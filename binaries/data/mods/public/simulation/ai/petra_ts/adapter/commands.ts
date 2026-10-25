/**
 * The commands the bot itself sends to the game (PLAN.md §3.4, the adapter):
 * diplomacy, tributes, chat, trading goods, dropsite sharing and the debug
 * shading. Everything goes through postCommand, so there is one place where
 * the bot's own commands leave the AI. The units' orders (move, gather,
 * attack, ...) still go through common-api's entity wrappers, which post
 * them themselves.
 */

/** Sends one command as this player; the command is the object the game receives. */
export function postCommand(command: PetraEngineCommand): void
{
	Engine.PostCommand(PlayerID, command);
}

/** Debug only: tints entities with an RGB colour (each channel a multiplier). */
export function debugShade(entities: EntityId[], rgb: [number, number, number]): void
{
	postCommand({ "type": "set-shading-color", "entities": entities, "rgb": rgb });
}
