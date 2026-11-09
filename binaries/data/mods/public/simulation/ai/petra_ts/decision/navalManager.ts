import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { getLandAccess, getSeaAccess, requireMetadata, requireValue, setSeaAccess } from "../adapter/entityExtend.ts";
import type { AttackDesk } from "../execution/attackDesk.ts";
import { FishingDesk } from "../execution/fishingDesk.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { TransportDesk } from "../execution/transportDesk.ts";
import { type SeaFleet } from "../execution/transportPlan.ts";
import { gatherTreasure } from "../execution/treasure.ts";
import { fishSea } from "../world/fishing.ts";
import { threatsAt } from "../world/seaRoute.ts";

/** Warships wanted on a sea where the enemy fishes or trades (huntWithFleet). */
export const HUNTERS_PER_SEA = 2;
/** How far from a hunting warship its prey may be. */
const HUNT_RANGE = 400;
/** Seconds a ship must stand still, neither moving nor turning, to be taken for blocked (moveApart). */
export const STUCK_SECONDS = 5;
/** A defensive building's reach when its template names none. */
const DEFAULT_TOWER_REACH = 60;

/** Food of fish per fishing boat wanted on a sea (fishByWhatIsLeft), and the most boats a sea gets. */
export const FISH_PER_BOAT = 1500;
export const FISH_MAX_BOATS = 8;
import { GAIA, NO_BASE, seaRegion } from "../adapter/brands.ts";
import { isPlaced } from "../adapter/placed.ts";
import { isInState, stateIs, unitState } from "../adapter/unitState.ts";
import { plansIn } from "../execution/attackConstants.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";
import type { Geography } from "../world/geography.ts";
import type { BasesManager } from "./basesManager.ts";
import type { Headquarters } from "./headquarters.ts";
import type { TradeManager } from "./tradeManager.ts";

/**
 * What the naval manager asks of the headquarters that owns it: whether the
 * map is naval, the population and what it may build, for its docks; and of
 * its sibling managers: the trader ships to keep out of the way, the attacks
 * to ship, and the bases on the shore.
 */
export type NavalHQ = Pick<Headquarters, "navalMap" | "getAccountedPopulation" | "canBuild"> & {
	readonly tradeManager: Pick<TradeManager, "traders">;
	readonly basesManager: Pick<BasesManager, "hasPotentialBase" | "baseManagers">;
	readonly town: { readonly attacks: Pick<AttackDesk, "upcomingAttacks">; };
};

/**
 * Naval Manager
 * Will deal with anything ships.
 * -Basically trade over water (with fleets and goals commissioned by the economy manager)
 * -Defense over water (commissioned by the defense manager)
 * -Transport of units over water (a few units).
 * -Scouting, ultimately.
 * Also deals with handling docks, making sure we have access and stuffs like that.
 */
/** The enemy's fishing boats and merchant ships by the sea they sail */
function enemyPreyBySea(gameState: CommonGameState): Map<number, CommonPlacedEntity[]>
{
	const access = gameState.ai.accessibility;
	const prey = new Map<number, CommonPlacedEntity[]>();
	for (const ship of gameState.getEnemyUnits().values())
	{
		if (!isPlaced(ship) || ship.owner() === GAIA || !ship.hasClasses(["FishingBoat", "Trader+Ship"]))
		{
			continue;
		}
		const pos = ship.position();
		const sea = access.getAccessValue(pos, true);
		const list = prey.get(sea);
		if (list)
		{
			list.push(ship);
		}
		else
		{
			prey.set(sea, [ship]);
		}
	}
	return prey;
}

/** The nearest prey within HUNT_RANGE of pos and out of the towers' reach */
function nearestPrey(
	list: CommonPlacedEntity[],
	pos: CommonPosition,
	towers: Parameters<typeof threatsAt>[1],
): CommonEntity | undefined
{
	let best: CommonEntity | undefined;
	let bestDist = HUNT_RANGE * HUNT_RANGE;
	for (const target of list)
	{
		const at = target.position();
		const dist = SquareVectorDistance(at, pos);
		if (dist >= bestDist || threatsAt(at, towers) > 0)
		{
			continue;
		}
		best = target;
		bestDist = dist;
	}
	return best;
}

/** Whether a ship sails to a supply or back to a dropsite */
function approachesSupply(ship: CommonEntity): boolean
{
	const state = unitState(ship);
	return stateIs(state, "INDIVIDUAL.GATHER.APPROACHING") ||
		stateIs(state, "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING");
}

/** Our merchant ships trading, which the trade manager steers */
function tradingShips(hq: NavalHQ): CommonEntity[]
{
	return hq.tradeManager.traders.filter(filters.byClass("Ship")).toEntityArray().filter((ship) =>
	{
		const role = ship.getMetadata(PlayerID, "role");
		return role !== undefined && role === Worker.ROLE_TRADER; // others already accounted before
	});
}

/** A ship near a blocked one at shipPosition moves off: one at work only when very near. */
function makeWay(blockingShip: CommonPlacedEntity, shipPosition: CommonPosition, atWork: boolean): void
{
	const distSquare = SquareVectorDistance(shipPosition, blockingShip.position());
	if (!atWork)
	{
		if (distSquare < 1600)
		{
			blockingShip.moveToRange(shipPosition[0], shipPosition[1], 40, 45);
		}
	}
	else if (distSquare < 900)
	{
		blockingShip.moveToRange(shipPosition[0], shipPosition[1], 30, 35);
	}
}

/**
 * How well a ship serves goal: for an attack its default arrows, for a transport its capacity with a bonus
 * for arrows and for carrying siege (undefined under 2), for fishing 0 for a fishing boat; undefined if not at all.
 */
function shipScore(template: CommonTemplate, goal: "attack" | "transport" | "fishing"): number | undefined
{
	const arrows = +(template.getDefaultArrow() || 0);
	if (goal === "attack")
	{
		return arrows;
	}
	if (goal === "transport")
	{
		let capacity = +(template.garrisonMax() || 0);
		if (capacity < 2)
		{
			return undefined;
		}
		capacity += 10 * arrows;
		if (MatchesClassList(template.garrisonableClasses(), "Siege"))
		{
			capacity += 50;
		}
		return capacity;
	}
	return template.hasClass("FishingBoat") ? 0 : undefined;
}

/** The sea of our new docks and shipyards, and of our new ships */
function setNewShipsSeas(gameState: CommonGameState, events: EngineAIEvents): void
{
	for (const evt of events.Create)
	{
		if (!evt.entity)
		{
			continue;
		}
		const ent = gameState.getEntityById(evt.entity);
		if (
			ent && ent.isOwn(PlayerID) && ent.foundationProgress() !== undefined && ent.hasClasses(["Dock", "Shipyard"])
		)
		{
			setSeaAccess(gameState, ent);
		}
	}

	for (const evt of events.TrainingFinished)
	{
		if (!evt.entities)
		{
			continue;
		}
		for (const entId of evt.entities)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent || !ent.hasClass("Ship") || !ent.isOwn(PlayerID))
			{
				continue;
			}
			setSeaAccess(gameState, ent);
		}
	}
}

/**
 * Whether a ship under way is blocked: neither moved nor turned for
 * STUCK_SECONDS (then counted again from now). Petra took a ship unmoved
 * for two turns, and a ship turns slowly in place: sent 30 m aside as it
 * turned, it turned again, and wandered round one spot (FINDINGS §45).
 */
function isShipBlocked(gameState: CommonGameState, ship: CommonEntity, shipPosition: CommonPosition): boolean
{
	const now = gameState.ai.elapsedTime;
	const angle = ship.angle();
	const previousPosition = ship.getMetadata(PlayerID, "previousPosition");
	if (
		!previousPosition || previousPosition[0] !== shipPosition[0] ||
		previousPosition[1] !== shipPosition[1] || ship.getMetadata(PlayerID, "previousAngle") !== angle
	)
	{
		ship.setMetadata(PlayerID, "previousPosition", shipPosition);
		ship.setMetadata(PlayerID, "previousAngle", angle);
		ship.setMetadata(PlayerID, "stillSince", now);
		return false;
	}
	if (now - requireMetadata(ship, "stillSince") < STUCK_SECONDS)
	{
		return false;
	}
	ship.setMetadata(PlayerID, "stillSince", now);
	return true;
}

/** A ship idle where it was last turn: it gathers treasure nearby, or leaves the docks' waters to other ships */
function moveIdleShipApart(gameState: CommonGameState, ship: CommonPlacedEntity, shipPosition: CommonPosition): void
{
	const previousIdlePosition = ship.getMetadata(PlayerID, "previousIdlePosition");
	if (
		!previousIdlePosition || previousIdlePosition[0] !== shipPosition[0] ||
		previousIdlePosition[1] !== shipPosition[1]
	)
	{
		ship.setMetadata(PlayerID, "previousIdlePosition", shipPosition);
		ship.setMetadata(PlayerID, "stationnary", undefined);
		return;
	}
	if (ship.getMetadata(PlayerID, "stationnary"))
	{
		return;
	}
	ship.setMetadata(PlayerID, "stationnary", true);
	// Check if there are some treasure around
	if (gatherTreasure(gameState, ship, true))
	{
		return;
	}
	// Do not stay idle near a dock to not disturb other ships
	// our transport and trader ships always have their sea set (see init and checkEvents)
	const sea = getSeaAccess(gameState, ship);
	for (const dock of gameState.getAllyStructures().filter(filters.byClass("Dock")).values())
	{
		if (getSeaAccess(gameState, dock) !== sea)
		{
			continue;
		}
		if (SquareVectorDistance(shipPosition, dock.position()) > 4900)
		{
			continue;
		}
		ship.moveToRange(dock.position()[0], dock.position()[1], 70, 75);
	}
}

/** The ship a sea should be trained for: the best attacker, carrier or fisher among those its docks can train */
export function getBestShip(
	gameState: CommonGameState,
	sea: SeaIndex,
	goal: "attack" | "transport" | "fishing",
): string | undefined
{
	const civ = gameState.getPlayerCiv();
	const trainableShips = new Map<string, CommonTemplate>();
	gameState.getOwnTrainingFacilities().filter(filters.byMetadata(PlayerID, "sea", sea)).forEach(
		function(ent: CommonEntity): void
		{
			// the facilities with a sea are our docks and shipyards, which all train ships
			for (const trainable of requireValue(ent.trainableEntities(civ)))
			{
				if (gameState.isTemplateDisabled(trainable))
				{
					continue;
				}
				const template = gameState.getTemplate(trainable);
				if (template && template.hasClass("Ship") && !trainableShips.has(trainable))
				{
					trainableShips.set(trainable, template);
				}
			}
		},
	);

	let best = 0;
	let bestShip;
	const limits = gameState.getEntityLimits();
	const current = gameState.getEntityCounts();
	for (const [trainable, template] of trainableShips)
	{
		if (!template.available(gameState))
		{
			continue;
		}

		const category = template.trainingCategory();
		if (category && limits[category] && current[category] >= limits[category])
		{
			continue;
		}

		const score = shipScore(template, goal);
		if (score === undefined || best > score)
		{
			continue;
		}
		best = score;
		bestShip = trainable;
	}
	return bestShip;
}

export class NavalManager
{
	Config: Config;
	docks: CommonEntityCollection<CommonStructureEntity>;
	fishShips: CommonEntityCollection;
	ships: CommonEntityCollection;
	transportShips: CommonEntityCollection;
	warShips: CommonEntityCollection;

	// ship subCollections. Also exist for land zones, idem, not caring.
	/** Each sea's ships, for the naval regions only (in their order) */
	fleets = new Map<number, SeaFleet>();

	// wanted NB per zone.
	wantedTransportShips: number[] = [];
	wantedWarShips: number[] = [];
	wantedFishShips: number[] = [];
	// needed NB per zone.
	neededTransportShips: number[] = [];
	neededWarShips: number[] = [];

	readonly hq: NavalHQ;
	/** the transport plans, made, run and kept on the execution side (execution/transportDesk.ts): its desk in the town */
	readonly desk: TransportDesk;
	/** what the fishers ask and report, on the execution side (execution/fishingDesk.ts) */
	readonly fishing: FishingDesk;

	constructor(Config: Config, gameState: CommonGameState, geography: Geography, hq: NavalHQ)
	{
		this.Config = Config;
		this.hq = hq;
		this.desk = new TransportDesk(Config, this);
		this.fishing = new FishingDesk(this);
		// docks
		this.docks = gameState.getOwnStructures().filter(filters.byClasses(["Dock", "Shipyard"]));
		this.docks.registerUpdates();

		this.ships = gameState.getOwnUnits().filter(
			filters.and(filters.byClass("Ship"), filters.not(filters.byMetadata(PlayerID, "role", Worker.ROLE_TRADER))),
		);
		// note: those two can overlap (some transport ships are warships too and vice-versa).
		this.transportShips = this.ships.filter(
			filters.and(filters.byCanGarrison(), filters.not(filters.byClass("FishingBoat"))),
		);
		this.warShips = this.ships.filter(filters.byClass("Warship"));
		this.fishShips = this.ships.filter(filters.byClass("FishingBoat"));

		this.ships.registerUpdates();
		this.transportShips.registerUpdates();
		this.warShips.registerUpdates();
		this.fishShips.registerUpdates();

		this.setUpFleets(gameState, geography);
	}

	/** A fleet on each sea we can sail, and the ships wanted there: fishing boats where there are fish enough. */
	private setUpFleets(gameState: CommonGameState, geography: Geography): void
	{
		const availableFishes: Record<number, number> = {};
		for (const fish of gameState.getFishableSupplies().values())
		{
			const sea = fishSea(gameState, fish);
			const amount = fish.resourceSupplyAmount();
			if (sea && availableFishes[sea])
			{
				availableFishes[sea] += amount;
			}
			else if (sea)
			{
				availableFishes[sea] = amount;
			}
		}

		for (let i = 0; i < gameState.ai.accessibility.regionSize.length; ++i)
		{
			if (!geography.navalRegions[i])
			{
				// a land, or a sea too small to sail: no fleet
				this.wantedTransportShips.push(0);
				this.wantedWarShips.push(0);
				this.wantedFishShips.push(0);
				this.neededTransportShips.push(0);
				this.neededWarShips.push(0);
				continue;
			}
			const onSea = (collection: CommonEntityCollection): CommonEntityCollection =>
			{
				const collec = collection.filter(filters.byMetadata(PlayerID, "sea", i));
				collec.registerUpdates();
				return collec;
			};
			this.fleets.set(i, {
				ships: onSea(this.ships),
				transports: onSea(this.transportShips),
				warShips: onSea(this.warShips),
				fishers: onSea(this.fishShips),
			});
			this.wantedTransportShips.push(0);
			this.wantedWarShips.push(0);
			if (availableFishes[i] && availableFishes[i] > 1000)
			{
				this.wantedFishShips.push(this.Config.Economy.targetNumFishers);
			}
			else
			{
				this.wantedFishShips.push(0);
			}
			this.neededTransportShips.push(0);
			this.neededWarShips.push(0);
		}
	}

	/** The ships on a sea, undefined for a land or a sea too small to sail (no naval region) */
	fleet(sea: number): SeaFleet | undefined
	{
		return this.fleets.get(sea);
	}

	/** A saved naval manager: its wishes, landing zones and transports from the save */
	static restore(
		Config: Config,
		gameState: CommonGameState,
		geography: Geography,
		data: ReturnType<NavalManager["Serialize"]>,
		hq: NavalHQ,
	): NavalManager
	{
		const manager = new NavalManager(Config, gameState, geography, hq);
		manager.resume(gameState, data);
		return manager;
	}

	/** At the start of a game, the sea each of our docks and ships is on */
	assignStartingSeas(gameState: CommonGameState): void
	{
		for (const ship of this.ships.values())
		{
			setSeaAccess(gameState, ship);
		}
		for (const dock of this.docks.values())
		{
			setSeaAccess(gameState, dock);
		}
	}

	/**
	 * On a naval map, the fishing boats wanted on each sea that still has fish
	 * follow the fish left in it: one per FISH_PER_BOAT, 1 to FISH_MAX_BOATS.
	 * Petra wanted 1 (2 from a small starting island) whatever the sea held,
	 * and island towns starved with fish beside them (FINDINGS §41). A sea
	 * whose fish ran out (its count set to 0 by the workers) stays at 0.
	 */
	fishByWhatIsLeft(gameState: CommonGameState): void
	{
		if (!this.hq.navalMap)
		{
			return;
		}
		const fishLeft: Record<number, number> = {};
		for (const fish of gameState.getFishableSupplies().values())
		{
			const sea = fishSea(gameState, fish);
			if (sea)
			{
				fishLeft[sea] = (fishLeft[sea] ?? 0) + (fish.resourceSupplyAmount() ?? 0);
			}
		}
		for (let sea = 0; sea < this.wantedFishShips.length; ++sea)
		{
			if (this.wantedFishShips[sea])
			{
				this.wantedFishShips[sea] = Math.min(
					FISH_MAX_BOATS,
					Math.max(1, Math.ceil((fishLeft[sea] ?? 0) / FISH_PER_BOAT)),
				);
			}
		}
	}

	updateFishingBoats(sea: SeaIndex, num: number): void
	{
		if (this.wantedFishShips[sea])
		{
			this.wantedFishShips[sea] = num;
		}
	}

	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void
	{
		if (sea !== undefined)
		{
			this.wantedFishShips[sea] = 0;
		}
		else
		{
			this.wantedFishShips.fill(0);
		}
	}

	/** get the list of seas (or lands) around this region not connected by a dock */
	getUnconnectedSeas(gameState: CommonGameState, region: AccessIndex): SeaIndex[]
	{
		// a land region links only to seas
		const seas = gameState.ai.accessibility.regionLinks[region].map(seaRegion);
		this.docks.forEach((dock) =>
		{
			if (!dock.hasClass("Dock") || getLandAccess(gameState, dock) !== region)
			{
				return;
			}
			const i = seas.indexOf(getSeaAccess(gameState, dock));
			if (i !== -1)
			{
				seas.splice(i, 1);
			}
		});
		return seas;
	}

	checkEvents(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): void
	{
		setNewShipsSeas(gameState, events);
		this.desk.checkShipsLost(gameState, events.Destroy);

		for (const evt of events.OwnershipChanged)
		{ // capture events
			if (evt.to !== PlayerID)
			{
				continue;
			}
			const ent = gameState.getEntityById(evt.entity);
			if (ent && ent.hasClasses(["Dock", "Shipyard"]))
			{
				setSeaAccess(gameState, ent);
			}
		}
	}

	// set minimal number of needed ships when a new event (new base or new attack plan)
	setMinimalTransportShips(gameState: CommonGameState, sea: SeaIndex, number: number): void
	{
		if (!sea)
		{
			return;
		}
		if (this.wantedTransportShips[sea] < number)
		{
			this.wantedTransportShips[sea] = number;
		}
	}

	// bumps up the number of ships we want if we need more.
	checkLevels(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.ships.hasQueuedUnits())
		{
			return;
		}

		for (let sea = 0; sea < this.neededTransportShips.length; sea++)
		{
			this.neededTransportShips[sea] = 0;
		}

		for (const plan of this.desk.plans)
		{
			if (!plan.needTransportShips || plan.units.length < 2)
			{
				continue;
			}
			const sea = plan.sea;
			const seaTransports = plan.seaFleet.transports.length;
			if (
				gameState.countOwnQueuedEntitiesWithMetadata("sea", sea) > 0 ||
				seaTransports < this.wantedTransportShips[sea]
			)
			{
				continue;
			}
			++this.neededTransportShips[sea];
			if (this.wantedTransportShips[sea] === 0 || seaTransports < plan.transportShips.length + 2)
			{
				++this.wantedTransportShips[sea];
				return;
			}
		}

		for (let sea = 0; sea < this.neededTransportShips.length; sea++)
		{
			if (this.neededTransportShips[sea] > 2)
			{
				++this.wantedTransportShips[sea];
			}
		}
	}

	/**
	 * While a transport with units waits for ships, the ship queue goes just
	 * above the training queues, as a needed house does: at its configured 1,
	 * a saving island town paid for no transport and its army waited at the
	 * shore for good (FINDINGS §37: 10 of 23 drawn island games at minute 61).
	 */
	shipPriority(gameState: CommonGameState): void
	{
		const priorities = this.Config.priorities;
		// a transport with units waiting for ships, or an attack preparing for a sea without any
		const waiting = this.desk.waitingForShips() ||
			[...plansIn(this.hq.town.attacks.upcomingAttacks)].some((plan) =>
				plan.overseas !== 0 && plan.unitCollection.hasEntities() &&
				!this.fleet(plan.overseas)?.transports.length
			);
		const priority = waiting ? Math.max(priorities.villager, priorities.citizenSoldier) + 2 : priorities.ships;
		if (gameState.ai.queueManager.getPriority("ships") !== priority)
		{
			gameState.ai.queueManager.changePriority("ships", priority);
		}
	}

	maintainFleet(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		this.shipPriority(gameState);
		if (queues.ships.hasQueuedUnits())
		{
			return;
		}
		if (!this.docks.filter(filters.isBuilt()).hasEntities())
		{
			return;
		}
		// check if we have enough transport ships per region.
		for (const [seaNumber, fleet] of this.fleets)
		{
			const sea = seaRegion(seaNumber);
			const transports = fleet.transports;
			const fishers = fleet.fishers;
			if (gameState.countOwnQueuedEntitiesWithMetadata("sea", sea) > 0)
			{
				continue;
			}

			if (transports.length < this.wantedTransportShips[sea])
			{
				const template = getBestShip(gameState, sea, "transport");
				if (template)
				{
					queues.ships.addPlan(new TrainingPlan(gameState, template, { sea: sea }, 1, 1));
					continue;
				}
			}

			if (fishers.length < this.wantedFishShips[sea])
			{
				const template = getBestShip(gameState, sea, "fishing");
				if (template)
				{
					queues.ships.addPlan(
						new TrainingPlan(
							gameState,
							template,
							{ base: NO_BASE, role: Worker.ROLE_WORKER, sea: sea },
							1,
							1,
						),
					);
					continue;
				}
			}

			const warShips = fleet.warShips;
			if (warShips.length < this.wantedWarShips[sea])
			{
				const template = getBestShip(gameState, sea, "attack");
				if (template)
				{
					queues.ships.addPlan(new TrainingPlan(gameState, template, { sea: sea }, 1, 1));
					continue;
				}
			}
		}
	}

	/**
	 * The enemy's fishing boats and merchant ships are what an island lives
	 * on, and nothing hunted them: Petra never wanted a warship of its own
	 * (FINDINGS §42). On a naval map, a sea with one of our docks and enemy
	 * fishing boats or merchant ships wants HUNTERS_PER_SEA warships; each of
	 * our warships idle and not carrying for a transport attacks the nearest
	 * such ship of its sea within HUNT_RANGE, out of reach of the enemy's
	 * towers and fortresses.
	 */
	huntWithFleet(gameState: CommonGameState): void
	{
		if (!this.hq.navalMap)
		{
			return;
		}
		const access = gameState.ai.accessibility;
		const prey = enemyPreyBySea(gameState);
		for (const dock of this.docks.filter(filters.isBuilt()).values())
		{
			const sea = getSeaAccess(gameState, dock);
			if (sea !== undefined && prey.has(sea) && this.wantedWarShips[sea] < HUNTERS_PER_SEA)
			{
				this.wantedWarShips[sea] = HUNTERS_PER_SEA;
			}
		}
		// the enemy's towers, fortresses and civic centres: prey in their reach is let be
		const towers = gameState.getEnemyStructures().toEntityArray().filter((ent) =>
			ent.owner() !== GAIA && ent.hasDefensiveFire()
		).map((ent) => ({ pos: ent.position(), range: ent.attackRange("Ranged")?.max ?? DEFAULT_TOWER_REACH }));
		for (const ship of this.warShips.values())
		{
			const pos = ship.position();
			if (!pos || !ship.isIdle() || ship.getMetadata(PlayerID, "transporter") !== undefined)
			{
				continue;
			}
			const list = prey.get(access.getAccessValue(pos, true));
			if (!list)
			{
				continue;
			}
			const best = nearestPrey(list, pos, towers);
			if (best)
			{
				ship.attack(best.id(), false);
			}
		}
	}

	/** let blocking ships move apart from active ships (waiting for a better pathfinder)
	 * TODO Ships entity collections are currently in two parts as the trader ships are dealt with
	 * in the tradeManager. That should be modified to avoid dupplicating all the code here.
	 */
	moveApart(gameState: CommonGameState): void
	{
		const blockedShips: CommonPlacedEntity[] = [];
		const blockedIds: EntityId[] = [];
		const nudgeIfBlocked = (ship: CommonPlacedEntity, shipPosition: CommonPosition): void =>
		{
			if (!isShipBlocked(gameState, ship, shipPosition))
			{
				return;
			}
			ship.moveToRange(shipPosition[0] + randFloat(-1, 1), shipPosition[1] + randFloat(-1, 1), 30, 35);
			blockedShips.push(ship);
			blockedIds.push(ship.id());
		};

		for (const ship of this.ships.values())
		{
			if (!isPlaced(ship))
			{
				continue;
			}
			const shipPosition = ship.position();
			if (ship.getMetadata(PlayerID, "transporter") !== undefined && this.desk.isShipBoarding(ship))
			{
				continue;
			}

			const transporter = ship.getMetadata(PlayerID, "transporter");
			if (transporter !== undefined || approachesSupply(ship))
			{
				// a ship its transport sails by a route is left to it: its plan
				// judges it stuck by its headway, and a nudge here threw its route
				// away, the plan sending it again (FINDINGS §45)
				if (transporter === undefined || !this.desk.getPlan(transporter)?.routes[ship.id()])
				{
					nudgeIfBlocked(ship, shipPosition);
				}
			}
			else if (ship.isIdle())
			{
				moveIdleShipApart(gameState, ship, shipPosition);
			}
		}

		for (const ship of tradingShips(this.hq))
		{
			if (!isPlaced(ship))
			{
				continue;
			}
			const shipPosition = ship.position();
			if (isInState(ship, "INDIVIDUAL.TRADE.APPROACHINGMARKET"))
			{
				nudgeIfBlocked(ship, shipPosition);
			}
			else if (ship.isIdle())
			{
				moveIdleShipApart(gameState, ship, shipPosition);
			}
		}

		for (const ship of blockedShips)
		{
			this.clearWayFor(gameState, ship, blockedIds);
		}
	}

	/** The ships near a blocked one move off: those at work only when very near. */
	private clearWayFor(gameState: CommonGameState, ship: CommonPlacedEntity, blockedIds: EntityId[]): void
	{
		const shipPosition = ship.position();
		// our transport ships always have their sea set (see init and checkEvents)
		const sea = getSeaAccess(gameState, ship);
		const fleet = this.fleet(sea);
		// a ship on a sea too small to sail has none to move away from
		if (!fleet)
		{
			return;
		}
		for (const blockingShip of fleet.ships.values())
		{
			if (blockedIds.indexOf(blockingShip.id()) !== -1 || !isPlaced(blockingShip))
			{
				continue;
			}
			const atWork = blockingShip.getMetadata(PlayerID, "transporter") !== undefined ||
				approachesSupply(blockingShip);
			makeWay(blockingShip, shipPosition, atWork);
		}

		for (const blockingShip of tradingShips(this.hq))
		{
			if (blockingShip.getMetadata(PlayerID, "sea") !== sea)
			{
				continue;
			}
			if (blockedIds.indexOf(blockingShip.id()) !== -1 || !isPlaced(blockingShip))
			{
				continue;
			}
			makeWay(blockingShip, shipPosition, isInState(blockingShip, "INDIVIDUAL.TRADE.APPROACHINGMARKET"));
		}
	}

	buildNavalStructures(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (!gameState.ai.geography.navalMap || !this.hq.basesManager.hasPotentialBase())
		{
			return;
		}

		if (
			this.hq.getAccountedPopulation(gameState) > this.Config.Economy.popForDock &&
			queues.dock.countQueuedUnitsWithClass("Dock") === 0 &&
			!gameState.getOwnStructures().filter(filters.and(filters.byClass("Dock"), filters.isFoundation()))
				.hasEntities() &&
			this.hq.canBuild(gameState, "structures/{civ}/dock")
		)
		{
			this.queueDock(gameState, queues);
		}
		this.queueShipyard(gameState, queues);
	}

	/** A shipyard once in town phase with a dock and a market, if none stands yet */
	private queueShipyard(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (
			gameState.currentPhase() < 2 ||
			this.hq.getAccountedPopulation(gameState) < this.Config.Economy.popPhase2 + 15 ||
			queues.militaryBuilding.hasQueuedUnits()
		)
		{
			return;
		}
		if (
			!this.docks.filter(filters.byClass("Dock")).hasEntities() ||
			this.docks.filter(filters.byClass("Shipyard")).hasEntities()
		)
		{
			return;
		}
		// Use in priority resources to build a Market.
		if (
			!gameState.getOwnEntitiesByClass("Market", true).hasEntities() &&
			this.hq.canBuild(gameState, "structures/{civ}/market")
		)
		{
			return;
		}
		let template;
		if (this.hq.canBuild(gameState, "structures/{civ}/super_dock"))
		{
			template = "structures/{civ}/super_dock";
		}
		else if (this.hq.canBuild(gameState, "structures/{civ}/shipyard"))
		{
			template = "structures/{civ}/shipyard";
		}
		else
		{
			return;
		}
		const wantedLand: Record<number, boolean> = {};
		for (const base of this.hq.basesManager.baseManagers)
		{
			if (base.anchor)
			{
				wantedLand[requireValue(base.accessIndex)] = true;
			}
		}
		// our docks always have their sea set (see init and checkEvents)
		const sea = getSeaAccess(gameState, this.docks.toEntityArray()[0]);
		queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, template, { land: wantedLand, sea: sea }));
	}

	/** A dock for the first built base with a sea we can sail and no dock of ours on it */
	private queueDock(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		for (const base of this.hq.basesManager.baseManagers)
		{
			if (!base.anchor || base.constructing)
			{
				continue;
			}
			// set with the anchor
			const baseAccessIndex = requireValue(base.accessIndex);
			const sea = this.getUnconnectedSeas(gameState, baseAccessIndex).find((s) =>
				gameState.ai.geography.navalRegions[s]
			);
			if (sea === undefined)
			{
				continue;
			}
			const wantedLand: Record<number, boolean> = {};
			wantedLand[baseAccessIndex] = true;
			queues.dock.addPlan(
				new ConstructionPlan(gameState, "structures/{civ}/dock", { land: wantedLand, sea: sea }),
			);
			return;
		}
	}

	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): void
	{
		Engine.ProfileStart("Naval Manager update");

		// close finished transport plans, and assign free ships to plans which need them
		this.desk.update(gameState);

		if (gameState.ai.playedTurn % 20 === 11)
		{
			this.fishByWhatIsLeft(gameState);
		}
		if (gameState.ai.playedTurn % 5 === 2)
		{
			this.huntWithFleet(gameState);
		}
		// and require for more ships/structures if needed
		if (gameState.ai.playedTurn % 3 === 0)
		{
			this.checkLevels(gameState, queues);
			this.maintainFleet(gameState, queues);
			this.buildNavalStructures(gameState, queues);
		}
		// let inactive ships move apart from active ones (waiting for a better pathfinder)
		this.moveApart(gameState);

		Engine.ProfileStop();
	}

	Serialize(): {
		properties: {
			wantedTransportShips: number[];
			wantedWarShips: number[];
			wantedFishShips: number[];
			neededTransportShips: number[];
			neededWarShips: number[];
		};
	}
	{
		const properties = {
			wantedTransportShips: this.wantedTransportShips,
			wantedWarShips: this.wantedWarShips,
			wantedFishShips: this.wantedFishShips,
			neededTransportShips: this.neededTransportShips,
			neededWarShips: this.neededWarShips,
		};

		return { properties: properties };
	}

	private resume(gameState: CommonGameState, data: ReturnType<NavalManager["Serialize"]>): void
	{
		this.wantedTransportShips = data.properties.wantedTransportShips;
		this.wantedWarShips = data.properties.wantedWarShips;
		this.wantedFishShips = data.properties.wantedFishShips;
		this.neededTransportShips = data.properties.neededTransportShips;
		this.neededWarShips = data.properties.neededWarShips;
	}
}
