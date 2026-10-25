/**
 * Ends the game at a fixed game time (90 minutes, or the MatchTimeLimit
 * setting, -autostart-timelimit) if no one has won by then: the player with
 * the largest population (the lowest id on a tie) wins, the others are
 * defeated, with the reason "time limit". The engine only ends a game on a win,
 * so without this a bot that cannot finish a game keeps a non-visual game
 * running for good. Used by build/petra_ts/match.sh -T and its integration test,
 * which fails on that reason.
 */
Trigger.prototype.MatchTimeLimitMinutes = 90;

Trigger.prototype.MatchTimeLimitReached = function()
{
	const cmpPlayerManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_PlayerManager);
	const active = cmpPlayerManager.GetActivePlayers();
	if (!active.length)
		return;
	let leader = active[0];
	for (const player of active)
		if (QueryPlayerIDInterface(player).GetPopulationCount() > QueryPlayerIDInterface(leader).GetPopulationCount())
			leader = player;

	Engine.QueryInterface(SYSTEM_ENTITY, IID_EndGameManager).MarkPlayersAsWon(
		[leader],
		n => markForPluralTranslation(
			"%(lastPlayer)s has won (time limit).",
			"%(players)s and %(lastPlayer)s have won (time limit).",
			n),
		n => markForPluralTranslation(
			"%(lastPlayer)s has been defeated (time limit).",
			"%(players)s and %(lastPlayer)s have been defeated (time limit).",
			n));
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	const minutes = InitAttributes.settings.MatchTimeLimit ?? cmpTrigger.MatchTimeLimitMinutes;
	cmpTrigger.DoAfterDelay(minutes * 60 * 1000, "MatchTimeLimitReached", {});
}
