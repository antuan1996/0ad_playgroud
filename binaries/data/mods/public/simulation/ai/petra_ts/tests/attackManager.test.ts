/**
 * AttackManager: how Petra decides *when* to attack, whom to attack, and what
 * bombards, raids and defense-army handovers feed its attack plans.
 *
 * The rosters are often driven with plain plan stubs, so a test pins down
 * exactly one branch of the cycle; the plans themselves (and their
 * preparations, unit collections and saves) were measured in attackPlan.test.
 * Plans the manager creates itself are real AttackPlans, so their creation
 * goes through the same world the game would give them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logs, resetRecorder, sent } from "./harness/engine.ts";
import { emptyEvents, fake, makeEntity, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import { ENEMY, GAIA, makeWorld, PLAYER, type World, type WorldOptions } from "./harness/world.ts";

import { entityId, playerId, worldPos } from "../adapter/brands.ts";
import { AttackManager } from "../decision/attackManager.ts";
import { Config } from "../decision/config.ts";
import { MEDIUM, SANDBOX } from "../decision/difficultyLevel.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import type { DefenseArmy } from "../execution/defenseArmy.ts";

const KEEP = AttackPlan.PREPARATION_KEEP_GOING;
const FAILED = AttackPlan.PREPARATION_FAILED;
const START = AttackPlan.PREPARATION_START;
const UNEXECUTED = AttackPlan.STATE_UNEXECUTED;
const COMPLETING = AttackPlan.STATE_COMPLETING;

/** A config whose personality the test picks, as Petra's Config would be. */
function configFor(aggressive: number, overrides: Partial<Config> = {}): Config
{
	return Object.assign(new Config(MEDIUM), {
		priorities: {},
		personality: { aggressive, defensive: 0, cooperative: 0.5 },
		...overrides
	});
}

/** The config the world implies, with chatter on, for typical managers. */
function worldConfig(world: World, overrides: Partial<Config> = {}): Config
{
	return Object.assign(new Config(world.ai.Config.difficulty), world.ai.Config, { "chat": true, ...overrides });
}

/** The manager wired to one world, as headquarters owns it. */
function makeManager(world: World, config: Config): AttackManager
{
	const manager = new AttackManager(config);
	world.ai.HQ.attackManager = manager;
	return manager;
}

/** A plan stub's record of what the manager asked of it. */
interface PlanCalls
{
	forceStartCalls: number;
	abortCalls: number;
	checkEventsCalls: number;
	updatePreparationCalls: number;
	/** each setPaused, in order */
	pauses: boolean[];
}

/**
 * A plan as the manager sees it in its rosters, with every question answered
 * by the test: how it rolls preparation, whether it starts, how many units it
 * owns, and what its abort/force-start calls did.
 */
function planStub(overrides: {
	name?: number;
	type?: string;
	state?: string;
	targetPlayer?: number | undefined;
	units?: number;
	paused?: boolean;
	preparation?: number;
	startable?: boolean;
	remaining?: number | false;
	alreadyStarted?: boolean;
	position?: [number, number] | undefined;
} = {}): AttackPlan & PlanCalls
{
	const stub = {
		name: overrides.name ?? 1,
		type: overrides.type ?? "Attack",
		state: overrides.state ?? UNEXECUTED,
		targetPlayer: overrides.targetPlayer,
		position: overrides.position,
		unitCollection: { length: overrides.units ?? 0 },
		requested: undefined,
		paused: overrides.paused ?? false,
		forceStartCalls: 0,
		abortCalls: 0,
		checkEventsCalls: 0,
		updatePreparationCalls: 0,
		pauses: [] as boolean[],
		forceStart: () => { ++stub.forceStartCalls; },
		checkEvents: () => { ++stub.checkEventsCalls; },
		isStarted: () => overrides.alreadyStarted ?? false,
		isPaused: () => stub.paused,
		updatePreparation: () =>
		{
			++stub.updatePreparationCalls;
			return overrides.preparation ?? KEEP;
		},
		StartAttack: () => overrides.startable ?? true,
		update: () => overrides.remaining ?? 1,
		Abort: () => { ++stub.abortCalls; },
		getName: () => stub.name,
		getType: () => stub.type,
		setPaused: (value: boolean) => { stub.paused = value; stub.pauses.push(value); }
	};
	return fake<AttackPlan & PlanCalls>(stub);
}

/** A defense army as switchDefenseToAttack walks it: its foes and defenders, around [20, 20]. */
function armyStub(id: number, foes: number[], owns: number[]): DefenseArmy
{
	const army = {
		"ID": id,
		"foeEntities": foes,
		"ownEntities": owns,
		"foePosition": [20, 20],
		"recalculatePosition": () => undefined,
		"removeFoe": (_gameState: CommonGameState, foe: number) =>
		{
			const index = army.foeEntities.indexOf(foe);
			if (index !== -1)
				army.foeEntities.splice(index, 1);
		},
		"removeOwn": (_gameState: CommonGameState, own: number) =>
		{
			const index = army.ownEntities.indexOf(own);
			if (index !== -1)
				army.ownEntities.splice(index, 1);
		}
	};
	return fake<DefenseArmy>(army);
}

/** The world game state's roster tables for a player that players 0-2 lack. */
function addFoe(world: World, player: number): void
{
	const gs = world.gameState as unknown as {
		playerData: { isEnemy: boolean[] };
		sharedScript: { playersData: unknown[] };
	};
	gs.playerData.isEnemy[player] = true;
	gs.sharedScript.playersData[player] = { "state": "active" };
}

describe("attack manager", () =>
{
	describe("sizing the rushes", () =>
	{
		it("gives three heavy rushes to a very aggressive commander", () =>
		{
			const manager = new AttackManager(configFor(0.8));
			manager.setRushes(3);
			assert.equal(manager.maxRushes, 3);
			assert.deepEqual(manager.rushSize, [16, 20, 24]);
		});

		it("gives two rushes to a strong-enough commander with room", () =>
		{
			const manager = new AttackManager(configFor(0.6));
			manager.setRushes(2);
			assert.equal(manager.maxRushes, 2);
			assert.deepEqual(manager.rushSize, [18, 22]);
		});

		it("gives one rush to a mild commander", () =>
		{
			const manager = new AttackManager(configFor(0.4));
			manager.setRushes(1);
			assert.equal(manager.maxRushes, 1);
			assert.deepEqual(manager.rushSize, [20]);
		});

		it("keeps the rush count when neither temper nor allowance allow them", () =>
		{
			const manager = new AttackManager(configFor(0.9));
			manager.setRushes(0);
			assert.equal(manager.maxRushes, 0, "no allowance for a strong temper");
			assert.deepEqual(manager.rushSize, [], "and no rush sizes to spend");
			const mild = new AttackManager(configFor(0.1));
			mild.setRushes(2);
			assert.equal(mild.maxRushes, 0, "no temper for a wide allowance");
		});
	});

	describe("answering allies", () =>
	{
		it("remembers who lost the game", () =>
		{
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.PlayerDefeated.push({ "playerId": playerId(3) });
			manager.checkEvents(world.gameState, events);
			assert.deepEqual(manager.defeated, { 3: true });
		});

		it("ignores a request from our own commander, a stranger and a friendly player", () =>
		{
			resetRecorder();
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ "source": PLAYER, "player": playerId(3) }, { "source": playerId(3), "player": playerId(2) }, { "source": playerId(3), "player": playerId(1) });
			const roster = manager.upcomingAttacks["Rush"];
			const attack = planStub({ name: 4, units: 9 });
			roster.push(attack, planStub({ name: 5, units: 9 }));

			manager.checkEvents(world.gameState, events);
			assert.deepEqual(sent("aichat"), [], "nobody was answered");
			assert.equal(attack.targetPlayer, undefined, "nobody's aim was touched");
		});

		it("declines an ally whose prey none of our armies are big enough for", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ "source": playerId(3), "player": playerId(2) });
			const rush = planStub({ name: 4, targetPlayer: 2, units: 2, state: COMPLETING });
			manager.upcomingAttacks["Rush"].push(rush);

			manager.checkEvents(world.gameState, events);
			assert.equal(rush.forceStartCalls, 0, "the attack is not forced");
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, 2, "the prey was named");
			assert.ok(/enough soldiers|strengthen my army/.test(message.message), `the decline was told: ${message.message}`);
		});

		it("points the ally at the enemy we are already fighting, when we cannot help", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			world.gameState.playerData.isEnemy[4] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ "source": playerId(3), "player": playerId(2) });
			manager.upcomingAttacks["Attack"].push(planStub({ name: 4, targetPlayer: 4, units: 3, state: COMPLETING }));

			manager.checkEvents(world.gameState, events);
			const [message] = sent("aichat");
			assert.deepEqual(message.parameters, { "_player_": 2, "_player_2": 4 },
				"the ally learned where our forces are");
		});

		it("aims its idle armies at the asked player, and forces them once twelve stand ready", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ "source": playerId(3), "player": playerId(2) });
			const small = planStub({ name: 3, units: 2 });
			const medium = planStub({ name: 4, units: 5 });
			const large = planStub({ name: 5, units: 9 });
			const completing = planStub({ name: 6, units: 9, state: COMPLETING, targetPlayer: 2 });
			const away = planStub({ name: 7, units: 9, targetPlayer: GAIA });
			manager.upcomingAttacks["Rush"].push(small, medium, large, completing, away);

			manager.checkEvents(world.gameState, events);
			assert.equal(small.forceStartCalls, 0, "too small was left alone (and re-aimed)");
			assert.equal(small.targetPlayer, 2, " armies were re-aimed at the requester");
			assert.equal(medium.forceStartCalls, 1, "the mid force marched");
			assert.equal(medium.requested, true, "marked as requested");
			assert.equal(large.forceStartCalls, 1);
			assert.equal(completing.forceStartCalls, 0, "a completing attack carried on its own aim");
			assert.equal(away.forceStartCalls, 1, "even an idle army aimed elsewhere was re-aimed and sent");
			assert.equal(away.targetPlayer, 2, "its aim now follows the ally's prey");
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, 2, "the prey was named");
			assert.ok(/regroup|preparations/.test(message.message), `the agreement was told: ${message.message}`);
		});

		it("answers the first request only, and not a second one", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ "source": playerId(3), "player": playerId(2) }, { "source": playerId(3), "player": playerId(4) });
			manager.upcomingAttacks["Rush"].push(planStub({ name: 4, units: 9 }));

			manager.checkEvents(world.gameState, events);
			assert.equal(sent("aichat").length, 1, "a single answer");
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, 2, "only the first request's prey");
		});
	});

	describe("renaming strike aims", () =>
	{
		it("renames a bombing aim whose target was rebuilt", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			manager.bombingAttacks.set(entityId(5001), new Set([entityId(1100)]));
			const events = emptyEvents();
			events.EntityRenamed.push({ "entity": entityId(5001), "newentity": entityId(7001) });

			manager.checkEvents(fake<CommonGameState>({}), events);
			assert.deepEqual([...manager.bombingAttacks.keys()], [7001], "the aim followed the rebuild");
			assert.deepEqual([...manager.bombingAttacks.get(entityId(7001))!], [1100], "with its force intact");
		});

		it("renames each bomber inside a group whose unit was rebuilt", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			manager.bombingAttacks.set(entityId(5000), new Set([entityId(6001), entityId(6002)]));
			const events = emptyEvents();
			events.EntityRenamed.push({ "entity": entityId(6001), "newentity": entityId(7001) });

			manager.checkEvents(fake<CommonGameState>({}), events);
			assert.deepEqual([...manager.bombingAttacks.get(entityId(5000))!], [6002, 7001], "the rebuilt bomber was re-listed");
		});
	});

	describe("bombing within range", () =>
	{
		/** a target structure somewhere away from the bomber */
		function makeEnemyWall(world: World, id = 5000, position: [number, number] = [40, 40]): CommonEntity
		{
			return world.addEntity(makeEntity({ id, "owner": ENEMY, position, "classes": ["Structure"] },
				{ "footprintRadius": () => 2 }));
		}

		it("prunes aims whose target is gone or no longer hostile", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world); // survives, its force still under orders
			world.addEntity(makeEntity({ id: 5002, owner: PLAYER, position: [32, 30], classes: ["Structure"] }));
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => false, "unitAIOrderData": () => [{ "target": 5000 }] }));
			manager.bombingAttacks.set(entityId(5002), new Set([entityId(1100)]));
			manager.bombingAttacks.set(entityId(5003), new Set([entityId(1100)]));
			manager.bombingAttacks.set(entityId(5000), new Set([entityId(1100)]));

			manager.assignBombers(world.gameState);
			assert.deepEqual([...manager.bombingAttacks.keys()], [5000], "only the enemy aim survived");
		});

		it("keeps the bomber whose last order still names the storm, and drops the moved-on one", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => ({ "max": 40 }), "unitAIOrderData": () => [{ "target": 5000 }] }));
			world.addEntity(makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => ({ "max": 40 }), "unitAIOrderData": () => [{ "target": 6000 }] }));
			manager.bombingAttacks.set(entityId(5000), new Set([entityId(1100), entityId(1101)]));

			manager.assignBombers(world.gameState);
			assert.deepEqual([...manager.bombingAttacks.get(entityId(5000))!], [1100], "the moved-on bomber was dropped");
		});

		it("skips blind, busy or reserved bombers", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => undefined }));
			world.addEntity(makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => false, "attackRange": () => ({ "max": 40 }) }));
			world.addEntity(makeEntity({ id: 1102, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => ({ "max": 40 }) }, { "plan": -2 }));
			world.addEntity(makeEntity({ id: 1103, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => ({ "max": 40 }) }, { "plan": -3 }));
			world.addEntity(makeEntity({ id: 1104, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] },
				{ "isIdle": () => true, "attackRange": () => ({ "max": 40 }) }, { "plan": 1, "subrole": "walking" }));

			manager.assignBombers(world.gameState);
			assert.equal(manager.bombingAttacks.size, 0, "nobody was enrolled");
		});

		it("strikes a structure already inside the gun's reach", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[][] = [];
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 60 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": (aimed: unknown, capture: unknown, queued: unknown) => strikes.push([aimed, capture, queued])
			}));

			manager.assignBombers(world.gameState);
			assert.deepEqual(strikes, [[5000, false, false]], "the wall took the shot without marching");
			assert.deepEqual([...manager.bombingAttacks.get(entityId(5000))!], [1100], "the bomber was enrolled");
		});

		it("marches out of reach and opens fire from the border", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[][] = [];
			const moves: Array<[number, number]> = [];
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 40 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": (aimed: unknown, capture: unknown, queued: unknown) => strikes.push([aimed, capture, queued]),
				"move": (x: number, y: number) => moves.push([x, y])
			}));

			manager.assignBombers(world.gameState);
			assert.deepEqual(strikes, [[5000, false, true]], "the shot was queued while moving");
			assert.equal(moves.length, 1, "the bomber marched once");
			assert.ok(Math.abs(moves[0][0] - 11.72) < 0.01 && Math.abs(moves[0][1] - 11.72) < 0.01,
				`the stand-off spot just inside gun range: ${moves[0]}`);
		});

		/** one bomber, one wall, and the territory/access answers to probe */
		function probe(territory: Array<[string, number]>, access?: Array<[string, number]>): number
		{
			const world = makeWorld({ enemyPlayer: ENEMY, territory: new Map(territory) });
			if (access)
				for (const [key, value] of access)
					world.accessAt.set(key, value);
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[] = [];
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 40 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": (aimed: unknown) => strikes.push(aimed),
				"move": () => undefined
			}));
			manager.assignBombers(world.gameState);
			return strikes.length;
		}

		it("refuses stand-off spots on enemy, foreign or unreachable ground", () =>
		{
			assert.equal(probe([["17,17", ENEMY]]), 0, "the approach was enemy ground");
			assert.equal(probe([["12,12", GAIA]]), 0, "the stand-off itself must be ours");
			assert.equal(probe([], [["12,12", 3]]), 0, "another land was refused");
		});

		it("ignores fields nobody gathers and fields outside the enemy's grip", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			world.territory.set("40,41", ENEMY);
			const manager = makeManager(world, worldConfig(world));
			const strikes: unknown[] = [];
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 60 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": (aimed: unknown) => strikes.push(aimed)
			}));
			// a field nobody works, however hostile its ground
			world.addEntity(makeEntity({ id: 5002, owner: ENEMY, position: [12, 12], classes: ["Structure", "Field"] },
				{ "resourceSupplyNumGatherers": () => 0, "footprintRadius": () => 1 }));
			// a worked field on our own ground
			world.addEntity(makeEntity({ id: 5003, owner: ENEMY, position: [20, 20], classes: ["Structure", "Field"] },
				{ "resourceSupplyNumGatherers": () => 2, "footprintRadius": () => 1 }));
			// a worked field deep in enemy land
			world.addEntity(makeEntity({ id: 5001, owner: ENEMY, position: [40, 41], classes: ["Structure", "Field"] },
				{ "resourceSupplyNumGatherers": () => 2, "footprintRadius": () => 1 }));

			manager.assignBombers(world.gameState);
			assert.deepEqual(strikes, [5001], "only the worked enemy field drew the bombers");
		});

		it("leaves a target whose storm is already crowded", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const crowd = new Set<EntityId>();
			for (let i = 0; i < 5; ++i)
			{
				world.addEntity(makeEntity({ id: 7001 + i, owner: PLAYER },
					{ "unitAIOrderData": () => [{ "target": 5000 }] }));
				crowd.add(entityId(7001 + i));
			}
			manager.bombingAttacks.set(entityId(5000), crowd);
			const strikes: unknown[] = [];
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 40 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": (aimed: unknown) => strikes.push(aimed),
				"move": () => undefined
			}));

			manager.assignBombers(world.gameState);
			assert.deepEqual(strikes, [], "the crowded wall was left alone");
			assert.equal(manager.bombingAttacks.get(entityId(5000))!.size, 5, "the crowd stood unchanged");
		});

		it("lets a second bomber pile onto the same storm", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[] = [];
			const shoot = (id: number) => (aimed: unknown) => strikes.push([id, aimed]);
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 40 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": shoot(1100),
				"move": () => undefined
			}));
			world.addEntity(makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 40 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY,
				"attack": shoot(1101),
				"move": () => undefined
			}));

			manager.assignBombers(world.gameState);
			assert.equal(strikes.length, 2, "both bombers opened fire");
			assert.deepEqual([...manager.bombingAttacks.get(entityId(5000))!], [1100, 1101], "both were enrolled");
		});
	});
	describe("keeping the exiles apart", () =>
	{
		it("keeps the units a previous attack dropped for the next muster", () =>
		{
			const world = makeWorld();
			world.addEntity(makeEntity({ id: 1200, owner: PLAYER, position: [11, 12], classes: ["Unit"] },
				{}, { "plan": -1 }));
			world.addEntity(makeEntity({ id: 1201, owner: PLAYER, position: [11, 12], classes: ["Unit"] },
				{}, { "plan": 8 }));
			const manager = makeManager(world, worldConfig(world));

			manager.init(world.gameState);
			assert.equal(manager.outOfPlan.hasEntId(entityId(1200)), true, "the dropped unit was kept");
			assert.equal(manager.outOfPlan.hasEntId(entityId(1201)), false, "an enlisted unit is not an exile");
		});
	});

	describe("walking the attack cycle", () =>
	{
		/** a world whose manager walks one update with the given roster contents */
		function cycleWorld(debug = 0): { world: World; manager: AttackManager }
		{
			const world = makeWorld({ debug });
			const manager = makeManager(world, worldConfig(world));
			return { world, manager };
		}

		it("dumps both rosters in debug splendour before the cycle", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(3);
			manager.upcomingAttacks["Attack"].push(planStub({ name: 5, units: 4, state: COMPLETING }));
			manager.startedAttacks["Rush"].push(planStub({ name: 7, units: 6, state: "walking" }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((line) => line.includes(" upcoming attacks =================")), "the dump opened");
			assert.ok(logs.some((line) => line.includes(" plan 5 type Attack state completing units 4")),
				`the waiting plan was listed: ${logs.join(" | ")}`);
			assert.ok(logs.some((line) => line.includes(" started attacks ==================")), "the second dump opened");
			assert.ok(logs.some((line) => line.includes(" plan 7 type Rush state walking units 6")),
				"the walking plan was listed");
			assert.equal(manager.debugTime, 100, "the next dump waits another minute");
		});

		it("dumps nothing when the last dump is still fresh", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(3);
			manager.debugTime = 100;

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.deepEqual(logs, [], "the rosters stayed unlisted");
		});

		it("grumbles about an upcoming plan that already started", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld();
			manager.upcomingAttacks["Attack"].push(planStub({ name: 5, alreadyStarted: true }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((line) => /Petra problem in attackManager/.test(line)),
				`the grumble was logged: ${logs.join(" | ")}`);
		});

		it("keeps a preparing attack warm for the next turn", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, units: 5 });
			manager.upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.checkEventsCalls, 1, "the plan heard the turn's events");
			assert.equal(attack.updatePreparationCalls, 1, "the plan prepared once");
			assert.equal(attack.abortCalls, 0, "nothing aborted");
			assert.equal(manager.upcomingAttacks["Attack"].length, 1, "the plan is kept");
		});

		it("does not raise a fresh rush while one already waits half-mustered", () =>
		{
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			manager.maxRushes = 2;
			manager.rushSize = [20, 20];
			manager.upcomingAttacks["Rush"].push(planStub({ name: 3 }));
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["Rush"].length, 1, "no second rush");
			assert.equal(manager.rushNumber, 0, "the credit was not spent either");
		});

		it("aborts a preparation that failed", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const attack = planStub({ name: 3, preparation: FAILED });
			manager.upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((line) => line.includes("Attack Manager: Attack plan 3 aborted.")),
				`the abort was logged: ${logs.join(" | ")}`);
			assert.equal(attack.abortCalls, 1, "the plan was told");
			assert.equal(manager.upcomingAttacks["Attack"].length, 0, "the roster forgot it");
		});

		it("launches a ready plan and announces the campaign", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const attack = planStub({ name: 3, preparation: START, targetPlayer: ENEMY });
			manager.upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((line) => line.includes("Attack Manager: Starting Attack plan 3")),
				`the start was logged: ${logs.join(" | ")}`);
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, ENEMY, "the prey was announced");
			assert.ok(/launching|sent|sending/.test(message.message),
				`the campaign was told: ${message.message}`);
			assert.equal(manager.startedAttacks["Attack"].length, 1, "the plan now marches");
			assert.equal(manager.upcomingAttacks["Attack"].length, 0, "and left the preparation roster");
		});

	it("skips the announcement when chatter is off", () =>
		{
			resetRecorder();
			const world = makeWorld({ debug: 1 });
			const manager = makeManager(world, worldConfig(world, { "chat": false }));
			manager.upcomingAttacks["Attack"].push(planStub({ name: 3, preparation: START, targetPlayer: ENEMY }));
			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.deepEqual(sent("aichat"), [], "chatter off, no announcement");
			assert.equal(manager.startedAttacks["Attack"].length, 1, "but the plan still marched");
		});

		it("aborts an attack whose start attempt failed", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, preparation: START, startable: false });
			manager.upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.abortCalls, 1, "the plan was aborted");
			assert.equal(manager.upcomingAttacks["Attack"].length, 0, "and forgotten");
			assert.equal(manager.startedAttacks["Attack"].length, 0, "without ever marching");
		});

		it("skips the started update of a paused plan", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, remaining: 0, paused: true });
			manager.startedAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.checkEventsCalls, 1, "the plan heard the turn's events");
			assert.equal(attack.abortCalls, 0, "the pause shielded it from its empty verdict");
			assert.equal(manager.startedAttacks["Attack"].length, 1, "the plan is kept");
		});

		it("retires an attack that came back empty, be it zero or false", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const spent = planStub({ name: 3, remaining: 0 });
			const dissolved = planStub({ name: 4, remaining: false });
			manager.startedAttacks["Attack"].push(spent, dissolved);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((entry) => entry.includes("Attack plan 3 is finished with remaining 0")),
				`the retirement was logged: ${logs.join(" | ")}`);
			assert.equal(spent.abortCalls, 1, "the spent plan was aborted");
			assert.equal(dissolved.abortCalls, 1, "the dissolved plan was aborted too");
			assert.equal(manager.startedAttacks["Attack"].length, 0, "the roster forgot both");
		});

		it("keeps an attack whose army survives", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, remaining: 1 });
			manager.startedAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.abortCalls, 0, "nothing aborted");
			assert.equal(manager.startedAttacks["Attack"].length, 1, "the plan is kept");
		});
	});

	describe("creating plans during update", () =>
	{
		/** the world and manager a creation test starts from */
		function creationWorld(options: WorldOptions = {}): { world: World; manager: AttackManager }
		{
			const world = makeWorld(options);
			const manager = makeManager(world, worldConfig(world));
			return { world, manager };
		}

		it("rushes when a barracks stands and the rush count has room", () =>
		{
			resetRecorder();
			const world = makeWorld({ debug: 2 });
			const manager = makeManager(world, worldConfig(world));
			manager.maxRushes = 1;
			manager.rushSize = [20];
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((entry) => entry.includes("Rushing plan 0 with maxRushes 1")),
				`the rush was logged: ${logs.join(" | ")}`);
			assert.equal(manager.upcomingAttacks["Rush"].length, 1, "one fresh rush waits");
			const plan = manager.upcomingAttacks["Rush"][0];
			assert.equal(plan.name, 0, "named by the running counter");
			assert.equal(plan.type, "Rush", "and typed as a rush");
			assert.equal(manager.totalNumber, 1, "the counter moved on");
			assert.equal(manager.rushNumber, 1, "and the rush credit was spent");
		});

		// artificial world (a "built" barracks with no position): while a barracks
		// stands, the plan always finds it to rally at, so the failure branch here
		// cannot actually be reached in a real game
		it("spends the rush credit even when the rush cannot be planned", () =>
		{
			const { world, manager } = creationWorld();
			world.bases[0].anchor = undefined;
			world.removeEntity(1000);
			manager.maxRushes = 1;
			manager.rushSize = [20];
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, classes: ["Structure", "Barracks"] }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["Rush"].length, 0, "no plan was enlisted");
			assert.equal(manager.rushNumber, 1, "but the credit was spent");
			assert.equal(manager.totalNumber, 0, "and the counter untouched");
		});

		it("raises a default attack once phase two stands and no other attack waits", () =>
		{
			resetRecorder();
			const world = makeWorld({ phase: 2, debug: 2 });
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((entry) => entry.includes("Creating the plan Attack  0")),
				`the creation was logged: ${logs.join(" | ")}`);
			assert.equal(manager.upcomingAttacks["Attack"].length, 1, "a default attack waits in preparation");
			const plan = manager.upcomingAttacks["Attack"][0];
			assert.equal(plan.type, "Attack", "the first two attacks are default ones");
			assert.equal(manager.attackNumber, 1, "the attack counter moved on");
		});

		it("swells into a HugeAttack once two default attacks have been spent", () =>
		{
			const { world, manager } = creationWorld({ phase: 2 });
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));
			manager.attackNumber = 2;

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["HugeAttack"].length, 1, "a huge attack waits in preparation");
			const plan = manager.upcomingAttacks["HugeAttack"][0];
			assert.equal(plan.type, "HugeAttack", "a huge attack was raised");
		});

		// artificial world: rush, default and huge plans carry no target, so only the
		// (unreachable) rally-point failure can hit them — unreachable in real play,
		// kept because the guard is real code in port and ref alike
		it("gives up a ground attack whose plan failed, and still spends the credit", () =>
		{
			const { world, manager } = creationWorld({ phase: 2 });
			world.bases[0].anchor = undefined;
			world.removeEntity(1000);
			world.addEntity(makeEntity({ id: 900, owner: PLAYER, classes: ["Structure", "Barracks"] }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["Attack"].length, 0, "no plan was enlisted");
			assert.equal(manager.attackNumber, 1, "but the credit was spent");
		});

		it("waits for the phase-two tech to be underway before attacking", () =>
		{
			const idle = creationWorld({ phaseName: "phase.town" });
			idle.world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));
			idle.manager.update(idle.world.gameState, idle.world.ai.queues, emptyEvents());
			assert.equal(idle.manager.upcomingAttacks["Attack"].length, 0, "no tech, no attack");

			const researching = creationWorld({ phaseName: "phase.town", researching: ["phase.town"] });
			researching.world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));
			researching.manager.update(researching.world.gameState, researching.world.ai.queues, emptyEvents());
			assert.equal(researching.manager.upcomingAttacks["Attack"].length, 1, "the tech underway, the attack comes");
		});

		it("attacks whatever happens when no base could ever rise again", () =>
		{
			const idle = creationWorld();
			idle.manager.update(idle.world.gameState, idle.world.ai.queues, emptyEvents());
			assert.equal(idle.manager.upcomingAttacks["Attack"].length, 0, "with a potential base, patience");

			const desperate = creationWorld({ hasPotentialBase: false });
			desperate.manager.update(desperate.world.gameState, desperate.world.ai.queues, emptyEvents());
			assert.equal(desperate.manager.upcomingAttacks["Attack"].length, 1, "nothing else to do than attack");
			assert.equal(desperate.manager.attackNumber, 1, "and the attack counter moved on");
		});

		it("caps the running attacks by the town's population allowance", () =>
		{
			const capped = creationWorld({ phase: 2, populationMax: 40 });
			capped.world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));
			capped.manager.startedAttacks["Attack"].push(planStub({ name: 2 }));

			capped.manager.update(capped.world.gameState, capped.world.ai.queues, emptyEvents());
			assert.equal(capped.manager.upcomingAttacks["Attack"].length, 0, "one running attack fills a small town");

			const roomy = creationWorld({ phase: 2 });
			roomy.world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }));
			roomy.manager.startedAttacks["Attack"].push(planStub({ name: 2 }));

			roomy.manager.update(roomy.world.gameState, roomy.world.ai.queues, emptyEvents());
			assert.equal(roomy.manager.upcomingAttacks["Attack"].length, 1, "a big town supports a second attack");
		});

		it("makes a raid on the threat the defense manager spotted", () =>
		{
			const { world, manager } = creationWorld({ enemyPlayer: ENEMY });
			const threat = world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }));
			world.ai.HQ.defenseManager.targetList.push(entityId(5000));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["Raid"].length, 1, "a raid waits in preparation");
			const plan = manager.upcomingAttacks["Raid"][0];
			assert.equal(plan.type, "Raid", "typed as a raid");
			assert.equal(plan.target, threat, "aimed at the spotted threat");
			assert.equal(manager.raidNumber, 1, "the raid credit was spent");
			assert.equal(manager.totalNumber, 1, "and the counter moved on");
		});

		it("skips lost names and friendly owners in the raid scan", () =>
		{
			const { world, manager } = creationWorld();
			world.addEntity(makeEntity({ id: 5001, owner: PLAYER, position: [30, 40], classes: ["Structure"] }));
			world.ai.HQ.defenseManager.targetList.push(entityId(99), entityId(5001));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.upcomingAttacks["Raid"].length, 0, "no raid was planned");
			assert.equal(manager.raidNumber, 0, "and no credit spent");
		});

		it("gives up on a raid whose target is sealed on another island", () =>
		{
			// the real in-game failure path: the defense army spots a threat on a
			// naval map, but no sea lane connects our land to theirs
			resetRecorder();
			const { world, manager } = creationWorld({ enemyPlayer: ENEMY, navalMap: true });
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] },
				{}, { "access": 3 }));
			world.ai.HQ.defenseManager.targetList.push(entityId(5000));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((entry) => entry.includes("has an inaccessible target")),
				`the missing sea lane was logged: ${logs.join(" | ")}`);
			assert.equal(manager.upcomingAttacks["Raid"].length, 0, "no raid was planned");
			assert.equal(manager.raidNumber, 0, "and no credit spent");
		});

		it("polls the bombers every fifth turn on a hard-enough difficulty", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			world.ai.playedTurn = 5;
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] },
				{ "footprintRadius": () => 2 }));
			world.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 60 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY
			}));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(manager.bombingAttacks.get(entityId(5000))?.has(entityId(1100)), true, "the idle bomber was enrolled");
		});

		it("leaves the bombers alone on other turns and on easy difficulties", () =>
		{
			const otherTurn = makeWorld({ enemyPlayer: ENEMY });
			otherTurn.ai.playedTurn = 6;
			const manager = makeManager(otherTurn, worldConfig(otherTurn));
			otherTurn.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] }));
			otherTurn.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 60 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY
			}));

			manager.update(otherTurn.gameState, otherTurn.ai.queues, emptyEvents());
			assert.equal(manager.bombingAttacks.size, 0, "no polling off the fifth turn");

			const easy = makeWorld({ enemyPlayer: ENEMY, difficulty: SANDBOX });
			easy.ai.playedTurn = 5;
			const easyManager = makeManager(easy, worldConfig(easy));
			easy.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] }));
			easy.addEntity(makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
				"isIdle": () => true,
				"attackRange": () => ({ "max": 60 }),
				"canAttackTarget": (aimed: CommonEntity) => aimed.owner() === ENEMY
			}));

			easyManager.update(easy.gameState, easy.ai.queues, emptyEvents());
			assert.equal(easyManager.bombingAttacks.size, 0, "no polling on the easiest difficulty");
		});
	});

	describe("picking the foe", () =>
	{
		function foeWorld(options: WorldOptions = {}): { world: World; manager: AttackManager }
		{
			const world = makeWorld(options);
			const manager = makeManager(world, worldConfig(world));
			return { world, manager };
		}

		it("stays on a foe once one has been chosen", () =>
		{
			const { world, manager } = foeWorld({ enemyPlayer: ENEMY });
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }));
			manager.currentEnemyPlayer = ENEMY;

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "the remembered foe carried over");
			assert.equal(manager.currentEnemyPlayer, ENEMY, "no re-choice while a plan is fresh");
		});

		it("re-picks when the remembered foe has nothing left", () =>
		{
			const { world, manager } = foeWorld({ enemyPlayer: ENEMY });
			manager.currentEnemyPlayer = ENEMY;

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), undefined, "nobody left to fight");
			assert.equal(manager.currentEnemyPlayer, undefined, "the memory was cleared");
		});

		it("never picks a player who already lost", () =>
		{
			const { world, manager } = foeWorld({ enemyPlayer: ENEMY });
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }));
			manager.defeated = { 2: true };
			manager.currentEnemyPlayer = ENEMY;

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), undefined, "the defeated stay defeated");
		});

		it("shies a rush away from a wall of defenses", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			for (let i = 0; i < 7; ++i)
				world.addEntity(makeEntity({ id: 6000 + i, owner: ENEMY, position: [30 + i, 40],
					classes: ["Structure", "Tower"] }));

			const rush = planStub({ name: 3, type: "Rush" });
			assert.equal(manager.getEnemyPlayer(world.gameState, rush), undefined, "too well defended for a rush");

			const lenient = makeManager(world, worldConfig(world));
			world.removeEntity(6006); // six towers are tolerated
			const bolder = planStub({ name: 4, type: "Rush" });
			assert.equal(lenient.getEnemyPlayer(world.gameState, bolder), ENEMY, "six towers are no veto");
		});

		it("walks to the enemy civil centre nearest our own", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] }));
			world.addEntity(makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] }));

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "the nearer centre won");
			assert.equal(manager.currentEnemyPlayer, ENEMY, "and was remembered");
		});

		it("cannot be lured to a centre across the sea when a land neighbour waits", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] }));
			// the overseas centre: on another land, so out of reach for a ground army
			world.addEntity(makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] },
				{}, { "access": 3 }));

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "the overseas centre was ignored");
		});

		it("targets the strongest enemy when no centre can be reached by land", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			// the enemy's centre sits on another land: out of the centre chase
			world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] },
				{}, { "access": 3 }));
			world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [31, 40], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 2101, owner: ENEMY, position: [32, 40], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3100, owner: 3, position: [80, 95], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3101, owner: 3, position: [81, 95], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3102, owner: 3, position: [82, 95], classes: ["Unit"] }));

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY,
				"the civ centre outweighed the extra unit");
			assert.equal(manager.currentEnemyPlayer, ENEMY, "and was remembered");
		});

		it("skips the centre chase and the remembered foe for a huge attack", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }));
			world.addEntity(makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] }));
			for (let i = 0; i < 10; ++i)
				world.addEntity(makeEntity({ id: 3100 + i, owner: 3, position: [80 + i * 0.4, 95], classes: ["Unit"] }));
			manager.currentEnemyPlayer = ENEMY;

			const plain = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, plain), ENEMY, "a normal attack revisits the foe");
			const huge = planStub({ name: 4, type: "HugeAttack" });
			assert.equal(manager.getEnemyPlayer(world.gameState, huge), 3, "a huge attack scans afresh");
		});

		it("hunts the player with the most advanced wonder", () =>
		{
			const building = foeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder"] });
			addFoe(building.world, 3);
			building.world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40],
				classes: ["Structure", "Wonder"] }, { "foundationProgress": () => 40 }));
			building.world.addEntity(makeEntity({ id: 2001, owner: 3, position: [80, 95],
				classes: ["Structure", "Wonder"] }, { "foundationProgress": () => 80 }));
			const attack = planStub({ name: 3 });
			assert.equal(building.manager.getEnemyPlayer(building.world.gameState, attack), 3,
				"the more advanced wonder won");
			assert.equal(building.manager.currentEnemyPlayer, 3, "and was remembered");

			const finished = foeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder"] });
			addFoe(finished.world, 3);
			finished.world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40],
				classes: ["Structure", "Wonder"] }, { "foundationProgress": () => 40 }));
			finished.world.addEntity(makeEntity({ id: 2001, owner: 3, position: [80, 95],
				classes: ["Structure", "Wonder"] })); // completed: no progress at all
			assert.equal(finished.manager.getEnemyPlayer(finished.world.gameState, planStub({ name: 3 })), 3,
				"a finished wonder wins outright");
		});

		it("leaves a gaia wonder alone and falls back to the usual choice", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder"] });
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 2000, owner: GAIA, position: [30, 40],
				classes: ["Structure", "Wonder"] }, { "foundationProgress": () => 40 }));
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [80, 95], classes: ["Structure"] }));

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY,
				"the wonder was ignored, the usual choice stands");
		});

		it("seizes the richest relic hoard", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["capture_the_relic"] });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 4000, owner: ENEMY, position: [30, 40], classes: ["Unit", "Relic"] }));
			world.addEntity(makeEntity({ id: 4001, owner: 3, position: [80, 95], classes: ["Unit", "Relic"] }));
			world.addEntity(makeEntity({ id: 4002, owner: 3, position: [81, 95], classes: ["Unit", "Relic"] }));
			world.addEntity(makeEntity({ id: 4003, owner: GAIA, position: [50, 50], classes: ["Unit", "Relic"] }));

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), 3, "the richer hoard won");
			assert.equal(manager.currentEnemyPlayer, 3, "and was remembered");
			assert.equal(world.relicResets.length, 0, "no gaia relic was handed back");
		});

		it("hands the gaia relics back when gaia holds the most", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["capture_the_relic"] });
			addFoe(world, 3);
			world.ai.HQ.victoryManager.tryCaptureGaiaRelic = true;
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 4000, owner: ENEMY, position: [30, 40], classes: ["Unit", "Relic"] }));
			for (let i = 0; i < 3; ++i)
				world.addEntity(makeEntity({ id: 4100 + i, owner: GAIA, position: [50 + i, 50], classes: ["Unit", "Relic"] }));

			// the picker itself does name gaia, and resets the gaia-relic plan
			const attack = planStub({ name: 3, targetPlayer: 3 }); // an aim already chosen
			assert.equal(manager.getRelicEnemyPlayer(world.gameState, attack), 0, "gaia's hoard won");
			assert.equal(world.relicResets.length, 1, "the gaia-relic plan was reset");
			assert.equal(manager.currentEnemyPlayer, undefined, "a plan with an aim keeps its own");

			// but the caller's `relicPick || wonderPick` swallows gaia's 0 on its own return:
			// gaia steers later plans only through the remembered-target branch
			assert.equal(manager.getEnemyPlayer(world.gameState, planStub({ name: 4 })), 0,
				"the remembered gaia pick still steers later plans");
		});

		it("mixes a wonder and a relic aim by chance", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder", "capture_the_relic"] });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "Wonder"] }));
			world.addEntity(makeEntity({ id: 4000, owner: 3, position: [80, 95], classes: ["Unit", "Relic"] }));

			const attack = planStub({ name: 3 });
			stubGlobal("randBool", () => false);
			try
			{
				assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "chance kept the wonder aim");
			}
			finally
			{
				restoreEngine();
			}
			stubGlobal("randBool", () => true);
			try
			{
				assert.equal(manager.getEnemyPlayer(world.gameState, planStub({ name: 4 })), 3,
					"chance switched to the relic hoard");
			}
			finally
			{
				restoreEngine();
			}
		});
	});

	describe("roster helpers", () =>
	{
		it("finds a plan by its name in either roster", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			const preparing = planStub({ name: 3 });
			const marching = planStub({ name: 9 });
			manager.upcomingAttacks["Rush"].push(preparing);
			manager.startedAttacks["Attack"].push(marching);

			assert.equal(manager.getPlan(3), preparing, "found among the preparing");
			assert.equal(manager.getPlan(9), marching, "found among the marching");
			assert.equal(manager.getPlan(50), undefined, "nothing under that name");
		});

		it("pauses exactly the named plan, or every plan at once", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			const c = planStub({ name: 5 });
			manager.upcomingAttacks["Rush"].push(a, b);
			manager.startedAttacks["Attack"].push(c);

			manager.pausePlan(4);
			assert.deepEqual(b.pauses, [true], "the named plan was paused");
			assert.deepEqual(a.pauses, [], "the rest was untouched");

			manager.pauseAllPlans();
			assert.deepEqual(a.pauses, [true]);
			assert.deepEqual(b.pauses, [true, true], "already paused stays paused");
			assert.deepEqual(c.pauses, [true]);

			manager.unpauseAllPlans();
			assert.equal(a.paused, false);
			assert.equal(b.paused, false);
			assert.equal(c.paused, false);
		});

		it("tells which attack is being prepared", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			manager.upcomingAttacks["Attack"].push(a, b);

			assert.equal(manager.getAttackInPreparation("Attack"), a, "the first in line");
			assert.equal(manager.getAttackInPreparation("Rush"), undefined, "no rush in preparation");
		});

		it("unpauses exactly the named plan", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			manager.upcomingAttacks["Rush"].push(a, b);

			manager.pauseAllPlans();
			manager.unpausePlan(4);
			assert.equal(b.paused, false, "the named plan runs again");
			assert.equal(a.paused, true, "the rest stays paused");
		});
	});

	describe("diplomacy and counting", () =>
	{
		it("cuts every war aim against a player we now befriend", () =>
		{
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			const preparing = planStub({ name: 3, targetPlayer: 3 });
			const marching = planStub({ name: 4, targetPlayer: 3 });
			const other = planStub({ name: 5, targetPlayer: 2 });
			manager.upcomingAttacks["Rush"].push(preparing);
			manager.startedAttacks["Attack"].push(marching, other);

			manager.cancelAttacksAgainstPlayer(world.gameState, playerId(3));
			assert.equal(preparing.targetPlayer, undefined, "the preparation lost its aim");
			assert.equal(marching.abortCalls, 1, "the marching attack was aborted");
			assert.equal(manager.startedAttacks["Attack"].length, 1, "and removed from the roster");
			assert.equal(other.abortCalls, 0, "another foe is untouched");
		});

		it("counts the troops of our marching armies around a point", () =>
		{
			const manager = new AttackManager(configFor(0.5));
			manager.startedAttacks["Attack"].push(
				planStub({ name: 3, units: 4, position: [20, 20] }),
				planStub({ name: 4, units: 2, position: [90, 90] }),
				planStub({ name: 5, units: 9 })); // no position: inside a transport

			assert.equal(manager.numAttackingUnitsAround(worldPos(25, 25), 10), 4, "the nearby army counts");
			assert.equal(manager.numAttackingUnitsAround(worldPos(25, 25), 200), 6, "the far army counts within reach");
		});
	});

	describe("switching defense armies over", () =>
	{
		/** the default defense setup: one target, one army, a draggable unit list */
		function defenseWorld(options: WorldOptions = {}): {
			world: World;
			manager: AttackManager;
			target: CommonEntity;
			army: DefenseArmy;
		}
		{
			const world = makeWorld(options);
			const manager = makeManager(world, worldConfig(world));
			const target = world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40],
				classes: ["Structure"] }));
			const army = armyStub(5, [3100], []);
			world.ai.HQ.defenseManager.armies.push(army);
			return { world, manager, target, army };
		}

		/** a defender standing near the threat */
		function defender(world: World, id: number): CommonEntity
		{
			return world.addEntity(makeEntity({
				id, "owner": PLAYER, "position": [19, 19], "classes": ["Unit"]
			}));
		}

		it("refuses a call without a target, without a position, or without a plan of action", () =>
		{
			const { world, manager, target } = defenseWorld();
			const blur = makeWorld().addEntity(makeEntity({ id: 5001, owner: ENEMY, classes: ["Structure"] }));

			assert.equal(manager.switchDefenseToAttack(world.gameState, fake<CommonEntity>(undefined), { "range": 5 }), false,
				"no target, no attack");
			assert.equal(manager.switchDefenseToAttack(world.gameState, blur, { "range": 5 }), false,
				"no position, no attack");
			assert.equal(manager.switchDefenseToAttack(world.gameState, target, {}), false,
				"neither range nor army id");
			assert.ok(logs.some((entry) => /inconsistent data/.test(entry)), `the misuse was logged: ${logs.join(" | ")}`);
		});

		// artificial world: defense plans carry no target, so only the rally-point
		// failure can hit them, and an AI under attack always has positioned
		// defenders — unreachable in a real game
		it("refuses when the plan cannot rally", () =>
		{
			const { world, manager, target } = defenseWorld();
			world.bases[0].anchor = undefined;
			world.removeEntity(1000);

			assert.equal(manager.switchDefenseToAttack(world.gameState, target, { "range": 70 }), false,
				"no base, no rallying");
			assert.equal(manager.startedAttacks["Attack"].length, 0, "no plan was kept either");
		});

		it("marches a nearby army off to the threat as a new attack", () =>
		{
			const { world, manager, target, army } = defenseWorld();
			const joiner = defender(world, 1200);
			army.ownEntities = [entityId(1200)];

			assert.equal(manager.switchDefenseToAttack(world.gameState, target, { "range": 70 }), true,
				"the army was handed over");
			const plan = manager.startedAttacks["Attack"][0];
			assert.equal(plan.name, 0, "named by the running counter");
			assert.equal(plan.targetPlayer, ENEMY, "aimed at the raider");
			assert.deepEqual(plan.targetPos, [30, 40], "aimed at the raider's spot");
			assert.equal(plan.target, target, "and at the raider itself");
			assert.equal(plan.state, "arrived", "the army stands ready");
			assert.equal(plan.unitCollection.hasEntId(entityId(1200)), true, "the defender joined the plan");
			assert.equal(joiner.getMetadata(PLAYER, "plan"), 0, "marked by the plan");
			assert.equal(joiner.getMetadata(PLAYER, "role"), "attack", "and role-attacked");
			assert.equal(army.foeEntities.length, 0, "the foes were handed over too");
			assert.equal(army.ownEntities.length, 0, "and the army was emptied");
			assert.equal(manager.totalNumber, 1, "the counter moved on");
		});

		it("keeps armies beyond the call at home", () =>
		{
			const { world, manager, target, army } = defenseWorld();
			army.foePosition = worldPos(90, 90);
			army.ownEntities = [entityId(1200)];
			defender(world, 1200);

			assert.equal(manager.switchDefenseToAttack(world.gameState, target, { "range": 5 }), false,
				"out of reach, no handover");
			assert.deepEqual(army.foeEntities, [3100], "the foes were untouched");
			assert.deepEqual(army.ownEntities, [1200], "the defenders were untouched");
		});

		it("hands over exactly the army the call named", () =>
		{
			const { world, manager, target, army } = defenseWorld();
			army.ownEntities = [entityId(1200)];
			defender(world, 1200);
			const neighbour = armyStub(6, [3200], [1300]);
			world.ai.HQ.defenseManager.armies.push(neighbour);
			defender(world, 1300);

			assert.equal(manager.switchDefenseToAttack(world.gameState, target,
				{ "armyID": 6, "uniqueTarget": true }), true, "the named army was handed over");
			const plan = manager.startedAttacks["Attack"][0];
			assert.equal(plan.uniqueTargetId, 5000, "the attack holds only this target");
			assert.deepEqual(neighbour.foeEntities, [], "the named army was drained");
			assert.equal(neighbour.ownEntities.length, 0, "its defenders joined");
			assert.deepEqual(army.foeEntities, [3100], "the other army stands untouched");
			assert.deepEqual(army.ownEntities, [1200], "with its defenders at home");
		});

	// only the port passes: it skips units that left the world mid-drain
	// (the original dereferences the missing unit and throws)
	it("enlists only joinable defenders", () =>
		{
			const { world, manager, target, army } = defenseWorld();
			army.ownEntities = [entityId(1200), entityId(1202), entityId(1203), entityId(1204)];
			defender(world, 1200);
			// 1202 carries a transport mark: the code drains it but never enlists it
			world.addEntity(makeEntity({ id: 1202, owner: PLAYER, position: [19, 19], classes: ["Unit"] },
				{}, { "transport": 4 }));
			// 1203 rides inside a transport and has no position of its own
			world.addEntity(makeEntity({ id: 1203, owner: PLAYER, classes: ["Unit"] }));
			// 1204 has left the world by the time the plan asks for it

			assert.equal(manager.switchDefenseToAttack(world.gameState, target, { "range": 70 }), true,
				"the joinable defender made the attack");
			const plan = manager.startedAttacks["Attack"][0];
			assert.equal(plan.unitCollection.hasEntId(entityId(1200)), true, "the plain defender joined");
			assert.equal(plan.unitCollection.hasEntId(entityId(1202)), false, "the transport-marked defender was drained but stayed home");
			assert.equal(plan.unitCollection.hasEntId(entityId(1203)), false, "the positionless defender stayed home");
			assert.equal(plan.unitCollection.hasEntId(entityId(1204)), false, "the vanished defender was skipped");
		});

		it("bails out when no defender can join", () =>
		{
			const { world, manager, target, army } = defenseWorld();

			assert.equal(manager.switchDefenseToAttack(world.gameState, target, { "range": 70 }), false,
				"nobody to hand over");
			assert.equal(army.foeEntities.length, 0, "the foes were still handed back");
			// an artifact worth knowing: the aborted plan stays in the started roster
			assert.equal(manager.startedAttacks["Attack"].length, 1, "the aborted plan was kept in the roster");
		});
	});

	describe("saving and restoring", () =>
	{
		it("round-trips the counters and both whole rosters", () =>
		{
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			const waiting = new AttackPlan(world.gameState, world.ai.Config, 7, "Rush", { "targetSize": 6 }, false);
			waiting.init(world.gameState);
			manager.upcomingAttacks["Rush"].push(waiting);
			const marching = new AttackPlan(world.gameState, world.ai.Config, 8, "Attack", undefined, false);
			marching.init(world.gameState);
			manager.startedAttacks["Attack"].push(marching);
			manager.totalNumber = 5;
			manager.attackNumber = 3;
			manager.rushNumber = 1;
			manager.raidNumber = 2;
			manager.maxRushes = 2;
			manager.rushSize = [18, 22];
			manager.currentEnemyPlayer = playerId(2);
			manager.defeated = { 3: true };
			const saved = manager.Serialize();

			const fresh = makeWorld();
			// as the bot loads: the queue manager first, with the plans' queues
			fresh.ai.queueManager.Deserialize(fresh.gameState, world.ai.queueManager.Serialize());
			fresh.ai.queues = fresh.ai.queueManager.queues;
			const restored = makeManager(fresh, worldConfig(fresh));
			restored.Deserialize(fresh.gameState, saved);

			assert.equal(restored.totalNumber, 5, "the counters came back");
			assert.equal(restored.attackNumber, 3);
			assert.equal(restored.rushNumber, 1);
			assert.equal(restored.raidNumber, 2);
			assert.deepEqual(restored.rushSize, [18, 22]);
			assert.equal(restored.maxRushes, 2);
			assert.equal(restored.currentEnemyPlayer, 2, "the remembered foe came back");
			assert.deepEqual(restored.defeated, { 3: true }, "the losses came back");
			assert.equal(restored.upcomingAttacks["Rush"].length, 1, "the waiting plan came back");
			assert.equal(restored.upcomingAttacks["Rush"][0].name, 7,
				"under its own name");
			assert.equal(restored.startedAttacks["Attack"].length, 1, "the marching plan came back");
			assert.equal(restored.startedAttacks["Attack"][0].name, 8,
				"under its own name");
			assert.equal(restored.upcomingAttacks["Attack"].length, 0, "the empty rosters stayed empty");
			assert.equal(restored.startedAttacks["Rush"].length, 0, "the empty rosters stayed empty");
		});
	});
	// @@MORE@@
});
