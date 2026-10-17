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
		/**
		 * The engine's territory grid, copied onto the AI by baseAI. Not the
		 * territory map the headquarters builds — that one is `HQ.territoryMap`.
		 */
		territoryMap: CommonPassabilityMap;
		uniqueIDs: Record<string, number>;
	}

	type PlanLike = import("./queueplan.ts").QueuePlan;

	/** The three concrete plan kinds a Queue can hold (all extend PlanLike). */
	type ConcretePlan = import("./queueplanTraining.ts").TrainingPlan | import("./queueplanBuilding.ts").ConstructionPlan | import("./queueplanResearch.ts").ResearchPlan;

	interface QueueLike {
		plans: PlanLike[];
		paused: boolean;
		switched: number;
		empty: () => void;
		addPlan: (plan: ConcretePlan | null | undefined) => void;
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
