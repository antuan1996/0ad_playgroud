/**
 * Petra TS with a dump of its own state, for match.sh -b: the bot's decisions
 * hang on AI-side state the engine never sees (entity metadata, queues and their
 * accounts, plans, base resource lists), so the timeline cannot show it.
 *
 * prepare-bot.ts state copies this file into petra_out/_botstate.js and points
 * data.json at PetraBotState. Every two game minutes (minutes 1, 3, 5, ..., as
 * the timeline) it prints one line:
 *   BOTSTATE {"minute":..,"player":..,"hq":{..},"workers":{..},"gathering":{..},
 *             "bases":[..],"queues":{..},"attacks":{..},"defenseArmies":..}
 * It only reads: the game is the same with it or without (same fingerprint).
 */
import { PetraBot } from "simulation/ai/petra_out/_petrabot.js";

const DUMP_FIRST = 60;
const DUMP_EVERY = 120;

export class PetraBotState extends PetraBot
{
	OnUpdate(sharedScript)
	{
		super.OnUpdate(sharedScript);
		if (!this.HQ || !this.queueManager || this.gameState.playerData.state != "active")
			return;
		this.nextStateDump ??= DUMP_FIRST;
		if (this.elapsedTime < this.nextStateDump)
			return;
		this.nextStateDump += DUMP_EVERY;
		print("BOTSTATE " + JSON.stringify(this.stateDump()) + "\n");
	}

	stateDump()
	{
		const gameState = this.gameState;
		const HQ = this.HQ;
		const count = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };

		// Units by "role/subrole", gatherers by what they gather.
		const workers = {};
		const gathering = {};
		for (const ent of gameState.getOwnUnits().values())
		{
			const role = ent.getMetadata(PlayerID, "role") ?? "none";
			const subrole = ent.getMetadata(PlayerID, "subrole");
			count(workers, subrole ? role + "/" + subrole : role);
			if (subrole == "gatherer")
				count(gathering, ent.getMetadata(PlayerID, "gather-type") ?? "none");
		}

		// Each base's resource lists, by distance band, and the amount within reach.
		const bases = HQ.basesManager.baseManagers.map(base =>
		{
			const supplies = {};
			for (const type in base.dropsiteSupplies)
			{
				const bands = base.dropsiteSupplies[type];
				supplies[type] = {
					"nearby": bands.nearby.length,
					"medium": bands.medium.length,
					"faraway": bands.faraway.length,
					"amount": base.getResourceLevel(gameState, type, ["nearby", "medium"])
				};
			}
			// A base gets its anchor with the foundation, its lists once it is built.
			const anchor = base.anchorId === undefined ? undefined : gameState.getEntityById(base.anchorId);
			return {
				"id": base.ID,
				"anchor": base.anchorId,
				"anchorBuilt": !!anchor && anchor.foundationProgress() === undefined,
				"access": base.accessIndex,
				supplies
			};
		});

		// Queues with what is planned and what is set aside for it.
		const queues = {};
		for (const name in this.queueManager.queues)
		{
			const plans = this.queueManager.queues[name].plans;
			const account = this.queueManager.accounts[name];
			const reserved = {};
			for (const type of Resources.GetCodes())
				if (account?.[type])
					reserved[type] = account[type];
			if (!plans.length && !Object.keys(reserved).length)
				continue;
			queues[name] = {
				"priority": this.queueManager.priorities[name],
				"plans": plans.map(plan => plan.type + (plan.number > 1 ? " x" + plan.number : "")),
				reserved
			};
		}

		const attacks = {};
		for (const [state, lists] of [["upcoming", HQ.attackManager.upcomingAttacks], ["started", HQ.attackManager.startedAttacks]])
			for (const type in lists)
				for (const plan of lists[type])
					(attacks[state] ??= []).push({
						"name": plan.name,
						type,
						"state": plan.state,
						"target": plan.targetPlayer,
						"units": plan.unitCollection.length
					});

		return {
			"minute": Math.round(this.elapsedTime / 60),
			"player": PlayerID,
			"hq": {
				"phase": HQ.currentPhase,
				"phasing": HQ.phasing,
				"saveResources": !!HQ.saveResources,
				"saveSpace": !!HQ.saveSpace,
				"needFarm": !!HQ.needFarm,
				"canBuildUnits": HQ.canBuildUnits,
				"targetNumWorkers": HQ.targetNumWorkers,
				"popPhase2": this.Config.Economy.popPhase2
			},
			workers,
			gathering,
			bases,
			queues,
			attacks,
			"defenseArmies": HQ.defenseManager.armies.length
		};
	}
}
