/**
 * The statistics of batch-stats.ts against known values.
 *
 *   node --test build/petra_ts/batch-stats.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sprt, summarise, wilson, type BatchRow } from "./batch-stats.ts";

const close = (actual: number, expected: number, digits = 3): void =>
	assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} is not ${expected}`);

test("the Wilson interval matches the textbook values", () =>
{
	// 50 of 100: 40.4%–59.6%; 0 of 10: 0–27.8%; 10 of 10: 72.2%–100%.
	const [low, high] = wilson(50, 100);
	close(low, 0.4038);
	close(high, 0.5962);
	close(wilson(0, 10)[1], 0.2775);
	close(wilson(10, 10)[0], 0.7225);
	assert.deepEqual(wilson(0, 0), [0, 1]);
});

test("the SPRT bounds are Wald's and the LLR moves with wins and losses", () =>
{
	const even = sprt(0, 0);
	close(even.upper, Math.log(19));
	close(even.lower, -Math.log(19));
	assert.equal(even.verdict, "undecided");
	// A win is worth ln(1.1), a loss ln(0.9).
	close(sprt(3, 2).llr, 3 * Math.log(1.1) + 2 * Math.log(0.9));
	assert.equal(sprt(60, 20).verdict, "H1");
	assert.equal(sprt(100, 120).verdict, "H0");
	assert.equal(sprt(50, 45).verdict, "undecided");
});

function game(index: number, outcome: BatchRow["outcome"], swapped: boolean, seed: number, fingerprint = `f${index}`): BatchRow
{
	return {
		"game": index, "map": "random/mainland", "mapSeed": seed, "aiSeed": seed, "blue": "petra_parity", "red": "petra_fixed",
		swapped, outcome, "reason": outcome == "draw" ? "time limit" : "last player alive", "decided": 30 * 60000,
		fingerprint, "errors": 0, "warnings": 0, "wall": 60, "worker": 0
	};
}

test("the summary counts outcomes, slots, sweeps and repeated games", () =>
{
	const rows = [
		game(1, "blue", false, 1), game(2, "blue", true, 1),
		game(3, "blue", false, 2), game(4, "red", true, 2),
		game(5, "draw", false, 3), game(6, "red", true, 3),
		game(7, "blue", false, 1, "f1"), game(8, "blue", false, 2, "other")
	];
	const summary = summarise(rows);
	assert.match(summary, /petra_parity won 5, petra_fixed won 2, 1 draws \(time limit\)/);
	assert.match(summary, /win-rate of petra_parity: 5\/7 = 71\.4%/);
	// Player 1 won games 1, 3, 7, 8 and lost 4 and 6 (red as player 1 won), 2 to red: 6 of 7.
	assert.match(summary, /win-rate of player 1 \(slot advantage\): 6\/7/);
	assert.match(summary, /petra_parity won both 1, petra_fixed won both 0, split or drawn 2/);
	assert.match(summary, /determinism: 2 games played more than once, 1 with different fingerprints \(games 3, 8\)/);
});
