/**
 * The checks of structure.ts on small sources with known answers.
 *
 *   node --test build/petra_ts/structure.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { analyse, analyseModule, calledMethods, importCycles, layerOf, layerViolations } from "./structure.ts";

function rules(file: string, text: string): string[]
{
	return analyseModule(file, text).findings.map((f) => f.rule);
}

test("a module's layer is its folder; the bot's root is above them all", () =>
{
	assert.deepEqual(["adapter/a.ts", "world/b.ts", "execution/c.ts", "decision/d.ts", "_petrabot.ts"].map(layerOf), [
		"adapter",
		"world",
		"execution",
		"decision",
		"root",
	]);
});

test("casts and non-null assertions break the rules, but in brands.ts and for as const", () =>
{
	assert.deepEqual(
		rules("world/a.ts", "const x = y as number; const z = [1] as const; const w = <string>v; const n = m!;"),
		["cast", "cast", "non-null"],
	);
	assert.deepEqual(rules("adapter/brands.ts", "export const id = (v: number) => v as EntityId;"), []);
});

test("only commands.ts posts commands, and only adapter/ uses Engine (profiling apart)", () =>
{
	assert.deepEqual(
		rules("decision/a.ts", "Engine.PostCommand(1); Engine.ProfileStart(\"x\"); Engine.ProfileStop();"),
		["post-command", "engine"],
	);
	assert.deepEqual(rules("adapter/commands.ts", "Engine.PostCommand(1);"), []);
	assert.deepEqual(rules("execution/b.ts", "Engine.ComputePath(a, b, c);"), ["engine"]);
});

test("execution code reaches the headquarters through hq.ts only", () =>
{
	assert.deepEqual(
		rules(
			"execution/a.ts",
			"import type { Headquarters } from \"../decision/headquarters.ts\"; const h = gameState.ai.HQ;",
		),
		["hq-access", "hq-access"],
	);
	assert.deepEqual(
		rules(
			"execution/hq.ts",
			"import type { Headquarters } from \"../decision/headquarters.ts\"; const h = gameState.ai.HQ;",
		),
		[],
	);
	assert.deepEqual(rules("decision/b.ts", "const h = gameState.ai.HQ;"), []);
});

test("imports against the layers' order are counted, type-only ones too; hq.ts's view is allowed", () =>
{
	const modules = [
		analyseModule("adapter/a.ts", "import { B } from \"../world/b.ts\";"),
		analyseModule(
			"world/b.ts",
			"import type { C } from \"../decision/c.ts\"; import { D } from \"../adapter/d.ts\";",
		),
		analyseModule("execution/hq.ts", "import type { Headquarters } from \"../decision/headquarters.ts\";"),
		analyseModule(
			"decision/c.ts",
			"import { E } from \"../execution/e.ts\"; import { F } from \"simulation/ai/common-api/f.js\";",
		),
	];
	assert.deepEqual(layerViolations(modules).map((e) => [e.from, e.to, e.typeOnly]), [[
		"adapter/a.ts",
		"world/b.ts",
		false,
	], ["world/b.ts", "decision/c.ts", true]]);
});

test("cycles are found among value imports only", () =>
{
	const modules = [
		analyseModule("execution/a.ts", "import { B } from \"./b.ts\";"),
		analyseModule("execution/b.ts", "import { C } from \"./c.ts\";"),
		analyseModule("execution/c.ts", "import { A } from \"./a.ts\"; import type { D } from \"./d.ts\";"),
		analyseModule("execution/d.ts", "import type { C } from \"./c.ts\"; import { type E } from \"./c.ts\";"),
	];
	assert.deepEqual(importCycles(modules), [["execution/a.ts", "execution/b.ts", "execution/c.ts"]]);
});

test("exports: dead, used only in their module, only by the tests, or through a namespace import", () =>
{
	const modules = [
		analyseModule(
			"world/a.ts",
			"export const USED = 1; export const LOCAL = 2; export const DEAD = 3; export function f(): number { return LOCAL; }" +
				" export const TESTED = 4; export const VIA_NS = 5;",
		),
		analyseModule(
			"decision/b.ts",
			"import { USED, f } from \"../world/a.ts\"; import * as a from \"../world/a.ts\"; const x = USED + f() + a.VIA_NS;",
		),
	];
	const users = [analyseModule("tests/a.test.ts", "import { TESTED } from \"../world/a.ts\";")];
	const { dead } = analyse(modules, users);
	assert.deepEqual(dead.deadExports.map((f) => f.text), ["DEAD"]);
	assert.deepEqual(dead.localOnlyExports.map((f) => f.text), ["LOCAL"]);
	assert.deepEqual(dead.testOnlyExports.map((f) => f.text), ["TESTED"]);
});

test("methods no code names are dead, unless marked; a marked one the port calls is stale", () =>
{
	const modules = [analyseModule(
		"world/a.ts",
		`export class A
{
	used(): void {}
	unused(): void {}
	/** TODO never called (nor in the original Petra): remove it */
	marked(): void {}
	/** TODO never called (nor in the original Petra): remove it */
	called(): void {}
	OnUpdate(): void {}
	run(): void { this.used(); this.called(); }
}`,
	)];
	const users = [analyseModule("tests/a.test.ts", "new A().unused(); new A().marked();")];
	const { dead } = analyse(modules, users);
	assert.deepEqual(dead.deadMethods.map((f) => f.text), ["A.unused", "A.run"]);
	assert.deepEqual(dead.staleTodos.map((f) => f.text), ["A.called"]);
});

test("the type checker tells the calls of one method from those of another of the same name", () =>
{
	const port = "/port";
	const files: Record<string, string> = {
		"/port/a.ts": "export class A { /** TODO never called */ size(): number { return 1; } }",
		"/port/b.ts": "import { A } from \"./a.ts\"; export class B { size(): number { return 2; } }\n" +
			"export function f(b: B, a: A): number { return b.size() + (a ? 0 : 1); }",
		"/port/tests/t.ts": "import { A } from \"../a.ts\"; new A().size();",
	};
	const options: ts.CompilerOptions = {
		allowImportingTsExtensions: true,
		noEmit: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noLib: true,
		types: [],
	};
	const host = ts.createCompilerHost(options);
	host.getSourceFile = (name: string) =>
		name in files ? ts.createSourceFile(name, files[name], ts.ScriptTarget.ES2022, true) : undefined;
	host.fileExists = (name: string) => name in files;
	host.readFile = (name: string) => files[name];
	const program = ts.createProgram(Object.keys(files), options, host);
	const called = calledMethods(program, port);
	assert.deepEqual([...called], ["b.ts:1"], "B.size is called, A.size only by a test");

	const modules = [analyseModule("a.ts", files["/port/a.ts"]), analyseModule("b.ts", files["/port/b.ts"])];
	assert.deepEqual(analyse(modules, [], called).dead.staleTodos, [], "by name, A.size would look called");
	assert.deepEqual(analyse(modules, []).dead.staleTodos.map((f) => f.text), ["A.size"]);
});

test("a class's cohesion: groups of methods linked by fields and calls, and methods using neither", () =>
{
	const [cls] = analyseModule(
		"world/a.ts",
		`class Two
{
	x = 0;
	y = 0;
	constructor(private z: number) {}
	readX(): number { return this.x; }
	writeX(): void { this.x = 1; this.helper(); }
	helper(): void {}
	readY(): number { return this.y + this.z; }
	pure(a: number): number { return a + 1; }
	static make(): Two { return new Two(1); }
}`,
	).classes;
	assert.deepEqual([cls.methods, cls.fields, cls.lcom4], [5, 3, 3]);
	assert.deepEqual(cls.groups, [["readX", "writeX", "helper"], ["readY"], ["pure"]]);
	assert.deepEqual(cls.thisless, ["helper", "pure"]);
});

test("in a class of nine methods or more, a member used by more than an eighth of them links no group", () =>
{
	const methods = "abcdefghklmnopqr".split("").map((m) => `${m}(): number { return this.config; }`).join("\n");
	const [cls] = analyseModule(
		"world/a.ts",
		`class Big
{
	config = 1;
	other = 2;
	${methods}
	i(): number { return this.other; }
	j(): number { return this.other; }
}`,
	).classes;
	assert.deepEqual(cls.hubs, ["config"]);
	assert.deepEqual([cls.methods, cls.lcom4], [18, 17]);
	assert.deepEqual(cls.groups[0], ["i", "j"]);
});
