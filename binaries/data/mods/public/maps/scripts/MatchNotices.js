/**
 * Prints what the game tells a player besides the end of the game, one line
 * each, with the game time:
 *   NOTICE {"time":<ms>,"players":[..],"type":"text"|"aichat"|..,"message":".."}
 * A refused order reaches its player only this way ("Insufficient resources -
 * 50 stone", "Unable to ungarrison unit"): the command log shows the order, not
 * whether it took. "aichat" is a bot's chat (attack announcements, tribute
 * requests). The message has its parameters filled in.
 * Used by build/petra_ts/match.sh -l (notices.txt).
 */
{
	// As in MatchEnd.js: wrap the prototype, which is not serialized; it only prints.
	const guiInterface = Object.getPrototypeOf(Engine.QueryInterface(SYSTEM_ENTITY, IID_GuiInterface));
	const pushNotification = guiInterface.PushNotification;
	const logged = new Set([undefined, "text", "aichat", "attack", "tribute", "diplomacy", "barter"]);
	guiInterface.PushNotification = function(notification)
	{
		if (logged.has(notification.type) && notification.players)
		{
			const parameters = notification.parameters || {};
			const message = typeof notification.message == "string" ?
				notification.message.replace(/%\((\w+)\)s/g, (match, name) =>
					name in parameters ? String(parameters[name]) : match) :
				notification.message;
			print("NOTICE " + JSON.stringify({
				"time": Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer).GetTime(),
				"players": notification.players,
				"type": notification.type || "text",
				"message": message
			}) + "\n");
		}
		pushNotification.call(this, notification);
	};
}
