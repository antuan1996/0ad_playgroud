/**
 * Summarises the idle time of a match's players, from idle.txt
 * (maps/scripts/MatchIdle.js, match.sh -i):
 *
 *   node build/petra_ts/idle-log.ts <match dir>...
 *
 * Per player and kind of unit: the share of its units' time spent idle over
 * the game and by bands of ten game minutes, the mean number idle, the idle
 * spells by length (a spell is counted once it ends), and the longest spell
 * seen (the unit, its template and where it stood).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Counts = Record<string, number>;
interface IdleLine
{
	minute: number;
	player: number;
	name: string;
	idleNow: Counts;
	idleSeconds: Counts;
	aliveSeconds: Counts;
	spells: Record<string, Counts>;
	longest: Record<string, { id: number; seconds: number; template: string; x?: number; z?: number }>;
}

const CATEGORIES = ["Women", "CitizenSoldier", "Soldier", "Siege", "Ship", "Trader", "Other"];
const BANDS = ["<30", "30-60", "60-180", "180-600", ">600"];
const BAND_MINUTES = 10;

const dirs = process.argv.slice(2);
if (!dirs.length)
{
	console.error("usage: node build/petra_ts/idle-log.ts <match dir>...");
	process.exit(2);
}

const percent = (part: number, whole: number): string => whole ? `${(100 * part / whole).toFixed(1)}%` : "-";

for (const dir of dirs)
{
	const file = join(dir, "idle.txt");
	if (!existsSync(file))
	{
		console.error(`${dir}: no idle.txt (play the match with -i)`);
		continue;
	}
	const lines: IdleLine[] = readFileSync(file, "utf8").split("\n").filter(line => line.startsWith("{"))
		.map(line => JSON.parse(line));
	if (dirs.length > 1)
		console.log(`== ${dir}`);
	const byPlayer = new Map<number, IdleLine[]>();
	for (const line of lines)
		byPlayer.set(line.player, [...byPlayer.get(line.player) ?? [], line]);
	console.log(`idle time (units of each kind idle, not garrisoned; sampled every 5 s), ${BAND_MINUTES}-minute bands:`);
	for (const [player, series] of [...byPlayer].sort((a, b) => a[0] - b[0]))
	{
		const last = series[series.length - 1];
		console.log(`player ${player}, ${last.name} (to minute ${last.minute}):`);
		const categories = CATEGORIES.filter(cat => last.aliveSeconds[cat]);
		for (const cat of categories)
		{
			// the share in each band: the difference of the running totals at its ends
			const bands: string[] = [];
			let previous: IdleLine | undefined;
			for (let end = BAND_MINUTES; ; end += BAND_MINUTES)
			{
				const at = series.filter(line => line.minute <= end).at(-1);
				if (!at)
					break;
				const idle = (at.idleSeconds[cat] ?? 0) - (previous?.idleSeconds[cat] ?? 0);
				const alive = (at.aliveSeconds[cat] ?? 0) - (previous?.aliveSeconds[cat] ?? 0);
				bands.push(percent(idle, alive));
				previous = at;
				if (at === last)
					break;
			}
			const meanIdle = (last.idleSeconds[cat] ?? 0) / (60 * last.minute);
			const spells = BANDS.map(band => `${band} s ${last.spells[cat]?.[band] ?? 0}`).join(", ");
			const longest = last.longest[cat];
			console.log(`  ${cat.padEnd(15)} idle ${percent(last.idleSeconds[cat] ?? 0, last.aliveSeconds[cat]).padStart(6)}` +
				`, ${meanIdle.toFixed(1)} idle on average; by band: ${bands.join(" ")}`);
			console.log(`  ${"".padEnd(15)} spells: ${spells}`);
			if (longest)
				console.log(`  ${"".padEnd(15)} longest: ${Math.round(longest.seconds)} s, ${longest.template} #${longest.id}` +
					(longest.x !== undefined ? ` at (${longest.x}, ${longest.z})` : ""));
		}
	}
}
