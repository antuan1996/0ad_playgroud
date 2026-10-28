/**
 * Mainland for two players, made symmetric: the map is generated as Mainland
 * is, then the half of player 2 is replaced with the half of player 1 turned
 * by 180 degrees about the centre (heights, textures, trees, every entity;
 * player 1's starting units become player 2's). On a circle the two starts lie
 * opposite each other, so each player has the same land around the same start.
 * For measuring AIs against each other: the start's layout, which decides most
 * games between equal bots on Mainland, plays no part.
 *
 * The copied starting units keep player 1's templates, so both players must
 * play the same civilisation.
 */
import { generateMap as generateMainland } from "maps/random/mainland.js";

export function* generateMap(mapSettings)
{
	if (getNumPlayers() != 2)
		throw new Error("mainland_mirror: made for two players, not " + getNumPlayers());
	if (getCivCode(1) != getCivCode(2))
		throw new Error("mainland_mirror: both players must play the same civilisation, not " +
			getCivCode(1) + " and " + getCivCode(2));

	const map = yield* generateMainland(mapSettings);
	mirrorHalf(map);
	return map;
}

/** Whether a tile-space position lies on player 1's side of the line between the two starts. */
function onFirstSide(position, center, axis)
{
	return (position.x - center.x) * axis.x + (position.y - center.y) * axis.y > 0;
}

/** Replaces player 2's half of the map with player 1's, turned by 180 degrees. */
function mirrorHalf(map)
{
	const size = map.getSize();
	const center = new Vector2D(size / 2, size / 2);
	const start = map.entities.find(entity => entity.player == 1 && entity.templateName.indexOf("civil_centre") != -1);
	if (!start)
		throw new Error("mainland_mirror: player 1 has no civic centre");
	const axis = Vector2D.sub(start.GetPosition2D(), center);
	// the tile (or height vertex) i of n turned by 180 degrees
	const turned = (i, n) => n - 1 - i;

	// terrain: textures and trees per tile, the heights per vertex
	for (let x = 0; x < size; ++x)
		for (let z = 0; z < size; ++z)
		{
			if (onFirstSide(new Vector2D(x + 0.5, z + 0.5), center, axis))
				continue;
			const tx = turned(x, size);
			const tz = turned(z, size);
			map.texture[x][z] = map.texture[tx][tz];
			const tree = map.terrainEntities[tx][tz];
			map.terrainEntities[x][z] = tree &&
				new Entity(map.getEntityID(), tree.templateName, tree.player,
					new Vector2D(size, size).sub(tree.GetPosition2D()), tree.rotation.y + Math.PI);
		}
	const vertices = map.height.length;
	for (let x = 0; x < vertices; ++x)
		for (let z = 0; z < vertices; ++z)
		{
			const at = TILE_CENTERED_HEIGHT_MAP ? new Vector2D(x + 0.5, z + 0.5) : new Vector2D(x, z);
			if (!onFirstSide(at, center, axis))
				map.height[x][z] = map.height[turned(x, vertices)][turned(z, vertices)];
		}

	// entities: those on player 1's side stay, and each gets its turned copy
	// (player 1's become player 2's); those on player 2's side go
	const kept = map.entities.filter(entity => onFirstSide(entity.GetPosition2D(), center, axis) && entity.player != 2);
	map.entities = kept.slice();
	for (const entity of kept)
		map.entities.push(new Entity(map.getEntityID(), entity.templateName, entity.player == 1 ? 2 : entity.player,
			new Vector2D(size, size).sub(entity.GetPosition2D()), entity.rotation.y + Math.PI));
}
