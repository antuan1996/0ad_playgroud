/**
 * BuildManager: the ledger of who can raise stones. init() walks the own
 * units and books every one against the structures its Builder/Entities
 * template names; checkEvents keeps that book fresh over a turn's events —
 * births, deaths, captures, and overhauls of the Builder component (which the
 * game answers by dumping and rebuilding the whole book, since the engine
 * cannot say which single entity changed). Around the book the office parks
 * the structures it must not keep asking about (unbuildables), each hold out
 * for a wait counted in game seconds: forever when the template itself is
 * wrong, a computed timeout when only the circumstances are.
 *
 * The manager here is built through its own constructor, on the world harness
 * the other manager campaigns use; the units are fakes that answer the
 * Builder questions the office hears.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventsWith, makeEntity, makeTemplate, type Methods } from "./harness/fakes.ts";
import { ENEMY, makeWorld, PLAYER, type World } from "./harness/world.ts";

import { entityId, seconds, templateName } from "../adapter/brands.ts";
import { BuildManager } from "../decision/buildManager.ts";

/** a support unit whose Builder/Entities/_string names the structures it can
 * raise: the game keeps that list on the unit's template, and the common-api
 * hands the office the {civ}-substituted names, which is what the books see */
function builderUnit(id: number, buildables: string[] | undefined, methods: Methods = {}): CommonEntity
{
	return makeEntity({ id, owner: PLAYER, position: [40, 40], classes: ["Unit", "Support"] }, {
		// as the common-api Entity.buildableEntities (entity.js 339) expands
		// Builder/Entities/_string: {civ} becomes the player's civ, and no
		// Builder/Entities tag leaves the list empty
		buildableEntities: (civ: string) => (buildables ?? []).map(name => name.replace("{civ}", civ)),
		isOwn: (player: number) => player === PLAYER,
		...methods
	});
}

/** a structure self-standing on the map is not a builder of anything */
function structure(id: number, buildables?: string[]): CommonEntity
{
	return makeEntity({ id, owner: PLAYER, position: [40, 41],
		classes: ["Structure", "House"] }, {
		buildableEntities: (civ: string) => (buildables ?? []).map(name => name.replace("{civ}", civ))
	});
}

/** the registered templates one buildable town needs, keyed by name */
function registerTemplates(world: World): void
{
	world.templates["structures/athen/house"] = makeTemplate("structures/athen/house",
		{ "classes": ["Structure", "House", "Economic"] });
	world.templates["structures/athen/storehouse"] = makeTemplate("structures/athen/storehouse",
		{ "classes": ["Structure", "Storehouse", "Economic"] });
	world.templates["structures/athen/defense_tower"] = makeTemplate("structures/athen/defense_tower",
		{ "classes": ["Structure", "Tower", "Defensive"] });
	world.templates["structures/athen/stable"] = makeTemplate("structures/athen/stable",
		{ "classes": ["Structure", "Stable"], "available": false });
}

describe("the builder book: who can raise what", () =>
{
	it("a support unit ready to build a house takes it into the book", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));

		mgr.init(world.gameState);

		assert.deepEqual(
			[...mgr.builders.keys()], ["structures/athen/house"],
			"the {civ} stand-in came out as the player's civ");
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3001]);
	});

	it("a unit with no Builder tag raises nothing, and a structure raises nothing", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		// the common support unit owns no Builder/Entities tag; a structure,
		// whatever its template, is outside the getOwnUnits walk
		world.addEntity(builderUnit(3001, undefined));
		world.addEntity(structure(3100, ["structures/{civ}/house"]));

		mgr.init(world.gameState);

		assert.equal(mgr.builders.size, 0, "no template is booked");
	});

	it("two builders share a template entry, and the ids keep their order", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house", "structures/{civ}/storehouse"]));
		world.addEntity(builderUnit(3002, ["structures/{civ}/house"]));

		mgr.init(world.gameState);

		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3001, 3002]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/storehouse")), [3001]);
	});
});

describe("the book over one turn's events", () =>
{
	it("a fresh unit walks in with its buildables", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.init(world.gameState);
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));

		mgr.checkEvents(world.gameState, eventsWith({ "Create": [{ "entity": entityId(3001) }] }));

		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3001]);
		assert.equal(mgr.elapsedTime, 100, "the office named the turn's own time");
	});

	it("a unit created and destroyed the same turn is never booked", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.init(world.gameState);
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));

		mgr.checkEvents(world.gameState, eventsWith({
			"Create": [{ "entity": entityId(3001) }],
			"Destroy": [{ "entity": entityId(3001) }]
		}));

		assert.equal(mgr.builders.size, 0, "the birth that was undone leaves no entry");
	});

	it("a destroyed builder leaves every entry it filled, empty list behind", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house", "structures/{civ}/storehouse"]));
		world.addEntity(builderUnit(3002, ["structures/{civ}/house"]));
		mgr.init(world.gameState);

		mgr.checkEvents(world.gameState, eventsWith({ "Destroy": [{ "entity": entityId(3001) }] }));

		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3002]);
		// the storehouse entry had only this builder: the removal splices his
		// id out and the now-empty list stays as the template's book page
		assert.deepEqual(
			[...mgr.builders.keys()], ["structures/athen/house", "structures/athen/storehouse"]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/storehouse")), []);
	});

	it("a captured builder takes his skills over", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.init(world.gameState);
		// the captured worker now fights for us: the engine names the entity
		// and the new owner, the office asks its template
		world.ents.set(3001, builderUnit(3001, ["structures/{civ}/house"]));

		mgr.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": entityId(3001), "from": ENEMY, "to": PLAYER }]
		}));

		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3001]);
	});

	it("a builder captured away leaves the book, whoever raises stones", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		const other = builderUnit(3002, ["structures/athen/storehouse"]);
		world.addEntity(other);
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));
		mgr.init(world.gameState);

		mgr.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": entityId(3001), "from": PLAYER, "to": ENEMY }]
		}));

		// the storehouse entry stands untouched; the captured builder's id is
		// spliced out of the house list, and the emptied page stays as the
		// template's book page
		assert.deepEqual([...mgr.builders.keys()],
			["structures/athen/storehouse", "structures/athen/house"]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/storehouse")), [3002]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), []);
	});

	it("an overhaul of the Builder component dumps and rebuilds the whole book", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		const incumbent = builderUnit(3001, ["structures/{civ}/house"]);
		world.addEntity(incumbent);
		mgr.init(world.gameState);

		// the season rolls over: the house builder died, and a new support
		// unit walked in with a wider list. The engine cannot say which single
		// builder changed, so the overhaul reads as a full dump.
		world.removeEntity(3001);
		world.addEntity(builderUnit(3002, ["structures/athen/storehouse", "structures/{civ}/house"]));

		mgr.checkEvents(world.gameState, eventsWith({
			"ValueModification": [{ "entities": [entityId(3002)], "component": "Builder", "valueNames": ["Builder/Entities/_string"] }]
		}));

		assert.deepEqual(
			[...mgr.builders.keys()], ["structures/athen/storehouse", "structures/athen/house"]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3002]);
		assert.deepEqual(mgr.builders.get(templateName("structures/athen/storehouse")), [3002]);
	});

	it("an overhaul of some other component leaves the book alone", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));
		mgr.init(world.gameState);

		mgr.checkEvents(world.gameState, eventsWith({
			// the wrong component, and the right one touched on a value the
			// builder lists do not start with
			"ValueModification": [
				{ "entities": [entityId(3001)], "component": "Aura", "valueNames": ["Builder/Ratio"] },
				{ "entities": [entityId(3001)], "component": "Builder", "valueNames": ["Armour/Hack"] }
			]
		}));

		assert.deepEqual(mgr.builders.get(templateName("structures/athen/house")), [3001]);
	});
});

describe("what a project needs in the book", () =>
{
	it("findStructuresByFilter walks the book and refuses the dead entries", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		registerTemplates(world);
		// the town's builders: one raises houses and stables, one raises the
		// defense tower, one raises a template the engine never shipped
		world.addEntity(builderUnit(3001, ["structures/athen/house", "structures/athen/stable"]));
		world.addEntity(builderUnit(3002, ["structures/athen/defense_tower"]));
		world.addEntity(builderUnit(3003, ["structures/athen/missing"]));
		mgr.init(world.gameState);
		// the game disables the tower per civ
		world.gameState.isTemplateDisabled =
			(name: string) => name === "structures/athen/defense_tower";

		const every = mgr.findStructuresByFilter(world.gameState, { "func": () => true, "dynamicProperties": [] });

		assert.deepEqual(
			every, ["structures/athen/house"],
			"the disabled tower, the one the requirements refuse, the unshipped template and the " +
			"stable list check out one by one");
	});

	it("a project that wants a tower class finds none when every holder is gone", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		registerTemplates(world);
		world.addEntity(builderUnit(3001, ["structures/athen/house"]));
		mgr.init(world.gameState);

		assert.equal(
			mgr.findStructureWithClass(world.gameState, ["Tower"]), undefined,
			"no booked template carries the class");
	});

	it("findStructureWithClass answers the first booked template of the class", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		registerTemplates(world);
		world.addEntity(builderUnit(3001, ["structures/athen/storehouse"]));
		world.addEntity(builderUnit(3002, ["structures/athen/house"]));
		mgr.init(world.gameState);

		// both buildings share the Economic class; the book's own order picks
		// which template the office reads first (TODO in the source: when
		// several available, choose the best one)
		assert.equal(
			mgr.findStructureWithClass(world.gameState, ["Economic"]), "structures/athen/storehouse");
		assert.equal(
			mgr.findStructureWithClass(world.gameState, ["House"]), "structures/athen/house");
	});

	it("hasBuilder answers the booked id list, and stays silent with no entry", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house"]));
		mgr.init(world.gameState);

		assert.equal(mgr.hasBuilder(templateName("structures/athen/house")), true,
			"the id list counts somebody — the office answers just true, not the list");
		assert.equal(mgr.hasBuilder(templateName("structures/athen/fortress")), undefined,
			"a template nobody raised in the book answers `undefined`");
		// the empty page a removal stranded: the `numBuilders && length > 0`
		// read answers false
		mgr.builders.set(templateName("structures/athen/fortress"), []);
		assert.equal(mgr.hasBuilder(templateName("structures/athen/fortress")), false);
	});
});

describe("the parking lot: unbuildables and their waits", () =>
{
	it("a room refusal parks the template for the default season", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();

		mgr.setUnbuildable(world.gameState, "structures/athen/house");

		assert.deepEqual(
			[...mgr.unbuildables.entries()],
			[["structures/athen/house", { "reason": "room", "time": 190 }]],
			"the wait runs from the turn's own time, 90 seconds as the default names");
		assert.equal(mgr.isUnbuildable(world.gameState, "structures/athen/house"), true);
	});

	it("the very second the wait ends the office asks again", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 90);
		world.ai.elapsedTime = seconds(190);

		assert.equal(
			mgr.isUnbuildable(world.gameState, "structures/athen/house"), false,
			"a hold `time` above the elapsed time is the guarded word: at equality the hold is over");
	});

	it("a later, longer wait takes over the row; a shorter one cannot", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 90, "room");

		world.ai.elapsedTime = seconds(160);
		// somebody parks the same house again, briefly, for another reason
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 30, "nobuilder");
		assert.deepEqual(mgr.unbuildables.get("structures/athen/house"),
			{ "reason": "room", "time": 190 }, "the shorter hold loses, reasons kept with it");

		// then a longer hold over the row takes both the time and the reason
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 100, "limit");
		assert.deepEqual(mgr.unbuildables.get("structures/athen/house"),
			{ "reason": "limit", "time": 260 });
	});

	it("setBuildable clears the hold", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 90);

		mgr.setBuildable("structures/athen/house");

		assert.equal(mgr.isUnbuildable(world.gameState, "structures/athen/house"), false);
	});

	it("numberMissingRoom counts the live room holds only, and the reset clears all of them", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		mgr.setUnbuildable(world.gameState, "structures/athen/house", 90, "room");
		mgr.setUnbuildable(world.gameState, "structures/athen/storehouse", 200, "room");
		mgr.setUnbuildable(world.gameState, "structures/athen/stable", 90, "nobuilder");
		// one room hold already ran out
		world.ai.elapsedTime = seconds(200);

		assert.equal(mgr.numberMissingRoom(world.gameState), 1,
			"the house's hold expired at 190, the storehouse still parks; the stable never counted as room");

		mgr.resetMissingRoom(world.gameState);

		assert.deepEqual(
			[...mgr.unbuildables.keys()], ["structures/athen/stable"],
			"the room rows go even when unexpired; the other reason stays");
		assert.equal(mgr.numberMissingRoom(world.gameState), 0);
	});

	it("the ledger saves and reloads whole: builders, holds and all", () =>
	{
		const world = makeWorld();
		const mgr = new BuildManager();
		world.addEntity(builderUnit(3001, ["structures/{civ}/house", "structures/{civ}/storehouse"]));
		mgr.init(world.gameState);
		mgr.setUnbuildable(world.gameState, "structures/athen/fortress", 90, "limit");

		const saved = mgr.Serialize();
		const restored = new BuildManager();
		restored.Deserialize(saved);

		assert.deepEqual(restored.Serialize(), saved);
		// and the loaded book keeps its meaning as well
		assert.equal(restored.hasBuilder(templateName("structures/athen/house")), true);
		const bookedIds = saved.builders.get(templateName("structures/athen/house"));
		assert.deepEqual(bookedIds, [3001]);
		assert.deepEqual(restored.unbuildables.get("structures/athen/fortress"),
			{ "reason": "limit", "time": 190 });
	});
});
