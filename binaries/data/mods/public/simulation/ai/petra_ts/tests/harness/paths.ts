/**
 * Where the code under test lives, and which build of it is selected.
 *
 * The tests import the port's sources (`../decision/headquarters.ts`). The
 * PETRA_TARGET environment variable picks what those imports load (see the
 * npm scripts and hooks.ts):
 *
 *   src  simulation/ai/petra_ts/**\/*.ts  the port, run by Node directly
 *   out  simulation/ai/petra_out/**\/*.js the port as the game loads it, the
 *                                        "Petra TS" bot (npm run build:petra:out):
 *                                        a check that the build output works
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PetraTarget = "src" | "out";

const TARGETS: readonly string[] = ["src", "out"] satisfies PetraTarget[];

function isTarget(name: string): name is PetraTarget
{
	return TARGETS.includes(name);
}

/** The port's sources: simulation/ai/petra_ts. */
export const portRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const aiRoot = path.dirname(portRoot);

/** The bot built from the port: simulation/ai/petra_out. */
export const outRoot = path.join(aiRoot, "petra_out");

/** VFS root of the public mod: an engine path "simulation/x.js" is this plus that. */
export const modsPublic = path.resolve(aiRoot, "../..");

/**
 * VFS root of the base "mod" mod, which the engine stacks under every other
 * mod. Its `globalscripts/` (l10n, sprintf) are therefore globals too, even
 * though they are not in the public mod.
 */
export const modsBase = path.join(path.dirname(modsPublic), "mod");

export function petraTarget(): PetraTarget
{
	const raw = process.env["PETRA_TARGET"] ?? "src";
	if (!isTarget(raw))
		throw new Error(`PETRA_TARGET must be one of ${TARGETS.join(", ")} (got "${raw}")`);
	return raw;
}

/** Directory holding the modules under test, and the extension they use. */
export function petraModuleDir(target = petraTarget()): { dir: string; ext: string }
{
	return target === "src" ? { "dir": portRoot, "ext": ".ts" } : { "dir": outRoot, "ext": ".js" };
}
