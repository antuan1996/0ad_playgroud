/**
 * The states a unit's `plan` metadata takes besides an attack plan's name
 * (UnitPlan in engine-api.d.ts), and how lending a unit changes it.
 */

/** Out of any plan: free for the next attack (the attack manager's `outOfPlan`). */
export const PLAN_RESERVE = -1;
/** Lent to a defense army, a garrison or a guard while it had a plan: back to the reserve when released. */
export const PLAN_LENT_FROM_PLAN = -2;
/** Lent the same way while it had no plan: back to no plan when released. */
export const PLAN_LENT_UNPLANNED = -3;

/** Whether the unit is lent out (defense, garrison, guard). */
export function isLent(plan: UnitPlan | undefined): boolean
{
	return plan === PLAN_LENT_FROM_PLAN || plan === PLAN_LENT_UNPLANNED;
}

/** The plan of a unit being lent: whether it had one decides what it returns to. */
export function lentPlan(plan: UnitPlan | undefined): UnitPlan
{
	return plan !== undefined ? PLAN_LENT_FROM_PLAN : PLAN_LENT_UNPLANNED;
}

/** The plan of a lent unit being released: the reserve if it had a plan, else none. */
export function releasedPlan(plan: UnitPlan | undefined): UnitPlan | undefined
{
	return plan === PLAN_LENT_FROM_PLAN ? PLAN_RESERVE : undefined;
}
