/**
 * Crossing into the branded ids (PLAN.md §3.3).
 *
 * `EntityId` and `PlayerId` (engine-api.d.ts) are numbers with a compile-time
 * tag, so one cannot be passed for the other or for a plain count. Values that
 * come from the engine (`ent.id()`, `ent.owner()`, events, `PlayerID`) carry
 * the tag already. These functions are the only way to give it to a number
 * the types cannot follow: a property name read back by `for...in`, a loop
 * over player indices, a value restored from a save. They return their
 * argument unchanged, so the game plays the same with them as without.
 */

/** A number known to be an entity id. */
export function entityId(value: number): EntityId
{
	return value as EntityId;
}

/** A number known to be a player index (0 is Gaia). */
export function playerId(value: number): PlayerId
{
	return value as PlayerId;
}

/** Gaia, the player 0 that owns the map's neutral entities. */
export const GAIA: PlayerId = playerId(0);

/** The engine's INVALID_PLAYER: no player, as for an entity not yet owned. */
export const INVALID_PLAYER: PlayerId = playerId(-1);

/** The engine's INVALID_ENTITY: no entity. */
export const INVALID_ENTITY: EntityId = entityId(0);

/** A world position from its coordinates: the same new [x, z] array as a literal. */
export function worldPos(x: number, z: number): WorldPos
{
	return [x, z] as WorldPos;
}

/** A region the caller knows to be land (from `regionType`, or as a land's place in a route). */
export function landRegion(value: number): AccessIndex
{
	return value as AccessIndex;
}

/** A region the caller knows to be sea (from `regionType`, or as a sea's place in a route). */
export function seaRegion(value: number): SeaIndex
{
	return value as SeaIndex;
}

/** Region 0, no land in particular: as a filter it matches any land. */
export const NO_LAND: AccessIndex = landRegion(0);

/** Region -1, no region at all (a base that has none yet): it matches no land. */
export const NO_REGION: AccessIndex = landRegion(-1);

/** A number of game seconds, Petra's unit of time (a literal, or the result of arithmetic on times). */
export function seconds(value: number): GameSeconds
{
	return value as GameSeconds;
}

/** The engine's milliseconds as Petra's seconds. */
export function secondsOf(time: GameMs): GameSeconds
{
	return seconds(time / 1000);
}

/** A string known to be a template name with the civilisation filled in. */
export function templateName(value: string): TemplateName
{
	return value as TemplateName;
}

/** No template: the empty name a search starts from before it finds one. */
export const NO_TEMPLATE: TemplateName = templateName("");

/** The cell `index` of `map`, on that map's grid. */
export function cellIndex<G extends GridKind>(map: { readonly __grid?: G }, index: number): CellIndex<G>
{
	return index as CellIndex<G>;
}
