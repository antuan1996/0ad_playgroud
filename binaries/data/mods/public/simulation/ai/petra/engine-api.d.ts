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

/** Single point returned by the engine pathfinder. */
interface EnginePathPoint
{
	/** X-coordinate in world space. */
	x: number;
	/** Y-coordinate in world space. */
	y: number;
}

/** Chat command payload sent to the engine AI chat channel. */
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

/** Command payload that updates the shading color of selected entities. */
interface EngineCommandSetShadingColor
{
	/** The command kind. */
	type: "set-shading-color";
	/** Entity ids whose shading color should change. */
	entities: EntityId[];
	/** RGB color tuple in 0-255 ranges. */
	rgb: [number, number, number];
}

/** Command payload that updates trading goods for a market or trader. */
interface EngineCommandSetTradingGoods
{
	/** The command kind. */
	type: "set-trading-goods";
	/** Goods to set for the trader state. */
	tradingGoods: ResourceAmounts;
}

/** Command payload that requests a tribute transfer. */
interface EngineCommandTribute
{
	/** The command kind. */
	type: "tribute";
	/** Player receiving the tribute. */
	player: PlayerId;
	/** Resources to send. */
	amounts: ResourceAmounts;
}

/** Command payload that asks another player for tribute. */
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

/** Command payload for diplomacy messages or requests. */
interface EngineCommandDiplomacy
{
	/** The command kind. */
	type: "diplomacy" | "diplomacy-request";
	/** The player to which the diplomacy request applies. */
	player: PlayerId;
	/** Optional source player for a request event. */
	source?: PlayerId;
	/** Text or identifier describing the diplomacy action. */
	to: string;
}

/** Command payload requesting an attack order. */
interface EngineCommandAttackRequest
{
	/** The command kind. */
	type: "attack-request";
	/** Source player issuing the request. */
	source: PlayerId;
	/** Player whose army should attack. */
	player: PlayerId;
}

/** Command payload that toggles dropsite sharing for a set of entities. */
interface EngineCommandDropSiteSharing
{
	/** The command kind. */
	type: "set-dropsite-sharing";
	/** Entity ids affected by the setting. */
	entities: EntityId[];
	/** Whether the entities should share dropsite access. */
	shared: boolean;
}

/** Union of Petra engine commands accepted by the AI runtime. */
type PetraEngineCommand = EngineCommandChat | EngineCommandSetShadingColor |
	EngineCommandSetTradingGoods | EngineCommandTribute | EngineCommandTributeRequest | EngineCommandDiplomacy |
	EngineCommandAttackRequest | EngineCommandDropSiteSharing;

/** Engine runtime entry points exposed to Petra scripts. */
declare const Engine: {
	/** Submit a command to the engine for a specific player. */
	PostCommand(player: PlayerId, command: PetraEngineCommand): void;
	/** Start profiling a named section. */
	ProfileStart(name: string): void;
	/** Stop the active profile section. */
	ProfileStop(): void;
	/** Compute a path between two world points while respecting a passability mask. */
	ComputePath(start: { x: number; y: number }, end: { x: number; y: number },
		passabilityMask: number): EnginePathPoint[];
	/** Write an image frame to a file for debugging. */
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
};

/** Engine-side simulation query helpers used for modifiers. */
declare const SimEngine: {
	/** Query a component interface on an entity. */
	QueryInterface(entity: EntityId, interfaceId: string | number): {
		/** Add one or more modifiers to an entity. */
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
