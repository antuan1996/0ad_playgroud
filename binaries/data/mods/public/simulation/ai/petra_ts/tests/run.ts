/**
 * Runs the Petra unit tests against one build of the port.
 *
 *   node tests/run.ts              # the sources: simulation/ai/petra_ts/**\/*.ts
 *   node tests/run.ts out          # the built "Petra TS" bot: simulation/ai/petra_out/**\/*.js
 *   node tests/run.ts --coverage   # the sources, plus Node's coverage report
 *
 * Until stage 3 (PLAN.md) the same tests also ran against the original
 * petra/*.js; its modules no longer match the port's, so it is no target now
 * (the parity of the frozen port is checked in games, stage 1).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = ["src", "out"];
const [target = "src", ...flags] = process.argv.slice(2);

if (!targets.includes(target) || flags.some((flag) => flag !== "--coverage"))
{
	console.error(`usage: run.ts [${targets.join("|")}] [--coverage]`);
	process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// node --test takes files or globs, not a directory to search, and wants the
// pattern with forward slashes even on Windows.
const pattern = `${here.split(path.sep).join("/")}/**/*.test.ts`;

// Node reports V8 coverage, but rejects its flags in NODE_OPTIONS, so they
// have to reach the runner through the spawn below. The report is scoped to
// the code under test: the harness and the tests themselves are left out. The
// flags go before the pattern - node --test reads anything after a file
// pattern as more patterns, not as flags.
const coverageFlags = flags.includes("--coverage")
	? [
		"--experimental-test-coverage",
		`--test-coverage-include=${target === "out" ? "**/petra_out/**" : "**/petra_ts/**"}`,
		"--test-coverage-exclude=**/tests/**"
	]
	: [];

const result = spawnSync(
	process.execPath,
	["--test", ...coverageFlags, pattern],
	{ stdio: "inherit", env: { ...process.env, "PETRA_TARGET": target } }
);

if (result.error)
	throw result.error;

process.exit(result.status ?? 1);
