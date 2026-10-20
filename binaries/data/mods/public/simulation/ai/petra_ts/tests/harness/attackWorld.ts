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
	personality: { aggressive: number; defensive: number; military: number };
	personalityCut?: { weak: number; medium: number; strong: number };
	/** how much each damage type counts towards attack strength; the real config values */
	DamageTypeImportance: Record<string, number>;
	/** Petra's defense knobs, as config.ts sets them */
	Defense: { defenseRatio: Record<string, number>; armyCompactSize: number; armyBreakawaySize: number };
	/** config.garrisonHealthLevel */
	garrisonHealthLevel: Record<string, number>;
	/** chat announcements; the attack manager asks but the managers' tests mostly do not */
	chat?: boolean;
	priorities: Record<string, number>;
}

/** A base as Petra sees it: an anchor structure and the land it sits on. */
export interface BaseLike
{
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
	removeFoe(gameState: CommonGameState, entId: number): void;
	removeOwn(gameState: CommonGameState, entId: number): void;
	clear?(gameState: CommonGameState): void;
}

/** The HQ surface the managers touch; every knob starts neutral. */
export interface HQLike
{
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
	};
	defenseManager: {
		targetList: number[];
		armies: DefenseArmyLike[];
		/** whether a wounded unit has a safe structure to garrison into */
		garrisonAttackedUnit(gameState: CommonGameState, ent: FakeEnt): boolean;
	};
	victoryManager: {
		criticalEnts: Map<number, unknown>;
		targetedGaiaRelics: Map<number, number[]>;
		tryCaptureGaiaRelic: boolean;
		resetCaptureGaiaRelic(gameState: CommonGameState): void;
	};
	territoryMap: { getOwner(pos: [number, number]): number };
	isDangerousLocation(gameState: CommonGameState, pos: [number, number], minDist: number): boolean;
	findBestTrainableUnit(gameState: CommonGameState, classes: string[], interests: unknown): string | undefined;
	capturableTargets: Map<number, unknown>;
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
		isInvulnerable: () => false,
		isGarrisonHolder: () => false,
		isFull: () => false,
		isSharedDropsite: () => false,
		hasDefensiveFire: () => false,
		decaying: () => false,
		getDefaultArrow: () => undefined,
		garrisoned: () => [],
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
} = {}): FakeTemplateLike
{
	const cost = detail.cost ?? {};
	const classes = [...(detail.classes ?? [])];
	const getPaths = detail.getPaths ? { ...detail.getPaths } : {};
	const available = detail.available ?? true;
	return {
		// the raw serialized template, as the original reads it
		"_template": { "Cost": { "Population": detail.popCost ?? 1 } },
		cost: () => ({ ...cost }),
		costSum: () => Object.values(cost).reduce((sum: number, amount: number) => sum + amount, 0),
		get: (path: string) => {
			let value: any = getPaths;
			for (const part of path.split("/"))
			{
				value = value?.[part];
				if (value == undefined)
					break;
			}
			return value;
		},
		hasClass: (cls: string) => classes.includes(cls),
		hasClasses: (list: string[]) => MatchesClassList(classes, list),
		classes: () => classes,
		available: () => available
	} as unknown as FakeTemplateLike;
}

const { QueueManager } = await loadPetraModule<{
	QueueManager: new (
		Config: ConfigLike,
		queues: Record<string, QueueLike>
	) => QueueManagerLike;
}>("queueManager");

const EntityCollection = (await loadCommonModule<{
	EntityCollection: new (sharedAI: CommonSharedScript, entities?: Map<number, FakeEnt>) => FakeCollection;
}>("entitycollection")).EntityCollection;

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
	const buddies = options.victoryConditions ?? [];

	const transportCalls: World["transportCalls"] = [];
	const minimalShipCalls: World["minimalShipCalls"] = [];
	const relicResets: unknown[] = [];
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
		transportCalls,
		minimalShipCalls,
		relicResets,
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
				personality: { aggressive: 1, defensive: options.defensive ?? 1, military: 1 },
				// the real config values: they weight the damage types and steer
				// army formation, so an army run against them behaves as in game
				DamageTypeImportance: { "Hack": 0.075, "Pierce": 0.085, "Crush": 0.045, "Fire": 0.001 },
				Defense: {
					defenseRatio: { "ally": 1.4, "neutral": 1.8, "own": 2 },
					armyCompactSize: 2000,
					armyBreakawaySize: 3500
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
			getAttackInPreparation: () => undefined
		},
		defenseManager: {
			targetList: [],
			armies: [],
			garrisonAttackedUnit: () => false
		},
		victoryManager: {
			criticalEnts: new Map(),
			targetedGaiaRelics: new Map(),
			tryCaptureGaiaRelic: false,
			resetCaptureGaiaRelic: (gs: CommonGameState) => relicResets.push(gs)
		},
		territoryMap: { getOwner: (pos: [number, number]) => territory.get(`${Math.round(pos[0])},${Math.round(pos[1])}`) ?? PLAYER },
		isDangerousLocation: () => false,
		findBestTrainableUnit: () => knobs.bestTrainable,
		capturableTargets: new Map()
	};
	world.ai.HQ = HQ;

	// one base, anchoring a civil centre on land 2 — the world's rally point.
	const anchor = makeEntity({ id: 1000, owner: PLAYER, position: [10, 10], classes: ["Structure", "CivCentre"], templateName: "structures/athen_civil_centre" });
	world.addEntity(anchor);
	bases.push({ anchor, accessIndex: 2 });

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
		applyCiv: (name: string) => name,
		getTemplate: (name: string) => templates[name] ?? null,
		isTemplateDisabled: () => false,
		getPlayerCiv: () => "athen",
		templates,
		getVictoryConditions: () => new Set(buddies),
		getPopulation: () => options.population ?? 0,
		getPopulationMax: () => options.populationMax ?? 400,
		/** the barracks able to train a given template, as the real implementations do */
		findTrainers: (template: string) =>
			new EntityCollection(sharedAI as unknown as CommonSharedScript,
				mapOf(structures.filter((s) => s.hasClass("Trainer") &&
					((s.trainableEntities as (civ: string) => string[] | undefined)("athen") ?? []).indexOf(template) !== -1))),
		getNumPlayerEnemies: () => knobs.enemyPlayer === undefined ? 0 : 1,
		getEntityById: (id: number | string) => ents.get(+id),
		getEntities: (owner?: number) => new EntityCollection(
			sharedAI as unknown as CommonSharedScript,
			mapOf([...ents.values()].filter((e) => owner === undefined || e.owner() === owner))),
		getOwnUnits: () => new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(units)),
		getOwnEntities: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf([...units, ...structures.filter((s) => s.owner() === PLAYER)])),
		getEnemyStructures: (owner?: number) => structuresOf(owner === undefined ? undefined : owner),
		getEnemyUnits: (owner?: number) => unitsOf(owner),
		getStructures: () => new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(structures)),
		getOwnEntitiesByRole: (role: string | undefined) =>
			new EntityCollection(sharedAI as unknown as CommonSharedScript, mapOf(units.filter((u) => u.getMetadata(PLAYER, "role") == role))),
		getOwnEntitiesByClass: (cls: string) => new EntityCollection(
			sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => s.hasClass(cls)))),
		getOwnTrainingFacilities: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => s.hasClass("Trainer")))),
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
		/** structures of everyone we and they consider an ally, as the game defines ally collections */
		getAllyStructures: () => new EntityCollection(sharedAI as unknown as CommonSharedScript,
			mapOf(structures.filter((s) => (state.playerData as { isMutualAlly: boolean[] }).isMutualAlly[s.owner()]))),
		getPassabilityClassMask: () => 0
	};
	world.gameState = state as unknown as CommonGameState;
	return world;
}
