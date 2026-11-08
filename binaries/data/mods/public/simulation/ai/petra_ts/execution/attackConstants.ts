import type { AttackPlan } from "./attackPlan.ts";
/**
 * An attack plan's constants (execution/attackPlan.ts keeps them as AttackPlan's statics too): what a preparation
 * step returns, the siege state of its build orders, how far it answers a hit while gathering, its states and its
 * types. Apart from the class so that the modules of its parts read them without importing it.
 */

/** What a preparation step returns: the plan fails, keeps preparing, or starts. */
export const PREPARATION_FAILED = 0;
export const PREPARATION_KEEP_GOING = 1;
export const PREPARATION_START = 2;

/** Whether siege was looked for: not yet, no trainer for it (look again later), or added to the build orders. */
export const SIEGE_NOT_TESTED = 0;
export const SIEGE_NO_TRAINER = 1;
export const SIEGE_ADDED = 2;

/** How far from a unit hit the plan's units bound for a ship answer, while it gathers at its rally point (answerAttacks). */
export const ANSWER_RANGE = 60;

export const STATE_UNEXECUTED = "unexecuted";
export const STATE_COMPLETING = "completing";
export const STATE_WALKING = "walking";
export const STATE_TRANSPORTING = "transporting";
export const STATE_ARRIVED = "arrived";
/** At the target: the units fight what they find. */
export const STATE_ATTACKING = "";

export const TYPE_DEFAULT = "Attack";
export const TYPE_HUGE_ATTACK = "HugeAttack";
export const TYPE_RAID = "Raid";
export const TYPE_RUSH = "Rush";

/** The four kinds of attack plan, in the order the attack manager keeps them. */
export type AttackType = "Rush" | "Raid" | "Attack" | "HugeAttack";

export const ATTACK_TYPES: readonly AttackType[] = ["Rush", "Raid", "Attack", "HugeAttack"];

/** Every plan of the records, type by type in ATTACK_TYPES' order; lazy, as the nested loops it replaces were. */
export function* plansIn(records: Record<AttackType, AttackPlan[]>): Generator<AttackPlan>
{
	for (const type of ATTACK_TYPES)
	{
		yield* records[type];
	}
}
/** How near its rally point a withdrawing army stops, past the anchor's footprint when it is a base. */
export const WITHDRAW_RANGE = 15;
