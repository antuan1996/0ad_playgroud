declare namespace PetraRuntime {
	type Dict<T = unknown> = Record<string, T>;
	type ResourceMap = Dict<number>;
	type Position = [number, number] | { x: number; y: number };
	type EntityLike = CommonEntity;
	type GameStateLike = CommonGameState;

	interface PlanLike {
		category?: string;
		type?: string;
		number: number;
		maxMerge?: number;
		template?: CommonTemplate;
		queueToReset?: string;
		addItem?: (count: number) => void;
		isInvalid?: (gameState: GameStateLike) => boolean;
		isGo?: (gameState: GameStateLike) => boolean;
		getCost?: () => ResourceMap;
		start?: (gameState: GameStateLike) => void;
		hasClass?: (className: string) => boolean;
	}

	interface QueueLike {
		plans: PlanLike[];
		paused: boolean;
		switched: number;
		empty: () => void;
		addPlan: (plan: PlanLike | null | undefined) => void;
		check: (gameState: GameStateLike) => void;
		getNext: () => PlanLike | null;
		startNext: (gameState: GameStateLike) => boolean;
		maxAccountWanted: (gameState: GameStateLike, fraction: number) => CommonResourcesManager;
		queueCost: () => CommonResourcesManager;
		length: () => number;
		hasQueuedUnits: () => boolean;
		countQueuedUnits: () => number;
		hasQueuedUnitsWithClass: (className: string) => boolean;
		countQueuedUnitsWithClass: (className: string) => number;
	}

	interface Personality {
		aggressive: number;
		cooperative: number;
		defensive: number;
	}
}
