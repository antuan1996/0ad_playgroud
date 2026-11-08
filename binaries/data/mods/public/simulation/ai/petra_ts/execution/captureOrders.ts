/**
 * Capture or destroy, ordered: every 3 s the headquarters has the capture tally (world/captureTally.ts) rebuilt from
 * our units' attack orders, and each target's attackers switched to capturing it or destroying it as allowCapture
 * (world/capture.ts) now judges. Unit orders, so the execution layer's (moved from decision/headquarters.ts).
 */
import { getAttackBonus } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { hasActivity } from "../adapter/unitState.ts";
import { allowCapture } from "../world/capture.ts";
import type { CaptureTally } from "../world/captureTally.ts";

/** Compute the capture strength of all units attacking a capturable target */
export function updateCaptureStrength(gameState: CommonGameState, tally: CaptureTally): void
{
	tally.targets.clear();
	for (const ent of gameState.getOwnUnits().values())
	{
		addCaptureStrength(gameState, ent, tally);
	}

	for (const [targetId, capturableTarget] of tally.targets)
	{
		const target = gameState.getEntityById(targetId);
		if (!target)
		{
			continue;
		}
		let shouldCapture;
		for (const entId of capturableTarget.ents)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent)
			{
				continue;
			}
			if (shouldCapture === undefined)
			{
				shouldCapture = allowCapture(gameState, ent, target);
			}
			const orderData = ordersOf(ent);
			if (!orderData || !orderData.length || !orderData[0].attackType)
			{
				continue;
			}
			if ((orderData[0].attackType === "Capture") !== shouldCapture)
			{
				ent.attack(targetId, shouldCapture);
			}
		}
	}

	tally.time = gameState.ai.elapsedTime;
}

/** A unit of ours capturing adds its capture strength to its target's */
function addCaptureStrength(gameState: CommonGameState, ent: CommonEntity, tally: CaptureTally): void
{
	if (!ent.canCapture())
	{
		return;
	}
	if (!hasActivity(ent, "COMBAT"))
	{
		return;
	}
	const orderData = ordersOf(ent);
	if (!orderData || !orderData.length || !orderData[0].target)
	{
		return;
	}
	const targetId = orderData[0].target;
	const target = gameState.getEntityById(targetId);
	if (!target || !target.isCapturable() || !ent.canCapture(target))
	{
		return;
	}
	const captureStrength = ent.captureStrength();
	if (captureStrength === undefined)
	{
		return;
	}
	const capturableTarget = tally.targets.get(targetId);
	if (!capturableTarget)
	{
		tally.targets.set(targetId, {
			strength: captureStrength * getAttackBonus(ent, target, "Capture"),
			ents: new Set([ent.id()]),
		});
	}
	else
	{
		capturableTarget.strength += captureStrength * getAttackBonus(ent, target, "Capture");
		capturableTarget.ents.add(ent.id());
	}
}
