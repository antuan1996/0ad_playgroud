import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { GAIA, worldPos } from "../adapter/brands.ts";
import * as chat from "../adapter/chatHelper.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, requireValue } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { ATTACK_TYPES, plansIn, type AttackType } from "../execution/attackConstants.ts";
import { AttackPlan, byAttackType, type SerializedAttackPlan } from "../execution/attackPlan.ts";
import type { DefenseArmy } from "../execution/defenseArmy.ts";
import { PLAN_RESERVE, isLent } from "../execution/unitPlan.ts";
import { Worker, marchesWithAttack } from "../execution/worker.ts";
import { allowCapture } from "../world/capture.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import {
	getEnemyPlayer as getEnemyPlayerFor,
	getRelicEnemyPlayer as getRelicEnemyPlayerFor,
} from "./enemySelection.ts";

export type SerializedAttackManager = {
	properties: {
		totalNumber: number;
		attackNumber: number;
		rushNumber: number;
		raidNumber: number;
		debugTime: number;
		maxRushes: number;
		rushSize: number[];
		currentEnemyPlayer: PlayerId | undefined;
		defeated: Record<number, boolean>;
	};
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

/** A defense army dissolved into the attack: its units on the target's land that the attack may take join it */
function enlistArmy(
	gameState: CommonGameState,
	army: DefenseArmy,
	attackPlan: AttackPlan,
	targetAccess: AccessIndex,
): void
{
	while (army.foeEntities.length > 0)
	{
		army.removeFoe(gameState, army.foeEntities[0]);
	}
	while (army.ownEntities.length > 0)
	{
		const unitId = army.ownEntities[0];
		army.removeOwn(gameState, unitId);
		const unit = gameState.getEntityById(unitId);
		if (!unit)
		{
			continue;
		}
		// the original ORed in "transport metadata exists" here, but
		// isAvailableUnit below always rejects transport-marked units, so the
		// clause could never lead to an enlistment and was dropped
		if (
			isPlaced(unit) && getLandAccess(gameState, unit) === targetAccess &&
			attackPlan.isAvailableUnit(gameState, unit)
		)
		{
			unit.setMetadata(PlayerID, "plan", attackPlan.name);
			unit.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
			attackPlan.unitCollection.updateEnt(unit);
		}
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
	const owner = gameState.ai.HQ.geography.territoryMap.getOwner(safePos);
	if (owner !== 0 && gameState.isPlayerEnemy(owner))
	{
		return undefined;
	}
	const targetPos = worldPos(
		structPos[0] + (entPos[0] - structPos[0]) * range / dist,
		structPos[1] + (entPos[1] - structPos[1]) * range / dist,
	);
	if (
		gameState.ai.HQ.geography.territoryMap.getOwner(targetPos) !== PlayerID ||
		gameState.ai.accessibility.getAccessValue(targetPos) !== from.access
	)
	{
		return undefined;
	}
	return targetPos;
}

export class AttackManager
{
	Config: Config;
	/** Our units held in reserve, out of any plan */
	outOfPlan: CommonEntityCollection;

	totalNumber = 0;
	attackNumber = 0;
	rushNumber = 0;
	raidNumber = 0;
	upcomingAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	startedAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	bombingAttacks = new Map<EntityId, Set<EntityId>>(); // Temporary attacks for siege units while waiting their current attack to start
	debugTime = 0;
	maxRushes = 0;
	rushSize: number[] = [];
	currentEnemyPlayer: PlayerId | undefined = undefined; // enemy player we are currently targeting
	defeated: Record<number, boolean> = {};
	/** enemiesByLand's answer and the turn it was counted on (not saved). */
	enemyLands = new Map<AccessIndex, CommonPlacedEntity[]>();
	enemyLandsTurn = -1;

	constructor(config: Config, gameState: CommonGameState)
	{
		this.Config = config;
		this.outOfPlan = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "plan", PLAN_RESERVE));
		this.outOfPlan.registerUpdates();
	}

	/** A saved attack manager with its plans; canBuildUnits is the restored headquarters' */
	static restore(
		config: Config,
		gameState: CommonGameState,
		data: SerializedAttackManager,
		canBuildUnits: boolean,
	): AttackManager
	{
		const manager = new AttackManager(config, gameState);
		manager.resume(gameState, data, canBuildUnits);
		return manager;
	}

	/** More initialisation for stuff that needs the gameState */

	setRushes(allowed: number): void
	{
		if (this.Config.personality.aggressive > this.Config.personalityCut.strong && allowed > 2)
		{
			this.maxRushes = 3;
			this.rushSize = [16, 20, 24];
		}
		else if (this.Config.personality.aggressive > this.Config.personalityCut.medium && allowed > 1)
		{
			this.maxRushes = 2;
			this.rushSize = [18, 22];
		}
		else if (this.Config.personality.aggressive > this.Config.personalityCut.weak && allowed > 0)
		{
			this.maxRushes = 1;
			this.rushSize = [20];
		}
	}

	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.PlayerDefeated)
		{
			this.defeated[evt.playerId] = true;
		}

		this.onAttackRequest(gameState, events);

		for (const evt of events.EntityRenamed)
		{ // take care of packing units in bombing attacks
			this.renameInBombings(evt.entity, evt.newentity);
		}
	}

	/** An ally asks us to attack a player: our upcoming attacks aim at it, and start at once if strong enough */
	private onAttackRequest(gameState: CommonGameState, events: EngineAIEvents): void
	{
		let answer: "join" | "other" | "decline" = "decline";
		let other;
		let targetPlayer;
		for (const evt of events.AttackRequest)
		{
			if (evt.source === PlayerID || !gameState.isPlayerAlly(evt.source) || !gameState.isPlayerEnemy(evt.player))
			{
				continue;
			}
			targetPlayer = evt.player;
			const aimed = this.aimUpcomingAttacks(targetPlayer);
			other = aimed.other;

			if (aimed.available > 12)
			{ // launch the attack immediately
				for (const attack of plansIn(this.upcomingAttacks))
				{
					// every non-completing attack was re-aimed at targetPlayer by the
					// loop above, so the original targetPlayer re-check here could
					// never fire and was dropped
					if (attack.state === AttackPlan.STATE_COMPLETING || attack.unitCollection.length < 3)
					{
						continue;
					}
					attack.forceStart();
					attack.requested = true;
				}
				answer = "join";
			}
			else if (other !== undefined)
			{
				answer = "other";
			}
			break; // take only the first attack request into account
		}
		if (targetPlayer !== undefined)
		{
			chat.answerRequestAttack(gameState, targetPlayer, answer, other);
		}
	}

	/**
	 * The upcoming attacks not completing aim at targetPlayer; returns the units they and those completing
	 * against it have, and the target of one completing against another player.
	 */
	private aimUpcomingAttacks(targetPlayer: PlayerId): { available: number; other: PlayerId | undefined; }
	{
		let available = 0;
		let other;
		for (const attack of plansIn(this.upcomingAttacks))
		{
			if (attack.state === AttackPlan.STATE_COMPLETING)
			{
				if (attack.targetPlayer === targetPlayer)
				{
					available += attack.unitCollection.length;
				}
				else if (attack.targetPlayer !== undefined && attack.targetPlayer !== targetPlayer)
				{
					other = attack.targetPlayer;
				}
				continue;
			}

			attack.targetPlayer = targetPlayer;

			if (attack.unitCollection.length > 2)
			{
				available += attack.unitCollection.length;
			}
		}
		return { available, other };
	}

	/** A bombing's target or bomber renamed (packed or unpacked) */
	private renameInBombings(entity: EntityId, newentity: EntityId): void
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
					!gameState.isPlayerEnemy(gameState.ai.HQ.geography.territoryMap.getOwner(structPos))
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

	/**
	 * Some functions are run every turn
	 * Others once in a while
	 */
	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): void
	{
		if (this.Config.debug > 2 && gameState.ai.elapsedTime > this.debugTime + 60)
		{
			this.warnAttacks(gameState);
		}

		Engine.ProfileStart("attacks checkEvents");
		this.checkEvents(gameState, events);
		Engine.ProfileStop();
		Engine.ProfileStart("attacks upcoming");
		const unexecutedAttacks = this.updateUpcomingAttacks(gameState, events);
		Engine.ProfileStop();
		Engine.ProfileStart("attacks started");
		this.updateStartedAttacks(gameState, events);
		Engine.ProfileStop();

		// creating plans after updating because an aborted plan might be reused in that case.

		Engine.ProfileStart("attacks create");
		this.createAttacks(gameState, unexecutedAttacks);
		Engine.ProfileStop();

		if (unexecutedAttacks[AttackPlan.TYPE_RAID] === 0 && gameState.ai.HQ.defenseManager.targetList.length)
		{
			let target;
			for (const targetId of gameState.ai.HQ.defenseManager.targetList)
			{
				target = gameState.getEntityById(targetId);
				if (!target)
				{
					continue;
				}
				if (gameState.isPlayerEnemy(target.owner()))
				{
					break;
				}
				target = undefined;
			}
			if (target)
			{ // prepare a raid against this target
				this.raidTargetEntity(gameState, target);
			}
		}

		// Check if we have some unused ranged siege unit which could do something useful while waiting
		if (this.Config.difficulty > difficulty.VERY_EASY && gameState.ai.playedTurn % 5 === 0)
		{
			this.assignBombers(gameState);
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
				this.Config,
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
					this.Config,
					1,
					() => "Attack Manager: Starting " + attack.getType() + " plan " + attack.getName(),
				);
				if (this.Config.chat)
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
						this.Config,
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

	/** A rush, or a default or huge attack, when none of its type waits unexecuted */
	createAttacks(gameState: CommonGameState, unexecutedAttacks: Record<AttackType, number>): void
	{
		const barracksNb = gameState.getOwnEntitiesByClass("Barracks", true).filter(filters.isBuilt()).length;
		if (this.rushNumber < this.maxRushes && barracksNb >= 1)
		{
			if (unexecutedAttacks[AttackPlan.TYPE_RUSH] === 0)
			{
				this.createRush(gameState);
			}
		}
		else if (this.wantsMainAttack(gameState, unexecutedAttacks))
		{
			const phase2 = gameState.getPhaseName(2);
			if (
				barracksNb >= 1 &&
					(gameState.currentPhase() > 1 || (phase2 !== undefined && gameState.isResearching(phase2))) ||
				!gameState.ai.HQ.basesManager.hasPotentialBase()
			)
			{ // if we have no base ... nothing else to do than attack
				this.createMainAttack(gameState);
			}
		}
	}

	/** we have a barracks and we want to rush, rush. */
	private createRush(gameState: CommonGameState): void
	{
		const data = { targetSize: this.rushSize[this.rushNumber] };
		const attackPlan = AttackPlan.create(gameState, this.Config, this.totalNumber, AttackPlan.TYPE_RUSH, data);
		if (attackPlan)
		{
			debugWarn(
				this.Config,
				1,
				() => "Military Manager: Rushing plan " + this.totalNumber + " with maxRushes " + this.maxRushes,
			);
			this.totalNumber++;
			this.upcomingAttacks[AttackPlan.TYPE_RUSH].push(attackPlan);
		}
		this.rushNumber++;
	}

	/**
	 * Whether a default or huge attack is wanted: none waits unexecuted, fewer are started than the population allows,
	 * and none is or we have room to train
	 */
	private wantsMainAttack(gameState: CommonGameState, unexecutedAttacks: Record<AttackType, number>): boolean
	{
		const started = this.startedAttacks[AttackPlan.TYPE_DEFAULT].length +
			this.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length;
		return unexecutedAttacks[AttackPlan.TYPE_DEFAULT] === 0 &&
			unexecutedAttacks[AttackPlan.TYPE_HUGE_ATTACK] === 0 &&
			started < Math.min(2, 1 + Math.round(gameState.getPopulationMax() / 100)) &&
			(started === 0 || gameState.getPopulationMax() - gameState.getPopulation() > 12);
	}

	/** A default attack, or a huge one after two attacks while none is started */
	private createMainAttack(gameState: CommonGameState): void
	{
		const type = this.attackNumber < 2 || this.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length > 0 ?
			AttackPlan.TYPE_DEFAULT :
			AttackPlan.TYPE_HUGE_ATTACK;
		const attackPlan = AttackPlan.create(gameState, this.Config, this.totalNumber, type);
		// the original wrote a write-only "attackPlansEncounteredWater" hack flag
		// on failure; nothing ever read it, so the port drops the dead write
		if (attackPlan)
		{
			debugWarn(this.Config, 1, () => "Military Manager: Creating the plan " + type + "  " + this.totalNumber);
			this.totalNumber++;
			this.upcomingAttacks[type].push(attackPlan);
		}
		this.attackNumber++;
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

	/**
	 * Determine which player should be attacked: when called when starting the attack,
	 * attack.targetPlayer is undefined and in that case, we keep track of the chosen target
	 * for future attacks.
	 */
	getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		return getEnemyPlayerFor(gameState, attack, this);
	}

	/**
	 * Target the player with the most relics (including gaia).
	 */
	getRelicEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		return getRelicEnemyPlayerFor(gameState, attack, this);
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

	raidTargetEntity(gameState: CommonGameState, ent: CommonEntity): AttackPlan | undefined
	{
		const data = { target: ent };
		const attackPlan = AttackPlan.create(gameState, this.Config, this.totalNumber, AttackPlan.TYPE_RAID, data);
		if (!attackPlan)
		{
			return undefined;
		}
		debugWarn(this.Config, 1, () => "Military Manager: Raiding plan " + this.totalNumber);
		this.raidNumber++;
		this.totalNumber++;
		this.upcomingAttacks[AttackPlan.TYPE_RAID].push(attackPlan);
		return attackPlan;
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
			const local = AttackPlan.create(gameState, this.Config, this.totalNumber, AttackPlan.TYPE_DEFAULT);
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
				this.Config,
				1,
				() =>
					"Military Manager: local attack " + local.name + " on land " + land +
					" with " + soldiers.length + " units left by " + leaving.name,
			);
		}
	}

	/**
	 * Switch defense armies into an attack one against the given target
	 * data.range: transform all defense armies inside range of the target into a new attack
	 * data.armyID: transform only the defense army ID into a new attack
	 * data.uniqueTarget: the attack will stop when the target is destroyed or captured
	 */
	switchDefenseToAttack(
		gameState: CommonGameState,
		target: CommonEntity,
		data: { range?: number; armyID?: ArmyId; uniqueTarget?: boolean; },
	): boolean
	{
		if (!target || !isPlaced(target))
		{
			return false;
		}
		if (!data.range && !data.armyID)
		{
			aiWarn(" attackManager.switchDefenseToAttack inconsistent data " + uneval(data));
			return false;
		}
		const attackData = data.uniqueTarget ? { uniqueTargetId: target.id() } : undefined;
		const pos = target.position();
		const attackType = AttackPlan.TYPE_DEFAULT;
		const attackPlan = AttackPlan.create(gameState, this.Config, this.totalNumber, attackType, attackData);
		if (!attackPlan)
		{
			return false;
		}
		this.totalNumber++;
		this.startedAttacks[attackType].push(attackPlan);

		const targetAccess = getLandAccess(gameState, target);
		for (const army of gameState.ai.HQ.defenseManager.armies)
		{
			if (data.range)
			{
				army.recalculatePosition(gameState);
				if (SquareVectorDistance(pos, army.foePosition) > data.range * data.range)
				{
					continue;
				}
			}
			// If range is not given, the entry check ensured armyID is set.
			else if (army.ID !== data.armyID)
			{
				continue;
			}

			enlistArmy(gameState, army, attackPlan, targetAccess);
		}
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

	Serialize(): SerializedAttackManager
	{
		const properties = {
			totalNumber: this.totalNumber,
			attackNumber: this.attackNumber,
			rushNumber: this.rushNumber,
			raidNumber: this.raidNumber,
			debugTime: this.debugTime,
			maxRushes: this.maxRushes,
			rushSize: this.rushSize,
			currentEnemyPlayer: this.currentEnemyPlayer,
			defeated: this.defeated,
		};

		const upcomingAttacks = byAttackType((type) => this.upcomingAttacks[type].map((attack) => attack.Serialize()));
		const startedAttacks = byAttackType((type) => this.startedAttacks[type].map((attack) => attack.Serialize()));

		return { properties: properties, upcomingAttacks: upcomingAttacks, startedAttacks: startedAttacks };
	}

	private resume(gameState: CommonGameState, data: SerializedAttackManager, canBuildUnits: boolean): void
	{
		this.totalNumber = data.properties.totalNumber;
		this.attackNumber = data.properties.attackNumber;
		this.rushNumber = data.properties.rushNumber;
		this.raidNumber = data.properties.raidNumber;
		this.debugTime = data.properties.debugTime;
		this.maxRushes = data.properties.maxRushes;
		this.rushSize = data.properties.rushSize;
		this.currentEnemyPlayer = data.properties.currentEnemyPlayer;
		this.defeated = data.properties.defeated;

		const restore = (dataAttack: SerializedAttackPlan): AttackPlan =>
			AttackPlan.restore(gameState, this.Config, dataAttack, canBuildUnits);
		this.upcomingAttacks = byAttackType((type) => data.upcomingAttacks[type].map(restore));
		this.startedAttacks = byAttackType((type) => data.startedAttacks[type].map(restore));
	}
}
