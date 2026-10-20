/**
 * DefenseManager: the office that spots invaders, raises an army around each
 * of them, and finds defenders for every army. The suites walk Petra's real
 * defensive week: a raider spotted near the civil centre, an enemy builder
 * squatting a foundation on the frontier, a fort bleeding capture points, a
 * beast that mauled a villager, gaia ruins left behind by a resigned enemy,
 * armies merging and breaking apart as raiders wander, the roster of
 * defenders it calls up each turn, and the attacked events that decide
 * whether our units shoot back, flee or garrison.
 *
 * The armies inside the manager are real DefenseArmies (covered by their own
 * suite); the manager here is constructed through its own constructor and
 * driven through update() or by calling the sub-methods a turn in the life
 * of headquarters would call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import {
	emptyEvents, ENEMY, GAIA, makeEntity, makeWorld, PLAYER
} from "./harness/attackWorld.ts";
import type { FakeEnt, Methods, World } from "./harness/attackWorld.ts";

const { DefenseManager } = await loadPetraModule<{
	DefenseManager: new (Config: unknown) => DefenseManagerLike;
}>("defenseManager");
const { Worker } = await loadPetraModule<{
	Worker: {
		SUBROLE_DEFENDER: string;
		SUBROLE_ATTACKING: string;
		SUBROLE_COMPLETING: string;
		SUBROLE_WALKING: string;
		SUBROLE_GARRISONING: string;
	};
}>("worker");
const { GarrisonManager } = await loadPetraModule<{
	GarrisonManager: { TYPE_PROTECTION: string; TYPE_DECAY: string; TYPE_EMERGENCY: string };
}>("garrisonManager");
const { AttackPlan } = await loadPetraModule<{
	AttackPlan: { STATE_UNEXECUTED: string };
}>("attackPlan");

type DefenseManagerLike = Record<string, any> & {
	armies: any[];
	targetList: number[];
	armyMergeSize: number;
	attackedAllies: Record<number, number>;
	attackingUnits: Record<number, Record<number, number>>;
	attackingArmies: Record<number, Record<number, number>>;

	makeIntoArmy(gameState: CommonGameState, entityID: number, type?: string): void;
	getArmy(partOfArmy: number): any | undefined;
	abortArmy(gameState: CommonGameState, army: any): void;
	isDangerous(gameState: CommonGameState, entity: FakeEnt): boolean;
	checkEnemyUnits(gameState: CommonGameState): void;
	checkEnemyArmies(gameState: CommonGameState): void;
	assignDefenders(gameState: CommonGameState): void;
	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void;
	garrisonUnitsInside(gameState: CommonGameState, target: FakeEnt,
		data: { attacker: FakeEnt; min?: number; type?: string }): boolean;
	garrisonSiegeUnit(gameState: CommonGameState, unit: FakeEnt): boolean;
	garrisonAttackedUnit(gameState: CommonGameState, unit: FakeEnt, emergency?: boolean): boolean;
	GetCooperationLevel(ally: number): number;
	switchToAttack(gameState: CommonGameState, army: any): void;
	update(gameState: CommonGameState, events: EngineAIEvents): void;
	Serialize(): { properties: Record<string, unknown>; armies: Record<string, unknown>[] };
	Deserialize(gameState: CommonGameState, data: { properties: Record<string, unknown>; armies: Record<string, unknown>[] }): void;
};

/** damage-weighted attack strength: config weighs "Hack" at 0.075,
 * spread across the four damage types the config knows */
const hackOf = (strength: number) => 0.075 * strength / 4;

/** reads the diplomacy row the engine keeps, to name an ally per test */
function allyRow(world: World): { isAlly: boolean[]; isMutualAlly: boolean[]; isEnemy: boolean[] }
{
	return world.gameState.playerData as unknown as
		{ isAlly: boolean[]; isMutualAlly: boolean[]; isEnemy: boolean[] };
}

/** a raider: any attacking soldier the defense manager would spot */
function makeSoldier(id: number, position: [number, number], spec: {
	owner?: number;
	strength?: number;
	classes?: string[];
	methods?: Methods;
} = {}): FakeEnt
{
	return makeEntity({
		id, owner: spec.owner ?? ENEMY, position,
		classes: ["Unit", "Infantry", ...(spec.classes ?? [])]
	}, {
		attackTypes: () => ["Melee"],
		attackStrengths: () => ({ "Hack": spec.strength ?? 100 }),
		...spec.methods
	});
}

/** a structure, owned by whoever the scenario needs */
function makeStructure(id: number, position: [number, number], owner = GAIA,
	classes: string[] = ["Structure"], methods: Methods = {}): FakeEnt
{
	return makeEntity({ id, owner, position, classes }, methods);
}

/** the defender Petra calls up: a citizen soldier at home */
function makeDefender(id: number, position: [number, number] | undefined,
	methods: Methods = {}, metadata: Record<string, unknown> = {}): FakeEnt
{
	return makeEntity({
		id, owner: PLAYER, position, classes: ["Unit", "Infantry", "CitizenSoldier"]
	}, {
		attackTypes: () => ["Melee"],
		attackStrengths: () => ({ "Hack": 100 }),
		canAttackTarget: () => true,
		...methods
	}, metadata);
}

/** A manager wired to one world as headquarters owns it. */
function makeDefenseManager(world: World): DefenseManagerLike
{
	return new DefenseManager(world.ai.Config);
}

/** A manager that has run one quiet startup tick on an empty world, so it
 * holds the territory map, exactly as headquarters hands it over in game. */
function assembledWorld(): { world: World; manager: DefenseManagerLike }
{
	const world = makeWorld();
	const manager = makeDefenseManager(world);
	manager.update(world.gameState, emptyEvents());
	return { world, manager };
}

/** the turn's events as the engine raises them, with extras added */
function eventsWith(extra: Record<string, unknown[]>): EngineAIEvents
{
	const events = emptyEvents() as unknown as Record<string, unknown[]>;
	for (const key in extra)
		events[key] = extra[key];
	return events as unknown as EngineAIEvents;
}

/** a tracked enemy base for the target-list tests */
function makeWatchedBase(id = 4000): FakeEnt
{
	return makeStructure(id, [50, 50], ENEMY);
}

describe("watching the field", () =>
{
	it("flags the raider camping our homestead", () =>
	{
		const { world, manager } = assembledWorld();
		const raider = makeSoldier(2000, [30, 30]);
		world.addEntity(raider);

		assert.equal(manager.isDangerous(world.gameState, raider), true,
			"a melee raider twenty tiles from the civil centre is a threat");
		assert.equal(manager.armies.length, 0,
			"isDangerous only reads the field; the rota raises armies");
	});

	it("leaves the raider far out in empty grass", () =>
	{
		const { world, manager } = assembledWorld();
		const raider = makeSoldier(2000, [400, 400]);
		world.addEntity(raider);

		assert.equal(manager.isDangerous(world.gameState, raider), false,
			"nothing of ours lies within the raider's seventy-tile watch radius");
		assert.deepEqual(manager.attackingUnits[ENEMY][PLAYER], 1,
			"but the scout counts him among the enemies standing in our territory");
	});

	it("tracks the enemy builder raising a base on our frontier", () =>
	{
		const { world, manager } = assembledWorld();
		world.addEntity(makeStructure(4000, [55, 55], ENEMY, ["Structure", "CivCentre"],
			{ foundationProgress: () => 0 }));
		world.addEntity(makeStructure(4001, [70, 70], PLAYER, ["Structure"]));
		const builder = makeSoldier(2000, [60, 60], {
			methods: {
				unitAIState: () => "INDIVIDUAL.REPAIR.REPAIRING",
				unitAIOrderData: () => [{ "target": 4000 }]
			}
		});
		world.addEntity(builder);
		// the builder works in unclaimed ground between our camp and his base
		world.territory.set("60,60", 0);

		assert.equal(manager.isDangerous(world.gameState, builder), true,
			"an enemy base rising half a map from our forward camp must be stopped");
		assert.deepEqual(manager.targetList, [4000],
			"the new enemy base joins the targets headquarters remembers");
	});

	it("re-flags the builder whose base headquarters already tracks", () =>
	{
		const { world, manager } = assembledWorld();
		manager.targetList.push(4000);
		const builder = makeSoldier(2000, [60, 60], {
			methods: {
				unitAIState: () => "INDIVIDUAL.REPAIR.REPAIRING",
				unitAIOrderData: () => [{ "target": 4000 }]
			}
		});
		world.addEntity(builder);

		assert.equal(manager.isDangerous(world.gameState, builder), true,
			"a tracked building site is dangerous without a second look");
		assert.deepEqual(manager.targetList, [4000], "listed once, listed once");
	});

	it("watches a foe settle a frontier foundation near our rising town", () =>
	{
		const { world, manager } = assembledWorld();
		world.addEntity(makeStructure(4000, [55, 55], ENEMY, ["Structure", "CivCentre"],
			{ foundationProgress: () => 0 }));
		// our own settlement is being built out here as well
		world.addEntity(makeStructure(4001, [70, 70], PLAYER, ["Structure"],
			{ foundationProgress: () => 0.5 }));
		const builder = makeSoldier(2000, [80, 80], {
			methods: {
				unitAIState: () => "INDIVIDUAL.REPAIR.REPAIRING",
				unitAIOrderData: () => [{ "target": 4000 }]
			}
		});
		world.addEntity(builder);
		world.territory.set("80,80", 0);

		assert.equal(manager.isDangerous(world.gameState, builder), true,
			"an enemy civil centre within reach of our constructions is a threat");
		assert.deepEqual(manager.targetList, [4000]);
	});

	it("extends the watch radius for an archer near the tracked base", () =>
	{
		const { world, manager } = assembledWorld();
		world.addEntity(makeWatchedBase());
		manager.targetList.push(4000);
		userAddSoldier(world, 2000, [44, 40],
			{ classes: ["Ranged"], methods: { attackRange: () => ({ "max": 6 }) } });
		const archer = userEnt(world, 2000);
		assert.equal(manager.isDangerous(world.gameState, archer), true,
			"the archer is inside (6+30)² of the base we watch");
	});

	it("denies the raider deep in enemy country", () =>
	{
		const { world, manager } = assembledWorld();
		const raider = makeSoldier(2000, [90, 90]);
		world.addEntity(raider);
		world.territory.set("90,90", ENEMY);

		assert.equal(manager.isDangerous(world.gameState, raider), false,
			"a raider inside the enemy's own land is their problem");
	});

	it("ignores the wandering support worker", () =>
	{
		const { world, manager } = assembledWorld();
		const worker = makeEntity({
			id: 2000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Support", "Worker"]
		}, {
			attackTypes: () => ["Melee"]
		});
		world.addEntity(worker);

		assert.equal(manager.isDangerous(world.gameState, worker), false,
			"support classes are never counted as threats");
	});

	it("chases the foe toward the base we already watch", () =>
	{
		const { world, manager } = assembledWorld();
		world.addEntity(makeWatchedBase());
		manager.targetList.push(4000);
		const raider = makeSoldier(2000, [52, 52]);
		world.addEntity(raider);

		assert.equal(manager.isDangerous(world.gameState, raider), true,
			"any enemy fighter frolicking near a tracked base raises the alarm");
	});

	it("brings help for the built ally centre standing in contested ground", () =>
	{
		const { world, manager } = assembledWorld();
		allyRow(world).isAlly[3] = true;
		allyRow(world).isMutualAlly[3] = true;
		world.addEntity(makeEntity({
			id: 4000, owner: 3, position: [75, 75], classes: ["Structure", "CivCentre"]
		}));
		const raider = makeSoldier(2000, [70, 70]);
		world.addEntity(raider);
		world.territory.set("70,70", 0);

		assert.equal(manager.isDangerous(world.gameState, raider), true,
			"with normal cooperation a built ally centre still counts as ours to defend");
	});

	it("leaves a half-built ally centre alone under normal cooperation", () =>
	{
		const { world, manager } = assembledWorld();
		allyRow(world).isAlly[3] = true;
		allyRow(world).isMutualAlly[3] = true;
		world.addEntity(makeEntity({
			id: 4000, owner: 3, position: [75, 75], classes: ["Structure", "CivCentre"]
		}, { foundationProgress: () => 0.5 }));
		const raider = makeSoldier(2000, [70, 70]);
		world.addEntity(raider);
		world.territory.set("70,70", 0);

		assert.equal(manager.isDangerous(world.gameState, raider), false,
			"a foundation is not worth an expedition until the ally is pressed hard");
	});

	it("defends an ally's whole settled land once he is carved up", () =>
	{
		const { world, manager } = assembledWorld();
		allyRow(world).isAlly[3] = true;
		allyRow(world).isMutualAlly[3] = true;
		// three raids in the book: the memory the turn rota keeps
		manager.attackedAllies[3] = 3;
		world.addEntity(makeEntity({
			id: 4000, owner: 3, position: [75, 75], classes: ["Structure", "Barracks"]
		}));
		const raider = makeSoldier(2000, [70, 70]);
		world.addEntity(raider);
		world.territory.set("70,70", 3);

		assert.equal(manager.GetCooperationLevel(3) > 0.7, true,
			"three raids lift cooperation from 0.5 to 0.9");
		assert.equal(manager.isDangerous(world.gameState, raider), true,
			"a besieged ally's barracks are defended like our own");
	});

	it("ignores our own tower lost on a blinking border tile", () =>
	{
		const { world, manager } = assembledWorld();
		const tower = makeStructure(4000, [72, 72], PLAYER, ["Structure", "Tower"]);
		world.addEntity(tower);
		world.blinking.set("72,72", true);
		const raider = makeSoldier(2000, [70, 70]);
		world.addEntity(raider);
		world.territory.set("70,70", 0);

		assert.equal(manager.isDangerous(world.gameState, raider), false,
			"an undefendable building on shifting ground is not worth a skirmish");
	});
});

describe("the turn rota", () =>
{
	it("raises the recovery army for our fort bleeding capture points", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 1;
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 15, 10, 0]
		});
		world.addEntity(fort);
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1, "the capture-recovery scan raised one army");
		assert.equal(manager.armies[0].getType(), "capturing");
		assert.deepEqual(manager.armies[0].foeEntities, [5000],
			"the army must take the fort back");
		assert.equal(fort.getMetadata(PLAYER, "PartOfArmy"), manager.armies[0].ID,
			"the fort is registered as the army's sole foe");
	});

	it("leaves the fort that keeps most of its capture points", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 1;
		world.addEntity(makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 20, 1, 0]
		}));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0,
			"losing one point of twenty is below the quarter threshold");
	});

	it("never chases the decaying ruin we already gave up on", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 1;
		world.addEntity(makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			decaying: () => true,
			capturePoints: () => [0, 0, 25, 0]
		}));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0, "decaying structures are left to rot");
	});

	it("does not rescan for captures while an army is already up", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.ai.playedTurn = 2;
		const manager = makeDefenseManager(world);
		manager.update(world.gameState, emptyEvents());
		assert.equal(manager.armies.length, 1, "the raider raised the first army");

		world.addEntity(makeStructure(5000, [80, 80], PLAYER, ["Structure"], {
			capturePoints: () => [0, 0, 25, 0]
		}));
		world.ai.playedTurn = 4;	// next our-turn
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1,
			"the capture scan only runs while the roster is empty");
	});

	it("enlists the raider who marched into our land", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		const raider = makeSoldier(2000, [40, 40]);
		world.addEntity(raider);
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1, "the raider raised an army");
		assert.deepEqual(manager.armies[0].foeEntities, [2000]);
		assert.equal(raider.getMetadata(PLAYER, "PartOfArmy"), manager.armies[0].ID,
			"the raider knows he is being tracked");
	});

	it("does not re-enlist raiders that already march in an army", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		const raider = makeSoldier(2000, [40, 40]);
		world.addEntity(raider);
		raider.setMetadata(PLAYER, "PartOfArmy", 99);
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0,
			"an enlisted raider is somebody else's army's business");
	});

	it("never enlists the enemy ship or the trader to a defense army", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40], { classes: ["Ship"] }));
		world.addEntity(makeSoldier(2001, [41, 41], { classes: ["Trader"] }));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0,
			"ships and traders are skipped; fending them off is not this manager's work");
	});

	it("hunts the gaia beast that mauled our villager", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 0;
		world.addEntity(makeEntity({
			id: 3000, owner: PLAYER, position: [31, 30], classes: ["Unit", "Support", "Worker"]
		}));
		const beast = makeSoldier(2000, [30, 30], {
			owner: GAIA, classes: ["Animal"], methods: {
				unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
				unitAIOrderData: () => [{ "target": 3000 }]
			}
		});
		world.addEntity(beast);
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1, "a beast in combat against us raised an army");
		assert.deepEqual(manager.armies[0].foeEntities, [2000],
			"the beast is the army's foe");
	});

	it("leaves the gaia beast grazing in peace", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 0;
		world.addEntity(makeSoldier(2000, [30, 30], {
			owner: GAIA, classes: ["Animal"], methods: {
				unitAIState: () => "INDIVIDUAL.IDLE",
				unitAIOrderData: () => []
			}
		}));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0, "an idle beast is left to graze");
	});

	it("raises a capture army against the gaia ruin that shoots back", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 0;
		world.addEntity(makeStructure(5000, [50, 50], GAIA, ["Structure"], {
			hasDefensiveFire: () => true
		}));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1, "the ruin raised a capturing army");
		assert.equal(manager.armies[0].getType(), "capturing");
	});

	it("leaves the harmless gaia ruin standing in our territory", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 0;
		world.addEntity(makeStructure(5000, [50, 50], GAIA, ["Structure"]));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0,
			"a ruin without capture points or defensive fire is harmless");
	});

	it("waits for a thin roster before chasing gaia ruins", () =>
	{
		const world = makeWorld();
		// two raiders near home yet apart beyond the compacting size raise two armies
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [12, 80]));
		world.addEntity(makeStructure(5000, [50, 50], GAIA, ["Structure"], {
			hasDefensiveFire: () => true
		}));
		const manager = makeDefenseManager(world);
		manager.update(world.gameState, emptyEvents());
		assert.equal(manager.armies.length, 2, "two separated raiders, two armies");

		world.ai.playedTurn = 3;	// next gaia turn
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 2,
			"two armies up means the ruin scan never starts");
	});

	it("sends one recovery army a turn even when two forts bleed", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 1;
		world.addEntity(makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 0, 25, 0]
		}));
		world.addEntity(makeStructure(5001, [62, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 0, 25, 0]
		}));
		const manager = makeDefenseManager(world);

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1,
			"the scan breaks after the first recovering structure");
	});
});

/** adds a soldier of the given player, as the field tests need */
function userAddSoldier(world: World, id: number, position: [number, number],
	spec: { classes?: string[]; methods?: Methods } = {}, owner = ENEMY): FakeEnt
{
	const ent = makeSoldier(id, position, { classes: spec.classes, methods: spec.methods, owner });
	world.addEntity(ent);
	return ent;
}

/** the registered entity, plainly */
function userEnt(world: World, id: number): FakeEnt
{
	const ent = world.ents.get(id);
	assert.ok(ent, `entity ${id} must exist`);
	return ent;
}

/** the army under its roster id, plainly */
function userArmy(manager: DefenseManagerLike, id: number): any
{
	const army = manager.getArmy(id);
	assert.ok(army, `army ${id} must exist`);
	return army;
}

/** a manager holding one army around a lone raider, raised the way the
 * rota raises it: an enemy's turn with the raider inside our land */
function raidedWorld(foePos: [number, number] = [40, 40]): {
	world: World; manager: DefenseManagerLike; army: any; raider: FakeEnt;
}
{
	const world = makeWorld();
	world.ai.playedTurn = 2;
	const raider = makeSoldier(2000, foePos);
	world.addEntity(raider);
	const manager = makeDefenseManager(world);
	manager.update(world.gameState, emptyEvents());
	return { world, manager, army: manager.armies[0], raider };
}

describe("keeping the roster", () =>
{
	it("drops the army whose raiders are all gone", () =>
	{
		const { world, manager, raider } = raidedWorld();

		// the raid fell, as it does once our towers have done their work
		world.removeEntity(raider.id());
		world.ai.playedTurn = 3;
		manager.update(world.gameState, eventsWith({ "Destroy": [{ "entity": raider.id() }] }));

		assert.equal(manager.armies.length, 0, "an army without a foe is dissolved");
		assert.equal(world.switchCalls.length, 0,
			"and nothing was left to convert into an attack");
	});

	it("drops the army that crawled back into the raider's homeland", () =>
	{
		const { world, manager } = raidedWorld();
		world.territory.set("40,40", ENEMY);
		world.ai.playedTurn = 5;	// the five-day sweep
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 0,
			"an army standing on enemy ground at home is no raid of ours");
		assert.equal(userEnt(world, 2000).getMetadata(PLAYER, "PartOfArmy"), undefined,
			"the raider was released from the book");
	});

	it("keeps the army lingering by our gates on unclaimed ground", () =>
	{
		const { world, manager } = raidedWorld();
		world.territory.set("40,40", 0);
		world.ai.playedTurn = 5;
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1,
			"still one civil-centre's walk from the raid, the watch holds");
		assert.equal(world.switchCalls.length, 0,
			"a dangerous army is watched, not converted");
	});

	it("keeps the army one of our oversea docks watches", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [200, 5]));
		world.addEntity(makeStructure(4000, [205, 5], PLAYER, ["Structure", "Dock"]));
		const manager = makeDefenseManager(world);
		manager.makeIntoArmy(world.gameState, 2000);
		world.territory.set("200,5", 0);
		world.ai.playedTurn = 5;
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1,
			"the dock watch keeps the raid in reach of the oversea base");
	});

	it("merges the armies once the raid camps converge", () =>
	{
		const world = makeWorld();
		const raiderA = makeSoldier(2000, [40, 40]);
		const raiderB = makeSoldier(2001, [200, 200]);
		world.addEntity(raiderA);
		world.addEntity(raiderB);
		const manager = makeDefenseManager(world);
		// two camps far apart, so the rota kept two armies
		manager.makeIntoArmy(world.gameState, 2000);
		manager.makeIntoArmy(world.gameState, 2001);

		// both camps drift toward our town
		raiderA.position = () => [195, 198];
		raiderB.position = () => [198, 200];
		world.ai.elapsedTime = 110;	// the cadence lets armies re-aim
		world.ai.playedTurn = 5;	// the sweep that re-aims and merges
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1, "one merged army now");
		assert.deepEqual(manager.armies[0].foeEntities.sort(), [2000, 2001]);
	});

	it("never merges the capture army with a punitive one beside it", () =>
	{
		const world = makeWorld();
		world.addEntity(makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 15, 10, 0]
		}));
		world.addEntity(makeSoldier(2000, [61, 60]));
		const manager = makeDefenseManager(world);
		manager.makeIntoArmy(world.gameState, 5000, "capturing");
		manager.makeIntoArmy(world.gameState, 2000);
		world.ai.playedTurn = 2;
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 2, "both armies kept");
		assert.deepEqual(manager.armies.map((army) => army.getType()).sort(), ["capturing", "default"],
			"a capture army recovers our fort, a punitive one hunts the raider");
	});

	it("cuts off the wanderer who strayed beyond the raid party", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [41, 40]));
		world.addEntity(makeSoldier(2002, [40, 41]));
		const manager = makeDefenseManager(world);
		manager.update(world.gameState, emptyEvents());
		assert.equal(manager.armies.length, 1, "one raid party of three");

		// the wanderer took his own road mid-raid
		const wanderer = userEnt(world, 2001);
		wanderer.position = () => [160, 40];
		world.ai.elapsedTime = 115;	// past the five-second cadence
		world.ai.playedTurn = 7;
		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 2, "the wanderer became his own army");
		assert.deepEqual(userEnt(world, 2000).getMetadata(PLAYER, "PartOfArmy"),
			userEnt(world, 2002).getMetadata(PLAYER, "PartOfArmy"),
			"the mass still shares one army");
		assert.notEqual(userEnt(world, 2001).getMetadata(PLAYER, "PartOfArmy"),
			userEnt(world, 2000).getMetadata(PLAYER, "PartOfArmy"),
			"the wanderer broke from the book");
	});

	it("writes two sieges from two enemies into the cooperation book", () =>
	{
		// the book counts how many different enemies raid the same ally
		const world = makeWorld();
		allyRow(world).isAlly[3] = true;
		allyRow(world).isMutualAlly[3] = true;
		// the harness deals the neutral diplomacy: this scene declares the ally
		allyRow(world).isEnemy[3] = false;
		world.addEntity(makeSoldier(2000, [50, 50]));
		world.addEntity(makeSoldier(2001, [160, 160], { owner: GAIA }));
		const manager = makeDefenseManager(world);
		// one enemy camp and one gaia beast horde inside the ally's land,
		// as when a raid splits up and beasts follow the war trail
		manager.makeIntoArmy(world.gameState, 2000);
		manager.makeIntoArmy(world.gameState, 2001);
		world.territory.set("50,50", 3);
		world.territory.set("160,160", 3);
		world.ai.playedTurn = 5;
		manager.update(world.gameState, emptyEvents());

		assert.deepEqual(manager.attackingArmies[ENEMY][3], 1,
			"the raid camp stands in the ally's territory");
		assert.deepEqual(manager.attackingArmies[GAIA][3], 1,
			"the beast horde stands there too");

		world.ai.playedTurn = 10;	// the next sweep turns books into memory
		manager.update(world.gameState, emptyEvents());
		assert.equal(manager.attackedAllies[3], 2,
			"two enemies raiding one ally went into the memory");
		assert.equal(manager.GetCooperationLevel(3), 0.5 + 0.2,
			"and lifted cooperation for him");
	});
});

describe("calling the defenders", () =>
{
	function attackRecorder(): {
		calls: number[];
		make: (id: number, pos: [number, number] | undefined, methods?: Methods,
			metadata?: Record<string, unknown>) => FakeEnt;
	}
	{
		const calls: number[] = [];
		return {
			calls,
			make: (id, pos, methods, metadata) => makeDefender(id, pos, {
				attack: (target: number) => { calls.push(target); },
				...methods
			}, metadata)
		};
	}

	it("follows six swordsmen onto one raider and holds two in the wings", () =>
	{
		// eight swordsmen around a Hack-400 raider: need is exactly met, but
		// above five on a plain foe the army gives no further attack orders
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40], { strength: 400 }));
		const manager = makeDefenseManager(world);
		const { calls, make } = attackRecorder();
		for (let i = 0; i < 8; ++i)
			world.addEntity(make(3000 + i, [20, 20]));

		manager.update(world.gameState, emptyEvents());

		assert.equal(manager.armies.length, 1);
		const army = manager.armies[0];
		for (let i = 0; i < 8; ++i)
		{
			const def = userEnt(world, 3000 + i);
			assert.equal(def.getMetadata(PLAYER, "PartOfArmy"), army.ID,
				`defender ${3000 + i} marched with the army`);
			assert.equal(def.getMetadata(PLAYER, "subrole"), "defender",
				"and took the defender work");
		}
		assert.deepEqual(calls, Array(6).fill(2000),
			"six take aim; a plain raider only wants five attackers");
		assert.equal(world.emergencyCalls.length, 0, "the need was met at home");
	});

	it("holds the first twelve back from a far ally rescue", () =>
	{
		const world = makeWorld();
		allyRow(world).isAlly[3] = true;
		allyRow(world).isMutualAlly[3] = true;
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [200, 200]));
		const manager = makeDefenseManager(world);
		// the raid was enlisted the way an attack on the ally enlists it
		manager.makeIntoArmy(world.gameState, 2000);
		const { calls, make } = attackRecorder();
		for (let i = 0; i < 13; ++i)
			world.addEntity(make(3000 + i, [20, 20]));
		world.territory.set("200,200", 3);

		manager.update(world.gameState, emptyEvents());

		assert.equal(calls.length, 1, "only the thirteenth swordsman marched");
		assert.equal(userEnt(world, 3012).getMetadata(PLAYER, "PartOfArmy"), manager.armies[0].ID,
			"the thirteenth joined the rescue");
		for (let i = 0; i < 12; ++i)
			assert.equal(userEnt(world, 3000 + i).getMetadata(PLAYER, "PartOfArmy"), undefined,
				`the ${i + 1}. swordsman stayed home in reserve`);
		assert.equal(world.emergencyCalls.length, 1,
			"and HQ was asked to train the rest at home");
		assert.deepEqual(world.emergencyCalls[0][1], [manager.armies[0].foePosition],
			"for these raid positions");
	});

	it("ferries the thirteenth defender whose only road runs over water", () =>
	{
		// the two passes strike the first twelve stranded swordsmen as
		// reserve, so the ferry only ever reaches the thirteenth
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [150, 150]));
		const manager = makeDefenseManager(world);
		// enlisted the way an attack event in an ally's land enlists it
		manager.makeIntoArmy(world.gameState, 2000);
		// the raid stands on another island; our warband on its own isle too
		world.accessAt.set("150,150", 3);
		world.accessAt.set("20,20", 5);
		const { calls, make } = attackRecorder();
		for (let i = 0; i < 13; ++i)
			world.addEntity(make(3000 + i, [20, 20]));
		world.territory.set("150,150", 3);

		manager.update(world.gameState, emptyEvents());

		assert.equal(calls.length, 0, "he was not ordered to attack straight away");
		assert.equal(userEnt(world, 3012).getMetadata(PLAYER, "PartOfArmy"), manager.armies[0].ID,
			"only the thirteenth swordsman was ferried to the raid");
		for (let i = 0; i < 12; ++i)
			assert.equal(userEnt(world, 3000 + i).getMetadata(PLAYER, "PartOfArmy"), undefined,
				`the ${i + 1}. stranded swordsman stayed in reserve`);
		assert.equal(world.transportCalls.length, 1, "a ferry was asked for him");
		assert.equal(world.emergencyCalls.length, 1,
			"and the remaining shortage went to the trainers");
	});

	it("skips support hands, transportees, plan-walkers and heroes", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40], { strength: 400 }));
		const manager = makeDefenseManager(world);
		const { calls, make } = attackRecorder();
		world.addEntity(make(3000, [20, 20]));	// the one honest defender
		world.addEntity(makeEntity({
			id: 3001, owner: PLAYER, position: [20, 20], classes: ["Unit", "Support", "Worker"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(make(3002, [20, 20], {}, { "transport": 7 }));
		world.addEntity(make(3003, [20, 20], {}, { "plan": -3 }));
		world.addEntity(make(3004, [20, 20], {}, { "plan": 1, "subrole": "attacking" }));
		world.addEntity(make(3005, [20, 20], {}, { "plan": -1 }));
		world.addEntity(make(3006, [20, 20]));
		world.ai.HQ.victoryManager.criticalEnts.set(3006, true);
		world.addEntity(makeEntity({
			id: 3007, owner: PLAYER, position: [20, 20], classes: ["Unit", "StoneThrower"]
		}, { attackTypes: () => ["Melee"] }));

		manager.update(world.gameState, emptyEvents());
		const enlisted = [3000, 3005].map((id) =>
			userEnt(world, id).getMetadata(PLAYER, "PartOfArmy") === manager.armies[0].ID);
		assert.deepEqual(enlisted, [true, true],
			"the honest defender and the released -1 volunteer only");
		for (const id of [3001, 3002, 3003, 3004, 3006, 3007])
			assert.equal(userEnt(world, id).getMetadata(PLAYER, "PartOfArmy"), undefined,
				`defender ${id} was left to his work`);
		assert.equal(world.emergencyCalls.length, 1,
			"support hands and heroes count as no defenders at all");
	});

	it("keeps the shooters that cannot hurt the raid party in reserve", () =>
	{
		const world = makeWorld();
		world.ai.playedTurn = 2;
		world.addEntity(makeSoldier(2000, [40, 40], { strength: 400 }));
		const manager = makeDefenseManager(world);
		const { calls, make } = attackRecorder();
		world.addEntity(make(3000, [20, 20], { canAttackTarget: () => false }));

		manager.update(world.gameState, emptyEvents());

		assert.equal(userEnt(world, 3000).getMetadata(PLAYER, "PartOfArmy"), undefined,
			"who cannot shoot the raider cannot march");
		assert.equal(world.emergencyCalls.length, 1,
			"and the shortage was handed to the trainers");
	});
});


describe("when our own are hit", () =>
{
	it("takes our own archers into the tower that opens fire", () =>
	{
		const { world, manager } = assembledWorld();
		const tower = makeStructure(5000, [30, 30], PLAYER, ["Structure", "Tower"], {
			isGarrisonHolder: () => true,
			getArrowMultiplier: () => 1,
			attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 33 }),
			garrisonMax: () => 10
		});
		tower.setMetadata(PLAYER, "base", 1);
		world.addEntity(tower);
		world.addEntity(makeSoldier(2000, [40, 40]));

		const calls: number[] = [];
		for (let i = 0; i < 2; ++i)
		{
			const archer = makeEntity({ id: 3000 + i, owner: PLAYER, position: [20, 20],
				classes: ["Unit", "Infantry"] }, { attackTypes: () => ["Ranged"] });
			world.addEntity(archer);
		}

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 2000, "attacker": 5000 }]
		}));

		assert.equal(world.garrisonCalls.length, 2, "both idle archers garrisoned");
		assert.deepEqual(world.garrisonCalls.map(([unit, target]) => [unit.id(), target.id()]),
			[[3000, 5000], [3001, 5000]]);
		assert.deepEqual(Array.from(world.garrisonCounts.keys()), [5000],
			"the tower fills its slots");
	});

	it("hands the fight over to the started plan that a swordsman serves", () =>
	{
		const { world, manager } = assembledWorld();
		// one of ours already marched off with an attack plan and got hit; the
		// plan may keep him and the office stays out of the quarrel
		const hunter = makeDefender(3000, [20, 20], {
			attack: () => { assert.fail("the plan owns him"); }
		}, { "plan": 5 });
		world.addEntity(hunter);
		const raider = makeSoldier(2000, [21, 21]);
		world.addEntity(raider);
		world.ai.HQ.attackManager.getPlan = (plan: number) =>
			plan == 5 ? { "state": "started", "removeUnit": () => undefined } as never : undefined;

		const events = eventsWith({ "Attacked": [{ "target": 3000, "attacker": 2000 }] });
		// an extra enlistment check: the raider stays unlisted while the plan owns the fight on our side
		manager.checkEvents(world.gameState, events);

		assert.equal(manager.armies.length, 0,
			"the plan runs the whole fight: the office raises no army");
	});

	it("lets an idle swordsman answer the blow", () =>
	{
		const { world, manager } = assembledWorld();
		const calls: number[] = [];
		world.addEntity(makeDefender(3000, [20, 20], {
			attack: (target) => { calls.push(target); }
		}));
		world.addEntity(makeSoldier(2000, [21, 21]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		assert.deepEqual(calls, [2000], "the swordsman struck back at once");
	});

	it("leaves a swordsman busy in honest combat to his foe", () =>
	{
		const { world, manager } = assembledWorld();
		const calls: number[] = [];
		world.addEntity(makeDefender(3000, [20, 20], {
			attack: (target) => { calls.push(target); },
			unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
			unitAIOrderData: () => [{ "target": 2000 }]
		}));
		world.addEntity(makeSoldier(2000, [21, 21]));

		const events = eventsWith({ "Attacked": [{ "target": 3000, "attacker": 2000 }] });
		const raider = userEnt(world, 2000) as FakeEnt;
		// the raider at the same spot: retaliation would reorder the whole fight
		manager.checkEvents(world.gameState, events);
		assert.equal(calls.length, 0, "the ongoing duel was left alone");
	});

	it("leaves a mason repairing our arrow tower alone", () =>
	{
		const { world, manager } = assembledWorld();
		const calls: number[] = [];
		const tower = makeStructure(5000, [30, 30], PLAYER, ["Structure", "Tower"], {
			hasDefensiveFire: () => true
		});
		tower.setMetadata(PLAYER, "base", 1);
		world.addEntity(tower);
		world.addEntity(makeDefender(3000, [28, 30], {
			attack: (target) => { calls.push(target); },
			unitAIState: () => "INDIVIDUAL.REPAIR.REPAIRING",
			unitAIOrderData: () => [{ "target": 5000 }]
		}));
		world.addEntity(makeSoldier(2000, [35, 30]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		assert.equal(calls.length, 0, "the repair kept him from the duel");
	});

	it("hands a duelling mate over to the raider at our captured citadel", () =>
	{
		const { world, manager } = assembledWorld();
		const citadel = makeStructure(5000, [60, 60], PLAYER, ["Structure"]);
		world.addEntity(citadel);
		world.ai.HQ.capturableTargets.set(5000, { "ents": new Set([3000, 3001]) });
		const mateCalls: number[] = [];
		world.addEntity(makeDefender(3000, [70, 60], {
			unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
			unitAIOrderData: () => [{ "target": 5000 }]
		}));
		world.addEntity(makeDefender(3001, [71, 60], {
			attack: (target) => { mateCalls.push(target); },
			unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
			unitAIOrderData: () => [{ "target": 5000 }]
		}));
		world.addEntity(makeSoldier(2000, [72, 60]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		const targets = world.ai.HQ.capturableTargets.get(5000) as unknown as { ents: Set<number> };
		assert.equal(targets.ents.has(3000), false,
			"the struck dueller left the capture crew");
		assert.equal(targets.ents.has(3001), false,
			"so did the free mate who took his post at the raider");
		assert.deepEqual(mateCalls, [2000], "the mate was thrown at the raider");
	});

	it("burns the poisoned tower on blinking ground we cannot hold", () =>
	{
		const { world, manager } = assembledWorld();
		const destroyCalls: number[] = [];
		const ruin = makeStructure(5000, [30, 30], PLAYER, ["Structure"], {
			capturePoints: () => [5, 30, 10, 5],
			destroy: () => { destroyCalls.push(5000); }
		});
		ruin.setMetadata(PLAYER, "base", 9);	// a base that no longer exists
		world.addEntity(ruin);
		world.blinking.set("30,30", true);
		world.addEntity(makeDefender(3000, [30, 31]));
		world.addEntity(makeSoldier(2000, [31, 30]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 5000, "attacker": 2000 }]
		}));

		assert.deepEqual(destroyCalls, [5000],
			"a half-lost indefendable tower on decaying tiles is pulled down");
		assert.equal(manager.armies.length, 0,
			"the pull-down removes the quarrel with the raider too");
	});

	it("keeps the tower we can still defend and enlists the raider", () =>
	{
		const { world, manager } = assembledWorld();
		const destroyCalls: number[] = [];
		const keep = makeStructure(5000, [30, 30], PLAYER, ["Structure"], {
			capturePoints: () => [5, 30, 10, 5],
			destroy: () => { destroyCalls.push(5000); }
		});
		keep.setMetadata(PLAYER, "base", 1);
		world.addEntity(keep);
		world.blinking.set("30,30", true);
		world.ai.HQ.isDefendable = () => true;
		world.addEntity(makeDefender(3000, [30, 31]));
		world.addEntity(makeSoldier(2000, [31, 30]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 5000, "attacker": 2000 }]
		}));

		assert.deepEqual(destroyCalls, [], "a defendable tower stands");
		assert.equal(manager.armies.length, 1, "the raider was enlisted");
	});

	it("sends the hunters for the civil centre seized from an ally", () =>
	{
		const { world, manager } = assembledWorld();
		allyRow(world).isMutualAlly[3] = true;
		const centre = makeStructure(5000, [60, 60], ENEMY, ["Structure", "CivCentre"]);
		world.addEntity(centre);

		manager.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 5000, "from": 3, "to": 2 }]
		}));

		assert.equal(world.switchCalls.length, 1, "one order went to the attack office");
		assert.deepEqual(world.switchCalls[0][1], { "range": 150 },
			"the hunters go for the seized centre itself");
	});

	it("enlists the raider who struck from unclaimed ground but not from his homeland", () =>
	{
		const { world, manager } = assembledWorld();
		world.addEntity(makeDefender(3000, [20, 20]));
		const raider = makeSoldier(2000, [21, 21]);
		world.addEntity(raider);
		world.addEntity(makeSoldier(2001, [90, 90]));
		world.territory.set("90,90", ENEMY);

		const events = eventsWith({
			"Attacked": [
				{ "target": 3000, "attacker": 2000 },
				{ "target": 3000, "attacker": 2001 }
			]
		});
		manager.checkEvents(world.gameState, events);

		assert.equal(manager.armies.length, 1, "only the border raider was enlisted");
		assert.deepEqual(manager.armies[0].foeEntities, [2000]);
		assert.equal(raider.getMetadata(PLAYER, "PartOfArmy"), manager.armies[0].ID);
		assert.equal(userEnt(world, 2001).getMetadata(PLAYER, "PartOfArmy"), undefined,
			"a raider striking from his own homeland is hunted past frontier fights anyway");
	});

	it("sails the idle fishing boat out of the warship's reach", () =>
	{
		const { world, manager } = assembledWorld();
		const fleeWalks: number[][] = [];
		const boat = makeEntity({
			id: 3000, owner: PLAYER, position: [50, 50],
			classes: ["Unit", "Ship", "FishingBoat"]
		}, {
			isIdle: () => true,
			moveToRange: (x: number, z: number) => { fleeWalks.push([x, z]); }
		});
		world.addEntity(boat);
		const raider = makeSoldier(2000, [51, 50], {
			classes: ["Ship"], methods: { attackRange: () => ({ "max": 33 }) }
		});
		world.addEntity(raider);

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		assert.deepEqual(fleeWalks, [[51, 50]], "the boat was ordered to the safe rim");
	});

	it("disbands the capture army so its men can defend themselves", () =>
	{
		const { world, manager } = assembledWorld();
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [5, 20, 5, 0]
		});
		world.addEntity(fort);
		manager.makeIntoArmy(world.gameState, 5000, "capturing");
		const capturingID = fort.getMetadata(PLAYER, "PartOfArmy") as number;
		world.addEntity(makeSoldier(2000, [61, 60]));
		const soldier = makeDefender(3001, [59, 60]);
		// the recovery army had a swordsman of its own inside the fort
		soldier.setMetadata(PLAYER, "PartOfArmy", capturingID);
		world.addEntity(soldier);
		const capturing = userArmy(manager, capturingID);
		capturing.ownEntities.push(3001);

		const events = eventsWith({ "Attacked": [{ "target": 3001, "attacker": 2000 }] });
		manager.checkEvents(world.gameState, events);

		assert.equal(manager.armies.length, 1,
			"the recovery army stands down, leaving only the freshly enlisted raider");
		assert.equal(soldier.getMetadata(PLAYER, "PartOfArmy"), undefined,
			"the soldier was released from the book");
	});

	it("stands a recapture down once the fort is ours again", () =>
	{
		const { world, manager } = assembledWorld();
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 25, 0, 0]
		});
		fort.setMetadata(PLAYER, "base", 1);
		world.addEntity(fort);
		manager.makeIntoArmy(world.gameState, 5000, "capturing");

		const events = eventsWith({ "Attacked": [{ "target": 5000, "attacker": 2000 }] });
		world.addEntity(makeSoldier(2000, [61, 60]));
		manager.checkEvents(world.gameState, events);

		assert.equal(manager.armies.length, 1,
			"the recovery army stood down, leaving only the freshly enlisted raider");
		assert.equal(manager.getArmy(manager.armies[0].ID) !== undefined, true,
			"that raider army is the freshly enlisted one");
		assert.equal(fort.getMetadata(PLAYER, "PartOfArmy"), undefined,
			"the fort was released from the book");
	});

	it("lets the recapture run while the enemy still drains points", () =>
	{
		const { world, manager } = assembledWorld();
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [5, 20, 5, 0]
		});
		fort.setMetadata(PLAYER, "base", 1);
		world.addEntity(fort);
		manager.makeIntoArmy(world.gameState, 5000, "capturing");

		const events = eventsWith({ "Attacked": [{ "target": 5000, "attacker": 2000 }] });
		world.addEntity(makeSoldier(2000, [61, 60]));
		manager.checkEvents(world.gameState, events);

		assert.equal(manager.armies.length, 2,
			"the recovery army stays up beside the freshly enlisted raider");
		assert.ok(manager.armies.some((army) => army.getType() == "capturing" &&
			army.foeEntities[0] == 5000), "the enemy still holds points; keep pushing");
	});

	it("shelters a bleeding villager in the nearest healing house", () =>
	{
		const { world, manager } = assembledWorld();
		const hospital = makeStructure(5000, [70, 70], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 10,
			buffHeal: () => 8
		});
		hospital.setMetadata(PLAYER, "base", 1);
		world.addEntity(hospital);
		const shelter = makeStructure(5001, [30, 30], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"]
		});
		shelter.setMetadata(PLAYER, "base", 1);
		world.addEntity(shelter);
		world.addEntity(makeEntity({
			id: 3000, owner: PLAYER, position: [40, 40], classes: ["Unit", "Support", "Worker"]
		}, { healthLevel: () => 0.4 }));
		world.addEntity(makeSoldier(2000, [41, 40]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		assert.deepEqual(world.garrisonCalls.map(([unit, target, type]) => [unit.id(), target.id(), type]),
			[[3000, 5000, GarrisonManager.TYPE_PROTECTION]],
			"the farther healing house was taken, not the closer mere shelter");
	});

	it("sends a spent stone thrower into the nearest fortress", () =>
	{
		const { world, manager } = assembledWorld();
		const fortress = makeStructure(5000, [60, 60], PLAYER, ["Structure", "Fortress"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["StoneThrower"],
			garrisonMax: () => 4
		});
		fortress.setMetadata(PLAYER, "base", 1);
		world.addEntity(fortress);
		world.addEntity(makeEntity({
			id: 3000, owner: PLAYER, position: [40, 40],
			classes: ["Unit", "Siege", "StoneThrower"]
		}, { attackTypes: () => ["Ranged"] }));
		world.addEntity(makeSoldier(2000, [41, 40]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 3000, "attacker": 2000 }]
		}));

		assert.deepEqual(world.garrisonCalls.map(([unit, target, type]) => [unit.id(), target.id(), type]),
			[[3000, 5000, GarrisonManager.TYPE_PROTECTION]]);
	});

	it("gathers archers into our tower standing under fire", () =>
	{
		const { world, manager } = assembledWorld();
		const tower = makeStructure(5000, [30, 30], PLAYER, ["Structure", "Tower"], {
			isGarrisonHolder: () => true,
			getArrowMultiplier: () => 1,
			attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 33 }),
			garrisonMax: () => 10
		});
		tower.setMetadata(PLAYER, "base", 1);
		world.addEntity(tower);
		world.addEntity(makeEntity({
			id: 3000, owner: PLAYER, position: [20, 20], classes: ["Unit", "Infantry"]
		}, { attackTypes: () => ["Ranged"] }));
		world.addEntity(makeSoldier(2000, [40, 40]));

		manager.checkEvents(world.gameState, eventsWith({
			"Attacked": [{ "target": 5000, "attacker": 2000 }]
		}));

		assert.deepEqual(world.garrisonCalls.map(([unit, target, type]) => [unit.id(), target.id(), type]),
			[[3000, 5000, GarrisonManager.TYPE_PROTECTION]],
			"the archer went up while the tower took arrows");
	});
});

describe("garrisoning by hand", () =>
{
	function towerWorld(overrides: Methods = {}): { world: World; manager: DefenseManagerLike; tower: FakeEnt }
	{
		const { world, manager } = assembledWorld();
		const tower = makeStructure(5000, [30, 30], PLAYER, ["Structure", "Tower"], {
			isGarrisonHolder: () => true,
			getArrowMultiplier: () => 1,
			attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 33 }),
			garrisonMax: () => 5,
			...overrides
		});
		world.addEntity(tower);
		world.addEntity(makeSoldier(2000, [40, 40]));	// the raider in bowshot
		return { world, manager, tower };
	}

	function archer(id: number, attackTypes: string[], metadata: Record<string, unknown> = {}): FakeEnt
	{
		return makeEntity({ id, owner: PLAYER, position: [20, 20], classes: ["Unit", "Infantry"] },
			{ attackTypes: () => attackTypes }, metadata);
	}

	it("takes the archers nearest by through the open slots", () =>
	{
		const { world, manager, tower } = towerWorld();
		world.addEntity(archer(3000, ["Ranged"]));
		world.addEntity(archer(3001, ["Melee"]));

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000) }), true, "someone went up");
		assert.deepEqual(world.garrisonCalls.map(([unit]) => unit.id()), [3000, 3001],
			"nearest first, melee allowed because the raider is a plain soldier");
	});

	it("stops when the slots run out", () =>
	{
		const { world, manager, tower } = towerWorld();
		world.addEntity(archer(3000, ["Ranged"]));
		world.garrisonCounts.set(5000, 5);

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000) }), false,
			"the tower is full");
		assert.equal(world.garrisonCalls.length, 0, "nobody was ordered up");
	});

	it("refuses a tower too damaged to hold the door", () =>
	{
		const { world, manager, tower } = towerWorld({ hitpoints: () => 50 });	// under the 0.7 eject health

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000) }), false,
			"it would immediately fling its men out again");
		assert.equal(world.garrisonCalls.length, 0);
	});

	it("ignores raiders beyond bowshot", () =>
	{
		const { world, manager, tower } = towerWorld();
		const farRaider = makeSoldier(2001, [80, 80]);
		world.addEntity(farRaider);

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": farRaider }), false, "out of arrow range means no garrison");
	});

	it("keeps melee fighters down when the office says so", () =>
	{
		const { world, manager, tower } = towerWorld();
		world.ai.HQ.garrisonManager.allowMelee = () => false;
		world.addEntity(archer(3000, ["Ranged"]));
		world.addEntity(archer(3001, ["Melee"]));

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000) }), true, "a ranged fighter went up");
		assert.deepEqual(world.garrisonCalls.map(([unit]) => unit.id()), [3000],
			"the melee fighter stays down");
	});

	it("lets plan hands finish their hunt before entering the decay", () =>
	{
		const { world, manager, tower } = towerWorld();
		world.addEntity(archer(3000, ["Ranged"], { "plan": 1, "subrole": "attacking" }));

		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000) }), false,
			"a plan hand with a fighting job is not pulled out");

		const removed: number[] = [];
		const planStub = { "state": "started", "removeUnit": (ent: FakeEnt) => { removed.push(ent.id()); } };
		world.ai.HQ.attackManager.getPlan = (plan: number) => plan == 1 ? planStub as never : undefined;
		// the tower is a captured decay-prone one: it takes even plan hands
		assert.equal(manager.garrisonUnitsInside(world.gameState, tower,
			{ "attacker": userEnt(world, 2000), "type": GarrisonManager.TYPE_DECAY }), true,
			"a decay tower takes even plan hands");
		assert.deepEqual(removed, [3000], "the plan was told to release him");
		assert.deepEqual(world.garrisonCalls.map(([unit]) => unit.id()), [3000]);
	});

	it("walks the wounded ramm into the nearest fortress that takes it", () =>
	{
		const { world, manager } = assembledWorld();
		const ram = makeEntity({
			id: 3000, owner: PLAYER, position: [30, 30], classes: ["Unit", "Siege", "StoneThrower"]
		}, { attackTypes: () => ["Ranged"] });
		world.addEntity(ram);
		const far = makeStructure(5000, [70, 70], PLAYER, ["Structure", "Fortress"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["StoneThrower"],
			garrisonMax: () => 4
		});
		far.setMetadata(PLAYER, "base", 1);
		world.addEntity(far);
		const near = makeStructure(5001, [40, 40], PLAYER, ["Structure", "Fortress"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["StoneThrower"],
			garrisonMax: () => 4
		});
		near.setMetadata(PLAYER, "base", 1);
		world.addEntity(near);

		assert.equal(manager.garrisonSiegeUnit(world.gameState, ram), true);
		assert.deepEqual(world.garrisonCalls.map(([unit, target]) => [unit.id(), target.id()]),
			[[3000, 5001]], "the nearer fortress took the ramm");
	});

	it("refuses a full fortress", () =>
	{
		const { world, manager } = assembledWorld();
		const ram = makeEntity({
			id: 3000, owner: PLAYER, position: [30, 30], classes: ["Unit", "Siege", "StoneThrower"]
		}, { attackTypes: () => ["Ranged"] });
		world.addEntity(ram);
		const fortress = makeStructure(5000, [40, 40], PLAYER, ["Structure", "Fortress"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["StoneThrower"],
			garrisonMax: () => 4
		});
		fortress.setMetadata(PLAYER, "base", 1);
		world.addEntity(fortress);
		world.garrisonCounts.set(5000, 4);

		assert.equal(manager.garrisonSiegeUnit(world.gameState, ram), false,
			"the fortress is full");
		assert.equal(world.garrisonCalls.length, 0);
	});

	it("takes the hurt villager to a healing house, not the closest shelter", () =>
	{
		const { world, manager } = assembledWorld();
		const house = makeStructure(5000, [40, 40], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 10
		});
		house.setMetadata(PLAYER, "base", 1);
		world.addEntity(house);
		const hospital = makeStructure(5001, [70, 70], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 10,
			buffHeal: () => 8
		});
		hospital.setMetadata(PLAYER, "base", 1);
		world.addEntity(hospital);
		const wounded = makeEntity({
			id: 3000, owner: PLAYER, position: [20, 20], classes: ["Unit", "Support", "Worker"]
		});
		world.addEntity(wounded);

		assert.equal(manager.garrisonAttackedUnit(world.gameState, wounded), true);
		assert.deepEqual(world.garrisonCalls.map(([unit, target, type]) => [unit.id(), target.id(), type]),
			[[3000, 5001, GarrisonManager.TYPE_PROTECTION]],
			"only the healing house was taken, though farther");
	});

	it("leaves a hurt villager out when no healing house exists and it is no emergency", () =>
	{
		const { world, manager } = assembledWorld();
		const house = makeStructure(5000, [40, 40], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 10
		});
		house.setMetadata(PLAYER, "base", 1);
		world.addEntity(house);
		const wounded = makeEntity({
			id: 3000, owner: PLAYER, position: [20, 20], classes: ["Unit", "Support", "Worker"]
		});
		world.addEntity(wounded);

		assert.equal(manager.garrisonAttackedUnit(world.gameState, wounded), false,
			"outside a crisis a mere shelter does not treat wounds");
		assert.equal(world.garrisonCalls.length, 0);
	});

	it("makes room by throwing a resident out for an emergency case", () =>
	{
		const { world, manager } = assembledWorld();
		const unloadCalls: number[] = [];
		const shelter = makeStructure(5000, [40, 40], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 1,
			unload: (ent: unknown) => { unloadCalls.push(ent as number); },
			// like the engine: the holder reports its residents, here id 3000
			garrisoned: () => [3000]
		});
		shelter.setMetadata(PLAYER, "base", 1);
		world.addEntity(shelter);
		world.garrisonCounts.set(5000, 1);
		const bleeding = makeEntity({
			id: 3001, owner: PLAYER, position: [20, 20], classes: ["Unit", "Support", "Worker"]
		});
		world.addEntity(bleeding);

		assert.equal(manager.garrisonAttackedUnit(world.gameState, bleeding, true), true,
			"the emergency got a place");
		assert.deepEqual(unloadCalls, [3000], "the resident was evicted first");
		assert.deepEqual(world.garrisonCalls.map(([unit, target, type]) => [unit.id(), target.id(), type]),
			[[3001, 5000, GarrisonManager.TYPE_EMERGENCY]],
			"an emergency with no healing house is an emergency case, not for healing");
	});

	it("refuses the eviction when the shelter holds nobody to evict", () =>
	{
		const { world, manager } = assembledWorld();
		const shelter = makeStructure(5000, [40, 40], PLAYER, ["Structure"], {
			isGarrisonHolder: () => true,
			garrisonableClasses: () => ["Support"],
			garrisonMax: () => 1,
			garrisoned: () => []
		});
		shelter.setMetadata(PLAYER, "base", 1);
		world.addEntity(shelter);
		world.garrisonCounts.set(5000, 1);
		const bleeding = makeEntity({
			id: 3000, owner: PLAYER, position: [20, 20], classes: ["Unit", "Support", "Worker"]
		});
		world.addEntity(bleeding);

		assert.equal(manager.garrisonAttackedUnit(world.gameState, bleeding, true), false,
			"no place, nobody to evict");
		assert.equal(world.garrisonCalls.length, 0);
	});
});

describe("the office itself", () =>
{
	it("joins the standing army when the raider fits, opens a new one for captures", () =>
	{
		const { world, manager } = assembledWorld();
		const raider = makeSoldier(2000, [40, 40]);
		world.addEntity(raider);
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [0, 15, 10, 0]
		});
		world.addEntity(fort);
		manager.makeIntoArmy(world.gameState, 2000);
		assert.equal(manager.armies.length, 1, "one standing army");
		const next = makeSoldier(2001, [41, 40]);
		world.addEntity(next);
		manager.makeIntoArmy(world.gameState, 2001);
		assert.equal(manager.armies.length, 1, "the second raider joined the first army");
		assert.deepEqual(manager.armies[0].foeEntities.sort(), [2000, 2001]);

		manager.makeIntoArmy(world.gameState, 5000, "capturing");
		assert.equal(manager.armies.length, 2,
			"a capture army never folds into a punitive one");
		const captureID = fort.getMetadata(PLAYER, "PartOfArmy") as number;
		assert.equal(userArmy(manager, captureID).getType(), "capturing");
	});

	it("cuts an army out of the roster on the abort order", () =>
	{
		const { world, manager } = assembledWorld();
		const fort = makeStructure(5000, [60, 60], PLAYER, ["Structure"], {
			capturePoints: () => [5, 20, 5, 0]
		});
		world.addEntity(fort);
		manager.makeIntoArmy(world.gameState, 5000, "capturing");
		const army = manager.armies[0];

		manager.abortArmy(world.gameState, army);

		assert.equal(manager.armies.length, 0, "the army is gone from the roster");
		assert.equal(fort.getMetadata(PLAYER, "PartOfArmy"), undefined, "the fort released");
	});

	it("lifts cooperation with each extra enemy raiding the same ally", () =>
	{
		const { world, manager } = assembledWorld();
		assert.equal(manager.GetCooperationLevel(3), 0.5,
			"friendly cooperation stands at the personality's value");
		manager.attackedAllies[3] = 2;
		assert.equal(manager.GetCooperationLevel(3), 0.5 + 0.2,
			"two raiders lift it by a fifth");
		manager.attackedAllies[3] = 3;
		assert.equal(manager.GetCooperationLevel(3), 0.5 + 0.4,
			"and again by a fifth per further enemy");
	});

	it("rolls the freed defenders onto a tracked base once the raid falls", () =>
	{
		const world = makeWorld();
		const raider = makeSoldier(2000, [60, 50]);
		world.addEntity(raider);
		world.addEntity(makeStructure(4000, [50, 50], ENEMY));
		const manager = makeDefenseManager(world);
		manager.targetList.push(4000);
		world.ai.playedTurn = 2;
		world.addEntity(makeDefender(3000, [55, 50]));
		world.addEntity(makeDefender(3001, [56, 50]));
		manager.update(world.gameState, emptyEvents());
		const armyID = manager.armies[0].ID;
		assert.equal(manager.armies.length, 1, "the raid was under watch");

		// the raid party fell to the towers; the freed men get next orders
		world.removeEntity(raider.id());
		world.ai.playedTurn = 3;
		manager.update(world.gameState, eventsWith({ "Destroy": [{ "entity": raider.id() }] }));

		assert.equal(manager.armies.length, 0, "the army dissolved after the roll-out");
		assert.equal(world.switchCalls.length, 1, "and the freed men were rolled out");
		const roll = world.switchCalls[0] as [FakeEnt, Record<string, unknown>];
		assert.equal(roll[0].id(), 4000, "against the tracked base");
		assert.deepEqual(roll[1], { "armyID": armyID, "uniqueTarget": true });
	});

	it("keeps the freed men at rest when a tracked base is farther than any of us", () =>
	{
		const world = makeWorld();
		const raider = makeSoldier(2000, [200, 200]);
		world.addEntity(raider);
		world.addEntity(makeStructure(4000, [50, 50], ENEMY));
		const manager = makeDefenseManager(world);
		manager.targetList.push(4000);
		world.ai.playedTurn = 2;
		world.addEntity(makeDefender(3000, [220, 220]));
		world.addEntity(makeDefender(3001, [221, 220]));
		// the party was enlisted as an earlier attack on the ally had enlisted it
		manager.makeIntoArmy(world.gameState, raider.id());
		manager.update(world.gameState, emptyEvents());

		// the raid party fell, but nothing of ours stands near the tracked base
		world.removeEntity(raider.id());
		world.ai.playedTurn = 3;
		manager.update(world.gameState, eventsWith({ "Destroy": [{ "entity": raider.id() }] }));

		assert.equal(manager.armies.length, 0, "the army dissolved all the same");
		assert.equal(world.switchCalls.length, 0, "but none was rolled against the far base");
	});

	it("carries the whole defense through the save", () =>
	{
		const { world, manager } = assembledWorld();
		const raider = makeSoldier(2000, [40, 40]);
		world.addEntity(raider);
		manager.makeIntoArmy(world.gameState, 2000);
		manager.attackedAllies[3] = 2;

		const data = manager.Serialize();
		const fresh = makeDefenseManager(world);
		fresh.Deserialize(world.gameState, data);

		assert.equal(fresh.armies.length, 1, "one army restored");
		assert.deepEqual(fresh.getArmy(manager.armies[0].ID).foeEntities, [2000],
			"the restored army hunts the same raider");
		assert.deepEqual(fresh.attackedAllies, { "3": 2 },
			"the cooperation memory returned");
		assert.deepEqual(fresh.targetList, [], "the target list returned");
	});
});
