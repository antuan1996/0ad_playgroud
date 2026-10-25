/**
 * What a unit is doing, as the engine reports it (PLAN.md §3.2).
 *
 * `ent.unitAIState()` is the dotted name of the unit's state in UnitAI's state
 * machine (simulation/components/UnitAI.js, UnitFsmSpec): "INDIVIDUAL.GATHER.
 * GATHERING", "FORMATIONMEMBER.WALKING", ... or nothing at all, which the
 * engine can report (AIProxy passes on UnitAI.GetCurrentState()). Parsed here,
 * once, into a value the rest of the bot can switch on: the names the state
 * machine has are a closed union, so a test against a state that does not
 * exist, or is misspelled, does not compile.
 *
 * UNIT_AI_STATES is the state machine's own list, read from UnitAI.js (every
 * key of FSM.states for UnitFsmSpec); refresh it when UnitAI.js changes its
 * states. A state not in it parses as "other" with its raw name.
 */
import { requireValue } from "./entityExtend.ts";

export const UNIT_AI_STATES = [
	"FORMATIONCONTROLLER",
	"FORMATIONCONTROLLER.COMBAT",
	"FORMATIONCONTROLLER.COMBAT.APPROACHING",
	"FORMATIONCONTROLLER.COMBAT.ATTACKING",
	"FORMATIONCONTROLLER.FORMING",
	"FORMATIONCONTROLLER.GARRISON",
	"FORMATIONCONTROLLER.GARRISON.APPROACHING",
	"FORMATIONCONTROLLER.GARRISON.GARRISONING",
	"FORMATIONCONTROLLER.IDLE",
	"FORMATIONCONTROLLER.MEMBER",
	"FORMATIONCONTROLLER.PATROL",
	"FORMATIONCONTROLLER.PATROL.CHECKINGWAYPOINT",
	"FORMATIONCONTROLLER.PATROL.PATROLLING",
	"FORMATIONCONTROLLER.WALKING",
	"FORMATIONCONTROLLER.WALKINGANDFIGHTING",
	"FORMATIONMEMBER",
	"FORMATIONMEMBER.CHEERING",
	"FORMATIONMEMBER.IDLE",
	"FORMATIONMEMBER.IDLE.LINGERING",
	"FORMATIONMEMBER.IDLE.ROAMING",
	"FORMATIONMEMBER.WALKING",
	"FORMATIONMEMBER.WALKINGTOPOINT",
	"INDIVIDUAL",
	"INDIVIDUAL.CHEERING",
	"INDIVIDUAL.COLLECTTREASURE",
	"INDIVIDUAL.COLLECTTREASURE.APPROACHING",
	"INDIVIDUAL.COLLECTTREASURE.COLLECTING",
	"INDIVIDUAL.COLLECTTREASURE.FINDINGNEWTARGET",
	"INDIVIDUAL.COLLECTTREASURE.WALKING",
	"INDIVIDUAL.COMBAT",
	"INDIVIDUAL.COMBAT.APPROACHING",
	"INDIVIDUAL.COMBAT.ATTACKING",
	"INDIVIDUAL.COMBAT.CHASING",
	"INDIVIDUAL.COMBAT.CHASING.MOVINGTOPOINT",
	"INDIVIDUAL.COMBAT.FINDINGNEWTARGET",
	"INDIVIDUAL.FLEEING",
	"INDIVIDUAL.GARRISON",
	"INDIVIDUAL.GARRISON.APPROACHING",
	"INDIVIDUAL.GARRISON.GARRISONING",
	"INDIVIDUAL.GATHER",
	"INDIVIDUAL.GATHER.APPROACHING",
	"INDIVIDUAL.GATHER.FINDINGNEWTARGET",
	"INDIVIDUAL.GATHER.GATHERING",
	"INDIVIDUAL.GATHER.RETURNINGRESOURCE",
	"INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING",
	"INDIVIDUAL.GATHER.RETURNINGRESOURCE.DROPPINGRESOURCES",
	"INDIVIDUAL.GATHER.WALKING",
	"INDIVIDUAL.GUARD",
	"INDIVIDUAL.GUARD.ESCORTING",
	"INDIVIDUAL.GUARD.GUARDING",
	"INDIVIDUAL.HEAL",
	"INDIVIDUAL.HEAL.APPROACHING",
	"INDIVIDUAL.HEAL.FINDINGNEWTARGET",
	"INDIVIDUAL.HEAL.HEALING",
	"INDIVIDUAL.IDLE",
	"INDIVIDUAL.IDLE.LINGERING",
	"INDIVIDUAL.IDLE.ROAMING",
	"INDIVIDUAL.PACKING",
	"INDIVIDUAL.PATROL",
	"INDIVIDUAL.PATROL.CHECKINGWAYPOINT",
	"INDIVIDUAL.PATROL.PATROLLING",
	"INDIVIDUAL.PICKUP",
	"INDIVIDUAL.PICKUP.APPROACHING",
	"INDIVIDUAL.PICKUP.LOADING",
	"INDIVIDUAL.REPAIR",
	"INDIVIDUAL.REPAIR.APPROACHING",
	"INDIVIDUAL.REPAIR.REPAIRING",
	"INDIVIDUAL.RETURNRESOURCE",
	"INDIVIDUAL.RETURNRESOURCE.APPROACHING",
	"INDIVIDUAL.RETURNRESOURCE.DROPPINGRESOURCES",
	"INDIVIDUAL.TRADE",
	"INDIVIDUAL.TRADE.APPROACHINGMARKET",
	"INDIVIDUAL.TRADE.TRADING",
	"INDIVIDUAL.UNPACKING",
	"INDIVIDUAL.WALKING",
	"INDIVIDUAL.WALKINGANDFIGHTING",
] as const;

/** A state of UnitAI's state machine, by its dotted name. */
export type UnitAIStateName = typeof UNIT_AI_STATES[number];

/** The first part of a state name: who the unit acts as. */
export type UnitAIRole = "INDIVIDUAL" | "FORMATIONCONTROLLER" | "FORMATIONMEMBER";

/** The second part of a state name, what the unit does: "GATHER", "COMBAT", "FLEEING", ... */
export type UnitAIActivity = UnitAIStateName extends infer N ?
	N extends `${string}.${infer A}.${string}` ? A : N extends `${string}.${infer A}` ? A : never : never;

export type UnitState =
	/** The engine reported no state. */
	| { readonly kind: "none" }
	| {
		readonly kind: "known";
		readonly name: UnitAIStateName;
		readonly role: UnitAIRole;
		/** undefined for a role alone ("INDIVIDUAL"), as `name.split(".")[1]` */
		readonly activity: UnitAIActivity | undefined;
	}
	/** A name the state machine above does not have (a mod's UnitAI). */
	| { readonly kind: "other"; readonly raw: string };

const NONE: UnitState = { "kind": "none" };
const ACTIVITIES = new Set<string>(UNIT_AI_STATES.map((name: UnitAIStateName): string => name.split(".")[1] ?? ""));
const KNOWN = new Map<string, UnitState>(UNIT_AI_STATES.map((name: UnitAIStateName): [string, UnitState] =>
{
	const [role, activity] = name.split(".");
	return [name, { "kind": "known", name, "role": roleOf(role), "activity": activityNamed(activity) }];
}));

function roleOf(part: string): UnitAIRole
{
	return part === "FORMATIONCONTROLLER" || part === "FORMATIONMEMBER" ? part : "INDIVIDUAL";
}

function isActivity(part: string): part is UnitAIActivity
{
	return ACTIVITIES.has(part);
}

function activityNamed(part: string | undefined): UnitAIActivity | undefined
{
	return part !== undefined && isActivity(part) ? part : undefined;
}

/** The state the engine reports for a unit, parsed. */
export function parseUnitState(raw: string | undefined): UnitState
{
	if (raw === undefined)
		return NONE;
	return KNOWN.get(raw) ?? { "kind": "other", raw };
}

/** A unit's state, parsed. */
export function unitState(ent: CommonEntity): UnitState
{
	return parseUnitState(ent.unitAIState());
}

/** Whether a parsed state is exactly the state `name`. */
export function stateIs(state: UnitState, name: UnitAIStateName): boolean
{
	return state.kind === "known" && state.name === name;
}

/** Whether a unit is in exactly the state `name`. */
export function isInState(ent: CommonEntity, name: UnitAIStateName): boolean
{
	return stateIs(unitState(ent), name);
}

/**
 * What a parsed state does, its name's second part: undefined with no state
 * or a role alone. An unknown state gives its own second part.
 */
export function activityOf(state: UnitState): string | undefined
{
	switch (state.kind)
	{
	case "none":
		return undefined;
	case "known":
		return state.activity;
	case "other":
		return state.raw.split(".")[1];
	}
}

/** Whether a unit is doing `activity` (in any state below it). */
export function hasActivity(ent: CommonEntity, activity: UnitAIActivity): boolean
{
	return activityOf(unitState(ent)) === activity;
}

/**
 * A unit's state name where the code relies on it having one: like the
 * original's unguarded `.split`, it throws (after a warning) on a unit with none.
 */
export function requireStateName(ent: CommonEntity): string
{
	return requireValue(ent.unitAIState());
}

/** What a parsed state does, where the code relies on there being a state: throws on none. */
export function requireActivity(state: UnitState): string | undefined
{
	if (state.kind === "none")
		requireValue(undefined);
	return activityOf(state);
}

/** Whether a unit is doing `activity`, where the code relies on it having a state: throws on none. */
export function requiredActivityIs(ent: CommonEntity, activity: UnitAIActivity): boolean
{
	return requireActivity(unitState(ent)) === activity;
}

/** Whether a unit with a state, which the code relies on, is in `state` or below it. */
export function requiredStateWithin(ent: CommonEntity, state: UnitAIStateName): boolean
{
	return requireStateName(ent).startsWith(state);
}
