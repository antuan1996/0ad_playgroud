/**
 * GarrisonManager: the office that rents out wall slots. A unit that is sent
 * behind stones first enters the office's pre-garrison book; each turn the
 * office checks who arrived, whose march order failed, whether the threats
 * around a structure still justify its residents, and how many men a
 * decaying wall still needs. The suites walk that week: orders to lodge and
 * their refusals, marchers who reach their seat or lose their order, the
 * three-second patrol that releases swordsmen when a bolt catches them out,
 * heroes holding their hold during sieges, keepers lost to battle or
 * promotion, upgrades relabelling the book, the decay watch begging its
 * walls full of men, and the counts a hundred other offices ask for.
 *
 * The manager here is built through its own constructor, the way the
 * headquarters does, and is driven through update() or the single calls a
 * turn would make. The holders book is real Map book (the manager's own);
 * entities are fakes that answer the engine questions the office hears.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import {
	emptyEvents, ENEMY, GAIA, makeEntity, makeWorld, PLAYER
} from "./harness/attackWorld.ts";
import type { FakeEnt, Methods, World } from "./harness/attackWorld.ts";
import { logs, resetRecorder } from "./harness/engine.ts";
import { restoreEngine } from "./harness/attackWorld.ts";

const { GarrisonManager } = await loadPetraModule<{
	GarrisonManager: (new (Config: unknown) => GarrisonManagerLike) & {
		TYPE_FORCE: string;
		TYPE_TRADE: string;
		TYPE_PROTECTION: string;
		TYPE_DECAY: string;
		TYPE_EMERGENCY: string;
	};
}>("garrisonManager");
const { Worker } = await loadPetraModule<{
	Worker: { SUBROLE_GARRISONING: string };
}>("worker");

/** what the tests of the one manager ask it */
type HolderDataLike = { list: number[]; allowMelee: boolean };
type GarrisonManagerLike = Record<string, any> & {
	holders: Map<number, HolderDataLike>;
	decayingStructures: Map<number, number>;
	update(gameState: CommonGameState, events: EngineAIEvents): void;
	numberOfGarrisonedUnits(holder: FakeEnt): number;
	numberOfGarrisonedSlots(holder: FakeEnt): number;
	allowMelee(holder: FakeEnt): boolean | undefined;
	garrison(gameState: CommonGameState, ent: FakeEnt, holder: FakeEnt, type: string): void;
	leaveGarrison(ent: FakeEnt): void;
	cancelGarrison(ent: FakeEnt): void;
	keepGarrisoned(ent: FakeEnt, holder: FakeEnt,
		around: { defenseStructure: boolean; meleeSiege: boolean; rangeSiege: boolean; unit: boolean }): boolean;
	registerHolder(gameState: CommonGameState, holder: FakeEnt): HolderDataLike;
	addDecayingStructure(gameState: CommonGameState, entId: number, justCaptured?: boolean): boolean;
	removeDecayingStructure(entId: number): void;
	Serialize(): Record<string, unknown>;
	Deserialize(data: Record<string, unknown>): void;
};

/** the turn's events as the engine raises them, with extras added */
function eventsWith(extra: Record<string, unknown[]>): EngineAIEvents
{
	const events = emptyEvents() as unknown as Record<string, unknown[]>;
	for (const [name, list] of Object.entries(extra))
		events[name] = list;
	return events as unknown as EngineAIEvents;
}

/** the manager of one headquarters as the constructor builds it */
function makeGarrisonManager(world: World): GarrisonManagerLike
{
	return new GarrisonManager(world.ai.Config);
}

/** a watch structure: the tower of the frontier week, with per-test answers */
function towerWorld(overrides: Methods = {}): { world: World; manager: GarrisonManagerLike; tower: FakeEnt }
{
	const world = makeWorld();
	const manager = makeGarrisonManager(world);
	const tower = makeEntity({
		id: 5000, owner: PLAYER, position: [30, 30], classes: ["Structure", "Tower"]
	}, {
		isGarrisonHolder: () => true,
		garrisonableClasses: () => ["Infantry"],
		garrisonMax: () => 10,
		attackRange: (type: string) => type == "Ranged" ? ({ "max": 60 }) : undefined,
		...overrides
	});
	world.addEntity(tower);
	return { world, manager, tower };
}

/** a unit on the walk to its appointed slot, as the engine order shows */
function walker(id: number, holderId: number, methods: Methods = {}, metadata: Record<string, unknown> = {}): FakeEnt
{
	return makeEntity({
		id, owner: PLAYER, position: [20, 20], classes: ["Unit", "Infantry"]
	}, {
		canGarrison: () => true,
		unitAIOrderData: () => [{ "target": holderId }],
		...methods
	}, metadata);
}

/** the registered entity, plainly; its overridable answers count in Methods */
function entOf(world: World, id: number): FakeEnt & Methods
{
	return world.ents.get(id) as FakeEnt & Methods;
}

/** a tower's leaf in the holder book */
function leaf(manager: GarrisonManagerLike, id: number): HolderDataLike
{
	return manager.holders.get(id) as HolderDataLike;
}

/** an armed resident: one soldier seated in the holder, booked for protection */
function residentArm(id: number, attackTypes: string[], methods: Methods = {},
	metadata: Record<string, unknown> = { "garrisonType": GarrisonManager.TYPE_PROTECTION }): FakeEnt
{
	return makeEntity({
		id, owner: PLAYER, position: [30, 31], classes: ["Unit", "Infantry", "CitizenSoldier"]
	}, {
		attackTypes: () => attackTypes,
		canGarrison: () => true,
		...methods
	}, metadata);
}

/** a foe the three-second patrol hears around the wall */
function foeUnit(id: number, position: [number, number], spec: {
	classes?: string[];
	owner?: number;
	attackTypes?: string[];
	combat?: boolean;
	methods?: Methods;
} = {}): FakeEnt
{
	return makeEntity({
		id, owner: spec.owner ?? ENEMY, position,
		classes: ["Unit", ...(spec.classes ?? [])]
	}, {
		unitAIState: () => spec.combat === false ? "INDIVIDUAL.IDLE" : "INDIVIDUAL.COMBAT.ATTACKING",
		attackTypes: () => spec.attackTypes,
		...spec.methods
	});
}

/** a wall the decay office begs full */
function decayedTower(id: number, methods: Methods = {}): FakeEnt
{
	return makeEntity({
		id, owner: PLAYER, position: [30, 30], classes: ["Structure", "Tower"]
	}, {
		isGarrisonHolder: () => true,
		garrisonMax: () => 10,
		hasDefensiveFire: () => true,
		territoryDecayRate: () => 6,
		garrisonRegenRate: () => 2,
		defaultRegenRate: () => 2,
		...methods
	});
}

describe("garrisonManager", () =>
{
	describe("orders to lodge", () =>
	{
		it("opens a pre-garrison book and sends the archer marching", () =>
		{
			const { world, manager, tower } = towerWorld();
			const marchingTo: number[] = [];
			const archer = walker(3000, tower.id(), {
				garrison: (holder: unknown) => { marchingTo.push((holder as FakeEnt).id()); }
			});
			world.addEntity(archer);

			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);

			assert.deepEqual(marchingTo, [5000], "the march was ordered toward the tower");
			const book = manager.holders.get(5000);
			assert.ok(book, "the tower was written into the book");
			assert.deepEqual(book.list, [3000], "the walker sits on the pre-garrison leaf");
			assert.equal(archer.getMetadata(PLAYER, "plan"), -3,
				"a unit marching for no plan wears the -3 marker");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_GARRISONING);
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), 5000);
			assert.equal(archer.getMetadata(PLAYER, "garrisonType"), GarrisonManager.TYPE_PROTECTION);
			assert.equal(tower.getMetadata(PLAYER, "holderTimeUpdate"), 100, "the wall's watch clock started");
			assert.equal(manager.numberOfGarrisonedUnits(tower), 1);
			assert.equal(manager.numberOfGarrisonedSlots(tower), 1, "the walker holds one slot");
		});

		it("books two marchers on the same leaf", () =>
		{
			const { world, manager, tower } = towerWorld();
			world.addEntity(walker(3000, tower.id()));
			world.addEntity(walker(3001, tower.id()));

			manager.garrison(world.gameState, entOf(world, 3000) as FakeEnt, tower, GarrisonManager.TYPE_PROTECTION);
			manager.garrison(world.gameState, entOf(world, 3001) as FakeEnt, tower, GarrisonManager.TYPE_PROTECTION);

			const book = manager.holders.get(5000);
			assert.ok(book, "the tower was written into the book");
			assert.deepEqual(book.list, [3000, 3001], "both marchers share the tower's leaf");
		});

		it("a unit that serves a plan keeps him marked -2 and lands him back", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id(), {}, { "plan": 4 });
			world.addEntity(archer);

			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			assert.equal(archer.getMetadata(PLAYER, "plan"), -2, "the plan keeps him aboard");
			manager.leaveGarrison(archer);
			assert.equal(archer.getMetadata(PLAYER, "plan"), -1, "the plan reclaimed him on landing");
		});

		it("refuses a tower whose slots are taken", () =>
		{
			const { world, manager, tower } = towerWorld({ garrisonedSlots: () => 10 });
			const marchingTo: number[] = [];
			const archer = walker(3000, tower.id(), {
				garrison: (holder: unknown) => { marchingTo.push((holder as FakeEnt).id()); }
			});
			world.addEntity(archer);

			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);

			assert.equal(marchingTo.length, 0, "no march was ordered");
			assert.equal(manager.holders.size, 0, "no book was opened");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
		});

		it("refuses a unit that cannot lodge", () =>
		{
			const { world, manager, tower } = towerWorld();
			const marcher = walker(3000, tower.id(), { canGarrison: () => false });
			world.addEntity(marcher);

			manager.garrison(world.gameState, marcher, tower, GarrisonManager.TYPE_EMERGENCY);

			assert.equal(manager.holders.size, 0, "the office wrote nothing");
			assert.equal(marcher.getMetadata(PLAYER, "garrisonHolder"), undefined);
			assert.equal(marcher.getMetadata(PLAYER, "garrisonType"), undefined);
		});
	});

	describe("the ledger of the march", () =>
	{
		it("keeps the book while the archer still walks", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(leaf(manager, 5000).list, [3000], "still on the march");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_GARRISONING);
		});

		it("unlocks the archer when he takes his seat", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			entOf(world, 5000).garrisoned = () => [3000];	// the engine seated him
			entOf(world, 5000).garrisonedSlots = () => 1;

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(leaf(manager, 5000).list, [], "his leaf is free again");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), undefined, "he is no longer marching");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
			// garrisonType outlives leaveGarrison: the release patrol reads it
			assert.equal(archer.getMetadata(PLAYER, "garrisonType"), GarrisonManager.TYPE_PROTECTION);
			assert.equal(manager.allowMelee(tower), true, "the fresh book still allows melee by default");
		});

		it("gives up on a march whose order failed", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			// the slots filled meanwhile: the engine dropped his order
			entOf(world, 3000).unitAIOrderData = () => [];

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(leaf(manager, 5000).list, [], "the failed march left the leaf");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined, "he was released");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), undefined);
		});

		it("leaves a re-booked marcher to the office that reseated him", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			// the worker's office reseated him on another structure, engine order too
			archer.setMetadata(PLAYER, "garrisonHolder", 5001);
			archer.unitAIOrderData = () => [{ "target": 5001 }];

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(leaf(manager, 5000).list, [], "our leaf is free");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), 5001,
				"the reseating office keeps its own booking");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_GARRISONING,
				"we did not undo another office's booking");
			assert.equal(archer.getMetadata(PLAYER, "plan"), -3);
		});

		it("strikes a marcher who died on the road", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.removeEntity(3000);

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(leaf(manager, 5000).list, [], "the fallen marcher left the leaf");
		});

		it("stops the booked marcher we recall", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);

			manager.cancelGarrison(archer);

			assert.deepEqual(stopCalls, [3000], "the recall stopped his feet");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), undefined);
			assert.equal(archer.getMetadata(PLAYER, "plan"), undefined);
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
		});

		// Port-only amendment, wanted by the mod owner: the original reads the
		// booking after the release has already wiped it, so its ledger strike
		// is dead code and a cancelled marcher stays written on the holder's
		// list for good. The port reads the booking first and does strike it.
		it("strikes the cancelled marcher from the keeper's list, too", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			assert.deepEqual(leaf(manager, tower.id()).list, [3000], "he stands written in the book");

			manager.cancelGarrison(archer);

			assert.deepEqual(stopCalls, [3000], "his feet were stopped as always");
			assert.deepEqual(leaf(manager, tower.id()).list, [],
				"the recall also struck his name from the keeper's ledger");
		});
	});

	describe("the patrol around the wall", () =>
	{
		it("keeps every soldier lodged while a raider stands at the gate", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.ai.elapsedTime = 104;	// the patrol runs three wall-seconds later
			world.addEntity(foeUnit(2000, [40, 30], { "classes": ["Infantry"], "attackTypes": ["Melee"] }));
			// a grazing gaia animal is no threat
			world.addEntity(foeUnit(2010, [35, 31], { "owner": GAIA, "classes": ["Animal"], "attackTypes": [], "combat": false }));

			manager.update(world.gameState, emptyEvents());

			assert.equal(manager.allowMelee(tower), true, "a plain foe at the gate allows melee");
			assert.equal(tower.getMetadata(PLAYER, "holderTimeUpdate"), 104, "the patrol wrote its round");
			assert.deepEqual(leaf(manager, 5000).list, [3000], "the archer remains on his leaf");
		});

		it("counts no threat in the woods standing by the wall", () =>
		{
			const unloadCalls: number[] = [];
			// the seated archer whose watch ends once the raid melts away
			const { world, manager, tower } = towerWorld({
				garrisoned: () => [3021],
				garrisonedSlots: () => 1,
				unload: (id: unknown) => { unloadCalls.push(id as number); }
			});
			const archer = residentArm(3021, ["Ranged"]);
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			// the engine lists every gaia decoration among the AI's "enemies":
			// a tree answers neither the Structure nor the Unit class, so the
			// patrol dismisses it without even asking its range
			world.addEntity(makeEntity({ id: 9000, owner: GAIA, position: [31, 30] }));
			world.ai.elapsedTime = 104;	// the three-second patrol walks past the forest

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(unloadCalls, [3021], "with no foe left, the archer went back to the field");
			assert.equal(manager.allowMelee(tower), false, "scenery grants neither threat nor melee verdict");
			assert.equal(tower.getMetadata(PLAYER, "holderTimeUpdate"), 104, "the patrol walked its round");
		});

		it("hears the shots of an enemy tower and keeps its men too", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.ai.elapsedTime = 104;
			// a market cannot shoot: the engine answers no ranged range for it
			world.addEntity(makeEntity({ id: 5010, owner: ENEMY, position: [40, 30],
				classes: ["Structure"] }, { attackRange: () => undefined }));
			world.addEntity(makeEntity({ id: 5011, owner: ENEMY, position: [40, 31],
				classes: ["Structure", "Tower"] },
				{ attackRange: (t: string) => t == "Ranged" ? ({ "max": 50 }) : undefined }));

			manager.update(world.gameState, emptyEvents());

			assert.equal(manager.allowMelee(tower), true, "a shooting tower allows melee as a plain foe would");
			assert.deepEqual(leaf(manager, 5000).list, [3000], "the archer stays on his leaf");
		});

		it("releases our swordsmen while a range ram hammers", () =>
		{
			const unloadCalls: number[] = [];
			// the tower was created reporting both seated men, and hands them out
			const { world, manager, tower } = towerWorld({
				garrisoned: () => [3021, 3022],
				garrisonedSlots: () => 2,
				unload: (id: unknown) => { unloadCalls.push(id as number); }
			});
			const swordsman = residentArm(3021, ["Melee"]);
			const archer = residentArm(3022, ["Ranged"]);
			world.addEntity(swordsman);
			world.addEntity(archer);
			// the first man took his seat that morning: the book opened at once
			manager.registerHolder(world.gameState, tower);
			world.ai.elapsedTime = 101;	// the march lands, and the leaves are freed
			manager.update(world.gameState, emptyEvents());
			world.ai.elapsedTime = 104;	// and the patrol then weighs who earns his wall
			world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [35, 30],
				classes: ["Unit", "Siege"] }, {
				unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
				attackTypes: () => ["Ranged"]
			}));

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(unloadCalls, [3021], "the arrows turn the swordsman out first");
			assert.equal(archer.getMetadata(PLAYER, "garrisonType"), GarrisonManager.TYPE_PROTECTION,
				"the archer stays lodged");
			assert.equal(manager.allowMelee(tower), false, "no plain foe at the gate");
		});

		it("keeps only the wounded swordsman under a melee siege", () =>
		{
			const unloadCalls: number[] = [];
			// (the tower was created holding both seated men and handing them out)
			const { world, manager, tower } = towerWorld({
				garrisoned: () => [3021, 3022],
				garrisonedSlots: () => 2,
				unload: (id: unknown) => { unloadCalls.push(id as number); }
			});
			const swordsman = residentArm(3021, ["Melee"]);
			const wounded = residentArm(3022, ["Melee"], { healthLevel: () => 0.3 });
			world.addEntity(swordsman);
			world.addEntity(wounded);
			manager.garrison(world.gameState, swordsman, tower, GarrisonManager.TYPE_PROTECTION);
			manager.garrison(world.gameState, wounded, tower, GarrisonManager.TYPE_PROTECTION);
			entOf(world, 5000).garrisoned = () => [3021, 3022];
			entOf(world, 5000).garrisonedSlots = () => 2;
			entOf(world, 5000).unload = (id: unknown) => { unloadCalls.push(id as number); };
			world.ai.elapsedTime = 101;
			manager.update(world.gameState, emptyEvents());
			world.ai.elapsedTime = 104;
			world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [35, 30],
				classes: ["Unit", "Siege"] }, {
				unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
				attackTypes: () => ["Melee"]
			}));

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(unloadCalls, [3021], "the healthy swordsman left, the wounded stayed");
		});

		it("holds a healing-house patient until he is well", () =>
		{
			const { world, manager } = towerWorld();
			const unloadCalls: number[] = [];
			const house = makeEntity({ id: 5001, owner: PLAYER, position: [40, 40],
				classes: ["Structure"] }, {
				isGarrisonHolder: () => true,
				garrisonableClasses: () => ["Support"],
				garrisonMax: () => 10,
				buffHeal: () => 8,
				garrisoned: () => [3023, 3024],
				garrisonedSlots: () => 2,
				unload: (id: unknown) => { unloadCalls.push(id as number); }
			});
			world.addEntity(house);
			house.setMetadata(PLAYER, "holderTimeUpdate", 100);
			const healer = makeEntity({ id: 3023, owner: PLAYER, position: [40, 41],
				classes: ["Unit", "Support", "Healer"] }, {
				attackTypes: () => [],
				canGarrison: () => true,
				isHealable: () => true,
				needsHeal: () => true
			});
			const fresh = makeEntity({ id: 3024, owner: PLAYER, position: [40, 42],
				classes: ["Unit", "Support", "Healer"] }, {
				attackTypes: () => [],
				canGarrison: () => true,
				isHealable: () => true,
				needsHeal: () => false
			});
			world.addEntity(healer);
			world.addEntity(fresh);
			manager.garrison(world.gameState, healer, house, GarrisonManager.TYPE_PROTECTION);
			manager.garrison(world.gameState, fresh, house, GarrisonManager.TYPE_PROTECTION);
			world.ai.elapsedTime = 101;
			manager.update(world.gameState, emptyEvents());
			world.ai.elapsedTime = 104;	// the town is quiet; the healing house weighs its patients

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(unloadCalls, [3024], "the whole patient kept his wall, the tougher one went home");
		});

		it("shields a villager mending in the healing house even when he is nearly whole", () =>
		{
			const { world, manager } = towerWorld();
			const released: number[] = [];
			const house = makeEntity({ id: 5001, owner: PLAYER, position: [40, 40],
				classes: ["Structure"] }, {
				isGarrisonHolder: () => true,
				garrisonableClasses: () => ["Support"],
				garrisonMax: () => 10,
				buffHeal: () => 8,
				garrisoned: () => [3030],
				garrisonedSlots: () => 1,
				unload: (id: unknown) => { released.push(id as number); }
			});
			world.addEntity(house);
			const villager = makeEntity({ id: 3030, owner: PLAYER, position: [40, 41],
				classes: ["Unit", "Support", "Worker"] }, {
				// the engine truth: an unarmed unit answers no attack types at all
				attackTypes: () => undefined,
				canGarrison: () => true,
				isHealable: () => true,
				needsHeal: () => true,			// isHurt() && isHealable(): he is still mending
				healthLevel: () => 0.9		// far from death, yet short of whole
			});
			world.addEntity(villager);
			manager.garrison(world.gameState, villager, house, GarrisonManager.TYPE_PROTECTION);
			world.ai.elapsedTime = 101;	// he takes his seat inside
			manager.update(world.gameState, emptyEvents());
			world.ai.elapsedTime = 104;	// the raiders have gone; the house keeps its patients

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(released, [], "the house kept him until he was whole");
			assert.equal(manager.holders.size, 1, "the healing house still keeps its post");
		});

		it("recalls a march whose cause fell before the marcher arrived", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			// the raid died under our arrows while the archer was still walking
			world.ai.elapsedTime = 104;	// the patrol then finds no cause at all

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(stopCalls, [3000], "the pointless march was recalled");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
			assert.equal(manager.holders.size, 0, "the idle tower needed no book");
			assert.equal(manager.allowMelee(tower), undefined, "the dropped book answers nothing");
		});
		it("takes the tower off the book once its seat lies empty", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			entOf(world, 5000).garrisoned = () => [3000];	// the archer took his seat
			entOf(world, 5000).garrisonedSlots = () => 1;
			world.ai.elapsedTime = 101;
			manager.update(world.gameState, emptyEvents());
			assert.deepEqual(leaf(manager, 5000).list, [], "he was freed from the leaf");

			// the raid then broke through: the seat stands empty when the patrol comes
			entOf(world, 5000).garrisoned = () => [];
			entOf(world, 5000).garrisonedSlots = () => 0;
			world.ai.elapsedTime = 104;

			manager.update(world.gameState, emptyEvents());

			assert.equal(manager.holders.size, 0, "the empty tower left the book too");
		});
	});
	describe("when the tower falls", () =>
	{
		it("frees our marchers when the tower is shattered", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			// one more marcher booked with another office, whom our loss must not touch
			const neighbor = walker(3001, 5001, { stopMoving: () => { stopCalls.push(3001); } });
			neighbor.setMetadata(PLAYER, "garrisonHolder", 5001);
			world.addEntity(archer);
			world.addEntity(neighbor);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.removeEntity(5000);	// the raider's ballista pulled the tower down

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(stopCalls, [3000], "only our own marcher was stopped");
			assert.equal(archer.getMetadata(PLAYER, "subrole"), undefined, "the march was cancelled");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
			assert.equal(neighbor.getMetadata(PLAYER, "garrisonHolder"), 5001,
				"the other office's booking stands untouched");
			assert.equal(manager.holders.size, 0, "the ruin left the book");
		});

		it("frees the marchers of a tower the enemy overran", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			entOf(world, 5000).owner = () => ENEMY;	// the enemy took the walls between turns

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(stopCalls, [3000]);
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
			assert.equal(manager.holders.size, 0, "an enemy keep guards no longer for us");
		});
	});

	describe("renames and upgrades", () =>
	{
		it("hands the book to the upgraded keep", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.addEntity(makeEntity({ id: 5050, owner: PLAYER, position: [30, 30],
				classes: ["Structure", "Tower", "Fortress"] }, {
				isGarrisonHolder: () => true,
				garrisonableClasses: () => ["Infantry"],
				garrisonMax: () => 20,
				attackRange: (t: string) => t == "Ranged" ? ({ "max": 80 }) : undefined
			}));
			// the engine relabels the marcher's order together with the tower
			archer.unitAIOrderData = () => [{ "target": 5050 }];

			manager.update(world.gameState, eventsWith({
				"EntityRenamed": [{ "entity": 5000, "newentity": 5050 }]
			}));

			assert.equal(manager.holders.has(5000), false, "the old name left the book");
			const book = manager.holders.get(5050);
			assert.ok(book, "the upgrade carried the keep's leaf over");
			assert.deepEqual(book.list, [3000], "the marcher walks on under the new name");
			assert.equal(book.allowMelee, true, "the new leaf keeps the melee verdict until the patrol");
		});

		it("frees the marchers when the upgrade ends the garrison", () =>
		{
			const { world, manager, tower } = towerWorld();
			const stopCalls: number[] = [];
			const archer = walker(3000, tower.id(), { stopMoving: () => { stopCalls.push(3000); } });
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			world.addEntity(makeEntity({ id: 5050, owner: PLAYER, position: [30, 30],
				classes: ["Structure", "Storehouse"] }));

			manager.update(world.gameState, eventsWith({
				"EntityRenamed": [{ "entity": 5000, "newentity": 5050 }]
			}));

			assert.deepEqual(stopCalls, [3000], "the marcher was recalled");
			assert.equal(archer.getMetadata(PLAYER, "garrisonHolder"), undefined);
			assert.equal(manager.holders.size, 0, "the storehouse holds no wall slots");
		});

		it("watches the decayed ground under the new keep", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			world.ents.delete(5000);
			world.addEntity(makeEntity({ id: 5050, owner: PLAYER, position: [30, 30],
				classes: ["Structure", "Tower"] }, {
				isGarrisonHolder: () => true,
				hasDefensiveFire: () => true,
				territoryDecayRate: () => 7,
				garrisonRegenRate: () => 2,
				defaultRegenRate: () => 2
			}));

			manager.update(world.gameState, eventsWith({
				"EntityRenamed": [{ "entity": 5000, "newentity": 5050 }]
			}));

			assert.equal(manager.decayingStructures.has(5000), false, "the ruin's watch ended");
			assert.equal(manager.decayingStructures.get(5050), 3,
				"the new keep asks ceil((7-2)/2) = 3 men at its walls");
		});

		it("forgets decay that the new keep does not rust", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			world.ents.delete(5000);
			world.addEntity(makeEntity({ id: 5050, owner: PLAYER, position: [30, 30],
				classes: ["Structure", "Tower"] }, { isGarrisonHolder: () => true }));

			manager.update(world.gameState, eventsWith({
				"EntityRenamed": [{ "entity": 5000, "newentity": 5050 }]
			}));

			assert.equal(manager.decayingStructures.size, 0, "the rebuilt keep needs no men");
		});

		it("leaves a fresh keep whose leaf was already written", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			// the same-turn bookkeeping race: two laps of the watch wrote both names
			world.addEntity(makeEntity({ id: 5050, owner: PLAYER, position: [30, 30],
				classes: ["Structure", "Tower"] }, {
				isGarrisonHolder: () => true,
				territoryDecayRate: () => 7,
				garrisonRegenRate: () => 2,
				defaultRegenRate: () => 2
			}));
			manager.decayingStructures.set(5050, 1);

			manager.update(world.gameState, eventsWith({
				"EntityRenamed": [{ "entity": 5000, "newentity": 5050 }]
			}));

			assert.equal(manager.decayingStructures.get(5050), 1, "the earlier leaf stands");
			assert.equal(manager.decayingStructures.size, 1);
		});
	});

	describe("the shrinking outer walls", () =>
	{
		it("watches a defensive keep that decay rusts", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);

			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			assert.equal(manager.decayingStructures.get(5000), 2,
				"the wall asks ceil((6-2)/2) = 2 men to hold its ground");
		});

		it("watches a barracks we won even without arrows", () =>
		{
			const { world, manager } = towerWorld();
			const barracks = makeEntity({ id: 5001, owner: PLAYER, position: [20, 20],
				classes: ["Structure", "Barracks"] }, {
				territoryDecayRate: () => 5,
				garrisonRegenRate: () => 2,
				defaultRegenRate: () => 1
			});
			world.addEntity(barracks);

			assert.equal(manager.addDecayingStructure(world.gameState, 5001, true), true,
				"a barracks just won needs garrisoned men against decay");
			assert.equal(manager.decayingStructures.get(5001), 2, "ceil((5-1)/2) = 2 men");
		});

		it("writes off a held barracks that serves no defense", () =>
		{
			const { world, manager } = towerWorld();
			const barracks = makeEntity({ id: 5001, owner: PLAYER, position: [20, 20],
				classes: ["Structure", "Barracks"] }, {
				territoryDecayRate: () => 5,
				garrisonRegenRate: () => 2,
				defaultRegenRate: () => 1
			});
			world.addEntity(barracks);

			assert.equal(manager.addDecayingStructure(world.gameState, 5001), false,
				"an old barracks is not worth wall men");
			assert.equal(manager.decayingStructures.size, 0);
		});

		it("writes off a keep that does not rust", () =>
		{
			const { world, manager } = towerWorld();
			const solid = makeEntity({ id: 5002, owner: PLAYER, position: [22, 22],
				classes: ["Structure", "Tower"] }, { hasDefensiveFire: () => true });
			world.addEntity(solid);

			assert.equal(manager.addDecayingStructure(world.gameState, 5002), false,
				"no decay, no watch");
			assert.equal(manager.decayingStructures.size, 0);
		});

		it("begs the walls full of men while the garrison is short", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000, {
				garrisonedSlots: () => 1,	// one man seated while the watch asks two
				garrisoned: () => [3010]
			});
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);

			manager.update(world.gameState, emptyEvents());

			assert.deepEqual(world.decayGarrisonCalls.map(([ent, data]) => [ent.id(), data]),
				[[5000, { "min": 2, "type": GarrisonManager.TYPE_DECAY }]],
				"the decay office asked the defense office for one more man");
		});

		it("a full watch needs no refill", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000, {
				garrisonedSlots: () => 2,
				garrisoned: () => [3010, 3011]
			});
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);

			manager.update(world.gameState, emptyEvents());

			assert.equal(world.decayGarrisonCalls.length, 0, "the wall was watched enough");
		});

		it("the enemy keeps leave the watch, and our ruins too", () =>
		{
			const { world, manager } = towerWorld();
			const taken = decayedTower(5000, { garrisonedSlots: () => 1, garrisoned: () => [3010] });
			world.addEntity(taken);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			entOf(world, 5000).owner = () => ENEMY;
			const ours = decayedTower(5001, {
				garrisonedSlots: () => 1, garrisoned: () => [3011]
			});
			world.addEntity(ours);
			assert.equal(manager.addDecayingStructure(world.gameState, 5001), true);

			manager.update(world.gameState, emptyEvents());

			assert.equal(manager.decayingStructures.has(5000), false, "the captured keep left the watch");
			assert.deepEqual(world.decayGarrisonCalls.map(([ent, data]) => [ent.id(), data]),
				[[5001, { "min": 2, "type": GarrisonManager.TYPE_DECAY }]],
				"ours begged for its last man");
		});

		it("dismisses the watch by hand when the decay ends", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000, { garrisonedSlots: () => 2, garrisoned: () => [3010, 3011] });
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);

			manager.removeDecayingStructure(5000);
			manager.update(world.gameState, emptyEvents());

			assert.equal(manager.decayingStructures.size, 0, "the watch was called off");
			assert.equal(world.decayGarrisonCalls.length, 0);
		});

		it("a name the watch never knew is simply nothing", () =>
		{
			const { world, manager } = towerWorld();
			manager.removeDecayingStructure(9999);	// a stray id from a lost age
			assert.equal(manager.decayingStructures.size, 0);
		});
	});
	describe("the fit of the lodged men", () =>
	{
		/** the quiet roster around a question: who may stay */
		const quiet = { "defenseStructure": false, "meleeSiege": false, "rangeSiege": false, "unit": false };

		it("a call to empty the hold is honored", () =>
		{
			const { world, manager, tower } = towerWorld();
			const heldForced = residentArm(3021, ["Melee"], {}, { "garrisonType": GarrisonManager.TYPE_FORCE });
			world.addEntity(heldForced);

			assert.equal(manager.keepGarrisoned(heldForced, tower, quiet), false,
				"a force call is the ticket out");
		});

		it("traders rest aboard their ship", () =>
		{
			const { world, manager, tower } = towerWorld();
			const trader = residentArm(3021, [], {}, { "garrisonType": GarrisonManager.TYPE_TRADE });
			world.addEntity(trader);

			assert.equal(manager.keepGarrisoned(trader, tower, quiet), true,
				"the trade run keeps its man aboard till the sea is calm");
		});

		it("a man being taken over stays for the counterstroke", () =>
		{
			const { world, manager, tower } = towerWorld();
			const captive = residentArm(3021, ["Melee"], { capturePoints: () => [2, 1, 1] },
				{ "garrisonType": GarrisonManager.TYPE_PROTECTION });
			world.addEntity(captive);

			assert.equal(manager.keepGarrisoned(captive, tower, quiet), true,
				"our quarter of the capture rose, he holds the wall");
		});

		it("a decaying keep keeps its men while the watch stands", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5000), true);
			const doomed = residentArm(3021, ["Melee"], { captureStrength: () => 4 },
				{ "garrisonType": GarrisonManager.TYPE_DECAY });
			const spent = residentArm(3022, ["Melee"], { captureStrength: () => 0 },
				{ "garrisonType": GarrisonManager.TYPE_DECAY });
			world.addEntity(doomed);
			world.addEntity(spent);

			assert.equal(manager.keepGarrisoned(doomed, keep, quiet), true,
				"his strength matters against decay");
			// the armed manager returns a mere falsy here, the port turns it to
			// a real false; both mean the same in every caller
			assert.ok(!manager.keepGarrisoned(spent, keep, quiet),
				"a man without power gains the wall nothing");
		});

		it("a decaying keep freed from decay lets its men go", () =>
		{
			const { world, manager } = towerWorld();
			const keep = decayedTower(5000);
			world.addEntity(keep);
			const doomed = residentArm(3021, ["Melee"], { captureStrength: () => 4 },
				{ "garrisonType": GarrisonManager.TYPE_DECAY });
			world.addEntity(doomed);

			assert.equal(manager.keepGarrisoned(doomed, keep, quiet), false,
				"no watch, no posts");
		});

		it("a hero holds the gates while foes stand near", () =>
		{
			const { world, manager } = towerWorld();
			const hero = residentArm(3021, ["Melee"],
				{ healthLevel: () => 1 }, { "garrisonType": GarrisonManager.TYPE_EMERGENCY });
			world.addEntity(hero);
			const attacked = { "defenseStructure": false, "meleeSiege": false, "rangeSiege": false, "unit": true };
			assert.equal(manager.keepGarrisoned(hero, entOf(world, 5000), attacked), true,
				"the assault keeps the hero behind the walls");

			const noFoe = { "defenseStructure": false, "meleeSiege": false, "rangeSiege": false, "unit": false };
			// the armed manager answers a bare undefined here, the port a false;
			// both empty truth for every caller
			assert.ok(!manager.keepGarrisoned(hero, entOf(world, 5000), noFoe),
				"the gates were opened once the foes walked away");
		});

		it("an on-board soldier is the transports' business, never ours", () =>
		{
			const { world, manager, tower } = towerWorld();
			const aboard = residentArm(3021, ["Melee"], {}, {
				"garrisonType": "unknownToUs", "onBoard": "onBoard"
			});
			world.addEntity(aboard);

			assert.equal(manager.keepGarrisoned(aboard, tower, quiet), true,
				"the naval office carries him, we only count him");
		});

		it("an unknown booking is refilled as protection and warned about", () =>
		{
			const { world, manager, tower } = towerWorld();
			const drifted = residentArm(3021, ["Melee"], {}, { "garrisonType": "somberLost" });
			world.addEntity(drifted);
			resetRecorder();

			assert.equal(manager.keepGarrisoned(drifted, tower, quiet), true,
				"the drifted sleeper is treated as a defender");
			assert.ok(logs.some((entry) => /unknown type in garrisonManager somberLost/.test(entry)),
				"the office made noise about the unknown booking");
			assert.equal(drifted.getMetadata(PLAYER, "garrisonType"), GarrisonManager.TYPE_PROTECTION,
				"the booking was rewritten as protection");
		});
	});

	describe("the office itself", () =>
	{
		it("counts the seated and the still-walking alike", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			entOf(world, 5000).garrisoned = () => [3021, 3022];	// two seated earlier
			entOf(world, 5000).garrisonedSlots = () => 2;

			assert.equal(manager.numberOfGarrisonedUnits(tower), 3, "two seated plus one walking");
			assert.equal(manager.numberOfGarrisonedSlots(tower), 3, "two slots plus the walker's");
			assert.equal(manager.allowMelee(tower), true, "the untouched leaf still allows melee");

			const other = makeEntity({ id: 5001, owner: PLAYER, position: [40, 40],
				classes: ["Structure"] });
			world.addEntity(other);
			assert.equal(manager.numberOfGarrisonedUnits(other), 0, "an unbooked wall holds nobody");
			assert.equal(manager.numberOfGarrisonedSlots(other), 0);
			assert.equal(manager.allowMelee(other), undefined, "no verdict on an unbooked wall");
		});

		it("carries the book across the save", () =>
		{
			const { world, manager, tower } = towerWorld();
			const archer = walker(3000, tower.id());
			world.addEntity(archer);
			manager.garrison(world.gameState, archer, tower, GarrisonManager.TYPE_PROTECTION);
			const keep = decayedTower(5001);
			world.addEntity(keep);
			assert.equal(manager.addDecayingStructure(world.gameState, 5001), true);

			const saved = manager.Serialize();
			assert.deepEqual(Object.keys(saved).sort(), ["decayingStructures", "holders"]);
			const fresh = makeGarrisonManager(world);
			fresh.Deserialize(saved);

			assert.equal(leaf(fresh, 5000).list.length, 1, "the march is booked again");
			assert.equal(fresh.allowMelee(tower), true);
			assert.deepEqual([...fresh.decayingStructures.entries()], [[5001, 2]]);
		});
	});
});
