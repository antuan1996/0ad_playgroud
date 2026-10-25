/**
 * Integration test: plays one fixed headless match of Petra TS against itself
 * in the real game and checks its record for anomalies (match-checks.ts).
 *
 *   npm run test:petra:match
 *
 * Needs the engine built from this repository (binaries/system/pyrogenesis);
 * skipped without it. Takes one to two minutes.
 *
 * The seeds are fixed, so the game is the same on every run of the same code
 * and a failure replays with the rerun line of match.txt; the record is kept in
 * build/petra_ts/matches/test/. The checks hold for any healthy game, so a
 * change to the bot that changes the game still passes; the fingerprint is
 * printed to show whether it did. The game is the eighth of the mirror batch in
 * tests/FINDINGS.md §11: both sides reach town and city phase, the winner the
 * population cap, decided at 46:20 after a long fight.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMatch } from "./match-checks.ts";

const repo = join(import.meta.dirname, "..", "..");
const game = join(repo, "binaries", "system", "pyrogenesis");
const record = join(repo, "build", "petra_ts", "matches", "test");

const match = [
	"-m", "random/mainland",
	"-s", "287591089",
	"-a", "941505347",
	"-d", "5",
	"-c", "athen",
	"-w", "conquest",
	"-o", "petra_out",
	// headless, timeline, command log and notices, the bot's state, end at 90
	// game minutes if undecided
	"-n", "-t", "-l", "-b", "-T",
	"-r", record
];

test("a mirror match of Petra TS in the game shows no anomaly", {
	"skip": existsSync(game) ? false : `${game} is missing: build the engine first (see CLAUDE.md)`,
	"timeout": 10 * 60 * 1000
}, async t =>
{
	const run = spawnSync(join(repo, "build", "petra_ts", "match.sh"), match, { "encoding": "utf8", "maxBuffer": 1 << 30 });
	assert.equal(run.status, 0, `match.sh failed:\n${run.stderr.slice(-2000)}`);
	const report = readFileSync(join(record, "match.txt"), "utf8");
	t.diagnostic(`record: ${record}`);
	t.diagnostic(/^fingerprint: \S+/m.exec(report)?.[0] ?? "no fingerprint");
	t.diagnostic(/^rerun.*$/m.exec(report)?.[0] ?? "");

	for (const { name, ok, detail } of checkMatch(record))
		await t.test(name, () =>
		{
			t.diagnostic(`${name}: ${detail}`);
			assert.ok(ok, detail);
		});
});
