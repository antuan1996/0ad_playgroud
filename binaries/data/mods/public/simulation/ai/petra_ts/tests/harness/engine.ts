/**
 * Recreates the global scope the game gives the AI scripts.
 *
 * In the game, AI scripts run in a SpiderMonkey context where the mod's
 * `globalscripts/*.js` have already been evaluated and a handful of engine
 * builtins exist. Node has neither, so this module:
 *
 *   1. evaluates the real `globalscripts/*.js` as classic scripts, so the AI
 *      sees the same Vector2D, Math, FSM, Resources, ... it sees in game;
 *   2. installs the engine builtins those scripts and the AI call, backed by
 *      the real files on disk where a real answer is available
 *      (`ReadJSONFile`, `ListDirectoryFiles`) and by recorders elsewhere
 *      (`PostCommand`), so a test can assert on what the AI asked the game to do.
 *
 * Anything not stubbed raises an error naming itself rather than returning
 * undefined, so a test cannot pass by accident on a missing global.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { modsBase, modsPublic } from "./paths.ts";

/** Commands handed to Engine.PostCommand, oldest first. */
export const commands: unknown[] = [];

/** Everything passed to warn()/error(), oldest first. */
export const logs: string[] = [];

export function resetRecorder(): void
{
	commands.length = 0;
	logs.length = 0;
}

/** Thrown by Engine.Exit so a test can tell "the AI gave up" from a crash. */
export class EngineExit extends Error
{
	code: number;
	constructor(code: number)
	{
		super(`Engine.Exit(${code})`);
		this.code = code;
	}
}

type EngineStub = Record<string, (...args: never[]) => unknown>;

function makeEngine(): object
{
	const real: Record<string, unknown> = {
		PostCommand: (player: number, command: unknown) => {
			void player;
			commands.push(command);
		},
		ProfileStart: () => undefined,
		ProfileStop: () => undefined,
		ComputePath: () => null,
		DumpImage: () => undefined,
		GetTemplate: () => null,
		Exit: (code: number) => {
			throw new EngineExit(code);
		},
		// VFS reads answered from the real mod files on disk.
		ReadJSONFile: (vfsPath: string) => {
			const file = path.join(modsPublic, vfsPath);
			if (!existsSync(file))
				return null;
			return JSON.parse(readFileSync(file, "utf8"));
		},
		ListDirectoryFiles: (vfsDir: string, extension = "*", recurse = false) => {
			const dir = path.join(modsPublic, vfsDir);
			if (!existsSync(dir))
				return [];
			const suffix = extension.replace(/^\*/, "");
			const out: string[] = [];
			for (const entry of readdirSync(dir, { recursive: recurse }))
			{
				const name = entry.toString();
				if (!name.endsWith(suffix))
					continue;
				out.push(path.posix.join(vfsDir.replace(/\/+$/, ""), name.split(path.sep).join("/")));
			}
			return out.sort();
		}
	};

	return new Proxy(real, {
		get(target, property)
		{
			if (typeof property === "symbol" || property === "then" || property === "inspect")
				return undefined;
			if (property in target)
				return target[property];
			throw new Error(`Engine.${property} is not stubbed — add it to tests/harness/engine.ts`);
		}
	}) as EngineStub;
}

/**
 * Stand-in for SpiderMonkey's `uneval`. The AI only uses it to render values
 * into warning messages, so a readable rendering is enough; it is not
 * byte-identical to the engine's.
 */
function uneval(value: unknown, depth = 0): string
{
	if (depth > 4)
		return "...";
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "function")
		return `[function ${(value as { name?: string }).name ?? "anonymous"}]`;
	if (value instanceof Set)
		return `new Set([${[...value].map(item => uneval(item, depth + 1)).join(", ")}])`;
	if (value instanceof Map)
		return `new Map([${[...value].map(([k, v]) => `[${uneval(k, depth + 1)}, ${uneval(v, depth + 1)}]`).join(", ")}])`;
	if (Array.isArray(value))
		return `[${value.map(item => uneval(item, depth + 1)).join(", ")}]`;
	if (typeof value === "object")
	{
		const entries = Object.entries(value as Record<string, unknown>)
			.map(([key, item]) => `${key}: ${uneval(item, depth + 1)}`);
		return `{ ${entries.join(", ")} }`;
	}
	return String(value);
}

/**
 * Every script the game evaluates before any mod code runs. The engine globs
 * `globalscripts/*.js` across the whole VFS stack (scriptinterface/Interface.cpp),
 * so the base mod's files count as well — `markForTranslation`, which Petra
 * calls at module scope, comes from `mods/mod/globalscripts/l10n.js`.
 *
 * Each mod's files are loaded in name order so the set cannot silently drift
 * as the mods gain files.
 */
function globalScriptFiles(): { dir: string; file: string }[]
{
	const out: { dir: string; file: string }[] = [];
	for (const root of [modsBase, modsPublic])
	{
		const dir = path.join(root, "globalscripts");
		for (const file of readdirSync(dir).filter(name => name.endsWith(".js")).sort())
			out.push({ dir, file });
	}
	return out;
}

let installed = false;

/** Put the AI's global scope in place. Safe to call more than once. */
export function installEngineGlobals(): void
{
	if (installed)
		return;
	installed = true;

	const g = globalThis as Record<string, unknown>;

	g["Engine"] = makeEngine();
	g["uneval"] = uneval;
	// The engine registers its deepcopy builtin as "clone" (Interface.cpp 370).
	// The AI calls it on plain data (positions, path arrays) only, so Node's
	// structuredClone is the same answer.
	g["clone"] = (value: unknown) => structuredClone(value);
	g["global"] = globalThis;
	g["warn"] = (message: unknown) => { logs.push(String(message)); };
	g["error"] = (message: unknown) => { logs.push(String(message)); };
	g["dump"] = (message: unknown) => { logs.push(String(message)); };
	g["deepfreeze"] = function deepfreeze(value: unknown): unknown
	{
		if (value && typeof value === "object")
		{
			Object.freeze(value);
			for (const child of Object.values(value as Record<string, unknown>))
				deepfreeze(child);
		}
		return value;
	};
	// baseAI.js normally sets this on import; tests that build a game state
	// without it still need a number rather than undefined.
	if (g["PlayerID"] === undefined)
		g["PlayerID"] = 1;

	// Indirect eval evaluates in global scope, which is what these classic
	// scripts expect: their top-level `function`/`var` become globals.
	const evaluateInGlobalScope = eval;
	for (const { dir, file } of globalScriptFiles())
	{
		try
		{
			evaluateInGlobalScope(readFileSync(path.join(dir, file), "utf8"));
		}
		catch (err)
		{
			throw new Error(`${path.basename(path.dirname(dir))}/globalscripts/${file} failed to load into the test global scope: ` +
				`${(err as Error).message}`);
		}
	}

	// common-api/resources.js does `Resources = new Resources()`, which needs
	// the constructor above to have produced a real resource list.
	if (typeof g["Resources"] !== "function")
		throw new Error("globalscripts/Resources.js did not define the Resources constructor");
}
