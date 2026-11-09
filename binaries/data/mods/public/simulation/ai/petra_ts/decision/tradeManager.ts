import * as filters from "simulation/ai/common-api/filters.js";
import type { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { INVALID_ENTITY, landRegion } from "../adapter/brands.ts";
import { newTradeRoute as chatNewTradeRoute } from "../adapter/chatHelper.ts";
import { postCommand } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, getSeaAccess, requireMetadata, requireStructureTemplate } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { requiredStateWithin } from "../adapter/unitState.ts";
import { type PlanMetadata } from "../execution/queueplan.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import type { Town } from "../execution/town.ts";
import { gatherTreasure } from "../execution/treasure.ts";
import { Worker } from "../execution/worker.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import type { Geography } from "../world/geography.ts";
import { isLineInsideEnemyTerritory } from "../world/territory.ts";
import { getBestBase } from "./baseManager.ts";
import type { BasesManager } from "./basesManager.ts";
import type { BuildManager } from "./buildManager.ts";
import type { Headquarters } from "./headquarters.ts";
import type { NavalManager } from "./navalManager.ts";
import type { ResearchManager } from "./researchManager.ts";

/**
 * What the trade manager asks of the headquarters that owns it: the
 * resources most needed and their wanted rates, the markets it may build and
 * where, and whether it can barter; and of its sibling managers: the ships
 * to sail merchants and traders, the bases' stocks and rates, the buildable
 * market and dock, and the trade bonus research.
 */
export type TradeHQ = Pick<Headquarters, "canBuild" | "canBarter" | "placement"> & {
	readonly town: Pick<Town, "pickMostNeededResources" | "GetWantedGatherRates" | "transports">;
	readonly navalManager: Pick<NavalManager, "fleet">;
	readonly basesManager: Pick<
		BasesManager,
		"getTotalResourceLevel" | "GetCurrentGatherRates" | "baselessBase" | "baseManagers"
	>;
	readonly buildManager: Pick<BuildManager, "setBuildable" | "setUnbuildable">;
	readonly researchManager: Pick<ResearchManager, "researchTradeBonus">;
};

export type TradeRoute = { source: EntityId; target: EntityId; gain: number; land?: AccessIndex; sea?: SeaIndex; };

/** Our markets and our allies' exclusive ones; undefined when there are not two markets yet. */
function tradeMarketPair(
	gameState: CommonGameState,
):
	| { market1: CommonEntityCollection<CommonStructureEntity>; market2: CommonEntityCollection; onlyOurs: boolean; }
	| undefined
{
	const market1 = gameState.updatingCollection("OwnMarkets", filters.byClass("Trade"), gameState.getOwnStructures());
	let market2 = gameState.updatingCollection(
		"diplo-ExclusiveAllyMarkets",
		filters.byClass("Trade"),
		gameState.getExclusiveAllyEntities(),
	);
	if (market1.length + market2.length < 2)
	{ // We have to wait  ... markets will be built soon
		return undefined;
	}
	const onlyOurs = !market2.hasEntities();
	if (onlyOurs)
	{
		market2 = market1;
	}
	return { market1, market2, onlyOurs };
}

/** What a barter decision reads: our barter market, the resources, what we hold, need and gather, and the prices. */
type BarterMarket = {
	barterer: CommonEntity;
	codes: string[];
	available: ResourcesManager;
	needs: ResourcesManager;
	rates: Record<string, number>;
	prices: { buy: CommonResourceAmounts; sell: CommonResourceAmounts; };
};

/** How much of buy one sale of sell brings, in percent */
function barterRateOf(
	prices: { buy: Record<string, number>; sell: Record<string, number>; },
	buy: string,
	sell: string,
): number
{
	return Math.round(100 * prices.sell[sell] / prices.buy[buy]);
}

/** The lowest rate at which we sell sell for buy: lower the more of it we hold, food the cheapest. */
function minimalBarterRate(available: ResourcesManager, buy: string, sell: string): number
{
	let barterRateMin;
	if (sell === "food")
	{
		barterRateMin = 30;
		if (available[sell] > 40000)
		{
			barterRateMin = 0;
		}
		else if (available[sell] > 15000)
		{
			barterRateMin = 5;
		}
		else if (available[sell] > 1000)
		{
			barterRateMin = 10;
		}
	}
	else
	{
		barterRateMin = 70;
		if (available[sell] > 5000)
		{
			barterRateMin = 30;
		}
		else if (available[sell] > 1000)
		{
			barterRateMin = 50;
		}
		if (buy === "food")
		{
			barterRateMin += 20;
		}
	}
	return barterRateMin;
}

/** The routes checkRoutes chooses between */
type BestRoutes = { candidate: TradeRoute; potential: TradeRoute; bestIndex: TradeRoute; bestLand: TradeRoute; };

/** Keeps route among the best routes it beats; a route between markets not all built only as a potential one. */
function keepRoute(
	gameState: CommonGameState,
	best: BestRoutes,
	route: TradeRoute,
	built: boolean,
	accessIndex: RegionIndex | undefined,
): void
{
	if (built)
	{
		if (accessIndex && !keepForIndex(gameState, best, route, accessIndex))
		{
			return;
		}
		if (route.gain < best.candidate.gain)
		{
			return;
		}
		best.candidate = { ...route };
	}
	if (route.gain < best.potential.gain)
	{
		return;
	}
	best.potential = { ...route };
}

/**
 * Keeps route as the best on accessIndex, or on any land for a land index; false when a better one
 * is kept already, and the route is then no candidate either.
 */
function keepForIndex(
	gameState: CommonGameState,
	best: BestRoutes,
	route: TradeRoute,
	accessIndex: RegionIndex,
): boolean
{
	const regionType = gameState.ai.accessibility.regionType[accessIndex];
	if (regionType === "water" && route.sea === accessIndex || regionType === "land" && route.land === accessIndex)
	{
		if (route.gain < best.bestIndex.gain)
		{
			return false;
		}
		best.bestIndex = { ...route };
	}
	else if (regionType === "land")
	{
		if (route.gain < best.bestLand.gain)
		{
			return false;
		}
		best.bestLand = { ...route };
	}
	return true;
}

/**
 * If we have some merchant ships assigned to transport, try first to reassign one to trade: returns true
 * when one is (or already was) switched.
 * May-be, there were produced at an early stage when no other ship were available
 * and the naval manager will train now more appropriate ships.
 */
function switchMerchantShip(gameState: CommonGameState, hq: TradeHQ, sea: SeaIndex): boolean
{
	let already = false;
	let shipToSwitch: CommonEntity | undefined;
	hq.navalManager.fleet(sea)?.transports.forEach(function(ship: CommonEntity): void
	{
		if (already || !ship.hasClass("Trader"))
		{
			return;
		}
		if (ship.getMetadata(PlayerID, "role") === Worker.ROLE_SWITCH_TO_TRADER)
		{
			already = true;
			return;
		}
		shipToSwitch = ship;
	});
	if (already)
	{
		return true;
	}
	if (!shipToSwitch)
	{
		return false;
	}
	if (shipToSwitch.getMetadata(PlayerID, "transporter") === undefined)
	{
		shipToSwitch.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
	}
	else
	{
		shipToSwitch.setMetadata(PlayerID, "role", Worker.ROLE_SWITCH_TO_TRADER);
	}
	return true;
}

/**
 * Manage the trade
 */
export type SerializedTradeManager = {
	tradeRoute: TradeRoute | undefined;
	potentialTradeRoute: TradeRoute | undefined;
	routeProspection: boolean;
	targetNumTraders: number;
	warnedAllies: Record<number, boolean>;
};

export class TradeManager
{
	Config: Config;
	minimalGain: number;
	potentialTradeRoute: TradeRoute | undefined;
	routeProspection: boolean;
	targetNumTraders: number;
	tradeRoute: TradeRoute | undefined;
	traders: CommonEntityCollection;
	warnedAllies: Record<number, boolean>;
	readonly hq: TradeHQ;

	constructor(config: Config, gameState: CommonGameState, geography: Geography, hq: TradeHQ)
	{
		this.Config = config;
		this.hq = hq;
		this.tradeRoute = undefined;
		this.potentialTradeRoute = undefined;
		this.routeProspection = false;
		this.targetNumTraders = this.Config.Economy.targetNumTraders;
		this.warnedAllies = {};
		this.traders = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "role", Worker.ROLE_TRADER));
		this.traders.registerUpdates();
		this.minimalGain = geography.navalMap ? 3 : 5;
	}

	/** A saved trade manager: its route and wishes from the save */
	static restore(
		config: Config,
		gameState: CommonGameState,
		geography: Geography,
		data: SerializedTradeManager,
		hq: TradeHQ,
	): TradeManager
	{
		const manager = new TradeManager(config, gameState, geography, hq);
		manager.resume(data);
		return manager;
	}

	hasTradeRoute(): boolean
	{
		return this.tradeRoute !== undefined;
	}

	assignTrader(ent: CommonEntity): void
	{
		ent.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
		this.traders.updateEnt(ent);
	}

	trainMoreTraders(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (!this.hasTradeRoute() || queues.trader.hasQueuedUnits())
		{
			return;
		}

		const route = this.tradeRoute;
		if (!route)
		{
			return;
		}

		const { numTraders, numSeaTraders, numLandTraders } = this.countTraders(gameState);
		if (
			numTraders >= this.targetNumTraders &&
			(!route.sea && numLandTraders >= Math.floor(this.targetNumTraders / 2) ||
				route.sea && numSeaTraders >= Math.floor(this.targetNumTraders / 2))
		)
		{
			return;
		}

		let template;
		const metadata: PlanMetadata = { role: Worker.ROLE_TRADER };
		if (route.sea)
		{
			if (switchMerchantShip(gameState, this.hq, route.sea))
			{
				return;
			}
			template = gameState.applyCiv("units/{civ}/ship_merchant");
			metadata.sea = route.sea;
		}
		else
		{
			template = gameState.applyCiv("units/{civ}/support_trader");
			const sourceObject = gameState.getEntityById(route.source);
			if (!sourceObject)
			{
				return;
			}
			const baseObject = sourceObject.hasClass("Naval") ? gameState.getEntityById(route.target) : sourceObject;

			// all our own markets always have their base set (see assignEntity)
			metadata.base = baseObject ? requireMetadata(baseObject, "base") : undefined;
		}

		if (!gameState.getTemplate(template))
		{
			debugWarn(
				this.Config,
				0,
				() =>
					"Petra error: trying to train " + template + " for civ " +
					gameState.getPlayerCiv() + " but no template found.",
			);
			return;
		}
		queues.trader.addPlan(new TrainingPlan(gameState, template, metadata, 1, 1));
	}

	/** Our traders, at sea and on land, those in training counted in. */
	private countTraders(
		gameState: CommonGameState,
	): { numTraders: number; numSeaTraders: number; numLandTraders: number; }
	{
		let numTraders = this.traders.length;
		let numSeaTraders = this.traders.filter(filters.byClass("Ship")).length;
		let numLandTraders = numTraders - numSeaTraders;
		// add traders already in training
		gameState.getOwnTrainingFacilities().forEach(function(ent: CommonEntity): void
		{
			for (const item of ent.trainingQueue() ?? [])
			{
				if (!item.metadata || !item.metadata.role || item.metadata.role !== Worker.ROLE_TRADER)
				{
					continue;
				}
				numTraders += item.count;
				if (item.metadata.sea !== undefined)
				{
					numSeaTraders += item.count;
				}
				else
				{
					numLandTraders += item.count;
				}
			}
		});
		return { numTraders, numSeaTraders, numLandTraders };
	}

	updateTrader(gameState: CommonGameState, ent: CommonEntity): void
	{
		if (
			ent.hasClass("Ship") && gameState.ai.playedTurn % 5 === 0 &&
			!requiredStateWithin(ent, "INDIVIDUAL.COLLECTTREASURE") &&
			gatherTreasure(gameState, ent, true)
		)
		{
			return;
		}

		if (!this.hasTradeRoute() || !ent.isIdle() || !isPlaced(ent))
		{
			return;
		}
		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			return;
		}

		// TODO if the trader is idle and has workOrders, restore them to avoid losing the current gain

		Engine.ProfileStart("Trade Manager");
		this.sendTrading(gameState, ent);
		Engine.ProfileStop();
	}

	/** An idle trader takes the best route it reaches, from the nearer market, or asks for a ship to it. */
	private sendTrading(gameState: CommonGameState, ent: CommonPlacedEntity): void
	{
		const access = ent.hasClass("Ship") ? getSeaAccess(gameState, ent) : getLandAccess(gameState, ent);
		if (access === undefined)
		{
			return;
		}
		const route = this.checkRoutes(gameState, access);
		if (!route)
		{
			// TODO try to garrison land trader inside merchant ship when only sea routes available
			debugWarn(this.Config, 0, () => " no available route for " + ent.genericName() + " " + ent.id());
			return;
		}
		const routeSource = gameState.getEntityById(route.source);
		const routeTarget = gameState.getEntityById(route.target);
		// the route's markets: on the map
		if (!routeSource || !routeTarget || !isPlaced(routeSource) || !isPlaced(routeTarget))
		{
			return;
		}

		const nearerSource =
			!(SquareVectorDistance(routeTarget.position(), ent.position()) <
				SquareVectorDistance(routeSource.position(), ent.position()));

		if (!ent.hasClass("Ship") && route.land !== undefined && route.land !== access)
		{
			// not a ship: access is the land the trader stands on
			const land = landRegion(access);
			const destination = nearerSource ? routeSource.position() : routeTarget.position();
			this.hq.town.transports.requireTransport(gameState, ent, land, route.land, destination);
			return;
		}

		if (nearerSource)
		{
			ent.tradeRoute(routeTarget, routeSource);
		}
		else
		{
			ent.tradeRoute(routeSource, routeTarget);
		}
		ent.setMetadata(PlayerID, "route", route);
	}

	setTradingGoods(gameState: CommonGameState): void
	{
		const resTradeCodes = Resources.GetTradableCodes();
		if (!resTradeCodes.length)
		{
			return;
		}
		const tradingGoods: Record<string, number> = {};
		for (const res of resTradeCodes)
		{
			tradingGoods[res] = 0;
		}
		// first, try to anticipate future needs
		const stocks = this.hq.basesManager.getTotalResourceLevel(gameState);
		const mostNeeded = this.hq.town.pickMostNeededResources(gameState, resTradeCodes);
		const wantedRates = this.hq.town.GetWantedGatherRates(gameState);
		let remaining = 100;
		let targetNum = this.Config.Economy.targetNumTraders;
		for (const res of resTradeCodes)
		{
			if (res === "food")
			{
				continue;
			}
			const wantedRate = wantedRates[res];
			if (stocks[res] < 200)
			{
				tradingGoods[res] = wantedRate > 0 ? 20 : 10;
				targetNum += Math.min(5, 3 + Math.ceil(wantedRate / 30));
			}
			else if (stocks[res] < 500)
			{
				tradingGoods[res] = wantedRate > 0 ? 15 : 10;
				targetNum += 2;
			}
			else if (stocks[res] < 1000)
			{
				tradingGoods[res] = 10;
				targetNum += 1;
			}
			remaining -= tradingGoods[res];
		}
		this.targetNumTraders = Math.round(this.Config.popScaling * targetNum);

		// then add what is needed now
		const mainNeed = Math.floor(remaining * 70 / 100);
		const nextNeed = remaining - mainNeed;

		tradingGoods[mostNeeded[0].type] += mainNeed;
		if (mostNeeded[1] && mostNeeded[1].wanted > 0)
		{
			tradingGoods[mostNeeded[1].type] += nextNeed;
		}
		else
		{
			tradingGoods[mostNeeded[0].type] += nextNeed;
		}
		postCommand({ type: "set-trading-goods", tradingGoods: tradingGoods });
		debugWarn(this.Config, 2, () => " trading goods set to " + uneval(tradingGoods));
	}

	/**
	 * Try to barter unneeded resources for needed resources.
	 * only once per turn because the info is not updated within a turn
	 */
	performBarter(gameState: CommonGameState): boolean
	{
		const barterers = gameState.getOwnEntitiesByClass("Barter", true).filter(filters.isBuilt()).toEntityArray();
		if (barterers.length === 0)
		{
			return false;
		}
		const resBarterCodes = Resources.GetBarterableCodes();
		if (!resBarterCodes.length)
		{
			return false;
		}

		const market: BarterMarket = {
			barterer: barterers[0],
			codes: resBarterCodes,
			// Available resources after account substraction
			available: gameState.ai.queueManager.getAvailableResources(gameState),
			needs: gameState.ai.queueManager.currentNeeds(gameState),
			rates: this.hq.basesManager.GetCurrentGatherRates(gameState),
			prices: gameState.getBarterPrices(),
		};

		// loop through each missing resource checking if we could barter and help finishing a queue quickly.
		for (const buy of resBarterCodes)
		{
			if (this.necessityBarter(market, buy))
			{
				return true;
			}
		}

		// now do contingency bartering, selling food to buy finite resources (and annoy our ennemies by increasing prices)
		return this.contingencyBarter(market);
	}

	/** Sells what we can spare at the best rate for buy, if our gatherers would not bring it soon enough. */
	private necessityBarter(market: BarterMarket, buy: string): boolean
	{
		const { available, needs, rates } = market;
		// Check if our rate allows to gather it fast enough
		if (needs[buy] === 0 || needs[buy] < rates[buy] * 30)
		{
			return false;
		}

		// Pick the best resource to barter.
		let bestToSell: string | undefined;
		let bestRate = 0;
		for (const sell of market.codes)
		{
			if (sell === buy)
			{
				continue;
			}
			// Do not sell if we need it or do not have enough buffer
			if (needs[sell] > 0 || available[sell] < 500)
			{
				continue;
			}

			const barterRate = barterRateOf(market.prices, buy, sell);
			if (barterRate > bestRate && barterRate > minimalBarterRate(available, buy, sell))
			{
				bestRate = barterRate;
				bestToSell = sell;
			}
		}
		if (bestToSell === undefined)
		{
			return false;
		}
		const amount = available[bestToSell] > 5000 ? 500 : 100;
		market.barterer.barter(buy, bestToSell, amount);
		debugWarn(
			this.Config,
			2,
			() =>
				"Necessity bartering: sold " + bestToSell + " for " + buy +
				" >> need sell " + needs[bestToSell] + " need buy " + needs[buy] +
				" rate buy " + rates[buy] + " available sell " + available[bestToSell] +
				" available buy " + available[buy] + " barterRate " + bestRate +
				" amount " + amount,
		);
		return true;
	}

	/** Sells spare food for the scarcest resource at a fair rate. */
	private contingencyBarter(market: BarterMarket): boolean
	{
		const { available, needs } = market;
		if (available.food < 1000 || needs.food > 0 || market.codes.indexOf("food") === -1)
		{
			return false;
		}
		let bestToBuy: string | undefined;
		let bestChoice = 0;
		for (const buy of market.codes)
		{
			if (buy === "food")
			{
				continue;
			}
			let barterRateMin = 80;
			if (available[buy] < 5000 && available.food > 5000)
			{
				barterRateMin -= 20 - Math.floor(available[buy] / 250);
			}
			const barterRate = barterRateOf(market.prices, buy, "food");
			if (barterRate < barterRateMin)
			{
				continue;
			}
			const choice = barterRate / (100 + available[buy]);
			if (choice > bestChoice)
			{
				bestChoice = choice;
				bestToBuy = buy;
			}
		}
		if (bestToBuy === undefined)
		{
			return false;
		}
		const amount = available.food > 5000 ? 500 : 100;
		market.barterer.barter(bestToBuy, "food", amount);
		debugWarn(
			this.Config,
			2,
			() =>
				"Contingency bartering: sold food for " + bestToBuy + " available sell " +
				available.food + " available buy " + available[bestToBuy] + " barterRate " +
				barterRateOf(market.prices, bestToBuy, "food") + " amount " + amount,
		);
		return true;
	}

	checkEvents(gameState: CommonGameState, events: EngineAIEvents): boolean
	{
		// check if one market from a traderoute is renamed, change the route accordingly
		for (const evt of events.EntityRenamed)
		{
			const ent = gameState.getEntityById(evt.newentity);
			if (ent && ent.hasClass("Trade"))
			{
				this.renameMarket(evt.entity, evt.newentity);
			}
		}

		if (!this.marketsChanged(gameState, events))
		{
			return false;
		}
		this.activateProspection(gameState);
		return true;
	}

	/** The traders' routes follow a market renamed. */
	private renameMarket(entity: EntityId, newentity: EntityId): void
	{
		for (const trader of this.traders.values())
		{
			const route = trader.getMetadata(PlayerID, "route");
			if (!route)
			{
				continue;
			}
			if (route.source === entity)
			{
				route.source = newentity;
			}
			else if (route.target === entity)
			{
				route.target = newentity;
			}
			else
			{
				continue;
			}
			trader.setMetadata(PlayerID, "route", route);
		}
	}

	/** Whether id is a market of the trade route or of the potential one */
	private onRoute(id: EntityId): boolean
	{
		return id === this.tradeRoute?.source ||
			id === this.tradeRoute?.target ||
			id === this.potentialTradeRoute?.source ||
			id === this.potentialTradeRoute?.target;
	}

	/** Whether a route's market was destroyed, a market built or captured, or diplomacy changed. */
	private marketsChanged(gameState: CommonGameState, events: EngineAIEvents): boolean
	{
		// if one market (or market-foundation) is destroyed, we should look for a better route
		for (const evt of events.Destroy)
		{
			if (this.onRoute(evt.entity))
			{
				return true;
			}
		}

		// same thing if one market is built
		for (const evt of events.Create)
		{
			const ent = gameState.getEntityById(evt.entity);
			if (
				ent && ent.foundationProgress() === undefined && ent.hasClass("Trade") &&
				gameState.isPlayerAlly(ent.owner())
			)
			{
				return true;
			}
		}

		// and same thing for captured markets
		for (const evt of events.OwnershipChanged)
		{
			if (!gameState.isPlayerAlly(evt.from) && !gameState.isPlayerAlly(evt.to))
			{
				continue;
			}
			const ent = gameState.getEntityById(evt.entity);
			if (ent && ent.foundationProgress() === undefined && ent.hasClass("Trade"))
			{
				return true;
			}
		}

		// or if diplomacy changed
		return events.DiplomacyChanged.length > 0;
	}

	activateProspection(gameState: CommonGameState): void
	{
		this.routeProspection = true;
		this.hq.buildManager.setBuildable(gameState.applyCiv("structures/{civ}/market"));
		this.hq.buildManager.setBuildable(gameState.applyCiv("structures/{civ}/dock"));
	}

	/**
	 * fills the best trade route in this.tradeRoute and the best potential route in this.potentialTradeRoute
	 * If an index is given, it returns the best route with this index or the best land route if index is a land index
	 */
	checkRoutes(gameState: CommonGameState, accessIndex: RegionIndex): TradeRoute | false;
	checkRoutes(gameState: CommonGameState, accessIndex?: undefined): boolean;
	checkRoutes(gameState: CommonGameState, accessIndex?: RegionIndex): boolean | TradeRoute
	{
		// If we cannot trade, do not bother checking routes.
		if (!Resources.GetTradableCodes().length)
		{
			this.tradeRoute = undefined;
			this.potentialTradeRoute = undefined;
			return false;
		}

		const markets = tradeMarketPair(gameState);
		if (!markets)
		{
			this.tradeRoute = undefined;
			this.potentialTradeRoute = undefined;
			return false;
		}
		const { market1, market2, onlyOurs } = markets;
		const { candidate, potential, bestIndex, bestLand } = this.bestRoutes(
			gameState,
			market1,
			market2,
			onlyOurs,
			accessIndex,
		);

		if (potential.gain < 1)
		{
			this.potentialTradeRoute = undefined;
		}
		else
		{
			this.potentialTradeRoute = potential;
		}

		if (candidate.gain < 1)
		{
			debugWarn(this.Config, 2, () => "no better trade route possible");
			this.tradeRoute = undefined;
			return false;
		}

		if (this.Config.debug > 1 && this.tradeRoute)
		{
			if (candidate.gain > this.tradeRoute.gain)
			{
				aiWarn(
					"one better trade route set with gain " + candidate.gain + " instead of " + this.tradeRoute.gain,
				);
			}
		}
		else
		{
			debugWarn(this.Config, 1, () => "one trade route set with gain " + candidate.gain);
		}
		this.tradeRoute = candidate;

		if (this.Config.chat)
		{
			this.warnAlly(gameState, this.tradeRoute);
		}

		if (accessIndex)
		{
			if (bestIndex.gain > 0)
			{
				return bestIndex;
			}
			else if (gameState.ai.accessibility.regionType[accessIndex] === "land" && bestLand.gain > 0)
			{
				return bestLand;
			}
			return false;
		}
		return true;
	}

	/** Warn an ally that we have a trade route with him, once */
	private warnAlly(gameState: CommonGameState, route: TradeRoute): void
	{
		const sourceEnt = gameState.getEntityById(route.source);
		let owner = sourceEnt ? sourceEnt.owner() : PlayerID;
		if (owner === PlayerID)
		{
			const targetEnt = gameState.getEntityById(route.target);
			if (targetEnt)
			{
				owner = targetEnt.owner();
			}
		}
		if (owner !== PlayerID && !this.warnedAllies[owner])
		{
			chatNewTradeRoute(gameState, owner);
			this.warnedAllies[owner] = true;
		}
	}

	/**
	 * The best routes between the markets: the best between built ones (candidate), the best of all
	 * (potential), and given accessIndex the best on it (bestIndex) and, for a land, the best on any land.
	 */
	private bestRoutes(
		gameState: CommonGameState,
		market1: CommonEntityCollection<CommonStructureEntity>,
		market2: CommonEntityCollection,
		onlyOurs: boolean,
		accessIndex: RegionIndex | undefined,
	): BestRoutes
	{
		const none = (): TradeRoute => ({ source: INVALID_ENTITY, target: INVALID_ENTITY, gain: 0 });
		const best: BestRoutes = { candidate: none(), potential: none(), bestIndex: none(), bestLand: none() };

		const mapSize = gameState.sharedScript.mapSize;
		const traderTemplatesGains = gameState.getTraderTemplatesGains();

		for (const m1 of market1.values())
		{
			const access1 = getLandAccess(gameState, m1);
			const sea1 = m1.hasClass("Naval") ? getSeaAccess(gameState, m1) : undefined;
			for (const m2 of market2.values())
			{
				if (onlyOurs && m1.id() >= m2.id())
				{
					continue;
				}
				if (!isPlaced(m2))
				{
					continue;
				}
				const route = this.routeBetween(
					gameState,
					{ market: m1, land: access1, sea: sea1 },
					m2,
					mapSize,
					traderTemplatesGains,
				);
				if (route)
				{
					keepRoute(
						gameState,
						best,
						route,
						m1.foundationProgress() === undefined && m2.foundationProgress() === undefined,
						accessIndex,
					);
				}
			}
		}
		return best;
	}

	/** The route from m1 to m2 on a land or sea they share, outside enemy territory, worth its gain, or undefined. */
	private routeBetween(
		gameState: CommonGameState,
		from: { market: CommonStructureEntity; land: AccessIndex | undefined; sea: SeaIndex | undefined; },
		m2: CommonPlacedEntity,
		mapSize: number,
		traderTemplatesGains: ReturnType<CommonGameState["getTraderTemplatesGains"]>,
	): TradeRoute | undefined
	{
		const m1 = from.market;
		const access2 = getLandAccess(gameState, m2);
		const sea2 = m2.hasClass("Naval") ? getSeaAccess(gameState, m2) : undefined;
		const land = from.land === access2 ? from.land : undefined;
		const sea = from.sea && from.sea === sea2 ? from.sea : undefined;
		if (!land && !sea)
		{
			return undefined;
		}
		if (land && isLineInsideEnemyTerritory(gameState, m1.position(), m2.position()))
		{
			return undefined;
		}
		let gainMultiplier;
		if (land && traderTemplatesGains.landGainMultiplier)
		{
			gainMultiplier = traderTemplatesGains.landGainMultiplier;
		}
		else if (sea && traderTemplatesGains.navalGainMultiplier)
		{
			gainMultiplier = traderTemplatesGains.navalGainMultiplier;
		}
		else
		{
			return undefined;
		}
		const gain = Math.round(
			gainMultiplier * TradeGain(SquareVectorDistance(m1.position(), m2.position()), mapSize),
		);
		if (gain < this.minimalGain)
		{
			return undefined;
		}
		return { source: m1.id(), target: m2.id(), gain: gain, land: land, sea: sea };
	}

	/** Called when a market was built or destroyed, and checks if trader orders should be changed */
	checkTrader(gameState: CommonGameState, ent: CommonEntity): void
	{
		const presentRoute = ent.getMetadata(PlayerID, "route");
		if (!presentRoute)
		{
			return;
		}

		if (!isPlaced(ent))
		{
			// This trader is garrisoned, we will decide later (when ungarrisoning) what to do
			ent.setMetadata(PlayerID, "route", undefined);
			return;
		}

		const access = ent.hasClass("Ship") ? getSeaAccess(gameState, ent) : getLandAccess(gameState, ent);
		if (access === undefined)
		{
			ent.setMetadata(PlayerID, "route", undefined);
			return;
		}
		const possibleRoute = this.checkRoutes(gameState, access);
		// Warning:  presentRoute is from metadata, so contains entity ids
		if (
			!possibleRoute ||
			possibleRoute.source !== presentRoute.source && possibleRoute.source !== presentRoute.target ||
			possibleRoute.target !== presentRoute.source && possibleRoute.target !== presentRoute.target
		)
		{
			// Trader will be assigned in updateTrader
			ent.setMetadata(PlayerID, "route", undefined);
			if (!possibleRoute && !ent.hasClass("Ship"))
			{
				const closestBase = getBestBase(gameState, this.hq.basesManager, ent, true);
				// onlyConstructedBase (third argument) ensures the anchor exists when a base matched
				if (closestBase && closestBase.accessIndex === access && closestBase.anchor)
				{
					const closestBasePos = closestBase.anchor.position();
					ent.moveToRange(closestBasePos[0], closestBasePos[1], 0, 15);
					return;
				}
			}
			ent.stopMoving();
		}
	}

	prospectForNewMarket(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.economicBuilding.hasQueuedUnitsWithClass("Trade") || queues.dock.hasQueuedUnitsWithClass("Trade"))
		{
			return;
		}
		if (!this.hq.canBuild(gameState, "structures/{civ}/market"))
		{
			return;
		}
		if (
			!gameState.updatingCollection("OwnMarkets", filters.byClass("Trade"), gameState.getOwnStructures())
				.hasEntities() &&
			!gameState.updatingCollection(
				"diplo-ExclusiveAllyMarkets",
				filters.byClass("Trade"),
				gameState.getExclusiveAllyEntities(),
			).hasEntities()
		)
		{
			return;
		}
		// canBuild() above already verified that the template exists.
		const template = requireStructureTemplate(gameState, gameState.applyCiv("structures/{civ}/market"));
		this.checkRoutes(gameState);
		const marketPos = this.hq.placement.findMarketLocation(gameState, template);
		if (!marketPos || marketPos[3] === 0)
		{ // marketPos[3] is the expected gain
			// no position found
			if (gameState.getOwnEntitiesByClass("Market", true).hasEntities())
			{
				this.hq.buildManager.setUnbuildable(gameState, gameState.applyCiv("structures/{civ}/market"));
			}
			else
			{
				this.routeProspection = false;
			}
			return;
		}
		this.routeProspection = false;
		if (!this.isNewMarketWorth(marketPos[3]))
		{
			return; // position found, but not enough gain compared to our present route
		}

		if (this.Config.debug > 1)
		{
			if (this.potentialTradeRoute)
			{
				aiWarn(
					"turn " + gameState.ai.playedTurn + "we could have a new route with gain " +
						marketPos[3] + " instead of the present " + this.potentialTradeRoute.gain,
				);
			}
			else
			{
				aiWarn("turn " + gameState.ai.playedTurn + "we could have a first route with gain " + marketPos[3]);
			}
		}

		if (!this.tradeRoute)
		{
			gameState.ai.queueManager.changePriority("economicBuilding", 2 * this.Config.priorities.economicBuilding);
		}
		const plan = new ConstructionPlan(gameState, "structures/{civ}/market");
		if (!this.tradeRoute)
		{
			plan.queueToReset = "economicBuilding";
		}
		queues.economicBuilding.addPlan(plan);
	}

	isNewMarketWorth(expectedGain: number): boolean
	{
		if (!Resources.GetTradableCodes().length)
		{
			return false;
		}
		if (expectedGain < this.minimalGain)
		{
			return false;
		}
		if (
			this.potentialTradeRoute && expectedGain < 2 * this.potentialTradeRoute.gain &&
			expectedGain < this.potentialTradeRoute.gain + 20
		)
		{
			return false;
		}
		return true;
	}

	update(gameState: CommonGameState, events: EngineAIEvents, queues: PetraRuntime.QueueCollection): void
	{
		if (this.hq.canBarter && Resources.GetBarterableCodes().length)
		{
			this.performBarter(gameState);
		}

		if (this.Config.difficulty <= difficulty.VERY_EASY)
		{
			return;
		}

		if (this.checkEvents(gameState, events))
		{ // true if one market was built or destroyed
			this.traders.forEach((ent) =>
			{
				this.checkTrader(gameState, ent);
			});
			this.checkRoutes(gameState);
		}

		if (this.tradeRoute)
		{
			this.traders.forEach((ent) =>
			{
				this.updateTrader(gameState, ent);
			});
			if (gameState.ai.playedTurn % 5 === 0)
			{
				this.trainMoreTraders(gameState, queues);
			}
			if (gameState.ai.playedTurn % 20 === 0 && this.traders.length >= 2)
			{
				this.hq.researchManager.researchTradeBonus(gameState, queues);
			}
			if (gameState.ai.playedTurn % 60 === 0)
			{
				this.setTradingGoods(gameState);
			}
		}

		if (this.routeProspection)
		{
			this.prospectForNewMarket(gameState, queues);
		}
	}

	Serialize(): SerializedTradeManager
	{
		return {
			tradeRoute: this.tradeRoute,
			potentialTradeRoute: this.potentialTradeRoute,
			routeProspection: this.routeProspection,
			targetNumTraders: this.targetNumTraders,
			warnedAllies: this.warnedAllies,
		};
	}

	private resume(data: SerializedTradeManager): void
	{
		// The fallbacks keep the value set by the constructor for fields absent in
		// savegames written by an older version
		this.tradeRoute = data.tradeRoute;
		this.potentialTradeRoute = data.potentialTradeRoute;
		this.routeProspection = data.routeProspection ?? false;
		this.targetNumTraders = data.targetNumTraders ?? this.Config.Economy.targetNumTraders;
		this.warnedAllies = data.warnedAllies ?? {};
	}
}
