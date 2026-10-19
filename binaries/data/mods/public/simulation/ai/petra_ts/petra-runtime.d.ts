// Petra-internal runtime type aliases.
//
// This file only declares the glue types used by the TypeScript modules that
// do not fit neatly in the engine (engine-api.d.ts) or common-api
// (common-api.d.ts) declarations. It is namespaced so it can be imported
// ambiently (`declare namespace PetraRuntime`).

declare namespace PetraRuntime {
/** Generic string-keyed record; used e.g. for numeric accounts and priorities. */
	type Dict<T = unknown> = Record<string, T>;

/**
 * The state object Petra keeps between turns and serializes. This is the
 * type of `GameState.ai` (filled in by baseAI.js: the bot instance itself is
 * assigned to its GameState). Fields flagged with "baseAI" below are attached
 * by common-api/baseAI.js, not by Petra; HQ and queueManager are only
 * undefined during construction and (de)serialization windows — the update
 * path always runs with them present.
 */
	interface AIState {
		Config: import("./config.ts").Config;
		HQ: import("./headquarters.ts").Headquarters;
/** baseAI: passability/terrain analyzer built once per game from the first state dump. */
		accessibility: import("simulation/ai/common-api/terrain-analysis.js").Accessibility;
/** Time elapsed in the game, in seconds (copied from the shared script each turn). */
		elapsedTime: number;
/** Turn counter used to stagger expensive AI work every 8 turns. */
		playedTurn: number;
		queueManager: import("./queueManager.ts").QueueManager;
		queues: Record<string, import("./queue.ts").Queue>;
		/**
		 * baseAI: the engine's territory grid, copied onto the AI by baseAI.
		 * Not the territory map the headquarters builds — that one is
		 * `HQ.territoryMap`.
		 */
		territoryMap: CommonPassabilityMap;
/** Per-name id generators (tagging, fake entities ...), carried across saves. */
		uniqueIDs: Record<string, number>;
	}

/** Any QueuePlan subclass instance (structural supertype of the concrete plans). */
	type PlanLike = import("./queueplan.ts").QueuePlan;

/** The three concrete plan kinds a Queue can hold (all extend PlanLike). */
	type ConcretePlan = import("./queueplanTraining.ts").TrainingPlan | import("./queueplanBuilding.ts").ConstructionPlan | import("./queueplanResearch.ts").ResearchPlan;

/** All named Petra queues, keyed by their queue name (see Config.priorities). */
	type QueueCollection = Record<string, import("./queue.ts").Queue>;

/**
 * The three adjustable personality axes Petra reads from the game settings
 * (each normalised to [0, 1] and set by Config.setConfig from map settings
 * or defaults).
 */
	interface Personality {
		aggressive: number;
		cooperative: number;
		defensive: number;
	}
}
