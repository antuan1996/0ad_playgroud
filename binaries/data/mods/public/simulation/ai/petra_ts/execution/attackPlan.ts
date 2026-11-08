import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import {
	INVALID_PLAYER,
	NO_BASE,
	NO_LAND,
	NO_REGION,
	attackPlanId,
	playerId,
	seconds,
	worldPos,
} from "../adapter/brands.ts";
import { debugShade, postCommand } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import {
	dumpEntity,
	getHolder,
	getLandAccess,
	isSiegeUnit,
	requireTemplate,
	requireValue,
	returnResources,
} from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { computePath } from "../adapter/pathfinder.ts";
import { isPlaced } from "../adapter/placed.ts";
import { basesOf } from "../world/bases.ts";
import { allowCapture } from "../world/capture.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import {
	answerAttackers,
	answersBlow,
	attackerTargetClasses,
	countUnitTargets,
	destroyFarthestSiege,
	orderAttacker,
	type AttackerContext,
} from "./attackOrders.ts";
import {
	defaultTargetFinder,
	findRushTarget,
	findTargetObstruction,
	nearestBaseAnchors,
	raidTargetFinder,
	rallyPoints,
	targetDistance,
} from "./attackTargets.ts";
import { hqOf } from "./hq.ts";
import type { Queue } from "./queue.ts";
import { type PlanMetadata } from "./queueplan.ts";
import { TrainingPlan } from "./queueplanTraining.ts";
import { PLAN_RESERVE } from "./unitPlan.ts";
import { Worker } from "./worker.ts";

export type AttackUnitStat = {
	priority: number;
	minSize: number;
	targetSize: number;
	batchSize: number;
	classes: string[];
	interests?: Array<[string, number, ...string[]]>;
};

type AttackBuildOrder = [number, string[], CommonEntityCollection, AttackUnitStat, string];

/** What an attack plan looks like once serialized: `Serialize` builds it, `Deserialize` reads it. */
export type SerializedAttackPlan = {
	properties: {
		name: AttackPlanId;
		type: AttackType;
		state: string;
		forced: boolean;
		rallyPoint: CommonPosition;
		overseas: SeaIndex | 0;
		paused: boolean;
		maxCompletingTime: GameSeconds;
		neededShips: number;
		unitStat: Record<string, AttackUnitStat>;
		siegeState: number;
		position5TurnsAgo: CommonPosition;
		lastPosition: CommonPosition;
		position: CommonPosition | undefined;
		isBlocked: boolean;
		targetPlayer: PlayerId | undefined;
		target: EntityId | undefined;
		targetPos: CommonPosition | undefined;
		uniqueTargetId: EntityId | undefined;
		path: CommonPosition[] | undefined;
		unitCollUpdateArray: EntityId[] | undefined;
	};
};

/**
 * The lifecycle of an attack (PLAN.md §3.1), as the moves each state allows:
 *
 *   unexecuted ──> completing ──> walking ──────> arrived ──> attacking ("")
 *     │    ^           │    └───> transporting ──┘
 *     │    └───────────┘ the target was lost while regrouping
 *     └──> arrived       an army switched from defence to attack
 *
 * The values are the strings Petra saves. A move goes through
 * AttackPlan.changeState, which only type-checks for a move listed here.
 */
type AttackTransitions = {
	"unexecuted": "completing" | "arrived";
	"completing": "unexecuted" | "walking" | "transporting";
	"walking": "arrived";
	"transporting": "arrived";
	"arrived": "";
	"": never;
};
type AttackPlanState = keyof AttackTransitions;
/** How near its rally point a withdrawing army stops, past the anchor's footprint when it is a base. */
const WITHDRAW_RANGE = 15;

/** The four kinds of attack plan, in the order the attack manager keeps them. */
export type AttackType = "Rush" | "Raid" | "Attack" | "HugeAttack";
export const ATTACK_TYPES: readonly AttackType[] = ["Rush", "Raid", "Attack", "HugeAttack"];

/** Every plan of the records, type by type in ATTACK_TYPES' order; lazy, as the nested loops it replaces were. */
export function* plansIn(records: Record<AttackType, AttackPlan[]>): Generator<AttackPlan>
{
	for (const type of ATTACK_TYPES)
	{
		yield* records[type];
	}
}

/** A record over the four attack types, in ATTACK_TYPES' order, of what `make` gives for each. */
export function byAttackType<T>(make: (type: AttackType) => T): Record<AttackType, T>
{
	return { Rush: make("Rush"), Raid: make("Raid"), Attack: make("Attack"), HugeAttack: make("HugeAttack") };
}

/**
 * This is an attack plan:
 * It deals with everything in an attack, from picking a target to picking a path to it
 * To making sure units are built, and pushing elements to the queue manager otherwise
 * It also handles the actual attack, though much work is needed on that.
 * When @c deserialized is true, do not call any random function inside constructor
 * as that would cause oos.
 */
/** What a new plan is asked for: a target, a unique target, a rush's size. */
export type AttackPlanData = { target?: CommonEntity; uniqueTargetId?: EntityId; targetSize?: number; };
/** Where a plan gathers its army, and the sea to cross to its target (0: none). */
type AttackStart = { rallyPoint: CommonPosition; overseas: SeaIndex | 0; };

/** Empties a preparing plan's three queues. */
export function emptyQueues(prep: AttackPreparation): void
{
	prep.queue.empty();
	prep.queueChamp.empty();
	prep.queueSiege.empty();
}

/** At our population limit, with no room left for a house (the house template marked unbuildable). */
export function cannotGrow(gameState: CommonGameState): boolean
{
	if (gameState.getPopulationLimit() - gameState.getPopulation() >= 5)
	{
		return false;
	}
	const buildManager = hqOf(gameState).buildManager;
	return ["structures/{civ}/house", "structures/{civ}/apartment"].some((house) =>
	{
		const name = gameState.applyCiv(house);
		return gameState.isTemplateAvailable(name) && buildManager.isUnbuildable(gameState, name);
	});
}

/**
 * Whether a unit stands on another land than the rally point's with enemies
 * on it: it is not drafted, nor shipped to the rally point, while they are
 * there (FINDINGS §34).
 */
function besideEnemies(gameState: CommonGameState, ent: CommonEntity, rallyLand: AccessIndex): boolean
{
	const land = ent.position() ? getLandAccess(gameState, ent) : undefined;
	// 1 marks an impassable cell (a hunter at a cliff's edge), no land: no island of its own
	return land !== undefined && land > 1 && land !== rallyLand &&
		hqOf(gameState).attackManager.enemiesByLand(gameState).has(land);
}

/**
 * The build orders by training advancement, the least advanced (current size / target size, less priority)
 * first, those done last; equal ones by name, backwards
 */
function byTrainingAdvancement(a: AttackBuildOrder, b: AttackBuildOrder): number
{
	let va = a[0] / a[3].targetSize - a[3].priority;
	if (a[0] >= a[3].targetSize)
	{
		va += 1000;
	}
	let vb = b[0] / b[3].targetSize - b[3].priority;
	if (b[0] >= b[3].targetSize)
	{
		vb += 1000;
	}

	const calcResult = va - vb;
	if (calcResult !== 0)
	{
		return calcResult;
	}

	if (a[4] < b[4])
	{
		return 1;
	}
	if (a[4] > b[4])
	{
		return -1;
	}
	return 0;
}

/** For each set of classes, whether one of our training facilities can train a unit of them */
function trainersFor(gameState: CommonGameState, classes: string[][]): boolean[]
{
	const civ = gameState.getPlayerCiv();
	const hasTrainer = classes.map(() => false);
	for (const ent of gameState.getOwnTrainingFacilities().values())
	{
		const trainables = ent.trainableEntities(civ);
		if (!trainables)
		{
			continue;
		}
		for (const trainable of trainables)
		{
			if (gameState.isTemplateDisabled(trainable))
			{
				continue;
			}
			const template = gameState.getTemplate(trainable);
			if (!template || !template.available(gameState))
			{
				continue;
			}
			for (let i = 0; i < classes.length; ++i)
			{
				if (template.hasClasses(classes[i]))
				{
					hasTrainer[i] = true;
				}
			}
		}
	}
	return hasTrainer;
}

/** The siege an attack adds, by difficulty and population: none for a small attack at the easiest levels */
function siegeSize(config: Config, type: AttackType): number
{
	let targetSize;
	if (config.difficulty < difficulty.MEDIUM)
	{
		targetSize = type === AttackPlan.TYPE_HUGE_ATTACK ?
			Math.max(config.difficulty, 1) :
			Math.max(config.difficulty - 1, 0);
	}
	else
	{
		targetSize = type === AttackPlan.TYPE_HUGE_ATTACK ? config.difficulty + 1 : config.difficulty - 1;
	}
	return Math.max(Math.round(config.popScaling * targetSize), type === AttackPlan.TYPE_HUGE_ATTACK ? 1 : 0);
}

/**
 * A new plan's army: attackComposition's, with a lower priority and smaller sizes for easier difficulty levels,
 * then the sizes changed according to max population
 */
function planSizes(
	config: Config,
	type: AttackType,
	data: AttackPlanData | undefined,
	variation: number,
): { priority: number; unitStat: Record<string, AttackUnitStat>; neededShips: number; }
{
	const composition = attackComposition(type, data);
	let priority = composition.priority;
	const unitStat = composition.unitStat;
	let neededShips = composition.neededShips;

	if (config.difficulty < difficulty.EASY)
	{
		priority *= 0.4;
		variation *= 0.2;
	}
	else if (config.difficulty < difficulty.MEDIUM)
	{
		priority *= 0.8;
		variation *= 0.6;
	}

	if (config.difficulty < difficulty.EASY)
	{
		for (const cat in unitStat)
		{
			unitStat[cat].targetSize = Math.ceil(variation * unitStat[cat].targetSize);
			unitStat[cat].minSize = Math.min(unitStat[cat].targetSize, Math.min(unitStat[cat].minSize, 2));
			unitStat[cat].batchSize = unitStat[cat].minSize;
		}
	}
	else
	{
		for (const cat in unitStat)
		{
			unitStat[cat].targetSize = Math.ceil(variation * unitStat[cat].targetSize);
			unitStat[cat].minSize = Math.min(unitStat[cat].minSize, unitStat[cat].targetSize);
		}
	}

	neededShips = Math.ceil(config.popScaling * neededShips);
	for (const cat in unitStat)
	{
		unitStat[cat].targetSize = Math.ceil(config.popScaling * unitStat[cat].targetSize);
		unitStat[cat].minSize = Math.ceil(config.popScaling * unitStat[cat].minSize);
	}
	return { priority, unitStat, neededShips };
}

/** An attack's unit categories and queues, and the ships needed before difficulty and population scaling. */
type AttackComposition = { priority: number; unitStat: Record<string, AttackUnitStat>; neededShips: number; };

/** A rush's citizen infantry, its target size overridden by the plan's data. */
function rushComposition(data: AttackPlanData | undefined): AttackComposition
{
	const infantry: AttackUnitStat = {
		priority: 1,
		minSize: 10,
		targetSize: 20,
		batchSize: 2,
		classes: ["Infantry"],
		interests: [["strength", 1], ["costsResource", 0.5, "stone"], ["costsResource", 0.6, "metal"]],
	};
	if (data && data.targetSize)
	{
		infantry.targetSize = data.targetSize;
	}
	return {
		priority: 250,
		unitStat: {
			Infantry: infantry,
			FastMoving: {
				priority: 1,
				minSize: 2,
				targetSize: 4,
				batchSize: 2,
				classes: ["FastMoving+CitizenSoldier"],
				interests: [["strength", 1]],
			},
		},
		neededShips: 1,
	};
}

/** A raid's fast-moving citizen soldiers. */
function raidComposition(): AttackComposition
{
	return {
		priority: 150,
		unitStat: {
			FastMoving: {
				priority: 1,
				minSize: 3,
				targetSize: 4,
				batchSize: 2,
				classes: ["FastMoving+CitizenSoldier"],
				interests: [["strength", 1]],
			},
		},
		neededShips: 1,
	};
}

/** A huge attack's foot units: citizen soldiers for the barracks and champion units. */
function hugeAttackInfantry(): Record<string, AttackUnitStat>
{
	return {
		RangedInfantry: {
			priority: 0.7,
			minSize: 5,
			targetSize: 20,
			batchSize: 5,
			classes: ["Infantry+Ranged+CitizenSoldier"],
			interests: [["strength", 3]],
		},
		MeleeInfantry: {
			priority: 0.7,
			minSize: 5,
			targetSize: 20,
			batchSize: 5,
			classes: ["Infantry+Melee+CitizenSoldier"],
			interests: [["strength", 3]],
		},
		ChampRangedInfantry: {
			priority: 1,
			minSize: 3,
			targetSize: 18,
			batchSize: 3,
			classes: ["Infantry+Ranged+Champion"],
			interests: [["strength", 3]],
		},
		ChampMeleeInfantry: {
			priority: 1,
			minSize: 3,
			targetSize: 18,
			batchSize: 3,
			classes: ["Infantry+Melee+Champion"],
			interests: [["strength", 3]],
		},
	};
}

/** A huge attack's fast-moving units and its hero. */
function hugeAttackFastMoving(): Record<string, AttackUnitStat>
{
	return {
		RangedFastMoving: {
			priority: 0.7,
			minSize: 4,
			targetSize: 20,
			batchSize: 4,
			classes: ["FastMoving+Ranged+CitizenSoldier"],
			interests: [["strength", 2]],
		},
		MeleeFastMoving: {
			priority: 0.7,
			minSize: 4,
			targetSize: 20,
			batchSize: 4,
			classes: ["FastMoving+Melee+CitizenSoldier"],
			interests: [["strength", 2]],
		},
		ChampRangedFastMoving: {
			priority: 1,
			minSize: 3,
			targetSize: 15,
			batchSize: 3,
			classes: ["FastMoving+Ranged+Champion"],
			interests: [["strength", 3]],
		},
		ChampMeleeFastMoving: {
			priority: 1,
			minSize: 3,
			targetSize: 15,
			batchSize: 3,
			classes: ["FastMoving+Melee+Champion"],
			interests: [["strength", 2]],
		},
		Hero: { priority: 1, minSize: 0, targetSize: 1, batchSize: 1, classes: ["Hero"], interests: [["strength", 2]] },
	};
}

/** A huge attack: foot units, fast-moving units and a hero. */
function hugeAttackComposition(): AttackComposition
{
	return { priority: 90, unitStat: { ...hugeAttackInfantry(), ...hugeAttackFastMoving() }, neededShips: 5 };
}

/** A standard attack: ranged and melee infantry that can gather, and fast-moving citizen soldiers. */
function standardAttackComposition(): AttackComposition
{
	const interests: Array<[string, number, ...string[]]> = [["canGather", 1], ["strength", 1.6], [
		"costsResource",
		0.3,
		"stone",
	], ["costsResource", 0.3, "metal"]];
	return {
		priority: 70,
		unitStat: {
			RangedInfantry: {
				priority: 1,
				minSize: 6,
				targetSize: 16,
				batchSize: 3,
				classes: ["Infantry+Ranged"],
				interests,
			},
			MeleeInfantry: {
				priority: 1,
				minSize: 6,
				targetSize: 16,
				batchSize: 3,
				classes: ["Infantry+Melee"],
				interests,
			},
			FastMoving: {
				priority: 1,
				minSize: 2,
				targetSize: 6,
				batchSize: 2,
				classes: ["FastMoving+CitizenSoldier"],
				interests: [["strength", 1]],
			},
		},
		neededShips: 3,
	};
}

/**
 * The army an attack of this type aims at: per category its classes, sizes, batch and the unit
 * qualities wanted, the priority of its queues and the ships it needs (before difficulty and population scaling).
 * unitStat priority is relative. If all are 0, the only relevant criteria is "currentsize/targetsize".
 * if not, this is a "bonus". The higher the priority, the faster this unit will get built.
 * Should really be clamped to [0.1-1.5] (assuming 1 is default/the norm)
 * Eg: if all are priority 1, and the siege is 0.5, the siege units will get built
 * only once every other category is at least 50% of its target size.
 * note: siege build order is currently added by the military manager if a fortress is there.
 */
function attackComposition(type: AttackType, data: AttackPlanData | undefined): AttackComposition
{
	if (type === AttackPlan.TYPE_RUSH)
	{
		return rushComposition(data);
	}
	if (type === AttackPlan.TYPE_RAID)
	{
		return raidComposition();
	}
	if (type === AttackPlan.TYPE_HUGE_ATTACK)
	{
		return hugeAttackComposition();
	}
	return standardAttackComposition();
}

/**
 * What an attack plan is made from: a new plan's type, its data, where it
 * starts and its size roll, or a save; and whether we can train units at all
 * (the headquarters' canBuildUnits: the plan then has build orders).
 */
type AttackPlanSetup =
	& { canBuildUnits: boolean; }
	& ({ kind: "new"; type: AttackType; data: AttackPlanData | undefined; start: AttackStart; variation: number; } | {
		kind: "saved";
		saved: SerializedAttackPlan;
	});

/** What an attack goes for: its target, and where it is (or was last seen, for a unit that went in somewhere) */
type AttackAim = { target: CommonEntity; pos: CommonPosition; };

/**
 * What a plan attacks and what it knows of it: the entity, where it was last
 * seen, its owner, and the unique target it was asked to keep. Every stage
 * carries one, so the target and its position move together.
 */
type AttackTarget = {
	ent: CommonEntity | undefined;
	pos: CommonPosition | undefined;
	player: PlayerId | undefined;
	uniqueTargetId: EntityId | undefined;
};

/**
 * An attack plan's state and what the state holds. A preparing plan may hold
 * the path it will walk, made when it sets off (getPathToTarget); walking
 * holds the path it walks, so a path is never read outside those states.
 */
type AttackStage =
	| { state: "unexecuted" | "completing"; prep: AttackPreparation; target: AttackTarget; path?: CommonPosition[]; }
	| { state: "walking"; path: CommonPosition[]; target: AttackTarget; }
	| { state: "transporting" | "arrived" | ""; target: AttackTarget; };

/**
 * What a preparing plan trains with: its three queues (removed from the
 * queue manager when it sets off), its build orders and whether siege was
 * tried. A completing plan keeps it: it goes back to preparing when its
 * target is lost.
 */
export type AttackPreparation = {
	queue: Queue;
	queueChamp: Queue;
	queueSiege: Queue;
	buildOrders: AttackBuildOrder[];
	siegeState: number;
};

export class AttackPlan
{
	Config: Config;
	canBuildUnits: boolean;
	forced: boolean;
	isBlocked: boolean;
	lastPosition: CommonPosition;
	maxCompletingTime: GameSeconds;
	name: AttackPlanId;
	neededShips: number;
	overseas: SeaIndex | 0;
	paused: boolean;
	position: CommonPosition | undefined;
	position5TurnsAgo: CommonPosition;
	rallyPoint: CommonPosition;
	/** Set when an ally asked for this attack: it does not ask its allies in turn */
	requested: boolean | undefined = undefined;
	startingAttack = false;
	/** The plan's state and what the state holds: changed only by changeState and startWalking, and restored from a save. */
	stage: AttackStage;
	get state(): AttackPlanState
	{
		return this.stage.state;
	}
	/** The path a preparing plan will walk, or the one a walking plan walks. */
	get path(): CommonPosition[] | undefined
	{
		const stage = this.stage;
		return stage.state === "unexecuted" || stage.state === "completing" || stage.state === "walking" ?
			stage.path :
			undefined;
	}
	set path(path: CommonPosition[] | undefined)
	{
		const stage = this.stage;
		if (stage.state === "unexecuted" || stage.state === "completing" || stage.state === "walking")
		{
			stage.path = path;
			return;
		}
		throw new Error("Petra error: attack plan " + this.name + " given a path while \"" + stage.state + "\"");
	}
	/**
	 * A state for a test's set-up: a preparing one keeps the plan's
	 * preparation, the others hold nothing (walking holds its path: startWalking).
	 */
	set state(state: Exclude<AttackPlanState, "walking">)
	{
		this.stage = this.stageFor(state);
	}

	/** The plan's training while it prepares, none once it has set off */
	preparation(): AttackPreparation | undefined
	{
		const stage = this.stage;
		return stage.state === AttackPlan.STATE_UNEXECUTED || stage.state === AttackPlan.STATE_COMPLETING ?
			stage.prep :
			undefined;
	}

	/** The stage of a state that holds no path: a preparing one takes the plan's preparation along */
	private stageFor(state: Exclude<AttackPlanState, "walking">): AttackStage
	{
		if (state !== AttackPlan.STATE_UNEXECUTED && state !== AttackPlan.STATE_COMPLETING)
		{
			return { state, target: this.stage.target };
		}
		const prep = this.preparation();
		if (!prep)
		{
			throw new Error("Petra error: attack plan " + this.name + " back to \"" + state + "\" after it set off");
		}
		return { state, prep, target: this.stage.target };
	}
	/** The entity the plan attacks, carried with its place and owner by every stage. */
	get target(): CommonEntity | undefined
	{
		return this.stage.target.ent;
	}
	set target(target: CommonEntity | undefined)
	{
		this.stage.target.ent = target;
	}
	get targetPlayer(): PlayerId | undefined
	{
		return this.stage.target.player;
	}
	set targetPlayer(player: PlayerId | undefined)
	{
		this.stage.target.player = player;
	}
	/** Where the target is, or was last seen (a unit that went in somewhere). */
	get targetPos(): CommonPosition | undefined
	{
		return this.stage.target.pos;
	}
	set targetPos(pos: CommonPosition | undefined)
	{
		this.stage.target.pos = pos;
	}
	/** The unique target the plan was asked to keep, if any. */
	get uniqueTargetId(): EntityId | undefined
	{
		return this.stage.target.uniqueTargetId;
	}
	type: AttackType;
	unit: Record<string, CommonEntityCollection>;
	unitCollUpdateArray: EntityId[] | undefined = undefined;
	unitCollection: CommonEntityCollection;
	unitStat: Record<string, AttackUnitStat>;

	/**
	 * Where a plan gathers its army (a base's anchor, or any unit of ours) and
	 * the sea between it and the target when that lies overseas; undefined when
	 * no plan can be made: nowhere to gather, or a target out of reach.
	 */
	static findStart(
		gameState: CommonGameState,
		type: AttackType,
		name: AttackPlanId,
		target: CommonEntity | undefined,
	): AttackStart | undefined
	{
		// get a starting rallyPoint ... will be improved later
		const rally = rallyPoints(gameState);
		if (!rally)
		{
			return undefined;
		}
		const { rallyPoint, rallyAccess, allAccesses } = rally;
		let start: AttackStart = { rallyPoint, overseas: 0 };
		if (!gameState.ai.geography.navalMap)
		{
			return start;
		}
		for (const structure of gameState.getEnemyStructures().values())
		{
			if (target && structure.id() !== target.id())
			{
				continue;
			}
			const access = getLandAccess(gameState, structure);
			if (access === undefined)
			{
				continue;
			}
			if (access in allAccesses)
			{
				start = { rallyPoint: allAccesses[access], overseas: 0 };
				break;
			}
			else if (!start.overseas && rallyAccess !== undefined)
			{
				const sea = hqOf(gameState).getSeaBetweenIndices(gameState, rallyAccess, access);
				if (!sea)
				{
					if (target)
					{
						aiWarn(
							"Petra: " + type + " " + name + " has an inaccessible target " +
								target.templateName() + " indices " + rallyAccess + " " + access,
						);
						return undefined;
					}
					continue;
				}
				start = { rallyPoint: start.rallyPoint, overseas: sea };
				hqOf(gameState).navalManager.setMinimalTransportShips(gameState, sea, 1);
			}
		}
		return start;
	}

	/** A new plan, or undefined when it has nowhere to start (findStart). */
	static create(
		gameState: CommonGameState,
		config: Config,
		uniqueID: number,
		type: AttackType = AttackPlan.TYPE_DEFAULT,
		data?: AttackPlanData,
	): AttackPlan | undefined
	{
		const start = AttackPlan.findStart(gameState, type, attackPlanId(uniqueID), data?.target);
		// some randomness on the attack's size
		return start &&
			new AttackPlan(gameState, config, uniqueID, {
				kind: "new",
				type,
				data,
				start,
				variation: randFloat(0.8, 1.2),
				canBuildUnits: hqOf(gameState).canBuildUnits,
			});
	}

	/** A saved plan, as it was saved: its queues (restored with the queue manager) and units found again. */
	static restore(
		gameState: CommonGameState,
		config: Config,
		saved: SerializedAttackPlan,
		canBuildUnits: boolean,
	): AttackPlan
	{
		return new AttackPlan(gameState, config, saved.properties.name, { kind: "saved", saved, canBuildUnits });
	}

	constructor(gameState: CommonGameState, config: Config, uniqueID: number, setup: AttackPlanSetup)
	{
		this.Config = config;
		this.name = attackPlanId(uniqueID);
		// the plan's stage, once its build orders are known (made below for every plan)
		let makeStage: (buildOrders: AttackBuildOrder[], target: AttackTarget) => AttackStage;
		let target: AttackTarget;
		if (setup.kind === "saved")
		{
			const saved = setup.saved;
			this.type = saved.properties.type;
			makeStage = this.savedStage(gameState, saved);
			this.forced = saved.properties.forced;
			this.rallyPoint = saved.properties.rallyPoint;
			this.overseas = saved.properties.overseas;
			this.paused = saved.properties.paused;
			this.maxCompletingTime = saved.properties.maxCompletingTime;
			this.neededShips = saved.properties.neededShips;
			this.unitStat = saved.properties.unitStat;
			this.position5TurnsAgo = saved.properties.position5TurnsAgo;
			this.lastPosition = saved.properties.lastPosition;
			this.position = saved.properties.position;
			this.isBlocked = saved.properties.isBlocked;
			this.unitCollUpdateArray = saved.properties.unitCollUpdateArray;

			const targetId = saved.properties.target;
			target = {
				ent: typeof targetId === "number" ? gameState.getEntityById(targetId) : undefined,
				pos: saved.properties.targetPos,
				player: saved.properties.targetPlayer,
				uniqueTargetId: saved.properties.uniqueTargetId,
			};
		}
		else
		{
			const data = setup.data;
			this.type = setup.type;
			this.forced = false; // true when this attacked has been forced to help an ally

			const chosen = data && data.target ? data.target : undefined;
			target = {
				ent: chosen,
				pos: chosen ? chosen.position() : undefined,
				player: chosen ? chosen.owner() : undefined,
				uniqueTargetId: data && data.uniqueTargetId || undefined,
			};

			this.rallyPoint = setup.start.rallyPoint;
			this.overseas = setup.start.overseas;
			this.paused = false;
			this.maxCompletingTime = seconds(0);

			// the army this type aims at (see attackComposition), sized by difficulty and population
			const sizes = planSizes(this.Config, setup.type, data, setup.variation);
			this.unitStat = sizes.unitStat;
			this.neededShips = sizes.neededShips;
			makeStage = this.newStage(gameState, sizes.priority);

			// some variables used during the attack
			this.position5TurnsAgo = worldPos(0, 0);
			this.lastPosition = worldPos(0, 0);
			this.position = worldPos(0, 0);
			this.isBlocked = false; // true when this attack faces walls
		}

		this.canBuildUnits = setup.canBuildUnits;

		this.unitCollection = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "plan", this.name));
		this.unitCollection.registerUpdates();

		this.unit = {};
		this.stage = makeStage(this.unitCollections(), target);
	}

	/**
	 * Defining the entity collections: the units I own that are part of this plan, by category.
	 * Also defining the buildOrders: each array is [ratio, [associated classes], associated EntityColl,
	 * associated unitStat, name ]
	 */
	private unitCollections(): AttackBuildOrder[]
	{
		const buildOrders: AttackBuildOrder[] = [];
		for (const cat in this.unitStat)
		{
			const Unit = this.unitStat[cat];
			this.unit[cat] = this.unitCollection.filter(filters.byClasses(Unit.classes));
			this.unit[cat].registerUpdates();
			if (this.canBuildUnits)
			{
				buildOrders.push([0, Unit.classes, this.unit[cat], Unit, cat]);
			}
		}
		return buildOrders;
	}

	/** A new plan's stage: unexecuted, with its three queues (TODO: there should probably be one queue per type of training building) */
	private newStage(
		gameState: CommonGameState,
		priority: number,
	): (buildOrders: AttackBuildOrder[], target: AttackTarget) => AttackStage
	{
		const queue = gameState.ai.queueManager.addQueue(`plan_${this.name}`, priority);
		const queueChamp = gameState.ai.queueManager.addQueue(`plan_${this.name}_champ`, priority + 1);
		const queueSiege = gameState.ai.queueManager.addQueue(`plan_${this.name}_siege`, priority);
		return (buildOrders: AttackBuildOrder[], target: AttackTarget): AttackStage => ({
			state: AttackPlan.STATE_UNEXECUTED,
			prep: { queue, queueChamp, queueSiege, buildOrders, siegeState: AttackPlan.SIEGE_NOT_TESTED },
			target,
		});
	}

	/**
	 * A saved plan's stage: a preparing plan's queues were restored with the queue manager, a plan that set off
	 * has none; a walking plan walks its saved path, one saved without (never written) attacks where it stands.
	 * A preparing plan keeps the path it had made, as a plan that set off but has not walked yet.
	 */
	private savedStage(
		gameState: CommonGameState,
		saved: SerializedAttackPlan,
	): (buildOrders: AttackBuildOrder[], target: AttackTarget) => AttackStage
	{
		const state = saved.properties.state;
		const savedPath = saved.properties.path;
		const preparing = (prepState: "unexecuted" | "completing") =>
		{
			const queues = this.savedQueues(gameState);
			return (buildOrders: AttackBuildOrder[], target: AttackTarget): AttackStage => ({
				state: prepState,
				prep: { ...queues, buildOrders, siegeState: saved.properties.siegeState },
				target,
				path: savedPath,
			});
		};
		if (state === AttackPlan.STATE_WALKING)
		{
			return (_buildOrders: AttackBuildOrder[], target: AttackTarget): AttackStage =>
				savedPath ? { state, path: savedPath, target } : { state: AttackPlan.STATE_ARRIVED, target };
		}
		if (state === AttackPlan.STATE_UNEXECUTED || state === AttackPlan.STATE_COMPLETING)
		{
			return preparing(state);
		}
		if (
			state === AttackPlan.STATE_TRANSPORTING || state === AttackPlan.STATE_ARRIVED ||
			state === AttackPlan.STATE_ATTACKING
		)
		{
			return (_buildOrders: AttackBuildOrder[], target: AttackTarget): AttackStage => ({ state, target });
		}
		aiWarn(
			"Petra: attack plan " + saved.properties.name + " saved in an unknown state \"" + state +
				"\": it prepares again",
		);
		return preparing(AttackPlan.STATE_UNEXECUTED);
	}

	/** A preparing plan's queues from a save, restored with the queue manager before the plan */
	private savedQueues(gameState: CommonGameState): Pick<AttackPreparation, "queue" | "queueChamp" | "queueSiege">
	{
		return {
			queue: requireValue(gameState.ai.queues[`plan_${this.name}`]),
			queueChamp: requireValue(gameState.ai.queues[`plan_${this.name}_champ`]),
			queueSiege: requireValue(gameState.ai.queues[`plan_${this.name}_siege`]),
		};
	}

	/** The target and its position together, when the plan has both (none before a target is chosen, or once it is lost). */
	aim(): AttackAim | undefined
	{
		return this.target && this.targetPos ? { target: this.target, pos: this.targetPos } : undefined;
	}

	static PREPARATION_FAILED = 0;
	static PREPARATION_KEEP_GOING = 1;
	static PREPARATION_START = 2;

	static SIEGE_NOT_TESTED = 0;
	static SIEGE_NO_TRAINER = 1;

	/**
	 * Siege added in build orders
	 */
	static SIEGE_ADDED = 2;
	/** How far from a unit hit the plan's units bound for a ship answer, while it gathers at its rally point (answerAttacks). */
	static ANSWER_RANGE = 60;

	static readonly STATE_UNEXECUTED = "unexecuted";
	static readonly STATE_COMPLETING = "completing";
	static readonly STATE_WALKING = "walking";
	static readonly STATE_TRANSPORTING = "transporting";
	static readonly STATE_ARRIVED = "arrived";
	/** At the target: the units fight what they find. */
	static readonly STATE_ATTACKING = "";

	static readonly TYPE_DEFAULT = "Attack";
	static readonly TYPE_HUGE_ATTACK = "HugeAttack";
	static readonly TYPE_RAID = "Raid";
	static readonly TYPE_RUSH = "Rush";

	getName(): number
	{
		return this.name;
	}

	getType(): AttackType
	{
		return this.type;
	}

	isStarted(): boolean
	{
		return this.state !== AttackPlan.STATE_UNEXECUTED && this.state !== AttackPlan.STATE_COMPLETING;
	}

	/**
	 * Moves the attack from the state `from` to `to`; only the moves of
	 * AttackTransitions type-check. `from` is where the caller knows the plan
	 * stands; a plan elsewhere makes the move anyway, as Petra always did, and
	 * says so (a bug in the caller's reasoning, not in the game).
	 */
	changeState<From extends AttackPlanState>(from: From, to: Exclude<AttackTransitions[From], "walking">): void
	{
		if (this.state !== from)
		{
			aiWarn(
				"Petra: attack plan " + this.name + " moved to \"" + to + "\" from \"" + this.state +
					"\", not from \"" + from + "\"",
			);
		}
		this.stage = this.stageFor(to);
	}

	/** The plan sets off from completing on its path, walking it (the only way into walking). */
	startWalking(path: CommonPosition[]): void
	{
		if (this.state !== AttackPlan.STATE_COMPLETING)
		{
			aiWarn(
				"Petra: attack plan " + this.name + " moved to \"walking\" from \"" + this.state +
					"\", not from \"completing\"",
			);
		}
		this.stage = { state: AttackPlan.STATE_WALKING, path, target: this.stage.target };
	}

	isPaused(): boolean
	{
		return this.paused;
	}

	setPaused(boolValue: boolean): void
	{
		this.paused = boolValue;
	}

	/**
	 * Returns true if the attack can be executed at the current time
	 * Basically it checks we have enough units.
	 */
	canStart(): boolean
	{
		if (!this.canBuildUnits)
		{
			return true;
		}

		for (const unitCat in this.unitStat)
		{
			if (this.unit[unitCat].length < this.unitStat[unitCat].minSize)
			{
				return false;
			}
		}

		return true;
	}

	mustStart(): boolean
	{
		if (this.isPaused())
		{
			return false;
		}

		if (!this.canBuildUnits)
		{
			return this.unitCollection.hasEntities();
		}

		let MaxReachedEverywhere = true;
		let MinReachedEverywhere = true;
		for (const unitCat in this.unitStat)
		{
			const Unit = this.unitStat[unitCat];
			if (this.unit[unitCat].length < Unit.targetSize)
			{
				MaxReachedEverywhere = false;
			}
			if (this.unit[unitCat].length < Unit.minSize)
			{
				MinReachedEverywhere = false;
				break;
			}
		}

		if (MaxReachedEverywhere)
		{
			return true;
		}
		if (MinReachedEverywhere)
		{
			const raidTarget = this.target;
			if (this.type !== AttackPlan.TYPE_RAID || !raidTarget)
			{
				return false;
			}
			const progress = raidTarget.foundationProgress();
			return progress !== undefined && progress > 50;
		}
		return false;
	}

	forceStart(): void
	{
		for (const unitCat in this.unitStat)
		{
			const Unit = this.unitStat[unitCat];
			Unit.targetSize = 0;
			Unit.minSize = 0;
		}
		this.forced = true;
	}

	removeQueues(gameState: CommonGameState): void
	{
		gameState.ai.queueManager.removeQueue(`plan_${this.name}`);
		gameState.ai.queueManager.removeQueue(`plan_${this.name}_champ`);
		gameState.ai.queueManager.removeQueue(`plan_${this.name}_siege`);
	}

	/** Adds a build order. If resetQueue is true, this will reset the queue. */
	addBuildOrder(gameState: CommonGameState, name: string, unitStats: AttackUnitStat, resetQueue: boolean): void
	{
		// while it prepares (not started)
		const prep = this.preparation();
		if (prep)
		{
			// no minsize as we don't want the plan to fail at the last minute though.
			this.unitStat[name] = unitStats;
			const Unit = this.unitStat[name];
			this.unit[name] = this.unitCollection.filter(filters.byClasses(Unit.classes));
			this.unit[name].registerUpdates();
			prep.buildOrders.push([0, Unit.classes, this.unit[name], Unit, name]);
			if (resetQueue)
			{
				emptyQueues(prep);
			}
		}
	}

	addSiegeUnits(gameState: CommonGameState): boolean
	{
		const stage = this.stage;
		if (stage.state !== AttackPlan.STATE_UNEXECUTED || stage.prep.siegeState === AttackPlan.SIEGE_ADDED)
		{
			return false;
		}
		const prep = stage.prep;

		const classes = [["Siege+Melee"], ["Siege+Ranged"], ["Elephant+Melee"]];
		const hasTrainer = trainersFor(gameState, classes);
		if (hasTrainer.every((e: boolean): boolean => !e))
		{
			prep.siegeState = AttackPlan.SIEGE_NO_TRAINER;
			return false;
		}
		let i = this.name % classes.length;
		for (let k = 0; k < classes.length; ++k)
		{
			if (hasTrainer[i])
			{
				break;
			}
			i = (i + 1) % classes.length;
		}

		prep.siegeState = AttackPlan.SIEGE_ADDED;
		const targetSize = siegeSize(this.Config, this.type);
		if (!targetSize)
		{
			return true;
		}
		// no minsize as we don't want the plan to fail at the last minute though.
		const stat: AttackUnitStat = {
			priority: 1,
			minSize: 0,
			targetSize: targetSize,
			batchSize: Math.min(targetSize, 2),
			classes: classes[i],
			interests: [["siegeStrength", 3]],
		};
		this.addBuildOrder(gameState, "Siege", stat, true);
		return true;
	}

	/** Three returns possible: 1 is "keep going", 0 is "failed plan", 2 is "start". */
	updatePreparation(gameState: CommonGameState): number
	{
		// the completing step is used to return resources and regroup the units
		// so we check that we have no more forced order before starting the attack
		if (this.state === AttackPlan.STATE_COMPLETING)
		{
			const step = this.completingStep(gameState);
			if (step !== undefined)
			{
				return step;
			}
		}

		if (this.Config.debug > 3 && gameState.ai.playedTurn % 50 === 0)
		{
			this.debugAttack();
		}

		if (!this.prepareArmy(gameState))
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}

		// the training below is a preparing plan's: one that set off has none to train with
		const prep = this.preparation();
		if (!prep)
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}

		const step = this.trainingStep(gameState, prep);
		if (step !== undefined)
		{
			return step;
		}

		// if we're here, it means we must start
		return this.setOff(gameState);
	}

	/**
	 * A completing plan starts once its units are done with their transport and their forced orders (or its time is
	 * up); undefined when its target is gone: it is unexecuted again
	 */
	private completingStep(gameState: CommonGameState): number | undefined
	{
		// if our target was destroyed, go back to "unexecuted" state
		if (this.targetPlayer === undefined || !this.target || !gameState.getEntityById(this.target.id()))
		{
			this.changeState(AttackPlan.STATE_COMPLETING, AttackPlan.STATE_UNEXECUTED);
			this.target = undefined;
			return undefined;
		}
		// check that all units have finished with their transport if needed
		if (this.waitingForTransport())
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}
		// bloqued units which cannot finish their order should not stop the attack
		if (gameState.ai.elapsedTime < this.maxCompletingTime && this.hasForceOrder())
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}
		return AttackPlan.PREPARATION_START;
	}

	/** The plan drafts its units and keeps them off disputed lands; false while it waits for its ships */
	private prepareArmy(gameState: CommonGameState): boolean
	{
		if (this.type !== AttackPlan.TYPE_RAID || !this.forced)
		{ // Forced Raids have special purposes (as relic capture)
			this.assignUnits(gameState);
		}

		// if we need a transport, wait for some transport ships, the units
		// drafted first: they keep at their work until the plan sets off, and
		// Petra, waiting before it drafted, left 147 idle citizen soldiers out of
		// an attack waiting for its ships on a dry island (FINDINGS §40); the
		// ship queue is raised meanwhile (NavalManager.shipPriority)
		if (this.overseas && !hqOf(gameState).navalManager.fleet(this.overseas)?.transports.length)
		{
			return false;
		}
		if (
			this.type !== AttackPlan.TYPE_RAID &&
			hqOf(gameState).attackManager.getAttackInPreparation(AttackPlan.TYPE_RAID) !== undefined
		)
		{
			this.reassignFastUnit(gameState); // reassign some fast units (if any) to fasten raid preparations
		}
		// while it prepares, the plan holds no soldier beside enemies away from its rally point
		this.leaveDisputedLands(gameState, gameState.ai.accessibility.getAccessValue(this.rallyPoint));

		// Fasten the end game.
		if (gameState.ai.playedTurn % 5 === 0 && this.hasSiegeUnits())
		{
			this.fastenEndGame(gameState);
		}
		return true;
	}

	/** The plan's training while it prepares: a result to return, or undefined when it must start */
	private trainingStep(gameState: CommonGameState, prep: AttackPreparation): number | undefined
	{
		// special case: if we've reached max pop, and we can start the plan, start it;
		// so too at our population limit with no room for a house: it cannot grow
		// (FINDINGS §40: a huge attack of 136 waited for good on a full island)
		if (gameState.getPopulationMax() - gameState.getPopulation() < 5 || cannotGrow(gameState))
		{
			let lengthMin = 16;
			if (gameState.getPopulationMax() < 300)
			{
				lengthMin -= Math.floor(8 * (300 - gameState.getPopulationMax()) / 300);
			}
			if (this.canStart() || this.unitCollection.length > lengthMin)
			{
				emptyQueues(prep);
				return undefined;
			}
			// Short of men at the cap: wait, gathering the reserve as below it. The
			// original aborted the plan so that its units would serve other plans,
			// but the next plan the attack manager made took them back at once
			// (FINDINGS §16: 120 plans in 200 games, 80 in one).
			return AttackPlan.PREPARATION_KEEP_GOING;
		}
		if (this.mustStart())
		{
			if (gameState.countOwnQueuedEntitiesWithMetadata("plan", +this.name) > 0)
			{
				// keep on while the units finish being trained, then we'll start
				emptyQueues(prep);
				return AttackPlan.PREPARATION_KEEP_GOING;
			}
			return undefined;
		}
		if (this.canBuildUnits)
		{
			// We still have time left to recruit units and do stuffs.
			if (
				prep.siegeState === AttackPlan.SIEGE_NOT_TESTED ||
				prep.siegeState === AttackPlan.SIEGE_NO_TRAINER && gameState.ai.playedTurn % 5 === 0
			)
			{
				this.addSiegeUnits(gameState);
			}
			this.trainMoreUnits(gameState, prep);
			// may happen if we have no more training facilities and build orders are canceled
			if (!prep.buildOrders.length)
			{
				return AttackPlan.PREPARATION_FAILED; // will abort the plan
			}
		}
		return AttackPlan.PREPARATION_KEEP_GOING;
	}

	/** The plan sets off: completing, with its target and path, its units gathering, its queues reset */
	private setOff(gameState: CommonGameState): number
	{
		this.changeState(AttackPlan.STATE_UNEXECUTED, AttackPlan.STATE_COMPLETING);

		// Raids have their predefined target
		if (!this.target && !this.chooseTarget(gameState))
		{
			return AttackPlan.PREPARATION_FAILED;
		}
		this.leaveDisputedLands(gameState, this.targetLand(gameState));
		const aim = this.aim();
		if (!this.overseas && aim)
		{
			this.getPathToTarget(gameState, aim);
		}

		if (this.type === AttackPlan.TYPE_RAID)
		{
			this.maxCompletingTime = seconds(this.forced ? 0 : gameState.ai.elapsedTime + 20);
		}
		else
		{
			if (this.type === AttackPlan.TYPE_RUSH || this.forced)
			{
				this.maxCompletingTime = seconds(gameState.ai.elapsedTime + 40);
			}
			else
			{
				this.maxCompletingTime = seconds(gameState.ai.elapsedTime + 60);
			}
			// warn our allies so that they can help if possible
			if (!this.requested && this.targetPlayer !== undefined)
			{
				postCommand({ type: "attack-request", source: PlayerID, player: this.targetPlayer });
			}
		}

		this.gatherAtRallyPoint(gameState);

		// reset all queued units
		this.removeQueues(gameState);
		return AttackPlan.PREPARATION_KEEP_GOING;
	}

	/** A plan with siege far bigger than the enemies' armies starts at once */
	fastenEndGame(gameState: CommonGameState): void
	{
		let totEnemies = 0;
		let hasEnemies = false;
		for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
		{
			const i = playerId(iIndex);
			if (!gameState.isPlayerEnemy(i) || hqOf(gameState).attackManager.defeated[i])
			{
				continue;
			}
			hasEnemies = true;
			totEnemies += gameState.getEnemyUnits(i).length;
		}
		if (hasEnemies && this.unitCollection.length > 20 + 2 * totEnemies)
		{
			this.forceStart();
		}
	}

	/** The plan sets off: its units leave bombing, return what they carry and go to the rally point, by ship if need be */
	gatherAtRallyPoint(gameState: CommonGameState): void
	{
		// Remove those units which were in a temporary bombing attack
		for (const unitIds of hqOf(gameState).attackManager.bombingAttacks.values())
		{
			for (const entId of unitIds.values())
			{
				const ent = gameState.getEntityById(entId);
				if (!ent || ent.getMetadata(PlayerID, "plan") !== this.name)
				{
					continue;
				}
				unitIds.delete(entId);
				ent.stopMoving();
			}
		}

		const rallyPoint = this.rallyPoint;
		const rallyIndex = gameState.ai.accessibility.getAccessValue(rallyPoint);
		for (const ent of this.unitCollection.values())
		{
			// For the time being, if occupied in a transport, remove the unit from this plan   TODO improve that
			if (
				ent.getMetadata(PlayerID, "transport") !== undefined ||
				ent.getMetadata(PlayerID, "transporter") !== undefined
			)
			{
				ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
				continue;
			}
			ent.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_COMPLETING);
			const carrying = ent.resourceCarrying();
			let queued = false;
			if (carrying && carrying.length)
			{
				queued = returnResources(gameState, ent);
			}
			const index = getLandAccess(gameState, ent);
			if (index === undefined)
			{
				continue;
			}
			if (index === rallyIndex)
			{
				ent.moveToRange(rallyPoint[0], rallyPoint[1], 0, 15, queued);
			}
			else
			{
				hqOf(gameState).navalManager.requireTransport(gameState, ent, index, rallyIndex, rallyPoint);
			}
		}
	}

	trainMoreUnits(gameState: CommonGameState, prep: AttackPreparation): void
	{
		// let's sort by training advancement, ie 'current size / target size'
		// count the number of queued units too.
		// substract priority.
		for (const order of prep.buildOrders)
		{
			order[0] = order[2].length + this.queuedFor(gameState, prep, order[4]).total;
		}
		prep.buildOrders.sort(byTrainingAdvancement);

		if (this.Config.debug > 1 && gameState.ai.playedTurn % 50 === 0)
		{
			this.debugBuildOrders(gameState, prep);
		}

		const firstOrder = prep.buildOrders[0];
		if (firstOrder[0] < firstOrder[3].targetSize)
		{
			this.queueBuildOrder(gameState, prep, firstOrder);
		}
	}

	/** The units of a build order in training and in the plan's three queues */
	private queuedFor(
		gameState: CommonGameState,
		prep: AttackPreparation,
		name: string,
	): { inTraining: number; queue1: number; queue2: number; queue3: number; total: number; }
	{
		const special = "Plan_" + this.name + "_" + name;
		const inTraining = gameState.countOwnQueuedEntitiesWithMetadata("special", special);
		const queue1 = prep.queue.countQueuedUnitsWithMetadata("special", special);
		const queue2 = prep.queueChamp.countQueuedUnitsWithMetadata("special", special);
		const queue3 = prep.queueSiege.countQueuedUnitsWithMetadata("special", special);
		let total = inTraining;
		total += queue1;
		total += queue2;
		total += queue3;
		return { inTraining, queue1, queue2, queue3, total };
	}

	private debugBuildOrders(gameState: CommonGameState, prep: AttackPreparation): void
	{
		aiWarn("====================================");
		aiWarn("======== build order for plan " + this.name);
		for (const order of prep.buildOrders)
		{
			const { inTraining, queue1, queue2, queue3 } = this.queuedFor(gameState, prep, order[4]);
			aiWarn(
				" >>> " + order[4] + " done " + order[2].length + " training " + inTraining +
					" queue " + queue1 + " champ " + queue2 + " siege " + queue3 + " >> need " + order[3].targetSize,
			);
		}
		aiWarn("====================================");
	}

	/**
	 * A batch of the build order's best trainable unit in its queue (siege and heroes in the siege queue, champions
	 * in the champions'), unless 6 wait there; with no trainable template the build order is removed, effectively
	 * removing the unit from the plan (HACK, TODO replace)
	 */
	private queueBuildOrder(gameState: CommonGameState, prep: AttackPreparation, firstOrder: AttackBuildOrder): void
	{
		// find the actual queue we want
		let queue = prep.queue;
		if (firstOrder[4] === "Siege")
		{
			queue = prep.queueSiege;
		}
		else if (firstOrder[3].classes.indexOf("Hero") !== -1)
		{
			queue = prep.queueSiege;
		}
		else if (firstOrder[3].classes.indexOf("Champion") !== -1)
		{
			queue = prep.queueChamp;
		}

		if (queue.length() > 5)
		{
			return;
		}
		const interests = firstOrder[3].interests;
		const template = interests === undefined ?
			undefined :
			hqOf(gameState).findBestTrainableUnit(gameState, firstOrder[1], interests);
		if (template === undefined)
		{
			debugWarn(this.Config, 1, () => "attack no template found " + firstOrder[1]);
			delete this.unitStat[firstOrder[4]]; // deleting the associated unitstat.
			prep.buildOrders.splice(0, 1);
			return;
		}
		debugWarn(this.Config, 2, () => "attack template " + template + " added for plan " + this.name);
		const max = firstOrder[3].batchSize;
		const specialData = "Plan_" + this.name + "_" + firstOrder[4];
		// trained on the rally point's land where it can be (queueplanTraining's trainer choice)
		const data: PlanMetadata = {
			plan: this.name,
			special: specialData,
			base: NO_BASE,
			index: gameState.ai.accessibility.getAccessValue(this.rallyPoint),
		};
		// findBestTrainableUnit names only templates that exist
		const templateObj = requireTemplate(gameState, template);
		// a mercenary is a citizen soldier that cannot gather: an attacker only
		data.role = templateObj.hasClass("CitizenSoldier") && templateObj.resourceGatherRates() !== undefined ?
			Worker.ROLE_WORKER :
			Worker.ROLE_ATTACK;
		const trainingPlan = new TrainingPlan(gameState, template, data, max, max);
		if (trainingPlan.template)
		{
			queue.addPlan(trainingPlan);
		}
		else
		{
			debugWarn(
				this.Config,
				1,
				() =>
					"training plan canceled because no template for " + template +
					"   build1 " + uneval(firstOrder[1]) +
					" build3 " + uneval(firstOrder[3].interests),
			);
		}
	}

	assignUnits(gameState: CommonGameState): boolean
	{
		let added = false;
		const rallyLand = gameState.ai.accessibility.getAccessValue(this.rallyPoint);
		const available = (ent: CommonEntity): boolean =>
			this.isAvailableUnit(gameState, ent) && !besideEnemies(gameState, ent, rallyLand);
		// If we can not build units, assign all available except those affected to allied defense to the current attack.
		if (!this.canBuildUnits)
		{
			return this.enlistAll(gameState, available);
		}

		if (this.type === AttackPlan.TYPE_RAID)
		{
			return this.enlistRaiders(gameState, available);
		}

		// Assign all units without specific role.
		for (const ent of gameState.getOwnEntitiesByRole(undefined, true).values())
		{
			if (ent.hasClasses(["!Unit", "Ship", "Support"]) || !available(ent) || ent.attackTypes() === undefined)
			{
				continue;
			}
			added = this.enlist(ent);
		}
		// Add units previously in a plan, but which left it because needed for defense or attack finished.
		for (const ent of hqOf(gameState).attackManager.outOfPlan.values())
		{
			if (available(ent))
			{
				added = this.enlist(ent);
			}
		}

		// Finally add also some workers for the higher difficulties,
		if (this.Config.difficulty <= difficulty.EASY)
		{
			return added;
		}
		return this.draftWorkers(gameState, available) || added;
	}

	/** All units available but those affected to allied defense join the plan; whether one did */
	private enlistAll(gameState: CommonGameState, available: (ent: CommonEntity) => boolean): boolean
	{
		let added = false;
		for (const ent of gameState.getOwnUnits().values())
		{
			if (!ent.getMetadata(PlayerID, "allied") && available(ent))
			{
				added = this.enlist(ent);
			}
		}
		return added;
	}

	/** Raids are quick attacks: all FastMoving soldiers join, except some for hunting; whether one did */
	private enlistRaiders(gameState: CommonGameState, available: (ent: CommonEntity) => boolean): boolean
	{
		let added = false;
		let num = 0;
		for (const ent of gameState.getOwnUnits().values())
		{
			if (!ent.hasClass("FastMoving") || !available(ent))
			{
				continue;
			}
			if (num++ < 2)
			{
				continue;
			}
			added = this.enlist(ent);
		}
		return added;
	}

	/** The unit joins the plan: true */
	private enlist(ent: CommonEntity): boolean
	{
		ent.setMetadata(PlayerID, "plan", this.name);
		this.unitCollection.updateEnt(ent);
		return true;
	}

	/**
	 * Some citizen soldiers from the workers: if Rush, all kind of workers, keeping only a minimum number of
	 * defenders; otherwise only some idle workers if too much of them. Whether one was drafted.
	 */
	private draftWorkers(gameState: CommonGameState, available: (ent: CommonEntity) => boolean): boolean
	{
		let added = false;
		let num = 0;
		const numbase: Record<number, number> = {};
		let keep = this.type !== AttackPlan.TYPE_RUSH ?
			6 + 4 * gameState.getNumPlayerEnemies() + 8 * this.Config.personality.defensive :
			8;
		keep = Math.round(this.Config.popScaling * keep);
		for (const ent of gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).values())
		{
			if (!ent.hasClass("CitizenSoldier") || !available(ent))
			{
				continue;
			}
			const baseID = ent.getMetadata(PlayerID, "base");
			if (baseID)
			{
				numbase[baseID] = numbase[baseID] ? ++numbase[baseID] : 1;
			}
			else
			{
				aiWarn("Petra problem ent without base ");
				dumpEntity(ent);
				continue;
			}
			if (num++ < keep || numbase[baseID] < 5)
			{
				continue;
			}
			if (this.type !== AttackPlan.TYPE_RUSH && ent.getMetadata(PlayerID, "subrole") !== Worker.SUBROLE_IDLE)
			{
				continue;
			}
			added = this.enlist(ent);
		}
		return added;
	}

	isAvailableUnit(gameState: CommonGameState, ent: CommonEntity): boolean
	{
		if (!isPlaced(ent))
		{
			return false;
		}
		if (
			ent.getMetadata(PlayerID, "plan") !== undefined && ent.getMetadata(PlayerID, "plan") !== PLAN_RESERVE ||
			ent.getMetadata(PlayerID, "transport") !== undefined ||
			ent.getMetadata(PlayerID, "transporter") !== undefined
		)
		{
			return false;
		}
		if (hqOf(gameState).victoryManager.criticalEnts.has(ent.id()) && (this.overseas || ent.healthLevel() < 0.8))
		{
			return false;
		}
		return true;
	}

	/** Reassign one (at each turn) FastMoving unit to fasten raid preparation. */
	reassignFastUnit(gameState: CommonGameState): void
	{
		for (const ent of this.unitCollection.values())
		{
			if (!isPlaced(ent) || ent.getMetadata(PlayerID, "transport") !== undefined)
			{
				continue;
			}
			if (!ent.hasClasses(["FastMoving+CitizenSoldier"]))
			{
				continue;
			}
			const raid = hqOf(gameState).attackManager.getAttackInPreparation(AttackPlan.TYPE_RAID);
			if (!raid)
			{
				return;
			}
			ent.setMetadata(PlayerID, "plan", raid.name);
			this.unitCollection.updateEnt(ent);
			raid.unitCollection.updateEnt(ent);
			return;
		}
	}

	chooseTarget(gameState: CommonGameState): boolean
	{
		if (!this.findTarget(gameState) || !this.target)
		{
			return false;
		}
		this.targetPos = this.target.position();
		if (!this.targetPos)
		{
			return false;
		}
		// redefine a new rally point for this target if we have a base on the same land
		// find a new one on the pseudo-nearest base (dist weighted by the size of the island)
		const targetIndex = getLandAccess(gameState, this.target);
		if (targetIndex === undefined)
		{
			return false;
		}
		const rallyIndex = gameState.ai.accessibility.getAccessValue(this.rallyPoint);
		if (targetIndex === rallyIndex)
		{
			if (this.overseas)
			{
				this.overseas = 0;
			}
			return true;
		}
		const { rallySame, rallyDiff } = nearestBaseAnchors(gameState, targetIndex, this.targetPos);
		if (rallySame)
		{
			this.rallyPoint = rallySame;
			this.overseas = 0;
		}
		else if (rallyDiff)
		{
			return this.rallyOverseas(gameState, rallyDiff, targetIndex);
		}
		return true;
	}

	/** The target player (chosen if none) and its nearest target, or another player's when it has none */
	private findTarget(gameState: CommonGameState): boolean
	{
		if (this.targetPlayer === undefined)
		{
			this.targetPlayer = hqOf(gameState).attackManager.getEnemyPlayer(gameState, this);
			if (this.targetPlayer === undefined)
			{
				return false;
			}
		}

		this.target = this.getNearestTarget(gameState, this.rallyPoint);
		if (this.target)
		{
			return true;
		}
		if (this.uniqueTargetId)
		{
			return false;
		}

		// may-be all our previous enemey target (if not recomputed here) have been destroyed ?
		this.targetPlayer = hqOf(gameState).attackManager.getEnemyPlayer(gameState, this);
		if (this.targetPlayer !== undefined)
		{
			this.target = this.getNearestTarget(gameState, this.rallyPoint);
		}
		return !!this.target;
	}

	/**
	 * The plan gathers at a base on another land than its target's: the enemy buildings on that land go first
	 * (the whole plan clears it before it sails, FINDINGS §34), else it sails; false when the target cannot be reached
	 */
	private rallyOverseas(gameState: CommonGameState, rallyDiff: CommonPosition, targetIndex: AccessIndex): boolean
	{
		const rallyIndex = gameState.ai.accessibility.getAccessValue(rallyDiff);
		this.rallyPoint = rallyDiff;
		const local = this.targetOnLand(gameState, rallyIndex);
		const localPos = local?.position();
		if (local && localPos)
		{
			this.target = local;
			this.targetPos = localPos;
			this.targetPlayer = local.owner();
			this.overseas = 0;
			return true;
		}
		const sea = hqOf(gameState).getSeaBetweenIndices(gameState, rallyIndex, targetIndex);
		if (!sea)
		{
			aiWarn(
				"Petra: " + this.type + " " + this.name + " has an inaccessible target" +
					" with indices " + rallyIndex + " " + targetIndex + " from " + this.target?.templateName(),
			);
			return false;
		}
		this.overseas = sea;
		hqOf(gameState).navalManager.setMinimalTransportShips(gameState, this.overseas, this.neededShips);
		return true;
	}

	/**
	 * The plan's nearest target on a land, among the enemies with buildings
	 * there (by the plan's own target search, kept to that land), the owner of
	 * the building nearest to the rally point first; undefined for a plan with
	 * a unique target, or when none is found (the target player then unchanged).
	 */
	targetOnLand(gameState: CommonGameState, land: AccessIndex): CommonEntity | undefined
	{
		if (this.uniqueTargetId)
		{
			return undefined;
		}
		const buildings = (hqOf(gameState).attackManager.enemiesByLand(gameState).get(land) ?? []).filter((enemy) =>
			enemy.hasClass("Structure")
		);
		if (!buildings.length)
		{
			return undefined;
		}
		const distance = (enemy: CommonPlacedEntity): number => SquareVectorDistance(enemy.position(), this.rallyPoint);
		const owners = new Set([...buildings].sort((a, b) => distance(a) - distance(b)).map((enemy) => enemy.owner()));
		const targetPlayer = this.targetPlayer;
		for (const owner of owners)
		{
			this.targetPlayer = owner;
			const target = this.getNearestTarget(gameState, this.rallyPoint, land);
			if (target)
			{
				return target;
			}
		}
		this.targetPlayer = targetPlayer;
		return undefined;
	}

	/** The land of the plan's target, if it has one. */
	targetLand(gameState: CommonGameState): AccessIndex | undefined
	{
		const target = this.target;
		return target && getLandAccess(gameState, target);
	}

	/**
	 * Those of the plan's soldiers who stand beside enemies, on another land
	 * than `keptLand` (the rally point's while the plan prepares, the target's
	 * once it sets off), stay there to fight them, from LOCAL_FIGHT_MIN on a
	 * land (AttackManager.splitLocalFights); the fewer, on another land than
	 * the rally point's, leave the plan rather than be shipped to it, and go
	 * back to work (FINDINGS §34). Run while it prepares, so that the plan
	 * counts and trains without them.
	 */
	leaveDisputedLands(gameState: CommonGameState, keptLand: AccessIndex | undefined): void
	{
		hqOf(gameState).attackManager.splitLocalFights(gameState, this, keptLand);
		const rallyLand = gameState.ai.accessibility.getAccessValue(this.rallyPoint);
		for (const ent of this.unitCollection.values())
		{
			if (besideEnemies(gameState, ent, rallyLand))
			{
				this.removeUnit(ent, true);
			}
		}
	}

	/**
	 * sameLand true means that we look for a target for which we do not need to take a transport
	 */
	getNearestTarget(
		gameState: CommonGameState,
		position: CommonPosition,
		sameLand?: AccessIndex | false,
	): CommonEntity | undefined
	{
		const targetPlayer = this.targetPlayer;
		if (targetPlayer === undefined)
		{
			return undefined;
		}
		this.isBlocked = false;
		const land = sameLand && sameLand > 1 ? sameLand : false;

		const targets = this.targetCandidates(gameState, targetPlayer, land);
		if (!targets.hasEntities())
		{
			return undefined;
		}

		// picking the nearest target
		let target;
		let minDist = Math.min();
		for (const ent of targets.values())
		{
			const dist = targetDistance(gameState, ent, position, { land, targetPlayer, type: this.type });
			if (dist !== undefined && dist < minDist)
			{
				minDist = dist;
				target = ent;
			}
		}
		if (!target)
		{
			return undefined;
		}

		// Check that we can reach this target
		target = this.checkTargetObstruction(gameState, target, position);

		if (!target)
		{
			return undefined;
		}
		if (
			this.targetPlayer === 0 && gameState.getVictoryConditions().has("capture_the_relic") &&
			target.hasClass("Relic")
		)
		{
			hqOf(gameState).victoryManager.planRelicRaid(target.id(), this.name);
		}
		// Rushes can change their enemy target if nothing found with the preferred enemy
		// Obstruction also can change the enemy target
		this.targetPlayer = target.owner();
		return target;
	}

	/** The targets the plan chooses from: its unique target, a raid's, a rush's (or the defended ones) or the default ones */
	private targetCandidates(
		gameState: CommonGameState,
		targetPlayer: PlayerId,
		land: AccessIndex | false,
	): CommonEntityCollection
	{
		if (this.uniqueTargetId)
		{
			const targets = new EntityCollection(gameState.sharedScript);
			const ent = gameState.getEntityById(this.uniqueTargetId);
			if (ent)
			{
				targets.addEnt(ent);
			}
			return targets;
		}
		if (this.type === AttackPlan.TYPE_RAID)
		{
			return raidTargetFinder(gameState);
		}
		if (this.type !== AttackPlan.TYPE_RUSH && this.type !== AttackPlan.TYPE_DEFAULT)
		{
			return defaultTargetFinder(gameState, targetPlayer, land);
		}
		const targets = this.rushTargetFinder(gameState, targetPlayer, land);
		// with no undefended building, an attack takes on the defended ones; Petra
		// waited for siege engines, and on islands its armies, finding nothing,
		// were aborted and remade every few seconds for good (FINDINGS §35)
		if (!targets.hasEntities() && (this.type === AttackPlan.TYPE_DEFAULT || this.hasSiegeUnits() || this.forced))
		{
			return defaultTargetFinder(gameState, targetPlayer, land);
		}
		return targets;
	}

	/** Rush target finder aims at isolated non-defended buildings */
	rushTargetFinder(
		gameState: CommonGameState,
		playerEnemy?: PlayerId,
		sameLand: AccessIndex | false = false,
	): CommonEntityCollection
	{
		this.position = this.unitCollection.getCentrePosition();
		if (!this.position)
		{
			this.position = this.rallyPoint;
		}
		return findRushTarget(gameState, this.position, playerEnemy, sameLand, this.type === AttackPlan.TYPE_RUSH);
	}

	/**
	 * Check that we can have a path to this target
	 * otherwise we may be blocked by walls and try to react accordingly
	 * This is done only when attacker and target are on the same land
	 */
	checkTargetObstruction(
		gameState: CommonGameState,
		target: CommonEntity,
		position: CommonPosition,
	): CommonEntity | undefined
	{
		const res = findTargetObstruction(gameState, target, position);
		if (res.blocked)
		{
			this.isBlocked = true;
		}
		return res.target;
	}

	getPathToTarget(gameState: CommonGameState, aim: AttackAim, fixedRallyPoint: boolean = false): boolean
	{
		const target = aim.target;
		const targetPos = aim.pos;
		const startAccess = gameState.ai.accessibility.getAccessValue(this.rallyPoint);
		const endAccess = getLandAccess(gameState, target);
		if (startAccess !== endAccess)
		{
			return false;
		}

		Engine.ProfileStart("AI Compute path");
		const startPos = { x: this.rallyPoint[0], y: this.rallyPoint[1] };
		const endPos = { x: targetPos[0], y: targetPos[1] };
		const path = computePath(startPos, endPos, gameState.getPassabilityClassMask("large"));
		const way: CommonPosition[] = [clone(targetPos)];
		for (const point of path)
		{
			way.push(worldPos(point.x, point.y));
		}
		way.push(clone(this.rallyPoint));
		way.reverse();
		this.path = way;
		// Change the rally point to something useful
		if (!fixedRallyPoint)
		{
			this.setRallyPoint(gameState, way);
		}
		Engine.ProfileStop();

		return true;
	}

	/** Set rally point at the border of our territory, on the path out of it (cut to start there) */
	setRallyPoint(gameState: CommonGameState, path: CommonPosition[]): void
	{
		for (let i = 0; i < path.length; ++i)
		{
			if (gameState.ai.geography.territoryMap.getOwner(path[i]) === PlayerID)
			{
				continue;
			}

			if (i === 0)
			{
				this.rallyPoint = path[0];
			}
			else if (i > 1 && hqOf(gameState).isDangerousLocation(gameState, path[i - 1], 20))
			{
				this.rallyPoint = path[i - 2];
				path.splice(0, i - 2);
			}
			else
			{
				this.rallyPoint = path[i - 1];
				path.splice(0, i - 1);
			}
			break;
		}
	}

	/**
	 * Executes the attack plan, after this is executed the update function will be run every turn
	 * If we're here, it's because we have enough units.
	 */
	StartAttack(gameState: CommonGameState): boolean
	{
		debugWarn(this.Config, 1, () => "start attack " + this.name + " with type " + this.type);

		// if our target was destroyed during preparation, choose a new one
		if (
			(this.targetPlayer === undefined || !this.target || !gameState.getEntityById(this.target.id())) &&
			!this.chooseTarget(gameState)
		)
		{
			return false;
		}
		this.leaveDisputedLands(gameState, this.targetLand(gameState));

		// erase our queue. This will stop any leftover unit from being trained.
		this.removeQueues(gameState);

		for (const ent of this.unitCollection.values())
		{
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_WALKING);
			const stance = ent.isPackable() ? "standground" : "aggressive";
			if (ent.getStance() !== stance)
			{
				ent.setStance(stance);
			}
		}

		const target = this.target;
		if (!target)
		{
			return false;
		}
		const targetPos = this.targetPos;
		if (!targetPos)
		{
			return false;
		}
		const rallyAccess = gameState.ai.accessibility.getAccessValue(this.rallyPoint);
		const targetAccess = getLandAccess(gameState, target);
		if (rallyAccess === undefined || targetAccess === undefined)
		{
			return false;
		}
		if (rallyAccess === targetAccess)
		{
			return this.walkTo(gameState, { target, pos: targetPos });
		}
		return this.sailTo(gameState, rallyAccess, targetAccess, targetPos);
	}

	/** The plan walks to its target on its land, along its path (made now if none); false without one */
	private walkTo(gameState: CommonGameState, aim: AttackAim): boolean
	{
		if (!this.path)
		{
			this.getPathToTarget(gameState, aim, true);
		}
		const path = this.path;
		if (!path || !path[0][0] || !path[0][1])
		{
			return false;
		}
		this.overseas = 0;
		this.startWalking(path);
		this.unitCollection.moveToRange(path[0][0], path[0][1], 0, 15);
		return true;
	}

	/** The plan's units are shipped to the target's land; false without a sea there */
	private sailTo(
		gameState: CommonGameState,
		rallyAccess: AccessIndex,
		targetAccess: AccessIndex,
		targetPos: CommonPosition,
	): boolean
	{
		const sea = hqOf(gameState).getSeaBetweenIndices(gameState, rallyAccess, targetAccess);
		if (sea === undefined)
		{
			return false;
		}
		this.overseas = sea;
		if (!this.overseas)
		{
			return false;
		}
		this.changeState(AttackPlan.STATE_COMPLETING, AttackPlan.STATE_TRANSPORTING);
		// TODO require a global transport for the collection,
		// and put back its state to "walking" when the transport is finished
		for (const ent of this.unitCollection.values())
		{
			hqOf(gameState).navalManager.requireTransport(gameState, ent, rallyAccess, targetAccess, targetPos);
		}
		return true;
	}

	/** Runs every turn after the attack is executed */
	update(gameState: CommonGameState, events: EngineAIEvents): number | false
	{
		if (!this.unitCollection.hasEntities())
		{
			return 0;
		}

		Engine.ProfileStart("Update Attack");
		const remaining = this.updateTurn(gameState, events);
		Engine.ProfileStop();
		return remaining;
	}

	/** The turn of an attack under way: the units it has left, or false when it has no target any more */
	private updateTurn(gameState: CommonGameState, events: EngineAIEvents): number | false
	{
		this.releaseGarrisoned(gameState);
		if (!this.unitCollection.hasEntities())
		{
			return 0;
		}

		this.position = this.unitCollection.getCentrePosition();

		// we are transporting our units, let's wait
		// TODO instead of state "arrived", made a state "walking" with a new path
		if (this.state === AttackPlan.STATE_TRANSPORTING)
		{
			this.UpdateTransporting(gameState, events);
		}

		if (!this.position)
		{
			return this.unitCollection.length;
		}

		const stage = this.stage;
		if (stage.state === AttackPlan.STATE_WALKING && !this.UpdateWalking(gameState, events, stage.path))
		{
			return 0;
		}

		if (this.state === AttackPlan.STATE_ARRIVED)
		{
			this.startAttacking(gameState, this.position);
		}

		// basic state of attacking.
		if (this.state === AttackPlan.STATE_ATTACKING)
		{
			// First update the target and/or its position if needed
			const aim = this.UpdateTarget(gameState);
			if (!aim)
			{
				return false;
			}

			this.updateAttacking(gameState, events, aim);
		}
		this.lastPosition = clone(this.position);
		return this.unitCollection.length;
	}

	/**
	 * A unit inside one of our buildings on land, not on its way by sea, is
	 * out of the attack (trained where the rally point garrisons, then kept
	 * there by the garrison manager): let it go, or a plan of only such
	 * units waits for good and holds up the next attack.
	 */
	private releaseGarrisoned(gameState: CommonGameState): void
	{
		for (const ent of this.unitCollection.values())
		{
			if (isPlaced(ent) || ent.getMetadata(PlayerID, "transport") !== undefined)
			{
				continue;
			}
			const holderId = ent.garrisonHolderID();
			const holder = holderId === undefined ? undefined : gameState.getEntityById(holderId);
			if (holder && !holder.hasClass("Ship"))
			{
				this.removeUnit(ent, true);
			}
		}
	}

	/** Arrived: let's proceed on with whatever happens now; a rush tries to find a better target */
	private startAttacking(gameState: CommonGameState, position: CommonPosition): void
	{
		this.changeState(AttackPlan.STATE_ARRIVED, AttackPlan.STATE_ATTACKING);
		this.startingAttack = true;
		this.unitCollection.forEach((ent) =>
		{
			ent.stopMoving();
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_ATTACKING);
		});
		if (this.type !== AttackPlan.TYPE_RUSH)
		{
			return;
		}
		const newtarget = this.getNearestTarget(gameState, position);
		if (newtarget)
		{
			this.target = newtarget;
			this.targetPos = this.target.position();
		}
	}

	/** The attacking state's turn: answer the blows, then look at a few attackers' orders. */
	updateAttacking(gameState: CommonGameState, events: EngineAIEvents, aim: AttackAim): void
	{
		const target = aim.target;
		const targetPos = aim.pos;

		const time = gameState.ai.elapsedTime;
		const attackedByStructure = answerAttackers(gameState, events, time, this.unitCollection, this.isBlocked);

		const enemyUnits = gameState.getEnemyUnits(this.targetPlayer);
		const enemyStructures = gameState.getEnemyStructures(this.targetPlayer);

		// Count the number of times an enemy is targeted, to prevent all units to follow the same target
		const unitTargets = countUnitTargets(gameState, this.unitCollection);
		const veto: Record<string, boolean> = {};
		for (const target in unitTargets)
		{
			if (unitTargets[target] > 0)
			{
				veto[target] = true;
			}
		}

		const { targetClassesUnit, targetClassesSiege } = attackerTargetClasses(this.type, target, veto);

		if (this.unitCollUpdateArray === undefined || !this.unitCollUpdateArray.length)
		{
			this.unitCollUpdateArray = this.unitCollection.toIdArray();
		}

		// Let's check a few units each time we update (currently 10) except when attack starts
		const lgth = this.unitCollUpdateArray.length < 15 || this.startingAttack ? this.unitCollUpdateArray.length : 10;
		const ctx: AttackerContext = {
			time,
			target,
			targetPos,
			veto,
			unitTargets,
			attackedByStructure,
			enemyUnits,
			enemyStructures,
			targetClassesUnit,
			targetClassesSiege,
			unitCollection: this.unitCollection,
			isBlocked: this.isBlocked,
		};
		for (let check = 0; check < lgth; check++)
		{
			const ent = gameState.getEntityById(this.unitCollUpdateArray[check]);
			if (!ent || !isPlaced(ent))
			{
				continue;
			}
			orderAttacker(gameState, ent, ctx);
		}
		this.unitCollUpdateArray.splice(0, lgth);
		this.startingAttack = false;

		// check if this enemy has resigned
		if (this.target && this.target.owner() === 0 && this.targetPlayer !== 0)
		{
			this.target = undefined;
		}
	}

	UpdateTransporting(gameState: CommonGameState, events: EngineAIEvents): void
	{
		let done = true;
		for (const ent of this.unitCollection.values())
		{
			if (this.Config.debug > 1 && ent.getMetadata(PlayerID, "transport") !== undefined)
			{
				debugShade([ent.id()], [2, 2, 0]);
			}
			else if (this.Config.debug > 1)
			{
				debugShade([ent.id()], [1, 1, 1]);
			}
			if (!done)
			{
				continue;
			}
			if (ent.getMetadata(PlayerID, "transport") !== undefined)
			{
				done = false;
			}
		}

		if (done)
		{
			this.changeState(AttackPlan.STATE_TRANSPORTING, AttackPlan.STATE_ARRIVED);
			return;
		}

		// if we are attacked while waiting the rest of the army, retaliate
		this.answerAttacks(gameState, events);
	}

	/**
	 * Answers the first attack of the turn on one of the plan's units, while
	 * the plan waits for its ships. A unit bound for a ship, still ashore, walks
	 * or waits for it and is never idle; it strikes back at an attacker on its
	 * own land, where it stood still under fire before (FINDINGS §34); the
	 * boarding then walks it back to its ship. One aboard (no position) cannot.
	 * While the plan sails to its target ("transporting") the idle ones answer
	 * too. While it gathers at its rally point ("completing"), only those bound
	 * for a ship to it, within ANSWER_RANGE of the unit hit: the defense
	 * manager leaves the units of a plan past preparation to it, and they stood
	 * under fire at the shore. The others, walking to the rally point, keep
	 * walking: answering every blow, they chased their attackers away from the
	 * army, and on mainland the attacks bled (FINDINGS §34).
	 */
	answerAttacks(gameState: CommonGameState, events: EngineAIEvents): void
	{
		const completing = this.state === AttackPlan.STATE_COMPLETING;
		for (const evt of events.Attacked)
		{
			if (!this.unitCollection.hasEntId(evt.target))
			{
				continue;
			}
			const attacker = gameState.getEntityById(evt.attacker);
			const victim = gameState.getEntityById(evt.target);
			if (!attacker || !victim)
			{
				continue;
			}
			const attackerLand = getLandAccess(gameState, attacker);
			const near = victim.position() ?? attacker.position();
			for (const ent of this.unitCollection.values())
			{
				if (
					!answersBlow(gameState, ent, completing, attackerLand, {
						pos: near,
						range: AttackPlan.ANSWER_RANGE,
					})
				)
				{
					continue;
				}
				const shouldCapture = allowCapture(gameState, ent, attacker);
				if (!ent.canAttackTarget(attacker, shouldCapture))
				{
					continue;
				}
				ent.attack(attacker.id(), shouldCapture);
			}
			break;
		}
	}

	/** A walking turn, on the path the plan sets off on (StartAttack) or was saved walking. */
	UpdateWalking(gameState: CommonGameState, events: EngineAIEvents, path: CommonPosition[]): boolean
	{
		const pos = this.position;
		if (!pos)
		{
			return false;
		}
		const pos5TurnsAgo = this.position5TurnsAgo;
		const targetPos = this.targetPos;
		// we're marching towards the target
		// Are we arrived at destination ?
		if (this.arrivedUnderFire(gameState, events, pos))
		{
			this.changeState(AttackPlan.STATE_WALKING, AttackPlan.STATE_ARRIVED);
			return true;
		}

		// basically haven't moved an inch: very likely stuck)
		if (
			pos5TurnsAgo && SquareVectorDistance(pos, pos5TurnsAgo) < 10 &&
			path.length > 0 && gameState.ai.playedTurn % 5 === 0
		)
		{
			destroyFarthestSiege(this.unitCollection, pos);
		}
		if (gameState.ai.playedTurn % 5 === 0)
		{
			this.position5TurnsAgo = clone(pos);
		}

		const lastPos = this.lastPosition;
		if (lastPos && SquareVectorDistance(pos, lastPos) < 16 && path.length > 0)
		{
			const walls = this.unstick(gameState, pos, path);
			if (walls !== undefined)
			{
				return walls;
			}
		}

		// check if our units are close enough from the next waypoint.
		if (targetPos && SquareVectorDistance(pos, targetPos) < 10000 || this.walkedPath(path, pos))
		{
			debugWarn(
				this.Config,
				1,
				() => "Attack Plan " + this.type + " " + this.name + " has arrived to destination.",
			);
			this.changeState(AttackPlan.STATE_WALKING, AttackPlan.STATE_ARRIVED);
		}
		return true;
	}

	/**
	 * Let's check if any of our unit has been attacked: in case yes, we'll determine if we're simply off against an
	 * enemy army, a lone unit/building or if we reached the enemy base (attacked in its territory, or a lot).
	 * Different plans may react differently.
	 */
	private arrivedUnderFire(gameState: CommonGameState, events: EngineAIEvents, pos: CommonPosition): boolean
	{
		let attackedNB = 0;
		let attackedUnitNB = 0;
		for (const evt of events.Attacked)
		{
			if (!this.unitCollection.hasEntId(evt.target))
			{
				continue;
			}
			const attacker = gameState.getEntityById(evt.attacker);
			if (attacker && (attacker.owner() !== 0 || this.targetPlayer === 0))
			{
				attackedNB++;
				if (attacker.hasClass("Unit"))
				{
					attackedUnitNB++;
				}
			}
		}
		return attackedNB > 1 && (attackedUnitNB > 0 || this.hasSiegeUnits()) &&
			(gameState.ai.geography.territoryMap.getOwner(pos) === this.targetPlayer || attackedNB > 3);
	}

	/**
	 * We're stuck, presumably: walls just close to us end the walk (arrived, true, if we can attack them, else
	 * false: we give up); without, the army is sent again to the next waypoint (undefined)
	 */
	private unstick(gameState: CommonGameState, pos: CommonPosition, path: CommonPosition[]): boolean | undefined
	{
		if (!path[0][0] || !path[0][1])
		{
			aiWarn("Start: Problem with path " + uneval(path));
		}
		const walls = this.facesWalls(gameState, pos);
		if (walls !== undefined)
		{
			if (walls)
			{
				this.changeState(AttackPlan.STATE_WALKING, AttackPlan.STATE_ARRIVED);
			}
			return walls;
		}
		// this.unitCollection.move(path[0][0], path[0][1]);
		this.unitCollection.moveIndiv(path[0][0], path[0][1]);
		return undefined;
	}

	/**
	 * Walls just close to a stuck army: true if it can attack them (it has arrived), false if not (it gives up),
	 * undefined when there are none
	 */
	private facesWalls(gameState: CommonGameState, pos: CommonPosition): boolean | undefined
	{
		for (const ent of gameState.getEnemyStructures().filter(filters.byClasses(["Palisade", "Wall"])).values())
		{
			const entPos = ent.position();
			if (SquareVectorDistance(pos, entPos) > 800)
			{
				continue;
			}
			const enemyClass = ent.hasClass("Wall") ? "Wall" : "Palisade";
			// there are walls, so check if we can attack
			if (this.unitCollection.filter(filters.byCanAttackClass(enemyClass)).hasEntities())
			{
				debugWarn(
					this.Config,
					1,
					() => "Attack Plan " + this.type + " " + this.name + " has met walls and is not happy.",
				);
				return true;
			}
			// abort plan
			debugWarn(
				this.Config,
				1,
				() => "Attack Plan " + this.type + " " + this.name + " has met walls and gives up.",
			);
			return false;
		}
		return undefined;
	}

	/** The next waypoint reached: the army moves on to the one after; whether that was the last */
	private walkedPath(path: CommonPosition[], pos: CommonPosition): boolean
	{
		if (!path.length || !(SquareVectorDistance(pos, path[0]) < 1600))
		{
			return false;
		}
		path.shift();
		if (!path.length)
		{
			return true;
		}
		this.unitCollection.moveToRange(path[0][0], path[0][1], 0, 15);
		return false;
	}

	UpdateTarget(gameState: CommonGameState): AttackAim | undefined
	{
		const pos = this.position;
		if (!pos)
		{
			return undefined;
		}
		// First update the target position in case it's a unit (and check if it has garrisoned)
		if (this.target && this.target.hasClass("Unit"))
		{
			this.followUnitTarget(gameState, this.target);
		}
		// Then update the target if needed:
		if (this.targetPlayer === undefined || !gameState.isPlayerEnemy(this.targetPlayer))
		{
			this.targetPlayer = hqOf(gameState).attackManager.getEnemyPlayer(gameState, this);
			if (this.targetPlayer === undefined)
			{
				return undefined;
			}

			if (this.target && this.target.owner() !== this.targetPlayer)
			{
				this.target = undefined;
			}
		}
		if (this.target && this.target.owner() === 0 && this.targetPlayer !== 0)
		{ // this enemy has resigned
			this.target = undefined;
		}

		if (!this.target || !gameState.getEntityById(this.target.id()))
		{
			debugWarn(
				this.Config,
				1,
				() => "Seems like our target for plan " + this.name + " has been destroyed or captured. Switching.",
			);
			if (!this.switchTarget(gameState, pos))
			{
				return undefined;
			}
		}
		return this.aim();
	}

	/** A unit target's position; one gone into an enemy's building gives way to that holder */
	private followUnitTarget(gameState: CommonGameState, target: CommonEntity): void
	{
		this.targetPos = target.position();
		if (this.targetPos)
		{
			return;
		}
		const holder = getHolder(gameState, target);
		if (holder && gameState.isPlayerEnemy(holder.owner()))
		{
			this.target = holder;
			this.targetPos = holder.position();
		}
		else
		{
			this.target = undefined;
		}
	}

	/**
	 * A new target, the nearest on the army's land; else one of our other attacks' there, which we help; else
	 * another enemy's. Whether one was found.
	 */
	private switchTarget(gameState: CommonGameState, pos: CommonPosition): boolean
	{
		const accessIndex = this.getAttackAccess(gameState);
		this.target = this.getNearestTarget(gameState, pos, accessIndex);
		if (!this.target)
		{
			if (this.uniqueTargetId)
			{
				return false;
			}

			// Check if we could help any current attack
			if (this.helpOtherAttack(gameState, accessIndex))
			{
				return true;
			}

			// If not, let's look for another enemy
			this.targetPlayer = hqOf(gameState).attackManager.getEnemyPlayer(gameState, this);
			if (this.targetPlayer !== undefined)
			{
				this.target = this.getNearestTarget(gameState, pos, accessIndex);
			}
			if (!this.target)
			{
				debugWarn(this.Config, 1, () => "No new target found. Remaining units " + this.unitCollection.length);
				return false;
			}
			debugWarn(this.Config, 1, () => "We will help one of our other attacks");
		}
		this.targetPos = this.target.position();
		return true;
	}

	/** The target of another of our attacks on that land, still an enemy's: whether we take it */
	private helpOtherAttack(gameState: CommonGameState, accessIndex: AccessIndex | undefined): boolean
	{
		const attackManager = hqOf(gameState).attackManager;
		for (const attack of plansIn(attackManager.startedAttacks))
		{
			if (attack.name === this.name)
			{
				continue;
			}
			if (
				!attack.target || !gameState.getEntityById(attack.target.id()) ||
				!gameState.isPlayerEnemy(attack.target.owner())
			)
			{
				continue;
			}
			if (accessIndex !== getLandAccess(gameState, attack.target))
			{
				continue;
			}
			if (attack.target.owner() === 0 && attack.targetPlayer !== 0)
			{ // looks like it has resigned
				continue;
			}
			if (!gameState.isPlayerEnemy(attack.targetPlayer ?? INVALID_PLAYER))
			{
				continue;
			}
			this.target = attack.target;
			this.targetPlayer = attack.targetPlayer;
			this.targetPos = this.target.position();
			return true;
		}
		return false;
	}

	/** reset any units */
	Abort(gameState: CommonGameState): void
	{
		const pos = this.position;
		this.unitCollection.unregister();
		if (this.unitCollection.hasEntities())
		{
			// If the attack was started, look for a good rallyPoint to withdraw
			// (an army with no position is aboard ships: it gets no rallyPoint)
			const { rallyPoint, withdrawRange } = this.isStarted() && pos ?
				this.withdrawPoint(gameState, pos) :
				{ rallyPoint: undefined, withdrawRange: WITHDRAW_RANGE };

			for (const ent of this.unitCollection.values())
			{
				if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_ATTACK)
				{
					ent.stopMoving();
				}
				if (rallyPoint)
				{
					ent.moveToRange(rallyPoint[0], rallyPoint[1], 0, withdrawRange);
				}
				this.removeUnit(ent);
			}
		}

		for (const unitCat in this.unitStat)
		{
			this.unit[unitCat].unregister();
		}

		this.removeQueues(gameState);
	}

	/**
	 * Where a started attack withdraws: its rally point if on the army's land, or a nearer base of ours there (in
	 * case this attack has captured one); and how far from it the units may stop: an anchor's position is the
	 * centre of its building, so the ring must reach out past the footprint or nobody can get there
	 */
	private withdrawPoint(
		gameState: CommonGameState,
		pos: CommonPosition,
	): { rallyPoint: CommonPosition | undefined; withdrawRange: number; }
	{
		let rallyPoint;
		let withdrawRange = WITHDRAW_RANGE;
		const access = this.getAttackAccess(gameState);
		let dist = Math.min();
		if (this.rallyPoint && gameState.ai.accessibility.getAccessValue(this.rallyPoint) === access)
		{
			rallyPoint = this.rallyPoint;
			dist = SquareVectorDistance(pos, rallyPoint);
		}
		for (const base of basesOf(gameState))
		{
			const anchor = base.anchor;
			const anchorPos = anchor ? anchor.position() : undefined;
			if (!anchor || !anchorPos)
			{
				continue;
			}
			if (getLandAccess(gameState, anchor) !== access)
			{
				continue;
			}
			const newdist = SquareVectorDistance(pos, anchorPos);
			if (newdist > dist)
			{
				continue;
			}
			dist = newdist;
			rallyPoint = anchorPos;
			withdrawRange = anchor.obstructionRadius().max + WITHDRAW_RANGE;
		}
		return { rallyPoint, withdrawRange };
	}

	removeUnit(ent: CommonEntity, update = false): void
	{
		if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_ATTACK)
		{
			if (ent.hasClass("CitizenSoldier") && ent.isGatherer())
			{
				ent.setMetadata(PlayerID, "role", Worker.ROLE_WORKER);
			}
			else
			{
				ent.setMetadata(PlayerID, "role", undefined);
			}
			ent.setMetadata(PlayerID, "subrole", undefined);
		}
		ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
		if (update)
		{
			this.unitCollection.updateEnt(ent);
		}
	}

	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.EntityRenamed)
		{
			if (this.target && this.target.id() === evt.entity)
			{
				this.onTargetRenamed(gameState, evt.newentity);
			}
		}

		this.onTargetLost(gameState, events);

		// The original made and registered a new unit collection here every
		// turn, never unregistering the last: each one stayed in the shared
		// script's lists, updated on every plan or owner change of any entity,
		// thousands by minute 30 and the main cost of a late turn (FINDINGS §48).
		// The constructor's collection is kept up to date by its registration.

		if (!this.overseas || this.state !== AttackPlan.STATE_UNEXECUTED)
		{
			return;
		}
		// let's check if an enemy has built a structure at our access
		for (const evt of events.Create)
		{
			const ent = gameState.getEntityById(evt.entity);
			if (ent && isPlaced(ent) && ent.hasClass("Structure") && gameState.isPlayerEnemy(ent.owner()))
			{
				this.rallyAtBaseOn(gameState, getLandAccess(gameState, ent));
			}
		}
	}

	/** The target captured by an ally is no more ours; a defeated target player gives way to another */
	private onTargetLost(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.OwnershipChanged)
		{ // capture event
			if (this.target && this.target.id() === evt.entity && gameState.isPlayerAlly(evt.to))
			{
				this.target = undefined;
			}
		}

		for (const evt of events.PlayerDefeated)
		{
			if (this.targetPlayer !== evt.playerId)
			{
				continue;
			}
			this.targetPlayer = hqOf(gameState).attackManager.getEnemyPlayer(gameState, this);
			this.target = undefined;
		}
	}

	/** The target renamed (promoted, upgraded): followed, but by a raid not yet started */
	private onTargetRenamed(gameState: CommonGameState, newentity: EntityId): void
	{
		if (this.type === AttackPlan.TYPE_RAID && !this.isStarted())
		{
			this.target = undefined;
		}
		else
		{
			this.target = gameState.getEntityById(newentity);
		}
		if (this.target)
		{
			this.targetPos = this.target.position();
		}
	}

	/** An enemy built on a land where we have a base: the plan gathers there, the last such base, without sailing */
	private rallyAtBaseOn(gameState: CommonGameState, access: AccessIndex): void
	{
		for (const base of basesOf(gameState))
		{
			const anchorPos = base.anchor ? base.anchor.position() : undefined;
			if (!anchorPos)
			{
				continue;
			}
			if (base.accessIndex !== access)
			{
				continue;
			}
			this.overseas = 0;
			this.rallyPoint = anchorPos;
		}
	}

	waitingForTransport(): boolean
	{
		for (const ent of this.unitCollection.values())
		{
			if (ent.getMetadata(PlayerID, "transport") !== undefined)
			{
				return true;
			}
		}
		return false;
	}

	hasSiegeUnits(): boolean
	{
		for (const ent of this.unitCollection.values())
		{
			if (isSiegeUnit(ent))
			{
				return true;
			}
		}
		return false;
	}

	hasForceOrder(data?: string, value?: unknown): boolean
	{
		for (const ent of this.unitCollection.values())
		{
			if (data && Number(ent.getMetadata(PlayerID, data)) !== Number(value))
			{
				continue;
			}
			const orders = ordersOf(ent);
			for (const order of orders)
			{
				if (order.force)
				{
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * The center position of this attack may be in an inaccessible area. So we use the access
	 * of the unit nearest to this center position.
	 */
	getAttackAccess(gameState: CommonGameState): AccessIndex
	{
		// no position: no unit of the army has one (all aboard ships)
		const pos = this.position;
		if (!pos)
		{
			return NO_LAND;
		}
		for (const ent of this.unitCollection.filterNearest(pos, 1).values())
		{
			return getLandAccess(gameState, ent) ?? NO_REGION;
		}

		return NO_LAND;
	}

	debugAttack(): void
	{
		aiWarn("---------- attack " + this.name);
		for (const unitCat in this.unitStat)
		{
			const Unit = this.unitStat[unitCat];
			aiWarn(unitCat + " num=" + this.unit[unitCat].length + " min=" + Unit.minSize + " need=" + Unit.targetSize);
		}
		aiWarn("------------------------------");
	}

	Serialize(): SerializedAttackPlan
	{
		const properties = {
			name: this.name,
			type: this.type,
			state: this.state,
			forced: this.forced,
			rallyPoint: clone(this.rallyPoint),
			overseas: this.overseas,
			paused: this.paused,
			maxCompletingTime: this.maxCompletingTime,
			neededShips: this.neededShips,
			unitStat: this.unitStat,
			siegeState: this.preparation()?.siegeState ?? AttackPlan.SIEGE_NOT_TESTED,
			position5TurnsAgo: this.position5TurnsAgo,
			lastPosition: this.lastPosition,
			position: this.position !== undefined ? clone(this.position) : undefined,
			isBlocked: this.isBlocked,
			targetPlayer: this.targetPlayer,
			target: this.target !== undefined ? this.target.id() : undefined,
			targetPos: this.targetPos !== undefined ? clone(this.targetPos) : undefined,
			uniqueTargetId: this.uniqueTargetId,
			path: this.path,
			unitCollUpdateArray: this.unitCollUpdateArray,
		};

		return { properties: properties };
	}
}
