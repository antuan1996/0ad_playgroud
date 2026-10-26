/**
 * VictoryManager: what the victory conditions ask of the AI — guards and
 * healers for the hero of a regicide game and its retreat when wounded,
 * guards for a wonder and the workers that raise it, and raids to capture the
 * gaia relics of a relic game. The suites seat a real office on the plain
 * (tests/harness/hqWorld.ts), with its military and garrison offices
 * recorded at the door.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventsWith, fake, makeTemplate, type Methods, override } from "./harness/fakes.ts";
import {
	doorCalls, doorManagers, ENEMY, type HqWorld, type HqWorldOptions, makeHqEntity, makeHqWorld,
	PLAYER, seatHQ
} from "./harness/hqWorld.ts";

import { armyId, entityId, playerId, seconds, transportPlanId } from "../adapter/brands.ts";
import { type SerializedVictoryManager, VictoryManager } from "../decision/victoryManager.ts";
import type { AttackPlan } from "../execution/attackPlan.ts";

/** the relic raids a victory manager books, its own private record */
function raids(manager: VictoryManager): Map<EntityId, number[]>
{
	return fake<{ targetedGaiaRelics: Map<EntityId, number[]> }>(manager).targetedGaiaRelics;
}

const PlayerID = PLAYER;

/** the military offices are doors here too: the guards and raids are recorded, not run */
const victoryDoors = [...doorManagers, "attackManager", "garrisonManager"];

/** an office on the plain, playing the given victory conditions */
function seat(victoryConditions: string[] = [], options: Partial<HqWorldOptions> = {})
{
	const world = makeHqWorld({ victoryConditions, ...options });
	const hq = seatHQ(world, { "stubs": victoryDoors });
	hq.updateTerritories(world.gameState);
	// the military office's answers: no plan unless a test gives one, no army
	hq.attackManager.getPlan = () => undefined;
	hq.attackManager.outOfPlan = world.gameState.getOwnUnits().filter((e: CommonEntity) => e.getMetadata(PlayerID, "plan") === -1);
	hq.defenseManager.getArmy = () => undefined;
	const manager = new VictoryManager(hq.Config);
	return { world, hq, manager, "queues": world.ai.queues };
}

/** a unit of ours at the given spot, recording its orders */
function unit(world: HqWorld, id: number, classes: string[], position: [number, number] | undefined = [40, 40],
	metadata: Record<string, unknown> = {}, methods: Methods = {}, owner = PLAYER)
{
	const orders: unknown[][] = [];
	let stance = "aggressive";
	const ent = world.addEntity(makeHqEntity({ id, owner, position, "classes": ["Unit", ...classes] }, {
		"canGuard": () => true,
		"guard": (target: CommonEntity, queued: boolean) => orders.push(["guard", target.id(), queued]),
		"removeGuard": () => orders.push(["removeGuard"]),
		"stopMoving": () => orders.push(["stop"]),
		"moveToRange": (x: number, z: number, min: number, max: number) => orders.push(["range", x, z, min, max]),
		"setStance": (s: string) => { stance = s; },
		"getStance": () => stance,
		"healthLevel": () => 1,
		...methods
	}, metadata));
	return { ent, orders };
}

const events = (extra: Record<string, unknown[]>) => (eventsWith({ "Garrison": [], "UnGarrison": [], ...extra }));

describe("the victory-critical entities at the start: init", () =>
{
	it("in a wonder game, our wonders, raised or rising, are to be guarded", () =>
	{
		const { world, manager } = seat(["wonder"]);
		world.addEntity(makeHqEntity({ "id": 500, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Wonder"] }));
		world.addEntity(makeHqEntity({ "id": 501, "owner": PLAYER, "position": [200, 100], "classes": ["Structure", "Wonder"] },
			{ "foundationProgress": () => 0.5 }));
		world.addEntity(makeHqEntity({ "id": 502, "owner": ENEMY, "position": [200, 200], "classes": ["Structure", "Wonder"] }));

		manager.init(world.gameState);

		assert.deepEqual([...manager.criticalEnts.keys()], [500, 501]);
		assert.equal(manager.criticalEnts.get(entityId(500))?.healersAssigned, undefined, "a wonder needs no healer");
	});

	it("in regicide, our hero is guarded and healed; a soldier hero fights, another keeps away", () =>
	{
		const { world, manager } = seat(["regicide"]);
		const soldierHero = unit(world, 600, ["Hero", "Soldier"]);
		const kingHero = unit(world, 601, ["Hero"]);

		manager.init(world.gameState);

		assert.ok(manager.criticalEnts.get(entityId(600))?.healersAssigned instanceof Set);
		assert.equal(soldierHero.ent.getStance(), "aggressive");
		assert.equal(kingHero.ent.getStance(), "passive");
		assert.equal(manager.criticalEnts.get(entityId(601))?.garrisonEmergency, false);
	});

	it("in a relic game, the relics we hold are to be guarded, not gaia's", () =>
	{
		const { world, manager } = seat(["capture_the_relic"]);
		unit(world, 700, ["Relic"]);
		unit(world, 701, ["Relic"], [200, 200], {}, {}, playerId(0));

		manager.init(world.gameState);

		assert.deepEqual([...manager.criticalEnts.keys()], [700]);
	});

	it("in a plain conquest game, nothing is critical", () =>
	{
		const { world, manager } = seat([]);
		unit(world, 600, ["Hero", "Soldier"]);
		manager.init(world.gameState);
		assert.equal(manager.criticalEnts.size, 0);
	});
});

describe("a wonder game: the wonder's builders and guards", () =>
{
	it("a wonder foundation of a town gets ten workers from the other towns", () =>
	{
		const { world, hq, manager } = seat(["wonder"]);
		const helpers = [unit(world, 800, ["Worker"]).ent, unit(world, 801, ["Worker"]).ent];
		const asked: unknown[] = [];
		override(hq, { "bulkPickWorkers": (_gs: unknown, base: { ID: number }, number: number) =>
		{
			asked.push([base.ID, number]);
			return { "values": () => helpers };
		} });
		world.addEntity(makeHqEntity({ "id": 501, "owner": PLAYER, "position": [200, 100], "classes": ["Structure", "Wonder"] },
			{ "foundationProgress": () => 0.1 }, { "base": 2 }));

		manager.checkEvents(world.gameState, events({ "Create": [{ "entity": 501 }, { "entity": 999 }] }));

		assert.deepEqual(asked, [[2, 10]]);
		for (const w of helpers)
		{
			assert.equal(w.getMetadata(PlayerID, "subrole"), "builder");
			assert.equal(w.getMetadata(PlayerID, "target-foundation"), 501);
			assert.equal(w.getMetadata(PlayerID, "base"), 2);
		}
	});

	it("a wonder just finished, or captured, is to be guarded", () =>
	{
		const { world, manager } = seat(["wonder"]);
		world.addEntity(makeHqEntity({ "id": 500, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Wonder"] }));
		world.addEntity(makeHqEntity({ "id": 503, "owner": PLAYER, "position": [150, 100], "classes": ["Structure", "Wonder"] }));

		manager.checkEvents(world.gameState, events({
			"ConstructionFinished": [{ "newentity": 500 }, {}],
			"OwnershipChanged": [{ "entity": 503, "from": ENEMY, "to": PLAYER }]
		}));

		assert.deepEqual([...manager.criticalEnts.keys()].sort(), [500, 503]);
	});
});

describe("regicide: the hero under attack", () =>
{
	/** a regicide game with our hero at the given health */
	function heroAt(health: number, metadata: Record<string, unknown> = {})
	{
		const s = seat(["regicide"]);
		const hero = unit(s.world, 600, ["Hero", "Soldier"], [60, 60], metadata, { "healthLevel": () => health });
		s.manager.init(s.world.gameState);
		return { ...s, hero };
	}

	it("a hero still in good health keeps fighting", () =>
	{
		const { world, hq, manager, hero } = heroAt(0.9);
		manager.checkEvents(world.gameState, events({ "Attacked": [{ "target": 600 }, { "target": 999 }] }));
		assert.deepEqual(hero.orders, []);
		assert.deepEqual(doorCalls(hq.defenseManager), []);
	});

	it("a wounded hero leaves its attack and army and retreats to the nearest town", () =>
	{
		const left: string[] = [];
		const { world, hq, manager, hero } = heroAt(0.6, { "plan": 4, "PartOfArmy": 7 });
		override(hq.attackManager, { "getPlan": (id: number) => id === 4 ? { "removeUnit": () => left.push("attack") } : undefined });
		override(hq.defenseManager, { "getArmy": (id: number) => id === 7 ? { "removeOwn": () => left.push("army") } : undefined });

		manager.checkEvents(world.gameState, events({ "Attacked": [{ "target": 600 }] }));

		assert.deepEqual(left, ["attack", "army"]);
		assert.deepEqual(hero.orders[0], ["stop"]);
		const garrison = doorCalls(hq.defenseManager).find(([m]) => m === "garrisonAttackedUnit");
		assert.equal(garrison?.[1][2], false, "not an emergency yet");
		assert.equal(hero.ent.getStance(), "passive", "it flees rather than fights");
		assert.deepEqual(hero.orders.at(-1), ["range", 10, 10, 0, 2], "to the town centre");
	});

	it("a badly wounded hero asks for a garrison in an emergency", () =>
	{
		const { world, hq, manager } = heroAt(0.3);
		manager.checkEvents(world.gameState, events({ "Attacked": [{ "target": 600 }] }));
		const garrison = doorCalls(hq.defenseManager).find(([m]) => m === "garrisonAttackedUnit");
		assert.equal(garrison?.[1][2], true);
	});

	it("a hero already heading for a garrison, now badly wounded, hurries to the nearest one", () =>
	{
		const { world, hq, manager } = heroAt(0.3, { "plan": -2 });

		manager.checkEvents(world.gameState, events({ "Attacked": [{ "target": 600 }] }));

		assert.ok(doorCalls(hq.garrisonManager).some(([m]) => m === "cancelGarrison"));
		assert.equal(manager.criticalEnts.get(entityId(600))?.garrisonEmergency, true);
		manager.checkEvents(world.gameState, events({ "Attacked": [{ "target": 600 }] }));
		assert.equal(doorCalls(hq.garrisonManager).filter(([m]) => m === "cancelGarrison").length, 1, "once");
	});

	it("a hero garrisoned in a building has its guards gather round it; healers on their way to heal stay", () =>
	{
		const { world, manager } = heroAt(0.9);
		const fort = world.addEntity(makeHqEntity({ "id": 650, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "Fortress"] },
			{ "obstructionRadius": () => ({ "min": 8, "max": 12 }) }));
		const soldier = unit(world, 610, ["Soldier"]);
		const healer = unit(world, 611, ["Healer"], [40, 40], { "plan": -2 });
		manager.criticalEnts.get(entityId(600))?.guards.set(entityId(610), "guard").set(entityId(611), "healer");
		manager.criticalEnts.get(entityId(600))!.garrisonEmergency = true;

		manager.checkEvents(world.gameState, events({ "Garrison": [{ "entity": 600, "holder": 650 }, { "entity": 999, "holder": 650 }] }));

		assert.deepEqual(soldier.orders, [["range", 80, 80, 12, 17]]);
		assert.deepEqual(healer.orders, []);
		assert.equal(manager.criticalEnts.get(entityId(600))?.garrisonEmergency, false, "it found its shelter");
		void fort;
	});

	it("a hero aboard a ship lets its guards go", () =>
	{
		const { world, manager } = heroAt(0.9);
		world.addEntity(makeHqEntity({ "id": 651, "owner": PLAYER, "position": [200, 80], "classes": ["Unit", "Ship"] }));
		const soldier = unit(world, 610, ["Soldier"]);
		manager.criticalEnts.get(entityId(600))?.guards.set(entityId(610), "guard").set(entityId(698), "guard");
		manager.guardEnts.set(entityId(610), true);

		manager.checkEvents(world.gameState, events({ "Garrison": [{ "entity": 600, "holder": 651 }] }));

		assert.deepEqual(soldier.orders, [["removeGuard"]]);
		assert.equal(manager.guardEnts.get(entityId(610)), false);
		assert.equal(manager.criticalEnts.get(entityId(600))?.guards.size, 0);
	});

	it("a healer just trained for the hero is sent to it", () =>
	{
		const { world, manager } = heroAt(0.9);
		const healer = unit(world, 620, ["Healer"], [44, 44], { "role": "criticalEntHealer" });
		unit(world, 621, ["Infantry"], [44, 44]);

		manager.checkEvents(world.gameState, events({ "TrainingFinished": [{ "entities": [620, 621, 999] }] }));

		assert.deepEqual(healer.orders, [["guard", 600, false]]);
		assert.equal(manager.criticalEnts.get(entityId(600))?.guards.get(entityId(620)), "healer");
		assert.ok(manager.criticalEnts.get(entityId(600))?.healersAssigned?.has(entityId(620)));
	});
});

describe("guards renamed, killed, unloaded; critical entities lost", () =>
{
	it("a promoted guard keeps its post under its new id", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		manager.init(world.gameState);
		manager.criticalEnts.get(entityId(600))?.guards.set(entityId(610), "guard");
		manager.guardEnts.set(entityId(610), true);

		manager.checkEvents(world.gameState, events({ "EntityRenamed": [{ "entity": 610, "newentity": 611 }, { "entity": 999, "newentity": 1 }] }));

		assert.equal(manager.criticalEnts.get(entityId(600))?.guards.get(entityId(611)), "guard");
		assert.equal(manager.guardEnts.get(entityId(611)), true);
		assert.equal(manager.guardEnts.has(entityId(610)), false);
	});

	it("a guard killed leaves the books of the entity it guarded", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		manager.init(world.gameState);
		const crit = manager.criticalEnts.get(entityId(600))!;
		crit.guards.set(entityId(611), "healer");
		crit.healersAssigned?.add(entityId(611));
		manager.guardEnts.set(entityId(611), true);

		manager.checkEvents(world.gameState, events({ "Destroy": [{ "entity": 611 }, { "entity": 999 }] }));

		assert.equal(crit.guards.size, 0);
		assert.equal(crit.healersAssigned?.size, 0);
		assert.equal(manager.guardEnts.has(entityId(611)), false);
	});

	it("a critical entity lost lets its healers be reassigned and its soldiers return to the army", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		manager.init(world.gameState);
		const soldier = unit(world, 610, ["Soldier"], [40, 40], { "plan": -2, "role": "criticalEntGuard", "guardedEnt": 600 });
		unit(world, 611, ["Healer"], [40, 40], { "role": "criticalEntHealer" });
		manager.criticalEnts.get(entityId(600))?.guards.set(entityId(610), "guard").set(entityId(611), "healer").set(entityId(612), "guard");
		manager.guardEnts.set(entityId(610), true).set(entityId(611), true);

		manager.checkEvents(world.gameState, events({ "Destroy": [{ "entity": 600 }] }));

		assert.equal(manager.criticalEnts.size, 0);
		assert.equal(soldier.ent.getMetadata(PlayerID, "plan"), -1);
		assert.equal(soldier.ent.getMetadata(PlayerID, "role"), undefined);
		assert.equal(soldier.ent.getMetadata(PlayerID, "guardedEnt"), undefined);
		assert.equal(manager.guardEnts.has(entityId(610)), false);
		assert.equal(manager.guardEnts.get(entityId(611)), false, "the healer waits for another to heal");
	});

	it("a critical entity captured from us is no longer ours to guard", () =>
	{
		const { world, manager } = seat(["capture_the_relic"]);
		unit(world, 700, ["Relic"]);
		manager.init(world.gameState);

		manager.checkEvents(world.gameState, events({ "OwnershipChanged": [{ "entity": 700, "from": PLAYER, "to": ENEMY }] }));

		assert.equal(manager.criticalEnts.size, 0);
	});

	it("a relic we capture is guarded and taken to the nearest town", () =>
	{
		const { world, hq, manager } = seat(["capture_the_relic"]);
		const relic = unit(world, 700, ["Relic"], [60, 60]);

		manager.checkEvents(world.gameState, events({ "OwnershipChanged": [{ "entity": 700, "from": 0, "to": PLAYER }] }));

		assert.ok(manager.criticalEnts.has(entityId(700)));
		assert.ok(doorCalls(hq.defenseManager).some(([m]) => m === "garrisonAttackedUnit"));
		assert.equal(relic.ent.getStance(), "aggressive", "a relic has no stance to change");
		assert.deepEqual(relic.orders.at(-1), ["range", 10, 10, 0, 2]);
	});

	it("a guard back from a sea crossing takes up its post; a hero back on land collects the guards it lacked", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"], [60, 60]);
		manager.init(world.gameState);
		const crossed = unit(world, 610, ["Soldier"], [50, 50], { "role": "criticalEntGuard", "guardedEnt": 600 });
		const waiting = unit(world, 611, ["Healer"], [55, 55], { "role": "criticalEntHealer" });
		manager.guardEnts.set(entityId(610), false).set(entityId(611), false);

		manager.checkEvents(world.gameState, events({ "UnGarrison": [{ "entity": 610 }, { "entity": 999 }] }));
		assert.deepEqual(crossed.orders, [["guard", 600, false]]);

		manager.checkEvents(world.gameState, events({ "UnGarrison": [{ "entity": 600 }] }));
		assert.deepEqual(waiting.orders, [["guard", 600, false]]);
	});

	it("a gaia relic we were raiding, taken by someone else, ends the raid", () =>
	{
		const { world, hq, manager } = seat(["capture_the_relic"]);
		const aborted: number[] = [];
		override(hq.attackManager, { "getPlan": (id: number) => ({ "Abort": () => aborted.push(id) }) });
		raids(manager).set(entityId(701), [3, 4]);

		manager.checkEvents(world.gameState, events({ "OwnershipChanged": [{ "entity": 701, "from": 0, "to": ENEMY }] }));

		assert.deepEqual(aborted, [3, 4]);
		assert.equal(raids(manager).size, 0);
	});
});

describe("healers and guards for the critical entities", () =>
{
	/** a regicide game with our hero, a temple, and some population */
	function regicide(population = 100)
	{
		const s = seat(["regicide"], { population, "populationMax": 300 });
		unit(s.world, 600, ["Hero"], [60, 60]);
		s.world.addEntity(makeHqEntity({ "id": 660, "owner": PLAYER, "position": [80, 60], "classes": ["Structure", "Temple"] }));
		s.world.templates["units/athen/support_healer_b"] = makeTemplate("units/athen/support_healer_b",
			{ "classes": ["Unit", "Support", "Healer"], "cost": { "food": 100 } });
		s.manager.init(s.world.gameState);
		return s;
	}

	it("a hero short of healers gets one trained at a temple", () =>
	{
		const { world, manager, queues } = regicide();
		manager.manageCriticalEntHealers(world.gameState, queues);
		assert.deepEqual(queues.healer.plans.map((p) => [p.type, p.metadata]),
			[["units/athen/support_healer_b", { "role": "criticalEntHealer", "base": 0 }]]);
	});

	it("no healer is trained while saving, while one is queued, with no temple, with guards enough, or for a hero fully healed", () =>
	{
		const saving = regicide();
		saving.hq.saveResources = true;
		saving.manager.manageCriticalEntHealers(saving.world.gameState, saving.queues);
		assert.equal(saving.queues.healer.plans.length, 0, "saving");

		const crowded = regicide(20);
		for (let i = 0; i < 6; ++i)
			crowded.manager.guardEnts.set(entityId(900 + i), true);
		crowded.manager.manageCriticalEntHealers(crowded.world.gameState, crowded.queues);
		assert.equal(crowded.queues.healer.plans.length, 0, "more guards than a quarter of the people");

		const served = regicide();
		for (let i = 0; i < served.manager.healersPerCriticalEnt; ++i)
			served.manager.criticalEnts.get(entityId(600))?.healersAssigned?.add(entityId(900 + i));
		served.manager.manageCriticalEntHealers(served.world.gameState, served.queues);
		assert.equal(served.queues.healer.plans.length, 0, "healers enough");

		const noTemple = seat(["regicide"], { "population": 100 });
		unit(noTemple.world, 600, ["Hero"]);
		noTemple.manager.init(noTemple.world.gameState);
		noTemple.manager.manageCriticalEntHealers(noTemple.world.gameState, noTemple.queues);
		assert.equal(noTemple.queues.healer.plans.length, 0, "no temple");
	});

	it("with workers short, citizen-soldier guards go back to work", () =>
	{
		const { world, manager } = regicide();
		const guard = unit(world, 610, ["Soldier", "CitizenSoldier"], [60, 60], { "role": "criticalEntGuard", "plan": -2, "guardedEnt": 600 });
		const champion = unit(world, 611, ["Soldier", "Champion"], [60, 60], { "role": "criticalEntGuard", "plan": -2 });
		manager.criticalEnts.get(entityId(600))?.guards.set(entityId(610), "guard").set(entityId(611), "guard");
		manager.guardEnts.set(entityId(610), true).set(entityId(611), true);

		manager.manageCriticalEntGuards(world.gameState);

		assert.deepEqual(guard.orders[0], ["removeGuard"]);
		assert.equal(guard.ent.getMetadata(PlayerID, "plan"), -1);
		assert.equal(guard.ent.getMetadata(PlayerID, "role"), undefined);
		assert.equal(manager.guardEnts.has(entityId(610)), false);
		assert.equal(champion.ent.getMetadata(PlayerID, "plan"), -2, "a champion stays");
	});

	it("guards are drawn from the champions first, then units out of any plan, then soldiers, while workers suffice", () =>
	{
		const { world, manager } = seat(["wonder"]);
		world.addEntity(makeHqEntity({ "id": 500, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Wonder"] },
			{}, { "base": 2 }));
		manager.init(world.gameState);
		for (let i = 0; i < 40; ++i)
			unit(world, 1100 + i, ["Worker"], [30, 30], { "role": "worker" });
		const champion = unit(world, 1200, ["Soldier", "Champion"], [90, 90]);
		const reserve = unit(world, 1201, ["Soldier", "Infantry"], [90, 95], { "plan": -1 });
		unit(world, 1202, ["Soldier", "Infantry"], [90, 85], { "plan": 3 });
		const free = unit(world, 1203, ["Soldier", "Infantry"], [95, 90]);

		manager.manageCriticalEntGuards(world.gameState);

		const data = manager.criticalEnts.get(entityId(500))!;
		assert.ok(data.guardsAssigned.has(entityId(1200)), "the champion");
		assert.equal(champion.ent.getMetadata(PlayerID, "role"), "criticalEntGuard");
		assert.equal(champion.ent.getMetadata(PlayerID, "plan"), -2);
		assert.equal(free.ent.getMetadata(PlayerID, "base"), 2, "a guard of a structure joins its town");
		assert.equal(data.guardsAssigned.has(entityId(1202)), false, "a unit busy in an attack is left to it");
		// only the port passes: the original refuses a unit out of any plan (-1)
		assert.ok(data.guardsAssigned.has(entityId(1201)), "the unit out of any plan");
		assert.equal(reserve.ent.getMetadata(PlayerID, "plan"), -2);
		// forty workers allow 25 + 3 per guard: at most five guards
		assert.ok(data.guardsAssigned.size <= 5);
	});

	it("a military guard is refused when planned, in transport, critical itself, or on another land", () =>
	{
		const { world, manager } = seat(["wonder"]);
		const wonder = world.addEntity(makeHqEntity({ "id": 500, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Wonder"] }));
		manager.init(world.gameState);
		world.accessAt.set("250,250", 3);
		const cases = [
			unit(world, 1300, ["Soldier"], [90, 90], { "plan": 1 }),
			unit(world, 1301, ["Soldier"], [90, 90], { "transport": 2 }),
			unit(world, 1302, ["Soldier"], [250, 250])
		];
		for (const c of cases)
			assert.equal(manager.tryAssignMilitaryGuard(world.gameState, c.ent, wonder, true), false, String(c.ent.id()));
		assert.equal(manager.tryAssignMilitaryGuard(world.gameState, wonder, wonder, false), false, "critical itself");
	});
});

describe("sending a guard to its post: assignGuardToCriticalEnt", () =>
{
	it("a unit unable to guard, or waiting for a boat, is not taken", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		manager.init(world.gameState);
		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, unit(world, 610, ["Soldier"], [40, 40], {}, { "canGuard": () => false }).ent), false);
		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, unit(world, 611, ["Soldier"], [40, 40], { "transport": 1 }).ent), false);
	});

	it("a guard sent to a critical entity that is gone is sent to the one with fewest guards", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		unit(world, 601, ["Hero"]);
		manager.init(world.gameState);
		manager.criticalEnts.get(entityId(600))?.guardsAssigned.add(entityId(999));
		const guard = unit(world, 610, ["Soldier"], [40, 40], { "guardedEnt": 650 });

		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, guard.ent, entityId(650)), true);

		assert.equal(guard.ent.getMetadata(PlayerID, "guardedEnt"), 601);
		assert.ok(manager.criticalEnts.get(entityId(601))?.guardsAssigned.has(entityId(610)));
	});

	it("a healer is sent to a hero, never to a wonder", () =>
	{
		const { world, manager } = seat(["wonder"]);
		world.addEntity(makeHqEntity({ "id": 500, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Wonder"] }));
		manager.init(world.gameState);
		const healer = unit(world, 620, ["Healer"], [40, 40], { "guardedEnt": 650 });

		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, healer.ent), false);
		assert.equal(healer.ent.getMetadata(PlayerID, "guardedEnt"), undefined);
	});

	it("a guard for a hero out of sight waits", () =>
	{
		const { world, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"], [60, 60], {}, { "position": () => undefined });	// garrisoned
		manager.init(world.gameState);
		const guard = unit(world, 610, ["Soldier"]);

		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, guard.ent, entityId(600)), false);
		assert.equal(manager.guardEnts.get(entityId(610)), false);
	});

	it("a guard on another land asks for a passage", () =>
	{
		const { world, hq, manager } = seat(["regicide"]);
		unit(world, 600, ["Hero"], [60, 60]);
		manager.init(world.gameState);
		world.accessAt.set("250,250", 3);
		const guard = unit(world, 610, ["Soldier"], [250, 250]);

		assert.equal(manager.assignGuardToCriticalEnt(world.gameState, guard.ent, entityId(600)), true);

		assert.ok(doorCalls(hq.navalManager).some(([m]) => m === "requireTransport"));
		assert.equal(manager.guardEnts.get(entityId(610)), false, "not guarding yet");
		assert.equal(guard.ent.getMetadata(PlayerID, "guardedEnt"), 600);
	});
});

describe("the relic game: raids on gaia relics", () =>
{
	/** a relic game with a gaia relic at the given spot, and our capturers nearby */
	function relicGame(relicAt: [number, number] = [120, 120], capturers = 3)
	{
		const s = seat(["capture_the_relic"]);
		const relic = unit(s.world, 701, ["Relic"], relicAt, {}, {
			"defaultRegenRate": () => 1, "capturePoints": () => [500, 0, 0]
		}, playerId(0));
		const units = [...Array(capturers).keys()].map((i) => unit(s.world, 1400 + i, ["Soldier", "Infantry"], [100 + i, 100], {}, {
			"canCapture": () => true, "captureStrength": () => 2.5, "get": () => undefined, "visionRange": () => 80
		}));
		const forced: unknown[] = [];
		const raid = fake<AttackPlan>({
			"name": 9,
			"rallyPoint": undefined,
			"unitCollection": { "updateEnt": () => undefined, "values": () => [] },
			"forceStart": () => forced.push(true)
		});
		s.hq.attackManager.raidTargetEntity = () => raid;
		return { ...s, relic, units, raid, forced };
	}

	it("a gaia relic on our ground is raided at once with the nearest units able to capture it", () =>
	{
		const { world, manager, units, raid, forced } = relicGame([60, 60]);
		world.ai.playedTurn = 10;

		manager.update(world.gameState, events({}), world.ai.queues);

		assert.deepEqual(raids(manager).get(entityId(701)), [9]);
		assert.ok(units.some((u) => u.ent.getMetadata(PlayerID, "plan") === 9));
		assert.deepEqual(forced, [true]);
		assert.ok(raid.rallyPoint, "the raid gathers where its first unit stands");
	});

	it("a gaia relic in sight of our units is raided too, unless on enemy ground", () =>
	{
		const seen = relicGame([140, 100]);
		seen.world.map.setTerritoryOwner(17, 12, 0);
		seen.world.ai.playedTurn = 10;
		seen.manager.update(seen.world.gameState, events({}), seen.world.ai.queues);
		assert.ok(raids(seen.manager).has(entityId(701)), "seen 40 m away");

		const enemyGround = relicGame([140, 100]);
		enemyGround.world.map.setTerritoryOwner(17, 12, ENEMY);
		enemyGround.world.ai.playedTurn = 10;
		enemyGround.manager.update(enemyGround.world.gameState, events({}), enemyGround.world.ai.queues);
		assert.equal(raids(enemyGround.manager).size, 0);
	});

	it("no raid when no unit can capture, or too few to matter, or when the military office declines", () =>
	{
		const none = relicGame([60, 60], 0);
		raids(none.manager).set(entityId(701), []);
		none.manager.captureGaiaRelic(none.world.gameState, none.relic.ent);
		assert.deepEqual(none.forced, []);

		const weak = relicGame([60, 60], 1);
		weak.relic.ent.capturePoints = () => [5000, 0, 0];
		raids(weak.manager).set(entityId(701), []);
		weak.manager.captureGaiaRelic(weak.world.gameState, weak.relic.ent);
		assert.deepEqual(weak.forced, [], "2.5 against 5000 points");

		const declined = relicGame([60, 60]);
		declined.hq.attackManager.raidTargetEntity = () => undefined;
		raids(declined.manager).set(entityId(701), []);
		declined.manager.captureGaiaRelic(declined.world.gameState, declined.relic.ent);
		assert.deepEqual(declined.forced, []);
	});

	it("a raid already strong enough is not reinforced; units already busy are not taken", () =>
	{
		const { world, hq, manager, units, forced } = relicGame([60, 60]);
		override(hq.attackManager, { "getPlan": (id: number) => id === 5 ?
			{ "unitCollection": { "values": () => units.map((u) => u.ent) }, "state": "arrived", "type": "Raid" } : undefined });
		raids(manager).set(entityId(701), [5]);
		manager_relic(world).capturePoints = () => [200, 0, 0];

		manager.captureGaiaRelic(world.gameState, manager_relic(world));
		assert.deepEqual(forced, [], "7.5 capture less 1 regeneration beats a fiftieth of 200 points");

		const busy = relicGame([60, 60]);
		busy.units[0].ent.setMetadata(PlayerID, "transport", transportPlanId(1));
		busy.units[1].ent.setMetadata(PlayerID, "PartOfArmy", armyId(1));
		busy.units[2].ent.setMetadata(PlayerID, "plan", -2);
		raids(busy.manager).set(entityId(701), []);
		busy.manager.captureGaiaRelic(busy.world.gameState, busy.relic.ent);
		assert.deepEqual(busy.forced, []);
	});

	// only the port passes: the original adds captureStrength() for every unit
	// of the raid, and a ram's is undefined, so the total is NaN, the "already
	// enough" exit never fires and every nearby capturer is sent again
	it("a ram in a raid strong enough does not make it look weak", () =>
	{
		const { world, hq, manager, units, forced } = relicGame([60, 60]);
		const ram = unit(world, 1410, ["Siege", "Ram"], [100, 110], { "plan": 5 }, {
			"canCapture": () => false, "captureStrength": () => undefined, "get": () => undefined
		});
		override(hq.attackManager, { "getPlan": (id: number) => id === 5 ?
			{ "unitCollection": { "values": () => [...units.map((u) => u.ent), ram.ent] }, "state": "arrived", "type": "Raid" } : undefined });
		raids(manager).set(entityId(701), [5]);
		manager_relic(world).capturePoints = () => [200, 0, 0];

		manager.captureGaiaRelic(world.gameState, manager_relic(world));
		assert.deepEqual(forced, [], "the three capturers alone are enough");
	});

	it("a raid on a relic no longer gaia's is called off; a raid still needed is reinforced", () =>
	{
		const { world, hq, manager } = relicGame([60, 60]);
		const aborted: number[] = [];
		override(hq.attackManager, { "getPlan": (id: number) => ({ "Abort": () => aborted.push(id),
			"unitCollection": { "values": () => [] } }) });
		raids(manager).set(entityId(701), [5]);
		raids(manager).set(entityId(702), [6]);	// a relic that no longer exists
		world.ai.playedTurn = 20;

		manager.update(world.gameState, events({}), world.ai.queues);

		assert.deepEqual(aborted, [6]);
		assert.deepEqual(raids(manager).get(entityId(701)), [5, 9], "reinforced");
	});

	it("relic captures are spaced out by difficulty", () =>
	{
		const { world, hq, manager } = relicGame();
		world.ai.elapsedTime = seconds(100);
		hq.Config.difficulty = 5;
		manager.resetCaptureGaiaRelic(world.gameState);
		assert.equal(manager.tryCaptureGaiaRelicLapseTime, 100 + 240 - 60);
		assert.equal(manager.tryCaptureGaiaRelic, false);

		world.ai.elapsedTime = seconds(300);
		world.ai.playedTurn = 10;
		manager.update(world.gameState, events({}), world.ai.queues);
		assert.equal(manager.tryCaptureGaiaRelic, true);
	});

	/** the relic of the seat (id 701) */
	function manager_relic(world: HqWorld): CommonEntity
	{
		return world.ents.get(701)!;
	}
});

describe("the victory manager through its turn: update", () =>
{
	it("on its first turn, it finds the critical entities", () =>
	{
		const { world, manager, queues } = seat(["regicide"]);
		unit(world, 600, ["Hero"]);
		world.ai.playedTurn = 1;
		manager.update(world.gameState, events({}), queues);
		assert.ok(manager.criticalEnts.has(entityId(600)));
	});

	it("every tenth turn, a wonder game builds the wonder, and a healthy soldier hero goes back to fighting", () =>
	{
		const wonder = seat(["wonder"]);
		const built: boolean[] = [];
		wonder.hq.buildWonder = (_gs: unknown, _q: unknown, force: boolean) => built.push(force);
		wonder.world.ai.playedTurn = 10;
		wonder.manager.update(wonder.world.gameState, events({}), wonder.queues);
		assert.deepEqual(built, [true]);

		const regicide = seat(["regicide"]);
		const hero = unit(regicide.world, 600, ["Hero", "Soldier"]);
		regicide.manager.init(regicide.world.gameState);
		hero.ent.setStance("passive");
		regicide.world.ai.playedTurn = 10;
		regicide.manager.update(regicide.world.gameState, events({}), regicide.queues);
		assert.equal(hero.ent.getStance(), "aggressive");
	});

	it("does nothing between its tenth turns, or in a plain conquest game", () =>
	{
		const off = seat(["wonder"]);
		const built: boolean[] = [];
		off.hq.buildWonder = () => built.push(true);
		off.world.ai.playedTurn = 11;
		off.manager.update(off.world.gameState, events({}), off.queues);

		const plain = seat([]);
		plain.hq.buildWonder = () => built.push(true);
		plain.world.ai.playedTurn = 10;
		plain.manager.update(plain.world.gameState, events({}), plain.queues);

		assert.deepEqual(built, []);
	});
});

describe("the victory manager saved and loaded", () =>
{
	it("a save from an older version, missing fields, keeps the defaults", () =>
	{
		const { manager } = seat();
		const defaults = manager.Serialize();
		manager.Deserialize(fake<SerializedVictoryManager>({}));
		assert.deepEqual(manager.Serialize(), defaults);
	});
});

