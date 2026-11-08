/**
 * The headquarters' turn of events (moved out of decision/headquarters.ts): units trained (their role, base and
 * garrison), structures lost, captured or decaying, and new bases founded, as the turn's events report them.
 */
import { playerId } from "../adapter/brands.ts";
import { setSeaAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { PLAN_RESERVE } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import type { Headquarters, HeadquartersEvents } from "./headquarters.ts";
import { configFirstBase } from "./startingStrategy.ts";

export function checkEvents(hq: Headquarters, gameState: CommonGameState, events: HeadquartersEvents): void
{
	hq.buildManager.checkEvents(gameState, events);
	hq.updateTerritories(gameState);

	// Reset the entities collections which depend on diplomacy
	if (events.DiplomacyChanged.some((evt) => evt.player === PlayerID || evt.otherPlayer === PlayerID))
	{
		gameState.resetOnDiplomacyChanged();
	}

	hq.basesManager.checkEvents(gameState, events);

	// a market built lifts the fields' limit
	for (const evt of events.ConstructionFinished)
	{
		if (evt.newentity !== evt.entity && hq.economy.maxFields && isOwnMarket(gameState, evt.newentity))
		{ // not a repaired building
			hq.economy.maxFields = false;
		}
	}

	for (const evt of events.OwnershipChanged)
	{ // capture events
		if (evt.to === PlayerID)
		{
			onCaptured(hq, gameState, evt.entity);
		}
	}

	// deal with the different rally points of training units: the rally point is set when the training starts
	// for the time being, only autogarrison is used
	for (const evt of events.TrainingStarted)
	{
		setTrainingRallyPoint(gameState, evt.entity);
	}

	onTrainingFinished(hq, gameState, events);

	for (const evt of events.TerritoryDecayChanged)
	{
		onDecayChanged(hq, gameState, evt.entity, evt.to);
	}

	// Then deals with decaying structures: destroy them if being lost to enemy (except in easier difficulties)
	if (hq.Config.difficulty >= difficulty.EASY)
	{
		destroyLostStructures(hq, gameState, events);
	}
}

/** checkEvents: units trained. */
function onTrainingFinished(hq: Headquarters, gameState: CommonGameState, events: HeadquartersEvents): void
{
	for (const evt of events.TrainingFinished)
	{
		for (const entId of evt.entities)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent || !ent.isOwn(PlayerID))
			{
				continue;
			}

			if (!isPlaced(ent))
			{
				checkAutogarrison(hq, gameState, ent);
			}
			else if (ent.getMetadata(PlayerID, "garrisonType"))
			{
				// we were supposed to be autogarrisoned, but hq has failed (may-be full)
				ent.setMetadata(PlayerID, "garrisonType", undefined);
			}

			// Check if hq unit is no more needed in its attack plan
			// (happen when the training ends after the attack is started or aborted)
			const plan = ent.getMetadata(PlayerID, "plan");
			if (plan !== undefined && plan >= 0)
			{
				const attack = hq.attackManager.getPlan(plan);
				if (!attack || attack.state !== AttackPlan.STATE_UNEXECUTED)
				{
					ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
				}
			}
		}
	}
}

/**
 * we are autogarrisoned, check that the holder is registered in the garrisonManager.
 * The rally point garrisons a whole building's batches, set from the one
 * at the head of its queue as we last saw it: a unit not trained to
 * garrison (one of an attack, say) comes out again.
 */
function checkAutogarrison(hq: Headquarters, gameState: CommonGameState, ent: CommonEntity): void
{
	const holderID = ent.garrisonHolderID();
	const holder = holderID === undefined ? undefined : gameState.getEntityById(holderID);
	if (holder && !ent.getMetadata(PlayerID, "garrisonType"))
	{
		holder.unload(ent.id());
	}
	else if (holder)
	{
		hq.garrisonManager.registerHolder(gameState, holder);
	}
}

/** Our decaying structures being lost to an enemy are destroyed; those no more decaying (or gone) forgotten */
function destroyLostStructures(hq: Headquarters, gameState: CommonGameState, events: HeadquartersEvents): void
{
	for (const entId of hq.decayingStructures)
	{
		const ent = gameState.getEntityById(entId);
		if (ent && ent.decaying() && ent.isOwn(PlayerID))
		{
			if (!lostToEnemy(gameState, ent, events))
			{
				continue;
			}
			ent.destroy();
		}
		hq.decayingStructures.delete(entId);
	}
}

/** A building of ours starting or stopping to decay */
function onDecayChanged(hq: Headquarters, gameState: CommonGameState, entity: EntityId, decaying: boolean): void
{
	const ent = gameState.getEntityById(entity);
	if (!ent || !ent.isOwn(PlayerID) || ent.foundationProgress() !== undefined)
	{
		return;
	}
	if (decaying)
	{
		noteDecaying(hq, gameState, ent, false);
	}
	else if (ent.isGarrisonHolder())
	{
		hq.garrisonManager.removeDecayingStructure(entity);
	}
}

/** An entity we captured: a decaying structure is followed, a unit taken over */
function onCaptured(hq: Headquarters, gameState: CommonGameState, entity: EntityId): void
{
	const ent = gameState.getEntityById(entity);
	if (!ent)
	{
		return;
	}
	if (!ent.hasClass("Unit"))
	{
		if (ent.decaying())
		{
			noteDecaying(hq, gameState, ent, true);
		}
		return;
	}
	takeOverUnit(gameState, ent);
}

/** A structure of ours decaying: garrisoned against it if it may be (justCaptured too), else followed */
function noteDecaying(hq: Headquarters, gameState: CommonGameState, ent: CommonEntity, justCaptured: boolean): void
{
	if (
		ent.isGarrisonHolder() &&
		hq.garrisonManager.addDecayingStructure(gameState, ent.id(), justCaptured || undefined)
	)
	{
		return;
	}
	if (!hq.decayingStructures.has(ent.id()))
	{
		hq.decayingStructures.add(ent.id());
	}
}

export function handleNewBase(hq: Headquarters, gameState: CommonGameState): void
{
	if (!hq.economy.firstBaseConfig)
	{
		// This is our first base, let us configure our starting resources.
		configFirstBase(hq, gameState);
	}
	else
	{
		// Let us hope hq new base will fix our possible resource shortage.
		hq.economy.saveResources = undefined;
		hq.economy.saveSpace = undefined;
		hq.economy.maxFields = false;
	}
}

/** Whether an entity is a market of ours */
function isOwnMarket(gameState: CommonGameState, id: EntityId): boolean
{
	const ent = gameState.getEntityById(id);
	return !!ent && ent.owner() === PlayerID && !!ent.hasClass("Market");
}

/**
 * Whether a decaying structure of ours is being lost to an enemy: half its capture points or more still ours,
 * an enemy's among the others, and below a random ratio (higher when it is attacked)
 */
function lostToEnemy(gameState: CommonGameState, ent: CommonEntity, events: HeadquartersEvents): boolean
{
	const capture = ent.capturePoints();
	if (!capture)
	{
		return false;
	}
	const captureRatio = capture[PlayerID] / capture.reduce((a: number, b: number): number => a + b);
	if (captureRatio < 0.50)
	{
		return false;
	}
	let decayToGaia = true;
	for (let iIndex = 1; iIndex < capture.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (gameState.isPlayerAlly(i) || !capture[i])
		{
			continue;
		}
		decayToGaia = false;
		break;
	}
	if (decayToGaia)
	{
		return false;
	}
	let ratioMax = 0.7 + randFloat(0, 0.1);
	for (const evt of events.Attacked)
	{
		if (ent.id() !== evt.target)
		{
			continue;
		}
		ratioMax = 0.85 + randFloat(0, 0.1);
		break;
	}
	return !(captureRatio > ratioMax);
}

/** A building of ours starting to train: its trained units will autogarrison if its first batch is to */
function setTrainingRallyPoint(gameState: CommonGameState, entity: EntityId): void
{
	const ent = gameState.getEntityById(entity);
	if (!ent || !ent.isOwn(PlayerID))
	{
		return;
	}

	const trainingQueue = ent.trainingQueue();
	if (!trainingQueue || !trainingQueue.length)
	{
		return;
	}
	const metadata = trainingQueue[0].metadata;
	if (metadata && metadata.garrisonType)
	{
		ent.setRallyPoint(ent, "garrison"); // trained units will autogarrison
	}
	else
	{
		ent.unsetRallyPoint();
	}
}

/** A unit we captured: its old roles cleared, a trader, worker or soldier of ours */
function takeOverUnit(gameState: CommonGameState, ent: CommonEntity): void
{
	ent.setMetadata(PlayerID, "role", undefined);
	ent.setMetadata(PlayerID, "subrole", undefined);
	ent.setMetadata(PlayerID, "plan", undefined);
	ent.setMetadata(PlayerID, "PartOfArmy", undefined);
	if (ent.hasClass("Trader"))
	{
		ent.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
		ent.setMetadata(PlayerID, "route", undefined);
	}
	if (ent.hasClass("Worker") && ent.isGatherer())
	{
		ent.setMetadata(PlayerID, "role", Worker.ROLE_WORKER);
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
	}
	if (ent.hasClass("Ship"))
	{
		setSeaAccess(gameState, ent);
	}
	if (!ent.hasClasses(["Support", "Ship"]) && ent.attackTypes() !== undefined)
	{
		ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
	}
}
