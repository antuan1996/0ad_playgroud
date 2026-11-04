/**
 * The measures of quality.ts on small sources with known values.
 *
 *   node --test build/petra_ts/quality.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicatedLinesByFile, findClones, measureSource, type FunctionMetrics } from "./quality.ts";

function only(text: string, name: string): FunctionMetrics
{
	const found = measureSource("m.ts", text).functions.find((f) => f.name === name);
	assert.ok(found, `${name} measured`);
	return found;
}

test("SonarSource's labelled-loop example: cognitive 7, cyclomatic 4", () =>
{
	const f = only(`
function sumOfPrimes(max: number): number
{
	let total = 0;
	OUT: for (let i = 1; i <= max; ++i)
	{
		for (let j = 2; j < i; ++j)
		{
			if (i % j === 0)
				continue OUT;
		}
		total += i;
	}
	return total;
}`, "sumOfPrimes");
	// the loops +1 and +2 (nested), the if +3, the labelled continue +1
	assert.deepEqual([f.cognitive, f.cyclomatic, f.depth, f.params, f.lines], [7, 4, 3, 1, 14]);
});

test("a switch costs 1 for the reader and each case 1 for the paths", () =>
{
	const f = only(`
function getWords(n: number): string
{
	switch (n)
	{
	case 1: return "one";
	case 2: return "a couple";
	case 3: return "a few";
	default: return "lots";
	}
}`, "getWords");
	assert.deepEqual([f.cognitive, f.cyclomatic], [1, 4]);
});

test("else and else if cost 1 without nesting; each run of like logical operators 1", () =>
{
	const f = only(`
function pick(a: boolean, b: boolean, c: boolean, d: boolean): number
{
	if (a && b || c)
		return 1;
	else if (d)
		return 2;
	else
		return 3;
}`, "pick");
	// if 1, the runs "&&" and "||" 2, else if 1, else 1; paths: if, &&, ||, else if
	assert.deepEqual([f.cognitive, f.cyclomatic, f.depth], [5, 5, 1]);
	const runs = only("function g(a: boolean, b: boolean, c: boolean): boolean { return a && b && (c && a); }", "g");
	assert.equal(runs.cognitive, 1, "one run of &&, parentheses or not");
	assert.equal(runs.cyclomatic, 4);
	const nullish = only("function h(a?: number, b?: number): number { return a ?? b ?? 0; }", "h");
	assert.deepEqual([nullish.cognitive, nullish.cyclomatic], [1, 3]);
	const chained = only("function k(a?: { b?: number }): number | undefined { return a?.b; }", "k");
	assert.deepEqual([chained.cognitive, chained.cyclomatic], [0, 1], "optional chaining is no branch here");
});

test("nesting raises the cost: an if in a loop in an if, a ternary inside", () =>
{
	const f = only(`
function deep(xs: number[], on: boolean): number
{
	let n = 0;
	if (on)
		for (const x of xs)
			if (x > 0)
				n += x > 10 ? 2 : 1;
	return n;
}`, "deep");
	// if 1, for 2, if 3, ternary 4
	assert.deepEqual([f.cognitive, f.cyclomatic, f.depth], [10, 5, 4]);
});

test("a callback is measured on its own, under its function's name", () =>
{
	const { functions, classes } = measureSource("m.ts", `
export class Plan
{
	units: number[] = [];
	name = "p";
	constructor() {}
	get size(): number { return this.units.length; }
	choose(): number[]
	{
		return this.units.filter((u) =>
		{
			if (u > 0)
				return true;
			return false;
		});
	}
}`);
	assert.deepEqual(functions.map((f) => f.name), ["Plan.constructor", "Plan.size", "Plan.choose", "Plan.choose > arrow@10"]);
	const choose = functions.find((f) => f.name === "Plan.choose");
	const arrow = functions.find((f) => f.name.startsWith("Plan.choose > arrow"));
	assert.deepEqual([choose?.cognitive, choose?.cyclomatic], [0, 1], "the arrow's if is the arrow's");
	assert.deepEqual([arrow?.cognitive, arrow?.cyclomatic, arrow?.params], [1, 2, 1]);
	assert.deepEqual(classes.map((c) => [c.name, c.methods, c.fields, c.lines]), [["Plan", 3, 2, 16]]);
});

test("functions take the names they are known by", () =>
{
	const names = measureSource("m.ts", `
const helper = (x: number): number => x;
export function named(): void {}
const table = { "entry": function(): void {}, other: (): void => undefined };
[1].map((x) => x);`).functions.map((f) => f.name);
	assert.deepEqual(names, ["helper", "named", "entry", "other", "(module) > arrow@5"]);
});

test("overload signatures are no functions", () =>
{
	const names = measureSource("m.ts", `
function pick(a: number): number;
function pick(a: string): string;
function pick(a: number | string): number | string { return a; }`).functions.map((f) => f.name);
	assert.deepEqual(names, ["pick"]);
});

test("code lines leave out comments and blank lines", () =>
{
	const { module } = measureSource("m.ts", `
/**
 * A comment of three lines.
 */
// another
export const a = 1;   // trailing

export const b = \`two
lines\`;
`);
	assert.equal(module.codeLines, 3);
});

const BODY = `
	let total = 0;
	for (const value of values)
	{
		if (value > limit)
			total += value * 2;
		else
			total -= value;
	}
	return total;
`;

test("a function copied into another module is one clone with two copies; imports are no clone", () =>
{
	const imports = Array.from({ length: 12 }, (_, i) => `import { thing${i} } from "./module${i}.ts";`).join("\n");
	const clones = findClones([
		{ "file": "a.ts", "text": `${imports}\nexport function first(values: number[], limit: number): number\n{${BODY}}\n` },
		{ "file": "b.ts", "text": `${imports}\nexport const x = 1;\nexport function first(values: number[], limit: number): number\n{${BODY}}\n` }
	], 40, 5);
	assert.equal(clones.length, 1);
	assert.deepEqual(clones[0].copies.map((c) => [c.file, c.startLine, c.endLine]), [["a.ts", 13, 24], ["b.ts", 14, 25]]);
	assert.deepEqual([...duplicatedLinesByFile(clones)], [["a.ts", 12], ["b.ts", 12]]);
});

test("renamed copies are found only when asked; short or overlapping runs are not clones", () =>
{
	const renamedBody = BODY.replaceAll("total", "sum").replaceAll("value", "item");
	const sources = [
		{ "file": "a.ts", "text": `function first(values: number[], limit: number): number\n{${BODY}}\n` },
		{ "file": "b.ts", "text": `function second(values: number[], limit: number): number\n{${renamedBody}}\n` }
	];
	assert.equal(findClones(sources, 40, 5).length, 0);
	const renamed = findClones(sources, 40, 5, true);
	assert.equal(renamed.length, 1);
	assert.equal(renamed[0].copies.length, 2);
	assert.equal(findClones(sources, 400, 5, true).length, 0, "shorter than the minimum");
	const repeated = { "file": "c.ts", "text": "const a = [" + "1, ".repeat(200) + "];\n" };
	assert.equal(findClones([repeated], 40, 1).length, 0, "a run repeating itself is no copy of code");
});

test("three copies are one clone", () =>
{
	const text = ["one", "two", "three"].map((name) => `function ${name}(values: number[], limit: number): number\n{${BODY}}\n`).join("\n");
	const clones = findClones([{ "file": "a.ts", text }], 40, 5);
	assert.equal(clones.length, 1);
	assert.equal(clones[0].copies.length, 3);
});
