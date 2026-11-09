/**
 * The town's victory conditions (`gameState.ai.town.victory`, part of execution/town.ts): what the attack plans
 * ask of them — the units they protect, and the gaia relics being raided. The victory manager
 * (decision/victoryManager.ts) makes it, and it reaches the manager only through VictoryDecisions.
 */

/** What the victory desk asks of its victory manager */
export interface VictoryDecisions
{
	readonly criticalEnts: ReadonlyMap<EntityId, unknown>;
	isRelicRaided(relicId: EntityId): boolean;
	planRelicRaid(relicId: EntityId, plan: AttackPlanId): void;
}

export class VictoryDesk
{
	private readonly manager: VictoryDecisions;

	constructor(manager: VictoryDecisions)
	{
		this.manager = manager;
	}

	/** Whether the victory conditions protect the unit (a hero in regicide, ...) */
	isCritical(id: EntityId): boolean
	{
		return this.manager.criticalEnts.has(id);
	}

	isRelicRaided(relicId: EntityId): boolean
	{
		return this.manager.isRelicRaided(relicId);
	}

	/** an attack plan that chose a gaia relic as its target raids it, alone */
	planRelicRaid(relicId: EntityId, plan: AttackPlanId): void
	{
		this.manager.planRelicRaid(relicId, plan);
	}
}
