/**
 * This class will spawn a dialog with the result of each player once a player has won,
 * in case the user observes the game (and it is not a replay, which has its own dialog).
 * With -autostart-stop-on-end the simulation stays on that turn, so staying shows the final state.
 */
class QuitConfirmationObserver extends QuitConfirmation
{
	constructor(closeSession)
	{
		super();

		if (Engine.IsAtlasRunning())
			return;

		this.shown = false;
		registerPlayersFinishedHandler(this.onPlayersFinished.bind(this, closeSession));
	}

	onPlayersFinished(closeSession, players, won, message)
	{
		if (!won || this.shown || g_IsReplay || Engine.GetPlayerID() != -1)
			return;

		this.shown = true;

		// The simulation already holds every result of the turn, while g_Players
		// may not be updated yet.
		const states = Engine.GuiInterfaceCall("GetSimulationState").players;
		// How the game was won, as in the chat: "... has won (wonder victory)."
		const reason = new ChatMessageFormatSimulation.playerstate().parse({ "message": message, "players": players }).text;
		this.Caption = reason + "\n\n" + states.slice(1).map((player, i) =>
			sprintf(translate("%(player)s: %(state)s"), {
				"player": colorizePlayernameByID(i + 1),
				"state": this.States[player.state] || player.state
			})).join("\n") + "\n\n" + QuitConfirmation.prototype.Caption;
		this.Height = 200 + 20 * (states.length - 1);

		this.display(closeSession);
	}
}

QuitConfirmationObserver.prototype.Title = translate("GAME OVER");

QuitConfirmationObserver.prototype.States = {
	"won": translateWithContext("player state", "won"),
	"defeated": translateWithContext("player state", "defeated"),
	"active": translateWithContext("player state", "still playing")
};
