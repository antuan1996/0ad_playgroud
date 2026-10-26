/**
 * DefenseArmy: the army Petra raises around every invader — who joined it,
 * who defends against it, whom the defenders are told to hit, when raiders
 * break away, and how the army dissolves when the raid is over.
 *
 * The armies under test are real ones, constructed the way the defense
 * manager raises them: one spotted raider in, `addFoe` to let more of the
 * raid party join, `addOwn` for each defender. "capturing" armies are the
 * ones built against gaia ruins standing inside our territory.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyEvents, makeEntity, type Methods, override } from "./harness/fakes.ts";
import { ENEMY, GAIA, makeWorld, PLAYER, type World } from "./harness/world.ts";

import { entityId, seconds, templateName, worldPos } from "../adapter/brands.ts";
import { DefenseArmy } from "../execution/defenseArmy.ts";
import { TransportPlan } from "../execution/transportPlan.ts";
import { Worker } from "../execution/worker.ts";

/** damage-weighted attack strength: config weighs "Hack" at 0.075,
 * spread across the four damage types the config knows */
const hackOf = (strength: number) => 0.075 * strength / 4;

/** a raider: any attacking soldier the defense manager would spot */
function makeSoldier(id: number, position: [number, number], spec: {
	owner?: number;
	strength?: number;
	classes?: string[];
} = {}): CommonEntity
{
	return makeEntity({
		id, owner: spec.owner ?? ENEMY, position,
		classes: ["Unit", "Infantry", ...(spec.classes ?? [])]
	}, {
		attackTypes: () => ["Melee"],
		attackStrengths: () => ({ "Hack": spec.strength ?? 100 })
	});
}

/** a structure a capture army chases: a gaia ruin inside our territory */
function makeStructure(id: number, position: [number, number], owner = GAIA): CommonEntity
{
	return makeEntity({ id, owner, position, classes: ["Structure"] });
}

/** the defender Petra takes home from the army: a citizen soldier */
function makeDefender(id: number, position: [number, number] | undefined,
	methods: Methods = {}, metadata: Record<string, unknown> = {}): CommonEntity
{
	return makeEntity({
		id, owner: PLAYER, position, classes: ["Unit", "Infantry", "CitizenSoldier"]
	}, {
		attackTypes: () => ["Melee"],
		attackStrengths: () => ({ "Hack": 100 }),
		canAttackTarget: () => true,
		...methods
	}, metadata);
}

/** an army holding one raider, with nothing assigned yet */
function raidedWorld(): { world: World; army: DefenseArmy }
{
	const world = makeWorld();
	world.addEntity(makeSoldier(2000, [40, 40]));
	const army = new DefenseArmy(world.gameState, [entityId(2000)]);
	world.addEntity(makeDefender(3000, [20, 20]));
	return { world, army };
}

describe("raising an army", () =>
{
	it("spawns an army around one spotted raider", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.ID > 0, true, "the army drew its number from Petra's id ledger");
		assert.equal(army.getType(), "default", "an unnamed army is a default one");
		assert.deepEqual(army.foeEntities, [2000], "the raider is the army's first foe");
		assert.deepEqual(army.foePosition, [40, 40], "the army sits at the raider");
		assert.equal(world.ents.get(2000)!.getMetadata(PLAYER, "PartOfArmy"), army.ID,
			"the raider remembers which army it belongs to");
	});

	it("takes an army type for the capture hunts", () =>
	{
		const world = makeWorld();
		world.addEntity(makeStructure(5000, [30, 30]));

		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");
		assert.equal(army.getType(), "capturing", "the type was kept");
	});

	it("tells the manager whether the raid pack is still around", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.getState(), 1, "still in pursuit");

		// the raid walked away: the manager decides what to do with the shell
		army.removeFoe(world.gameState, entityId(2000));
		assert.equal(army.getState(), 0, "empty book, no pursuit");
	});

	it("keeps the roster's centre until the cadence follows the crowd", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [41, 40]));

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.addFoe(world.gameState, entityId(2001)), true, "the second raider joined");
		// addFoe only dirties the book: the centre follows at the next cadence
		assert.deepEqual(army.foePosition, [40, 40], "not re-centred on the spot");
		world.ai.elapsedTime = seconds(110); // the next cadence
		army.update(world.gameState);
		assert.deepEqual(army.foePosition, [40.5, 40], "then the crowd averaged out");
	});

	it("declines a raider who marches beyond the army's reach", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2100, [90, 40]));

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.addFoe(world.gameState, entityId(2100)), false, "the newcomer was refused");
		assert.deepEqual(army.foeEntities, [2000]);
	});

	it("declines raiders already enrolled and raiders that vanished", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		assert.equal(army.addFoe(world.gameState, entityId(2000)), false, "a raider cannot join twice");
		assert.equal(army.addFoe(world.gameState, entityId(2999)), false, "a ghost was refused");
		assert.deepEqual(army.foeEntities, [2000]);
	});

	it("weighs a raider's attack strength into the army book", () =>
	{
		const world = makeWorld();
		const strong = world.addEntity(makeSoldier(2000, [40, 40], { strength: 400 }));

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.foeStrength, hackOf(400), "one hacking raider");
		assert.equal(strong.getMetadata(PLAYER, "PartOfArmy"), army.ID, "enrolled");
	});

	it("triples the book for an elephant raider", () =>
	{
		const world = makeWorld();
		// elephant strength reads low from the generic formula; petra corrects it
		world.addEntity(makeSoldier(2000, [40, 40], { strength: 400, classes: ["Animal", "Elephant"] }));

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.foeStrength, 3 * hackOf(400), "the war elephant counted threefold");
	});
});

describe("facing raiders again", () =>
{
	it("releases a raider who garrisoned into safety", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		army.assignedAgainst[2000].push(entityId(3000));
		army.assignedTo[3000] = entityId(2000);

		const before = army.foeStrength;
		assert.equal(army.removeFoe(world.gameState, entityId(2000)), true, "the raider was released");
		assert.deepEqual(army.foeEntities, [], "no foes left");
		assert.equal(army.assignedAgainst[2000], undefined, "nobody is sent against it anymore");
		assert.notEqual(army.assignedTo[3000], 2000, "our defender was un-hooked from him");
		assert.equal(army.foeStrength, before - hackOf(100), "its strength was given back");
		assert.equal(world.ents.get(2000)!.getMetadata(PLAYER, "PartOfArmy"), undefined,
			"the raider forgot its army");
	});

	it("survives a raider destroyed while being captured (capture plus destroy)", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		// the Destroy event for a captured-and-razed entity arrives when the
		// engine no longer holds it: the army releases the slot with no entity
		world.removeEntity(2000);
		assert.equal(army.removeFoe(world.gameState, entityId(2000)), true, "the vanished raider was released");
		assert.deepEqual(army.foeEntities, [], "the roster emptied");
		assert.equal(army.foeStrength, hackOf(100), "no strength could be subtracted");
	});

	it("declines to release raiders it never held", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.removeFoe(world.gameState, entityId(2771)), false, "an unknown raider was refused");
	});
});

describe("calling defenders", () =>
{
	it("enlists a brave defender for the watch", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		assert.equal(army.addOwn(world.gameState, entityId(3000)), true, "the defender joined");
		assert.deepEqual(army.ownEntities, [3000]);
		assert.equal(army.ownStrength, hackOf(100), "his strength was counted");
		const defender = world.ents.get(3000)!;
		assert.equal(defender.getMetadata(PLAYER, "plan"), -3, "marked as fresh defense duty");
		assert.equal(defender.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_DEFENDER);
		assert.equal(defender.getMetadata(PLAYER, "formerSubrole"), undefined,
			"he had no former role to stash");
	});

	it("recalls a defender away from an attack plan and keeps his attacking role", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10], {}, { "plan": 7, "subrole": Worker.SUBROLE_ATTACKING }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		army.addOwn(world.gameState, entityId(3000));
		const defender = world.ents.get(3000)!;
		assert.equal(defender.getMetadata(PLAYER, "plan"), -2, "his attack plan is suspended");
		assert.equal(defender.getMetadata(PLAYER, "formerSubrole"), Worker.SUBROLE_ATTACKING,
			"his attacking role was stashed");
	});

	it("leaves a pure defender's book untouched", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10], {}, { "plan": -3, "subrole": Worker.SUBROLE_DEFENDER }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		army.addOwn(world.gameState, entityId(3000));
		const defender = world.ents.get(3000)!;
		assert.equal(defender.getMetadata(PLAYER, "formerSubrole"), undefined,
			"no role stash was kept for a defender");
	});

	it("declines a defender who is elsewhere aboard a ship", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, undefined));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		assert.equal(army.addOwn(world.gameState, entityId(3000)), false,
			"the positionless defender was refused");
	});

	it("waves a transportee through when armies merge", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, undefined, {}, { "transport": 9 }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		// merges recruit transportees even though their position sank
		assert.equal(army.addOwn(world.gameState, entityId(3000), true), true, "the transportee joined the merge");
	});

	it("discharges a defender when the raid is over", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10], {}, { "plan": 7, "subrole": Worker.SUBROLE_ATTACKING }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));
		army.assignedAgainst[4000] = [];
		army.assignedAgainst[4000].push(entityId(3000));
		army.assignedTo[3000] = entityId(4000);

		const before = army.ownStrength;
		assert.equal(army.removeOwn(world.gameState, entityId(3000)), true, "the defender was discharged");
		assert.deepEqual(army.ownEntities, []);
		assert.deepEqual(army.assignedAgainst[4000], [], "he is no longer sent against anyone");
		assert.equal(army.ownStrength, before - hackOf(100));
		const defender = world.ents.get(3000)!;
		assert.equal(defender.getMetadata(PLAYER, "plan"), -1, "a suspended plan became an exile");
		assert.equal(defender.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_ATTACKING, "his role was restored");
		assert.equal(defender.getMetadata(PLAYER, "formerSubrole"), undefined, "the stash emptied");
	});

	it("discharges a home guard who joined with no plan of his own", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));

		army.removeOwn(world.gameState, entityId(3000));
		assert.equal(world.ents.get(3000)!.getMetadata(PLAYER, "plan"), undefined,
			"no attack plan was ever his to resume");
	});

	it("takes back a defender whose body went to the dead list", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [10, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));

		// the Destroy event arrives when the entity is already gone
		world.removeEntity(3000);
		assert.equal(army.removeOwn(world.gameState, entityId(3000)), true, "the vanished defender was let go");
		assert.deepEqual(army.ownEntities, [], "the roster emptied");
	});

	it("pulls a still-boarding defender off his ferry", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const boardingCalls: number[] = [];
		world.addEntity(makeDefender(3000, [10, 10], {}, { "transport": 12 }));
		world.ai.HQ.navalManager.getPlan = (name: number) => name === 12 ? {
			state: TransportPlan.BOARDING,
			removeUnit: (_gs: CommonGameState, ent: CommonEntity) => boardingCalls.push(ent.id())
		} as never : undefined;

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));
		army.removeOwn(world.gameState, entityId(3000));
		assert.deepEqual(boardingCalls, [3000], "the defender was pulled off the ferry");
	});

	it("looks away when a defender's ferry plan is already past boarding", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const boardingCalls: number[] = [];
		world.addEntity(makeDefender(3000, [10, 10], {}, { "transport": 13 }));
		world.ai.HQ.navalManager.getPlan = (name: number) => name === 13 ? {
			state: "sailing",
			removeUnit: (_gs: CommonGameState, ent: CommonEntity) => boardingCalls.push(ent.id())
		} as never : undefined;

		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));
		army.removeOwn(world.gameState, entityId(3000));
		assert.deepEqual(boardingCalls, [], "nobody was pulled off a plan under way");
	});
});

describe("choosing whom to fight", () =>
{
	it("sends the defender at the raider who is hitting him", () =>
	{
		const { world, army } = raidedWorld();
		const defender = world.ents.get(3000)!;
		// the raider already charged our defender — the engine order data says so
		world.ents.get(2000)!.unitAIOrderData = () => [{ "target": entityId(3000) }];

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown, capture?: unknown, queued?: unknown) =>
			strikes.push([target, capture, queued]) });

		assert.equal(army.assignUnit(world.gameState, entityId(3000)), true, "an order was given");
		assert.deepEqual(strikes[0], [2000, false, false], "retaliate first, not whatever is nearest");
		assert.equal(army.assignedTo[3000], 2000);
		assert.deepEqual(army.assignedAgainst[2000], [3000]);
	});

	it("matches the nearest unclaimed raider", () =>
	{
		const { world, army } = raidedWorld();
		world.addEntity(makeSoldier(2001, [50, 40]));
		army.addFoe(world.gameState, entityId(2001));
		const defender = world.ents.get(3000)!;

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes[0], [2000], "the nearer raider won");
	});

	it("prefers an uncrowded raider over the nearer mob", () =>
	{
		const { world, army } = raidedWorld();
		// five defenders already stand against the raider: idMin's crowd band
		// (> 2) keeps him out of the preferred pick, but he is not so mobbed
		// (≤ 8) that the whole army file refuses him
		for (let id = 3001; id <= 3005; ++id)
		{
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}
		world.addEntity(makeSoldier(2001, [60, 60]));
		army.addFoe(world.gameState, entityId(2001));
		const defender = world.ents.get(3000)!;

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes[0], [2001], "the mild mob was left to its opponents");
	});

	it("sends nobody at a raider whose mob reached nine", () =>
	{
		const { world, army } = raidedWorld();
		for (let id = 3002; id <= 3010; ++id)
		{
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}
		const defender = world.ents.get(3000)!;
		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		assert.equal(army.assignUnit(world.gameState, entityId(3000)), false, "no order was given");
		assert.deepEqual(strikes, [], "the raider's crowd was already the whole army");
	});

	it("still spares a sixth attacker for an ordinary raider", () =>
	{
		const { world, army } = raidedWorld();
		for (let id = 3001; id <= 3007; ++id)
		{
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}
		world.addEntity(makeSoldier(2001, [60, 60]));
		army.addFoe(world.gameState, entityId(2001));
		const defender = world.ents.get(3000)!;
		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes, [[2001]], "the mob was left at eight");
	});

	it("sends a backup even to a mobbed hero", () =>
	{
		const { world, army } = raidedWorld();
		for (let id = 3001; id <= 3007; ++id)
		{
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}
		world.ents.get(2000)!.hasClass = (cls: string) => cls === "Infantry" || cls === "Hero";
		const defender = world.ents.get(3000)!;
		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes, [[2000]], "heroes never lose their escort");
	});

	it("sends a backup even to a mobbed ram", () =>
	{
		const { world, army } = raidedWorld();
		for (let id = 3001; id <= 3007; ++id)
		{
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}
		const ram = world.addEntity(makeSoldier(2011, [41, 40], { classes: ["Siege"] }));
		army.addFoe(world.gameState, entityId(2011), true);
		const defender = world.ents.get(3000)!;
		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes, [[ram.id()]], "rams never lose their escort");
	});

	it("does not send a soldier at a foe he cannot hurt", () =>
	{
		const { world, army } = raidedWorld();
		const defender = world.ents.get(3000)!;
		// e.g. a pure melee defender whose engine refuses the target class
		defender.canAttackTarget = () => false;
		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		assert.equal(army.assignUnit(world.gameState, entityId(3000)), false, "no order was given");
		assert.deepEqual(strikes, [], "nothing was aimed");
		assert.deepEqual(army.assignedAgainst[2000], [], "nobody was booked against");
	});

	it("rides the raider's island across a thin strait", () =>
	{
		const world = makeWorld();
		// a raider landed across a narrow channel: another land, near enough
		world.accessAt.set("50,10", 3);
		world.addEntity(makeSoldier(2000, [50, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [20, 10]));

		army.assignUnit(world.gameState, entityId(3000));
		const call = world.transportCalls.find((row) => row[0].id() === 3000);
		assert.ok(call, "a ferry was asked for");
		assert.deepEqual(army.assignedAgainst[2000], [], "no strike was booked before the ride");
		assert.deepEqual([call![1], call![2], call![3]], [2, 3, [50, 10]], "there and then");
	});

	it("sends a defending warship at the foe in the water", () =>
	{
		const world = makeWorld();
		// the raiding unit sits in the water: sea access 4
		world.accessAt.set("40,40", 4);
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const defender = world.addEntity(makeEntity({
			id: 3000, owner: PLAYER, position: [20, 20], classes: ["Unit", "Ship"]
		}, {
			attackTypes: () => ["Melee"],
			attackStrengths: () => ({ "Hack": 100 }),
			canAttackTarget: () => true
		}));

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });

		assert.equal(army.assignUnit(world.gameState, entityId(3000)), true, "the order went out");
		assert.deepEqual(strikes[0], [2000], "the ship hunted the raider");
	});

	it("returns the defender's harvest home before the charge", () =>
	{
		const { world, army } = raidedWorld();
		const defender = world.ents.get(3000)!;
		defender.resourceCarrying = () => [{ "type": "wood", "amount": 10 }];
		const dropsite = world.addEntity(makeEntity({
			id: 6000, owner: PLAYER, position: [10, 10], classes: ["Structure"]
		}));
		world.gameState.getOwnDropsites = () => ({
			values: () => [dropsite][Symbol.iterator](),
			filter: function() { return this; }
		} as never);

		const order: string[] = [];
		override(defender, { "returnResources": () => { order.push("returns"); return true; } });
		override(defender, { "attack": (target: unknown, _c?: unknown, queued?: unknown) => {
			order.push(`attack ${String(target)} queued=${String(queued)}`);
		} });

		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(order, ["returns", "attack 2000 queued=true"],
			"the harvest went home and the strike queued after it");
	});
});

describe("asking for defenders", () =>
{
	/** an army of one raider on the given ground */
	function armyOn(territory: Map<string, number>, strength = 100): { world: World; army: DefenseArmy }
	{
		const world = makeWorld({ territory });
		world.addEntity(makeSoldier(2000, [40, 40], { strength }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		return { world, army };
	}

	it("demands most while our ground is under fire", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", PLAYER]]), 400);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		// two defenders per raider point
		assert.equal(army.needsDefenders(world.gameState),
			hackOf(400) * 2 - hackOf(100), "the own-territory ratio");
	});

	it("demands less on ally ground", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", 3]]), 400);
		world.gameState.playerData.isAlly[3] = true;
		// we are the owner's only ally so far, so the ratio stays whole
		assert.equal(army.needsDefenders(world.gameState), hackOf(400) * 1.4,
			"the ally ratio, unshared");
	});

	it("softens the ally demand the more allies stand by", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", 3]]), 400);
		// we and another ally both answer for the owner
		world.gameState.playerData.isAlly[3] = true;
		const playersData = (world.gameState.sharedScript as { playersData: { isAlly: boolean[] }[] }).playersData;
		playersData[1].isAlly[3] = true;
		playersData[2] = { "isAlly": [false, false, true, true] };

		const need = army.needsDefenders(world.gameState) as number;
		assert.ok(Math.abs(need - hackOf(400) * 1.4 / 1.5) < 1e-10,
			"two sharers split their share of the ratio");
	});

	it("demands the neutral ratio on ground nobody holds", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", 0]]));
		assert.equal(army.needsDefenders(world.gameState), hackOf(100) * 1.8,
			"neutral ground demands the neutral ratio");
	});

	it("says no once our defenders balance the raiders", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", PLAYER]]), 100);
		world.addEntity(makeDefender(3000, [10, 10]));
		world.addEntity(makeDefender(3001, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		army.addOwn(world.gameState, entityId(3001));
		assert.equal(army.needsDefenders(world.gameState), false,
			"two defenders cover a raider twice over");
	});

	it("recounts the book when a slow upgrade left it negative", () =>
	{
		const { world, army } = armyOn(new Map([["40,40", PLAYER]]), 100);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		// the blacksmith finished between the enlistment and the discharge: the
		// removal subtracts the upgraded strength, more than it added
		// the blacksmith finished between the enlistment and the discharge: the
		// removal subtracts the upgraded strength, more than it added
		world.ents.get(3000)!
			.attackStrengths = () => ({ "Hack": 600 });		army.removeOwn(world.gameState, entityId(3000));
		assert.ok(army.ownStrength < 0, "the book went negative");

		const need = army.needsDefenders(world.gameState);
		assert.equal(need, hackOf(100) * 2 - 0, "the recount saw no defenders left");
		assert.equal(army.ownStrength, 0, "and the book was reconciled");
	});
});

describe("scattering home", () =>
{
	it("marches lost defenders home to our ground's centre", () =>
	{
		const world = makeWorld({ territory: new Map([["100,100", 0]]) });
		world.gameState.playerData.isMutualAlly[3] = true;
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeDefender(3000, [8, 10]));
		world.addEntity(makeDefender(3001, [12, 14]));
		// one defender got left stranded in unclaimed ground while the raid passed
		const lost = world.addEntity(makeDefender(3002, [100, 100]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));
		army.addOwn(world.gameState, entityId(3001));
		army.addOwn(world.gameState, entityId(3002));

		const walks: unknown[][] = [];
		override(lost, { "moveToRange": (x: number, z: number, min: unknown, max: number) => walks.push([x, z, min, max]) });

		army.clear(world.gameState);
		assert.deepEqual(army.ownEntities, [], "everybody was released");
		assert.deepEqual(walks, [[10, 12, 0, 5]],
			"the lost one walked to the centre of the ones who knew their way, radius 0");
		assert.deepEqual(army.assignedAgainst, {}, "the assignment book reset");
		assert.deepEqual(army.assignedTo, {});
	});

	it("stands down the defenders already inside ally ground", () =>
	{
		const world = makeWorld({ territory: new Map([["8,10", 3]]) });
		world.gameState.playerData.isMutualAlly[3] = true;
		world.addEntity(makeSoldier(2000, [40, 40]));
		const onGoal = world.addEntity(makeDefender(3000, [8, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));

		const stops: unknown[] = [];
		onGoal.stopMoving = () => { stops.push("stop"); };
		const walks: unknown[] = [];
		override(onGoal, { "moveToRange": () => { walks.push("walk"); } });

		army.clear(world.gameState);
		assert.equal(stops.length, 1, "the settled defender stood at ease");
		assert.deepEqual(walks, [], "no marching order was given");
	});

	it("rallies stranded defenders at the nearest shooting ally stronghold", () =>
	{
		const world = makeWorld({ territory: new Map([
			["60,40", 0], ["61,61", 3], ["70,70", 3], ["80,80", 3], ["90,90", 3]
		]) });
		world.gameState.playerData.isMutualAlly[3] = true;
		world.addEntity(makeSoldier(2000, [40, 10]));
		const walker = world.addEntity(makeDefender(3000, [60, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));

		// our homesteads are long gone; on the stranded defender's land stand
		// a plain ally workshop, a farther one, and a defensive tower
		world.addEntity(makeEntity({
			id: 6000, owner: 3, position: [61, 61], classes: ["Structure", "Tower"]
		}, { hasDefensiveFire: () => true }));
		world.addEntity(makeEntity({
			id: 6001, owner: 3, position: [70, 70], classes: ["Structure"]
		}));
		world.addEntity(makeEntity({
			id: 6002, owner: 3, position: [80, 80], classes: ["Structure"]
		}));
		world.addEntity(makeEntity({
			id: 6003, owner: 3, position: [90, 90], classes: ["Structure", "Tower"]
		}, { hasDefensiveFire: () => true }));
		const walks: unknown[][] = [];
		override(walker, { "moveToRange": (x: number, z: number, min: unknown, max: number) => walks.push([x, z, min, max]) });

		army.clear(world.gameState);
		assert.deepEqual(walks, [[61, 61, 2, 7]],
			"the tower and its two-tile ring was the rally-point: the farther buildings never displaced it");
	});

	it("garrisons the wounded instead of walking them through the raid", () =>
	{
		const world = makeWorld({ territory: new Map([["8,10", PLAYER]]) });
		world.addEntity(makeSoldier(2000, [40, 40]));
		const wounded = world.addEntity(makeDefender(3000, [8, 10]));
		wounded.healthLevel = () => 0.2;
		world.ai.HQ.defenseManager.garrisonAttackedUnit = () => true;
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));

		const walks: unknown[] = [];
		override(wounded, { "moveToRange": () => { walks.push("walk"); } });
		army.clear(world.gameState);
		assert.deepEqual(walks, [], "the wounded never walked");
		assert.deepEqual(army.ownEntities, [], "the army still emptied out");
	});

	it("lets a stranded wound walk home when no garrison is open", () =>
	{
		const world = makeWorld({ territory: new Map([["60,60", 0]]) });
		world.addEntity(makeSoldier(2000, [40, 40]));
		const wounded = world.addEntity(makeDefender(3000, [60, 60]));
		wounded.healthLevel = () => 0.2; // no garrison available: the answer stays false
		// two healthy back at home: the walk-home aim is their centre
		world.addEntity(makeDefender(3001, [8, 10]));
		world.addEntity(makeDefender(3002, [12, 10]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000));
		army.addOwn(world.gameState, entityId(3001));
		army.addOwn(world.gameState, entityId(3002));

		const walks: unknown[][] = [];
		override(wounded, { "moveToRange": (x: number, z: number) => walks.push([x, z]) });
		army.clear(world.gameState);
		assert.deepEqual(walks, [[10, 10]], "he walked to the home centre with the rest");
	});

	it("holds its order-hands over defenders still aboard a ship", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const aboard = world.addEntity(makeDefender(3000, undefined, {}, { "transport": 9 }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addOwn(world.gameState, entityId(3000), true);

		const moves: unknown[] = [];
		override(aboard, { "moveToRange": () => { moves.push("move"); } });
		aboard.stopMoving = () => { moves.push("stop"); };
		army.clear(world.gameState);
		assert.deepEqual(moves, [], "no order reached a shipped-out defender");
	});
});

describe("merging armies", () =>
{
	it("swallows a nearby army whole", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [42, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const other = new DefenseArmy(world.gameState, [entityId(2001)]);

		world.addEntity(makeDefender(3000, [8, 10]));
		world.addEntity(makeDefender(3001, [12, 10]));
		army.addOwn(world.gameState, entityId(3000));
		other.addOwn(world.gameState, entityId(3001));
		army.assignedAgainst[2002] = [];
		army.assignedAgainst[2002].push(entityId(3000));
		army.assignedTo[3000] = entityId(2002);

		assert.equal(army.merge(world.gameState, other), true, "the merge came through");
		assert.deepEqual(army.foeEntities, [2000, 2001], "the raid parties joined");
		assert.deepEqual(army.ownEntities, [3000, 3001], "the defenders joined");
		assert.equal(army.ownStrength, 2 * hackOf(100), "the strength books merged");
		assert.deepEqual(army.assignedAgainst[2002], [3000], "preset assignments stood");
		assert.deepEqual(army.assignedAgainst[2001], [], "new foes are open to the book");
		assert.equal(army.assignedTo[3001], 0, "a merged defender begins unassigned");
		assert.deepEqual(army.foePosition, [41, 40], "the army re-centred");
	});

	it("re-opens the overlapping foe's ledger when armies merge", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [45, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const other = new DefenseArmy(world.gameState, [entityId(2001)]);

		// a foe can appear in two armies' ledgers mid turn (the manager splits
		// and merges armies): both sides filed defenders against this raider
		world.addEntity(makeDefender(3010, [10, 10]));
		world.addEntity(makeDefender(3000, [8, 10]));
		other.addOwn(world.gameState, entityId(3010));
		other.assignedAgainst[2001].push(entityId(3010));
		other.assignedTo[3010] = entityId(2001);
		army.addOwn(world.gameState, entityId(3000));
		army.assignedAgainst[2001] = [entityId(3000)];
		army.assignedTo[3000] = entityId(2001);

		assert.equal(army.merge(world.gameState, other), true, "the merge came through");
		assert.deepEqual(army.foeEntities, [2000, 2001]);
		// the forced addFoe/addOwn inside the merge re-initialise the rows:
		// the shared foe's pre-merge opponents are forgotten (verbatim in both
		// port and reference) and the merged-in defender starts unassigned
		assert.deepEqual(army.assignedAgainst[2001], []);
		assert.equal(army.assignedTo[3000], 2001, "our defender still knows whom he faced");
		assert.equal(army.assignedTo[3010], 0, "the merged-in defender begins unassigned");
	});

	// only the port passes: the original's removeFoe leaves the raider's row
	// as undefined, and the merge appends that undefined to our row
	// (concat(undefined)), so the raider looks fought by one defender more
	it("counts only real defenders against a raider the merged army had let go", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [45, 40]));
		// the raid pack's army lets one raider break away, and another army
		// takes him up with two defenders on him
		const other = new DefenseArmy(world.gameState, [entityId(2000), entityId(2001)]);
		assert.equal(other.removeFoe(world.gameState, entityId(2000)), true);
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		for (const id of [3001, 3002])
		{
			world.addEntity(makeDefender(id, [38, 40]));
			army.addOwn(world.gameState, entityId(id));
			army.assignedAgainst[2000].push(entityId(id));
			army.assignedTo[id] = entityId(2000);
		}

		assert.equal(army.merge(world.gameState, other), true, "the merge came through");
		assert.deepEqual(army.assignedAgainst[2000], [3001, 3002], "the breakaway's ledger holds his two defenders");

		// a third defender goes at the nearer raider, two on him being no mob
		world.addEntity(makeDefender(3000, [20, 20]));
		const strikes: unknown[] = [];
		override(world.ents.get(3000)!, { "attack": (target: unknown) => strikes.push(target) });
		army.assignUnit(world.gameState, entityId(3000));
		assert.deepEqual(strikes, [2000]);
	});
});

describe("hearing events", () =>
{
	it("re-points the army when a foe promotes", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2005, [40, 40], { strength: 200 }));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		army.assignedAgainst[2000].push(entityId(3000));
		army.assignedTo[3000] = entityId(2000);

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(2000), "newentity": entityId(2005) });
		army.checkEvents(world.gameState, events);

		assert.deepEqual(army.foeEntities, [2005], "the row now names the promoted raider");
		assert.deepEqual(army.assignedAgainst[2005], [3000], "the opponent list was carried over");
		assert.equal(army.assignedAgainst[2000], undefined, "and the old id let go");
		assert.equal(army.assignedTo[3000], 2005);
		assert.equal(army.foeStrength, hackOf(200) - hackOf(100),
			"the old strength was backed out, the promoted one counted in");
	});

	it("ignores the corpse of a foe it watched all along", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeEntity({ id: 2010, owner: GAIA, position: [40, 40] }));
		world.ents.get(2010)!.templateName = () => templateName("resource|obsolete|meat|food");
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(2000), "newentity": entityId(2010) });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.foeEntities, [2000], "the army held the old roster");
	});

	it("re-points a promoted defender and his assignments", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		world.addEntity(makeDefender(3010, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));
		army.assignedAgainst[2000].push(entityId(3000));
		army.assignedTo[3000] = entityId(2000);

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(3000), "newentity": entityId(3010) });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.ownEntities, [3010]);
		assert.deepEqual(army.assignedAgainst[2000], [3010]);
		assert.equal(army.assignedTo[3010], 2000);
	});

	it("waits on a renamed defender that lost his teeth", () =>
	{
		// the reference keeps this guard for renames that strip the combat kit
		// (packed/unpacked transitions can pass through such states); the army
		// simply leaves the old row in place for the next roster sweep
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		world.addEntity(makeEntity({ id: 3020, owner: PLAYER, position: [10, 10], classes: ["Unit"] },
			{ hasUnitAI: () => true, attackTypes: () => undefined }));
		army.addOwn(world.gameState, entityId(3000));

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(3000), "newentity": entityId(3020) });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.ownEntities, [3000], "the roster stayed on the attacker");
	});

	it("forgets foes that garrisoned into a building", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		const events = emptyEvents();
		events.Garrison.push({ "entity": entityId(2000), "holder": entityId(6000) });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.foeEntities, [], "the garrisoned raider was no raider anymore");
	});

	it("forgets a foe we ourselves captured", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);

		const events = emptyEvents();
		events.OwnershipChanged.push({ "entity": entityId(2000), "from": ENEMY, "to": PLAYER });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.foeEntities, [], "a captured raider is no raider");
	});

	it("releases our own unit an enemy captured", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));

		const events = emptyEvents();
		events.OwnershipChanged.push({ "entity": entityId(3000), "from": PLAYER, "to": ENEMY });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.ownEntities, [], "the captured one no longer fights for us");
	});

	it("buries the destroyed from both sides of the ledger", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		world.addEntity(makeDefender(3000, [10, 10]));
		army.addOwn(world.gameState, entityId(3000));

		const events = emptyEvents();
		events.Destroy.length = 0;
		events.Destroy.push({ "entity": entityId(2000) }, { "entity": entityId(3000) });
		army.checkEvents(world.gameState, events);
		assert.deepEqual(army.foeEntities, [], "the raider was buried");
		assert.deepEqual(army.ownEntities, [], "and our defender with him");
	});
});

describe("walking the daily cycle", () =>
{
	it("hands the idle defenders an order", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const defender = world.addEntity(makeDefender(3000, [20, 20]));
		army.addOwn(world.gameState, entityId(3000));

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown) => strikes.push([target]) });
		army.update(world.gameState);
		assert.deepEqual(strikes[0], [2000], "the idle defender got an order");
	});

	it("waits for defenders already being ferried", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const ferrying = world.addEntity(makeDefender(3000, [20, 20], {}, { "transport": 7 }));
		army.addOwn(world.gameState, entityId(3000));

		const strikes: unknown[][] = [];
		override(ferrying, { "attack": (target: unknown) => strikes.push([target]) });
		army.update(world.gameState);
		assert.deepEqual(strikes, [], "the ferry had first right");
	});

	it("leaves a defender already fencing another foe alone", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const busy = world.addEntity(makeDefender(3000, [20, 20]));
		army.addOwn(world.gameState, entityId(3000));
		// already in combat with something else (order target set, no capture)
		busy.unitAIOrderData = () => [{ "target": entityId(2222) }];

		const strikes: unknown[][] = [];
		override(busy, { "attack": (target: unknown) => strikes.push([target]) });
		army.update(world.gameState);
		assert.deepEqual(strikes, [], "no order reached a defender already fighting");
	});

	it("honors a defender whose capture order is fine as it is", () =>
	{
		const world = makeWorld();
		// our ally recaptured enough points to hold this outpost; the defender
		// was already sent to finish the recapture
		world.addEntity(makeEntity({ id: 2000, owner: 3, position: [40, 40], classes: ["Structure"] }, {
			isCapturable: () => true
		}));
		world.gameState.playerData.isAlly[3] = true;
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const capturer = world.addEntity(makeDefender(3000, [20, 20]));
		army.addOwn(world.gameState, entityId(3000));
		capturer.unitAIOrderData = () => [{ "target": entityId(2000), "attackType": "Capture" }];
		capturer.canCapture = () => true;

		const strikes: unknown[][] = [];
		override(capturer, { "attack": (target: unknown, capture?: unknown) => strikes.push([target, capture]) });
		army.update(world.gameState);
		assert.deepEqual(strikes, [], "no re-cut for a lawful capture order");
	});

	it("re-orders a defender whose capture the army cannot honor", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		const defender = world.addEntity(makeDefender(3000, [20, 20]));
		army.addOwn(world.gameState, entityId(3000));
		defender.unitAIOrderData = () => [{ "target": entityId(2000), "attackType": "Capture" }];
		defender.canCapture = () => false; // a plain hacker never captures

		const strikes: unknown[][] = [];
		override(defender, { "attack": (target: unknown, capture?: unknown) => strikes.push([target, capture]) });
		army.update(world.gameState);
		assert.deepEqual(strikes, [[2000, false]], "the order was re-cut to plain attack");
	});

	it("marches a capture army to the ruin while an enemy holds its points", () =>
	{
		const world = makeWorld();
		const ruin = world.addEntity(makeStructure(5000, [30, 30]));
		ruin.capturePoints = () => [0, 0, 12];
		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");

		assert.deepEqual(army.update(world.gameState), [], "the capture army never breaks away");
		assert.deepEqual(army.foeEntities, [5000], "the ruin stayed under watch");
	});

	it("keeps a fresh gaia ruin under watch while gaia holds every point", () =>
	{
		const world = makeWorld();
		const ruin = world.addEntity(makeStructure(5000, [30, 30]));
		ruin.capturePoints = () => [30, 0, 0]; // an untouched ruin is all gaia's
		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");

		army.update(world.gameState);
		assert.deepEqual(army.foeEntities, [5000], "gaia's share is still an enemy share");
	});

	it("frees the gaia ruin once no enemy holds capture points anymore", () =>
	{
		const world = makeWorld();
		const ruin = world.addEntity(makeStructure(5000, [30, 30]));
		ruin.capturePoints = () => [0, 0, 0]; // our capture drained the enemies
		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");

		army.update(world.gameState);
		assert.deepEqual(army.foeEntities, [], "the ruin was released, the army stands empty");
	});

	it("books a token strength for the fort we are retaking from the occupier", () =>
	{
		const world = makeWorld();
		// the enemy fully captured our fort: the capture army is raised against
		// our own building, which without arrows is worth a token two points
		const fort = world.addEntity(makeStructure(5000, [30, 30], PLAYER));
		fort.capturePoints = () => [0, 0, 25];
		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");

		assert.equal(army.foeStrength, 2, "an own structure counts as a light target");
	});

	it("weighs a fortified ruin by its arrow volleys", () =>
	{
		const world = makeWorld();
		// a gaia keep the occupier garrisoned: it still returns fire
		const keep = world.addEntity(makeStructure(5000, [30, 30]));
		keep.getDefaultArrow = () => 2;
		const army = new DefenseArmy(world.gameState, [entityId(5000)], "capturing");

		assert.equal(army.foeStrength, 12, "six points per volley of arrows");
	});

	it("marches the army's aim to the raiders' new average", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [52, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addFoe(world.gameState, entityId(2001));

		world.ai.elapsedTime = seconds(110); // past the five-second cadence
		army.update(world.gameState);
		assert.deepEqual(army.foePosition, [46, 40], "the average followed the raid");
		assert.deepEqual(army.positionLastUpdate, 110, "the cadence was re-armed");
	});

	it("keeps the army's aim dead still until the cadence rolls over", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [52, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addFoe(world.gameState, entityId(2001));

		world.ai.elapsedTime = seconds(110);
		army.update(world.gameState);
		// mid-turn a raider moved on toward our civil centre; the same-tick
		// second update must not re-aim the army after him
		world.ents.get(2001)!.position = () => worldPos(38, 40);
		army.update(world.gameState);
		assert.deepEqual(army.foePosition, [46, 40], "the aim stood at the last cadence");

		world.ai.elapsedTime = seconds(116); // the next cadence: the aim follows
		army.update(world.gameState);
		assert.deepEqual(army.foePosition, [39, 40], "and caught up a tick later");
	});

	it("splits off raiders who wandered too far from the mass", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [41, 40]));
		world.addEntity(makeSoldier(2002, [40, 41]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addFoe(world.gameState, entityId(2001));
		army.addFoe(world.gameState, entityId(2002));
		// the far raider continued his own march elsewhere
		world.ents.get(2001)!.position = () => worldPos(160, 40);

		world.ai.elapsedTime = seconds(110); // past the five-second cadence
		const breakaways = army.update(world.gameState);
		assert.deepEqual(breakaways, [2001], "the wanderer was handed back");
		assert.deepEqual(army.foeEntities, [2000, 2002], "the army kept the mass");
		assert.equal(world.ents.get(2001)!.getMetadata(PLAYER, "PartOfArmy"), undefined,
			"the wanderer forgot the army");
	});

	it("retains patience when a capture army's ruin fell mid-turn", () =>
	{
		const world = makeWorld();
		const army = new DefenseArmy(world.gameState, [], "capturing");
		army.foeEntities.push(entityId(5000)); // the ruin is already gone from the world

		assert.deepEqual(army.update(world.gameState), [], "nothing was broken away");
		assert.deepEqual(army.foeEntities, [5000], "and the slot is still its own");
	});
});

describe("saved and restored", () =>
{
	it("carries a whole army through the save", () =>
	{
		const world = makeWorld();
		world.addEntity(makeSoldier(2000, [40, 40]));
		world.addEntity(makeSoldier(2001, [41, 40]));
		const army = new DefenseArmy(world.gameState, [entityId(2000)]);
		army.addFoe(world.gameState, entityId(2001));
		world.addEntity(makeDefender(3000, [10, 10]));
		world.addEntity(makeDefender(3001, [11, 10]));
		army.addOwn(world.gameState, entityId(3000));
		army.addOwn(world.gameState, entityId(3001));
		army.assignedAgainst[2001].push(entityId(3000));
		army.assignedTo[3000] = entityId(2001);

		const data = army.Serialize();
		assert.deepEqual(Object.keys(data).sort(), [
			"ID", "assignedAgainst", "assignedTo", "foeEntities", "foePosition",
			"foeStrength", "ownEntities", "ownStrength", "positionLastUpdate", "type"
		], "exactly the ten properties the game saves");

		// the way the defense manager rebuilds its armies after a load
		const restored = new DefenseArmy(world.gameState, []);
		restored.Deserialize(data);
		assert.deepEqual([restored.ID, restored.type], [army.ID, army.type]);
		assert.deepEqual(restored.foeEntities, [2000, 2001]);
		assert.deepEqual(restored.ownEntities, [3000, 3001]);
		assert.deepEqual(restored.assignedAgainst[2001], [3000]);
		assert.equal(restored.assignedTo[3000], 2001);
		assert.equal(restored.foeStrength, hackOf(200));
		assert.equal(restored.ownStrength, hackOf(200));
	});

	it("rehydrates the book the manager rebuilds into after a load", () =>
	{
		const world = makeWorld();
		const shell = new DefenseArmy(world.gameState, []);
		const data = { "ID": 77, "type": "default", "foePosition": [5, 5], "positionLastUpdate": 3,
			"assignedAgainst": { "99": [7] }, "assignedTo": { "7": 99 }, "foeEntities": [99],
			"foeStrength": 12, "ownEntities": [55], "ownStrength": 3 };
		shell.Deserialize(data);
		assert.deepEqual(
			[shell.ID, shell.type, shell.foeEntities, shell.ownEntities, shell.assignedAgainst["99"]],
			[77, "default", [99], [55], [7]], "the rehydrated army carried its whole book");
	});
});
