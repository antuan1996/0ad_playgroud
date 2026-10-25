/**
 * Summarises a match recorded by match.sh, from its game.log and the replay.
 *
 *   node build/petra_ts/match-report.ts <match dir> <player id> <name> <player id> <name>
 *
 * Prints the end of match.txt (settings the game setup picked, game time,
 * result, a table of each bot's statistics, errors and warnings, the replay and
 * a fingerprint) and writes the statistics NonVisualTrigger.js printed to
 * <match dir>/statistics.json.
 *
 * The fingerprint hashes the game time of the decision and the statistics: two
 * runs with the same seeds and code play the same game and give the same
 * fingerprint, in visual and non-visual mode alike.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Counts = Record<string, number>;

interface PlayerStatistics
{
	playerID: number;
	playerState: string;
	statistics: Record<string, number | Counts>;
}

const [dir, ...nameArgs] = process.argv.slice(2);
if (!dir || nameArgs.length != 4)
{
	console.error("usage: node match-report.ts <match dir> <player id> <name> <player id> <name>");
	process.exit(2);
}
const names = new Map([[Number(nameArgs[0]), nameArgs[1]], [Number(nameArgs[2]), nameArgs[3]]]);
const log = readFileSync(join(dir, "game.log"), "utf8");
const lines = log.split("\n");

const name = (id: number): string => names.get(id) ?? `player ${id}`;
const botName = (id: number): string => `${name(id)} (player ${id})`;

// NonVisualTrigger.js prints one JSON object per player, from "{" to "}" at
// the start of a line, once the game is decided.
const players: PlayerStatistics[] = [];
for (let i = 0; i < lines.length; ++i)
{
	if (lines[i] != "{")
		continue;
	const end = lines.indexOf("}", i);
	if (end == -1)
		break;
	players.push(JSON.parse(lines.slice(i, end + 1).join("\n")));
	i = end;
}
players.sort((a, b) => a.playerID - b.playerID);
if (players.length)
	writeFileSync(join(dir, "statistics.json"), JSON.stringify(players, null, "\t") + "\n");

// MatchEnd.js prints the game time of each win and defeat. Failing those (the
// window was closed first), the non-visual engine prints "Turn N (length in
// ms)..." before each turn; the visual one prints nothing.
// Those with "players" also give the reason, like "wonder victory".
let decided: number | undefined;
const reasons = new Map<number, string>();
for (const match of log.matchAll(/^MATCHEND (.*)$/gm))
{
	const end: { time: number; players?: number[]; reason?: string } = JSON.parse(match[1]);
	decided = Math.max(decided ?? 0, end.time);
	for (const player of end.players ?? [])
		if (end.reason)
			reasons.set(player, end.reason);
}
let played = 0;
for (const match of log.matchAll(/^Turn \d+ \((\d+)\)\.\.\.$/gm))
	played += Number(match[1]);
const clock = (ms: number): string =>
	`${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const replay = /^Replay written to '(.*)'$/m.exec(log)?.[1];
const commands = replay && join(replay, "commands.txt");
if (commands && existsSync(commands))
{
	const start = readFileSync(commands, "utf8").split("\n", 1)[0];
	const settings = JSON.parse(start.replace(/^start /, "")).settings;
	const picked = [["biome", settings.Biome], ["placement", settings.PlayerPlacement],
		["daytime", settings.Daytime], ["landscape", settings.Landscape]]
		.filter(([, value]) => value !== undefined)
		.map(([name, value]) => `${name} ${value}`);
	if (picked.length)
		console.log(`picked by the game setup: ${picked.join(", ")}`);
}

if (decided !== undefined)
	console.log(`decided at ${clock(decided)} game time`);
else if (played)
	console.log(`played ${clock(played)} game time`);

if (players.length)
{
	console.log("result: " + players.map(p => `${botName(p.playerID)} ${p.playerState}` +
		(reasons.has(p.playerID) ? ` (${reasons.get(p.playerID)})` : "")).join(", "));
	// The "total" of the lost/killed/destroyed counters is never incremented
	// (StatisticsTracker.js): count the Unit and Structure classes instead.
	type Row = [string, (p: PlayerStatistics) => string | number];
	const count = (key: string, type: string) => (p: PlayerStatistics): number =>
	{
		const counts = p.statistics[key];
		return typeof counts == "object" ? counts[type] ?? 0 : 0;
	};
	const value = (key: string) => (p: PlayerStatistics): number =>
	{
		const statistic = p.statistics[key];
		return typeof statistic == "number" ? statistic : 0;
	};
	const resources = ["food", "wood", "stone", "metal"];
	const rows: Row[] = [
		["state", p => p.playerState],
		["units trained", count("unitsTrained", "Unit")],
		["  of which soldiers", p => count("unitsTrained", "Infantry")(p) + count("unitsTrained", "Cavalry")(p) +
			count("unitsTrained", "Champion")(p)],
		["units lost", count("unitsLost", "Unit")],
		["enemy units killed", count("enemyUnitsKilled", "Unit")],
		["buildings constructed", count("buildingsConstructed", "Structure")],
		["buildings lost", count("buildingsLost", "Structure")],
		["enemy buildings destroyed", count("enemyBuildingsDestroyed", "Structure")],
		["enemy buildings captured", count("buildingsCaptured", "Structure")],
		...resources.map((type): Row => [`${type} gathered`, count("resourcesGathered", type)]),
		["resources used", p => resources.reduce((sum, type) => sum + count("resourcesUsed", type)(p), 0)],
		["loot collected", value("lootCollected")],
		["map explored %", value("percentMapExplored")],
		["peak map controlled %", value("peakPercentMapControlled")]
	];
	const header = ["", ...players.map(p => name(p.playerID))];
	const table = [header, ...rows.map(([label, cell]) => [label, ...players.map(p => String(cell(p)))])];
	const widths = header.map((_, column) => Math.max(...table.map(row => row[column].length)));
	for (const row of table)
		console.log("  " + row.map((cell, column) =>
			column ? cell.padStart(widths[column] + 2) : cell.padEnd(widths[column])).join("").trimEnd());
}
else
	console.log("result: undecided (the game was closed before one bot defeated the other)");

// Errors and warnings, each distinct line once, most frequent first.
for (const level of ["ERROR", "WARNING"])
{
	const counts = new Map<string, number>();
	for (const line of lines)
		if (line.includes(level))
			counts.set(line, (counts.get(line) ?? 0) + 1);
	const count = [...counts.values()].reduce((sum, n) => sum + n, 0);
	console.log(`lines with ${level} in game.log: ${count}${count ? `, ${counts.size} distinct:` : ""}`);
	const listed = [...counts].sort((a, b) => b[1] - a[1]);
	for (const [line, n] of listed.slice(0, 10))
		console.log(`  ${n}x ${line.length > 200 ? line.slice(0, 200) + "..." : line}`);
	if (listed.length > 10)
		console.log(`  ... and ${listed.length - 10} more`);
}

console.log(`replay: ${replay ?? "none written"}`);
const fingerprint = createHash("sha256").update(`${decided}\n${JSON.stringify(players)}`).digest("hex").slice(0, 16);
console.log(`fingerprint: ${fingerprint} (the same seeds and code give the same fingerprint)`);
