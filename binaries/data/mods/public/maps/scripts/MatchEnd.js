/**
 * Prints a line when a player wins or is defeated, with the game time:
 *   MATCHEND {"time":<ms>,"player":..,"state":"won"|"defeated"}
 * Unlike the engine's "Turn N" lines, it is printed in visual mode too, and it
 * dates the decision, not the moment the window is closed.
 * Used by build/petra_ts/match.sh (match-report.ts).
 */
Trigger.prototype.MatchEndPrint = function(data, state)
{
	print("MATCHEND " + JSON.stringify({
		"time": Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime(),
		"player": data.playerId,
		"state": state
	}) + "\n");
};

Trigger.prototype.MatchEndWon = function(data)
{
	this.MatchEndPrint(data, "won");
};

Trigger.prototype.MatchEndDefeated = function(data)
{
	this.MatchEndPrint(data, "defeated");
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	cmpTrigger.RegisterTrigger("OnPlayerWon", "MatchEndWon", { "enabled": true });
	cmpTrigger.RegisterTrigger("OnPlayerDefeated", "MatchEndDefeated", { "enabled": true });
}
