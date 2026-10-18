/**
 * Save/reload tests for the Petra managers.
 *
 * Each test builds a manager, gives its fields values no default has, saves it,
 * restores a second instance from that save, and requires the second instance to
 * save to exactly the same data. See harness/persistence.ts for why that shape
 * is what catches a field dropped on either side.
 */
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import { assertRoundTrip } from "./harness/persistence.ts";
import { makeFakeGameState } from "./harness/world.ts";

/**
 * A Petra class, seen as the harness uses it: constructed with whatever the
 * class wants, then saved. The port's own types describe what each constructor
 * takes; here the point is that a save round-trips whatever object comes out.
 */
type AnyClass = new (...args: unknown[]) => Record<string, unknown>;

/** A base, with the one method this file has to call on it. */
type BaseLike = Record<string, unknown> & { init(gameState: CommonGameState, state: string): void };

const { Config } = await loadPetraModule<{ Config: AnyClass }>("config");
const { Queue } = await loadPetraModule<{ Queue: AnyClass }>("queue");
const { BuildManager } = await loadPetraModule<{ BuildManager: AnyClass }>("buildManager");
const { GarrisonManager } = await loadPetraModule<{ GarrisonManager: AnyClass }>("garrisonManager");
const { EmergencyManager } = await loadPetraModule<{ EmergencyManager: AnyClass }>("emergencyManager");
const { DiplomacyManager } = await loadPetraModule<{ DiplomacyManager: AnyClass }>("diplomacyManager");
const { VictoryManager } = await loadPetraModule<{ VictoryManager: AnyClass }>("victoryManager");
const { ResearchManager } = await loadPetraModule<{ ResearchManager: AnyClass }>("researchManager");
const { TradeManager } = await loadPetraModule<{ TradeManager: AnyClass }>("tradeManager");
const { DefenseManager } = await loadPetraModule<{ DefenseManager: AnyClass }>("defenseManager");
const { AttackManager } = await loadPetraModule<{ AttackManager: AnyClass }>("attackManager");
const { NavalManager } = await loadPetraModule<{ NavalManager: AnyClass }>("navalManager");
const { QueueManager } = await loadPetraModule<{ QueueManager: AnyClass }>("queueManager");
const { BaseManager } = await loadPetraModule<{ BaseManager: AnyClass }>("baseManager");
const { BasesManager } = await loadPetraModule<{ BasesManager: AnyClass }>("basesManager");
const { Headquarters } = await loadPetraModule<{ Headquarters: AnyClass }>("headquarters");
const { TrainingPlan } = await loadPetraModule<{ TrainingPlan: AnyClass }>("queueplanTraining");
const { ConstructionPlan } = await loadPetraModule<{ ConstructionPlan: AnyClass }>("queueplanBuilding");
const { ResearchPlan } = await loadPetraModule<{ ResearchPlan: AnyClass }>("queueplanResearch");

/** Petra's own tuning, as it is at game start. */
function makeConfig(): Record<string, unknown>
{
	return new Config(3, "balanced");
}

/**
 * A map with nothing built on it and nothing in the water. Restoring a base or
 * a headquarters rebuilds the entity collections it holds, so it needs a world
 * to look at — this one says "empty" to every question it is asked.
 */
function emptyWorldWithMap(): CommonGameState
{
	return makeFakeGameState({
		map: {}, ownStructures: [], ownUnits: [], emptyWorld: true
	}).gameState;
}

describe("save and reload", () =>
{
	it("keeps the config", () =>
	{
		assertRoundTrip(
			{
				label: "Config",
				original: () => makeConfig(),
				restored: () => makeConfig(),
				// `debug` is deliberately not saved, and `personality` is drawn at
				// game start, so neither may be compared across a reload.
				keep: ["debug"]
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps an empty queue", () =>
	{
		assertRoundTrip(
			{
				label: "Queue",
				original: () => new Queue(),
				restored: () => new Queue(),
				set: { paused: true, switched: 42 }
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a build manager", () =>
	{
		assertRoundTrip(
			{
				label: "BuildManager",
				original: () => new BuildManager(),
				restored: () => new BuildManager()
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a garrison manager", () =>
	{
		assertRoundTrip(
			{
				label: "GarrisonManager",
				original: () => new GarrisonManager(makeConfig()),
				restored: () => new GarrisonManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps an emergency manager", () =>
	{
		assertRoundTrip(
			{
				label: "EmergencyManager",
				original: () => new EmergencyManager(makeConfig()),
				restored: () => new EmergencyManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a diplomacy manager", () =>
	{
		assertRoundTrip(
			{
				label: "DiplomacyManager",
				original: () => new DiplomacyManager(makeConfig(), false),
				restored: () => new DiplomacyManager(makeConfig(), false)
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a victory manager", () =>
	{
		assertRoundTrip(
			{
				label: "VictoryManager",
				original: () => new VictoryManager(makeConfig()),
				restored: () => new VictoryManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a research manager", () =>
	{
		assertRoundTrip(
			{
				label: "ResearchManager",
				original: () => new ResearchManager(makeConfig()),
				restored: () => new ResearchManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a trade manager", () =>
	{
		assertRoundTrip(
			{
				label: "TradeManager",
				original: () => new TradeManager(makeConfig()),
				restored: () => new TradeManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a defense manager", () =>
	{
		assertRoundTrip(
			{
				label: "DefenseManager",
				original: () => new DefenseManager(makeConfig()),
				restored: () => new DefenseManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps an attack manager", () =>
	{
		assertRoundTrip(
			{
				label: "AttackManager",
				original: () => new AttackManager(makeConfig()),
				restored: () => new AttackManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a naval manager", () =>
	{
		assertRoundTrip(
			{
				label: "NavalManager",
				original: () => new NavalManager(makeConfig()),
				restored: () => new NavalManager(makeConfig())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a queue manager", () =>
	{
		const queues = () => ({ "military": new Queue(), "economic": new Queue() });
		assertRoundTrip(
			{
				label: "QueueManager",
				original: () => new QueueManager(makeConfig(), queues()),
				restored: () => new QueueManager(makeConfig(), queues())
			},
			makeFakeGameState().gameState
		);
	});

	it("keeps a base manager", () =>
	{
		// The base manager is not saved as a standalone object: its anchor and
		// resource lists live on the entity it is attached to. Only its own
		// fields are compared here.
		const basesManager = () => new BasesManager(makeConfig());
		const world = makeFakeGameState().gameState;
		assertRoundTrip(
			{
				label: "BaseManager",
				original: () => new BaseManager(world, basesManager()),
				restored: () => new BaseManager(world, basesManager()),
				keep: ["anchor", "anchorId", "territoryIndices"]
			},
			world
		);
	});

	it("keeps a bases manager holding one base", () =>
	{
		const world = emptyWorldWithMap();
		const states = BaseManager as unknown as { STATE_WITH_ANCHOR: string };
		const build = () =>
		{
			const bases = new BasesManager(makeConfig());
			// The game always runs init() on a bases manager (fresh game and
			// restore alike) before using or saving it, which is what creates
			// its baseless base, so build this one the same way.
			(bases as { init(gameState: CommonGameState, deserialize: boolean): void })
				.init(world, false);
			// A base only holds its entity collections after init, and
			// restoring runs init as well, so a base that skipped it would
			// differ for a reason that has nothing to do with the save.
			const base = new BaseManager(world, bases) as BaseLike;
			base.init(world, states.STATE_WITH_ANCHOR);
			bases["baseManagers"] = [base];
			return bases;
		};
		assertRoundTrip(
			{
				label: "BasesManager",
				original: build,
				restored: build
			},
			world
		);
	});

	it("keeps a headquarters", () =>
	{
		// Restoring a headquarters rebuilds every manager it owns, which needs
		// the map and the list of buildings already standing.
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "Headquarters",
				// A headquarters only holds bases once the bot has initialised
				// its base manager, and restoring does that as part of loading.
				// So the saved side starts from a live one, the restored side
				// from a bare one.
				original: () =>
				{
					const hq = new Headquarters(makeConfig(), false);
					(hq["basesManager"] as { init(gameState: CommonGameState, deserialize: boolean): void })
						.init(world, false);
					return hq;
				},
				restored: () => new Headquarters(makeConfig(), false),
				// Not saved, in the original as in the port: the constructor
				// derives all four from Config, which is saved, so a reload
				// recomputes the same numbers.
				notSaved: {
					"towerLapseTime": "derived from Config.Military at construction",
					"fortressLapseTime": "derived from Config.Military at construction",
					"extraTowers": "derived from Config difficulty and personality at construction",
					"extraFortresses": "derived from Config difficulty and personality at construction"
				},
				// Rebuilding the managers reaches back for the headquarters they
				// belong to, so the world has to be holding the one being restored.
				prepare: hq => { (world as unknown as { ai: Record<string, unknown> }).ai["HQ"] = hq; }
			},
			world
		);
	});

	describe("queue plans", () =>
	{
		/** Plans are built from templates, so the test says what things cost. */
		const world = makeFakeGameState({
			templates: {
				"structures/athenians_barracks": { cost: { wood: 120, stone: 100 } },
				"units/athenians_soldite": { cost: { food: 150, wood: 20 }, population: 4 },
				"research/athenians_myrnidian_founding": { cost: { food: 200 }, researchTime: 60 }
			}
		}).gameState;

		it("keeps a training plan", () =>
		{
			assertRoundTrip(
				{
					label: "TrainingPlan",
					original: () => new TrainingPlan(world, "units/athenians_soldite"),
					restored: () => new TrainingPlan(world, "units/athenians_soldite"),
					// The template is looked up again on load, never copied.
					keep: ["ID"]
				},
				world
			);
		});

		it("keeps a construction plan", () =>
		{
			assertRoundTrip(
				{
					label: "ConstructionPlan",
					original: () => new ConstructionPlan(world, "structures/athenians_barracks"),
					restored: () => new ConstructionPlan(world, "structures/athenians_barracks"),
					keep: ["ID"]
				},
				world
			);
		});

		it("keeps a research plan", () =>
		{
			assertRoundTrip(
				{
					label: "ResearchPlan",
					original: () => new ResearchPlan(world, "research/athenians_myrnidian_founding"),
					restored: () => new ResearchPlan(world, "research/athenians_myrnidian_founding"),
					keep: ["ID"]
				},
				world
			);
		});
	});
});
