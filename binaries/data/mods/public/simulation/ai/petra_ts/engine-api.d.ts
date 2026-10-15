/**
 * Engine API declarations used by Petra.
 */

/** Two-dimensional world coordinates used by engine path and position helpers. */
type Vec2 = [number, number];
/** Mapping of resource codes to amounts. */
type ResourceAmounts = Record<string, number>;
/** Stable numeric identifier for a player. */
type PlayerId = number;
/** Stable numeric identifier for an entity instance. */
type EntityId = number;

/** Represents the Engine Player Color. */
interface EnginePlayerColor
{
	r: number;
	g: number;
	b: number;
	a: number;
}

/** Represents the Engine Player Statistics. */
interface EnginePlayerStatistics
{
	resourcesGathered: ResourceAmounts;
	percentMapExplored: number;
}

/** Represents the Engine Player Statistics Sequences. */
interface EnginePlayerStatisticsSequences
{
	[key: string]: number[] | Record<string, number[]>;
}

/** Represents the Engine Player State. */
interface EnginePlayerState
{
	name: string;
	civ: string;
	color: EnginePlayerColor;
	entity: EntityId;
	controlsAll: boolean;
	popCount: number;
	popLimit: number;
	popMax: number;
	panelEntities: EntityId[];
	resourceCounts: ResourceAmounts;
	resourceGatherers: Record<string, number>;
	trainingBlocked: boolean;
	state: string;
	team: number;
	teamLocked: boolean;
	disabledTemplates: Record<string, boolean>;
	disabledTechnologies: Record<string, boolean>;
	hasSharedDropsites: boolean;
	hasSharedLos: boolean;
	spyCostMultiplier: number;
	phase: "" | "village" | "town" | "city";
	isAlly: boolean[];
	isMutualAlly: boolean[];
	isNeutral: boolean[];
	isEnemy: boolean[];
	entityLimits: Record<string, number> | null;
	entityCounts: Record<string, number> | null;
	matchEntityCounts: Record<string, number> | null;
	entityLimitChangers: Record<string, Record<string, unknown>> | null;
	researchQueued: Map<string, unknown> | null;
	researchedTechs: Set<string> | null;
	classCounts: Record<string, number> | null;
	typeCountsByClass: Record<string, Record<string, number>> | null;
	canBarter: boolean;
	barterPrices: {
		buy: ResourceAmounts;
		sell: ResourceAmounts;
	};
	statistics?: EnginePlayerStatistics;
	sequences?: EnginePlayerStatisticsSequences;
}

/** Represents the Engine Simulation State. */
interface EngineSimulationState
{
	players: EnginePlayerState[];
	circularMap?: boolean;
	mapSize?: number;
	/** Simulation time in milliseconds. */
	timeElapsed: number;
	ceasefireActive?: boolean;
	ceasefireTimeRemaining?: number;
	victoryConditions: string[];
	alliedVictory: boolean;
	populationCapType: string;
	populationCap: number;
}

/** Represents the Engine Grid Map. */
interface EngineGridMap
{
	width: number;
	height: number;
	cellSize?: number;
	data?: ArrayLike<number>;
}

/** Represents the Engine Value Modification. */
interface EngineValueModification
{
	variable: string;
	value: string | number | boolean;
}

/** Represents the Engine AI Entity State. */
interface EngineAIEntityState
{
	/** Present in the initial representation; entity updates may be partial. */
	id?: EntityId;
	template?: string;
	position?: Vec2;
	angle?: number;
	hitpoints?: number;
	invulnerability?: boolean;
	owner?: PlayerId;
	idle?: boolean;
	stance?: string;
	unitAIState?: string;
	unitAIOrderData?: unknown[];
	trainingQueue?: EngineProductionQueueItem[];
	foundationProgress?: number;
	foundationBuilders?: EntityId[];
	sharedDropsite?: boolean;
	garrisoned?: EntityId[];
	garrisonHolderID?: EntityId;
	decaying?: boolean;
	capturePoints?: Record<string, number>;
}

/** Represents the Engine Production Queue Item. */
interface EngineProductionQueueItem
{
	id: number;
	unitTemplate?: string;
	technologyTemplate?: string;
	count: number;
	progress: number;
	timeRemaining: number;
	metadata?: Record<string, unknown>;
}

/** Represents the Engine AI Event. */
interface EngineAIEvent
{
	[key: string]: unknown;
}

/** Represents the Engine AI Construction Finished Event. */
interface EngineAIConstructionFinishedEvent
	extends EngineAIEvent
{
	entity: EntityId;
	newentity: EntityId;
}

/** Represents the Engine AI Training Finished Event. */
interface EngineAITrainingFinishedEvent
	extends EngineAIEvent
{
	entities: EntityId[];
	owner: PlayerId;
	metadata: Record<string, unknown>;
}

/** Represents the Engine AI Metadata Event. */
interface EngineAIMetadataEvent
	extends EngineAIEvent
{
	id: EntityId;
	owner: PlayerId;
	metadata: PetraEntityMetadata;
}

interface EngineAIAttackRequestEvent extends EngineAIEvent
{
	source: PlayerId;
	player: PlayerId;
}

interface EngineAIAttackedEvent extends EngineAIEvent
{
	target: EntityId;
	attacker: EntityId;
}

interface EngineAIDiplomacyChangedEvent extends EngineAIEvent
{
	player: PlayerId;
	otherPlayer: PlayerId;
}

interface EngineAITrainingStartedEvent extends EngineAIEvent
{
	entity: EntityId;
}

interface EngineAITerritoryDecayChangedEvent extends EngineAIEvent
{
	entity: EntityId;
	to: boolean;
}

/** Represents the Engine AI Destroy Event. */
interface EngineAIDestroyEvent
	extends EngineAIEvent
{
	entity: EntityId;
	SuccessfulFoundation?: boolean;
	metadata?: Record<number, PetraEntityMetadata>;
}

/** Represents the Engine AI Events. */
interface EngineAIEvents
{
	Create: Array<{ entity: EntityId }>;
	Destroy: EngineAIDestroyEvent[];
	Attacked: EngineAIAttackedEvent[];
	ConstructionFinished: EngineAIConstructionFinishedEvent[];
	DiplomacyChanged: EngineAIDiplomacyChangedEvent[];
	TrainingStarted: EngineAITrainingStartedEvent[];
	TrainingFinished: EngineAITrainingFinishedEvent[];
	AIMetadata: EngineAIMetadataEvent[];
	PlayerDefeated: Array<{ playerId: PlayerId }>;
	EntityRenamed: Array<{ entity: EntityId; newentity: EntityId }>;
	ValueModification: Array<{
		component: string;
		valueNames: string[];
		entities: EntityId[];
		player?: PlayerId;
	}>;
	OwnershipChanged: Array<{ entity: EntityId; from: PlayerId; to: PlayerId }>;
	Garrison: Array<{ entity: EntityId; holder: EntityId }>;
	UnGarrison: Array<{ entity: EntityId; holder: EntityId }>;
	TerritoriesChanged: EngineAIEvent[];
	TerritoryDecayChanged: EngineAITerritoryDecayChangedEvent[];
	TributeExchanged: EngineAIEvent[];
	AttackRequest: EngineAIAttackRequestEvent[];
	CeasefireEnded: EngineAIEvent[];
	DiplomacyRequest: EngineAIEvent[];
	TributeRequest: EngineAIEvent[];
}

/** Represents the Engine AI State. */
interface EngineAIState extends EngineSimulationState
{
	entities: Record<string, EngineAIEntityState>;
	events: EngineAIEvents;
	changedTemplateInfo: Record<string, Record<string, EngineValueModification[]>>;
	changedEntityTemplateInfo: Record<string, EngineValueModification[]>;
	passabilityClasses: Record<string, number>;
	passabilityMap: EngineGridMap;
	territoryMap: EngineGridMap;
}

/** Represents the Engine Path Point. */
interface EnginePathPoint
{
	/** X-coordinate in world space. */
	x: number;
	/** Y-coordinate in world space. */
	y: number;
}

/** Represents the Engine Command Chat. */
interface EngineCommandChat
{
	/** The command kind. */
	type: "aichat";
	/** Message text to send to the player or engine. */
	message: string;
	/** Whether to translate the message before display. */
	translateMessage?: boolean;
	/** Translation parameters for the message. */
	translateParameters?: string[] | Record<string, string | null>;
	/** Replacement parameters bound to the message. */
	parameters?: Record<string, string | number>;
}

/** Represents the Engine Command Set Shading Color. */
interface EngineCommandSetShadingColor
{
	/** The command kind. */
	type: "set-shading-color";
	/** Entity ids whose shading color should change. */
	entities: EntityId[];
	/** RGB color components passed to the engine's shading command. */
	rgb: [number, number, number];
}

/** Represents the Engine Command Set Trading Goods. */
interface EngineCommandSetTradingGoods
{
	/** The command kind. */
	type: "set-trading-goods";
	/** Goods to set for the trader state. */
	tradingGoods: ResourceAmounts;
}

/** Represents the Engine Command Tribute. */
interface EngineCommandTribute
{
	/** The command kind. */
	type: "tribute";
	/** Player receiving the tribute. */
	player: PlayerId;
	/** Resources to send. */
	amounts: ResourceAmounts;
}

/** Represents the Engine Command Tribute Request. */
interface EngineCommandTributeRequest
{
	/** The command kind. */
	type: "tribute-request";
	/** Sender of the request. */
	source: PlayerId;
	/** Player whose tribute is requested. */
	player: PlayerId;
	/** Amount of resource requested. */
	resourceWanted: number;
	/** Resource type requested. */
	resourceType: string;
}

/** Represents the Engine Command Diplomacy. */
interface EngineCommandDiplomacy
{
	type: "diplomacy";
	/** The player whose diplomatic stance is changed. */
	player: PlayerId;
	/** The requested diplomatic stance. */
	to: "ally" | "neutral" | "enemy";
}

/** Represents the Engine Command Diplomacy Request. */
interface EngineCommandDiplomacyRequest
{
	type: "diplomacy-request";
	source: PlayerId;
	player: PlayerId;
	to: string;
}

/** Represents the Engine Command Attack Request. */
interface EngineCommandAttackRequest
{
	/** The command kind. */
	type: "attack-request";
	/** Source player issuing the request. */
	source: PlayerId;
	/** Player whose army should attack. */
	player: PlayerId;
}

/** Represents the Engine Command Drop Site Sharing. */
interface EngineCommandDropSiteSharing
{
	/** The command kind. */
	type: "set-dropsite-sharing";
	/** Entity ids affected by the setting. */
	entities: EntityId[];
	/** Whether the entities should share dropsite access. */
	shared: boolean;
}

/** Represents the Engine Rally Point Data. */
interface EngineRallyPointData
{
	command?: string;
	target?: EntityId;
	resourceType?: string;
	resourceTemplate?: string;
	targetClasses?: string[];
	allowCapture?: boolean;
	source?: EntityId;
}

/** Represents the Engine Wall Set. */
interface EngineWallSet
{
	templates: {
		tower: string;
		long: string;
		medium: string;
		short: string;
		gate: string;
		[key: string]: string;
	};
	minTowerOverlap: number;
	maxTowerOverlap: number;
}

/** Represents the Engine Command Entity List. */
interface EngineCommandEntityList
{
	entities: EntityId[];
}

/** Represents the Engine Command Queued. */
interface EngineCommandQueued extends EngineCommandEntityList
{
	queued?: boolean;
	pushFront?: boolean;
}

/** Represents the Engine Command With Formation. */
interface EngineCommandWithFormation extends EngineCommandQueued
{
	formation?: string;
}

/** Represents the Engine Command Queued Formation. */
interface EngineCommandQueuedFormation extends EngineCommandEntityList
{
	queued?: boolean;
	formation?: string;
}

/** Cheat command payloads are only accepted when cheats are enabled. */
type EngineCommandCheat =
	| { type: "cheat"; player: PlayerId; action: "addresource"; text: string; parameter: number }
	| { type: "cheat"; player: PlayerId; action: "convertunit"; selected: EntityId[]; parameter: PlayerId }
	| { type: "cheat"; player: PlayerId; action: "createunits"; selected: EntityId[]; parameter: number; templates: string[] }
	| { type: "cheat"; player: PlayerId; action: "killunits"; selected: EntityId[] }
	| { type: "cheat"; player: PlayerId; action: "defeatplayer"; parameter: PlayerId }
	| { type: "cheat"; player: PlayerId; action: "researchTechnology"; parameter: string; selected?: EntityId[] }
	| { type: "cheat"; player: PlayerId; action: "revealmap" | "maxpopulation" | "changemaxpopulation" | "fastactions" }
	| { type: "cheat"; player: PlayerId; action: "changephase"; parameter?: string | number; selected?: EntityId[] };

/** Commands dispatched by ProcessCommand; field validation is handler-specific. */
type EngineCommand =
	| EngineCommandChat
	| EngineCommandSetShadingColor
	| EngineCommandSetTradingGoods
	| EngineCommandTribute
	| EngineCommandTributeRequest
	| EngineCommandDiplomacy
	| EngineCommandDiplomacyRequest
	| EngineCommandAttackRequest
	| EngineCommandDropSiteSharing
	| (EngineCommandQueued & { type: "walk"; x: number; z: number; formation?: string })
	| (EngineCommandWithFormation & { type: "walk-custom"; targetPositions: Record<string, { x: number; y: number }> })
	| (EngineCommandQueued & { type: "walk-to-range"; x: number; z: number; min: number; max: number })
	| (EngineCommandWithFormation & { type: "attack-walk"; x: number; z: number; targetClasses?: string[]; allowCapture?: boolean })
	| (EngineCommandWithFormation & { type: "attack-walk-custom"; targetPositions: Record<string, { x: number; y: number }>; targetClasses?: string[]; allowCapture?: boolean })
	| (EngineCommandQueued & { type: "attack"; target: EntityId; allowCapture?: boolean; formation?: string })
	| (EngineCommandQueued & { type: "attack-group"; targets: EntityId[]; allowCapture?: boolean })
	| (EngineCommandQueuedFormation & { type: "patrol"; x: number; z: number; targetClasses?: string[]; allowCapture?: boolean })
	| (EngineCommandQueued & { type: "heal"; target: EntityId; formation?: string })
	| (EngineCommandWithFormation & { type: "repair"; target: EntityId; autocontinue?: boolean })
	| (EngineCommandWithFormation & { type: "gather"; target: EntityId })
	| (EngineCommandQueued & { type: "gather-near-position"; x: number; z: number; resourceType: string; resourceTemplate: string; formation?: string })
	| (EngineCommandWithFormation & { type: "returnresource"; target: EntityId })
	| (EngineCommandEntityList & { type: "collect-treasure"; target: EntityId; queued?: boolean; formation?: string })
	| (EngineCommandEntityList & { type: "collect-treasure-near-position"; x: number; z: number; queued?: boolean })
	| (EngineCommandEntityList & { type: "back-to-work" | "remove-guard" | "leave-turret" | "unload-turrets" | "alert-raise" | "alert-end" | "cancel-upgrade" | "autoqueue-on" | "autoqueue-off" })
	| (EngineCommandEntityList & { type: "stop"; queued?: boolean })
	| (EngineCommandQueued & { type: "call-to-arms"; position: { x: number; z: number }; targetClasses?: string[]; allowCapture?: boolean; formation?: string })
	| (EngineCommandQueued & { type: "focus-fire"; target: EntityId; formation?: string })
	| (EngineCommandEntityList & { type: "occupy-turret"; target: EntityId; queued?: boolean })
	| (EngineCommandQueued & { type: "garrison" | "guard"; target: EntityId; formation?: string })
	| { type: "train"; entities: EntityId[]; template: string; count: number; metadata?: Record<string, unknown>; pushFront?: boolean }
	| { type: "research"; entity: EntityId; template: string; metadata?: Record<string, unknown>; pushFront?: boolean }
	| { type: "stop-production"; entity: EntityId; id: number }
	| (EngineCommandQueued & { type: "construct"; template: string; x: number; z: number; angle: number; metadata?: Record<string, unknown>; actorSeed?: number; autorepair?: boolean; autocontinue?: boolean; formation?: string; obstructionControlGroup?: number; obstructionControlGroup2?: number })
	| (EngineCommandEntityList & { type: "construct-wall"; pieces: Array<{ template: string; x: number; z: number; angle: number }>; wallSet: EngineWallSet; startSnappedEntity?: EntityId; endSnappedEntity?: EntityId; autorepair?: boolean; autocontinue?: boolean; queued?: boolean })
	| { type: "delete-entities"; entities: EntityId[] }
	| { type: "set-rallypoint"; structures?: EntityId[]; x: number; z: number; data?: EngineRallyPointData; queued?: boolean }
	| { type: "unset-rallypoint"; structures?: EntityId[] }
	| { type: "resign" }
	| (EngineCommandEntityList & { type: "setup-trade-route"; target: EntityId; source: EntityId; route?: Array<{ x: number; z: number }>; queued?: boolean; formation?: string })
	| { type: "cancel-setup-trade-route"; entities: EntityId[]; target: EntityId }
	| { type: "barter"; sell: string; buy: string; amount: number }
	| { type: "unload"; garrisonHolder: EntityId; entities: EntityId[] }
	| { type: "unload-template"; garrisonHolders: EntityId[]; template: string; owner: PlayerId; all: boolean }
	| { type: "unload-all-by-owner" | "unload-all"; garrisonHolders: EntityId[] }
	| { type: "formation"; entities: EntityId[]; formation: string; queued?: boolean; pushFront?: boolean }
	| (EngineCommandEntityList & { type: "promote" })
	| (EngineCommandEntityList & { type: "stance"; name: string })
	| (EngineCommandEntityList & { type: "lock-gate"; lock: boolean })
	| (EngineCommandEntityList & { type: "pack" | "cancel-pack"; pack: boolean; queued?: boolean; pushFront?: boolean })
	| (EngineCommandEntityList & { type: "upgrade"; template: string })
	| { type: "spy-request"; player: PlayerId }
	| { type: "dialog-answer"; dialog?: string; answer?: string; tutorial?: "continue"; [key: string]: unknown }
	| EngineCommandCheat
	| { type: "control-all"; flag: boolean }
	| { type: "reveal-map"; enable: boolean };

/** Backwards-compatible name used by existing Petra declarations. */
type PetraEngineCommand = EngineCommand;

/** Engine runtime entry points exposed to Petra scripts. */
declare const Engine: {
/** Represents the Post Command. */
	PostCommand(player: PlayerId, command: PetraEngineCommand): void;
/** Gets a template by name. */
	GetTemplate(name: string): Record<string, unknown> | null | undefined;
/** Gets the Entities With Interface. */
	GetEntitiesWithInterface(interfaceId: string | number): EntityId[];
/** Represents the Exit. */
	Exit(exitStatus: number): void;
/** Represents the Profile Start. */
	ProfileStart(name: string): void;
/** Represents the Profile Stop. */
	ProfileStop(): void;
	/** Compute a path between two world points while respecting a passability mask. */
	ComputePath(start: { x: number; y: number }, end: { x: number; y: number },
		passabilityMask: number): EnginePathPoint[];
/** Represents the Dump Image. */
	DumpImage(name: string, data: ArrayLike<number>, width: number, height: number, threshold: number): void;
};

/** Active player id for the currently running AI script. */
declare var PlayerID: PlayerId;

/** Core simulation state variables exposed by the engine. */
declare const Sim: {
	/** Entity id of the system entity. */
	SYSTEM_ENTITY: EntityId;
	/** Interface identifier for the modifiers manager. */
	IID_ModifiersManager: string | number;
	/** Interface identifiers used by common AI helpers. */
	IID_UnitAI: string | number;
	IID_ResourceSupply: string | number;
	IID_ResourceGatherer: string | number;
	/** Requirements helper exposed by the simulation runtime. */
	RequirementsHelper: {
/** Represents the Are Requirements Met. */
		AreRequirementsMet(requirements: unknown, player: PlayerId): boolean;
	};
};

/** Engine-side simulation query helpers used for modifiers. */
declare const SimEngine: {
/** Represents the Query Interface. */
	QueryInterface(entity: EntityId, interfaceId: string | number): {
/** Adds Modifiers. */
		AddModifiers(name: string, modifiers: Record<string, unknown>, affectedPlayers?: PlayerId[]): void;
	};
};

/** Mark a string for translation lookup. */
declare function markForTranslation(message: string): string;
/** Deep-clone a value without preserving object identity. */
declare function clone<T>(value: T): T;
/** Serialize a value into a string representation for debugging. */
declare function uneval(value: unknown): string;
/** Emit a warning message to the engine log. */
declare function warn(message: string): void;
/** Throw a scripted error with a diagnostic message. */
declare function error(message: string): never;
