/**
 * Engine API declarations used by Petra.
 *
 * Everything here documents the machine interface the engine really builds for
 * AI scripts, verified against runtime sources so that callers do not have to
 * dig into engine or simulation-script code. The main sources are:
 *
 * - **AI script context** — created by `CAIWorker::Init`
 *   (source/simulation2/components/CCmpAIManager.cpp) inside the simulation's
 *   SpiderMonkey realm. It registers `PostCommand`, `Exit`, `ComputePath` and
 *   `DumpImage` on the global `Engine` object, along with the read-only VFS
 *   helpers (`ListDirectoryFiles`, `FileExists`, `ReadJSONFile`). It also
 *   exposes two simulation globals to the AI: `Sim` (the simulation scripts'
 *   global object, holding `SYSTEM_ENTITY`, `IID_*` constants, helper classes
 *   like `RequirementsHelper`, …) and `SimEngine` (the simulation interface's
 *   native scope, i.e. the object the simulation scripts call `Engine`).
 * - **Per-turn state** — assembled by the AIInterface system component
 *   (binaries/data/mods/public/simulation/components/AIInterface.js):
 *   the GUI's `GetSimulationState()` (GuiInterface.js) filled with AI extras
 *   (`entities`, `events`, `changedTemplateInfo`,
 *   `changedEntityTemplateInfo`), plus the passability/territory grids and
 *   passability classes attached by CCmpAIManager. The same state object is
 *   handed to every AI player, so Petra must treat it as read-only.
 * - **Entity snapshots** — produced by the AIProxy component
 *   (binaries/data/mods/public/simulation/components/AIProxy.js): a full
 *   representation when an entity is first seen, afterwards only partial
 *   "changes" objects. The common-api merges them into the previous turn's
 *   value, so an absent field keeps its old value, while a field explicitly
 *   marked present-but-cleared is `undefined` (e.g. `position` when the
 *   entity is taken out of the world).
 * - **Events** — messages collected by AIInterface via AIProxy handlers; every
 *   named bucket exists in every turn, empty when nothing happened. Payload
 *   shapes below are verified against the `components/interfaces/*.js`
 *   docs and posting sites (found by searching each `RegisterMessageType`
 *   name under binaries/data/mods/public/simulation/components).
 * - Petra's own bridge scripts (binaries/data/mods/public/simulation/ai/
 *   common-api/*.js) additionally decorate some engine values before Petra
 *   logic sees them; such additions are called out explicitly in the comments
 *   (e.g. `EngineGridMap.cellSize`, and the `SuccessfulFoundation`/`metadata`
 *   fields on Destroy events, added by common-api/shared.js, not by the
 *   engine).
 *
 * The engine (main.cpp / Interface.cpp) also provides script globals that are
 * only declared here where Petra uses them (`warn`, `error`, `uneval`,
 * `clone`, `markForTranslation`, the `global`, `print`, `log` and `deepfreeze`
 * globals are not declared).
 */

/**
 * Two world coordinates `[x, z]` in metres, as used by the engine's
 * position/navcell helpers. Note `ComputePath`'s start/goal parameters instead
 * take `{ x, y }` objects (they are converted as CFixedVector2D).
 */
type Vec2 = [number, number];
/**
 * An amount of one or more resources keyed by resource code, most often per
 * generic type (`"food"`, `"wood"`, `"stone"`, `"metal"`). Some payloads key
 * by specific type (`"meat"`, `"fruit"`, `"grain"`, …) as noted on the field.
 */
type ResourceAmounts = Record<string, number>;
/**
 * A player index: 0 is the always-neutral Gaia player, 1..N are the playable
 * players, and -1 (`INVALID_PLAYER`) is returned for not-yet-owned entities.
 * The engine also exposes `INVALID_PLAYER` as a `Sim` global.
 */
type PlayerId = number;
/**
 * A simulation entity identifier: `0` is `INVALID_ENTITY`, `1` is
 * `SYSTEM_ENTITY` (host of system components like AIInterface, the pathfinder
 * or the PlayerManager), every other positive id is an entity. Entity ids are
 * also used as property names (stringified) in state maps such as
 * `entities` and `capturePoints`.
 */
type EntityId = number;

/**
 * RGBA player colour as configured in the game settings for each player
 * (GuiInterface copies it from `Player.GetColor()`).
 */
interface EnginePlayerColor
{
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * A few counters exposed by the StatisticsTracker component on every player
 * entity that implements it (`GetBasicStatistics()`); absent (optional) for
 * player entities without a StatisticsTracker. `resourcesGathered` is keyed by
 * generic resource code plus the extra `"vegetarianFood"` key.
 */
interface EnginePlayerStatistics
{
	resourcesGathered: ResourceAmounts;
	percentMapExplored: number;
}

/**
 * One entry of the `players` array of the per-turn state: exactly the fields
 * `GuiInterface.GetSimulationState()` (GuiInterface.js) builds from the
 * components of the player's Player entity, never partial. Diplomacy arrays
 * (`isAlly`, `isMutualAlly`, `isNeutral`, `isEnemy`) are indexed by player id
 * with numPlayers entries; this player's own slot is `true` in `isAlly`.
 */
interface EnginePlayerState
{
	/** Identity.GetName() of the player entity's Identity component. */
	name: string;
	/** Identity.GetCiv() culture code, e.g. "romans". */
	civ: string;
	/** The colour set in the match settings for this player. */
	color: EnginePlayerColor;
	/** Entity id of this player's persistent Player entity (the value Petra's
	 * common-api exposes as `gameState.playerData.entity`). Pass it to
	 * `SimEngine.QueryInterface` (e.g. with `IID_Player`) to access the
	 * player's components. It is NOT the player id: system entities come
	 * first, and `PlayerManager.ReplacePlayerTemplate` can re-create the
	 * entity with a fresh id, so never derive it arithmetically. */
	entity: EntityId;
	/** True only when the player can control all units (observer/debug). */
	controlsAll: boolean;
	/** Population units owned or being trained/population reserved. */
	popCount: number;
	/** Current population limit after bonuses, techs and per-player caps. */
	popLimit: number;
	/** Configured maximum population (`Player.GetMaxPopulation()`). */
	popMax: number;
	/** Entity ids shown with special UI markers, from Player.panelEntities. */
	panelEntities: EntityId[];
	/** Remaining resources, keyed by generic resource code. */
	resourceCounts: ResourceAmounts;
	/** Gatherers currently assigned per generic resource code. */
	resourceGatherers: Record<string, number>;
	/** True while any production queue is blocked (population/limits). */
	trainingBlocked: boolean;
	/** Player state, one of "active", "defeated", "won" (Player.js
	 * STATE_* constants). */
	state: "active" | "defeated" | "won";
	/** Diplomatic team index, or -1 for "no team". */
	team: number;
	/** Whether the team cannot be changed after the start. */
	teamLocked: boolean;
	/** Template names this player has deliberately disabled, value `true`. */
	disabledTemplates: Record<string, boolean>;
	/** Technology template names this player disabled, value `true`. */
	disabledTechnologies: Record<string, boolean>;
	/** Whether this player shares dropsites with its allies. */
	hasSharedDropsites: boolean;
	/** Whether this player shares line of sight with its allies. */
	hasSharedLos: boolean;
	/** Cost multiplier for bribes (`Player.GetSpyCostMultiplier()`). */
	spyCostMultiplier: number;
	/** Technology phase: "" before "phase_village", else "village", "town"
	 * or "city". Gaia (no TechnologyManager) is always "". */
	phase: "" | "village" | "town" | "city";
	isAlly: boolean[];
	isMutualAlly: boolean[];
	isNeutral: boolean[];
	isEnemy: boolean[];
	/** `null` when the player entity has no EntityLimits component. */
	entityLimits: Record<string, number> | null;
	/** Keyed by limits category/template; `null` without EntityLimits. */
	entityCounts: Record<string, number> | null;
	/** Keyed by matched template; `null` without EntityLimits. */
	matchEntityCounts: Record<string, number> | null;
	/** Per-category limit changers (technologies/entities); `null` without
	 * EntityLimits. */
	entityLimitChangers: Record<string, Record<string, unknown>> | null;
	/** Technologies queued for research; keyed by suffixed technology name;
	 * `null` when the player has no TechnologyManager. */
	researchQueued: Map<string, unknown> | null;
	/** Researched technology names; `null` without TechnologyManager. */
	researchedTechs: Set<string> | null;
	/** Entity class/template counts per player (TechnologyManager);
	 * `null` without TechnologyManager. */
	classCounts: Record<string, number> | null;
	typeCountsByClass: Record<string, Record<string, number>> | null;
	/** Whether this player has barter-capable markets. */
	canBarter: boolean;
	/** Barter rates (Barter.GetPrices) keyed by generic resource code. */
	barterPrices: {
		buy: ResourceAmounts;
		sell: ResourceAmounts;
	};
	/** Only present when the player entity has a StatisticsTracker. */
	statistics?: EnginePlayerStatistics;
}

/**
 * The non-entity part of the per-turn AI state: `GetSimulationState()`
 * fields from GuiInterface.js. All fields except the three marked optional
 * are always present.
 */
interface EngineSimulationState
{
	players: EnginePlayerState[];
	/** True when the playable map is circular (from the RangeManager);
	 * only absent when that manager does not exist. */
	circularMap?: boolean;
	/** Terrain size in world metres (tiles × TERRAIN_TILE_SIZE = 4 m). */
	mapSize?: number;
	/** Simulated time in milliseconds (`Timer.GetTime()`), not wall time. */
	timeElapsed: number;
	/** Ceasefire fields are only absent when no CeasefireManager exists;
	 * `ceasefireTimeRemaining` is 0 whenever ceasefire is inactive and
	 * otherwise the remaining milliseconds. */
	ceasefireActive?: boolean;
	ceasefireTimeRemaining?: number;
	/** Optional — only when a CinemaManager exists and its queue is playing. */
	cinemaPathPlaying?: boolean;
	/** Victory condition identifiers (e.g. "conquest", "wonder") enabled in
	 * the match settings. */
	victoryConditions: string[];
	alliedVictory: boolean;
	/** Population cap mode from PopulationCapManager. */
	populationCapType: string;
	populationCap: number;
}

/**
 * A passability or territory grid, converted by
 * `Script::ToJSVal<Grid<uint8_t|uint16_t>>` (source/simulation2/scripting/
 * EngineScriptConversions.cpp) to exactly this shape; `data` is always
 * present.
 */
interface EngineGridMap
{
	/** Number of columns: navcells (1 m) for `passabilityMap`, terrain tiles
	 * (4 m) for `territoryMap`. */
	width: number;
	/** Number of rows, as `width`. */
	height: number;
	/**
	 * Not engine-provided: Petra's common-api/shared.js adds
	 * `cellSize = mapSize / width` (world metres per grid cell, so 4 m for a
	 * territory cell and 1 m for a navcell) before Petra logic reads it.
	 */
	cellSize?: number;
	/**
	 * Row-major cell values, length `width * height`.
	 * - `passabilityMap`: a Uint16Array of passability masks per navcell,
	 *   combining `passabilityClasses` values.
	 * - `territoryMap`: a Uint8Array where bits 0-4 encode the owning
	 *   player id (`TERRITORY_PLAYER_MASK` = 0x1F, 0 = unowned/Gaia-less)
	 *   and bit 6 (0x40) the blinking/frontier flag.
	 */
	data: Uint8Array | Uint16Array;
}

/** One value change as sent by AIInterface's changed-template/entity info. */
interface EngineValueModification
{
	/** The template path affected, e.g. "Cost/BuildTime". */
	variable: string;
	/** The modified value; a few population paths are already engine-rounded
	 * by AIInterface.OnTemplateModification before they get here. */
	value: string | number | boolean;
}

/**
 * One entity's AI-visible state, from AIProxy.js. Fields exist because the
 * corresponding engine component exists on the entity; the changes-stream may
 * republish any subset at any time, so treat every field as unknown between
 * turns except through the common-api Entity merge.
 */
interface EngineAIEntityState
{
	/** Present in full representations; changes may omit it. */
	id?: EntityId;
	/** Current template name (constant per entity, from the TemplateManager). */
	template?: string;
	/** World position `[x, z]`, `undefined` explicitly set when out of world. */
	position?: Vec2;
	/** Rotation around the vertical axis (radians). */
	angle?: number;
	/** Current hitpoints, for entities with a Health component. */
	hitpoints?: number;
	/** Invulnerability flag, for entities with a Resistance component. */
	invulnerability?: boolean;
	/** Owning player id; -1 (`INVALID_PLAYER`) until first owned. */
	owner?: PlayerId;
	/** Confirmed UnitAI idleness (units only, `cmpUnitAI.isIdleConfirmed`). */
	idle?: boolean;
	/** Current stance name (units only), updated on stance changes. */
	stance?: string;
	/** UnitAI FSM state name (units only), e.g. "INDIVIDUAL.GATHER.X". */
	unitAIState?: string;
	/** UnitAI order payload list (units only); their dynamic keys include
	 * `target`, `force`, `x` and `z` depending on the order type. */
	unitAIOrderData?: unknown[];
	/** Production queue of the entity (structures with ProductionQueue). */
	trainingQueue?: EngineProductionQueueItem[];
	/** Build progress 0..100 of a foundation. */
	foundationProgress?: number;
	foundationBuilders?: EntityId[];
	/** Whether the entity's dropsite is shared with allies. */
	sharedDropsite?: boolean;
	/** Garrisoned entity ids (structures/holders with GarrisonHolder). */
	garrisoned?: EntityId[];
	/** Holder entity id, for garrisonable units currently inside a holder. */
	garrisonHolderID?: EntityId;
	/** Whether the entity's territory is decaying. */
	decaying?: boolean;
	/** Cap players → capture points remaining, string keys (entities with a
	 * Capturable component). */
	capturePoints?: Record<string, number>;
}

/**
 * One item of an entity's production queue (ProductionQueue.GetQueue, one of
 * Researcher.GetResearchingTechnology / Trainer.GetBatch). All items share
 * `id`, `progress`, `timeRemaining`, `paused` and `metadata`; the remaining
 * fields differ per queue kind:
 * - unit items additionally carry `unitTemplate`, `count`, `neededSlots`;
 * - technology items carry `technologyTemplate`, `templateName`,
 *   `researcher` and no `count`.
 */
interface EngineProductionQueueItem
{
	id: number;
	/** Unit items only: the unit template being trained. */
	unitTemplate?: string;
	/** Technology items only: the technology being researched. */
	technologyTemplate?: string;
	/** Unit items only: units still to come out of this batch. */
	count?: number;
	/** 0..1 batch fraction, recomputed every turn as
	 * `1 - timeRemaining / timeTotal` by the side that publishes the queue. */
	progress: number;
	/** Simulation milliseconds still needed to finish this item. */
	timeRemaining: number;
	/** Whether the queue is explicitly paused. */
	paused: boolean;
	/** Unit items only: population slots that still have no unit to seat. */
	neededSlots?: number;
	/** Technology items only: entity id of the researcher (structure). */
	researcher?: EntityId;
	/** Technology items only: plain technology template name. */
	templateName?: string;
	/** Whatever the Petra command passed as `metadata` when adding the
	 * item, per train/research command. */
	metadata?: Record<string, unknown>;
}

/** Bare event payloads the engine pushes with no extra fields yet. */
interface EngineAIEvent
{
	[key: string]: unknown;
}

/** A foundation finished building; see components/interfaces/Foundation.js. */
interface EngineAIConstructionFinishedEvent
	extends EngineAIEvent
{
	/** The (renamed-away) foundation entity. */
	entity: EntityId;
	/** The completed building entity id it became. */
	newentity: EntityId;
}

/**
 * One or more units finished training; posted by Trainer.js. `metadata` is
 * whatever Petra attached to the originating train command.
 */
interface EngineAITrainingFinishedEvent
	extends EngineAIEvent
{
	entities: EntityId[];
	owner: PlayerId;
	/** Train-command metadata; absent for batches without metadata. */
	metadata?: Record<string, unknown>;
}

/**
 * Petra metadata attached to a constructed entity: the "construct" command
 * with `metadata` posts MT_AIMetadata (`{ id, metadata, owner }`, see
 * Commands.js TryConstructBuilding), which AIProxy forwards as this event;
 * Petra's common-api/shared.js turns it into entity metadata.
 */
interface EngineAIMetadataEvent
	extends EngineAIEvent
{
	id: EntityId;
	owner: PlayerId;
	metadata: PetraEntityMetadata;
}

/** Another AI requests that this player attacks `player`. */
interface EngineAIAttackRequestEvent extends EngineAIEvent
{
	/** The requesting AI player. */
	source: PlayerId;
	/** The player to attack. */
	player: PlayerId;
}

/**
 * An entity was damaged (components/interfaces/Resistance.js posts the raw
 * MT_Attacked payload); `attacker` is the damaging entity id.
 */
interface EngineAIAttackedEvent extends EngineAIEvent
{
	target: EntityId;
	attacker: EntityId;
}

/** Diplomacy stance message sent by another player (Commands.js). */
interface EngineAIDiplomacyChangedEvent extends EngineAIEvent
{
	player: PlayerId;
	/** Player whose stance towards `player` changed, or null when the engine
	 * broadcasts a change initiated by `player` itself. */
	otherPlayer: PlayerId | null;
}

/** A batch of units started training (Trainer.js). */
interface EngineAITrainingStartedEvent extends EngineAIEvent
{
	entity: EntityId;
}

/**
 * Territory decay toggles on an entity (TerritoryDecay.js posts
 * `{ entity, to, rate }` for AIProxy to forward).
 */
interface EngineAITerritoryDecayChangedEvent extends EngineAIEvent
{
	entity: EntityId;
	to: boolean;
	/** Decay rate per second for the entity's TerritoryDecay component. */
	rate: number;
}

/**
 * An entity was destroyed. Petra's common-api/shared.js further augments each
 * Destroy event before Petra logic sees it (`SuccessfulFoundation` for
 * foundations completed in the same turn, `metadata` with the per-player
 * PetraEntityMetadata of the entity); the engine itself pushes only `entity`.
	 */
interface EngineAIDestroyEvent
	extends EngineAIEvent
{
	entity: EntityId;
	/** Added by Petra's shared.js when the destroyed entity was a foundation
	 * completed during this AI turn. */
	SuccessfulFoundation?: boolean;
	/** Added by Petra's shared.js: the entity's previous-turn per-player
	 * PetraEntityMetadata, keyed by player id (number). */
	metadata?: Record<number, PetraEntityMetadata>;
}

/**
 * All events the engine can hand to the AI during one turn, named by
 * AIInterface.EventNames (AIInterface.js). Exactly these 21 buckets always
 * exist, empty when nothing was sent this turn; Petra merges them across
 * turns in `_petrabot.ts`.
 */
interface EngineAIEvents
{
	/** Entity just received its first owner (AIProxy.OnOwnershipChanged). */
	Create: Array<{ entity: EntityId }>;
	Destroy: EngineAIDestroyEvent[];
	/**
	 * Entity damaged; the MT_Attacked payload (components/interfaces/
	 * Resistance.js) is richer than Petra reads: `{ type, target, attacker,
	 * attackerOwner, damage, capture, statusEffects, fromStatusEffect }`.
	 */
	Attacked: EngineAIAttackedEvent[];
	ConstructionFinished: EngineAIConstructionFinishedEvent[];
	DiplomacyChanged: EngineAIDiplomacyChangedEvent[];
	TrainingStarted: EngineAITrainingStartedEvent[];
	TrainingFinished: EngineAITrainingFinishedEvent[];
	AIMetadata: EngineAIMetadataEvent[];
	PlayerDefeated: Array<{ playerId: PlayerId }>;
	/** Entity id changed (Foundation/Formation/Health/Promotion/Mirage/
	 * Transform…, components/interfaces/Messages.js). */
	EntityRenamed: Array<{ entity: EntityId; newentity: EntityId }>;
	/**
	 * Technology value changes per entity, sent by ModifiersManager
	 * (SendPlayerModifierMessages) — no `player` field is ever added.
	 */
	ValueModification: Array<{
		component: string;
		valueNames: string[];
		entities: EntityId[];
	}>;
	OwnershipChanged: Array<{ entity: EntityId; from: PlayerId; to: PlayerId }>;
	/** A unit entered a garrison holder (AIProxy.OnGarrisonedUnitsChanged). */
	Garrison: Array<{ entity: EntityId; holder: EntityId }>;
	UnGarrison: Array<{ entity: EntityId; holder: EntityId }>;
	TerritoriesChanged: EngineAIEvent[];
	TerritoryDecayChanged: EngineAITerritoryDecayChangedEvent[];
	/** Initiated by Player.Transfer: `{ to, from, amounts }` (Player.js). */
	TributeExchanged: EngineAIEvent[];
	AttackRequest: EngineAIAttackRequestEvent[];
	CeasefireEnded: EngineAIEvent[];
	TributeRequest: EngineAIEvent[];
	DiplomacyRequest: EngineAIEvent[];
}

/**
 * The full AI-visible per-turn state: `EngineSimulationState` from GuiInterface
 * plus these AI additions from AIInterface.js and CCmpAIManager. Everything
 * except entity snapshots and the maps is the same every turn.
 */
interface EngineAIState extends EngineSimulationState
{
	/**
	 * Entity ids → AIProxy snapshots — note object keys are strings here;
	 * Petra's common-api keeps its own `number`-keyed map. All entities are
	 * present in the very first state; later turns only carry entities whose
	 * AIProxy reported any change.
	 */
	entities: Record<string, EngineAIEntityState>;
	events: EngineAIEvents;
	/** PlayerId → template name → modifications (AIInterface.js
	 * OnTemplateModification). Note player keys are strings after
	 * serialization. */
	changedTemplateInfo: Record<string, Record<string, EngineValueModification[]>>;
	/** Entity id → modifications (AIInterface.js OnGlobalValueModification);
	 * keys are strings after serialization. */
	changedEntityTemplateInfo: Record<string, EngineValueModification[]>;
	/** Values from the initial state only; passability class name → mask
	 * (LoadPathfinderClasses). */
	passabilityClasses: Record<string, number>;
	/** Navcell-level passability grid (see EngineGridMap). */
	passabilityMap: EngineGridMap;
	/** Terrain-tile-level territory grid (see EngineGridMap). */
	territoryMap: EngineGridMap;
}

/**
 * A single LongPathfinder waypoint the engine made from a Vector2D (world x
 * and y coordinates), used by `ComputePath`.
 */
interface EnginePathPoint
{
	x: number;
	y: number;
}

/**
 * The "aichat" command (Commands.js): the payload is forwarded to the GUI
 * as a chat notification ("players" is inserted there from the command
 * player); these fields carry the message parameters.
 */
interface EngineCommandChat
{
	/** Command kind; unknown command types are engine error-logged, so this
	 * keeps the literal "aichat" type. */
	type: "aichat";
	/** Message body, optionally already localized per `translateMessage`. */
	message: string;
	/** When true the GUI translates `message` before display. */
	translateMessage?: boolean;
	/** Variable names meant for translation filling (e.g. "_player_"). */
	translateParameters?: string[] | Record<string, string | null>;
	/** Display values for the variables listed in `translateParameters`. */
	parameters?: Record<string, string | number>;
}

/**
 * Entity shading-color change: Petra uses it to highlight entities, and the
 * GUI applies `rgb` (values 0..255) to those entities.
 */
interface EngineCommandSetShadingColor
{
	type: "set-shading-color";
	entities: EntityId[];
	/** Red/green/blue 0..255 tint values applied to these entities. */
	rgb: [number, number, number];
}

/**
 * Sets the amounts each trader will carry per resource trip
 * (Player.SetTradingGoods values).
 */
interface EngineCommandSetTradingGoods
{
	type: "set-trading-goods";
	/** Keyed by generic resource code; amounts weighted (per Player.js the
	 * per-resource "probabilities * 100" sort of measure). */
	tradingGoods: ResourceAmounts;
}

/**
 * Sends resources from this player to another player
 * (Commands.js "tribute" → Player.SendTribute).
 */
interface EngineCommandTribute
{
	type: "tribute";
	/** Player receiving the tribute. */
	player: PlayerId;
	/** Resources to send (must be available to this player). */
	amounts: ResourceAmounts;
}

/** Asks another player for tribute (commands sent by DiplomacyManager). */
interface EngineCommandTributeRequest
{
	type: "tribute-request";
	/** The asking player (Petra's own id). */
	source: PlayerId;
	player: PlayerId;
	/** Amount of resource desired. */
	resourceWanted: number;
	/** Generic desired resource code. */
	resourceType: string;
}

/**
 * Requests a diplomacy change (ally/neutral/enemy) of `player` for this
 * player; during a ceasefire or with locked teams it is silently a no-op
 * (Commands.js).
 */
interface EngineCommandDiplomacy
{
	type: "diplomacy";
	/** The player whose diplomatic stance should change. */
	player: PlayerId;
	/** The requested new stance. */
	to: "ally" | "neutral" | "enemy";
}

/**
 * A diplomacy request sent from Petra to another AI player; the engine
 * simply forwards it to that AI as a DiplomacyRequest event (Commands.js).
 */
interface EngineCommandDiplomacyRequest
{
	type: "diplomacy-request";
	source: PlayerId;
	player: PlayerId;
	to: string;
}

/** One AI player asks another for attack cooperation (Commands.js). */
interface EngineCommandAttackRequest
{
	type: "attack-request";
	/** Player id issuing the request (this player). */
	source: PlayerId;
	/** Player whose army should respond to the attack. */
	player: PlayerId;
}

/** Shared-dropsite toggle (ResourceDropsite.SetSharing) on `entities`. */
interface EngineCommandDropSiteSharing
{
	type: "set-dropsite-sharing";
	entities: EntityId[];
	/** Whether to share dropsite access or to stop sharing. */
	shared: boolean;
}

/** Rally point target payload for "set-rallypoint". */
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

/**
 * The wall-set template bundle a "construct-wall" command needs, from the
 * GUI wallslot bundle: the five piece templates plus overlap parameters.
 */
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

/** The list of entities most movement-production commands act on. */
interface EngineCommandEntityList
{
	entities: EntityId[];
}

/** Queued-order commands extending the entity list. */
interface EngineCommandQueued extends EngineCommandEntityList
{
	/** Appends the order after existing orders instead of replacing them. */
	queued?: boolean;
	/** Places the order at the front of the queue. */
	pushFront?: boolean;
}

/** Formation-choosing versions of queued orders; the unit's own default
 * formation is used by UnitAI when absent. */
interface EngineCommandWithFormation extends EngineCommandQueued
{
	formation?: string;
}

/** Queued order with explicit formation (the engine's "patrol" contract
 * in Commands.js). */
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

/**
 * Commands the simulation accepts via Engine.PostCommand, each dispatched by
 * the matching handler of `g_Commands` (helpers/Commands.js ProcessCommand).
 * Field names below are verified against those handlers where Petra relies on
 * them; unknown command types only log an engine error. Handlers validate the
 * rest of the fields at runtime (silently warning and no-op'ing on mismatch),
 * so declared fields mirror engine usage. Commands Petra does not send itself
 * (e.g. construct-wall) are kept because Petra's common-api Entity wrappers
 * issue them.
 */
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

/**
 * The AI script context's `Engine` object, as generated by CAIWorker::Init.
 * Registered C++ helpers; any member not listed here is simply absent
 * (`Engine.QueryInterface`, for instance, lives on `SimEngine`).
 */
declare const Engine: {
	/**
	 * Queue `command` to run for `player` on the following simulation turn
	 * (CAIWorker::PostCommand → ICmpCommandQueue). Invalid/unconfigured
	 * players are ignored with a LOGERROR. Dispatch rules, e.g. the derived
	 * `data.entities` filtering, follow helpers/Commands.js ProcessCommand.
	 */
	PostCommand(player: PlayerId, command: PetraEngineCommand): void;
	/**
	 * A complete XML template converted by CParamNode::ConstructJSVal:
	 * - child element nodes become nested objects;
	 * - attribute nodes become keys prefixed with `@` (leaf strings);
	 * - element text appears only as the `_string` string property on object
	 *   nodes;
	 * - childless nodes with plain text return that string value;
	 * - `undefined` when the template name does not exist (CParamNode(false)
	 *   maps to undefined); never `null` — the `null` appears only in
	 *   Petra's own sharedAI.GetTemplate cache, which converts a missing
	 *   template to `null`.
	 */
	GetTemplate(name: string): Record<string, unknown> | undefined;
	/**
	 * Requests process shutdown via main.cpp QuitEngine(exitStatus); the
	 * engine sets the shutdown flag, and the AI script simply returns.
	 */
	Exit(exitStatus: number): void;
	/**
	 * Profiling brackets for the AI script phases, visible in the engine
	 * profiler (CMicroprofiler).
	 */
	ProfileStart(name: string): void;
	ProfileStop(): void;
	/**
	 * Long pathfinder run between two world points with passability class
	 * mask `passabilityMask` (a combination of `state.passabilityClasses`
	 * values). Returns waypoints as Vector2D objects (x/y world metres)
	 * ordered goal-first: the search reconstructs the path in reverse
	 * (LongPathfinder.cpp), so `path[0]` neighbours the target while the
	 * final entry neighbours the start Petra began from.
	 */
	ComputePath(start: { x: number; y: number }, end: { x: number; y: number },
		passabilityMask: number): EnginePathPoint[];
	/**
	 * Debug-visualizes `data` (row-major, length width*height) as a PNG
	 * saved under `screenshots/aidump/name.png`; warns and skips when the
	 * data size mismatches or when `max` is 0 (values are normalized
	 * against it).
	 */
	DumpImage(name: string, data: ArrayLike<number>, width: number, height: number, max: number): void;
};

/**
 * Petra's `common-api/baseAI.js` defines this on `globalThis`; it is not an
 * engine global. It is initialized to -1 and reset by `BaseAI.Init` and
 * `BaseAI.HandleMessage`, so it never serves any player id other than the
 * currently-updating AI player at the time each of these handlers runs.
 */
declare var PlayerID: PlayerId;

/**
 * The simulation scripts' global object, copied via `SetGlobal("Sim", …)`
 * in CAIWorker::Init. Only the members Petra uses are typed here; the global
 * also carries the remaining constants (`INVALID_ENTITY = 0`,
 * `INVALID_PLAYER = -1`, every `MT_*`, script-defined `IID_*`) and helper
 * classes. All `IID_*` constants are plain integers — neither
 * ComponentManager.cpp SetGlobal site ever produces strings.
 */
declare const Sim: {
	/** Fixed system-entity id (= 1); host of system components like the
	 * PlayerManager, the pathfinder, ModifiersManager and AIInterface. */
	SYSTEM_ENTITY: EntityId;
	/** Interface ids used by common-api and config.Cheat for QueryInterface. */
	IID_ModifiersManager: number;
	IID_UnitAI: number;
	IID_ResourceSupply: number;
	IID_ResourceGatherer: number;
	/**
	 * simulation/helpers/Requirements.js helper class evaluated in the
	 * simulation global scope, so `Sim.RequirementsHelper` reaches AI code
	 * too. Petra's common-api entity.js uses it to filter requirement-bound
	 * templates.
	 */
	RequirementsHelper: {
		/** AreRequirementsMet(requirements, player): `true` for empty
		 * requirement payloads, otherwise `AllRequirementsMet` against the
		 * player's TechnologyManager: `true`/`false` when present, and
		 * `undefined` when the player has no TechnologyManager (Gaia). */
		AreRequirementsMet(requirements: unknown, player: PlayerId): boolean | undefined;
	};
};

/**
 * The simulation scripts' native scope — the exact object the simulation
 * realm calls as `Engine`, holding CComponentManager's registered script
 * functions (QueryInterface, GetTemplate, PostMessage, …) plus
 * Profile[Start|Stop]. Petra reaches it for component queries: the common-api
 * Entity wrappers fetch UnitAI order data through it, and config.Cheat
 * installs the AI difficulty modifiers with it.
 */
declare const SimEngine: {
	/**
	 * CComponentManager::QueryInterface → IComponent scripting mode. Returns:
	 * - the scripted component instance object for JS component interfaces
	 *   (their prototype methods are directly on it, e.g.
	 *   `AddModifiers` below);
	 * - `null` when no component implements the interface id on the entity
	 *   (QueryInterface hit nothing);
	 * - `undefined` (with an engine-side LOGERROR) when the interface has no
	 *   scriptable instance at all.
	 * Petra's single call site (config.Cheat) queries the system entity, so
	 * it never observes `null`/`undefined` in practice.
	 */
	QueryInterface(entity: EntityId, interfaceId: number): {
		/**
		 * ModifiersManager.AddModifiers: attaches the modifier set `modifiers`
		 * (template paths → modifier lists) under identity `name`, applying to
		 * the entity `entity` (a list is possible engine-side but Petra does not
		 * need one). Per-player modifiers must use the player ENTITY id (what
		 * ModifiersManager.ApplyModifiers looks up via GetPlayerByID(owner));
		 * a bare player id does not address the player entity and such
		 * modifiers never apply. `stackable` defaults to false.
		 */
		AddModifiers(name: string, modifiers: Record<string, unknown>, entity?: EntityId, stackable?: boolean): void;
	};
};

/** Mark a string for translation lookup. */
declare function markForTranslation(message: string): string;
/** Deep-clone a value without preserving object identity. */
declare function clone<T>(value: T): T;
/** Serialize a value into a string representation for debugging. */
declare function uneval(value: unknown): string;
/** Log a scripted warning (LOGWARNING in scriptinterface/Interface.cpp). */
declare function warn(message: string): void;
/** Log a scripted error to the engine log (LOGERROR); returns, does not throw. */
declare function error(message: string): void;
