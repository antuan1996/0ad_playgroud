/**
 * Lets Node load the port the way the engine does.
 *
 * - The AI scripts import each other by VFS path, e.g.
 *   `simulation/ai/common-api/utils.js`, and the built bot names its own
 *   modules that way (`simulation/ai/petra_out/execution/queue.js`). Those map
 *   to the public mod's files.
 * - The tests import the port's sources (`../execution/queue.ts`). With
 *   PETRA_TARGET=out each such import loads the built module instead
 *   (`petra_out/execution/queue.js`), so the same tests check the build the
 *   game loads, and the built modules, importing each other by VFS path, are
 *   the same instances the tests hold.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { modsPublic, outRoot, petraTarget, portRoot } from "./paths.ts";

const testsRoot = path.join(portRoot, "tests");
const toBuild = petraTarget() === "out";

registerHooks({
	resolve(specifier, context, nextResolve)
	{
		if (specifier.startsWith("simulation/"))
			return { "url": pathToFileURL(existing(path.join(modsPublic, specifier), specifier)).href, "shortCircuit": true };

		const resolved = nextResolve(specifier, context);
		if (!toBuild || !resolved.url.startsWith("file:"))
			return resolved;
		const file = fileURLToPath(resolved.url);
		if (!file.startsWith(portRoot + path.sep) || file.startsWith(testsRoot + path.sep))
			return resolved;
		const built = path.join(outRoot, path.relative(portRoot, file)).replace(/\.ts$/, ".js");
		return { "url": pathToFileURL(existing(built, specifier)).href, "shortCircuit": true };
	}
});

function existing(file: string, specifier: string): string
{
	if (!existsSync(file))
		throw new Error(`cannot resolve "${specifier}" (looked for ${file})`);
	return file;
}
