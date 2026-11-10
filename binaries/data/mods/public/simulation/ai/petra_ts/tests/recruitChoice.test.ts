/**
 * The recruit choice (decision/recruitChoice.ts, HQ.recruits): of the units
 * our buildings train in the classes asked, the one the weights pick for its
 * cost, a unit costing a resource we hold and still gather little of weighed
 * down. On a real office seated on the plain (tests/harness/hqSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logs, resetRecorder } from "./harness/engine.ts";
import { makeTemplate, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import { hand, seat, trainerTown } from "./harness/hqSeat.ts";
import { dropsiteCC, makeGaiaSupply } from "./harness/hqWorld.ts";

import { trainMoreWorkers } from "../decision/workforceTraining.ts";

describe("the recruit choice: what the weights pick", () =>
{
	// the comparator the office runs on its two recruit bills: value =
	// 0.1 + Σ param·weight, then every resource the card costs multiplies
	// that value by its costsResource weight, and the order divides by
	// 1 + costSum. The bookkeeping appends the same costsResource weight
	// for every resource the town can neither stock (available ≤ 800) nor
	// still gather (remaining ≤ 400 books 0.2; remaining ≤ 800 books 0.6).
	it("no trainer to house them: the choice returns nothing", () =>
	{
		const { world, hq } = seat();
		// no facility anywhere on the plain — the camp answers no card
		const best = hq.recruits.findBestTrainableUnit(world.gameState, ["Support+Worker"], [[
			"costsResource",
			1,
			"food",
		]]);

		assert.equal(best, undefined);
	});

	it("the honest speeds: at equal cost the quicker recruit leads", () =>
	{
		// the two first-line infantry cards of a real game: the melee
		// hoplite walks 9.5 (template_unit_infantry_melee), the ranged
		// archer 9 (the template_unit base). Costs equal at 50 food +
		// 50 wood, so the [speed 0.5] sweep picks the hoplite —
		// (0.1 + 0.5·9.5)/101 = 0.0480 stands above (0.1 + 0.5·9)/101 = 0.0455
		const { world, hq } = seat({ stock: { food: 1000, wood: 1000 } });
		trainerTown(world);

		// asked through the town, as an attack plan asks it
		const best = hq.town.findBestTrainableUnit(world.gameState, [["CitizenSoldier", "Infantry", "Melee"]], [[
			"speed",
			0.5,
		]]);

		assert.equal(best, "units/athen/infantry_spearman_b");
	});

	it("a city of forty-five hands: the office judges recruits by their arms", async () =>
	{
		// past forty-five paid workers the recruit sweep swaps from the
		// walk-speed and discount weights to the strength table:
		// getMaxStrength weighs every Attack/<type>/Damage entry with the
		// config's DamageTypeImportance (Hack .075, Pierce .085, Crush
		// .045, Fire .001 — four types), adds range and timing at
		// 0.0125·MaxRange and ±time/100000, adds the resistance Damage the
		// same way, then multiplies by Health/Max / 100. The real cards:
		// the spear strikes 4.5 Hack + 4 Pierce at range 4, rests
		// 3/3, on 100 health — 0.1 + 0.344 = 0.444; the bow pierces 7.2 at
		// range 60, rests 1/1, on 50 health — 0.1 + 0.474 = 0.574. At
		// equal 50-food + 50-wood bills the bow's reach and damage out-
		// weigh the spear's sturdier frame (the Slaughter all units carry
		// is skipped by the sweep)
		const { world, hq } = seat({ stock: { food: 1000, wood: 1000 } });
		trainerTown(world);
		// the two recruit cards carry their real attack blocks
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b", {
			classes: [
				"Unit",
				"Human",
				"CitizenSoldier",
				"Soldier",
				"Infantry",
				"Melee",
				"Spearman",
				"Worker",
				"Citizen",
			],
			cost: { food: 50, wood: 50 },
			walkSpeed: 9.5,
			getPaths: { Cost: { Population: 1 } },
			attackTypes: ["Melee", "Slaughter"],
			attackStrengths: { Melee: { Hack: 4.5, Pierce: 4 } },
			attackRanges: { Melee: { max: 4 } },
			attackTimes: { Melee: { prepare: 500, repeat: 1000 } },
			resistanceStrengths: { Hack: 3, Pierce: 3 },
			maxHitpoints: 100,
		});
		world.templates["units/athen/infantry_archer_b"] = makeTemplate("units/athen/infantry_archer_b", {
			classes: [
				"Unit",
				"Human",
				"CitizenSoldier",
				"Soldier",
				"Infantry",
				"Ranged",
				"Archer",
				"Worker",
				"Citizen",
			],
			cost: { food: 50, wood: 50 },
			walkSpeed: 9,
			getPaths: { Cost: { Population: 1 } },
			attackTypes: ["Ranged", "Slaughter"],
			attackStrengths: { Ranged: { Pierce: 7.2 } },
			attackRanges: { Ranged: { max: 60 } },
			attackTimes: { Ranged: { prepare: 800, repeat: 1250 } },
			resistanceStrengths: { Hack: 1, Pierce: 1 },
			maxHitpoints: 50,
		});
		// twenty-three supports and twenty-two hoplites on the payroll: the
		// support share 30·(1 − e^−0.85·45/30) = 21.6 stands below the
		// standing supports, so the barracks answers, and 45 in total
		// pushes the sweep to the strength table
		for (let i = 0; i < 23; ++i)
		{
			hand(world, 500 + i, false);
		}
		for (let i = 0; i < 22; ++i)
		{
			hand(world, 600 + i, true);
		}

		// pin the class dice to Infantry so both cards face the sweep
		stubGlobal("pickRandom", (list: string[]) => list[2]);
		try
		{
			trainMoreWorkers(hq, world.gameState, world.ai.queues);

			const queues = world.ai.queues;
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_archer_b");
			// the batch reads ceil(45/10), capped at five
			assert.equal(queues.citizenSoldier.plans[0].number, 5);
		}
		finally
		{
			restoreEngine();
		}
	});

	// the two swing cards for the weight stories: no real recruit card
	// costs stone, so the suite hands a synthetic stone-flavoured one
	// (annotate-facing stand-in) to face the real artisan (cost food 50)
	// — what both worlds share: available food 1000 books the food slot
	// over the sweep's 800 shelf, so the artisan pays no gathered-wealth
	// discount at all
	it("a card whose only cost rides above the shelf: it pays nothing", () =>
	{
		// a fresh town with food in hand (1000): the sweep skips food
		// entirely (available > 800) and weights the rest at 0.2 — the
		// artisan reads 0.1/51 = 0.00196 and the stone card
		// 0.1·0.2/21 = 0.00095: the untouched card leads
		const { world, hq } = seat({ stock: { food: 1000 } });
		trainerTown(world);
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b", {
			classes: ["Unit", "Infantry"],
			cost: { stone: 20 },
			walkSpeed: 9.5,
		});

		const best = hq.recruits.findBestTrainableUnit(world.gameState, ["Unit"], [["costsResource", 1, "food"]]);

		assert.equal(best, "units/athen/support_civilian");
	});

	it("a stone hill behind the walls: the stone-flavoured card wins instead", () =>
	{
		// the same pair, but the town's central dropsite bookkeeps 600
		// gatherable stone: remaining > 400 books the 0.6 weight, and the
		// stone card reads 0.1·0.6/21 = 0.00286 above the artisan's
		// 0.00196 — the discount bookkeeping flips the choice
		const { world, hq } = seat({ stock: { food: 1000, stone: 200, metal: 200 } });
		const { civicCentre } = trainerTown(world);
		assert.ok(civicCentre);
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b", {
			classes: ["Unit", "Infantry"],
			cost: { stone: 20 },
			walkSpeed: 9.5,
		});
		dropsiteCC(world);
		// two stone mines of 300 next to the civic centre; the ledger loop
		// is the storehouse test's (it walks assignResourceToDropsite)
		world.addEntity(
			makeGaiaSupply({
				id: 2,
				position: [140, 100],
				generic: "stone",
				specific: "stone",
				classes: ["Stone"],
				amount: 300,
			}),
		);
		world.addEntity(
			makeGaiaSupply({
				id: 3,
				position: [146, 96],
				generic: "stone",
				specific: "stone",
				classes: ["Stone"],
				amount: 300,
			}),
		);
		hq.updateTerritories(world.gameState);
		hq.basesManager.baseManagers[0].assignResourceToDropsite(world.gameState, civicCentre, false);

		const best = hq.recruits.findBestTrainableUnit(world.gameState, ["Unit"], [["costsResource", 1, "food"]]);

		assert.equal(best, "units/athen/infantry_spearman_b");
	});

	it("an unexpected parameter token is logged and refused, not crashed", () =>
	{
		// the requirement lists are data the callers build; a token the
		// comparator does not carry must refuse the sweep (the value stays
		// at its base) and log the surprise instead of throwing
		const { world, hq } = seat();
		trainerTown(world);
		// unequal bills so the compared order stays deterministic
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b", {
			classes: ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Melee", "Worker", "Citizen"],
			cost: { food: 50, wood: 30 },
			walkSpeed: 9.5,
			getPaths: { Cost: { Population: 1 } },
		});

		resetRecorder();
		const best = hq.recruits.findBestTrainableUnit(world.gameState, [["CitizenSoldier", "Infantry"]], [[
			"magnetism",
			1,
		]]);

		assert.ok(
			logs.some((entry) => /trainMoreUnits avec non prevu/.test(entry)),
			"the unexpected parameter was logged",
		);
		// both cards read the same 0.1 base, so the cheaper bill leads
		assert.equal(best, "units/athen/infantry_spearman_b");
	});
});
