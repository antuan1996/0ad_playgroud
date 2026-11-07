import { combatStats, type CombatStats } from "../adapter/templateData.ts";

/**
 * Who wins a fight between two armies, and with how much left (PLAN.md §6.3.1): a narrow model over the units'
 * stats, Lanchester's square law over the two compositions.
 *
 * - A blow of a against b does `damage x 0.9^resistance` per damage type, times every bonus of the attack whose
 *   classes (and civ, if given) b matches, as the engine's Attack component does; a unit fights with its best
 *   attack against each target, every `repeatSeconds`.
 * - A side's damage per second is spread over the other side's units by their share of its hit points.
 * - The square law: each side's strength is its damage per second times its hit points; the stronger wins,
 *   keeping `sqrt(1 - weaker / stronger)` of its army, after `atanh(sqrt(weaker / stronger)) / k` seconds, k the
 *   square root of the two damages per second over the two hit points.
 * - A shooting structure adds the damage of its arrows to its side, not its hit points: an attacker wins the fight
 *   by killing the army, not the towers.
 *
 * Pure: no state, nothing saved; the same input gives the same answer.
 */

/** Units of one template (and owner) in a fight: their stats, how many, and the hit points they have left. */
export type FightGroup = { stats: CombatStats; count: number; hpFraction: number; };

/** A side of a fight: its units, and its shooting structures (a group's count being the arrows it shoots). */
export type FightSide = { units: readonly FightGroup[]; shooters: readonly FightGroup[]; };

/** The outcome: which side is left standing, the fraction of each army left, and how long it takes. */
export type FightEstimate = {
	winner: "ours" | "theirs" | "none";
	ourFractionLeft: number;
	theirFractionLeft: number;
	seconds: number;
};

/** The multiplier of an attack's bonuses against a target: the product of those whose classes and civ it matches. */
function bonusAgainst(bonuses: CombatStats["attacks"][number]["bonuses"], target: CombatStats): number
{
	let multiplier = 1;
	for (const bonus of bonuses)
	{
		if (bonus.Civ !== undefined && bonus.Civ !== target.civ)
		{
			continue;
		}
		if (bonus.Classes !== undefined && !MatchesClassList([...target.classes], bonus.Classes))
		{
			continue;
		}
		multiplier *= bonus.Multiplier;
	}
	return multiplier;
}

/** The damage per second one unit of `attacker` does to one of `target`, with its best attack. */
export function damagePerSecond(attacker: CombatStats, target: CombatStats): number
{
	let best = 0;
	for (const attack of attacker.attacks)
	{
		let blow = 0;
		for (const type in attack.damage)
		{
			blow += attack.damage[type] * Math.pow(0.9, target.resistance[type] ?? 0);
		}
		best = Math.max(best, blow * bonusAgainst(attack.bonuses, target) / attack.repeatSeconds);
	}
	return best;
}

/** A side's hit points: its units' (structures not counted). */
function hitPoints(side: FightSide): number
{
	let hp = 0;
	for (const group of side.units)
	{
		hp += group.count * group.stats.hp * group.hpFraction;
	}
	return hp;
}

/** A side's damage per second against the other side's units, spread over them by their share of its hit points. */
function damageAgainst(side: FightSide, enemy: FightSide): number
{
	const enemyHp = hitPoints(enemy);
	if (enemyHp <= 0)
	{
		return 0;
	}
	let dps = 0;
	for (const group of [...side.units, ...side.shooters])
	{
		for (const target of enemy.units)
		{
			const share = target.count * target.stats.hp * target.hpFraction / enemyHp;
			dps += group.count * share * damagePerSecond(group.stats, target.stats);
		}
	}
	return dps;
}

/** Who wins between our side and theirs (see the module's head). */
export function estimateFight(ours: FightSide, theirs: FightSide): FightEstimate
{
	const ourHp = hitPoints(ours);
	const theirHp = hitPoints(theirs);
	const ourDps = damageAgainst(ours, theirs);
	const theirDps = damageAgainst(theirs, ours);
	const ourStrength = ourDps * ourHp;
	const theirStrength = theirDps * theirHp;
	if (ourHp <= 0 || theirHp <= 0)
	{
		return {
			winner: ourHp > 0 ? "ours" : theirHp > 0 ? "theirs" : "none",
			ourFractionLeft: ourHp > 0 ? 1 : 0,
			theirFractionLeft: theirHp > 0 ? 1 : 0,
			seconds: 0,
		};
	}
	if (ourStrength === theirStrength)
	{
		const seconds = ourDps > 0 ? theirHp / ourDps : Infinity;
		return { winner: "none", ourFractionLeft: 0, theirFractionLeft: 0, seconds };
	}
	const oursWin = ourStrength > theirStrength;
	const ratio = oursWin ? theirStrength / ourStrength : ourStrength / theirStrength;
	const left = Math.sqrt(1 - ratio);
	const k = Math.sqrt(ourDps * theirDps / (ourHp * theirHp));
	const seconds = k > 0 ? Math.atanh(Math.sqrt(ratio)) / k : (oursWin ? theirHp / ourDps : ourHp / theirDps);
	return {
		winner: oursWin ? "ours" : "theirs",
		ourFractionLeft: oursWin ? left : 0,
		theirFractionLeft: oursWin ? 0 : left,
		seconds,
	};
}

/**
 * A side of a fight from entities: units grouped by owner and template (their stats read once, an owner's
 * technologies in them), and the structures with the arrows each shoots.
 */
export function fightSide(
	units: Iterable<CommonEntity>,
	shooters: Iterable<{ structure: CommonEntity; arrows: number; }> = [],
): FightSide
{
	const groups = new Map<string, FightGroup>();
	for (const ent of units)
	{
		const key = ent.owner() + ":" + ent.templateName();
		const group = groups.get(key);
		const health = ent.healthLevel();
		if (group)
		{
			group.hpFraction = (group.hpFraction * group.count + health) / (group.count + 1);
			++group.count;
		}
		else
		{
			groups.set(key, { stats: combatStats(ent), count: 1, hpFraction: health });
		}
	}
	const towers: FightGroup[] = [];
	for (const { structure, arrows } of shooters)
	{
		if (arrows > 0)
		{
			towers.push({ stats: combatStats(structure), count: arrows, hpFraction: 1 });
		}
	}
	return { units: [...groups.values()], shooters: towers };
}
