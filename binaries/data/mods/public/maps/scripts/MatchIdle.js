/**
 * Measures how long each player's units stand idle. Every 5 game seconds it
 * looks at every unit (UnitAI.IsIdle, a garrisoned unit or one aboard a ship
 * not counted) and adds 5 s to its category's idle time, or its alive time;
 * it also follows each unit's idle spells, from the sample it was first seen
 * idle to the one it was not, and counts them by length. Every game minute it
 * prints one line per player, the totals so far:
 *   IDLE {"minute":..,"player":..,"name":..,"idleNow":{cat: n},
 *         "idleSeconds":{cat: s},"aliveSeconds":{cat: s},
 *         "spells":{cat: {"<30":n,"30-60":n,"60-180":n,"180-600":n,">600":n}},
 *         "longest":{cat: {"id":..,"seconds":..,"template":..,"x":..,"z":..}}}
 * A spell still running counts in "spells" once it ends, and in "longest" as
 * it stands. The categories: Women (Support workers: women, and citizens of
 * the kind), CitizenSoldier (soldiers that gather, infantry and cavalry),
 * Soldier (the others: champions, mercenaries, heroes), Siege, Ship, Trader,
 * Other. It only reads the simulation. Used by build/petra_ts/match.sh -i,
 * summarised by build/petra_ts/idle-log.ts.
 */
Trigger.prototype.MatchIdleStep = 5;
Trigger.prototype.MatchIdleBands = [[30, "<30"], [60, "30-60"], [180, "60-180"], [600, "180-600"], [Infinity, ">600"]];

Trigger.prototype.MatchIdleCategory = function(list)
{
	const has = cls => list.indexOf(cls) != -1;
	if (has("Ship"))
		return "Ship";
	if (has("Siege"))
		return "Siege";
	if (has("Trader"))
		return "Trader";
	if (has("CitizenSoldier"))
		return "CitizenSoldier";
	if (has("Soldier") || has("Hero"))
		return "Soldier";
	if (has("Support") && has("Worker"))
		return "Women";
	return "Other";
};

Trigger.prototype.MatchIdleSample = function()
{
	if (!this.matchIdle)
		this.matchIdle = { "players": {}, "since": new Map(), "samples": 0 };
	const data = this.matchIdle;
	const step = this.MatchIdleStep;
	const now = Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime() / 1000;
	const cmpPlayerManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_PlayerManager);
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	const band = seconds => this.MatchIdleBands.find(([limit]) => seconds < limit)[1];
	const seen = new Set();
	for (let player = 1; player < cmpPlayerManager.GetNumPlayers(); ++player)
	{
		const stats = data.players[player] || (data.players[player] =
			{ "idleNow": {}, "idleSeconds": {}, "aliveSeconds": {}, "spells": {}, "longest": {} });
		stats.idleNow = {};
		for (const ent of cmpRangeManager.GetEntitiesByPlayer(player))
		{
			const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
			const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
			if (!cmpUnitAI || !cmpIdentity)
				continue;
			const list = cmpIdentity.GetClassesList();
			if (list.indexOf("Unit") == -1)
				continue;
			const cat = this.MatchIdleCategory(list);
			stats.aliveSeconds[cat] = (stats.aliveSeconds[cat] || 0) + step;
			const garrisoned = Engine.QueryInterface(ent, IID_Garrisonable)?.IsGarrisoned();
			if (garrisoned || !cmpUnitAI.IsIdle())
				continue;
			seen.add(ent);
			stats.idleNow[cat] = (stats.idleNow[cat] || 0) + 1;
			stats.idleSeconds[cat] = (stats.idleSeconds[cat] || 0) + step;
			const spell = data.since.get(ent);
			if (!spell)
			{
				data.since.set(ent, { "start": now, player, cat });
				continue;
			}
			const length = now - spell.start;
			if (!stats.longest[cat] || length > stats.longest[cat].seconds)
			{
				const pos = Engine.QueryInterface(ent, IID_Position);
				const at = pos && pos.IsInWorld() ? pos.GetPosition2D() : undefined;
				stats.longest[cat] = {
					"id": ent,
					"seconds": length,
					"template": Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager).GetCurrentTemplateName(ent),
					"x": at ? Math.round(at.x) : undefined,
					"z": at ? Math.round(at.y) : undefined
				};
			}
		}
	}
	// The spells that ended: the unit no longer idle, garrisoned, or gone.
	for (const [ent, spell] of data.since)
	{
		if (seen.has(ent))
			continue;
		data.since.delete(ent);
		const stats = data.players[spell.player];
		const spells = stats.spells[spell.cat] || (stats.spells[spell.cat] = {});
		const key = band(now - spell.start);
		spells[key] = (spells[key] || 0) + 1;
	}
	if (++data.samples % (60 / step))
		return;
	for (const player in data.players)
	{
		const stats = data.players[player];
		print("IDLE " + JSON.stringify({
			"minute": Math.round(now / 60),
			"player": +player,
			"name": QueryPlayerIDInterface(+player, IID_Identity).GetName(),
			"idleNow": stats.idleNow,
			"idleSeconds": stats.idleSeconds,
			"aliveSeconds": stats.aliveSeconds,
			"spells": stats.spells,
			"longest": stats.longest
		}) + "\n");
	}
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	cmpTrigger.RegisterTrigger("OnInterval", "MatchIdleSample", {
		"enabled": true,
		"delay": Trigger.prototype.MatchIdleStep * 1000,
		"interval": Trigger.prototype.MatchIdleStep * 1000
	});
}
