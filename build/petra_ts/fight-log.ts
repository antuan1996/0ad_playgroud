/**
 * Scores the fight estimator (decision/fightEstimate.ts, PLAN.md §6.3.1)
 * against the fights of match.sh -b (fights.txt, bot-state.js logFights):
 *
 *   node build/petra_ts/fight-log.ts <match dir | batch dir> [--after 60|120] [--worst N]
 *
 * A fight's real winner is the side that lost the smaller share of its units
 * (dead or taken) by --after seconds (default 120), nobody if the shares are
 * equal. Printed: how often the estimate named it, by kind and by size of
 * fight (the smaller side's units); how much of our army the estimate left
 * against what was left, where it named the winner right; and the worst misses.
 * The calibration's exit (PLAN.md §6.3.3): right in 75% of the fights of ten
 * or more units a side.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
	console.log(report(dir, Number(value("--after") ?? 120), Number(value("--worst") ?? 8)));
}
