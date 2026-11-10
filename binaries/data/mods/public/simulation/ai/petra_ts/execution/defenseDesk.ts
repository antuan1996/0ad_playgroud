/**
 * The town's defense (`gameState.ai.town.defense`, part of execution/town.ts): what the attack plans, transports
 * and defense armies ask of the defense — the enemy foundations to raid, the defense armies, a shelter for a hurt
 * unit, whether an invading army is near a spot. The defense manager (decision/defenseManager.ts) makes it, and it reaches the manager only through
 * DefenseDecisions.
 */
import type { DefenseArmy } from "./defenseArmy.ts";

/** What the defense desk asks of its defense manager */
export interface DefenseDecisions
{
	readonly targetList: readonly EntityId[];
	getArmy(partOfArmy: ArmyId): DefenseArmy | undefined;
	garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency?: boolean): boolean;
	isNearInvadingArmy(pos: CommonPosition): boolean;
}

export class DefenseDesk
{
	private readonly manager: DefenseDecisions;

	constructor(manager: DefenseDecisions)
	{
		this.manager = manager;
	}

	/** the enemy foundations whose builders we attacked, for the raids */
	get raidTargets(): readonly EntityId[]
	{
		return this.manager.targetList;
	}

	getArmy(partOfArmy: ArmyId): DefenseArmy | undefined
	{
		return this.manager.getArmy(partOfArmy);
	}

	/** Whether a position is too near an invading army to build or work at */
	isNearInvadingArmy(pos: CommonPosition): boolean
	{
		return this.manager.isNearInvadingArmy(pos);
	}

	/** a hurt unit sent into the nearest holder that heals it (any, in an emergency) */
	garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency?: boolean): boolean
	{
		return this.manager.garrisonAttackedUnit(gameState, unit, emergency);
	}
}
