/**
 * Lets Node resolve the engine's VFS-style import specifiers.
 *
 * The AI scripts import each other the way the game's module loader addresses
 * files in the VFS, e.g. `simulation/ai/common-api/utils.js`, and the reference
 * JS also names its own siblings that way (`simulation/ai/petra/queue.js`).
 * Node has no idea what those mean, so they are mapped to real paths:
 *
 *   simulation/ai/petra/<x>      -> the target under test (petra_ts, petra_out or ref)
 *   simulation/ai/petra_ts/<x>   -> the same
 *   simulation/<x>               -> binaries/data/mods/public/simulation/<x>
 *
 * Registered from setup.ts, which tests are run through, so it is installed
 * before any module under test is imported.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { commonApiRoot, petraModuleDir, vfsToDisk } from "./paths.ts";

registerHooks({
	resolve(specifier, context, nextResolve)
	{
		if (!specifier.startsWith("simulation/"))
			return nextResolve(specifier, context);

		const file = resolveVfs(specifier);
		if (!existsSync(file))
			throw new Error(`cannot resolve engine specifier "${specifier}" (looked for ${file})`);

		return { url: pathToFileURL(file).href, shortCircuit: true };
	}
});

function resolveVfs(specifier: string): string
{
	const petraPrefixed = /^simulation\/ai\/(?:petra|petra_ts)\/(.+)$/;
	const match = petraPrefixed.exec(specifier);
	if (match)
	{
		const { dir, ext } = petraModuleDir();
		// The reference spells its siblings ".js"; the sources spell them ".ts".
		const name = match[1].replace(/\.js$/, ext);
		return path.join(dir, name);
	}

	if (specifier.startsWith("simulation/ai/common-api/"))
		return path.join(commonApiRoot, specifier.slice("simulation/ai/common-api/".length));

	return vfsToDisk(specifier);
}
