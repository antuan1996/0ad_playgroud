import { ResearchPlan } from "../execution/queueplanResearch.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "./config.ts";

/**
 * Manage the research
 */
export class ResearchManager
{
	declare Config: Config;

	constructor(Config: Config)
	{
		this.Config = Config;
	}

	/**
	 * Check if we can go to the next phase
	 */
	checkPhase(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.majorTech.hasQueuedUnits())
			return;
		// Don't try to phase up if already trying to gather resources for a civil-centre or wonder
		if (queues.civilCentre.hasQueuedUnits() || queues.wonder.hasQueuedUnits())
			return;

		const currentPhaseIndex = gameState.currentPhase();
		const nextPhaseName = gameState.getPhaseName(currentPhaseIndex+1);
		if (!nextPhaseName)
			return;

		const petraRequirements =
			currentPhaseIndex == 1 && gameState.ai.HQ.getAccountedPopulation(gameState) >= this.Config.Economy.popPhase2 ||
			currentPhaseIndex == 2 && gameState.ai.HQ.getAccountedWorkers(gameState) > this.Config.Economy.workPhase3 ||
			currentPhaseIndex >= 3 && gameState.ai.HQ.getAccountedWorkers(gameState) > this.Config.Economy.workPhase4;
		if (petraRequirements && gameState.hasResearchers(nextPhaseName, true))
		{
			gameState.ai.HQ.phasing = currentPhaseIndex + 1;
			// Reset the queue priority in case it was changed during a previous phase update
			gameState.ai.queueManager.changePriority("majorTech", gameState.ai.Config.priorities.majorTech);
			queues.majorTech.addPlan(new ResearchPlan(gameState, nextPhaseName, true));
		}
	}

	researchPopulationBonus(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.minorTech.hasQueuedUnits())
			return;

		const techs = gameState.findAvailableTech();
		for (const tech of techs)
		{
			if (!tech[1]._template.modifications)
				continue;
			// TODO may-be loop on all modifs and check if the effect if positive ?
			if (tech[1]._template.modifications[0].value !== "Population/Bonus")
				continue;
			queues.minorTech.addPlan(new ResearchPlan(gameState, tech[0]));
			break;
		}
	}

	researchTradeBonus(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.minorTech.hasQueuedUnits())
			return;

		const techs = gameState.findAvailableTech();
		for (const tech of techs)
		{
			if (!tech[1]._template.modifications || !tech[1]._template.affects)
				continue;
			if (tech[1]._template.affects.indexOf("Trader") === -1)
				continue;
			// TODO may-be loop on all modifs and check if the effect if positive ?
			if (tech[1]._template.modifications[0].value !== "UnitMotion/WalkSpeed" &&
		              tech[1]._template.modifications[0].value !== "Trader/GainMultiplier")
				continue;
			queues.minorTech.addPlan(new ResearchPlan(gameState, tech[0]));
			break;
		}
	}

	/** Techs to be searched for as soon as they are available */
	researchWantedTechs(gameState: CommonGameState, techs: Array<[string, CommonTemplate]>): { name: string; increasePriority: boolean } | null
	{
		const phase1 = gameState.currentPhase() === 1;
		const available = phase1 ? gameState.ai.queueManager.getAvailableResources(gameState) : null;
		const numWorkers = phase1 ? gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length : 0;
		for (const tech of techs)
		{
			if (tech[0].indexOf("unlock_champion") == 0)
				return { "name": tech[0], "increasePriority": true };
			if (tech[0] == "traditional_army_sele" || tech[0] == "reformed_army_sele")
			{
				const selected = pickRandom(["traditional_army_sele", "reformed_army_sele"]);
				if (selected !== undefined)
					return { "name": selected, "increasePriority": true };
			}

			if (!tech[1]._template.modifications)
				continue;
			const template = tech[1]._template;
			if (phase1)
			{
				const cost = template.cost;
				let costMax = 0;
				for (const res in cost)
					costMax = Math.max(costMax, Math.max(cost[res]-(available ? available[res] : 0), 0));
				if (10*numWorkers < costMax)
					continue;
			}
			for (const i in template.modifications)
			{
				if (gameState.ai.HQ.geography.navalMap && template.modifications[i].value === "ResourceGatherer/Rates/food.fish")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value === "ResourceGatherer/Rates/food.fruit")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value === "ResourceGatherer/Rates/food.grain")
					return { "name": tech[0], "increasePriority": false };
				else if (template.modifications[i].value === "ResourceGatherer/Rates/wood.tree")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value.startsWith("ResourceGatherer/Capacities"))
					return { "name": tech[0], "increasePriority": false };
				else if (template.modifications[i].value === "Attack/Ranged/MaxRange")
					return { "name": tech[0], "increasePriority": false };
			}
		}
		return null;
	}

	/** Techs to be searched for as soon as they are available, but only after phase 2 */
	researchPreferredTechs(gameState: CommonGameState, techs: Array<[string, CommonTemplate]>): { name: string; increasePriority: boolean } | null
	{
		const phase2 = gameState.currentPhase() === 2;
		const available = phase2 ? gameState.ai.queueManager.getAvailableResources(gameState) : null;
		const numWorkers = phase2 ? gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length : 0;
		for (const tech of techs)
		{
			if (!tech[1]._template.modifications)
				continue;
			const template = tech[1]._template;
			if (phase2)
			{
				const cost = template.cost;
				let costMax = 0;
				for (const res in cost)
					costMax = Math.max(costMax, Math.max(cost[res]-(available ? available[res] : 0), 0));
				if (10*numWorkers < costMax)
					continue;
			}
			for (const i in template.modifications)
			{
				if (template.modifications[i].value === "ResourceGatherer/Rates/stone.rock")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value === "ResourceGatherer/Rates/metal.ore")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value === "BuildingAI/DefaultArrowCount")
					return { "name": tech[0], "increasePriority": this.CostSum(template.cost) < 400 };
				else if (template.modifications[i].value === "Health/RegenRate")
					return { "name": tech[0], "increasePriority": false };
				else if (template.modifications[i].value === "Health/IdleRegenRate")
					return { "name": tech[0], "increasePriority": false };
			}
		}
		return null;
	}

	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.minorTech.hasQueuedUnits() || queues.majorTech.hasQueuedUnits())
			return;

		const techs = gameState.findAvailableTech();

		let techName = this.researchWantedTechs(gameState, techs);
		if (techName)
		{
			if (techName.increasePriority)
			{
				gameState.ai.queueManager.changePriority("minorTech", 2*this.Config.priorities.minorTech);
				const plan = new ResearchPlan(gameState, techName.name);
				plan.queueToReset = "minorTech";
				queues.minorTech.addPlan(plan);
			}
			else
				queues.minorTech.addPlan(new ResearchPlan(gameState, techName.name));
			return;
		}

		if (gameState.currentPhase() < 2)
			return;

		techName = this.researchPreferredTechs(gameState, techs);
		if (techName)
		{
			if (techName.increasePriority)
			{
				gameState.ai.queueManager.changePriority("minorTech", 2*this.Config.priorities.minorTech);
				const plan = new ResearchPlan(gameState, techName.name);
				plan.queueToReset = "minorTech";
				queues.minorTech.addPlan(plan);
			}
			else
				queues.minorTech.addPlan(new ResearchPlan(gameState, techName.name));
			return;
		}

		if (gameState.currentPhase() < 3)
			return;

		// remove some techs not yet used by this AI
		// remove also sharedLos if we have no ally
		for (let i = 0; i < techs.length; ++i)
		{
			const template = techs[i][1]._template;
			if (template.affects && template.affects.length === 1 &&
				(template.affects[0] === "Healer" || template.affects[0] === "Outpost" || template.affects[0] === "Wall"))
			{
				techs.splice(i--, 1);
				continue;
			}
			if (template.modifications && template.modifications.length === 1 &&
				this.Config.unusedNoAllyTechs.includes(template.modifications[0].value) &&
				!gameState.hasAllies())
			{
				techs.splice(i--, 1);
				continue;
			}
		}
		if (!techs.length)
			return;

		// randomly pick one. No worries about pairs in that case.
		const pickedTech = pickRandom(techs);
		if (!pickedTech)
			return;
		queues.minorTech.addPlan(new ResearchPlan(gameState, pickedTech[0]));
	}

	/** A tech without a cost (the civ bonuses researched automatically) sums to 0, as in the original. */
	CostSum(cost: CommonResourceAmounts | undefined): number
	{
		let costSum = 0;
		if (cost === undefined)
			return costSum;
		for (const res in cost)
			costSum += cost[res];
		return costSum;
	}

	Serialize(): Record<string, never>
	{
		return {};
	}

	Deserialize(data: Record<string, unknown>): void
	{
	}
}
