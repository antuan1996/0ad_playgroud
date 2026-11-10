/**
 * The checks of structure.ts on small sources with known answers.
 *
 *   node --test build/petra_ts/structure.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { partCohesion, typeWidth } from "./coupling.ts";
import {
	NEW_CLASS_CORE_MAX,
	analyse,
	analyseModule,
	calledMethods,
	cohesionChanges,
	cohesionFigures,
	importCycles,
	layerAccesses,
	layerOf,
	layerViolations,
} from "./structure.ts";

/** The global types the checker needs to type anything (noLib: no standard library) */
const MINIMAL_LIB = "interface Array<T> { length: number; } interface Boolean {} interface CallableFunction {} " +
	"interface Function {} interface IArguments {} interface NewableFunction {} interface Number {} " +
	"interface Object {} interface RegExp {} interface String {} type Readonly<T> = { readonly [P in keyof T]: T[P] }; " +
	"type Pick<T, K extends keyof T> = { [P in K]: T[P] };";

/** A type-checked program of in-memory files, on a minimal standard library */
function programOf(given: Record<string, string>): ts.Program
{
	const files: Record<string, string> = { "/lib/minimal.d.ts": MINIMAL_LIB, ...given };
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
	// the files are in memory: their folders are those the names hold
	host.directoryExists = (dir: string) => Object.keys(files).some((name) => name.startsWith(dir + "/"));
	host.realpath = (name: string) => name;
	return ts.createProgram(Object.keys(files), options, host);
}

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

test("only the bot reads gameState.ai.HQ, and no execution code imports the headquarters", () =>
{
	assert.deepEqual(
		rules(
			"execution/a.ts",
			"import type { Headquarters } from \"../decision/headquarters.ts\"; const h = gameState.ai.HQ;",
		),
		["hq-access", "hq-access"],
	);
	assert.deepEqual(
		rules("decision/b.ts", "import type { Headquarters } from \"./headquarters.ts\"; const h = gameState.ai.HQ;"),
		["hq-access"],
		"a manager is given its view of the headquarters; its type it may import",
	);
	assert.deepEqual(rules("_petrabot.ts", "const h = this.ai.HQ;"), [], "the bot owns the headquarters");
});

test("imports against the layers' order are counted, type-only ones too", () =>
{
	const modules = [
		analyseModule("adapter/a.ts", "import { B } from \"../world/b.ts\";"),
		analyseModule(
			"world/b.ts",
			"import type { C } from \"../decision/c.ts\"; import { D } from \"../adapter/d.ts\";",
		),
		analyseModule("execution/view.ts", "import type { Headquarters } from \"../decision/headquarters.ts\";"),
		analyseModule(
			"decision/c.ts",
			"import { E } from \"../execution/e.ts\"; import { F } from \"simulation/ai/common-api/f.js\";",
		),
	];
	assert.deepEqual(layerViolations(modules).map((e) => [e.from, e.to, e.typeOnly]), [
		["adapter/a.ts", "world/b.ts", false],
		["world/b.ts", "decision/c.ts", true],
		["execution/view.ts", "decision/headquarters.ts", true],
	]);
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
	const program = programOf(files);
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

test("a forwarder passes one call or read on to a member of a field; the core cohesion leaves forwarders out", () =>
{
	const [cls] = analyseModule(
		"execution/a.ts",
		`class Desk
{
	private readonly manager: Manager;
	private plans: number[] = [];
	constructor(manager: Manager) { this.manager = manager; }
	get ships(): number { return this.manager.ships; }
	fleet(sea: number): number { return this.manager.fleet(sea); }
	report(sea: number): void { this.manager.navy.report(sea, true); }
	add(plan: number): void { this.plans.push(plan); }
	count(): number { return this.plans.length + this.manager.ships; }
	asked(sea: number): number { return this.manager.fleet(sea + 1); }
	twice(): void { this.manager.a(); this.manager.b(); }
}`,
	).classes;
	assert.deepEqual(
		cls.forwarders,
		["ships", "fleet", "report"],
		"an argument computed, or two calls, is no forwarding",
	);
	// all linked through manager (a small class has no hubs): forwarders apart, the rest still one group
	assert.deepEqual([cls.lcom4, cls.coreLcom4], [1, 1]);
});

test("forwarders apart, a facade's own groups are what is left", () =>
{
	const forwards = "abcdefghk".split("").map((m) => `${m}(x: number): number { return this.hq.${m}(x); }`).join("\n");
	const [cls] = analyseModule(
		"execution/a.ts",
		`class Facade
{
	private readonly hq: Hq;
	private cache = 0;
	${forwards}
	read(): number { return this.cache; }
	clear(): void { this.cache = 0; }
}`,
	).classes;
	// of the eleven methods, hq and cache are hubs: each a group of its own; of the two own ones, cache (the class's
	// own state, never a hub of the core) links both
	assert.deepEqual([cls.methods, cls.lcom4, cls.forwarders.length, cls.coreLcom4], [11, 11, 9, 1]);
});

test("in the core, the class's own state links its methods however many use it; a collaborator they all ask does not", () =>
{
	const own = "abcdefghklmn".split("").map((m) => `${m}(): number { return this.plans.length + this.config.x; }`)
		.join("\n");
	const [cls] = analyseModule(
		"execution/a.ts",
		`class Registry
{
	private readonly config: Config;
	private plans: number[] = [];
	${own}
	other(): number { return this.config.y + 1; }
}`,
	).classes;
	// both are hubs of the whole class: thirteen groups; the core keeps plans, which links the twelve
	assert.deepEqual([cls.methods, cls.lcom4, cls.coreLcom4], [13, 13, 2]);
});

test("a getter and setter passed on to a collaborator forward; a field set fresh in the constructor is own state", () =>
{
	const own = "abcdefghk".split("").map((m) => `${m}(): number { return this.cache.x + this.config.y; }`).join("\n");
	const [cls] = analyseModule(
		"decision/a.ts",
		`class Office
{
	geography: Geography;
	config: Config;
	cache: Cache;
	constructor(geography: Geography, config: Config) { this.geography = geography; this.config = config; this.cache = {}; }
	get navalMap(): boolean { return this.geography.navalMap; }
	set navalMap(naval: boolean) { this.geography.navalMap = naval; }
	${own}
}`,
	).classes;
	assert.deepEqual(cls.forwarders, ["navalMap"]);
	// cache, set to {} in the constructor, is the office's own: it links the nine; config, given, is a hub
	assert.deepEqual([cls.methods, cls.coreLcom4], [10, 1]);
});

test("a value typed as the whole Headquarters outside it is counted; a view of it is not", () =>
{
	assert.deepEqual(
		analyseModule(
			"decision/a.ts",
			"import type { Headquarters } from \"./headquarters.ts\";\n" +
				"function f(hq: Headquarters): void {}\n" +
				"function g(hq: Pick<Headquarters, \"canBuild\">): Headquarters[\"economy\"] { return hq.economy; }\n" +
				"class C { hq: Headquarters; }\n" +
				"function h(): Headquarters { return x; }",
		).findings.map((f) => [f.rule, f.text]),
		[["whole-hq", "hq: Headquarters"], ["whole-hq", "hq: Headquarters"], ["whole-hq", "h: Headquarters"]],
	);
	assert.deepEqual(rules("decision/headquarters.ts", "function f(hq: Headquarters): void {}"), []);
	assert.deepEqual(rules("_petrabot.ts", "let HQ: Headquarters;"), [], "the bot owns the headquarters");
	const structure = analyse([analyseModule("decision/a.ts", "function f(hq: Headquarters): void {}")], []);
	assert.equal(structure.rules.length, 0, "a tracked count, not a broken rule");
	assert.equal(structure.wholeHq.length, 1);
});

test("decision code may not import an execution class it sees through a view", () =>
{
	assert.deepEqual(
		analyseModule(
			"decision/a.ts",
			"import { AttackPlan, type AttackPlanView } from \"../execution/attackPlan.ts\";",
		).findings.map((f) => [f.rule, f.text]),
		[[
			"view-only",
			"imports AttackPlan from execution/attackPlan.ts: use AttackPlanView (its states and types: " +
			"execution/attackConstants.ts)",
		]],
	);
	assert.deepEqual(
		rules("execution/b.ts", "import { AttackPlan } from \"./attackPlan.ts\";"),
		[],
		"execution runs the plans",
	);
});

test("cohesion against its baseline: worse above it, better below, a new class allowed a few groups", () =>
{
	const [cls] = analyseModule("world/a.ts", "class One { x = 0; a(): number { return this.x; } }").classes;
	const figures = cohesionFigures([cls], [{ file: "world/b.ts", name: "Plan", lcom4: 3 }]);
	assert.deepEqual(figures, { "world/a.ts:One": 1, "parts world/b.ts:Plan": 3 });

	const changes = cohesionChanges({
		"a:Kept": 2,
		"a:Worse": 5,
		"a:Better": 1,
		"a:NewSmall": NEW_CLASS_CORE_MAX,
		"a:NewBig": NEW_CLASS_CORE_MAX + 1,
	}, { "a:Kept": 2, "a:Worse": 3, "a:Better": 4, "a:Gone": 7 });
	assert.deepEqual(changes.worse, [{ key: "a:Worse", now: 5, was: 3 }, {
		key: "a:NewBig",
		now: NEW_CLASS_CORE_MAX + 1,
		was: undefined,
	}]);
	assert.deepEqual(changes.better, [{ key: "a:Better", now: 1, was: 4 }]);
});

/** The port of the layer-access tests: the headquarters reached through a global the declarations type, as the AI's */
const layered: Record<string, string> = {
	"/port/runtime.d.ts": "declare const ai: { HQ: import(\"./decision/headquarters.ts\").Headquarters; " +
		"Config: import(\"./world/config.ts\").Config; " +
		"attacks: import(\"./execution/services.ts\").AttackRegistry; };",
	"/port/world/config.ts": "export class Config { debug = 0; }",
	"/port/decision/attackManager.ts": "export class AttackManager { total = 0; getPlan(): number { return 1; } }",
	"/port/decision/headquarters.ts": "import { AttackManager } from \"./attackManager.ts\";\n" +
		"export class Headquarters { attackManager = new AttackManager(); needFarm = false; }",
	"/port/execution/services.ts": "export interface AttackRegistry { getPlan(): number; }",
};

test("a lower layer reaching a higher one's object with no import: once a chain, every way it is read", () =>
{
	const found = layerAccesses(
		programOf({
			...layered,
			// two reads of the HQ through the AI, one of them a chain to a manager's method
			"/port/world/bases.ts": "export const a = ai.HQ.needFarm;\nexport const b = ai.HQ.attackManager.getPlan();",
			// the same reached by a key and by destructuring
			"/port/adapter/read.ts": "export const c = ai[\"HQ\"];\nexport const { HQ } = ai;",
			// the configuration is world/: adapter/ may not read it, world/ may
			"/port/adapter/debug.ts": "export const d = ai.Config.debug;",
			"/port/world/own.ts": "export const e = ai.Config.debug;",
		}),
		"/port",
	);
	assert.deepEqual(found.map((v) => `${v.file}:${v.line} ${v.from}->${v.to} ${v.text}`), [
		"world/bases.ts:1 world->decision ai.HQ",
		"world/bases.ts:2 world->decision ai.HQ",
		"adapter/read.ts:1 adapter->decision ai[\"HQ\"]",
		"adapter/read.ts:2 adapter->decision HQ",
		"adapter/debug.ts:1 adapter->world ai.Config",
	]);
});

test("execution reaches decision only through the interfaces it declares itself", () =>
{
	const found = layerAccesses(
		programOf({
			...layered,
			"/port/execution/plan.ts": "export const plan = ai.attacks.getPlan();\n" +
				"export const raw = ai.HQ.attackManager.getPlan();\n" +
				"const manager = ai.HQ.attackManager;\nexport const total = manager.total;",
		}),
		"/port",
	);
	assert.deepEqual(
		found.map((v) => `${v.line} ${v.text}`),
		["2 ai.HQ", "3 ai.HQ", "4 manager.total"],
		"the service is execution's own; the HQ and its manager are decision's, however reached",
	);
});

test("a class with its parts: methods and the functions taking it, the saves and the constructor apart", () =>
{
	const found = partCohesion(
		programOf({
			"/port/execution/plan.ts": "export class Plan {\n" +
				"\ta = 0; b = 0; c = 0; d = 0; e = 0; f = 0;\n" +
				"\tconstructor() { this.a = 1; this.b = 1; this.c = 1; this.d = 1; this.e = 1; this.f = 1; }\n" +
				"\tgrowA(): void { this.a++; }\n" +
				"\tgrowB(): number { return this.b + this.f; }\n" +
				"\tsave(): number[] { return [this.a, this.b, this.c, this.d]; }\n}",
			// two parts linked by a call, a third linked to growB by the field f
			"/port/execution/march.ts": "import type { Plan } from \"./plan.ts\";\n" +
				"export function walk(plan: Plan): number { return plan.c + step(plan); }\n" +
				"function step(plan: Plan): number { return plan.d; }\n" +
				"export const halt = (plan: Plan): number => plan.f;",
			// a reader, not a part: its uses tell who owns e
			"/port/decision/manager.ts": "import type { Plan } from \"../execution/plan.ts\";\n" +
				"export class Manager { plan: Plan | undefined; total(): number { return this.plan?.e ?? 0; } }",
		}),
		"/port",
	);
	const plan = found.find((c) => c.name === "Plan");
	assert.ok(plan);
	assert.deepEqual(plan.parts, [{ file: "execution/march.ts", functions: ["walk", "step", "halt"] }]);
	assert.equal(plan.units, 6);
	assert.deepEqual(plan.whole, ["save"], "save uses four of the six fields");
	assert.deepEqual(plan.groups.map((g) => [...g].sort()), [["growB", "march.ts:halt"], [
		"march.ts:step",
		"march.ts:walk",
	], ["growA"]]);
	assert.equal(plan.lcom4, 3);
	assert.deepEqual(
		plan.ownedFields,
		[{ file: "execution/march.ts", fields: ["c", "d"] }, { file: "execution/plan.ts", fields: ["a", "b"] }, {
			file: "decision/manager.ts",
			fields: ["e"],
		}],
		"f is used by the class and the march; the constructor and save count for none",
	);
});

test("a type's width: the members each other module reads, its own module and this apart", () =>
{
	const members = "abcdefgh".split("").map((m) => `${m}: number;`).join(" ");
	const found = typeWidth(
		programOf({
			"/port/execution/services.ts": `export interface Wide { ${members} }\n` +
				"export class Small { x = 0; private y = 0; get z(): number { return this.y; } static s = 0; }\n" +
				"export function own(w: Wide): number { return w.a; }",
			"/port/decision/narrow.ts": "import type { Wide } from \"../execution/services.ts\";\n" +
				"export function f(w: Wide): number { const { b } = w; return w.a + b; }",
			"/port/decision/broad.ts": "import type { Wide, Small } from \"../execution/services.ts\";\n" +
				"export function g(w: Wide, s: Small): number { return w.a + w.c + w.d + s.z + s.x; }",
		}),
		"/port",
	);
	assert.deepEqual(
		found.map((t) => [t.name, t.members, t.usedOutside, t.narrow, t.consumers.map((c) => `${c.file} ${c.used}`)]),
		[["Wide", 8, 4, 1, ["decision/narrow.ts a,b", "decision/broad.ts a,c,d"]], ["Small", 2, 2, 0, [
			"decision/broad.ts x,z",
		]]],
		"two of eight is narrow, three is not; Small's private and static members are not its width",
	);
});

test("a member read through an interface the class is given as is a read of the class's member", () =>
{
	const program = programOf({
		"/port/execution/services.ts": "export interface Service { flag: boolean; count(): number; }",
		"/port/decision/hq.ts": "import type { Service } from \"../execution/services.ts\";\n" +
			"export class Hq { flag = false; other = 0; count(): number { return this.other; } }\n" +
			"export function grow(hq: Hq): void { hq.other++; }\n" +
			// the instance given as the service, as the bot's getters do
			"export function serve(hq: Hq): Service { return hq; }",
		"/port/execution/user.ts": "import type { Service } from \"./services.ts\";\n" +
			"export function use(s: Service): boolean { return s.flag && s.count() > 0; }",
	});
	const hq = partCohesion(program, "/port").find((c) => c.name === "Hq");
	assert.ok(hq);
	assert.deepEqual(hq.ownedFields, [{ file: "decision/hq.ts", fields: ["other"] }, {
		file: "execution/user.ts",
		fields: ["flag"],
	}], "flag is read by the service's user, not by nobody");
	const width = typeWidth(program, "/port").find((t) => t.name === "Hq");
	assert.ok(width);
	assert.deepEqual(width.through, [{ type: "Service", used: ["count", "flag"] }]);
	assert.equal(width.usedOutside, 2, "both are read outside its module, through the service");
	assert.deepEqual(width.consumers, [], "no module reads the class itself");
});
