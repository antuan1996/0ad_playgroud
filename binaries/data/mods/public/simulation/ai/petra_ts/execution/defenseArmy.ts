import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { armyId, playerId, worldPos } from "../adapter/brands.ts";
import { allowCapture, getLandAccess, getMaxStrength, isSiegeUnit, returnResources } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import type { Config } from "../world/config.ts";
import { hqOf } from "./hq.ts";
import { TransportPlan } from "./transportPlan.ts";
import { lentPlan, releasedPlan } from "./unitPlan.ts";
import { Worker } from "./worker.ts";

/** The fields a save keeps. */
export type SerializedDefenseArmy = Pick<
	DefenseArmy,
	| "ID"
	| "type"
	| "foePosition"
	| "positionLastUpdate"
	| "assignedAgainst"
	| "assignedTo"
	| "foeEntities"
	| "foeStrength"
	| "ownEntities"
	| "ownStrength"
>;

/**
 * Armies used by the defense manager.
 * An army is a collection of own entities and enemy entities.
 *
 * Types of armies:
 * "default":   army to counter an invading army
 * "capturing": army set to capture a gaia building or recover capture points to one of its own structures
 *            It must contain only one foe (the building to capture) and never be merged
 */
export class DefenseArmy
{
	Config: Config;
	ID: ArmyId;
	assignedAgainst: Record<number, EntityId[]>;
	assignedTo: Record<number, EntityId | 0>;
	breakawaySize: number;
	compactSize: number;
	foeEntities: EntityId[];
	foePosition: CommonPosition;
	foeStrength: number;
	ownEntities: EntityId[];
	ownStrength: number;
	positionLastUpdate: number;
	type: string;

	constructor(gameState: CommonGameState, foeEntities: EntityId[], type?: string)
	{
		this.ID = armyId(gameState.ai.uniqueIDs.armies++);
		this.type = type || "default";

		this.Config = gameState.ai.Config;
		this.compactSize = this.Config.Defense.armyCompactSize;
		this.breakawaySize = this.Config.Defense.armyBreakawaySize;

		// average
		this.foePosition = worldPos(0, 0);
		this.positionLastUpdate = gameState.ai.elapsedTime;

		// Some caching
		// A list of our defenders that were tasked with attacking a particular unit
		// This doesn't mean that they actually are since they could move on to something else on their own.
		this.assignedAgainst = {};
		// who we assigned against, for quick removal.
		this.assignedTo = {};

		this.foeEntities = [];
		this.foeStrength = 0;

		this.ownEntities = [];
		this.ownStrength = 0;

		// actually add units
		for (const id of foeEntities)
			this.addFoe(gameState, id, true);

		this.recalculatePosition(gameState, true);
	}

	/**
	 * add an entity to the enemy army
	 * Will return true if the entity was added and false otherwise.
	 * won't recalculate our position but will dirty it.
	 * force is true at army creation or when merging armies, so in this case we should add it even if far
	 */
	addFoe(gameState: CommonGameState, enemyId: EntityId, force?: boolean): boolean
	{
		if (this.foeEntities.indexOf(enemyId) !== -1)
			return false;
		const ent = gameState.getEntityById(enemyId);
		if (!ent || !isPlaced(ent))
			return false;

		// check distance
		if (!force && SquareVectorDistance(ent.position(), this.foePosition) > this.compactSize)
			return false;

		this.foeEntities.push(enemyId);
		this.assignedAgainst[enemyId] = [];
		this.positionLastUpdate = 0;
		this.evaluateStrength(ent);
		ent.setMetadata(PlayerID, "PartOfArmy", this.ID);

		return true;
	}

	/**
	 * returns true if the entity was removed and false otherwise.
	 * TODO: when there is a technology update, we should probably recompute the strengths, or weird stuffs will happen.
	 */
	removeFoe(gameState: CommonGameState, enemyId: EntityId, enemyEntity?: CommonEntity): boolean
	{
		const idx = this.foeEntities.indexOf(enemyId);
		if (idx === -1)
			return false;

		this.foeEntities.splice(idx, 1);

		delete this.assignedAgainst[enemyId];
		// entities assigned against this foe become unassigned
		for (const to in this.assignedTo)
			if (this.assignedTo[to] === enemyId)
				this.assignedTo[to] = 0;

		const ent = enemyEntity ? enemyEntity : gameState.getEntityById(enemyId);
		if (ent)
		{ // TODO recompute strength when no entities (could happen if capture+destroy)
			this.evaluateStrength(ent, false, true);
			ent.setMetadata(PlayerID, "PartOfArmy", undefined);
		}

		return true;
	}

	/**
	 * adds a defender but doesn't assign him yet.
	 * force is true when merging armies, so in this case we should add it even if no position as it can be in a ship
	 */
	addOwn(gameState: CommonGameState, id: EntityId, force?: boolean): boolean
	{
		if (this.ownEntities.indexOf(id) !== -1)
			return false;
		const ent = gameState.getEntityById(id);
		if (!ent || !isPlaced(ent) && !force)
			return false;

		this.ownEntities.push(id);
		this.evaluateStrength(ent, true);
		ent.setMetadata(PlayerID, "PartOfArmy", this.ID);
		this.assignedTo[id] = 0;

		ent.setMetadata(PlayerID, "plan", lentPlan(ent.getMetadata(PlayerID, "plan")));
		const subrole = ent.getMetadata(PlayerID, "subrole");
		if (subrole === undefined || subrole !== Worker.SUBROLE_DEFENDER)
			ent.setMetadata(PlayerID, "formerSubrole", subrole);
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_DEFENDER);
		return true;
	}

	removeOwn(gameState: CommonGameState, id: EntityId, Entity?: CommonEntity): boolean
	{
		const idx = this.ownEntities.indexOf(id);
		if (idx === -1)
			return false;

		this.ownEntities.splice(idx, 1);

		const assignedToId = this.assignedTo[id];
		if (assignedToId !== 0)
		{
			const temp = this.assignedAgainst[assignedToId];
			if (temp)
				temp.splice(temp.indexOf(id), 1);
		}
		this.assignedTo[id] = 0;

		const ent = Entity ? Entity : gameState.getEntityById(id);
		if (!ent)
			return true;

		this.evaluateStrength(ent, true, true);
		ent.setMetadata(PlayerID, "PartOfArmy", undefined);
		ent.setMetadata(PlayerID, "plan", releasedPlan(ent.getMetadata(PlayerID, "plan")));

		const formerSubrole = ent.getMetadata(PlayerID, "formerSubrole");
		if (formerSubrole !== undefined)
			ent.setMetadata(PlayerID, "subrole", formerSubrole);
		else
			ent.setMetadata(PlayerID, "subrole", undefined);
		ent.setMetadata(PlayerID, "formerSubrole", undefined);

		// Remove from transport plan if not yet on Board
		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			const plan = hqOf(gameState).navalManager.getPlan(ent.getMetadata(PlayerID, "transport"));
			if (plan && plan.state === TransportPlan.BOARDING && isPlaced(ent))
				plan.removeUnit(gameState, ent);
		}

		return true;
	}

	/**
	 * resets the army properly.
	 * assumes we already cleared dead units.
	 */
	clear(gameState: CommonGameState): void
	{
		while (this.foeEntities.length > 0)
			this.removeFoe(gameState, this.foeEntities[0]);

		// Go back to our or allied territory if needed
		const { destination, radius } = this.retreatPoint(gameState);
		while (this.ownEntities.length > 0)
		{
			const entId = this.ownEntities[0];
			// fetched once: removeOwn reuses it instead of looking it up again
			const ent = gameState.getEntityById(entId);
			this.removeOwn(gameState, entId, ent);
			if (ent)
				this.sendBack(gameState, ent, destination, radius);
		}

		this.assignedAgainst = {};
		this.assignedTo = {};

		this.recalculateStrengths(gameState);
		this.recalculatePosition(gameState);
	}

	/** Where the army goes back to: the middle of its units on our territory, else on an ally's, else the nearest ally structure. */
	private retreatPoint(gameState: CommonGameState): { destination: number[] | undefined; radius: number }
	{
		const { own, ally, other } = this.positionsByTerritory(gameState);
		if (own.n > 0)
			return { "destination": [own.pos[0] / own.n, own.pos[1] / own.n], "radius": 0 };
		if (ally.n > 0)
			return { "destination": [ally.pos[0] / ally.n, ally.pos[1] / ally.n], "radius": 0 };
		other.pos[0] /= other.n;
		other.pos[1] /= other.n;
		return nearestAllyStructure(gameState, other.pos);
	}

	/** The sums of the army's unit positions on our territory, on our allies' and elsewhere, with their counts. */
	private positionsByTerritory(
		gameState: CommonGameState,
	): Record<"own" | "ally" | "other", { pos: CommonPosition; n: number }>
	{
		const sums = {
			"own": { "pos": worldPos(0, 0), "n": 0 },
			"ally": { "pos": worldPos(0, 0), "n": 0 },
			"other": { "pos": worldPos(0, 0), "n": 0 },
		};
		for (const entId of this.ownEntities)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent || !isPlaced(ent))
				continue;
			const pos = ent.position();
			const territoryOwner = hqOf(gameState).geography.territoryMap.getOwner(pos);
			const sum = territoryOwner === PlayerID ?
				sums.own :
				gameState.isPlayerMutualAlly(territoryOwner) ?
				sums.ally :
				sums.other;
			sum.pos[0] += pos[0];
			sum.pos[1] += pos[1];
			++sum.n;
		}
		return sums;
	}

	/** A released unit not being shipped heals in a garrison, or goes back to our territory, or stops. */
	private sendBack(
		gameState: CommonGameState,
		ent: CommonEntity,
		destination: number[] | undefined,
		radius: number,
	): void
	{
		if (
			!isPlaced(ent) || ent.getMetadata(PlayerID, "transport") !== undefined ||
			ent.getMetadata(PlayerID, "transporter") !== undefined
		)
			return;
		if (
			ent.healthLevel() < this.Config.garrisonHealthLevel.low &&
			hqOf(gameState).defenseManager.garrisonAttackedUnit(gameState, ent)
		)
			return;

		if (
			destination &&
			!gameState.isPlayerMutualAlly(hqOf(gameState).geography.territoryMap.getOwner(ent.position()))
		)
			ent.moveToRange(destination[0], destination[1], radius, radius + 5);
		else
			ent.stopMoving();
	}

	assignUnit(gameState: CommonGameState, entID: EntityId): boolean
	{
		// we'll assume this defender is ours already.
		// we'll also override any previous assignment

		const ent = gameState.getEntityById(entID);
		if (!ent || !isPlaced(ent))
			return false;

		// try to return its resources, and if any, the attack order will be queued
		const queued = returnResources(gameState, ent);

		const target = this.chooseFoe(gameState, ent, entID);
		if (!target)
			return false;
		const { idFoe, foeEnt } = target;

		const ownIndex = getLandAccess(gameState, ent);
		const foePosition = foeEnt.position();
		const foeIndex = gameState.ai.accessibility.getAccessValue(foePosition);
		if (ownIndex === foeIndex || ent.hasClass("Ship"))
		{
			this.assignedTo[entID] = idFoe;
			this.assignedAgainst[idFoe].push(entID);
			ent.attack(idFoe, allowCapture(gameState, ent, foeEnt), queued);
		}
		else
			hqOf(gameState).navalManager.requireTransport(gameState, ent, ownIndex, foeIndex, foePosition);
		return true;
	}

	/**
	 * The foe ent should attack: the one attacking it, else the nearest with at most two of ours on it,
	 * else the nearest not yet fought by enough of ours.
	 */
	private chooseFoe(
		gameState: CommonGameState,
		ent: CommonPlacedEntity,
		entID: EntityId,
	): { idFoe: EntityId; foeEnt: CommonPlacedEntity } | undefined
	{
		type Choice = { idFoe: EntityId; foeEnt: CommonPlacedEntity; dist: number };
		let best: Choice | undefined;
		let bestAll: Choice | undefined;
		for (const id of this.foeEntities)
		{
			const eEnt = gameState.getEntityById(id);
			if (!eEnt || !isPlaced(eEnt)) // probably can't happen.
				continue;

			if (!ent.canAttackTarget(eEnt, allowCapture(gameState, ent, eEnt)))
				continue;

			if (isAttacking(eEnt, entID))
			{ // being attacked  >>> target the unit
				best = { "idFoe": id, "foeEnt": eEnt, "dist": 0 };
				break;
			}

			// already enough units against it
			if (this.enoughAgainst(id, eEnt))
				continue;

			const dist = SquareVectorDistance(ent.position(), eEnt.position());
			if (!bestAll || dist < bestAll.dist)
				bestAll = { "idFoe": id, "foeEnt": eEnt, dist };
			if (this.assignedAgainst[id].length > 2)
				continue;
			if (!best || dist < best.dist)
				best = { "idFoe": id, "foeEnt": eEnt, dist };
		}
		return best ?? bestAll;
	}

	/** Whether enough of ours fight foe id already: 9, or 6 unless a hero or siege. */
	private enoughAgainst(id: EntityId, eEnt: CommonEntity): boolean
	{
		return this.assignedAgainst[id].length > 8 ||
			this.assignedAgainst[id].length > 5 && !eEnt.hasClass("Hero") && !isSiegeUnit(eEnt);
	}

	getType(): string
	{
		return this.type;
	}

	getState(): 0 | 1
	{
		if (!this.foeEntities.length)
			return 0;
		return 1;
	}

	/**
	 * merge this army with another properly.
	 * assumes units are in only one army.
	 * also assumes that all have been properly cleaned up (no dead units).
	 */
	merge(gameState: CommonGameState, otherArmy: DefenseArmy): boolean
	{
		// copy over all parameters.
		for (const i in otherArmy.assignedAgainst)
		{
			if (this.assignedAgainst[i] === undefined)
				this.assignedAgainst[i] = otherArmy.assignedAgainst[i];
			else
				this.assignedAgainst[i] = this.assignedAgainst[i].concat(otherArmy.assignedAgainst[i]);
		}
		for (const i in otherArmy.assignedTo)
			this.assignedTo[i] = otherArmy.assignedTo[i];

		for (const id of otherArmy.foeEntities)
			this.addFoe(gameState, id, true);
		// TODO: reassign those ?
		for (const id of otherArmy.ownEntities)
			this.addOwn(gameState, id, true);

		this.recalculatePosition(gameState, true);
		this.recalculateStrengths(gameState);

		return true;
	}

	needsDefenders(gameState: CommonGameState): number | false
	{
		let defenseRatio;
		const territoryOwner = hqOf(gameState).geography.territoryMap.getOwner(this.foePosition);
		if (territoryOwner === PlayerID)
			defenseRatio = this.Config.Defense.defenseRatio.own;
		else if (gameState.isPlayerAlly(territoryOwner))
		{
			defenseRatio = this.Config.Defense.defenseRatio.ally;
			let numExclusiveAllies = 0;
			for (let p = 1; p < gameState.sharedScript.playersData.length; ++p)
				if (p !== territoryOwner && gameState.sharedScript.playersData[p].isAlly[territoryOwner])
					++numExclusiveAllies;
			defenseRatio /= 1 + 0.5 * Math.max(0, numExclusiveAllies - 1);
		}
		else
			defenseRatio = this.Config.Defense.defenseRatio.neutral;

		// some preliminary checks because we don't update for tech so entStrength removed can be > entStrength added
		if (this.foeStrength <= 0 || this.ownStrength <= 0)
			this.recalculateStrengths(gameState);

		if (this.foeStrength * defenseRatio <= this.ownStrength)
			return false;
		return this.foeStrength * defenseRatio - this.ownStrength;
	}

	/** if not forced, will only recalculate if on a different turn. */
	recalculatePosition(gameState: CommonGameState, force?: boolean): void
	{
		if (!force && this.positionLastUpdate === gameState.ai.elapsedTime)
			return;

		let npos = 0;
		const pos = [0, 0];
		for (const id of this.foeEntities)
		{
			const ent = gameState.getEntityById(id);
			if (!ent || !isPlaced(ent))
				continue;
			npos++;
			const epos = ent.position();
			pos[0] += epos[0];
			pos[1] += epos[1];
		}
		// if npos = 0, the army must have been destroyed and will be removed next turn. keep previous position
		if (npos > 0)
		{
			this.foePosition[0] = pos[0] / npos;
			this.foePosition[1] = pos[1] / npos;
		}

		this.positionLastUpdate = gameState.ai.elapsedTime;
	}

	recalculateStrengths(gameState: CommonGameState): void
	{
		this.ownStrength = 0;
		this.foeStrength = 0;

		for (const id of this.foeEntities)
			this.evaluateStrength(gameState.getEntityById(id));
		for (const id of this.ownEntities)
			this.evaluateStrength(gameState.getEntityById(id), true);
	}

	/** adds or remove the strength of the entity either to the enemy or to our units. */
	evaluateStrength(ent: CommonEntity | undefined, isOwn?: boolean, remove?: boolean): void
	{
		if (!ent)
			return;

		let entStrength;
		if (ent.hasClass("Structure"))
		{
			if (ent.owner() !== PlayerID)
				entStrength = ent.getDefaultArrow() ? 6 * ent.getDefaultArrow() : 4;
			// small strength used only when we try to recover capture points
			else
				entStrength = 2;
		}
		else
			entStrength = getMaxStrength(ent, this.Config.debug, this.Config.DamageTypeImportance);

		// TODO adapt the getMaxStrength function for animals.
		// For the time being, just increase it for elephants as the returned value is too small.
		if (ent.hasClasses(["Animal+Elephant"]))
			entStrength *= 3;

		if (remove)
			entStrength *= -1;

		if (isOwn)
			this.ownStrength += entStrength;
		else
			this.foeStrength += entStrength;
	}

	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		// Warning the metadata is already cloned in shared.js. Futhermore, changes should be done before destroyEvents
		// otherwise it would remove the old entity from this army list
		// TODO we should may-be reevaluate the strength
		for (const evt of events.EntityRenamed)
		{ // take care of promoted and packed units
			if (this.foeEntities.indexOf(evt.entity) !== -1)
				this.renameFoe(gameState, evt.entity, evt.newentity);
			else if (this.ownEntities.indexOf(evt.entity) !== -1)
				this.renameOwn(gameState, evt.entity, evt.newentity);
		}

		for (const evt of events.Garrison)
			this.removeFoe(gameState, evt.entity);

		for (const evt of events.OwnershipChanged)
		{ // captured
			if (!gameState.isPlayerEnemy(evt.to))
				this.removeFoe(gameState, evt.entity);
			else if (evt.from === PlayerID)
				this.removeOwn(gameState, evt.entity);
		}

		for (const evt of events.Destroy)
		{
			// we may have capture+destroy, so do not trust owner and check all possibilities
			this.removeOwn(gameState, evt.entity);
			this.removeFoe(gameState, evt.entity);
		}
	}

	/** A foe promoted or packed: the army follows it under its new id, unless it became a corpse. */
	private renameFoe(gameState: CommonGameState, entity: EntityId, newentity: EntityId): void
	{
		const ent = gameState.getEntityById(newentity);
		if (ent && ent.templateName().indexOf("resource|") !== -1) // corpse of animal killed
			return;
		const idx = this.foeEntities.indexOf(entity);
		this.foeEntities[idx] = newentity;
		this.assignedAgainst[newentity] = this.assignedAgainst[entity];
		delete this.assignedAgainst[entity];
		for (const to in this.assignedTo)
			if (this.assignedTo[to] === entity)
				this.assignedTo[to] = newentity;
	}

	/** A defender promoted or packed: the army keeps it under its new id if it can still fight. */
	private renameOwn(gameState: CommonGameState, entity: EntityId, newentity: EntityId): void
	{
		const newEnt = gameState.getEntityById(newentity);
		if (newEnt && (!newEnt.hasUnitAI() || !newEnt.attackTypes()))
			return;
		const idx = this.ownEntities.indexOf(entity);
		this.ownEntities[idx] = newentity;
		this.assignedTo[newentity] = this.assignedTo[entity];
		this.assignedTo[entity] = 0;
		for (const against in this.assignedAgainst)
		{
			if (!this.assignedAgainst[against])
				continue;
			if (this.assignedAgainst[against].indexOf(entity) !== -1)
				this.assignedAgainst[against][this.assignedAgainst[against].indexOf(entity)] = newentity;
		}
	}

	update(gameState: CommonGameState): EntityId[]
	{
		for (const entId of this.ownEntities)
		{
			const ent = gameState.getEntityById(entId);
			if (ent)
				this.keepFighting(gameState, ent, entId);
		}

		if (this.type === "capturing")
		{
			this.checkRecaptured(gameState);
			return [];
		}

		const breakaways = [];
		// TODO: assign unassigned defenders, cleanup of a few things.
		// perhaps occasional strength recomputation

		// occasional update or breakaways, positions…
		if (gameState.ai.elapsedTime - this.positionLastUpdate > 5)
		{
			// also stamps positionLastUpdate with this turn, so the
			// non-forced later calls this turn return immediately
			this.recalculatePosition(gameState);

			// Check for breakaways.
			for (let i = 0; i < this.foeEntities.length; ++i)
			{
				const id = this.foeEntities[i];
				const ent = gameState.getEntityById(id);
				if (
					!ent || !isPlaced(ent) ||
					!(SquareVectorDistance(ent.position(), this.foePosition) > this.breakawaySize)
				)
					continue;
				breakaways.push(id);
				if (this.removeFoe(gameState, id, ent))
					i--;
			}
		}

		return breakaways;
	}

	/** An idle defender is given a foe; one capturing what it had better destroy attacks it instead. */
	private keepFighting(gameState: CommonGameState, ent: CommonEntity, entId: EntityId): void
	{
		const orderData = ordersOf(ent);
		if (!orderData.length && !ent.getMetadata(PlayerID, "transport"))
			this.assignUnit(gameState, entId);
		else if (
			orderData.length && orderData[0].target && orderData[0].attackType && orderData[0].attackType === "Capture"
		)
		{
			const target = gameState.getEntityById(orderData[0].target);
			if (target && !allowCapture(gameState, ent, target))
				ent.attack(orderData[0].target, false);
		}
	}

	/** A capturing army's one foe leaves the army once no enemy holds capture points of it. */
	private checkRecaptured(gameState: CommonGameState): void
	{
		const firstFoe = gameState.getEntityById(this.foeEntities[0]);
		if (!this.foeEntities.length || !firstFoe)
			return;
		// Check if we still still some capturePoints to recover
		// and if not, remove this foe from the list (capture army have only one foe)
		const capture = firstFoe.capturePoints();
		if (capture)
		{
			for (let j = 0; j < capture.length; ++j)
				if (gameState.isPlayerEnemy(playerId(j)) && capture[j] > 0)
					return;
		}
		this.removeFoe(gameState, this.foeEntities[0], firstFoe);
	}

	Serialize(): SerializedDefenseArmy
	{
		return {
			"ID": this.ID,
			"type": this.type,
			"foePosition": this.foePosition,
			"positionLastUpdate": this.positionLastUpdate,
			"assignedAgainst": this.assignedAgainst,
			"assignedTo": this.assignedTo,
			"foeEntities": this.foeEntities,
			"foeStrength": this.foeStrength,
			"ownEntities": this.ownEntities,
			"ownStrength": this.ownStrength,
		};
	}

	/** A saved defense army: its foes, its defenders and their pairings */
	static restore(gameState: CommonGameState, data: SerializedDefenseArmy): DefenseArmy
	{
		const army = new DefenseArmy(gameState, []);
		army.resume(data);
		return army;
	}

	private resume(data: SerializedDefenseArmy): void
	{
		this.ID = data.ID;
		this.type = data.type;
		this.foePosition = data.foePosition;
		this.positionLastUpdate = data.positionLastUpdate;
		this.assignedAgainst = data.assignedAgainst;
		this.assignedTo = data.assignedTo;
		this.foeEntities = data.foeEntities;
		this.foeStrength = data.foeStrength;
		this.ownEntities = data.ownEntities;
		this.ownStrength = data.ownStrength;
	}
}

/** The nearest ally structure on the army's land, a defensive one first, and its obstruction radius. */
function nearestAllyStructure(
	gameState: CommonGameState,
	position: CommonPosition,
): { destination: number[] | undefined; radius: number }
{
	let destination: number[] | undefined;
	let defensiveFound;
	let distmin;
	let radius = 0;
	const armyAccess = gameState.ai.accessibility.getAccessValue(position);
	for (const struct of gameState.getAllyStructures().values())
	{
		const pos = struct.position();
		if (!pos || !gameState.isPlayerMutualAlly(hqOf(gameState).geography.territoryMap.getOwner(pos)))
			continue;
		if (getLandAccess(gameState, struct) !== armyAccess)
			continue;
		const defensiveStruct = struct.hasDefensiveFire();
		if (defensiveFound && !defensiveStruct)
			continue;
		const dist = SquareVectorDistance(position, pos);
		if (distmin && dist > distmin && (defensiveFound || !defensiveStruct))
			continue;
		if (defensiveStruct)
			defensiveFound = true;
		distmin = dist;
		destination = pos;
		// ally structures always have an obstruction
		radius = struct.obstructionRadius().max;
	}
	return { destination, radius };
}

/** Whether the foe is a unit attacking entID */
function isAttacking(eEnt: CommonEntity, entID: EntityId): boolean
{
	return !!eEnt.hasClass("Unit") && !!ordersOf(eEnt) && ordersOf(eEnt).length > 0 &&
		!!ordersOf(eEnt)[0].target && ordersOf(eEnt)[0].target === entID;
}
