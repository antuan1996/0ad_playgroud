/**
 * Checks a match recorded by match.sh -t -l for anomalies in the bots' play:
 *
 *   node build/petra_ts/match-checks.ts <match dir>
 *
 * Reads match.txt, statistics.json, timeline.txt, commands.txt and notices.txt;
 * prints one
 * line per check and exits 1 if any fails. match.test.ts runs a fixed match and
 * asserts each check. The thresholds come from twenty matches of the port
 * against itself (tests/FINDINGS.md §11) with a wide margin: they flag a broken
 * bot, not a weak game.
 *
 * Every check reads what the engine records (statistics, the trigger scripts'
 * timeline, commands and notices), never the bot's internal state (-b,
 * botstate.txt): that changes with the bot's code, and a check on it would
 * break with a refactor rather than with a bug.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Check
{
	name: string;
	ok: boolean;
	detail: string;
}

interface Snapshot
{
	minute: number;
	player: number;
	pop: number;
	popLimit: number;
	resources: Record<string, number>;
	phase: string;
	classes: Record<string, number>;
	unitAI: Record<string, number>;
	idle: Record<string, number>;
}

interface PlayerStatistics
{
	playerID: number;
	playerState: string;
	statistics: Record<string, number | Record<string, number>>;
}

interface Notice
{
	time: number;
	players: number[];
	type: string;
	message?: string;
}

interface Command
{
	time: number;
	player: number;
	json: string;
	type: string;
	template?: string;
}

/** The thresholds: see the header. */
export const limits = {
	// the winner orders town phase by then (winners: minutes 13-19)
	townPhaseMinute: 25,
	// metal the winner gathers over the game (winners: 2400-15600)
	winnerMetal: 1000,
	// idle women: at most this many, or this share of all women, in two
	// snapshots in a row (seen: 6 of 32 once, between two tasks)
	idleSupport: 5,
	idleSupportShare: 0.15,
	// a stock of one resource this large while far below the population cap
	// means gatherers keep bringing what is never spent (the original's
	// removeSupply bug piled food into the millions)
	stockpile: 20000,
	stockpileBelowPop: 250,
	// population at minute 9 against minute 1 (seen: 4.5-5x)
	earlyGrowth: 2,
	// minutes in a row with no command while the player still has buildings
	// and this many units (a beaten side with 2 units and no resources has
	// nothing to order)
	silentMinutes: 2,
	silentPopulation: 5,
	// the same command in this many turns within two minutes is a stuck loop
	// (seen: 37, a builder re-sent to its foundation every update while it
	// walks home with its load); one turn is 0.2 s, an HQ update 1.6 s
	repeatedTurns: 60,
	repeatWindow: 2 * 60 * 1000,
	// commands of one player in one turn (seen: 379, a big battle)
	commandsPerTurn: 1000,
	// cancelled productions in a minute while below the population cap (seen:
	// 10; at the cap a besieged bot cancels ~50 a minute, which is left alone)
	cancelsPerMinute: 30,
	capMargin: 5,
	// minutes between ordering a phase and having it (research takes 1-2)
	phaseResearchMinutes: 4,
	// orders the game refused, per player and game (seen: 1; the bot checks
	// costs before it orders)
	refusals: 30
};

function readLines(dir: string, file: string): string[]
{
	return readFileSync(join(dir, file), "utf8").split("\n").filter(line => line.length);
}

function parseCommand(line: string): Command
{
	const [time, player] = line.split(" ", 2);
	const json = line.slice(time.length + player.length + 2);
	const command: { type: string; template?: string } = JSON.parse(json);
	return { "time": Number(time), "player": Number(player), json, "type": command.type, "template": command.template };
}

const minuteOf = (ms: number): number => Math.floor(ms / 60000);

export function checkMatch(dir: string): Check[]
{
	const report = readFileSync(join(dir, "match.txt"), "utf8");
	const players: PlayerStatistics[] = JSON.parse(readFileSync(join(dir, "statistics.json"), "utf8"));
	const timeline: Snapshot[] = readLines(dir, "timeline.txt").map(line => JSON.parse(line));
	const commands = readLines(dir, "commands.txt").map(parseCommand);
	const notices: Notice[] = readLines(dir, "notices.txt").map(line => JSON.parse(line));
	const ids = players.map(p => p.playerID);
	const winner = players.find(p => p.playerState == "won")?.playerID;
	const decidedAt = /^decided at (\d+):(\d+) game time$/m.exec(report);
	const decidedMinute = decidedAt ? Number(decidedAt[1]) : Infinity;
	const snapshots = (player: number): Snapshot[] => timeline.filter(t => t.player == player);
	const issued = (player: number): Command[] => commands.filter(c => c.player == player);

	const checks: Check[] = [];
	const check = (name: string, problems: string[], fine: string): void =>
	{
		checks.push({ name, "ok": !problems.length, "detail": problems.length ? problems.join("; ") : fine });
	};

	// The outcome.
	const errors = /^lines with ERROR in game.log: (\d+)/m.exec(report)?.[1];
	const warnings = /^lines with WARNING in game.log: (\d+)/m.exec(report)?.[1];
	check("no script error or warning", errors == "0" && warnings == "0" ? [] :
		[`${errors ?? "?"} error and ${warnings ?? "?"} warning lines in game.log`], "none in game.log");

	const result = /^result: (.*)$/m.exec(report)?.[1] ?? "";
	check("decided by a victory condition", winner === undefined ? ["no player won"] :
		result.includes("(time limit)") ? [`undecided at the time limit: ${result}`] : [], result);

	// Phases, from the timeline (snapshots every two minutes).
	const reached = (player: number, phase: string): number | undefined =>
		snapshots(player).find(t => t.phase.split(",").includes(phase))?.minute;
	const winnerTown = winner === undefined ? undefined : reached(winner, "phase_town");
	check("the winner reaches town phase", winner === undefined ? ["no winner"] :
		winnerTown === undefined || winnerTown > limits.townPhaseMinute ?
			[`town phase ${winnerTown === undefined ? "never" : `at minute ${winnerTown}`}, limit ${limits.townPhaseMinute}`] : [],
		`at minute ${winnerTown}`);

	const statistic = (p: PlayerStatistics, key: string, type: string): number =>
	{
		const counts = p.statistics[key];
		return typeof counts == "object" ? counts[type] ?? 0 : 0;
	};
	const winnerStats = players.find(p => p.playerID == winner);
	const metal = winnerStats ? statistic(winnerStats, "resourcesGathered", "metal") : 0;
	check("the winner mines metal", metal >= limits.winnerMetal ? [] : [`${metal} metal gathered, at least ${limits.winnerMetal}`],
		`${metal} gathered`);

	// The economy, snapshot by snapshot.
	const idle: string[] = [];
	const stock: string[] = [];
	const growth: string[] = [];
	for (const player of ids)
	{
		let idleBefore = false;
		for (const t of snapshots(player))
		{
			const women = t.classes.Support ?? 0;
			const idleWomen = t.idle?.Support ?? 0;
			const idleNow = idleWomen > Math.max(limits.idleSupport, limits.idleSupportShare * women);
			if (idleNow && idleBefore)
				idle.push(`player ${player} at minute ${t.minute}: ${idleWomen} of ${women} women idle, as two minutes before`);
			idleBefore = idleNow;
			for (const [type, amount] of Object.entries(t.resources))
				if (amount > limits.stockpile && t.pop < limits.stockpileBelowPop)
					stock.push(`player ${player} at minute ${t.minute}: ${amount} ${type} at population ${t.pop}`);
		}
		const pop = (minute: number): number | undefined => snapshots(player).find(t => t.minute == minute)?.pop;
		const [start, later] = [pop(1), pop(9)];
		if (start === undefined || later === undefined || later < limits.earlyGrowth * start)
			growth.push(`player ${player}: population ${start} at minute 1, ${later} at minute 9`);
	}
	check("workers are not left idle", idle, `at most ${limits.idleSupport} idle women, or ${limits.idleSupportShare * 100}%`);
	check("no stockpile grows unspent", stock, `no resource above ${limits.stockpile} below population ${limits.stockpileBelowPop}`);
	check("both sides grow early", growth, `population at least ${limits.earlyGrowth}x from minute 1 to 9`);

	// The commands.
	const silent: string[] = [];
	const repeated: string[] = [];
	const floods: string[] = [];
	const churn: string[] = [];
	const phasing: string[] = [];
	for (const player of ids)
	{
		const own = issued(player);
		const perMinute = new Map<number, Command[]>();
		for (const command of own)
			perMinute.set(minuteOf(command.time), [...perMinute.get(minuteOf(command.time)) ?? [], command]);

		// Silence while the player still has houses or a centre, until the game is decided.
		let quiet = 0;
		for (let minute = 0; minute < decidedMinute; ++minute)
		{
			const snapshot = snapshots(player).filter(t => t.minute <= minute).at(-1);
			if (snapshot && !snapshot.popLimit)
				break;
			if (snapshot && snapshot.pop < limits.silentPopulation)
			{
				quiet = 0;
				continue;
			}
			quiet = perMinute.has(minute) ? 0 : quiet + 1;
			if (quiet == limits.silentMinutes)
				silent.push(`player ${player}: no command in minutes ${minute - quiet + 1}-${minute}`);
		}

		// The same command in many turns: a decision that never takes. Repeats
		// within one turn are not counted (defenseManager deletes a structure
		// it gives up once per attack on it that turn).
		const turnsOf = new Map<string, number[]>();
		for (const command of own)
		{
			const turns = turnsOf.get(command.json) ?? [];
			if (turns.at(-1) !== command.time)
				turns.push(command.time);
			turnsOf.set(command.json, turns);
		}
		for (const [json, turns] of turnsOf)
			for (let first = 0, last = 0; last < turns.length; ++last)
			{
				while (turns[last] - turns[first] > limits.repeatWindow)
					++first;
				if (last - first + 1 > limits.repeatedTurns)
				{
					repeated.push(`player ${player}: ${json.slice(0, 120)} in ${last - first + 1} turns from minute ${minuteOf(turns[first])}`);
					break;
				}
			}

		const perTurn = new Map<number, number>();
		for (const command of own)
			perTurn.set(command.time, (perTurn.get(command.time) ?? 0) + 1);
		for (const [time, count] of perTurn)
			if (count > limits.commandsPerTurn)
				floods.push(`player ${player}: ${count} commands at ${(time / 60000).toFixed(1)} min`);

		// Productions cancelled in bulk while there is room to train.
		for (const [minute, list] of perMinute)
		{
			const cancels = list.filter(c => c.type == "stop-production").length;
			const snapshot = snapshots(player).filter(t => t.minute <= minute).at(-1);
			if (cancels > limits.cancelsPerMinute && snapshot && snapshot.pop < snapshot.popLimit - limits.capMargin)
				churn.push(`player ${player} in minute ${minute}: ${cancels} productions cancelled at population ${snapshot.pop} of ${snapshot.popLimit}`);
		}

		// A phase is had soon after it is ordered.
		for (const phase of ["phase_town", "phase_city"])
		{
			const order = own.find(c => c.type == "research" && c.template?.startsWith(phase));
			const had = reached(player, phase);
			if (order && had === undefined && minuteOf(order.time) + limits.phaseResearchMinutes < decidedMinute)
				phasing.push(`player ${player}: ${order.template} ordered at minute ${minuteOf(order.time)}, never had`);
			else if (order && had !== undefined && had > minuteOf(order.time) + limits.phaseResearchMinutes)
				phasing.push(`player ${player}: ${order.template} ordered at minute ${minuteOf(order.time)}, had at ${had}`);
			else if (!order && had !== undefined)
				phasing.push(`player ${player}: ${phase} had at minute ${had} but never ordered`);
		}
		if (player == winner && !own.some(c => c.type == "research" && c.template?.startsWith("phase_town")))
			phasing.push(`player ${player}, the winner, never ordered town phase`);
	}
	check("no side falls silent", silent, `a command every minute while it has buildings and ${limits.silentPopulation} units`);
	check("no command repeated turn after turn", repeated,
		`no command in more than ${limits.repeatedTurns} turns within ${limits.repeatWindow / 60000} minutes`);
	check("no command flood", floods, `at most ${limits.commandsPerTurn} commands a turn`);
	check("no production churn", churn, `at most ${limits.cancelsPerMinute} cancels a minute below the population cap`);
	check("phases follow their orders", phasing, `each phase within ${limits.phaseResearchMinutes} minutes of its order`);

	// What the game refused. Notices addressed to an entity id rather than a
	// player come from a swapped call in Commands.js (CanPlayerOrAllyControlUnit
	// passes player and entity the wrong way round: "Gaia can't be controlled.",
	// though the order goes through) and are left out.
	const refused: string[] = [];
	for (const player of ids)
	{
		const own = notices.filter(n => n.type == "text" && n.players.length == 1 && n.players[0] == player);
		if (own.length > limits.refusals)
		{
			const kinds = new Map<string, number>();
			for (const n of own)
				kinds.set(n.message ?? "", (kinds.get(n.message ?? "") ?? 0) + 1);
			const top = [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${n}x ${m}`).join(", ");
			refused.push(`player ${player}: ${own.length} orders refused (${top})`);
		}
	}
	check("few orders refused", refused, `at most ${limits.refusals} a player`);

	return checks;
}

if (import.meta.url == pathToFileURL(process.argv[1]).href)
{
	const dir = process.argv[2];
	if (!dir)
	{
		console.error("usage: node match-checks.ts <match dir>");
		process.exit(2);
	}
	const checks = checkMatch(dir);
	for (const { name, ok, detail } of checks)
		console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
	process.exit(checks.every(c => c.ok) ? 0 : 1);
}
