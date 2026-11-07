/**
 * The fight estimator (decision/fightEstimate.ts, PLAN.md §6.3.1) on armies of
 * the game's own numbers: the templates' hit points, resistances, damage,
 * repeat times and bonuses (template_unit_infantry_melee_spearman.xml and the
 * templates it inherits from, and so on).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity, makeTemplate } from "./harness/fakes.ts";

import { combatStats, type CombatStats } from "../adapter/templateData.ts";
import {
	damagePerSecond,
	estimateFight,
	fightSide,
	type FightGroup,
	type FightSide,
} from "../decision/fightEstimate.ts";

/** A citizen spearman: 100 hp, hack 3 pierce 3 crush 15, a spear of hack 4.5 pierce 4 each second, 2.5 x on cavalry. */
const spearmanTemplate = makeTemplate("units/athen/infantry_spearman_b", {
	classes: ["Unit", "Infantry", "Melee", "Spearman", "CitizenSoldier"],
	civ: "athen",
	attackTypes: ["Melee", "Capture", "Slaughter"],
	attackStrengths: { Melee: { Hack: 4.5, Pierce: 4 }, Slaughter: { Hack: 1000 } },
	attackRanges: { Melee: { max: 4 }, Slaughter: { max: 2 } },
	attackTimes: { Melee: { repeat: 1000 }, Slaughter: { repeat: 1000 } },
	resistanceStrengths: { Hack: 3, Pierce: 3, Crush: 15 },
	maxHitpoints: 100,
	// a parsed template's leaves are strings
	getPaths: {
		Attack: { Melee: { Bonuses: { BonusCavMelee: { Classes: "Cavalry", Multiplier: "2.5" } } }, Slaughter: {} },
	},
});

/** A cavalry swordsman: 160 hp, hack 3 pierce 2 crush 15, a sword of hack 9 every 0.75 s. */
const horsemanTemplate = makeTemplate("units/athen/cavalry_swordsman_b", {
	classes: ["Unit", "Cavalry", "Melee", "Swordsman", "CitizenSoldier"],
	civ: "athen",
	attackTypes: ["Melee"],
	attackStrengths: { Melee: { Hack: 9 } },
	attackRanges: { Melee: { max: 4 } },
	attackTimes: { Melee: { repeat: 750 } },
	resistanceStrengths: { Hack: 3, Pierce: 2, Crush: 15 },
	maxHitpoints: 160,
	getPaths: { Attack: { Melee: {} } },
});

/** A citizen archer: 50 hp, hack 1 pierce 1 crush 10, arrows of pierce 7.2 every 1.25 s, 60 m. */
const archerTemplate = makeTemplate("units/athen/infantry_archer_b", {
	classes: ["Unit", "Infantry", "Ranged", "Archer", "CitizenSoldier"],
	civ: "athen",
	attackTypes: ["Ranged"],
	attackStrengths: { Ranged: { Pierce: 7.2 } },
	attackRanges: { Ranged: { max: 60 } },
	attackTimes: { Ranged: { repeat: 1250 } },
	resistanceStrengths: { Hack: 1, Pierce: 1, Crush: 10 },
	maxHitpoints: 50,
	getPaths: { Attack: { Ranged: {} } },
});

/** A stone tower's arrows: pierce 8 each, every 3.5 s. */
const towerTemplate = makeTemplate("structures/athen/defense_tower", {
	classes: ["Structure", "Tower", "Defensive"],
	civ: "athen",
	attackTypes: ["Ranged"],
	attackStrengths: { Ranged: { Pierce: 8 } },
	attackRanges: { Ranged: { max: 60 } },
	attackTimes: { Ranged: { repeat: 3500 } },
	resistanceStrengths: { Hack: 25, Pierce: 50, Crush: 3 },
	maxHitpoints: 1000,
	getPaths: { Attack: { Ranged: {} } },
});

const spearman = combatStats(spearmanTemplate);
const horseman = combatStats(horsemanTemplate);
const archer = combatStats(archerTemplate);
const tower = combatStats(towerTemplate);

const group = (stats: CombatStats, count: number, hpFraction = 1): FightGroup => ({ stats, count, hpFraction });
const side = (units: FightGroup[], shooters: FightGroup[] = []): FightSide => ({ units, shooters });

describe("a unit's fighting stats: combatStats", () =>
{
	it("reads the spear, its timing and its bonus, and leaves out capturing and slaughtering", () =>
	{
		assert.equal(spearman.hp, 100);
		assert.deepEqual(spearman.resistance, { Hack: 3, Pierce: 3, Crush: 15 });
		assert.equal(spearman.attacks.length, 1, "Capture and Slaughter kill no army");
		assert.deepEqual(spearman.attacks[0].damage, { Hack: 4.5, Pierce: 4 });
		assert.equal(spearman.attacks[0].repeatSeconds, 1);
		assert.equal(spearman.attacks[0].range, 4);
		assert.deepEqual(spearman.attacks[0].bonuses, [{ Civ: undefined, Classes: "Cavalry", Multiplier: 2.5 }]);
		assert.equal(spearman.civ, "athen");
	});
});

describe("a blow: damagePerSecond", () =>
{
	it("takes off the target's resistance, 10% a point, damage type by damage type", () =>
	{
		// (4.5 x 0.9^3 + 4 x 0.9^3) per second against a spearman
		assert.ok(Math.abs(damagePerSecond(spearman, spearman) - 8.5 * 0.729) < 1e-9);
	});

	it("multiplies by the bonus against the classes it counters", () =>
	{
		// against a horseman: hack 3, pierce 2, and 2.5 x
		const expected = (4.5 * 0.729 + 4 * 0.81) * 2.5;
		assert.ok(Math.abs(damagePerSecond(spearman, horseman) - expected) < 1e-9);
	});

	it("a bonus against one civilisation's units counts against theirs only", () =>
	{
		// as a template's Bonuses/<name>/Civ names it
		const hater = { ...spearman, attacks: [{ ...spearman.attacks[0], bonuses: [{ Civ: "pers", Multiplier: 2 }] }] };
		const persian = { ...spearman, civ: "pers" };
		assert.ok(Math.abs(damagePerSecond(hater, persian) - 2 * damagePerSecond(spearman, spearman)) < 1e-9);
		assert.ok(Math.abs(damagePerSecond(hater, spearman) - damagePerSecond(spearman, spearman)) < 1e-9);
	});

	it("does nothing without an attack", () =>
	{
		const woman = combatStats(makeTemplate("units/athen/support_female_citizen", { maxHitpoints: 25 }));
		assert.equal(damagePerSecond(woman, spearman), 0);
	});
});

describe("who wins: estimateFight", () =>
{
	it("two equal armies wear each other out: nobody wins", () =>
	{
		const fight = estimateFight(side([group(spearman, 20)]), side([group(spearman, 20)]));
		assert.equal(fight.winner, "none");
		assert.equal(fight.ourFractionLeft, 0);
	});

	it("thirty against twenty of the same win with three quarters of the thirty left, as the square law has it", () =>
	{
		const fight = estimateFight(side([group(spearman, 30)]), side([group(spearman, 20)]));
		assert.equal(fight.winner, "ours");
		// sqrt(1 - 20^2 / 30^2) = 0.745
		assert.ok(Math.abs(fight.ourFractionLeft - Math.sqrt(1 - 400 / 900)) < 1e-9);
		assert.equal(fight.theirFractionLeft, 0);
		assert.ok(fight.seconds > 0 && Number.isFinite(fight.seconds));
	});

	it("wounded men count for less: thirty at half health only just beat twenty whole ones", () =>
	{
		const whole = estimateFight(side([group(spearman, 30)]), side([group(spearman, 20)]));
		const wounded = estimateFight(side([group(spearman, 30, 0.5)]), side([group(spearman, 20)]));
		// they strike as hard, and have half the hit points: 30 x 1500 against 20 x 2000
		assert.equal(wounded.winner, "ours");
		assert.ok(Math.abs(wounded.ourFractionLeft - Math.sqrt(1 - 40000 / 45000)) < 1e-9);
		assert.ok(wounded.ourFractionLeft < whole.ourFractionLeft / 2);
	});

	it("spearmen beat as many horsemen, who are worth more each", () =>
	{
		const fight = estimateFight(side([group(spearman, 15)]), side([group(horseman, 15)]));
		assert.equal(fight.winner, "ours");
	});

	it("a stone tower with five archers inside tips an even fight for the defenders", () =>
	{
		const even = estimateFight(side([group(spearman, 15)]), side([group(spearman, 15)]));
		assert.equal(even.winner, "none");
		// its two arrows and one for each of the five archers inside
		const defended = estimateFight(side([group(spearman, 15)]), side([group(spearman, 15)], [group(tower, 7)]));
		assert.equal(defended.winner, "theirs");
	});

	it("a lone tower with nobody beside it is no army: the attackers win the fight", () =>
	{
		const fight = estimateFight(side([group(spearman, 5)]), side([], [group(tower, 2)]));
		assert.equal(fight.winner, "ours");
		assert.equal(fight.ourFractionLeft, 1);
		assert.equal(fight.seconds, 0);
	});

	it("archers that do no harm to a target still lose to it when it can strike back", () =>
	{
		// women with no weapon against archers: the archers win, untouched
		const woman = combatStats(makeTemplate("units/athen/support_female_citizen", { maxHitpoints: 25 }));
		const fight = estimateFight(side([group(archer, 5)]), side([group(woman, 10)]));
		assert.equal(fight.winner, "ours");
		assert.ok(Math.abs(fight.ourFractionLeft - 1) < 1e-9, "nothing strikes back");
		assert.ok(Math.abs(fight.seconds - 250 / (5 * damagePerSecond(archer, woman))) < 1e-9);
	});
});

describe("an army as it stands: fightSide", () =>
{
	it("groups the units by owner and template, with their health, and gives each structure its arrows", () =>
	{
		const soldier = (id: number, owner: number, template: CommonTemplate, health: number) =>
			makeEntity({ id, owner, templateName: String(template.classes()) }, {
				healthLevel: () => health,
				attackTypes: () => template.attackTypes(),
				attackStrengths: (type: string) => template.attackStrengths(type),
				attackTimes: (type: string) => template.attackTimes(type),
				attackRange: (type: string) => template.attackRange(type),
				resistanceStrengths: () => template.resistanceStrengths(),
				maxHitpoints: () => template.maxHitpoints(),
				classes: () => template.classes(),
				civ: () => template.civ(),
				get: (path: string) => template.get(path),
			});
		const towerEnt = makeEntity({ id: 900, owner: 2, templateName: "structures/athen/defense_tower" }, {
			attackTypes: () => towerTemplate.attackTypes(),
			attackStrengths: (type: string) => towerTemplate.attackStrengths(type),
			attackTimes: (type: string) => towerTemplate.attackTimes(type),
			attackRange: (type: string) => towerTemplate.attackRange(type),
			resistanceStrengths: () => towerTemplate.resistanceStrengths(),
			maxHitpoints: () => towerTemplate.maxHitpoints(),
			classes: () => towerTemplate.classes(),
			civ: () => towerTemplate.civ(),
			get: (path: string) => towerTemplate.get(path),
		});

		const army = fightSide([
			soldier(1, 2, spearmanTemplate, 1),
			soldier(2, 2, spearmanTemplate, 0.5),
			soldier(3, 2, archerTemplate, 1),
			// another player's spearman is another group: his technologies are his own
			soldier(4, 3, spearmanTemplate, 1),
		], [{ structure: towerEnt, arrows: 4 }, { structure: towerEnt, arrows: 0 }]);

		assert.deepEqual(army.units.map((g) => [g.stats.hp, g.count, g.hpFraction]), [[100, 2, 0.75], [50, 1, 1], [
			100,
			1,
			1,
		]]);
		assert.deepEqual(army.shooters.map((g) => g.count), [4], "a tower shooting no arrow is left out");
	});
});
