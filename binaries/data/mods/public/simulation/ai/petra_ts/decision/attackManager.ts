import * as filters from "simulation/ai/common-api/filters.js";
import { aiWarn, SquareVectorDistance, VectorDistance } from "simulation/ai/common-api/utils.js";
import { ATTACK_TYPES, AttackPlan, type AttackType, type SerializedAttackPlan, byAttackType, plansIn } from "../execution/attackPlan.ts";
import * as chat from "../adapter/chatHelper.ts";
import { Config } from "./config.ts";
import * as difficulty from "./difficultyLevel.ts";
import { allowCapture, getLandAccess, requireValue } from "../adapter/entityExtend.ts";
import { Worker } from "../execution/worker.ts";
import { playerId, worldPos } from "../adapter/brands.ts";
import { PLAN_RESERVE, isLent } from "../execution/unitPlan.ts";
import { debugWarn } from "../adapter/debug.ts";

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

export class AttackManager
{
	Config: Config;
	declare outOfPlan: CommonEntityCollection;

	totalNumber = 0;
	attackNumber = 0;
	rushNumber = 0;
	raidNumber = 0;
	upcomingAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	startedAttacks: Record<AttackType, AttackPlan[]> = byAttackType(() => []);
	bombingAttacks = new Map<EntityId, Set<EntityId>>();// Temporary attacks for siege units while waiting their current attack to start
	debugTime = 0;
	maxRushes = 0;
	rushSize: number[] = [];
	currentEnemyPlayer: PlayerId | undefined = undefined; // enemy player we are currently targeting
	defeated: Record<number, boolean> = {};

	constructor(config: Config)
	{
		this.Config = config;
	}

	/** More initialisation for stuff that needs the gameState */
	init(gameState: CommonGameState): void
	{
		this.outOfPlan = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "plan", PLAN_RESERVE));
		this.outOfPlan.registerUpdates();
	}

	setRushes(allowed: number): void
	{
		if (this.Config.personality.aggressive > this.Config.personalityCut.strong && allowed > 2)
		{
			this.maxRushes = 3;
			this.rushSize = [ 16, 20, 24 ];
		}
		else if (this.Config.personality.aggressive > this.Config.personalityCut.medium && allowed > 1)
		{
			this.maxRushes = 2;
			this.rushSize = [ 18, 22 ];
		}
		else if (this.Config.personality.aggressive > this.Config.personalityCut.weak && allowed > 0)
		{
			this.maxRushes = 1;
			this.rushSize = [ 20 ];
		}
	}

	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.PlayerDefeated)
			this.defeated[evt.playerId] = true;

		let answer: "join" | "other" | "decline" = "decline";
		let other;
		let targetPlayer;
		for (const evt of events.AttackRequest)
		{
			if (evt.source === PlayerID || !gameState.isPlayerAlly(evt.source) || !gameState.isPlayerEnemy(evt.player))
				continue;
			targetPlayer = evt.player;
			let available = 0;
			for (const attack of plansIn(this.upcomingAttacks))
			{
				if (attack.state === AttackPlan.STATE_COMPLETING)
				{
					if (attack.targetPlayer === targetPlayer)
						available += attack.unitCollection.length;
					else if (attack.targetPlayer !== undefined && attack.targetPlayer !== targetPlayer)
						other = attack.targetPlayer;
					continue;
				}

				attack.targetPlayer = targetPlayer;

				if (attack.unitCollection.length > 2)
					available += attack.unitCollection.length;
			}

			if (available > 12)	// launch the attack immediately
			{
				for (const attack of plansIn(this.upcomingAttacks))
				{
					// every non-completing attack was re-aimed at targetPlayer by the
					// loop above, so the original targetPlayer re-check here could
					// never fire and was dropped
					if (attack.state === AttackPlan.STATE_COMPLETING ||
						attack.unitCollection.length < 3)
						continue;
					attack.forceStart();
					attack.requested = true;
				}
				answer = "join";
			}
			else if (other !== undefined)
				answer = "other";
			break;  // take only the first attack request into account
		}
		if (targetPlayer !== undefined)
			chat.answerRequestAttack(gameState, targetPlayer, answer, other);

		for (const evt of events.EntityRenamed)	// take care of packing units in bombing attacks
		{
			for (const [targetId, unitIds] of this.bombingAttacks)
			{
				if (targetId === evt.entity)
				{
					this.bombingAttacks.set(evt.newentity, unitIds);
					this.bombingAttacks.delete(evt.entity);
				}
				else if (unitIds.has(evt.entity))
				{
					unitIds.add(evt.newentity);
					unitIds.delete(evt.entity);
				}
			}
		}
	}

	/**
	 * Check for any structure in range from within our territory, and bomb it
	 */
	assignBombers(gameState: CommonGameState): void
	{
		// First some cleaning of current bombing attacks
		for (const [targetId, unitIds] of this.bombingAttacks)
		{
			const target = gameState.getEntityById(targetId);
			if (!target || !gameState.isPlayerEnemy(target.owner()))
				this.bombingAttacks.delete(targetId);
			else
			{
				for (const entId of unitIds.values())
				{
					const ent = gameState.getEntityById(entId);
					if (ent && ent.owner() === PlayerID)
					{
						const plan = ent.getMetadata(PlayerID, "plan");
						const orders = ent.unitAIOrderData();
						const lastOrder = orders && orders.length ? orders[orders.length-1] : null;
						if (lastOrder && lastOrder.target && lastOrder.target === targetId && !isLent(plan))
							continue;
					}
					unitIds.delete(entId);
				}
				if (!unitIds.size)
					this.bombingAttacks.delete(targetId);
			}
		}

		const bombers = gameState.updatingCollection("bombers",
			filters.byClasses(["BoltShooter", "StoneThrower"]), gameState.getOwnUnits());
		for (const ent of bombers.values())
		{
			// Filtered on having a Ranged attack, so attackRange("Ranged") is defined.
			const ranged = ent.attackRange("Ranged");
			if (!ent.position() || !ent.isIdle() || !ranged)
				continue;
			if (isLent(ent.getMetadata(PlayerID, "plan")))
				continue;
			if (ent.getMetadata(PlayerID, "plan") !== undefined && ent.getMetadata(PlayerID, "plan") !== PLAN_RESERVE)
			{
				const subrole = ent.getMetadata(PlayerID, "subrole");
				if (subrole && (subrole === Worker.SUBROLE_COMPLETING ||
					subrole === Worker.SUBROLE_WALKING || subrole === Worker.SUBROLE_ATTACKING))
					continue;
			}
			let alreadyBombing = false;
			for (const unitIds of this.bombingAttacks.values())
			{
				if (!unitIds.has(ent.id()))
					continue;
				alreadyBombing = true;
				break;
			}
			if (alreadyBombing)
				break;

			const range = ranged.max;
			const entPos = ent.position();
			const access = getLandAccess(gameState, ent);
			for (const struct of gameState.getEnemyStructures().values())
			{
				if (!ent.canAttackTarget(struct, allowCapture(gameState, ent, struct)))
					continue;

				const structPos = struct.position();
				if (struct.hasClass("Field"))
				{
					if (!struct.resourceSupplyNumGatherers() ||
					    !gameState.isPlayerEnemy(gameState.ai.HQ.geography.territoryMap.getOwner(structPos)))
						continue;
				}
				const dist = VectorDistance(entPos, structPos);
				// targetPos holds the position to move to when out of range.
				let targetPos: CommonPosition | undefined;
				if (dist > range)
				{
					const safety = requireValue(struct.footprintRadius()) + 30;
					targetPos = worldPos(
						structPos[0] + (entPos[0] - structPos[0]) * safety / dist,
						structPos[1] + (entPos[1] - structPos[1]) * safety / dist
					);
					const owner = gameState.ai.HQ.geography.territoryMap.getOwner(targetPos);
					if (owner !== 0 && gameState.isPlayerEnemy(owner))
						continue;
					targetPos = worldPos(
						structPos[0] + (entPos[0] - structPos[0]) * range / dist,
						structPos[1] + (entPos[1] - structPos[1]) * range / dist
					);
					if (gameState.ai.HQ.geography.territoryMap.getOwner(targetPos) !== PlayerID ||
					    gameState.ai.accessibility.getAccessValue(targetPos) !== access)
						continue;
				}
				let attackingUnits;
				for (const [targetId, unitIds] of this.bombingAttacks)
				{
					if (targetId !== struct.id())
						continue;
					attackingUnits = unitIds;
					break;
				}
				if (attackingUnits && attackingUnits.size > 4)
					continue;	// already enough units against that target
				if (!attackingUnits)
				{
					attackingUnits = new Set<EntityId>();
					this.bombingAttacks.set(struct.id(), attackingUnits);
				}
				attackingUnits.add(ent.id());
				if (targetPos)
					ent.move(targetPos[0], targetPos[1]);
				ent.attack(struct.id(), false, dist > range);
				break;
			}
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
			this.debugTime = gameState.ai.elapsedTime;
			aiWarn(" upcoming attacks =================");
			for (const attackType of ATTACK_TYPES)
			{
				for (const attack of this.upcomingAttacks[attackType])
				{
					aiWarn(" plan " + attack.name + " type " + attackType + " state " + attack.state +
						" units " + attack.unitCollection.length);
				}
			}
			aiWarn(" started attacks ==================");
			for (const attackType of ATTACK_TYPES)
			{
				for (const attack of this.startedAttacks[attackType])
				{
					aiWarn(" plan " + attack.name + " type " + attackType + " state " + attack.state +
						" units " + attack.unitCollection.length);
				}
			}
			aiWarn(" ==================================");
		}

		this.checkEvents(gameState, events);
		const unexecutedAttacks = {
			[AttackPlan.TYPE_RUSH]: 0,
			[AttackPlan.TYPE_RAID]: 0,
			[AttackPlan.TYPE_DEFAULT]: 0,
			[AttackPlan.TYPE_HUGE_ATTACK]: 0
		};
		for (const attackType of ATTACK_TYPES)
		{
			for (let i = 0; i < this.upcomingAttacks[attackType].length; ++i)
			{
				const attack = this.upcomingAttacks[attackType][i];
				attack.checkEvents(gameState, events);

				if (attack.isStarted())
				{
					aiWarn("Petra problem in attackManager: attack in preparation has already " +
						"started ???");
				}

				const updateStep = attack.updatePreparation(gameState);
				// now we're gonna check if the preparation time is over
				if (updateStep === AttackPlan.PREPARATION_KEEP_GOING || attack.isPaused())
				{
					// just chillin'
					if (attack.state === AttackPlan.STATE_UNEXECUTED)
						++unexecutedAttacks[attackType];
				}
				else if (updateStep === AttackPlan.PREPARATION_FAILED)
				{
					debugWarn(this.Config, 1, () => "Attack Manager: " + attack.getType() + " plan " + attack.getName() +
						" aborted.");
					attack.Abort(gameState);
					this.upcomingAttacks[attackType].splice(i--, 1);
				}
				else if (updateStep === AttackPlan.PREPARATION_START)
				{
					if (attack.StartAttack(gameState))
					{
						debugWarn(this.Config, 1, () => "Attack Manager: Starting " + attack.getType() + " plan " +
							attack.getName());
						if (this.Config.chat)
							chat.launchAttack(gameState, requireValue(attack.targetPlayer), attack.getType());
						this.startedAttacks[attackType].push(attack);
					}
					else
						attack.Abort(gameState);
					this.upcomingAttacks[attackType].splice(i--, 1);
				}
			}
		}

		for (const attackType of ATTACK_TYPES)
		{
			for (let i = 0; i < this.startedAttacks[attackType].length; ++i)
			{
				const attack = this.startedAttacks[attackType][i];
				attack.checkEvents(gameState, events);
				// okay so then we'll update the attack.
				if (attack.isPaused())
					continue;
				const remaining = attack.update(gameState, events);
				if (!remaining)
				{
					debugWarn(this.Config, 1, () => "Military Manager: " + attack.getType() + " plan " +
						attack.getName() + " is finished with remaining " + remaining);
					attack.Abort(gameState);
					this.startedAttacks[attackType].splice(i--, 1);
				}
			}
		}

		// creating plans after updating because an aborted plan might be reused in that case.

		const barracksNb = gameState.getOwnEntitiesByClass("Barracks", true).filter(filters.isBuilt()).length;
		if (this.rushNumber < this.maxRushes && barracksNb >= 1)
		{
			if (unexecutedAttacks[AttackPlan.TYPE_RUSH] === 0)
			{
				// we have a barracks and we want to rush, rush.
				const data = { "targetSize": this.rushSize[this.rushNumber] };
				const attackPlan = new AttackPlan(gameState, this.Config, this.totalNumber,
					AttackPlan.TYPE_RUSH, data, false);
				if (!attackPlan.failed)
				{
					debugWarn(this.Config, 1, () => "Military Manager: Rushing plan " + this.totalNumber +
						" with maxRushes " + this.maxRushes);
					this.totalNumber++;
					attackPlan.init(gameState);
					this.upcomingAttacks[AttackPlan.TYPE_RUSH].push(attackPlan);
				}
				this.rushNumber++;
			}
		}
		else if (unexecutedAttacks[AttackPlan.TYPE_DEFAULT] === 0 &&
			unexecutedAttacks[AttackPlan.TYPE_HUGE_ATTACK] === 0 &&
			this.startedAttacks[AttackPlan.TYPE_DEFAULT].length +
				this.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length <
				Math.min(2, 1 + Math.round(gameState.getPopulationMax() / 100)) &&
			(this.startedAttacks[AttackPlan.TYPE_DEFAULT].length +
				this.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length === 0 ||
			gameState.getPopulationMax() - gameState.getPopulation() > 12))
		{
			const phase2 = gameState.getPhaseName(2);
			if (barracksNb >= 1 && (gameState.currentPhase() > 1 || (phase2 !== undefined && gameState.isResearching(phase2))) ||
				!gameState.ai.HQ.hasPotentialBase())	// if we have no base ... nothing else to do than attack
			{
				const type = this.attackNumber < 2 ||
					this.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length > 0 ?
					AttackPlan.TYPE_DEFAULT : AttackPlan.TYPE_HUGE_ATTACK;
				const attackPlan = new AttackPlan(gameState, this.Config, this.totalNumber, type,
					undefined, false);
				// the original wrote a write-only "attackPlansEncounteredWater" hack flag
				// on failure; nothing ever read it, so the port drops the dead write
				if (!attackPlan.failed)
				{
					debugWarn(this.Config, 1, () => "Military Manager: Creating the plan " + type + "  " +
						this.totalNumber);
					this.totalNumber++;
					attackPlan.init(gameState);
					this.upcomingAttacks[type].push(attackPlan);
				}
				this.attackNumber++;
			}
		}

		if (unexecutedAttacks[AttackPlan.TYPE_RAID] === 0 &&
			gameState.ai.HQ.defenseManager.targetList.length)
		{
			let target;
			for (const targetId of gameState.ai.HQ.defenseManager.targetList)
			{
				target = gameState.getEntityById(targetId);
				if (!target)
					continue;
				if (gameState.isPlayerEnemy(target.owner()))
					break;
				target = undefined;
			}
			if (target) // prepare a raid against this target
				this.raidTargetEntity(gameState, target);
		}

		// Check if we have some unused ranged siege unit which could do something useful while waiting
		if (this.Config.difficulty > difficulty.VERY_EASY && gameState.ai.playedTurn % 5 === 0)
			this.assignBombers(gameState);
	}

	getPlan(planName: UnitPlan | undefined): AttackPlan | undefined
	{
		for (const attack of plansIn(this.upcomingAttacks))
			if (attack.getName() === planName)
				return attack;
		for (const attack of plansIn(this.startedAttacks))
			if (attack.getName() === planName)
				return attack;
		return undefined;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pausePlan(planName: AttackPlanId): void
	{
		const attack = this.getPlan(planName);
		if (attack)
			attack.setPaused(true);
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpausePlan(planName: AttackPlanId): void
	{
		const attack = this.getPlan(planName);
		if (attack)
			attack.setPaused(false);
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseAllPlans(): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
			attack.setPaused(true);

		for (const attack of plansIn(this.startedAttacks))
			attack.setPaused(true);
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseAllPlans(): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
			attack.setPaused(false);

		for (const attack of plansIn(this.startedAttacks))
			attack.setPaused(false);
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
		let enemyPlayer;

		// First check if there is a preferred enemy based on our victory conditions.
		// If both wonder and relic, choose randomly between them TODO should combine decisions

		if (gameState.getVictoryConditions().has("wonder"))
			enemyPlayer = this.getWonderEnemyPlayer(gameState, attack);

		if (gameState.getVictoryConditions().has("capture_the_relic"))
			if (!enemyPlayer || randBool())
				enemyPlayer = this.getRelicEnemyPlayer(gameState, attack) || enemyPlayer;

		if (enemyPlayer)
			return enemyPlayer;

		const veto: Record<number, boolean> = {};
		for (const i in this.defeated)
			veto[i] = true;
		// No rush if enemy too well defended (i.e. iberians)
		if (attack.type === AttackPlan.TYPE_RUSH)
		{
			for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
			{
				const i = playerId(iIndex);
				if (!gameState.isPlayerEnemy(i) || veto[i])
					continue;
				if (this.defeated[i])
					continue;
				let enemyDefense = 0;
				for (const ent of gameState.getEnemyStructures(i).values())
					if (ent.hasClasses(["Tower", "WallTower", "Fortress"]))
						enemyDefense++;
				if (enemyDefense > 6)
					veto[i] = true;
			}
		}

		// then if not a huge attack, continue attacking our previous target as long as it has some entities,
		// otherwise target the most accessible one
		if (attack.type !== AttackPlan.TYPE_HUGE_ATTACK)
		{
			if (attack.targetPlayer === undefined && this.currentEnemyPlayer !== undefined &&
				!this.defeated[this.currentEnemyPlayer] &&
				gameState.isPlayerEnemy(this.currentEnemyPlayer) &&
				gameState.getEntities(this.currentEnemyPlayer).hasEntities())
				return this.currentEnemyPlayer;

			let distmin;
			let ccmin;
			const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
			for (const ourcc of ccEnts.values())
			{
				if (ourcc.owner() !== PlayerID)
					continue;
				const ourPos = ourcc.position();
				const access = getLandAccess(gameState, ourcc);
				for (const enemycc of ccEnts.values())
				{
					if (veto[enemycc.owner()])
						continue;
					if (!gameState.isPlayerEnemy(enemycc.owner()))
						continue;
					if (access !== getLandAccess(gameState, enemycc))
						continue;
					const dist = SquareVectorDistance(ourPos, enemycc.position());
					if (distmin && dist > distmin)
						continue;
					ccmin = enemycc;
					distmin = dist;
				}
			}
			if (ccmin)
			{
				enemyPlayer = ccmin.owner();
				if (attack.targetPlayer === undefined)
					this.currentEnemyPlayer = enemyPlayer;
				return enemyPlayer;
			}
		}

		// then let's target our strongest enemy (basically counting enemies units)
		// with priority to enemies with civ center
		let max = 0;
		for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
		{
			const i = playerId(iIndex);
			if (veto[i])
				continue;
			if (!gameState.isPlayerEnemy(i))
				continue;
			let enemyCount = 0;
			let enemyCivCentre = false;
			for (const ent of gameState.getEntities(i).values())
			{
				enemyCount++;
				if (ent.hasClass("CivCentre"))
					enemyCivCentre = true;
			}
			if (enemyCivCentre)
				enemyCount += 500;
			if (!enemyCount || enemyCount < max)
				continue;
			max = enemyCount;
			enemyPlayer = i;
		}
		if (attack.targetPlayer === undefined)
			this.currentEnemyPlayer = enemyPlayer;
		return enemyPlayer;
	}

	/**
	 * Target the player with the most advanced wonder.
	 * TODO currently the first built wonder is kept, should chek on the minimum wonderDuration left instead.
	 */
	getWonderEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		let enemyPlayer;
		let enemyWonder;
		let moreAdvanced;
		for (const wonder of gameState.getEnemyStructures().filter(filters.byClass("Wonder")).values())
		{
			if (wonder.owner() === 0)
				continue;
			const progress = wonder.foundationProgress();
			if (progress === undefined)
			{
				enemyWonder = wonder;
				break;
			}
			// only remember this wonder if it is the most advanced one so far
			if (moreAdvanced === undefined || progress >= moreAdvanced)
			{
				enemyWonder = wonder;
				moreAdvanced = progress;
			}
		}
		if (enemyWonder)
		{
			enemyPlayer = enemyWonder.owner();
			if (attack.targetPlayer === undefined)
				this.currentEnemyPlayer = enemyPlayer;
		}
		return enemyPlayer;
	}

	/**
	 * Target the player with the most relics (including gaia).
	 */
	getRelicEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		let enemyPlayer;
		const allRelics = gameState.updatingGlobalCollection("allRelics", filters.byClass("Relic"));
		let maxRelicsOwned = 0;
		for (let iIndex = 0; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
		{
			const i = playerId(iIndex);
			if (!gameState.isPlayerEnemy(i) || this.defeated[i] ||
			    i === 0 && !gameState.ai.HQ.victoryManager.tryCaptureGaiaRelic)
				continue;

			const relicsCount = allRelics.filter((relic) => relic.owner() === i).length;
			if (relicsCount <= maxRelicsOwned)
				continue;
			maxRelicsOwned = relicsCount;
			enemyPlayer = i;
		}
		if (enemyPlayer !== undefined)
		{
			if (attack.targetPlayer === undefined)
				this.currentEnemyPlayer = enemyPlayer;
			if (enemyPlayer === 0)
				gameState.ai.HQ.victoryManager.resetCaptureGaiaRelic(gameState);
		}
		return enemyPlayer;
	}

	/** f.e. if we have changed diplomacy with another player. */
	cancelAttacksAgainstPlayer(gameState: CommonGameState, player: PlayerId): void
	{
		for (const attack of plansIn(this.upcomingAttacks))
			if (attack.targetPlayer === player)
				attack.targetPlayer = undefined;

		for (const attackType of ATTACK_TYPES)
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

	raidTargetEntity(gameState: CommonGameState, ent: CommonEntity): AttackPlan | undefined
	{
		const data = { "target": ent };
		const attackPlan = new AttackPlan(gameState, this.Config, this.totalNumber,
			AttackPlan.TYPE_RAID, data, false);
		if (attackPlan.failed)
			return undefined;
		debugWarn(this.Config, 1, () => "Military Manager: Raiding plan " + this.totalNumber);
		this.raidNumber++;
		this.totalNumber++;
		attackPlan.init(gameState);
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
			if (!attack.position)	// this attack may be inside a transport
				continue;
			if (SquareVectorDistance(pos, attack.position) < dist*dist)
				num += attack.unitCollection.length;
		}
		return num;
	}

	/**
	 * Switch defense armies into an attack one against the given target
	 * data.range: transform all defense armies inside range of the target into a new attack
	 * data.armyID: transform only the defense army ID into a new attack
	 * data.uniqueTarget: the attack will stop when the target is destroyed or captured
	 */
	switchDefenseToAttack(gameState: CommonGameState, target: CommonEntity, data: { range?: number; armyID?: ArmyId; uniqueTarget?: boolean }): boolean
	{
		if (!target || !target.position())
			return false;
		if (!data.range && !data.armyID)
		{
			aiWarn(" attackManager.switchDefenseToAttack inconsistent data " + uneval(data));
			return false;
		}
		const attackData = data.uniqueTarget ? { "uniqueTargetId": target.id() } : undefined;
		const pos = target.position();
		const attackType = AttackPlan.TYPE_DEFAULT;
		const attackPlan = new AttackPlan(gameState, this.Config, this.totalNumber, attackType, attackData,
			false);
		if (attackPlan.failed)
			return false;
		this.totalNumber++;
		attackPlan.init(gameState);
		this.startedAttacks[attackType].push(attackPlan);

		const targetAccess = getLandAccess(gameState, target);
		for (const army of gameState.ai.HQ.defenseManager.armies)
		{
			if (data.range)
			{
				army.recalculatePosition(gameState);
				if (SquareVectorDistance(pos, army.foePosition) > data.range * data.range)
					continue;
			}
			// If range is not given, the entry check ensured armyID is set.
			else if (army.ID !== data.armyID)
				continue;

			while (army.foeEntities.length > 0)
				army.removeFoe(gameState, army.foeEntities[0]);
			while (army.ownEntities.length > 0)
			{
				const unitId = army.ownEntities[0];
				army.removeOwn(gameState, unitId);
				const unit = gameState.getEntityById(unitId);
				if (!unit)
					continue;
				// the original ORed in "transport metadata exists" here, but
				// isAvailableUnit below always rejects transport-marked units, so the
				// clause could never lead to an enlistment and was dropped
				if (unit.position() && getLandAccess(gameState, unit) === targetAccess &&
					attackPlan.isAvailableUnit(gameState, unit))
				{
					unit.setMetadata(PlayerID, "plan", attackPlan.name);
					unit.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
					attackPlan.unitCollection.updateEnt(unit);
				}
			}
		}
		if (!attackPlan.unitCollection.hasEntities())
		{
			attackPlan.Abort(gameState);
			return false;
		}
		for (const unit of attackPlan.unitCollection.values())
			unit.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
		attackPlan.targetPlayer = target.owner();
		attackPlan.targetPos = pos;
		attackPlan.target = target;
		attackPlan.changeState(AttackPlan.STATE_UNEXECUTED, AttackPlan.STATE_ARRIVED);
		return true;
	}

	Serialize(): SerializedAttackManager
	{
		const properties = {
			"totalNumber": this.totalNumber,
			"attackNumber": this.attackNumber,
			"rushNumber": this.rushNumber,
			"raidNumber": this.raidNumber,
			"debugTime": this.debugTime,
			"maxRushes": this.maxRushes,
			"rushSize": this.rushSize,
			"currentEnemyPlayer": this.currentEnemyPlayer,
			"defeated": this.defeated
		};

		const upcomingAttacks = byAttackType(type => this.upcomingAttacks[type].map(attack => attack.Serialize()));
		const startedAttacks = byAttackType(type => this.startedAttacks[type].map(attack => attack.Serialize()));

		return { "properties": properties, "upcomingAttacks": upcomingAttacks, "startedAttacks": startedAttacks };
	}

	Deserialize(gameState: CommonGameState, data: SerializedAttackManager): void
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
		{
			const attack = new AttackPlan(gameState, this.Config, dataAttack.properties.name,
				undefined, undefined, true);
			attack.Deserialize(gameState, dataAttack);
			attack.init(gameState);
			return attack;
		};
		this.upcomingAttacks = byAttackType(type => data.upcomingAttacks[type].map(restore));
		this.startedAttacks = byAttackType(type => data.startedAttacks[type].map(restore));
	}
}
