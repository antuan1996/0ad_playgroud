/**
 * The town's attacks (`gameState.ai.town.attacks`, part of execution/town.ts): the attack plans, execution's own
 * to keep — those in preparation and those under way, numbered as they are made, run each turn, started, aborted
 * and closed, and saved with the town — with the local fights a leaving plan leaves, the defense armies turned to
 * an attack, the siege units sent to bomb what is in range meanwhile, and the enemies on each land. The attack
 * manager decides which attacks to make and whom they fight; it makes the desk, which reaches it only through
 * AttackDecisions.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { GAIA, worldPos } from "../adapter/brands.ts";
import * as chat from "../adapter/chatHelper.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, requireValue } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { allowCapture } from "../world/capture.ts";
import type { Config } from "../world/config.ts";
import { ATTACK_TYPES, plansIn, type AttackType } from "./attackConstants.ts";
import { AttackPlan, byAttackType, type AttackPlanData, type SerializedAttackPlan } from "./attackPlan.ts";
import { isLent } from "./unitPlan.ts";
import { Worker, marchesWithAttack } from "./worker.ts";

/** The attack plans as the town saves them */
export type SerializedAttacks = {
	totalNumber: number;
	debugTime: number;
	upcomingAttacks: Record<AttackType, SerializedAttackPlan[]>;
	startedAttacks: Record<AttackType, SerializedAttackPlan[]>;
};

/** The fewest of a leaving plan's soldiers on a land with enemies that stay there to fight (splitLocalFights). */
const LOCAL_FIGHT_MIN = 4;

/** Where a group stands: the mean of its positions. */
function centreOf(units: readonly CommonPlacedEntity[]): CommonPosition
{
	let x = 0;
	let z = 0;
	for (const ent of units)
	{
		const pos = ent.position();
		x += pos[0];
		z += pos[1];
	}
	return worldPos(x / units.length, z / units.length);
}

/** The enemy building nearest to a position, else the nearest enemy unit (the list holds one or the other). */
function nearestLocalTarget(enemies: readonly CommonPlacedEntity[], from: CommonPosition): CommonPlacedEntity
{
	const structures = enemies.filter((enemy) => enemy.hasClass("Structure"));
	const pool = structures.length ? structures : enemies;
	let best = pool[0];
	let bestDist = SquareVectorDistance(best.position(), from);
	for (const enemy of pool)
	{
		const dist = SquareVectorDistance(enemy.position(), from);
		if (dist < bestDist)
		{
			best = enemy;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * How the defense hands armies to a new attack once it is made: it releases
 * the armies' foes and defenders, each defender (still in the world) to
 * `enlist` (decision/defenseManager.ts releaseArmies).
 */
export type ArmyRelease = (
	gameState: CommonGameState,
	targetPos: CommonPosition,
	enlist: (unit: CommonEntity) => void,
) => void;

/** A released defender joins the attack: on the map, on the target's land, and free to go */
function enlistDefender(
	gameState: CommonGameState,
	attackPlan: AttackPlan,
	targetAccess: AccessIndex,
	unit: CommonEntity,
): void
{
	// the original ORed in "transport metadata exists" here, but
	// isAvailableUnit below always rejects transport-marked units, so the
	// clause could never lead to an enlistment and was dropped
	if (
		isPlaced(unit) && getLandAccess(gameState, unit) === targetAccess && attackPlan.isAvailableUnit(gameState, unit)
	)
	{
		unit.setMetadata(PlayerID, "plan", attackPlan.name);
		unit.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
		attackPlan.unitCollection.updateEnt(unit);
	}
}

/** Whether a bomber still has the target as its last order and is lent to nothing */
function stillBombing(ent: CommonEntity, targetId: EntityId): boolean
{
	const plan = ent.getMetadata(PlayerID, "plan");
	const orders = ordersOf(ent);
	const lastOrder = orders && orders.length ? orders[orders.length - 1] : null;
	return !!lastOrder && !!lastOrder.target && lastOrder.target === targetId && !isLent(plan);
}

/**
 * Where a bomber out of range goes to shoot the structure: at range on the line to it, on our territory and land,
 * with the structure's surroundings not the enemy's; undefined if there is no such place.
 */
function bombingSpot(
	gameState: CommonGameState,
	from: { pos: CommonPosition; access: AccessIndex; },
	struct: CommonStructureEntity,
	dist: number,
	range: number,
): CommonPosition | undefined
{
	const entPos = from.pos;
	const structPos = struct.position();
	const safety = struct.footprintRadius() + 30;
	const safePos = worldPos(
		structPos[0] + (entPos[0] - structPos[0]) * safety / dist,
		structPos[1] + (entPos[1] - structPos[1]) * safety / dist,
	);
	const owner = gameState.ai.geography.territoryMap.getOwner(safePos);
	if (owner !== 0 && gameState.isPlayerEnemy(owner))
	{
		return undefined;
	}
	const targetPos = worldPos(
		structPos[0] + (entPos[0] - structPos[0]) * range / dist,
		structPos[1] + (entPos[1] - structPos[1]) * range / dist,
	);
	if (
		gameState.ai.geography.territoryMap.getOwner(targetPos) !== PlayerID ||
		gameState.ai.accessibility.getAccessValue(targetPos) !== from.access
	)
	{
		return undefined;
	}
	return targetPos;
}

/** What the attacks desk asks of its attack manager (decision/attackManager.ts, which makes it and passes itself) */
export interface AttackDecisions
{
	readonly outOfPlan: CommonEntityCollection;
	readonly defeated: Readonly<Record<number, boolean>>;
	getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined;
}

export class AttackDesk
{
	/** the plans in preparation, by type */
	upcomingAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	/** the plans under way, by type */
	startedAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	/** Temporary attacks for siege units while waiting their current attack to start, by target */
	bombingAttacks = new Map<EntityId, Set<EntityId>>();
	/** the plans made so far: the next one's number */
	totalNumber = 0;
	/** when the plans were last listed (debug) */
	debugTime = 0;
	/** enemiesByLand's answer and the turn it was counted on (not saved). */
	private enemyLands = new Map<AccessIndex, CommonPlacedEntity[]>();
	private enemyLandsTurn = -1;
	private readonly config: Config;
	private readonly manager: AttackDecisions;

	constructor(config: Config, manager: AttackDecisions)
	{
		this.config = config;
		this.manager = manager;
	}

	/** units that left a plan, ready for the next one */
	get outOfPlan(): CommonEntityCollection
	{
		return this.manager.outOfPlan;
	}

	/** Whether the player was found defeated */
	isDefeated(player: PlayerId): boolean
	{
		return !!this.manager.defeated[player];
	}

	/** the player an attack should go for */
	getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		return this.manager.getEnemyPlayer(gameState, attack);
	}

	/** A new plan of the type to prepare, numbered next; none when it has nowhere to start from */
	prepareAttack(gameState: CommonGameState, type: AttackType, data?: AttackPlanData): AttackPlan | undefined
	{
		const attackPlan = AttackPlan.create(gameState, this.config, this.totalNumber, type, data);
		if (!attackPlan)
		{
			return undefined;
		}
		this.totalNumber++;
		this.upcomingAttacks[type].push(attackPlan);
		return attackPlan;
	}

	/** A bombing's target or bomber renamed (packed or unpacked) */
	renameInBombings(entity: EntityId, newentity: EntityId): void
	{
		for (const [targetId, unitIds] of this.bombingAttacks)
		{
			if (targetId === entity)
			{
				this.bombingAttacks.set(newentity, unitIds);
				this.bombingAttacks.delete(entity);
			}
			else if (unitIds.has(entity))
			{
				unitIds.add(newentity);
				unitIds.delete(entity);
			}
		}
	}

	/**
	 * Check for any structure in range from within our territory, and bomb it
	 */
	assignBombers(gameState: CommonGameState): void
	{
		this.cleanBombings(gameState);

		const bombers = gameState.updatingCollection(
			"bombers",
			filters.byClasses(["BoltShooter", "StoneThrower"]),
			gameState.getOwnUnits(),
		);
		for (const ent of bombers.values())
		{
			// Filtered on having a Ranged attack, so attackRange("Ranged") is defined.
			const ranged = ent.attackRange("Ranged");
			if (!isPlaced(ent) || !ent.isIdle() || !ranged)
			{
				continue;
			}
			if (isLent(ent.getMetadata(PlayerID, "plan")))
			{
				continue;
			}
			if (marchesWithAttack(ent))
			{
				continue;
			}
			if (this.isBombing(ent.id()))
			{
				break;
			}
			this.bombAStructure(gameState, ent, ranged.max);
		}
	}

	/** The bombings drop their units gone or sent elsewhere, and the targets gone or no more enemy */
	private cleanBombings(gameState: CommonGameState): void
	{
		for (const [targetId, unitIds] of this.bombingAttacks)
		{
			const target = gameState.getEntityById(targetId);
			if (!target || !gameState.isPlayerEnemy(target.owner()))
			{
				this.bombingAttacks.delete(targetId);
				continue;
			}
			for (const entId of unitIds.values())
			{
				const ent = gameState.getEntityById(entId);
				if (ent && ent.owner() === PlayerID && stillBombing(ent, targetId))
				{
					continue;
				}
				unitIds.delete(entId);
			}
			if (!unitIds.size)
			{
				this.bombingAttacks.delete(targetId);
			}
		}
	}

	/** Whether the unit bombs a target already */
	private isBombing(id: EntityId): boolean
	{
		for (const unitIds of this.bombingAttacks.values())
		{
			if (unitIds.has(id))
			{
				return true;
			}
		}
		return false;
	}

	/** The bomber attacks the first enemy structure it can reach from our territory, unless 5 bomb it already */
	private bombAStructure(gameState: CommonGameState, ent: CommonPlacedEntity, range: number): void
	{
		const entPos = ent.position();
		const access = getLandAccess(gameState, ent);
		for (const struct of gameState.getEnemyStructures().values())
		{
			if (!ent.canAttackTarget(struct, allowCapture(gameState, ent, struct)))
			{
				continue;
			}

			const structPos = struct.position();
			if (struct.hasClass("Field"))
			{
				if (
					!struct.resourceSupplyNumGatherers() ||
					!gameState.isPlayerEnemy(gameState.ai.geography.territoryMap.getOwner(structPos))
				)
				{
					continue;
				}
			}
			const dist = VectorDistance(entPos, structPos);
			// targetPos holds the position to move to when out of range.
			let targetPos: CommonPosition | undefined;
			if (dist > range)
			{
				targetPos = bombingSpot(gameState, { pos: entPos, access }, struct, dist, range);
				if (!targetPos)
				{
					continue;
				}
			}
			let attackingUnits = this.bombingAttacks.get(struct.id());
			if (attackingUnits && attackingUnits.size > 4)
			{
				continue; // already enough units against that target
			}
			if (!attackingUnits)
			{
				attackingUnits = new Set<EntityId>();
				this.bombingAttacks.set(struct.id(), attackingUnits);
			}
			attackingUnits.add(ent.id());
			if (targetPos)
			{
				ent.move(targetPos[0], targetPos[1]);
			}
			ent.attack(struct.id(), false, dist > range);
			return;
		}
	}

	/** Debug: the plans in preparation and the started ones */
	warnAttacks(gameState: CommonGameState): void
	{
		this.debugTime = gameState.ai.elapsedTime;
		aiWarn(" upcoming attacks =================");
		for (const attackType of ATTACK_TYPES)
		{
			for (const attack of this.upcomingAttacks[attackType])
			{
				aiWarn(
					" plan " + attack.name + " type " + attackType + " state " + attack.state +
						" units " + attack.unitCollection.length,
				);
			}
		}
		aiWarn(" started attacks ==================");
		for (const attackType of ATTACK_TYPES)
		{
			for (const attack of this.startedAttacks[attackType])
			{
				aiWarn(
					" plan " + attack.name + " type " + attackType + " state " + attack.state +
						" units " + attack.unitCollection.length,
				);
			}
		}
		aiWarn(" ==================================");
	}

	/** Prepare the upcoming attacks: start, abort or keep them; returns how many of each type are unexecuted */
	updateUpcomingAttacks(gameState: CommonGameState, events: EngineAIEvents): Record<AttackType, number>
	{
		const unexecutedAttacks: Record<AttackType, number> = {
			[AttackPlan.TYPE_RUSH]: 0,
			[AttackPlan.TYPE_RAID]: 0,
			[AttackPlan.TYPE_DEFAULT]: 0,
			[AttackPlan.TYPE_HUGE_ATTACK]: 0,
		};
		for (const attackType of ATTACK_TYPES)
		{
			for (let i = 0; i < this.upcomingAttacks[attackType].length; ++i)
			{
				const attack = this.upcomingAttacks[attackType][i];
				const outcome = this.prepare(gameState, attack, attackType, events);
				if (outcome === "unexecuted")
				{
					++unexecutedAttacks[attackType];
				}
				else if (outcome === "done")
				{
					this.upcomingAttacks[attackType].splice(i--, 1);
				}
			}
		}
		return unexecutedAttacks;
	}

	/**
	 * One preparation step of an upcoming attack: "done" when it was aborted or started (and so is no more upcoming),
	 * "unexecuted" when it goes on unexecuted, else "preparing".
	 */
	private prepare(
		gameState: CommonGameState,
		attack: AttackPlan,
		attackType: AttackType,
		events: EngineAIEvents,
	): "done" | "unexecuted" | "preparing"
	{
		attack.checkEvents(gameState, events);
		if (attack.state === AttackPlan.STATE_COMPLETING)
		{
			attack.answerAttacks(gameState, events);
		}

		if (attack.isStarted())
		{
			aiWarn("Petra problem in attackManager: attack in preparation has already " + "started ???");
		}

		Engine.ProfileStart("attack preparation " + attackType);
		const updateStep = attack.updatePreparation(gameState);
		Engine.ProfileStop();
		// now we're gonna check if the preparation time is over
		if (updateStep === AttackPlan.PREPARATION_KEEP_GOING || attack.isPaused())
		{
			// just chillin'
			return attack.state === AttackPlan.STATE_UNEXECUTED ? "unexecuted" : "preparing";
		}
		if (updateStep === AttackPlan.PREPARATION_FAILED)
		{
			debugWarn(
				this.config,
				1,
				() => "Attack Manager: " + attack.getType() + " plan " + attack.getName() + " aborted.",
			);
			attack.Abort(gameState);
			return "done";
		}
		if (updateStep === AttackPlan.PREPARATION_START)
		{
			if (attack.StartAttack(gameState))
			{
				debugWarn(
					this.config,
					1,
					() => "Attack Manager: Starting " + attack.getType() + " plan " + attack.getName(),
				);
				if (this.config.chat)
				{
					chat.launchAttack(
						gameState,
						requireValue(attack.targetPlayer),
						attack.type === AttackPlan.TYPE_HUGE_ATTACK,
					);
				}
				this.startedAttacks[attackType].push(attack);
			}
			else
			{
				attack.Abort(gameState);
			}
			return "done";
		}
		return "preparing";
	}

	/** Update the started attacks, ending those with nothing left */
	updateStartedAttacks(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const attackType of ATTACK_TYPES)
		{
			for (let i = 0; i < this.startedAttacks[attackType].length; ++i)
			{
				const attack = this.startedAttacks[attackType][i];
				attack.checkEvents(gameState, events);
				// okay so then we'll update the attack.
				if (attack.isPaused())
				{
					continue;
				}
				const remaining = attack.update(gameState, events);
				if (!remaining)
				{
					debugWarn(
						this.config,
						1,
						() =>
							"Military Manager: " + attack.getType() + " plan " +
							attack.getName() + " is finished with remaining " + remaining,
					);
					attack.Abort(gameState);
					this.startedAttacks[attackType].splice(i--, 1);
				}
			}
		}
	}

	getPlan(planName: UnitPlan | undefined): AttackPlan | undefined
	{
		for (const attack of plansIn(this.upcomingAttacks))
		{
			if (attack.getName() === planName)
			{
				return attack;
			}
		}
		for (const attack of plansIn(this.startedAttacks))
		{
			if (attack.getName() === planName)
			{
				return attack;
			}
		}
		return undefined;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pausePlan(planName: AttackPlanId): void
	{
		const attack = this.getPlan(planName);
		if (attack)
		{
			attack.setPaused(true);
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpausePlan(planName: AttackPlanId): void
	{
		const attack = this.getPlan(planName);
		if (attack)
		{
			attack.setPaused(false);
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseAllPlans(): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
		{
			attack.setPaused(true);
		}

		for (const attack of plansIn(this.startedAttacks))
		{
			attack.setPaused(true);
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseAllPlans(): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
		{
			attack.setPaused(false);
		}

		for (const attack of plansIn(this.startedAttacks))
		{
			attack.setPaused(false);
		}
	}

	getAttackInPreparation(type: AttackType): AttackPlan | undefined
	{
		return this.upcomingAttacks[type].length ? this.upcomingAttacks[type][0] : undefined;
	}

	/** f.e. if we have changed diplomacy with another player. */
	cancelAttacksAgainstPlayer(gameState: CommonGameState, player: PlayerId): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
		{
			if (attack.targetPlayer === player)
			{
				attack.targetPlayer = undefined;
			}
		}

		for (const attackType of ATTACK_TYPES)
		{
			for (let i = 0; i < this.startedAttacks[attackType].length; ++i)
			{
				const attack = this.startedAttacks[attackType][i];
				if (attack.targetPlayer === player)
				{
					attack.Abort(gameState);
					this.startedAttacks[attackType].splice(i--, 1);
				}
			}
		}
	}

	/**
	 * Return the number of units from any of our attacking armies around this position
	 */
	numAttackingUnitsAround(pos: CommonPosition, dist: number): number
	{
		let num = 0;
		for (const attack of plansIn(this.startedAttacks))
		{
			if (!attack.position)
			{ // this attack may be inside a transport
				continue;
			}
			if (SquareVectorDistance(pos, attack.position) < dist * dist)
			{
				num += attack.unitCollection.length;
			}
		}
		return num;
	}

	/**
	 * Each land's enemy soldiers, heroes, siege engines and buildings (not
	 * gaia's, no ships), counted once a turn: where our soldiers have enemies
	 * beside them (FINDINGS §34).
	 */
	enemiesByLand(gameState: CommonGameState): ReadonlyMap<AccessIndex, readonly CommonPlacedEntity[]>
	{
		if (this.enemyLandsTurn === gameState.ai.playedTurn)
		{
			return this.enemyLands;
		}
		this.enemyLandsTurn = gameState.ai.playedTurn;
		this.enemyLands = new Map();
		for (const enemy of gameState.getEnemyEntities().values())
		{
			if (
				enemy.owner() === GAIA || !isPlaced(enemy) || enemy.hasClass("Ship") ||
				!enemy.hasClasses(["Soldier", "Hero", "Siege", "Structure"])
			)
			{
				continue;
			}
			// 1 marks an impassable cell (a cliff's edge, the map's), no land
			const land = getLandAccess(gameState, enemy);
			if (land === undefined || land <= 1)
			{
				continue;
			}
			const list = this.enemyLands.get(land);
			if (list)
			{
				list.push(enemy);
			}
			else
			{
				this.enemyLands.set(land, [enemy]);
			}
		}
		return this.enemyLands;
	}

	/**
	 * When an attack sets off, its soldiers standing on a land where enemies
	 * stand (enemiesByLand), other than the target's, stay there as one attack
	 * per land, started at once against the nearest enemy building there, else
	 * the nearest unit (FINDINGS §34: on shared islands the army sailed away
	 * from enemies beside it). A land with fewer than LOCAL_FIGHT_MIN of the
	 * plan's soldiers keeps them in the plan, which ships none of them to its
	 * rally point (AttackPlan.updatePreparation).
	 */
	splitLocalFights(gameState: CommonGameState, leaving: AttackPlan, targetLand: AccessIndex | undefined): void
	{
		const enemiesByLand = this.enemiesByLand(gameState);
		const soldiersByLand = new Map<AccessIndex, CommonPlacedEntity[]>();
		for (const ent of leaving.unitCollection.values())
		{
			// a soldier aboard a ship is on no land
			if (!isPlaced(ent))
			{
				continue;
			}
			const land = getLandAccess(gameState, ent);
			if (land === undefined || land === targetLand || !enemiesByLand.has(land))
			{
				continue;
			}
			const list = soldiersByLand.get(land);
			if (list)
			{
				list.push(ent);
			}
			else
			{
				soldiersByLand.set(land, [ent]);
			}
		}
		for (const [land, soldiers] of soldiersByLand)
		{
			if (soldiers.length < LOCAL_FIGHT_MIN)
			{
				continue;
			}
			const target = nearestLocalTarget(requireValue(enemiesByLand.get(land)), centreOf(soldiers));
			const local = AttackPlan.create(gameState, this.config, this.totalNumber, AttackPlan.TYPE_DEFAULT);
			if (!local)
			{
				continue;
			}
			this.totalNumber++;
			this.startedAttacks[AttackPlan.TYPE_DEFAULT].push(local);
			for (const ent of soldiers)
			{
				ent.setMetadata(PlayerID, "plan", local.name);
				ent.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
				leaving.unitCollection.updateEnt(ent);
				local.unitCollection.updateEnt(ent);
			}
			local.targetPlayer = target.owner();
			local.targetPos = target.position();
			local.target = target;
			local.changeState(AttackPlan.STATE_UNEXECUTED, AttackPlan.STATE_ARRIVED);
			debugWarn(
				this.config,
				1,
				() =>
					"Military Manager: local attack " + local.name + " on land " + land +
					" with " + soldiers.length + " units left by " + leaving.name,
			);
		}
	}

	/**
	 * Switch defense armies into an attack against the given target: once the
	 * plan is made, the defense releases the armies it chose (`release`), and
	 * each defender that may go joins the attack.
	 * uniqueTarget: the attack will stop when the target is destroyed or captured
	 */
	switchDefenseToAttack(
		gameState: CommonGameState,
		target: CommonEntity,
		release: ArmyRelease,
		uniqueTarget = false,
	): boolean
	{
		if (!target || !isPlaced(target))
		{
			return false;
		}
		const attackData = uniqueTarget ? { uniqueTargetId: target.id() } : undefined;
		const pos = target.position();
		const attackType = AttackPlan.TYPE_DEFAULT;
		const attackPlan = AttackPlan.create(gameState, this.config, this.totalNumber, attackType, attackData);
		if (!attackPlan)
		{
			return false;
		}
		this.totalNumber++;
		this.startedAttacks[attackType].push(attackPlan);

		const targetAccess = getLandAccess(gameState, target);
		release(gameState, pos, (unit) => enlistDefender(gameState, attackPlan, targetAccess, unit));
		if (!attackPlan.unitCollection.hasEntities())
		{
			attackPlan.Abort(gameState);
			return false;
		}
		for (const unit of attackPlan.unitCollection.values())
		{
			unit.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
		}
		attackPlan.targetPlayer = target.owner();
		attackPlan.targetPos = pos;
		attackPlan.target = target;
		attackPlan.changeState(AttackPlan.STATE_UNEXECUTED, AttackPlan.STATE_ARRIVED);
		return true;
	}

	Serialize(): SerializedAttacks
	{
		return {
			totalNumber: this.totalNumber,
			debugTime: this.debugTime,
			upcomingAttacks: byAttackType((type) => this.upcomingAttacks[type].map((attack) => attack.Serialize())),
			startedAttacks: byAttackType((type) => this.startedAttacks[type].map((attack) => attack.Serialize())),
		};
	}

	/** The saved plans back, as the headquarters can build units or not */
	resume(gameState: CommonGameState, data: SerializedAttacks, canBuildUnits: boolean): void
	{
		this.totalNumber = data.totalNumber;
		this.debugTime = data.debugTime;
		const restore = (dataAttack: SerializedAttackPlan): AttackPlan =>
			AttackPlan.restore(gameState, this.config, dataAttack, canBuildUnits);
		this.upcomingAttacks = byAttackType((type) => data.upcomingAttacks[type].map(restore));
		this.startedAttacks = byAttackType((type) => data.startedAttacks[type].map(restore));
	}
}
