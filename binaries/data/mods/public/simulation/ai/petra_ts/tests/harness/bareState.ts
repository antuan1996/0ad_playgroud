/**
 * The smallest game state, for the code that only needs Petra's own config,
 * its queue manager and a few templates (the queues, the plans, the saves).
 *
 * `GameState` in common-api is a thin layer over a `SharedScript` full of live
 * engine data, which is not something a unit test can hand it. What these
 * paths call, though, is a small set of methods, so tests get a plain object
 * that answers exactly those; calling anything else fails. The managers that
 * need a world of entities run in world.ts and hqWorld.ts instead.
 */
import { fake, makeTemplate } from "./fakes.ts";

/**
 * What a template costs, as a test names it instead of loading a real
 * template file, so a test says what a thing costs rather than inheriting a
 * balance value it never meant to depend on.
 */
export interface FakeTemplateOptions
{
	/** What `cost()` returns, per resource code. */
	cost?: Record<string, number>;
	/** `Cost/Population` in the template JSON. */
	population?: number;
	/** `Research/Time`; leave undefined for anything that is not a technology. */
	researchTime?: number;
}

/**
 * An entity list as the API returns them: iterable through `values()`, and
 * chainable through `filter()`.
 *
 * `filter` ignores its predicate and hands back the same items. Applying the
 * real `filters.*` predicates would mean faking entity metadata as deep as the
 * entities themselves, which is more machinery than a test asked for. A test
 * that cares which entities a call selects passes exactly those in, or filters
 * on the state it was given.
 */
function fakeEntityList(items: readonly unknown[] = []): object
{
	return {
		hasEntities: () => items.length > 0,
		toEntityArray: () => [...items],
		values: () => items[Symbol.iterator](),
		[Symbol.iterator]: () => items[Symbol.iterator](),
		filter: () => fakeEntityList(items),
		// A real collection re-subscribes to entity events. There are no live
		// entities to subscribe to here, so this has nothing to do.
		registerUpdates: () => undefined,
		length: items.length,
	};
}

export interface FakeGameStateOptions
{
	/** Queue priorities, as Petra reads them from its config. */
	priorities?: Record<string, number>;
	/**
	 * Templates the AI may look up, by template id. Declaring this is what
	 * enables `getTemplate`/`applyCiv`: without it those still throw, so a test
	 * that never meant to build a plan cannot start depending on one.
	 */
	templates?: Record<string, FakeTemplateOptions>;
	/**
	 * A map, so code that builds an `InfoMap` has dimensions to copy, and the
	 * territory and border maps a headquarters makes have grids to read: all
	 * unowned, all passable, square. Nothing here is a real terrain: the
	 * default is a handful of cells, which is right for code that only reads
	 * `width`/`cellSize` and wrong for anything that navigates, so a test that
	 * navigates has to say so in its own fake.
	 */
	map?: { width?: number; height?: number; cellSize?: number };
	/**
	 * The player's own entities, as `getOwnStructures()`/`getOwnUnits()` return
	 * them. Pass an empty array to say "the player has none" — declaring the
	 * option is what makes that method answer at all.
	 */
	ownStructures?: readonly unknown[];
	ownUnits?: readonly unknown[];
	/**
	 * Say that the world is empty: no fish, no market goods, no entity behind an
	 * id. This is a statement about the test's world, not a permissive default —
	 * without it those lookups still throw, so a test that meant to have a world
	 * cannot quietly run against an empty one.
	 */
	emptyWorld?: boolean;
}

export interface FakeGameState
{
	gameState: CommonGameState;
	/** changePriority calls, as [queue, priority] pairs. */
	readonly priorityChanges: Array<[string, number]>;
}

/**
 * The smallest state that satisfies the AI paths which only need Petra's own
 * config and queue manager. Grow it deliberately, one method at a time, so a
 * test never accidentally depends on a stub nobody meant to provide.
 */
export function makeFakeGameState(options: FakeGameStateOptions = {}): FakeGameState
{
	const priorityChanges: Array<[string, number]> = [];

	const ai: Record<string, unknown> = {
		queueManager: {
			changePriority: (queue: string, priority: number) =>
			{
				priorityChanges.push([queue, priority]);
			},
		},
		Config: { priorities: options.priorities ?? {} },
		// Petra's own id counters, not engine state: a base or a plan takes its
		// number from here, so anything constructing one needs them.
		uniqueIDs: { plans: 1, bases: 1 },
	};

	const state: Record<string, unknown> = { ai };

	if (options.templates)
	{
		const templates = options.templates;
		// Civ bonuses are a template-id suffix; tests use plain ids.
		state["applyCiv"] = (template: string) => template;
		state["getTemplate"] = (template: string) =>
		{
			const found = templates[template];
			if (found === undefined)
				throw new Error(`no fake template "${template}" — add it to the test's templates`);
			// plans read the population cost straight off the template JSON
			const population = found.population ?? 0;
			const made = makeTemplate(template, {
				"cost": found.cost,
				"popCost": population,
				"getPaths": { "Cost": { "Population": population } },
				"researchTime": found.researchTime,
			});
			// a structure has an obstruction and a footprint (template_structure.xml)
			return template.startsWith("structures/") ?
				fake<CommonTemplate>({
					...made,
					"obstructionRadius": () => ({ "min": 1, "max": 2 }),
					"footprintRadius": () => 2,
				}) :
				made;
		};
		// Plans look for trainers/researchers in their constructor. Answering
		// "none" keeps them on the cheap path; a test that wants trainers
		// overrides these on the state it was given.
		state["findTrainers"] = () => fakeEntityList();
		state["findResearchers"] = () => fakeEntityList();
	}

	if (options.map)
	{
		const { width = 8, height = 8, cellSize = 20 } = options.map;
		const dimensions = { width, height, cellSize };
		// InfoMap copies the dimensions off the shared script and allocates its
		// own array, so one object serves both map types.
		state["sharedScript"] = { territoryMap: dimensions, passabilityMap: dimensions };
		ai["territoryMap"] = { ...dimensions, "data": new Uint8Array(width * height) };
		state["getPassabilityMap"] = () => ({ ...dimensions, "data": new Uint16Array(width * height) });
		state["getPassabilityClassMask"] = () => 0;
		state["circularMap"] = false;
	}

	if (options.ownStructures)
		state["getOwnStructures"] = () => fakeEntityList(options.ownStructures);
	if (options.ownUnits)
		state["getOwnUnits"] = () => fakeEntityList(options.ownUnits);

	if (options.emptyWorld)
	{
		state["getFishableSupplies"] = () => fakeEntityList();
		state["getEntityById"] = () => undefined;
		// no treasure on the map, still in the first phase, nobody yet
		state["getEntities"] = () => fakeEntityList();
		state["currentPhase"] = () => 1;
		state["getPopulation"] = () => 0;
		// a civilisation for the builders' book, which has none to enter
		state["getPlayerCiv"] = () => "athen";
		// Petra's own region analysis, from accessibility.js. "No regions" is
		// what an unanalysed map looks like to the code that iterates it.
		// Every cell of a declared map is impassable to land units and ships alike.
		const cells = options.map ? (options.map.width ?? 8) * (options.map.height ?? 8) : 0;
		ai["accessibility"] = {
			regionSize: [],
			regionType: [],
			numRegions: 0,
			landPassMap: new Uint8Array(cells),
			navalPassMap: new Uint8Array(cells),
		};
	}

	return { "gameState": fake<CommonGameState>(state), priorityChanges };
}
