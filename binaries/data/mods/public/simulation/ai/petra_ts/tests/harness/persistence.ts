/**
 * Save/reload checks.
 *
 * Petra holds its whole state in memory and has no storage of its own: on save
 * every manager returns a `Serialize()` blob, and on load a freshly constructed
 * manager is filled from that blob by `Deserialize()`. A field that one of the
 * two forgets is invisible while a game runs — it only shows up after a reload,
 * mid-match, when the AI quietly loses its attack list or its trade route.
 *
 * So the check is a round trip: put non-default values into a manager, save it,
 * restore a *different* instance from that data, and require the second instance
 * to save to exactly the same data. A field `Deserialize` ignores then shows up
 * as a key missing from the second save; a field `Serialize` forgets shows up as
 * a key that only appears after a reload.
 *
 * This works without naming a single field, which is the point: the port
 * replaced `for (const key in data) this[key] = data[key]` with explicit field
 * lists, and a list is only trustworthy if something checks it mechanically.
 */
import assert from "node:assert/strict";

/** The part of a manager this harness calls. */
export interface Serializable
{
	Serialize(): unknown;
	Deserialize(...args: never[]): void;
}

export interface RoundTrip<T>
{
	/** What is being checked, for the failure message. */
	label: string;
	/** A fresh instance holding the state that will be saved. */
	original(): T;
	/** A fresh instance of the same class, to restore the save into. */
	restored(): T;
	/** Fields left at their constructed value (see `populate`). */
	keep?: readonly string[];
	/**
	 * Fields that are deliberately not saved, each with the reason. A field that
	 * is set but absent from the save is a bug unless it is listed here, so this
	 * list is the whole record of what a manager chooses not to remember.
	 */
	notSaved?: Record<string, string>;
	/** Values set on the original after `populate`, for state it cannot invent. */
	set?: Record<string, unknown>;
	/**
	 * How to call `Deserialize`. The default passes `(gameState, data)` when the
	 * method takes two parameters and `(data)` when it takes one.
	 */
	restore?: (instance: T, data: unknown, gameState: CommonGameState) => void;
	/**
	 * Run on the restored instance before it is filled in, for a world that has
	 * to point at the object being restored already — Petra reaches for
	 * `gameState.ai.HQ` from inside `Deserialize`.
	 */
	prepare?: (instance: T) => void;
}

/**
 * Give every own scalar field a value that no default has, so a field dropped
 * on the way through a save cannot hide behind an identical default.
 *
 * Only numbers, strings and booleans are touched. Objects, arrays, Maps and
 * Sets are left as constructed — a test that wants them filled says so in
 * `set`, because only it knows what a sensible entry is.
 */
export function populate(target: object, options: { keep?: readonly string[] } = {}): string[]
{
	const keep = new Set(options.keep ?? []);
	const values = target as Record<string, unknown>;
	const touched: string[] = [];

	for (const [key, value] of Object.entries(values))
	{
		if (keep.has(key))
			continue;

		if (typeof value === "number")
			values[key] = 7;
		else if (typeof value === "string")
			values[key] = `${key}_probe`;
		else if (typeof value === "boolean")
			values[key] = !value;
		else
			continue;

		touched.push(key);
	}

	return touched;
}

/**
 * Deep-copy plain data so the two saves can be compared honestly.
 *
 * `Serialize` is free to hand out its own arrays and objects rather than copies.
 * Comparing such a save with itself would prove nothing, so the first save is
 * snapshotted before it is handed to `Deserialize`. Values that are not plain
 * data are kept by reference — they cannot survive a real save either, and a
 * test will see them as a type mismatch.
 */
function snapshot(value: unknown): unknown
{
	if (Array.isArray(value))
		return value.map(snapshot);
	if (value instanceof Map)
		return new Map([...value].map(([key, item]) => [snapshot(key), snapshot(item)]));
	if (value instanceof Set)
		return new Set([...value].map(snapshot));

	if (value && typeof value === "object")
	{
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null)
			return value;
		const copy: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>))
			copy[key] = snapshot(item);
		return copy;
	}

	return value;
}

function callSerialize(instance: object, label: string): unknown
{
	try
	{
		return (instance as unknown as Serializable).Serialize();
	}
	catch (err)
	{
		throw new Error(`${label}: Serialize() threw: ${(err as Error).message}`);
	}
}

function callDeserialize(instance: object, data: unknown, gameState: CommonGameState, label: string): void
{
	const method = (instance as unknown as Serializable).Deserialize;
	if (typeof method !== "function")
		throw new Error(`${label}: no Deserialize method`);

	try
	{
		if (method.length === 1)
			(method as (data: unknown) => void).call(instance, data);
		else
			(method as (gameState: CommonGameState, data: unknown) => void).call(instance, gameState, data);
	}
	catch (err)
	{
		throw new Error(`${label}: Deserialize() threw: ${(err as Error).message}`);
	}
}

/** Every key name appearing anywhere in a save, at any depth. */
function allKeys(value: unknown, into = new Set<string>()): Set<string>
{
	if (Array.isArray(value))
	{
		for (const item of value)
			allKeys(item, into);
	}
	else if (value instanceof Map)
	{
		for (const item of value.values())
			allKeys(item, into);
	}
	else if (value && typeof value === "object")
	{
		for (const [key, item] of Object.entries(value as Record<string, unknown>))
		{
			into.add(key);
			allKeys(item, into);
		}
	}
	return into;
}

/** Keys present in one save and not the other, for a readable failure. */
function keyDiff(before: unknown, after: unknown): string
{
	if (!before || !after || typeof before !== "object" || typeof after !== "object")
		return "";

	const out: string[] = [];
	const dropped = Object.keys(before).filter(key => !(key in (after as object)));
	const appeared = Object.keys(after).filter(key => !(key in (before as object)));
	if (dropped.length)
		out.push(`lost on reload: ${dropped.join(", ")}`);
	if (appeared.length)
		out.push(`only present after a reload: ${appeared.join(", ")}`);
	return out.join("; ");
}

/**
 * Check that one instance restores exactly what another saved, and that the
 * save covers the state the instance holds.
 *
 * `original` is populated first, so both checks cover the fields the class
 * actually has rather than the ones a freshly built instance happens to set.
 */
export function assertRoundTrip<T extends object>(rt: RoundTrip<T>, gameState: CommonGameState): void
{
	const original = rt.original();
	const touched = populate(original, { keep: rt.keep });
	if (rt.set)
		Object.assign(original, rt.set);
	if (rt.prepare)
		rt.prepare(original);

	const saved = snapshot(callSerialize(original, rt.label));

	// A field that Serialize stopped writing is invisible to the round trip
	// below — both saves would be missing it and agree — so check the save
	// against the state that went into it.
	const notSaved = rt.notSaved ?? {};
	const forgotten = touched.filter(key => !(key in notSaved) && !allKeys(saved).has(key));
	assert.equal(
		forgotten.length,
		0,
		`${rt.label}: set, but never written to the save — ${forgotten.join(", ")}` +
			`. Add them to Serialize, or to notSaved with a reason`
	);

	const restored = rt.restored();
	if (rt.prepare)
		rt.prepare(restored);
	if (rt.restore)
		rt.restore(restored, saved, gameState);
	else
		callDeserialize(restored, saved, gameState, rt.label);

	const reloaded = callSerialize(restored, `${rt.label} (after reload)`);

	const detail = keyDiff(saved, reloaded);
	assert.deepStrictEqual(
		reloaded,
		saved,
		`${rt.label}: saving and reloading changed the data` + (detail ? ` — ${detail}` : "")
	);
}
