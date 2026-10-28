/**
 * Our population against the room we have for it (stage 5's economy model,
 * world/): what the house decisions read (decision/housing.ts).
 */
import { requireValue } from "../adapter/entityExtend.ts";

/** The population, the room for it, and the room our foundations will add. */
export interface Census
{
	/** units we have, in population slots */
	population: number;
	/** the room our built houses and centres give */
	limit: number;
	/** the most the game allows */
	max: number;
	/** the room our foundations will add once built */
	coming: number;
}

export function censusOf(gameState: CommonGameState): Census
{
	let coming = 0;
	for (const ent of gameState.getOwnFoundations().values())
		coming += requireValue(gameState.getBuiltTemplate(ent.templateName())).getPopulationBonus();
	return {
		"population": gameState.getPopulation(),
		"limit": gameState.getPopulationLimit(),
		"max": gameState.getPopulationMax(),
		coming
	};
}
