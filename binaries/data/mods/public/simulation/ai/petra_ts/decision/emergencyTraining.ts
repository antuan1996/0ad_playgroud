/**
 * The emergency training (HQ.emergencyTraining): when an enemy army comes, citizen infantry trained at once, with
 * the highest priority, in the civic centre nearest it that trains and is not busy, and garrisoned there when its
 * garrison has room (ranged or melee by chance then, those adding arrows). The bases and the defense call it;
 * it reads the headquarters' bases and garrisons through EmergencyHQ.
 */
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { GarrisonManager } from "../execution/garrisonManager.ts";
import { type PlanMetadata } from "../execution/queueplan.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { PLAN_RESERVE } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
import type { BasesManager } from "./basesManager.ts";

/** What the emergency training asks of the headquarters: its bases' anchors, and the room in their garrisons */
type EmergencyHQ = {
	readonly basesManager: Pick<BasesManager, "baseManagers">;
	readonly town: { readonly garrisons: Pick<GarrisonManager, "numberOfGarrisonedSlots">; };
};

/** Whether a building trains for over 5 s what has started or garrisons there */
function busyTraining(anchor: CommonEntity): boolean
{
	const queue = anchor.trainingQueue();
	if (!queue)
	{
		return false;
	}
	let time = 0;
	for (const item of queue)
	{
		if (item.progress > 0 || item.metadata && item.metadata.garrisonType)
		{
			time += item.timeRemaining;
		}
	}
	return time / 1000 > 5;
}

/**
 * The citizen infantry the anchor trains for an emergency, one that adds arrows when it garrisons and that we can
 * afford: ranged if wanted, else the last found
 */
function emergencyTemplate(
	gameState: CommonGameState,
	nearestAnchor: CommonEntity,
	civ: string,
	autogarrison: boolean,
	rangedWanted: boolean,
): [string, CommonTemplate] | undefined
{
	const total = gameState.getResources();
	let templateFound: [string, CommonTemplate] | undefined;
	const trainables = nearestAnchor.trainableEntities(civ);
	const garrisonArrowClasses = nearestAnchor.getGarrisonArrowClasses();
	for (const trainable of (trainables ?? []))
	{
		if (gameState.isTemplateDisabled(trainable))
		{
			continue;
		}
		const template = gameState.getTemplate(trainable);
		if (!template || !template.hasClasses(["Infantry+CitizenSoldier"]))
		{
			continue;
		}
		if (autogarrison && !template.hasClasses(garrisonArrowClasses))
		{
			continue;
		}
		if (!total.canAfford(new ResourcesManager(template.cost())))
		{
			continue;
		}
		templateFound = [trainable, template];
		if (template.hasClass("Ranged") === rangedWanted)
		{
			break;
		}
	}
	return templateFound;
}

export class EmergencyTraining
{
	private readonly hq: EmergencyHQ;

	constructor(hq: EmergencyHQ)
	{
		this.hq = hq;
	}

	/**
	 * train with highest priority ranged infantry in the nearest civil center from a given set of positions
	 * and garrison them there for defense
	 */
	trainEmergencyUnits(gameState: CommonGameState, positions: CommonPosition[]): boolean
	{
		if (gameState.ai.queues.emergency.hasQueuedUnits())
		{
			return false;
		}

		const civ = gameState.getPlayerCiv();
		// find nearest base anchor
		const distcut = 20000;
		const { nearestAnchor, distmin } = this.nearestFreeAnchor(gameState, positions, civ);
		if (!nearestAnchor || distmin > distcut)
		{
			return false;
		}

		// We will choose randomly ranged and melee units, except when garrisonHolder is full
		// in which case we prefer melee units
		const autogarrison = this.makeRoomToGarrison(nearestAnchor);
		const rangedWanted = randBool() && autogarrison;

		const templateFound = emergencyTemplate(gameState, nearestAnchor, civ, autogarrison, rangedWanted);
		if (!templateFound)
		{
			return false;
		}

		// Check first if we can afford it without touching the other accounts
		// and if not, take some of other accounted resources
		// TODO sort the queues to be substracted
		gameState.ai.queueManager.fund(gameState, new ResourcesManager(templateFound[1].cost()), "emergency");
		const metadata: PlanMetadata = {
			role: Worker.ROLE_WORKER,
			base: nearestAnchor.getMetadata(PlayerID, "base"),
			plan: PLAN_RESERVE,
			trainer: nearestAnchor.id(),
		};
		if (autogarrison)
		{
			metadata.garrisonType = GarrisonManager.TYPE_PROTECTION;
		}
		gameState.ai.queues.emergency.addPlan(new TrainingPlan(gameState, templateFound[0], metadata, 1, 1));
		return true;
	}

	/** The base anchor nearest one of the positions on its land that trains and is not busy for long, and its square distance */
	private nearestFreeAnchor(
		gameState: CommonGameState,
		positions: CommonPosition[],
		civ: string,
	): { nearestAnchor: CommonEntity | undefined; distmin: number; }
	{
		let nearestAnchor: CommonEntity | undefined;
		let distmin = Infinity;
		for (const pos of positions)
		{
			const access = gameState.ai.accessibility.getAccessValue(pos);
			// check nearest base anchor
			for (const base of this.hq.basesManager.baseManagers)
			{
				if (!base.anchor)
				{
					continue;
				}
				if (getLandAccess(gameState, base.anchor) !== access)
				{
					continue;
				}
				if (!base.anchor.trainableEntities(civ))
				{ // base still in construction
					continue;
				}
				if (busyTraining(base.anchor))
				{
					continue;
				}
				const dist = SquareVectorDistance(base.anchor.position(), pos);
				if (nearestAnchor && dist > distmin)
				{
					continue;
				}
				distmin = dist;
				nearestAnchor = base.anchor;
			}
		}
		return { nearestAnchor, distmin };
	}

	/**
	 * The anchor's training queue keeps only what garrisons there and what has started; whether its garrison
	 * still has room (and it is sound enough) for the emergency unit to garrison
	 */
	private makeRoomToGarrison(nearestAnchor: CommonEntity): boolean
	{
		let numGarrisoned = this.hq.town.garrisons.numberOfGarrisonedSlots(nearestAnchor);
		const anchorQueue = nearestAnchor.trainingQueue();
		if (anchorQueue)
		{
			for (const item of anchorQueue)
			{
				// only unit batches are trained with a garrisonType metadata (Petra never
				// attaches it to research), so the unit-only `count` field is present.
				if (item.metadata && item.metadata.garrisonType)
				{
					numGarrisoned += item.count;
				}
				else if (!item.progress && (!item.metadata || !item.metadata.trainer))
				{
					nearestAnchor.stopProduction(item.id);
				}
			}
		}
		return numGarrisoned < nearestAnchor.garrisonMax() &&
			nearestAnchor.hitpoints() > nearestAnchor.garrisonEjectHealth() * nearestAnchor.maxHitpoints();
	}
}
