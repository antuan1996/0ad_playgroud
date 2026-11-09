/**
 * The town's attacks (`gameState.ai.town.attacks`, part of execution/town.ts): what the attack plans and transports
 * ask of the attack manager — the plans under way and in preparation, the units that left a plan, the siege sent
 * ahead, the defeated players, whom to attack, and the enemies on each land. It reaches the attack manager only
 * through AttackHQ.
 */
import type { AttackType } from "./attackConstants.ts";
import type { AttackPlan } from "./attackPlan.ts";

/** What the attacks desk asks of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface AttackHQ
{
	readonly attackManager: {
		readonly startedAttacks: Record<AttackType, AttackPlan[]>;
		readonly outOfPlan: CommonEntityCollection;
		readonly defeated: Readonly<Record<number, boolean>>;
		readonly bombingAttacks: ReadonlyMap<EntityId, Set<EntityId>>;
		getPlan(planName: UnitPlan | undefined): AttackPlan | undefined;
		getAttackInPreparation(type: AttackType): AttackPlan | undefined;
		getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined;
		enemiesByLand(gameState: CommonGameState): ReadonlyMap<AccessIndex, readonly CommonPlacedEntity[]>;
		splitLocalFights(gameState: CommonGameState, leaving: AttackPlan, targetLand: AccessIndex | undefined): void;
	};
}

export class AttackDesk
{
	private readonly hq: AttackHQ;

	constructor(hq: AttackHQ)
	{
		this.hq = hq;
	}

	/** the attacks under way, by type */
	get startedAttacks(): Readonly<Record<AttackType, readonly AttackPlan[]>>
	{
		return this.hq.attackManager.startedAttacks;
	}

	/** units that left a plan, ready for the next one */
	get outOfPlan(): CommonEntityCollection
	{
		return this.hq.attackManager.outOfPlan;
	}

	/** the siege units sent ahead against a target, by target */
	get bombingAttacks(): ReadonlyMap<EntityId, Set<EntityId>>
	{
		return this.hq.attackManager.bombingAttacks;
	}

	/** Whether the player was found defeated */
	isDefeated(player: PlayerId): boolean
	{
		return !!this.hq.attackManager.defeated[player];
	}

	getPlan(planName: UnitPlan | undefined): AttackPlan | undefined
	{
		return this.hq.attackManager.getPlan(planName);
	}

	getAttackInPreparation(type: AttackType): AttackPlan | undefined
	{
		return this.hq.attackManager.getAttackInPreparation(type);
	}

	/** the player an attack should go for */
	getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined
	{
		return this.hq.attackManager.getEnemyPlayer(gameState, attack);
	}

	/** the enemies' entities on each land, counted once a turn */
	enemiesByLand(gameState: CommonGameState): ReadonlyMap<AccessIndex, readonly CommonPlacedEntity[]>
	{
		return this.hq.attackManager.enemiesByLand(gameState);
	}

	/** the soldiers of a leaving plan beside enemies on another land stay there, as attacks of their own */
	splitLocalFights(gameState: CommonGameState, leaving: AttackPlan, targetLand: AccessIndex | undefined): void
	{
		this.hq.attackManager.splitLocalFights(gameState, leaving, targetLand);
	}
}
