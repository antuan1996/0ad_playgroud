declare namespace PetraRuntime {
	type Dict<T = unknown> = Record<string, T>;
	type ResourceMap = Dict<number>;
	type Position = [number, number] | { x: number; y: number };
	type EntityLike = CommonEntity;
	type GameStateLike = CommonGameState;

	interface AIState {
		Config: import("./config.ts").Config;
		HQ: import("./headquarters.ts").Headquarters;
		accessibility: import("simulation/ai/common-api/terrain-analysis.js").Accessibility;
		elapsedTime: number;
		playedTurn: number;
		queueManager: import("./queueManager.ts").QueueManager;
		queues: Record<string, import("./queue.ts").Queue>;
		territoryMap: import("./headquarters.ts").Headquarters["territoryMap"];
		uniqueIDs: Record<string, number>;
	}

	type PlanLike = import("./queueplan.ts").QueuePlan;

	interface QueueLike {
		plans: PlanLike[];
		paused: boolean;
		switched: number;
		empty: () => void;
		addPlan: (plan: PlanLike | null | undefined) => void;
		check: (gameState: GameStateLike) => void;
		getNext: () => PlanLike | null;
		startNext: (gameState: GameStateLike) => boolean;
		maxAccountWanted: (gameState: GameStateLike, fraction: number) => import("simulation/ai/common-api/resources.js").ResourcesManager;
		queueCost: () => import("simulation/ai/common-api/resources.js").ResourcesManager;
		length: () => number;
		hasQueuedUnits: () => boolean;
		countQueuedUnits: () => number;
		hasQueuedUnitsWithClass: (className: string) => boolean;
		countQueuedUnitsWithClass: (className: string) => number;
	}

	type QueueCollection = Record<string, import("./queue.ts").Queue>;

	interface Personality {
		aggressive: number;
		cooperative: number;
		defensive: number;
	}
}
