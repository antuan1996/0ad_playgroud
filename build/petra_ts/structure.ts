/**
 * The structure of the Petra TS port: its layers, its import graph, its dead
 * code and its classes' cohesion.
 *
 *   node build/petra_ts/structure.ts [options]
 *   npm run structure:petra -- [options]
 *
 *   --check            exit 1 when a rule is broken or a tracked count rose
 *                      above the baseline (build/petra_ts/structure-baseline.json)
 *   --update-baseline  write the tracked counts as the new baseline
 *   --top N            rows in each list (default 15)
 *   --json FILE        also write every finding as JSON
 *
 * Reads the port's sources (petra_ts/, the tests apart) with the TypeScript
 * compiler's parser, no type check; the tests, the declarations (*.d.ts) and
 * the build's bot-state.js count as users of the port's exports.
 *
 * Rules (each finding breaks the check):
 * - cast: an `as` cast (not `as const`) or `<T>` assertion outside
 *   adapter/brands.ts, the port's only sanctioned casts;
 * - non-null: a `!` non-null assertion;
 * - post-command: Engine.PostCommand outside adapter/commands.ts;
 * - hq-access: execution code reaching the headquarters other than through
 *   execution/hq.ts (hqOf): importing decision/headquarters.ts, or reading
 *   `.ai.HQ`.
 *
 * Tracked counts (the check fails when one rises above the baseline; lower
 * them, then --update-baseline):
 * - layer: imports against the layers' order (PLAN.md §3.4), adapter <
 *   world < execution < decision < the bot's root, a module importing only
 *   its own layer or those below; type-only imports count too;
 * - layer-access: members of a higher layer reached at run time, with no
 *   import: a property whose declaration, or the type of the value it
 *   yields, lies in a higher layer than the module's (`gameState.ai.HQ` in
 *   world/ yields decision/'s headquarters), resolved by the type checker
 *   (layerAccesses), whether read as x.name, x["name"] or destructured
 *   (`const { name } = x`); one finding a chain. Execution code reaching decision/
 *   through the headquarters' view of execution/hq.ts (hqOf) is the
 *   sanctioned way and is reported apart, not counted;
 * - hq-manager-access: execution code using the members of the decision
 *   objects that view hands out (the managers' methods and fields, however
 *   reached): sanctioned by the view, but a dependency on decision/'s
 *   classes, held from growing;
 * - cycle: modules in a cycle of value imports (type-only imports leave
 *   nothing at run time);
 * - engine: uses of Engine outside adapter/ (profiling apart);
 * - dead-export: exports nothing imports, nor uses in its own module (but
 *   those marked `TODO never called`);
 * - dead-method: methods (and accessors) no code of the port (nor the
 *   build's bot-state.js) names, not marked `TODO never called`; matched by
 *   name, as a class is often reached through a type of its methods
 *   (execution/hq.ts): a method `update` is never dead, so a finding is
 *   certain and the count a lower bound;
 * - stale-todo: methods marked `TODO never called` that a call of the port
 *   reaches, resolved by the type checker (the program of
 *   tsconfig.tests.json).
 *
 * Reported, not tracked: exports only the tests use, exports only their own
 * module uses (they need not be exported), each module's fan-in and fan-out,
 * and per class its methods, fields and cohesion: LCOM4, the number of groups
 * of methods linked by the fields they share or the methods they call (1 is
 * one cohesive class; each further group could be a class of its own), the
 * members an eighth of the methods use set apart as hubs in classes of 9
 * methods or more (the configuration, the managers asked: they would join
 * every group), and the methods using no field and no other method (module
 * functions, really). Calls link methods too, so a class whose update calls
 * its steps stays one group: a large LCOM4 says a split is easy, a small
 * one in a large class only that its methods call one another.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export type Layer = "adapter" | "world" | "execution" | "decision" | "root";

const LAYER_RANK: Record<Layer, number> = { adapter: 0, world: 1, execution: 2, decision: 3, root: 4 };

export interface ImportEdge
{
	from: string;
	to: string;
	typeOnly: boolean;
	line: number;
	/** the names imported, "*" for a namespace import */
	names: string[];
}

export interface Finding
{
	rule: string;
	file: string;
	line: number;
	text: string;
}

export interface ClassCohesion
{
	file: string;
	name: string;
	line: number;
	methods: number;
	fields: number;
	/** groups of methods linked by shared fields and calls (hubs apart) */
	lcom4: number;
	/** the members an eighth of the methods use (in classes of HUB_MIN_METHODS methods): they link no group */
	hubs: string[];
	/** each group's members, the largest first */
	groups: string[][];
	/** methods using no field and calling no method */
	thisless: string[];
}

export interface ModuleInfo
{
	file: string;
	layer: Layer;
	imports: ImportEdge[];
	exports: Array<{ name: string; line: number; todo?: boolean; }>;
	/** names used in the module's own code (identifiers and property names) */
	identifiers: Map<string, number>;
	/** methods and accessors: name, line, marked TODO never called */
	methods: Array<{ cls: string; name: string; line: number; todo: boolean; }>;
	classes: ClassCohesion[];
	findings: Finding[];
}

/** A port module's layer, by its folder */
export function layerOf(file: string): Layer
{
	const top = file.split("/")[0];
	return top === "adapter" || top === "world" || top === "execution" || top === "decision" ? top : "root";
}

function lineOf(source: ts.SourceFile, pos: number): number
{
	return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasExportModifier(node: ts.Node): boolean
{
	return ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function memberName(name: ts.PropertyName | undefined): string | undefined
{
	if (!name)
	{
		return undefined;
	}
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name))
	{
		return name.text;
	}
	return undefined;
}

/** Whether a member's leading comments mark it never called */
function markedNeverCalled(node: ts.Node, source: ts.SourceFile): boolean
{
	return /TODO never called/.test(source.text.slice(node.getFullStart(), node.getStart(source)));
}

/** The module a relative specifier names, relative to the port's root; undefined for others */
function resolveSpecifier(from: string, specifier: string): string | undefined
{
	const vfs = /^simulation\/ai\/petra_out\/(.+)\.js$/.exec(specifier);
	if (vfs)
	{
		return vfs[1] + ".ts";
	}
	if (!specifier.startsWith("."))
	{
		return undefined;
	}
	return join(dirname(from), specifier).replace(/\\/g, "/").replace(/\.js$/, ".ts");
}

/** The fewest methods a class has for its most used members to count as hubs */
const HUB_MIN_METHODS = 9;
/** A member more methods than this share of them use is a hub */
const HUB_SHARE = 8;

/** A class's cohesion: its methods linked when they share a field or one calls the other, hubs apart */
function classCohesion(
	file: string,
	source: ts.SourceFile,
	cls: ts.ClassDeclaration | ts.ClassExpression,
): ClassCohesion
{
	const fields = new Set<string>();
	const methods = new Map<string, ts.Node>();
	for (const member of cls.members)
	{
		const name = memberName(member.name);
		if (ts.isPropertyDeclaration(member) && name)
		{
			fields.add(name);
		}
		else if (
			(ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) ||
				ts.isSetAccessorDeclaration(member)) && name && !(ts.getModifiers(member) ?? []).some((m) =>
					m.kind === ts.SyntaxKind.StaticKeyword
				)
		)
		{
			methods.set(name, member);
		}
		else if (ts.isConstructorDeclaration(member))
		{
			for (const param of member.parameters)
			{
				if (ts.isParameterPropertyDeclaration(param, member) && ts.isIdentifier(param.name))
				{
					fields.add(param.name.text);
				}
			}
			// fields assigned in the constructor
			const visit = (node: ts.Node): void =>
			{
				if (
					ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
				)
				{
					fields.add(node.left.name.text);
				}
				ts.forEachChild(node, visit);
			};
			if (member.body)
			{
				visit(member.body);
			}
		}
	}
	// a getter and setter of one name are one member
	const names = [...methods.keys()];
	const parent = new Map<string, string>(names.map((n) => [n, n]));
	const find = (n: string): string =>
	{
		let root = n;
		while (parent.get(root) !== root)
		{
			root = parent.get(root) ?? root;
		}
		parent.set(n, root);
		return root;
	};
	const union = (a: string, b: string): void =>
	{
		parent.set(find(a), find(b));
	};
	// what each method uses of the class: its fields and the methods it calls
	const uses = new Map<string, Set<string>>();
	const thisless: string[] = [];
	for (const [name, node] of methods)
	{
		const used = new Set<string>();
		let usesThis = false;
		const visit = (inner: ts.Node): void =>
		{
			if (ts.isPropertyAccessExpression(inner) && inner.expression.kind === ts.SyntaxKind.ThisKeyword)
			{
				usesThis = true; // a member of a base class too
				if (fields.has(inner.name.text) || methods.has(inner.name.text) && inner.name.text !== name)
				{
					used.add(inner.name.text);
				}
			}
			ts.forEachChild(inner, visit);
		};
		visit(node);
		uses.set(name, used);
		if (!usesThis)
		{
			thisless.push(name);
		}
	}
	// hubs (the configuration, the managers a class asks): members an eighth of the methods use link no group
	const userCount = new Map<string, number>();
	for (const used of uses.values())
	{
		for (const member of used)
		{
			userCount.set(member, (userCount.get(member) ?? 0) + 1);
		}
	}
	const hubs = names.length >= HUB_MIN_METHODS ?
		[...userCount].filter(([, n]) => n > names.length / HUB_SHARE).map(([member]) => member).sort() :
		[];
	const fieldUser = new Map<string, string>();
	for (const [name, used] of uses)
	{
		for (const member of used)
		{
			if (hubs.includes(member))
			{
				continue;
			}
			if (methods.has(member))
			{
				union(name, member);
				continue;
			}
			const other = fieldUser.get(member);
			if (other === undefined)
			{
				fieldUser.set(member, name);
			}
			else
			{
				union(name, other);
			}
		}
	}
	const groupsByRoot = new Map<string, string[]>();
	for (const name of names)
	{
		const root = find(name);
		const group = groupsByRoot.get(root);
		if (group)
		{
			group.push(name);
		}
		else
		{
			groupsByRoot.set(root, [name]);
		}
	}
	const groups = [...groupsByRoot.values()].sort((a, b) => b.length - a.length);
	return {
		file,
		name: cls.name?.text ?? "(anonymous)",
		line: lineOf(source, cls.getStart(source)),
		methods: names.length,
		fields: fields.size,
		lcom4: groups.length,
		groups,
		hubs,
		thisless,
	};
}

/** One port module's imports, exports, identifiers, methods, classes and rule findings */
export function analyseModule(file: string, text: string): ModuleInfo
{
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const layer = layerOf(file);
	const info: ModuleInfo = {
		file,
		layer,
		imports: [],
		exports: [],
		identifiers: new Map(),
		methods: [],
		classes: [],
		findings: [],
	};
	const finding = (rule: string, node: ts.Node, what: string): void =>
	{
		info.findings.push({ rule, file, line: lineOf(source, node.getStart(source)), text: what });
	};
	const count = (name: string): void =>
	{
		info.identifiers.set(name, (info.identifiers.get(name) ?? 0) + 1);
	};

	for (const statement of source.statements)
	{
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
		{
			const to = resolveSpecifier(file, statement.moduleSpecifier.text);
			const clause = statement.importClause;
			if (!to || !clause)
			{
				continue;
			}
			const names: string[] = [];
			const clauseTypeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
			let allTypes = clauseTypeOnly;
			if (clause.name)
			{
				names.push("default");
			}
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings))
			{
				names.push("*");
			}
			else if (bindings)
			{
				const elements = bindings.elements;
				for (const element of elements)
				{
					names.push((element.propertyName ?? element.name).text);
				}
				if (!clauseTypeOnly && !clause.name)
				{
					allTypes = elements.length > 0 && elements.every((e) => e.isTypeOnly);
				}
			}
			info.imports.push({
				from: file,
				to,
				typeOnly: allTypes,
				line: lineOf(source, statement.getStart(source)),
				names,
			});
			continue;
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
		{
			for (const element of statement.exportClause.elements)
			{
				info.exports.push({ name: element.name.text, line: lineOf(source, element.getStart(source)) });
			}
			continue;
		}
		if (!hasExportModifier(statement))
		{
			continue;
		}
		const line = lineOf(source, statement.getStart(source));
		if (ts.isVariableStatement(statement))
		{
			for (const decl of statement.declarationList.declarations)
			{
				if (ts.isIdentifier(decl.name))
				{
					info.exports.push({ name: decl.name.text, line });
				}
			}
		}
		else if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name
		)
		{
			info.exports.push({ name: statement.name.text, line, todo: markedNeverCalled(statement, source) });
		}
	}

	const exportNames = new Set(info.exports.map((e) => e.name));
	const visit = (node: ts.Node): void =>
	{
		if (ts.isImportDeclaration(node))
		{
			return;
		}
		if (ts.isIdentifier(node))
		{
			// an export's own declaration is no use of it
			const parent = node.parent;
			const declares = parent && "name" in parent && parent.name === node && exportNames.has(node.text) &&
				(ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
					ts.isVariableDeclaration(parent) ||
					ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) ||
					ts.isEnumDeclaration(parent));
			const declaresMember = parent && "name" in parent && parent.name === node &&
				(ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
					ts.isSetAccessorDeclaration(parent));
			if (!declares && !declaresMember)
			{
				count(node.text);
			}
		}
		else if (ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent))
		{
			count(node.text);
		}
		if (ts.isAsExpression(node))
		{
			const isConst = ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) &&
				node.type.typeName.text === "const";
			if (!isConst && file !== "adapter/brands.ts")
			{
				finding("cast", node, node.getText(source).slice(0, 80));
			}
		}
		else if (ts.isTypeAssertionExpression(node) && file !== "adapter/brands.ts")
		{
			finding("cast", node, node.getText(source).slice(0, 80));
		}
		else if (ts.isNonNullExpression(node))
		{
			finding("non-null", node, node.getText(source).slice(0, 80));
		}
		else if (ts.isPropertyAccessExpression(node))
		{
			if (ts.isIdentifier(node.expression) && node.expression.text === "Engine")
			{
				const what = node.name.text;
				if (what === "PostCommand" && file !== "adapter/commands.ts")
				{
					finding("post-command", node, node.getText(source));
				}
				if (layer !== "adapter" && what !== "ProfileStart" && what !== "ProfileStop")
				{
					finding("engine", node, "Engine." + what);
				}
			}
			if (
				node.name.text === "HQ" && layer === "execution" && file !== "execution/hq.ts" &&
				ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "ai"
			)
			{
				finding("hq-access", node, node.getText(source));
			}
		}
		if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)))
		{
			info.classes.push(classCohesion(file, source, node));
			const clsName = node.name?.text ?? "(anonymous)";
			for (const member of node.members)
			{
				const name = memberName(member.name);
				if (
					name &&
					(ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) ||
						ts.isSetAccessorDeclaration(member))
				)
				{
					info.methods.push({
						cls: clsName,
						name,
						line: lineOf(source, member.getStart(source)),
						todo: markedNeverCalled(member, source),
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	for (const edge of info.imports)
	{
		if (layer === "execution" && file !== "execution/hq.ts" && edge.to === "decision/headquarters.ts")
		{
			info.findings.push({ rule: "hq-access", file, line: edge.line, text: "imports decision/headquarters.ts" });
		}
	}
	return info;
}

/** The modules in a cycle of value imports, each cycle's modules together (Tarjan) */
export function importCycles(modules: ModuleInfo[]): string[][]
{
	const graph = new Map<string, string[]>();
	for (const mod of modules)
	{
		graph.set(mod.file, mod.imports.filter((e) => !e.typeOnly && e.to !== mod.file).map((e) => e.to));
	}
	let index = 0;
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const cycles: string[][] = [];
	const connect = (v: string): void =>
	{
		indices.set(v, index);
		low.set(v, index);
		++index;
		stack.push(v);
		onStack.add(v);
		for (const w of graph.get(v) ?? [])
		{
			if (!graph.has(w))
			{
				continue;
			}
			if (!indices.has(w))
			{
				connect(w);
				low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
			}
			else if (onStack.has(w))
			{
				low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
			}
		}
		if (low.get(v) !== indices.get(v))
		{
			return;
		}
		const component: string[] = [];
		let w: string | undefined;
		do
		{
			w = stack.pop();
			if (w === undefined)
			{
				break;
			}
			onStack.delete(w);
			component.push(w);
		}
		while (w !== v);
		if (component.length > 1)
		{
			cycles.push(component.sort());
		}
	};
	for (const v of [...graph.keys()].sort())
	{
		if (!indices.has(v))
		{
			connect(v);
		}
	}
	return cycles.sort((a, b) => b.length - a.length);
}

/** The imports against the layers' order (execution/hq.ts's view of the headquarters apart) */
export function layerViolations(modules: ModuleInfo[]): ImportEdge[]
{
	const violations: ImportEdge[] = [];
	for (const mod of modules)
	{
		for (const edge of mod.imports)
		{
			if (mod.file === "execution/hq.ts" && edge.to === "decision/headquarters.ts")
			{
				continue;
			}
			if (LAYER_RANK[layerOf(edge.to)] > LAYER_RANK[mod.layer])
			{
				violations.push(edge);
			}
		}
	}
	return violations;
}

export interface DeadCode
{
	/** exports nothing uses, in the port or out of it */
	deadExports: Finding[];
	/** exports only the tests (or the build) use */
	testOnlyExports: Finding[];
	/** exports only their own module uses */
	localOnlyExports: Finding[];
	/** methods the port never names, not marked TODO never called */
	deadMethods: Finding[];
	/** methods marked TODO never called that the port names */
	staleTodos: Finding[];
}

/**
 * The exports and methods nothing uses: the port's modules, and the users outside it (tests, declarations,
 * the build's scripts) as modules whose imports and identifiers count
 */
export function deadCode(modules: ModuleInfo[], users: ModuleInfo[], calledMethods?: Set<string>): DeadCode
{
	const result: DeadCode = {
		deadExports: [],
		testOnlyExports: [],
		localOnlyExports: [],
		deadMethods: [],
		staleTodos: [],
	};
	// the names imported from each module, by the port and by the users; namespace imports by their member accesses
	const importedBy = (importers: ModuleInfo[]): Map<string, Set<string>> =>
	{
		const imported = new Map<string, Set<string>>();
		for (const mod of importers)
		{
			for (const edge of mod.imports)
			{
				const set = imported.get(edge.to) ?? new Set<string>();
				for (const name of edge.names)
				{
					set.add(name);
				}
				imported.set(edge.to, set);
			}
		}
		return imported;
	};
	const fromPort = importedBy(modules);
	const fromUsers = importedBy(users);
	const used = (imported: Map<string, Set<string>>, file: string, name: string, importers: ModuleInfo[]): boolean =>
	{
		const names = imported.get(file);
		if (!names)
		{
			return false;
		}
		if (names.has(name))
		{
			return true;
		}
		// a namespace import: the export is used when a module importing it so names it
		return names.has("*") &&
			importers.some((m) =>
				m.imports.some((e) => e.to === file && e.names.includes("*")) && (m.identifiers.get(name) ?? 0) > 0
			);
	};
	for (const mod of modules)
	{
		for (const exp of mod.exports)
		{
			const finding = { rule: "", file: mod.file, line: exp.line, text: exp.name };
			if (used(fromPort, mod.file, exp.name, modules))
			{
				continue;
			}
			if (used(fromUsers, mod.file, exp.name, users))
			{
				result.testOnlyExports.push({ ...finding, rule: "test-only-export" });
			}
			else if ((mod.identifiers.get(exp.name) ?? 0) > 0)
			{
				result.localOnlyExports.push({ ...finding, rule: "local-only-export" });
			}
			else if (!exp.todo)
			{
				result.deadExports.push({ ...finding, rule: "dead-export" });
			}
		}
	}

	// a method is dead when no code of the port (nor the build's scripts) names it; stale when the type checker
	// resolves a call of the port to its very declaration (by name when no checker is given)
	const named = new Map<string, number>();
	for (const mod of [...modules, ...users.filter((u) => !u.file.startsWith("tests/") && !u.file.endsWith(".d.ts"))])
	{
		for (const [name, n] of mod.identifiers)
		{
			named.set(name, (named.get(name) ?? 0) + n);
		}
	}
	for (const mod of modules)
	{
		for (const method of mod.methods)
		{
			const finding = { rule: "", file: mod.file, line: method.line, text: method.cls + "." + method.name };
			const named_ = (named.get(method.name) ?? 0) > 0;
			const called = calledMethods ? calledMethods.has(`${mod.file}:${method.line}`) : named_;
			if (!named_ && !method.todo && !ENTRY_POINTS.has(method.name))
			{
				result.deadMethods.push({ ...finding, rule: "dead-method" });
			}
			else if (called && method.todo)
			{
				result.staleTodos.push({ ...finding, rule: "stale-todo" });
			}
		}
	}
	return result;
}

/**
 * The methods (and accessors) the port's own code calls, as "file:line" of their declarations relative to the
 * port: each property access of the port's modules (not its tests) resolved by the type checker
 */
export function calledMethods(program: ts.Program, port: string): Set<string>
{
	const checker = program.getTypeChecker();
	const called = new Set<string>();
	const inPort = (file: string): string | undefined =>
	{
		const rel = relative(port, file).replace(/\\/g, "/");
		return rel.startsWith("..") || rel.startsWith("tests/") || rel.endsWith(".d.ts") ? undefined : rel;
	};
	for (const source of program.getSourceFiles())
	{
		if (inPort(source.fileName) === undefined)
		{
			continue;
		}
		const visit = (node: ts.Node): void =>
		{
			let at: ts.Node | undefined;
			if (ts.isPropertyAccessExpression(node))
			{
				at = node.name;
			}
			else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
			{
				at = node.argumentExpression;
			}
			const symbol = at && checker.getSymbolAtLocation(at);
			for (const decl of symbol?.declarations ?? [])
			{
				if (
					!ts.isMethodDeclaration(decl) && !ts.isGetAccessorDeclaration(decl) &&
					!ts.isSetAccessorDeclaration(decl)
				)
				{
					continue;
				}
				// a method calling itself is no call of it
				if (node.pos >= decl.pos && node.end <= decl.end && decl.getSourceFile() === source)
				{
					continue;
				}
				const file = inPort(decl.getSourceFile().fileName);
				if (file !== undefined)
				{
					called.add(`${file}:${lineOf(decl.getSourceFile(), decl.getStart())}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return called;
}

/** An access of a member of a higher layer than the module's: where, what, and the two layers */
export interface LayerAccess
{
	file: string;
	line: number;
	text: string;
	from: Layer;
	to: Layer;
	/** where the member (or the type it yields) is declared */
	declared: string;
}

/** The function through which execution code reaches the headquarters (execution/hq.ts) */
const HQ_GATEWAY = "hqOf";

/**
 * The accesses of members of a higher layer than the accessing module's, resolved by the type checker: a property
 * whose declaration, or the declaration of the type of the value it yields, lies in a module of a higher layer
 * (`gameState.ai.HQ` in world/ yields the headquarters of decision/). The declarations (*.d.ts) belong to no layer;
 * a value they type is judged by its type. Each chain of violations is reported once, at its first access over
 * the line. Execution code reaches decision/ in two ways apart: the members of the headquarters' view
 * (execution/hq.ts, hqOf: ExecutionHQ), the sanctioned way (`viaHq`); and the members of the decision objects the
 * view hands out, the managers (`viaManagers`), whatever the way they are reached (a chain or a variable). The view
 * itself (execution/hq.ts) is the gateway and is not looked at.
 */
export function layerAccesses(program: ts.Program, port: string): LayerAccesses
{
	const checker = program.getTypeChecker();
	const violations: LayerAccess[] = [];
	const viaHq: LayerAccess[] = [];
	const viaManagers: LayerAccess[] = [];
	const portFile = (file: string): string | undefined =>
	{
		const rel = relative(port, file).replace(/\\/g, "/");
		return rel.startsWith("..") || rel.startsWith("tests/") || rel.endsWith(".d.ts") ? undefined : rel;
	};
	/** The highest layer among a symbol's declarations in the port's modules, with the file */
	const declaredLayer = (symbol: ts.Symbol | undefined): [Layer, string] | undefined =>
	{
		let best: [Layer, string] | undefined;
		const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		for (const decl of target?.declarations ?? [])
		{
			const file = portFile(decl.getSourceFile().fileName);
			if (file !== undefined && (!best || LAYER_RANK[layerOf(file)] > LAYER_RANK[best[0]]))
			{
				best = [layerOf(file), file];
			}
		}
		return best;
	};
	/** The layer of the declaration of a value's type (its class, interface or alias), the undefined stripped */
	const typeLayer = (node: ts.Node): [Layer, string] | undefined =>
	{
		const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
		const parts = type.isUnion() ? type.types : [type];
		let best: [Layer, string] | undefined;
		for (const part of parts)
		{
			const found = declaredLayer(part.aliasSymbol) ?? declaredLayer(part.getSymbol());
			if (found && (!best || LAYER_RANK[found[0]] > LAYER_RANK[best[0]]))
			{
				best = found;
			}
		}
		return best;
	};
	// the headquarters' view: the type hqOf returns (execution/hq.ts), which every value it gives shares
	const hqSource = program.getSourceFiles().find((f) => portFile(f.fileName) === "execution/hq.ts");
	let hqView: ts.Type | undefined;
	hqSource?.forEachChild((node) =>
	{
		if (ts.isFunctionDeclaration(node) && node.name?.text === HQ_GATEWAY)
		{
			const signature = checker.getSignatureFromDeclaration(node);
			hqView = signature && checker.getReturnTypeOfSignature(signature);
		}
	});
	const isHqView = (node: ts.Node): boolean =>
		!!hqView && checker.getNonNullableType(checker.getTypeAtLocation(node)) === hqView;
	/** Whether a chain passes through the view: `hqOf(gs).turnCache.x`, the turnCache a Readonly of the HQ's */
	const throughHqView = (node: ts.Node): boolean =>
	{
		let at: ts.Node = node;
		while (
			ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at) ||
			ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at)
		)
		{
			if (isHqView(at))
			{
				return true;
			}
			at = at.expression;
		}
		return isHqView(at);
	};
	for (const source of program.getSourceFiles())
	{
		const file = portFile(source.fileName);
		if (file === undefined)
		{
			continue;
		}
		const from = layerOf(file);
		if (from === "root" || file === "execution/hq.ts")
		{
			continue;
		}
		const flagged = new Set<ts.Node>();
		/** An access: the node it reads, the member's symbol, the object it is read from */
		const access = (node: ts.Node, symbol: ts.Symbol | undefined, object: ts.Node): void =>
		{
			// the chain is reported once, at its first access over the line
			let inner: ts.Node = object;
			while (ts.isCallExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner))
			{
				inner = inner.expression;
			}
			if (flagged.has(inner))
			{
				flagged.add(node);
				return;
			}
			const over = [declaredLayer(symbol), typeLayer(node)].filter((d): d is [Layer, string] =>
				d !== undefined && LAYER_RANK[d[0]] > LAYER_RANK[from]
			).sort((a, b) =>
				LAYER_RANK[b[0]] - LAYER_RANK[a[0]]
			)[0];
			if (!over)
			{
				return;
			}
			const found: LayerAccess = {
				file,
				line: lineOf(source, node.getStart(source)),
				text: node.getText(source).replace(/\s+/g, " ").slice(0, 90),
				from,
				to: over[0],
				declared: over[1],
			};
			// the view's own members, or those of a decision object it handed out (a manager); not the HQ itself
			if (from === "execution" && over[0] === "decision")
			{
				if (isHqView(object))
				{
					viaHq.push(found);
					return;
				}
				if (typeLayer(object)?.[0] === "decision" || throughHqView(object))
				{
					viaManagers.push(found);
					return;
				}
			}
			flagged.add(node);
			violations.push(found);
		};
		const visit = (node: ts.Node): void =>
		{
			ts.forEachChild(node, visit);
			if (ts.isPropertyAccessExpression(node))
			{
				access(node, checker.getSymbolAtLocation(node.name), node.expression);
			}
			// x["name"]: as x.name
			else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
			{
				access(node, checker.getSymbolAtLocation(node.argumentExpression), node.expression);
			}
			// const { name } = x: as x.name, the object the pattern's
			else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken)
			{
				const key = node.propertyName ?? node.name;
				const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
				const symbol = name === undefined ?
					undefined :
					checker.getTypeAtLocation(node.parent).getProperty(name);
				access(node.name, symbol, node.parent);
			}
		};
		visit(source);
	}
	return { violations, viaHq, viaManagers };
}

/** The accesses of higher layers' members (layerAccesses), by kind */
export type LayerAccesses = { violations: LayerAccess[]; viaHq: LayerAccess[]; viaManagers: LayerAccess[]; };

/** The program of the port and its tests, as tsconfig.tests.json makes it */
function portProgram(configPath: string): ts.Program
{
	const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: () => undefined,
	});
	if (!config)
	{
		throw new Error("cannot read " + configPath);
	}
	return ts.createProgram(config.fileNames, config.options);
}

/** Methods the engine or the common API calls by their name */
const ENTRY_POINTS = new Set(["OnUpdate", "CustomInit", "Serialize", "Deserialize", "Init", "toString"]);

export interface Structure
{
	modules: ModuleInfo[];
	rules: Finding[];
	layer: ImportEdge[];
	cycles: string[][];
	engine: Finding[];
	dead: DeadCode;
	fan: Array<{ file: string; fanIn: number; fanOut: number; }>;
	classes: ClassCohesion[];
	/** members of a higher layer reached at run time (layerAccesses), and those through the headquarters' view */
	access: LayerAccess[];
	viaHq: LayerAccess[];
	viaManagers: LayerAccess[];
}

/** The counts the baseline holds */
export function trackedCounts(structure: Structure): Record<string, number>
{
	return {
		"layer": structure.layer.length,
		"layer-access": structure.access.length,
		"hq-manager-access": structure.viaManagers.length,
		"cycle": structure.cycles.reduce((sum, c) => sum + c.length, 0),
		"engine": structure.engine.length,
		"dead-export": structure.dead.deadExports.length,
		"dead-method": structure.dead.deadMethods.length,
		"stale-todo": structure.dead.staleTodos.length,
	};
}

/** The structure of the port from its modules and their users */
export function analyse(
	modules: ModuleInfo[],
	users: ModuleInfo[],
	called?: Set<string>,
	accesses: LayerAccesses = { violations: [], viaHq: [], viaManagers: [] },
): Structure
{
	const findings = modules.flatMap((m) => m.findings);
	const fanIn = new Map<string, Set<string>>();
	for (const mod of modules)
	{
		for (const edge of mod.imports)
		{
			const set = fanIn.get(edge.to) ?? new Set<string>();
			set.add(mod.file);
			fanIn.set(edge.to, set);
		}
	}
	return {
		modules,
		rules: findings.filter((f) => f.rule !== "engine"),
		layer: layerViolations(modules),
		cycles: importCycles(modules),
		engine: findings.filter((f) => f.rule === "engine"),
		dead: deadCode(modules, users, called),
		fan: modules.map((m) => ({
			file: m.file,
			fanIn: fanIn.get(m.file)?.size ?? 0,
			fanOut: new Set(m.imports.map((e) => e.to)).size,
		})),
		classes: modules.flatMap((m) => m.classes),
		access: accesses.violations,
		viaHq: accesses.viaHq,
		viaManagers: accesses.viaManagers,
	};
}

function listFiles(dir: string, keep: (path: string) => boolean): string[]
{
	const files: string[] = [];
	for (const entry of readdirSync(dir).sort())
	{
		const path = join(dir, entry);
		if (statSync(path).isDirectory())
		{
			files.push(...listFiles(path, keep));
		}
		else if (keep(path))
		{
			files.push(path);
		}
	}
	return files;
}

function table(header: string[], rows: Array<Array<string | number>>, right: number[] = []): string
{
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
	const line = (cells: Array<string | number>): string =>
		cells.map((c, i) => right.includes(i) ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i])).join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)].join("\n");
}

function option(args: string[], name: string): string | undefined
{
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

function main(args: string[]): void
{
	const repo = resolve(import.meta.dirname, "../..");
	const port = join(repo, "binaries/data/mods/public/simulation/ai/petra_ts");
	const baselineFile = join(import.meta.dirname, "structure-baseline.json");
	const top = Number(option(args, "--top") ?? 15);

	const modules = listFiles(
		port,
		(p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !relative(port, p).startsWith("tests"),
	).map((p) => analyseModule(relative(port, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));
	const userFiles = [
		...listFiles(join(port, "tests"), (p) => p.endsWith(".ts")),
		...listFiles(port, (p) => p.endsWith(".d.ts")),
		join(import.meta.dirname, "bot-state.js"),
	].filter((p) => existsSync(p));
	const users = userFiles.map((p) => analyseModule(relative(port, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));
	// the declarations name the port's types as import("./x.ts").Name
	for (const user of users)
	{
		const text = readFileSync(join(port, user.file), "utf8");
		for (const m of text.matchAll(/import\("(\.[^"]+)"\)\.(\w+)/g))
		{
			const to = resolveSpecifier(user.file, m[1]);
			if (to)
			{
				user.imports.push({ from: user.file, to, typeOnly: true, line: 0, names: [m[2]] });
			}
		}
	}
	const program = portProgram(join(import.meta.dirname, "tsconfig.tests.json"));
	const structure = analyse(modules, users, calledMethods(program, port), layerAccesses(program, port));
	const counts = trackedCounts(structure);
	const baseline: Record<string, number> = existsSync(baselineFile) ?
		JSON.parse(readFileSync(baselineFile, "utf8")) :
		{};

	const out: string[] = [];
	out.push(
		`Petra TS structure: ${modules.length} modules, ${structure.classes.length} classes, ` +
			`${modules.reduce((n, m) => n + m.imports.length, 0)} imports`,
	);
	out.push(
		`rules broken: ${structure.rules.length}` + (structure.rules.length ?
			"\n" + structure.rules.map((f) =>
				`  ${f.rule}  ${f.file}:${f.line}  ${f.text}`
			).join("\n") :
			""),
	);
	out.push(
		"tracked counts (baseline):  " + Object.entries(counts).map(([k, v]) =>
			`${k} ${v}${baseline[k] === undefined ? "" : ` (${baseline[k]})`}`
		).join(", "),
	);

	out.push("\nimports against the layers (adapter < world < execution < decision < root):");
	out.push(
		structure.layer.length ?
			table(
				["from", "to", "kind"],
				structure.layer.map((e) => [`${e.from}:${e.line}`, e.to, e.typeOnly ? "type" : "value"]),
			) :
			"  none",
	);
	out.push("\nmembers of a higher layer reached at run time (through gameState.ai and the like, no import):");
	out.push(
		structure.access.length ?
			table(
				["where", "layers", "declared in", "access"],
				structure.access.map((a) => [`${a.file}:${a.line}`, `${a.from} -> ${a.to}`, a.declared, a.text]),
			) :
			"  none",
	);
	const members = (list: LayerAccess[]): string =>
	{
		const by = new Map<string, number>();
		for (const a of list)
		{
			const name = a.text.split(".").at(-1)?.replace(/\W.*$/, "") ?? a.text;
			const key = `${a.declared.replace(/^decision\//, "")} ${name}`;
			by.set(key, (by.get(key) ?? 0) + 1);
		}
		return [...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
	};
	out.push(
		`\nexecution reaching decision through the headquarters' view (execution/hq.ts, sanctioned): ` +
			`${structure.viaHq.length} accesses: ${members(structure.viaHq)}`,
	);
	out.push(
		`\nexecution using the members of the managers the view hands out (decision/ classes, tracked): ` +
			`${structure.viaManagers.length} accesses: ${members(structure.viaManagers)}`,
	);
	out.push("\nvalue-import cycles:");
	out.push(
		structure.cycles.length ? structure.cycles.map((c) => `  ${c.length}: ${c.join(" ")}`).join("\n") : "  none",
	);
	out.push("\nEngine outside adapter/ (profiling apart):");
	out.push(
		structure.engine.length ? structure.engine.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join("\n") : "  none",
	);

	const list = (title: string, findings: Finding[]): void =>
	{
		out.push(`\n${title}: ${findings.length}`);
		for (const f of findings.slice(0, top))
		{
			out.push(`  ${f.file}:${f.line}  ${f.text}`);
		}
		if (findings.length > top)
		{
			out.push(`  ... ${findings.length - top} more`);
		}
	};
	list("dead exports (nothing uses them)", structure.dead.deadExports);
	list("dead methods (no code of the port names them; not marked TODO never called)", structure.dead.deadMethods);
	list("stale TODO never called (the port names them)", structure.dead.staleTodos);
	list("exports only their own module uses", structure.dead.localOnlyExports);
	list("exports only the tests or the build use", structure.dead.testOnlyExports);

	out.push("\nmodules, by fan-in:");
	out.push(
		table(
			["module", "fan-in", "fan-out"],
			[...structure.fan].sort((a, b) => b.fanIn - a.fanIn || b.fanOut - a.fanOut).slice(0, top).map((
				f,
			) => [f.file, f.fanIn, f.fanOut]),
			[1, 2],
		),
	);
	out.push("\nclasses, by methods (LCOM4: groups of methods sharing no field nor call, the hubs apart):");
	const classes = [...structure.classes].sort((a, b) => b.methods - a.methods).slice(0, top);
	out.push(
		table(
			["class", "where", "methods", "fields", "lcom4", "no this", "groups (sizes)"],
			classes.map((
				c,
			) => [
				c.name,
				`${c.file}:${c.line}`,
				c.methods,
				c.fields,
				c.lcom4,
				c.thisless.length,
				c.groups.filter((g) => g.length > 1).map((g) => g.length).join(" "),
			]),
			[2, 3, 4, 5],
		),
	);
	for (const c of classes)
	{
		if (c.hubs.length)
		{
			out.push(`  ${c.name}, hubs: ${c.hubs.join(", ")}`);
		}
		for (const group of c.groups.filter((g) => g.length > 1).slice(1, 4))
		{
			out.push(
				`  ${c.name}, a group of ${group.length}: ${group.slice(0, 8).join(", ")}${
					group.length > 8 ? ", ..." : ""
				}`,
			);
		}
		if (c.thisless.length)
		{
			out.push(`  ${c.name}, using no field nor method: ${c.thisless.join(", ")}`);
		}
	}
	console.log(out.join("\n"));

	const jsonFile = option(args, "--json");
	if (jsonFile)
	{
		writeFileSync(
			jsonFile,
			JSON.stringify(
				{
					counts,
					rules: structure.rules,
					layer: structure.layer,
					layerAccess: structure.access,
					viaHq: structure.viaHq,
					viaManagers: structure.viaManagers,
					cycles: structure.cycles,
					engine: structure.engine,
					dead: structure.dead,
					fan: structure.fan,
					classes: structure.classes,
				},
				null,
				"\t",
			),
		);
	}
	if (args.includes("--update-baseline"))
	{
		writeFileSync(baselineFile, JSON.stringify(counts, null, "\t") + "\n");
		console.log(`\nbaseline written: ${relative(repo, baselineFile)}`);
	}
	if (args.includes("--check"))
	{
		const rose = Object.entries(counts).filter(([k, v]) => v > (baseline[k] ?? Infinity));
		for (const [k, v] of rose)
		{
			console.log(`check: ${k} rose to ${v} (baseline ${baseline[k]})`);
		}
		if (structure.rules.length || rose.length)
		{
			process.exit(1);
		}
		console.log("\ncheck: no rule broken, no tracked count above the baseline");
	}
}

if (import.meta.filename === resolve(process.argv[1] ?? ""))
{
	main(process.argv.slice(2));
}
