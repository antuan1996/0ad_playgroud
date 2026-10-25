/**
 * commands: the one place the bot's own commands leave the AI (adapter/commands.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands, resetRecorder } from "./harness/engine.ts";
import { loadPetraModule } from "./harness/target.ts";

const { postCommand, debugShade } = await loadPetraModule<{
	postCommand(command: Record<string, unknown>): void;
	debugShade(entities: number[], rgb: [number, number, number]): void;
}>("commands");

describe("the bot's own commands", () =>
{
	it("hands the game the command as it was written", () =>
	{
		resetRecorder();
		const tribute = { "type": "tribute", "player": 2, "amounts": { "food": 100 } };
		postCommand(tribute);
		assert.deepEqual(commands, [tribute]);
	});

	it("tints entities for debugging with the game's shading command", () =>
	{
		resetRecorder();
		debugShade([1010, 1011], [2, 0, 0]);
		assert.equal(JSON.stringify(commands), JSON.stringify([{ "type": "set-shading-color", "entities": [1010, 1011], "rgb": [2, 0, 0] }]),
			"the same keys in the same order, as the command log records them");
	});
});
