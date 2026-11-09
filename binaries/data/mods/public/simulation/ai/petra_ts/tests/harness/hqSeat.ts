/**
 * The headquarters suites' seat (headquarters.test.ts, town.test.ts,
 * placementSearches.test.ts): an office seated on the plain with its doors
 * recorded, the structure cards with the engine's footprints, and the trade
 * cards a market suite needs.
 */
import { makeTemplate } from "./fakes.ts";
import {
	doorManagers,
	makeHqWorld,
	seatHQ,
	structureTemplate,
	type HqSeatOptions,
	type HqWorld,
	type HqWorldOptions,
} from "./hqWorld.ts";

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
