/**
 * ProductionLoad: how busy our infantry trainers are, measured: the share of
 * our built barracks and ranges with a batch in their queue, smoothed over
 * about a minute (world/production.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake } from "./harness/fakes.ts";
import { seconds } from "../adapter/brands.ts";

import { ProductionLoad } from "../world/production.ts";

/** a trainer of ours: built or a foundation, training or not */
function trainer(training: boolean, built = true): CommonEntity
{
	return fake<CommonEntity>({
		"foundationProgress": () => built ? undefined : 40,
		"trainingQueue": () => training ? [{ "unitTemplate": "units/athen/infantry_spearman_b", "count": 2 }] : []
	});
}

/** a town with these barracks and ranges (and a stable, which the load leaves out) at game second `time` */
function town(barracks: CommonEntity[], ranges: CommonEntity[], time: number): CommonGameState
{
	const byClass: Record<string, CommonEntity[]> = { "Barracks": barracks, "Range": ranges, "Stable": [trainer(false)] };
	return fake<CommonGameState>({
		"ai": { "elapsedTime": seconds(time) },
		"getOwnEntitiesByClass": (cls: string) => ({ "values": () => (byClass[cls] ?? []).values() })
	});
}

describe("ProductionLoad", () =>
{
	it("counts the built barracks and ranges, and the share of them training", () =>
	{
		const load = new ProductionLoad();
		load.update(town([trainer(true), trainer(true), trainer(false, false)], [trainer(false)], 0));

		assert.equal(load.trainers, 3, "a foundation trains nothing yet; the idle stable is not counted");
		assert.ok(Math.abs(load.busy - 2 / 3) < 1e-9, "the first update takes the share as it is");
	});

	it("moves toward the share measured, over about a minute", () =>
	{
		const load = new ProductionLoad();
		load.update(town([trainer(false), trainer(false)], [], 0));
		assert.equal(load.busy, 0);

		load.update(town([trainer(true), trainer(true)], [], 60));
		assert.ok(Math.abs(load.busy - (1 - Math.exp(-1))) < 1e-9, "a minute later, 63% of the way");
	});

	it("reads no trainers as none busy", () =>
	{
		const load = new ProductionLoad();
		load.update(town([], [], 0));
		assert.equal(load.trainers, 0);
		assert.equal(load.busy, 0);
	});
});
