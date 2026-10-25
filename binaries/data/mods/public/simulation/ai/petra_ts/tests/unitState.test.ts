/**
 * unitState: what a unit is doing, parsed from the state name the engine
 * reports (adapter/unitState.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { logs } from "./harness/engine.ts";
import { modsPublic } from "./harness/paths.ts";
import { loadPetraModule } from "./harness/target.ts";

type UnitState =
	| { kind: "none" }
	| { kind: "known"; name: string; role: string; activity: string | undefined }
	| { kind: "other"; raw: string };
type Unit = { unitAIState(): string | undefined };

const states = await loadPetraModule<{
	UNIT_AI_STATES: readonly string[];
	parseUnitState(raw: string | undefined): UnitState;
	activityOf(state: UnitState): string | undefined;
	hasActivity(ent: Unit, activity: string): boolean;
	isInState(ent: Unit, name: string): boolean;
	requiredActivityIs(ent: Unit, activity: string): boolean;
	requiredStateWithin(ent: Unit, name: string): boolean;
}>("unitState");

const unit = (state: string | undefined): Unit => ({ "unitAIState": () => state });

/** Every state of UnitAI's state machine, read from the game's own UnitAI.js and FSM.js. */
function gameUnitAIStates(): string[]
{
	// JavaScript's own globals pass through; the game's (Engine, IID_*, ...) are stubs
	const builtins = new Set<string | symbol>(Object.getOwnPropertyNames(vm.runInNewContext("globalThis")));
	const stub: unknown = new Proxy(function () {}, { "get": () => stub, "apply": () => stub, "construct": () => stub as object });
	const sandbox = new Proxy<Record<string | symbol, unknown>>({}, {
		"has": () => true,
		"get": (target, key) => key in target ? target[key] :
			builtins.has(key) ? (globalThis as Record<string | symbol, unknown>)[key] : stub,
		"set": (target, key, value) => { target[key] = value; return true; }
	});
	const context = vm.createContext(sandbox);
	vm.runInContext(readFileSync(path.join(modsPublic, "globalscripts/FSM.js"), "utf8"), context);
	vm.runInContext("function UnitAI() {}\n" +
		readFileSync(path.join(modsPublic, "simulation/components/UnitAI.js"), "utf8").replace(/^function UnitAI\(\) \{\}$/m, ""), context);
	const FSM = vm.runInContext("FSM", context) as new (spec: unknown) => { states: Record<string, unknown> };
	return Object.keys(new FSM(vm.runInContext("UnitAI.prototype.UnitFsmSpec", context)).states).filter(Boolean).sort();
}

describe("what a unit is doing: parsing its state", () =>
{
	it("knows every state UnitAI's state machine has, and no other", () =>
	{
		assert.deepEqual([...states.UNIT_AI_STATES].sort(), gameUnitAIStates(),
			"UNIT_AI_STATES no longer matches simulation/components/UnitAI.js: refresh it");
	});

	it("reads a state into who the unit acts as and what it does", () =>
	{
		assert.deepEqual(states.parseUnitState("INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING"),
			{ "kind": "known", "name": "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", "role": "INDIVIDUAL", "activity": "GATHER" });
		assert.deepEqual(states.parseUnitState("FORMATIONMEMBER.WALKING"),
			{ "kind": "known", "name": "FORMATIONMEMBER.WALKING", "role": "FORMATIONMEMBER", "activity": "WALKING" });
	});

	it("gives a role alone no activity, as the name's second part is none", () =>
	{
		assert.equal(states.activityOf(states.parseUnitState("INDIVIDUAL")), undefined);
	});

	it("takes no state as a case of its own, not an error", () =>
	{
		assert.deepEqual(states.parseUnitState(undefined), { "kind": "none" });
		assert.equal(states.hasActivity(unit(undefined), "COMBAT"), false);
		assert.equal(states.isInState(unit(undefined), "INDIVIDUAL.IDLE"), false);
	});

	it("keeps a state its list does not have, with its own activity", () =>
	{
		const modded = states.parseUnitState("INDIVIDUAL.DANCE.SPINNING");
		assert.deepEqual(modded, { "kind": "other", "raw": "INDIVIDUAL.DANCE.SPINNING" });
		assert.equal(states.activityOf(modded), "DANCE");
	});

	it("tells an activity and an exact state apart", () =>
	{
		const chasing = unit("INDIVIDUAL.COMBAT.CHASING.MOVINGTOPOINT");
		assert.equal(states.hasActivity(chasing, "COMBAT"), true);
		assert.equal(states.hasActivity(chasing, "GATHER"), false);
		assert.equal(states.isInState(chasing, "INDIVIDUAL.COMBAT.CHASING"), false, "not the parent state");
		assert.equal(states.isInState(chasing, "INDIVIDUAL.COMBAT.CHASING.MOVINGTOPOINT"), true);
		assert.equal(states.requiredStateWithin(chasing, "INDIVIDUAL.COMBAT"), true, "but within it");
	});

	it("throws, after a warning, where the code relies on a unit having a state", () =>
	{
		logs.length = 0;
		assert.throws(() => states.requiredActivityIs(unit(undefined), "FLEEING"));
		assert.throws(() => states.requiredStateWithin(unit(undefined), "INDIVIDUAL.COLLECTTREASURE"));
		assert.ok(logs.some((entry) => entry.includes("required value")), "it said what was missing");
		assert.equal(states.requiredActivityIs(unit("INDIVIDUAL.FLEEING"), "FLEEING"), true);
	});
});
