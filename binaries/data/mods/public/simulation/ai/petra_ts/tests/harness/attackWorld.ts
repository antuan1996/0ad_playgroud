/**
 * The fake world the military managers (attackPlan, attackManager, …) run in.
 *
 * Collections, filters and queues are the game's own code (common-api and
 * Petra's QueueManager); the entities, structures, templates and every knob
 * the managers ask about come from here, declared per test. An entity answers
 * exactly what its test declared over neutral defaults, and anything else
 * raises with the missing method's name, so a test cannot pass because a call
 * quietly returned undefined.
 */
import { commands } from "./engine.ts";
import { loadCommonModule, loadPetraModule } from "./target.ts";

/** Method overrides a test supplies on top of the neutral entity defaults. */
export type Methods = Record<string, (...args: any[]) => unknown>;

export interface FakeEnt
{
	id(): number;
	owner(): number;
	position(): [number, number] | undefined;
	templateName(): string;
	hasClass(cls: string): boolean;
	hasClasses(list: string[]): boolean | undefined;
	foundationProgress(): number | undefined;
	/** Swappable entity commands (the tests record calls on them). */
	attack(target: unknown, capture?: unknown): unknown;
	attackMove(x: unknown, z: unknown, classes?: unknown, capture?: unknown): unknown;
	moveToRange(x: unknown, z: unknown, min?: unknown, max?: unknown, queued?: boolean): unknown;
	setStance(stance: string): unknown;
	getStance(): string;
	isIdle(): boolean;
	isPackable(): boolean;
	/** the trainer list a structure offers, when the test overrides it */
	trainableEntities?: (civ: string) => string[] | undefined;
	/** the live training bills a facility carries; a structure outside one answers falsy */
	trainingQueue?(player: number): unknown[] | undefined | false;
	getMetadata(player: number, key: string): unknown;
	setMetadata(player: number, key: string, value: unknown): void;
	/** the metadata store, for assertions */
	metadata: Record<string, unknown>;
	/** overridable engine reads the army and worker code asks entities */
	unitAIOrderData?(): Array<{ target?: number; attackType?: string }>;
	canAttackTarget?(target: FakeEnt, capture?: boolean): boolean;
	canCapture?(target: FakeEnt): boolean;
	capturePoints?(): number[] | undefined;
	getDefaultArrow?(): number | undefined;
	hasDefensiveFire?(): boolean;
	/** whether the entity accepts a resource — with none named, any-resource */
	isResourceDropsite?(resource?: string): boolean;
	healthLevel?(): number;
	resourceCarrying?(): Array<{ type: string; amount: number }> | undefined;
	returnResources?(gameState: CommonGameState, queued?: boolean): boolean;
	stopMoving?(): void;
}

/** What a fake plan object looks like inside a queue. */
export interface FakePlanLike
{
	type: string;
	category: string;
	number: number;
	metadata: Record<string, unknown> | undefined;
	/** QueuePlan books 0 when no position was given; ConstructionPlan a couple */
	position?: [number, number] | number | undefined;
	template: FakeTemplateLike;
}

/** The part of a Queue the plan touches; the queues themselves are real. */
export interface QueueLike
{
	plans: FakePlanLike[];
	empty(): void;
	addPlan(plan: FakePlanLike | null | undefined): void;
	length(): number;
	countQueuedUnitsWithMetadata(key: string, value: unknown): number;
}

export interface ResourcesAccount
{
	Serialize(): Record<string, number>;
}

export interface QueueManagerLike
{
	queues: Record<string, QueueLike>;
	priorities: Record<string, number>;
	accounts: Record<string, ResourcesAccount>;
	addQueue(queueName: string, priority: number): void;
	removeQueue(queueName: string): void;
	/** Config.getPriority's answer for a queue. */
	getPriority(queueName: string): number;
}

/** The part of the real EntityCollection the tests rely on. */
export interface FakeCollection
{
	readonly length: number;
	hasEntities(): boolean;
	values(): IterableIterator<FakeEnt>;
	filter(filter: unknown, thisp?: unknown): FakeCollection;
	filterNearest(targetPos: [number, number], n: number): FakeCollection;
	/** drops an entity from the collection, as the game does when it leaves the world */
	removeEnt(ent: FakeEnt): boolean;
	toEntityArray(): FakeEnt[];
	toIdArray(): number[];
	addEnt(ent: FakeEnt): boolean;
	hasEntId(id: number): boolean;
	updateEnt(ent: FakeEnt, force?: boolean): boolean;
	registerUpdates(): void;
	unregister(): void;
	getCentrePosition(): [number, number] | undefined;
	forEach(fn: (ent: FakeEnt) => void): void;
	moveToRange(x: number, y: number, min: number, max: number): void;
	moveIndiv(x: number, y: number): void;
}

export interface FakeTemplateLike
{
	cost(trainer?: FakeEnt): Record<string, number>;
	costSum(productionQueue?: FakeEnt): number;
	get(path: string): unknown;
	hasClasses(list: string[]): boolean | undefined;
	hasClass(cls: string): boolean;
	classes(): string[];
	available(gameState: CommonGameState): boolean;
	walkSpeed(): number | undefined;
	trainingCategory(): string | undefined;
	matchLimit(): number | undefined;
	resourceGatherRates(): Record<string, number> | undefined;
	attackTypes(): string[] | undefined;
	attackStrengths(type: string): Record<string, number> | undefined;
	attackRange(type: string): { max: number; min: number } | undefined;
	attackTimes(type: string): { prepare: number; repeat: number } | undefined;
	resistanceStrengths(): Record<string, number> | undefined;
	maxHitpoints(): number;
	/** the EntityLimits category, from BuildRestrictions/Category; unit templates carry no block */
	buildCategory?(): string | undefined;
	/** the raw BuildRestrictions/Territory list, undefined with no BuildRestrictions block */
	buildTerritories?(): string[] | undefined;
}

export interface UnitStatLike
{
	priority: number;
	minSize: number;
	targetSize: number;
	batchSize: number;
	classes: string[];
	interests?: unknown;
}

export interface ConfigLike
{
	debug: number;
	difficulty: number;
	popScaling: number;
	personality: { aggressive: number; defensive: number; military: number; cooperative?: number };
	personalityCut?: { weak: number; medium: number; strong: number };
	/** how much each damage type counts towards attack strength; the real config values */
	DamageTypeImportance: Record<string, number>;
	/** Petra's defense knobs, as config.ts sets them */
	Defense: { defenseRatio: Record<string, number>; armyCompactSize: number; armyBreakawaySize: number; armyMergeSize: number };
	/** config.garrisonHealthLevel */
	garrisonHealthLevel: Record<string, number>;
	/** chat announcements; the attack manager asks but the managers' tests mostly do not */
	chat?: boolean;
	priorities: Record<string, number>;
}

/** A base as Petra sees it: an anchor structure and the land it sits on. */
export interface BaseLike
{
	/** the base's roster id, what getBaseByID looks for */
	ID?: number;
	anchor: FakeEnt | null;
	accessIndex: number | undefined;
}

/** The defense army surface switchDefenseToAttack walks. */
export interface DefenseArmyLike
{
	ID: number;
	foeEntities: number[];
	ownEntities: number[];
	foePosition: [number, number];
	recalculatePosition(gameState: CommonGameState): void;
	removeFoe(gameState: CommonGameState, entId: number, enemyEntity?: CommonEntity): void;
	removeOwn(gameState: CommonGameState, entId: number): void;
	clear?(gameState: CommonGameState): void;
}

/** The HQ surface the managers touch; every knob starts neutral. */
export interface HQLike
{
	/**
	 * The real HQ keeps its maps and regions in `geography` (world/geography.ts)
	 * with accessors of the old names; the stub is its own geography, so a test
	 * that sets `HQ.navalMap` or `HQ.territoryMap` sets what the port reads.
	 */
	readonly geography: HQLike;
	baseManagers(): BaseLike[];
	navalMap: boolean;
	canBuildUnits: boolean;
	hasPotentialBase(): boolean;
	getSeaBetweenIndices(gameState: CommonGameState, from: number, to: number): number | undefined;
	navalManager: {
		seaTransportShips: Record<number, FakeEnt[]>;
		setMinimalTransportShips(gameState: CommonGameState, sea: number, needed: number): void;
		requireTransport(gameState: CommonGameState, ent: FakeEnt, from: number, to: number, toPos: [number, number] | undefined): void;
		/** the transport plan of a given number; undefined means the plan is gone */
		getPlan(planName: number): { state: string; removeUnit(gameState: CommonGameState, ent: FakeEnt): void } | undefined;
	};
	attackManager: {
		upcomingAttacks: Record<string, unknown[]>;
		startedAttacks: Record<string, unknown[]>;
		defeated: Record<number, boolean>;
		bombingAttacks: Map<string, Set<number>>;
		outOfPlan: Map<number, FakeEnt>;
		getEnemyPlayer(gameState: CommonGameState, plan: unknown): number | undefined;
		getAttackInPreparation(type: string): unknown | undefined;
		/** the plan of a given number; undefined means there is none */
		getPlan(planName: number): { state: number; removeUnit(ent: FakeEnt, removed: boolean): void } | undefined;
		/** attackUnit interception when defense armies roll into an attack */
		switchDefenseToAttack(gameState: CommonGameState, target: CommonEntity, data?: {
			range?: number; armyID?: number; uniqueTarget?: boolean;
		}): boolean;
	};
	defenseManager: {
		targetList: number[];
		armies: DefenseArmyLike[];
		/** whether a wounded unit has a safe structure to garrison into */
		garrisonAttackedUnit(gameState: CommonGameState, ent: FakeEnt): boolean;
		/** the decaying-structure refill call, as garrisonManager.update requests it */
		garrisonUnitsInside(gameState: CommonGameState, target: FakeEnt, data: Record<string, unknown>): void;
	};
	victoryManager: {
		criticalEnts: Map<number, unknown>;
		targetedGaiaRelics: Map<number, number[]>;
		isRelicRaided(relicId: number): boolean;
		planRelicRaid(relicId: number, plan: number): void;
		tryCaptureGaiaRelic: boolean;
		resetCaptureGaiaRelic(gameState: CommonGameState): void;
	};
	territoryMap: {
		getOwner(pos: [number, number]): number;
		/** whether the tile's ownership is contested (map-border / decay flicker) */
		isBlinking(pos: [number, number]): boolean;
	};
	isDangerousLocation(gameState: CommonGameState, pos: [number, number], minDist: number): boolean;
	findBestTrainableUnit(gameState: CommonGameState, classes: string[], interests: unknown): string | undefined;
	capturableTargets: Map<number, unknown>;
	/** the base of a given roster id */
	getBaseByID(id: number): BaseLike | undefined;
	/** whether the base's forces are worth defending */
	isDefendable(ent: CommonEntity): boolean;
	/** whether some base is running; the capture-recovery and gaia scans need one */
	hasActiveBase(): boolean;
	/** HQ trains emergency garrison infantry for these army positions */
	trainEmergencyUnits(gameState: CommonGameState, positions: [number, number][]): void;
	garrisonManager: {
		garrison(gameState: CommonGameState, unit: FakeEnt, target: FakeEnt, type: string): void;
		numberOfGarrisonedSlots(target: FakeEnt): number;
		/** undefined means the garrison manager has no stored decision */
		allowMelee(target: FakeEnt): boolean | undefined;
	};
}

/** The world builder's knobs, each starting with its most common answer. */
export interface WorldOptions
{
	/** what getEnemyPlayer returns; undefined means "no enemy left". */
	enemyPlayer?: number | undefined;
	/** getAccessValue's answer for positions not named in accessAt. */
	accessibilityFallback?: number;
	/** HQ.getSeaBetweenIndices' answer. */
	sea?: number | undefined;
	/** HQ.navalMap. */
	navalMap?: boolean;
	/** HQ.canBuildUnits. */
	canBuildUnits?: boolean;
	/** Config.debug. */
	debug?: number;
	/** Config.DIFFICULTY_LEVEL used by addSiegeUnits' shrink logic. */
	difficulty?: number;
	/** getVictoryConditions' set. */
	victoryConditions?: string[];
	/** territoryMap.getOwner's answer, keyed "x,y". */
	territory?: Map<string, number>;
	/** territoryMap.isBlinking's answer, keyed "x,y". */
	blinking?: Map<string, boolean>;
	/** countOwnQueuedEntitiesWithMetadata's answer. */
	queuedInTraining?: number;
	/** Config.personality.defensive, for the worker assignment formula. */
	defensive?: number;
	/** Config.popScaling. */
	popScaling?: number;
	/** gameState.getPopulation/getPopulationMax. */
	population?: number;
	populationMax?: number;
	/** gameState.currentPhase's answer. */
	phase?: number;
	/** gameState.getPhaseName(2)'s answer; undefined means no phase-two tech. */
	phaseName?: string;
	/** names gameState.isResearching answers true for. */
	researching?: string[];
	/** HQ.hasPotentialBase's answer. */
	hasPotentialBase?: boolean;
}

/**
 * The world the managers see. Collections, filters and queues are real; owning
 * the lists makes each test's army explicit. It spawns one default base (an
 * anchor at [10,10] on land 2) and, per test, whatever entities it wants
 * through `addEntity`.
 */
export interface World
{
	gameState: CommonGameState;
	ai: {
		playedTurn: number;
		elapsedTime: number;
		uniqueIDs: { plans: number; bases: number; armies: number };
		queues: Record<string, QueueLike>;
		queueManager: QueueManagerLike;
		Config: ConfigLike;
		HQ: HQLike;
		accessibility: {
			getAccessValue(pos: [number, number], sea?: boolean): number;
			regionSize: Record<number, number>;
		};
	};
	/** registers an entity so the world classifies and serves it */
	addEntity(ent: FakeEnt): FakeEnt;
	/** forgets an entity again, in every list it was registered in */
	removeEntity(id: number): void;
	units: FakeEnt[];
	structures: FakeEnt[];
	/** every registered entity, keyed id — the world of getEntityById */
	ents: Map<number, FakeEnt>;
	/** the templates getTemplate answers with; tests add theirs */
	templates: Record<string, FakeTemplateLike>;
	bases: BaseLike[];
	/** the world's mutable knobs, as described in WorldOptions */
	knobs: {
		accessibilityFallback: number;
		queuedInTraining: number;
		sea: number | undefined;
		enemyPlayer: number | undefined;
		navalMap: boolean;
		canBuildUnits: boolean;
		bestTrainable: string | undefined;
		phase: number;
		phaseName: string | undefined;
		researching: string[];
		hasPotentialBase: boolean;
	};
	/** the downtime positions getAccessValue names, keyed "x,y" */
	accessAt: Map<string, number>;
	/** the answers territoryMap.getOwner gives, keyed "x,y" */
	territory: Map<string, number>;
	/** the answers territoryMap.isBlinking gives, keyed "x,y" */
	blinking: Map<string, boolean>;
	/** garrison calls the garrisonManager saw, as [unit, target, type] */
	garrisonCalls: Array<[FakeEnt, FakeEnt, string]>;
	/** garrisoned slot counts the garrisonManager keeps, keyed target id */
	garrisonCounts: Map<number, number>;
	/** defenseManager.garrisonUnitsInside refill calls the garrison-decay loop made */
	decayGarrisonCalls: Array<[FakeEnt, Record<string, unknown>]>;
	/** trainEmergencyUnits calls, as the army positions asked for */
	emergencyCalls: Array<[CommonGameState, [number, number][]]>;
	/** switchDefenseToAttack calls, as [target, data] */
	switchCalls: Array<[FakeEnt | undefined, Record<string, unknown> | undefined]>;
	/** transport calls the navalManager saw, as [ent, from, to, toPos] */
	transportCalls: Array<[FakeEnt, number, number, [number, number] | undefined]>;
	/** setMinimalTransportShips calls, as [sea, needed] */
	minimalShipCalls: Array<[number, number]>;
	/** resetCaptureGaiaRelic calls the victoryManager saw */
	relicResets: unknown[];
	/** the collections the plan asked the sharedScript to keep updated */
	collections: {
		registered: FakeCollection[];
	};
}

export const PLAYER = 1;
export const ENEMY = 2;
export const GAIA = 0;

/** Engine builtins and globals a test stubs, kept for restoreEngine after it. */
let engineStubs: Map<string, unknown> | undefined;
let globalStubs: Map<string, unknown> | undefined;

const engineBag = globalThis as unknown as { Engine: Record<string, unknown> };

/** Swap an Engine builtin for the test; pair with restoreEngine. */
export function stubEngine(name: string, value: unknown): void
{
	engineStubs ??= new Map();
	if (!engineStubs.has(name))
		engineStubs.set(name, engineBag.Engine[name]);
	engineBag.Engine[name] = value;
}

/** Swap any global (e.g. randBool) for the test; pair with restoreEngine. */
export function stubGlobal(name: string, value: unknown): void
{
	globalStubs ??= new Map();
	if (!globalStubs.has(name))
		globalStubs.set(name, (globalThis as Record<string, unknown>)[name]);
	(globalThis as Record<string, unknown>)[name] = value;
}

/** The recorded engine commands, in a form the tests can index. */
export function commandList(): Record<string, unknown>[]
{
	return commands.map((cmd) => cmd as Record<string, unknown>);
}

/** Put back every builtin a test has stubbed. */
export function restoreEngine(): void
{
	if (engineStubs)
	{
		for (const [name, value] of engineStubs)
			engineBag.Engine[name] = value;
	}
	if (globalStubs)
	{
		for (const [name, value] of globalStubs)
			(globalThis as Record<string, unknown>)[name] = value;
	}
	engineStubs = undefined;
	globalStubs = undefined;
}

/** Let Engine.ComputePath answer with the given waypoints for the test. */
export function withPath(path: Array<{ "x": number; "y": number }> | null, body: () => void): void
{
	stubEngine("ComputePath", () => path);
	try
	{
		body();
	}
	finally
	{
		restoreEngine();
	}
}

/** Fill out an EngineAIEvents skeleton with only the buckets a test names. */
export function emptyEvents(): EngineAIEvents
{
	return {
		"Create": [], "Destroy": [], "Attacked": [], "ConstructionFinished": [], "DiplomacyChanged": [],
		"TrainingStarted": [], "TrainingFinished": [], "AIMetadata": [], "PlayerDefeated": [],
		"AttackRequest": [], "EntityRenamed": [], "ValueModification": [], "OwnershipChanged": [], "UntrustingEvents": [],
		"Garrison": [], "UnGarrison": []
	} as unknown as EngineAIEvents;
}

/**
 * An entity saying exactly what its test declared, over the neutral defaults.
 * Anything else raises, naming the method, so a test cannot pass because a
 * missing answer quietly returned undefined. Method answers go in `methods`;
 * a test that wants to see a call turns the method into its own recorder.
 */
export function makeEntity(spec: {
	id: number;
	owner: number;
	position?: [number, number] | undefined;
	classes?: string[];
	templateName?: string;
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): FakeEnt
{
	const classes = [...(spec.classes ?? [])];
	const store = { metadata };

	const defaults: Methods = {
		id: () => spec.id,
		owner: () => spec.owner,
		position: () => spec.position ? [...spec.position] : undefined,
		templateName: () => spec.templateName ?? "unit/falsebow",
		genericName: () => "tested",
		hasClass: (cls: string) => classes.includes(cls),
		hasClasses: (list: string[]) => MatchesClassList(classes, list),
		getMetadata: (_player: number, key: string) => store.metadata[key],
		setMetadata: (_player: number, key: string, value: unknown) => {
			// Petra clears roles by writing undefined; drop the key so
			// "no metadata" answers stay truthful.
			if (value === undefined)
				delete store.metadata[key];
			else
				store.metadata[key] = value;
		},
		// Neutral answers for the questions every entity in Petra hears.
		angle: () => 0,
		trainableEntities: () => undefined,
		buildPlacementType: () => undefined,
		get: () => undefined,
		unitAIState: () => undefined,
		unitAIOrderData: () => [],
		isIdle: () => false,
		isPackable: () => false,
		getStance: () => "aggressive",
		setStance: () => undefined,
		isCapturable: () => false,
		// needsRepair composes isHurt() && isRepairable(); the default fake
		// stands at full hitpoints, so a built building reads never hurt
		needsRepair: () => false,
		isInvulnerable: () => false,
		isGarrisonHolder: () => false,
		isFull: () => false,
		isSharedDropsite: () => false,
		hasDefensiveFire: () => false,
		decaying: () => false,
		getDefaultArrow: () => undefined,
		garrisoned: () => [],
		garrisonedSlots: () => 0,
		garrisonMax: () => 0,
		healthLevel: () => 1,
		hitpoints: () => 100,
		maxHitpoints: () => 100,
		foundationProgress: () => undefined,
		resourceCarrying: () => undefined,
		obstructionRadius: () => ({ "max": 2 }),
		captureStrength: () => 0,
		capturePoints: () => undefined,
		canCapture: () => false,
		canAttackTarget: () => false,
		canAttackClass: () => false,
		counters: () => false,
		// the builder list lives on the template: no Builder tag, nothing buildable
		buildableEntities: () => [],
		isGatherer: () => false,
		// dropsites carry a template tag; a plain entity drops nowhere
		resourceDropsiteTypes: () => undefined,
		isResourceDropsite: () => false,
		// a plain entity supplies no resource (the tag lives on gaia resources)
		resourceSupplyType: () => undefined,
		resourceSupplyMax: () => 0,
		resourceSupplyAmount: () => 0,
		garrisonRegenRate: () => 0,
		defaultRegenRate: () => 0,
		territoryDecayRate: () => 0,
		// engine entities always expose a resistance structure (possibly empty)
		resistanceStrengths: () => ({}),
		attackTypes: () => undefined,
		attackStrengths: () => undefined,
		attackRange: () => ({ "max": 0 }),
		attackTimes: () => undefined,
		costSum: () => 500,
		trainingQueue: () => false,
		maxGatherers: () => 0,
		getMultiplierAgainst: () => undefined,
		// Actions and effects: silent unless a test overrides them.
		stopMoving: () => undefined,
		moveToRange: () => undefined,
		move: () => undefined,
		attack: () => undefined,
		attackMove: () => undefined,
		destroy: () => undefined,
		garrison: () => undefined,
		gather: () => undefined,
		// garrison-holder surface, as the common engine defaults
		getArrowMultiplier: () => 0,
		buffHeal: () => undefined,
		garrisonEjectHealth: () => 0.7,
		getGarrisonArrowClasses: () => ["Infantry"],
		garrisonableClasses: () => ["Infantry"],
		unload: () => undefined,
		returnResources: () => undefined,
		repair: () => undefined,
		setRallyPoint: () => undefined,
		// a live answer so guard code stays on the game path; a test that wants
		// a non-attacker overrides it together with attackTypes
		hasUnitAI: () => true,
		...methods
	};

	return new Proxy(store, {
		get(target, property)
		{
			if (typeof property === "symbol")
				return Reflect.get(target, property);
			if (String(property) in target)
				return (target as Record<string, unknown>)[String(property)];
			const value = defaults[String(property)];
			if (value === undefined && !(String(property) in defaults))
				throw new Error(`fake entity ${spec.id} has no "${String(property)}" — declare it in the test`);
			return value;
		},
		set(target, property, value)
		{
			if (typeof property !== "symbol")
				defaults[String(property)] = value;
			return true;
		}
	}) as unknown as FakeEnt;
}

/**
 * A template as the game hands it back from `getTemplate`. Declares its own
 * classes and cost, and answers `get(path)` by walking declared paths the way
 * a real template walks its JSON.
 */
export function makeTemplate(name: string, detail: {
	classes?: string[];
	cost?: Record<string, number>;
	popCost?: number;
	getPaths?: Record<string, unknown>;
	available?: boolean;
	/** the walk speed; every unit carries template_unit's WalkSpeed, structures none */
	walkSpeed?: number;
	/** the TrainingRestrictions category; only unit templates carry it */
	trainingCategory?: string | undefined;
	/** the template match limit, from LimitMatcher; default uncapped */
	matchLimit?: number | undefined;
	/** the gather rates, as template_unit's Rates list gives them */
	resourceGatherRates?: Record<string, number>;
	/** the attack types the Identity/Attack block lists (units carry Slaughter too) */
	attackTypes?: string[];
	/** the Damage dictionaries, keyed by attack type, as Attack/<type>/Damage reads */
	attackStrengths?: Record<string, Record<string, number>>;
	/** the ranges, as Attack/<type>/MaxRange and MinRange read */
	attackRanges?: Record<string, { max: number; min?: number }>;
	/** the timing, as Attack/<type>/PrepareTime and RepeatTime read */
	attackTimes?: Record<string, { prepare?: number; repeat?: number }>;
	/** the resistance Damage dictionary, as Resistance/Entity/Damage reads */
	resistanceStrengths?: Record<string, number>;
	/** the Health/Max; template_unit gives 100, infantry 80, ranged 50 */
	maxHitpoints?: number;
	/** the gatherers a supply feeds, as ResourceSupply/MaxGatherers reads; default 0 */
	maxGatherers?: number;
} = {}): FakeTemplateLike
{
	const cost = detail.cost ?? {};
	const classes = [...(detail.classes ?? [])];
	const getPaths = detail.getPaths ? { ...detail.getPaths } : {};
	const available = detail.available ?? true;
	const gatherRates = detail.resourceGatherRates ? { ...detail.resourceGatherRates } : undefined;
	// the template walk the `get` method below reads leaves from
	const getTemplateValue = (path: string): unknown =>
	{
		let value: unknown = getPaths;
		for (const part of path.split("/"))
		{
			value = (value as Record<string, unknown> | undefined)?.[part];
			if (value == undefined)
				break;
		}
		return value as unknown;
	};
	return {
		// the raw serialized template, as the original reads it
		"_template": { "Cost": { "Population": detail.popCost ?? 1 } },
		cost: () => ({ ...cost }),
		costSum: () => Object.values(cost).reduce((sum: number, amount: number) => sum + amount, 0),
		get: (path: string) => getTemplateValue(path),
		hasClass: (cls: string) => classes.includes(cls),
		hasClasses: (list: string[]) => MatchesClassList(classes, list),
		classes: () => classes,
		available: () => available,
		walkSpeed: () => detail.walkSpeed,
		trainingCategory: () => detail.trainingCategory,
		matchLimit: () => detail.matchLimit,
		// as common-api template.resourceGatherRates reads Rates/<rate>/Payload
		resourceGatherRates: () => gatherRates ? { ...gatherRates } : undefined,
		// as common-api template.attackTypes reads the Attack block's keys
		attackTypes: () => detail.attackTypes ? [...detail.attackTypes] : undefined,
		// as common-api template.attackStrengths reads Attack/<type>/Damage
		attackStrengths: (type: string) =>
			detail.attackStrengths?.[type] ? { ...detail.attackStrengths[type] } : undefined,
		// as common-api template.attackRange reads Attack/<type>/MaxRange, MinRange
		attackRange: (type: string) =>
			detail.attackRanges?.[type] ?
				{ "max": detail.attackRanges[type].max, "min": detail.attackRanges[type].min ?? 0 } :
				undefined,
		// as common-api template.attackTimes reads PrepareTime and RepeatTime
		attackTimes: (type: string) =>
			detail.attackTimes?.[type] ?
				{ "prepare": detail.attackTimes[type].prepare ?? 0,
					"repeat": detail.attackTimes[type].repeat ?? 1000 } :
				undefined,
		// as common-api template.resistanceStrengths reads Resistance/Entity: the
		// damage resistances under its Damage key
		resistanceStrengths: () => detail.resistanceStrengths ? { "Damage": { ...detail.resistanceStrengths } } : undefined,
		maxHitpoints: () => detail.maxHitpoints ?? 100,
		maxGatherers: () => detail.maxGatherers ?? 0,
		// as the common-api Template.buildCategory (entity.js 479) reads
		// BuildRestrictions/Category, the EntityLimits counter that template
		// decrements when raised; unit templates carry no BuildRestrictions
		buildCategory: () =>
			getTemplateValue("BuildRestrictions/Category") as string | undefined,
		// as the common-api Template.buildTerritories (entity.js 493) reads
		// BuildRestrictions: undefined when the template carries no
		// BuildRestrictions block at all (unit templates never do; structure
		// templates inherit template_structure.xml's), the Territory leaf
		// split on whitespace otherwise. canBuild's no-active-base branch and
		// isNotWorthBuilding both test this answer's shape, so it stays the
		// raw list — hasBuildTerritory is the masked membership view of it.
		buildTerritories: (): string[] | undefined =>
		{
			if (getTemplateValue("BuildRestrictions") === undefined)
				return undefined;
			const territory = getTemplateValue("BuildRestrictions/Territory");
			return territory === undefined ? undefined : String(territory).split(/\s+/);
		}
	} as unknown as FakeTemplateLike;
}

const { QueueManager } = await loadPetraModule<{
	QueueManager: new (
		Config: ConfigLike,
		queues: Record<string, QueueLike>
	) => QueueManagerLike;
}>("queueManager");

const EntityCollection = (await loadCommonModule<{
	EntityCollection: new (sharedAI: CommonSharedScript, entities?: Map<number, FakeEnt>, filters?: unknown[]) => FakeCollection;
}>("entitycollection")).EntityCollection;

const { byClass } = await loadCommonModule<{ byClass: (cls: string) => unknown }>("filters");

/** Build the Map a real EntityCollection expects. */
export function mapOf(items: FakeEnt[]): Map<number, FakeEnt>
{
	const map = new Map<number, FakeEnt>();
	for (const ent of items)
		map.set(ent.id(), ent);
	return map;
}

/** Build a world: one base, no enemies, and knobs at their neutral answers. */
export function makeWorld(options: WorldOptions = {}): World
{
	const accessAt = new Map<string, number>();
	const knobs = {
		accessibilityFallback: options.accessibilityFallback ?? 2,
		queuedInTraining: options.queuedInTraining ?? 0,
		sea: options.sea,
		enemyPlayer: options.enemyPlayer as number | undefined,
		navalMap: options.navalMap ?? false,
		canBuildUnits: options.canBuildUnits ?? true,
		bestTrainable: undefined as string | undefined,
		phase: options.phase ?? 1,
		phaseName: options.phaseName,
		researching: [...(options.researching ?? [])],
		hasPotentialBase: options.hasPotentialBase ?? true
	};
	const territory = options.territory ?? new Map<string, number>();
	const blinking = options.blinking ?? new Map<string, boolean>();
	const buddies = options.victoryConditions ?? [];

	const transportCalls: World["transportCalls"] = [];
	const minimalShipCalls: World["minimalShipCalls"] = [];
	const relicResets: unknown[] = [];
	const targetedGaiaRelics = new Map<number, number[]>();
	const garrisonCalls: Array<[FakeEnt, FakeEnt, string]> = [];
	const garrisonCounts = new Map<number, number>();
	const emergencyCalls: Array<[CommonGameState, [number, number][]]> = [];
	const switchCalls: Array<[FakeEnt | undefined, Record<string, unknown> | undefined]> = [];
	const decayGarrisonCalls: Array<[FakeEnt, Record<string, unknown>]> = [];
	const units: FakeEnt[] = [];
	const structures: FakeEnt[] = [];
	const ents = new Map<number, FakeEnt>();
	const bases: BaseLike[] = [];
	const templates: Record<string, FakeTemplateLike> = {};

	function accessOf(pos: [number, number]): number
	{
		const key = `${Math.round(pos[0])},${Math.round(pos[1])}`;
		return accessAt.get(key) ?? knobs.accessibilityFallback;
	}

	const collections = { registered: [] as FakeCollection[] };
	const sharedAI: Record<string, unknown> = {
		registerUpdatingEntityCollection: (collection: FakeCollection) => collections.registered.push(collection),
		removeUpdatingEntityCollection: (collection: FakeCollection) => {
			const index = collections.registered.indexOf(collection);
			if (index !== -1)
				collections.registered.splice(index, 1);
		},
		// three players, so the plan's endgame counting loop leaves player 2
		// (the enemy) and skips our own player 1. Each row carries the per-player
		// diplomacy the engine fills (PlayerManager): a player is always its own
		// ally, nobody else by default.
		playersData: [
			{ "state": "active", "isAlly": [true, false, false, false] },
			{ "state": "active", "isAlly": [false, true, false, false] },
			{ "state": "active", "isAlly": [false, false, true, false] }
		]
	};

	const structuresOf = (owner?: number) =>
		new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(structures.filter((s) => owner === undefined || s.owner() === owner)));
	const unitsOf = (owner?: number) =>
		new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(units.filter((u) => owner === undefined ? u.owner() !== PLAYER : u.owner() === owner)));

	const world: World = {
		gameState: undefined as unknown as CommonGameState,
		ents,
		units,
		structures,
		bases,
		templates,
		knobs,
		accessAt,
		territory,
		blinking,
		transportCalls,
		minimalShipCalls,
		relicResets,
		garrisonCalls,
		garrisonCounts,
		emergencyCalls,
		switchCalls,
		decayGarrisonCalls,
		collections,
		ai: {
			playedTurn: 0,
			elapsedTime: 100,
			uniqueIDs: { plans: 1, bases: 1, armies: 1 },
			queues: {},
			queueManager: undefined as unknown as QueueManagerLike,
			Config: {
				debug: options.debug ?? 0,
				difficulty: options.difficulty ?? 3,
				popScaling: options.popScaling ?? 1,
				personality: { aggressive: 1, defensive: options.defensive ?? 1, military: 1, cooperative: 0.5 },
				// the real config values: they weight the damage types and steer
				// army formation, so an army run against them behaves as in game
				DamageTypeImportance: { "Hack": 0.075, "Pierce": 0.085, "Crush": 0.045, "Fire": 0.001 },
				Defense: {
					defenseRatio: { "ally": 1.4, "neutral": 1.8, "own": 2 },
					armyCompactSize: 2000,
					armyBreakawaySize: 3500,
					armyMergeSize: 1400
				},
				garrisonHealthLevel: { "low": 0.4, "medium": 0.55, "high": 0.7 },
				priorities: {}
			},
			accessibility: {
				getAccessValue: accessOf,
				regionSize: { 2: 100, 3: 400 }
			},
			HQ: undefined as unknown as HQLike
		},
		addEntity(ent: FakeEnt)
		{
			ents.set(ent.id(), ent);
			if (ent.hasClass("Unit"))
				units.push(ent);
			else
				structures.push(ent);
			return ent;
		},
		removeEntity(id: number)
		{
			// a destroyed entity leaves every entity collection that follows the world
			const gone = ents.get(id);
			if (gone)
				for (const collection of collections.registered)
					collection.removeEnt(gone);
			ents.delete(id);
			for (const list of [units, structures])
				for (let i = list.length - 1; i >= 0; --i)
					if (list[i].id() === id)
						list.splice(i, 1);
		}
	};

	const queues: Record<string, QueueLike> = {};
	world.ai.queueManager = new QueueManager(
		{ ...world.ai.Config, priorities: {} } as unknown as ConfigLike,
		queues as never
	) as unknown as QueueManagerLike;
	world.ai.queues = queues;

	const HQ: HQLike = {
		get geography(): HQLike { return HQ; },
		baseManagers: () => bases,
		navalMap: knobs.navalMap,
		canBuildUnits: knobs.canBuildUnits,
		hasPotentialBase: () => knobs.hasPotentialBase,
		getSeaBetweenIndices: () => knobs.sea,
		navalManager: {
			seaTransportShips: { 4: [] },
			setMinimalTransportShips: (_gs: CommonGameState, sea: number, needed: number) => minimalShipCalls.push([sea, needed]),
			requireTransport: (_gs: CommonGameState, ent: FakeEnt, from: number, to: number, toPos: [number, number] | undefined) =>
				transportCalls.push([ent, from, to, toPos]),
			getPlan: () => undefined
		},
		attackManager: {
			upcomingAttacks: { "Raid": [], "Rush": [], "Attack": [], "HugeAttack": [] },
			startedAttacks: { "Raid": [], "Rush": [], "Attack": [], "HugeAttack": [] },
			defeated: {},
			bombingAttacks: new Map<string, Set<number>>(),
			outOfPlan: new Map<number, FakeEnt>(),
			getEnemyPlayer: () => knobs.enemyPlayer,
			getAttackInPreparation: () => undefined,
			getPlan: () => undefined,
			switchDefenseToAttack: (_gs: CommonGameState, target: CommonEntity, data) =>
			{
				switchCalls.push([target as unknown as FakeEnt, data as Record<string, unknown> | undefined]);
				return true;
			}
		},
		defenseManager: {
			targetList: [],
			armies: [],
			garrisonAttackedUnit: () => false,
			// defenceManager's refill bookkeeping, recorded for the decay tests
			garrisonUnitsInside: (_gs: CommonGameState, target: FakeEnt, data: Record<string, unknown>) =>
			{
				decayGarrisonCalls.push([target, data]);
			}
		},
		garrisonManager: {
			// like the engine: garrisoning fills the target's slots
			garrison: (_gs: CommonGameState, unit: FakeEnt, target: FakeEnt, type: string) =>
			{
				garrisonCalls.push([unit, target, type]);
				garrisonCounts.set(target.id(), (garrisonCounts.get(target.id()) ?? 0) + 1);
			},
			numberOfGarrisonedSlots: (target: FakeEnt) => garrisonCounts.get(target.id()) ?? 0,
			allowMelee: () => undefined
		},
		victoryManager: {
			criticalEnts: new Map(),
			targetedGaiaRelics,
			isRelicRaided: (relicId: number) => targetedGaiaRelics.has(relicId),
			planRelicRaid: (relicId: number, plan: number) => { targetedGaiaRelics.set(relicId, [plan]); },
			tryCaptureGaiaRelic: false,
			resetCaptureGaiaRelic: (gs: CommonGameState) => relicResets.push(gs)
		},
		territoryMap: {
			getOwner: (pos: [number, number]) => territory.get(`${Math.round(pos[0])},${Math.round(pos[1])}`) ?? PLAYER,
			isBlinking: (pos: [number, number]) => blinking.get(`${Math.round(pos[0])},${Math.round(pos[1])}`) ?? false
		},
		isDangerousLocation: () => false,
		findBestTrainableUnit: () => knobs.bestTrainable,
		capturableTargets: new Map(),
		getBaseByID: (id: number) => bases.find((b) => b.ID === id),
		isDefendable: () => false,
		hasActiveBase: () => true,
		trainEmergencyUnits: (gs: CommonGameState, positions: [number, number][]) => emergencyCalls.push([gs, positions])
	};
	world.ai.HQ = HQ;

	// one base, anchoring a civil centre on land 2 — the world's rally point.
	const anchor = makeEntity({ id: 1000, owner: PLAYER, position: [10, 10], classes: ["Structure", "CivCentre"], templateName: "structures/athen_civil_centre" });
	world.addEntity(anchor);
	bases.push({ "ID": 1, anchor, accessIndex: 2 });

	const state: Record<string, unknown> = {
		ai: world.ai,
		sharedScript: sharedAI,
		playerData: {
			civ: "athen",
			hasSharedDropsites: false,
			// the engine diplomacy matrix: every player is its own and everyone's
			// gaia enemy; the player who reads this row is always their own ally
			isAlly: [false, true, false, false],
			isMutualAlly: [false, true, false, false],
			isEnemy: [true, false, true, true]
		},
		applyCiv: (name: string) => name.replace("{civ}", "athen"),
		getTemplate: (name: string) => templates[name] ?? null,
		isTemplateDisabled: () => false,
		getPlayerCiv: () => "athen",
		templates,
		getVictoryConditions: () => new Set(buddies),
		getPopulation: () => options.population ?? 0,
		getPopulationMax: () => options.populationMax ?? 400,
		// the facilities able to train a given template, as the real
		// GameState.findTrainers does: it runs over the training-facilities
		// collection (see below), so membership is a truthy trainingQueue
		findTrainers: (template: string) =>
			new EntityCollection(sharedAI as unknown as CommonSharedScript,
				mapOf(structures.filter((s) => (s.trainingQueue as (player: number) => unknown)(PLAYER) &&
					((s.trainableEntities as (civ: string) => string[] | undefined)("athen") ?? []).indexOf(template) !== -1))),
		getNumPlayerEnemies: () => knobs.enemyPlayer === undefined ? 0 : 1,
		getEntityById: (id: number | string) => ents.get(+id),
		getEntities: (owner?: number) => new EntityCollection(
			sharedAI as unknown as CommonSharedScript,
			mapOf([...ents.values()].filter((e) => owner === undefined || e.owner() === owner))),
		// as GameState.prototype.getOwnUnits/getOwnStructures, the collections
		// carry their class filter, so a later .filter() keeps it and updateEnt
		// never lets a structure into a units collection (or the reverse)
		getOwnUnits: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(units.filter((u) => u.owner() === PLAYER)), [byClass("Unit")]),
		getOwnEntities: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf([...units, ...structures.filter((s) => s.owner() === PLAYER)])),
		// as GameState.prototype.getEnemyStructures: with no owner, the
		// structures of every player the diplomacy row calls an enemy
		getEnemyStructures: (owner?: number) => owner !== undefined ? structuresOf(owner) :
			new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(structures.filter((s) =>
				(state.playerData as { isEnemy: boolean[] }).isEnemy[s.owner()]))),
		// every entity of a player the diplomacy row calls an enemy, as the
		// common-api byOwners(getEnemies()) does
		getEnemyEntities: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf([...ents.values()].filter((e) =>
				(state.playerData as { isEnemy: boolean[] }).isEnemy[e.owner()]))),
		getOwnStructures: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => s.owner() === PLAYER)), [byClass("Structure")]),
		getEnemyUnits: (owner?: number) => unitsOf(owner),
		getStructures: () => new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(structures)),
		getOwnEntitiesByRole: (role: string | undefined) =>
			new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(units.filter((u) => u.getMetadata(PLAYER, "role") == role))),
		getOwnEntitiesByClass: (cls: string) => new EntityCollection(
			sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => s.hasClass(cls)))),
		// as GameState.prototype.getOwnTrainingFacilities: facilities are the
		// own entities a truthy trainingQueue answers for (filters.byTrainingQueue),
		// not a class test
		getOwnTrainingFacilities: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => (s.trainingQueue as (player: number) => unknown)(PLAYER)))),
		countOwnQueuedEntitiesWithMetadata: () => knobs.queuedInTraining,
		updatingCollection: (_key: string, filter: { func: (ent: FakeEnt) => boolean }, collection: FakeCollection) =>
			collection.filter(filter),
		updatingGlobalCollection: (_key: string, filter: { func: (ent: FakeEnt) => boolean }) =>
			new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf([...ents.values()])).filter(filter),
		getOwnDropsites: () => new EntityCollection(sharedAI as unknown as CommonSharedScript),
		currentPhase: () => knobs.phase,
		isResearching: (name: string) => name !== undefined && knobs.researching.includes(name),
		getPhaseName: (phase: number) => phase === 2 ? options.phaseName : undefined,
		isPlayerEnemy: (id: number) => (state.playerData as { isEnemy: boolean[] }).isEnemy[id],
		isPlayerAlly: (id: number) => (state.playerData as { isAlly: boolean[] }).isAlly[id],
		isPlayerMutualAlly: (id: number) => (state.playerData as { isMutualAlly: boolean[] }).isMutualAlly[id],
		// the gameState entity affirmations, as common-api defines them
		isEntityOwn: (ent: FakeEnt) => ent.owner() === PLAYER,
		isEntityAlly: (ent: FakeEnt) => (state.playerData as { isAlly: boolean[] }).isAlly[ent.owner()],
		isEntityEnemy: (ent: FakeEnt) => (state.playerData as { isEnemy: boolean[] }).isEnemy[ent.owner()],
		isEntityExclusiveAlly: (ent: FakeEnt) =>
			(state.playerData as { isAlly: boolean[] }).isAlly[ent.owner()] && ent.owner() !== PLAYER,
		/** structures of everyone we and they consider an ally, as the game defines ally collections */
		getAllyStructures: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => (state.playerData as { isMutualAlly: boolean[] }).isMutualAlly[s.owner()]))),
		getPassabilityClassMask: () => 0
	};
	world.gameState = state as unknown as CommonGameState;
	return world;
}
