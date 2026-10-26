/**
 * The world the managers run in, around a stub headquarters.
 *
 * Collections, filters, the config and the queues are the game's own code
 * (common-api and Petra); the entities, structures, templates and every
 * answer of the headquarters come from here, declared per test. A suite that
 * needs the real Headquarters seats one over this world (hqWorld.ts).
 */
import { fake, makeEntity } from "./fakes.ts";

import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import { byClass } from "simulation/ai/common-api/filters.js";

import { GAIA, playerId, templateName } from "../../adapter/brands.ts";
import { Config } from "../../decision/config.ts";
import type { Headquarters } from "../../decision/headquarters.ts";
import type { Queue } from "../../execution/queue.ts";
import { QueueManager } from "../../execution/queueManager.ts";

/** A base as the stub HQ hands them out: an anchor structure and the land it sits on. */
export interface BaseLike
{
	/** the base's roster id, what getBaseByID looks for */
	ID?: number;
	anchor: CommonEntity | undefined;
	accessIndex: number | undefined;
}

/** The world builder's knobs, each starting with its most common answer. */
export interface WorldOptions
{
	/** what getEnemyPlayer returns; undefined means "no enemy left". */
	enemyPlayer?: number | undefined;
	/** getAccessValue's answer for positions not named in accessAt. */
	accessibilityFallback?: number;
	/** HQ.getSeaBetweenIndices' answer. */
	sea?: number | undefined;
	/** HQ.navalMap. */
	navalMap?: boolean;
	/** HQ.canBuildUnits. */
	canBuildUnits?: boolean;
	/** Config.debug. */
	debug?: number;
	/** Config.difficulty, which addSiegeUnits' shrink logic reads. */
	difficulty?: number;
	/** getVictoryConditions' set. */
	victoryConditions?: string[];
	/** territoryMap.getOwner's answer, keyed "x,y". */
	territory?: Map<string, number>;
	/** territoryMap.isBlinking's answer, keyed "x,y". */
	blinking?: Map<string, boolean>;
	/** countOwnQueuedEntitiesWithMetadata's answer. */
	queuedInTraining?: number;
	/** Config.personality.defensive, for the worker assignment formula. */
	defensive?: number;
	/** Config.popScaling. */
	popScaling?: number;
	/** gameState.getPopulation/getPopulationMax. */
	population?: number;
	populationMax?: number;
	/** gameState.currentPhase's answer. */
	phase?: number;
	/** gameState.getPhaseName(2)'s answer; undefined means no phase-two tech. */
	phaseName?: string;
	/** names gameState.isResearching answers true for. */
	researching?: string[];
	/** HQ.hasPotentialBase's answer. */
	hasPotentialBase?: boolean;
}

/**
 * The world the managers see. Collections, filters and queues are real; owning
 * the lists makes each test's army explicit. It spawns one default base (an
 * anchor at [10,10] on land 2) and, per test, whatever entities it wants
 * through `addEntity`.
 */
export interface World
{
	gameState: CommonGameState;
	/** the bot's state, gameState.ai; its HQ is a stub until a suite seats a real one */
	ai: PetraRuntime.AIState;
	/** registers an entity so the world classifies and serves it */
	addEntity(ent: CommonEntity): CommonEntity;
	/** forgets an entity again, in every list it was registered in */
	removeEntity(id: number): void;
	units: CommonEntity[];
	structures: CommonEntity[];
	/** every registered entity, keyed id — the world of getEntityById */
	ents: Map<number, CommonEntity>;
	/** the templates getTemplate answers with; tests add theirs */
	templates: Record<string, CommonTemplate>;
	bases: BaseLike[];
	/** the world's mutable knobs, as described in WorldOptions */
	knobs: {
		accessibilityFallback: number;
		queuedInTraining: number;
		sea: number | undefined;
		enemyPlayer: number | undefined;
		navalMap: boolean;
		canBuildUnits: boolean;
		bestTrainable: string | undefined;
		phase: number;
		phaseName: string | undefined;
		researching: string[];
		hasPotentialBase: boolean;
	};
	/** the downtime positions getAccessValue names, keyed "x,y" */
	accessAt: Map<string, number>;
	/** the answers territoryMap.getOwner gives, keyed "x,y" */
	territory: Map<string, number>;
	/** the answers territoryMap.isBlinking gives, keyed "x,y" */
	blinking: Map<string, boolean>;
	/** garrison calls the garrisonManager saw, as [unit, target, type] */
	garrisonCalls: Array<[CommonEntity, CommonEntity, string]>;
	/** garrisoned slot counts the garrisonManager keeps, keyed target id */
	garrisonCounts: Map<number, number>;
	/** defenseManager.garrisonUnitsInside refill calls the garrison-decay loop made */
	decayGarrisonCalls: Array<[CommonEntity, Record<string, unknown>]>;
	/** trainEmergencyUnits calls, as the army positions asked for */
	emergencyCalls: Array<[CommonGameState, [number, number][]]>;
	/** switchDefenseToAttack calls, as [target, data] */
	switchCalls: Array<[CommonEntity | undefined, Record<string, unknown> | undefined]>;
	/** transport calls the navalManager saw, as [ent, from, to, toPos] */
	transportCalls: Array<[CommonEntity, number, number, [number, number] | undefined]>;
	/** setMinimalTransportShips calls, as [sea, needed] */
	minimalShipCalls: Array<[number, number]>;
	/** resetCaptureGaiaRelic calls the victoryManager saw */
	relicResets: unknown[];
	/** the collections the plan asked the sharedScript to keep updated */
	collections: {
		registered: CommonEntityCollection[];
	};
}

export const PLAYER = playerId(1);
export const ENEMY = playerId(2);
export { GAIA };

/** Build the Map a real EntityCollection expects. */
export function mapOf(items: Iterable<CommonEntity>): Map<EntityId, CommonEntity>
{
	const map = new Map<EntityId, CommonEntity>();
	for (const ent of items)
		map.set(ent.id(), ent);
	return map;
}

/** A real EntityCollection over `items`, kept by the world's shared script. */
export function collectionOf(world: { gameState: CommonGameState }, items: Iterable<CommonEntity> = [],
	filters?: CommonEntityFilter[]): CommonEntityCollection
{
	return new EntityCollection(world.gameState.sharedScript, mapOf(items), filters);
}

/** Build a world: one base, no enemies, and knobs at their neutral answers. */
export function makeWorld(options: WorldOptions = {}): World
{
	const accessAt = new Map<string, number>();
	const knobs: World["knobs"] = {
		accessibilityFallback: options.accessibilityFallback ?? 2,
		queuedInTraining: options.queuedInTraining ?? 0,
		sea: options.sea,
		enemyPlayer: options.enemyPlayer,
		navalMap: options.navalMap ?? false,
		canBuildUnits: options.canBuildUnits ?? true,
		bestTrainable: undefined,
		phase: options.phase ?? 1,
		phaseName: options.phaseName,
		researching: [...(options.researching ?? [])],
		hasPotentialBase: options.hasPotentialBase ?? true
	};
	const territory = options.territory ?? new Map<string, number>();
	const blinking = options.blinking ?? new Map<string, boolean>();
	const victoryConditions = options.victoryConditions ?? [];

	const transportCalls: World["transportCalls"] = [];
	const minimalShipCalls: World["minimalShipCalls"] = [];
	const relicResets: unknown[] = [];
	const targetedGaiaRelics = new Map<number, number[]>();
	const garrisonCalls: World["garrisonCalls"] = [];
	const garrisonCounts = new Map<number, number>();
	const emergencyCalls: World["emergencyCalls"] = [];
	const switchCalls: World["switchCalls"] = [];
	const decayGarrisonCalls: World["decayGarrisonCalls"] = [];
	const units: CommonEntity[] = [];
	const structures: CommonEntity[] = [];
	const ents = new Map<number, CommonEntity>();
	const bases: BaseLike[] = [];
	const templates: Record<string, CommonTemplate> = {};

	function accessOf(pos: [number, number]): number
	{
		const key = `${Math.round(pos[0])},${Math.round(pos[1])}`;
		return accessAt.get(key) ?? knobs.accessibilityFallback;
	}

	const collections: World["collections"] = { registered: [] };
	const sharedAI = fake<CommonSharedScript>({
		registerUpdatingEntityCollection: (collection: CommonEntityCollection) => collections.registered.push(collection),
		removeUpdatingEntityCollection: (collection: CommonEntityCollection) => {
			const index = collections.registered.indexOf(collection);
			if (index !== -1)
				collections.registered.splice(index, 1);
		},
		// three players, so the plan's endgame counting loop leaves player 2
		// (the enemy) and skips our own player 1. Each row carries the per-player
		// diplomacy the engine fills (PlayerManager): a player is always its own
		// ally, nobody else by default.
		playersData: [
			{ "state": "active", "isAlly": [true, false, false, false] },
			{ "state": "active", "isAlly": [false, true, false, false] },
			{ "state": "active", "isAlly": [false, false, true, false] }
		]
	});
	const collect = (items: Iterable<CommonEntity> = [], filters?: CommonEntityFilter[]) =>
		new EntityCollection(sharedAI, mapOf(items), filters);

	// the real config, at the difficulty and personality a test names; the
	// queues get no priorities, and the managers' chat stays quiet
	const config = new Config(options.difficulty ?? 3);
	config.debug = options.debug ?? 0;
	config.popScaling = options.popScaling ?? 1;
	config.personality = { aggressive: 1, defensive: options.defensive ?? 1, cooperative: 0.5 };
	config.priorities = {};
	config.chat = false;

	const queues: Record<string, Queue> = {};
	const ai = fake<PetraRuntime.AIState>({
		playedTurn: 0,
		elapsedTime: 100,
		uniqueIDs: { plans: 1, bases: 1, armies: 1 },
		queues,
		queueManager: new QueueManager(config, queues),
		Config: config,
		accessibility: {
			getAccessValue: accessOf,
			regionSize: { 2: 100, 3: 400 }
		}
	});

	const world: World = {
		gameState: fake<CommonGameState>({}),
		ai,
		ents,
		units,
		structures,
		bases,
		templates,
		knobs,
		accessAt,
		territory,
		blinking,
		transportCalls,
		minimalShipCalls,
		relicResets,
		garrisonCalls,
		garrisonCounts,
		emergencyCalls,
		switchCalls,
		decayGarrisonCalls,
		collections,
		addEntity(ent: CommonEntity)
		{
			ents.set(ent.id(), ent);
			if (ent.hasClass("Unit"))
				units.push(ent);
			else
				structures.push(ent);
			return ent;
		},
		removeEntity(id: number)
		{
			// a destroyed entity leaves every entity collection that follows the world
			const gone = ents.get(id);
			if (gone)
				for (const collection of collections.registered)
					collection.removeEnt(gone);
			ents.delete(id);
			for (const list of [units, structures])
				for (let i = list.length - 1; i >= 0; --i)
					if (list[i].id() === id)
						list.splice(i, 1);
		}
	};

	const HQ = {
		get geography() { return HQ; },
		baseManagers: () => bases,
		navalMap: knobs.navalMap,
		canBuildUnits: knobs.canBuildUnits,
		hasPotentialBase: () => knobs.hasPotentialBase,
		getSeaBetweenIndices: () => knobs.sea,
		navalManager: {
			// the transport ships per sea: none on sea 4
			seaTransportShips: Object.assign([], { 4: collect() }),
			setMinimalTransportShips: (_gs: CommonGameState, sea: number, needed: number) => minimalShipCalls.push([sea, needed]),
			requireTransport: (_gs: CommonGameState, ent: CommonEntity, from: number, to: number, toPos: [number, number] | undefined) =>
				transportCalls.push([ent, from, to, toPos]),
			getPlan: () => undefined
		},
		attackManager: {
			upcomingAttacks: { "Raid": [], "Rush": [], "Attack": [], "HugeAttack": [] },
			startedAttacks: { "Raid": [], "Rush": [], "Attack": [], "HugeAttack": [] },
			defeated: {},
			bombingAttacks: new Map<string, Set<number>>(),
			outOfPlan: collect(),
			getEnemyPlayer: () => knobs.enemyPlayer,
			getAttackInPreparation: () => undefined,
			getPlan: () => undefined,
			switchDefenseToAttack: (_gs: CommonGameState, target: CommonEntity, data?: Record<string, unknown>) =>
			{
				switchCalls.push([target, data]);
				return true;
			}
		},
		defenseManager: {
			targetList: [],
			armies: [],
			garrisonAttackedUnit: () => false,
			// defenceManager's refill bookkeeping, recorded for the decay tests
			garrisonUnitsInside: (_gs: CommonGameState, target: CommonEntity, data: Record<string, unknown>) =>
			{
				decayGarrisonCalls.push([target, data]);
			}
		},
		garrisonManager: {
			// like the engine: garrisoning fills the target's slots
			garrison: (_gs: CommonGameState, unit: CommonEntity, target: CommonEntity, type: string) =>
			{
				garrisonCalls.push([unit, target, type]);
				garrisonCounts.set(target.id(), (garrisonCounts.get(target.id()) ?? 0) + 1);
			},
			numberOfGarrisonedSlots: (target: CommonEntity) => garrisonCounts.get(target.id()) ?? 0,
			allowMelee: () => undefined
		},
		victoryManager: {
			criticalEnts: new Map(),
			targetedGaiaRelics,
			isRelicRaided: (relicId: number) => targetedGaiaRelics.has(relicId),
			planRelicRaid: (relicId: number, plan: number) => { targetedGaiaRelics.set(relicId, [plan]); },
			tryCaptureGaiaRelic: false,
			resetCaptureGaiaRelic: (gs: CommonGameState) => relicResets.push(gs)
		},
		territoryMap: {
			getOwner: (pos: [number, number]) => territory.get(`${Math.round(pos[0])},${Math.round(pos[1])}`) ?? PLAYER,
			isBlinking: (pos: [number, number]) => blinking.get(`${Math.round(pos[0])},${Math.round(pos[1])}`) ?? false
		},
		isDangerousLocation: () => false,
		findBestTrainableUnit: () => knobs.bestTrainable,
		capturableTargets: new Map(),
		getBaseByID: (id: number) => bases.find((b) => b.ID === id),
		isDefendable: () => false,
		hasActiveBase: () => true,
		trainEmergencyUnits: (gs: CommonGameState, positions: [number, number][]) => emergencyCalls.push([gs, positions])
	};
	// the stub HQ is its own geography: a test that sets `HQ.navalMap` or
	// `HQ.territoryMap` sets what the port reads through `HQ.geography`
	ai.HQ = fake<Headquarters>(HQ);

	// one base, anchoring a civil centre on land 2 — the world's rally point.
	const anchor = makeEntity({ id: 1000, owner: PLAYER, position: [10, 10], classes: ["Structure", "CivCentre"], templateName: "structures/athen_civil_centre" });
	world.addEntity(anchor);
	bases.push({ "ID": 1, anchor, accessIndex: 2 });

	// the engine diplomacy matrix: every player is its own and everyone's
	// gaia enemy; the player who reads this row is always their own ally
	const playerData = {
		civ: "athen",
		hasSharedDropsites: false,
		isAlly: [false, true, false, false],
		isMutualAlly: [false, true, false, false],
		isEnemy: [true, false, true, true]
	};
	const isEnemy = (owner: number) => playerData.isEnemy[owner];
	const ownedBy = (owner: number | undefined) => (ent: CommonEntity) => owner === undefined || ent.owner() === owner;
	const trainingFacilities = () => structures.filter((s) => s.trainingQueue());

	world.gameState = fake<CommonGameState>({
		ai,
		sharedScript: sharedAI,
		playerData,
		applyCiv: (name: string) => name.replace("{civ}", "athen"),
		getTemplate: (name: string) => templates[name] ?? null,
		isTemplateDisabled: () => false,
		getPlayerCiv: () => "athen",
		templates,
		getVictoryConditions: () => new Set(victoryConditions),
		getPopulation: () => options.population ?? 0,
		getPopulationMax: () => options.populationMax ?? 400,
		// the facilities able to train a given template, as the real
		// GameState.findTrainers does: it runs over the training-facilities
		// collection (see below), so membership is a truthy trainingQueue
		findTrainers: (template: string) => collect(trainingFacilities().filter((s) =>
			(s.trainableEntities("athen") ?? []).includes(templateName(template)))),
		getNumPlayerEnemies: () => knobs.enemyPlayer === undefined ? 0 : 1,
		getEntityById: (id: number | string) => ents.get(+id),
		getEntities: (owner?: number) => collect([...ents.values()].filter(ownedBy(owner))),
		// as GameState.prototype.getOwnUnits/getOwnStructures, the collections
		// carry their class filter, so a later .filter() keeps it and updateEnt
		// never lets a structure into a units collection (or the reverse)
		getOwnUnits: () => collect(units.filter(ownedBy(PLAYER)), [byClass("Unit")]),
		getOwnEntities: () => collect([...units, ...structures.filter(ownedBy(PLAYER))]),
		// as GameState.prototype.getEnemyStructures: with no owner, the
		// structures of every player the diplomacy row calls an enemy
		getEnemyStructures: (owner?: number) => collect(structures.filter((s) =>
			owner === undefined ? isEnemy(s.owner()) : s.owner() === owner)),
		// every entity of a player the diplomacy row calls an enemy, as the
		// common-api byOwners(getEnemies()) does
		getEnemyEntities: () => collect([...ents.values()].filter((e) => isEnemy(e.owner()))),
		getOwnStructures: () => collect(structures.filter(ownedBy(PLAYER)), [byClass("Structure")]),
		getEnemyUnits: (owner?: number) => collect(units.filter((u) =>
			owner === undefined ? u.owner() !== PLAYER : u.owner() === owner)),
		getStructures: () => collect(structures),
		getOwnEntitiesByRole: (role: string | undefined) => collect(units.filter((u) => u.getMetadata(PLAYER, "role") == role)),
		getOwnEntitiesByClass: (cls: string) => collect(structures.filter((s) => s.hasClass(cls))),
		// as GameState.prototype.getOwnTrainingFacilities: facilities are the
		// own entities a truthy trainingQueue answers for (filters.byTrainingQueue),
		// not a class test
		getOwnTrainingFacilities: () => collect(trainingFacilities()),
		countOwnQueuedEntitiesWithMetadata: () => knobs.queuedInTraining,
		updatingCollection: (_key: string, filter: CommonEntityFilter, collection: CommonEntityCollection) =>
			collection.filter(filter),
		updatingGlobalCollection: (_key: string, filter: CommonEntityFilter) => collect(ents.values()).filter(filter),
		getOwnDropsites: () => collect(),
		currentPhase: () => knobs.phase,
		isResearching: (name: string) => name !== undefined && knobs.researching.includes(name),
		getPhaseName: (phase: number) => phase === 2 ? options.phaseName : undefined,
		isPlayerEnemy: (id: number) => playerData.isEnemy[id],
		isPlayerAlly: (id: number) => playerData.isAlly[id],
		isPlayerMutualAlly: (id: number) => playerData.isMutualAlly[id],
		// the gameState entity affirmations, as common-api defines them
		isEntityOwn: (ent: CommonEntity) => ent.owner() === PLAYER,
		isEntityAlly: (ent: CommonEntity) => playerData.isAlly[ent.owner()],
		isEntityEnemy: (ent: CommonEntity) => isEnemy(ent.owner()),
		isEntityExclusiveAlly: (ent: CommonEntity) => playerData.isAlly[ent.owner()] && ent.owner() !== PLAYER,
		/** structures of everyone we and they consider an ally, as the game defines ally collections */
		getAllyStructures: () => collect(structures.filter((s) => playerData.isMutualAlly[s.owner()])),
		getPassabilityClassMask: () => 0
	});
	return world;
}
