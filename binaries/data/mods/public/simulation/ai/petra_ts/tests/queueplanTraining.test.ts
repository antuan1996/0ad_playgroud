/**
 * TrainingPlan and ResearchPlan: a batch of units, or a technology, queued by
 * the town — what it costs, which building can produce it, which of them is
 * chosen, and what starting it tells the game. The suites seat a real office
 * on the plain (tests/harness/hqWorld.ts); the buildings that train or
 * research record what they are told.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake, makeTemplate } from "./harness/fakes.ts";
import {
	doorManagers, type HqWorld, type HqWorldOptions, makeHqEntity, makeHqWorld, PLAYER, seatHQ
} from "./harness/hqWorld.ts";

import type { DefenseArmy } from "../execution/defenseArmy.ts";
import { ResearchPlan } from "../execution/queueplanResearch.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { techName } from "../adapter/brands.ts";

const SPEARMAN = "units/athen/infantry_spearman_b";
const FEMALE = "units/athen/support_female_citizen";

function seat(options: Partial<HqWorldOptions> = {})
{
	const world = makeHqWorld(options);
	const hq = seatHQ(world, { "stubs": doorManagers });
	// the engine hands template leaves over as strings (parsed XML)
	world.templates[SPEARMAN] = fake<CommonTemplate>({ ...makeTemplate(SPEARMAN, { "classes": ["Unit", "Infantry", "Soldier"], "getPaths": { "Cost": { "Population": "1" } } }),
		// a building's batch-time bonus makes a unit cheaper there, as Template.cost(trainer) reckons it
		"cost": (trainer?: CommonEntity) => ({ "food": trainer?.hasClass("Barracks") ? 40 : 50, "wood": 50 }),
		"costSum": (trainer?: CommonEntity) => trainer?.hasClass("Barracks") ? 90 : 100 });
	world.templates[FEMALE] = makeTemplate(FEMALE, { "classes": ["Unit", "Support", "Worker"], "cost": { "food": 50 },
		"getPaths": { "Cost": { "Population": "1" } } });
	return { world, hq };
}

/** a building of ours training the given units, recording its orders */
function trainer(world: HqWorld, id: number, classes: string[], trainables: string[], options: {
	position?: [number, number]; queueTime?: number; metadata?: Record<string, unknown> } = {})
{
	const orders: unknown[][] = [];
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, "position": options.position ?? [80, 80],
		"classes": ["Structure", ...classes] }, {
		"trainingQueue": () => [],
		"trainableEntities": () => trainables,
		"trainingQueueTime": () => options.queueTime ?? 0,
		"train": (civ: string, type: string, count: number, metadata: unknown) => orders.push([civ, type, count, metadata]),
		"research": (type: string) => orders.push(["research", type]),
		"stopAllProduction": (ratio: number) => orders.push(["stop", ratio])
	}, options.metadata ?? {}));
	return { ent, orders };
}

describe("a batch of units: TrainingPlan", () =>
{
	it("costs the unit's price per head and its population, read from the template", () =>
	{
		const { world } = seat();
		const plan = new TrainingPlan(world.gameState, SPEARMAN, { "role": "worker" }, 3, 4);
		assert.deepEqual([plan.cost.food, plan.cost.wood, plan.cost.population], [50, 50, 1]);
		assert.equal(typeof plan.cost.population, "number", "the template's string is read as a number");
		assert.equal(plan.number, 3);
		assert.equal(plan.maxMerge, 4);
		plan.addItem();
		plan.addItem(2);
		assert.equal(plan.number, 6);
	});

	it("can start only with a building to train it, and is priced at the cheapest", () =>
	{
		const { world } = seat();
		const plan = new TrainingPlan(world.gameState, SPEARMAN);
		assert.equal(plan.canStart(world.gameState), false);

		trainer(world, 300, ["CivCentre", "Civic"], [SPEARMAN]);
		trainer(world, 301, ["Barracks"], [SPEARMAN]);
		assert.equal(plan.canStart(world.gameState), true);
		assert.equal(plan.cost.food, 40, "at the barracks' price");
		assert.deepEqual(plan.getBestTrainers(world.gameState)?.map((e) => e.id()), [301]);
	});

	it("keeps to the named building, the plan's sea and the plan's town", () =>
	{
		const { world } = seat();
		trainer(world, 300, ["Barracks"], [SPEARMAN], { "metadata": { "base": 2 } });
		trainer(world, 301, ["Barracks"], [SPEARMAN], { "metadata": { "base": 3, "sea": 5 } });
		const ids = (metadata: Record<string, unknown>) =>
			new TrainingPlan(world.gameState, SPEARMAN, metadata).getBestTrainers(world.gameState)?.map((e) => e.id());

		assert.deepEqual(ids({ "trainer": 301 }), [301]);
		assert.deepEqual(ids({ "trainer": 999 }), [300, 301], "a named building gone: any will do");
		assert.deepEqual(ids({ "sea": 5 }), [301]);
		assert.deepEqual(ids({ "base": 2 }), [300]);
		assert.equal(ids({ "base": 7 }), undefined);
	});

	it("starts at its building, telling the game the batch, and drops the building's name from the units' orders", () =>
	{
		const { world } = seat();
		const barracks = trainer(world, 301, ["Barracks"], [SPEARMAN], { "metadata": { "base": 2 } });
		const plan = new TrainingPlan(world.gameState, SPEARMAN, { "trainer": 301, "role": "worker", "base": 0 }, 5);
		plan.canStart(world.gameState);

		plan.start(world.gameState);

		assert.deepEqual(barracks.orders, [["athen", SPEARMAN, 5, { "role": "worker", "base": 2 }]],
			"a plan for no town in particular takes its building's town");
	});

	it("among several buildings, prefers a short queue, a barracks over the town centre for soldiers", () =>
	{
		const { world } = seat();
		const cc = trainer(world, 300, ["CivCentre", "Civic"], [SPEARMAN], { "queueTime": 5 });
		const busy = trainer(world, 301, ["Barracks"], [SPEARMAN], { "queueTime": 20 });
		const idle = trainer(world, 302, ["Barracks"], [SPEARMAN], { "queueTime": 12 });
		const plan = new TrainingPlan(world.gameState, SPEARMAN);
		plan.canStart(world.gameState);
		// every building at the same price for this test
		plan.trainers = [cc.ent, busy.ent, idle.ent];

		plan.start(world.gameState);

		assert.equal(idle.orders.length, 1, "12 beats 5 + 10 for the town centre, and 20");
	});

	it("keeps support units away from an invading army", () =>
	{
		const { world, hq } = seat();
		hq.defenseManager.armies.push(fake<DefenseArmy>({ "foePosition": [80, 80] }));
		const threatened = trainer(world, 300, ["CivCentre", "Civic"], [FEMALE], { "position": [80, 80] });
		const safe = trainer(world, 301, ["CivCentre", "Civic"], [FEMALE], { "position": [280, 280], "queueTime": 30 });
		const plan = new TrainingPlan(world.gameState, FEMALE);
		plan.canStart(world.gameState);

		plan.start(world.gameState);

		assert.deepEqual([threatened.orders.length, safe.orders.length], [0, 1]);
	});

	it("prefers a building on the wanted land, and for workers the town with fewer of them", () =>
	{
		const { world, hq } = seat();
		const town = hq.baseManagers()[0];
		// a second town on another land
		const islandCC = world.addEntity(makeHqEntity({ "id": 290, "owner": PLAYER, "position": [280, 280],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre" }, {}, { "access": 3 }));
		const island = hq.basesManager.createBase(world.gameState, islandCC, "anchored");
		const away = trainer(world, 300, ["Barracks"], [SPEARMAN], { "metadata": { "base": island.ID } });
		const noTown = trainer(world, 301, ["Barracks"], [SPEARMAN]);
		const home = trainer(world, 302, ["Barracks"], [SPEARMAN], { "metadata": { "base": town.ID }, "queueTime": 20 });
		const plan = new TrainingPlan(world.gameState, SPEARMAN, { "index": town.accessIndex, "role": "worker" });
		plan.canStart(world.gameState);

		plan.start(world.gameState);

		assert.deepEqual([away.orders.length, noTown.orders.length, home.orders.length], [0, 0, 1],
			"20 on the wanted land beats 0 + 30 elsewhere");
	});

	it("is saved and loaded whole", () =>
	{
		const { world } = seat();
		const plan = new TrainingPlan(world.gameState, SPEARMAN, { "role": "worker" }, 2, 3);
		const saved = JSON.parse(JSON.stringify(plan.Serialize()));
		const loaded = new TrainingPlan(world.gameState, SPEARMAN);
		loaded.Deserialize(world.gameState, saved);
		assert.deepEqual(JSON.parse(JSON.stringify(loaded.Serialize())), saved);
	});
});

describe("a technology: ResearchPlan", () =>
{
	const TECH = techName("gather_lumbering_ironaxes");

	/** a town whose buildings may research the given tech */
	function lab(options: Partial<HqWorldOptions> = {}, researchers: Array<ReturnType<typeof trainer>> = [])
	{
		const s = seat(options);
		s.world.templates[TECH] = fake<CommonTemplate>({ "researchTime": 40, "cost": () => ({ "wood": 200, "metal": 100 }),
			"costSum": () => 300 });
		const gs = s.world.gameState;
		gs.findResearchers = () => s.world.gameState
			.getOwnStructures().filter((e: CommonEntity) => researchers.some((r) => r.ent.id() === e.id()));
		gs.isResearched = () => false;
		return { ...s, researchers };
	}

	it("can start only with a building to research it", () =>
	{
		const none = lab();
		const plan = new ResearchPlan(none.world.gameState, TECH);
		assert.equal(plan.canStart(none.world.gameState), false);

		const s = lab();
		s.researchers.push(trainer(s.world, 300, ["Storehouse"], []));
		const ready = new ResearchPlan(s.world.gameState, TECH);
		assert.equal(ready.canStart(s.world.gameState), true);
		assert.equal(ready.cost.wood, 200);
	});

	it("is researched at the building with the shortest queue; a rushed tech clears that queue first", () =>
	{
		const s = lab();
		const busy = trainer(s.world, 300, ["Storehouse"], [], { "queueTime": 30 });
		const free = trainer(s.world, 301, ["Storehouse"], [], { "queueTime": 2 });
		s.researchers.push(busy, free);
		const plan = new ResearchPlan(s.world.gameState, TECH, true);
		plan.canStart(s.world.gameState);

		plan.start(s.world.gameState);

		assert.deepEqual(free.orders, [["stop", 0.45], ["research", TECH]]);
		assert.deepEqual(busy.orders, []);
	});

	it("starting a phase tells the office the phase is coming; a reset queue gets its priority back", () =>
	{
		const s = lab({ "phaseName": "phase_town_generic" });
		s.world.templates["phase_town_generic"] = fake<CommonTemplate>({ "researchTime": 60, "cost": () => ({ "food": 500 }), "costSum": () => 500 });
		s.researchers.push(trainer(s.world, 300, ["CivCentre"], []));
		const phasedUp: number[] = [];
		s.hq.OnPhaseUp = (_gs: unknown, phase: number) => phasedUp.push(phase);
		s.hq.phasing = 2;
		const queueManager = s.world.ai.queueManager;
		const usual = queueManager.priorities.majorTech;
		queueManager.changePriority("majorTech", 1);
		const plan = new ResearchPlan(s.world.gameState, techName("phase_town_generic"), true);
		plan.queueToReset = "majorTech";
		plan.canStart(s.world.gameState);

		plan.start(s.world.gameState);

		assert.deepEqual(phasedUp, [2]);
		assert.equal(s.hq.phasing, 0);
		assert.equal(queueManager.priorities.majorTech, usual);
	});

	it("a tech already researched, or being researched, is no longer wanted", () =>
	{
		const s = lab({ "researching": [TECH] });
		const plan = new ResearchPlan(s.world.gameState, TECH);
		assert.equal(plan.isInvalid(s.world.gameState), true);

		const done = lab();
		done.world.gameState.isResearched = () => true;
		assert.equal(new ResearchPlan(done.world.gameState, TECH).isInvalid(done.world.gameState), true);

		const open = lab();
		assert.equal(new ResearchPlan(open.world.gameState, TECH).isInvalid(open.world.gameState), false);
	});

	it("is saved and loaded whole", () =>
	{
		const s = lab();
		const plan = new ResearchPlan(s.world.gameState, TECH, true);
		plan.queueToReset = "minorTech";
		const saved = JSON.parse(JSON.stringify(plan.Serialize()));
		const loaded = new ResearchPlan(s.world.gameState, TECH);
		loaded.Deserialize(s.world.gameState, saved);
		assert.deepEqual(JSON.parse(JSON.stringify(loaded.Serialize())), saved);
	});
});
