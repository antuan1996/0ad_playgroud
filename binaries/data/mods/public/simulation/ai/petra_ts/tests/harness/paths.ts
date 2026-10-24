/**
 * Locations the test harness needs, and which implementation under test is
 * selected.
 *
 * Two implementations of the same AI sit side by side in the mod, and the
 * suite runs against either one, chosen with the PETRA_TARGET environment
 * variable (see the npm scripts):
 *
 *   src  simulation/ai/petra_ts/*.ts  the port, run by Node directly
 *   ref  simulation/ai/petra/*.js     the original hand-written AI the port
 *                                     was derived from, and what the game
 *                                     loads today
 *   out  simulation/ai/petra_out/*.js the port as the game loads it, the
 *                                     "Petra TS" bot (npm run build:petra:out):
 *                                     not another implementation, a check
 *                                     that the build output still works
 *
 * `ref` is the game's own copy. The harness only ever imports it, so running
 * the suite cannot change it — but nothing here should either.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PetraTarget = "src" | "ref" | "out";

const VALID: PetraTarget[] = ["src", "ref", "out"];

function findRepoRoot(): string
{
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;)
	{
		if (existsSync(path.join(dir, "package.json")))
			return dir;
		const parent = path.dirname(dir);
		if (parent === dir)
			throw new Error("could not locate the repository root above " + path.dirname(fileURLToPath(import.meta.url)));
		dir = parent;
	}
}

export const repoRoot = findRepoRoot();

/** VFS root of the public mod: an engine path "simulation/x.js" is this plus that. */
export const modsPublic = path.join(repoRoot, "binaries/data/mods/public");

/**
 * VFS root of the base "mod" mod, which the engine stacks under every other
 * mod. Its `globalscripts/` (l10n, sprintf) are therefore globals too, even
 * though they are not in the public mod.
 */
export const modsBase = path.join(repoRoot, "binaries/data/mods/mod");

export const aiRoot = path.join(modsPublic, "simulation/ai");

export const commonApiRoot = path.join(aiRoot, "common-api");

export function vfsToDisk(vfsPath: string): string
{
	return path.join(modsPublic, vfsPath);
}

export function petraTarget(): PetraTarget
{
	const raw = process.env["PETRA_TARGET"] ?? "src";
	if (!VALID.includes(raw as PetraTarget))
		throw new Error(`PETRA_TARGET must be one of ${VALID.join(", ")} (got "${raw}")`);
	return raw as PetraTarget;
}

/** Directory holding the modules under test, and the extension they use. */
export function petraModuleDir(target = petraTarget()): { dir: string; ext: string }
{
	switch (target)
	{
	case "src":
		return { dir: path.join(aiRoot, "petra_ts"), ext: ".ts" };
	case "ref":
		return { dir: path.join(aiRoot, "petra"), ext: ".js" };
	case "out":
		return { dir: path.join(aiRoot, "petra_out"), ext: ".js" };
	}
}
