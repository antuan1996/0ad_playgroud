/**
 * Prints every command the simulation processes, one line each, with the game
 * time in milliseconds and the player who sent it:
 *   COMMAND <ms> <player> {"type":..,..}
 * The AIs' commands are not recorded in the replay (the AIs run again on
 * playback), so this is the way to see what each bot did and to diff two runs:
 * with the same seeds the first differing line is where they diverge.
 * Commands of an unknown type are left out: the simulation rejects them.
 * Used by build/petra_ts/match.sh -l.
 */
Trigger.prototype.MatchCommandsPrint = function(data)
{
	print("COMMAND " + Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime() + " " + data.player + " " +
		JSON.stringify(data.cmd) + "\n");
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	cmpTrigger.RegisterTrigger("OnPlayerCommand", "MatchCommandsPrint", { "enabled": true });
}
