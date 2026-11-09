import * as filters from "simulation/ai/common-api/filters.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { NO_LAND, NO_REGION, attackPlanId, seconds, worldPos } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, isSiegeUnit, requireValue } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { computePath } from "../adapter/pathfinder.ts";
import { isPlaced } from "../adapter/placed.ts";
import { allowCapture } from "../world/capture.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import {
	ANSWER_RANGE,
	PREPARATION_FAILED,
	PREPARATION_KEEP_GOING,
	PREPARATION_START,
	SIEGE_ADDED,
	SIEGE_NOT_TESTED,
	SIEGE_NO_TRAINER,
	STATE_ARRIVED,
	STATE_ATTACKING,
	STATE_COMPLETING,
	STATE_TRANSPORTING,
	STATE_UNEXECUTED,
	STATE_WALKING,
	TYPE_DEFAULT,
	TYPE_HUGE_ATTACK,
	TYPE_RAID,
	TYPE_RUSH,
	WITHDRAW_RANGE,
	type AttackType,
} from "./attackConstants.ts";
import { besideEnemies, draftWorkers, enlist, enlistAll, enlistRaiders, leaveDisputedLands } from "./attackDraft.ts";
import {
	onTargetLost,
	onTargetRenamed,
	rallyAtBaseOn,
	releaseGarrisoned,
	startAttacking,
	withdrawPoint,
} from "./attackFight.ts";
import { UpdateTransporting, UpdateWalking, walkTo, type MarchTrack } from "./attackMarch.ts";
import {
	answerAttackers,
	answersBlow,
	attackerTargetClasses,
	countUnitTargets,
	orderAttacker,
	type AttackerContext,
} from "./attackOrders.ts";
import {
	completingStep,
	debugBuildOrders,
	emptyQueues,
	prepareArmy,
	queueBuildOrder,
	queuedFor,
	setOff,
	trainingStep,
} from "./attackPreparation.ts";
import {
	findTarget,
	followUnitTarget,
	rallyOverseas,
	switchTarget,
	targetCandidates,
	targetLand,
} from "./attackTargeting.ts";
import {
	findRushTarget,
	findTargetObstruction,
	nearestBaseAnchors,
	rallyPoints,
	targetDistance,
} from "./attackTargets.ts";
import type { Queue } from "./queue.ts";
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

export type AttackBuildOrder = [number, string[], CommonEntityCollection, AttackUnitStat, string];

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
export type AttackAim = { target: CommonEntity; pos: CommonPosition; };

/**
 * What a plan attacks and what it knows of it: the entity, where it was last
 * seen, its owner, and the unique target it was asked to keep. Every stage
 * carries one, so the target and its position move together.
 */
export type AttackTarget = {
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
	/** Until when a completing plan waits for its units' forced orders (attackPreparation.ts) */
	maxCompletingTime: GameSeconds;
};

export class AttackPlan
{
	Config: Config;
	canBuildUnits: boolean;
	forced: boolean;
	isBlocked: boolean;
	/** Where the army stood, to tell when it is stuck (attackMarch.ts) */
	march: MarchTrack;
	name: AttackPlanId;
	neededShips: number;
	overseas: SeaIndex | 0;
	paused: boolean;
	position: CommonPosition | undefined;
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
				const sea = gameState.ai.town.getSeaBetweenIndices(gameState, rallyAccess, access);
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
				gameState.ai.town.transports.setMinimalTransportShips(gameState, sea, 1);
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
				canBuildUnits: gameState.ai.town.canBuildUnits,
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
			this.neededShips = saved.properties.neededShips;
			this.unitStat = saved.properties.unitStat;
			this.march = {
				position5TurnsAgo: saved.properties.position5TurnsAgo,
				lastPosition: saved.properties.lastPosition,
			};
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

			// the army this type aims at (see attackComposition), sized by difficulty and population
			const sizes = planSizes(this.Config, setup.type, data, setup.variation);
			this.unitStat = sizes.unitStat;
			this.neededShips = sizes.neededShips;
			makeStage = this.newStage(gameState, sizes.priority);

			// some variables used during the attack
			this.march = { position5TurnsAgo: worldPos(0, 0), lastPosition: worldPos(0, 0) };
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
			prep: {
				queue,
				queueChamp,
				queueSiege,
				buildOrders,
				siegeState: AttackPlan.SIEGE_NOT_TESTED,
				maxCompletingTime: seconds(0),
			},
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
				prep: {
					...queues,
					buildOrders,
					siegeState: saved.properties.siegeState,
					maxCompletingTime: saved.properties.maxCompletingTime,
				},
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

	static PREPARATION_FAILED = PREPARATION_FAILED;
	static PREPARATION_KEEP_GOING = PREPARATION_KEEP_GOING;
	static PREPARATION_START = PREPARATION_START;

	static SIEGE_NOT_TESTED = SIEGE_NOT_TESTED;
	static SIEGE_NO_TRAINER = SIEGE_NO_TRAINER;
	static SIEGE_ADDED = SIEGE_ADDED;
	static ANSWER_RANGE = ANSWER_RANGE;

	static readonly STATE_UNEXECUTED = STATE_UNEXECUTED;
	static readonly STATE_COMPLETING = STATE_COMPLETING;
	static readonly STATE_WALKING = STATE_WALKING;
	static readonly STATE_TRANSPORTING = STATE_TRANSPORTING;
	static readonly STATE_ARRIVED = STATE_ARRIVED;
	static readonly STATE_ATTACKING = STATE_ATTACKING;

	static readonly TYPE_DEFAULT = TYPE_DEFAULT;
	static readonly TYPE_HUGE_ATTACK = TYPE_HUGE_ATTACK;
	static readonly TYPE_RAID = TYPE_RAID;
	static readonly TYPE_RUSH = TYPE_RUSH;

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
		const completing = this.state === AttackPlan.STATE_COMPLETING ? this.preparation() : undefined;
		if (completing)
		{
			const step = completingStep(this, gameState, completing);
			if (step !== undefined)
			{
				return step;
			}
		}

		if (this.Config.debug > 3 && gameState.ai.playedTurn % 50 === 0)
		{
			this.debugAttack();
		}

		if (!prepareArmy(this, gameState))
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}

		// the training below is a preparing plan's: one that set off has none to train with
		const prep = this.preparation();
		if (!prep)
		{
			return AttackPlan.PREPARATION_KEEP_GOING;
		}

		const step = trainingStep(this, gameState, prep);
		if (step !== undefined)
		{
			return step;
		}

		// if we're here, it means we must start
		return setOff(this, gameState, prep);
	}

	trainMoreUnits(gameState: CommonGameState, prep: AttackPreparation): void
	{
		// let's sort by training advancement, ie 'current size / target size'
		// count the number of queued units too.
		// substract priority.
		for (const order of prep.buildOrders)
		{
			order[0] = order[2].length + queuedFor(this, gameState, prep, order[4]).total;
		}
		prep.buildOrders.sort(byTrainingAdvancement);

		if (this.Config.debug > 1 && gameState.ai.playedTurn % 50 === 0)
		{
			debugBuildOrders(this, gameState, prep);
		}

		const firstOrder = prep.buildOrders[0];
		if (firstOrder[0] < firstOrder[3].targetSize)
		{
			queueBuildOrder(this, gameState, prep, firstOrder);
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
			return enlistAll(this, gameState, available);
		}

		if (this.type === AttackPlan.TYPE_RAID)
		{
			return enlistRaiders(this, gameState, available);
		}

		// Assign all units without specific role.
		for (const ent of gameState.getOwnEntitiesByRole(undefined, true).values())
		{
			if (ent.hasClasses(["!Unit", "Ship", "Support"]) || !available(ent) || ent.attackTypes() === undefined)
			{
				continue;
			}
			added = enlist(this, ent);
		}
		// Add units previously in a plan, but which left it because needed for defense or attack finished.
		for (const ent of gameState.ai.town.attacks.outOfPlan.values())
		{
			if (available(ent))
			{
				added = enlist(this, ent);
			}
		}

		// Finally add also some workers for the higher difficulties,
		if (this.Config.difficulty <= difficulty.EASY)
		{
			return added;
		}
		return draftWorkers(this, gameState, available) || added;
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
		if (gameState.ai.town.guard.isCritical(ent.id()) && (this.overseas || ent.healthLevel() < 0.8))
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
			const raid = gameState.ai.town.attacks.getAttackInPreparation(AttackPlan.TYPE_RAID);
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
		if (!findTarget(this, gameState) || !this.target)
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
			return rallyOverseas(this, gameState, rallyDiff, targetIndex);
		}
		return true;
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

		const targets = targetCandidates(this, gameState, targetPlayer, land);
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
			gameState.ai.town.guard.planRelicRaid(target.id(), this.name);
		}
		// Rushes can change their enemy target if nothing found with the preferred enemy
		// Obstruction also can change the enemy target
		this.targetPlayer = target.owner();
		return target;
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
			else if (i > 1 && gameState.ai.town.isDangerousLocation(gameState, path[i - 1], 20))
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
		leaveDisputedLands(this, gameState, targetLand(this, gameState));

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
			return walkTo(this, gameState, { target, pos: targetPos });
		}
		return this.sailTo(gameState, rallyAccess, targetAccess, targetPos);
	}

	/** The plan's units are shipped to the target's land; false without a sea there */
	private sailTo(
		gameState: CommonGameState,
		rallyAccess: AccessIndex,
		targetAccess: AccessIndex,
		targetPos: CommonPosition,
	): boolean
	{
		const sea = gameState.ai.town.getSeaBetweenIndices(gameState, rallyAccess, targetAccess);
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
			gameState.ai.town.transports.requireTransport(gameState, ent, rallyAccess, targetAccess, targetPos);
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
		releaseGarrisoned(this, gameState);
		if (!this.unitCollection.hasEntities())
		{
			return 0;
		}

		this.position = this.unitCollection.getCentrePosition();

		// we are transporting our units, let's wait
		// TODO instead of state "arrived", made a state "walking" with a new path
		if (this.state === AttackPlan.STATE_TRANSPORTING)
		{
			UpdateTransporting(this, gameState, events);
		}

		if (!this.position)
		{
			return this.unitCollection.length;
		}

		const stage = this.stage;
		if (stage.state === AttackPlan.STATE_WALKING && !UpdateWalking(this, gameState, events, stage.path))
		{
			return 0;
		}

		if (this.state === AttackPlan.STATE_ARRIVED)
		{
			startAttacking(this, gameState, this.position);
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
		this.march.lastPosition = clone(this.position);
		return this.unitCollection.length;
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
			followUnitTarget(this, gameState, this.target);
		}
		// Then update the target if needed:
		if (this.targetPlayer === undefined || !gameState.isPlayerEnemy(this.targetPlayer))
		{
			this.targetPlayer = gameState.ai.town.attacks.getEnemyPlayer(gameState, this);
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
			if (!switchTarget(this, gameState, pos))
			{
				return undefined;
			}
		}
		return this.aim();
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
				withdrawPoint(this, gameState, pos) :
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
				onTargetRenamed(this, gameState, evt.newentity);
			}
		}

		onTargetLost(this, gameState, events);

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
				rallyAtBaseOn(this, gameState, getLandAccess(gameState, ent));
			}
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
			maxCompletingTime: this.preparation()?.maxCompletingTime ?? seconds(0),
			neededShips: this.neededShips,
			unitStat: this.unitStat,
			siegeState: this.preparation()?.siegeState ?? AttackPlan.SIEGE_NOT_TESTED,
			position5TurnsAgo: this.march.position5TurnsAgo,
			lastPosition: this.march.lastPosition,
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
