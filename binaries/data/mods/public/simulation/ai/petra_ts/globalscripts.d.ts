// Type declarations for the engine's global scripts
// (binaries/data/mods/public/globalscripts/*.js).
//
// The AI worker script context loads these files at startup
// (CAIWorker::Init -> ScriptInterface::LoadGlobalScripts), exactly like the
// simulation and GUI contexts, so all of the declarations below are available
// as plain globals inside the AI. The AI receives the SAME definitions as
// every other script context, including deterministic overrides of several
// Math functions (see the `Math` interface below).
//
// Every declaration here was verified against the corresponding source file;
// the comments state the runtime behaviour rather than paraphrasing names.

declare global
{
/**
 * Extension of the standard `Math` object installed by globalscripts/Math.js.
 *
 * IMPORTANT for AI code: Math.js *replaces* the engine's native cos, sin,
 * atan, atan2, pow, exp and log with deterministic JS approximations. This
 * makes all JS(schema) scripts produce bit-identical results across platforms
 * and rejoins (rejoin/Out-of-sync safety); precision of the approximations is
 * roughly double-precision. acos, asin and tan have no portable implementation
 * and are stubs that log an error and return undefined. The helpers below
 * (square, intPow, euclid*, clamp) are additions on top of that.
 */
	interface Math
	{
/** Deterministic square: simply `value * value` (avoids the slower Math.pow). */
		square(value: number): number;
/** X raised to a positive integer exponent by binary exponentiation; handles infinite exponents and x of |1|. */
		intPow(x: number, y: number): number;
/** Squared Euclidean distance in 2D, `(x2-x1)² + (y2-y1)²`; faster than Math.hypot and preserves determinism. */
		euclidDistance2DSquared(x1: number, y1: number, x2: number, y2: number): number;
/** Euclidean distance in 2D (`sqrt` of `euclidDistance2DSquared`); can be faster than Math.hypot. */
		euclidDistance2D(x1: number, y1: number, x2: number, y2: number): number;
/** Squared Euclidean distance in 3D. */
		euclidDistance3DSquared(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
/** Euclidean distance in 3D. */
		euclidDistance3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
/** Clamps `value` into the closed interval `[min, max]`. */
		clamp(value: number, min: number, max: number): number;
	}

/** Structural subset of an entity template's `<Identity>` node used by the class helpers of Templates.js. */
	type IdentityTemplate = {
		Classes?: { _string?: string };
		VisibleClasses?: { _string?: string };
		Rank?: string;
		[key: string]: unknown;
	};

/**
 * One entry of a tech/aura `modifications` array after path resolution.
 * `affects` is the class-match specification (space-separated string, or the
 * nested-array form produced by DeriveModificationsFromTech where each
 * element is a list of AND-ed class tokens); the other keys are the numeric
 * / string operations understood by GetTechModifiedProperty, plus any extra
 * fields the modification carried.
 */
	type TechnologyModification = {
		affects?: string | string[] | string[][];
		add?: number;
		multiply?: number;
		replace?: string | number;
		tokens?: string;
		[key: string]: unknown;
	};

/**
 * Technology/aura research requirement list as computed by
 * DeriveTechnologyRequirements / InterpretTechRequirements: an OR-list of
 * prerequisites, each either a list of prerequisite tech names or a list of
 * required entity classes (`check` distinguishes counting units from counting
 * distinct variants). `false` replaces the list when the requirement can
 * never be met by the given civ.
 */
	type TechnologyRequirements = Array<{
		techs?: string[];
		entities?: Array<{ class: string; number: number; check: "count" | "variants" }>;
	}>;

/** A message passed to FSM.ProcessMessage / handler functions. */
	type FSMMessage = { type: string; [key: string]: unknown };
/** A message handler function of an FSM spec. */
	type FSMHandler<T = unknown> = (this: T, message: FSMMessage) => unknown;
/**
 * One node of an FSM spec: message handlers keyed by message type plus the
 * special "enter"/"leave" transition hooks and "_name"/"_parent" metadata.
 * State names may only contain the characters A-Z, joined with "." for
 * sub-states (see globalscripts/FSM.js and UnitAI.js for the full syntax).
 */
	type FSMStateSpec<T = unknown> = {
		[key: string]: FSMHandler<T> | FSMStateSpec<T> | string;
	};

/**
 * The bookkeeping an FSM keeps on the managed object itself
 * (FSM.Init sets both fields; the `FsmStateNameChanged` callback is invoked
 * by FSM.SwitchToNextState whenever a transition is aborted by a hook).
 */
	interface FSMObject
	{
/** Always up-to-date name of the innermost state the object is in. */
		fsmStateName: string;
/** Queued next state (set by handlers calling FSM.SetNextState); undefined when no transition is pending. */
		fsmNextState: string | undefined;
/** Called when an enter/leave hook interrupts a state transition. */
		FsmStateNameChanged(name: string): void;
	}

/**
 * One entry of simulation/data/resources/*.json, sorted by `order`, with
 * `code`/`name` plus optional subtypes and property tags ("barterable",
 * "tradable", "tributable", "aiAnalysisInfluenceGroup", ...).
 */
	interface ResourceData
	{
		code: string;
		name: string;
		order: number;
		subtypes?: Record<string, string>;
		properties?: string[];
		aiAnalysisInfluenceGroup?: string;
		[key: string]: unknown;
	}

/** Instance of the global `Resources` singleton below (globalscripts/Resources.js). */
	interface Resources
	{
/** All resource definitions from simulation/data/resources/, sorted by `order`. */
		GetResources(): ResourceData[];
/** Definition of a single resource by its code, or undefined for unknown codes. */
		GetResource(type: string): ResourceData | undefined;
/** Base resource codes ("food", "wood", ...) in their defined sort order. */
		GetCodes(): string[];
/** Resource codes flagged as barterable in their JSON definition. */
		GetBarterableCodes(): string[];
/** Resource codes flagged as tradable. */
		GetTradableCodes(): string[];
/** Resource codes flagged as tributable. */
		GetTributableCodes(): string[];
/** Mapping from resource code (and each resource's subtypes) to human-readable display name. */
		GetNames(): Record<string, string>;
	}

/**
 * One stored item of a MultiKeyMap. `_count` implements stacking: adding the
 * same (primaryKey, itemID, secondaryKey) tuple repeatedly increments it.
 */
	interface MultiKeyMapEntry<T = unknown>
	{
		_ID: string;
		_count: number;
		value: T;
	}

/** Structural stand-in for a {x, y} value; Vector2D methods accept these. */
	interface Vector2DLike
	{
		x: number;
		y: number;
	}

/** Structural stand-in for a {x, y, z} value; Vector3D methods accept these. */
	interface Vector3DLike
	{
		x: number;
		y: number;
		z: number;
	}

/**
 * Instance type of the global `Vector2D` constructor (globalscripts/vector.js).
 * Mutating methods (`set`, `add`, `sub`, `mult`, ..., including `toFixed`)
 * modify the vector in place and return `this` for chaining; methods listed
 * as returning `Vector2D` (`clone`, `perpendicular`, `lerp`) return a NEW
 * vector and leave `this` untouched.
 */
	interface Vector2D extends Vector2DLike
	{
/** Copies the values into a new vector. */
		clone(): Vector2D;
/** Overwrites both components and returns the same vector. */
		set(x: number, y: number): this;
/** Copies the components of `vector` into this vector. */
		setFrom(vector: Vector2DLike): this;
/** Adds `vector` in place. */
		add(vector: Vector2DLike): this;
/** Subtracts `vector` in place. */
		sub(vector: Vector2DLike): this;
/** Multiplies both components by `factor` in place. */
		mult(factor: number): this;
/** Divides both components by `factor` in place. */
		div(factor: number): this;
/** Scales to unit length in place; a zero vector is left unchanged (division by zero is avoided). */
		normalize(): this;
/** Rotates the vector by `angle` radians anti-clockwise, in place. */
		rotate(angle: number): this;
/** Rotates the vector by `angle` radians anti-clockwise around `center`, in place. */
		rotateAround(angle: number, center: Vector2DLike): this;
/** Rounds both components (Math.round) in place. */
		round(): this;
/** Floors both components (Math.floor) in place. */
		floor(): this;
/** Rounds both components to `digits` decimals in place. */
		toFixed(digits: number): this;
/** Returns a new vector rotated 90° anti-clockwise ((-y, x)). */
		perpendicular(): Vector2D;
/** Scalar (dot) product with `vector`. */
		dot(vector: Vector2DLike): number;
/** Z-component of the cross product of two 2D vectors (`x1*y2 - y1*x2`); sign gives the relative orientation, magnitude the parallelogram area. */
		cross(vector: Vector2DLike): number;
/** Squared length of the vector. */
		lengthSquared(): number;
/** Length of the vector. */
		length(): number;
/** Sign of `this.lengthSquared() - vector.lengthSquared()`: -1, 0 or 1 (NaN when the lengths aren't comparable). */
		compareLength(vector: Vector2DLike): number;
/** Squared Euclidean distance to `vector`. */
		distanceToSquared(vector: Vector2DLike): number;
/** Euclidean distance to `vector`. */
		distanceTo(vector: Vector2DLike): number;
/** Angle (Math.atan2, radians, counter-clockwise from +y) from this vector to `vector`. */
		angleTo(vector: Vector2DLike): number;
/** Returns a NEW vector interpolated `t` of the way from this vector to `vector`. */
		lerp(vector: Vector2DLike, t: number): Vector2D;
	}

/** Class type of the global `Vector2D` (globalscripts/vector.js). */
	interface Vector2DConstructor
	{
/** Creates a vector with the given components (defaulting to 0, 0). */
		new(x?: number, y?: number): Vector2D;
/** Projects a 3D vector onto the game plane: returns (v.x, v.z) — y is dropped because 2D world coordinates use y for the up (z) axis. */
		from3D(vector: Vector3DLike): Vector2D;
/** Returns a new vector with the component-wise sum of `a` and `b`. */
		add(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Returns a new vector with the component-wise difference of `a` and `b`. */
		sub(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Loose equality (==) of the components of two vectors. */
		isEqualTo(a: Vector2DLike, b: Vector2DLike): boolean;
/** Returns a new vector scaled by `factor`. */
		mult(vector: Vector2DLike, factor: number): Vector2D;
/** Returns a new vector divided by `factor`. */
		div(vector: Vector2DLike, factor: number): Vector2D;
/** Returns a new vector with the component-wise minimum of `a` and `b`. */
		min(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Returns a new vector with the component-wise maximum of `a` and `b`. */
		max(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Returns a new vector holding the average (sum divided by the list length) of all given vectors. */
		average(vectors: Vector2DLike[]): Vector2D;
/** Returns a new vector holding the component-wise sum of all given vectors. */
		sum(vectors: Vector2DLike[]): Vector2D;
/** Scalar product of two vectors. */
		dot(a: Vector2DLike, b: Vector2DLike): number;
	}

/**
 * Instance type of the global `Vector3D` constructor (globalscripts/vector.js).
 * As with Vector2D, in-place methods return `this`; `clone`, `cross` and
 * `normalize`'s counterparts that build vectors return new ones. Note that in
 * the game's world coordinates the y component is the up axis.
 */
	interface Vector3D extends Vector3DLike
	{
/** Copies the values into a new vector. */
		clone(): Vector3D;
/** Overwrites all three components and returns the same vector. */
		set(x: number, y: number, z: number): this;
/** Adds `vector` in place. */
		add(vector: Vector3DLike): this;
/** Subtracts `vector` in place. */
		sub(vector: Vector3DLike): this;
/** Multiplies all components by `factor` in place. */
		mult(factor: number): this;
/** Divides all components by `factor` in place. */
		div(factor: number): this;
/** Scales to unit length in place. */
		normalize(): this;
/** Rounds all components in place. */
		round(): this;
/** Floors all components in place. */
		floor(): this;
/** Rounds all components to `digits` decimals in place. */
		toFixed(digits: number): this;
/** Scalar (dot) product with `vector`. */
		dot(vector: Vector3DLike): number;
/** Returns a NEW vector holding the cross product with `vector`. */
		cross(vector: Vector3DLike): Vector3D;
/** Squared length of the vector. */
		lengthSquared(): number;
/** Length of the vector. */
		length(): number;
/** Sign of the squared-length difference to `vector` (-1, 0, 1; NaN when not comparable). */
		compareLength(vector: Vector3DLike): number;
/** Squared 3D Euclidean distance to `vector`. */
		distanceToSquared(vector: Vector3DLike): number;
/** 3D Euclidean distance to `vector`. */
		distanceTo(vector: Vector3DLike): number;
/** Squared distance to `vector` using only the horizontal (x, z) components. */
		horizDistanceToSquared(vector: Vector3DLike): number;
/** Distance to `vector` using only the horizontal (x, z) components. */
		horizDistanceTo(vector: Vector3DLike): number;
/** Angle (radians) from this vector to `vector`, measured in the horizontal (x, z) plane. */
		horizAngleTo(vector: Vector3DLike): number;
	}

/** Class type of the global `Vector3D` (globalscripts/vector.js). */
	interface Vector3DConstructor
	{
/** Creates a vector with the given components (defaulting to 0, 0, 0). */
		new(x?: number, y?: number, z?: number): Vector3D;
/** Returns a new vector with the component-wise sum of `a` and `b`. */
		add(a: Vector3DLike, b: Vector3DLike): Vector3D;
/** Returns a new vector with the component-wise difference of `a` and `b`. */
		sub(a: Vector3DLike, b: Vector3DLike): Vector3D;
/** Loose equality (==) of the components of two vectors. */
		isEqualTo(a: Vector3DLike, b: Vector3DLike): boolean;
/** Returns a new vector scaled by `factor`. */
		mult(vector: Vector3DLike, factor: number): Vector3D;
/** Returns a new vector divided by `factor`. */
		div(vector: Vector3DLike, factor: number): Vector3D;
	}

/**
 * Global instance (created once at script load) holding the receivers listed
 * in simulation/data/attack_effects/*.json, sorted by their `order` field.
 */
	class AttackEffects
	{
		constructor();
/** The possible attack impact effects and the component interface ("IID", e.g. "IID_StatusEffectsReceiver") plus method name that receives each effect type. */
		Receivers(): Array<{ type: string; IID: string; method: string }>;
	}

/**
 * Global instance (created once at script load) caching the damage-type
 * metadata from simulation/data/damage_types/*.json. Damage types without a
 * JSON definition are still legal in-game (modding affordance).
 */
	class DamageTypesMetadata
	{
		constructor();
/**
 * Returns a sorted copy of `damageTypes`: first all types that have metadata,
 * in the order given by their `order` field, then all types without metadata
 * (preserving their relative input order).
 */
		sort(damageTypes: string[]): string[];
/** Human-readable name of the damage type; the code itself is returned when no metadata exists for it. */
		getName(code: string): string;
	}

/**
 * Value of the global `NULL_FORMATION` constant (globalscripts/Formation.js):
 * assigning this formation makes units act as individuals.
 */
	const NULL_FORMATION: "special/formations/null";

/**
 * Hierarchical finite-state machine runner (globalscripts/FSM.js), used by
 * e.g. UnitAI. The spec handed to the constructor maps message names and
 * hierarchical state names (A-Z words joined by "." only) to handler
 * functions; stateless ("default") handlers can be overridden per state, and
 * "enter"/"leave" hooks fire when a transition crosses that state's level.
 */
	class FSM
	{
/** Compiles the given spec into internal lookup tables. */
		constructor(spec: FSMStateSpec<FSMObject>);
/** Resets `object`'s FSM bookkeeping and enters `initialState` (running its enter hooks). */
		Init(object: FSMObject, initialState: string): void;
/** Queues `state` as the next state for `object`; the actual transition happens when the current handler returns to FSM.ProcessMessage. */
		SetNextState(object: FSMObject, state: string): void;
/**
 * Dispatches `message` to the handler for `object`'s current state (falling
 * back to default handlers), then performs any transition queued via
 * SetNextState. Returns the handler's return value, or undefined (with an
 * error logged) when no handler accepted the message type.
 */
		ProcessMessage(object: FSMObject, message: FSMMessage): unknown;
/** Re-dispatches `message` from the parent state of the state it was last handled in (used to forward unhandled sub-state messages). */
		DeferMessage(object: FSMObject, message: FSMMessage): void;
/** Resolves a (possibly dotted) relative state name against `currentStateName`. */
		LookupState(currentStateName: string, stateName: string): string;
/** Innermost state name `object` is currently in. */
		GetCurrentState(object: FSMObject): string;
/**
 * Performs the transition from the current state to `nextStateName` right
 * away: runs leave hooks bottom-up and enter hooks top-down over the states
 * between the two branches of the hierarchy; if any hook returns true the
 * remainder of the transition is aborted and `FsmStateNameChanged` is
 * notified instead. Transitioning to the current state still runs the
 * one-level leave/enter cycle.
 */
		SwitchToNextState(object: FSMObject, nextStateName: string): void;
	}

/**
 * Cache for aura or technology definition JSONs (created by
 * LoadModificationTemplates for global.AuraTemplates and
 * global.TechnologyTemplates). Never serialize instances: they depend on
 * disk reads and must be re-created on load, otherwise rejoined clients would
 * hold different objects and desync.
 */
	class ModificationTemplates
	{
/** Reads and caches every *.json below `path` (e.g. "simulation/data/auras/"). */
		constructor(path: string);
		names: string[];
		templates: Record<string, Record<string, unknown>>;
/** Names of the loaded definition files, without directory or ".json" suffix. */
		GetNames(): string[];
/** Whether an aura/technology definition with this name was loaded. */
		Has(name: string): boolean;
/** The parsed definition JSON for `name`, or undefined if not loaded. */
		Get(name: string): Record<string, unknown> | undefined;
/** All loaded definitions keyed by file name. */
		GetAll(): Record<string, Record<string, unknown>>;
	}

/** RelaxNG schema fragment for one in-template modification (Globalscripts/ModificationTemplates.js; used to validate entity XML). */
	const ModificationSchema: string;
/** Full RelaxNG schema (wrapping ModificationSchema) for a template's `<Modifiers>` block. */
	const ModificationsSchema: string;
/**
 * Instantiates global.AuraTemplates ("simulation/data/auras/") and
 * global.TechnologyTemplates ("simulation/data/technologies/"). Until this
 * runs, both globals are undefined.
 */
	function LoadModificationTemplates(): void;
/**
 * Turns one aura/technology template's `modifications` array into a mapping
 * from value path ("Health/Max", ...) to the list of modifications applying
 * to that path; missing `affects` matches every class. Returns an empty
 * object when the template has no modifications.
 */
	function DeriveModificationsFromTech(techTemplate: Record<string, unknown>): Record<string, TechnologyModification[]>;
/**
 * Combines DeriveModificationsFromTech over an array of aura/technology
 * template data. Templates whose `reqs` exists but is falsy (locked, e.g.
 * unresearched prerequisite chains in GUI summaries) are skipped; auras have
 * no `reqs` and always count.
 */
	function DeriveModificationsFromTechnologies(technologies: Record<string, unknown>[]): Record<string, TechnologyModification[]>;
/**
 * Builds a single value-path keyed modification set from an entity template's
 * modification XML node (`Paths`, `Affects`, `Add`/`Multiply`/`Replace`),
 * coercing Add/Multiply values with unary +.
 */
	function DeriveModificationFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;
/** DeriveModificationFromXMLTemplate combined over several templates' modification nodes. */
	function DeriveModificationsFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;

/**
 * Global 3-tuple keyed store (globalscripts/MultiKeyMap.js), used by
 * ModifiersManager to hold modifiers by (property path, entity, item ID).
 * Returns of list getters are live references and must be treated as
 * read-only; the boolean results mean "cached derived values may need
 * recomputation".
 */
	class MultiKeyMap<T = unknown>
	{
		constructor();
		items: Map<unknown, Map<unknown, MultiKeyMapEntry<T>[]>>;
/** Round-trips the whole store to a plain nested array structure (arrays of [primaryKey, [secondaryKey, entries]] pairs). */
		Serialize(): Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>;
/** Restores the store from Serialize()'s output. */
		Deserialize(data: Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>): void;
/**
 * Adds one item under (primaryKey, itemID, secondaryKey); re-adding the same
 * IDs only bumps the entry's `_count` (stacking). Returns true if the stored
 * value list changed in a way that invalidates caches (`stackable` matters
 * for the stacked case).
 */
		AddItem(primaryKey: string, itemID: string, item: T, secondaryKey: unknown, stackable?: boolean): boolean;
/** AddItem for several primary keys at once, keyed by `items`; true if anything changed. */
		AddItems(itemID: string, items: Record<string, T>, secondaryKey: unknown, stackable?: boolean): boolean;
/** Decrements the stack for (primaryKey, itemID, secondaryKey) and deletes empty groups; true if the store changed. */
		RemoveItem(primaryKey: string, itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
/** RemoveItem over every primary key for the given itemID; true if any store changed. */
		RemoveAllItems(itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
/** Whether at least one entry exists for (primaryKey, itemID, secondaryKey). */
		HasItem(primaryKey: string, itemID: string, secondaryKey: unknown): boolean;
/** Whether any entry with that itemID exists for `secondaryKey`, under any primary key. */
		HasAnyItem(itemID: string, secondaryKey: unknown): boolean;
/** Entries stored under (primaryKey, secondaryKey); an empty array when none. */
		GetItems(primaryKey: string, secondaryKey: unknown): MultiKeyMapEntry<T>[];
/** All entries for `secondaryKey`, keyed by primary key (only keys that hold entries). */
		GetAllItems(secondaryKey: unknown): Record<string, MultiKeyMapEntry<T>[]>;
	}

/** Global Resources singleton (globalscripts/Resources.js), built once at script load from simulation/data/resources/*.json. */
	const Resources: Resources;

/**
 * Global instance (created once at script load) caching status-effect
 * metadata from simulation/data/status_effects/*.json.
 */
	class StatusEffectsMetadata
	{
		constructor();
/**
 * Full metadata for the status effect `code`. Known codes always carry all
 * five fields (missing JSON fields default to "", "default" or the code
 * itself); for an unknown code a warning is logged and an empty object is
 * returned, so treat the sub-fields as present-but-possibly-undefined.
 */
		getData(code: string): {
			applierTooltip?: string;
			code?: string;
			icon?: string;
			statusName?: string;
			receiverTooltip?: string;
		};
/** Tooltip shown to the entity applying the effect; undefined for unknown codes. */
		getApplierTooltip(code: string): string | undefined;
/** Icon path of the effect, defaulting to "default"; undefined for unknown codes. */
		getIcon(code: string): string | undefined;
/** Display name of the effect, defaulting to the code; undefined for unknown codes. */
		getName(code: string): string | undefined;
/** Tooltip shown on affected entities; undefined for unknown codes. */
		getReceiverTooltip(code: string): string | undefined;
	}

/**
 * Applies technology/aura modifications to one property value.
 * Dispatches on the type of `originalValue` (string -> string helper,
 * number -> numeric helper, anything else -> generic helper for Replace /
 * token modifications only); `classes` is the class list of the affected
 * template ("Unit"+!Hero" string form, or array/nested-array form).
 */
	function GetTechModifiedProperty(
		modifications: TechnologyModification[],
		classes: string[] | string | undefined,
		originalValue: unknown): unknown;
/** Generic variant: only `replace` and `tokens` operations are honoured. */
	function GetTechModifiedProperty_generic(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: unknown): unknown;
/** Numeric variant: the first applicable `replace` wins outright, otherwise the value becomes `originalValue * product(multiply) + sum(add)` (a warning is logged for unrecognised modification shapes). */
	function GetTechModifiedProperty_numeric(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: number): number;
/** String variant: first applicable `replace` wins, otherwise `tokens` operations are applied in modification order. */
	function GetTechModifiedProperty_string(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: string): string;
/** Whether a modification's `affects` specification matches a class list (an empty `affects` matches everything). */
	function DoesModificationApply(modification: TechnologyModification, classes: string[] | string | undefined): boolean;
/**
 * Rewrites a space-separated token string: tokens of `modification` are
 * appended, "-token" removes a token, and "old>new" renames one.
 */
	function HandleTokens(originalValue: string, modification: string): string;
/**
 * Computes the technology requirements of a template, taking its `supersedes`
 * chain into account. Returns false for requirements that can never be met
 * (chiefly a civ restriction failing for the given `civ`).
 */
	function DeriveTechnologyRequirements(template: Record<string, unknown>, civ: string | undefined): TechnologyRequirements | false;
/**
 * Interprets one requirement operator ("civ", "notciv", "entity", "tech",
 * "all", "any", "none", ...), where `value` is the operator's payload;
 * nested operators recurse. The result is the OR-list of prerequisite groups
 * or false (condition impossible for `civ`; civ-null checks are used to
 * compute the "any civ" wording in GUI code).
 */
	function InterpretTechRequirements(civ: string | null | undefined, operator: string, value: unknown): TechnologyRequirements | false;
/**
 * Orders the phase definitions of a mod into a research order: for each phase
 * with `reqs`/`replaces` mappings, returns the list of phase names such that
 * each phase comes after the phase it supersedes/requires.
 */
	function UnravelPhases(phases: Record<string, { reqs: Array<{ techs?: string[] }>; replaces?: string[] }>): string[];

/**
 * Reads every simulation/data/civs/*.json (selectable civs only when
 * `selectableOnly`), flattening the listed top-level properties and
 * validating their presence; returns civ data keyed by the JSON `Code`.
 * Handled by the GUI and data mods; scenario maps may add non-selectable
 * civs.
 */
	function loadCivFiles(selectableOnly: boolean): Record<string, Record<string, unknown>>;
/**
 * All identity classes of a template: the union of `Classes._string`,
 * `VisibleClasses._string`, and the template's `Rank`, as a token array,
 * or [] when none.
 */
	function GetIdentityClasses(template: IdentityTemplate): string[];
/** Classes from `VisibleClasses._string` only (the subset meant to be shown to the player), or []. */
	function GetVisibleIdentityClasses(template: IdentityTemplate): string[];
/**
 * Matches a class list against a match specification. `classes` is a token
 * array; `match` is either a string like "Class1 Class2+!Class3" (space = OR,
 * "+" = AND, "!" = NOT) or the equivalent nested-array form
 * [[Class1], [Class2, Class3]]. Returns true when any AND-group matches,
 * false when none does, and undefined (meaning "no constraint given") when
 * either argument is missing/empty — callers must treat undefined as true.
 */
	function MatchesClassList(
		classes: string[] | undefined,
		match: string | Array<string | string[]> | undefined): boolean | undefined;
/**
 * Reads `template[valuePath]` for a dotted path and coerces it with unary +.
 * Note the `||` semantics: a stored value of 0 falls back to `defaultValue`,
 * and a missing value with no default yields NaN.
 */
	function GetBaseTemplateDataValue(template: Record<string, unknown>, valuePath: string, defaultValue?: number): number;
/**
 * GetBaseTemplateDataValue plus tech modifications: when `player` is truthy
 * the engine's ApplyValueModificationsToTemplate is used for that player
 * (player 0/gaia and undefined fall back to the explicit `modifiers`
 * argument keyed by `modKey || valuePath`). The result is rounded away from
 * SpiderMonkey float noise via +toFixed(8).
 */
	function GetModifiedTemplateDataValue(
		template: Record<string, unknown>,
		valuePath: string,
		modKey: string | null | undefined,
		player: number | null | undefined,
		modifiers?: Record<string, TechnologyModification[]>,
		defaultValue?: number): number;
/**
 * Aggregates a full per-template data bag for the AI/GUI (same structure as
 * GetEntityState): identity, cost, speed, attack, armour, resources, auras and
 * technologies, with player-specific modifier application when `player` is
 * given. Keyed sub-objects pass through GetModifiedTemplateDataValue /
 * GetBaseTemplateDataValue; the returned structure mirrors what the GUI's
 * template helpers publish.
 */
	function GetTemplateDataHelper(
		template: Record<string, unknown>,
		player: number | null | undefined,
		auraTemplates: Record<string, Record<string, unknown>> | undefined,
		resources: Resources,
		modifiers?: Record<string, TechnologyModification[]>): Record<string, unknown>;
/** Technology data bag without resource/tooltip enrichment: generic, phases and requirements for `civ`. */
	function GetTechnologyBasicDataHelper(template: Record<string, unknown>, civ: string | null | undefined): Record<string, unknown>;
/** GetTechnologyBasicDataHelper plus localized name/tooltip/icon and cost data resolved against `resources`. */
	function GetTechnologyDataHelper(template: Record<string, unknown>, civ: string | null | undefined, resources: Resources): Record<string, unknown>;
/** Aura data bag: name, description, icon and effect range/duration fields for the aura template. */
	function GetAuraDataHelper(template: Record<string, unknown>): Record<string, unknown>;
/**
 * Amounts of each carried resource of an entity: `carriedResources` entries
 * are summed per type, and a trader's `tradingGoods` contribution adds
 * traderGain + market1Gain + market2Gain for its type. Zero amounts are kept
 * (the Object.value || 0 idiom means 0-valued entries survive).
 */
	function calculateCarriedResources(
		carriedResources?: Array<{ type: string; amount: number }>,
		tradingGoods?: {
			type: string;
			amount?: { traderGain?: number; market1Gain?: number; market2Gain?: number };
		}): Record<string, number>;
/** Strips a leading "filter|" prefix (mirage, corpse, etc.) from a template name: only the segment after the last "|" survives. */
	function removeFiltersFromTemplateName(templateName: string): string;

/**
 * Normalisation factor for trade gains as a function of map size: the pair
 * TradeGainNormalization(mapSize) * TradeGain(distanceSquared, mapSize) is
 * calibrated such that a route of 10000 distance-squared (= 100 m) on an
 * official size-1024 map yields the reference gain.
 */
	function TradeGainNormalization(mapSize: number): number;
/** Distance-dependent part of the trade gain: distanceSquared / (1 + 0.25 * sqrt(distanceSquared) / mapSize). */
	function TradeGain(distanceSquared: number, mapSize: number): number;

/**
 * Weighted random container (globalscripts/WeightedList.js). NOTE the
 * runtime quirk: `push` sets the item's weight via Map.set and then adds that
 * weight to `totalWeight` unconditionally, so re-pushing an already-stored
 * item inflates the stored total.
 */
	class WeightedList<T = unknown>
	{
		constructor();
		elements: Map<T, number>;
		totalWeight: number;
/** Number of stored items (distinct, not weight-summed). */
		length(): number;
/** Overwrites the weight of `item` (default 1) and adds it to totalWeight (see quirk above). */
		push(item: T, weight?: number): void;
/** Removes `item` if present, subtracting its old weight from totalWeight. */
		remove(item: T): void;
/** Uniform-randomly selects an item proportionally to the weights; undefined when the list is empty. */
		randomItem(): T | undefined;
	}

/** Cardinal/Catmull-Rom style cubic interpolation over four control points at parameter `x` in [0, 1], with `tension` controlling smoothing; used by camera paths. */
	function cubicInterpolation(tension: number, x: number, p0: number, p1: number, p2: number, p3: number): number;
/** Bicubic interpolation over a 4x4 grid of control points, evaluated at `position` (coordinates in [0, 1] within the cell); used by terrain height smoothing. */
	function bicubicInterpolation(
		position: Vector2DLike,
		p00: number, p01: number, p02: number, p03: number,
		p10: number, p11: number, p12: number, p13: number,
		p20: number, p21: number, p22: number, p23: number,
		p30: number, p31: number, p32: number, p33: number): number;

/**
 * Pair of independent standard-normal random numbers (zero mean, variance 1)
 * via the polar-rejection method.
 */
	function randomNormal2D(): [number, number];
/** Uniformly picks one element of `source`, or undefined when the array is empty. */
	function pickRandom<T>(source: readonly T[]): T | undefined;
/** Uniform random float in the half-open interval [min, max). */
	function randFloat(min: number, max: number): number;
/** Uniform random integer in [floor(min), ceil(max)]; non-integer endpoints cut off the distribution at that boundary. */
	function randIntInclusive(min: number, max: number): number;
/** Uniform random integer in [floor(min), ceil(max) - 1]; non-integer endpoints cut off the distribution likewise. */
	function randIntExclusive(min: number, max: number): number;
/** Bernoulli trial with success probability `p` (default 0.5). */
	function randBool(probability?: number): boolean;
/** Uniform random angle in [0, 2π). */
	function randomAngle(): number;

/**
 * Fisher-Yates ("inside-out") shuffle that returns a NEW array; the input is
 * never modified. An empty input yields an empty result.
 */
	function shuffleArray<T>(source: readonly T[]): T[];
/**
 * Runs `callback` on every permutation of `array` (B. R. Heap's algorithm);
 * the input array is modified in place and each callback receives a cloned
 * copy produced by `cloneFunc`.
 */
	function heapsPermute<T>(array: T[], cloneFunc: (item: T) => T, callback: (permutation: T[]) => void): void;
/** Structural deep equality of any two values (handles undefined, Sets, arrays, objects — more accurate than a JSON.roundtrip comparison). */
	function deepCompare(first: unknown, second: unknown): boolean;
/** Last "/"-separated segment of `path`. */
	function basename(path: string): string;
/** Everything before the last "/" in `path` ("" for a bare filename). */
	function dirname(path: string): string;
/**
 * Wrapper for Engine.ListDirectoryFiles(path, "*" + extension, recurse) that
 * strips BOTH the directory prefix and the trailing extension from every
 * returned name.
 */
	function listFiles(path: string, extension: string, recurse: boolean): string[];
/** Cartesian product of the given arrays, computed left to right. */
	function cartesianProduct<T>(arrays: readonly (readonly T[])[]): T[][];

/** Global Vector2D class (globalscripts/vector.js). */
	const Vector2D: Vector2DConstructor;
/** Global Vector3D class (globalscripts/vector.js). */
	const Vector3D: Vector3DConstructor;

/**
 * The engine's `global` script object. LoadModificationTemplates() assigns
 * these two caches, which hold every aura resp. technology definition:
 */
	const global: {
		AuraTemplates?: ModificationTemplates;
		TechnologyTemplates?: ModificationTemplates;
	};
}

export {};
