import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { worldPos } from "./brands.ts";
import { isPlaced } from "./placed.ts";
import { attackBonuses, footprintHalves, isStructureTemplate } from "./templateData.ts";

/** returns true if this unit should be considered as a siege unit */
export function isSiegeUnit(ent: CommonEntity): boolean
{
	return ent.hasClasses(["Siege", "Elephant+Melee"]) === true;
}

/** returns true if this unit should be considered as "fast". */
export function isFastMoving(ent: CommonEntity): boolean
{
	// TODO: use clever logic based on walkspeed comparisons.
	return ent.hasClass("FastMoving") === true;
}

/** returns some sort of DPS * health factor. If you specify a class, it'll use the modifiers against that class too. */
export function getMaxStrength(
	ent: CommonTemplate,
	debugLevel: number,
	DamageTypeImportance: Record<string, number>,
	againstClass?: string,
): number
{
	let strength = 0;
	const attackTypes = ent.attackTypes();
	const weights = { importance: DamageTypeImportance, count: Object.keys(DamageTypeImportance).length, debugLevel };
	if (!attackTypes)
	{
		return strength;
	}

	for (const type of attackTypes)
	{
		if (type !== "Slaughter")
		{
			strength = addAttackStrength(strength, ent, type, weights, againstClass);
		}
	}

	const resistanceStrength = ent.resistanceStrengths();

	if (resistanceStrength && resistanceStrength.Damage)
	{
		for (const str in resistanceStrength.Damage)
		{
			strength = addDamageStrength(strength, weights, str, +resistanceStrength.Damage[str], "resistanceStrength");
		}
	}

	// ToDo: Add support for StatusEffects and Capture.

	return strength * ent.maxHitpoints() / 100.0;
}

/** How getMaxStrength weighs each damage type. */
interface DamageWeights
{
	importance: Record<string, number>;
	/** the number of damage types */
	count: number;
	debugLevel: number;
}

/** strength with one damage type's value added, weighted by its importance */
function addDamageStrength(strength: number, weights: DamageWeights, str: string, val: number, what: string): number
{
	if (weights.importance[str])
	{
		return strength + weights.importance[str] * val / weights.count;
	}
	if (weights.debugLevel > 0)
	{
		aiWarn(
			"Petra: " + str + " unknown " + what + " in getMaxStrength " + "(please add " + str + "  to config.js).",
		);
	}
	return strength;
}

/** strength with an attack type's damage, range and times added */
function addAttackStrength(
	strength: number,
	ent: CommonTemplate,
	type: string,
	weights: DamageWeights,
	againstClass?: string,
): number
{
	const attackStrength = ent.attackStrengths(type);
	for (const str in attackStrength)
	{
		let val = attackStrength[str];
		if (againstClass)
		{
			val *= ent.getMultiplierAgainst(type, againstClass) ?? NaN;
		}
		strength = addDamageStrength(strength, weights, str, val, "attackStrength");
	}

	const attackRange = ent.attackRange(type);
	if (attackRange)
	{
		strength += attackRange.max * 0.0125;
	}

	const attackTimes = ent.attackTimes(type);
	for (const str in attackTimes)
	{
		const val = parseFloat(String(attackTimes[str]));
		switch (str)
		{
			case "repeat":
				strength += val / 100000;
				break;
			case "prepare":
				strength -= val / 100000;
				break;
			default:
				aiWarn("Petra: " + str + " unknown attackTimes in getMaxStrength");
		}
	}
	return strength;
}

/**
 * Get access and cache it (except for units as it can change) in metadata if not already done.
 * An entity on the map always has one; one off the map has its holder's, or none.
 */
export function getLandAccess(gameState: CommonGameState, ent: CommonPlacedEntity): AccessIndex;
export function getLandAccess(gameState: CommonGameState, ent: CommonEntity): AccessIndex | undefined;
export function getLandAccess(gameState: CommonGameState, ent: CommonEntity): AccessIndex | undefined
{
	if (ent.hasClass("Unit"))
	{
		const pos = ent.position();
		if (!pos)
		{
			const holder = getHolder(gameState, ent);
			if (holder)
			{
				return getLandAccess(gameState, holder);
			}

			aiWarn("Petra error: entity without position, but not garrisoned");
			dumpEntity(ent);
			return undefined;
		}
		return gameState.ai.accessibility.getAccessValue(pos);
	}

	let access = ent.getMetadata(PlayerID, "access");
	// a structure, a supply, a treasure: never off the map
	const entPos = ent.position();
	if (!access && entPos)
	{
		access = gameState.ai.accessibility.getAccessValue(entPos);
		// Docks are sometimes not as expected
		if (access < 2 && ent.buildPlacementType() === "shore")
		{
			const halfDepth = footprintHalves(ent).halfDepth;
			const entAngle = ent.angle();
			const cosa = Math.cos(entAngle ?? NaN);
			const sina = Math.sin(entAngle ?? NaN);
			for (let d = 3; d < halfDepth; d += 3)
			{
				const pos: CommonPosition = worldPos(entPos[0] - d * sina, entPos[1] - d * cosa);
				access = gameState.ai.accessibility.getAccessValue(pos);
				if (access > 1)
				{
					break;
				}
			}
		}
		ent.setMetadata(PlayerID, "access", access);
	}
	return access;
}

/** Sea access always cached as it never changes; an entity on the map always has one */
export function getSeaAccess(gameState: CommonGameState, ent: CommonPlacedEntity): SeaIndex;
export function getSeaAccess(gameState: CommonGameState, ent: CommonEntity): SeaIndex | undefined;
export function getSeaAccess(gameState: CommonGameState, ent: CommonEntity): SeaIndex | undefined
{
	let sea = ent.getMetadata(PlayerID, "sea");
	const entPos = ent.position();
	if (!sea && entPos)
	{
		sea = gameState.ai.accessibility.getAccessValue(entPos, true);
		// Docks are sometimes not as expected
		if (sea < 2 && ent.buildPlacementType() === "shore")
		{
			const entAngle = ent.angle();
			const cosa = Math.cos(entAngle ?? NaN);
			const sina = Math.sin(entAngle ?? NaN);
			for (let d = 3; d < 15; d += 3)
			{
				const pos: CommonPosition = worldPos(entPos[0] + d * sina, entPos[1] + d * cosa);
				sea = gameState.ai.accessibility.getAccessValue(pos, true);
				if (sea > 1)
				{
					break;
				}
			}
		}
		ent.setMetadata(PlayerID, "sea", sea);
	}
	return sea;
}

export function setSeaAccess(gameState: CommonGameState, ent: CommonEntity): void
{
	getSeaAccess(gameState, ent);
}

/**
 * Gets the template of the given type at call sites where it is already known
 * to exist, e.g. because gameState.canBuild() or gameState.isTemplateAvailable()
 * was checked earlier in the same code path.
 * Throws (after a warning) if the template is unexpectedly missing, so that
 * such an unexpected case is noticed instead of silently skipping a decision.
 */
export function requireTemplate(gameState: CommonGameState, type: TemplateName): CommonTemplate
{
	const template = gameState.getTemplate(type);
	if (!template)
	{
		const message = "Petra error: template " + type + " not found although it should always be available.";
		aiWarn(message);
		throw new Error(message);
	}
	return template;
}

/** A structure's template, where the context guarantees it exists and is one (see requireTemplate). */
export function requireStructureTemplate(gameState: CommonGameState, type: TemplateName): CommonStructureTemplate
{
	const template = requireTemplate(gameState, type);
	if (!isStructureTemplate(template))
	{
		const message = "Petra error: template " + type +
			" has no obstruction or footprint although it is a structure's.";
		aiWarn(message);
		throw new Error(message);
	}
	return template;
}

/**
 * Reads entity metadata that Petra has necessarily set before, e.g. right before
 * in the same flow, or when initializing one of the entities it manages (like the
 * "sea" of its ships, docks and trains).
 * Throws (after a warning) if the metadata is unexpectedly missing, so that such
 * an unexpected case is noticed instead of silently skipping a decision.
 */
export function requireMetadata<K extends keyof PetraEntityMetadata>(ent: CommonEntity, key: K): PetraEntityMetadata[K]
{
	const value = ent.getMetadata(PlayerID, key);
	if (value === undefined)
	{
		const message = "Petra error: metadata " + key + " not found on entity " +
			ent.id() + " although it should always have been set.";
		aiWarn(message);
		throw new Error(message);
	}
	return value;
}

/**
 * Asserts that a possibly-missing value (undefined or null) is present, for
 * call sites where the calling context guarantees it, so that the common-api
 * declarations can keep stating their true return types.
 * Throws (after a warning) if the value is unexpectedly missing, so that such
 * an unexpected case is noticed instead of silently skipping a decision.
 */
export function requireValue<T>(value: T | null | undefined): T
{
	if (value === undefined || value === null)
	{
		const message = "Petra error: required value was unexpectedly " + value + ".";
		aiWarn(message);
		throw new Error(message);
	}
	return value;
}

export function getAttackBonus(ent: CommonEntity, target: CommonEntity, type: string): number
{
	let attackBonus = 1;
	for (const bonus of attackBonuses(ent, type))
	{
		if (bonus.Civ && bonus.Civ !== target.civ())
		{
			continue;
		}
		if (!bonus.Classes || target.hasClasses(bonus.Classes))
		{
			attackBonus *= bonus.Multiplier;
		}
	}
	return attackBonus;
}

/** Makes the worker deposit the currently carried resources at the closest accessible dropsite */
export function returnResources(gameState: CommonGameState, ent: CommonEntity): boolean
{
	const carrying = ent.resourceCarrying();
	if (!carrying || !carrying.length || !isPlaced(ent))
	{
		return false;
	}

	const resource = carrying[0].type;

	let closestDropsite;
	let distmin = Math.min();
	const access = getLandAccess(gameState, ent);
	const dropsiteCollection = gameState.playerData.hasSharedDropsites ?
		gameState.getAnyDropsites(resource) :
		gameState.getOwnDropsites(resource);
	for (const dropsite of dropsiteCollection.values())
	{
		if (!isPlaced(dropsite))
		{
			continue;
		}
		const owner = dropsite.owner();
		// owner !== PlayerID can only happen when hasSharedDropsites === true, so no need to test it again
		if (owner !== PlayerID && (!dropsite.isSharedDropsite() || !gameState.isPlayerMutualAlly(owner)))
		{
			continue;
		}
		if (getLandAccess(gameState, dropsite) !== access)
		{
			continue;
		}
		const dist = SquareVectorDistance(ent.position(), dropsite.position());
		if (dist > distmin)
		{
			continue;
		}
		distmin = dist;
		closestDropsite = dropsite;
	}

	if (!closestDropsite)
	{
		return false;
	}
	ent.returnResources(closestDropsite);
	return true;
}

export function getHolder(gameState: CommonGameState, ent: CommonEntity): CommonEntity | undefined
{
	for (const holder of gameState.getEntities().values())
	{
		if (holder.isGarrisonHolder() && holder.garrisoned().indexOf(ent.id()) !== -1)
		{
			return holder;
		}
	}
	return undefined;
}

/** Returns the template of the structure a foundation builds when `ent` is a foundation, otherwise `ent` itself; callers only use template-level queries. */
export function getBuiltEntity(gameState: CommonGameState, ent: CommonEntity): CommonTemplate
{
	// a foundation's template is "foundation|" + the template it builds
	if (ent.foundationProgress() !== undefined)
	{
		return requireValue(gameState.getBuiltTemplate(ent.templateName()));
	}

	return ent;
}

export function dumpEntity(ent: CommonEntity | undefined): void
{
	if (!ent)
	{
		return;
	}
	aiWarn(
		" >>> id " + ent.id() + " name " + ent.genericName() + " pos " + ent.position() + " state " + ent.unitAIState(),
	);
	aiWarn(
		" base " + ent.getMetadata(PlayerID, "base") + " >>> role " +
			ent.getMetadata(PlayerID, "role") + " subrole " + ent.getMetadata(PlayerID, "subrole"),
	);
	aiWarn(
		"owner " + ent.owner() + " health " + ent.hitpoints() + " healthMax " + ent.maxHitpoints() +
			" foundationProgress " + ent.foundationProgress(),
	);
	aiWarn(
		" garrisoning " + ent.getMetadata(PlayerID, "garrisoning") + " garrisonHolder " +
			ent.getMetadata(PlayerID, "garrisonHolder") + " plan " + ent.getMetadata(PlayerID, "plan") +
			" transport " + ent.getMetadata(PlayerID, "transport"),
	);
	aiWarn(
		" stance " + ent.getStance() + " transporter " + ent.getMetadata(PlayerID, "transporter") +
			" gather-type " + ent.getMetadata(PlayerID, "gather-type") + " target-foundation " +
			ent.getMetadata(PlayerID, "target-foundation") + " PartOfArmy " +
			ent.getMetadata(PlayerID, "PartOfArmy"),
	);
}
