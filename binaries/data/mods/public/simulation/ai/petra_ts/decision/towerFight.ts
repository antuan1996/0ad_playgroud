import { damagePerSecond, estimateFight, type FightGroup, type FightSide } from "./fightEstimate.ts";

/**
 * Whether our units near an enemy tower (or fortress, or any structure that shoots) should storm it or get out of
 * its reach: a narrow model over the units' stats, as fightEstimate.ts.
 *
 * - First, the enemy units guarding it: our units must win that fight, the tower's arrows on their side, and those
 *   of the enemy structures that cover it (the guards' shooters, estimateFight); what is left of us goes on.
 * - Then the tower itself: our damage per second against it falls as its arrows kill us, our hit points going down
 *   at its damage per second D, our damage with them: by t we have done `dps (t - D t² / 2H)` to it, H our hit
 *   points, which reaches its hit points before we are gone, or never (most is `dps H / 2D`). Those of ours that
 *   capture take its capture points the same way, less its regeneration: whichever comes first takes it. The
 *   structures covering it shoot all along.
 * - Units called from farther off (`arriving`) join when the last of them comes: until then those beside it take the
 *   arrows alone (they strike it meanwhile, which is not counted).
 * - We storm when we take it and keep at least STORM_MIN_LEFT of our strength; else we flee.
 *
 * Capture and damage are counted apart (soldiers that capture do not damage it meanwhile), whichever is quicker, and
 * the capture rate stays that of the tower's health when assessed: the model errs towards fleeing. Pure: no state; the same input gives the same
 * answer.
 */

/** Of our strength, what we keep at least for the storm to be worth it */
export const STORM_MIN_LEFT = 0.5;

/** Units called to the storm from farther off, and the seconds until the last of them comes */
export type Arriving = { side: FightSide; seconds: number; };

/** The tower: its stats, the arrows it shoots (default arrows and those of its garrison), its hit points left */
export type TowerGroup = FightGroup;

/**
 * Our capture of the tower, for those of ours that capture: their capture points a second at full strength, the
 * tower's regeneration a second (its own and its garrison's), the points its owner holds
 */
export type TowerCapture = { rate: number; regen: number; points: number; };

export type TowerFight = {
	verdict: "storm" | "flee";
	/** the fraction of our units' hit points left once the tower falls (0 when we flee) */
	ourFractionLeft: number;
	/** how long the storm takes, guards and tower, in seconds (Infinity when we cannot take it) */
	seconds: number;
};

/** Our hit points, their side's share each (structures not counted) */
function hitPoints(units: readonly FightGroup[]): number
{
	let hp = 0;
	for (const group of units)
	{
		hp += group.count * group.stats.hp * group.hpFraction;
	}
	return hp;
}

/**
 * The time for a side of `hp` hit points, losing `incoming` a second, to bring a target's `points` to nothing at
 * `rate` a second (falling as its units die) against the target's `regen` a second
 */
function stormSeconds(rate: number, hp: number, incoming: number, points: number, regen: number = 0): number
{
	if (rate <= regen || hp <= 0)
	{
		return Infinity;
	}
	if (incoming <= 0)
	{
		return points / (rate - regen);
	}
	// (rate - regen) t - rate incoming t² / 2hp = points, before t = hp / incoming
	const a = rate * incoming / (2 * hp);
	const b = rate - regen;
	const discriminant = b * b - 4 * a * points;
	return discriminant < 0 ? Infinity : (b - Math.sqrt(discriminant)) / (2 * a);
}

/** The damage a second that `shooters` do to our units, spread over them by their share of our hit points */
function incomingOn(units: readonly FightGroup[], shooters: readonly FightGroup[]): number
{
	const total = hitPoints(units);
	let incoming = 0;
	for (const group of units)
	{
		const share = group.count * group.stats.hp * group.hpFraction / total;
		for (const shooter of shooters)
		{
			incoming += shooter.count * share * damagePerSecond(shooter.stats, group.stats);
		}
	}
	return incoming;
}

/** Our side after `seconds` alone under the arrows of `shooters`, each group's hit points down by its share */
function afterArrows(ours: FightSide, shooters: readonly FightGroup[], seconds: number): FightSide
{
	const hp = hitPoints(ours.units);
	if (!hp || seconds <= 0)
	{
		return ours;
	}
	const kept = Math.max(0, 1 - incomingOn(ours.units, shooters) * seconds / hp);
	return {
		units: kept > 0 ? ours.units.map((group) => ({ ...group, hpFraction: group.hpFraction * kept })) : [],
		shooters: ours.shooters,
	};
}

/** The storm of the tower by `ours` (guards first, see the module's head): what is left of them and how long */
function storming(
	ours: FightSide,
	tower: TowerGroup,
	guards: FightSide,
	capture?: TowerCapture,
): { left: number; seconds: number; } | undefined
{
	if (!ours.units.length)
	{
		return undefined;
	}
	let left = 1;
	let seconds = 0;
	if (guards.units.length)
	{
		const fight = estimateFight(ours, { units: guards.units, shooters: [...guards.shooters, tower] });
		if (fight.winner !== "ours")
		{
			return undefined;
		}
		left = fight.ourFractionLeft;
		seconds = fight.seconds;
	}
	const hp = hitPoints(ours.units) * left;
	let dps = 0;
	for (const group of ours.units)
	{
		dps += group.count * left * damagePerSecond(group.stats, tower.stats);
	}
	// the arrows of the tower and of the structures covering it
	const incoming = incomingOn(ours.units, [tower, ...guards.shooters]);
	const stormTime = Math.min(
		stormSeconds(dps, hp, incoming, tower.stats.hp * tower.hpFraction),
		capture ? stormSeconds(capture.rate * left, hp, incoming, capture.points, capture.regen) : Infinity,
	);
	if (stormTime === Infinity)
	{
		return undefined;
	}
	return { left: left * (1 - incoming * stormTime / hp), seconds: seconds + stormTime };
}

/** Whether our units should storm the tower guarded by `guards`, or flee it (see the module's head) */
export function assessTower(
	ours: FightSide,
	tower: TowerGroup,
	guards: FightSide,
	capture?: TowerCapture,
	arriving?: Arriving,
): TowerFight
{
	const flee: TowerFight = { verdict: "flee", ourFractionLeft: 0, seconds: Infinity };
	const strength = hitPoints(ours.units) + hitPoints(arriving?.side.units ?? []);
	const wait = arriving?.seconds ?? 0;
	const side = arriving ?
		{
			units: [...afterArrows(ours, [tower, ...guards.shooters], wait).units, ...arriving.side.units],
			shooters: [...ours.shooters, ...arriving.side.shooters],
		} :
		ours;
	// of the strength we had when called, that of those who came: their capture too, as many of those beside it fell
	const came = strength ? hitPoints(side.units) / strength : 0;
	const fight = storming(side, tower, guards, capture && { ...capture, rate: capture.rate * came });
	if (!fight)
	{
		return flee;
	}
	const ourFractionLeft = fight.left * came;
	return ourFractionLeft >= STORM_MIN_LEFT ?
		{ verdict: "storm", ourFractionLeft, seconds: wait + fight.seconds } :
		{ ...flee, seconds: wait + fight.seconds };
}
