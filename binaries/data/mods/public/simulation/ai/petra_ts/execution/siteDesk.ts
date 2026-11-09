/**
 * The town's building sites (`gameState.ai.town.sites`, part of execution/town.ts): what the construction plans ask
 * before they lay a foundation — whether a builder exists and what may not be built, and whether a market is still
 * worth it (where to build is the town's placement, execution/placementSearches.ts). It reaches the build and trade
 * managers only through SiteHQ.
 */

/** What the sites ask of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface SiteHQ
{
	readonly buildManager: {
		readonly builders: { hasBuilder(template: TemplateName): boolean | undefined; };
		isUnbuildable(gameState: CommonGameState, template: string): boolean;
		setUnbuildable(gameState: CommonGameState, template: string, time?: number, reason?: string): void;
	};
	readonly tradeManager: {
		checkRoutes(gameState: CommonGameState): boolean;
		isNewMarketWorth(expectedGain: number): boolean;
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
		return this.hq.buildManager.builders.hasBuilder(template);
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
}
