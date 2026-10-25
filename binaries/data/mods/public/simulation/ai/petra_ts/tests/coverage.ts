/**
 * Line, function and block coverage of Petra, read straight from V8.
 *
 *   node tests/coverage.ts                 # the port: simulation/ai/petra_ts/**\/*.ts
 *   node tests/coverage.ts out             # the built bot: simulation/ai/petra_out/**\/*.js
 *   node tests/coverage.ts src --file worker        # one module's never-run lines and blocks
 *   node tests/coverage.ts src --json cov.json      # everything, for other tools
 *
 * Why not `--experimental-test-coverage`: its line figure counts a line as run
 * when V8 left out the line's block, and V8 leaves a block out whenever the
 * block ran as often as its parent did. Across the suite's processes (one per
 * test file) that reads whole never-run blocks as run: worker.ts showed 100%
 * lines while a marker planted in those blocks never fired.
 *
 * This tool runs the suite once with NODE_V8_COVERAGE, then per test process
 * resolves every source character to the innermost V8 range around it, takes
 * the highest count any process saw, and only then folds characters into
 * lines. Node strips TypeScript types by blanking them, so V8's offsets are
 * offsets into the .ts file as written.
 *
 * What it counts, per module:
 * - lines: lines holding code (not blank, comment, lone brace/`else`, or a
 *   TypeScript-only declaration), and of those the lines where any code ran;
 * - blocks: stretches of code that never ran — a whole branch, a `continue;`
 *   no test took, a `?? -1` fallback never used — roughly V8's branch misses;
 * - functions: function bodies V8 saw called at least once.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { petraModuleDir, type PetraTarget } from "./harness/paths.ts";

interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { functionName: string; ranges: V8Range[]; isBlockCoverage: boolean }
interface V8Script { url: string; functions: V8Function[] }

interface Block { line: number; column: number; text: string }

interface ModuleCoverage
{
	module: string;
	loaded: boolean;
	codeLines: number;
	runLines: number;
	missedLines: number[];
	missedBlocks: Block[];
	functions: number;
	runFunctions: number;
	missedFunctions: string[];
}

interface TargetCoverage
{
	target: PetraTarget;
	tests: { total: number; pass: number; fail: number };
	modules: ModuleCoverage[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Run the whole suite against one target with V8 coverage written to a fresh directory. */
function runSuite(target: PetraTarget): { dir: string; tests: TargetCoverage["tests"] }
{
	const dir = mkdtempSync(path.join(os.tmpdir(), `petra-cov-${target}-`));
	const pattern = `${here.split(path.sep).join("/")}/**/*.test.ts`;
	const result = spawnSync(process.execPath, ["--test", pattern], {
		"env": { ...process.env, "PETRA_TARGET": target, "NODE_V8_COVERAGE": dir },
		"encoding": "utf8",
		"maxBuffer": 256 * 1024 * 1024
	});
	if (result.error)
		throw result.error;
	const summary = (name: string): number =>
		Number(new RegExp(`^ℹ ${name} (\\d+)$`, "m").exec(result.stdout)?.[1] ?? NaN);
	return { dir, "tests": { "total": summary("tests"), "pass": summary("pass"), "fail": summary("fail") } };
}

/**
 * Mark the characters that are code: not whitespace, not inside a comment.
 * Strings, template literals and regular expressions count as code.
 */
function codeMask(source: string): Uint8Array
{
	const mask = new Uint8Array(source.length);
	let i = 0;
	// the last code character, to tell a regular expression from a division
	let previous = "";
	while (i < source.length)
	{
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/")
		{
			while (i < source.length && source[i] !== "\n")
				++i;
			continue;
		}
		if (c === "/" && next === "*")
		{
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`" || c === "/" && (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous)))
		{
			const start = i++;
			let inClass = false;
			while (i < source.length)
			{
				const d = source[i];
				if (d === "\\")
				{
					i += 2;
					continue;
				}
				if (c === "/" && d === "[")
					inClass = true;
				else if (c === "/" && d === "]")
					inClass = false;
				else if (d === c && !inClass)
					break;
				else if (d === "\n" && c !== "`")
					break;
				++i;
			}
			++i;
			mask.fill(1, start, Math.min(i, source.length));
			previous = c;
			continue;
		}
		if (!/\s/.test(c))
		{
			mask[i] = 1;
			previous = c;
		}
		++i;
	}
	return mask;
}

/**
 * Lines that hold TypeScript-only declarations, which no engine runs: an
 * interface or type alias (to its end), `declare` members, `import type`.
 */
function typeOnlyLines(lines: string[]): Set<number>
{
	const skip = new Set<number>();
	for (let k = 0; k < lines.length; ++k)
	{
		const text = lines[k].trim();
		if (/^(export\s+)?declare\s/.test(text) || /^declare\s/.test(text) || /^(import|export)\s+type\s/.test(text))
		{
			skip.add(k);
			continue;
		}
		if (!/^(export\s+)?(interface|type)\s+\w/.test(text))
			continue;
		// to the end of the declaration: braces balanced, and a `;` or `}` closing it
		let depth = 0;
		for (let j = k; j < lines.length; ++j)
		{
			skip.add(j);
			for (const ch of lines[j])
				depth += ch === "{" || ch === "(" || ch === "<" ? 1 : ch === "}" || ch === ")" || ch === ">" ? -1 : 0;
			const end = lines[j].trimEnd();
			if (depth <= 0 && (end.endsWith(";") || end.endsWith("}")))
			{
				k = j;
				break;
			}
		}
	}
	return skip;
}

/** The coverage scripts V8 wrote for one module, from every test process. */
function scriptsFor(coverageDir: string, file: string): V8Script[]
{
	const url = "file://" + file;
	const scripts: V8Script[] = [];
	for (const name of readdirSync(coverageDir))
	{
		if (!name.endsWith(".json"))
			continue;
		const data = JSON.parse(readFileSync(path.join(coverageDir, name), "utf8")) as { result: V8Script[] };
		for (const script of data.result)
			if (script.url === url)
				scripts.push(script);
	}
	return scripts;
}

/** The highest count any process saw at each character, innermost range first. */
function characterCounts(scripts: V8Script[], length: number): Int32Array
{
	const best = new Int32Array(length);
	for (const script of scripts)
	{
		const counts = new Int32Array(length);
		const ranges = script.functions.flatMap((fn) => fn.ranges)
			.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
		for (const range of ranges)
			counts.fill(range.count, range.startOffset, Math.min(range.endOffset, length));
		for (let i = 0; i < length; ++i)
			if (counts[i] > best[i])
				best[i] = counts[i];
	}
	return best;
}

/** A line is code when, once comments and lone punctuation are gone, something is left. */
function isCodeText(text: string): boolean
{
	const stripped = text.replace(/[\s{}()[\];,]/g, "");
	return stripped !== "" && stripped !== "else";
}

function analyseModule(coverageDir: string, file: string): ModuleCoverage
{
	const source = readFileSync(file, "utf8");
	const module = path.basename(file).replace(/\.(ts|js)$/, "");
	const scripts = scriptsFor(coverageDir, file);
	const mask = codeMask(source);
	const counts = characterCounts(scripts, source.length);

	const lines = source.split("\n");
	const typeOnly = typeOnlyLines(lines);
	let offset = 0;
	let codeLines = 0;
	let runLines = 0;
	const missedLines: number[] = [];
	for (let k = 0; k < lines.length; ++k)
	{
		const start = offset;
		offset += lines[k].length + 1;
		if (typeOnly.has(k))
			continue;
		let code = "";
		let ran = false;
		for (let i = start; i < start + lines[k].length; ++i)
		{
			if (!mask[i])
				continue;
			code += source[i];
			if (counts[i] > 0 && !"{}()[];,".includes(source[i]))
				ran = true;
		}
		if (!isCodeText(code))
			continue;
		++codeLines;
		if (ran && scripts.length)
			++runLines;
		else
			missedLines.push(k + 1);
	}

	// stretches of code never run: maximal runs of zero-count code characters
	const missedBlocks: Block[] = [];
	const lineStarts = [0];
	for (let i = 0; i < source.length; ++i)
		if (source[i] === "\n")
			lineStarts.push(i + 1);
	const lineOf = (i: number): number =>
	{
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi)
		{
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= i)
				lo = mid;
			else
				hi = mid - 1;
		}
		return lo;
	};
	if (scripts.length)
	{
		let i = 0;
		while (i < source.length)
		{
			if (!mask[i] || counts[i] > 0 || typeOnly.has(lineOf(i)))
			{
				++i;
				continue;
			}
			const start = i;
			let text = "";
			while (i < source.length && (!mask[i] || counts[i] === 0))
			{
				if (mask[i])
					text += source[i];
				else if (text && !text.endsWith(" "))
					text += " ";
				++i;
			}
			if (isCodeText(text))
			{
				const line = lineOf(start);
				missedBlocks.push({ "line": line + 1, "column": start - lineStarts[line] + 1, "text": text.trim() });
			}
		}
	}

	// functions, keyed by where they start; the module's top level is not one
	const seen = new Map<number, { name: string; count: number }>();
	for (const script of scripts)
		for (const fn of script.functions)
		{
			const start = fn.ranges[0].startOffset;
			if (start === 0 && fn.functionName === "")
				continue;
			const known = seen.get(start);
			seen.set(start, { "name": fn.functionName || `<anonymous>@${lineOf(start) + 1}`,
				"count": Math.max(known?.count ?? 0, fn.ranges[0].count) });
		}
	const fns = [...seen.values()];

	return {
		module,
		"loaded": scripts.length > 0,
		codeLines,
		runLines,
		missedLines,
		missedBlocks,
		"functions": fns.length,
		"runFunctions": fns.filter((f) => f.count > 0).length,
		"missedFunctions": fns.filter((f) => f.count === 0).map((f) => f.name)
	};
}

function analyseTarget(target: PetraTarget): TargetCoverage
{
	const { dir, tests } = runSuite(target);
	try
	{
		const { "dir": moduleDir, ext } = petraModuleDir(target);
		const files = (readdirSync(moduleDir, { "recursive": true }) as string[])
			.map((name) => name.split(path.sep).join("/"))
			.filter((name) => name.endsWith(ext) && !name.endsWith(".d.ts") && !name.startsWith("tests/"))
			.sort((a, b) => path.posix.basename(a).localeCompare(path.posix.basename(b)))
			.map((name) => path.join(moduleDir, name));
		return { target, tests, "modules": files.map((file) => analyseModule(dir, file)) };
	}
	finally
	{
		rmSync(dir, { "recursive": true, "force": true });
	}
}

const pct = (part: number, whole: number): string => whole ? (100 * part / whole).toFixed(1).padStart(5) + "%" : "    –";

/** Collapse sorted line numbers into "3-7 12 15-16". */
function ranges(lines: number[]): string
{
	const out: string[] = [];
	for (let k = 0; k < lines.length; ++k)
	{
		let j = k;
		while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1)
			++j;
		out.push(j > k ? `${lines[k]}-${lines[j]}` : `${lines[k]}`);
		k = j;
	}
	return out.join(" ");
}

function totals(modules: ModuleCoverage[])
{
	return modules.reduce((sum, m) => ({
		"codeLines": sum.codeLines + m.codeLines, "runLines": sum.runLines + m.runLines,
		"blocks": sum.blocks + m.missedBlocks.length,
		"functions": sum.functions + m.functions, "runFunctions": sum.runFunctions + m.runFunctions
	}), { "codeLines": 0, "runLines": 0, "blocks": 0, "functions": 0, "runFunctions": 0 });
}

function printTable(result: TargetCoverage): void
{
	const { tests } = result;
	console.log(`\n${result.target}: ${tests.total} tests, ${tests.pass} pass, ${tests.fail} fail`);
	console.log("module               lines run/code      %   blocks missed   functions run/all      %");
	for (const m of result.modules)
	{
		const name = (m.loaded ? m.module : m.module + " *").padEnd(20);
		console.log(`${name} ${`${m.runLines}/${m.codeLines}`.padStart(14)} ${pct(m.runLines, m.codeLines)}` +
			`   ${String(m.missedBlocks.length).padStart(13)}   ${`${m.runFunctions}/${m.functions}`.padStart(17)} ${pct(m.runFunctions, m.functions)}`);
	}
	const t = totals(result.modules);
	console.log(`${"all modules".padEnd(20)} ${`${t.runLines}/${t.codeLines}`.padStart(14)} ${pct(t.runLines, t.codeLines)}` +
		`   ${String(t.blocks).padStart(13)}   ${`${t.runFunctions}/${t.functions}`.padStart(17)} ${pct(t.runFunctions, t.functions)}`);
	if (result.modules.some((m) => !m.loaded))
		console.log("* not loaded by any test");
}

function printModule(result: TargetCoverage, name: string): void
{
	const m = result.modules.find((mod) => mod.module === name);
	if (!m)
	{
		console.error(`${result.target}: no module "${name}"`);
		process.exitCode = 2;
		return;
	}
	console.log(`\n${result.target} ${m.module}: lines ${m.runLines}/${m.codeLines} (${pct(m.runLines, m.codeLines).trim()}),` +
		` functions ${m.runFunctions}/${m.functions}, ${m.missedBlocks.length} blocks never run` +
		(m.loaded ? "" : " — not loaded by any test"));
	if (m.missedFunctions.length)
		console.log(`functions never called: ${m.missedFunctions.join(", ")}`);
	if (m.missedLines.length)
		console.log(`lines never run: ${ranges(m.missedLines)}`);
	for (const block of m.missedBlocks)
		console.log(`  ${`${block.line}:${block.column}`.padEnd(9)} ${block.text.length > 100 ? block.text.slice(0, 97) + "..." : block.text}`);
}

const args = process.argv.slice(2);
const option = (flag: string): string | undefined =>
{
	const at = args.indexOf(flag);
	return at === -1 ? undefined : args[at + 1];
};
const mode = args[0] && !args[0].startsWith("--") ? args[0] : "src";
if (mode !== "src" && mode !== "out")
{
	console.error("usage: coverage.ts [src|out] [--file <module>] [--json <path>]");
	process.exit(2);
}
const results = [analyseTarget(mode)];
const file = option("--file");

if (file)
	results.forEach((result) => printModule(result, file));
else
	printTable(results[0]);

const json = option("--json");
if (json)
	writeFileSync(json, JSON.stringify(results, null, "\t"));
