/** The engine's pathfinder, the AI's only way to it */

/** The long-range path between two positions for a passability class mask, its waypoints from the end */
export function computePath(
	start: { x: number; y: number },
	end: { x: number; y: number },
	passClass: number,
): ReturnType<typeof Engine.ComputePath>
{
	return Engine.ComputePath(start, end, passClass);
}
