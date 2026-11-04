import { techName } from "../adapter/brands.ts";
import { ResearchPlan } from "../execution/queueplanResearch.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";
import { PAYBACK_HORIZON, incomeGain, paybackSeconds } from "./economyScore.ts";

/**
 * Whether a tech with these modifications is wanted as soon as available:
 * undefined if not, else whether it is urgent (the cheap gather rates).
 */
function wantedModification(
	modifications: Array<{ value: string }>,
	cheap: boolean,
	naval: boolean,
): boolean | undefined
{
	for (const modification of modifications)
	{
		const value = modification.value;
		if (
			naval && value === "ResourceGatherer/Rates/food.fish" || value === "ResourceGatherer/Rates/food.fruit" ||
			value === "ResourceGatherer/Rates/wood.tree"
		)
			return cheap;
		if (
			value === "ResourceGatherer/Rates/food.grain" || value.startsWith("ResourceGatherer/Capacities") ||
			value === "Attack/Ranged/MaxRange"
		)
			return false;
	}
	return undefined;
}

/** A tech the stock cannot pay for that ten resources a worker would not cover: wait for it. */
function tooDearForWorkers(
	cost: CommonResourceAmounts | undefined,
	available: Record<string, number> | null,
	numWorkers: number,
): boolean
{
	let costMax = 0;
	for (const res in cost)
		costMax = Math.max(costMax, Math.max(cost[res] - (available ? available[res] : 0), 0));
	return 10 * numWorkers < costMax;
}

/**
 * Manage the research
 */
export class ResearchManager
{
	Config: Config;

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
		const nextPhaseName = gameState.getPhaseName(currentPhaseIndex + 1);
		if (!nextPhaseName)
			return;

		// a town whose land has run dry of wood asks for the town phase at once,
		// while its stock still pays the phase and the market after it: waiting
		// for its population, it spent the wood on houses and stayed in the
		// village phase (FINDINGS §37)
		const petraRequirements =
			currentPhaseIndex === 1 &&
				(gameState.ai.HQ.getAccountedPopulation(gameState) >= this.Config.Economy.popPhase2 ||
					gameState.ai.HQ.landRunDry(gameState)) ||
			currentPhaseIndex === 2 &&
				gameState.ai.HQ.getAccountedWorkers(gameState) > this.Config.Economy.workPhase3 ||
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
			const modifications = tech[1].modifications();
			if (!modifications)
				continue;
			// TODO may-be loop on all modifs and check if the effect if positive ?
			if (modifications[0].value !== "Population/Bonus")
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
			const modifications = tech[1].modifications();
			const affects = tech[1].affects();
			if (!modifications || !affects)
				continue;
			if (affects.indexOf("Trader") === -1)
				continue;
			// TODO may-be loop on all modifs and check if the effect if positive ?
			if (modifications[0].value !== "UnitMotion/WalkSpeed" && modifications[0].value !== "Trader/GainMultiplier")
				continue;
			queues.minorTech.addPlan(new ResearchPlan(gameState, tech[0]));
			break;
		}
	}

	/** Techs to be searched for as soon as they are available */
	researchWantedTechs(
		gameState: CommonGameState,
		techs: Array<[TechName, CommonTechnology]>,
	): { name: TechName; increasePriority: boolean } | undefined
	{
		const phase1 = gameState.currentPhase() === 1;
		const available = phase1 ? gameState.ai.queueManager.getAvailableResources(gameState) : null;
		const numWorkers = phase1 ? gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length : 0;
		for (const tech of techs)
		{
			if (tech[0].indexOf("unlock_champion") === 0)
				return { "name": tech[0], "increasePriority": true };
			if (tech[0] === "traditional_army_sele" || tech[0] === "reformed_army_sele")
			{
				const selected = pickRandom([techName("traditional_army_sele"), techName("reformed_army_sele")]);
				if (selected !== undefined)
					return { "name": selected, "increasePriority": true };
			}

			const modifications = tech[1].modifications();
			if (!modifications)
				continue;
			const cost = tech[1].cost();
			if (phase1 && tooDearForWorkers(cost, available, numWorkers))
				continue;
			const increasePriority = wantedModification(
				modifications,
				this.CostSum(cost) < 400,
				gameState.ai.HQ.geography.navalMap,
			);
			if (increasePriority !== undefined)
				return { "name": tech[0], increasePriority };
		}
		return undefined;
	}

	/**
	 * The economy tech that pays back soonest, if it pays back within the
	 * horizon (decision/economyScore.ts, FINDINGS §28).
	 */
	researchPayingTech(gameState: CommonGameState, techs: Array<[TechName, CommonTechnology]>): TechName | undefined
	{
		const economy = gameState.ai.HQ.gatherEconomy;
		let best: TechName | undefined;
		let bestPayback = PAYBACK_HORIZON;
		for (const [name, tech] of techs)
		{
			const modifications = tech.modifications();
			if (!modifications)
				continue;
			const cost = tech.cost();
			let costSum = 0;
			for (const res in cost)
				costSum += cost[res];
			const payback = paybackSeconds(costSum, tech.researchTime(), incomeGain(economy, modifications));
			if (payback < bestPayback)
			{
				best = name;
				bestPayback = payback;
			}
		}
		return best;
	}

	/** Techs to be searched for as soon as they are available, but only after phase 2 */
	researchPreferredTechs(
		gameState: CommonGameState,
		techs: Array<[TechName, CommonTechnology]>,
	): { name: TechName; increasePriority: boolean } | undefined
	{
		const phase2 = gameState.currentPhase() === 2;
		const available = phase2 ? gameState.ai.queueManager.getAvailableResources(gameState) : null;
		const numWorkers = phase2 ? gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length : 0;
		for (const tech of techs)
		{
			const modifications = tech[1].modifications();
			if (!modifications)
				continue;
			const cost = tech[1].cost();
			if (phase2 && tooDearForWorkers(cost, available, numWorkers))
				continue;
			const cheap = this.CostSum(cost) < 400;
			for (const modification of modifications)
			{
				const value = modification.value;
				if (
					value === "ResourceGatherer/Rates/stone.rock" || value === "ResourceGatherer/Rates/metal.ore" ||
					value === "BuildingAI/DefaultArrowCount"
				)
					return { "name": tech[0], "increasePriority": cheap };
				if (value === "Health/RegenRate" || value === "Health/IdleRegenRate")
					return { "name": tech[0], "increasePriority": false };
			}
		}
		return undefined;
	}

	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		if (queues.majorTech.hasQueuedUnits())
			return;

		const techs = gameState.findAvailableTech();

		// a tech that pays back within the horizon is paid before the women; it
		// takes the place of a plan of Petra's rules waiting in the queue (the
		// capacity tech waited there unpaid from minute 5 to 15, FINDINGS §28)
		const paying = this.researchPayingTech(gameState, techs);
		if (paying && queues.minorTech.getNext()?.type !== paying)
		{
			queues.minorTech.empty();
			gameState.ai.queueManager.changePriority("minorTech", this.Config.priorities.villager + 1);
			const plan = new ResearchPlan(gameState, paying);
			plan.queueToReset = "minorTech";
			queues.minorTech.addPlan(plan);
			return;
		}
		if (queues.minorTech.hasQueuedUnits())
			return;

		const wanted = this.researchWantedTechs(gameState, techs);
		if (wanted)
		{
			this.queueTech(gameState, queues, wanted);
			return;
		}

		if (gameState.currentPhase() < 2)
			return;

		const preferred = this.researchPreferredTechs(gameState, techs);
		if (preferred)
		{
			this.queueTech(gameState, queues, preferred);
			return;
		}

		if (gameState.currentPhase() < 3)
			return;

		this.dropUnusedTechs(gameState, techs);
		if (!techs.length)
			return;

		// randomly pick one. No worries about pairs in that case.
		const pickedTech = pickRandom(techs);
		if (!pickedTech)
			return;
		queues.minorTech.addPlan(new ResearchPlan(gameState, pickedTech[0]));
	}

	/** Queues a chosen tech; one wanted soon raises the minor techs' priority until it starts. */
	private queueTech(
		gameState: CommonGameState,
		queues: PetraRuntime.QueueCollection,
		choice: { name: TechName; increasePriority: boolean },
	): void
	{
		if (!choice.increasePriority)
		{
			queues.minorTech.addPlan(new ResearchPlan(gameState, choice.name));
			return;
		}
		gameState.ai.queueManager.changePriority("minorTech", 2 * this.Config.priorities.minorTech);
		const plan = new ResearchPlan(gameState, choice.name);
		plan.queueToReset = "minorTech";
		queues.minorTech.addPlan(plan);
	}

	/** Removes the techs this AI does not use yet, and the shared line of sight without an ally. */
	private dropUnusedTechs(gameState: CommonGameState, techs: Array<[TechName, CommonTechnology]>): void
	{
		for (let i = 0; i < techs.length; ++i)
		{
			const affects = techs[i][1].affects();
			const modifications = techs[i][1].modifications();
			// the class list's first class: "Healer !Champion !Hero" is for healers
			const classes = affects && affects.length === 1 ? affects[0] : undefined;
			const firstClass = typeof classes === "string" ? classes.split(" ")[0] : classes?.[0];
			if (firstClass === "Healer" || firstClass === "Outpost" || firstClass === "Wall")
			{
				techs.splice(i--, 1);
				continue;
			}
			if (
				modifications && modifications.length === 1 &&
				this.Config.unusedNoAllyTechs.includes(modifications[0].value) &&
				!gameState.hasAllies()
			)
			{
				techs.splice(i--, 1);
				continue;
			}
		}
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

	/** the manager keeps no state of its own: its save is empty */
	Serialize(): Record<string, never>
	{
		return {};
	}

	/** A saved research manager: it saves nothing of its own */
	static restore(Config: Config, data: Record<string, never>): ResearchManager
	{
		const manager = new ResearchManager(Config);
		manager.resume(data);
		return manager;
	}

	private resume(_data: Record<string, never>): void
	{
	}
}
