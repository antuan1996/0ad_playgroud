#!/bin/bash
# Watch the original Petra ("Petra JS", simulation/ai/petra) play its
# TypeScript port ("Petra TS", simulation/ai/petra_out) in the game, as an
# observer. Builds the port first, then records the match under
# build/petra_ts/matches/<time>/ (and matches/latest):
#   match.txt          who is who, the settings, the command and the result
#   game.log           the game's stdout/stderr: script errors, warnings, the
#                      statistics printed when the game ends
#   mainlog.html, interestinglog.html   the engine's own logs of the run
# The game ends on conquest: once one bot has defeated the other.
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
  -x         swap slots: Petra TS plays player 1, Petra JS player 2
  -v SPEED   game speed (default 1; up to 20 while observing)
  -n         non-visual: no graphics, as fast as possible
  -h         this help
Petra JS is always blue and Petra TS always red, whichever slot they play.
EOF
}

map="random/mainland"
seed=""
aiseed=""
difficulty=5
civ="athen"
swap=false
speed=1
nonvisual=false
while getopts "m:s:a:d:c:xv:nh" option; do
	case "$option" in
		m) map="$OPTARG" ;;
		s) seed="$OPTARG" ;;
		a) aiseed="$OPTARG" ;;
		d) difficulty="$OPTARG" ;;
		c) civ="$OPTARG" ;;
		x) swap=true ;;
		v) speed="$OPTARG" ;;
		n) nonvisual=true ;;
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

if [ "$swap" = true ]; then
	ts=1
	js=2
else
	js=1
	ts=2
fi

args=(
	-autostart="$map"
	-autostart-seed="$seed"
	-autostart-aiseed="$aiseed"
	-autostart-players=2
	-autostart-player=-1
	-autostart-victory=conquest
	-autostart-speed="$speed"
	-autostart-script=scripts/NonVisualTrigger.js
	-autostart-ai="$js:petra"
	-autostart-ai="$ts:petra_out"
	-autostart-aidiff="$js:$difficulty"
	-autostart-aidiff="$ts:$difficulty"
	-autostart-civ="$js:$civ"
	-autostart-civ="$ts:$civ"
	-autostart-name="$js:Petra JS"
	-autostart-name="$ts:Petra TS"
	-autostart-color="$js:10,10,190"
	-autostart-color="$ts:230,10,10"
)
if [ "$nonvisual" = true ]; then
	args+=(-autostart-nonvisual)
fi
args+=("$@")

matches="$repo/build/petra_ts/matches"
out="$matches/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
ln -sfn "$(basename "$out")" "$matches/latest"

{
	echo "player $js: Petra JS (simulation/ai/petra), blue"
	echo "player $ts: Petra TS (simulation/ai/petra_out), red"
	echo "map $map, seed $seed, AI seed $aiseed, difficulty $difficulty, civ $civ, speed $speed"
	echo "branch $(git -C "$repo" rev-parse --abbrev-ref HEAD) at $(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet HEAD || echo ' (with uncommitted changes)')"
	echo "started $(date '+%Y-%m-%d %H:%M:%S')"
	printf 'command:'
	printf ' %q' "$game" "${args[@]}"
	echo
} >"$out/match.txt"
cat "$out/match.txt"

set +e
"$game" "${args[@]}" 2>&1 | tee "$out/game.log"
status=${PIPESTATUS[0]}
set -e

for log in mainlog.html interestinglog.html; do
	if [ -e "$logs/$log" ]; then
		cp "$logs/$log" "$out/"
	fi
done

# NonVisualTrigger.js prints each player's statistics once the game is decided.
result="$(awk '/"playerID":/ { id = $2 + 0 }
	/"playerState":/ { gsub(/[",]/, "", $2); printf "%s player %d: %s\n", (id == js ? "Petra JS" : "Petra TS"), id, $2 }' \
	js="$js" "$out/game.log")"
errors="$(grep -c 'ERROR' "$out/game.log" || true)"
replay="$(find "$replays" -mindepth 2 -maxdepth 2 -type d -newer "$out/match.txt" 2>/dev/null | sort | tail -n 1)"

{
	echo "ended $(date '+%Y-%m-%d %H:%M:%S'), game exit status $status"
	echo "result: ${result:-undecided (the game was closed before one bot defeated the other)}"
	echo "lines with ERROR in game.log: $errors"
	echo "replay: ${replay:-none found}"
} | tee -a "$out/match.txt"
echo "logs: $out"
