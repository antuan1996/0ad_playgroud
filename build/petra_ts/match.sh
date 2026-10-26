#!/bin/bash
# Watch the TypeScript port of Petra ("Petra TS", simulation/ai/petra_out) play
# itself, or with -o/-p another bot: the original ("Petra JS",
# simulation/ai/petra) or a baseline (baselines.ts: "Petra TS parity",
# petra_parity; "Petra fixed", petra_fixed), in the game, as an observer.
# Builds the bots first (not with -B), then records the match under
# build/petra_ts/matches/<time>/ (and matches/latest):
#   match.txt          who is who, the settings, the commit, a hash of the
#                      Petra TS build, the command and how to rerun the match;
#                      then the result, a table of both bots' statistics, the
#                      errors and warnings, the replay and a fingerprint of the
#                      game (match-report.ts)
#   statistics.json    the statistics printed when the game ends, one entry per
#                      player
#   timeline.txt       with -t: each player's state every two game minutes
#   commands.txt       with -l: every command each bot sent, "<game ms> <player>
#                      <command JSON>"; diff two of them to find where two
#                      runs diverge
#   notices.txt        with -l: what the game told the bots, one JSON line each:
#                      refused orders ("Insufficient resources - ...") and their
#                      chat (MatchNotices.js)
#   botstate.txt       with -b: Petra TS's own state every two game minutes, one
#                      JSON line per player (bot-state.js)
#   attacks.txt        with -b: the attack plans' lives, one JSON line per event
#                      (created, started, aborted, finished, progress; bot-state.js,
#                      read by attack-log.ts)
#   aitimes.txt        with -P: each AI's script time per turn, measured by the
#                      engine (PYROGENESIS_AI_TIMES, CCmpAIManager.cpp), and
#                      aitimes-summary.txt (ai-times.ts)
#   metadata.json      the replay's metadata: the final state of each player and
#                      every statistic sampled each 30 game seconds ("sequences")
#   logs.tar.gz        game.log, the game's stdout/stderr (script errors,
#                      warnings, the statistics), and the engine's own
#                      mainlog.html and interestinglog.html
# The game ends once one bot has won by one of the victory conditions (-w;
# conquest by default, the game's own default). In visual
# mode the game then stops on that turn (-autostart-stop-on-end) and shows the
# result; the record is finished once you close the game (Alt+F4, or Quit and
# then Exit in the main menu).
# Matches are deterministic: the same seeds, options and code play the same
# game (the map seed also picks the settings the game setup leaves random, like
# the biome; see -autostart-seed), and match.txt has the line to rerun one.
set -euo pipefail

usage()
{
	cat <<EOF
usage: $0 [options] [-- extra pyrogenesis arguments]
  -m MAP     map, TYPEDIR/MAPNAME (default random/mainland)
  -s SEED    map seed (default: a random one, recorded in match.txt)
  -a SEED    AI seed (default: a random one, recorded in match.txt)
  -d DIFF    difficulty of both bots, 0 sandbox .. 5 very hard (default 5)
  -c CIV     civilisation of both bots (default athen)
  -w LIST    victory conditions, comma separated, from
             simulation/data/settings/victory_conditions/ (default
             conquest; e.g. conquest,wonder,capture_the_relic)
  -W MINUTES how long a wonder or all relics must be held to win (default 20)
  -o BOT     the blue bot: petra_out, Petra TS (default); petra, Petra JS;
             petra_parity, Petra TS parity; petra_fixed, Petra fixed
  -p BOT     the red bot, the same choice (default petra_out), or a
             petra_hybrid* bot of baselines.ts hybrid (never built here)
  -x         swap slots: the red bot plays player 1, the blue one player 2
  -v SPEED   game speed (default 1; up to 20 while observing)
  -n         non-visual: no graphics, as fast as possible
  -t         timeline: each player's state every two game minutes (timeline.txt)
  -l         log every command each bot sends (commands.txt) and what the game
             tells the bots back, refusals and chat (notices.txt), for debugging
  -b         Petra TS dumps its own state every two game minutes (botstate.txt:
             roles, base resource lists, queues, plans) and logs its attack plans'
             lives (attacks.txt), for debugging; the game is the same
  -P         time each AI's turn in the engine (aitimes.txt; ai-times.ts
             summarises it): two clock reads per AI and turn, kept in memory
             and written when the game ends, so the times are the bot's own
  -T         end the game at 90 game minutes if undecided: the larger
             population wins with the reason "time limit" (MatchTimeLimit.js)
  -L MIN     as -T, but at game minute MIN (parity-bisect.ts stops its games
             shortly after the divergence it looks into)
  -r DIR     record into DIR (emptied first) instead of matches/<time>;
             no rotation, and matches/latest is left alone
  -k KEEP    keep the last KEEP match folders, this one included, and delete
             older ones (default 5; 0 keeps them all)
  -B         do not build: play the bots as they are (batch.ts builds them
             once for all its games)
  -h         this help
Blue is the -o bot, red the -p one, whichever slot they play; a bot against
itself is named with its color, like "Petra TS (blue)" and "Petra TS (red)".
EOF
}

map="random/mainland"
seed=""
aiseed=""
difficulty=5
civ="athen"
victory="conquest"
holdMinutes=20
opponent=petra_out
redBot=petra_out
build=true
swap=false
speed=1
nonvisual=false
timeline=false
commands=false
keep=5
timeLimit=false
limitMinutes=""
botState=false
aiTimes=false
record=""
while getopts "m:s:a:d:c:w:W:o:p:xv:ntlbPTL:r:k:Bh" option; do
	case "$option" in
		m) map="$OPTARG" ;;
		s) seed="$OPTARG" ;;
		a) aiseed="$OPTARG" ;;
		d) difficulty="$OPTARG" ;;
		c) civ="$OPTARG" ;;
		w) victory="$OPTARG" ;;
		W) holdMinutes="$OPTARG" ;;
		o) opponent="$OPTARG" ;;
		p) redBot="$OPTARG" ;;
		B) build=false ;;
		x) swap=true ;;
		v) speed="$OPTARG" ;;
		n) nonvisual=true ;;
		t) timeline=true ;;
		l) commands=true ;;
		T) timeLimit=true ;;
		L)
			timeLimit=true
			limitMinutes="$OPTARG"
			;;
		b) botState=true ;;
		P) aiTimes=true ;;
		r) record="$OPTARG" ;;
		k) keep="$OPTARG" ;;
		h)
			usage
			exit 0
			;;
		*)
			usage >&2
			exit 2
			;;
	esac
done
shift $((OPTIND - 1))
botName()
{
	case "$1" in
		petra) echo "Petra JS" ;;
		petra_out) echo "Petra TS" ;;
		petra_parity) echo "Petra TS parity" ;;
		petra_fixed) echo "Petra fixed" ;;
		petra_hybrid*) echo "Petra hybrid ${1#petra_hybrid}" ;;
		*)
			echo "-$2 takes petra_out, petra, petra_parity or petra_fixed, not '$1'" >&2
			return 1
			;;
	esac
}
blueName="$(botName "$opponent" o)" || exit 2
redName="$(botName "$redBot" p)" || exit 2
if [ "$opponent" = "$redBot" ]; then
	blueName="$blueName (blue)"
	redName="$redName (red)"
fi
if [ "$botState" = true ] && [ "$opponent" != petra_out ] && [ "$redBot" != petra_out ]; then
	echo "-b: only petra_out dumps its state, and neither bot is petra_out" >&2
	exit 2
fi
conditions="$(dirname "$0")/../../binaries/data/mods/public/simulation/data/settings/victory_conditions"
IFS=, read -r -a victories <<<"$victory"
for condition in "${victories[@]}"; do
	if [ ! -e "$conditions/$condition.json" ]; then
		echo "-w: no victory condition '$condition' (see $conditions)" >&2
		exit 2
	fi
done
if ! [[ "$holdMinutes" =~ ^[0-9]+$ ]]; then
	echo "-W takes a number of minutes, not '$holdMinutes'" >&2
	exit 2
fi
if [ -n "$limitMinutes" ] && ! [[ "$limitMinutes" =~ ^[1-9][0-9]*$ ]]; then
	echo "-L takes a number of game minutes, not '$limitMinutes'" >&2
	exit 2
fi
if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
	echo "-k takes a number of matches, not '$keep'" >&2
	exit 2
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
ai="$repo/binaries/data/mods/public/simulation/ai"
# match.sh runs in parallel under batch.ts: git must not take the index lock.
export GIT_OPTIONAL_LOCKS=0
game="$repo/binaries/system/pyrogenesis"
logs="${XDG_STATE_HOME:-$HOME/.local/state}/0ad/log"
replays="${XDG_DATA_HOME:-$HOME/.local/share}/0ad/replays"

if [ ! -x "$game" ]; then
	echo "$game is missing: build the game first (see CLAUDE.md)" >&2
	exit 1
fi

# Explicit seeds, so that match.txt says which game this was.
seed="${seed:-$((RANDOM * 32768 + RANDOM))}"
aiseed="${aiseed:-$((RANDOM * 32768 + RANDOM))}"

bots=("$opponent")
[ "$redBot" != "$opponent" ] && bots+=("$redBot")
if [ "$build" = true ]; then
	(cd "$repo" && npm run --silent build:petra:out)
	baselines=()
	for bot in "${bots[@]}"; do
		case "$bot" in
			petra_parity) baselines+=(parity) ;;
			petra_fixed) baselines+=(fixed) ;;
		esac
	done
	if [ ${#baselines[@]} -gt 0 ]; then
		node "$repo/build/petra_ts/baselines.ts" "${baselines[@]}"
	fi
	if [ "$botState" = true ]; then
		node "$repo/build/petra_ts/prepare-bot.ts" state
	fi
fi
for bot in "${bots[@]}"; do
	if [ ! -e "$ai/$bot/data.json" ]; then
		echo "simulation/ai/$bot is not built (run without -B, or npm run build:petra:baselines)" >&2
		exit 1
	fi
done

# Slots of the blue (-o) bot and of the red one, the port.
if [ "$swap" = true ]; then
	red=1
	blue=2
else
	blue=1
	red=2
fi

args=(
	-autostart="$map"
	-autostart-seed="$seed"
	-autostart-aiseed="$aiseed"
	-autostart-players=2
	-autostart-player=-1
	-autostart-stop-on-end
	-autostart-speed="$speed"
	-autostart-script=scripts/NonVisualTrigger.js
	-autostart-script=scripts/MatchEnd.js
	-autostart-ai="$blue:$opponent"
	-autostart-ai="$red:$redBot"
	-autostart-aidiff="$blue:$difficulty"
	-autostart-aidiff="$red:$difficulty"
	-autostart-civ="$blue:$civ"
	-autostart-civ="$red:$civ"
	-autostart-name="$blue:$blueName"
	-autostart-name="$red:$redName"
	-autostart-color="$blue:10,10,190"
	-autostart-color="$red:230,10,10"
)
if [ "$nonvisual" = true ]; then
	args+=(-autostart-nonvisual)
fi
if [ "$timeline" = true ]; then
	args+=(-autostart-script=scripts/MatchTimeline.js)
fi
if [ "$commands" = true ]; then
	args+=(-autostart-script=scripts/MatchCommands.js -autostart-script=scripts/MatchNotices.js)
fi
if [ "$timeLimit" = true ]; then
	args+=(-autostart-script=scripts/MatchTimeLimit.js)
	if [ -n "$limitMinutes" ]; then
		args+=(-autostart-timelimit="$limitMinutes")
	fi
fi
for condition in "${victories[@]}"; do
	args+=(-autostart-victory="$condition")
done
args+=(-autostart-wonderduration="$holdMinutes" -autostart-relicduration="$holdMinutes")
args+=("$@")

rerun=(build/petra_ts/match.sh -m "$map" -s "$seed" -a "$aiseed" -d "$difficulty" -c "$civ" -w "$victory" -W "$holdMinutes" -o "$opponent" -p "$redBot" -v "$speed")
[ "$swap" = true ] && rerun+=(-x)
[ "$nonvisual" = true ] && rerun+=(-n)
[ "$timeline" = true ] && rerun+=(-t)
[ "$commands" = true ] && rerun+=(-l)
if [ -n "$limitMinutes" ]; then
	rerun+=(-L "$limitMinutes")
elif [ "$timeLimit" = true ]; then
	rerun+=(-T)
fi
[ "$botState" = true ] && rerun+=(-b)
[ "$aiTimes" = true ] && rerun+=(-P)
if [ $# -gt 0 ]; then
	rerun+=(--)
fi

matches="$repo/build/petra_ts/matches"
if [ -n "$record" ]; then
	out="$record"
	# Only ever empty a previous record, never a folder given by mistake.
	if [ -e "$out" ] && [ -n "$(ls -A "$out")" ] && [ ! -e "$out/match.txt" ]; then
		echo "-r: $out is not empty and holds no match.txt; not emptying it" >&2
		exit 2
	fi
	rm -rf -- "$out"
	mkdir -p "$out"
else
	out="$matches/$(date +%Y%m%d-%H%M%S)"
	mkdir -p "$out"
	ln -sfn "$(basename "$out")" "$matches/latest"
fi

# Rotation: the folder names are timestamps, so they sort oldest first.
if [ -z "$record" ] && [ "$keep" -gt 0 ]; then
	old=()
	while IFS= read -r dir; do
		old+=("$matches/$dir")
	done < <(find "$matches" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' -printf '%f\n' |
		sort | head -n -"$keep")
	if [ ${#old[@]} -gt 0 ]; then
		rm -rf -- "${old[@]}"
	fi
fi

{
	echo "player $blue: $blueName (simulation/ai/$opponent), blue"
	echo "player $red: $redName (simulation/ai/$redBot), red"
	echo "map $map, seed $seed, AI seed $aiseed, difficulty $difficulty, civ $civ, speed $speed"
	hold=""
	if [[ ",$victory," =~ ,(wonder|capture_the_relic), ]]; then
		hold="; a wonder or all relics win when held $holdMinutes min"
	fi
	echo "victory conditions $victory$hold"
	echo "branch $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
	dirty=""
	if ! git -C "$repo" diff --quiet HEAD || [ -n "$(git -C "$repo" ls-files --others --exclude-standard)" ]; then
		dirty=" (with uncommitted changes)"
	fi
	echo "commit $(git -C "$repo" log -1 --format='%H %cs "%s"')$dirty"
	# sha256 of the sorted list of "sha256  ./path" of every file of a build.
	for bot in "${bots[@]}"; do
		if [ "$bot" != petra ]; then
			echo "$bot sha256 $(cd "$ai/$bot" &&
				find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
		fi
	done
	if [[ " ${bots[*]} " == *" petra_parity "* ]]; then
		echo "petra_parity from tag petra-ts-parity $(git -C "$repo" rev-parse --short=10 'petra-ts-parity^{commit}' 2>/dev/null || echo "(missing)")"
	fi
	echo "engine built $(date -r "$game" '+%Y-%m-%d %H:%M:%S')"
	echo "started $(date '+%Y-%m-%d %H:%M:%S')"
	printf 'command:'
	printf ' %q' "$game" "${args[@]}"
	echo
	printf 'rerun (on that commit):'
	printf ' %q' "${rerun[@]}" "$@"
	echo
} >"$out/match.txt"
cat "$out/match.txt"

set +e
if [ "$aiTimes" = true ]; then
	PYROGENESIS_AI_TIMES="$out/aitimes.txt" "$game" "${args[@]}" 2>&1 | tee "$out/game.log"
else
	"$game" "${args[@]}" 2>&1 | tee "$out/game.log"
fi
status=${PIPESTATUS[0]}
set -e
if [ "$aiTimes" = true ] && [ -e "$out/aitimes.txt" ]; then
	node "$repo/build/petra_ts/ai-times.ts" "$out" >"$out/aitimes-summary.txt" || true
fi

if [ "$timeline" = true ]; then
	grep '^TIMELINE ' "$out/game.log" | cut -d' ' -f2- >"$out/timeline.txt" || true
fi
# Not anchored: the engine may not end its line before the first command.
if [ "$commands" = true ]; then
	grep -oE 'COMMAND [0-9]+ [0-9]+ \{.*\}$' "$out/game.log" | cut -d' ' -f2- >"$out/commands.txt" || true
	grep -oE 'NOTICE \{.*\}$' "$out/game.log" | cut -d' ' -f2- >"$out/notices.txt" || true
fi
if [ "$botState" = true ]; then
	grep -oE 'BOTSTATE \{.*\}$' "$out/game.log" | cut -d' ' -f2- >"$out/botstate.txt" || true
	grep -oE 'ATTACKLOG \{.*\}$' "$out/game.log" | cut -d' ' -f2- >"$out/attacks.txt" || true
fi

for log in mainlog.html interestinglog.html; do
	if [ -e "$logs/$log" ]; then
		cp "$logs/$log" "$out/"
	fi
done

wall=$(($(date +%s) - $(date -r "$out/match.txt" +%s)))
{
	echo "ended $(date '+%Y-%m-%d %H:%M:%S') after $((wall / 60))m$((wall % 60))s, game exit status $status"
	node "$repo/build/petra_ts/match-report.ts" "$out" "$blue" "$blueName" "$red" "$redName"
} | tee -a "$out/match.txt"

replay="$(sed -n "s/^Replay written to '\(.*\)'$/\1/p" "$out/game.log")"
if [ -n "$replay" ] && [ -e "$replay/metadata.json" ]; then
	cp "$replay/metadata.json" "$out/"
fi

archived=()
for log in game.log mainlog.html interestinglog.html; do
	if [ -e "$out/$log" ]; then
		archived+=("$log")
	fi
done
tar -czf "$out/logs.tar.gz" -C "$out" "${archived[@]}"
(cd "$out" && rm -- "${archived[@]}")
echo "logs: $out"
