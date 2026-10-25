/**
 * Loads the module under test.
 *
 * Importing this file installs everything the AI scripts need to be loaded at
 * all — the VFS specifier hooks and the engine globals — so a test only has to
 * ask for a module by name:
 *
 *   const { Queue } = await loadPetraModule<{ Queue: new () => Queue }>("queue");
 *
 * Which implementation is returned depends on PETRA_TARGET; see paths.ts.
 * Node caches modules by resolved path, so repeated loads are cheap and share
 * state the way two imports of the same file would.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import "./hooks.ts";
import { installEngineGlobals } from "./engine.ts";
import { commonApiRoot, petraModuleDir, petraModuleFile, petraTarget, type PetraTarget } from "./paths.ts";

installEngineGlobals();

export type { PetraTarget };

export const target: PetraTarget = petraTarget();

export function targetLabel(): string
{
	return `${target} (${petraModuleDir().dir})`;
}

/**
 * Load module `name` (`<name>.ts`/`.js`) of the target, e.g. "queue",
 * "headquarters", from whichever layer folder holds it.
 */
export function loadPetraModule<T>(name: string): Promise<T>
{
	return import(pathToFileURL(petraModuleFile(name)).href) as Promise<T>;
}

/**
 * Load a shared `common-api` module, e.g. "resources" for ResourcesManager.
 * These are the same file for every target — they are not part of the port.
 */
export function loadCommonModule<T>(name: string): Promise<T>
{
	return import(pathToFileURL(path.join(commonApiRoot, name + ".js")).href) as Promise<T>;
}
