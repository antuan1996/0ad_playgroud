/**
 * The bombardment (execution/bombardment.ts): our idle siege sent to shoot
 * the enemy structures in range from our territory while it waits, five at
 * most against one, the storms pruned of gone targets and moved-on bombers,
 * and kept through the renames of packing units. The attack manager makes it
 * and runs it in its turn (tests/harness/attackSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configFor, freshManager, makeManager, worldConfig } from "./harness/attackSeat.ts";
import { emptyEvents, fake, makeEntity, orders } from "./harness/fakes.ts";
import { ENEMY, GAIA, PLAYER, makeWorld, type World } from "./harness/world.ts";

import { entityId } from "../adapter/brands.ts";

describe("the bombardment", () =>
{
	describe("renaming strike aims", () =>
	{
		it("renames a bombing aim whose target was rebuilt", () =>
		{
			const manager = freshManager(configFor(0.5));
			manager.bombing.bombingAttacks.set(entityId(5001), new Set([entityId(1100)]));
			const events = emptyEvents();
			events.EntityRenamed.push({ entity: entityId(5001), newentity: entityId(7001) });

			manager.checkEvents(fake<CommonGameState>({}), events);
			assert.deepEqual([...manager.bombing.bombingAttacks.keys()], [7001], "the aim followed the rebuild");
			assert.deepEqual([...manager.bombing.bombingAttacks.get(entityId(7001))!], [1100], "with its force intact");
		});

		it("renames each bomber inside a group whose unit was rebuilt", () =>
		{
			const manager = freshManager(configFor(0.5));
			manager.bombing.bombingAttacks.set(entityId(5000), new Set([entityId(6001), entityId(6002)]));
			const events = emptyEvents();
			events.EntityRenamed.push({ entity: entityId(6001), newentity: entityId(7001) });

			manager.checkEvents(fake<CommonGameState>({}), events);
			assert.deepEqual(
				[...manager.bombing.bombingAttacks.get(entityId(5000))!],
				[6002, 7001],
				"the rebuilt bomber was re-listed",
			);
		});
	});

	describe("bombing within range", () =>
	{
		/** a target structure somewhere away from the bomber */
		function makeEnemyWall(world: World, id = 5000, position: [number, number] = [40, 40]): CommonEntity
		{
			return world.addEntity(
				makeEntity({ id, owner: ENEMY, position, classes: ["Structure"] }, { footprintRadius: () => 2 }),
			);
		}

		it("prunes aims whose target is gone or no longer hostile", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world); // survives, its force still under orders
			world.addEntity(makeEntity({ id: 5002, owner: PLAYER, position: [32, 30], classes: ["Structure"] }));
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => false,
					unitAIOrderData: () => orders({ target: entityId(5000) }),
				}),
			);
			manager.bombing.bombingAttacks.set(entityId(5002), new Set([entityId(1100)]));
			manager.bombing.bombingAttacks.set(entityId(5003), new Set([entityId(1100)]));
			manager.bombing.bombingAttacks.set(entityId(5000), new Set([entityId(1100)]));

			manager.bombing.assignBombers(world.gameState);
			assert.deepEqual([...manager.bombing.bombingAttacks.keys()], [5000], "only the enemy aim survived");
		});

		it("keeps the bomber whose last order still names the storm, and drops the moved-on one", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					unitAIOrderData: () => orders({ target: entityId(5000) }),
				}),
			);
			world.addEntity(
				makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					unitAIOrderData: () => orders({ target: entityId(6000) }),
				}),
			);
			manager.bombing.bombingAttacks.set(entityId(5000), new Set([entityId(1100), entityId(1101)]));

			manager.bombing.assignBombers(world.gameState);
			assert.deepEqual(
				[...manager.bombing.bombingAttacks.get(entityId(5000))!],
				[1100],
				"the moved-on bomber was dropped",
			);
		});

		it("skips blind, busy or reserved bombers", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => undefined,
				}),
			);
			world.addEntity(
				makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => false,
					attackRange: () => ({ max: 40 }),
				}),
			);
			world.addEntity(
				makeEntity({ id: 1102, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
				}, { plan: -2 }),
			);
			world.addEntity(
				makeEntity({ id: 1103, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
				}, { plan: -3 }),
			);
			world.addEntity(
				makeEntity({ id: 1104, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
				}, { plan: 1, subrole: "walking" }),
			);

			manager.bombing.assignBombers(world.gameState);
			assert.equal(manager.bombing.bombingAttacks.size, 0, "nobody was enrolled");
		});

		it("strikes a structure already inside the gun's reach", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[][] = [];
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 60 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: (aimed: unknown, capture: unknown, queued: unknown) =>
						strikes.push([aimed, capture, queued]),
				}),
			);

			manager.bombing.assignBombers(world.gameState);
			assert.deepEqual(strikes, [[5000, false, false]], "the wall took the shot without marching");
			assert.deepEqual(
				[...manager.bombing.bombingAttacks.get(entityId(5000))!],
				[1100],
				"the bomber was enrolled",
			);
		});

		it("marches out of reach and opens fire from the border", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[][] = [];
			const moves: Array<[number, number]> = [];
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: (aimed: unknown, capture: unknown, queued: unknown) =>
						strikes.push([aimed, capture, queued]),
					move: (x: number, y: number) => moves.push([x, y]),
				}),
			);

			manager.bombing.assignBombers(world.gameState);
			assert.deepEqual(strikes, [[5000, false, true]], "the shot was queued while moving");
			assert.equal(moves.length, 1, "the bomber marched once");
			assert.ok(
				Math.abs(moves[0][0] - 11.72) < 0.01 && Math.abs(moves[0][1] - 11.72) < 0.01,
				`the stand-off spot just inside gun range: ${moves[0]}`,
			);
		});

		/** one bomber, one wall, and the territory/access answers to probe */
		function probe(territory: Array<[string, number]>, access?: Array<[string, number]>): number
		{
			const world = makeWorld({ enemyPlayer: ENEMY, territory: new Map(territory) });
			if (access)
			{
				for (const [key, value] of access)
				{
					world.accessAt.set(key, value);
				}
			}
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[] = [];
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: (aimed: unknown) => strikes.push(aimed),
					move: () => undefined,
				}),
			);
			manager.bombing.assignBombers(world.gameState);
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
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 60 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: (aimed: unknown) => strikes.push(aimed),
				}),
			);
			// a field nobody works, however hostile its ground
			world.addEntity(
				makeEntity({ id: 5002, owner: ENEMY, position: [12, 12], classes: ["Structure", "Field"] }, {
					resourceSupplyNumGatherers: () => 0,
					footprintRadius: () => 1,
				}),
			);
			// a worked field on our own ground
			world.addEntity(
				makeEntity({ id: 5003, owner: ENEMY, position: [20, 20], classes: ["Structure", "Field"] }, {
					resourceSupplyNumGatherers: () => 2,
					footprintRadius: () => 1,
				}),
			);
			// a worked field deep in enemy land
			world.addEntity(
				makeEntity({ id: 5001, owner: ENEMY, position: [40, 41], classes: ["Structure", "Field"] }, {
					resourceSupplyNumGatherers: () => 2,
					footprintRadius: () => 1,
				}),
			);

			manager.bombing.assignBombers(world.gameState);
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
				world.addEntity(
					makeEntity({ id: 7001 + i, owner: PLAYER }, {
						unitAIOrderData: () => orders({ target: entityId(5000) }),
					}),
				);
				crowd.add(entityId(7001 + i));
			}
			manager.bombing.bombingAttacks.set(entityId(5000), crowd);
			const strikes: unknown[] = [];
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: (aimed: unknown) => strikes.push(aimed),
					move: () => undefined,
				}),
			);

			manager.bombing.assignBombers(world.gameState);
			assert.deepEqual(strikes, [], "the crowded wall was left alone");
			assert.equal(manager.bombing.bombingAttacks.get(entityId(5000))!.size, 5, "the crowd stood unchanged");
		});

		it("lets a second bomber pile onto the same storm", () =>
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			const manager = makeManager(world, worldConfig(world));
			makeEnemyWall(world);
			const strikes: unknown[] = [];
			const shoot = (id: number) => (aimed: unknown) => strikes.push([id, aimed]);
			world.addEntity(
				makeEntity({ id: 1100, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: shoot(1100),
					move: () => undefined,
				}),
			);
			world.addEntity(
				makeEntity({ id: 1101, owner: PLAYER, position: [10, 10], classes: ["Unit", "BoltShooter"] }, {
					isIdle: () => true,
					attackRange: () => ({ max: 40 }),
					canAttackTarget: (aimed: CommonEntity) => aimed.owner() === ENEMY,
					attack: shoot(1101),
					move: () => undefined,
				}),
			);

			manager.bombing.assignBombers(world.gameState);
			assert.equal(strikes.length, 2, "both bombers opened fire");
			assert.deepEqual(
				[...manager.bombing.bombingAttacks.get(entityId(5000))!],
				[1100, 1101],
				"both were enrolled",
			);
		});
	});
});
