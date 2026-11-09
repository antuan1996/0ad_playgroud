/**
 * The naval suites' seat (navalManager.test.ts, transportDesk.test.ts,
 * fishing.test.ts): a real office and its real naval manager on the naval
 * board (harness/navalWorld.ts), and the shoals, docks, ship cards and plan
 * states they lay out.
 */
import { worldPos } from "../../adapter/brands.ts";
import { fake, makeTemplate } from "./fakes.ts";
import { PLAYER, makeGaiaSupply, makeHqEntity } from "./hqWorld.ts";
import { ISLAND, WEST, navalWorld, ship, soldier, type HqWorld } from "./navalWorld.ts";

import { NavalManager } from "../../decision/navalManager.ts";
import type { TransportDesk } from "../../execution/transportDesk.ts";
import { TransportPlan } from "../../execution/transportPlan.ts";

const PlayerID = PLAYER;

/** the naval board, its naval manager not yet initialised */
export function seat(options: Parameters<typeof navalWorld>[0] = {})
{
	const s = navalWorld(options);
	// the trade office's merchants, as TradeManager.init collects them (role trader)
	const traders = s.world.gameState.getOwnUnits().filter((e: CommonEntity) =>
		e.getMetadata(PlayerID, "role") === "trader"
	);
	traders.registerUpdates();
	s.hq.tradeManager.traders = traders;
	return {
		...s,
		get naval(): NavalManager
		{
			return s.hq.navalManager;
		},
		/** the town's transports, where the passages are made and kept */
		get transports(): TransportDesk
		{
			return s.hq.town.transports;
		},
	};
}

/**
 * The naval manager made as the headquarters makes it, on the world as the
 * test laid it out (its fleet, the fish, the landing zones), with the sea of
 * each dock and ship noted, as at the start of a game.
 */

/** a plan at sea, as onBoarding leaves it, with its ships' points as they were */
export function setSail(p: TransportPlan): void
{
	p.stage = {
		state: TransportPlan.SAILING,
		landingPos: p.shipPoints(),
		nTry: {},
		unloaded: [],
		recovered: [],
		canceled: undefined,
	};
}

/** a plan back at the shore, its points kept: a test's set-up only (a plan never goes back) */
export function backToBoarding(p: TransportPlan): void
{
	p.stage = { state: TransportPlan.BOARDING, boardingPos: p.shipPoints(), nTry: {}, needSplit: [] };
}

export const init = (s: ReturnType<typeof seat>) =>
{
	s.hq.navalManager = new NavalManager(s.hq.Config, s.world.gameState, s.hq.geography, s.hq);
	// the town gathers the new manager's desk, as the headquarters' town does when it is made
	Object.assign(s.hq.town, { transports: s.hq.navalManager.desk, fishing: s.hq.navalManager.fishing });
	s.hq.navalManager.assignStartingSeas(s.world.gameState);
};

export const queues = (world: HqWorld) => world.ai.queues;

/** a shoal of fish */
export function fish(world: HqWorld, id: number, position: [number, number], amount = 1000)
{
	return world.addEntity(
		makeGaiaSupply({ id, position, generic: "food", specific: "fish", classes: ["SeaCreature"], amount }),
	);
}

/** a dock of ours, which may train the given ships */
export function dock(
	world: HqWorld,
	id: number,
	position: [number, number],
	trainable: string[] = [],
	options: { foundation?: boolean; classes?: string[]; owner?: number; } = {},
)
{
	return world.addEntity(
		makeHqEntity({
			id,
			owner: options.owner ?? PLAYER,
			position,
			classes: options.classes ?? ["Structure", "Dock"],
			templateName: (options.foundation ? "foundation|" : "") + "structures/athen/dock",
		}, {
			trainingQueue: () => [],
			trainableEntities: () => trainable,
			foundationProgress: () => options.foundation ? 0.5 : undefined,
		}),
	);
}

/** a ship card, answering what the common-api Template reads for ships */
export function shipCard(
	world: HqWorld,
	name: string,
	detail: {
		classes?: string[];
		capacity?: number;
		arrows?: number;
		garrisonable?: string[];
		available?: boolean;
		category?: string;
	} = {},
): string
{
	world.templates[name] = fake<CommonTemplate>({
		...makeTemplate(name, {
			classes: detail.classes ?? ["Unit", "Ship"],
			available: detail.available ?? true,
			trainingCategory: detail.category,
		}),
		getDefaultArrow: () => detail.arrows,
		garrisonMax: () => detail.capacity,
		garrisonableClasses: () => detail.garrisonable ?? ["Infantry"],
	});
	return name;
}

/** a passage with its ship sent to our shore */
export function boarding(s: ReturnType<typeof seat>)
{
	const carrier = ship(s.world, 200, [200, 160]);
	init(s);
	s.transports.requireTransport(
		s.world.gameState,
		soldier(s.world, 100, [140, 160]).ent,
		WEST,
		ISLAND,
		worldPos(280, 160),
	);
	const p = s.transports.plans[0];
	s.transports.assignShipsToPlans(s.world.gameState);
	p.update(s.world.gameState);
	return { carrier, p };
}
