import { aiWarn } from "simulation/ai/common-api/utils.js";

/**
 * Warns `message()` when the bot's debug level is above `level`; the message
 * is built only then, so a costly one (an uneval of a plan) costs nothing at
 * the levels games are played at.
 */
export function debugWarn(config: { debug: number }, level: number, message: () => string): void
{
	if (config.debug > level)
		aiWarn(message());
}
