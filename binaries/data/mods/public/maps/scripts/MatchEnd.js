/**
 * Prints a line when a player wins or is defeated, with the game time and the
 * reason the game gives for it, under any victory condition:
 *   MATCHEND {"time":<ms>,"player":..,"state":"won"|"defeated"}
 *   MATCHEND {"time":<ms>,"players":[..],"state":"won"|"defeated","reason":"wonder victory"}
 * The first kind comes from the OnPlayerWon/OnPlayerDefeated events, the
 * second from the chat notification that follows ("... has won (wonder
 * victory)."), the only place the reason is given.
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

	// The reason is only in the "won" and "defeat" notifications to the GUI.
	// Wrap the prototype, which is not serialized: it only prints.
	const guiInterface = Object.getPrototypeOf(Engine.QueryInterface(SYSTEM_ENTITY, IID_GuiInterface));
	const pushNotification = guiInterface.PushNotification;
	guiInterface.PushNotification = function(notification)
	{
		if (notification.type == "won" || notification.type == "defeat")
		{
			const message = notification.message.message ?? notification.message;
			print("MATCHEND " + JSON.stringify({
				"time": Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime(),
				"players": notification.allies,
				"state": notification.type == "won" ? "won" : "defeated",
				"reason": /\(([^)]*)\)\.?$/.exec(message)?.[1] ?? message
			}) + "\n");
		}
		pushNotification.call(this, notification);
	};
}
