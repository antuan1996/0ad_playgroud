/**
 * The headquarters suites' seat (headquarters.test.ts, town.test.ts,
 * placementSearches.test.ts): an office seated on the plain with its doors
 * recorded, the structure cards with the engine's footprints, and the trade
 * cards a market suite needs.
 */
import { makeTemplate } from "./fakes.ts";
import {
	PLAYER,
	doorManagers,
	makeHqEntity,
	makeHqWorld,
	seatHQ,
	structureTemplate,
	type HqSeatOptions,
	type HqWorld,
	type HqWorldOptions,
} from "./hqWorld.ts";

import { templateName } from "../../adapter/brands.ts";
import { requireValue } from "../../adapter/entityExtend.ts";

/** an office seated on the plain, with its doors recorded (unless a suite seats its own) */
export function seat(worldOptions: Partial<HqWorldOptions> = {}, seatOptions: Partial<HqSeatOptions> = {})
{
	const world = makeHqWorld(worldOptions);
	const hq = seatHQ(world, { stubs: doorManagers, ...seatOptions });
	return { world, hq };
}

/** The templates of this campaign carry the game's own sizes, so the
 * obstruction radii, the half sizes and the territory lists are the real
 * engine's numbers: the civic centre digs a 32x32 footprint over a 30x30
 * static obstruction (radius max 21.2, min 15), the market a 33x29 footprint
 * (max 21.96, min 13) and a Town trader card, the fortress 30x30 and the
 * stone tower 13x13. Every footprint walk needs the "@"-prefixed attribute
 * leaves the template walk reads, otherwise halfSize turns NaN and silently
 * disables the enemy-fire checks. */
export const ccTemplate = () =>
	structureTemplate("structures/athen/civil_centre", {
		classes: ["Structure", "CivCentre"],
		territories: ["own", "neutral"],
		getPaths: { Footprint: { Square: { "@width": 32, "@depth": 32 } } },
		obstruction: { min: 15, max: 21.2 },
	});
export const marketTemplate = () =>
	structureTemplate("structures/athen/market", {
		classes: ["Structure", "Trade", "Town", "Market"],
		getPaths: { Footprint: { Square: { "@width": 33, "@depth": 29 } } },
		obstruction: { min: 13, max: 21.96 },
	});
export const fortressTemplate = () =>
	structureTemplate("structures/athen/fortress", {
		classes: ["Structure", "Fortress", "Defensive"],
		getPaths: { Footprint: { Square: { "@width": 30, "@depth": 30 } } },
		obstruction: { min: 15, max: 21.2 },
	});
export const towerTemplate = () =>
	structureTemplate("structures/athen/defense_tower", {
		classes: ["Structure", "Tower", "Defensive"],
		getPaths: { Footprint: { Square: { "@width": 13, "@depth": 13 } } },
		obstruction: { min: 6, max: 9.2 },
	});

/** the ally trade cards: getTraderTemplatesGains only quotes a gain when the
 * trader templates exist (a real game always has them, so a market suite that
 * wants a counted route must seat the two cards). */
export function seatTraders(world: HqWorld): void
{
	world.templates["units/{civ}/support_trader"] = makeTemplate("units/{civ}/support_trader", {
		classes: ["Unit", "Support", "Trader"],
	});
	world.templates["units/{civ}/ship_merchant"] = makeTemplate("units/{civ}/ship_merchant", {
		classes: ["Unit", "Ship", "Trader"],
	});
}

export function trainerTown(world: HqWorld): { civicCentre: CommonEntity; barracks: CommonEntity; }
{
	const civicCentre = requireValue(world.ents.get(1000));
	// the engine's CCmpTrainer always answers an array here (an empty
	// queue still answers []), so the CC is a facility even at rest
	civicCentre.trainingQueue = () => [];
	civicCentre.trainableEntities = () => [templateName("units/athen/support_civilian")];
	world.templates["units/athen/support_civilian"] = makeTemplate("units/athen/support_civilian", {
		classes: ["Unit", "Human", "Support", "Builder", "Civilian", "Worker"],
		cost: { food: 50 },
		walkSpeed: 9,
		getPaths: { Cost: { Population: 1 } },
	});
	const barracks = world.addEntity(
		makeHqEntity({
			id: 400,
			owner: PLAYER,
			position: [104, 140],
			classes: ["Structure", "Barracks"],
			templateName: "structures/athen/barracks",
		}, { trainingQueue: () => [] }),
	);
	barracks.trainableEntities =
		() => [templateName("units/athen/infantry_spearman_b"), templateName("units/athen/infantry_archer_b")];
	world.templates["structures/athen/barracks"] = structureTemplate("structures/athen/barracks", {
		classes: ["Structure", "Barracks"],
	});
	// crops under the walls: the full 0.3 support share applies unless a
	// suite drops the field again (the lost-fields suite)
	world.templates["structures/athen/field"] = structureTemplate("structures/athen/field", {
		classes: ["Structure", "Economic", "Field"],
	});
	world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b", {
		classes: ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Melee", "Spearman", "Worker", "Citizen"],
		// the infantry base costs 50 food, the spearman adds 50 wood
		cost: { food: 50, wood: 50 },
		walkSpeed: 9.5,
		getPaths: { Cost: { Population: 1 } },
	});
	world.templates["units/athen/infantry_archer_b"] = makeTemplate("units/athen/infantry_archer_b", {
		classes: ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Ranged", "Archer", "Worker", "Citizen"],
		cost: { food: 50, wood: 50 },
		walkSpeed: 9,
		getPaths: { Cost: { Population: 1 } },
	});
	return { civicCentre, barracks };
}

/** a citizen worker already on the payroll (no plan holds it) */
export function hand(world: HqWorld, id: number, soldier: boolean): CommonEntity
{
	const spec = soldier ?
		{
			id: id,
			owner: PLAYER,
			position: [80 + id, 80 + id] as [number, number],
			classes: ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Melee", "Worker"],
			templateName: "units/athen/infantry_spearman_b",
		} :
		{
			id: id,
			owner: PLAYER,
			position: [60 + id, 60 + id] as [number, number],
			classes: ["Unit", "Human", "Support", "Worker", "Civilian", "Builder"],
			templateName: "units/athen/support_civilian",
		};
	const ent = world.addEntity(makeHqEntity(spec, {}, { role: "worker" })) as CommonEntity;
	return ent;
}
