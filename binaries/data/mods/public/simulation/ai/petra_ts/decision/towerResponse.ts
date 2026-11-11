/**
 * Our units under a shooting enemy structure (a tower, a fortress, a civic centre with arrows): they storm it when
 * they can take it and keep most of their strength (decision/towerFight.ts), else they get out of its reach. Asked
 * by the defense for each such structure that hit our units this turn; Petra let workers, idle soldiers and ships
 * stand under its arrows.
 *
 * Who may answer: our units within reach of it, not in a started attack (their plan fights), a defense army, a
 * transport, nor protected by the victory conditions. Those that storm are the soldiers, citizen soldiers and
 * warships among them that can attack it and reach it: on the land beside it, or the sea beside it for a ship. In
 * its owner's territory (never Gaia's) it is weighed with as many of its free garrison slots filled as its owner
 * has units by it that it takes (reinforcementOf). The party is as small as makes the storm pay, keeping
 * STORM_SAFE_LEFT when it can (STORM_MIN_LEFT else), taken cheapest to the economy first: those already striking
 * it, then the idle and others not at work, then the workers, each the nearest first; the idle beside it join
 * anyway. When those beside it are too few, out of its owner's territory, the nearest of our free soldiers farther
 * off (up to ROUND_UP_REACH beyond its reach, ROUND_UP_MOST in all) are called, the idle first, those beside it
 * holding the arrows alone until the last of them comes. The others step out of its reach if idle or hurt (below
 * FLEE_HEALTH): a gatherer whole keeps on, a weak tower shooting across a strait would else chase the workers off
 * at every arrow; when no storm pays, those striking it too, and those called before and still on their way stop.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { GAIA, worldPos } from "../adapter/brands.ts";
import { getAttackBonus, getLandAccess, getSeaAccess } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced, isStructure } from "../adapter/placed.ts";
import { combatStats } from "../adapter/templateData.ts";
import { hasActivity, unitState } from "../adapter/unitState.ts";
import { allowCapture, antiCaptureOf } from "../world/capture.ts";
import { fightSide } from "./fightEstimate.ts";
import { assessTower, type Arriving, type TowerCapture, type TowerFight, type TowerGroup } from "./towerFight.ts";

/** Metres beyond its reach within which our units count for a storm of the structure */
const STORM_REACH = 40;

/** Metres beyond its reach within which our soldiers may be called to storm it when those beside it are too few */
const ROUND_UP_REACH = 150;

/** The most soldiers a storm takes, those beside the structure and those called */
const ROUND_UP_MOST = 25;

/** Metres from a structure within which its owner's units run into it when it is stormed */
const GARRISON_REACH = 60;

/**
 * Of our strength, what a party is sized to keep when it can: a margin over STORM_MIN_LEFT, so that its first
 * losses do not turn it back at the next look
 */
const STORM_SAFE_LEFT = 0.65;

/** Metres around a structure beyond which no other structure's arrows reach its foot (a fortress's 60 and more) */
const COVER_MOST = 120;

/** A man's capture strength, as the garrison a structure may yet take is counted (a citizen soldier's) */
const GARRISON_CAPTURE = 2.5;

/** Below this health a busy unit that does not storm leaves its task to get out of reach; above it, only an idle one */
const FLEE_HEALTH = 0.5;

/** Moves a unit out of the attacker's reach (its ranged reach and 15 m, else 25 m), if it is within it */
export function fleeFrom(target: CommonPlacedEntity, attacker: CommonPlacedEntity): void
{
	const pos = attacker.position();
	const attackerRange = attacker.attackRange("Ranged");
	const range = attackerRange ? attackerRange.max + 15 : 25;
	if (range * range > SquareVectorDistance(pos, target.position()))
	{
		target.moveToRange(pos[0], pos[1], range, range + 5);
	}
}

/** Whether a structure of the enemy shoots: a ranged attack, its own arrows or a garrison's */
export function shootsArrows(structure: CommonPlacedEntity): boolean
{
	return structure.hasClass("Structure") === true && structure.attackRange("Ranged") !== undefined &&
		arrowsOf(structure) > 0;
}

/** The arrows a structure shoots: its default ones, and one a garrisoned unit */
function arrowsOf(structure: CommonPlacedEntity): number
{
	return +(structure.getDefaultArrow() || 0) + (structure.isGarrisonHolder() ? structure.garrisoned().length : 0);
}

/**
 * The men a structure in its owner's territory may yet take in: its free garrison slots, as many as its owner has
 * units near by that it takes, who fill them as soon as it is stormed (a sentry tower's two arrows became five in a
 * few seconds); none elsewhere
 */
function reinforcementOf(gameState: CommonGameState, structure: CommonPlacedEntity): number
{
	if (!structure.isGarrisonHolder() || !isOwnersLand(gameState, structure))
	{
		return 0;
	}
	const free = Math.max(0, structure.garrisonMax() - structure.garrisoned().length);
	if (!free)
	{
		return 0;
	}
	const owner = structure.owner();
	const classes = structure.garrisonableClasses();
	const able = placedWithin(
		gameState.getEnemyUnits(),
		structure.position(),
		GARRISON_REACH,
		(ent) => ent.owner() === owner && ent.hasClasses(classes) === true,
	);
	return Math.min(free, able.length);
}

/** The spot `margin` metres beyond the structure's footprint, on the side of `from` (`from` itself if nearer) */
function approachOf(structure: CommonPlacedEntity, from: CommonPosition, margin: number): CommonPosition
{
	const pos = structure.position();
	const dist = Math.sqrt(SquareVectorDistance(pos, from));
	const radius = (isStructure(structure) ? structure.footprintRadius() : 0) + margin;
	if (dist <= radius)
	{
		return from;
	}
	return worldPos(pos[0] + (from[0] - pos[0]) * radius / dist, pos[1] + (from[1] - pos[1]) * radius / dist);
}

/**
 * Whether a unit of ours can strike the structure where it stands: a land unit from the spot by its footprint on its
 * side, if on its land; a ship from its sea, somewhere between the shore by the footprint and its own reach.
 */
function canReach(gameState: CommonGameState, ent: CommonPlacedEntity, structure: CommonPlacedEntity): boolean
{
	const accessibility = gameState.ai.accessibility;
	if (!ent.hasClass("Ship"))
	{
		return accessibility.getAccessValue(approachOf(structure, ent.position(), 4)) === getLandAccess(gameState, ent);
	}
	const sea = getSeaAccess(gameState, ent);
	const reach = Math.max(ent.attackRange("Ranged")?.max ?? ent.attackRange("Melee")?.max ?? 0, 2);
	return [2, reach / 2, reach].some((margin) =>
		accessibility.getAccessValue(approachOf(structure, ent.position(), margin), true) === sea
	);
}

/** Whether a unit of ours can strike the structure: armed (no support), able to attack it, and in reach of it */
function canStorm(gameState: CommonGameState, ent: CommonPlacedEntity, structure: CommonPlacedEntity): boolean
{
	return isArmed(ent) && ent.canAttackTarget(structure, true) && canReach(gameState, ent, structure);
}

/**
 * Our capture of the structure, by those of the stormers that can capture it (undefined when none can), as the engine
 * counts it (simulation/helpers/Attack.js)
 */
function captureOf(
	gameState: CommonGameState,
	stormers: readonly CommonPlacedEntity[],
	structure: CommonPlacedEntity,
	reinforcement: number,
): TowerCapture | undefined
{
	const points = structure.capturePoints()?.[structure.owner()];
	if (!structure.isCapturable() || !points)
	{
		return undefined;
	}
	let rate = 0;
	for (const ent of stormers)
	{
		if (ent.canCapture(structure))
		{
			const repeat = (ent.attackTimes("Capture")?.repeat ?? 1000) / 1000;
			rate += (ent.captureStrength() ?? 0) * getAttackBonus(ent, structure, "Capture") / repeat;
		}
	}
	// as the engine's capture effect: less by its resistance, more the more it is damaged
	rate *= Math.pow(0.9, structure.resistanceStrengths()?.Capture ?? 0) / (0.1 + 0.9 * structure.healthLevel());
	const regen = antiCaptureOf(gameState, structure) +
		reinforcement * structure.garrisonRegenRate() * GARRISON_CAPTURE;
	return rate > 0 ? { rate, regen, points } : undefined;
}

/** Whether the unit is already striking the structure */
function striking(ent: CommonEntity, structure: CommonEntity): boolean
{
	const orders = ordersOf(ent);
	return orders.length > 0 && orders[0].target === structure.id();
}

/** Whether a unit fights: armed, and no support unit */
function isArmed(ent: CommonEntity): boolean
{
	return !ent.hasClass("Support") && ent.attackTypes() !== undefined;
}

/** The placed entities of a collection within `reach` of `pos` that `keep` keeps */
function placedWithin(
	entities: CommonEntityCollection,
	pos: CommonPosition,
	reach: number,
	keep: (ent: CommonPlacedEntity) => boolean,
): CommonPlacedEntity[]
{
	const found: CommonPlacedEntity[] = [];
	for (const ent of entities.values())
	{
		if (isPlaced(ent) && SquareVectorDistance(ent.position(), pos) < reach * reach && keep(ent))
		{
			found.push(ent);
		}
	}
	return found;
}

/**
 * Our units within `reach` of `pos` that `keep` keeps, those that take orders only: a trained goat or sheep is a
 * unit without a UnitAI (the engine has no orders of it to read)
 */
function oursWithin(
	gameState: CommonGameState,
	pos: CommonPosition,
	reach: number,
	keep: (ent: CommonPlacedEntity) => boolean,
): CommonPlacedEntity[]
{
	return placedWithin(gameState.getOwnUnits(), pos, reach, (ent) => unitState(ent).kind !== "none" && keep(ent));
}

/** The enemy structures (the tower apart) whose arrows reach the tower's foot, with the arrows each shoots */
function coverOf(
	gameState: CommonGameState,
	structure: CommonPlacedEntity,
): Array<{ structure: CommonPlacedEntity; arrows: number; }>
{
	const pos = structure.position();
	const cover: Array<{ structure: CommonPlacedEntity; arrows: number; }> = [];
	for (const other of gameState.getEnemyStructures().values())
	{
		if (
			other.id() === structure.id() || !isPlaced(other) ||
			SquareVectorDistance(other.position(), pos) > COVER_MOST * COVER_MOST || !shootsArrows(other)
		)
		{
			continue;
		}
		const range = (other.attackRange("Ranged")?.max ?? 0) +
			(isStructure(structure) ? structure.footprintRadius() : 0);
		if (SquareVectorDistance(other.position(), pos) < range * range)
		{
			cover.push({ structure: other, arrows: arrowsOf(other) });
		}
	}
	return cover;
}

/** Whether the structure stands in its owner's territory */
function isOwnersLand(gameState: CommonGameState, structure: CommonPlacedEntity): boolean
{
	// Gaia owns no territory: the 0 of unowned land is not its
	return structure.owner() !== GAIA &&
		gameState.ai.geography.territoryMap.getOwner(structure.position()) === structure.owner();
}

/** Our soldiers farther from the structure who could join a storm of it, the nearest first */
function reserveFor(
	gameState: CommonGameState,
	structure: CommonPlacedEntity,
	near: ReadonlySet<CommonPlacedEntity>,
	free: (ent: CommonPlacedEntity) => boolean,
): CommonPlacedEntity[]
{
	const pos = structure.position();
	const reach = (structure.attackRange("Ranged")?.max ?? 0) + ROUND_UP_REACH;
	const reserve = oursWithin(
		gameState,
		pos,
		reach,
		(ent) => !near.has(ent) && free(ent) && canStorm(gameState, ent, structure),
	);
	return cheapestFirst(reserve, structure);
}

/** Whether the unit is at work for the economy: gathering, carrying its load home or building */
function atWork(ent: CommonEntity): boolean
{
	return hasActivity(ent, "GATHER") || hasActivity(ent, "RETURNRESOURCE") || hasActivity(ent, "REPAIR");
}

/**
 * The units in the order a storm of the structure takes them, the cheapest to the economy first: those already
 * striking it, then those not at work, then the workers, each the nearest first.
 */
function cheapestFirst(units: CommonPlacedEntity[], structure: CommonPlacedEntity): CommonPlacedEntity[]
{
	const pos = structure.position();
	const cost = (ent: CommonPlacedEntity): number => striking(ent, structure) ? 0 : atWork(ent) ? 2 : 1;
	const distance = (ent: CommonPlacedEntity): number => SquareVectorDistance(ent.position(), pos);
	return units.sort((a, b) => cost(a) - cost(b) || distance(a) - distance(b));
}

/**
 * Units called from farther off as they join a storm of the structure: their side, and the seconds until the last
 * of them is at its foot (undefined when none is called)
 */
function arrivingOf(called: readonly CommonPlacedEntity[], structure: CommonPlacedEntity): Arriving | undefined
{
	if (!called.length)
	{
		return undefined;
	}
	const pos = structure.position();
	const radius = isStructure(structure) ? structure.footprintRadius() : 0;
	let seconds = 0;
	for (const ent of called)
	{
		const walk = Math.max(0, Math.sqrt(SquareVectorDistance(ent.position(), pos)) - radius);
		seconds = Math.max(seconds, walk / Math.max(ent.walkSpeed(), 1));
	}
	return { side: fightSide(called), seconds };
}

/** A party weighed: who storms, and what was weighed for them */
type Weighed = { party: readonly CommonPlacedEntity[]; fight: TowerFight; };

/**
 * The smallest size from `least` to `most` of the candidates' prefix that makes the storm pay, keeping
 * STORM_SAFE_LEFT if any size does, else STORM_MIN_LEFT (the verdict taken to grow with the size: halved
 * search); undefined when even `most` does not pay
 */
function smallestParty(
	candidates: readonly CommonPlacedEntity[],
	least: number,
	most: number,
	weigh: (party: readonly CommonPlacedEntity[]) => TowerFight,
): Weighed | undefined
{
	const weighed = new Map<number, Weighed>();
	const at = (size: number): Weighed =>
	{
		let found = weighed.get(size);
		if (!found)
		{
			const party = candidates.slice(0, size);
			found = { party, fight: weigh(party) };
			weighed.set(size, found);
		}
		return found;
	};
	if (most < least || at(most).fight.verdict !== "storm")
	{
		return undefined;
	}
	const enough = at(most).fight.ourFractionLeft >= STORM_SAFE_LEFT ?
		(size: number) => at(size).fight.ourFractionLeft >= STORM_SAFE_LEFT :
		(size: number) => at(size).fight.verdict === "storm";
	let low = least;
	let high = most;
	while (low < high)
	{
		const mid = Math.floor((low + high) / 2);
		if (enough(mid))
		{
			high = mid;
		}
		else
		{
			low = mid + 1;
		}
	}
	return at(high);
}

/**
 * The party that storms the structure, with what was weighed for it: of the stormers beside it (cheapest first, the
 * first `free` of them idle or already striking it, who join at no cost to the economy), as few as make the storm
 * pay and the free ones; when they do not, as few of the `reserve` (asked only then) as make it pay with them all,
 * ROUND_UP_MOST at most in all. When none pays, all the stormers beside it and what they weigh.
 */
function partyFor(
	stormers: readonly CommonPlacedEntity[],
	free: number,
	reserve: () => readonly CommonPlacedEntity[],
	weigh: (party: readonly CommonPlacedEntity[]) => TowerFight,
): Weighed
{
	const beside = smallestParty(stormers, 1, stormers.length, weigh);
	if (beside)
	{
		return beside.party.length >= free ?
			beside :
			{ party: stormers.slice(0, free), fight: weigh(stormers.slice(0, free)) };
	}
	const candidates = [...stormers, ...reserve()];
	const most = Math.min(candidates.length, Math.max(ROUND_UP_MOST, stormers.length));
	return smallestParty(candidates, stormers.length + 1, most, weigh) ?? { party: stormers, fight: weigh(stormers) };
}

/** The party strikes the structure: each booked on the capture of it first, so that each order weighs their joint strength */
function storm(gameState: CommonGameState, party: readonly CommonPlacedEntity[], structure: CommonPlacedEntity): void
{
	for (const ent of party)
	{
		allowCapture(gameState, ent, structure);
	}
	for (const ent of party)
	{
		if (!striking(ent, structure))
		{
			ent.attack(structure.id(), allowCapture(gameState, ent, structure));
		}
	}
}

/**
 * Our units answer a shooting enemy structure that hit some of them: `free` tells those that may (see the module's
 * head). They storm it, called from farther when those beside it are too few, or flee it; what was weighed is
 * returned.
 */
export function answerTower(
	gameState: CommonGameState,
	structure: CommonPlacedEntity,
	free: (ent: CommonPlacedEntity) => boolean,
): TowerFight
{
	const pos = structure.position();
	const reach = (structure.attackRange("Ranged")?.max ?? 0) + STORM_REACH;
	const near = oursWithin(gameState, pos, reach, free);
	const stormers = cheapestFirst(near.filter((ent) => canStorm(gameState, ent, structure)), structure);
	const guards = fightSide(
		placedWithin(gameState.getEnemyUnits(), pos, reach, (ent) => isArmed(ent)),
		coverOf(gameState, structure),
	);
	const tower: TowerGroup = {
		stats: combatStats(structure),
		count: arrowsOf(structure),
		hpFraction: structure.healthLevel(),
	};
	const reinforcement = reinforcementOf(gameState, structure);
	tower.count += reinforcement;
	const nearby = new Set(near);
	const weigh = (party: readonly CommonPlacedEntity[]): TowerFight =>
		assessTower(
			fightSide(party.filter((ent) => nearby.has(ent))),
			tower,
			guards,
			captureOf(gameState, party, structure, reinforcement),
			arrivingOf(party.filter((ent) => !nearby.has(ent)), structure),
		);
	// nobody is called into its owner's territory, where more of its men come as soon as ours do
	const { party, fight } = partyFor(
		stormers,
		stormers.filter((ent) => striking(ent, structure) || !atWork(ent)).length,
		() => isOwnersLand(gameState, structure) ? [] : reserveFor(gameState, structure, nearby, free),
		weigh,
	);
	if (fight.verdict === "storm")
	{
		storm(gameState, party, structure);
		const stormed = new Set(party);
		for (const ent of near)
		{
			if (!stormed.has(ent) && (ent.isIdle() || ent.healthLevel() < FLEE_HEALTH))
			{
				fleeFrom(ent, structure);
			}
		}
		return fight;
	}
	for (const ent of near)
	{
		if (ent.isIdle() || ent.healthLevel() < FLEE_HEALTH || striking(ent, structure))
		{
			fleeFrom(ent, structure);
		}
	}
	// those called to it before and still on their way
	const reach2 = (structure.attackRange("Ranged")?.max ?? 0) + ROUND_UP_REACH;
	for (const ent of oursWithin(gameState, pos, reach2, (ent) => !nearby.has(ent) && free(ent)))
	{
		if (striking(ent, structure))
		{
			ent.stopMoving();
		}
	}
	return fight;
}
