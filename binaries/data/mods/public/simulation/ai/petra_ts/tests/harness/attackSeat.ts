/**
 * The attack suites' seat (attackManager.test.ts, attackDesk.test.ts,
 * bombardment.test.ts): configs with a chosen temper, an attack manager wired
 * to a world as the headquarters owns it (its desk the town's attacks), plan
 * stubs answering every question a test asks, and foes added to the world.
 */
import { fake } from "./fakes.ts";
import { makeWorld, type World } from "./world.ts";

import { AttackManager } from "../../decision/attackManager.ts";
import type { AttackDesk } from "../../execution/attackDesk.ts";
import { AttackPlan } from "../../execution/attackPlan.ts";
import { Config } from "../../world/config.ts";
import { MEDIUM } from "../../world/difficultyLevel.ts";

export const KEEP = AttackPlan.PREPARATION_KEEP_GOING;
export const FAILED = AttackPlan.PREPARATION_FAILED;
export const START = AttackPlan.PREPARATION_START;
export const UNEXECUTED = AttackPlan.STATE_UNEXECUTED;
export const COMPLETING = AttackPlan.STATE_COMPLETING;

/** A config whose personality the test picks, as Petra's Config would be. */
export function configFor(aggressive: number, overrides: Partial<Config> = {}): Config
{
	return Object.assign(new Config(MEDIUM), {
		priorities: {},
		personality: { aggressive, defensive: 0, cooperative: 0.5 },
		...overrides,
	});
}

/** The config the world implies, with chatter on, for typical managers. */
export function worldConfig(world: World, overrides: Partial<Config> = {}): Config
{
	return Object.assign(new Config(world.ai.Config.difficulty), world.ai.Config, { chat: true, ...overrides });
}

/** The plans the manager makes, run and kept by its desk (execution/attackDesk.ts) */
export function desk(manager: AttackManager): AttackDesk
{
	return manager.desk;
}

/** The manager wired to one world, as headquarters owns it, its desk the town's attacks */
export function makeManager(world: World, config: Config): AttackManager
{
	const manager = new AttackManager(config, world.gameState, world.ai.HQ);
	world.ai.HQ.attackManager = manager;
	Object.assign(world.ai.town, { attacks: manager.desk });
	return manager;
}

/** A manager of a world of its own */
export function freshManager(config: Config): AttackManager
{
	return makeManager(makeWorld(), config);
}

/** A plan stub's record of what the manager asked of it. */
export interface PlanCalls
{
	forceStartCalls: number;
	abortCalls: number;
	checkEventsCalls: number;
	updatePreparationCalls: number;
	/** each setPaused, in order */
	pauses: boolean[];
}

/**
 * A plan as the manager sees it in its rosters, with every question answered
 * by the test: how it rolls preparation, whether it starts, how many units it
 * owns, and what its abort/force-start calls did.
 */
export function planStub(
	overrides: {
		name?: number;
		type?: string;
		state?: string;
		targetPlayer?: number | undefined;
		units?: number;
		paused?: boolean;
		preparation?: number;
		startable?: boolean;
		remaining?: number | false;
		alreadyStarted?: boolean;
		position?: [number, number] | undefined;
	} = {},
): AttackPlan & PlanCalls
{
	const stub = {
		name: overrides.name ?? 1,
		type: overrides.type ?? "Attack",
		state: overrides.state ?? UNEXECUTED,
		targetPlayer: overrides.targetPlayer,
		position: overrides.position,
		unitCollection: { length: overrides.units ?? 0 },
		requested: undefined,
		paused: overrides.paused ?? false,
		forceStartCalls: 0,
		abortCalls: 0,
		checkEventsCalls: 0,
		answerAttacksCalls: 0,
		updatePreparationCalls: 0,
		pauses: [] as boolean[],
		forceStart: () =>
		{
			++stub.forceStartCalls;
		},
		checkEvents: () =>
		{
			++stub.checkEventsCalls;
		},
		answerAttacks: () =>
		{
			++stub.answerAttacksCalls;
		},
		isStarted: () => overrides.alreadyStarted ?? false,
		isPaused: () => stub.paused,
		updatePreparation: () =>
		{
			++stub.updatePreparationCalls;
			return overrides.preparation ?? KEEP;
		},
		StartAttack: () => overrides.startable ?? true,
		update: () => overrides.remaining ?? 1,
		Abort: () =>
		{
			++stub.abortCalls;
		},
		getName: () => stub.name,
		getType: () => stub.type,
		setPaused: (value: boolean) =>
		{
			stub.paused = value;
			stub.pauses.push(value);
		},
	};
	return fake<AttackPlan & PlanCalls>(stub);
}

/** The world game state's roster tables for a player that players 0-2 lack. */
export function addFoe(world: World, player: number): void
{
	const gs = world.gameState as unknown as {
		playerData: { isEnemy: boolean[]; };
		sharedScript: { playersData: unknown[]; };
	};
	gs.playerData.isEnemy[player] = true;
	gs.sharedScript.playersData[player] = { state: "active" };
}
