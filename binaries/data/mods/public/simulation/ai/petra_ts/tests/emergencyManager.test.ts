/**
 * The emergency manager: it watches the population, the structures and the
 * territory roots (civil centres, military colonies) of the town, calls
 * the allies for help when they collapse, and says so again when the town
 * has recovered.
 *
 * The thresholds are the real Config's emergency values for the default
 * difficulty (Config.setConfig): population 0.6, structures 0.6, roots 0.5.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resetRecorder, sent } from "./harness/engine.ts";
import { makeEntity } from "./harness/fakes.ts";
import { makeWorld, PLAYER, type World } from "./harness/world.ts";

import { Config } from "../decision/config.ts";
import { EmergencyManager } from "../decision/emergencyManager.ts";

/** the chat lines setConfig's factors lead to, as chatHelper lists them */
const ENTER_LINES = [
	"My armies failed while defending my empire. Please honor our alliance and send help!",
	"My humble armies feel weak and tired. My civilization depends on our alliance, please send help!",
	"I need your help. Please do not let my armies fall!"
];
const EXIT_LINES = [
	"My empire regained its old strength, now it is time to seek revenge together!",
	"My civilization raised from the ashes. Now my armies feel stronger and eager to fight for our alliance."
];

interface Town
{
	world: World;
	/** the population the game counts now */
	population: { value: number };
	/** add structures: `roots` of them root territory (civil centres), the rest do not (houses) */
	build(roots: number, others: number): void;
	/** destroy structures of either kind */
	lose(roots: number, others: number): void;
	manager: InstanceType<typeof EmergencyManager>;
}

let nextId = 2000;

/** A town with a population and structures, and a manager that took its measure at game start. */
function town(population: number, roots: number, others: number): Town
{
	resetRecorder();
	const world = makeWorld();
	// the seed civil centre of the world is not part of this town's count
	world.removeEntity(1000);
	const pop = { "value": population };
	world.gameState.getPopulation = () => pop.value;
	const rootIds: number[] = [];
	const otherIds: number[] = [];
	const add = (root: boolean) =>
	{
		const id = nextId++;
		world.addEntity(makeEntity({
			id, "owner": PLAYER, "position": [100, 100],
			"classes": root ? ["Structure", "CivCentre"] : ["Structure", "House"],
			"templateName": root ? "structures/athen/civil_centre" : "structures/athen/house"
		}, {
			// as the parsed template gives it: every structure has a
			// TerritoryInfluence node; only the roots say Root "true"
			"get": (path: string) => path === "TerritoryInfluence" ?
				{ "Root": root ? "true" : "false", "Radius": root ? "140" : "20", "Weight": "30000" } : undefined
		}));
		(root ? rootIds : otherIds).push(id);
	};
	const build = (r: number, o: number) =>
	{
		for (let i = 0; i < r; ++i)
			add(true);
		for (let i = 0; i < o; ++i)
			add(false);
	};
	const lose = (r: number, o: number) =>
	{
		for (const id of rootIds.splice(0, r))
			world.removeEntity(id);
		for (const id of otherIds.splice(0, o))
			world.removeEntity(id);
	};
	build(roots, others);
	const config = new Config();
	config.emergencyValues = { "population": 0.6, "structures": 0.6, "roots": 0.5 };
	const manager = new EmergencyManager(config);
	manager.init(world.gameState);
	return { world, "population": pop, build, lose, manager };
}

/** the ally chats the manager posted, as their message text */
function chats(): string[]
{
	return sent("aichat")
		.map((c) =>
		{
			assert.equal(c.translateMessage, true);
			assert.ok(c.message.startsWith("/allies "));
			return c.message.slice("/allies ".length);
		});
}

describe("emergency manager: when the town calls for help", () =>
{
	it("a town at peace takes its measure at game start", () =>
	{
		const { manager } = town(20, 1, 9);
		assert.equal(manager.referencePopulation, 20);
		assert.equal(manager.referenceStructureCount, 10);
		assert.equal(manager.numRoots, 1);
		assert.equal(manager.hasEmergency, false);
	});

	it("ordinary losses are no emergency", () =>
	{
		const t = town(20, 1, 9);
		t.population.value = 13;	// 0.65 of the reference
		t.lose(0, 3);				// 7 of 10 structures left
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, false);
		assert.deepEqual(chats(), []);
	});

	it("an army lost while the town stands is no emergency", () =>
	{
		const t = town(40, 1, 9);
		t.population.value = 10;
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, false);
	});

	it("losing most people and most buildings: the allies are asked for help", () =>
	{
		const t = town(20, 1, 9);
		t.population.value = 11;	// 0.55
		t.lose(0, 5);				// 5 of 10
		t.manager.update(t.world.gameState);

		assert.equal(t.manager.hasEmergency, true);
		const said = chats();
		assert.equal(said.length, 1);
		assert.ok(ENTER_LINES.includes(said[0]), said[0]);
		// the town is measured again from its ruins
		assert.equal(t.manager.referencePopulation, 11);
		assert.equal(t.manager.referenceStructureCount, 5);
		assert.equal(t.manager.numRoots, 1);
	});

	it("losing half the civil centres is an emergency on its own", () =>
	{
		const t = town(60, 2, 18);
		t.lose(1, 0);
		t.manager.update(t.world.gameState);

		assert.equal(t.manager.hasEmergency, true);
		assert.equal(chats().length, 1);
		assert.equal(t.manager.numRoots, 1);
	});

	it("a nomad start (no civil centre at all) is no emergency for want of roots", () =>
	{
		const t = town(10, 0, 0);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, false);
	});

	it("a nomad army wiped out before it settled: no people and no buildings is an emergency", () =>
	{
		// a start with no structures and an army that dies before the first update
		const t = town(5, 0, 0);
		t.population.value = 0;
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
	});

	it("the measure follows growth, so a later collapse is judged from the peak", () =>
	{
		const t = town(20, 1, 9);
		t.population.value = 50;
		t.build(1, 10);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.referencePopulation, 50);
		assert.equal(t.manager.referenceStructureCount, 21);
		assert.equal(t.manager.numRoots, 2);
		assert.equal(t.manager.hasEmergency, false);

		// back to the starting size: 0.4 of the peak people, 10 of 21 buildings
		t.population.value = 20;
		t.lose(0, 11);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
	});

	it("smaller shrinkage does not lower the measure", () =>
	{
		const t = town(20, 1, 9);
		t.population.value = 18;
		t.lose(0, 1);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.referencePopulation, 20);
		assert.equal(t.manager.referenceStructureCount, 10);
	});
});

describe("emergency manager: the way out", () =>
{
	/** a town just fallen into emergency at 10 people and 5 buildings, one root left */
	function fallen(): Town
	{
		const t = town(20, 1, 9);
		t.population.value = 10;
		t.lose(0, 5);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
		resetRecorder();
		return t;
	}

	it("a modest recovery is not enough", () =>
	{
		const t = fallen();
		t.population.value = 12;	// exactly 1.2 times: not above
		t.build(0, 2);				// 7 of 5
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
		assert.deepEqual(chats(), []);
		// in emergency the measure stays where the fall left it
		assert.equal(t.manager.referencePopulation, 10);
	});

	it("growing people alone is not enough: the town must rebuild too", () =>
	{
		const t = fallen();
		t.population.value = 30;
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
	});

	it("over a fifth more people and buildings: the allies hear the town is back", () =>
	{
		const t = fallen();
		t.population.value = 13;
		t.build(0, 2);
		t.manager.update(t.world.gameState);

		assert.equal(t.manager.hasEmergency, false);
		const said = chats();
		assert.equal(said.length, 1);
		assert.ok(EXIT_LINES.includes(said[0]), said[0]);
		assert.equal(t.manager.referencePopulation, 13);
		assert.equal(t.manager.referenceStructureCount, 7);
	});

	it("a new civil centre ends the emergency at once", () =>
	{
		const t = fallen();
		t.build(1, 0);
		t.manager.update(t.world.gameState);

		assert.equal(t.manager.hasEmergency, false);
		assert.equal(t.manager.numRoots, 2);
		assert.equal(chats().length, 1);
	});

	it("in emergency a further collapse does not call again", () =>
	{
		const t = fallen();
		t.population.value = 2;
		t.lose(1, 3);
		t.manager.update(t.world.gameState);
		assert.equal(t.manager.hasEmergency, true);
		assert.deepEqual(chats(), []);
	});
});
