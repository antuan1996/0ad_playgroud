/**
 * ResearchManager: which technology the town studies next — the next phase
 * when the town is ready for it, the techs it wants as soon as they are
 * available, those it prefers once in the second phase, and a random one
 * later. The techs are the game's own (simulation/data/technologies), read
 * from disk as the engine reads them; the suites seat a real office on the
 * plain (see tests/harness/hqWorld.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import { makeHqEntity, makeHqWorld, seatHQ, PLAYER, type HqWorld, type HqWorldOptions } from "./harness/hqWorld.ts";
import { modsPublic } from "./harness/paths.ts";

interface Choice { name: string; increasePriority: boolean }

interface Manager
{
	checkPhase(gs: unknown, queues: unknown): void;
	researchPopulationBonus(gs: unknown, queues: unknown): void;
	researchTradeBonus(gs: unknown, queues: unknown): void;
	researchWantedTechs(gs: unknown, techs: Tech[]): Choice | null;
	researchPreferredTechs(gs: unknown, techs: Tech[]): Choice | null;
	update(gs: unknown, queues: unknown): void;
	CostSum(cost: Record<string, number>): number;
	Serialize(): unknown;
	Deserialize(data: unknown): void;
}

interface QueueLike
{
	plans: Array<{ type: string; rush?: boolean; queueToReset?: string }>;
	addPlan(plan: unknown): void;
}

/** a tech as GameState.findAvailableTech lists it: its name and its template */
type Tech = [string, { _template: Record<string, unknown>; researchTime: number; cost(): Record<string, number> }];

const { ResearchManager } = await loadPetraModule<{ ResearchManager: new (config: unknown) => Manager }>("researchManager");

/** the town's doors kept outside the walls, as the other campaigns do */
const doorManagers = [
	"navalManager", "tradeManager", "researchManager", "diplomacyManager", "victoryManager", "defenseManager"
];

/** a game tech, read from its file as the engine's TechnologyTemplates does */
function tech(world: HqWorld, name: string): Tech
{
	const json = JSON.parse(readFileSync(path.join(modsPublic, "simulation/data/technologies", name + ".json"), "utf8")) as Record<string, unknown>;
	const template = {
		"_template": json,
		"researchTime": (json.researchTime as number | undefined) ?? 40,
		"cost": () => ({ ...(json.cost as Record<string, number> | undefined ?? {}) })
	};
	world.templates[name] = template as unknown as HqWorld["templates"][string];
	return [name, template];
}

/** a town on the plain; `techs` are what its buildings could research now */
function seat(options: Partial<HqWorldOptions> = {}, techs: string[] = [])
{
	const world = makeHqWorld(options as HqWorldOptions);
	const hq = seatHQ(world, { "stubs": doorManagers });
	const listed = techs.map((name) => tech(world, name));
	const gs = world.gameState as unknown as Record<string, unknown>;
	gs.findAvailableTech = () => [...listed];
	// a new research plan looks for its researchers; none here, so the plain cost stands
	gs.findResearchers = () => undefined;
	gs.hasResearchers = () => true;
	gs.hasAllies = () => false;
	const manager = new ResearchManager(hq.Config);
	return { world, hq, manager, "queues": world.ai.queues as unknown as Record<string, QueueLike> };
}

/** our workers, as GameState.getOwnEntitiesByRole counts them */
function workers(world: HqWorld, count: number): void
{
	const first = 5000 + world.ents.size;
	for (let i = 0; i < count; ++i)
		world.addEntity(makeHqEntity({ "id": first + i, "owner": PLAYER, "position": [40, 40], "classes": ["Unit", "Worker"] },
			{}, { "role": "worker" }));
}

const queued = (queue: QueueLike): string[] => queue.plans.map((p) => p.type);

describe("the next phase: checkPhase", () =>
{
	it("a town with the people for it researches the next phase, in a hurry", () =>
	{
		const { world, hq, manager, queues } = seat({ "population": 150, "phaseName": "phase_town_generic" }, ["phase_town_generic"]);
		const queueManager = world.ai.queueManager as unknown as { priorities: Record<string, number>; changePriority(q: string, p: number): void };
		queueManager.changePriority("majorTech", 1);

		manager.checkPhase(world.gameState, queues);

		assert.deepEqual(queued(queues.majorTech), ["phase_town_generic"]);
		assert.equal(queues.majorTech.plans[0].rush, true);
		assert.equal(hq.phasing, 2);
		assert.equal(queueManager.priorities.majorTech, hq.Config.priorities.majorTech, "the queue priority is reset");
	});

	it("waits while the town is too small, or no building can research the phase", () =>
	{
		const small = seat({ "population": 100, "phaseName": "phase_town_generic" }, ["phase_town_generic"]);
		small.manager.checkPhase(small.world.gameState, small.queues);
		assert.deepEqual(queued(small.queues.majorTech), []);

		const noResearcher = seat({ "population": 150, "phaseName": "phase_town_generic" }, ["phase_town_generic"]);
		(noResearcher.world.gameState as unknown as { hasResearchers: () => boolean }).hasResearchers = () => false;
		noResearcher.manager.checkPhase(noResearcher.world.gameState, noResearcher.queues);
		assert.deepEqual(queued(noResearcher.queues.majorTech), []);
	});

	it("waits while a phase, a civic centre or a wonder is already in the queues, or when no phase is left", () =>
	{
		for (const queue of ["majorTech", "civilCentre", "wonder"])
		{
			const s = seat({ "population": 150, "phaseName": "phase_town_generic" }, ["phase_town_generic"]);
			(s.queues[queue] as unknown as { hasQueuedUnits: () => boolean }).hasQueuedUnits = () => true;
			s.manager.checkPhase(s.world.gameState, s.queues);
			assert.equal(s.hq.phasing, 0, `with ${queue} busy`);
		}
		const last = seat({ "population": 150 });	// no phase name for the next phase
		last.manager.checkPhase(last.world.gameState, last.queues);
		assert.deepEqual(queued(last.queues.majorTech), []);
	});

	it("later phases follow the number of workers", () =>
	{
		for (const [phase, key, next] of [[2, "workPhase3", "phase_city_generic"], [3, "workPhase4", "phase_town_generic"]] as const)
		{
			const s = seat({ phase }, [next]);
			(s.world.gameState as unknown as { getPhaseName: (p: number) => string | undefined }).getPhaseName =
				(p: number) => p === phase + 1 ? next : undefined;
			// a small map's config: few workers make a phase
			s.hq.Config.Economy[key] = 5;
			workers(s.world, 5);
			s.manager.checkPhase(s.world.gameState, s.queues);
			assert.deepEqual(queued(s.queues.majorTech), [], `phase ${phase}: five workers are not more than five`);

			workers(s.world, 1);
			s.hq.turnCache.accountedWorkers = undefined;
			s.manager.checkPhase(s.world.gameState, s.queues);
			assert.deepEqual(queued(s.queues.majorTech), [next], `phase ${phase}: six are`);
			assert.equal(s.hq.phasing, phase + 1);
		}
	});
});

describe("the techs asked for by the other managers", () =>
{
	it("a town short of houses researches the first tech that raises their population", () =>
	{
		const { world, manager, queues } = seat({}, ["barracks_batch_training", "unlock_champion_infantry", "pop_house_01", "pop_house_02"]);
		manager.researchPopulationBonus(world.gameState, queues);
		assert.deepEqual(queued(queues.minorTech), ["pop_house_01"]);
	});

	it("traders get faster or richer, not anyone else", () =>
	{
		const { world, manager, queues } = seat({},
			["cavalry_movement_speed", "unlock_champion_infantry", "hoplite_tradition", "exploration", "trade_gain_01"]);
		manager.researchTradeBonus(world.gameState, queues);
		assert.deepEqual(queued(queues.minorTech), ["trade_gain_01"],
			"the cavalry's speed and the hoplites are not for traders, and exploration gives traders only vision");
	});

	it("a busy minor queue takes neither", () =>
	{
		const { world, manager, queues } = seat({}, ["pop_house_01", "trade_gain_01"]);
		(queues.minorTech as unknown as { hasQueuedUnits: () => boolean }).hasQueuedUnits = () => true;
		manager.researchPopulationBonus(world.gameState, queues);
		manager.researchTradeBonus(world.gameState, queues);
		assert.deepEqual(queued(queues.minorTech), []);
	});
});

describe("the techs wanted as soon as they are available: researchWantedTechs", () =>
{
	const wanted = (names: string[], options: Partial<HqWorldOptions> = { "phase": 2 }, naval = false) =>
	{
		const s = seat(options, names);
		s.hq.navalMap = naval;
		const techs = (s.world.gameState as unknown as { findAvailableTech(): Tech[] }).findAvailableTech();
		return s.manager.researchWantedTechs(s.world.gameState, techs);
	};

	it("champions are unlocked first, and in a hurry", () =>
	{
		assert.deepEqual(wanted(["gather_lumbering_ironaxes", "unlock_champion_infantry"]),
			{ "name": "gather_lumbering_ironaxes", "increasePriority": true }, "the tech listed first wins");
		assert.deepEqual(wanted(["unlock_champion_infantry", "gather_lumbering_ironaxes"]),
			{ "name": "unlock_champion_infantry", "increasePriority": true });
	});

	it("the Seleucid army reform is one of its two choices, in a hurry", () =>
	{
		const choice = wanted(["traditional_army_sele"]);
		assert.ok(choice && ["traditional_army_sele", "reformed_army_sele"].includes(choice.name));
		assert.equal(choice?.increasePriority, true);
	});

	it("gathering techs: cheap ones in a hurry, farming and baskets in their turn, fishing only on a naval map", () =>
	{
		assert.deepEqual(wanted(["gather_lumbering_ironaxes"]), { "name": "gather_lumbering_ironaxes", "increasePriority": true },
			"300 resources: cheap");
		assert.deepEqual(wanted(["gather_wicker_baskets"]), { "name": "gather_wicker_baskets", "increasePriority": true });
		assert.deepEqual(wanted(["gather_farming_chain_pump"]), { "name": "gather_farming_chain_pump", "increasePriority": false });
		assert.deepEqual(wanted(["gather_capacity_basket"]), { "name": "gather_capacity_basket", "increasePriority": false });
		assert.deepEqual(wanted(["archery_tradition"]), { "name": "archery_tradition", "increasePriority": false });
		assert.equal(wanted(["fishing_boat_gather_rate"]), null, "no fishing on a land map");
		assert.deepEqual(wanted(["fishing_boat_gather_rate"], { "phase": 2 }, true),
			{ "name": "fishing_boat_gather_rate", "increasePriority": true });
		assert.equal(wanted(["gather_lumbering_sharpaxes"])?.increasePriority, false, "900 resources: not cheap");
	});

	it("techs of no use now, or with no modification at all, are not wanted", () =>
	{
		assert.equal(wanted(["hoplite_tradition", "barracks_batch_training", "phase_town_generic", "equine_transports"]), null);
	});

	it("in the first phase, a tech the workforce cannot soon afford waits", () =>
	{
		// 300 wood short with no worker: 10 x 0 workers < 300
		assert.equal(wanted(["gather_lumbering_ironaxes"], { "phase": 1 }), null);
		const s = seat({ "phase": 1, "stock": { "wood": 200, "metal": 100 } }, ["gather_lumbering_ironaxes"]);
		const techs = (s.world.gameState as unknown as { findAvailableTech(): Tech[] }).findAvailableTech();
		assert.equal(s.manager.researchWantedTechs(s.world.gameState, techs)?.name, "gather_lumbering_ironaxes", "affordable now");
	});
});

describe("the techs preferred from the second phase: researchPreferredTechs", () =>
{
	const preferred = (names: string[], options: Partial<HqWorldOptions> = { "phase": 3 }) =>
	{
		const s = seat(options, names);
		const techs = (s.world.gameState as unknown as { findAvailableTech(): Tech[] }).findAvailableTech();
		return s.manager.researchPreferredTechs(s.world.gameState, techs);
	};

	it("mining, arrows and healing", () =>
	{
		assert.deepEqual(preferred(["gather_mining_servants"]), { "name": "gather_mining_servants", "increasePriority": true },
			"300 resources: cheap");
		assert.deepEqual(preferred(["gather_mining_shaftmining"]), { "name": "gather_mining_shaftmining", "increasePriority": false });
		assert.deepEqual(preferred(["tower_garrison"]), { "name": "tower_garrison", "increasePriority": false });
		assert.deepEqual(preferred(["arsenal_philon"]), { "name": "arsenal_philon", "increasePriority": false });
		assert.deepEqual(preferred(["health_regen_units"]), { "name": "health_regen_units", "increasePriority": false });
		assert.equal(preferred(["hoplite_tradition", "unlock_champion_infantry"]), null);
	});

	it("in the second phase, a tech the workforce cannot soon afford waits", () =>
	{
		assert.equal(preferred(["gather_mining_servants"], { "phase": 2 }), null);
		const s = seat({ "phase": 2 }, ["gather_mining_servants"]);
		workers(s.world, 30);
		const techs = (s.world.gameState as unknown as { findAvailableTech(): Tech[] }).findAvailableTech();
		assert.equal(s.manager.researchPreferredTechs(s.world.gameState, techs)?.name, "gather_mining_servants",
			"thirty workers make up 300 resources soon enough");
	});
});

describe("the research of a turn: update", () =>
{
	it("a wanted tech in a hurry doubles the minor queue's priority until it starts", () =>
	{
		const { world, hq, manager, queues } = seat({ "phase": 2 }, ["unlock_champion_infantry"]);

		manager.update(world.gameState, queues);

		assert.deepEqual(queued(queues.minorTech), ["unlock_champion_infantry"]);
		assert.equal(queues.minorTech.plans[0].queueToReset, "minorTech");
		assert.equal((world.ai.queueManager as unknown as { priorities: Record<string, number> }).priorities.minorTech,
			2 * hq.Config.priorities.minorTech);
	});

	it("a wanted tech in no hurry is just queued", () =>
	{
		const { world, hq, manager, queues } = seat({ "phase": 2 }, ["gather_farming_chain_pump"]);
		manager.update(world.gameState, queues);
		assert.deepEqual(queued(queues.minorTech), ["gather_farming_chain_pump"]);
		assert.equal(queues.minorTech.plans[0].queueToReset, undefined);
		assert.equal((world.ai.queueManager as unknown as { priorities: Record<string, number> }).priorities.minorTech,
			hq.Config.priorities.minorTech);
	});

	it("a preferred tech waits for the second phase, then is queued, in a hurry if cheap", () =>
	{
		const first = seat({ "phase": 1 }, ["gather_mining_servants", "tower_garrison"]);
		first.manager.update(first.world.gameState, first.queues);
		assert.deepEqual(queued(first.queues.minorTech), []);

		const cheap = seat({ "phase": 3 }, ["gather_mining_servants"]);
		cheap.manager.update(cheap.world.gameState, cheap.queues);
		assert.equal(cheap.queues.minorTech.plans[0].queueToReset, "minorTech");

		const dear = seat({ "phase": 3 }, ["tower_garrison"]);
		dear.manager.update(dear.world.gameState, dear.queues);
		assert.deepEqual(queued(dear.queues.minorTech), ["tower_garrison"]);
		assert.equal(dear.queues.minorTech.plans[0].queueToReset, undefined);
	});

	it("from the third phase, any other tech may be researched, but not one for healers, outposts or walls alone", () =>
	{
		const second = seat({ "phase": 2 }, ["hoplite_tradition"]);
		second.manager.update(second.world.gameState, second.queues);
		assert.deepEqual(queued(second.queues.minorTech), [], "not yet in the second phase");

		const third = seat({ "phase": 3 }, ["outpost_vision", "long_walls", "hoplite_tradition"]);
		third.manager.update(third.world.gameState, third.queues);
		assert.deepEqual(queued(third.queues.minorTech), ["hoplite_tradition"]);

		const nothing = seat({ "phase": 3 }, ["outpost_vision", "long_walls"]);
		nothing.manager.update(nothing.world.gameState, nothing.queues);
		assert.deepEqual(queued(nothing.queues.minorTech), []);
	});

	it("shared vision is researched only with an ally to share it with", () =>
	{
		const alone = seat({ "phase": 3 }, ["unlock_shared_los"]);
		alone.manager.update(alone.world.gameState, alone.queues);
		assert.deepEqual(queued(alone.queues.minorTech), []);

		const allied = seat({ "phase": 3 }, ["unlock_shared_los"]);
		(allied.world.gameState as unknown as { hasAllies: () => boolean }).hasAllies = () => true;
		allied.manager.update(allied.world.gameState, allied.queues);
		assert.deepEqual(queued(allied.queues.minorTech), ["unlock_shared_los"]);
	});

	it("nothing is queued while a tech is already waiting", () =>
	{
		for (const queue of ["minorTech", "majorTech"])
		{
			const s = seat({ "phase": 3 }, ["unlock_champion_infantry"]);
			(s.queues[queue] as unknown as { hasQueuedUnits: () => boolean }).hasQueuedUnits = () => true;
			s.manager.update(s.world.gameState, s.queues);
			assert.deepEqual(queued(s.queues.minorTech), [], queue);
		}
	});
});

describe("the research manager's bookkeeping", () =>
{
	it("sums a cost, and saves nothing", () =>
	{
		const { manager } = seat();
		assert.equal(manager.CostSum({ "food": 100, "metal": 50 }), 150);
		assert.deepEqual(manager.Serialize(), {});
		manager.Deserialize({});
	});
});
