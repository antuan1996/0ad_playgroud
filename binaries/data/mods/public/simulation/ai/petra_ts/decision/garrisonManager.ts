import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { dumpEntity, isSiegeUnit } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { hasActivity } from "../adapter/unitState.ts";
import { lentPlan, releasedPlan } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";

export type GarrisonHolderData = { list: EntityId[]; allowMelee: boolean; };
type GarrisonThreats = { defenseStructure: boolean; meleeSiege: boolean; rangeSiege: boolean; unit: boolean; };

/** The fields a save keeps. */
export type SerializedGarrisonManager = Pick<GarrisonManager, "holders" | "decayingStructures">;

/** Whether an enemy entity can threaten a holder: a structure that shoots, a unit, gaia's only while fighting. */
function mayThreaten(ent: CommonEntity): boolean
{
	if (ent.hasClass("Structure"))
	{
		return !!ent.attackRange("Ranged");
	}
	if (ent.hasClass("Unit"))
	{
		return ent.owner() !== 0 || hasActivity(ent, "COMBAT");
	}
	return false;
}

/**
 * Manage the garrisonHolders
 * When a unit is ordered to garrison, it must be done through this.garrison() function so that
 * an object in this.holders is created. This object contains an array with the entities
 * in the process of being garrisoned. To have all garrisoned units, we must add those in holder.garrisoned().
 * Futhermore garrison units have a metadata garrisonType describing its reason (protection, transport, ...)
 */

export class GarrisonManager
{
	Config: Config;

	holders = new Map<EntityId, GarrisonHolderData>();
	decayingStructures = new Map<EntityId, number>();

	constructor(Config: Config)
	{
		this.Config = Config;
	}

	static TYPE_FORCE = "force";
	static TYPE_TRADE = "trade";
	static TYPE_PROTECTION = "protection";
	static TYPE_DECAY = "decay";
	static TYPE_EMERGENCY = "emergency";

	update(gameState: CommonGameState, events: EngineAIEvents): void
	{
		// First check for possible upgrade of a structure
		this.onEntityRenamed(gameState, events);

		for (const [id, data] of this.holders.entries())
		{
			const list = data.list;
			const holder = gameState.getEntityById(id);
			if (!holder || !gameState.isPlayerAlly(holder.owner()))
			{
				// this holder was certainly destroyed or captured. Let's remove it
				this.releaseAll(gameState, id, list);
				this.holders.delete(id);
				continue;
			}

			// Update the list of garrisoned units
			this.updateGarrisonList(gameState, holder, id, list, events);

			if (!isPlaced(holder))
			{ // could happen with siege unit inside a ship
				continue;
			}

			if (gameState.ai.elapsedTime - (holder.getMetadata(PlayerID, "holderTimeUpdate") ?? NaN) > 3)
			{
				this.reviewHolder(gameState, holder, data);
			}
		}

		// Warning new garrison orders (as in the following lines) should be done after having updated the holders
		// (or TODO we should add a test that the garrison order is from a previous turn when updating)
		for (const [id, gmin] of this.decayingStructures.entries())
		{
			const ent = gameState.getEntityById(id);
			// a decaying structure: on the map
			if (!ent || !isPlaced(ent) || ent.owner() !== PlayerID)
			{
				this.decayingStructures.delete(id);
			}
			else if (this.numberOfGarrisonedSlots(ent) < gmin)
			{
				gameState.ai.HQ.defenseManager.garrisonUnitsInside(gameState, ent, {
					min: gmin,
					type: GarrisonManager.TYPE_DECAY,
				});
			}
		}
	}

	/** The units on their way to holder id stop going there. */
	private releaseAll(gameState: CommonGameState, id: EntityId, list: EntityId[]): void
	{
		for (const entId of list)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent || ent.getMetadata(PlayerID, "garrisonHolder") !== id)
			{
				continue;
			}
			this.leaveGarrison(ent);
			ent.stopMoving();
		}
	}

	/** Unloads the units the threats around holder no longer keep inside, and drops those on their way. */
	private reviewHolder(gameState: CommonGameState, holder: CommonPlacedEntity, data: GarrisonHolderData): void
	{
		const id = holder.id();
		const list = data.list;
		const around = this.threatsAround(gameState, holder);
		// Keep defenseManager.garrisonUnitsInside in sync to avoid garrisoning-ungarrisoning some units
		data.allowMelee = around.defenseStructure || around.unit;

		for (const entId of holder.garrisoned())
		{
			const ent = gameState.getEntityById(entId);
			if (!ent)
			{
				continue;
			}
			if (ent.owner() === PlayerID && !this.keepGarrisoned(ent, holder, around))
			{
				holder.unload(entId);
			}
		}
		for (let j = 0; j < list.length; ++j)
		{
			const ent = gameState.getEntityById(list[j]);
			if (!ent)
			{
				continue;
			}
			if (this.keepGarrisoned(ent, holder, around))
			{
				continue;
			}
			if (ent.getMetadata(PlayerID, "garrisonHolder") === id)
			{
				this.leaveGarrison(ent);
				ent.stopMoving();
			}
			list.splice(j--, 1);
		}
		if (this.numberOfGarrisonedSlots(holder) === 0)
		{
			this.holders.delete(id);
		}
		else
		{
			holder.setMetadata(PlayerID, "holderTimeUpdate", gameState.ai.elapsedTime);
		}
	}

	/** A holder or a decaying structure was upgraded or replaced */
	onEntityRenamed(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.EntityRenamed)
		{
			const data = this.holders.get(evt.entity);
			if (data)
			{
				const newHolder = gameState.getEntityById(evt.newentity);
				if (newHolder && newHolder.isGarrisonHolder())
				{
					this.holders.delete(evt.entity);
					this.holders.set(evt.newentity, data);
				}
				else
				{
					this.releaseAll(gameState, evt.entity, data.list);
					this.holders.delete(evt.entity);
				}
			}

			if (!this.decayingStructures.delete(evt.entity) || this.decayingStructures.has(evt.newentity))
			{
				continue;
			}
			const ent = gameState.getEntityById(evt.newentity);
			if (!ent || !ent.territoryDecayRate() || !ent.garrisonRegenRate())
			{
				continue;
			}
			const gmin = Math.ceil((ent.territoryDecayRate() - ent.defaultRegenRate()) / ent.garrisonRegenRate());
			this.decayingStructures.set(evt.newentity, gmin);
		}
	}

	/** Follow the units sent to garrison in a holder: renamed, killed, garrisoned or their order failed */
	updateGarrisonList(
		gameState: CommonGameState,
		holder: CommonEntity,
		id: EntityId,
		list: EntityId[],
		events: EngineAIEvents,
	): void
	{
		for (let j = 0; j < list.length; ++j)
		{
			for (const evt of events.EntityRenamed)
			{
				if (evt.entity === list[j])
				{
					list[j] = evt.newentity;
				}
			}

			const ent = gameState.getEntityById(list[j]);
			if (!ent)
			{ // unit must have been killed while garrisoning
				list.splice(j--, 1);
			}
			else if (holder.garrisoned().indexOf(list[j]) !== -1)
			{ // unit is garrisoned
				this.leaveGarrison(ent);
				list.splice(j--, 1);
			}
			else
			{
				if (
					ordersOf(ent).some((order: Record<string, unknown>): unknown => order.target && order.target === id)
				)
				{
					continue;
				}
				if (ent.getMetadata(PlayerID, "garrisonHolder") === id)
				{
					// The garrison order must have failed
					this.leaveGarrison(ent);
					list.splice(j--, 1);
				}
				else
				{
					if (gameState.ai.Config.debug > 0)
					{
						aiWarn(
							"Petra garrison error: unit " + ent.id() + " (" +
								ent.genericName() + ") is expected to garrison in " + id + " (" +
								holder.genericName() + "), but has no such garrison order " +
								uneval(ordersOf(ent)),
						);
						dumpEntity(ent);
					}
					list.splice(j--, 1);
				}
			}
		}
	}

	/** Which threats are within the holder's range: defensive structures, siege and other units */
	threatsAround(gameState: CommonGameState, holder: CommonPlacedEntity): GarrisonThreats
	{
		const holderAttackRange = holder.attackRange("Ranged");
		const range = holderAttackRange ? holderAttackRange.max : 80;
		const around: GarrisonThreats = { defenseStructure: false, meleeSiege: false, rangeSiege: false, unit: false };
		for (const ent of gameState.getEnemyEntities().values())
		{
			if (!mayThreaten(ent) || !isPlaced(ent))
			{
				continue;
			}
			const dist = SquareVectorDistance(ent.position(), holder.position());
			if (dist > range * range)
			{
				continue;
			}
			if (ent.hasClass("Structure"))
			{
				around.defenseStructure = true;
			}
			else if (isSiegeUnit(ent))
			{
				if (ent.attackTypes()?.indexOf("Melee") !== -1)
				{
					around.meleeSiege = true;
				}
				else
				{
					around.rangeSiege = true;
				}
			}
			else
			{
				around.unit = true;
				break;
			}
		}
		return around;
	}

	/**
	 * TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used.
	 * TODO should add the units garrisoned inside garrisoned units
	 */
	numberOfGarrisonedUnits(holder: CommonEntity): number
	{
		const holderData = this.holders.get(holder.id());
		return holder.garrisoned().length + (holderData ? holderData.list.length : 0);
	}

	/** TODO should add the units garrisoned inside garrisoned units */
	numberOfGarrisonedSlots(holder: CommonEntity): number
	{
		const holderData = this.holders.get(holder.id());
		return holder.garrisonedSlots() + (holderData ? holderData.list.length : 0);
	}

	allowMelee(holder: CommonEntity): boolean | undefined
	{
		return this.holders.get(holder.id())?.allowMelee;
	}

	/** This is just a pre-garrison state, while the entity walk to the garrison holder */
	garrison(gameState: CommonGameState, ent: CommonEntity, holder: CommonEntity, type: string): void
	{
		if (this.numberOfGarrisonedSlots(holder) >= holder.garrisonMax() || !ent.canGarrison())
		{
			return;
		}

		this.registerHolder(gameState, holder).list.push(ent.id());

		if (gameState.ai.Config.debug > 2)
		{
			warn("garrison unit " + ent.genericName() + " in " + holder.genericName() + " with type " + type);
			warn(
				" we try to garrison a unit with plan " + ent.getMetadata(PlayerID, "plan") + " and role " +
					ent.getMetadata(PlayerID, "role") +
					" and subrole " + ent.getMetadata(PlayerID, "subrole") + " and transport " +
					ent.getMetadata(PlayerID, "transport"),
			);
		}

		ent.setMetadata(PlayerID, "plan", lentPlan(ent.getMetadata(PlayerID, "plan")));
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_GARRISONING);
		ent.setMetadata(PlayerID, "garrisonHolder", holder.id());
		ent.setMetadata(PlayerID, "garrisonType", type);
		ent.garrison(holder);
	}

	/**
	 This is the end of the pre-garrison state, either because the entity is really garrisoned
	 or because it has changed its order (i.e. because the garrisonHolder was destroyed)
	 This function is for internal use inside garrisonManager. From outside, you should also update
	 the holder and then using cancelGarrison should be the preferred solution
	 */
	leaveGarrison(ent: CommonEntity): void
	{
		ent.setMetadata(PlayerID, "subrole", undefined);
		ent.setMetadata(PlayerID, "plan", releasedPlan(ent.getMetadata(PlayerID, "plan")));
		ent.setMetadata(PlayerID, "garrisonHolder", undefined);
	}

	/** Cancel a pre-garrison state */
	cancelGarrison(ent: CommonEntity): void
	{
		ent.stopMoving();
		// The booking must be read before the release below wipes the record;
		// the release also has to happen whether or not it was still booked.
		const holderId = ent.getMetadata(PlayerID, "garrisonHolder");
		const holderData = holderId !== undefined ? this.holders.get(holderId) : undefined;
		this.leaveGarrison(ent);
		if (holderData)
		{
			const index = holderData.list.indexOf(ent.id());
			if (index !== -1)
			{
				holderData.list.splice(index, 1);
			}
		}
	}

	keepGarrisoned(ent: CommonEntity, holder: CommonEntity, around: GarrisonThreats): boolean
	{
		switch (ent.getMetadata(PlayerID, "garrisonType"))
		{
			case GarrisonManager.TYPE_FORCE: // force the ungarrisoning
				return false;
			case GarrisonManager.TYPE_TRADE: // trader garrisoned in ship
				return true;
			case GarrisonManager.TYPE_PROTECTION: // hurt unit for healing or infantry for defense
				return this.keepProtected(ent, holder, around);
			case GarrisonManager.TYPE_DECAY:
				return !!ent.captureStrength() && this.decayingStructures.has(holder.id());
			case GarrisonManager.TYPE_EMERGENCY: // f.e. hero in regicide mode
				return this.keepInEmergency(ent, holder, around);
			default:
				if (ent.getMetadata(PlayerID, "onBoard") === "onBoard")
				{ // transport is not (yet ?) managed by garrisonManager
					return true;
				}
				aiWarn(
					"unknown type in garrisonManager " + ent.getMetadata(PlayerID, "garrisonType") +
						" for " + ent.genericName() + " id " + ent.id() + " inside " + holder.genericName() +
						" id " + holder.id(),
				);
				ent.setMetadata(PlayerID, "garrisonType", GarrisonManager.TYPE_PROTECTION);
				return true;
		}
	}

	/** Whether a unit adding arrows to its holder stays in: against units, structures, or siege when it cannot fight siege. */
	private keepShooting(ent: CommonEntity, around: GarrisonThreats): boolean
	{
		if (around.unit || around.defenseStructure)
		{
			return true;
		}
		if (around.meleeSiege || around.rangeSiege)
		{
			return ent.attackTypes()?.indexOf("Melee") === -1 ||
				ent.healthLevel() < this.Config.garrisonHealthLevel.low;
		}
		return false;
	}

	/** Whether a unit garrisoned in an emergency (a hero in regicide) stays in. */
	private keepInEmergency(ent: CommonEntity, holder: CommonEntity, around: GarrisonThreats): boolean
	{
		if (holder.buffHeal() && ent.isHealable() && ent.healthLevel() < this.Config.garrisonHealthLevel.high)
		{
			return true;
		}
		if (
			around.unit || around.defenseStructure || around.meleeSiege ||
			around.rangeSiege && ent.healthLevel() < this.Config.garrisonHealthLevel.high
		)
		{
			return true;
		}
		return !!holder.buffHeal() && ent.needsHeal();
	}

	/** Whether a unit garrisoned for protection, to heal or to defend, stays in. */
	private keepProtected(ent: CommonEntity, holder: CommonEntity, around: GarrisonThreats): boolean
	{
		if (holder.buffHeal() && ent.isHealable() && ent.healthLevel() < this.Config.garrisonHealthLevel.high)
		{
			return true;
		}
		const capture = ent.capturePoints();
		if (capture && capture[PlayerID] / capture.reduce((a: number, b: number): number => a + b) < 0.8)
		{
			return true;
		}
		if (ent.hasClasses(holder.getGarrisonArrowClasses()))
		{
			return this.keepShooting(ent, around);
		}
		const entAttackTypes = ent.attackTypes();
		if (entAttackTypes && entAttackTypes.indexOf("Melee") !== -1)
		{
			return false;
		}
		if (around.unit)
		{
			return ent.hasClass("Support") || isSiegeUnit(ent); // only ranged siege here and below as melee siege already released above
		}
		if (isSiegeUnit(ent))
		{
			return around.meleeSiege;
		}
		return !!holder.buffHeal() && ent.needsHeal();
	}

	/** Add this holder in the list managed by the garrisonManager, and return its (existing or new) data */
	registerHolder(gameState: CommonGameState, holder: CommonEntity): GarrisonHolderData
	{
		let holderData = this.holders.get(holder.id()); // already registered
		if (!holderData)
		{
			holderData = { list: [], allowMelee: true };
			this.holders.set(holder.id(), holderData);
			holder.setMetadata(PlayerID, "holderTimeUpdate", gameState.ai.elapsedTime);
		}
		return holderData;
	}

	/**
	 * Garrison units in decaying structures to stop their decay
	 * do it only for structures useful for defense, except if we are expanding (justCaptured=true)
	 * in which case we also do it for structures useful for unit trainings (TODO only Barracks are done)
	 */
	addDecayingStructure(gameState: CommonGameState, entId: EntityId, justCaptured?: boolean): boolean
	{
		if (this.decayingStructures.has(entId))
		{
			return true;
		}
		const ent = gameState.getEntityById(entId);
		if (!ent || !(ent.hasClass("Barracks") && justCaptured) && !ent.hasDefensiveFire())
		{
			return false;
		}
		if (!ent.territoryDecayRate() || !ent.garrisonRegenRate())
		{
			return false;
		}
		const gmin = Math.ceil((ent.territoryDecayRate() - ent.defaultRegenRate()) / ent.garrisonRegenRate());
		this.decayingStructures.set(entId, gmin);
		return true;
	}

	removeDecayingStructure(entId: EntityId): void
	{
		if (!this.decayingStructures.has(entId))
		{
			return;
		}
		this.decayingStructures.delete(entId);
	}

	Serialize(): SerializedGarrisonManager
	{
		return { holders: this.holders, decayingStructures: this.decayingStructures };
	}

	/** A saved garrison manager: its holders and decaying structures */
	static restore(Config: Config, data: SerializedGarrisonManager): GarrisonManager
	{
		const manager = new GarrisonManager(Config);
		manager.resume(data);
		return manager;
	}

	private resume(data: SerializedGarrisonManager): void
	{
		this.holders = data.holders;
		this.decayingStructures = data.decayingStructures;
	}
}
