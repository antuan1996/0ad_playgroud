#!/bin/bash
# Watch the TypeScript port of Petra ("Petra TS", simulation/ai/petra_out) play
# itself, or with -o petra the original ("Petra JS", simulation/ai/petra), in
# the game, as an observer. Builds the port first, then records the match under
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
  -o BOT     the blue bot: petra_out, Petra TS (default), or petra, Petra JS
  -x         swap slots: the red bot plays player 1, the blue one player 2
  -v SPEED   game speed (default 1; up to 20 while observing)
  -n         non-visual: no graphics, as fast as possible
  -t         timeline: each player's state every two game minutes (timeline.txt)
  -l         log every command each bot sends (commands.txt) and what the game
             tells the bots back, refusals and chat (notices.txt), for debugging
  -b         Petra TS dumps its own state every two game minutes (botstate.txt:
             roles, base resource lists, queues, plans), for debugging
  -T         end the game at 90 game minutes if undecided: the larger
             population wins with the reason "time limit" (MatchTimeLimit.js)
  -r DIR     record into DIR (emptied first) instead of matches/<time>;
             no rotation, and matches/latest is left alone
  -k KEEP    keep the last KEEP match folders, this one included, and delete
             older ones (default 5; 0 keeps them all)
  -h         this help
The red bot is always Petra TS. Blue is the -o bot, red the port, whichever
slot they play; against itself the port is named "Petra TS (blue)" and
"Petra TS (red)".
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
swap=false
speed=1
nonvisual=false
timeline=false
commands=false
keep=5
timeLimit=false
botState=false
record=""
while getopts "m:s:a:d:c:w:W:o:xv:ntlbTr:k:h" option; do
	case "$option" in
		m) map="$OPTARG" ;;
		s) seed="$OPTARG" ;;
		a) aiseed="$OPTARG" ;;
		d) difficulty="$OPTARG" ;;
		c) civ="$OPTARG" ;;
		w) victory="$OPTARG" ;;
		W) holdMinutes="$OPTARG" ;;
		o) opponent="$OPTARG" ;;
		x) swap=true ;;
		v) speed="$OPTARG" ;;
		n) nonvisual=true ;;
		t) timeline=true ;;
		l) commands=true ;;
		T) timeLimit=true ;;
		b) botState=true ;;
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
case "$opponent" in
	petra)
		blueName="Petra JS"
		redName="Petra TS"
		;;
	petra_out)
		blueName="Petra TS (blue)"
		redName="Petra TS (red)"
		;;
	*)
		echo "-o takes petra or petra_out, not '$opponent'" >&2
		exit 2
		;;
esac
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
if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
	echo "-k takes a number of matches, not '$keep'" >&2
	exit 2
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
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

(cd "$repo" && npm run --silent build:petra:out)
if [ "$botState" = true ]; then
	node "$repo/build/petra_ts/prepare-bot.ts" state
fi

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
	-autostart-ai="$red:petra_out"
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
fi
for condition in "${victories[@]}"; do
	args+=(-autostart-victory="$condition")
done
args+=(-autostart-wonderduration="$holdMinutes" -autostart-relicduration="$holdMinutes")
args+=("$@")

rerun=(build/petra_ts/match.sh -m "$map" -s "$seed" -a "$aiseed" -d "$difficulty" -c "$civ" -w "$victory" -W "$holdMinutes" -o "$opponent" -v "$speed")
[ "$swap" = true ] && rerun+=(-x)
[ "$nonvisual" = true ] && rerun+=(-n)
[ "$timeline" = true ] && rerun+=(-t)
[ "$commands" = true ] && rerun+=(-l)
[ "$timeLimit" = true ] && rerun+=(-T)
[ "$botState" = true ] && rerun+=(-b)
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
	echo "player $red: $redName (simulation/ai/petra_out), red"
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
	# sha256 of the sorted list of "sha256  ./path" of every file of the build.
	echo "petra_out sha256 $(cd "$repo/binaries/data/mods/public/simulation/ai/petra_out" &&
		find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
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
"$game" "${args[@]}" 2>&1 | tee "$out/game.log"
status=${PIPESTATUS[0]}
set -e

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
