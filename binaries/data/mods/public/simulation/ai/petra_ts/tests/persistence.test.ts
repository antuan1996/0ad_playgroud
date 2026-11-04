/**
 * Save/reload tests for the Petra managers.
 *
 * Each test builds a manager, gives its fields values no default has, saves it,
 * restores a second instance from that save, and requires the second instance to
 * save to exactly the same data. See harness/persistence.ts for why that shape
 * is what catches a field dropped on either side.
 */
import { Geography } from "../world/geography.ts";
import { createBorderMap, createTerritoryMap } from "../world/mapModule.ts";
import { fake } from "./harness/fakes.ts";
import { describe, it } from "node:test";

import { makeFakeGameState } from "./harness/bareState.ts";
import { assertRoundTrip } from "./harness/persistence.ts";
import { techName } from "../adapter/brands.ts";

import { AttackManager, type SerializedAttackManager } from "../decision/attackManager.ts";
import { BaseManager, type SerializedBaseManager } from "../decision/baseManager.ts";
import { BasesManager, type SerializedBasesManager } from "../decision/basesManager.ts";
import { BuildManager } from "../decision/buildManager.ts";
import { Config } from "../decision/config.ts";
import { DefenseManager } from "../decision/defenseManager.ts";
import { DiplomacyManager } from "../decision/diplomacyManager.ts";
import { EmergencyManager } from "../decision/emergencyManager.ts";
import { GarrisonManager } from "../decision/garrisonManager.ts";
import { type HeadquartersSerializedData, Headquarters } from "../decision/headquarters.ts";
import { NavalManager } from "../decision/navalManager.ts";
import { ResearchManager } from "../decision/researchManager.ts";
import { type SerializedTradeManager, TradeManager } from "../decision/tradeManager.ts";
import { VictoryManager } from "../decision/victoryManager.ts";
import { Queue } from "../execution/queue.ts";
import { QueueManager, configuredQueues } from "../execution/queueManager.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { ResearchPlan } from "../execution/queueplanResearch.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";

/** Petra's own tuning, as it is at game start. */
function makeConfig(): Config
{
	return new Config(3, "balanced");
}

/**
 * A map with nothing built on it and nothing in the water. Restoring a base or
 * a headquarters rebuilds the entity collections it holds, so it needs a world
 * to look at — this one says "empty" to every question it is asked.
 */
/** A geography with no regions, on the world's own maps: what analyseMap makes of a map it found nothing on */
function bareGeography(world: CommonGameState): Geography
{
	return new Geography(createTerritoryMap(world), createBorderMap(world),
		{ "landRegions": {}, "navalRegions": {}, "navalMap": false });
}

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
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "TradeManager",
				original: () => new TradeManager(makeConfig(), world, bareGeography(world)),
				fromSave: (data, gameState) => TradeManager.restore(makeConfig(), gameState, bareGeography(gameState),
					fake<SerializedTradeManager>(data)),
				notSaved: { "minimalGain": "derived from the map at construction, which a reload reads again" }
			},
			world
		);
	});

	it("keeps a defense manager", () =>
	{
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "DefenseManager",
				original: () => new DefenseManager(makeConfig(), bareGeography(world)),
				restored: () => new DefenseManager(makeConfig(), bareGeography(world))
			},
			world
		);
	});

	it("keeps an attack manager", () =>
	{
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "AttackManager",
				original: () => new AttackManager(makeConfig(), world),
				fromSave: (data, gameState) => AttackManager.restore(makeConfig(), gameState, fake<SerializedAttackManager>(data), true),
				notSaved: {
					"enemyLandsTurn": "a cache of enemiesByLand, counted again on the turn it is asked",
					"enemyLands": "a cache of enemiesByLand, counted again on the turn it is asked"
				}
			},
			world
		);
	});

	it("keeps a naval manager", () =>
	{
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "NavalManager",
				original: () => new NavalManager(makeConfig(), world, bareGeography(world)),
				fromSave: (data, gameState) => NavalManager.restore(makeConfig(), gameState, bareGeography(gameState),
					fake<ReturnType<NavalManager["Serialize"]>>(data))
			},
			world
		);
	});

	it("keeps a queue manager", () =>
	{
		const queues = configuredQueues;
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
		const world = emptyWorldWithMap();
		const basesManager = () => new BasesManager(makeConfig(), world);
		assertRoundTrip(
			{
				label: "BaseManager",
				original: () => new BaseManager(world, basesManager(), BaseManager.STATE_WITH_ANCHOR),
				fromSave: (data, gameState) => BaseManager.restore(gameState, basesManager(), fake<SerializedBaseManager>(data)),
				keep: ["anchor", "anchorId", "territoryIndices"]
			},
			world
		);
	});

	it("keeps a bases manager holding one base", () =>
	{
		const world = emptyWorldWithMap();
		const build = () =>
		{
			const bases = new BasesManager(makeConfig(), world);
			bases["baseManagers"] = [new BaseManager(world, bases, BaseManager.STATE_WITH_ANCHOR)];
			return bases;
		};
		assertRoundTrip(
			{
				label: "BasesManager",
				original: build,
				fromSave: (data, gameState) => new BasesManager(makeConfig(), gameState, fake<SerializedBasesManager>(data))
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
				original: () => new Headquarters(makeConfig(), world, bareGeography(world)),
				fromSave: (data, gameState) => Headquarters.restore(makeConfig(), gameState, fake<HeadquartersSerializedData>(data)),
				// Not saved, in the original as in the port: the constructor
				// derives all four from Config, which is saved, so a reload
				// recomputes the same numbers.
				notSaved: {
					"towerLapseTime": "derived from Config.Military at construction",
					"fortressLapseTime": "derived from Config.Military at construction",
					"extraTowers": "derived from Config difficulty and personality at construction",
					"extraFortresses": "derived from Config difficulty and personality at construction",
					"canBarter": "read from the built markets at the start of each update",
					"currentPhase": "read from the game when the headquarters is made, a reload's too"
				},
				// the managers' new plans reach back for the headquarters they belong to
				prepare: hq => { world.ai["HQ"] = hq; }
			},
			world
		);
	});

	it("keeps a headquarters that has learnt its map and its losses", () =>
	{
		// The scalars are filled by populate(); the collections the office
		// learns during a match are not, so this run names them itself.
		const world = emptyWorldWithMap();
		assertRoundTrip(
			{
				label: "Headquarters with learnt state",
				original: () => new Headquarters(makeConfig(), world, bareGeography(world)),
				fromSave: (data, gameState) => Headquarters.restore(makeConfig(), gameState, fake<HeadquartersSerializedData>(data)),
				notSaved: {
					"towerLapseTime": "derived from Config.Military at construction",
					"fortressLapseTime": "derived from Config.Military at construction",
					"extraTowers": "derived from Config difficulty and personality at construction",
					"extraFortresses": "derived from Config difficulty and personality at construction",
					"canBarter": "read from the built markets at the start of each update",
					"currentPhase": "read from the game when the headquarters is made, a reload's too"
				},
				// Regions the map reports as land and sea, a structure that
				// decayed to gaia, a capture target with garrisoned defenders,
				// and the gather that failed in each resource.
				set: {
					landRegions: { 2: true, 5: true },
					navalRegions: { 9: true },
					decayingStructures: new Set([301, 302]),
					capturableTargets: new Map([[401, { strength: 3, ents: new Set([402, 403]) }]]),
					lastFailedGather: { wood: 40, food: 12 }
				},
				prepare: hq => { world.ai["HQ"] = hq; }
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
					original: () => new ResearchPlan(world, techName("research/athenians_myrnidian_founding")),
					restored: () => new ResearchPlan(world, techName("research/athenians_myrnidian_founding")),
					keep: ["ID"]
				},
				world
			);
		});
	});
});
