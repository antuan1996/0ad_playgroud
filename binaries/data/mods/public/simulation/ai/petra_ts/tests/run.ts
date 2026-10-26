/**
 * Runs the Petra unit tests against one build of the port.
 *
 *   node tests/run.ts              # the sources: simulation/ai/petra_ts/**\/*.ts
 *   node tests/run.ts out          # the built "Petra TS" bot: simulation/ai/petra_out/**\/*.js
 *   node tests/run.ts --coverage   # the sources, plus Node's coverage report
 *   node tests/run.ts src queue.test.ts --test-name-pattern="restor"
 *
 * Test files (a path, or a name in tests/) and other `node --test` flags after
 * the target pass through; with no file given, every tests/**\/*.test.ts runs.
 * Each test process preloads harness/setup.ts, which lets the tests import the
 * port.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PetraTarget } from "./harness/paths.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The node arguments that run `files` (default: the whole suite) on the selected target. */
export function testArgs(files: string[] = [], flags: string[] = []): string[]
{
	// node --test takes files or globs, not a directory to search, and wants
	// the pattern with forward slashes even on Windows. Flags go before the
	// files: node --test reads anything after a file as another file.
	const patterns = files.length ? files : [`${here.split(path.sep).join("/")}/**/*.test.ts`];
	return ["--import", pathToFileURL(path.join(here, "harness/setup.ts")).href, "--test", ...flags, ...patterns];
}

if (import.meta.main)
{
	const args = process.argv.slice(2);
	const first = args[0];
	const target: PetraTarget = first === "src" || first === "out" ? first : "src";
	if (first === target)
		args.shift();
	process.env["PETRA_TARGET"] = target;

	// Node reports V8 coverage, but rejects its flags in NODE_OPTIONS, so they
	// reach the runner through the spawn below. The report is scoped to the
	// code under test: the harness and the tests themselves are left out.
	const coverage = args.includes("--coverage") ?
		[
			"--experimental-test-coverage",
			`--test-coverage-include=${target === "out" ? "**/petra_out/**" : "**/petra_ts/**"}`,
			"--test-coverage-exclude=**/tests/**"
		] :
		[];
	const rest = args.filter((arg) => arg !== "--coverage");
	const flags = [...coverage, ...rest.filter((arg) => arg.startsWith("-"))];
	const files = rest.filter((arg) => !arg.startsWith("-"))
		.map((file) => existsSync(file) ? file : path.join(here, file));

	const result = spawnSync(process.execPath, testArgs(files, flags), { "stdio": "inherit", "env": process.env });
	if (result.error)
		throw result.error;
	process.exit(result.status ?? 1);
}
