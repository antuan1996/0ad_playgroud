/**
 * The town's building sites (`gameState.ai.town.sites`, part of execution/town.ts): what the construction plans ask
 * before they lay a foundation — whether a builder exists and what may not be built, where to build, and whether a
 * market is still worth it. It reaches the build and trade managers and the placement searches only through SiteHQ.
 */

/** Where a civic centre for a resource may go: near a spot, from a strategic search, for room */
type EconomicCCOptions = { proximity?: CommonPosition; fromStrategic?: boolean; forRoom?: boolean; };

/** What the sites ask of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface SiteHQ
{
	readonly buildManager: {
		hasBuilder(template: TemplateName): boolean | undefined;
		isUnbuildable(gameState: CommonGameState, template: string): boolean;
		setUnbuildable(gameState: CommonGameState, template: string, time?: number, reason?: string): void;
	};
	readonly tradeManager: {
		checkRoutes(gameState: CommonGameState): boolean;
		isNewMarketWorth(expectedGain: number): boolean;
	};
	readonly placement: {
		findBestBaseForMilitary(gameState: CommonGameState): number | undefined;
		findDefensiveLocation(
			gameState: CommonGameState,
			template: CommonStructureTemplate,
		): [number, number, BaseId] | undefined;
		findEconomicCCLocation(
			gameState: CommonGameState,
			template: CommonStructureTemplate,
			resource: string,
			options?: EconomicCCOptions,
		): false | CommonPosition;
		findMarketLocation(
			gameState: CommonGameState,
			template: CommonStructureTemplate,
		): false | [number, number, BaseId | -1, number];
		findStrategicCCLocation(
			gameState: CommonGameState,
			template: CommonStructureTemplate,
		): false | CommonPosition | undefined;
	};
}

export class SiteDesk
{
	private readonly hq: SiteHQ;

	constructor(hq: SiteHQ)
	{
		this.hq = hq;
	}

	/** Whether one of our units can build the template (undefined while nobody was counted) */
	hasBuilder(template: TemplateName): boolean | undefined
	{
		return this.hq.buildManager.hasBuilder(template);
	}

	isUnbuildable(gameState: CommonGameState, template: string): boolean
	{
		return this.hq.buildManager.isUnbuildable(gameState, template);
	}

	/** The template may not be built for `time` seconds (for ever without one), for `reason` */
	setUnbuildable(gameState: CommonGameState, template: string, time?: number, reason?: string): void
	{
		this.hq.buildManager.setUnbuildable(gameState, template, time, reason);
	}

	/** Whether a new market expecting `expectedGain` is still worth it, the trade routes looked for anew */
	isNewMarketWorth(gameState: CommonGameState, expectedGain: number): boolean
	{
		this.hq.tradeManager.checkRoutes(gameState);
		return this.hq.tradeManager.isNewMarketWorth(expectedGain);
	}

	findBestBaseForMilitary(gameState: CommonGameState): number | undefined
	{
		return this.hq.placement.findBestBaseForMilitary(gameState);
	}

	findDefensiveLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined
	{
		return this.hq.placement.findDefensiveLocation(gameState, template);
	}

	findEconomicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		resource: string,
		options?: EconomicCCOptions,
	): false | CommonPosition
	{
		return this.hq.placement.findEconomicCCLocation(gameState, template, resource, options);
	}

	findMarketLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | [number, number, BaseId | -1, number]
	{
		return this.hq.placement.findMarketLocation(gameState, template);
	}

	findStrategicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | CommonPosition | undefined
	{
		return this.hq.placement.findStrategicCCLocation(gameState, template);
	}
}
