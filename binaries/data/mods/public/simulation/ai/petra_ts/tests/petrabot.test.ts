/**
 * The bot itself (PetraBot): what it does when the game starts, how often it
 * plays, what it does with the events the engine sends between its turns,
 * and saving and loading a game.
 *
 * The bot runs over the HQ world (one civil centre of ours at [10,10] on a
 * plain map, an enemy player 2) with every manager real. The engine side is
 * the common-api SharedScript surface BaseAI.Init and OnUpdate read: the maps,
 * the per-player GameState and the turn's events, one bucket per name the
 * engine's AIInterface lists.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setPlayers } from "./harness/diplomacy.ts";
import { logs, resetRecorder } from "./harness/engine.ts";
import { emptyEvents, eventsWith, fake, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import { ENEMY, type HqWorld, type HqWorldOptions, makeHqWorld, PLAYER } from "./harness/hqWorld.ts";

import { PetraBot, SAVE_VERSION } from "../_petrabot.ts";
import { requireValue } from "../adapter/entityExtend.ts";

interface Game
{
	world: HqWorld;
	/** the shared script the engine hands every AI each turn */
	shared: CommonSharedScript;
	/** the game time, in milliseconds */
	time: { value: number };
	/** advance one simulation turn of 200 ms, with the given events */
	turn(bot: PetraBot, events?: Partial<EngineAIEvents>): void;
}

let modifiers: unknown[] = [];
let realRandom: () => number;

beforeEach(() =>
{
	resetRecorder();
	modifiers = [];
	realRandom = Math.random;
	Math.random = () => 0.5;
	stubGlobal("Sim", { "SYSTEM_ENTITY": 1, "IID_ModifiersManager": 61 });
	stubGlobal("SimEngine", { "QueryInterface": () => ({ "AddModifiers": (...args: unknown[]) => modifiers.push(args) }) });
});

afterEach(() =>
{
	Math.random = realRandom;
	restoreEngine();
});

/** A game of two players, at its first turn. */
function game(options: HqWorldOptions = {}): Game
{
	const world = makeHqWorld({ "stock": { "food": 300, "wood": 300, "stone": 300, "metal": 300 }, ...options });
	setPlayers(world, [{}, {}, {}]);
	const time = { "value": 0 };
	const gs = world.gameState as unknown as Record<string, unknown>;
	world.gameState.playerData.state = "active";
	gs.getTimeElapsed = () => time.value;
	// no technology to research on this plain map
	gs.findAvailableTech = () => [];
	// as GameState.countOwnEntitiesAndQueuedWithRole: our units of the role (nothing is in training here)
	gs.countOwnEntitiesAndQueuedWithRole = (role: string) =>
		[...world.ents.values()].filter((e) => e.owner() === PLAYER && e.getMetadata(PLAYER, "role") === role).length;
	const shared = fake<CommonSharedScript>({
		"territoryMap": world.ai.territoryMap,
		"accessibility": world.ai.accessibility,
		"gameState": { [PLAYER]: world.gameState },
		"timeElapsed": 0,
		"events": emptyEvents()
	});
	return {
		world, shared, time,
		turn(bot: PetraBot, events: Partial<EngineAIEvents> = {})
		{
			shared.events = eventsWith({ ...events });
			bot.OnUpdate(shared);
			time.value += 200;
		}
	};
}

/** A bot of the given behavior for our player, initialised on the game. */
function startBot(g: Game, behavior = "balanced"): PetraBot
{
	const bot = new PetraBot({ "player": PLAYER, "difficulty": 3, behavior });
	bot.Init(PLAYER, g.shared);
	return bot;
}

/** the event the engine sends when a player changes its diplomacy towards us */
const diplomacyChanged: Partial<EngineAIEvents> = { "DiplomacyChanged": [{ "player": ENEMY, "otherPlayer": PLAYER }] };

describe("the bot at game start", () =>
{
	it("draws its personality, sets up its queues and its headquarters, and is ready to play", () =>
	{
		const g = game();
		const bot = startBot(g, "aggressive");

		assert.equal(bot.canPlay, true);
		assert.ok(bot.Config.personality.aggressive > 0.7);
		assert.deepEqual(Object.keys(bot.queues).sort(), Object.keys(bot.Config.priorities).sort());
		// the town's civil centre is its first base
		assert.equal(requireValue(bot.HQ).baseManagers().length, 1);
		// the difficulty's AI bonus is applied once
		assert.equal(modifiers.length, 1);
	});

	it("on a map it cannot read, it never plays", () =>
	{
		// nothing of the map is passable, not even under the civil centre
		const g = game({ "accessibilityFallback": 0 });
		const bot = startBot(g);
		assert.equal(bot.canPlay, false);
		assert.ok(logs.some((line) => line.includes("does not know how to interpret this map")));

		for (let i = 0; i < 20; ++i)
			g.turn(bot, diplomacyChanged);
		// the headquarters never looked at the events
		assert.deepEqual(g.world.diplomacyResets, []);
	});
});

describe("the bot's turns", () =>
{
	it("it plays the first turn, then one turn in eight, offset by its player id", () =>
	{
		const g = game();
		const bot = startBot(g);
		const played: number[] = [];
		for (let t = 0; t < 21; ++t)
		{
			const before = bot.playedTurn;
			g.turn(bot);
			if (bot.playedTurn > before)
				played.push(t);
		}
		// player 1: (turn + 1) % 8 == 5
		assert.deepEqual(played, [0, 4, 12, 20]);
		assert.equal(bot.turn, 21);
		// the time is read every turn
		assert.equal(bot.elapsedTime, 4);
	});

	it("the events of the turns in between are kept and handled on its next turn, once", () =>
	{
		const g = game();
		const bot = startBot(g);
		g.turn(bot);								// turn 0: played
		g.turn(bot, diplomacyChanged);				// turn 1: kept
		g.turn(bot);								// turns 2 and 3
		g.turn(bot);
		assert.deepEqual(g.world.diplomacyResets, []);

		g.turn(bot);								// turn 4: played
		assert.equal(g.world.diplomacyResets.length, 1);

		for (let t = 5; t <= 12; ++t)
			g.turn(bot);
		// handled once: the turn-12 update saw no event
		assert.equal(g.world.diplomacyResets.length, 1);
	});

	it("a defeated bot does nothing at all", () =>
	{
		const g = game();
		const bot = startBot(g);
		g.turn(bot);
		g.world.gameState.playerData.state = "defeated";
		for (let t = 1; t < 10; ++t)
			g.turn(bot, diplomacyChanged);
		assert.equal(bot.turn, 1);
		assert.equal(bot.playedTurn, 1);
		assert.deepEqual(g.world.diplomacyResets, []);
	});
});

describe("saving and loading", () =>
{
	/** a bot that played a few turns and holds an event for its next turn (turn 12) */
	function playedBot(g: Game): PetraBot
	{
		const bot = startBot(g);
		for (let t = 0; t < 6; ++t)
			g.turn(bot);
		g.turn(bot, diplomacyChanged);		// turn 6: kept for turn 12
		return bot;
	}

	it("a loaded bot hands back the saved game unchanged until it has run", () =>
	{
		const g = game();
		const saved = playedBot(g).Serialize();
		const loaded = new PetraBot({ "player": PLAYER, "difficulty": 3, "behavior": "balanced" });
		loaded.Deserialize(saved, g.shared);
		assert.equal(loaded.Serialize(), saved);
	});

	it("a loaded bot resumes where it was: same turn count, same personality, the pending event handled on schedule", () =>
	{
		const g = game();
		const bot = playedBot(g);
		const saved = bot.Serialize();
		const personality = { ...bot.Config.personality };

		const loaded = new PetraBot({ "player": PLAYER, "difficulty": 3, "behavior": "balanced" });
		loaded.Deserialize(saved, g.shared);
		// a different draw would show if the personality were drawn again
		Math.random = () => 0.9;
		g.turn(loaded);						// turn 7: the load, then a turn off

		assert.equal(loaded.turn, 8);
		assert.equal(loaded.playedTurn, bot.playedTurn);
		assert.deepEqual(loaded.Config.personality, personality);
		assert.deepEqual(loaded.uniqueIDs, bot.uniqueIDs);
		assert.deepEqual(Object.keys(loaded.queues).sort(), Object.keys(bot.queues).sort());
		assert.deepEqual(g.world.diplomacyResets, []);

		for (let t = 8; t <= 12; ++t)
			g.turn(loaded);
		assert.equal(g.world.diplomacyResets.length, 1);
	});

	it("a save of another version is refused aloud, and the bot starts afresh from the game as it stands", () =>
	{
		const g = game();
		const saved = playedBot(g).Serialize();
		assert.equal(saved.saveVersion, SAVE_VERSION, "a save says its version");
		g.shared["_entityMetadata"] = { [PLAYER]: { 1000: { "base": 7 } } };

		logs.length = 0;
		const loaded = new PetraBot({ "player": PLAYER, "difficulty": 3, "behavior": "balanced" });
		loaded.Deserialize({ ...saved, "saveVersion": 0 }, g.shared);
		assert.ok(logs.some((entry) => entry.includes("version 0") && entry.includes("starts afresh")), "the refusal is said");
		assert.deepEqual(g.shared["_entityMetadata"][PLAYER], {}, "the old notes on our units are dropped");

		loaded.Init(PLAYER, g.shared);
		assert.equal(loaded.isDeserialized, false, "it plays as in a new game");
		assert.equal(requireValue(loaded.HQ).baseManagers().length, 1, "with the town's centre as its first base");
	});

	it("saving the loaded bot again, before anything happened, gives the same game", () =>
	{
		const g = game();
		const saved = playedBot(g).Serialize();
		const loaded = new PetraBot({ "player": PLAYER, "difficulty": 3, "behavior": "balanced" });
		loaded.Deserialize(saved, g.shared);
		g.turn(loaded);						// turn 7: off turn, nothing played

		const again = loaded.Serialize();
		assert.equal(again.turn, saved.turn + 1);
		assert.deepEqual({ ...again, "turn": saved.turn, "elapsedTime": saved.elapsedTime }, saved);
	});
});
