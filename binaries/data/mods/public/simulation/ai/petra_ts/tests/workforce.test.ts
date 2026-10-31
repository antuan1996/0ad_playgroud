/**
 * workforce: how many workers to train at a time, when to stop, and whether
 * the next is a support unit or a citizen soldier (decision/workforce.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type WorkforceCensus, batchSize, soldierRequirements, supportAlpha, supportShare, trainingStopped
} from "../decision/workforce.ts";

/** a town of 40 workers, little queued, the town phase researched, Petra's targets of difficulty 5 */
function town(overrides: Partial<WorkforceCensus> = {}): WorkforceCensus
{
	return { "workers": 40, "queuedSupports": 2, "queuedSoldiers": 2, "inTraining": 4, "target": 150,
		"popPhase2": 150, "waitingForTown": false, "saving": false, ...overrides };
}

describe("workforce", () =>
{
	it("trains one at a time below twelve workers, then a tenth of them, five at most", () =>
	{
		assert.equal(batchSize(11), 1);
		assert.equal(batchSize(12), 2);
		assert.equal(batchSize(31), 4);
		assert.equal(batchSize(90), 5);
	});

	it("stops past the target, or at the town phase's population before it is researched", () =>
	{
		assert.equal(trainingStopped(town()), false);
		assert.equal(trainingStopped(town({ "workers": 147 })), true, "147 + 4 queued past 150");
		assert.equal(trainingStopped(town({ "workers": 144, "waitingForTown": true })), false, "144 + 4 queued: 148, under 150");
		assert.equal(trainingStopped(town({ "workers": 146, "waitingForTown": true })), true, "150: the town phase awaited");
		assert.equal(trainingStopped(town({ "workers": 146 })), false, "the same town with the phase researched");
	});

	it("stops with the queues full, and while saving past the town phase's population", () =>
	{
		assert.equal(trainingStopped(town({ "queuedSupports": 30, "queuedSoldiers": 21 })), true, "51 queued");
		assert.equal(trainingStopped(town({ "queuedSupports": 21, "queuedSoldiers": 21 })), true, "both above 20");
		assert.equal(trainingStopped(town({ "inTraining": 16 })), true);
		assert.equal(trainingStopped(town({ "workers": 157, "saving": true, "target": 200 })), true, "161 > 160");
		assert.equal(trainingStopped(town({ "workers": 150, "saving": true, "target": 200 })), false, "154 is not");
	});

	it("starts the support share at 0.85, at 0.7 before a rush, towards 1 in a long truce", () =>
	{
		assert.equal(supportAlpha(false, undefined), 0.85);
		assert.equal(supportAlpha(true, undefined), 0.7);
		assert.ok(Math.abs(supportAlpha(false, 600) - 1) < 1e-12, "more than five minutes left: 1");
		assert.ok(Math.abs(supportAlpha(true, 210) - 0.85) < 1e-12, "half the 180 s ramp: from 0.7 halfway to 1");
		assert.equal(supportAlpha(true, 100), 0.7, "under two minutes left: as without a truce");
	});

	it("wants support units by the share, capped by the ratio, at 0.1 without fields", () =>
	{
		// 0.5 · 60 = 30 at most; at 30 workers in peace 30 · (1 − e^−0.85) = 17.2
		assert.ok(Math.abs(supportShare(30, 0.5, 60, 0.85, true) - 30 * (1 - Math.exp(-0.85))) < 1e-12);
		assert.ok(supportShare(1000, 0.5, 60, 0.85, true) < 30 && supportShare(1000, 0.5, 60, 0.85, true) > 29.99);
		assert.ok(Math.abs(supportShare(30, 0.5, 60, 0.85, false) - 6 * (1 - Math.exp(-0.85 * 5))) < 1e-12, "no fields: 6 at most");
	});

	it("chooses soldiers quick and cheap below 45 workers, then the strongest", () =>
	{
		assert.deepEqual(soldierRequirements(44), [["speed", 0.5], ["costsResource", 0.5, "stone"], ["costsResource", 0.5, "metal"]]);
		assert.deepEqual(soldierRequirements(45), [["strength", 1]]);
	});
});
