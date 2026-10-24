#!/bin/bash
# Watch the original Petra ("Petra JS", simulation/ai/petra) play its
# TypeScript port ("Petra TS", simulation/ai/petra_out) in the game, as an
# observer. Builds the port first, then records the match under
# build/petra_ts/matches/<time>/ (and matches/latest):
#   match.txt          who is who, the settings, the commit, a hash of the
#                      Petra TS build, the command and how to rerun the match;
#                      then the result, a table of both bots' statistics, the
#                      errors and warnings, the replay and a fingerprint of the
#                      game (match-report.ts)
#   statistics.json    the statistics printed when the game ends, one entry per
#                      player
#   timeline.txt       with -t: each player's state every two game minutes
#   metadata.json      the replay's metadata: the final state of each player and
#                      every statistic sampled each 30 game seconds ("sequences")
#   logs.tar.gz        game.log, the game's stdout/stderr (script errors,
#                      warnings, the statistics), and the engine's own
#                      mainlog.html and interestinglog.html
# The game ends on conquest: once one bot has defeated the other. In visual
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
  -x         swap slots: Petra TS plays player 1, Petra JS player 2
  -v SPEED   game speed (default 1; up to 20 while observing)
  -n         non-visual: no graphics, as fast as possible
  -t         timeline: each player's state every two game minutes (timeline.txt)
  -k KEEP    keep the last KEEP match folders, this one included, and delete
             older ones (default 5; 0 keeps them all)
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
timeline=false
keep=5
while getopts "m:s:a:d:c:xv:ntk:h" option; do
	case "$option" in
		m) map="$OPTARG" ;;
		s) seed="$OPTARG" ;;
		a) aiseed="$OPTARG" ;;
		d) difficulty="$OPTARG" ;;
		c) civ="$OPTARG" ;;
		x) swap=true ;;
		v) speed="$OPTARG" ;;
		n) nonvisual=true ;;
		t) timeline=true ;;
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
	-autostart-stop-on-end
	-autostart-speed="$speed"
	-autostart-script=scripts/NonVisualTrigger.js
	-autostart-script=scripts/MatchEnd.js
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
if [ "$timeline" = true ]; then
	args+=(-autostart-script=scripts/MatchTimeline.js)
fi
args+=("$@")

rerun=(build/petra_ts/match.sh -m "$map" -s "$seed" -a "$aiseed" -d "$difficulty" -c "$civ" -v "$speed")
[ "$swap" = true ] && rerun+=(-x)
[ "$nonvisual" = true ] && rerun+=(-n)
[ "$timeline" = true ] && rerun+=(-t)
if [ $# -gt 0 ]; then
	rerun+=(--)
fi

matches="$repo/build/petra_ts/matches"
out="$matches/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
ln -sfn "$(basename "$out")" "$matches/latest"

# Rotation: the folder names are timestamps, so they sort oldest first.
if [ "$keep" -gt 0 ]; then
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
	echo "player $js: Petra JS (simulation/ai/petra), blue"
	echo "player $ts: Petra TS (simulation/ai/petra_out), red"
	echo "map $map, seed $seed, AI seed $aiseed, difficulty $difficulty, civ $civ, speed $speed"
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

for log in mainlog.html interestinglog.html; do
	if [ -e "$logs/$log" ]; then
		cp "$logs/$log" "$out/"
	fi
done

wall=$(($(date +%s) - $(date -r "$out/match.txt" +%s)))
{
	echo "ended $(date '+%Y-%m-%d %H:%M:%S') after $((wall / 60))m$((wall % 60))s, game exit status $status"
	node "$repo/build/petra_ts/match-report.ts" "$out" "$js"
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
