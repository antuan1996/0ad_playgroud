import * as filters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { Queue } from "./queue.ts";
import { Worker } from "./worker.ts";
import type { Config } from "../decision/config.ts";
import { hqOf } from "./hq.ts";
import { requireValue } from "../adapter/entityExtend.ts";

/**
 * This takes the input queues and picks which items to fund with resources until no more resources are left to distribute.
 *
 * Currently this manager keeps accounts for each queue, split between the 4 main resources
 *
 * Each time resources are available (ie not in any account), it is split between the different queues
 * Mostly based on priority of the queue, and existing needs.
 * Each turn, the queue Manager checks if a queue can afford its next item, then it does.
 *
 * A consequence of the system it's not really revertible. Once a queue has an account of 500 food, it'll keep it
 * If for some reason the AI stops getting new food, and this queue lacks, say, wood, no other queues will
 * be able to benefit form the 500 food (even if they only needed food).
 * This is not to annoying as long as all goes well. If the AI loses many workers, it starts being problematic.
 *
 * It also has the effect of making the AI more or less always sit on a few hundreds resources since most queues
 * get some part of the total, and if all queues have 70% of their needs, nothing gets done
 * Particularly noticeable when phasing: the AI often overshoots by a good 200/300 resources before starting.
 *
 * This system should be improved. It's probably not flexible enough.
 */

/**
 * All queues, the one with the highest priority first, ties broken by queue
 * name. The keys of `queues` are unique, so a tie is always between two
 * different names and everything is strictly ordered.
 */
function sortedQueues(queues: PetraRuntime.QueueCollection, priorities: PetraRuntime.Dict<number>): Array<[PetraRuntime.QueueName, Queue]>
{
	return [...queueEntries(queues)]
		.sort(([a]: [string, Queue], [b]: [string, Queue]): number =>
		{
			const priorityDifference = priorities[b] - priorities[a];
			if (priorityDifference !== 0)
				return priorityDifference;
			return a < b ? -1 : 1;
		});
}

/** an attack plan's queues (attackPlan.ts): plan_<name>, with _champ or _siege */
const ATTACK_QUEUE = /^plan_\d+(_champ|_siege)?$/;

/** Whether `name` names a queue: one of the configuration's or an attack plan's. */
export function isQueueName(config: Config, name: string): name is PetraRuntime.QueueName
{
	return name in config.priorities || ATTACK_QUEUE.test(name);
}

/** The queues the configuration sets up, empty, in the order of Config.priorities. */
export function configuredQueues(): PetraRuntime.QueueCollection
{
	return {
		"villager": new Queue(), "citizenSoldier": new Queue(), "trader": new Queue(), "healer": new Queue(),
		"ships": new Queue(), "house": new Queue(), "dropsites": new Queue(), "field": new Queue(),
		"dock": new Queue(), "corral": new Queue(), "economicBuilding": new Queue(),
		"militaryBuilding": new Queue(), "defenseBuilding": new Queue(), "civilCentre": new Queue(),
		"majorTech": new Queue(), "minorTech": new Queue(), "wonder": new Queue(), "emergency": new Queue()
	};
}

/** Whether the collection holds a queue of that name (every key it lists). */
function holdsQueue(queues: PetraRuntime.QueueCollection, name: string): name is PetraRuntime.QueueName
{
	return Object.hasOwn(queues, name);
}

/** Each queue with its name, in the collection's order; lazy, as `for...in` over it would be. */
function* queueEntries(queues: PetraRuntime.QueueCollection): Generator<[PetraRuntime.QueueName, Queue]>
{
	for (const name in queues)
	{
		if (!holdsQueue(queues, name))
			continue;
		const queue = queues[name];
		if (queue)
			yield [name, queue];
	}
}

export class QueueManager
{
	Config: Config;
	accounts: Record<string, ResourcesManager>;
	finishingTime: GameSeconds | undefined;
	priorities: PetraRuntime.Dict<number>;
	queueArrays: Array<[PetraRuntime.QueueName, Queue]>;
	queues: PetraRuntime.QueueCollection;

	constructor(Config: Config, queues: PetraRuntime.QueueCollection)
	{
		this.Config = Config;
		this.queues = queues;
		this.priorities = {};
		for (const [name, priority] of Object.entries(Config.priorities))
			this.priorities[name] = priority;
		this.accounts = {};
		for (const q in this.queues)
			this.accounts[q] = new ResourcesManager();

		// the sorting is updated on priority change.
		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}

	/** Each queue with its name, in the order the queues were added. */
	entries(): Generator<[PetraRuntime.QueueName, Queue]>
	{
		return queueEntries(this.queues);
	}

	getAvailableResources(gameState: CommonGameState): ResourcesManager
	{
		const resources = gameState.getResources();
		for (const key in this.queues)
			resources.subtract(this.accounts[key]);
		return resources;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	getTotalAccountedResources(): ResourcesManager
	{
		const resources = new ResourcesManager();
		for (const key in this.queues)
			resources.add(this.accounts[key]);
		return resources;
	}

	currentNeeds(gameState: CommonGameState): ResourcesManager
	{
		const needed = new ResourcesManager();
		// queueArrays because it's faster.
		for (const q of this.queueArrays)
		{
			const queue = q[1];
			if (!queue.hasQueuedUnits() || !queue.plans[0].isGo(gameState))
				continue;
			const costs = queue.plans[0].getCost();
			needed.add(costs);
		}
		// get out current resources, not removing accounts.
		const current = gameState.getResources();
		for (const res of Resources.GetCodes())
			needed[res] = Math.max(0, needed[res] - current[res]);

		return needed;
	}

	// calculate the gather rates we'd want to be able to start all elements in our queues
	// TODO: many things.
	wantedGatherRates(gameState: CommonGameState): PetraRuntime.Dict<number>
	{
		// default values for first turn when we have not yet set our queues.
		if (gameState.ai.playedTurn === 0)
		{
			const ret: Record<string, number> = {};
			for (const res of Resources.GetCodes())
				ret[res] = this.Config.queues.firstTurn[res] || this.Config.queues.firstTurn.default;
			return ret;
		}

		// get out current resources, not removing accounts.
		const current = gameState.getResources();
		// short queue is the first item of a queue, assumed to be ready in 30s
		// medium queue is the second item of a queue, assumed to be ready in 60s
		// long queue contains the isGo=false items, assumed to be ready in 300s
		const totalShort: Record<string, number> = {};
		const totalMedium: Record<string, number> = {};
		const totalLong: Record<string, number> = {};
		for (const res of Resources.GetCodes())
		{
			totalShort[res] = this.Config.queues.short[res] || this.Config.queues.short.default;
			totalMedium[res] = this.Config.queues.medium[res] || this.Config.queues.medium.default;
			totalLong[res] = this.Config.queues.long[res] || this.Config.queues.long.default;
		}
		let total;
		// queueArrays because it's faster.
		for (const q of this.queueArrays)
		{
			const queue = q[1];
			if (queue.paused)
				continue;
			for (let j = 0; j < queue.length(); ++j)
			{
				if (j > 1)
					break;
				const cost = queue.plans[j].getCost();
				if (queue.plans[j].isGo(gameState))
				{
					if (j === 0)
						total = totalShort;
					else
						total = totalMedium;
				}
				else
					total = totalLong;
				for (const type in total)
					total[type] += cost[type];
				if (!queue.plans[j].isGo(gameState))
					break;
			}
		}
		// global rates
		const rates: Record<string, number> = {};
		let diff;
		for (const res of Resources.GetCodes())
		{
			if (current[res] > 0)
			{
				diff = Math.min(current[res], totalShort[res]);
				totalShort[res] -= diff;
				current[res] -= diff;
				if (current[res] > 0)
				{
					diff = Math.min(current[res], totalMedium[res]);
					totalMedium[res] -= diff;
					current[res] -= diff;
					if (current[res] > 0)
						totalLong[res] -= Math.min(current[res], totalLong[res]);
				}
			}
			rates[res] = totalShort[res]/30 + totalMedium[res]/60 + totalLong[res]/300;
		}

		return rates;
	}

	printQueues(gameState: CommonGameState): void
	{
		let numWorkers = 0;
		gameState.getOwnUnits().forEach((ent: CommonEntity): void =>
		{
			if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER &&
				ent.getMetadata(PlayerID, "plan") === undefined)
			{
				numWorkers++;
			}
		});
		aiWarn("---------- QUEUES ------------ with pop " + gameState.getPopulation() + " and workers " +
			numWorkers);
		for (const [i, q] of queueEntries(this.queues))
		{
			if (q.hasQueuedUnits())
			{
				aiWarn(i + ": ( with priority " + this.priorities[i] +" and accounts " +
					uneval(this.accounts[i]) +")");
				aiWarn(" while maxAccountWanted(0.6) is " + uneval(q.maxAccountWanted(gameState, 0.6)));
			}
			for (const plan of q.plans)
			{
				// Plans always plan for at least one unit (or build/research a
				// single thing), so the count is always printed.
				aiWarn("     " + plan.type + " x" + plan.number + "   isGo " + plan.isGo(gameState));
			}
		}
		aiWarn("Accounts");
		for (const p in this.accounts)
			aiWarn(p + ": " + uneval(this.accounts[p]));
		aiWarn("Current Resources: " + uneval(gameState.getResources()));
		aiWarn("Available Resources: " + uneval(this.getAvailableResources(gameState)));
		aiWarn("Wanted Gather Rates: " + uneval(hqOf(gameState).GetWantedGatherRates(gameState)));
		aiWarn("Current Gather Rates: " + uneval(hqOf(gameState).GetCurrentGatherRates(gameState)));
		aiWarn("Most needed resources: " + uneval(hqOf(gameState).pickMostNeededResources(gameState)));
		aiWarn("------------------------------------");
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	clear(): void
	{
		for (const [, queue] of queueEntries(this.queues))
			queue.empty();
	}

	/**
	 * set accounts of queue i from the unaccounted resources
	 */
	setAccounts(gameState: CommonGameState, cost: ResourcesManager | Record<string, number>, i: PetraRuntime.QueueName): void
	{
		const available = this.getAvailableResources(gameState);
		for (const res of Resources.GetCodes())
		{
			if (this.accounts[i][res] >= cost[res])
				continue;
			this.accounts[i][res] += Math.min(available[res], cost[res] - this.accounts[i][res]);
		}
	}

	/**
	 * transfer accounts from queue i to queue j
	 */
	transferAccounts(cost: ResourcesManager | Record<string, number>, i: PetraRuntime.QueueName, j: PetraRuntime.QueueName): void
	{
		for (const res of Resources.GetCodes())
		{
			if (this.accounts[j][res] >= cost[res])
				continue;
			const diff = Math.min(this.accounts[i][res], cost[res] - this.accounts[j][res]);
			this.accounts[i][res] -= diff;
			this.accounts[j][res] += diff;
		}
	}

	/**
	 * distribute the resources between the different queues according to their priorities
	 */
	distributeResources(gameState: CommonGameState): void
	{
		const availableRes = this.getAvailableResources(gameState);
		for (const res of Resources.GetCodes())
		{
			if (availableRes[res] < 0)    // rescale the accounts if we've spent resources already accounted (e.g. by bartering)
			{
				const total = gameState.getResources()[res];
				const scale = total / (total - availableRes[res]);
				availableRes[res] = total;
				for (const j in this.queues)
				{
					this.accounts[j][res] = Math.floor(scale * this.accounts[j][res]);
					availableRes[res] -= this.accounts[j][res];
				}
			}

			if (!availableRes[res])
			{
				this.switchResource(gameState, res);
				continue;
			}

			let totalPriority = 0;
			const tempPrio: Record<string, number> = {};
			const maxNeed: Record<string, number> = {};
			// Okay so this is where it gets complicated.
			// If a queue requires "res" for the next elements (in the queue)
			// And the account is not high enough for it.
			// Then we add it to the total priority.
			// To try and be clever, we don't want a long queue to hog all resources. So two things:
			//	-if a queue has enough of resource X for the 1st element, its priority is decreased (factor 2).
			//	-queues accounts are capped at "resources for the first + 60% of the next"
			// This avoids getting a high priority queue with many elements hogging all of one resource
			// uselessly while it awaits for other resources.
			for (const [j, queue] of queueEntries(this.queues))
			{
				// returns exactly the correct amount, ie 0 if we're not go.
				const queueCost = queue.maxAccountWanted(gameState, 0.6);
				if (queue.hasQueuedUnits() && this.accounts[j][res] < queueCost[res] && !queue.paused)
				{
					// adding us to the list of queues that need an update.
					tempPrio[j] = this.priorities[j];
					maxNeed[j] = queueCost[res] - this.accounts[j][res];
					// if we have enough of that resource for our first item in the queue, diminish our priority.
					const nextPlan = queue.getNext();
					if (nextPlan && this.accounts[j][res] >= nextPlan.getCost()[res])
						tempPrio[j] /= 2;

					if (tempPrio[j])
						totalPriority += tempPrio[j];
				}
				else if (this.accounts[j][res] > queueCost[res])
				{
					availableRes[res] += this.accounts[j][res] - queueCost[res];
					this.accounts[j][res] = queueCost[res];
				}
			}
			// Now we allow resources to the accounts. We can at most allow "TempPriority/totalpriority*available"
			// But we'll sometimes allow less if that would overflow.
			let available = availableRes[res];
			let missing = false;
			for (const j in tempPrio)
			{
				// we'll add at much what can be allowed to this queue.
				let toAdd = Math.floor(availableRes[res] * tempPrio[j]/totalPriority);
				if (toAdd >= maxNeed[j])
					toAdd = maxNeed[j];
				else
					missing = true;
				this.accounts[j][res] += toAdd;
				maxNeed[j] -= toAdd;
				available -= toAdd;
			}
			if (missing && available > 0)   // distribute the rest (due to floor) in any queue
			{
				for (const j in tempPrio)
				{
					const toAdd = Math.min(maxNeed[j], available);
					this.accounts[j][res] += toAdd;
					available -= toAdd;
					if (available <= 0)
						break;
				}
			}
			if (available < 0)
				aiWarn("Petra: problem with remaining " + res + " in queueManager " + available);
		}
	}

	switchResource(gameState: CommonGameState, res: string): void
	{
		// We have no available resources, see if we can't "compact" them in one queue.
		// compare queues 2 by 2, and if one with a higher priority could be completed by our amount, give it.
		// TODO: this isn't perfect compression.
		for (const [j, queue] of queueEntries(this.queues))
		{
			if (!queue.hasQueuedUnits() || queue.paused)
				continue;

			const queueCost = queue.maxAccountWanted(gameState, 0);
			if (this.accounts[j][res] >= queueCost[res])
				continue;

			for (const [i, otherQueue] of queueEntries(this.queues))
			{
				if (i === j)
					continue;
				if (this.priorities[i] >= this.priorities[j] || otherQueue.switched !== 0)
					continue;
				if (this.accounts[j][res] + this.accounts[i][res] < queueCost[res])
					continue;

				const diff = queueCost[res] - this.accounts[j][res];
				this.accounts[j][res] += diff;
				this.accounts[i][res] -= diff;
				++otherQueue.switched;
				if (this.Config.debug > 2)
				{
					aiWarn("switching queue " + res + " from " + i + " to " + j + " in amount " +
						diff);
				}
				break;
			}
		}
	}

	// Start the next item in the queue if we can afford it.
	startNextItems(gameState: CommonGameState): void
	{
		for (const q of this.queueArrays)
		{
			const name = q[0];
			const queue = q[1];
			if (queue.hasQueuedUnits() && !queue.paused)
			{
				// the queue just said it has plans
				const item = requireValue(queue.getNext());
				if (this.accounts[name].canAfford(item.getCost()) && item.canStart(gameState))
				{
					// canStart may update the cost because of the costMultiplier so we must check it again
					if (this.accounts[name].canAfford(item.getCost()))
					{
						this.finishingTime = gameState.ai.elapsedTime;
						this.accounts[name].subtract(item.getCost());
						queue.startNext(gameState);
						queue.switched = 0;
					}
				}
			}
			else if (!queue.hasQueuedUnits())
			{
				this.accounts[name].reset();
				queue.switched = 0;
			}
		}
	}

	update(gameState: CommonGameState): void
	{
		Engine.ProfileStart("Queue Manager");

		for (const [i, queue] of queueEntries(this.queues))
		{
			queue.check(gameState);  // do basic sanity checks on the queue
			if (this.priorities[i] > 0)
				continue;
			aiWarn("QueueManager received bad priorities, please report this error: " +
				uneval(this.priorities));
			this.priorities[i] = 1;  // TODO: make the Queue Manager not die when priorities are zero.
		}

		// Pause or unpause queues depending on the situation
		this.checkPausedQueues(gameState);

		// Let's assign resources to plans that need them
		this.distributeResources(gameState);

		// Start the next item in the queue if we can afford it.
		this.startNextItems(gameState);

		if (this.Config.debug > 1 && gameState.ai.playedTurn%50 === 0)
			this.printQueues(gameState);

		Engine.ProfileStop();
	}

	// Recovery system: if short of workers after an attack, pause (and reset) some queues to favor worker training
	checkPausedQueues(gameState: CommonGameState): void
	{
		const numWorkers = gameState.countOwnEntitiesAndQueuedWithRole(Worker.ROLE_WORKER);
		const workersMin = Math.min(Math.max(12, 24 * this.Config.popScaling), this.Config.Economy.popPhase2);
		for (const [q, queue] of queueEntries(this.queues))
		{
			let toBePaused = false;
			if (!hqOf(gameState).hasPotentialBase())
				toBePaused = q !== "dock" && q !== "civilCentre";
			else if (numWorkers < workersMin / 3)
				toBePaused = q !== "citizenSoldier" && q !== "villager" && q !== "emergency";
			else if (numWorkers < workersMin * 2 / 3)
				toBePaused = q === "civilCentre" || q === "economicBuilding" ||
					q === "militaryBuilding" || q === "defenseBuilding" || q === "healer" ||
					q === "majorTech" || q === "minorTech" || q.indexOf("plan_") !== -1;
			else if (numWorkers < workersMin)
				toBePaused = q === "civilCentre" || q === "defenseBuilding" ||
					q === "majorTech" || q.indexOf("_siege") !== -1 || q.indexOf("_champ") !== -1;

			if (toBePaused)
			{
				if (q === "field" && hqOf(gameState).needFarm &&
					!gameState.getOwnStructures().filter(filters.byClass("Field")).hasEntities())
				{
					toBePaused = false;
				}
				if (q === "corral" && hqOf(gameState).needCorral &&
					!gameState.getOwnStructures().filter(filters.byClass("Field")).hasEntities())
				{
					toBePaused = false;
				}
				if (q === "dock" && hqOf(gameState).needFish &&
					!gameState.getOwnStructures().filter(filters.byClass("Dock")).hasEntities())
				{
					toBePaused = false;
				}
				if (q === "ships" && hqOf(gameState).needFish &&
					!hqOf(gameState).navalManager.ships.filter(filters.byClass("FishingBoat"))
						.hasEntities())
				{
					toBePaused = false;
				}
			}

			if (!queue.paused && toBePaused)
			{
				queue.paused = true;
				this.accounts[q].reset();
			}
			else if (queue.paused && !toBePaused)
				queue.paused = false;

			// And reduce the batch sizes of attack queues
			if (q.indexOf("plan_") !== -1 && numWorkers < workersMin && queue.plans[0])
			{
				queue.plans[0].number = 1;
				if (queue.plans[1])
					queue.plans[1].number = 1;
			}
		}
	}

	canAfford(queue: PetraRuntime.QueueName, cost: ResourcesManager | Record<string, number>): boolean
	{
		if (!this.accounts[queue])
			return false;
		return this.accounts[queue].canAfford(cost);
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseQueue(queue: PetraRuntime.QueueName, scrapAccounts: boolean): void
	{
		const held = this.queues[queue];
		if (!held)
			return;
		held.paused = true;
		if (scrapAccounts)
			this.accounts[queue].reset();
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseQueue(queue: PetraRuntime.QueueName): void
	{
		const held = this.queues[queue];
		if (held)
			held.paused = false;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseAll(scrapAccounts: boolean, but: PetraRuntime.QueueName | undefined): void
	{
		for (const [q, queue] of queueEntries(this.queues))
		{
			if (q === but)
				continue;
			if (scrapAccounts)
				this.accounts[q].reset();
			queue.paused = true;
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseAll(but: PetraRuntime.QueueName | undefined): void
	{
		for (const [q, queue] of queueEntries(this.queues))
			if (q !== but)
				queue.paused = false;
	}


	addQueue(queueName: PetraRuntime.AttackQueueName, priority: number): void
	{
		if (this.queues[queueName] !== undefined)
			return;

		this.queues[queueName] = new Queue();
		this.priorities[queueName] = priority;
		this.accounts[queueName] = new ResourcesManager();

		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}

	removeQueue(queueName: PetraRuntime.AttackQueueName): void
	{
		if (this.queues[queueName] === undefined)
			return;

		delete this.queues[queueName];
		delete this.priorities[queueName];
		delete this.accounts[queueName];

		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}

	getPriority(queueName: PetraRuntime.QueueName): number
	{
		return this.priorities[queueName];
	}

	changePriority(queueName: PetraRuntime.QueueName, newPriority: number, metadata?: Record<string, unknown>): void
	{
		if (this.Config.debug > 1)
		{
			aiWarn(">>> Priority of queue " + queueName + " changed from " + this.priorities[queueName] +
				" to " + newPriority);
		}
		if (this.queues[queueName] !== undefined)
			this.priorities[queueName] = newPriority;
		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}

	Serialize(): {
		priorities: Record<string, number>;
		queues: Record<string, ReturnType<Queue["Serialize"]>>;
		accounts: Record<string, ReturnType<ResourcesManager["Serialize"]>>;
	}
	{
		const accounts: Record<string, ReturnType<ResourcesManager["Serialize"]>> = {};
		const queues: Record<string, ReturnType<Queue["Serialize"]>> = {};
		for (const [q, queue] of queueEntries(this.queues))
		{
			queues[q] = queue.Serialize();
			accounts[q] = this.accounts[q].Serialize();
			if (this.Config.debug === -100)
			{
				aiWarn("queueManager serialization: queue " + q + " >>> " + uneval(queues[q]) +
					" with accounts " + uneval(accounts[q]));
			}
		}

		return {
			"priorities": this.priorities,
			"queues": queues,
			"accounts": accounts
		};
	}

	Deserialize(gameState: CommonGameState, data: {
		priorities: Record<string, number>;
		queues: Record<string, Parameters<Queue["Deserialize"]>[1]>;
		accounts: Record<string, Parameters<ResourcesManager["Deserialize"]>[0]>;
	}): void
	{
		this.priorities = data.priorities;
		// the configured queues, then an attack plan's, in the saved order
		this.queues = configuredQueues();
		this.accounts = {};

		// the sorting is updated on priority change.
		this.queueArrays = [];
		for (const q in data.queues)
		{
			if (!isQueueName(this.Config, q))
			{
				aiWarn("Petra deserialization error: queue unknown " + q);
				continue;
			}
			const queue = this.queues[q] ?? new Queue();
			this.queues[q] = queue;
			queue.Deserialize(gameState, data.queues[q]);
			this.accounts[q] = new ResourcesManager();
			this.accounts[q].Deserialize(data.accounts[q]);
		}
		// the sorting is updated on priority change.
		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}
}
