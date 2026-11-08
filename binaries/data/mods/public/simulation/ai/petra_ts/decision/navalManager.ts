import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import {
	getLandAccess,
	getSeaAccess,
	isSiegeUnit,
	requireMetadata,
	requireValue,
	setSeaAccess,
} from "../adapter/entityExtend.ts";
import { plansIn } from "../execution/attackPlan.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { TransportPlan, type SeaFleet } from "../execution/transportPlan.ts";
import { gatherTreasure } from "../execution/treasure.ts";
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
import { GAIA, NO_BASE, cellIndex, seaRegion } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { isPlaced } from "../adapter/placed.ts";
import { isInState, stateIs, unitState } from "../adapter/unitState.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";
import type { Geography } from "../world/geography.ts";

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
function tradingShips(gameState: CommonGameState): CommonEntity[]
{
	return gameState.ai.HQ.tradeManager.traders.filter(filters.byClass("Ship")).toEntityArray().filter((ship) =>
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

/** Keeps the cells of a landing zone with the most neighbours in it, up to 2 */
function keepRoomyCells(landing: Set<number>, width: number): void
{
	const nbaround: Record<number, number> = {};
	let nbcut = 0;
	for (const i of landing)
	{
		let nb = 0;
		if (landing.has(i - 1))
		{
			nb++;
		}
		if (landing.has(i + 1))
		{
			nb++;
		}
		if (landing.has(i + width))
		{
			nb++;
		}
		if (landing.has(i - width))
		{
			nb++;
		}
		nbaround[i] = nb;
		nbcut = Math.max(nb, nbcut);
	}
	nbcut = Math.min(2, nbcut);
	for (const i of landing)
	{
		if (nbaround[i] < nbcut)
		{
			landing.delete(i);
		}
	}
}

const FISH_RAYS = [[-0.7, 0.7], [0, 1], [0.7, 0.7], [1, 0], [0.7, -0.7], [0, -1], [-0.7, -0.7], [-1, 0]];

/** The cell index of the t-th of ntry steps towards pos from radius*ntry cells in direction a, or undefined off the map */
function ringCell(
	ring: { pos: number[]; radius: number; ntry: number; width: number; },
	a: number[],
	t: number,
): number | undefined
{
	const { pos, radius, ntry, width } = ring;
	const i = pos[0] + Math.round(a[0] * radius * (ntry - t));
	const j = pos[1] + Math.round(a[1] * radius * (ntry - t));
	if (i < 0 || i >= width || j < 0 || j >= width)
	{
		return undefined;
	}
	return i + j * width;
}

/** Whether every ray of ntry steps from 120 m out towards fishPos satisfies checkCell */
function everyFishRay(
	map: { cellSize: number; width: number; gamePosToMapPos(pos: CommonPosition): MapPos; },
	fishPos: CommonPosition,
	ntry: number,
	checkCell: (cell: number) => "pass" | "next" | "fail",
): boolean
{
	const pos = map.gamePosToMapPos(fishPos);
	const width = map.width;
	const radius = 120 / map.cellSize / ntry;
	return FISH_RAYS.every((a) =>
	{
		for (let t = 0; t < ntry; ++t)
		{
			const cell = ringCell({ pos, radius, ntry, width }, a, t);
			if (cell === undefined)
			{
				continue;
			}
			const step = checkCell(cell);
			if (step !== "next")
			{
				return step === "pass";
			}
		}
		return true;
	});
}

/** Get the sea a fish is in, cache it, and check whether it lies in open sea */
function fishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
{
	let sea = fish.getMetadata(PlayerID, "sea");
	if (sea)
	{
		return sea;
	}
	const access = gameState.ai.accessibility;
	const pos = access.gamePosToMapPos(fish.position());
	const k = pos[0] + pos[1] * access.width;
	sea = access.navalPassMap[k];
	fish.setMetadata(PlayerID, "sea", sea);
	if (
		everyFishRay(access, fish.position(), 4, (cell) =>
		{
			if (access.landPassMap[cell] !== 1)
			{
				return "fail";
			}
			const navalPass = access.navalPassMap[cell];
			return navalPass === sea ? "pass" : navalPass === 1 ? "next" : "fail";
		})
	)
	{
		fish.setMetadata(PlayerID, "opensea", true);
	}
	return sea;
}

/** Whether no enemy territory lies near a fish */
function fishIsSafe(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
{
	if (fish.getMetadata(PlayerID, "opensea"))
	{
		return true;
	}
	const territoryMap = gameState.ai.HQ.geography.territoryMap;
	return everyFishRay(territoryMap, fish.position(), 2, (cell) =>
	{
		const owner = territoryMap.getOwnerIndex(cellIndex(territoryMap, cell));
		return owner !== 0 && gameState.isPlayerEnemy(owner) ? "fail" : "next";
	});
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

	transportPlans: TransportPlan[] = [];

	// shore-line regions where we can load and unload units
	landingZones: Record<number, Record<number, Set<number>>> = {};

	constructor(Config: Config, gameState: CommonGameState, geography: Geography)
	{
		this.Config = Config;
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
		this.findLandingZones(gameState);
	}

	/** A fleet on each sea we can sail, and the ships wanted there: fishing boats where there are fish enough. */
	private setUpFleets(gameState: CommonGameState, geography: Geography): void
	{
		const availableFishes: Record<number, number> = {};
		for (const fish of gameState.getFishableSupplies().values())
		{
			const sea = this.getFishSea(gameState, fish);
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

	/** The possible landing zones: the shore cells of each land on each sea, those with room around when possible. */
	private findLandingZones(gameState: CommonGameState): void
	{
		const width = gameState.getPassabilityMap().width;
		const length = width * gameState.getPassabilityMap().height;
		for (let i = 0; i < length; ++i)
		{
			const land = gameState.ai.accessibility.landPassMap[i];
			if (land < 2)
			{
				continue;
			}
			const naval = gameState.ai.accessibility.navalPassMap[i];
			if (naval < 2)
			{
				continue;
			}
			if (!this.landingZones[land])
			{
				this.landingZones[land] = {};
			}
			if (!this.landingZones[land][naval])
			{
				this.landingZones[land][naval] = new Set();
			}
			this.landingZones[land][naval].add(i);
		}
		// and keep only thoses with enough room around when possible
		for (const land in this.landingZones)
		{
			for (const sea in this.landingZones[land])
			{
				keepRoomyCells(this.landingZones[land][sea], width);
			}
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
	): NavalManager
	{
		const manager = new NavalManager(Config, gameState, geography);
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
		if (!gameState.ai.HQ.navalMap)
		{
			return;
		}
		const fishLeft: Record<number, number> = {};
		for (const fish of gameState.getFishableSupplies().values())
		{
			const sea = this.getFishSea(gameState, fish);
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

	/** Get the sea, cache it if not yet done and check if in opensea */
	getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
	{
		return fishSea(gameState, fish);
	}

	/** check if we can safely fish at the fish position */
	canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
	{
		return fishIsSafe(gameState, fish);
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

		for (const evt of events.Destroy)
		{
			const transporter = evt.metadata?.[PlayerID]?.transporter;
			if (!transporter)
			{
				continue;
			}
			const plan = this.getPlan(transporter);
			if (!plan)
			{
				continue;
			}

			this.onShipLost(gameState, plan, evt.entity);
		}

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

	/** A ship of a transport plan was destroyed: the units it was to carry wait for another, those landed ask anew. */
	private onShipLost(gameState: CommonGameState, plan: TransportPlan, shipId: EntityId): void
	{
		debugWarn(
			this.Config,
			1,
			() => "one ship " + shipId + " from plan " + plan.ID + " destroyed during " + plan.state,
		);
		if (plan.state === TransportPlan.BOARDING)
		{
			// just reset the units onBoard metadata and wait for a new ship to be assigned to this plan
			plan.units.forEach((ent) =>
			{
				if (
					ent.getMetadata(PlayerID, "onBoard") === "onBoard" && isPlaced(ent) ||
					ent.getMetadata(PlayerID, "onBoard") === shipId
				)
				{
					ent.setMetadata(PlayerID, "onBoard", undefined);
				}
			});
			plan.needTransportShips = !plan.transportShips.hasEntities();
		}
		else if (plan.state === TransportPlan.SAILING)
		{
			const endIndex = plan.endIndex;
			for (const ent of plan.units.values())
			{
				if (!isPlaced(ent))
				{ // unit from another ship of this plan ... do nothing
					continue;
				}
				const access = getLandAccess(gameState, ent);
				const endPos = plan.destinationOf(ent);
				ent.setMetadata(PlayerID, "transport", undefined);
				ent.setMetadata(PlayerID, "onBoard", undefined);
				ent.setMetadata(PlayerID, "endPos", undefined);
				// nothing else to do if access = endIndex as already at destination
				// otherwise, we should require another transport
				// TODO if attacking and no more ships available, remove the units from the attack
				// to avoid delaying it too much
				if (access !== endIndex)
				{
					this.requireTransport(gameState, ent, access, endIndex, endPos);
				}
			}
		}
	}

	getPlan(ID: TransportPlanId | undefined): TransportPlan | undefined
	{
		for (const plan of this.transportPlans)
		{
			if (plan.ID === ID)
			{
				return plan;
			}
		}
		return undefined;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	addPlan(plan: TransportPlan): void
	{
		this.transportPlans.push(plan);
	}

	/**
	 * complete already existing plan or create a new one for this requirement
	 * (many units can then call this separately and end up in the same plan)
	 * TODO  check garrison classes
	 */
	requireTransport(
		gameState: CommonGameState,
		ent: CommonEntity,
		startIndex: AccessIndex,
		endIndex: AccessIndex,
		endPos: CommonPosition,
	): boolean
	{
		if (!ent.canGarrison())
		{
			return false;
		}

		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			debugWarn(
				this.Config,
				0,
				() => "Petra naval manager error: unit " + ent.id() + " has already required a transport",
			);
			return false;
		}

		const plans: TransportPlan[] = [];
		for (const plan of this.transportPlans)
		{
			if (plan.startIndex !== startIndex || plan.endIndex !== endIndex || plan.state !== TransportPlan.BOARDING)
			{
				continue;
			}
			// Limit the number of siege units per transport to avoid problems when ungarrisoning
			if (isSiegeUnit(ent) && plan.units.filter((unit) => isSiegeUnit(unit)).length > 3)
			{
				continue;
			}
			plans.push(plan);
		}

		if (plans.length)
		{
			// join the plan with the fewest units
			plans.sort((a: TransportPlan, b: TransportPlan): number => a.units.length - b.units.length);
			plans[0].addUnit(ent, endPos);
			return true;
		}

		const plan = TransportPlan.create(gameState, [ent], { startIndex, endIndex, endPos });
		if (!plan)
		{
			debugWarn(this.Config, 1, () => ">>>> transport plan aborted <<<<");
			return false;
		}
		this.transportPlans.push(plan);
		return true;
	}

	/** split a transport plan in two, moving all entities not yet affected to a ship in the new plan */
	splitTransport(gameState: CommonGameState, plan: TransportPlan, needSplit: CommonEntity[]): boolean
	{
		debugWarn(this.Config, 1, () => ">>>> split of transport plan started <<<<");
		const newplan = TransportPlan.create(gameState, [], plan);
		if (!newplan)
		{
			debugWarn(this.Config, 1, () => ">>>> split of transport plan aborted <<<<");
			return false;
		}

		for (const ent of needSplit)
		{
			if (ent.getMetadata(PlayerID, "onBoard"))
			{ // Should never happen.
				continue;
			}
			newplan.addUnit(ent, plan.destinationOf(ent));
			plan.units.updateEnt(ent);
		}

		if (newplan.units.length)
		{
			this.transportPlans.push(newplan);
		}
		return newplan.units.length !== 0;
	}

	/**
	 * create a transport from a garrisoned ship to a land location
	 * needed at start game when starting with a garrisoned ship
	 */
	createTransportIfNeeded(
		gameState: CommonGameState,
		fromPos: CommonPosition,
		toPos: CommonPosition,
		toAccess: AccessIndex,
	): void
	{
		const fromAccess = gameState.ai.accessibility.getAccessValue(fromPos);
		if (fromAccess !== 1)
		{
			return;
		}
		if (toAccess < 2)
		{
			return;
		}

		for (const ship of this.ships.values())
		{
			if (!ship.isGarrisonHolder() || !ship.garrisoned().length)
			{
				continue;
			}
			if (ship.getMetadata(PlayerID, "transporter") !== undefined)
			{
				continue;
			}
			const units = ship.garrisoned().map((entId: EntityId): CommonEntity =>
				requireValue(gameState.getEntityById(entId))
			);
			// TODO check that the garrisoned units have not another purpose
			const plan = TransportPlan.create(gameState, units, {
				startIndex: fromAccess,
				endIndex: toAccess,
				endPos: toPos,
			}, ship);
			if (!plan)
			{
				continue;
			}
			this.transportPlans.push(plan);
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

		for (const plan of this.transportPlans)
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
		const waiting = this.transportPlans.some((plan) => plan.needTransportShips && plan.units.length > 0) ||
			[...plansIn(gameState.ai.HQ.attackManager.upcomingAttacks)].some((plan) =>
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
		if (!gameState.ai.HQ.navalMap)
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

	/** assigns free ships to plans that need some */
	assignShipsToPlans(gameState: CommonGameState): void
	{
		for (const plan of this.transportPlans)
		{
			if (plan.needTransportShips)
			{
				plan.assignShip(gameState);
			}
		}
	}

	/** Return true if this ship is likeky (un)garrisoning units */
	isShipBoarding(ship: CommonEntity): boolean
	{
		if (!isPlaced(ship))
		{
			return false;
		}
		const plan = this.getPlan(ship.getMetadata(PlayerID, "transporter"));
		const bp = plan?.shipPoints()[ship.id()];
		if (!plan || !bp)
		{
			return false;
		}
		return SquareVectorDistance(bp, ship.position()) < plan.boardingRange;
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
			if (ship.getMetadata(PlayerID, "transporter") !== undefined && this.isShipBoarding(ship))
			{
				continue;
			}

			const transporter = ship.getMetadata(PlayerID, "transporter");
			if (transporter !== undefined || approachesSupply(ship))
			{
				// a ship its transport sails by a route is left to it: its plan
				// judges it stuck by its headway, and a nudge here threw its route
				// away, the plan sending it again (FINDINGS §45)
				if (transporter === undefined || !this.getPlan(transporter)?.routes[ship.id()])
				{
					nudgeIfBlocked(ship, shipPosition);
				}
			}
			else if (ship.isIdle())
			{
				moveIdleShipApart(gameState, ship, shipPosition);
			}
		}

		for (const ship of tradingShips(gameState))
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

		for (const blockingShip of tradingShips(gameState))
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
		if (!gameState.ai.HQ.geography.navalMap || !gameState.ai.HQ.basesManager.hasPotentialBase())
		{
			return;
		}

		if (
			gameState.ai.HQ.getAccountedPopulation(gameState) > this.Config.Economy.popForDock &&
			queues.dock.countQueuedUnitsWithClass("Dock") === 0 &&
			!gameState.getOwnStructures().filter(filters.and(filters.byClass("Dock"), filters.isFoundation()))
				.hasEntities() &&
			gameState.ai.HQ.canBuild(gameState, "structures/{civ}/dock")
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
			gameState.ai.HQ.getAccountedPopulation(gameState) < this.Config.Economy.popPhase2 + 15 ||
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
			gameState.ai.HQ.canBuild(gameState, "structures/{civ}/market")
		)
		{
			return;
		}
		let template;
		if (gameState.ai.HQ.canBuild(gameState, "structures/{civ}/super_dock"))
		{
			template = "structures/{civ}/super_dock";
		}
		else if (gameState.ai.HQ.canBuild(gameState, "structures/{civ}/shipyard"))
		{
			template = "structures/{civ}/shipyard";
		}
		else
		{
			return;
		}
		const wantedLand: Record<number, boolean> = {};
		for (const base of gameState.ai.HQ.basesManager.baseManagers)
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
		for (const base of gameState.ai.HQ.basesManager.baseManagers)
		{
			if (!base.anchor || base.constructing)
			{
				continue;
			}
			// set with the anchor
			const baseAccessIndex = requireValue(base.accessIndex);
			const sea = this.getUnconnectedSeas(gameState, baseAccessIndex).find((s) =>
				gameState.ai.HQ.geography.navalRegions[s]
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

		// close previous transport plans if finished
		for (let i = 0; i < this.transportPlans.length; ++i)
		{
			const remaining = this.transportPlans[i].update(gameState);
			if (remaining)
			{
				continue;
			}
			debugWarn(this.Config, 1, () => "no more units on transport plan " + this.transportPlans[i].ID);
			this.transportPlans[i].releaseAll();
			this.transportPlans.splice(i--, 1);
		}
		// assign free ships to plans which need them
		this.assignShipsToPlans(gameState);

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
			landingZones: Record<number, Record<number, Set<number>>>;
		};
		transports: Record<string, ReturnType<TransportPlan["Serialize"]>>;
	}
	{
		const properties = {
			wantedTransportShips: this.wantedTransportShips,
			wantedWarShips: this.wantedWarShips,
			wantedFishShips: this.wantedFishShips,
			neededTransportShips: this.neededTransportShips,
			neededWarShips: this.neededWarShips,
			landingZones: this.landingZones,
		};

		const transports: Record<string, ReturnType<TransportPlan["Serialize"]>> = {};
		// keyed by the plan's place in the list, as the save always was
		this.transportPlans.forEach((plan, i) =>
		{
			transports[i] = plan.Serialize();
		});

		return { properties: properties, transports: transports };
	}

	private resume(gameState: CommonGameState, data: ReturnType<NavalManager["Serialize"]>): void
	{
		this.wantedTransportShips = data.properties.wantedTransportShips;
		this.wantedWarShips = data.properties.wantedWarShips;
		this.wantedFishShips = data.properties.wantedFishShips;
		this.neededTransportShips = data.properties.neededTransportShips;
		this.neededWarShips = data.properties.neededWarShips;
		this.landingZones = data.properties.landingZones;

		this.transportPlans = [];
		for (const i in data.transports)
		{
			const dataPlan = data.transports[i];
			// a saved plan whose sea has no fleet (a sea too small to sail) is left
			const plan = TransportPlan.restore(gameState, this, dataPlan);
			if (plan)
			{
				this.transportPlans.push(plan);
			}
		}
	}
}
