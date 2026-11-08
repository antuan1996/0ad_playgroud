/**
 * Capture or destroy: whether a unit of ours should capture a target or destroy it (moved from adapter/, which may
 * read no AI state: the joint strength comes from the capture tally of world/captureTally.ts).
 */
import { getAttackBonus } from "../adapter/entityExtend.ts";

/** Decide if we should try to capture (returns true) or destroy (return false) */
export function allowCapture(gameState: CommonGameState, ent: CommonEntity, target: CommonEntity): boolean
{
	if (!target.isCapturable() || !ent.canCapture(target))
	{
		return false;
	}
	if (target.isInvulnerable())
	{
		return true;
	}
	// always try to recapture capture points from an allied, except if it's decaying
	if (gameState.isPlayerAlly(target.owner()))
	{
		return !target.decaying();
	}

	const antiCapture = antiCaptureOf(gameState, target);
	const capture = jointCaptureStrength(gameState, ent, target) * (1 / (0.1 + 0.9 * target.healthLevel()));
	const capturePoints = target.capturePoints();
	const sumCapturePoints = capturePoints ? capturePoints.reduce((a: number, b: number): number => a + b) : 0;
	if (target.hasDefensiveFire() && target.isGarrisonHolder() && target.garrisoned())
	{
		return capture > antiCapture + sumCapturePoints / 50;
	}
	return capture > antiCapture + sumCapturePoints / 80;
}

/** How fast target regains its capture points: its regeneration, its garrison's, less its decay. */
function antiCaptureOf(gameState: CommonGameState, target: CommonEntity): number
{
	let antiCapture = target.defaultRegenRate();
	if (target.isGarrisonHolder())
	{
		const garrisonRegenRate = target.garrisonRegenRate();
		for (const garrisonedEntity of target.garrisoned())
		{
			antiCapture += garrisonRegenRate * (gameState.getEntityById(garrisonedEntity)?.captureStrength() || 0);
		}
	}

	if (target.decaying())
	{
		antiCapture -= target.territoryDecayRate();
	}
	return antiCapture;
}

/** The capture strength of every unit set on capturing target, ent counted in. */
function jointCaptureStrength(gameState: CommonGameState, ent: CommonEntity, target: CommonEntity): number
{
	let capture;
	const capturableTargets = gameState.ai.captures.targets;
	const capturable = capturableTargets.get(target.id());
	if (!capturable)
	{
		capture = (ent.captureStrength() ?? NaN) * getAttackBonus(ent, target, "Capture");
		capturableTargets.set(target.id(), { strength: capture, ents: new Set([ent.id()]) });
	}
	else
	{
		if (!capturable.ents.has(ent.id()))
		{
			capturable.strength += (ent.captureStrength() ?? NaN) * getAttackBonus(ent, target, "Capture");
			capturable.ents.add(ent.id());
		}
		capture = capturable.strength;
	}
	return capture;
}
