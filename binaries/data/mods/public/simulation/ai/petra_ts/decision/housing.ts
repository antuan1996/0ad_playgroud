/**
 * The houses (stage 5's economy module, PLAN.md §6.1): when to plan one,
 * when a planned one may be paid, and how urgently, over the census
 * (world/census.ts). Petra's thresholds, lifted out of the headquarters and
 * the building plan unchanged; the house before the training queues is
 * stage 5's (FINDINGS §22).
 */
import type { Census } from "../world/census.ts";

/** Free slots below which the house queue goes before the training queues. */
export const TIGHT_SLOTS = 5;

/** Whether another house goes into the queue: three planned, five past 80 units. */
export function planAnotherHouse(planned: number, population: number): boolean
{
	return planned < 3 || planned < 5 && population > 80;
}

/**
 * Whether a planned house may be paid now: once the room left, counting what
 * our foundations will add, falls to 10 free slots (15 past 30 units, 21 past
 * 55; 10 while saving), and never at the game's cap.
 */
export function houseNeeded(census: Readonly<Census>, saving: boolean): boolean
{
	if (census.max <= census.limit)
		return false;
	const free = census.limit - census.population + census.coming;
	if (saving)
		return free <= 10;
	if (census.population > 55)
		return free <= 21;
	if (census.population > 30)
		return free <= 15;
	return free <= 10;
}

/**
 * The house queue's priority when slots run short: before the training
 * queues, since a house blocks every unit after it; Petra's double priority
 * stayed below the citizen soldiers', which took the wood (FINDINGS §22).
 */
export function urgentHousePriority(priorities: Readonly<Record<"house" | "villager" | "citizenSoldier", number>>): number
{
	return Math.max(2 * priorities.house, Math.max(priorities.villager, priorities.citizenSoldier) + 1);
}
