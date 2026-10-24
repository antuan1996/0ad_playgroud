/**
 * DiplomacyManager: how the AI deals with the other players — tributes to
 * and from allies, answering alliance and neutrality requests (and asking a
 * tribute for them), sending its own requests, and turning against the
 * strongest remaining player in a "last man standing" game. The suites seat a
 * real office on the plain (tests/harness/hqWorld.ts) with the players set by
 * tests/harness/diplomacy.ts, and read what the AI told the game and the
 * other players from the recorded engine commands.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import { doorCalls, doorStub, makeHqEntity, makeHqWorld, seatHQ, PLAYER, type HqWorld, type HqWorldOptions } from "./harness/hqWorld.ts";
import { restoreEngine, stubGlobal } from "./harness/attackWorld.ts";
import { commands, resetRecorder } from "./harness/engine.ts";
import { setPlayers, type PlayerSpec } from "./harness/diplomacy.ts";

interface Request { requestType: string; status: string; wanted?: number; type?: string; warnTime?: number; sentWarning?: boolean }

interface Manager
{
	nextTributeUpdate: number;
	nextTributeRequest: Map<string, number>;
	betrayLapseTime: number;
	waitingToBetray: boolean;
	receivedDiplomacyRequests: Map<number, Request>;
	sentDiplomacyRequests: Map<number, { requestType: string; timeSent: number }>;
	sentDiplomacyRequestLapseTime: number;
	init(gs: unknown): void;
	tributes(gs: unknown): void;
	checkEvents(gs: unknown, events: unknown): void;
	lastManStandingCheck(gs: unknown): void;
	handleDiplomacyRequest(gs: unknown, player: number, type: string): void;
	checkRequestedTributes(gs: unknown): void;
	sendDiplomacyRequest(gs: unknown): void;
	checkSentDiplomacyRequests(gs: unknown): void;
	update(gs: unknown, events: unknown): void;
}

const { DiplomacyManager } = await loadPetraModule<{
	DiplomacyManager: new (config: unknown, deserialized: boolean) => Manager;
}>("diplomacyManager");

afterEach(() => restoreEngine());

const doorManagers = [
	"navalManager", "tradeManager", "researchManager", "diplomacyManager", "victoryManager", "defenseManager"
];

/** the first message of each answer, as chatHelper.ts words them (pickRandom takes the first here) */
const ANSWERS: Record<string, Record<string, string>> = {
	"ally": {
		"decline": "I cannot accept your offer to become allies, %(_player_)s.",
		"declineSuggestNeutral": "I will not be your ally, %(_player_)s. However, I will consider a neutrality pact.",
		"declineRepeatedOffer": "Our previous alliance did not work out, %(_player_)s. I must decline your offer.",
		"accept": "I will accept your offer to become allies, %(_player_)s. We will both benefit from this partnership.",
		"acceptWithTribute": "I will ally with you, %(_player_)s, but only if you send me a tribute of %(_amount_)s %(_resource_)s.",
		"waitingForTribute": "%(_player_)s, my offer still stands. I will ally with you only if you send me a tribute of %(_amount_)s %(_resource_)s."
	},
	"neutral": {
		"decline": "I will not become neutral with you, %(_player_)s.",
		"declineRepeatedOffer": "Our previous neutrality agreement ended in failure, %(_player_)s; I will not consider another one.",
		"accept": "I welcome your request for peace between our civilizations, %(_player_)s. I will accept.",
		"acceptWithTribute": "If you send me a tribute of %(_amount_)s %(_resource_)s, I will accept your neutrality request, %(_player_)s.",
		"waitingForTribute": "%(_player_)s, I will not accept your neutrality request unless you tribute me %(_amount_)s %(_resource_)s soon."
	}
};

type Command = Record<string, unknown> & { type: string };

/**
 * A game of the given players, seen by player 1. Random choices are fixed:
 * pickRandom takes the first, randFloat the lowest, randBool answers `chance`.
 */
function seat(players: PlayerSpec[], options: Partial<HqWorldOptions> = {}, chance = false)
{
	stubGlobal("pickRandom", (list: unknown[]) => list?.[0]);
	stubGlobal("randFloat", (low: number) => low);
	stubGlobal("randBool", () => chance);
	const world = makeHqWorld(options as HqWorldOptions);
	const hq = seatHQ(world, { "stubs": doorManagers });
	const attack = doorStub("attackManager", { "defeated": {}, "currentEnemyPlayer": undefined });
	hq.attackManager = attack;
	// what the town needs most, as the office ranks it
	hq.pickMostNeededResources = () => [{ "type": "wood", "wanted": 50, "current": 10 }, { "type": "food", "wanted": 30, "current": 20 }];
	setPlayers(world, players);
	resetRecorder();
	const manager = new DiplomacyManager(hq.Config, false);
	return { world, hq, manager, "attackCalls": doorCalls(attack) };
}

const sent = (): Command[] => commands as Command[];
const of = (type: string): Command[] => sent().filter((c) => c.type === type);

/** the answers we sent a player, as their message text */
const answersTo = (player: number): string[] => of("aichat")
	.map((c) => c.message as string)
	.filter((m) => m.startsWith("/msg Player " + player + " "))
	.map((m) => m.slice(("/msg Player " + player + " ").length));

const ai = (world: HqWorld) => world.gameState.ai as unknown as { elapsedTime: number };

/** units of a player, to weigh how strong it is */
function army(world: HqWorld, owner: number, count: number, first = 100 * owner): void
{
	for (let i = 0; i < count; ++i)
		world.addEntity(makeHqEntity({ "id": first + i, owner, "position": [40, 40], "classes": ["Unit", "Infantry"] }));
}

/** the events of a turn, every list empty unless given */
const events = (extra: Record<string, unknown[]> = {}) => ({
	"TributeExchanged": [], "Attacked": [], "DiplomacyChanged": [], "PlayerDefeated": [], "CeasefireEnded": [],
	"DiplomacyRequest": [], "TributeRequest": [], ...extra
});

// the usual table: gaia, us, and three others
const GAIA: PlayerSpec = {};
const US = (towards: Record<number, "ally" | "neutral" | "enemy"> = {}): PlayerSpec => ({ towards });

describe("diplomacy at the start: init", () =>
{
	it("an ally both ways is an accepted alliance; one-sided offers are answered as requests", () =>
	{
		const { world, manager } = seat([GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" } },
			{ "towards": { 1: "ally" } }, { "towards": { 1: "neutral" } }, {}]);

		manager.init(world.gameState);

		assert.deepEqual(manager.receivedDiplomacyRequests.get(2), { "requestType": "ally", "status": "accepted" });
		assert.equal(manager.receivedDiplomacyRequests.get(3)?.status, "waitingForTribute", "3 is allied to us, not we to 3");
		assert.equal(manager.receivedDiplomacyRequests.get(3)?.requestType, "ally");
		assert.equal(manager.receivedDiplomacyRequests.get(4)?.requestType, "neutral", "4 is neutral to us while we are its enemy");
		assert.equal(manager.receivedDiplomacyRequests.has(5), false);
		assert.deepEqual(answersTo(3), [ANSWERS.ally.acceptWithTribute]);
		assert.deepEqual(answersTo(4), [ANSWERS.neutral.acceptWithTribute]);
	});
});

describe("answering a diplomacy request: handleDiplomacyRequest", () =>
{
	// gaia, us, and three enemies: enemies (gaia counted) outnumber our allies
	const table = (): PlayerSpec[] => [GAIA, US(), {}, {}, {}];

	it("a team-locked game answers nothing", () =>
	{
		const players = table();
		players[1] = { "teamLocked": true };
		const { world, manager } = seat(players);
		manager.handleDiplomacyRequest(world.gameState, 2, "ally");
		assert.equal(manager.receivedDiplomacyRequests.size, 0);
		assert.deepEqual(sent(), []);
	});

	it("a first request from another civ is often declined for good", () =>
	{
		const players = table();
		players[2] = { "civ": "pers" };
		const { world, manager } = seat(players, {}, true);

		manager.handleDiplomacyRequest(world.gameState, 2, "ally");

		assert.deepEqual(manager.receivedDiplomacyRequests.get(2), { "requestType": "ally", "status": "declinedRequest" });
		assert.deepEqual(answersTo(2), [ANSWERS.ally.decline]);
	});

	it("a request is declined when allies already match the enemies, or from the player we are attacking", () =>
	{
		const balanced = seat([GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" } }, {}]);
		balanced.manager.handleDiplomacyRequest(balanced.world.gameState, 3, "neutral");
		assert.equal(balanced.manager.receivedDiplomacyRequests.get(3)?.status, "declinedRequest");

		const target = seat(table());
		target.hq.attackManager.currentEnemyPlayer = 2;
		target.manager.handleDiplomacyRequest(target.world.gameState, 2, "neutral");
		assert.deepEqual(answersTo(2), [ANSWERS.neutral.decline]);
	});

	it("a repeated neutrality request is answered from the earlier one", () =>
	{
		for (const [status, answer] of [["declinedRequest", "decline"], ["allianceBroken", "declineRepeatedOffer"],
			["waitingForTribute", "waitingForTribute"]])
		{
			const { world, manager } = seat(table());
			manager.receivedDiplomacyRequests.set(2, { "requestType": "neutral", status, "wanted": 1000, "type": "wood" });
			manager.handleDiplomacyRequest(world.gameState, 2, "neutral");
			assert.deepEqual(answersTo(2), [ANSWERS.neutral[answer]], status);
		}
	});

	it("an alliance with a weaker player is accepted at once, and attacks against it are called off", () =>
	{
		const { world, manager, attackCalls } = seat(table(), {}, true);
		army(world, 1, 5);
		army(world, 2, 2);

		manager.handleDiplomacyRequest(world.gameState, 2, "ally");

		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "ally" }]);
		assert.ok(attackCalls.some(([m]) => m === "cancelAttacksAgainstPlayer"));
		assert.deepEqual(manager.receivedDiplomacyRequests.get(2), { "requestType": "ally", "status": "accepted" });
		assert.equal(answersTo(2).at(-1), ANSWERS.ally.accept);
	});

	it("a neutrality request is accepted at once when chance allows", () =>
	{
		const { world, manager } = seat(table(), {}, true);
		manager.handleDiplomacyRequest(world.gameState, 2, "neutral");
		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "neutral" }]);
	});

	it("otherwise a tribute of the most needed resource is asked, more for an alliance", () =>
	{
		const { world, manager } = seat(table());
		army(world, 1, 150);

		manager.handleDiplomacyRequest(world.gameState, 2, "ally");
		manager.handleDiplomacyRequest(world.gameState, 3, "neutral");

		const ally = manager.receivedDiplomacyRequests.get(2);
		assert.equal(ally?.status, "waitingForTribute");
		assert.equal(ally?.type, "wood");
		assert.equal(ally?.wanted, 1500, "10 per unit of ours, at least 1000");
		assert.equal(manager.receivedDiplomacyRequests.get(3)?.wanted, 1000, "5 per unit, at least 1000");
		assert.equal(ally?.warnTime, ai(world).elapsedTime + 60);
	});

	it("with no resource that can be tributed, the request is declined", () =>
	{
		const { world, manager } = seat(table());
		stubGlobal("Resources", Object.assign(Object.create(Resources), { "GetTributableCodes": () => [] }));

		manager.handleDiplomacyRequest(world.gameState, 2, "ally");

		assert.equal(manager.receivedDiplomacyRequests.get(2)?.status, "declinedRequest");
	});
});

describe("tributes to and from our allies: tributes", () =>
{
	const allied = (ally: PlayerSpec = {}): PlayerSpec[] => [GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" }, ...ally }, {}];

	it("a stronger town sends a poor ally part of what it has to spare", () =>
	{
		const { world, manager } = seat(allied({ "resourceCounts": { "wood": 100 } }), { "stock": { "wood": 1000 } });
		army(world, 1, 3);

		manager.tributes(world.gameState);

		assert.deepEqual(of("tribute"), [{ "type": "tribute", "player": 2, "amounts": { "wood": 200 } }]);
		assert.equal(of("aichat").length, 1, "and says so to the ally");
		assert.equal(manager.nextTributeUpdate, ai(world).elapsedTime + 30);
	});

	it("a small ally gets a hundred of what we hold plenty of", () =>
	{
		const { world, hq, manager } = seat(allied({ "resourceCounts": { "stone": 50 }, "popCount": 5 }),
			{ "stock": { "stone": 600 }, "population": 40 });
		army(world, 1, 3);
		// most of it is promised to the queues already
		(world.ai.queueManager as unknown as { getAvailableResources: () => Record<string, number> }).getAvailableResources =
			() => ({ "food": 0, "wood": 0, "stone": 150, "metal": 0 });
		void hq;

		manager.tributes(world.gameState);

		assert.deepEqual(of("tribute"), [{ "type": "tribute", "player": 2, "amounts": { "stone": 100 } }]);
	});

	it("a town with none of a resource asks a rich ally for it, then waits before asking again", () =>
	{
		const { world, manager } = seat(allied({ "resourceCounts": { "wood": 2000 } }));
		ai(world).elapsedTime = 300;

		manager.tributes(world.gameState);
		assert.equal(of("aichat").length, 1, "the request for wood");
		assert.ok((of("aichat")[0].message as string).startsWith("/allies "));
		assert.equal(manager.nextTributeRequest.get("wood"), 540);

		manager.tributes(world.gameState);
		assert.equal(of("aichat").length, 1, "not again so soon");
	});

	it("sends nothing to an ally stronger than us", () =>
	{
		const { world, manager } = seat(allied({ "resourceCounts": { "wood": 100 } }), { "stock": { "wood": 1000 } });
		army(world, 1, 3);
		army(world, 2, 50);
		manager.tributes(world.gameState);
		assert.deepEqual(of("tribute"), []);
	});

	it("sends nothing to a defeated ally", () =>
	{
		const beaten = seat(allied({ "resourceCounts": { "wood": 100 } }), { "stock": { "wood": 1000 } });
		army(beaten.world, 1, 3);
		beaten.hq.attackManager.defeated[2] = true;
		beaten.manager.tributes(beaten.world.gameState);
		assert.deepEqual(of("tribute"), []);
	});

	it("with no resource that can be tributed, nothing is sent", () =>
	{
		const { world, manager } = seat(allied({ "resourceCounts": { "wood": 100 } }), { "stock": { "wood": 1000 } });
		army(world, 1, 3);
		stubGlobal("Resources", Object.assign(Object.create(Resources), { "GetTributableCodes": () => [] }));
		manager.tributes(world.gameState);
		assert.deepEqual(of("tribute"), []);
	});
});

describe("the turn's diplomatic events: checkEvents", () =>
{
	const table = (): PlayerSpec[] => [GAIA, US(), {}, {}, {}];

	it("the tribute asked for an alliance seals it once paid in full; part of it gives more time", () =>
	{
		const { world, manager } = seat(table());
		manager.receivedDiplomacyRequests.set(2, { "requestType": "ally", "status": "waitingForTribute", "wanted": 1000,
			"type": "wood", "warnTime": 10, "sentWarning": true });
		ai(world).elapsedTime = 200;

		manager.checkEvents(world.gameState, events({ "TributeExchanged": [{ "to": PLAYER, "from": 2, "amounts": { "wood": 400 } }] }));
		const request = manager.receivedDiplomacyRequests.get(2);
		assert.equal(request?.wanted, 600);
		assert.equal(request?.warnTime, 260);
		assert.equal(request?.sentWarning, false);

		manager.checkEvents(world.gameState, events({ "TributeExchanged": [{ "to": PLAYER, "from": 2, "amounts": { "food": 900 } }] }));
		assert.equal(request?.wanted, 600, "food is not what was asked");

		manager.checkEvents(world.gameState, events({ "TributeExchanged": [{ "to": PLAYER, "from": 2, "amounts": { "wood": 600 } }] }));
		assert.equal(request?.status, "accepted");
		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "ally" }]);
	});

	it("tributes from allies and allies fighting in our ground make us more cooperative", () =>
	{
		const { world, hq, manager } = seat([GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" } }, {}]);
		const before = hq.Config.personality.cooperative;
		manager.checkEvents(world.gameState, events({ "TributeExchanged": [
			{ "to": PLAYER, "from": 2, "amounts": { "food": 100, "wood": 100 } },
			{ "to": 3, "from": 2, "amounts": { "food": 5000 } }
		] }));
		assert.ok(Math.abs(hq.Config.personality.cooperative - (before + 0.0001 * 300)) < 1e-9, "food counts once, the rest twice");

		world.addEntity(makeHqEntity({ "id": 300, "owner": 3, "position": [40, 40], "classes": ["Unit"] }));
		world.addEntity(makeHqEntity({ "id": 301, "owner": 2, "position": [44, 40], "classes": ["Unit"] }));
		world.addEntity(makeHqEntity({ "id": 302, "owner": 3, "position": [48, 40], "classes": ["Unit"] }));
		const mid = hq.Config.personality.cooperative;
		manager.checkEvents(world.gameState, events({ "Attacked": [
			{ "target": 300, "attacker": 301 },
			{ "target": 300, "attacker": 302 },	// an enemy hitting an enemy
			{ "target": 999, "attacker": 301 }
		] }));
		assert.ok(Math.abs(hq.Config.personality.cooperative - (mid + 0.003)) < 1e-9);
	});

	it("a player taking up our request is answered in kind; otherwise the request is dropped", () =>
	{
		const players = table();
		players[2] = { "towards": { 1: "ally" } };
		const { world, manager } = seat(players);
		manager.sentDiplomacyRequests.set(2, { "requestType": "ally", "timeSent": 0 });
		manager.sentDiplomacyRequests.set(3, { "requestType": "neutral", "timeSent": 0 });

		manager.checkEvents(world.gameState, events({ "DiplomacyChanged": [
			{ "player": 2, "otherPlayer": PLAYER }, { "player": 3, "otherPlayer": PLAYER }, { "player": 4, "otherPlayer": 2 }
		] }));

		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "ally" }]);
		assert.equal(manager.sentDiplomacyRequests.size, 0);
	});

	it("a player who breaks off with us breaks the alliance, or ends the talks", () =>
	{
		const { world, manager } = seat(table());
		manager.receivedDiplomacyRequests.set(2, { "requestType": "ally", "status": "accepted" });
		manager.receivedDiplomacyRequests.set(3, { "requestType": "ally", "status": "waitingForTribute", "wanted": 1, "type": "wood" });
		manager.receivedDiplomacyRequests.set(4, { "requestType": "neutral", "status": "allianceBroken" });

		manager.checkEvents(world.gameState, events({ "DiplomacyChanged": [2, 3, 4].map((player) => ({ player, "otherPlayer": PLAYER })) }));

		assert.equal(manager.receivedDiplomacyRequests.get(2)?.status, "allianceBroken");
		assert.equal(manager.receivedDiplomacyRequests.get(3)?.status, "declinedRequest");
		assert.equal(manager.receivedDiplomacyRequests.get(4)?.status, "allianceBroken");
	});

	it("a player who allies with us while we are enemies is told no, or offered neutrality", () =>
	{
		const players = table();
		players[2] = { "towards": { 1: "ally" } };
		players[3] = { "towards": { 1: "ally" } };
		const { world, manager } = seat(players);
		manager.receivedDiplomacyRequests.set(2, { "requestType": "neutral", "status": "declinedRequest" });

		manager.checkEvents(world.gameState, events({ "DiplomacyChanged": [2, 3].map((player) => ({ player, "otherPlayer": PLAYER })) }));

		assert.deepEqual(answersTo(2), [ANSWERS.ally.decline]);
		assert.deepEqual(answersTo(3), [ANSWERS.ally.declineSuggestNeutral]);
	});

	it("a player who allies with us while we are neutral, or turns neutral while we are enemies, makes a request", () =>
	{
		const players: PlayerSpec[] = [GAIA, US({ 2: "neutral" }), { "towards": { 1: "ally" } }, { "towards": { 1: "neutral" } }, {}, {}];
		const { world, manager } = seat(players);

		manager.checkEvents(world.gameState, events({ "DiplomacyChanged": [2, 3].map((player) => ({ player, "otherPlayer": PLAYER })) }));

		assert.equal(manager.receivedDiplomacyRequests.get(2)?.requestType, "ally");
		assert.equal(manager.receivedDiplomacyRequests.get(3)?.requestType, "neutral");
	});

	it("a defeated player's requests are forgotten", () =>
	{
		const { world, manager } = seat(table());
		manager.receivedDiplomacyRequests.set(2, { "requestType": "ally", "status": "accepted" });
		manager.sentDiplomacyRequests.set(2, { "requestType": "ally", "timeSent": 0 });

		manager.checkEvents(world.gameState, events({ "PlayerDefeated": [{ "playerId": 2 }] }));

		assert.equal(manager.receivedDiplomacyRequests.size, 0);
		assert.equal(manager.sentDiplomacyRequests.size, 0);
	});

	it("an AI's request is answered, and a tribute asked of it through the game", () =>
	{
		const { world, manager } = seat(table());
		manager.checkEvents(world.gameState, events({ "DiplomacyRequest": [
			{ "player": PLAYER, "source": 2, "to": "ally" }, { "player": 3, "source": 4, "to": "ally" }
		] }));

		assert.deepEqual(of("tribute-request"), [
			{ "type": "tribute-request", "source": PLAYER, "player": 2, "resourceWanted": 1000, "resourceType": "wood" }
		]);
	});

	it("an AI asking us a tribute for our request gets it when we can afford it", () =>
	{
		const { world, manager } = seat(table(), { "stock": { "food": 500 } });
		ai(world).elapsedTime = 100;
		manager.checkEvents(world.gameState, events({ "TributeRequest": [
			{ "player": PLAYER, "source": 2, "resourceWanted": 300, "resourceType": "food" },
			{ "player": PLAYER, "source": 3, "resourceWanted": 800, "resourceType": "food" },
			{ "player": 4, "source": 2, "resourceWanted": 1, "resourceType": "food" }
		] }));

		assert.deepEqual(of("tribute"), [{ "type": "tribute", "player": 2, "amounts": { "food": 300 } }]);
		assert.equal(manager.nextTributeUpdate, 115);
	});
});

describe("the last man standing: lastManStandingCheck", () =>
{
	// gaia, us, an ally and a neutral player, no enemy left
	const endgame = (extra: Partial<HqWorldOptions> = {}, players?: PlayerSpec[]) =>
		seat(players ?? [GAIA, US({ 2: "ally", 3: "neutral" }), { "towards": { 1: "ally" } }, { "towards": { 1: "neutral" } }], extra);

	it("waits a while once only friends are left, and longer while still weak", () =>
	{
		const { world, manager } = endgame();
		ai(world).elapsedTime = 500;

		manager.lastManStandingCheck(world.gameState);
		assert.equal(manager.waitingToBetray, true);
		assert.equal(manager.betrayLapseTime, 510);

		manager.lastManStandingCheck(world.gameState);
		assert.equal(manager.betrayLapseTime, 570, "fewer than fifty units: a minute more");
		assert.deepEqual(of("diplomacy"), []);
	});

	it("turns against the strongest, counting a neutral as stronger", () =>
	{
		const { world, manager } = endgame();
		army(world, 1, 50);
		army(world, 2, 200);
		army(world, 3, 10);
		manager.waitingToBetray = true;

		manager.lastManStandingCheck(world.gameState);
		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "enemy" }], "200 units beat 10 + 150");

		const close = endgame();
		army(close.world, 1, 50);
		army(close.world, 2, 100);
		army(close.world, 3, 20);
		close.manager.waitingToBetray = true;
		close.manager.lastManStandingCheck(close.world.gameState);
		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 3, "to": "enemy" }], "20 + 150 beat 100");
		assert.equal(close.manager.waitingToBetray, false);
	});

	// only the port passes: the original diplomacyManager.js never imports
	// `filters`, so this check throws a ReferenceError in a wonder game; and
	// even with the import it reads the wonder as a collection's [0], which an
	// EntityCollection never answers, so it would never see one
	it("in a wonder game, turns at once against a player with a finished wonder", () =>
	{
		const { world, manager } = endgame({ "victoryConditions": ["wonder"] });
		army(world, 1, 50);
		army(world, 2, 100);
		world.addEntity(makeHqEntity({ "id": 900, "owner": 3, "position": [200, 200], "classes": ["Structure", "Wonder"] }));
		manager.waitingToBetray = true;

		manager.lastManStandingCheck(world.gameState);

		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 3, "to": "enemy" }]);
	});

	// only the port passes: the original never imports `filters` (see above),
	// so this check throws a ReferenceError in a relic game
	it("in a relic game, counts each relic a player holds", () =>
	{
		const { world, manager } = endgame({ "victoryConditions": ["capture_the_relic"] },
			[GAIA, US({ 2: "ally", 3: "ally" }), { "towards": { 1: "ally" } }, { "towards": { 1: "ally" } }]);
		army(world, 1, 50);
		army(world, 2, 100);
		for (const id of [910, 911])
			world.addEntity(makeHqEntity({ "id": id, "owner": 3, "position": [200, 200], "classes": ["Unit", "Relic"] }));
		manager.waitingToBetray = true;

		manager.lastManStandingCheck(world.gameState);

		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 3, "to": "enemy" }], "two relics weigh 300");
	});

	it("the player turned against loses its pending deals", () =>
	{
		const { world, manager } = endgame();
		army(world, 1, 50);
		army(world, 2, 200);
		manager.receivedDiplomacyRequests.set(2, { "requestType": "ally", "status": "waitingForTribute", "wanted": 1, "type": "wood" });
		manager.sentDiplomacyRequests.set(2, { "requestType": "ally", "timeSent": 0 });
		manager.waitingToBetray = true;

		manager.lastManStandingCheck(world.gameState);

		assert.equal(manager.receivedDiplomacyRequests.get(2)?.status, "declinedRequest");
		assert.deepEqual(answersTo(2), [ANSWERS.ally.decline]);
		assert.equal(manager.sentDiplomacyRequests.has(2), false);
	});

	it("does nothing in a team-locked game, a ceasefire, an allied victory with allies, alone, or with enemies left", () =>
	{
		const locked = endgame({}, [GAIA, { "towards": { 2: "ally" }, "teamLocked": true }, { "towards": { 1: "ally" } }]);
		locked.manager.lastManStandingCheck(locked.world.gameState);
		assert.equal(locked.manager.waitingToBetray, false, "team locked");

		const truce = endgame({ "ceasefire": true });
		truce.manager.lastManStandingCheck(truce.world.gameState);
		assert.equal(truce.manager.waitingToBetray, false, "ceasefire");

		const shared = endgame({ "alliedVictory": true });
		shared.manager.lastManStandingCheck(shared.world.gameState);
		assert.equal(shared.manager.waitingToBetray, false, "allied victory");

		const alone = endgame({}, [GAIA, US()]);
		alone.manager.lastManStandingCheck(alone.world.gameState);
		assert.equal(alone.manager.waitingToBetray, false, "alone");

		const war = endgame({}, [GAIA, US(), {}]);
		war.manager.waitingToBetray = true;
		war.manager.lastManStandingCheck(war.world.gameState);
		assert.equal(war.manager.waitingToBetray, false, "an enemy is left");
	});
});

describe("tributes we asked for and requests we sent", () =>
{
	const table = (): PlayerSpec[] => [GAIA, US(), {}, {}, {}];

	it("a player slow to pay is reminded once, then turned down", () =>
	{
		const { world, manager } = seat(table());
		manager.receivedDiplomacyRequests.set(2, { "requestType": "ally", "status": "waitingForTribute", "wanted": 1000,
			"type": "wood", "warnTime": 100, "sentWarning": false });
		ai(world).elapsedTime = 90;
		manager.checkRequestedTributes(world.gameState);
		assert.deepEqual(answersTo(2), [], "not yet");

		ai(world).elapsedTime = 110;
		manager.checkRequestedTributes(world.gameState);
		assert.deepEqual(answersTo(2), [ANSWERS.ally.waitingForTribute]);
		assert.equal(manager.receivedDiplomacyRequests.get(2)?.warnTime, 170);

		ai(world).elapsedTime = 180;
		manager.checkRequestedTributes(world.gameState);
		assert.deepEqual(answersTo(2).at(-1), ANSWERS.ally.decline);
		assert.equal(manager.receivedDiplomacyRequests.has(2), false);
	});

	it("a request goes to the player sharing most of our enemies, as an alliance since we are neutral with it", () =>
	{
		// 3 and 4 are at war with 5 as we are; 2 is at war with nobody
		const players: PlayerSpec[] = [GAIA, US({ 3: "neutral" }), { "towards": { 1: "ally", 3: "ally", 4: "ally", 5: "ally" } },
			{ "towards": { 1: "neutral" } }, {}, {}];
		const { world, manager } = seat(players);
		ai(world).elapsedTime = 50;

		manager.sendDiplomacyRequest(world.gameState);

		// 3 shares four of our enemies (gaia counted), 4 and 5 three each
		assert.deepEqual([...manager.sentDiplomacyRequests], [[3, { "requestType": "ally", "timeSent": 50 }]]);
		assert.deepEqual(of("diplomacy-request"), [{ "type": "diplomacy-request", "source": PLAYER, "player": 3, "to": "ally" }]);
	});

	it("no request goes to an ally, a defeated player, the player we attack, one already asked or one we turned down", () =>
	{
		const players: PlayerSpec[] = [GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" } }, {}, {}, {}, {}];
		const { world, hq, manager } = seat(players);
		hq.attackManager.defeated[3] = true;
		hq.attackManager.currentEnemyPlayer = 4;
		manager.sentDiplomacyRequests.set(5, { "requestType": "neutral", "timeSent": 0 });
		manager.receivedDiplomacyRequests.set(6, { "requestType": "neutral", "status": "declinedRequest" });

		manager.sendDiplomacyRequest(world.gameState);

		assert.deepEqual(of("diplomacy-request"), []);
	});

	it("an unanswered request is withdrawn after a minute, once we are big enough to care", () =>
	{
		const { world, manager } = seat(table(), { "population": 80 });
		manager.sentDiplomacyRequests.set(2, { "requestType": "ally", "timeSent": 0 });
		ai(world).elapsedTime = 50;
		manager.checkSentDiplomacyRequests(world.gameState);
		assert.equal(manager.sentDiplomacyRequests.size, 1);

		ai(world).elapsedTime = 70;
		manager.checkSentDiplomacyRequests(world.gameState);
		assert.equal(manager.sentDiplomacyRequests.size, 0);
		assert.equal(answersTo(2).length, 1, "the request is revoked aloud");
	});
});

describe("diplomacy through the turn: update", () =>
{
	it("sends tributes when due, checks the betrayal, and now and then sends a request", () =>
	{
		// three enemies besides gaia, no ally: chance may send a request
		const { world, manager } = seat([GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" }, "resourceCounts": { "wood": 100 } },
			{}, {}, {}], { "stock": { "wood": 1000 } }, true);
		army(world, 1, 3);
		ai(world).elapsedTime = 400;

		manager.update(world.gameState, events());

		assert.equal(of("tribute").length, 1, "the tribute to the ally");
		assert.equal(of("diplomacy-request").length, 1, "a request to one of the enemies");
		assert.equal(manager.sentDiplomacyRequestLapseTime, 400 + 300 + 10);
	});

	it("the betrayal waits for its time, and nothing is sent during a ceasefire", () =>
	{
		const { world, manager } = seat([GAIA, US(), {}, {}, {}], { "ceasefire": true }, true);
		manager.waitingToBetray = true;
		manager.betrayLapseTime = 1000;
		ai(world).elapsedTime = 400;

		manager.update(world.gameState, events());

		assert.equal(manager.waitingToBetray, true, "not yet time");
		assert.deepEqual(of("diplomacy-request"), []);
	});

	it("when the betrayal is due, it is checked again", () =>
	{
		const { world, manager } = seat([GAIA, US({ 2: "ally" }), { "towards": { 1: "ally" } }]);
		manager.waitingToBetray = true;
		manager.betrayLapseTime = 100;
		ai(world).elapsedTime = 200;
		army(world, 1, 50);

		manager.update(world.gameState, events());

		assert.deepEqual(of("diplomacy"), [{ "type": "diplomacy", "player": 2, "to": "enemy" }]);
	});
});
