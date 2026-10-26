/**
 * The bot's configuration at game start (Config.setConfig): the personality
 * drawn for the chosen behavior, and the economy and military settings the
 * difficulty, the population cap and the game settings lead to; then the
 * difficulty's gather/build bonus (Config.Cheat).
 *
 * Math.random is pinned to 0.5, so the personality draw is the middle of
 * each behavior's range.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { logs, resetRecorder } from "./harness/engine.ts";
import { fake, restoreEngine, stubGlobal } from "./harness/fakes.ts";

import { Config } from "../decision/config.ts";

const PLAYER_ENTITY = 7;

/** the game settings setConfig reads */
function game(options: { maxPop?: number; teamLocked?: boolean; alliedVictory?: boolean; victory?: string[] } = {}): CommonGameState
{
	return fake<CommonGameState>({
		"playerData": { "teamLocked": options.teamLocked ?? false, "entity": PLAYER_ENTITY },
		"getAlliedVictory": () => options.alliedVictory ?? false,
		"getPopulationMax": () => options.maxPop ?? 300,
		"getVictoryConditions": () => new Set(options.victory ?? ["conquest"])
	});
}

/** the modifiers the bonus asked the simulation for, as [name, modifiers, player entity] */
let modifiers: Array<[string, Record<string, Array<{ affects: string[]; multiply: number }>>, number]> = [];
let realRandom: () => number;

beforeEach(() =>
{
	resetRecorder();
	modifiers = [];
	realRandom = Math.random;
	Math.random = () => 0.5;
	stubGlobal("Sim", { "SYSTEM_ENTITY": 1, "IID_ModifiersManager": 61 });
	stubGlobal("SimEngine", {
		"QueryInterface": (entity: number, iid: number) =>
		{
			assert.deepEqual([entity, iid], [1, 61]);
			return { "AddModifiers": (name: string, mods: never, target: number) => modifiers.push([name, mods, target]) };
		}
	});
});

afterEach(() =>
{
	Math.random = realRandom;
	restoreEngine();
});

/** the multipliers the AI bonus applies, by modified value */
function bonus(): Record<string, number>
{
	assert.equal(modifiers.length, 1);
	const [name, mods, target] = modifiers[0];
	assert.equal(name, "AI Bonus");
	assert.equal(target, PLAYER_ENTITY);
	const ret: Record<string, number> = {};
	for (const key in mods)
	{
		assert.deepEqual(mods[key][0].affects, ["Unit", "Structure"]);
		ret[key] = mods[key][0].multiply;
	}
	return ret;
}

function close(actual: number, expected: number): void
{
	assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

describe("config: personality", () =>
{
	it("an aggressive bot is drawn near the aggressive end, a defensive one near the other", () =>
	{
		const aggressive = new Config(3, "aggressive");
		aggressive.setConfig(game());
		close(aggressive.personality.aggressive, 0.73 + 0.5 * 0.27);
		close(aggressive.personality.defensive, 0.5 * 0.27);
		close(aggressive.personality.cooperative, 0.5);

		const defensive = new Config(3, "defensive");
		defensive.setConfig(game());
		close(defensive.personality.aggressive, 0.5 * 0.27);
		close(defensive.personality.defensive, 1 - 0.27 + 0.5 * 0.27);
	});

	it("a bot without a chosen behavior draws over the whole range", () =>
	{
		const random = new Config(3);
		assert.equal(random.behavior, "random");
		random.setConfig(game());
		close(random.personality.aggressive, 0.5);
		close(random.personality.defensive, 0.5);
	});

	it("locked teams make the bot much more cooperative; a shared victory a little", () =>
	{
		const locked = new Config(3, "balanced");
		locked.setConfig(game({ "teamLocked": true, "alliedVictory": true }));
		close(locked.personality.cooperative, 0.8);

		const allied = new Config(3, "balanced");
		allied.setConfig(game({ "alliedVictory": true }));
		close(allied.personality.cooperative, 0.65);

		// never over 1
		Math.random = () => 0.9;
		const veryCooperative = new Config(3, "balanced");
		veryCooperative.setConfig(game({ "teamLocked": true }));
		close(veryCooperative.personality.cooperative, 1);
	});

	it("a sandbox bot keeps the default personality", () =>
	{
		const sandbox = new Config(0, "aggressive");
		sandbox.setConfig(game());
		assert.deepEqual(sandbox.personality, { "aggressive": 0.5, "cooperative": 0.5, "defensive": 0.5 });
	});
});

describe("config: settings by difficulty", () =>
{
	it("medium, aggressive, full population: an early barracks, an early town phase", () =>
	{
		const config = new Config(3, "aggressive");
		config.setConfig(game());

		// defensive 0.135: towers and forts come a little later, defenses a little lower in priority
		assert.equal(config.Military.towerLapseTime, Math.round(360 * (1.1 - 0.2 * 0.135)));
		assert.equal(config.Military.fortressLapseTime, Math.round(390 * (1.1 - 0.2 * 0.135)));
		assert.equal(config.priorities.defenseBuilding, Math.round(70 * (0.9 + 0.2 * 0.135)));
		// one tower at medium, one fewer for a bot this little defensive
		assert.equal(config.Military.numSentryTowers, 0);
		assert.equal(config.Military.popForBarracks1, 12);
		assert.equal(config.Economy.popPhase2, 50);
		assert.equal(config.priorities.healer, 10);
		assert.equal(config.Military.popForBarracks2, 55);
		assert.equal(config.Military.popForForge, 65);
		// a third of the population cap works
		assert.equal(config.Economy.targetNumWorkers, 100);
		assert.equal(config.Economy.workPhase3, 100);
		assert.equal(config.Economy.workPhase4, 100);
		assert.equal(config.Economy.targetNumTraders, 5);
		assert.equal(config.popScaling, 1);
		assert.deepEqual(config.emergencyValues, { "population": 0.6, "structures": 0.6, "roots": 0.5 });
		assert.deepEqual(config.personalityCut, { "weak": 0.3, "medium": 0.5, "strong": 0.7 });
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 1, "Trader/GainMultiplier": 1, "Cost/BuildTime": 1 });
	});

	it("hard, balanced, wonder victory: two towers, and the later phases come with fewer workers", () =>
	{
		const config = new Config(4, "balanced");
		config.setConfig(game({ "victory": ["conquest", "wonder"] }));

		assert.equal(config.Military.numSentryTowers, 2);
		assert.equal(config.Military.popForBarracks1, 25);
		assert.equal(config.Economy.popPhase2, 150);
		// the town phase is wanted at 150 people, which is also the worker target
		assert.equal(config.Economy.targetNumWorkers, 150);
		// 0.9 * 180 = 162 and 0.9 * 200 = 180, both capped by the worker target
		assert.equal(config.Economy.workPhase3, 150);
		assert.equal(config.Economy.workPhase4, 150);
		assert.equal(config.Economy.targetNumTraders, 6);
		assert.deepEqual(config.emergencyValues, { "population": 0.5, "structures": 0.5, "roots": 0.35 });
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 1.25, "Trader/GainMultiplier": 1.25, "Cost/BuildTime": 1 });
	});

	it("a big cap: workers are capped at 120, but never fewer than the town phase wants", () =>
	{
		const config = new Config(4, "balanced");
		config.setConfig(game({ "maxPop": 600 }));
		// min(120, 600 / 3) = 120, raised to popPhase2 = 150; the later phases follow
		assert.equal(config.Economy.popPhase2, 150);
		assert.equal(config.Economy.targetNumWorkers, 150);
		assert.equal(config.Economy.workPhase3, 150);
		assert.equal(config.Economy.workPhase4, 150);
	});

	it("very hard and defensive: three towers", () =>
	{
		const config = new Config(5, "defensive");
		config.setConfig(game());
		assert.equal(config.Military.numSentryTowers, 3);
		assert.deepEqual(config.emergencyValues, { "population": 0.35, "structures": 0.35, "roots": 0.2 });
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 1.56, "Trader/GainMultiplier": 1.56, "Cost/BuildTime": 1 });
	});

	it("easy, small population cap: everything scaled down to the cap", () =>
	{
		const config = new Config(2, "defensive");
		config.setConfig(game({ "maxPop": 150 }));

		const scaling = 0.7 * Math.sqrt(0.5);
		close(config.popScaling, scaling);
		assert.equal(config.Economy.supportRatio, 0.4);
		assert.equal(config.Economy.provisionFields, 1);
		// a defensive bot still builds its tower at easy
		assert.equal(config.Military.numSentryTowers, 1);
		assert.equal(config.Military.popForBarracks1, 12);			// floor(25 * 0.49) = 12
		assert.equal(config.Military.popForBarracks2, 45);			// raised to the floor of 45
		assert.equal(config.Military.popForForge, 32);				// floor(65 * 0.495)
		assert.equal(config.Economy.popPhase2, 74);					// floor(150 * 0.49)
		// min(60, half the cap) = 60 workers, raised to the town phase's 74
		assert.equal(config.Economy.targetNumWorkers, 74);
		assert.equal(config.Economy.workPhase3, 74);				// floor(180 * 0.495) = 89, capped by the workers
		assert.equal(config.Economy.workPhase4, 74);
		assert.equal(config.Economy.targetNumTraders, Math.round(4 * scaling));
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 0.75, "Trader/GainMultiplier": 0.75, "Cost/BuildTime": 1.1 });
	});

	it("very easy: never leaves the town phase, and an undefended bot builds no tower", () =>
	{
		const config = new Config(1, "aggressive");
		config.setConfig(game({ "maxPop": 300 }));

		assert.equal(config.popScaling, 0.5);
		assert.equal(config.Economy.supportRatio, 0.5);
		assert.equal(config.Military.numSentryTowers, 0);
		// an aggressive bot's early barracks is a medium-and-up trait
		assert.equal(config.Military.popForBarracks1, 12);
		assert.equal(config.Economy.popPhase2, 75);
		assert.equal(config.Economy.targetNumWorkers, 75);
		assert.equal(config.Economy.workPhase3, Infinity);
		assert.equal(config.Economy.targetNumTraders, 2);			// round(3 * 0.5)
		assert.deepEqual(config.emergencyValues, { "population": 0.8, "structures": 0.8, "roots": 0.8 });
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 0.56, "Trader/GainMultiplier": 0.56, "Cost/BuildTime": 1.25 });
	});

	it("very easy and defensive keeps one tower", () =>
	{
		const config = new Config(1, "defensive");
		config.setConfig(game());
		assert.equal(config.Military.numSentryTowers, 1);
	});

	it("sandbox: the slowest bonus, and a single worker on a one-person cap", () =>
	{
		const config = new Config(0);
		config.setConfig(game({ "maxPop": 1 }));
		// every threshold capped by the cap itself (popPhase2 = floor(1 / 2) = 0); one worker still
		assert.equal(config.Economy.popPhase2, 0);
		assert.equal(config.Economy.targetNumWorkers, 1);
		assert.equal(config.Economy.workPhase3, Infinity);
		assert.deepEqual(bonus(), { "ResourceGatherer/BaseSpeed": 0.42, "Trader/GainMultiplier": 0.42, "Cost/BuildTime": 1.4 });
	});

	it("at debug level 2 the drawn personality is written to the log", () =>
	{
		const config = new Config(3, "balanced");
		config.debug = 2;
		config.setConfig(game());
		assert.ok(logs.some((line) => line.includes("Petra bot: personality")));

		resetRecorder();
		const quiet = new Config(3, "balanced");
		quiet.setConfig(game());
		assert.ok(!logs.some((line) => line.includes("Petra bot: personality")));
	});
});
