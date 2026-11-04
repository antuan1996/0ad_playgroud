import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { AttackPlan } from "../execution/attackPlan.ts";
import { getAttackBonus, getBestBase, getLandAccess, returnResources, requireValue } from
	"../adapter/entityExtend.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "./config.ts";
import { NO_BASE, seconds } from "../adapter/brands.ts";
import { PLAN_LENT_FROM_PLAN, PLAN_RESERVE, isLent } from "../execution/unitPlan.ts";
import { isPlaced } from "../adapter/placed.ts";

/**
 * Handle events that are important to specific victory conditions:
 *   in capture_the_relic, capture gaia relics and train military guards.
 *   in regicide, train healer and military guards for the hero.
 *   in wonder, train military guards.
 */

type CriticalEntState = {
	guardsAssigned: Set<EntityId>;
	healersAssigned?: Set<EntityId>;
	guards: Map<EntityId, string>;
	garrisonEmergency?: boolean;
};

export type SerializedVictoryManager = {
	criticalEnts: Map<EntityId, CriticalEntState>;
	guardEnts: Map<EntityId, boolean>;
	healersPerCriticalEnt: number;
	tryCaptureGaiaRelic: boolean;
	tryCaptureGaiaRelicLapseTime: GameSeconds;
	targetedGaiaRelics: Map<EntityId, AttackPlanId[]>;
};

/** capture with the capture strength of the units against the relic added */
function addCaptureStrength(capture: number, units: CommonEntityCollection, relic: CommonEntity): number
{
	for (const ent of units.values())
	{
		const captureStrength = ent.captureStrength();
		if (captureStrength)
			capture += captureStrength * getAttackBonus(ent, relic, "Capture");
	}
	return capture;
}

/** Whether a unit of ours may join a raid on the relic: free, on its land, in no plan but one still preparing. */
function mayRaidRelic(gameState: CommonGameState, ent: CommonEntity, relic: CommonEntity, access: AccessIndex): boolean
{
	if (!isPlaced(ent) || !ent.canCapture(relic))
		return false;
	if (ent.getMetadata(PlayerID, "transport") !== undefined)
		return false;
	if (ent.getMetadata(PlayerID, "PartOfArmy") !== undefined)
		return false;
	const plan = ent.getMetadata(PlayerID, "plan");
	if (isLent(plan))
		return false;
	if (plan !== undefined && plan >= 0)
	{
		const attack = gameState.ai.HQ.attackManager.getPlan(plan);
		if (attack && (attack.state !== AttackPlan.STATE_UNEXECUTED ||
			attack.type === AttackPlan.TYPE_RAID))
		{
			return false;
		}
	}
	return getLandAccess(gameState, ent) === access;
}

/** Whether one of our units sees the position */
function seenByUs(gameState: CommonGameState, position: CommonPosition): boolean
{
	for (const ent of gameState.getOwnUnits().values())
	{
		if (!isPlaced(ent) || !ent.visionRange())
			continue;
		if (SquareVectorDistance(ent.position(), position) > Math.square(ent.visionRange()))
			continue;
		return true;
	}
	return false;
}

/** Whether a role is a critical entity's healer's or guard's */
function isGuardRole(role: WorkerRole | undefined): boolean
{
	return role === Worker.ROLE_CRITICAL_ENT_HEALER || role === Worker.ROLE_CRITICAL_ENT_GUARD;
}

/** Let's get a few units from other bases to build the wonder. */
function sendWonderBuilders(gameState: CommonGameState, ent: CommonEntity): void
{
	const baseID = ent.getMetadata(PlayerID, "base");
	const base = baseID === undefined ? undefined : gameState.ai.HQ.getBaseByID(baseID);
	if (!base)
		return;
	const builders = gameState.ai.HQ.bulkPickWorkers(gameState, base, 10);
	if (builders)
		for (const worker of builders.values())
		{
			worker.setMetadata(PlayerID, "base", base.ID);
			worker.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
			worker.setMetadata(PlayerID, "target-foundation", ent.id());
		}
}

/** A wounded critical entity stops and leaves its attack plan and its defense army. */
function withdrawFromFight(gameState: CommonGameState, target: CommonPlacedEntity, plan: UnitPlan | undefined): void
{
	target.stopMoving();

	if (plan !== undefined && plan >= 0)
	{
		const attackPlan = gameState.ai.HQ.attackManager.getPlan(plan);
		if (attackPlan)
			attackPlan.removeUnit(target, true);
	}

	const partOfArmy = target.getMetadata(PlayerID, "PartOfArmy");
	if (partOfArmy)
	{
		const army = gameState.ai.HQ.defenseManager.getArmy(partOfArmy);
		if (army)
			army.removeOwn(gameState, target.id());
	}
}

/**
 * Move the current guards to the garrison location.
 * TODO: try to garrison them with the critical ent.
 */
function guardsFollow(gameState: CommonGameState, hero: CriticalEntState, holderEnt: CommonEntity): void
{
	for (const guardId of hero.guards.keys())
	{
		const guardEnt = gameState.getEntityById(guardId);
		if (!guardEnt)
			continue;

		const plan = guardEnt.getMetadata(PlayerID, "plan");

		// Current military guards (with Soldier class) will have been assigned plan metadata, but healer guards
		// are not assigned a plan, and so they could be already moving to garrison somewhere due to low health.
		if (!guardEnt.hasClass("Soldier") && isLent(plan))
			continue;

		const pos = holderEnt.position();
		// garrison holders always have an obstruction
		const obstructionRadius = requireValue(holderEnt.obstructionRadius());
		if (pos)
			guardEnt.moveToRange(pos[0], pos[1], obstructionRadius.max, obstructionRadius.max + 5);
	}
}

export class VictoryManager
{
	Config: Config;
	criticalEnts: Map<EntityId, CriticalEntState>;
	guardEnts: Map<EntityId, boolean>;
	healersPerCriticalEnt: number;
	/** Gaia relics we are after, each with the attack plans raiding it; changed only here. */
	private targetedGaiaRelics: Map<EntityId, AttackPlanId[]>;
	tryCaptureGaiaRelic: boolean;
	tryCaptureGaiaRelicLapseTime: GameSeconds;

	constructor(Config: Config)
	{
		this.Config = Config;
		this.criticalEnts = new Map();
		// Holds ids of all ents who are (or can be) guarding and if the ent is currently guarding
		this.guardEnts = new Map();
		this.healersPerCriticalEnt = 2 + Math.round(this.Config.personality.defensive * 2);
		this.tryCaptureGaiaRelic = false;
		this.tryCaptureGaiaRelicLapseTime = seconds(-1);
		// Gaia relics which we are targeting currently and have not captured yet
		this.targetedGaiaRelics = new Map();
	}

	/**
	 * Cache the ids of any inital victory-critical entities (on the first turn, when trigger scripts have spawned them).
	 */
	findCriticalEnts(gameState: CommonGameState): void
	{
		if (gameState.getVictoryConditions().has("wonder"))
		{
			for (const wonder of gameState.getOwnEntitiesByClass("Wonder", true).values())
				this.criticalEnts.set(wonder.id(), { "guardsAssigned": new Set(), "guards": new Map() });
		}

		if (gameState.getVictoryConditions().has("regicide"))
		{
			for (const hero of gameState.getOwnEntitiesByClass("Hero", true).values())
			{
				const defaultStance = hero.hasClass("Soldier") ? "aggressive" : "passive";
				if (hero.getStance() !== defaultStance)
					hero.setStance(defaultStance);
				this.criticalEnts.set(hero.id(), {
					"garrisonEmergency": false,
					"healersAssigned": new Set(),
					"guardsAssigned": new Set(), // for non-healer guards
					"guards": new Map() // ids of ents who are currently guarding this hero
				});
			}
		}

		if (gameState.getVictoryConditions().has("capture_the_relic"))
		{
			for (const relic of
				gameState.updatingGlobalCollection("allRelics", filters.byClass("Relic")).values())
			{
				if (relic.owner() === PlayerID)
					this.criticalEnts.set(relic.id(), { "guardsAssigned": new Set(), "guards": new Map() });
			}
		}
	}

	/** checkEvents: entities destroyed. */
	onDestroy(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.Destroy)
		{
			if (this.criticalEnts.has(evt.entity))
			{
				this.removeCriticalEnt(gameState, evt.entity);
				continue;
			}

			if (!this.guardEnts.delete(evt.entity))
				continue;

			for (const data of this.criticalEnts.values())
			{
				if (data.guards.delete(evt.entity))
				{
					data.healersAssigned?.delete(evt.entity);
					data.guardsAssigned.delete(evt.entity);
				}
			}
		}
	}

	/** checkEvents: units leaving a holder. */
	onUnGarrison(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.UnGarrison)
		{
			if (!this.guardEnts.has(evt.entity) && !this.criticalEnts.has(evt.entity))
				continue;

			const ent = gameState.getEntityById(evt.entity);
			if (!ent)
				continue;

			// If this ent travelled to a criticalEnt's accessValue, try again to assign as a guard
			if (isGuardRole(ent.getMetadata(PlayerID, "role")) && !this.guardEnts.get(evt.entity))
			{
				this.assignGuardToCriticalEnt(gameState, ent, ent.getMetadata(PlayerID, "guardedEnt"));
				continue;
			}

			if (!this.criticalEnts.has(evt.entity))
				continue;

			// If this is a hero, try to assign ents that should be guarding it, but couldn't previously
			const criticalEnt = this.criticalEnts.get(evt.entity);
			if (criticalEnt)
				this.assignIdleGuards(gameState, evt.entity, criticalEnt);
		}
	}

	/** The guards not guarding are sent to the critical entity, up to its number of healers */
	private assignIdleGuards(gameState: CommonGameState, criticalEntId: EntityId, criticalEnt: CriticalEntState): void
	{
		for (const [id, isGuarding] of this.guardEnts)
		{
			if (criticalEnt.guards.size >= this.healersPerCriticalEnt)
				break;

			if (!isGuarding)
			{
				const guardEnt = gameState.getEntityById(id);
				if (guardEnt)
					this.assignGuardToCriticalEnt(gameState, guardEnt, criticalEntId);
			}
		}
	}

	/** checkEvents: entities changing hands (captured, converted). */
	onOwnershipChanged(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.OwnershipChanged)
		{
			if (evt.from === PlayerID && this.criticalEnts.has(evt.entity))
			{
				this.removeCriticalEnt(gameState, evt.entity);
				continue;
			}
			if (evt.from === 0 && this.targetedGaiaRelics.has(evt.entity))
				this.abortCaptureGaiaRelic(gameState, evt.entity);

			if (evt.to !== PlayerID)
				continue;

			const ent = gameState.getEntityById(evt.entity);
			if (ent && (gameState.getVictoryConditions().has("wonder") && ent.hasClass("Wonder") ||
				      gameState.getVictoryConditions().has("capture_the_relic") && ent.hasClass("Relic")))
			{
				this.criticalEnts.set(ent.id(), { "guardsAssigned": new Set(), "guards": new Map() });
				// Move captured relics to the closest base
				if (ent.hasClass("Relic") && isPlaced(ent))
					this.pickCriticalEntRetreatLocation(gameState, ent, false);
			}
		}
	}

	/**
	 * In regicide victory condition, if the hero has less than 70% health, try to garrison it in a healing structure
	 * If it is less than 40%, try to garrison in the closest possible structure
	 * If the hero cannot garrison, retreat it to the closest base
	 */
	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		if (gameState.getVictoryConditions().has("wonder"))
			this.onWonderEvents(gameState, events);

		if (gameState.getVictoryConditions().has("regicide"))
		{
			this.onCriticalEntAttacked(gameState, events);

			for (const evt of events.TrainingFinished)
				for (const entId of evt.entities)
				{
					const ent = gameState.getEntityById(entId);
					if (ent && ent.isOwn(PlayerID) && ent.getMetadata(PlayerID, "role") === Worker.ROLE_CRITICAL_ENT_HEALER)
						this.assignGuardToCriticalEnt(gameState, ent);
				}

			this.onCriticalEntGarrisoned(gameState, events);
		}

		this.onEntityRenamed(gameState, events);

		// Check if new healers/guards need to be assigned to an ent
		this.onDestroy(gameState, events);

		this.onUnGarrison(gameState, events);

		this.onOwnershipChanged(gameState, events);
	}

	/** A wonder founded: builders from other bases; a wonder finished: guarded */
	onWonderEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.Create)
		{
			const ent = gameState.getEntityById(evt.entity);
			if (!ent || !ent.isOwn(PlayerID) || ent.foundationProgress() === undefined ||
				!ent.hasClass("Wonder"))
				continue;

			sendWonderBuilders(gameState, ent);
		}

		for (const evt of events.ConstructionFinished)
		{
			if (!evt || !evt.newentity)
				continue;

			const ent = gameState.getEntityById(evt.newentity);
			if (ent && ent.isOwn(PlayerID) && ent.hasClass("Wonder"))
				this.criticalEnts.set(ent.id(), { "guardsAssigned": new Set(), "guards": new Map() });
		}
	}

	/** A critical entity wounded: out of its plan or army, it retreats or garrisons */
	onCriticalEntAttacked(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.Attacked)
		{
			if (!this.criticalEnts.has(evt.target))
				continue;

			const target = gameState.getEntityById(evt.target);
			if (!target || !isPlaced(target) || target.healthLevel() > this.Config.garrisonHealthLevel.high)
				continue;

			const plan = target.getMetadata(PlayerID, "plan");
			const hero = this.criticalEnts.get(evt.target);
			if (!isLent(plan))
			{
				withdrawFromFight(gameState, target, plan);
				if (hero)
				{
					hero.garrisonEmergency = target.healthLevel() < this.Config.garrisonHealthLevel.low;
					this.pickCriticalEntRetreatLocation(gameState, target, hero.garrisonEmergency);
				}
			}
			else if (hero && target.healthLevel() < this.Config.garrisonHealthLevel.low && !hero.garrisonEmergency)
			{
				// the hero is severely wounded, try to retreat/garrison quicker
				gameState.ai.HQ.garrisonManager.cancelGarrison(target);
				this.pickCriticalEntRetreatLocation(gameState, target, true);
				hero.garrisonEmergency = true;
			}
		}
	}

	/** A critical entity garrisoned: its guards follow it, or leave it on a ship */
	onCriticalEntGarrisoned(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.Garrison)
		{
			if (!this.criticalEnts.has(evt.entity))
				continue;

			const hero = this.criticalEnts.get(evt.entity);
			if (!hero)
				continue;
			if (hero.garrisonEmergency)
				hero.garrisonEmergency = false;

			const holderEnt = gameState.getEntityById(evt.holder);
			if (!holderEnt)
				continue;

			if (holderEnt.hasClass("Ship"))
				this.dismissGuards(gameState, hero);
			else
				guardsFollow(gameState, hero, holderEnt);
		}
	}

	/** If the hero is garrisoned on a ship, remove its guards */
	private dismissGuards(gameState: CommonGameState, hero: CriticalEntState): void
	{
		for (const guardId of hero.guards.keys())
		{
			const guardEnt = gameState.getEntityById(guardId);
			if (!guardEnt)
				continue;

			guardEnt.removeGuard();
			this.guardEnts.set(guardId, false);
		}
		hero.guards.clear();
	}

	/** A guard renamed (promoted or upgraded) keeps its role */
	onEntityRenamed(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.EntityRenamed)
		{
			if (!this.guardEnts.has(evt.entity))
				continue;
			for (const data of this.criticalEnts.values())
			{
				if (!data.guards.has(evt.entity))
					continue;
				const guardRole = data.guards.get(evt.entity);
				if (guardRole !== undefined)
					data.guards.set(evt.newentity, guardRole);
				data.guards.delete(evt.entity);
				break;
			}
			const guarding = this.guardEnts.get(evt.entity);
			if (guarding !== undefined)
				this.guardEnts.set(evt.newentity, guarding);
			this.guardEnts.delete(evt.entity);
		}
	}

	removeCriticalEnt(gameState: CommonGameState, criticalEntId: EntityId): void
	{
		const criticalEnt = this.criticalEnts.get(criticalEntId);
		if (!criticalEnt)
			return;
		for (const [guardId, role] of criticalEnt.guards)
		{
			const guardEnt = gameState.getEntityById(guardId);
			if (!guardEnt)
				continue;

			if (role === "healer")
				this.guardEnts.set(guardId, false);
			else
			{
				guardEnt.setMetadata(PlayerID, "plan", PLAN_RESERVE);
				guardEnt.setMetadata(PlayerID, "role", undefined);
				this.guardEnts.delete(guardId);
			}

			if (guardEnt.getMetadata(PlayerID, "guardedEnt"))
				guardEnt.setMetadata(PlayerID, "guardedEnt", undefined);
		}
		this.criticalEnts.delete(criticalEntId);
	}

	/**
	 * Train more healers to be later affected to critical entities if needed
	 */
	manageCriticalEntHealers(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (gameState.ai.HQ.saveResources || queues.healer.hasQueuedUnits() ||
		    !gameState.getOwnEntitiesByClass("Temple", true).hasEntities() ||
		    this.guardEnts.size > Math.min(gameState.getPopulationMax() / 10, gameState.getPopulation() / 4))
			return;

		for (const data of this.criticalEnts.values())
		{
			if (data.healersAssigned === undefined)
				continue;
			if (data.healersAssigned.size >= this.healersPerCriticalEnt)
				continue;

			const template = gameState.applyCiv("units/{civ}/support_healer_b");
			queues.healer.addPlan(new TrainingPlan(gameState, template,
				{ "role": Worker.ROLE_CRITICAL_ENT_HEALER, "base": NO_BASE }, 1, 1));
			return;
		}
	}

	/**
	 * Try to keep some military units guarding any criticalEnts, if we can afford it.
	 * If we have too low a population and require units for other needs, remove guards so they can be reassigned.
	 * TODO: Swap citizen soldier guards with champions if they become available.
	 */
	manageCriticalEntGuards(gameState: CommonGameState): void
	{
		let numWorkers = gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length;
		if (numWorkers < 20)
			numWorkers = this.releaseCitizenGuards(gameState, numWorkers);

		for (const [id, data] of this.criticalEnts)
		{
			const criticalEnt = gameState.getEntityById(id);
			if (criticalEnt)
				numWorkers = this.recruitGuards(gameState, criticalEnt, data, numWorkers);
		}
	}

	/** Short of workers, citizen soldiers guarding go back to work until we have 20; returns the workers then. */
	private releaseCitizenGuards(gameState: CommonGameState, numWorkers: number): number
	{
		for (const data of this.criticalEnts.values())
		{
			for (const guardId of data.guards.keys())
			{
				const guardEnt = gameState.getEntityById(guardId);
				if (!guardEnt || !guardEnt.hasClass("CitizenSoldier") ||
				    guardEnt.getMetadata(PlayerID, "role") !== Worker.ROLE_CRITICAL_ENT_GUARD)
					continue;

				guardEnt.removeGuard();
				guardEnt.setMetadata(PlayerID, "plan", PLAN_RESERVE);
				guardEnt.setMetadata(PlayerID, "role", undefined);
				this.guardEnts.delete(guardId);
				data.guardsAssigned.add(guardId);

				if (guardEnt.getMetadata(PlayerID, "guardedEnt"))
					guardEnt.setMetadata(PlayerID, "guardedEnt", undefined);

				if (++numWorkers >= 20)
					break;
			}
			if (numWorkers >= 20)
				break;
		}
		return numWorkers;
	}

	/**
	 * Military guards for criticalEnt up to its number, champions first, then units out of any plan, then soldiers,
	 * those beside it first, while workers stay enough; returns the workers left.
	 */
	private recruitGuards(gameState: CommonGameState, criticalEnt: CommonEntity, data: CriticalEntState, numWorkers: number): number
	{
		const minWorkers = 25;
		const deltaWorkers = 3;
		const militaryGuardsPerCriticalEnt = (criticalEnt.hasClass("Wonder") ? 10 : 4) +
			Math.round(this.Config.personality.defensive * 5);

		if (data.guardsAssigned.size >= militaryGuardsPerCriticalEnt)
			return numWorkers;

		const guarded = (): boolean => data.guardsAssigned.size >= militaryGuardsPerCriticalEnt;
		const enough = (): boolean => guarded() || numWorkers <= minWorkers + deltaWorkers * data.guardsAssigned.size;
		/** assigns entities as guards; a worker taken counts down the workers */
		const recruit = (entities: CommonEntityCollection, checkForSameAccess: boolean, takesWorker: boolean): void =>
		{
			for (const entity of entities.values())
			{
				if (!this.tryAssignMilitaryGuard(gameState, entity, criticalEnt, checkForSameAccess))
					continue;
				if (takesWorker)
					--numWorkers;
				data.guardsAssigned.add(entity.id());
				if (takesWorker ? enough() : guarded())
					break;
			}
		};

		// First try to pick guards in the criticalEnt's accessIndex, to avoid unnecessary transports
		for (const checkForSameAccess of [true, false])
		{
			// First try to assign any Champion units we might have
			recruit(gameState.getOwnEntitiesByClass("Champion", true), checkForSameAccess, false);
			if (enough())
				break;
			recruit(gameState.ai.HQ.attackManager.outOfPlan, checkForSameAccess, true);
			if (enough())
				break;
			recruit(gameState.getOwnEntitiesByClass("Soldier", true), checkForSameAccess, true);
			if (enough())
				break;
		}
		return numWorkers;
	}

	tryAssignMilitaryGuard(gameState: CommonGameState, guardEnt: CommonEntity, criticalEnt: CommonEntity, checkForSameAccess: boolean): boolean
	{
		// a unit out of any plan (-1, the attack manager's reserve) may guard
		const plan = guardEnt.getMetadata(PlayerID, "plan");
		if (plan !== undefined && plan !== PLAN_RESERVE ||
		    guardEnt.getMetadata(PlayerID, "transport") !== undefined || this.criticalEnts.has(guardEnt.id()) ||
		    checkForSameAccess && (!isPlaced(guardEnt) || !isPlaced(criticalEnt) ||
		    getLandAccess(gameState, criticalEnt) !== getLandAccess(gameState, guardEnt)))
			return false;

		if (!this.assignGuardToCriticalEnt(gameState, guardEnt, criticalEnt.id()))
			return false;

		// lent as a guard; released, it goes to the reserve whatever it had
		guardEnt.setMetadata(PlayerID, "plan", PLAN_LENT_FROM_PLAN);
		guardEnt.setMetadata(PlayerID, "role", Worker.ROLE_CRITICAL_ENT_GUARD);
		return true;
	}

	pickCriticalEntRetreatLocation(gameState: CommonGameState, criticalEnt: CommonPlacedEntity, emergency: boolean): void
	{
		gameState.ai.HQ.defenseManager.garrisonAttackedUnit(gameState, criticalEnt, emergency);
		const plan = criticalEnt.getMetadata(PlayerID, "plan");

		if (isLent(plan))
			return;

		const critData = this.criticalEnts.get(criticalEnt.id());
		if (critData && critData.garrisonEmergency)
			critData.garrisonEmergency = false;

		// Couldn't find a place to garrison, so the ent will flee from attacks
		if (!criticalEnt.hasClass("Relic") && criticalEnt.getStance() !== "passive")
			criticalEnt.setStance("passive");
		const accessIndex = getLandAccess(gameState, criticalEnt);
		const bestBase = getBestBase(gameState, criticalEnt, true);
		if (bestBase && bestBase.accessIndex === accessIndex)
		{
			const bestBaseAnchor = bestBase.anchor;
			if (bestBaseAnchor)
			{
				const bestBasePos = bestBaseAnchor.position();
				// anchors always have an obstruction
				if (bestBasePos)
					criticalEnt.moveToRange(bestBasePos[0], bestBasePos[1],
						0, bestBaseAnchor.obstructionRadius().max);
			}
		}
	}

	/**
	 * Only send the guard command if the guard's accessIndex is the same as the critical ent
	 * and the critical ent has a position (i.e. not garrisoned).
	 * Request a transport if the accessIndex value is different, and if a transport is needed,
	 * the guardEnt will be given metadata describing which entity it is being sent to guard,
	 * which will be used once its transport has finished.
	 * Return false if the guardEnt is not a valid guard unit (i.e. cannot guard or is being transported).
	 */
	assignGuardToCriticalEnt(gameState: CommonGameState, guardEnt: CommonEntity, criticalEntId?: EntityId): boolean
	{
		if (guardEnt.getMetadata(PlayerID, "transport") !== undefined || !guardEnt.canGuard())
			return false;

		if (criticalEntId && !this.criticalEnts.has(criticalEntId))
		{
			criticalEntId = undefined;
			if (guardEnt.getMetadata(PlayerID, "guardedEnt"))
				guardEnt.setMetadata(PlayerID, "guardedEnt", undefined);
		}

		if (!criticalEntId)
			criticalEntId = this.leastGuarded(guardEnt);

		if (!criticalEntId)
		{
			if (guardEnt.getMetadata(PlayerID, "guardedEnt"))
				guardEnt.setMetadata(PlayerID, "guardedEnt", undefined);
			return false;
		}

		const criticalEnt = gameState.getEntityById(criticalEntId);
		if (!criticalEnt || !isPlaced(criticalEnt) || !isPlaced(guardEnt))
		{
			this.guardEnts.set(guardEnt.id(), false);
			return false;
		}

		if (guardEnt.getMetadata(PlayerID, "guardedEnt") !== criticalEntId)
			guardEnt.setMetadata(PlayerID, "guardedEnt", criticalEntId);

		this.sendGuard(gameState, guardEnt, criticalEnt);
		return true;
	}

	/** Assign to the critical ent with the fewest guards (healers for a healer); its id, or undefined */
	private leastGuarded(guardEnt: CommonEntity): EntityId | undefined
	{
		const isHealer = guardEnt.hasClass("Healer");
		let criticalEntId;
		let min = Math.min();
		for (const [id, data] of this.criticalEnts)
		{
			if (isHealer && (data.healersAssigned === undefined || data.healersAssigned.size > min))
				continue;
			if (!isHealer && data.guardsAssigned.size > min)
				continue;

			criticalEntId = id;
			const assignedSet = isHealer ? data.healersAssigned : data.guardsAssigned;
			if (assignedSet)
				min = assignedSet.size;
		}
		if (criticalEntId)
		{
			const data = this.criticalEnts.get(criticalEntId);
			const assignedSet = data ? (isHealer ? data.healersAssigned : data.guardsAssigned) : undefined;
			if (assignedSet)
				assignedSet.add(guardEnt.id());
		}
		return criticalEntId;
	}

	/** The guard guards the critical entity on its land, or asks for a ship to it. */
	private sendGuard(gameState: CommonGameState, guardEnt: CommonPlacedEntity, criticalEnt: CommonPlacedEntity): void
	{
		const criticalEntId = criticalEnt.id();
		const guardEntAccess = getLandAccess(gameState, guardEnt);
		const criticalEntAccess = getLandAccess(gameState, criticalEnt);
		if (guardEntAccess === criticalEntAccess)
		{
			const queued = returnResources(gameState, guardEnt);
			guardEnt.guard(criticalEnt, queued);
			const guardRole = guardEnt.getMetadata(PlayerID, "role") === Worker.ROLE_CRITICAL_ENT_HEALER ? "healer" : "guard";
			const critData = this.criticalEnts.get(criticalEntId);
			if (critData)
				critData.guards.set(guardEnt.id(), guardRole);

			// Switch this guard ent to the criticalEnt's base
			if (criticalEnt.hasClass("Structure") && criticalEnt.getMetadata(PlayerID, "base") !== undefined)
				guardEnt.setMetadata(PlayerID, "base", criticalEnt.getMetadata(PlayerID, "base"));
		}
		else
		{
			const criticalEntPos = criticalEnt.position();
			if (guardEntAccess !== undefined && criticalEntAccess !== undefined)
				gameState.ai.HQ.navalManager.requireTransport(gameState, guardEnt, guardEntAccess, criticalEntAccess, criticalEntPos);
		}

		this.guardEnts.set(guardEnt.id(), guardEntAccess === criticalEntAccess);
	}

	resetCaptureGaiaRelic(gameState: CommonGameState): void
	{
		// Do not capture gaia relics too frequently as the ai has access to the entire map
		this.tryCaptureGaiaRelicLapseTime = seconds(gameState.ai.elapsedTime + 240 - 30 * (this.Config.difficulty - 3));
		this.tryCaptureGaiaRelic = false;
	}

	update(gameState: CommonGameState, events: EngineAIEvents, queues: PetraRuntime.QueueCollection): void
	{
		// Wait a turn for trigger scripts to spawn any critical ents (i.e. in regicide)
		if (gameState.ai.playedTurn === 1)
			this.findCriticalEnts(gameState);

		this.checkEvents(gameState, events);

		if (gameState.ai.playedTurn % 10 !== 0 ||
		    !gameState.getVictoryConditions().has("wonder") && !gameState.getVictoryConditions().has("regicide") &&
		    !gameState.getVictoryConditions().has("capture_the_relic"))
			return;

		this.manageCriticalEntGuards(gameState);

		if (gameState.getVictoryConditions().has("wonder"))
			gameState.ai.HQ.buildWonder(gameState, queues, true);

		if (gameState.getVictoryConditions().has("regicide"))
		{
			for (const id of this.criticalEnts.keys())
			{
				const ent = gameState.getEntityById(id);
				if (ent && ent.healthLevel() > this.Config.garrisonHealthLevel.high && ent.hasClass("Soldier") &&
				    ent.getStance() !== "aggressive")
					ent.setStance("aggressive");
			}
			this.manageCriticalEntHealers(gameState, queues);
		}

		if (gameState.getVictoryConditions().has("capture_the_relic"))
			this.updateRelicRaids(gameState);
	}

	/** Capture the relic: the raids on gaia relics reinforced or aborted, and one more relic raided if seen. */
	private updateRelicRaids(gameState: CommonGameState): void
	{
		if (!this.tryCaptureGaiaRelic && gameState.ai.elapsedTime > this.tryCaptureGaiaRelicLapseTime)
			this.tryCaptureGaiaRelic = true;

		// Reinforce (if needed) any raid currently trying to capture a gaia relic
		for (const relicId of this.targetedGaiaRelics.keys())
		{
			const relic = gameState.getEntityById(relicId);
			if (!relic || relic.owner() !== 0)
				this.abortCaptureGaiaRelic(gameState, relicId);
			// a relic held in a structure waits there
			else if (isPlaced(relic))
				this.captureGaiaRelic(gameState, relic);
		}
		// And look for some new gaia relics visible by any of our units
		// or that may be on our territory
		const allGaiaRelics = gameState.updatingGlobalCollection("allRelics", filters.byClass("Relic"))
			.filter((relic) => relic.owner() === 0);
		for (const relic of allGaiaRelics.values())
		{
			if (!isPlaced(relic) || this.targetedGaiaRelics.has(relic.id()))
				continue;
			const relicPosition = relic.position();
			const territoryOwner = gameState.ai.HQ.geography.territoryMap.getOwner(relicPosition);
			if (territoryOwner === PlayerID)
			{
				this.targetedGaiaRelics.set(relic.id(), []);
				this.captureGaiaRelic(gameState, relic);
				break;
			}

			if (territoryOwner !== 0 && gameState.isPlayerEnemy(territoryOwner))
				continue;

			if (seenByUs(gameState, relicPosition))
			{
				this.targetedGaiaRelics.set(relic.id(), []);
				this.captureGaiaRelic(gameState, relic);
			}
		}
	}

	/**
	 * Send an expedition to capture a gaia relic, or reinforce an existing one.
	 */
	captureGaiaRelic(gameState: CommonGameState, relic: CommonPlacedEntity): void
	{
		let capture = -relic.defaultRegenRate();
		const relicCapturePoints = relic.capturePoints();
		const sumCapturePoints = relicCapturePoints ? relicCapturePoints.reduce((a: number, b: number): number => a + b) : 0;
		const plans = this.targetedGaiaRelics.get(relic.id()) ?? [];
		for (const plan of plans)
		{
			const attack = gameState.ai.HQ.attackManager.getPlan(plan);
			if (attack)
				capture = addCaptureStrength(capture, attack.unitCollection, relic);
		}
		// No need to make a new attack if already enough units
		if (capture > sumCapturePoints / 50)
			return;
		const relicPosition = relic.position();
		const access = getLandAccess(gameState, relic);
		const units = gameState.getOwnUnits().filter((ent) => mayRaidRelic(gameState, ent, relic, access))
			.filterNearest(relicPosition);
		const expedition = [];
		for (const ent of units.values())
		{
			const captureStrength = ent.captureStrength();
			if (captureStrength)
			capture += captureStrength * getAttackBonus(ent, relic, "Capture");
			expedition.push(ent);
			if (capture > sumCapturePoints / 25)
				break;
		}
		if (!expedition.length || !plans.length && capture < sumCapturePoints / 100)
			return;
		this.raidRelic(gameState, relic, expedition);
	}

	/** A raid on the relic with the expedition, rallied where its first unit stands, started at once */
	private raidRelic(gameState: CommonGameState, relic: CommonPlacedEntity, expedition: CommonEntity[]): void
	{
		const attack = gameState.ai.HQ.attackManager.raidTargetEntity(gameState, relic);
		if (!attack)
			return;
		const plan = attack.name;
		let rallyPoint: CommonPosition | undefined;
		for (const ent of expedition)
		{
			ent.setMetadata(PlayerID, "plan", plan);
			attack.unitCollection.updateEnt(ent);
			if (!rallyPoint)
			{
				const entPos = ent.position();
				if (entPos)
					rallyPoint = entPos;
			}
		}
		if (rallyPoint)
			attack.rallyPoint = rallyPoint;
		attack.forceStart();
		const relicPlans = this.targetedGaiaRelics.get(relic.id());
		if (relicPlans)
			relicPlans.push(plan);
	}

	/** Whether we are after this gaia relic already. */
	isRelicRaided(relicId: EntityId): boolean
	{
		return this.targetedGaiaRelics.has(relicId);
	}

	/** An attack plan that chose a gaia relic as its target raids it, alone. */
	planRelicRaid(relicId: EntityId, plan: AttackPlanId): void
	{
		this.targetedGaiaRelics.set(relicId, [plan]);
	}

	abortCaptureGaiaRelic(gameState: CommonGameState, relicId: EntityId): void
	{
		const relicPlans = this.targetedGaiaRelics.get(relicId) ?? [];
		for (const plan of relicPlans)
		{
			const attack = gameState.ai.HQ.attackManager.getPlan(plan);
			if (attack)
				attack.Abort(gameState);
		}
		this.targetedGaiaRelics.delete(relicId);
	}

	Serialize(): SerializedVictoryManager
	{
		return {
			"criticalEnts": this.criticalEnts,
			"guardEnts": this.guardEnts,
			"healersPerCriticalEnt": this.healersPerCriticalEnt,
			"tryCaptureGaiaRelic": this.tryCaptureGaiaRelic,
			"tryCaptureGaiaRelicLapseTime": this.tryCaptureGaiaRelicLapseTime,
			"targetedGaiaRelics": this.targetedGaiaRelics
		};
	}

	/** A saved victory manager: its critical entities, their guards and the relics it goes for */
	static restore(Config: Config, data: SerializedVictoryManager): VictoryManager
	{
		const manager = new VictoryManager(Config);
		manager.resume(data);
		return manager;
	}

	private resume(data: SerializedVictoryManager): void
	{
		// The fallbacks keep the value set by the constructor for fields absent in
		// savegames written by an older version
		this.criticalEnts = data.criticalEnts ?? new Map();
		this.guardEnts = data.guardEnts ?? new Map();
		this.healersPerCriticalEnt = data.healersPerCriticalEnt ??
			2 + Math.round(this.Config.personality.defensive * 2);
		this.tryCaptureGaiaRelic = data.tryCaptureGaiaRelic ?? false;
		this.tryCaptureGaiaRelicLapseTime = data.tryCaptureGaiaRelicLapseTime ?? -1;
		this.targetedGaiaRelics = data.targetedGaiaRelics ?? new Map();
	}
}
