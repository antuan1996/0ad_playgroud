/**
 * Scores the build-order planner's forecast (decision/economyForecast.ts,
 * PLAN.md §6.3.2) against what happened (forecasts.txt of match.sh -b,
 * bot-state.js logForecasts):
 *
 *   node build/petra_ts/forecast-log.ts <match dir | batch dir>
 *
 * For each horizon (60, 120, 180 s) and each count (support units, citizen
 * soldiers, population): the median and the 90th percentile of the forecast's
 * relative error, |forecast - actual| / actual, over the forecasts; and the
 * median signed error (a model too slow reads negative). The exit (PLAN.md
 * §6.3.2): within 10% at 180 s on the median.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Counts = { supports: number; soldiers: number; population: number; };
type Entry = { t: number; forecast: Record<string, Counts>; actual: Record<string, Counts>; };

/** The forecasts.txt files of a match folder or of a batch's games. */
function forecastFiles(dir: string): string[]
{
	const single = join(dir, "forecasts.txt");
	if (existsSync(single))
	{
		return [single];
	}
	const games = join(dir, "games");
	if (!existsSync(games))
	{
		throw new Error(`no forecasts.txt in ${dir} (record with match.sh -b, or batch.ts --bot-state)`);
	}
	return readdirSync(games).sort().map((g) => join(games, g, "forecasts.txt")).filter((f) => existsSync(f));
}

const quantile = (values: number[], q: number): number =>
{
	if (!values.length)
	{
		return NaN;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const pct = (v: number): string => Number.isNaN(v) ? "-" : `${Math.round(100 * v)}%`;

/** The report for a match or batch folder. */
export function report(dir: string): string
{
	const entries: Entry[] = [];
	for (const file of forecastFiles(dir))
	{
		for (const line of readFileSync(file, "utf8").split("\n"))
		{
			if (line.trim())
			{
				const entry: Entry & { error?: string; } = JSON.parse(line);
				if (!entry.error)
				{
					entries.push(entry);
				}
			}
		}
	}
	const out = [`${entries.length} forecasts`, "horizon  count        median error  90th  median signed"];
	for (const horizon of ["60", "120", "180"])
	{
		for (const count of ["supports", "soldiers", "population"] as const)
		{
			const errors: number[] = [];
			const signed: number[] = [];
			for (const entry of entries)
			{
				const actual = entry.actual[horizon]?.[count];
				const predicted = entry.forecast[horizon]?.[count];
				if (!actual || predicted === undefined)
				{
					continue;
				}
				errors.push(Math.abs(predicted - actual) / actual);
				signed.push((predicted - actual) / actual);
			}
			out.push(
				`${(horizon + " s").padEnd(8)} ${count.padEnd(12)} ${pct(quantile(errors, 0.5)).padStart(12)}  ` +
					`${pct(quantile(errors, 0.9)).padStart(4)}  ${pct(quantile(signed, 0.5)).padStart(13)}`,
			);
		}
	}
	return out.join("\n");
}

if (import.meta.main)
{
	const dir = process.argv[2];
	if (!dir)
	{
		console.error("usage: node build/petra_ts/forecast-log.ts <match dir | batch dir>");
		process.exit(2);
	}
	console.log(report(dir));
}
