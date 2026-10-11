declare global
{
	interface Math
	{
		square(value: number): number;
		intPow(x: number, y: number): number;
		euclidDistance2DSquared(x1: number, y1: number, x2: number, y2: number): number;
		euclidDistance2D(x1: number, y1: number, x2: number, y2: number): number;
		euclidDistance3DSquared(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
		euclidDistance3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number;
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

	interface FSMObject
	{
		fsmStateName: string;
		fsmNextState: string | undefined;
		FsmStateNameChanged(name: string): void;
	}

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

	interface Resources
	{
		GetResources(): ResourceData[];
		GetResource(type: string): ResourceData | undefined;
		GetCodes(): string[];
		GetBarterableCodes(): string[];
		GetTradableCodes(): string[];
		GetTributableCodes(): string[];
		GetNames(): Record<string, string>;
	}

	interface ModificationTemplates
	{
		GetNames(): string[];
		Has(name: string): boolean;
		Get(name: string): Record<string, unknown> | undefined;
		GetAll(): Record<string, Record<string, unknown>>;
	}

	interface MultiKeyMapEntry<T = unknown>
	{
		_ID: string;
		_count: number;
		value: T;
	}

	interface Vector2DLike
	{
		x: number;
		y: number;
	}

	interface Vector3DLike
	{
		x: number;
		y: number;
		z: number;
	}

	interface Vector2D extends Vector2DLike
	{
		clone(): Vector2D;
		set(x: number, y: number): this;
		setFrom(vector: Vector2DLike): this;
		add(vector: Vector2DLike): this;
		sub(vector: Vector2DLike): this;
		mult(factor: number): this;
		div(factor: number): this;
		normalize(): this;
		rotate(angle: number): this;
		rotateAround(angle: number, center: Vector2DLike): this;
		round(): this;
		floor(): this;
		toFixed(digits: number): this;
		perpendicular(): Vector2D;
		dot(vector: Vector2DLike): number;
		cross(vector: Vector2DLike): number;
		lengthSquared(): number;
		length(): number;
		compareLength(vector: Vector2DLike): number;
		distanceToSquared(vector: Vector2DLike): number;
		distanceTo(vector: Vector2DLike): number;
		angleTo(vector: Vector2DLike): number;
		lerp(vector: Vector2DLike, t: number): Vector2D;
	}

	interface Vector2DConstructor
	{
		new(x?: number, y?: number): Vector2D;
		from3D(vector: Vector3DLike): Vector2D;
		add(a: Vector2DLike, b: Vector2DLike): Vector2D;
		sub(a: Vector2DLike, b: Vector2DLike): Vector2D;
		isEqualTo(a: Vector2DLike, b: Vector2DLike): boolean;
		mult(vector: Vector2DLike, factor: number): Vector2D;
		div(vector: Vector2DLike, factor: number): Vector2D;
		min(a: Vector2DLike, b: Vector2DLike): Vector2D;
		max(a: Vector2DLike, b: Vector2DLike): Vector2D;
		average(vectors: Vector2DLike[]): Vector2D;
		sum(vectors: Vector2DLike[]): Vector2D;
		dot(a: Vector2DLike, b: Vector2DLike): number;
	}

	interface Vector3D extends Vector3DLike
	{
		clone(): Vector3D;
		set(x: number, y: number, z: number): this;
		add(vector: Vector3DLike): this;
		sub(vector: Vector3DLike): this;
		mult(factor: number): this;
		div(factor: number): this;
		normalize(): this;
		round(): this;
		floor(): this;
		toFixed(digits: number): this;
		dot(vector: Vector3DLike): number;
		cross(vector: Vector3DLike): Vector3D;
		lengthSquared(): number;
		length(): number;
		compareLength(vector: Vector3DLike): number;
		distanceToSquared(vector: Vector3DLike): number;
		distanceTo(vector: Vector3DLike): number;
		horizDistanceToSquared(vector: Vector3DLike): number;
		horizDistanceTo(vector: Vector3DLike): number;
		horizAngleTo(vector: Vector3DLike): number;
	}

	interface Vector3DConstructor
	{
		new(x?: number, y?: number, z?: number): Vector3D;
		add(a: Vector3DLike, b: Vector3DLike): Vector3D;
		sub(a: Vector3DLike, b: Vector3DLike): Vector3D;
		isEqualTo(a: Vector3DLike, b: Vector3DLike): boolean;
		mult(vector: Vector3DLike, factor: number): Vector3D;
		div(vector: Vector3DLike, factor: number): Vector3D;
	}

	class AttackEffects
	{
		constructor();
		Receivers(): Array<{ type: string; IID: string; method: string }>;
	}

	class DamageTypesMetadata
	{
		constructor();
		sort(damageTypes: string[]): string[];
		getName(code: string): string;
	}

	const NULL_FORMATION: "special/formations/null";

	class FSM
	{
		constructor(spec: FSMStateSpec<FSMObject>);
		Init(object: FSMObject, initialState: string): void;
		SetNextState(object: FSMObject, state: string): void;
		ProcessMessage(object: FSMObject, message: FSMMessage): unknown;
		DeferMessage(object: FSMObject, message: FSMMessage): void;
		LookupState(currentStateName: string, stateName: string): string;
		GetCurrentState(object: FSMObject): string;
		SwitchToNextState(object: FSMObject, nextStateName: string): void;
	}

	class ModificationTemplates
	{
		constructor(path: string);
		names: string[];
		templates: Record<string, Record<string, unknown>>;
	}

	const ModificationSchema: string;
	const ModificationsSchema: string;
	function LoadModificationTemplates(): void;
	function DeriveModificationsFromTech(techTemplate: Record<string, unknown>): Record<string, TechnologyModification[]>;
	function DeriveModificationsFromTechnologies(technologies: Record<string, unknown>[]): Record<string, TechnologyModification[]>;
	function DeriveModificationFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;
	function DeriveModificationsFromXMLTemplate(template: Record<string, unknown>): Record<string, TechnologyModification[]>;

	class MultiKeyMap<T = unknown>
	{
		constructor();
		items: Map<unknown, Map<unknown, MultiKeyMapEntry<T>[]>>;
		Serialize(): Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>;
		Deserialize(data: Array<[unknown, Array<[unknown, MultiKeyMapEntry<T>[]]>]>): void;
		AddItem(primaryKey: string, itemID: string, item: T, secondaryKey: unknown, stackable?: boolean): boolean;
		AddItems(itemID: string, items: Record<string, T>, secondaryKey: unknown, stackable?: boolean): boolean;
		RemoveItem(primaryKey: string, itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
		RemoveAllItems(itemID: string, secondaryKey: unknown, stackable?: boolean): boolean;
		HasItem(primaryKey: string, itemID: string, secondaryKey: unknown): boolean;
		HasAnyItem(itemID: string, secondaryKey: unknown): boolean;
		GetItems(primaryKey: string, secondaryKey: unknown): MultiKeyMapEntry<T>[];
		GetAllItems(secondaryKey: unknown): Record<string, MultiKeyMapEntry<T>[]>;
	}

	const Resources: Resources;

	class StatusEffectsMetadata
	{
		constructor();
		getData(code: string): {
			applierTooltip?: string;
			code?: string;
			icon?: string;
			statusName?: string;
			receiverTooltip?: string;
		};
		getApplierTooltip(code: string): string | undefined;
		getIcon(code: string): string | undefined;
		getName(code: string): string | undefined;
		getReceiverTooltip(code: string): string | undefined;
	}

	function GetTechModifiedProperty(
		modifications: TechnologyModification[],
		classes: string[] | string | undefined,
		originalValue: unknown): unknown;
	function GetTechModifiedProperty_generic(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: unknown): unknown;
	function GetTechModifiedProperty_numeric(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: number): number;
	function GetTechModifiedProperty_string(modifications: TechnologyModification[], classes: string[] | string | undefined, originalValue: string): string;
	function DoesModificationApply(modification: TechnologyModification, classes: string[] | string | undefined): boolean;
	function HandleTokens(originalValue: string, modification: string): string;
	function DeriveTechnologyRequirements(template: Record<string, unknown>, civ: string | undefined): TechnologyRequirements | false;
	function InterpretTechRequirements(civ: string | null | undefined, operator: string, value: unknown): TechnologyRequirements | false;
	function UnravelPhases(phases: Record<string, { reqs: Array<{ techs?: string[] }>; replaces?: string[] }>): string[];

	function loadCivFiles(selectableOnly: boolean): Record<string, Record<string, unknown>>;
	function GetIdentityClasses(template: IdentityTemplate): string[];
	function GetVisibleIdentityClasses(template: IdentityTemplate): string[];
	function MatchesClassList(
		classes: string[] | undefined,
		match: string | Array<string | string[]> | undefined): boolean | undefined;
	function GetBaseTemplateDataValue(template: Record<string, unknown>, valuePath: string, defaultValue?: number): number;
	function GetModifiedTemplateDataValue(
		template: Record<string, unknown>,
		valuePath: string,
		modKey: string | null | undefined,
		player: number | null | undefined,
		modifiers?: Record<string, TechnologyModification[]>,
		defaultValue?: number): number;
	function GetTemplateDataHelper(
		template: Record<string, unknown>,
		player: number | null | undefined,
		auraTemplates: Record<string, Record<string, unknown>> | undefined,
		resources: Resources,
		modifiers?: Record<string, TechnologyModification[]>): Record<string, unknown>;
	function GetTechnologyBasicDataHelper(template: Record<string, unknown>, civ: string | null | undefined): Record<string, unknown>;
	function GetTechnologyDataHelper(template: Record<string, unknown>, civ: string | null | undefined, resources: Resources): Record<string, unknown>;
	function GetAuraDataHelper(template: Record<string, unknown>): Record<string, unknown>;
	function calculateCarriedResources(
		carriedResources?: Array<{ type: string; amount: number }>,
		tradingGoods?: {
			type: string;
			amount?: { traderGain?: number; market1Gain?: number; market2Gain?: number };
		}): Record<string, number>;
	function removeFiltersFromTemplateName(templateName: string): string;

	function TradeGainNormalization(mapSize: number): number;
	function TradeGain(distanceSquared: number, mapSize: number): number;

	class WeightedList<T = unknown>
	{
		constructor();
		elements: Map<T, number>;
		totalWeight: number;
		length(): number;
		push(item: T, weight?: number): void;
		remove(item: T): void;
		randomItem(): T | undefined;
	}

	function cubicInterpolation(tension: number, x: number, p0: number, p1: number, p2: number, p3: number): number;
	function bicubicInterpolation(
		position: Vector2DLike,
		p00: number, p01: number, p02: number, p03: number,
		p10: number, p11: number, p12: number, p13: number,
		p20: number, p21: number, p22: number, p23: number,
		p30: number, p31: number, p32: number, p33: number): number;

	function randomNormal2D(): [number, number];
	function pickRandom<T>(source: readonly T[]): T | undefined;
	function randFloat(min: number, max: number): number;
	function randIntInclusive(min: number, max: number): number;
	function randIntExclusive(min: number, max: number): number;
	function randBool(probability?: number): boolean;
	function randomAngle(): number;

	function shuffleArray<T>(source: readonly T[]): T[];
	function heapsPermute<T>(array: T[], cloneFunc: (item: T) => T, callback: (permutation: T[]) => void): void;
	function deepCompare(first: unknown, second: unknown): boolean;
	function basename(path: string): string | undefined;
	function dirname(path: string): string;
	function listFiles(path: string, extension: string, recurse: boolean): string[];
	function cartesianProduct<T>(arrays: readonly (readonly T[])[]): T[][];

	const Vector2D: Vector2DConstructor;
	const Vector3D: Vector3DConstructor;

	const global: {
		AuraTemplates?: ModificationTemplates;
		TechnologyTemplates?: ModificationTemplates;
	};
}

export {};