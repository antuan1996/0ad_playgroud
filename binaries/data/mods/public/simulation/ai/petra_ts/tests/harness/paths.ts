/**
 * Locations the test harness needs, and which implementation under test is
 * selected.
 *
 * Three targets can be tested, chosen with the PETRA_TARGET environment
 * variable (see the npm scripts):
 *
 *   src  petra_ts/*.ts        the TypeScript sources, run by Node directly
 *   out  petra_out/*.js       the same code transpiled, what the game loads
 *   ref  build/petra_check/ref/*.js
 *                            the hand-written JS the port was derived from
 *
 * `ref` is extracted from git and is gitignored; see the note in
 * build/petra_check/NOTES.md. It exists only while the port is being verified.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PetraTarget = "src" | "out" | "ref";

const VALID: PetraTarget[] = ["src", "out", "ref"];

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
	case "out":
		return { dir: path.join(aiRoot, "petra_out"), ext: ".js" };
	case "ref":
		return { dir: path.join(repoRoot, "build/petra_check/ref"), ext: ".js" };
	}
}
