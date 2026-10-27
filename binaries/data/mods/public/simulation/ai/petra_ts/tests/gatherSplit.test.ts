/**
 * gatherSplit: how many gatherers each resource should have
 * (decision/gatherSplit.ts), and the measured rates it reads
 * (world/gatherEconomy.ts).
 *
 * The split is pure, so most of it is checked as properties over generated
 * cases (PLAN.md §5.4): a seeded generator, the same cases every run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake, orders } from "./harness/fakes.ts";
// the game's Resources instance (common-api/resources.js makes it on load)
import "simulation/ai/common-api/resources.js";

import { entityId } from "../adapter/brands.ts";
import { byDeficit, capAtSaturation, deficit, type GatherNeed, SWITCH_GAP, targetGatherers, worthSwitching } from "../decision/gatherSplit.ts";
import { FOOD_PRIOR_RATE, GatherEconomy, PRIOR_RATE, SMOOTHING } from "../world/gatherEconomy.ts";

const RESOURCES = ["food", "wood", "stone", "metal"];

/** A small deterministic generator (mulberry32). */
function generator(seed: number): () => number
{
	let state = seed >>> 0;
	return () =>
	{
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Case
{
	total: number;
	/** the queued costs' rates */
	wanted: Record<string, number>;
	/** the reserve floors' rates */
	floors: Record<string, number>;
	rate: Record<string, number>;
	gatherers: Record<string, number>;
}

/**
 * Cases as the game has them: up to 100 gatherers, queued costs up to 40 a
 * second (some resources none), reserve floors up to 4 (half of them none),
 * rates 0.05-1.5.
 */
function cases(count: number, seed = 1): Case[]
{
	const random = generator(seed);
	const out: Case[] = [];
	for (let i = 0; i < count; ++i)
	{
		const wanted: Record<string, number> = {};
		const floors: Record<string, number> = {};
		const rate: Record<string, number> = {};
		const gatherers: Record<string, number> = {};
		let total = 0;
		for (const res of RESOURCES)
		{
			wanted[res] = random() < 0.25 ? 0 : 40 * random();
			floors[res] = random() < 0.5 ? 0 : 4 * random();
			rate[res] = 0.05 + 1.45 * random();
			gatherers[res] = Math.floor(30 * random());
			total += gatherers[res];
		}
		out.push({ "total": total + 1, wanted, floors, rate, gatherers });
	}
	return out;
}

const NO_FLOORS = { "food": 0, "wood": 0, "stone": 0, "metal": 0 };

const sum = (record: Record<string, number>): number => Object.values(record).reduce((a, b) => a + b, 0);

describe("the split: each resource's share of the gatherers", () =>
{
	it("shares out every gatherer, and none to a resource nobody wants", () =>
	{
		for (const c of cases(500))
		{
			const target = targetGatherers(c.total, c.wanted, c.floors, c.rate, c.gatherers);
			if (sum(c.wanted) + sum(c.floors) === 0)
				continue;
			assert.ok(Math.abs(sum(target) - c.total) < 1e-9, `the targets add up to ${c.total}`);
			for (const res of RESOURCES)
			{
				assert.ok(target[res] >= 0);
				if (c.wanted[res] === 0 && c.floors[res] === 0)
					assert.equal(target[res], 0, `${res} is not wanted`);
			}
		}
	});

	it("brings in each resource in proportion to what is queued, with no reserve to fill", () =>
	{
		// the income the targets would give, target × rate, is the queued
		// costs' rates scaled: everything queued becomes affordable together
		for (const c of cases(500, 2))
		{
			const target = targetGatherers(c.total, c.wanted, NO_FLOORS, c.rate, c.gatherers);
			const wanted = RESOURCES.filter((res) => c.wanted[res] > 0);
			if (wanted.length < 2)
				continue;
			const scale = target[wanted[0]] * c.rate[wanted[0]] / c.wanted[wanted[0]];
			for (const res of wanted)
				assert.ok(Math.abs(target[res] * c.rate[res] / c.wanted[res] - scale) < 1e-9 * Math.max(1, scale));
		}
	});

	it("gives a resource more gatherers when it comes in more slowly, the rest alike", () =>
	{
		for (const c of cases(500, 3))
		{
			if (c.wanted.food === 0)
				continue;
			const before = targetGatherers(c.total, c.wanted, c.floors, c.rate, c.gatherers).food;
			const after = targetGatherers(c.total, c.wanted, c.floors, { ...c.rate, "food": c.rate.food / 2 }, c.gatherers).food;
			assert.ok(after >= before - 1e-9, "slower food never loses gatherers");
		}
	});

	it("with nothing wanted at all, leaves the gatherers where they are", () =>
	{
		const gatherers = { "food": 7, "wood": 4, "stone": 0, "metal": 1 };
		const none = { "food": 0, "wood": 0, "stone": 0, "metal": 0 };

		assert.deepEqual(targetGatherers(12, none, none, PRIOR_RATE, gatherers), gatherers);
	});

	it("a reserve to fill takes its rate in gatherers, however slow the resource", () =>
	{
		// wood pays for the queue at 10 a second; metal's stock is short of its
		// reserve by 3 a second: 3 gatherers' weight, not 3 / 0.3 = 10
		const costs = { "food": 0, "wood": 10, "stone": 0, "metal": 0 };
		const floors = { "food": 0, "wood": 0, "stone": 0, "metal": 3 };
		const target = targetGatherers(16, costs, floors, { "wood": 0.8, "metal": 0.3 }, {});

		assert.ok(Math.abs(target.metal - 16 * 3 / 15.5) < 1e-9);
		assert.ok(Math.abs(target.wood - 16 * 12.5 / 15.5) < 1e-9);
	});

	it("a rate measured as nothing does not take every gatherer", () =>
	{
		// the floor of 0.05 a second: a supply all walk to and none reach
		const target = targetGatherers(20, { "food": 10, "wood": 10 }, {}, { "food": 0, "wood": 1 }, {});

		assert.ok(target.food < 20 && target.wood > 0);
		assert.ok(Math.abs(target.food - 20 * 200 / 210) < 1e-9);
	});
});

describe("the split: a resource that cannot take more", () =>
{
	it("caps a resource whose gatherers stand idle at those at work", () =>
	{
		// 14 fields hold 70 women; the share asks 90 of the 82 on food, and
		// the 20 food cannot use go to wood and stone, 3 : 1
		const capped = capAtSaturation({ "food": 90, "wood": 30, "stone": 10 }, { "food": 82, "wood": 26, "stone": 5 },
			{ "food": 12, "wood": 0, "stone": 0 });

		assert.deepEqual(capped, { "food": 70, "wood": 45, "stone": 15 });
	});

	it("leaves a share below the gatherers at work as it is", () =>
	{
		assert.deepEqual(capAtSaturation({ "food": 40 }, { "food": 82 }, { "food": 12 }), { "food": 40 });
	});

	it("keeps the sum of the targets, and never takes from a resource with nobody idle", () =>
	{
		for (const c of cases(300, 6))
		{
			const target = targetGatherers(c.total, c.wanted, c.floors, c.rate, c.gatherers);
			const idle = { "food": Math.min(c.gatherers.food, 3), "wood": 0, "stone": 0, "metal": 0 };
			const capped = capAtSaturation(target, c.gatherers, idle);
			for (const res of RESOURCES)
			{
				assert.ok(capped[res] >= 0);
				if (idle[res as keyof typeof idle])
					assert.ok(capped[res] <= target[res] + 1e-9);
				else
					assert.ok(capped[res] >= target[res] - 1e-9);
			}
			if (RESOURCES.some((res) => !idle[res as keyof typeof idle] && target[res] > 0))
				assert.ok(Math.abs(sum(capped) - sum(target)) < 1e-9, "the share food cannot use goes elsewhere");
		}
	});
});

describe("the split: the order and the switches", () =>
{
	const need = (type: string, gatherers: number, target: number, wanted = 1): GatherNeed =>
		({ type, wanted, "current": 0, gatherers, target });

	it("orders the resources most short of gatherers first, the more wanted first among equals", () =>
	{
		const order = byDeficit([need("stone", 3, 3, 2), need("food", 10, 14), need("wood", 8, 6), need("metal", 1, 1, 5)]);

		assert.deepEqual(order.map((n) => n.type), ["food", "metal", "stone", "wood"]);
		assert.deepEqual(order.map(deficit), [4, 0, 0, -2]);
	});

	it("puts a resource nobody wants after the wanted ones, even those with too many gatherers", () =>
	{
		const order = byDeficit([need("metal", 0, 0), need("wood", 9, 8), need("food", 12, 11)]);

		assert.deepEqual(order.map((n) => n.type), ["wood", "food", "metal"]);
	});

	it("moves a gatherer only when the deficits differ by the gap", () =>
	{
		const wood = need("wood", 10, 9);
		assert.equal(worthSwitching(wood, need("food", 10, 10.9)), false, "a gap of 1.9");
		assert.equal(worthSwitching(wood, need("food", 10, 11)), true, `a gap of ${SWITCH_GAP}`);
	});

	it("never moves gatherers both ways between two resources", () =>
	{
		for (const c of cases(300, 4))
		{
			const target = targetGatherers(c.total, c.wanted, c.floors, c.rate, c.gatherers);
			const needs = RESOURCES.map((res) => need(res, c.gatherers[res], target[res]));
			for (const a of needs)
				for (const b of needs)
					assert.ok(!(worthSwitching(a, b) && worthSwitching(b, a)));
		}
	});

	it("a switch the rule allows brings the split closer to its targets", () =>
	{
		for (const c of cases(300, 5))
		{
			const target = targetGatherers(c.total, c.wanted, c.floors, c.rate, c.gatherers);
			const needs = RESOURCES.map((res) => need(res, c.gatherers[res], target[res]));
			const miss = (list: GatherNeed[]): number => list.reduce((s, n) => s + Math.abs(deficit(n)), 0);
			for (const from of needs)
				for (const to of needs)
				{
					if (from === to || !worthSwitching(from, to) || from.gatherers === 0)
						continue;
					const after = needs.map((n) => n === from ? { ...n, "gatherers": n.gatherers - 1 } :
						n === to ? { ...n, "gatherers": n.gatherers + 1 } : n);
					assert.ok(miss(after) < miss(needs) + 1e-9);
				}
		}
	});
});

describe("the measured rates: what a gatherer brings in, the walk included", () =>
{
	/** a worker of ours with its roles, state and order */
	function worker(id: number, subrole: string, gatherType: string | undefined, state: string, supply?: number): CommonEntity
	{
		// the engine reports a unit idle in UnitAI's IDLE state
		const metadata: Record<string, unknown> = { "subrole": subrole, "gather-type": gatherType };
		return fake<CommonEntity>({
			"getMetadata": (_player: number, key: string) => metadata[key],
			"position": () => [10, 10],
			"unitAIState": () => state,
			"isIdle": () => state === "INDIVIDUAL.IDLE",
			"unitAIOrderData": () => supply === undefined ? [] : orders({ "target": entityId(supply) }),
			"resourceGatherRates": () => ({ "food.fruit": 1, "food.meat": 1, "wood.tree": 0.7 })
		});
	}

	function world(workers: CommonEntity[], time: number): CommonGameState
	{
		const supplies: Record<number, { generic: string; specific: string }> = {
			900: { "generic": "food", "specific": "fruit" },
			901: { "generic": "wood", "specific": "tree" }
		};
		return fake<CommonGameState>({
			"ai": { "elapsedTime": time },
			"getOwnEntitiesByRole": () => ({ "values": () => workers.values() }),
			"getEntityById": (id: number) => id in supplies ? fake<CommonEntity>({ "resourceSupplyType": () => supplies[id] }) : undefined
		});
	}

	// four on the berries, one of them at the bush; two woodcutters, both at the tree
	const town = (): CommonEntity[] => [
		worker(1, "gatherer", "food", "INDIVIDUAL.GATHER.GATHERING", 900),
		worker(2, "gatherer", "food", "INDIVIDUAL.GATHER.APPROACHING", 900),
		worker(3, "gatherer", "food", "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", 900),
		worker(4, "hunter", undefined, "INDIVIDUAL.COMBAT.APPROACHING", 900),
		worker(5, "gatherer", "wood", "INDIVIDUAL.GATHER.GATHERING", 901),
		worker(6, "gatherer", "wood", "INDIVIDUAL.GATHER.GATHERING", 901),
		worker(7, "builder", undefined, "INDIVIDUAL.REPAIR.REPAIRING")
	];

	it("counts the gatherers and what those gathering bring in now", () =>
	{
		const economy = new GatherEconomy();
		economy.update(world(town(), 0));

		assert.deepEqual(economy.gatherers, { "food": 4, "wood": 2, "stone": 0, "metal": 0 });
		assert.deepEqual(economy.income, { "food": 1, "wood": 1.4, "stone": 0, "metal": 0 });
		assert.deepEqual(economy.idle, { "food": 0, "wood": 0, "stone": 0, "metal": 0 });
	});

	it("counts the gatherers left idle with nothing to gather: the fields are full", () =>
	{
		const economy = new GatherEconomy();
		economy.update(world([...town(), worker(8, "gatherer", "food", "INDIVIDUAL.IDLE"),
			worker(9, "gatherer", "food", "INDIVIDUAL.IDLE")], 0));

		assert.equal(economy.gatherers.food, 6);
		assert.equal(economy.idle.food, 2);
		assert.equal(economy.idle.wood, 0);
	});

	it("starts from the prior, then moves toward what is measured, over about a minute", () =>
	{
		const economy = new GatherEconomy();
		economy.update(world(town(), 0));
		assert.equal(economy.rateOf("food"), PRIOR_RATE.food, "the first look only sets the prior");

		economy.update(world(town(), SMOOTHING));
		// a minute later: 1 - 1/e of the way from 0.4 to 1/4
		const expected = PRIOR_RATE.food + (0.25 - PRIOR_RATE.food) * (1 - Math.exp(-1));
		assert.ok(Math.abs(economy.rateOf("food") - expected) < 1e-9);
		assert.ok(Math.abs(economy.rateOf("wood") - (PRIOR_RATE.wood + (0.7 - PRIOR_RATE.wood) * (1 - Math.exp(-1)))) < 1e-9);
		assert.equal(economy.rateOf("stone"), PRIOR_RATE.stone, "nobody on stone: still the prior");
	});

	it("tells the food by source: berries, fields, the hunt; carrying back from a bush gone counts as berries", () =>
	{
		const supplies: Record<number, { generic: string; specific: string } | undefined> = {
			900: { "generic": "food", "specific": "fruit" },
			902: { "generic": "food", "specific": "grain" },
			950: undefined	// our farmstead: no supply
		};
		const gameState = fake<CommonGameState>({
			"ai": { "elapsedTime": 0 },
			"getOwnEntitiesByRole": () => ({ "values": () => [
				worker(1, "gatherer", "food", "INDIVIDUAL.GATHER.GATHERING", 900),
				worker(2, "gatherer", "food", "INDIVIDUAL.GATHER.GATHERING", 902),
				// carrying to the farmstead, then back to the field
				fake<CommonEntity>({
					"getMetadata": (_p: number, key: string) => ({ "subrole": "gatherer", "gather-type": "food" })[key],
					"position": () => [10, 10],
					"unitAIState": () => "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING",
					"isIdle": () => false,
					"unitAIOrderData": () => orders({ "target": entityId(950) }, { "target": entityId(902) }),
					"resourceGatherRates": () => ({ "food.grain": 0.5 })
				}),
				// carrying back from a bush picked clean: its order names nothing left
				worker(4, "gatherer", "food", "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", 999),
				worker(5, "hunter", undefined, "INDIVIDUAL.COMBAT.APPROACHING")
			].values() }),
			"getEntityById": (id: number) => id in supplies ?
				fake<CommonEntity>({ "resourceSupplyType": () => supplies[id] }) : undefined
		});
		const economy = new GatherEconomy();
		economy.update(gameState);

		assert.deepEqual(economy.foodGatherers, { "fruit": 2, "grain": 2, "meat": 1, "fish": 0 });
		assert.equal(economy.foodRateOf("grain"), FOOD_PRIOR_RATE.grain, "the first look only sets the prior");
	});

	it("keeps its rates through a save", () =>
	{
		const economy = new GatherEconomy();
		economy.update(world(town(), 0));
		economy.update(world(town(), 30));
		const loaded = new GatherEconomy();
		loaded.Deserialize(JSON.parse(JSON.stringify(economy.Serialize())));

		assert.deepEqual(loaded.perGatherer, economy.perGatherer);
		assert.deepEqual(loaded.perFoodGatherer, economy.perFoodGatherer);
		assert.equal(loaded.lastUpdate, 30);
	});
});
