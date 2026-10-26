/**
 * Typed readers of the template data Petra uses, over `Template.get(path)`,
 * which returns whatever the template holds (`unknown`). The leaves of a
 * parsed template are strings ("12.5"), a value a technology modified is a
 * number; the readers convert as Petra always did (`+value`, so a missing
 * leaf is NaN).
 */

/** A template leaf as a number, as `+value` reads it. */
function numberAt(template: CommonTemplate, path: string): number
{
	return Number(template.get(path));
}

/** A footprint's half extents: a square's half depth and width, a circle's radius for both, 0 without one. */
export type FootprintHalves = {
	halfDepth: number;
	halfWidth: number;
	/** the larger of the two */
	halfSize: number;
};

export function footprintHalves(template: CommonTemplate): FootprintHalves
{
	if (template.get("Footprint/Square"))
	{
		const halfDepth = numberAt(template, "Footprint/Square/@depth") / 2;
		const halfWidth = numberAt(template, "Footprint/Square/@width") / 2;
		return { halfDepth, halfWidth, "halfSize": Math.max(halfDepth, halfWidth) };
	}
	if (template.get("Footprint/Circle"))
	{
		const radius = numberAt(template, "Footprint/Circle/@radius");
		return { "halfDepth": radius, "halfWidth": radius, "halfSize": radius };
	}
	return { "halfDepth": 0, "halfWidth": 0, "halfSize": 0 };
}

/**
 * The shape of a structure's obstruction: a rectangle (static), a gate (its
 * door between two wall parts: the whole width, the deepest part, the door's
 * half width) or a circle (unit); undefined without an obstruction or with
 * none of these shapes.
 */
export type ObstructionShape =
	| { kind: "static"; width: number; depth: number }
	| { kind: "gate"; width: number; depth: number; doorHalfWidth: number }
	| { kind: "unit"; radius: number };

export function obstructionShape(template: CommonTemplate): ObstructionShape | undefined
{
	if (!template.get("Obstruction"))
		return undefined;
	if (template.get("Obstruction/Static"))
	{
		return {
			"kind": "static",
			"width": numberAt(template, "Obstruction/Static/@width"),
			"depth": numberAt(template, "Obstruction/Static/@depth")
		};
	}
	if (template.get("Obstruction/Obstructions"))
	{
		const doorWidth = numberAt(template, "Obstruction/Obstructions/Door/@width");
		return {
			"kind": "gate",
			"width": doorWidth + numberAt(template, "Obstruction/Obstructions/Left/@width") +
				numberAt(template, "Obstruction/Obstructions/Right/@width"),
			"depth": Math.max(numberAt(template, "Obstruction/Obstructions/Door/@depth"),
				numberAt(template, "Obstruction/Obstructions/Left/@depth"),
				numberAt(template, "Obstruction/Obstructions/Right/@depth")),
			"doorHalfWidth": doorWidth / 2
		};
	}
	if (template.get("Obstruction/Unit"))
		return { "kind": "unit", "radius": numberAt(template, "Obstruction/Unit/@radius") };
	return undefined;
}

/** One bonus of an attack: against units of `Classes` (a class list) of civ `Civ`, if given. */
export type AttackBonus = {
	Civ?: string;
	Classes?: string;
	Multiplier: number;
};

/** The bonuses of an attack type ("Melee", "Ranged", ...), keyed by their names in the template. */
export function attackBonuses(template: CommonTemplate, type: string): AttackBonus[]
{
	if (!template.get("Attack/" + type))
		return [];
	const bonuses = template.get("Attack/" + type + "/Bonuses");
	if (typeof bonuses !== "object" || bonuses === null)
		return [];
	const list: AttackBonus[] = [];
	const entries: unknown[] = Object.values(bonuses);
	for (const bonus of entries)
	{
		if (typeof bonus !== "object" || bonus === null)
			continue;
		list.push({
			"Civ": "Civ" in bonus && typeof bonus.Civ === "string" ? bonus.Civ : undefined,
			"Classes": "Classes" in bonus && typeof bonus.Classes === "string" ? bonus.Classes : undefined,
			"Multiplier": "Multiplier" in bonus ? Number(bonus.Multiplier) : NaN
		});
	}
	return list;
}
