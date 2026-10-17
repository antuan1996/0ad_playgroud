/**
 * Runs the Petra unit tests against one implementation.
 *
 *   node tests/run.ts              # the port: simulation/ai/petra_ts/*.ts
 *   node tests/run.ts ref          # the original: simulation/ai/petra/*.js
 *   node tests/run.ts --coverage   # the port, plus a coverage report
 *   node tests/run.ts ref --coverage
 *
 * The two are expected to agree except where the port deliberately behaves
 * differently; a `ref` run then exits non-zero, and that failure is the record
 * of the difference rather than of a regression.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = ["src", "ref"];
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
		`--test-coverage-include=${target === "ref" ? "**/petra/**" : "**/petra_ts/**"}`,
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
