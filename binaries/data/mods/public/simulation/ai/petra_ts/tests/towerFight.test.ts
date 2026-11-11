/**
 * Storm or flee an enemy tower (decision/towerFight.ts) on the game's own numbers: a sentry tower
 * (template_structure_defensive_tower_sentry.xml: 400 hp, hack 29 pierce 35 crush 3, two arrows of pierce 8 every
 * 3.5 s, 500 capture points regained at 10 a second), citizen spearmen (100 hp, a spear of hack 4.5 pierce 4 each
 * second, a capture of 2.5 a second) and a ram ship (template_unit_ship_warship_ram.xml: 800 hp, hack 320 crush 50
 * every 3 s).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeTemplate } from "./harness/fakes.ts";

import { combatStats } from "../adapter/templateData.ts";
import type { FightGroup, FightSide } from "../decision/fightEstimate.ts";
import { STORM_MIN_LEFT, assessTower, type TowerCapture, type TowerGroup } from "../decision/towerFight.ts";

const spearman = combatStats(
	makeTemplate("units/athen/infantry_spearman_b", {
		classes: ["Unit", "Infantry", "Melee", "Spearman", "CitizenSoldier"],
		civ: "athen",
		attackTypes: ["Melee", "Capture"],
		attackStrengths: { Melee: { Hack: 4.5, Pierce: 4 } },
		attackRanges: { Melee: { max: 4 } },
		attackTimes: { Melee: { repeat: 1000 } },
		resistanceStrengths: { Hack: 3, Pierce: 3, Crush: 15 },
		maxHitpoints: 100,
		getPaths: { Attack: { Melee: {} } },
	}),
);

const ramShip = combatStats(
	makeTemplate("units/athen/ship_ram", {
		classes: ["Unit", "Ship", "Warship", "Melee"],
		civ: "athen",
		attackTypes: ["Melee"],
		attackStrengths: { Melee: { Hack: 320, Crush: 50 } },
		attackRanges: { Melee: { max: 12 } },
		attackTimes: { Melee: { repeat: 3000 } },
		resistanceStrengths: { Hack: 5, Pierce: 5, Crush: 3 },
		maxHitpoints: 800,
		getPaths: { Attack: { Melee: {} } },
	}),
);

const sentryTower = combatStats(
	makeTemplate("structures/athen/sentry_tower", {
		classes: ["Structure", "Tower", "Defensive", "SentryTower"],
		civ: "athen",
		attackTypes: ["Ranged"],
		attackStrengths: { Ranged: { Pierce: 8 } },
		attackRanges: { Ranged: { max: 60 } },
		attackTimes: { Ranged: { repeat: 3500 } },
		resistanceStrengths: { Hack: 29, Pierce: 35, Crush: 3 },
		maxHitpoints: 400,
		getPaths: { Attack: { Ranged: {} } },
	}),
);

/** A side of `count` spearmen (and the other groups given), whole */
function spearmen(count: number): FightSide
{
	return { units: [{ stats: spearman, count, hpFraction: 1 }], shooters: [] };
}

/** The sentry tower shooting `arrows`, at its full hit points unless told */
function tower(arrows: number, hpFraction = 1): TowerGroup
{
	return { stats: sentryTower, count: arrows, hpFraction };
}

/** The spearmen's capture of the tower: 2.5 a second each, against its regeneration */
function capture(count: number, regen = 10, points = 500): TowerCapture
{
	return { rate: 2.5 * count, regen, points };
}

const NO_GUARDS: FightSide = { units: [], shooters: [] };

describe("storming an enemy tower", () =>
{
	it("a ram ship breaks a sentry tower in about 23 s and keeps nine-tenths of its hull", () =>
	{
		const ram: FightGroup = { stats: ramShip, count: 1, hpFraction: 1 };
		const fight = assessTower({ units: [ram], shooters: [] }, tower(2), NO_GUARDS);

		assert.equal(fight.verdict, "storm");
		// hack 320 x 0.9^29 and crush 50 x 0.9^3 every 3 s: 17 a second against 400 hp
		assert.ok(fight.seconds > 20 && fight.seconds < 26, `${fight.seconds}`);
		assert.ok(fight.ourFractionLeft > 0.9 && fight.ourFractionLeft < 0.95, `${fight.ourFractionLeft}`);
	});

	it("three spearmen flee a sentry tower they can neither break nor capture against its regeneration", () =>
	{
		const fight = assessTower(spearmen(3), tower(2), NO_GUARDS, capture(3));

		assert.equal(fight.verdict, "flee");
		assert.equal(fight.seconds, Infinity);
	});

	it("ten spearmen capture it in about 35 s, the tower's arrows costing them a tenth", () =>
	{
		const fight = assessTower(spearmen(10), tower(2), NO_GUARDS, capture(10));

		assert.equal(fight.verdict, "storm");
		// 25 a second against 10 regained: 500 points in a little over 33 s, longer as the arrows kill
		assert.ok(fight.seconds > 33 && fight.seconds < 40, `${fight.seconds}`);
		assert.ok(fight.ourFractionLeft > 0.85 && fight.ourFractionLeft < 0.95, `${fight.ourFractionLeft}`);
	});

	it("a tower that would fall at too high a price is fled: four spearmen would keep less than half", () =>
	{
		// no regeneration (a tower cut off from its territory's help): 10 a second takes the 500 points, but late
		const fight = assessTower(spearmen(4), tower(2), NO_GUARDS, capture(4, 0));

		assert.equal(fight.verdict, "flee");
		assert.ok(fight.seconds > 60 && fight.seconds < 80, `${fight.seconds}`);
		assert.equal(fight.ourFractionLeft, 0);
	});

	it("three men in it add their arrows and their capture strength: ten spearmen no longer take it", () =>
	{
		assert.equal(assessTower(spearmen(10), tower(2), NO_GUARDS, capture(10)).verdict, "storm");
		// two arrows and one each, 10 regained and 2.5 each (GarrisonRegenRate 1)
		assert.equal(assessTower(spearmen(10), tower(5), NO_GUARDS, capture(10, 17.5)).verdict, "flee");
	});

	it("a tower whose arrows are gone falls at our whole rate, at no cost", () =>
	{
		const fight = assessTower(spearmen(10), tower(0), NO_GUARDS, capture(10));

		assert.equal(fight.verdict, "storm");
		assert.equal(fight.seconds, 500 / 15);
		assert.equal(fight.ourFractionLeft, 1);
	});

	it("a damaged tower falls to soldiers who could not break a whole one", () =>
	{
		// 10 spearmen hack at 4.5 x 0.9^29: under 4 a second against 400 hp is too slow under two arrows...
		assert.equal(assessTower(spearmen(10), tower(2), NO_GUARDS).verdict, "flee");
		// ...but a tower at a tenth of its hit points goes down in 5 s
		const fight = assessTower(spearmen(10), tower(2, 0.1), NO_GUARDS);
		assert.equal(fight.verdict, "storm");
		assert.ok(fight.ourFractionLeft > STORM_MIN_LEFT);
	});
});

describe("soldiers called from farther off", () =>
{
	it("three beside it hold the arrows alone until seven called come: the later they come, the less is left", () =>
	{
		const together = assessTower(spearmen(10), tower(2), NO_GUARDS, capture(10));
		const soon = assessTower(spearmen(3), tower(2), NO_GUARDS, capture(10), { side: spearmen(7), seconds: 15 });
		const late = assessTower(spearmen(3), tower(2), NO_GUARDS, capture(10), { side: spearmen(7), seconds: 60 });

		assert.equal(soon.verdict, "storm");
		assert.ok(soon.ourFractionLeft < together.ourFractionLeft, `${soon.ourFractionLeft}`);
		assert.ok(soon.seconds > together.seconds + 15 - 1, `${soon.seconds}`);
		// two arrows for a minute kill two of the three: the seven come to it with one left beside them
		assert.ok(late.ourFractionLeft < soon.ourFractionLeft, `${late.ourFractionLeft}`);
	});

	it("those beside it all fall before the others come: the others weigh it alone, their capture with them", () =>
	{
		const alone = assessTower(spearmen(7), tower(2), NO_GUARDS, capture(7));
		// the one beside it lasts 30 s under two arrows
		const fallen = assessTower(spearmen(1), tower(2), NO_GUARDS, capture(8), { side: spearmen(7), seconds: 60 });

		assert.equal(alone.verdict, "flee", "seven cannot take it");
		assert.equal(fallen.verdict, "flee");
	});
});

describe("its guards first", () =>
{
	it("ten spearmen do not storm a tower that twenty spearmen guard", () =>
	{
		const fight = assessTower(spearmen(10), tower(2), spearmen(20), capture(10));

		assert.equal(fight.verdict, "flee");
		assert.equal(fight.ourFractionLeft, 0);
	});

	it("ten spearmen beat two guards under the tower's arrows, then capture it with what is left", () =>
	{
		const unguarded = assessTower(spearmen(10), tower(2), NO_GUARDS, capture(10));
		const fight = assessTower(spearmen(10), tower(2), spearmen(2), capture(10));

		assert.equal(fight.verdict, "storm");
		assert.ok(fight.ourFractionLeft < unguarded.ourFractionLeft, "the guards cost us some");
		assert.ok(fight.seconds > unguarded.seconds, "and some time");
	});

	it("ten spearmen who capture a lone sentry tower do not storm one a fortress's arrows cover", () =>
	{
		assert.equal(assessTower(spearmen(10), tower(2), NO_GUARDS, capture(10)).verdict, "storm");
		// a fortress beside it, ten arrows of the same kind (its own and its garrison's)
		const covered: FightSide = { units: [], shooters: [{ stats: sentryTower, count: 10, hpFraction: 1 }] };
		assert.equal(assessTower(spearmen(10), tower(2), covered, capture(10)).verdict, "flee");
	});

	it("nobody to storm it: flee", () =>
	{
		assert.equal(assessTower(NO_GUARDS, tower(2), NO_GUARDS).verdict, "flee");
	});
});
