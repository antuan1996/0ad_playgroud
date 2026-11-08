import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance } from "simulation/ai/common-api/utils.js";
import { worldPos } from "../adapter/brands.ts";
import { getLandAccess, requireValue } from "../adapter/entityExtend.ts";
import { computePath } from "../adapter/pathfinder.ts";
import { isPlaced } from "../adapter/placed.ts";
import { obstructionShape } from "../adapter/templateData.ts";
import { basesOf } from "../world/bases.ts";
import { hqOf } from "./hq.ts";

/** What the distance to a dock or a foundation counts for in a naval map's target pick (getNearestTarget). */
const ECONOMIC_TARGET_WEIGHT = 0.25;

/**
 * The nearest base anchors to the target position: on its land, and elsewhere (the distance weighted by the
 * size of the island)
 */
export function nearestBaseAnchors(
	gameState: CommonGameState,
	targetIndex: AccessIndex,
	targetPos: CommonPosition,
): { rallySame: CommonPosition | undefined; rallyDiff: CommonPosition | undefined; }
{
	let distminSame = Math.min();
	let rallySame;
	let distminDiff = Math.min();
	let rallyDiff;
	for (const base of basesOf(gameState))
	{
		const anchor = base.anchor;
		const anchorPos = anchor ? anchor.position() : undefined;
		if (!anchorPos)
		{
			continue;
		}
		const accessIndex = base.accessIndex;
		let dist = SquareVectorDistance(anchorPos, targetPos);
		if (accessIndex === targetIndex)
		{
			if (dist >= distminSame)
			{
				continue;
			}
			distminSame = dist;
			rallySame = anchorPos;
		}
		else
		{
			if (accessIndex === undefined)
			{
				continue;
			}
			dist /= Math.sqrt(gameState.ai.accessibility.regionSize[accessIndex]);
			if (dist >= distminDiff)
			{
				continue;
			}
			distminDiff = dist;
			rallyDiff = anchorPos;
		}
	}
	return { rallySame, rallyDiff };
}

/**
 * Where an army may gather: the first base anchor of ours on the map (else any entity of ours), its land,
 * and a gathering point on each land with an anchor
 */
export function rallyPoints(
	gameState: CommonGameState,
): { rallyPoint: CommonPosition; rallyAccess: AccessIndex; allAccesses: Record<number, CommonPosition>; } | undefined
{
	let rallyPoint;
	let rallyAccess;
	const allAccesses: Record<number, CommonPosition> = {};
	for (const base of basesOf(gameState))
	{
		if (!base.anchor || !isPlaced(base.anchor))
		{
			continue;
		}
		const anchorPos = base.anchor.position();
		const access = getLandAccess(gameState, base.anchor);
		if (access === undefined)
		{
			continue;
		}
		if (!rallyPoint)
		{
			rallyPoint = anchorPos;
			rallyAccess = access;
		}
		if (!allAccesses[access])
		{
			allAccesses[access] = anchorPos;
		}
	}
	if (rallyPoint && rallyAccess !== undefined)
	{
		return { rallyPoint, rallyAccess, allAccesses };
	}
	// no base ?  take the position of any of our entities
	for (const ent of gameState.getOwnEntities().values())
	{
		if (!isPlaced(ent))
		{
			continue;
		}
		const access = getLandAccess(gameState, ent);
		if (access === undefined)
		{
			continue;
		}
		const entPos = ent.position();
		allAccesses[access] = entPos;
		return { rallyPoint: entPos, rallyAccess: access, allAccesses };
	}
	return undefined;
}

/** Whether a defensive building stands within 80 of the position (TODO check on defense range rather than this fixed 80*80) */
function isDefended(pos: CommonPosition, buildings: CommonStructureEntity[]): boolean
{
	for (const defense of buildings)
	{
		if (!defense.hasDefensiveFire())
		{
			continue;
		}
		const defPos = defense.position();
		if (SquareVectorDistance(pos, defPos) < 6400)
		{
			return true;
		}
	}
	return false;
}

/** Whether the path crosses the gate's line out of its door */
function crossesGate(
	struct: CommonEntity,
	doorHalfWidth: number,
	cosa: number,
	sina: number,
	path: Array<{ x: number; y: number; }>,
): boolean
{
	const structPos = requireValue(struct.position());
	for (let i = 1; i < path.length; ++i)
	{
		const u1 = (path[i - 1].x - structPos[0]) * cosa - (path[i - 1].y - structPos[1]) * sina;
		const v1 = (path[i - 1].x - structPos[0]) * sina + (path[i - 1].y - structPos[1]) * cosa;
		const u2 = (path[i].x - structPos[0]) * cosa - (path[i].y - structPos[1]) * sina;
		const v2 = (path[i].x - structPos[0]) * sina + (path[i].y - structPos[1]) * cosa;
		if (v1 * v2 < 0)
		{
			const u0 = (u1 * v2 - u2 * v1) / (v2 - v1);
			if (Math.abs(u0) > doorHalfWidth)
			{
				continue;
			}
			return true;
		}
	}
	return false;
}

/**
 * Whether a structure blocks the way: the point (x, y), relative to it, a step ahead on the path, is inside its
 * obstruction, or the path crosses a gate (that could happen if not locked) out of its door
 */
function blocksWay(
	struct: CommonEntity,
	shape: NonNullable<ReturnType<typeof obstructionShape>>,
	at: { x: number; y: number; },
	path: Array<{ x: number; y: number; }>,
): boolean
{
	const { x, y } = at;
	if (shape.kind !== "static" && shape.kind !== "gate")
	{
		return x * x + y * y < shape.radius * shape.radius;
	}
	const angle = struct.angle();
	if (angle === undefined)
	{
		return false;
	}
	const { width, depth } = shape;
	const cosa = Math.cos(angle);
	const sina = Math.sin(angle);
	const u = x * cosa - y * sina;
	const v = x * sina + y * cosa;
	if (Math.abs(u) < width / 2 && Math.abs(v) < depth / 2)
	{
		return true;
	}
	return shape.kind === "gate" && crossesGate(struct, shape.doorHalfWidth, cosa, sina, path);
}

/** Whether a target is worth attacking: on the given land, when one is given, and not a decaying empty building */
function isValidTarget(gameState: CommonGameState, ent: CommonEntity, sameLand: AccessIndex | false): boolean
{
	if (!isPlaced(ent))
	{
		return false;
	}
	if (sameLand && getLandAccess(gameState, ent) !== sameLand)
	{
		return false;
	}
	return !ent.decaying() || !!ent.getDefaultArrow() || ent.isGarrisonHolder() && (ent.garrisoned() || []).length > 0;
}

/**
 * Default target finder aims for conquest critical targets
 * We must apply the *same* selection (isValidTarget) as done in getNearestTarget
 */
export function defaultTargetFinder(
	gameState: CommonGameState,
	playerEnemy: PlayerId,
	sameLand: AccessIndex | false = false,
): CommonEntityCollection
{
	let targets = new EntityCollection(gameState.sharedScript);
	if (gameState.getVictoryConditions().has("wonder"))
	{
		for (const ent of gameState.getEnemyStructures(playerEnemy).filter(filters.byClass("Wonder")).values())
		{
			targets.addEnt(ent);
		}
	}
	if (gameState.getVictoryConditions().has("regicide"))
	{
		for (const ent of gameState.getEnemyUnits(playerEnemy).filter(filters.byClass("Hero")).values())
		{
			targets.addEnt(ent);
		}
	}
	if (gameState.getVictoryConditions().has("capture_the_relic"))
	{
		for (
			const ent of gameState.updatingGlobalCollection("allRelics", filters.byClass("Relic")).filter((relic) =>
				relic.owner() === playerEnemy
			).values()
		)
		{
			targets.addEnt(ent);
		}
	}
	targets = targets.filter((ent: CommonEntity): boolean => isValidTarget(gameState, ent, sameLand));
	if (targets.hasEntities())
	{
		return targets;
	}

	const validTargets = gameState.getEnemyStructures(playerEnemy).filter((ent: CommonEntity): boolean =>
		isValidTarget(gameState, ent, sameLand)
	);
	// on a naval map the docks too, which the nearest pick favours (FINDINGS §42)
	targets = validTargets.filter(
		filters.byClasses(gameState.ai.geography.navalMap ? ["CivCentre", "Dock"] : ["CivCentre"]),
	);
	if (!targets.hasEntities())
	{
		targets = validTargets.filter(filters.byClass("ConquestCritical"));
	}
	// If there's nothing, attack anything else that's less critical
	if (!targets.hasEntities())
	{
		targets = validTargets.filter(filters.byClass("Town"));
	}
	if (!targets.hasEntities())
	{
		targets = validTargets.filter(filters.byClass("Village"));
	}
	// No buildings, attack anything conquest critical, units included.
	// TODO Should add naval attacks against the last remaining ships.
	if (!targets.hasEntities())
	{
		targets = gameState.getEntities(playerEnemy).filter(filters.byClass("ConquestCritical")).filter(
			filters.not(filters.byClass("Ship")),
		);
	}
	return targets;
}

/** Rush target finder aims at isolated non-defended buildings */
export function findRushTarget(
	gameState: CommonGameState,
	myPos: CommonPosition | undefined,
	playerEnemy: PlayerId | undefined,
	sameLand: AccessIndex | false,
	isRush: boolean,
): CommonEntityCollection
{
	const targets = new EntityCollection(gameState.sharedScript);
	const buildings = playerEnemy !== undefined ?
		gameState.getEnemyStructures(playerEnemy).toEntityArray() :
		gameState.getEnemyStructures().toEntityArray();
	if (!buildings.length || !myPos)
	{
		return targets;
	}

	let target;
	let minDist = Math.min();
	for (const building of buildings)
	{
		if (building.owner() === 0)
		{
			continue;
		}
		if (building.hasDefensiveFire())
		{
			continue;
		}
		if (!isValidTarget(gameState, building, sameLand))
		{
			continue;
		}
		const pos = building.position();
		if (isDefended(pos, buildings))
		{
			continue;
		}
		const dist = SquareVectorDistance(pos, myPos);
		if (dist > minDist)
		{
			continue;
		}
		minDist = dist;
		target = building;
	}
	if (target)
	{
		targets.addEnt(target);
	}

	if (!targets.hasEntities() && isRush && playerEnemy)
	{
		return findRushTarget(gameState, myPos, undefined, sameLand, true);
	}

	return targets;
}

/** Raid target finder aims at destructing foundations from which our defenseManager has attacked the builders */
export function raidTargetFinder(gameState: CommonGameState): CommonEntityCollection
{
	const targets = new EntityCollection(gameState.sharedScript);
	for (const targetId of hqOf(gameState).defenseManager.targetList)
	{
		const target = gameState.getEntityById(targetId);
		if (target && isPlaced(target))
		{
			targets.addEnt(target);
		}
	}
	return targets;
}

/** How far a target counts from the position, or undefined for a pointless one */
export function targetDistance(
	gameState: CommonGameState,
	ent: CommonEntity,
	position: CommonPosition,
	query: { land: AccessIndex | false; targetPlayer: PlayerId; type: string; },
): number | undefined
{
	const { land, targetPlayer, type } = query;
	if (
		targetPlayer === 0 && gameState.getVictoryConditions().has("capture_the_relic") &&
		(!ent.hasClass("Relic") || hqOf(gameState).victoryManager.isRelicRaided(ent.id()))
	)
	{
		return undefined;
	}
	// Do not bother with some pointless targets
	if (!isValidTarget(gameState, ent, land))
	{
		return undefined;
	}
	if (!isPlaced(ent))
	{
		return undefined;
	}
	const entPos = ent.position();
	let dist = SquareVectorDistance(entPos, position);
	// In normal attacks, disfavor fields
	if (type !== "Rush" && type !== "Raid" && ent.hasClass("Field"))
	{
		dist += 100000;
	}
	// On a naval map, a dock (the enemy's fishing and transport) or a base
	// still being built counts as nearer: on islands what the enemy lives on
	// is worth more than the hall of its home island, and Petra's attacks
	// landed under the towers of civic centres for little (FINDINGS §42)
	if (
		type !== "Raid" && gameState.ai.geography.navalMap &&
		(ent.hasClass("Dock") || ent.foundationProgress() !== undefined)
	)
	{
		dist *= ECONOMIC_TARGET_WEIGHT;
	}
	return dist;
}

/**
 * Check that we can have a path to this target
 * otherwise we may be blocked by walls and try to react accordingly
 * This is done only when attacker and target are on the same land
 */
export function findTargetObstruction(
	gameState: CommonGameState,
	target: CommonEntity,
	position: CommonPosition,
): { target: CommonEntity | undefined; blocked: boolean; }
{
	if (getLandAccess(gameState, target) !== gameState.ai.accessibility.getAccessValue(position))
	{
		return { target, blocked: false };
	}

	if (!isPlaced(target))
	{
		return { target: undefined, blocked: false };
	}
	const targetPos = target.position();
	const startPos = { x: position[0], y: position[1] };
	const endPos = { x: targetPos[0], y: targetPos[1] };
	let blocker;
	const path = computePath(startPos, endPos, gameState.getPassabilityClassMask("default"));
	if (!path.length)
	{
		return { target: undefined, blocked: false };
	}

	const pathPos: CommonPosition = worldPos(path[0].x, path[0].y);
	const dist = VectorDistance(pathPos, targetPos);
	// targets (units or structures) always have an obstruction
	const radius = requireValue(target.obstructionRadius()).max;
	for (const struct of gameState.getEnemyStructures().values())
	{
		const structPos = struct.position();
		const shape = obstructionShape(struct);
		if (!structPos || !shape || struct.hasClass("Field"))
		{
			continue;
		}
		// we consider that we can reach the target, but nonetheless check that we did not cross any enemy gate
		if (dist < radius + 10 && !struct.hasClass("Gate"))
		{
			continue;
		}
		// Check that we are really blocked by this structure, i.e. advancing by 1+0.8(clearance)m
		// in the target direction would bring us inside its obstruction.
		const x = pathPos[0] - structPos[0] + 1.8 * (targetPos[0] - pathPos[0]) / dist;
		const y = pathPos[1] - structPos[1] + 1.8 * (targetPos[1] - pathPos[1]) / dist;
		if (blocksWay(struct, shape, { x, y }, path))
		{
			blocker = struct;
			break;
		}
	}

	if (blocker)
	{
		return { target: blocker, blocked: true };
	}

	return { target, blocked: false };
}
