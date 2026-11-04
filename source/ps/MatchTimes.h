/* Copyright (C) 2026 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef INCLUDED_MATCHTIMES
#define INCLUDED_MATCHTIMES

#include "lib/timer.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

/**
 * Where a simulation turn's time goes, for measuring bots
 * (build/petra_ts/match.sh -P, build/petra_ts/turn-times.ts): with
 * PYROGENESIS_TURN_TIMES naming a file, each turn's whole update, the AI's
 * state set-up and computation, the garbage collection after the turn,
 * every GC slice (with its reason, and the AI player whose script was
 * running, if any) and every Engine.ProfileStart region of the AI scripts
 * are kept in memory (clock reads only, nothing printed during the game) and
 * written when the game ends. One line per record:
 * "<turn> <kind> <player> <microseconds> <name>".
 * Main thread only; off (one branch per call) without the variable.
 */
namespace MatchTimes
{

struct Record
{
	std::uint32_t turn;
	const char* kind;
	int player;
	float microseconds;
	std::string name;
};

struct OpenRegion
{
	const char* name;
	double start;
};

struct State
{
	bool initialised = false;
	bool written = false;
	std::string path;
	std::vector<Record> records;
	std::vector<OpenRegion> regions;
	std::uint32_t turn = 0;
	/** the AI player whose script runs now (0 the shared component), or -1 */
	int aiPlayer = -1;
	double gcSliceStart = 0.0;
	std::string gcSliceReason;
};

inline State& Get()
{
	static State state;
	return state;
}

inline bool Enabled()
{
	State& state = Get();
	if (!state.initialised)
	{
		state.initialised = true;
		if (const char* path = std::getenv("PYROGENESIS_TURN_TIMES"))
		{
			state.path = path;
			state.records.reserve(1 << 21);
		}
	}
	return !state.path.empty();
}

inline void Add(const char* kind, int player, double start, const std::string& name = "")
{
	State& state = Get();
	state.records.push_back({ state.turn, kind, player, static_cast<float>((timer_Time() - start) * 1e6), name });
}

inline void BeginTurn()
{
	++Get().turn;
}

inline void SetAIPlayer(int player)
{
	Get().aiPlayer = player;
}

/** an AI script's Engine.ProfileStart */
inline void RegionEnter(const char* name)
{
	State& state = Get();
	if (state.aiPlayer < 0)
		return;
	state.regions.push_back({ name, timer_Time() });
}

/** an AI script's Engine.ProfileStop: the region's name is prefixed by its depth */
inline void RegionLeave()
{
	State& state = Get();
	if (state.aiPlayer < 0 || state.regions.empty())
		return;
	const OpenRegion region = state.regions.back();
	state.regions.pop_back();
	Add("region", state.aiPlayer, region.start, std::to_string(state.regions.size()) + ":" + region.name);
}

inline void GCSliceBegin(const char* reason)
{
	State& state = Get();
	state.gcSliceStart = timer_Time();
	state.gcSliceReason = reason;
}

inline void GCSliceEnd()
{
	State& state = Get();
	if (state.gcSliceStart != 0.0)
		Add("gcslice", state.aiPlayer, state.gcSliceStart, state.gcSliceReason);
	state.gcSliceStart = 0.0;
}

inline void Write()
{
	State& state = Get();
	if (state.path.empty())
		return;
	FILE* file = std::fopen(state.path.c_str(), state.written ? "a" : "w");
	if (!file)
		return;
	for (const Record& record : state.records)
		std::fprintf(file, "%u %s %d %.1f %s\n", record.turn, record.kind, record.player, record.microseconds,
			record.name.empty() ? "-" : record.name.c_str());
	std::fclose(file);
	state.records.clear();
	state.written = true;
}

} // namespace MatchTimes

#endif // INCLUDED_MATCHTIMES
