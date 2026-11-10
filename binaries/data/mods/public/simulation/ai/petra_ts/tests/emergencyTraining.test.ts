/**
 * The emergency training (decision/emergencyTraining.ts,
 * HQ.emergencyTraining): defenders trained at once in the civic centre
 * nearest an enemy army that trains and is not busy, and garrisoned there
 * while it has room. On a real office seated on the plain
 * (tests/harness/hqSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake, makeTemplate, override, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import { seat } from "./harness/hqSeat.ts";
import { type HqWorld } from "./harness/hqWorld.ts";

import { worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import { type Headquarters } from "../decision/headquarters.ts";
import { GarrisonManager } from "../execution/garrisonManager.ts";
import { Worker } from "../execution/worker.ts";

describe("trainEmergencyUnits: the last call for the wall", () =>
{
	/** the town's training cards, keyed by the template name the anchor lists */
	function seatCards(world: HqWorld): void
	{
		world.templates["units/athen/infantry_spearman"] = makeTemplate("units/athen/infantry_spearman", {
			classes: ["Unit", "Infantry", "Melee", "CitizenSoldier"],
			getPaths: { Cost: { Population: 1 } },
			cost: { food: 100 },
		});
		world.templates["units/athen/infantry_archer"] = makeTemplate("units/athen/infantry_archer", {
			classes: ["Unit", "Infantry", "Ranged", "Archer", "CitizenSoldier"],
			getPaths: { Cost: { Population: 1 } },
			cost: { wood: 100 },
		});
	}

	/** the base anchor dressed for the alarm: both queue views (the entity
	 * method the port's first pass reads and the raw sim view the counting
	 * step reads on both implementations), the card list, and the wall's
	 * garrison answers */
	function emergencyAnchor(
		hq: Headquarters,
		world: HqWorld,
		options: {
			trainables?: string[];
			queue?: Array<Record<string, unknown>> | undefined;
			garrisonMax?: number;
			arrowClasses?: string[];
			ejectedHealth?: number;
		} = {},
	)
	{
		const anchor = requireValue(hq.basesManager.baseManagers[0].anchor);
		override(anchor, {
			trainableEntities: () => options.trainables ?? [],
			trainingQueue: () => options.queue ?? false,
		});
		anchor._entity = fake<EngineAIEntityState>({ trainingQueue: options.queue ?? undefined });
		if (options.garrisonMax !== undefined)
		{
			override(anchor, { garrisonMax: () => options.garrisonMax });
		}
		if (options.arrowClasses !== undefined)
		{
			override(anchor, { getGarrisonArrowClasses: () => options.arrowClasses });
		}
		if (options.ejectedHealth !== undefined)
		{
			override(anchor, { garrisonEjectHealth: () => options.ejectedHealth });
		}
		return anchor;
	}

	/** the emergency account book after the call, peeked at its one resource */
	function accountOf(world: HqWorld, queue: string): number
	{
		return world.ai.queueManager.accounts[queue].food;
	}

	it("the call books a melee batch at the empty house straight away", () =>
	{
		const { world, hq } = seat({ stock: { food: 500, wood: 500, stone: 500, metal: 500 } });
		seatCards(world);
		// the wall has no garrison room at the default book: 0 max slots means
		// the melee card wins the ranged roll whatever the coin says
		stubGlobal("randBool", () => true);
		try
		{
			const anchor = emergencyAnchor(hq, world, {
				trainables: ["units/athen/infantry_spearman", "units/athen/infantry_archer"],
			});

			assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);

			const queue = world.ai.queues.emergency;
			assert.equal(queue.plans.length, 1);
			const plan = queue.plans[0];
			assert.equal(plan.type, "units/athen/infantry_spearman");
			assert.equal(plan.number, 1);
			assert.equal(plan.metadata?.trainer, anchor.id());

			assert.equal(
				accountOf(world, "emergency"),
				100,
				"the cost was booked against the emergency account from the town's available stock",
			);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("so long as the emergency queue still holds the batch, no second book", () =>
	{
		const { world, hq } = seat({ stock: { food: 500, wood: 500, stone: 500, metal: 500 } });
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman"] });
		assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);

		assert.equal(
			hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]),
			false,
			"the queue's own batch is the answer while it lasts",
		);
		const queue = world.ai.queues.emergency;
		assert.equal(queue.plans.length, 1, "the second call books nothing");
	});

	it("a victim beyond the rescue cut is nobody's", () =>
	{
		const { world, hq } = seat({ stock: { food: 500 } });
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman"] });

		// 390 cells out in both axes: ~304,200 square distance over the cut
		assert.equal(
			hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(400, 400)]),
			false,
			"the town's guard cannot reach to respond in time",
		);
	});

	it("no road on the victim's land — the office holds", () =>
	{
		const { world, hq } = seat({ stock: { food: 500 } });
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman"] });
		world.accessAt.set("60,60", 9);

		assert.equal(
			hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(60, 60)]),
			false,
			"the anchor on land 2 cannot reach the calls from land 9",
		);
	});

	it("a training house already brimming skips the call", () =>
	{
		const { world, hq } = seat({ stock: { food: 500 } });
		seatCards(world);
		emergencyAnchor(hq, world, {
			trainables: ["units/athen/infantry_spearman"],
			// 6 s of queued production, half under way, reads as a house at
			// work: only batches in progress or bound for the wall count the
			// wait, so this batch is what the clock looks at
			queue: [{ metadata: {}, progress: 0.5, id: 1, timeRemaining: 6000 }],
		});

		assert.equal(
			hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]),
			false,
			"the only anchor is occupied at its queue",
		);
	});

	it("the wall's garrison book counts batches, and the lone fill makes the call ranged", () =>
	{
		const { world, hq } = seat({ stock: { food: 500, wood: 500 } });
		seatCards(world);
		const anchor = emergencyAnchor(hq, world, {
			trainables: ["units/athen/infantry_spearman", "units/athen/infantry_archer"],
			queue: [{ metadata: { garrisonType: "Tower" }, count: 3, progress: 0.2, timeRemaining: 2000 }, {
				id: 5,
				metadata: {},
				progress: 0,
				timeRemaining: 1000,
			}],
			garrisonMax: 10,
			arrowClasses: ["Archer"],
			ejectedHealth: 0.5,
		});
		const stops: number[] = [];
		override(anchor, {
			stopProduction: (id: number) =>
			{
				stops.push(id);
				return true;
			},
		});
		stubGlobal("randBool", () => true);
		try
		{
			assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);

			// the quiet drain from the batches: 3 in the wall's book, and the
			// idle fill with no trainer attached is pulled from the queue
			assert.deepEqual(stops, [5]);
			const queue = world.ai.queues.emergency;
			const plan = queue.plans[0];
			assert.equal(
				plan.type,
				"units/athen/infantry_archer",
				"room in the wall means the ranged roll goes through",
			);
			assert.equal(plan.metadata?.garrisonType, GarrisonManager.TYPE_PROTECTION);
			assert.equal(plan.metadata?.role, Worker.ROLE_WORKER);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("a wounded wall keeps the melee hand even on the ranged roll", () =>
	{
		const { world, hq } = seat({ stock: { food: 500 } });
		seatCards(world);
		// 40 hitpoints against the 50 eject floor: no room for arrows
		const anchor = emergencyAnchor(hq, world, {
			trainables: ["units/athen/infantry_spearman", "units/athen/infantry_archer"],
			garrisonMax: 10,
			ejectedHealth: 0.5,
		});
		anchor.hitpoints = () => 40;
		stubGlobal("randBool", () => true);
		try
		{
			assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);

			const queue = world.ai.queues.emergency;
			const plan = queue.plans[0];
			assert.equal(plan.type, "units/athen/infantry_spearman");
			assert.equal(
				plan.metadata?.garrisonType,
				undefined,
				"a wall with no room for men takes plain trash troops",
			);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("an empty treasury calls the house off", () =>
	{
		const { world, hq } = seat();
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman"] });

		assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), false);
		const queue = world.ai.queues.emergency;
		assert.equal(queue.plans.length, 0, "no card was affordable, nothing booked");
	});

	it("the disabled card is passed over and its teammate wins the call", () =>
	{
		const { world, hq } = seat({
			stock: { food: 500, wood: 500 },
			disabledTemplates: ["units/athen/infantry_spearman"],
		});
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman", "units/athen/infantry_archer"] });

		assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);
		const queue = world.ai.queues.emergency;
		const plan = queue.plans[0];
		assert.equal(
			plan.type,
			"units/athen/infantry_archer",
			"the prohibition leaves the ranged answer standing in the melee roll",
		);
	});

	it("when the emergency account falls short, the neighbour queue lends", () =>
	{
		const { world, hq } = seat({ stock: { food: 150 } });
		seatCards(world);
		emergencyAnchor(hq, world, { trainables: ["units/athen/infantry_spearman"] });
		// the villager queue held an account from a previous turn's distribution
		world.ai.queueManager.accounts.villager.food = 100;

		assert.equal(hq.emergencyTraining.trainEmergencyUnits(world.gameState, [worldPos(50, 50)]), true);

		// the shortfall 50 came over the villager account, and the batch books
		assert.equal(accountOf(world, "emergency"), 100);
		assert.equal(accountOf(world, "villager"), 50);
	});
});
