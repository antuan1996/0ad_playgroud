import * as filters from "simulation/ai/common-api/filters.js";
import * as chat from "../adapter/chatHelper.ts";
import { debugWarn } from "../adapter/debug.ts";
import { plansIn, type AttackType } from "../execution/attackConstants.ts";
import { AttackDesk } from "../execution/attackDesk.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { Bombardment } from "../execution/bombardment.ts";
import { PLAN_RESERVE } from "../execution/unitPlan.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import type { BasesManager } from "./basesManager.ts";
import type { DefenseManager } from "./defenseManager.ts";
import {
	getEnemyPlayer as getEnemyPlayerFor,
	getRelicEnemyPlayer as getRelicEnemyPlayerFor,
} from "./enemySelection.ts";
import type { VictoryManager } from "./victoryManager.ts";

export type SerializedAttackManager = {
	properties: {
		attackNumber: number;
		rushNumber: number;
		raidNumber: number;
		maxRushes: number;
		rushSize: number[];
		currentEnemyPlayer: PlayerId | undefined;
		defeated: Record<number, boolean>;
	};
};

/**
 * What the attack manager asks of its sibling managers, through the
 * headquarters that owns them all: the defense's targets, whether
 * a base can still be founded, and the victory manager's gaia relics.
 */
export type AttackSiblings = {
	readonly defenseManager: Pick<DefenseManager, "targetList">;
	readonly basesManager: Pick<BasesManager, "hasPotentialBase">;
	readonly victoryManager: Pick<VictoryManager, "tryCaptureGaiaRelic" | "resetCaptureGaiaRelic">;
};

export class AttackManager
{
	Config: Config;
	readonly siblings: AttackSiblings;
	/** the attack plans, made, run and kept on the execution side (execution/attackDesk.ts): its desk in the town */
	readonly desk: AttackDesk;
	/** the siege sent to bomb meanwhile, on the execution side (execution/bombardment.ts) */
	readonly bombing = new Bombardment();
	/** Our units held in reserve, out of any plan */
	outOfPlan: CommonEntityCollection;

	attackNumber = 0;
	rushNumber = 0;
	raidNumber = 0;
	maxRushes = 0;
	rushSize: number[] = [];
	currentEnemyPlayer: PlayerId | undefined = undefined; // enemy player we are currently targeting
	defeated: Record<number, boolean> = {};

	constructor(config: Config, gameState: CommonGameState, siblings: AttackSiblings)
	{
		this.Config = config;
		this.siblings = siblings;
		this.desk = new AttackDesk(config, this);
		this.outOfPlan = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "plan", PLAN_RESERVE));
		this.outOfPlan.registerUpdates();
	}

	/** A saved attack manager (its plans are the town's, saved with it) */
	static restore(
		config: Config,
		gameState: CommonGameState,
		data: SerializedAttackManager,
		siblings: AttackSiblings,
	): AttackManager
	{
		const manager = new AttackManager(config, gameState, siblings);
		manager.resume(data);
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
			this.bombing.renameInBombings(evt.entity, evt.newentity);
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
				for (const attack of plansIn(this.desk.upcomingAttacks))
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
		for (const attack of plansIn(this.desk.upcomingAttacks))
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

	/**
	 * Some functions are run every turn
	 * Others once in a while
	 */
	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): void
	{
		if (this.Config.debug > 2 && gameState.ai.elapsedTime > this.desk.debugTime + 60)
		{
			this.desk.warnAttacks(gameState);
		}

		Engine.ProfileStart("attacks checkEvents");
		this.checkEvents(gameState, events);
		Engine.ProfileStop();
		Engine.ProfileStart("attacks upcoming");
		const unexecutedAttacks = this.desk.updateUpcomingAttacks(gameState, events);
		Engine.ProfileStop();
		Engine.ProfileStart("attacks started");
		this.desk.updateStartedAttacks(gameState, events);
		Engine.ProfileStop();

		// creating plans after updating because an aborted plan might be reused in that case.

		Engine.ProfileStart("attacks create");
		this.createAttacks(gameState, unexecutedAttacks);
		Engine.ProfileStop();

		if (unexecutedAttacks[AttackPlan.TYPE_RAID] === 0 && this.siblings.defenseManager.targetList.length)
		{
			let target;
			for (const targetId of this.siblings.defenseManager.targetList)
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
			this.bombing.assignBombers(gameState);
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
				!this.siblings.basesManager.hasPotentialBase()
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
		const attackPlan = this.desk.prepareAttack(gameState, AttackPlan.TYPE_RUSH, data);
		if (attackPlan)
		{
			debugWarn(
				this.Config,
				1,
				() => "Military Manager: Rushing plan " + attackPlan.name + " with maxRushes " + this.maxRushes,
			);
		}
		this.rushNumber++;
	}

	/**
	 * Whether a default or huge attack is wanted: none waits unexecuted, fewer are started than the population allows,
	 * and none is or we have room to train
	 */
	private wantsMainAttack(gameState: CommonGameState, unexecutedAttacks: Record<AttackType, number>): boolean
	{
		const started = this.desk.startedAttacks[AttackPlan.TYPE_DEFAULT].length +
			this.desk.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length;
		return unexecutedAttacks[AttackPlan.TYPE_DEFAULT] === 0 &&
			unexecutedAttacks[AttackPlan.TYPE_HUGE_ATTACK] === 0 &&
			started < Math.min(2, 1 + Math.round(gameState.getPopulationMax() / 100)) &&
			(started === 0 || gameState.getPopulationMax() - gameState.getPopulation() > 12);
	}

	/** A default attack, or a huge one after two attacks while none is started */
	private createMainAttack(gameState: CommonGameState): void
	{
		const type = this.attackNumber < 2 || this.desk.startedAttacks[AttackPlan.TYPE_HUGE_ATTACK].length > 0 ?
			AttackPlan.TYPE_DEFAULT :
			AttackPlan.TYPE_HUGE_ATTACK;
		const attackPlan = this.desk.prepareAttack(gameState, type);
		// the original wrote a write-only "attackPlansEncounteredWater" hack flag
		// on failure; nothing ever read it, so the port drops the dead write
		if (attackPlan)
		{
			debugWarn(this.Config, 1, () => "Military Manager: Creating the plan " + type + "  " + attackPlan.name);
		}
		this.attackNumber++;
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

	raidTargetEntity(gameState: CommonGameState, ent: CommonEntity): AttackPlan | undefined
	{
		const data = { target: ent };
		const attackPlan = this.desk.prepareAttack(gameState, AttackPlan.TYPE_RAID, data);
		if (!attackPlan)
		{
			return undefined;
		}
		debugWarn(this.Config, 1, () => "Military Manager: Raiding plan " + attackPlan.name);
		this.raidNumber++;
		return attackPlan;
	}

	Serialize(): SerializedAttackManager
	{
		const properties = {
			attackNumber: this.attackNumber,
			rushNumber: this.rushNumber,
			raidNumber: this.raidNumber,
			maxRushes: this.maxRushes,
			rushSize: this.rushSize,
			currentEnemyPlayer: this.currentEnemyPlayer,
			defeated: this.defeated,
		};

		return { properties: properties };
	}

	private resume(data: SerializedAttackManager): void
	{
		this.attackNumber = data.properties.attackNumber;
		this.rushNumber = data.properties.rushNumber;
		this.raidNumber = data.properties.raidNumber;
		this.maxRushes = data.properties.maxRushes;
		this.rushSize = data.properties.rushSize;
		this.currentEnemyPlayer = data.properties.currentEnemyPlayer;
		this.defeated = data.properties.defeated;
	}
}
