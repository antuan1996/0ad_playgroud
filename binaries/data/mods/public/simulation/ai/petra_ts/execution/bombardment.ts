/**
 * The town's bombardment (`gameState.ai.town.bombing`, part of execution/town.ts): our idle bolt shooters and
 * stone throwers, in no plan and marching with none, sent to shoot the enemy structures in range from our
 * territory, five at most against one, while they wait for their attack to start. The attack manager makes it
 * and says when (its update, and the renames of packing units); it asks nothing of the decision layer, and is not
 * saved (the bombers are sent again).
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { VectorDistance } from "simulation/ai/common-api/utils.js";
import { worldPos } from "../adapter/brands.ts";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { allowCapture } from "../world/capture.ts";
import { isLent } from "./unitPlan.ts";
import { marchesWithAttack } from "./worker.ts";

/** Whether a bomber still has the target as its last order and is lent to nothing */
function stillBombing(ent: CommonEntity, targetId: EntityId): boolean
{
	const plan = ent.getMetadata(PlayerID, "plan");
	const orders = ordersOf(ent);
	const lastOrder = orders && orders.length ? orders[orders.length - 1] : null;
	return !!lastOrder && !!lastOrder.target && lastOrder.target === targetId && !isLent(plan);
}

/**
 * Where a bomber out of range goes to shoot the structure: at range on the line to it, on our territory and land,
 * with the structure's surroundings not the enemy's; undefined if there is no such place.
 */
function bombingSpot(
	gameState: CommonGameState,
	from: { pos: CommonPosition; access: AccessIndex; },
	struct: CommonStructureEntity,
	dist: number,
	range: number,
): CommonPosition | undefined
{
	const entPos = from.pos;
	const structPos = struct.position();
	const safety = struct.footprintRadius() + 30;
	const safePos = worldPos(
		structPos[0] + (entPos[0] - structPos[0]) * safety / dist,
		structPos[1] + (entPos[1] - structPos[1]) * safety / dist,
	);
	const owner = gameState.ai.geography.territoryMap.getOwner(safePos);
	if (owner !== 0 && gameState.isPlayerEnemy(owner))
	{
		return undefined;
	}
	const targetPos = worldPos(
		structPos[0] + (entPos[0] - structPos[0]) * range / dist,
		structPos[1] + (entPos[1] - structPos[1]) * range / dist,
	);
	if (
		gameState.ai.geography.territoryMap.getOwner(targetPos) !== PlayerID ||
		gameState.ai.accessibility.getAccessValue(targetPos) !== from.access
	)
	{
		return undefined;
	}
	return targetPos;
}

export class Bombardment
{
	/** Temporary attacks for siege units while waiting their current attack to start, by target */
	readonly bombingAttacks = new Map<EntityId, Set<EntityId>>();

	/** A bombing's target or bomber renamed (packed or unpacked) */
	renameInBombings(entity: EntityId, newentity: EntityId): void
	{
		for (const [targetId, unitIds] of this.bombingAttacks)
		{
			if (targetId === entity)
			{
				this.bombingAttacks.set(newentity, unitIds);
				this.bombingAttacks.delete(entity);
			}
			else if (unitIds.has(entity))
			{
				unitIds.add(newentity);
				unitIds.delete(entity);
			}
		}
	}

	/**
	 * Check for any structure in range from within our territory, and bomb it
	 */
	assignBombers(gameState: CommonGameState): void
	{
		this.cleanBombings(gameState);

		const bombers = gameState.updatingCollection(
			"bombers",
			filters.byClasses(["BoltShooter", "StoneThrower"]),
			gameState.getOwnUnits(),
		);
		for (const ent of bombers.values())
		{
			// Filtered on having a Ranged attack, so attackRange("Ranged") is defined.
			const ranged = ent.attackRange("Ranged");
			if (!isPlaced(ent) || !ent.isIdle() || !ranged)
			{
				continue;
			}
			if (isLent(ent.getMetadata(PlayerID, "plan")))
			{
				continue;
			}
			if (marchesWithAttack(ent))
			{
				continue;
			}
			if (this.isBombing(ent.id()))
			{
				break;
			}
			this.bombAStructure(gameState, ent, ranged.max);
		}
	}

	/** The bombings drop their units gone or sent elsewhere, and the targets gone or no more enemy */
	private cleanBombings(gameState: CommonGameState): void
	{
		for (const [targetId, unitIds] of this.bombingAttacks)
		{
			const target = gameState.getEntityById(targetId);
			if (!target || !gameState.isPlayerEnemy(target.owner()))
			{
				this.bombingAttacks.delete(targetId);
				continue;
			}
			for (const entId of unitIds.values())
			{
				const ent = gameState.getEntityById(entId);
				if (ent && ent.owner() === PlayerID && stillBombing(ent, targetId))
				{
					continue;
				}
				unitIds.delete(entId);
			}
			if (!unitIds.size)
			{
				this.bombingAttacks.delete(targetId);
			}
		}
	}

	/** Whether the unit bombs a target already */
	private isBombing(id: EntityId): boolean
	{
		for (const unitIds of this.bombingAttacks.values())
		{
			if (unitIds.has(id))
			{
				return true;
			}
		}
		return false;
	}

	/** The bomber attacks the first enemy structure it can reach from our territory, unless 5 bomb it already */
	private bombAStructure(gameState: CommonGameState, ent: CommonPlacedEntity, range: number): void
	{
		const entPos = ent.position();
		const access = getLandAccess(gameState, ent);
		for (const struct of gameState.getEnemyStructures().values())
		{
			if (!ent.canAttackTarget(struct, allowCapture(gameState, ent, struct)))
			{
				continue;
			}

			const structPos = struct.position();
			if (struct.hasClass("Field"))
			{
				if (
					!struct.resourceSupplyNumGatherers() ||
					!gameState.isPlayerEnemy(gameState.ai.geography.territoryMap.getOwner(structPos))
				)
				{
					continue;
				}
			}
			const dist = VectorDistance(entPos, structPos);
			// targetPos holds the position to move to when out of range.
			let targetPos: CommonPosition | undefined;
			if (dist > range)
			{
				targetPos = bombingSpot(gameState, { pos: entPos, access }, struct, dist, range);
				if (!targetPos)
				{
					continue;
				}
			}
			let attackingUnits = this.bombingAttacks.get(struct.id());
			if (attackingUnits && attackingUnits.size > 4)
			{
				continue; // already enough units against that target
			}
			if (!attackingUnits)
			{
				attackingUnits = new Set<EntityId>();
				this.bombingAttacks.set(struct.id(), attackingUnits);
			}
			attackingUnits.add(ent.id());
			if (targetPos)
			{
				ent.move(targetPos[0], targetPos[1]);
			}
			ent.attack(struct.id(), false, dist > range);
			return;
		}
	}
}
