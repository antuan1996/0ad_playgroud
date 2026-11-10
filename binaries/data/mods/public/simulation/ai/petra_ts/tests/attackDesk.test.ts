/**
 * The town's attacks (execution/attackDesk.ts): the attack plans run each
 * turn — prepared, started, aborted, closed —, found by name, paused, called
 * off against a new ally and counted around a spot; defense armies turned to
 * an attack; and the soldiers a leaving plan leaves to fight beside enemies.
 * The desk is the attack manager's (tests/harness/attackSeat.ts), which runs
 * it in its turn; the plans are often stubs answering every question.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	COMPLETING,
	FAILED,
	START,
	configFor,
	desk,
	freshManager,
	makeManager,
	planStub,
	worldConfig,
} from "./harness/attackSeat.ts";
import { logs, resetRecorder, sent } from "./harness/engine.ts";
import { emptyEvents, fake, makeEntity } from "./harness/fakes.ts";
import { ENEMY, PLAYER, makeWorld, type World, type WorldOptions } from "./harness/world.ts";

import { attackPlanId, entityId, landRegion, playerId, worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import { AttackManager } from "../decision/attackManager.ts";
import type { ArmyRelease } from "../execution/attackDesk.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { EnemyLands } from "../world/enemyLands.ts";

describe("the town's attacks", () =>
{
	describe("walking the attack cycle", () =>
	{
		/** a world whose manager walks one update with the given roster contents */
		function cycleWorld(debug = 0): { world: World; manager: AttackManager; }
		{
			const world = makeWorld({ debug });
			const manager = makeManager(world, worldConfig(world));
			return { world, manager };
		}

		it("dumps both rosters in debug splendour before the cycle", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(3);
			desk(manager).upcomingAttacks["Attack"].push(planStub({ name: 5, units: 4, state: COMPLETING }));
			desk(manager).startedAttacks["Rush"].push(planStub({ name: 7, units: 6, state: "walking" }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(logs.some((line) => line.includes(" upcoming attacks =================")), "the dump opened");
			assert.ok(
				logs.some((line) => line.includes(" plan 5 type Attack state completing units 4")),
				`the waiting plan was listed: ${logs.join(" | ")}`,
			);
			assert.ok(
				logs.some((line) => line.includes(" started attacks ==================")),
				"the second dump opened",
			);
			assert.ok(
				logs.some((line) => line.includes(" plan 7 type Rush state walking units 6")),
				"the walking plan was listed",
			);
			assert.equal(desk(manager).debugTime, 100, "the next dump waits another minute");
		});

		it("dumps nothing when the last dump is still fresh", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(3);
			desk(manager).debugTime = 100;

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.deepEqual(logs, [], "the rosters stayed unlisted");
		});

		it("grumbles about an upcoming plan that already started", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld();
			desk(manager).upcomingAttacks["Attack"].push(planStub({ name: 5, alreadyStarted: true }));

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((line) => /Petra problem in attackManager/.test(line)),
				`the grumble was logged: ${logs.join(" | ")}`,
			);
		});

		it("keeps a preparing attack warm for the next turn", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, units: 5 });
			desk(manager).upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.checkEventsCalls, 1, "the plan heard the turn's events");
			assert.equal(attack.updatePreparationCalls, 1, "the plan prepared once");
			assert.equal(attack.abortCalls, 0, "nothing aborted");
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 1, "the plan is kept");
		});

		it("does not raise a fresh rush while one already waits half-mustered", () =>
		{
			const world = makeWorld();
			const manager = makeManager(world, worldConfig(world));
			manager.maxRushes = 2;
			manager.rushSize = [20, 20];
			desk(manager).upcomingAttacks["Rush"].push(planStub({ name: 3 }));
			world.addEntity(
				makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Barracks"] }),
			);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(desk(manager).upcomingAttacks["Rush"].length, 1, "no second rush");
			assert.equal(manager.rushNumber, 0, "the credit was not spent either");
		});

		it("aborts a preparation that failed", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const attack = planStub({ name: 3, preparation: FAILED });
			desk(manager).upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((line) => line.includes("Attack Manager: Attack plan 3 aborted.")),
				`the abort was logged: ${logs.join(" | ")}`,
			);
			assert.equal(attack.abortCalls, 1, "the plan was told");
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 0, "the roster forgot it");
		});

		it("launches a ready plan and announces the campaign", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const attack = planStub({ name: 3, preparation: START, targetPlayer: ENEMY });
			desk(manager).upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((line) => line.includes("Attack Manager: Starting Attack plan 3")),
				`the start was logged: ${logs.join(" | ")}`,
			);
			const [message] = sent("aichat");
			assert.equal(message.parameters?._player_, ENEMY, "the prey was announced");
			assert.ok(/launching|sent|sending/.test(message.message), `the campaign was told: ${message.message}`);
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "the plan now marches");
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 0, "and left the preparation roster");
		});

		it("skips the announcement when chatter is off", () =>
		{
			resetRecorder();
			const world = makeWorld({ debug: 1 });
			const manager = makeManager(world, worldConfig(world, { chat: false }));
			desk(manager).upcomingAttacks["Attack"].push(
				planStub({ name: 3, preparation: START, targetPlayer: ENEMY }),
			);
			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.deepEqual(sent("aichat"), [], "chatter off, no announcement");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "but the plan still marched");
		});

		it("aborts an attack whose start attempt failed", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, preparation: START, startable: false });
			desk(manager).upcomingAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.abortCalls, 1, "the plan was aborted");
			assert.equal(desk(manager).upcomingAttacks["Attack"].length, 0, "and forgotten");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 0, "without ever marching");
		});

		it("skips the started update of a paused plan", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, remaining: 0, paused: true });
			desk(manager).startedAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.checkEventsCalls, 1, "the plan heard the turn's events");
			assert.equal(attack.abortCalls, 0, "the pause shielded it from its empty verdict");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "the plan is kept");
		});

		it("retires an attack that came back empty, be it zero or false", () =>
		{
			resetRecorder();
			const { world, manager } = cycleWorld(2);
			const spent = planStub({ name: 3, remaining: 0 });
			const dissolved = planStub({ name: 4, remaining: false });
			desk(manager).startedAttacks["Attack"].push(spent, dissolved);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.ok(
				logs.some((entry) => entry.includes("Attack plan 3 is finished with remaining 0")),
				`the retirement was logged: ${logs.join(" | ")}`,
			);
			assert.equal(spent.abortCalls, 1, "the spent plan was aborted");
			assert.equal(dissolved.abortCalls, 1, "the dissolved plan was aborted too");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 0, "the roster forgot both");
		});

		it("keeps an attack whose army survives", () =>
		{
			const { world, manager } = cycleWorld();
			const attack = planStub({ name: 3, remaining: 1 });
			desk(manager).startedAttacks["Attack"].push(attack);

			manager.update(world.gameState, world.ai.queues, emptyEvents());
			assert.equal(attack.abortCalls, 0, "nothing aborted");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "the plan is kept");
		});
	});

	describe("roster helpers", () =>
	{
		it("finds a plan by its name in either roster", () =>
		{
			const manager = freshManager(configFor(0.5));
			const preparing = planStub({ name: 3 });
			const marching = planStub({ name: 9 });
			desk(manager).upcomingAttacks["Rush"].push(preparing);
			desk(manager).startedAttacks["Attack"].push(marching);

			assert.equal(desk(manager).getPlan(attackPlanId(3)), preparing, "found among the preparing");
			assert.equal(desk(manager).getPlan(attackPlanId(9)), marching, "found among the marching");
			assert.equal(desk(manager).getPlan(attackPlanId(50)), undefined, "nothing under that name");
		});

		it("pauses exactly the named plan, or every plan at once", () =>
		{
			const manager = freshManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			const c = planStub({ name: 5 });
			desk(manager).upcomingAttacks["Rush"].push(a, b);
			desk(manager).startedAttacks["Attack"].push(c);

			desk(manager).pausePlan(attackPlanId(4));
			assert.deepEqual(b.pauses, [true], "the named plan was paused");
			assert.deepEqual(a.pauses, [], "the rest was untouched");

			desk(manager).pauseAllPlans();
			assert.deepEqual(a.pauses, [true]);
			assert.deepEqual(b.pauses, [true, true], "already paused stays paused");
			assert.deepEqual(c.pauses, [true]);

			desk(manager).unpauseAllPlans();
			assert.equal(a.paused, false);
			assert.equal(b.paused, false);
			assert.equal(c.paused, false);
		});

		it("tells which attack is being prepared", () =>
		{
			const manager = freshManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			desk(manager).upcomingAttacks["Attack"].push(a, b);

			assert.equal(desk(manager).getAttackInPreparation("Attack"), a, "the first in line");
			assert.equal(desk(manager).getAttackInPreparation("Rush"), undefined, "no rush in preparation");
		});

		it("unpauses exactly the named plan", () =>
		{
			const manager = freshManager(configFor(0.5));
			const a = planStub({ name: 3 });
			const b = planStub({ name: 4 });
			desk(manager).upcomingAttacks["Rush"].push(a, b);

			desk(manager).pauseAllPlans();
			desk(manager).unpausePlan(attackPlanId(4));
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
			desk(manager).upcomingAttacks["Rush"].push(preparing);
			desk(manager).startedAttacks["Attack"].push(marching, other);

			desk(manager).cancelAttacksAgainstPlayer(world.gameState, playerId(3));
			assert.equal(preparing.targetPlayer, undefined, "the preparation lost its aim");
			assert.equal(marching.abortCalls, 1, "the marching attack was aborted");
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "and removed from the roster");
			assert.equal(other.abortCalls, 0, "another foe is untouched");
		});

		it("counts the troops of our marching armies around a point", () =>
		{
			const manager = freshManager(configFor(0.5));
			desk(manager).startedAttacks["Attack"].push(
				planStub({ name: 3, units: 4, position: [20, 20] }),
				planStub({ name: 4, units: 2, position: [90, 90] }),
				planStub({ name: 5, units: 9 }),
			); // no position: inside a transport

			assert.equal(desk(manager).numAttackingUnitsAround(worldPos(25, 25), 10), 4, "the nearby army counts");
			assert.equal(
				desk(manager).numAttackingUnitsAround(worldPos(25, 25), 200),
				6,
				"the far army counts within reach",
			);
		});
	});

	describe("switching defense armies over", () =>
	{
		/** the default defense setup: one target on land 2 */
		function defenseWorld(
			options: WorldOptions = {},
		): { world: World; manager: AttackManager; target: CommonEntity; }
		{
			const world = makeWorld(options);
			const manager = makeManager(world, worldConfig(world));
			const target = world.addEntity(
				makeEntity({ id: 5000, owner: ENEMY, position: [30, 40], classes: ["Structure"] }),
			);
			return { world, manager, target };
		}

		/** a defender standing near the threat */
		function defender(world: World, id: number): CommonEntity
		{
			return world.addEntity(makeEntity({ id, owner: PLAYER, position: [19, 19], classes: ["Unit"] }));
		}

		/** the defense's release of these defenders (decision/defenseManager.ts releaseArmies), and where it was aimed */
		function handing(world: World, ...ids: number[]): { release: ArmyRelease; aimedAt: CommonPosition[]; }
		{
			const aimedAt: CommonPosition[] = [];
			const release: ArmyRelease = (_gameState, targetPos, enlist) =>
			{
				aimedAt.push(targetPos);
				for (const id of ids)
				{
					enlist(requireValue(world.gameState.getEntityById(entityId(id))));
				}
			};
			return { release, aimedAt };
		}

		it("refuses a call without a target or without a position, releasing no army", () =>
		{
			const { world, manager } = defenseWorld();
			const blur = makeWorld().addEntity(makeEntity({ id: 5001, owner: ENEMY, classes: ["Structure"] }));
			const { release, aimedAt } = handing(world);

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, fake<CommonEntity>(undefined), release),
				false,
				"no target, no attack",
			);
			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, blur, release),
				false,
				"no position, no attack",
			);
			assert.deepEqual(aimedAt, [], "the defense kept its armies");
		});

		// artificial world: defense plans carry no target, so only the rally-point
		// failure can hit them, and an AI under attack always has positioned
		// defenders — unreachable in a real game
		it("refuses when the plan cannot rally", () =>
		{
			const { world, manager, target } = defenseWorld();
			world.bases[0].anchor = undefined;
			world.removeEntity(1000);
			const { release, aimedAt } = handing(world);

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, target, release),
				false,
				"no base, no rallying",
			);
			assert.equal(desk(manager).startedAttacks["Attack"].length, 0, "no plan was kept either");
			assert.deepEqual(aimedAt, [], "and no army was released to it");
		});

		it("marches the defenders it is handed off to the threat as a new attack", () =>
		{
			const { world, manager, target } = defenseWorld();
			const joiner = defender(world, 1200);
			const { release, aimedAt } = handing(world, 1200);

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, target, release),
				true,
				"the army was handed over",
			);
			const plan = desk(manager).startedAttacks["Attack"][0];
			assert.deepEqual(aimedAt, [[30, 40]], "the armies were released for the raider's spot");
			assert.equal(plan.name, 0, "named by the running counter");
			assert.equal(plan.targetPlayer, ENEMY, "aimed at the raider");
			assert.deepEqual(plan.targetPos, [30, 40], "aimed at the raider's spot");
			assert.equal(plan.target, target, "and at the raider itself");
			assert.equal(plan.uniqueTargetId, undefined, "free to go on past it");
			assert.equal(plan.state, "arrived", "the army stands ready");
			assert.equal(plan.unitCollection.hasEntId(entityId(1200)), true, "the defender joined the plan");
			assert.equal(joiner.getMetadata(PLAYER, "plan"), 0, "marked by the plan");
			assert.equal(joiner.getMetadata(PLAYER, "role"), "attack", "and role-attacked");
			assert.equal(desk(manager).totalNumber, 1, "the counter moved on");
		});

		it("holds an attack on a unique target to it", () =>
		{
			const { world, manager, target } = defenseWorld();
			defender(world, 1300);

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, target, handing(world, 1300).release, true),
				true,
			);
			assert.equal(
				desk(manager).startedAttacks["Attack"][0].uniqueTargetId,
				5000,
				"the attack holds only this target",
			);
		});

		it("enlists only joinable defenders", () =>
		{
			const { world, manager, target } = defenseWorld();
			defender(world, 1200);
			// 1202 carries a transport mark: released, but never enlisted
			world.addEntity(
				makeEntity({ id: 1202, owner: PLAYER, position: [19, 19], classes: ["Unit"] }, {}, { transport: 4 }),
			);
			// 1203 rides inside a transport and has no position of its own
			world.addEntity(makeEntity({ id: 1203, owner: PLAYER, classes: ["Unit"] }));

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, target, handing(world, 1200, 1202, 1203).release),
				true,
				"the joinable defender made the attack",
			);
			const plan = desk(manager).startedAttacks["Attack"][0];
			assert.equal(plan.unitCollection.hasEntId(entityId(1200)), true, "the plain defender joined");
			assert.equal(
				plan.unitCollection.hasEntId(entityId(1202)),
				false,
				"the transport-marked defender stayed home",
			);
			assert.equal(plan.unitCollection.hasEntId(entityId(1203)), false, "the positionless defender stayed home");
		});

		it("bails out when no defender can join", () =>
		{
			const { world, manager, target } = defenseWorld();

			assert.equal(
				desk(manager).switchDefenseToAttack(world.gameState, target, handing(world).release),
				false,
				"nobody to hand over",
			);
			// an artifact worth knowing: the aborted plan stays in the started roster
			assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "the aborted plan was kept in the roster");
		});
	});
});

describe("an attack that sets off leaves its soldiers beside enemies to fight them", () =>
{
	/** the land of the target across the sea */
	const TARGET_LAND = landRegion(9);

	/** a plan of ours bound across the sea, with soldiers on our land (2) and on a quiet island (5) */
	function sailingTown(onOurLand: number, houses = true)
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		// the enemies on each land, counted from the world
		world.ai.enemyLands = new EnemyLands();
		world.accessAt.set("70,70", 5);
		world.accessAt.set("71,70", 5);
		const manager = makeManager(world, worldConfig(world));
		const sailing = AttackPlan.create(world.gameState, world.ai.Config, 7, "Attack");
		assert.ok(sailing);
		const soldier = (id: number, position: [number, number]) =>
			world.addEntity(
				makeEntity({ id, owner: PLAYER, position, classes: ["Unit", "Infantry", "Melee"] }, {}, { plan: 7 }),
			);
		const ashore = Array.from({ length: onOurLand }, (_, i) => soldier(1100 + i, [12 + i, 12]));
		const away = [soldier(1200, [70, 70]), soldier(1201, [71, 70])];
		for (const ent of [...ashore, ...away])
		{
			sailing.unitCollection.updateEnt(ent);
		}
		// two enemy houses, the farther listed first, and a soldier of theirs on our land
		if (houses)
		{
			world.addEntity(
				makeEntity({ id: 2100, owner: ENEMY, position: [40, 40], classes: ["Structure", "Village", "House"] }),
			);
		}
		const house = houses ?
			world.addEntity(
				makeEntity({ id: 2101, owner: ENEMY, position: [20, 20], classes: ["Structure", "Village", "House"] }),
			) :
			undefined;
		const raider = world.addEntity(
			makeEntity({ id: 3000, owner: ENEMY, position: [15, 14], classes: ["Unit", "Soldier", "Infantry"] }),
		);
		return { world, manager, sailing, ashore, away, house, raider };
	}

	// only the port passes: Petra's army sailed away from the enemy beside it
	it("five soldiers beside an enemy house stay as an attack on it; the two on a quiet island sail", () =>
	{
		const { world, manager, sailing, ashore, away, house } = sailingTown(5);

		desk(manager).splitLocalFights(world.gameState, sailing, TARGET_LAND);

		const local = desk(manager).startedAttacks["Attack"];
		assert.equal(local.length, 1, "one attack on our land");
		const fight = local[0];
		assert.equal(fight.target, house, "against the nearest enemy building, not its soldier");
		assert.equal(fight.state, "arrived", "started at once, no rally, no ship");
		for (const ent of ashore)
		{
			assert.equal(ent.getMetadata(PLAYER, "plan"), fight.name);
			assert.equal(ent.getMetadata(PLAYER, "role"), "attack");
		}
		assert.equal(fight.unitCollection.length, 5);
		for (const ent of away)
		{
			assert.equal(ent.getMetadata(PLAYER, "plan"), 7, "the quiet island's soldiers sail");
		}
		assert.equal(sailing.unitCollection.length, 2);
	});

	it("with no enemy building there, they go for the enemy soldier", () =>
	{
		const { world, manager, sailing, raider } = sailingTown(5, false);

		desk(manager).splitLocalFights(world.gameState, sailing, TARGET_LAND);

		assert.equal(desk(manager).startedAttacks["Attack"][0]?.target, raider);
	});

	it("soldiers on the target's own land go with the plan", () =>
	{
		const { world, manager, sailing, ashore } = sailingTown(5);

		desk(manager).splitLocalFights(world.gameState, sailing, landRegion(2));

		assert.equal(desk(manager).startedAttacks["Attack"].length, 0);
		for (const ent of ashore)
		{
			assert.equal(ent.getMetadata(PLAYER, "plan"), 7);
		}
	});

	// only the port passes: Petra sailed away from the enemy beside it
	it("however few, soldiers beside the enemy stay to fight it: three stay as an attack on the house", () =>
	{
		const { world, manager, sailing, ashore, house } = sailingTown(3);

		desk(manager).splitLocalFights(world.gameState, sailing, TARGET_LAND);

		const [fight] = desk(manager).startedAttacks["Attack"];
		assert.equal(fight?.target, house);
		for (const ent of ashore)
		{
			assert.equal(ent.getMetadata(PLAYER, "plan"), fight.name);
			assert.equal(sailing.unitCollection.hasEntId(ent.id()), false);
		}
	});

	it("soldiers beside the enemy join the attack already fighting on their land rather than start another", () =>
	{
		const { world, manager, sailing, ashore } = sailingTown(2);
		desk(manager).splitLocalFights(world.gameState, sailing, TARGET_LAND);
		const [fight] = desk(manager).startedAttacks["Attack"];
		assert.ok(fight);

		// two more soldiers, out of any plan, on the same land
		const more = [1300, 1301].map((id) =>
			world.addEntity(
				makeEntity({ id, owner: PLAYER, position: [13, 12], classes: ["Unit", "Infantry", "Melee"] }),
			)
		);
		desk(manager).fightBesideEnemies(world.gameState, more, TARGET_LAND);

		assert.equal(desk(manager).startedAttacks["Attack"].length, 1, "no second fight");
		for (const ent of [...ashore, ...more])
		{
			assert.equal(ent.getMetadata(PLAYER, "plan"), fight.name);
			assert.equal(ent.getMetadata(PLAYER, "role"), "attack");
		}
	});
});
