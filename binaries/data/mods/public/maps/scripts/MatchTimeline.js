/**
 * Prints a snapshot of every player every two game minutes, one line each:
 *   TIMELINE {"minute":..,"player":..,"name":..,"state":..,"pop":..,"resources":{..},
 *             "phase":..,"classes":{..},"unitAI":{..},"idle":{..}}
 * "classes" counts the player's entities of a few classes, "unitAI" its units
 * by the top of their UnitAI state (IDLE, GATHER, COMBAT, ...), or GARRISONED
 * for units inside a structure or a ship (whose UnitAI state is IDLE), and
 * "idle" its IDLE units of each of the classes, an army waiting to set off
 * (Soldier) apart from workers left without a task (Support).
 * It only reads the simulation. Used by build/petra_ts/match.sh -t.
 */
Trigger.prototype.MatchTimelineClasses = ["CivCentre", "House", "Field", "Storehouse", "Farmstead", "Barracks",
	"Dock", "Market", "Temple", "Tower", "Fortress", "Wall", "Worker", "Soldier", "Cavalry", "Siege", "Support"];

Trigger.prototype.MatchTimelineSnapshot = function()
{
	const minute = Math.round(Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime() / 60000);
	const cmpPlayerManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_PlayerManager);
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	for (let player = 1; player < cmpPlayerManager.GetNumPlayers(); ++player)
	{
		const cmpPlayer = QueryPlayerIDInterface(player);
		const classes = {};
		const unitAI = {};
		const idle = {};
		for (const ent of cmpRangeManager.GetEntitiesByPlayer(player))
		{
			const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
			if (!cmpIdentity)
				continue;
			const list = cmpIdentity.GetClassesList();
			for (const cls of this.MatchTimelineClasses)
				if (list.indexOf(cls) != -1)
					classes[cls] = (classes[cls] || 0) + 1;
			const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
			if (cmpUnitAI && list.indexOf("Unit") != -1)
			{
				const state = Engine.QueryInterface(ent, IID_Garrisonable)?.IsGarrisoned() ? "GARRISONED" :
					(cmpUnitAI.GetCurrentState() || "NONE").split(".")[1] || "NONE";
				unitAI[state] = (unitAI[state] || 0) + 1;
				if (state == "IDLE")
					for (const cls of this.MatchTimelineClasses)
						if (list.indexOf(cls) != -1)
							idle[cls] = (idle[cls] || 0) + 1;
			}
		}
		const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);
		const phases = cmpTechnologyManager ?
			[...cmpTechnologyManager.GetResearchedTechs()].filter(tech => tech.startsWith("phase_")) : [];
		print("TIMELINE " + JSON.stringify({
			"minute": minute,
			"player": player,
			"name": QueryPlayerIDInterface(player, IID_Identity).GetName(),
			"state": cmpPlayer.GetState(),
			"pop": cmpPlayer.GetPopulationCount(),
			"resources": cmpPlayer.GetResourceCounts(),
			"phase": phases.sort().join(","),
			"classes": classes,
			"unitAI": unitAI,
			"idle": idle
		}) + "\n");
	}
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	cmpTrigger.RegisterTrigger("OnInterval", "MatchTimelineSnapshot", {
		"enabled": true,
		"delay": 60 * 1000,
		"interval": 2 * 60 * 1000
	});
}
