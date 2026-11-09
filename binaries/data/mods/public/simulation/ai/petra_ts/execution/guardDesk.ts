/**
 * The town's guard (`gameState.ai.town.guard`, part of execution/town.ts): what the attack plans, transports and
 * defense armies ask of the defense and of the victory conditions — the enemy foundations to raid, the defense
 * armies, a shelter for a hurt unit, the units the victory conditions protect, and the gaia relics being raided.
 * It reaches the defense and victory managers only through GuardHQ.
 */
import type { DefenseArmy } from "./defenseArmy.ts";

/** What the guard asks of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface GuardHQ
{
	readonly defenseManager: {
		readonly targetList: readonly EntityId[];
		getArmy(partOfArmy: ArmyId): DefenseArmy | undefined;
		garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency?: boolean): boolean;
	};
	readonly victoryManager: {
		readonly criticalEnts: ReadonlyMap<EntityId, unknown>;
		isRelicRaided(relicId: EntityId): boolean;
		planRelicRaid(relicId: EntityId, plan: AttackPlanId): void;
	};
}

export class GuardDesk
{
	private readonly hq: GuardHQ;

	constructor(hq: GuardHQ)
	{
		this.hq = hq;
	}

	/** the enemy foundations whose builders we attacked, for the raids */
	get raidTargets(): readonly EntityId[]
	{
		return this.hq.defenseManager.targetList;
	}

	getArmy(partOfArmy: ArmyId): DefenseArmy | undefined
	{
		return this.hq.defenseManager.getArmy(partOfArmy);
	}

	/** a hurt unit sent into the nearest holder that heals it (any, in an emergency) */
	garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency?: boolean): boolean
	{
		return this.hq.defenseManager.garrisonAttackedUnit(gameState, unit, emergency);
	}

	/** Whether the victory conditions protect the unit (a hero in regicide, ...) */
	isCritical(id: EntityId): boolean
	{
		return this.hq.victoryManager.criticalEnts.has(id);
	}

	isRelicRaided(relicId: EntityId): boolean
	{
		return this.hq.victoryManager.isRelicRaided(relicId);
	}

	/** an attack plan that chose a gaia relic as its target raids it, alone */
	planRelicRaid(relicId: EntityId, plan: AttackPlanId): void
	{
		this.hq.victoryManager.planRelicRaid(relicId, plan);
	}
}
