/**
 * AttackManager: how Petra decides *when* to attack and whom to attack: the
 * rushes, the main attacks and raids it makes, the allies it answers, the foe
 * it picks. Running the plans is the town's attacks' (attackDesk.test.ts),
 * the siege sent to bomb meanwhile the bombardment's (bombardment.test.ts).
 *
 * The rosters are often driven with plain plan stubs, so a test pins down
 * exactly one branch of the cycle; the plans themselves (and their
 * preparations, unit collections and saves) were measured in attackPlan.test.
 * Plans the manager creates itself are real AttackPlans, so their creation
 * goes through the same world the game would give them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	COMPLETING,
	addFoe,
	configFor,
	desk,
	freshManager,
	makeManager,
	planStub,
	worldConfig,
} from "./harness/attackSeat.ts";
import { logs, resetRecorder, sent } from "./harness/engine.ts";
import { emptyEvents, makeEntity, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import { ENEMY, GAIA, PLAYER, makeWorld, type World, type WorldOptions } from "./harness/world.ts";

import { entityId, playerId } from "../adapter/brands.ts";
import { AttackManager } from "../decision/attackManager.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { QueueManager } from "../execution/queueManager.ts";
import { SANDBOX } from "../world/difficultyLevel.ts";

describe("attack manager", () =>
{
	describe("sizing the rushes", () =>
	{
		it("gives three heavy rushes to a very aggressive commander", () =>
		{
			const manager = freshManager(configFor(0.8));
			manager.setRushes(3);
			assert.equal(manager.maxRushes, 3);
			assert.deepEqual(manager.rushSize, [16, 20, 24]);
		});

		it("gives two rushes to a strong-enough commander with room", () =>
		{
			const manager = freshManager(configFor(0.6));
			manager.setRushes(2);
			assert.equal(manager.maxRushes, 2);
			assert.deepEqual(manager.rushSize, [18, 22]);
		});

		it("gives one rush to a mild commander", () =>
		{
			const manager = freshManager(configFor(0.4));
			manager.setRushes(1);
			assert.equal(manager.maxRushes, 1);
			assert.deepEqual(manager.rushSize, [20]);
		});

		it("keeps the rush count when neither temper nor allowance allow them", () =>
		{
			const manager = freshManager(configFor(0.9));
			manager.setRushes(0);
			assert.equal(manager.maxRushes, 0, "no allowance for a strong temper");
			assert.deepEqual(manager.rushSize, [], "and no rush sizes to spend");
			const mild = freshManager(configFor(0.1));
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
			events.PlayerDefeated.push({ playerId: playerId(3) });
			manager.checkEvents(world.gameState, events);
			assert.deepEqual(manager.defeated, { 3: true });
		});

		it("ignores a request from our own commander, a stranger and a friendly player", () =>
		{
			resetRecorder();
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ source: PLAYER, player: playerId(3) }, {
				source: playerId(3),
				player: playerId(2),
			}, { source: playerId(3), player: playerId(1) });
			const roster = desk(manager).upcomingAttacks["Rush"];
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
			events.AttackRequest.push({ source: playerId(3), player: playerId(2) });
			const rush = planStub({ name: 4, targetPlayer: 2, units: 2, state: COMPLETING });
			desk(manager).upcomingAttacks["Rush"].push(rush);

			manager.checkEvents(world.gameState, events);
			assert.equal(rush.forceStartCalls, 0, "the attack is not forced");
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, 2, "the prey was named");
			assert.ok(
				/enough soldiers|strengthen my army/.test(message.message),
				`the decline was told: ${message.message}`,
			);
		});

		it("points the ally at the enemy we are already fighting, when we cannot help", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			world.gameState.playerData.isEnemy[4] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ source: playerId(3), player: playerId(2) });
			desk(manager).upcomingAttacks["Attack"].push(
				planStub({ name: 4, targetPlayer: 4, units: 3, state: COMPLETING }),
			);

			manager.checkEvents(world.gameState, events);
			const [message] = sent("aichat");
			assert.deepEqual(
				message.parameters,
				{ _player_: 2, _player_2: 4 },
				"the ally learned where our forces are",
			);
		});

		it("aims its idle armies at the asked player, and forces them once twelve stand ready", () =>
		{
			resetRecorder();
			const world = makeWorld();
			world.gameState.playerData.isAlly[3] = true;
			const manager = makeManager(world, worldConfig(world));
			const events = emptyEvents();
			events.AttackRequest.push({ source: playerId(3), player: playerId(2) });
			const small = planStub({ name: 3, units: 2 });
			const medium = planStub({ name: 4, units: 5 });
			const large = planStub({ name: 5, units: 9 });
			const completing = planStub({ name: 6, units: 9, state: COMPLETING, targetPlayer: 2 });
			const away = planStub({ name: 7, units: 9, targetPlayer: GAIA });
			desk(manager).upcomingAttacks["Rush"].push(small, medium, large, completing, away);

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
			events.AttackRequest.push({ source: playerId(3), player: playerId(2) }, {
				source: playerId(3),
				player: playerId(4),
			});
			desk(manager).upcomingAttacks["Rush"].push(planStub({ name: 4, units: 9 }));

			manager.checkEvents(world.gameState, events);
			assert.equal(sent("aichat").length, 1, "a single answer");
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, 2, "only the first request's prey");
		});
	});
	describe("keeping the exiles apart", () =>
	{
		it("keeps the units a previous attack dropped for the next muster", () =>
		{
			const world = makeWorld();
			world.addEntity(
				makeEntity({ id: 1200, owner: PLAYER, position: [11, 12], classes: ["Unit"] }, {}, { plan: -1 }),
			);
			world.addEntity(
				makeEntity({ id: 1201, owner: PLAYER, position: [11, 12], classes: ["Unit"] }, {}, { plan: 8 }),
			);
			const manager = makeManager(world, worldConfig(world));

			assert.equal(manager.outOfPlan.hasEntId(entityId(1200)), true, "the dropped unit was kept");
			assert.equal(manager.outOfPlan.hasEntId(entityId(1201)), false, "an enlisted unit is not an exile");
		});
	});

	describe("creating plans during update", () =>
	{
		/** the world and manager a creation test starts from */
		function creationWorld(options: WorldOptions = {}): { world: World; manager: AttackManager; }
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
			world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((entry) => entry.includes("Rushing plan 0 with maxRushes 1")),
				`the rush was logged: ${logs.join(" | ")}`,
			);
			assert.equal(desk(manager).upcomingAttacks["Rush"].length, 1, "one fresh rush waits");
			const plan = desk(manager).upcomingAttacks["Rush"][0];
			assert.equal(plan.name, 0, "named by the running counter");
			assert.equal(plan.type, "Rush", "and typed as a rush");
			assert.equal(desk(manager).totalNumber, 1, "the counter moved on");
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
			assert.equal(desk(manager).upcomingAttacks["Rush"].length, 0, "no plan was enlisted");
			assert.equal(manager.rushNumber, 1, "but the credit was spent");
			assert.equal(desk(manager).totalNumber, 0, "and the counter untouched");
		});

		it("raises a default attack once phase two stands and no other attack waits", () =>
		{
			resetRecorder();
			const world = makeWorld({ phase: 2, debug: 2 });
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((entry) => entry.includes("Creating the plan Attack  0")),
				`the creation was logged: ${logs.join(" | ")}`,
			);
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 1, "a default attack waits in preparation");
			const plan = desk(manager).upcomingAttacks["Attack"][0];
			assert.equal(plan.type, "Attack", "the first two attacks are default ones");
			assert.equal(manager.attackNumber, 1, "the attack counter moved on");
		});

		it("swells into a HugeAttack once two default attacks have been spent", () =>
		{
			const { world, manager } = creationWorld({ phase: 2 });
			world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);
			manager.attackNumber = 2;

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(desk(manager).upcomingAttacks["HugeAttack"].length, 1, "a huge attack waits in preparation");
			const plan = desk(manager).upcomingAttacks["HugeAttack"][0];
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
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 0, "no plan was enlisted");
			assert.equal(manager.attackNumber, 1, "but the credit was spent");
		});

		it("waits for the phase-two tech to be underway before attacking", () =>
		{
			const idle = creationWorld({ phaseName: "phase.town" });
			idle.world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);
			idle.manager.update(idle.world.gameState, idle.world.ai.queues, emptyEvents());
			assert.equal(desk(idle.manager).upcomingAttacks["Attack"].length, 0, "no tech, no attack");

			const researching = creationWorld({ phaseName: "phase.town", researching: ["phase.town"] });
			researching.world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);
			researching.manager.update(researching.world.gameState, researching.world.ai.queues, emptyEvents());
			assert.equal(
				desk(researching.manager).upcomingAttacks["Attack"].length,
				1,
				"the tech underway, the attack comes",
			);
		});

		it("attacks whatever happens when no base could ever rise again", () =>
		{
			const idle = creationWorld();
			idle.manager.update(idle.world.gameState, idle.world.ai.queues, emptyEvents());
			assert.equal(desk(idle.manager).upcomingAttacks["Attack"].length, 0, "with a potential base, patience");

			const desperate = creationWorld({ hasPotentialBase: false });
			desperate.manager.update(desperate.world.gameState, desperate.world.ai.queues, emptyEvents());
			assert.equal(desk(desperate.manager).upcomingAttacks["Attack"].length, 1, "nothing else to do than attack");
			assert.equal(desperate.manager.attackNumber, 1, "and the attack counter moved on");
		});

		it("caps the running attacks by the town's population allowance", () =>
		{
			const capped = creationWorld({ phase: 2, populationMax: 40 });
			capped.world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);
			desk(capped.manager).startedAttacks["Attack"].push(planStub({ name: 2 }));

			capped.manager.update(capped.world.gameState, capped.world.ai.queues, emptyEvents());
			assert.equal(
				desk(capped.manager).upcomingAttacks["Attack"].length,
				0,
				"one running attack fills a small town",
			);

			const roomy = creationWorld({ phase: 2 });
			roomy.world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);
			desk(roomy.manager).startedAttacks["Attack"].push(planStub({ name: 2 }));

			roomy.manager.update(roomy.world.gameState, roomy.world.ai.queues, emptyEvents());
			assert.equal(
				desk(roomy.manager).upcomingAttacks["Attack"].length,
				1,
				"a big town supports a second attack",
			);
		});

		it("makes a raid on the threat the defense manager spotted", () =>
		{
			const { world, manager } = creationWorld({ enemyPlayer: ENEMY });
			const threat = world.addEntity(
				makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }),
			);
			world.ai.HQ.defenseManager.targetList.push(entityId(5000));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(desk(manager).upcomingAttacks["Raid"].length, 1, "a raid waits in preparation");
			const plan = desk(manager).upcomingAttacks["Raid"][0];
			assert.equal(plan.type, "Raid", "typed as a raid");
			assert.equal(plan.target, threat, "aimed at the spotted threat");
			assert.equal(manager.raidNumber, 1, "the raid credit was spent");
			assert.equal(desk(manager).totalNumber, 1, "and the counter moved on");
		});

		it("skips lost names and friendly owners in the raid scan", () =>
		{
			const { world, manager } = creationWorld();
			world.addEntity(makeEntity({ id: 5001, owner: PLAYER, position: [30, 40], classes: ["Structure"] }));
			world.ai.HQ.defenseManager.targetList.push(entityId(99), entityId(5001));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(desk(manager).upcomingAttacks["Raid"].length, 0, "no raid was planned");
			assert.equal(manager.raidNumber, 0, "and no credit spent");
		});

		it("gives up on a raid whose target is sealed on another island", () =>
		{
			// the real in-game failure path: the defense army spots a threat on a
			// naval map, but no sea lane connects our land to theirs
			resetRecorder();
			const { world, manager } = creationWorld({ enemyPlayer: ENEMY, navalMap: true });
			world.addEntity(
				makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }, {}, { access: 3 }),
			);
			world.ai.HQ.defenseManager.targetList.push(entityId(5000));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((entry) => entry.includes("has an inaccessible target")),
				`the missing sea lane was logged: ${logs.join(" | ")}`,
			);
			assert.equal(desk(manager).upcomingAttacks["Raid"].length, 0, "no raid was planned");
			assert.equal(manager.raidNumber, 0, "and no credit spent");
		});

		it("polls the bombers every fifth turn on a hard-enough difficulty", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			world.ai.playedTurn = 5;
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(
				makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] }, {
					footprintRadius: () => 2,
				}),
			);
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 60 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
				}),
			);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(
				manager.bombing.bombingAttacks.get(entityId(5000))?.has(entityId(1100)),
				true,
				"the idle bomber was enrolled",
			);
		});

		it("leaves the bombers alone on other turns and on easy difficulties", () =>
		{
			const otherTurn = makeWorld({ enemyPlayer: ENEMY });
			otherTurn.ai.playedTurn = 6;
			const manager = makeManager(otherTurn, worldConfig(otherTurn));
			otherTurn.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] }));
			otherTurn.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 60 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
				}),
			);

			manager.update(otherTurn.gameState, otherTurn.ai.queues, emptyEvents());
			assert.equal(manager.bombing.bombingAttacks.size, 0, "no polling off the fifth turn");

			const easy = makeWorld({ enemyPlayer: ENEMY, difficulty: SANDBOX });
			easy.ai.playedTurn = 5;
			const easyManager = makeManager(easy, worldConfig(easy));
			easy.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [40, 40], classes: ["Structure"] }));
			easy.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 60 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
				}),
			);

			easyManager.update(easy.gameState, easy.ai.queues, emptyEvents());
			assert.equal(easyManager.bombing.bombingAttacks.size, 0, "no polling on the easiest difficulty");
		});
	});

	describe("picking the foe", () =>
	{
		function foeWorld(options: WorldOptions = {}): { world: World; manager: AttackManager; }
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
			{
				world.addEntity(
					makeEntity({ id: 6000 + i, owner: ENEMY, position: [30 + i, 40], classes: ["Structure", "Tower"] }),
				);
			}

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
			world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] }),
			);
			world.addEntity(
				makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] }),
			);

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "the nearer centre won");
			assert.equal(manager.currentEnemyPlayer, ENEMY, "and was remembered");
		});

		it("cannot be lured to a centre across the sea when a land neighbour waits", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] }),
			);
			// the overseas centre: on another land, so out of reach for a ground army
			world.addEntity(
				makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] }, {}, {
					access: 3,
				}),
			);

			const attack = planStub({ name: 3 });
			assert.equal(manager.getEnemyPlayer(world.gameState, attack), ENEMY, "the overseas centre was ignored");
		});

		it("targets the strongest enemy when no centre can be reached by land", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			// the enemy's centre sits on another land: out of the centre chase
			world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"] }, {}, {
					access: 3,
				}),
			);
			world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [31, 40], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 2101, owner: ENEMY, position: [32, 40], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3100, owner: 3, position: [80, 95], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3101, owner: 3, position: [81, 95], classes: ["Unit"] }));
			world.addEntity(makeEntity({ id: 3102, owner: 3, position: [82, 95], classes: ["Unit"] }));

			const attack = planStub({ name: 3 });
			assert.equal(
				manager.getEnemyPlayer(world.gameState, attack),
				ENEMY,
				"the civ centre outweighed the extra unit",
			);
			assert.equal(manager.currentEnemyPlayer, ENEMY, "and was remembered");
		});

		it("skips the centre chase and the remembered foe for a huge attack", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }));
			world.addEntity(
				makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "CivCentre"] }),
			);
			for (let i = 0; i < 10; ++i)
			{
				world.addEntity(
					makeEntity({ id: 3100 + i, owner: 3, position: [80 + i * 0.4, 95], classes: ["Unit"] }),
				);
			}
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
			building.world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "Wonder"] }, {
					foundationProgress: () => 40,
				}),
			);
			building.world.addEntity(
				makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "Wonder"] }, {
					foundationProgress: () => 80,
				}),
			);
			const attack = planStub({ name: 3 });
			assert.equal(
				building.manager.getEnemyPlayer(building.world.gameState, attack),
				3,
				"the more advanced wonder won",
			);
			assert.equal(building.manager.currentEnemyPlayer, 3, "and was remembered");

			const finished = foeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder"] });
			addFoe(finished.world, 3);
			finished.world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "Wonder"] }, {
					foundationProgress: () => 40,
				}),
			);
			finished.world.addEntity(
				makeEntity({ id: 2001, owner: 3, position: [80, 95], classes: ["Structure", "Wonder"] }),
			); // completed: no progress at all
			assert.equal(
				finished.manager.getEnemyPlayer(finished.world.gameState, planStub({ name: 3 })),
				3,
				"a finished wonder wins outright",
			);
		});

		it("leaves a gaia wonder alone and falls back to the usual choice", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder"] });
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(
				makeEntity({ id: 2000, owner: GAIA, position: [30, 40], classes: ["Structure", "Wonder"] }, {
					foundationProgress: () => 40,
				}),
			);
			world.addEntity(makeEntity({ id: 5000, owner: ENEMY, position: [80, 95], classes: ["Structure"] }));

			const attack = planStub({ name: 3 });
			assert.equal(
				manager.getEnemyPlayer(world.gameState, attack),
				ENEMY,
				"the wonder was ignored, the usual choice stands",
			);
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
			{
				world.addEntity(
					makeEntity({ id: 4100 + i, owner: GAIA, position: [50 + i, 50], classes: ["Unit", "Relic"] }),
				);
			}

			// the picker itself does name gaia, and resets the gaia-relic plan
			const attack = planStub({ name: 3, targetPlayer: 3 }); // an aim already chosen
			assert.equal(manager.getRelicEnemyPlayer(world.gameState, attack), 0, "gaia's hoard won");
			assert.equal(world.relicResets.length, 1, "the gaia-relic plan was reset");
			assert.equal(manager.currentEnemyPlayer, undefined, "a plan with an aim keeps its own");

			// but the caller's `relicPick || wonderPick` swallows gaia's 0 on its own return:
			// gaia steers later plans only through the remembered-target branch
			assert.equal(
				manager.getEnemyPlayer(world.gameState, planStub({ name: 4 })),
				0,
				"the remembered gaia pick still steers later plans",
			);
		});

		it("mixes a wonder and a relic aim by chance", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY, victoryConditions: ["wonder", "capture_the_relic"] });
			addFoe(world, 3);
			const manager = makeManager(world, worldConfig(world));
			world.addEntity(
				makeEntity({ id: 2000, owner: ENEMY, position: [30, 40], classes: ["Structure", "Wonder"] }),
			);
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
				assert.equal(
					manager.getEnemyPlayer(world.gameState, planStub({ name: 4 })),
					3,
					"chance switched to the relic hoard",
				);
			}
			finally
			{
				restoreEngine();
			}
		});
	});

	describe("saving and restoring", () =>
	{
		it("round-trips the counters, and the town both whole rosters", () =>
		{
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			const waiting = AttackPlan.create(world.gameState, world.ai.Config, 7, "Rush", { targetSize: 6 });
			assert.ok(waiting);
			desk(manager).upcomingAttacks["Rush"].push(waiting);
			const marching = AttackPlan.create(world.gameState, world.ai.Config, 8, "Attack");
			assert.ok(marching);
			desk(manager).startedAttacks["Attack"].push(marching);
			desk(manager).totalNumber = 5;
			manager.attackNumber = 3;
			manager.rushNumber = 1;
			manager.raidNumber = 2;
			manager.maxRushes = 2;
			manager.rushSize = [18, 22];
			manager.currentEnemyPlayer = playerId(2);
			manager.defeated = { 3: true };
			const saved = manager.Serialize();
			// the plans are saved with the town
			const savedPlans = desk(manager).Serialize();

			const fresh = makeWorld();
			// as the bot loads: the queue manager first, with the plans' queues
			fresh.ai.queueManager = QueueManager.restore(
				fresh.ai.Config,
				fresh.gameState,
				world.ai.queueManager.Serialize(),
			);
			fresh.ai.queues = fresh.ai.queueManager.queues;
			const restored = AttackManager.restore(worldConfig(fresh), fresh.gameState, saved, fresh.ai.HQ);
			fresh.ai.HQ.attackManager = restored;
			// as the town resumes them, once the managers are restored
			restored.desk.resume(fresh.gameState, savedPlans, fresh.ai.HQ.canBuildUnits);

			assert.equal(desk(restored).totalNumber, 5, "the counters came back");
			assert.equal(restored.attackNumber, 3);
			assert.equal(restored.rushNumber, 1);
			assert.equal(restored.raidNumber, 2);
			assert.deepEqual(restored.rushSize, [18, 22]);
			assert.equal(restored.maxRushes, 2);
			assert.equal(restored.currentEnemyPlayer, 2, "the remembered foe came back");
			assert.deepEqual(restored.defeated, { 3: true }, "the losses came back");
			assert.equal(desk(restored).upcomingAttacks["Rush"].length, 1, "the waiting plan came back");
			assert.equal(desk(restored).upcomingAttacks["Rush"][0].name, 7, "under its own name");
			assert.equal(desk(restored).startedAttacks["Attack"].length, 1, "the marching plan came back");
			assert.equal(desk(restored).startedAttacks["Attack"][0].name, 8, "under its own name");
			assert.equal(desk(restored).upcomingAttacks["Attack"].length, 0, "the empty rosters stayed empty");
			assert.equal(desk(restored).startedAttacks["Rush"].length, 0, "the empty rosters stayed empty");
		});
	});
	// @@MORE@@
});
