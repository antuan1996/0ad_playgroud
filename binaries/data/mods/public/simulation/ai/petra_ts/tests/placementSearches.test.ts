/**
 * Where to build (execution/placementSearches.ts, over the scoring of
 * execution/placement.ts): a civic centre for its resources or to join our
 * allies' ground, a market for its trade route, the walls and towers facing
 * the enemy and its ships, the base for a military building; and the civic
 * centres ordered, followed until they stand, their spots avoided when they
 * did not. The searches are the town's placement, on a real office seated on
 * the plain (tests/harness/hqSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { override, structure } from "./harness/fakes.ts";
import { ccTemplate, fortressTemplate, marketTemplate, seat, seatTraders, towerTemplate } from "./harness/hqSeat.ts";
import {
	ENEMY,
	GAIA,
	PLAYER,
	doorCalls,
	makeHqEntity,
	structureTemplate,
	type HqWorld,
	type HqWorldOptions,
} from "./harness/hqWorld.ts";

import { entityId, landRegion, seconds, worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import { SHORE_TOWER_TRAFFIC } from "../execution/placement.ts";
import { CC_ENEMY_AVOID, CC_ORDER_WAIT, CC_SPOT_MEMORY } from "../execution/placementSearches.ts";
import { ShipTraffic } from "../world/shipTraffic.ts";

describe("findStrategicCCLocation: the ground the next town claims", () =>
{
	// parity: on an empty search both implementations answer just `undefined`
	// (the port used to answer the bogus position [-1, -1], which the caller's
	// truthiness check at queueplanBuilding.ts:165 consumed as a real position;
	// fixed to mirror petra/headquarters.js, which returns undefined)
	it("ends without a claim when no ground can be reached", () =>
	{
		const { world, hq } = seat();
		// the board is settled: a second allied town takes the far corner and
		// every territory cell stayed ours, so no gaia ground is left to claim
		world.addEntity(
			makeHqEntity({
				id: 2100,
				owner: PLAYER,
				position: [308, 308],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

		const result = hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate()));
		assert.equal(result, undefined, "no position is claimed");
		// and the transport question was never asked of a positionless base
		assert.ok(
			!doorCalls(hq.navalManager).some(([call]: [string, unknown[]]) => call === "setMinimalTransportShips"),
			"no ships were budgeted for a positionless base",
		);
	});

	it("a border town rises between two allied towns", () =>
	{
		// two scraps of unclaimed ground across the border line the towns
		// straddle; the geometry (map 320 wide, both towns 298 apart) makes the
		// north-west scrap the nearest-to-both legal claim
		const { world, hq } = seat({
			territoryOwner: (ix: number, iy: number) =>
				(ix === 7 && iy === 32) || (ix === 33 && iy === 32) ? 0 : PLAYER,
		});
		world.addEntity(
			makeHqEntity({
				id: 2100,
				owner: PLAYER,
				position: [308, 308],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

		assert.deepEqual(
			hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate())),
			[57, 257],
			"the claim sits on the diagonal between the towns",
		);
	});

	it("with one allied town the search becomes an economic one", () =>
	{
		// the single unclaimed lot sits 240+ units from the town: far enough to
		// lose the ally-favouring term, so plain economics would refuse it at
		// cut 60 - but a strategic expansion settles for cut 30
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => ix === 24 && iy === 20 ? 0 : PLAYER });

		// the plain economics call answers the ground not worth a town (cut 60)
		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			false,
			"a town for its own sake is too dear there",
		);
		// the strategic call delegates with the cheaper cut and takes the lot
		assert.deepEqual(hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate())), [
			193,
			161,
		], "expansion settles for the lot plain economics refused");
	});
});

describe("findEconomicCCLocation: where the next village feeds", () =>
{
	it("the first settlement rises next to the launch party", () =>
	{
		// every cell of the board is unclaimed and the launch party stands at
		// [100,100]: the proximity term dominates the flat resource sheets, so
		// the village plants beside the party rather than in the far country
		const { world, hq } = seat({ territoryOwner: () => 0 });

		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				proximity: worldPos(100, 100),
				fromStrategic: false,
			}),
			[97, 97],
			"the first act of founding likes company",
		);
	});

	it("the river bends the choice to the east bank", () =>
	{
		// a north-south river (passibility band 44..59) separates the west bank,
		// where the launch party camps, from open country: the cc's clearance
		// radius (21.2 + 8 proximity = 15 cells) keeps the party clear of the
		// water and the first buildable ground past the current ...
		const { world, hq } = seat({ territoryOwner: () => 0 });
		for (let pz = 0; pz < 160; ++pz)
		{
			for (let px = 44; px <= 59; ++px)
			{
				world.map.setPassData(px, pz, 0xB);
			}
		}

		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				proximity: worldPos(72, 72),
				fromStrategic: false,
			}),
			[151, 81],
			"the settlement stays on the water's edge",
		);
	});

	it("no town grows in the yard of a storehouse", () =>
	{
		// two unclaimed scraps: one next to the storehouse at [196,148], one
		// across the estate. Dropsites keep their working-yard radius of 80
		// (and ban their own 60); near the storehouse the lot loses half its
		// sheet and beyond 60 units the second lot stands
		const gaia = new Set([24 + 20 * 40, 29 + 29 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		world.addEntity(
			makeHqEntity({
				id: 606,
				owner: PLAYER,
				position: [196, 148],
				classes: ["Structure", "Storehouse"],
				templateName: "structures/athen/storehouse",
			}, {
				resourceDropsiteTypes: () => ["wood"],
				isResourceDropsite: (resource: string) =>
					resource === undefined || resource === "" || resource === "wood",
			}),
		);

		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			[233, 233],
			"the yard is kept for the carts",
		);
	});

	it("between two free lots the richer wood decides", () =>
	{
		// two unclaimed lots equal in every other respect; the wood sheet of
		// (29,29) is lifted to 60 (the denser stand behind the hill) and the
		// val formula 2*wood + wood + stone + metal reads the richer valley
		const gaia = new Set([29 + 15 * 40, 29 + 29 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		world.map.ccResourceMaps.wood.map[29 + 29 * 40] = 60;
		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			[233, 233],
			"the denser stand pulls the village",
		);
		// and the sheet moved south, the village follows the wood
		world.map.ccResourceMaps.wood.map[29 + 29 * 40] = 40;
		world.map.ccResourceMaps.wood.map[29 + 15 * 40] = 60;
		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			[233, 121],
			"the sheet moved, the village moved",
		);
	});

	// only the port passes: a base for room took no free island with little
	// left on it, and full island towns never expanded (FINDINGS §40)
	it("a base sought for its room takes free land the resources alone would not", () =>
	{
		const gaia = new Set([29 + 29 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		for (const sheet of Object.values(world.map.ccResourceMaps))
		{
			sheet.map.fill(0);
		}

		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: true,
			}),
			false,
			"nothing to gather there: below the cut",
		);
		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: true,
				forRoom: true,
			}),
			[233, 233],
			"for its room, the free lot",
		);
	});

	it("for its room, a base takes a contested lot when no other is left; for its resources, it does not", () =>
	{
		const gaia = new Set([29 + 29 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		world.map.ccResourceMaps.wood.map[29 + 29 * 40] = 60;
		override(hq.enemyLands, {
			byLand: () =>
				new Map([[2, [
					makeHqEntity({ id: 6100, owner: ENEMY, position: [240, 240], classes: ["Unit", "Soldier"] }),
				]]]),
		});

		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: true,
			}),
			false,
			"an enemy soldier beside it: contested",
		);
		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: true,
				forRoom: true,
			}),
			[233, 233],
			"for its room, the contested lot all the same",
		);
		hq.town.placement.ccSpotsAvoided.push({ pos: worldPos(233, 233), until: 1e9 });
		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: true,
				forRoom: true,
			}),
			false,
			"but not one that failed",
		);
	});

	it("a raiding army pushes the new town across the map", () =>
	{
		// two unclaimed lots, one of which the raiding party camps on: the
		// invading-army term (12000 = 110 units) strikes the west lot and the
		// village plants on the far side
		const gaia = new Set([15 + 28 * 40, 29 + 28 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		hq.defenseManager.armies.push({ foePosition: [124, 228] } as never);

		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			[233, 225],
			"the village plants beyond the raid",
		);
	});

	it("towns are not built under an enemy tower's fire", () =>
	{
		// the enemy stone tower at [124,228] shoots 60; with the cc's half size
		// (16) the danger band is 76 around the tower, so the west lot burns
		// and the east lot stands
		const gaia = new Set([15 + 28 * 40, 29 + 28 * 40]);
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER });
		world.addEntity(
			makeHqEntity({ id: 2200, owner: ENEMY, position: [124, 228], classes: ["Structure", "Tower"] }, {
				hasDefensiveFire: () => true,
				attackRange: (type: string) => type === "Ranged" ? { min: 0, max: 60 } : undefined,
			}),
		);

		assert.deepEqual(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			[233, 225],
			"the village keeps out of range",
		);
	});

	it("ground too far from every town is refused", () =>
	{
		// only the far-border corner stayed unclaimed: 260+ units from town
		// (the disfavour band halves the sheet) and inside the map's border
		// ring (another half) drops the sheet under the 60 cut
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => ix >= 35 && iy >= 35 ? 0 : PLAYER });

		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			false,
			"a town that far out never pays",
		);
		// (the oversea arm needs distances beyond 500, which a 320-wide board
		// cannot produce, so its lift is not exercisable on this harness)
	});
});

describe("findMarketLocation: where the trade route settles", () =>
{
	it("the first market is left to the construction plan", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => PLAYER });

		assert.deepEqual(hq.town.placement.findMarketLocation(world.gameState, structure(marketTemplate())), [
			-1,
			-1,
			-1,
			0,
		], "no partner, no geometry - the plan places it");
	});

	it("the second market opens the route as far from its partner as it can", () =>
	{
		// the town and its market stand at [244,76]; the trade cards are seated
		// because a real game always trades and the route values gain*distSq {
		const { world, hq } = seat({ territoryOwner: () => PLAYER });
		seatTraders(world);
		world.addEntity(
			makeHqEntity({
				id: 3000,
				owner: PLAYER,
				position: [244, 76],
				classes: ["Structure", "Trade", "Town", "Market"],
				templateName: "structures/athen/market",
			}),
		);
		hq.updateTerritories(world.gameState);

		const result = hq.town.placement.findMarketLocation(world.gameState, structure(marketTemplate()));
		assert.deepEqual(result, [23, 297, 2, 56310], "the new market clings to the far south-west corner");
		// the trade record is booked under the town's base; base ids start at
		// 2 because the anchorless manager consumes id 1 at territory time
		assert.equal(result[2], 2);
	});

	// artificial fixture: minimalGain is raised to 10^9 so the route could
	// never pay; in a real game the same refusal reads tradeManager's cut
	it("a second market the route cannot pay for is refused", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => PLAYER });
		seatTraders(world);
		world.addEntity(
			makeHqEntity({
				id: 3000,
				owner: PLAYER,
				position: [244, 76],
				classes: ["Structure", "Trade", "Town", "Market"],
				templateName: "structures/athen/market",
			}),
		);
		hq.updateTerritories(world.gameState);
		hq.tradeManager.minimalGain = 10 ** 9;

		assert.equal(
			hq.town.placement.findMarketLocation(world.gameState, structure(marketTemplate())),
			false,
			"the route is too poor, and one market already stands",
		);
	});

	// a mod scenario: Resources.GetTradableCodes answers [] when the
	// tradable property is stripped, which no vanilla data does
	it("with nothing tradable the route stops with mods", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => PLAYER });
		// the partner market belongs to the neighbouring empire, whose market
		// makes the trade arithmetic certain but never our own
		world.addEntity(
			makeHqEntity({
				id: 3001,
				owner: ENEMY,
				position: [100, 200],
				classes: ["Structure", "Trade", "Town", "Market"],
				templateName: "structures/athen/market",
			}),
		);
		(world.gameState.playerData as unknown as Record<string, boolean[]>).isMutualAlly[ENEMY] = true;
		const engine = globalThis as Record<string, unknown>;
		const realCodes = (engine.Resources as { GetTradableCodes: () => string[]; }).GetTradableCodes;
		(engine.Resources as { GetTradableCodes: () => string[]; }).GetTradableCodes = () => [];
		try
		{
			assert.equal(
				hq.town.placement.findMarketLocation(world.gameState, structure(marketTemplate())),
				false,
				"no tradable goods, no second route",
			);
		}
		finally
		{
			(engine.Resources as { GetTradableCodes: () => string[]; }).GetTradableCodes = realCodes;
		}
	});
});

describe("findDefensiveLocation: where the walls face", () =>
{
	/** the enemy's town over the southern march; the enemy strip keeps
	 * territory rows 26+ so frontier rows 16..25 carry narrow (20..25) and
	 * large (16..19) frontier bits alike */
	function seatMarch(worldOptions: Partial<HqWorldOptions> = {})
	{
		const seatOut = seat({
			territoryOwner: (ix: number, iy: number) => iy >= 26 ? ENEMY : PLAYER,
			...worldOptions,
		});
		seatOut.hq.updateTerritories(seatOut.world.gameState);
		return seatOut;
	}
	const enemyTown = (world: HqWorld, pos: [number, number] = [204, 220]) =>
		world.addEntity(
			makeHqEntity({
				id: 4000,
				owner: ENEMY,
				position: pos,
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

	it("fortress and tower brace the frontier nearest the foe's town", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);

		// cell (33,21) is the frontier cell nearest the enemy town and 80 units
		// from it (the not-under-80 rule's exact boundary is allowed)
		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			265,
			169,
			2,
		], "the fortress presses the frontier");
		assert.deepEqual(
			hq.town.placement.findDefensiveLocation(world.gameState, structure(towerTemplate())),
			[265, 169, 2],
			// row 21 is narrow, so the tower's large-frontier exclusion never
			// bites and the stone tower takes the same post
			"the tower takes the same post",
		);
	});

	it("a fort in the way turns the walls to the far side", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);
		world.addEntity(
			makeHqEntity({
				id: 4050,
				owner: PLAYER,
				position: [265, 169],
				classes: ["Structure", "Fortress", "Defensive"],
				templateName: "structures/athen/fortress",
			}),
		);

		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			137,
			169,
			2,
		], "the walls spread out to the mirror post");
	});

	it("walls stand out of the enemy tower's reach", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);
		// the enemy tower by its town shoots 120; with the fortress half size
		// (15) the danger band is 135, so the nearest posts fall inside and
		// the walls retreat past 135
		world.addEntity(
			makeHqEntity({ id: 4100, owner: ENEMY, position: [268, 172], classes: ["Structure", "Tower"] }, {
				hasDefensiveFire: () => true,
				attackRange: (type: string) => type === "Ranged" ? { min: 0, max: 120 } : undefined,
			}),
		);

		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			129,
			177,
			2,
		], "the walls stand clear of the fire");
	});

	it("at peace everywhere the walls wait — except facing a neutral", () =>
	{
		const { world, hq } = seatMarch();
		// nobody is an enemy yet: no wall is worth raising
		assert.equal(
			hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())),
			undefined,
			"no walls against everyone",
		);
		// ... unless a third empire is met but not war-declared — we may be in
		// cease fire, and Petra still braces toward the neutral town
		enemyTown(world);
		world.gameState.playerData.isEnemy[ENEMY] = false;
		world.gameState.playerData.isNeutral[ENEMY] = true;
		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			265,
			169,
			2,
		], "the walls face the neutral town all the same");
	});

	it("a rising wonder draws the fortifications", () =>
	{
		// the wonder victor builds its forts around the wonder, not the frontier
		const { world, hq } = seatMarch({ victoryConditions: ["wonder"] });
		enemyTown(world, [20, 300]);
		world.addEntity(
			makeHqEntity({ id: 5000, owner: PLAYER, position: [160, 160], classes: ["Structure", "Wonder"] }, {
				footprintRadius: () => 22.6,
			}),
		);

		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			89,
			129,
			2,
		], "the fort guards the wonder first");
		// (the wonder-without-position arm the port guards differently is a
		// resiliency note, not a counted deviation: the ref would crash on the
		// missing position, the port skips the cell)
	});
});

describe("findDefensiveLocation: towers where the enemy's ships pass", () =>
{
	/** the march of the walls' suite, with a traffic grid over it: `passages` of ship-seconds at points */
	function seatShores(passages: Array<[[number, number], number]>, townLand?: number)
	{
		const seatOut = seat({ territoryOwner: (ix: number, iy: number) => iy >= 26 ? ENEMY : PLAYER });
		seatOut.hq.updateTerritories(seatOut.world.gameState);
		seatOut.world.addEntity(
			makeHqEntity(
				{
					id: 4000,
					owner: ENEMY,
					position: [204, 220],
					classes: ["Structure", "CivCentre"],
					templateName: "structures/athen/civil_centre",
				},
				{},
				townLand === undefined ? {} : { access: townLand },
			),
		);
		const map = seatOut.hq.geography.territoryMap;
		const traffic = new ShipTraffic(map.width * map.cellSize, map.height * map.cellSize);
		for (const [pos, seconds] of passages)
		{
			traffic.cells[requireValue(traffic.cellAt(worldPos(pos[0], pos[1])))] = seconds;
		}
		seatOut.hq.shipTraffic = traffic;
		return seatOut;
	}
	const tower = () => override(towerTemplate(), { attackRange: () => ({ min: 0, max: 60 }) });
	const near = (spot: readonly number[] | undefined, pos: readonly number[], reach: number) =>
		!!spot && Math.hypot(spot[0] - pos[0], spot[1] - pos[1]) <= reach;

	it("a tower takes the shore of the busy passage, not the frontier", () =>
	{
		const { world, hq } = seatShores([[[72, 40], 100]]);
		const spot = hq.town.placement.findDefensiveLocation(world.gameState, structure(tower()));
		assert.ok(near(spot, [72, 40], 60), `within its reach of the passage: ${spot}`);
		assert.notDeepEqual(spot, [265, 169, 2]);
	});

	it("with little traffic, the frontier as before", () =>
	{
		const { world, hq } = seatShores([[[72, 40], SHORE_TOWER_TRAFFIC - 1]]);
		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(tower())), [265, 169, 2]);
		assert.equal(hq.town.placement.hasShoreTowerSpot(world.gameState, "structures/{civ}/defense_tower"), false);
	});

	it("the next tower goes to the passage the first does not watch", () =>
	{
		const { world, hq } = seatShores([[[72, 40], 100], [[232, 40], 60]]);
		world.addEntity(
			makeHqEntity({ id: 4200, owner: PLAYER, position: [72, 80], classes: ["Structure", "Tower", "Defensive"] }),
		);
		// the busy passage, a third once watched, counts about 33 against the other's 60
		assert.ok(near(hq.town.placement.findDefensiveLocation(world.gameState, structure(tower())), [232, 40], 60));
	});

	it("with every enemy overseas, a tower goes over a passage or nowhere: no frontier facing a town across the sea", () =>
	{
		// the enemy's town stands on another island
		const { world, hq } = seatShores([[[72, 40], SHORE_TOWER_TRAFFIC - 1]], 9);
		assert.equal(hq.town.placement.towersByTrafficOnly(world.gameState), true);
		assert.equal(
			hq.town.placement.findDefensiveLocation(world.gameState, structure(tower())),
			undefined,
			"too little traffic: no tower",
		);
		hq.shipTraffic?.cells.fill(0);
		requireValue(hq.shipTraffic).cells[requireValue(hq.shipTraffic?.cellAt(worldPos(72, 40)))] = 100;
		assert.ok(
			near(hq.town.placement.findDefensiveLocation(world.gameState, structure(tower())), [72, 40], 60),
			"over the passage",
		);
	});

	it("a fortress keeps to the frontier", () =>
	{
		const { world, hq } = seatShores([[[72, 40], 100]]);
		assert.deepEqual(hq.town.placement.findDefensiveLocation(world.gameState, structure(fortressTemplate())), [
			265,
			169,
			2,
		]);
	});
});

describe("civic centres overseas: followed orders and contested spots", () =>
{
	const centre = (world: HqWorld, id: number, pos: [number, number], progress: number | undefined, owner = PLAYER) =>
		world.addEntity(
			makeHqEntity({
				id,
				owner,
				position: pos,
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}, { foundationProgress: () => progress }),
		);

	it("a spot whose foundation never appeared is avoided for a while, one that stands is forgotten", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => 0 });
		world.ai.elapsedTime = seconds(1000);
		hq.town.noteCivCentreOrdered(world.gameState, worldPos(200, 200));
		hq.town.noteCivCentreOrdered(world.gameState, worldPos(60, 200));
		centre(world, 5001, [62, 198], 0);

		world.ai.elapsedTime = seconds(1000 + CC_ORDER_WAIT - 1);
		hq.town.placement.followCivCentreOrders(world.gameState);
		assert.equal(hq.town.placement.ccSpotsAvoided.length, 0, "still waiting");
		world.ai.elapsedTime = seconds(1000 + CC_ORDER_WAIT);
		hq.town.placement.followCivCentreOrders(world.gameState);
		assert.deepEqual(
			hq.town.placement.ccSpotsAvoided.map((spot) => spot.pos),
			[[200, 200]],
			"the spot that never took",
		);
		assert.equal(
			hq.town.placement.isContestedCCSpot(world.gameState, worldPos(240, 220), landRegion(2)),
			true,
			"avoided around it",
		);
		assert.equal(hq.town.placement.isContestedCCSpot(world.gameState, worldPos(300, 300), landRegion(2)), false);
		assert.equal(hq.town.placement.ccOrders.length, 1, "the foundation that stands is followed on");

		world.ai.elapsedTime = seconds(1000 + CC_SPOT_MEMORY + CC_ORDER_WAIT);
		hq.town.placement.followCivCentreOrders(world.gameState);
		assert.equal(hq.town.placement.ccSpotsAvoided.length, 0, "and forgotten after a while");
	});

	it("a foundation lost before it was built has its spot avoided; a built one is done", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => 0 });
		world.ai.elapsedTime = seconds(1000);
		hq.town.noteCivCentreOrdered(world.gameState, worldPos(200, 200));
		hq.town.noteCivCentreOrdered(world.gameState, worldPos(60, 200));
		const lost = centre(world, 5001, [200, 200], 30);
		centre(world, 5002, [60, 200], 50);
		hq.town.placement.followCivCentreOrders(world.gameState);
		override(lost, { position: () => undefined }); // destroyed
		override(requireValue(world.gameState.getEntityById(entityId(5002))), { foundationProgress: () => undefined });
		world.ai.elapsedTime = seconds(1002);
		hq.town.placement.followCivCentreOrders(world.gameState);
		assert.deepEqual(hq.town.placement.ccSpotsAvoided.map((spot) => spot.pos), [[200, 200]]);
		assert.equal(hq.town.placement.ccOrders.length, 0);
	});

	it("an island with enemy buildings and none of our bases, or enemy soldiers near the spot, is contested", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => 0 });
		const enemyLands = new Map<number, CommonEntity[]>();
		override(hq.enemyLands, { byLand: () => enemyLands });
		const tower = makeHqEntity({ id: 6001, owner: ENEMY, position: [300, 300], classes: ["Structure", "Tower"] });
		const soldier = makeHqEntity({ id: 6002, owner: ENEMY, position: [100, 100], classes: ["Unit", "Soldier"] });
		enemyLands.set(7, [tower]);
		enemyLands.set(2, [soldier]);
		assert.equal(
			hq.town.placement.isContestedCCSpot(world.gameState, worldPos(250, 250), landRegion(7)),
			true,
			"their island",
		);
		assert.equal(
			hq.town.placement.isContestedCCSpot(
				world.gameState,
				worldPos(100 + CC_ENEMY_AVOID - 1, 100),
				landRegion(2),
			),
			true,
			"beside their soldier",
		);
		assert.equal(
			hq.town.placement.isContestedCCSpot(
				world.gameState,
				worldPos(100 + CC_ENEMY_AVOID + 1, 100),
				landRegion(2),
			),
			false,
		);
		assert.equal(
			hq.town.placement.isContestedCCSpot(world.gameState, worldPos(250, 250), landRegion(9)),
			false,
			"an empty island",
		);
	});
});

describe("findBestBaseForMilitary: where the army stands", () =>
{
	/** one of our towns: an own civ centre carrying the roster id of its base */
	function ownTown(world: HqWorld, id: number, position: [number, number], baseId: number): void
	{
		world.addEntity(
			makeHqEntity(
				{
					id,
					owner: PLAYER,
					position,
					classes: ["Structure", "CivCentre"],
					templateName: "structures/athen/civil_centre",
				},
				{},
				{ base: baseId },
			),
		);
	}

	/** a hostile town on the plain */
	function enemyTownAt(world: HqWorld, id: number, position: [number, number]): void
	{
		world.addEntity(
			makeHqEntity({
				id,
				owner: ENEMY,
				position,
				classes: ["Structure", "CivCentre"],
				templateName: "structures/spart/civil_centre",
			}),
		);
	}

	it("the town closest to the hostile one keeps the first call", () =>
	{
		// no base seating: the raw CC walk is all the function reads; the roster
		// numbers wear the campaign's own base ids, starting at 2
		const { world, hq } = seat({}, { seatBases: false });
		ownTown(world, 1102, [105, 200], 2);
		ownTown(world, 1103, [155, 200], 3);
		enemyTownAt(world, 2202, [200, 200]);

		assert.equal(hq.town.placement.findBestBaseForMilitary(world.gameState), 3);
	});

	it("a quiet board: with no hostile town in the walk, no post is named", () =>
	{
		// the walk hunts for the town our army should stand near, and the
		// garrison of a player counts as its own ally in the outer round:
		// our towns alone leave no target, and the call goes unanswered
		const { world, hq } = seat({}, { seatBases: false });
		ownTown(world, 1102, [80, 80], 2);
		ownTown(world, 1103, [240, 240], 3);

		assert.equal(hq.town.placement.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("an allied town stands in the walk but never carries the answer", () =>
	{
		// the ally lies inside the collection but skips the target round; the
		// own town beside it counts as its own ally all the same
		const { world, hq } = seat({}, { seatBases: false });
		ownTown(world, 1102, [80, 80], 2);
		world.addEntity(
			makeHqEntity({
				id: 1104,
				owner: GAIA + 1,
				position: [90, 80],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/other/civil_centre",
			}),
		);

		assert.equal(hq.town.placement.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("a foe across the water raises no sound of the drum here", () =>
	{
		// the foe's town across the sea sits in an untouched land region,
		// getAccessValue answers 9 — no booked road, no post
		const { world, hq } = seat({}, { seatBases: false });
		world.accessAt.set("200,200", 9);
		ownTown(world, 1102, [80, 80], 2);
		enemyTownAt(world, 2202, [200, 200]);

		assert.equal(hq.town.placement.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("a second foe numbers closer and revises the call", () =>
	{
		// the first foe at the east walls books the town near it; the second
		// foe in the far field lands nearer the other town and moves the post
		const { world, hq } = seat({}, { seatBases: false });
		enemyTownAt(world, 2202, [300, 300]);
		ownTown(world, 1102, [260, 300], 2);
		ownTown(world, 1103, [180, 180], 3);
		enemyTownAt(world, 2203, [200, 200]);

		assert.equal(hq.town.placement.findBestBaseForMilitary(world.gameState), 3);
	});
});

describe("placing a town: the rivals and allies around the lot", () =>
{
	/** a town of ours or of a rival, as the world files it */
	function town(world: HqWorld, id: number, owner: number, position: [number, number]): void
	{
		world.addEntity(
			makeHqEntity({
				id,
				owner,
				position,
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);
	}

	it("a lot a rival's town would crowd is passed over for one clear of it", () =>
	{
		// the rival's centre sits on the open lot; no lot within a hundred and
		// twenty units of it is claimable, however good the ground
		const { world, hq } = seat({ territoryOwner: () => 0 });
		town(world, 2400, ENEMY, [100, 100]);

		const spot = hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
			fromStrategic: false,
		});
		assert.ok(Array.isArray(spot), "a clear lot is still found");
		assert.ok(
			Math.hypot(spot[0] - 100, spot[1] - 100) >= 120,
			"no town is planted within a hundred and twenty units of a rival",
		);
	});

	it("the only lot a hundred and twenty to two hundred units from an allied town is refused", () =>
	{
		// our own town is an ally to itself in the engine's diplomacy row; the
		// lot at [220,100] sits 120 units from it, inside the ally's no-go ring
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => ix === 27 && iy === 12 ? 0 : PLAYER });
		town(world, 2401, PLAYER, [100, 100]);

		assert.equal(
			hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
				fromStrategic: false,
			}),
			false,
			"no lot is taken inside an allied town's two-hundred-unit ring",
		);
	});

	it("a lot next to an allied town is refused by the strategic search, and the far lot taken", () =>
	{
		// two towns of ours make the allied pair the strategic search needs; a
		// lot a hundred and twenty-seven units from the first is too near it
		const { world, hq } = seat({
			territoryOwner: (ix: number, iy: number) =>
				(ix === 12 && iy === 12) || (ix === 7 && iy === 32) ? 0 : PLAYER,
		});
		town(world, 2402, PLAYER, [308, 308]);

		assert.deepEqual(
			hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate())),
			[57, 257],
			"the lot by the first town is refused; the lot on the diagonal is taken",
		);
	});

	it("three allied towns weigh the lot against the nearest three", () =>
	{
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => ix === 7 && iy === 32 ? 0 : PLAYER });
		town(world, 2402, PLAYER, [308, 308]);
		// the third town is placed between the other two in distance from the
		// lot, and so is weighed as the middle one of the three
		town(world, 2403, PLAYER, [280, 133]);

		const spot = hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate())) as [
			number,
			number,
		];
		for (const ally of [[10, 10], [308, 308], [280, 133]])
		{
			assert.ok(
				Math.hypot(spot[0] - ally[0], spot[1] - ally[1]) >= 249,
				"every allied town keeps its distance from the new one",
			);
		}
	});

	it("a lot across a strait is settled by sea, and the navy is told to ferry one ship", () =>
	{
		// our landmass is region 2; the island east of it is region 3, the water
		// between them region 8, and the strait's trajectory runs through it
		const { world, hq } = seat({
			landPassMap: (px: number) => px >= 80 ? 3 : 2,
			territoryOwner: (ix: number) => ix >= 20 ? 0 : PLAYER,
			trajectories: { "2,3": [2, 8, 3] },
			regionTypes: { 2: "land", 3: "land", 8: "water" },
		}, { landRegions: { 2: true, 3: true } });

		const spot = hq.town.placement.findEconomicCCLocation(world.gameState, structure(ccTemplate()), "wood", {
			fromStrategic: false,
		});
		assert.ok(Array.isArray(spot));
		assert.ok(spot[0] >= 160, "the lot is on the island across the water");
		assert.ok(
			doorCalls(hq.navalManager).some(([name, args]: [string, unknown[]]) =>
				name === "setMinimalTransportShips" && args[1] === 8 && args[2] === 1
			),
			"the strait's water gets one transport ship kept for the crossing",
		);
	});

	it("a round-footprint structure is placed by its radius, as a square one is by its sides", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => 0 });
		const round = structureTemplate("structures/athen/round_centre", {
			classes: ["Structure", "CivCentre"],
			territories: ["own", "neutral"],
			getPaths: { Footprint: { Circle: { "@radius": 16 } } },
			obstruction: { min: 15, max: 21.2 },
		});

		const spot = hq.town.placement.findEconomicCCLocation(world.gameState, structure(round), "wood", {
			fromStrategic: false,
		});
		assert.ok(Array.isArray(spot), "the round centre finds its lot like a square one");
	});
});

describe("round sites and the sea: what the searches make of them", () =>
{
	const ROUND_CENTRE = "structures/athen/round_centre";

	/** a round-footprint centre, placed as the square one is */
	function roundCentre(): CommonTemplate
	{
		return structureTemplate(ROUND_CENTRE, {
			classes: ["Structure", "CivCentre"],
			territories: ["own", "neutral"],
			getPaths: { Footprint: { Circle: { "@radius": 16 } } },
			obstruction: { min: 15, max: 21.2 },
		});
	}

	it("a round centre reaches for the allied pair's claim as a square one does", () =>
	{
		const { world, hq } = seat({
			territoryOwner: (ix: number, iy: number) =>
				(ix === 7 && iy === 32) || (ix === 33 && iy === 32) ? 0 : PLAYER,
		});
		world.addEntity(
			makeHqEntity({
				id: 2100,
				owner: PLAYER,
				position: [308, 308],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

		const spot = hq.town.placement.findStrategicCCLocation(world.gameState, structure(roundCentre()));
		assert.ok(Array.isArray(spot), "the round centre's claim is found too");
	});

	it("a lot across the strait, reached by a strategic search, gets the same one transport ship", () =>
	{
		// two towns of ours on the home landmass make the allied pair; the
		// island east of the water is the only unclaimed ground
		const { world, hq } = seat({
			landPassMap: (px: number) => px >= 80 ? 3 : 2,
			territoryOwner: (ix: number) => ix >= 20 ? 0 : PLAYER,
			trajectories: { "2,3": [2, 8, 3] },
			regionTypes: { 2: "land", 3: "land", 8: "water" },
		}, { landRegions: { 2: true, 3: true } });
		world.addEntity(
			makeHqEntity({
				id: 2101,
				owner: PLAYER,
				position: [40, 120],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

		const spot = hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate()));
		assert.ok(Array.isArray(spot));
		assert.ok(spot[0] >= 160, "the strategic lot is across the water");
		assert.ok(
			doorCalls(hq.navalManager).some(([name, args]: [string, unknown[]]) =>
				name === "setMinimalTransportShips" && args[1] === 8
			),
			"the same strait's water is kept for one ship",
		);
	});

	it("a round fortress braces the frontier as a square one does", () =>
	{
		// our ground to the north, the foe's frontier to the south, as the
		// frontier suites lay it out
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => iy >= 26 ? ENEMY : PLAYER });
		hq.updateTerritories(world.gameState);
		world.addEntity(
			makeHqEntity({
				id: 4000,
				owner: ENEMY,
				position: [204, 220],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);
		const round = structureTemplate("structures/athen/round_fortress", {
			classes: ["Structure", "Fortress", "Defensive"],
			getPaths: { Footprint: { Circle: { "@radius": 15 } } },
			obstruction: { min: 15, max: 21.2 },
		});

		const spot = hq.town.placement.findDefensiveLocation(world.gameState, structure(round));
		assert.ok(Array.isArray(spot) && spot.length === 3, "the round fortress finds its frontier cell");
	});
});

describe("allied towns, round markets and islands: the rarely-read answers", () =>
{
	it("a third allied town farther than the other two is weighed as the far one", () =>
	{
		const { world, hq } = seat({ territoryOwner: (ix: number, iy: number) => ix === 7 && iy === 32 ? 0 : PLAYER });
		world.addEntity(
			makeHqEntity({
				id: 2402,
				owner: PLAYER,
				position: [308, 308],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);
		world.addEntity(
			makeHqEntity({
				id: 2404,
				owner: PLAYER,
				position: [300, 10],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);

		const spot = hq.town.placement.findStrategicCCLocation(world.gameState, structure(ccTemplate())) as [
			number,
			number,
		];
		for (const ally of [[10, 10], [308, 308], [300, 10]])
		{
			assert.ok(
				Math.hypot(spot[0] - ally[0], spot[1] - ally[1]) >= 249,
				"every allied town keeps its distance from the new one",
			);
		}
	});

	it("a round market is placed by its trade route as a square one is", () =>
	{
		const { world, hq } = seat({ territoryOwner: () => PLAYER });
		seatTraders(world);
		world.addEntity(
			makeHqEntity({
				id: 3000,
				owner: PLAYER,
				position: [244, 76],
				classes: ["Structure", "Trade", "Town", "Market"],
				templateName: "structures/athen/market",
			}),
		);
		hq.updateTerritories(world.gameState);
		const round = structureTemplate("structures/athen/round_market", {
			classes: ["Structure", "Trade", "Town", "Market"],
			getPaths: { Footprint: { Circle: { "@radius": 15 } } },
			obstruction: { min: 13, max: 21.96 },
		});

		const result = hq.town.placement.findMarketLocation(world.gameState, structure(round));
		assert.ok(Array.isArray(result) && result.length === 4, "the round market finds its route");
		assert.equal(result[2], 2, "the route is booked under the town's base, as for a square market");
	});

	it("a second market reaches our first by land only, so the island across the water is no partner", () =>
	{
		// our market stands on the home landmass (region 2); the island lots
		// (region 3) have no land route to it, so the route lands at home
		const { world, hq } = seat({
			landPassMap: (px: number) => px >= 80 ? 3 : 2,
			territoryOwner: (ix: number) => ix >= 20 ? 0 : PLAYER,
		}, { landRegions: { 2: true, 3: true } });
		seatTraders(world);
		world.addEntity(
			makeHqEntity({
				id: 3001,
				owner: PLAYER,
				position: [60, 60],
				classes: ["Structure", "Trade", "Town", "Market"],
				templateName: "structures/athen/market",
			}),
		);
		hq.updateTerritories(world.gameState);

		const result = hq.town.placement.findMarketLocation(world.gameState, structure(marketTemplate()));
		assert.ok(
			Array.isArray(result) && result[0] < 160,
			"the second market is placed on the home side of the water, reachable by land",
		);
	});
});
