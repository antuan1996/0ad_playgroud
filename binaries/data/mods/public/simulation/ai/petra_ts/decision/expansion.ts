/**
 * Expansion (moved out of decision/headquarters.ts): when to found a new base and where, a new town for a land
 * run dry, and the civic centres ordered at a spot.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { NEW_BASE } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import type { Headquarters, HeadquartersQueues } from "./headquarters.ts";
import { buildFirstBase } from "./startingStrategy.ts";

/** Checks the status of the territory expansion. If no new economic bases created, build some strategic ones. */
export function checkBaseExpansion(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (queues.civilCentre.hasQueuedUnits())
	{
		return;
	}
	// First build one cc if all have been destroyed
	if (!hq.basesManager.hasPotentialBase())
	{
		buildFirstBase(hq, gameState);
		return;
	}
	// Then expand if we have not enough room available for buildings
	if (hq.buildManager.numberMissingRoom(gameState) > 1)
	{
		debugWarn(hq.Config, 2, () => "try to build a new base because not enough room to build ");
		// on a naval map, for its room: any free land will do (FINDINGS §40)
		buildNewBase(hq, gameState, queues, undefined, hq.geography.navalMap);
		return;
	}
	// If we've already planned to phase up, wait a bit before trying to expand
	if (hq.phasing)
	{
		return;
	}
	// Finally expand if we have lots of units (threshold depending on the aggressivity value)
	const activeBases = hq.basesManager.numActiveBases();
	const numUnits = gameState.getOwnUnits().length;
	const numvar = 10 * (1 - hq.Config.personality.aggressive);
	if (numUnits > activeBases * (65 + numvar + (10 + numvar) * (activeBases - 1)) || hq.saveResources && numUnits > 50)
	{
		debugWarn(
			hq.Config,
			2,
			() => "try to build a new base because of population " + numUnits + " for " + activeBases + " CCs",
		);
		buildNewBase(hq, gameState, queues);
	}
}

export function buildNewBase(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	resource?: string,
	forRoom = false,
): boolean
{
	const phaseName2 = gameState.getPhaseName(2);
	if (
		hq.basesManager.hasPotentialBase() && hq.currentPhase === 1 &&
		(phaseName2 === undefined || !gameState.isResearching(phaseName2))
	)
	{
		return false;
	}
	if (
		gameState.getOwnFoundations().filter(filters.byClass("CivCentre")).hasEntities() ||
		queues.civilCentre.hasQueuedUnits()
	)
	{
		return false;
	}

	const template = newBaseTemplate(hq, gameState);
	if (template === undefined)
	{
		return false;
	}

	// base "-1" means new base.
	debugWarn(hq.Config, 1, () => "new base " + gameState.applyCiv(template) + " planned with resource " + resource);
	queues.civilCentre.addPlan(
		new ConstructionPlan(
			gameState,
			template,
			forRoom ? { base: NEW_BASE, room: true } : { base: NEW_BASE, resource: resource },
		),
	);
	return true;
}

/**
 * A military colony once we have a civic centre of our own civ (it may allow specific units or techs), else a
 * civic centre, else a colony; undefined when we can build none
 */
function newBaseTemplate(hq: Headquarters, gameState: CommonGameState): string | undefined
{
	let hasOwnCC = false;
	for (const ent of gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")).values())
	{
		if (ent.owner() !== PlayerID || ent.templateName() !== gameState.applyCiv("structures/{civ}/civil_centre"))
		{
			continue;
		}
		hasOwnCC = true;
		break;
	}
	if (hasOwnCC && hq.canBuild(gameState, "structures/{civ}/military_colony"))
	{
		return "structures/{civ}/military_colony";
	}
	if (hq.canBuild(gameState, "structures/{civ}/civil_centre"))
	{
		return "structures/{civ}/civil_centre";
	}
	if (!hasOwnCC && hq.canBuild(gameState, "structures/{civ}/military_colony"))
	{
		return "structures/{civ}/military_colony";
	}
	return undefined;
}

/**
 * When the land has run dry (landRunDry): the field limit of a small
 * starting island lifted, as a market or a new base lifts it (with nothing
 * left to gather, every field's room is worth taking; the fishing boats
 * follow the fish left, NavalManager.fishByWhatIsLeft). In a 4-player Dodecanese
 * match a town kept its 2 fields for 50 minutes after its islands ran
 * dry, its workers idle, holding 6000 wood (FINDINGS §40). And its
 * civic centre's queue raised while one is queued.
 */
export function provideForDryLand(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	const queueManager = gameState.ai.queueManager;
	const dry = hq.landRunDry(gameState);
	// a new base is a dry or full town's way out: its civic centre goes just
	// above the training queues, where Petra left it at 1, paid only once
	// every other queue was (FINDINGS §40: one waited from minute 31 to the end)
	const wanted = dry || hq.geography.navalMap && hq.buildManager.numberMissingRoom(gameState) > 1;
	const ccPriority = wanted && queues.civilCentre.hasQueuedUnits() ?
		Math.max(hq.Config.priorities.villager, hq.Config.priorities.citizenSoldier) + 2 :
		hq.Config.priorities.civilCentre;
	if (queueManager.getPriority("civilCentre") !== ccPriority)
	{
		queueManager.changePriority("civilCentre", ccPriority);
	}
	if (dry)
	{
		hq.maxFields = false;
	}
}

/**
 * Follows the civic centres ordered: one whose foundation did not appear
 * within CC_ORDER_WAIT seconds (the spot taken, by another player's
 * foundation most often), or whose foundation was lost before it was
 * built, has its spot avoided for CC_SPOT_MEMORY seconds. Petra ordered
 * the same spot again and again: in a 4-player Dodecanese match three
 * players went for the same spot of the same neutral island, one ordering
 * it 6 times in a minute (FINDINGS §39).
 */
export function followCivCentreOrders(hq: Headquarters, gameState: CommonGameState): void
{
	const now = gameState.ai.elapsedTime;
	hq.ccSpotsAvoided = hq.ccSpotsAvoided.filter((spot) => spot.until > now);
	if (!hq.ccOrders.length)
	{
		return;
	}
	const centres = gameState.getOwnStructures().filter(filters.byClass("CivCentre")).toEntityArray();
	hq.ccOrders = hq.ccOrders.filter((order) =>
	{
		const centre = centres.find((ent) =>
		{
			const pos = ent.position();
			return !!pos && SquareVectorDistance(pos, order.pos) < 40 * 40;
		});
		if (centre)
		{
			if (centre.foundationProgress() === undefined)
			{
				return false;
			}
			order.seen = true;
			return true;
		}
		if (!order.seen && now - order.time < CC_ORDER_WAIT)
		{
			return true;
		}
		hq.ccSpotsAvoided.push({ pos: order.pos, until: now + CC_SPOT_MEMORY });
		return false;
	});
}

/** Seconds a civic centre's foundation may take to appear once ordered (followCivCentreOrders). */
export const CC_ORDER_WAIT = 20;

/** Seconds a civic centre spot that failed, or whose foundation was lost, is avoided. */
export const CC_SPOT_MEMORY = 600;
