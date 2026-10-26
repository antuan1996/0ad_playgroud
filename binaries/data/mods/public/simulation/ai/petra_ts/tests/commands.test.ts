/**
 * commands: the one place the bot's own commands leave the AI (adapter/commands.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commands, resetRecorder } from "./harness/engine.ts";

import { entityId, playerId } from "../adapter/brands.ts";
import { debugShade, postCommand } from "../adapter/commands.ts";

describe("the bot's own commands", () =>
{
	it("hands the game the command as it was written", () =>
	{
		resetRecorder();
		const tribute: EngineCommand = { "type": "tribute", "player": playerId(2), "amounts": { "food": 100 } };
		postCommand(tribute);
		assert.deepEqual(commands, [tribute]);
	});

	it("tints entities for debugging with the game's shading command", () =>
	{
		resetRecorder();
		debugShade([entityId(1010), entityId(1011)], [2, 0, 0]);
		assert.equal(JSON.stringify(commands), JSON.stringify([{ "type": "set-shading-color", "entities": [1010, 1011], "rgb": [2, 0, 0] }]),
			"the same keys in the same order, as the command log records them");
	});
});
