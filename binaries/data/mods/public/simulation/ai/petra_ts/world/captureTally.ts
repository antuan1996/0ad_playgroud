import { seconds } from "../adapter/brands.ts";

/** What our units set on one capturable target: their joint capture strength, and who they are. */
export type CaptureEntry = { strength: number; ents: Set<EntityId>; };

/**
 * The capture strength our units set on each capturable target (the AI's model of the captures under way, world/):
 * rebuilt by the headquarters every 3 s from its units' orders (Headquarters.updateCaptureStrength), added to by
 * world/capture.ts's allowCapture as attackers weigh a target between. Owned by the headquarters (HQ.captures,
 * saved through its accessors) and reached through `gameState.ai.captures` from below the decision layer.
 */
export class CaptureTally
{
	targets = new Map<EntityId, CaptureEntry>();
	/** when the headquarters last rebuilt it */
	time: GameSeconds = seconds(0);
}
