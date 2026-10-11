declare global
{
/** Extends Math with geometry helpers. */
	interface Math
	{
/** Squares a number. */
		square(value: number): number;
/** Represents the int Pow. */
		intPow(x: number, y: number): number;
/** Computes the squared 2D Euclidean distance. */
		euclidDistance2DSquared(x1: number, y1: number, x2: number, y2: number): number;
/** Represents the euclid Distance2 D. */
		euclidDistance2D(x1: number, y1: number, x2: number, y2: number): number;
/** Computes the squared 3D Euclidean distance. */
		euclidDistance3DSquared(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
/** Represents the euclid Distance3 D. */
		euclidDistance3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
/** Clamps a value to a range. */
		clamp(value: number, min: number, max: number): number;
	}

	type IdentityTemplate = {
		Classes?: { _string?: string };
		VisibleClasses?: { _string?: string };
		Rank?: string;
		[key: string]: unknown;
	};

	type TechnologyModification = {
		affects?: string | string[] | string[][];
		add?: number;
		multiply?: number;
		replace?: string | number;
		tokens?: string;
		[key: string]: unknown;
	};

	type TechnologyRequirements = Array<{
		techs?: string[];
		entities?: Array<{ class: string; number: number; check: "count" | "variants" }>;
	}>;

	type FSMMessage = { type: string; [key: string]: unknown };
	type FSMHandler<T = unknown> = (this: T, message: FSMMessage) => unknown;
	type FSMStateSpec<T = unknown> = {
		[key: string]: FSMHandler<T> | FSMStateSpec<T> | string;
	};

/** Represents an object managed by an FSM. */
	interface FSMObject
	{
		fsmStateName: string;
		fsmNextState: string | undefined;
/** Represents the Fsm State Name Changed. */
		FsmStateNameChanged(name: string): void;
	}

/** Describes a resource definition from the game data. */
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

/** Exposes resource metadata and lookup helpers. */
	interface Resources
	{
/** Gets the available resources. */
		GetResources(): ResourceData[];
/** Gets a resource definition by type. */
		GetResource(type: string): ResourceData | undefined;
/** Gets all resource codes. */
		GetCodes(): string[];
/** Gets the barterable resource codes. */
		GetBarterableCodes(): string[];
/** Gets the tradable resource codes. */
		GetTradableCodes(): string[];
/** Gets the tributable resource codes. */
		GetTributableCodes(): string[];
/** Gets the resource names. */
		GetNames(): Record<string, string>;
	}

/** Stores template data for gameplay modifications. */
	interface ModificationTemplates
	{
/** Gets the resource names. */
		GetNames(): string[];
/** Checks whether  exists. */
		Has(name: string): boolean;
/** Gets the . */
		Get(name: string): Record<string, unknown> | undefined;
/** Gets all entries for this collection. */
		GetAll(): Record<string, Record<string, unknown>>;
	}

/** Stores one entry in a multi-key map. */
	interface MultiKeyMapEntry<T = unknown>
	{
		_ID: string;
		_count: number;
		value: T;
	}

/** Represents a 2D position-like value. */
	interface Vector2DLike
	{
		x: number;
		y: number;
	}

/** Represents a 3D position-like value. */
	interface Vector3DLike
	{
		x: number;
		y: number;
		z: number;
	}

/** Two-dimensional vector math utilities. */
	interface Vector2D extends Vector2DLike
	{
/** Clones the object. */
		clone(): Vector2D;
/** Sets the . */
		set(x: number, y: number): this;
/** Copies the values from another vector. */
		setFrom(vector: Vector2DLike): this;
/** Adds . */
		add(vector: Vector2DLike): this;
/** Represents the sub. */
		sub(vector: Vector2DLike): this;
/** Represents the mult. */
		mult(factor: number): this;
/** Divides the value by a scalar. */
		div(factor: number): this;
/** Represents the normalize. */
		normalize(): this;
/** Rotates the vector by an angle. */
		rotate(angle: number): this;
/** Represents the rotate Around. */
		rotateAround(angle: number, center: Vector2DLike): this;
/** Rounds the vector components. */
		round(): this;
/** Represents the floor. */
		floor(): this;
/** Rounds the vector components to a precision. */
		toFixed(digits: number): this;
/** Represents the perpendicular. */
		perpendicular(): Vector2D;
/** Computes the dot product. */
		dot(vector: Vector2DLike): number;
/** Represents the cross. */
		cross(vector: Vector2DLike): number;
/** Gets the squared length. */
		lengthSquared(): number;
/** Represents the length. */
		length(): number;
/** Compares the length with another vector. */
		compareLength(vector: Vector2DLike): number;
/** Represents the distance To Squared. */
		distanceToSquared(vector: Vector2DLike): number;
/** Gets the distance to another point. */
		distanceTo(vector: Vector2DLike): number;
/** Represents the angle To. */
		angleTo(vector: Vector2DLike): number;
/** Interpolates between two vectors. */
		lerp(vector: Vector2DLike, t: number): Vector2D;
	}

/** Constructs and transforms 2D vectors. */
	interface Vector2DConstructor
	{
/** Creates a new instance. */
		new(x?: number, y?: number): Vector2D;
/** Represents the from3 D. */
		from3D(vector: Vector3DLike): Vector2D;
/** Adds another map or influence layer. */
		add(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Represents the sub. */
		sub(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Represents the is Equal To. */
		isEqualTo(a: Vector2DLike, b: Vector2DLike): boolean;
/** Represents the mult. */
		mult(vector: Vector2DLike, factor: number): Vector2D;
/** Divides the value by a scalar. */
		div(vector: Vector2DLike, factor: number): Vector2D;
/** Represents the min. */
		min(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Represents the max. */
		max(a: Vector2DLike, b: Vector2DLike): Vector2D;
/** Represents the average. */
		average(vectors: Vector2DLike[]): Vector2D;
/** Gets the sum of multiple vectors. */
		sum(vectors: Vector2DLike[]): Vector2D;
/** Represents the dot. */
		dot(a: Vector2DLike, b: Vector2DLike): number;
	}

/** Three-dimensional vector math utilities. */
	interface Vector3D extends Vector3DLike
	{
/** Clones the object. */
		clone(): Vector3D;
/** Sets the . */
		set(x: number, y: number, z: number): this;
/** Adds another map or influence layer. */
		add(vector: Vector3DLike): this;
/** Represents the sub. */
		sub(vector: Vector3DLike): this;
/** Multiplies the value by a scalar. */
		mult(factor: number): this;
/** Represents the div. */
		div(factor: number): this;
/** Normalizes the vector. */
		normalize(): this;
/** Represents the round. */
		round(): this;
/** Rounds the vector components down. */
		floor(): this;
/** Represents the to Fixed. */
		toFixed(digits: number): this;
/** Computes the dot product. */
		dot(vector: Vector3DLike): number;
/** Represents the cross. */
		cross(vector: Vector3DLike): Vector3D;
/** Gets the squared length. */
		lengthSquared(): number;
/** Represents the length. */
		length(): number;
/** Compares the length with another vector. */
		compareLength(vector: Vector3DLike): number;
/** Represents the distance To Squared. */
		distanceToSquared(vector: Vector3DLike): number;
/** Gets the distance to another point. */
		distanceTo(vector: Vector3DLike): number;
/** Represents the horiz Distance To Squared. */
		horizDistanceToSquared(vector: Vector3DLike): number;
/** Gets the horizontal distance to another point. */
		horizDistanceTo(vector: Vector3DLike): number;
/** Represents the horiz Angle To. */
		horizAngleTo(vector: Vector3DLike): number;
	}

/** Constructs and transforms 3D vectors. */
	interface Vector3DConstructor
	{
/** Creates a new instance. */
		new(x?: number, y?: number, z?: number): Vector3D;
/** Adds . */
		add(a: Vector3DLike, b: Vector3DLike): Vector3D;
/** Represents the sub. */
		sub(a: Vector3DLike, b: Vector3DLike): Vector3D;
/** Checks whether two vectors are equal. */
		isEqualTo(a: Vector3DLike, b: Vector3DLike): boolean;
/** Multiplies the value by a scalar. */
		mult(vector: Vector3DLike, factor: number): Vector3D;
/** Represents the div. */
		div(vector: Vector3DLike, factor: number): Vector3D;
	}

/** Lists attack effects and their target receivers. */
	class AttackEffects
	{
/** Initializes the object. */
		constructor();
		Receivers(): Array<{ type: string; IID: string; method: string }>;
	}

/** Looks up damage type metadata and sorting rules. */
	class DamageTypesMetadata
	{
/** Initializes the object. */
		constructor();
/** Represents the sort. */
		sort(damageTypes: string[]): string[];
/** Gets the formatted name for a damage type. */
		getName(code: string): string;
	}

/** Uses the null formation sentinel. */
	const NULL_FORMATION: "special/formations/null";

/** Runs a small state machine for AI decisions. */
	class FSM
	{
/** Initializes the object. */
		constructor(spec: FSMStateSpec<FSMObject>);
/** Initializes the state machine for an object. */
		Init(object: FSMObject, initialState: string): void;
/** Sets the next state for an object. */
		SetNextState(object: FSMObject, state: string): void;
/** Processes a message in the state machine. */
		ProcessMessage(object: FSMObject, message: FSMMessage): unknown;
/** Defers a message for later processing. */
		DeferMessage(object: FSMObject, message: FSMMessage): void;
/** Looks up a state by name. */
		LookupState(currentStateName: string, stateName: string): string;
/** Gets the current FSM state. */
		GetCurrentState(object: FSMObject): string;
/** Switches to the next state. */
		SwitchToNextState(object: FSMObject, nextStateName: string): void;
	}

/** Stores template data for gameplay modifications. */
	class ModificationTemplates
	{
/** Initializes the object. */
		constructor(path: string);
		names: string[];
		templates: Record<string, Record<string, unknown>>;
	}

/** Represents the Modification Schema. */
	const ModificationSchema: string;
/** Represents the Modifications Schema. */
	const ModificationsSchema: string;
/** Loads the available modification templates. */
	function LoadModificationTemplates(): void;
/** Derives Modifications From Tech. */
	function DeriveModificationsFromTech(techTemplate: Record<string, unknown>): Record<string, TechnologyModification[]>;
/** Derives modifications from a technology list. */
	function DeriveModificationsFromTechnologies(technologies: Record<string, unknown>[]): Record<string, TechnologyModification[]>;
/** Derives Modification From XML Template. */
	function DeriveModificationFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;
/** Derives modifications from XML template data. */
	function DeriveModificationsFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;

/** Stores values keyed by multiple dimensions. */
	class MultiKeyMap<T = unknown>
	{
/** Initializes the object. */
		constructor();
		items: Map<unknown, Map<unknown, MultiKeyMapEntry<T>[]>>;
/** Serializes the object state. */
		Serialize(): Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>;
/** Represents the Deserialize. */
		Deserialize(data: Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>): void;
/** Adds an item for the given keys. */
		AddItem(primaryKey: string, itemID: string, item: T, secondaryKey: unknown, stackable?: boolean): boolean;
/** Adds Items. */
		AddItems(itemID: string, items: Record<string, T>, secondaryKey: unknown, stackable?: boolean): boolean;
/** Removes an item for the given keys. */
		RemoveItem(primaryKey: string, itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
/** Removes All Items. */
		RemoveAllItems(itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
/** Checks whether an item exists for the given keys. */
		HasItem(primaryKey: string, itemID: string, secondaryKey: unknown): boolean;
/** Checks whether Any Item exists. */
		HasAnyItem(itemID: string, secondaryKey: unknown): boolean;
/** Gets the entries for a primary key. */
		GetItems(primaryKey: string, secondaryKey: unknown): MultiKeyMapEntry<T>[];
/** Gets the All Items. */
		GetAllItems(secondaryKey: unknown): Record<string, MultiKeyMapEntry<T>[]>;
	}

/** Exposes resource metadata and lookup helpers. */
	const Resources: Resources;

/** Provides status-effect metadata and tooltips. */
	class StatusEffectsMetadata
	{
/** Initializes the object. */
		constructor();
/** Gets the Data. */
		getData(code: string): {
			applierTooltip?: string;
			code?: string;
			icon?: string;
			statusName?: string;
			receiverTooltip?: string;
		};
/** Gets the applier tooltip for a status effect. */
		getApplierTooltip(code: string): string | undefined;
/** Gets the Icon. */
		getIcon(code: string): string | undefined;
/** Gets the formatted name for a damage type. */
		getName(code: string): string | undefined;
/** Gets the Receiver Tooltip. */
		getReceiverTooltip(code: string): string | undefined;
	}

/** Applies technology modifiers to a property value. */
	function GetTechModifiedProperty(
		modifications: TechnologyModification[],
		classes: string[] | string | undefined,
		originalValue: unknown): unknown;
/** Applies generic technology modifiers to a value. */
	function GetTechModifiedProperty_generic(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: unknown): unknown;
/** Gets the Tech Modified Property numeric. */
	function GetTechModifiedProperty_numeric(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: number): number;
/** Applies string technology modifiers to a value. */
	function GetTechModifiedProperty_string(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: string): string;
/** Represents the Does Modification Apply. */
	function DoesModificationApply(modification: TechnologyModification, classes: string[] | string | undefined): boolean;
/** Expands tokens in a string value. */
	function HandleTokens(originalValue: string, modification: string): string;
/** Derives Technology Requirements. */
	function DeriveTechnologyRequirements(template: Record<string, unknown>, civ: string | undefined): TechnologyRequirements | false;
/** Interprets a technology requirement operator and value. */
	function InterpretTechRequirements(civ: string | null | undefined, operator: string, value: unknown): TechnologyRequirements | false;
/** Represents the Unravel Phases. */
	function UnravelPhases(phases: Record<string, { reqs: Array<{ techs?: string[] }>; replaces?: string[] }>): string[];

/** Loads civilization files for the current game data. */
	function loadCivFiles(selectableOnly: boolean): Record<string, Record<string, unknown>>;
/** Gets the Identity Classes. */
	function GetIdentityClasses(template: IdentityTemplate): string[];
/** Gets the visible identity classes from a template. */
	function GetVisibleIdentityClasses(template: IdentityTemplate): string[];
/** Represents the Matches Class List. */
	function MatchesClassList(
		classes: string[] | undefined,
		match: string | Array<string | string[]> | undefined): boolean | undefined;
/** Reads a numeric template value from a path. */
	function GetBaseTemplateDataValue(template: Record<string, unknown>, valuePath: string, defaultValue?: number): number;
/** Gets the Modified Template Data Value. */
	function GetModifiedTemplateDataValue(
		template: Record<string, unknown>,
		valuePath: string,
		modKey: string | null | undefined,
		player: number | null | undefined,
		modifiers?: Record<string, TechnologyModification[]>,
		defaultValue?: number): number;
/** Builds template data for the AI helper context. */
	function GetTemplateDataHelper(
		template: Record<string, unknown>,
		player: number | null | undefined,
		auraTemplates: Record<string, Record<string, unknown>> | undefined,
		resources: Resources,
		modifiers?: Record<string, TechnologyModification[]>): Record<string, unknown>;
/** Builds the basic technology helper data. */
	function GetTechnologyBasicDataHelper(template: Record<string, unknown>, civ: string | null | undefined): Record<string, unknown>;
/** Gets the Technology Data Helper. */
	function GetTechnologyDataHelper(template: Record<string, unknown>, civ: string | null | undefined, resources: Resources): Record<string, unknown>;
/** Builds aura helper data for a template. */
	function GetAuraDataHelper(template: Record<string, unknown>): Record<string, unknown>;
/** Calculates Carried Resources. */
	function calculateCarriedResources(
		carriedResources?: Array<{ type: string; amount: number }>,
		tradingGoods?: {
			type: string;
			amount?: { traderGain?: number; market1Gain?: number; market2Gain?: number };
		}): Record<string, number>;
/** Removes template filters from a template name. */
	function removeFiltersFromTemplateName(templateName: string): string;

/** Normalizes trade gain values for map size. */
	function TradeGainNormalization(mapSize: number): number;
/** Represents the Trade Gain. */
	function TradeGain(distanceSquared: number, mapSize: number): number;

/** Stores weighted items and picks random entries. */
	class WeightedList<T = unknown>
	{
/** Initializes the object. */
		constructor();
		elements: Map<T, number>;
		totalWeight: number;
/** Gets the length. */
		length(): number;
/** Represents the push. */
		push(item: T, weight?: number): void;
/** Removes . */
		remove(item: T): void;
/** Represents the random Item. */
		randomItem(): T | undefined;
	}

/** Interpolates a value with cubic smoothing. */
	function cubicInterpolation(tension: number, x: number, p0: number, p1: number, p2: number, p3: number): number;
/** Represents the bicubic Interpolation. */
	function bicubicInterpolation(
		position: Vector2DLike,
		p00: number, p01: number, p02: number, p03: number,
		p10: number, p11: number, p12: number, p13: number,
		p20: number, p21: number, p22: number, p23: number,
		p30: number, p31: number, p32: number, p33: number): number;

/** Generates a random 2D normal vector. */
	function randomNormal2D(): [number, number];
/** Represents the pick Random. */
	function pickRandom<T>(source: readonly T[]): T | undefined;
/** Generates a random float in a range. */
	function randFloat(min: number, max: number): number;
/** Represents the rand Int Inclusive. */
	function randIntInclusive(min: number, max: number): number;
/** Generates a random integer in an exclusive range. */
	function randIntExclusive(min: number, max: number): number;
/** Represents the rand Bool. */
	function randBool(probability?: number): boolean;
/** Generates a random angle in radians. */
	function randomAngle(): number;

/** Shuffles an array copy. */
	function shuffleArray<T>(source: readonly T[]): T[];
/** Represents the heaps Permute. */
	function heapsPermute<T>(array: T[], cloneFunc: (item: T) => T, callback: (permutation: T[]) => void): void;
/** Checks whether two values are deeply equal. */
	function deepCompare(first: unknown, second: unknown): boolean;
/** Represents the basename. */
	function basename(path: string): string | undefined;
/** Gets the parent directory of a file path. */
	function dirname(path: string): string;
/** Represents the list Files. */
	function listFiles(path: string, extension: string, recurse: boolean): string[];
/** Builds the Cartesian product of arrays. */
	function cartesianProduct<T>(arrays: readonly (readonly T[])[]): T[][];

/** Two-dimensional vector math utilities. */
	const Vector2D: Vector2DConstructor;
/** Represents the Vector3 D. */
	const Vector3D: Vector3DConstructor;

/** Represents the global. */
	const global: {
		AuraTemplates?: ModificationTemplates;
		TechnologyTemplates?: ModificationTemplates;
	};
}

export {};
