/**
 * An entity on the map. The common API's `position()` is undefined while an
 * entity is garrisoned, aboard a ship or not yet placed, and its other
 * readings follow (no land, no distance). The check is made once, with
 * `isPlaced`, where an entity enters a computation; past it the entity's
 * type says it has a position, so no reading after it is checked again.
 * A position is the turn's snapshot: it does not change within an AI turn.
 * A resource supply is checked the same way, once (`isSupply`).
 */

/** An entity whose position is known this turn (CommonPlacedEntity, common-api.d.ts). */
export type PlacedEntity = CommonPlacedEntity;

/** Whether the entity is on the map, narrowing it to a placed one. */
export function isPlaced(ent: CommonEntity): ent is PlacedEntity
{
	return ent.position() !== undefined;
}

/** A resource supply on the map (CommonSupplyEntity, common-api.d.ts). */
export type SupplyEntity = CommonSupplyEntity;

/**
 * Whether the entity is a resource supply on the map, narrowing it to one:
 * an entity with a supply type has the ResourceSupply component, so its
 * amount and gatherers are there too.
 */
export function isSupply(ent: CommonEntity): ent is SupplyEntity
{
	return ent.resourceSupplyType() !== undefined && isPlaced(ent);
}
