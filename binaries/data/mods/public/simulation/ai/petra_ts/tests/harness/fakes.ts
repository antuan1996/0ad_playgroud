/**
 * The fakes every suite builds on: entities and templates, the turn's events,
 * and the engine builtins a test swaps for its own.
 *
 * An entity answers exactly what its test declared over neutral defaults, and
 * anything else raises with the missing method's name, so a test cannot pass
 * because a call quietly returned undefined.
 */

/**
 * A fake standing in for the engine's or the port's own `T`: the harness's one
 * cast. A fake answers only what its test declared, so it is no `T` the
 * compiler can check; what it is checked by is the test failing on any
 * undeclared method.
 */
export function fake<T>(value: unknown): T
{
	return value as T;
}

/** Method overrides a test supplies on top of the neutral entity defaults. */
export type Methods = Record<string, (...args: any[]) => unknown>;

/** Engine builtins and globals a test stubs, kept for restoreEngine after it. */
let engineStubs: Map<string, unknown> | undefined;
let globalStubs: Map<string, unknown> | undefined;

const globals = fake<Record<string, unknown> & { Engine: Record<string, unknown> }>(globalThis);

/** Swap an Engine builtin for the test; pair with restoreEngine. */
export function stubEngine(name: string, value: unknown): void
{
	engineStubs ??= new Map();
	if (!engineStubs.has(name))
		engineStubs.set(name, globals.Engine[name]);
	globals.Engine[name] = value;
}

/** Swap any global (e.g. randBool) for the test; pair with restoreEngine. */
export function stubGlobal(name: string, value: unknown): void
{
	globalStubs ??= new Map();
	if (!globalStubs.has(name))
		globalStubs.set(name, globals[name]);
	globals[name] = value;
}

/** Put back every builtin a test has stubbed. */
export function restoreEngine(): void
{
	if (engineStubs)
	{
		for (const [name, value] of engineStubs)
			globals.Engine[name] = value;
	}
	if (globalStubs)
	{
		for (const [name, value] of globalStubs)
			globals[name] = value;
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

/** A turn's events as the engine hands them over: every bucket of AIInterface.js's EventNames, empty. */
export function emptyEvents(): EngineAIEvents
{
	return {
		"Create": [], "Destroy": [], "Attacked": [], "ConstructionFinished": [], "DiplomacyChanged": [],
		"TrainingStarted": [], "TrainingFinished": [], "AIMetadata": [], "PlayerDefeated": [], "EntityRenamed": [],
		"ValueModification": [], "OwnershipChanged": [], "Garrison": [], "UnGarrison": [], "TerritoriesChanged": [],
		"TerritoryDecayChanged": [], "TributeExchanged": [], "AttackRequest": [], "CeasefireEnded": [],
		"DiplomacyRequest": [], "TributeRequest": []
	};
}

/** A turn's events with the given buckets raised, every other one empty. */
export function eventsWith(extra: Partial<EngineAIEvents>): EngineAIEvents
{
	return { ...emptyEvents(), ...extra };
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
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): CommonEntity
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

	return fake<CommonEntity>(new Proxy(store, {
		get(target, property)
		{
			if (typeof property === "symbol")
				return Reflect.get(target, property);
			if (property in target)
				return Reflect.get(target, property);
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
	}));
}

/**
 * Make a fake (an entity, a door, a manager's method) answer differently from
 * here on. The answers are the fake's own, unchecked like `Methods`: a fake
 * recording an order need not hand back what the real command returns.
 */
export function override<T extends object>(target: T, methods: Methods): T
{
	return Object.assign(target, methods);
}

/** Entity metadata as the engine carries it (in events, on entities): only the keys that were set. */
export function entityMetadata(fields: Partial<PetraEntityMetadata>): PetraEntityMetadata
{
	return fake<PetraEntityMetadata>(fields);
}

/** A value of a template's JSON by path ("Cost/Population"), the way a real template walks it. */
function templateValue(template: object, path: string): unknown
{
	let value: unknown = template;
	for (const part of path.split("/"))
	{
		if (typeof value !== "object" || value === null)
			return undefined;
		value = fake<Record<string, unknown>>(value)[part];
	}
	return value;
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
	/** the Research/Time of a technology; other templates carry none */
	researchTime?: number;
} = {}): CommonTemplate
{
	const cost = detail.cost ?? {};
	const classes = [...(detail.classes ?? [])];
	const getPaths = detail.getPaths ? { ...detail.getPaths } : {};
	const available = detail.available ?? true;
	const gatherRates = detail.resourceGatherRates ? { ...detail.resourceGatherRates } : undefined;
	// the template walk the `get` method below reads leaves from
	const getTemplateValue = (path: string): unknown => templateValue(getPaths, path);
	return fake<CommonTemplate>({
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
		researchTime: detail.researchTime,
		// as the common-api Template.buildCategory (entity.js 479) reads
		// BuildRestrictions/Category, the EntityLimits counter that template
		// decrements when raised; unit templates carry no BuildRestrictions
		buildCategory: () => getTemplateValue("BuildRestrictions/Category"),
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
	});
}
