/**
 * The headquarters' economy plan (moved out of decision/headquarters.ts, as `HQ.economy`): what the town saves
 * for and where its food comes from. The starting strategy sets it from the map; the headquarters' events, its
 * expansion and the bases adjust it during the game. Saved with the headquarters, under the same keys.
 */
export class EconomyPlan
{
	/** Spend on nothing but what the town needs most: set on a poor start, or once a base is lost */
	saveResources: boolean | undefined = undefined;
	/** Build on little room: set on a start with little land */
	saveSpace: boolean | undefined = undefined;
	/** Which food the town relies on: fields, corrals, fishing boats */
	needFarm = false;
	needCorral = false;
	needFish = false;
	/** the most fields the map's start allows, false for no limit (startingStrategy) */
	maxFields: number | false = false;
	/** Whether the first base was configured yet (startingStrategy) */
	firstBaseConfig = false;
}
