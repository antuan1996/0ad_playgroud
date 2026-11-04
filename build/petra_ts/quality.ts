/**
 * Code-quality metrics of the Petra TS port: size and complexity per
 * function, class and module, and duplicated code.
 *
 *   node build/petra_ts/quality.ts [options]
 *   npm run quality:petra -- [options]
 *
 *   --top N           rows in each list (default 25)
 *   --file M          only modules whose path contains M (e.g. attackPlan)
 *   --tests           measure the tests too (petra_ts/tests/), not only the port
 *   --min-tokens N    the shortest clone reported, in tokens (default 60)
 *   --min-lines N     ... and in lines (default 6)
 *   --renamed         clones with identifiers and literals renamed count too
 *                     (the same code over other names; noisier)
 *   --json FILE       also write every measure as JSON
 *
 * Reads the sources with the TypeScript compiler's parser and scanner (no
 * type check, nothing emitted); the declarations (*.d.ts) are left out.
 *
 * Per function (declarations, methods, constructors, accessors, function
 * expressions and arrows with a body, each measured on its own: a callback's
 * body does not count for the function it is written in; overload signatures
 * are not functions):
 * - lines: from the first line to the last;
 * - cyclomatic: 1 + each if, ?:, case, loop, catch, &&, || and ?? (and
 *   their assignments &&=, ||=, ??=); optional chaining and default
 *   parameters do not count;
 * - cognitive (SonarSource's cognitive complexity): each if, ?:, switch,
 *   loop and catch costs 1 plus its depth of nesting; else and else if cost
 *   1; each run of like logical operators costs 1 (a && b && c: 1,
 *   a && b || c: 2); a break or continue to a label costs 1;
 * - depth: the deepest nesting of those structures;
 * - params: its parameters.
 * Per class: lines, methods (with constructor and accessors) and fields.
 * Per module: code lines (lines holding anything but comments), functions,
 * classes, the sum and maximum of the functions' measures, and its
 * duplicated lines.
 *
 * Duplication: every run of at least --min-tokens tokens (imports left out)
 * that occurs twice, in one module or two, and spans at least --min-lines
 * lines, extended as far as the two copies agree; overlapping copies in one
 * module are skipped.
 *
 * The thresholds the summary counts against (functions over them):
 * lines 80, cyclomatic 15, cognitive 25, depth 4, params 5.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export interface FunctionMetrics
{
	file: string;
	name: string;
	line: number;
	lines: number;
	cyclomatic: number;
	cognitive: number;
	depth: number;
	params: number;
}

export interface ClassMetrics
{
	file: string;
	name: string;
	line: number;
	lines: number;
	methods: number;
	fields: number;
}

export interface ModuleMetrics
{
	file: string;
	codeLines: number;
	functions: number;
	classes: number;
	cyclomatic: number;
	cognitive: number;
	maxCyclomatic: number;
	maxCognitive: number;
	duplicatedLines: number;
}

export interface SourceMetrics
{
	functions: FunctionMetrics[];
	classes: ClassMetrics[];
	module: ModuleMetrics;
}

export const THRESHOLDS = { "lines": 80, "cyclomatic": 15, "cognitive": 25, "depth": 4, "params": 5 } as const;

type FunctionNode =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction;

function isFunctionNode(node: ts.Node): node is FunctionNode
{
	return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
		ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

const LOGICAL = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function lineOf(source: ts.SourceFile, pos: number): number
{
	return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined, source: ts.SourceFile): string | undefined
{
	if (!name)
		return undefined;
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
		return name.text;
	return name.getText(source);
}

/** A function's name as a reader looks it up: Class.method, a variable's or property's name, or where it sits. */
function functionName(node: FunctionNode, source: ts.SourceFile, outer: string | undefined): string
{
	const parent = node.parent;
	const owner = parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) ?
		parent.name?.text ?? "(class)" :
		undefined;
	let own: string | undefined;
	if (ts.isConstructorDeclaration(node))
		own = "constructor";
	else if (
		ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node)
	)
		own = propertyName(node.name, source);
	if (
		!own && parent &&
		(ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent))
	)
		own = propertyName(parent.name, source);
	if (owner)
		return `${owner}.${own ?? "(anonymous)"}`;
	if (own)
		return outer ? `${outer} > ${own}` : own;
	const kind = ts.isArrowFunction(node) ? "arrow" : "function";
	return `${outer ?? "(module)"} > ${kind}@${lineOf(source, node.getStart(source))}`;
}

function skipParentheses(node: ts.Node): ts.Node
{
	let current = node.parent;
	while (current && ts.isParenthesizedExpression(current))
		current = current.parent;
	return current;
}

/** Measures one function's own body: nested functions are measured on their own. */
function measureFunction(node: FunctionNode, source: ts.SourceFile, name: string): FunctionMetrics
{
	let cyclomatic = 1;
	let cognitive = 0;
	let depth = 0;

	const nested = (child: ts.Node, nesting: number): void => visit(child, nesting + 1);
	function visit(current: ts.Node, nesting: number): void
	{
		if (current !== node && isFunctionNode(current))
			return;
		if (ts.isIfStatement(current))
		{
			const elseIf = ts.isIfStatement(current.parent) && current.parent.elseStatement === current;
			cyclomatic += 1;
			// an else if costs 1 and keeps its if's nesting; its if paid for the depth
			cognitive += elseIf ? 1 : 1 + nesting;
			depth = Math.max(depth, nesting + 1);
			visit(current.expression, nesting);
			nested(current.thenStatement, nesting);
			const otherwise = current.elseStatement;
			if (otherwise)
			{
				if (ts.isIfStatement(otherwise))
					visit(otherwise, nesting);
				else
				{
					cognitive += 1;
					nested(otherwise, nesting);
				}
			}
			return;
		}
		if (ts.isConditionalExpression(current))
		{
			cyclomatic += 1;
			cognitive += 1 + nesting;
			depth = Math.max(depth, nesting + 1);
			visit(current.condition, nesting);
			nested(current.whenTrue, nesting);
			nested(current.whenFalse, nesting);
			return;
		}
		if (
			ts.isSwitchStatement(current) || ts.isForStatement(current) || ts.isForInStatement(current) ||
			ts.isForOfStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current) ||
			ts.isCatchClause(current)
		)
		{
			if (!ts.isSwitchStatement(current))
				cyclomatic += 1;
			cognitive += 1 + nesting;
			depth = Math.max(depth, nesting + 1);
			ts.forEachChild(current, child => nested(child, nesting));
			return;
		}
		if (ts.isCaseClause(current))
			cyclomatic += 1;
		if (ts.isBinaryExpression(current) && LOGICAL.has(current.operatorToken.kind))
		{
			cyclomatic += 1;
			const outer = skipParentheses(current);
			// a run of like operators costs 1, where it starts
			if (!(outer && ts.isBinaryExpression(outer) && outer.operatorToken.kind === current.operatorToken.kind))
				cognitive += 1;
		}
		if ((ts.isBreakStatement(current) || ts.isContinueStatement(current)) && current.label)
			cognitive += 1;
		ts.forEachChild(current, child => visit(child, nesting));
	}
	if (node.body)
		visit(node.body, 0);
	for (const parameter of node.parameters)
		if (parameter.initializer)
			visit(parameter.initializer, 0);

	const start = lineOf(source, node.getStart(source));
	return {
		"file": source.fileName,
		name,
		"line": start,
		"lines": lineOf(source, node.getEnd()) - start + 1,
		cyclomatic,
		cognitive,
		depth,
		"params": node.parameters.length,
	};
}

/** The lines holding anything but comments and whitespace. */
function codeLines(text: string): number
{
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
	const lines = new Set<number>();
	const source = ts.createSourceFile("lines.ts", text, ts.ScriptTarget.Latest, false);
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
	{
		if (
			kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia ||
			kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia
		)
			continue;
		const first = lineOf(source, scanner.getTokenStart());
		const last = lineOf(source, scanner.getTokenEnd());
		for (let line = first; line <= last; ++line)
			lines.add(line);
	}
	return lines.size;
}

/** Every measure of one module's source. */
export function measureSource(file: string, text: string): SourceMetrics
{
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const functions: FunctionMetrics[] = [];
	const classes: ClassMetrics[] = [];

	function visit(node: ts.Node, outer: string | undefined): void
	{
		// an overload's signature or an abstract method has no body: nothing to measure
		if (isFunctionNode(node) && node.body)
		{
			const name = functionName(node, source, outer);
			functions.push(measureFunction(node, source, name));
			ts.forEachChild(node, child => visit(child, name));
			return;
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
		{
			const start = lineOf(source, node.getStart(source));
			classes.push({
				file,
				"name": node.name?.text ?? "(class)",
				"line": start,
				"lines": lineOf(source, node.getEnd()) - start + 1,
				"methods": node.members.filter(m =>
					ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ||
					ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)
				).length,
				"fields": node.members.filter(m =>
					ts.isPropertyDeclaration(m)
				).length,
			});
		}
		ts.forEachChild(node, child => visit(child, outer));
	}
	visit(source, undefined);

	return {
		functions,
		classes,
		"module": {
			file,
			"codeLines": codeLines(text),
			"functions": functions.length,
			"classes": classes.length,
			"cyclomatic": functions.reduce((sum, f) => sum + f.cyclomatic, 0),
			"cognitive": functions.reduce((sum, f) => sum + f.cognitive, 0),
			"maxCyclomatic": Math.max(0, ...functions.map(f => f.cyclomatic)),
			"maxCognitive": Math.max(0, ...functions.map(f => f.cognitive)),
			"duplicatedLines": 0,
		},
	};
}

export interface CloneSide
{
	file: string;
	startLine: number;
	endLine: number;
}

/** One run of code and every place it occurs (two or more). */
export interface Clone
{
	tokens: number;
	/** the shortest copy's lines */
	lines: number;
	copies: CloneSide[];
}

interface Token
{
	id: number;
	start: number;
	end: number;
}

interface TokenisedSource
{
	file: string;
	source: ts.SourceFile;
	tokens: Token[];
}

/** A module's tokens without its imports, each interned to a number; renamed: identifiers and literals as one each. */
function tokenise(file: string, text: string, renamed: boolean, ids: Map<string, number>): TokenisedSource
{
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const skipped: Array<[number, number]> = source.statements.filter(s =>
		ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s)
	).map(s => [s.getStart(source), s.getEnd()]);
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
	const tokens: Token[] = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
	{
		const start = scanner.getTokenStart();
		if (skipped.some(([from, to]) => start >= from && start < to))
			continue;
		let key = scanner.getTokenText();
		if (
			renamed &&
			(kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.StringLiteral ||
				kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
		)
			key = `<${kind}>`;
		let id = ids.get(key);
		if (id === undefined)
		{
			id = ids.size;
			ids.set(key, id);
		}
		tokens.push({ id, start, "end": scanner.getTokenEnd() });
	}
	return { file, source, tokens };
}

const HASH_BASE = 1_000_003;
const HASH_MOD = 2_147_483_647;

/** Rolling hashes of every window of `size` tokens. */
function windowHashes(tokens: Token[], size: number): number[]
{
	const hashes: number[] = [];
	if (tokens.length < size)
		return hashes;
	let power = 1;
	for (let i = 1; i < size; ++i)
		power = power * HASH_BASE % HASH_MOD;
	let hash = 0;
	for (let i = 0; i < tokens.length; ++i)
	{
		if (i >= size)
			hash = (hash - (tokens[i - size].id + 1) * power % HASH_MOD + HASH_MOD) % HASH_MOD;
		hash = (hash * HASH_BASE + tokens[i].id + 1) % HASH_MOD;
		if (i >= size - 1)
			hashes.push(hash);
	}
	return hashes;
}

/** Copies of code: runs of at least minTokens tokens, over minLines lines, that occur twice or more, each run once. */
export function findClones(
	sources: Array<{ file: string; text: string }>,
	minTokens: number,
	minLines: number,
	renamed = false,
): Clone[]
{
	const ids = new Map<string, number>();
	const tokenised = sources.map(s => tokenise(s.file, s.text, renamed, ids));
	const buckets = new Map<number, Array<[number, number]>>();
	tokenised.forEach((t, fileIndex) =>
		windowHashes(t.tokens, minTokens).forEach((hash, position) =>
		{
			const bucket = buckets.get(hash);
			if (bucket)
				bucket.push([fileIndex, position]);
			else
				buckets.set(hash, [[fileIndex, position]]);
		})
	);

	// each copy is known by where it starts; two copies of one run are joined,
	// and so are the runs sharing a copy (three copies give three pairs whose
	// lengths differ by the token after them)
	const parent = new Map<string, string>();
	const find = (key: string): string =>
	{
		let root = key;
		while (parent.get(root) !== root)
			root = parent.get(root) ?? root;
		parent.set(key, root);
		return root;
	};
	const starts = new Map<string, [number, number]>();
	const lengths = new Map<string, number>();
	const same = (fa: number, pa: number, fb: number, pb: number): boolean =>
		pa >= 0 && pb >= 0 && pa < tokenised[fa].tokens.length && pb < tokenised[fb].tokens.length &&
		tokenised[fa].tokens[pa].id === tokenised[fb].tokens[pb].id;
	for (const bucket of buckets.values())
	{
		// a pattern repeated very often (a run of closing brackets) is no copy of code
		if (bucket.length < 2 || bucket.length > 40)
			continue;
		for (let i = 0; i < bucket.length; ++i)
		{
			for (let j = i + 1; j < bucket.length; ++j)
			{
				const [fa, pa] = bucket[i];
				const [fb, pb] = bucket[j];
				// only where the two copies start to agree, so each clone is found once
				if (same(fa, pa - 1, fb, pb - 1))
					continue;
				let length = 0;
				while (same(fa, pa + length, fb, pb + length))
					++length;
				if (length < minTokens)
					continue; // a hash collision
				if (fa === fb && pb < pa + length)
					continue; // a copy overlapping itself
				const a = `${fa}:${pa}`;
				const b = `${fb}:${pb}`;
				for (const [key, at] of [[a, [fa, pa]], [b, [fb, pb]]] as const)
				{
					if (!parent.has(key))
						parent.set(key, key);
					starts.set(key, [at[0], at[1]]);
				}
				const ra = find(a);
				const rb = find(b);
				const length2 = Math.min(lengths.get(ra) ?? length, lengths.get(rb) ?? length, length);
				parent.set(rb, ra);
				lengths.set(ra, length2);
			}
		}
	}
	const components = new Map<string, string[]>();
	for (const key of parent.keys())
	{
		const root = find(key);
		const members = components.get(root);
		if (members)
			members.push(key);
		else
			components.set(root, [key]);
	}
	const clones: Clone[] = [];
	for (const [root, members] of components)
	{
		const length = lengths.get(root) ?? 0;
		const copies = members.map((key): CloneSide =>
		{
			const [f, p] = starts.get(key) ?? [0, 0];
			const t = tokenised[f];
			return {
				"file": t.file,
				"startLine": lineOf(t.source, t.tokens[p].start),
				"endLine": lineOf(t.source, t.tokens[p + length - 1].end),
			};
		}).sort((x, y) => x.file.localeCompare(y.file) || x.startLine - y.startLine);
		const lines = Math.min(...copies.map(c => c.endLine - c.startLine + 1));
		if (lines >= minLines)
			clones.push({ "tokens": length, lines, copies });
	}
	clones.sort((x, y) =>
		y.tokens * y.copies.length - x.tokens * x.copies.length ||
		x.copies[0].file.localeCompare(y.copies[0].file) || x.copies[0].startLine - y.copies[0].startLine
	);
	// a clone whose copies all lie inside those of one listed before is the same code found again
	const kept: Clone[] = [];
	const inside = (c: CloneSide, d: CloneSide): boolean =>
		c.file === d.file && c.startLine >= d.startLine && c.endLine <= d.endLine;
	for (const clone of clones)
		if (!kept.some(k => clone.copies.every(c => k.copies.some(d => inside(c, d)))))
			kept.push(clone);
	return kept;
}

/** The lines of each module inside a copy. */
export function duplicatedLinesByFile(clones: Clone[]): Map<string, number>
{
	const lines = new Map<string, Set<number>>();
	for (const clone of clones)
	{
		for (const side of clone.copies)
		{
			let set = lines.get(side.file);
			if (!set)
				lines.set(side.file, set = new Set());
			for (let line = side.startLine; line <= side.endLine; ++line)
				set.add(line);
		}
	}
	return new Map([...lines].map(([file, set]) => [file, set.size]));
}

function sourceFiles(dir: string, withTests: boolean): string[]
{
	const files: string[] = [];
	for (const entry of readdirSync(dir).sort())
	{
		const path = join(dir, entry);
		if (statSync(path).isDirectory())
		{
			if (entry === "tests" && !withTests)
				continue;
			if (entry === "node_modules")
				continue;
			files.push(...sourceFiles(path, withTests));
		}
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
			files.push(path);
	}
	return files;
}

function table(header: string[], rows: Array<Array<string | number>>, right: number[] = []): string
{
	const cells = [header, ...rows.map(r => r.map(String))];
	const widths = header.map((_, c) => Math.max(...cells.map(r => r[c].length)));
	return cells.map(r =>
		r.map((cell, c) => right.includes(c) ? cell.padStart(widths[c]) : cell.padEnd(widths[c])).join("  ").trimEnd()
	).join("\n");
}

function option(args: string[], name: string): string | undefined
{
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function main(args: string[]): void
{
	const root = resolve(import.meta.dirname, "../..");
	const portDir = join(root, "binaries/data/mods/public/simulation/ai/petra_ts");
	const top = Number(option(args, "--top") ?? 25);
	const only = option(args, "--file");
	const minTokens = Number(option(args, "--min-tokens") ?? 60);
	const minLines = Number(option(args, "--min-lines") ?? 6);
	const json = option(args, "--json");

	const files = sourceFiles(portDir, args.includes("--tests"));
	const sources = files.map(path => ({ "file": relative(portDir, path), "text": readFileSync(path, "utf8") }));
	const measured = sources.map(s => measureSource(s.file, s.text));
	const clones = findClones(sources, minTokens, minLines, args.includes("--renamed"));
	const duplicated = duplicatedLinesByFile(clones);
	for (const m of measured)
		m.module.duplicatedLines = duplicated.get(m.module.file) ?? 0;

	const selected = (file: string): boolean => !only || file.includes(only);
	const modules = measured.map(m => m.module).filter(m => selected(m.file));
	const functions = measured.flatMap(m => m.functions).filter(f => selected(f.file));
	const classes = measured.flatMap(m => m.classes).filter(c => selected(c.file));
	const shownClones = clones.filter(c => c.copies.some(copy => selected(copy.file)));

	const over = (f: FunctionMetrics): string[] =>
		(Object.keys(THRESHOLDS) as Array<keyof typeof THRESHOLDS>).filter(key => f[key] > THRESHOLDS[key]);
	const totalLines = modules.reduce((sum, m) => sum + m.codeLines, 0);
	const totalDuplicated = modules.reduce((sum, m) => sum + m.duplicatedLines, 0);
	const percent = (part: number, whole: number): string => whole ? `${(100 * part / whole).toFixed(1)}%` : "-";

	console.log(
		`Petra TS code quality: ${modules.length} modules, ${totalLines} code lines, ${functions.length} functions, ` +
			`${classes.length} classes`,
	);
	console.log(
		`functions over the thresholds (${Object.entries(THRESHOLDS).map(([k, v]) => `${k} ${v}`).join(", ")}): ` +
			`${functions.filter(f => over(f).length).length}; ` +
			Object.keys(THRESHOLDS).map(key => `${key} ${functions.filter(f => over(f).includes(key)).length}`).join(
				", ",
			),
	);
	console.log(
		`duplicated: ${totalDuplicated} lines (${
			percent(totalDuplicated, totalLines)
		}) in ${shownClones.length} clones ` +
			`(at least ${minTokens} tokens and ${minLines} lines${
				args.includes("--renamed") ? ", identifiers renamed" : ""
			})`,
	);

	console.log("\nmodules, by cognitive complexity:");
	console.log(
		table(
			["module", "lines", "funcs", "classes", "cyclo", "cogn", "max cyclo", "max cogn", "over", "dup lines"],
			[...modules].sort((x, y) => y.cognitive - x.cognitive).slice(0, top).map(
				m => [
					m.file,
					m.codeLines,
					m.functions,
					m.classes,
					m.cyclomatic,
					m.cognitive,
					m.maxCyclomatic,
					m.maxCognitive,
					functions.filter(f => f.file === m.file && over(f).length).length,
					m.duplicatedLines,
				]
			),
			[1, 2, 3, 4, 5, 6, 7, 8, 9],
		),
	);

	console.log("\nfunctions, by cognitive complexity:");
	console.log(
		table(
			["function", "where", "lines", "cyclo", "cogn", "depth", "params", "over"],
			[...functions].sort((x, y) => y.cognitive - x.cognitive || y.cyclomatic - x.cyclomatic).slice(0, top).map(
				f => [
					f.name,
					`${f.file}:${f.line}`,
					f.lines,
					f.cyclomatic,
					f.cognitive,
					f.depth,
					f.params,
					over(f).join(","),
				]
			),
			[2, 3, 4, 5, 6],
		),
	);

	console.log("\nfunctions, by length:");
	console.log(
		table(
			["function", "where", "lines", "cyclo", "cogn"],
			[...functions].sort((x, y) => y.lines - x.lines).slice(0, top).map(
				f => [f.name, `${f.file}:${f.line}`, f.lines, f.cyclomatic, f.cognitive]
			),
			[2, 3, 4],
		),
	);

	console.log("\nclasses, by length:");
	console.log(
		table(
			["class", "where", "lines", "methods", "fields"],
			[...classes].sort((x, y) => y.lines - x.lines).slice(0, top).map(
				c => [c.name, `${c.file}:${c.line}`, c.lines, c.methods, c.fields]
			),
			[2, 3, 4],
		),
	);

	console.log("\nclones, by tokens times copies:");
	console.log(
		table(
			["tokens", "lines", "copies", "where"],
			shownClones.slice(0, top).map(c => [
				c.tokens,
				c.lines,
				c.copies.length,
				c.copies.map(copy => `${copy.file}:${copy.startLine}-${copy.endLine}`).join("  "),
			]),
			[0, 1, 2],
		),
	);

	if (json)
		writeFileSync(json, JSON.stringify({ modules, functions, classes, "clones": shownClones }, null, "\t") + "\n");
}

if (import.meta.filename === resolve(process.argv[1] ?? ""))
	main(process.argv.slice(2));
