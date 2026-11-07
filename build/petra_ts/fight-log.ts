/**
 * Scores the fight estimator (decision/fightEstimate.ts, PLAN.md §6.3.1)
 * against the fights of match.sh -b (fights.txt, bot-state.js logFights):
 *
 *   node build/petra_ts/fight-log.ts <match dir | batch dir> [--after 30|60|120] [--worst N] [--variants]
 *
 * A fight's real winner is the side that lost the smaller share of its units
 * (dead or taken) by --after seconds (default 120), nobody if the shares are
 * equal. Printed: how often the estimate named it, by kind and by size of
 * fight (the smaller side's units); how much of our army the estimate left
 * against what was left, where it named the winner right; and the worst misses.
 * The calibration's exit (PLAN.md §6.3.3): right in 75% of the fights of ten
 * or more units a side.
 *
 * --variants re-estimates every fight from its logged sides (each side by
 * template and distance band, fightstats.txt's stats) with the port's own
 * estimator under other choices of who fights: only the units within 20 or
 * 40 m of the other side, the far ones weighed less, no towers, the head
 * count alone; and prints each one's accuracy, by 30, 60 and 120 s.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { CombatStats } from "../../binaries/data/mods/public/simulation/ai/petra_ts/adapter/templateData.ts";
import type {
	FightGroup,
	FightSide,
} from "../../binaries/data/mods/public/simulation/ai/petra_ts/decision/fightEstimate.ts";

/** One FIGHTLOG line. */
type Fight = {
	t: number;
	player: number;
	kind: string;
	id: number;
	ours: number;
	theirs: number;
	estimate: { winner: "ours" | "theirs" | "none"; ourLeft: number; theirLeft: number; seconds: number | string; };
	lost: Record<string, [number, number]>;
	/** by "owner:template", per distance band (20, 40, 80 m, farther): count and summed health level */
	oursBy?: Record<string, Array<[number, number]>>;
	theirsBy?: Record<string, Array<[number, number]>>;
	towersBy?: { ours: Record<string, number>; theirs: Record<string, number>; };
};
type Scored = Fight & { game: string; real: "ours" | "theirs" | "none"; ourLeftReal: number; };

const BINS: Array<[number, number]> = [[5, 9], [10, 19], [20, 49], [50, Infinity]];

/** The fights.txt files of a match folder or of a batch's games. */
function fightFiles(dir: string): Array<[string, string]>
{
	const single = join(dir, "fights.txt");
	if (existsSync(single))
	{
		return [["match", single]];
	}
	const games = join(dir, "games");
	if (!existsSync(games))
	{
		throw new Error(`no fights.txt in ${dir} (record with match.sh -b, or batch.ts --bot-state)`);
	}
	return readdirSync(games).sort().map((g): [string, string] => [g, join(games, g, "fights.txt")]).filter(([, f]) =>
		existsSync(f)
	);
}

/** The fights of a text, each with its real winner by `after` seconds. */
export function scoreFights(game: string, text: string, after: number): Scored[]
{
	const scored: Scored[] = [];
	for (const line of text.split("\n"))
	{
		if (!line.trim())
		{
			continue;
		}
		const fight: Fight = JSON.parse(line);
		const lost = fight.lost?.[String(after)];
		if (!lost || fight.kind === "error")
		{
			continue;
		}
		const ourShare = lost[0] / fight.ours;
		const theirShare = lost[1] / fight.theirs;
		const real = ourShare < theirShare ? "ours" : ourShare > theirShare ? "theirs" : "none";
		scored.push({ ...fight, game, real, ourLeftReal: 1 - ourShare });
	}
	return scored;
}

const pct = (n: number, of: number): string => of ? `${Math.round(100 * n / of)}%` : "-";

/** The accuracy of a set of fights: right, and of how many. */
function accuracy(fights: Scored[]): string
{
	const right = fights.filter((f) => f.estimate.winner === f.real).length;
	return `${right}/${fights.length} right (${pct(right, fights.length)})`;
}

/** The report for a match or batch folder. */
export function report(dir: string, after = 120, worst = 8): string
{
	const fights: Scored[] = [];
	for (const [game, file] of fightFiles(dir))
	{
		fights.push(...scoreFights(game, readFileSync(file, "utf8"), after));
	}
	const out: string[] = [];
	out.push(`${fights.length} fights, real winner by ${after} s: ${accuracy(fights)}`);
	for (const kind of ["attack", "defense"])
	{
		out.push(`  ${kind}: ${accuracy(fights.filter((f) => f.kind === kind))}`);
	}
	for (const [low, high] of BINS)
	{
		const inBin = fights.filter((f) => Math.min(f.ours, f.theirs) >= low && Math.min(f.ours, f.theirs) <= high);
		out.push(`  ${low}${high === Infinity ? "+" : "-" + high} units a side: ${accuracy(inBin)}`);
	}
	const big = fights.filter((f) => Math.min(f.ours, f.theirs) >= 10);
	out.push(`  ten or more a side (the exit, 75%): ${accuracy(big)}`);
	const named = fights.filter((f) => f.estimate.winner === f.real && f.real === "ours");
	if (named.length)
	{
		const meanEstimate = named.reduce((s, f) => s + f.estimate.ourLeft, 0) / named.length;
		const meanReal = named.reduce((s, f) => s + f.ourLeftReal, 0) / named.length;
		out.push(
			`our army left where we won as estimated: estimate ${meanEstimate.toFixed(2)}, real ` +
				`${meanReal.toFixed(2)} (${named.length} fights)`,
		);
	}
	const misses = fights.filter((f) => f.estimate.winner !== f.real).sort((a, b) =>
		Math.min(b.ours, b.theirs) - Math.min(a.ours, a.theirs)
	);
	out.push("");
	out.push("largest misses:");
	for (const f of misses.slice(0, worst))
	{
		const lost = f.lost[String(after)];
		out.push(
			`  ${f.game} p${f.player} ${f.kind} ${f.id} at ${Math.round(f.t / 6) / 10} min: ${f.ours} against ` +
				`${f.theirs}, estimate ${f.estimate.winner} (ours left ${f.estimate.ourLeft}, theirs ` +
				`${f.estimate.theirLeft}), lost ${lost[0]} and ${lost[1]}: ${f.real}`,
		);
	}
	return out.join("\n");
}

/** A model of who fights: how much each distance band counts, and whether the towers do. */
type Variant = { name: string; bandWeights: number[]; towers: boolean; headCount?: boolean; };

const VARIANTS: Variant[] = [
	{ name: "the estimator (all units, towers)", bandWeights: [1, 1, 1, 1], towers: true },
	{ name: "no towers", bandWeights: [1, 1, 1, 1], towers: false },
	{ name: "within 80 m", bandWeights: [1, 1, 1, 0], towers: true },
	{ name: "within 40 m", bandWeights: [1, 1, 0, 0], towers: true },
	{ name: "within 20 m", bandWeights: [1, 0, 0, 0], towers: true },
	{ name: "the far weighed less (1, 1, 0.5, 0.25)", bandWeights: [1, 1, 0.5, 0.25], towers: true },
	{ name: "the head count alone", bandWeights: [1, 1, 1, 1], towers: false, headCount: true },
];

/** A side of a logged fight under a variant. */
function sideOf(
	by: Record<string, Array<[number, number]>>,
	towers: Record<string, number>,
	stats: Map<string, CombatStats>,
	variant: Variant,
): FightSide
{
	const units: FightGroup[] = [];
	for (const key in by)
	{
		const unitStats = stats.get(key);
		if (!unitStats)
		{
			continue;
		}
		let count = 0;
		let health = 0;
		by[key].forEach(([n, hp], band) =>
		{
			count += n * variant.bandWeights[band];
			health += hp * variant.bandWeights[band];
		});
		if (count > 0)
		{
			units.push({ stats: unitStats, count, hpFraction: health / count });
		}
	}
	const shooters: FightGroup[] = [];
	for (const key in variant.towers ? towers : {})
	{
		const towerStats = stats.get(key);
		if (towerStats)
		{
			shooters.push({ stats: towerStats, count: towers[key], hpFraction: 1 });
		}
	}
	return { units, shooters };
}

/** The variants' accuracy on a folder's fights, by 30, 60 and 120 s. */
async function variants(dir: string): Promise<string>
{
	// the estimator matches bonus classes with the game's own MatchesClassList (globalscripts/Templates.js)
	const scope: Record<string, unknown> = globalThis;
	scope.MatchesClassList = (classes: string[], match: string) =>
		match.split(/\s+/).some((sub) =>
			sub.split("+").every((c) => c[0] === "!" ? !classes.includes(c.slice(1)) : classes.includes(c))
		);
	const { estimateFight } = await import(
		"../../binaries/data/mods/public/simulation/ai/petra_ts/decision/fightEstimate.ts"
	);
	const out: string[] = [];
	const rows: Array<{ fight: Fight; stats: Map<string, CombatStats>; }> = [];
	for (const [game, file] of fightFiles(dir))
	{
		const statsFile = join(file, "..", "fightstats.txt");
		const stats = new Map<string, CombatStats>();
		for (const line of existsSync(statsFile) ? readFileSync(statsFile, "utf8").split("\n") : [])
		{
			if (line.trim())
			{
				const entry: { key: string; stats: CombatStats; } = JSON.parse(line);
				stats.set(entry.key, entry.stats);
			}
		}
		for (const fight of scoreFights(game, readFileSync(file, "utf8"), 120))
		{
			if (fight.oursBy && fight.theirsBy && fight.towersBy)
			{
				rows.push({ fight, stats });
			}
		}
	}
	out.push(
		`${rows.length} fights with their sides logged (ten or more a side: ` + `${
			rows.filter(({ fight }) => Math.min(fight.ours, fight.theirs) >= 10).length
		})`,
	);
	out.push("variant                                      30 s   60 s  120 s   (ten or more a side: 30, 60, 120 s)");
	for (const variant of VARIANTS)
	{
		const cells: string[] = [];
		for (const big of [false, true])
		{
			for (const after of ["30", "60", "120"])
			{
				let right = 0;
				let n = 0;
				for (const { fight, stats } of rows)
				{
					const lost = fight.lost[after];
					if (!lost || big && Math.min(fight.ours, fight.theirs) < 10)
					{
						continue;
					}
					const ourShare = lost[0] / fight.ours;
					const theirShare = lost[1] / fight.theirs;
					if (ourShare === theirShare)
					{
						continue;
					}
					const ours = sideOf(requireBy(fight.oursBy), fight.towersBy?.ours ?? {}, stats, variant);
					const theirs = sideOf(requireBy(fight.theirsBy), fight.towersBy?.theirs ?? {}, stats, variant);
					const winner = variant.headCount ?
						(count(ours) > count(theirs) ? "ours" : count(ours) < count(theirs) ? "theirs" : "none") :
						estimateFight(ours, theirs).winner;
					++n;
					if (winner === (ourShare < theirShare ? "ours" : "theirs"))
					{
						++right;
					}
				}
				cells.push(pct(right, n).padStart(5));
			}
		}
		out.push(`${variant.name.padEnd(44)} ${cells.slice(0, 3).join("  ")}   (${cells.slice(3).join(", ")})`);
	}
	out.push("(fights whose two sides lost the same share are left out: they say nothing of who won)");
	return out.join("\n");
}

const requireBy = (by: Fight["oursBy"]): Record<string, Array<[number, number]>> => by ?? {};
const count = (side: FightSide): number => side.units.reduce((sum, g) => sum + g.count, 0);

if (import.meta.main)
{
	const args = process.argv.slice(2);
	const value = (flag: string): string | undefined =>
	{
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const dir = args.find((a, i) => !a.startsWith("--") && !["--after", "--worst"].includes(args[i - 1]));
	if (!dir)
	{
		console.error("usage: node build/petra_ts/fight-log.ts <match dir | batch dir> [--after 60|120] [--worst N]");
		process.exit(2);
	}
	if (args.includes("--variants"))
	{
		console.log(await variants(dir));
	}
	else
	{
		console.log(report(dir, Number(value("--after") ?? 120), Number(value("--worst") ?? 8)));
	}
}
