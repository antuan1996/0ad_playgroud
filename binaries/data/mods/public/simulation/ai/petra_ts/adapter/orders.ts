/**
 * What a unit has been ordered to do, as the engine reports it.
 *
 * `Entity.unitAIOrderData()` returns the UnitAI's orders, `{type, data}`
 * (UnitAI.GetOrders), since the engine's commit 4b516b336e; before it, the
 * orders' data alone (UnitAI.GetOrderData), and that is what the bot was
 * written for: `order.target` read off the result was undefined on every
 * order after the change, so every check of what a unit targets failed
 * (FINDINGS §18). The common API's own `Entity.currentGatherRate` has the
 * same fault and returns 0 for every gatherer; the bot uses gatherRate here.
 */

/** The data of a unit's orders, in queue order, leaving out the orders that carry none (as UnitAI.GetOrderData). */
export function ordersOf(ent: CommonEntity): CommonUnitOrderData[]
{
	const data: CommonUnitOrderData[] = [];
	for (const order of ent.unitAIOrderData())
		if (order.data)
			data.push(order.data);
	return data;
}

/**
 * The rate a gathering unit gathers at (resource units per second, the
 * template's base speed times its rate for the supply's type, with technology
 * modifications), from the target of its gather order, or its next order's
 * while it carries back; undefined when it cannot gather, 0 when it is not
 * gathering or its target is gone.
 */
export function gatherRate(gameState: CommonGameState, ent: CommonEntity): number | undefined
{
	const rates = ent.resourceGatherRates();
	if (!rates)
		return undefined;
	if (ent.unitAIState()?.split(".")[1] !== "GATHER")
		return undefined;
	const data = ordersOf(ent);
	const target = data[0]?.target ?? data[1]?.target;
	const supply = target === undefined ? undefined : gameState.getEntityById(target);
	const type = supply?.resourceSupplyType();
	if (!type)
		return 0;
	return rates[type.generic + "." + type.specific] || 0;
}
