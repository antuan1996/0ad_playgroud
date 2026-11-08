import * as filters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { debugWarn } from "../adapter/debug.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import type { Config } from "../world/config.ts";
import { hqOf } from "./hq.ts";
import { Queue, type SerializedQueue } from "./queue.ts";
import { gatherDemand as queueGatherDemand, wantedGatherRates as queueWantedGatherRates } from "./queueDemand.ts";
import { Worker } from "./worker.ts";

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
function sortedQueues(
	queues: PetraRuntime.QueueCollection,
	priorities: PetraRuntime.Dict<number>,
): Array<[PetraRuntime.QueueName, Queue]>
{
	return [...queueEntries(queues)].sort(([a]: [string, Queue], [b]: [string, Queue]): number =>
	{
		const priorityDifference = priorities[b] - priorities[a];
		if (priorityDifference !== 0)
		{
			return priorityDifference;
		}
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
		villager: new Queue(),
		citizenSoldier: new Queue(),
		trader: new Queue(),
		healer: new Queue(),
		ships: new Queue(),
		house: new Queue(),
		dropsites: new Queue(),
		field: new Queue(),
		dock: new Queue(),
		corral: new Queue(),
		economicBuilding: new Queue(),
		militaryBuilding: new Queue(),
		defenseBuilding: new Queue(),
		civilCentre: new Queue(),
		majorTech: new Queue(),
		minorTech: new Queue(),
		wonder: new Queue(),
		emergency: new Queue(),
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
		{
			continue;
		}
		const queue = queues[name];
		if (queue)
		{
			yield [name, queue];
		}
	}
}

/** The queues that want more of one resource: their priority now, and how much they still want. */
type QueueNeeds = { totalPriority: number; tempPrio: Record<string, number>; maxNeed: Record<string, number>; };

/** What the queue manager saves */
export type SerializedQueueManager = {
	priorities: Record<string, number>;
	queues: Record<string, SerializedQueue>;
	accounts: Record<string, Parameters<ResourcesManager["Deserialize"]>[0]>;
};

/** The queues that go on without a base to build in. */
const RUN_WITHOUT_BASE: ReadonlySet<string> = new Set(["dock", "civilCentre"]);
/** The queues that go on with under a third of the workers wanted. */
const RUN_WITH_VERY_FEW_WORKERS: ReadonlySet<string> = new Set(["citizenSoldier", "villager", "emergency"]);
/** The queues (besides the attacks') that wait with under two thirds of the workers wanted. */
const WAIT_WITH_FEW_WORKERS: ReadonlySet<string> = new Set([
	"civilCentre",
	"economicBuilding",
	"militaryBuilding",
	"defenseBuilding",
	"healer",
	"majorTech",
	"minorTech",
]);
/** The queues (besides champions and siege) that wait short of the workers wanted. */
const WAIT_SHORT_OF_WORKERS: ReadonlySet<string> = new Set(["civilCentre", "defenseBuilding", "majorTech"]);

/** Whether queue q waits while we are short of workers: the fewer, the more queues wait. */
function pausedForWorkers(
	gameState: CommonGameState,
	q: PetraRuntime.QueueName,
	numWorkers: number,
	workersMin: number,
): boolean
{
	if (!gameState.ai.bases.hasPotentialBase())
	{
		return !RUN_WITHOUT_BASE.has(q);
	}
	if (numWorkers < workersMin / 3)
	{
		return !RUN_WITH_VERY_FEW_WORKERS.has(q);
	}
	if (numWorkers < workersMin * 2 / 3)
	{
		return WAIT_WITH_FEW_WORKERS.has(q) || q.indexOf("plan_") !== -1;
	}
	if (numWorkers < workersMin)
	{
		return WAIT_SHORT_OF_WORKERS.has(q) || q.indexOf("_siege") !== -1 || q.indexOf("_champ") !== -1;
	}
	return false;
}

/** The first field, corral, dock or fishing boat of a town that needs it never waits. */
function feedsTheTown(gameState: CommonGameState, q: PetraRuntime.QueueName): boolean
{
	const hq = hqOf(gameState);
	const hasNone = (className: string): boolean =>
		!gameState.getOwnStructures().filter(filters.byClass(className)).hasEntities();
	if (q === "field")
	{
		return hq.needFarm && hasNone("Field");
	}
	if (q === "corral")
	{
		return hq.needCorral && hasNone("Field");
	}
	if (q === "dock")
	{
		return hq.needFish && hasNone("Dock");
	}
	if (q === "ships")
	{
		return hq.needFish && !gameState.ai.naval.ships.filter(filters.byClass("FishingBoat")).hasEntities();
	}
	return false;
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
		{
			this.priorities[name] = priority;
		}
		this.accounts = {};
		for (const q in this.queues)
		{
			this.accounts[q] = new ResourcesManager();
		}

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
		{
			resources.subtract(this.accounts[key]);
		}
		return resources;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	getTotalAccountedResources(): ResourcesManager
	{
		const resources = new ResourcesManager();
		for (const key in this.queues)
		{
			resources.add(this.accounts[key]);
		}
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
			{
				continue;
			}
			const costs = queue.plans[0].getCost();
			needed.add(costs);
		}
		// get out current resources, not removing accounts.
		const current = gameState.getResources();
		for (const res of Resources.GetCodes())
		{
			needed[res] = Math.max(0, needed[res] - current[res]);
		}

		return needed;
	}

	/**
	 * What the gatherers are wanted for, in two parts (decision/gatherSplit.ts):
	 * `costs`, the rates that pay for what is queued over the horizons of
	 * wantedGatherRates, the stock spent on them first; and `floors`, the rate
	 * that brings what stock is left up to the config's short-queue amounts
	 * (Config.queues.short: a reserve, not a purchase) within 30 s. On the first
	 * turn, before any queue is set, the config's first-turn rates are costs.
	 * TODO never called since the gatherer split was dropped (FINDINGS §19):
	 * for the decisions of stage 5 that weigh queued costs.
	 */
	gatherDemand(gameState: CommonGameState): { costs: Record<string, number>; floors: Record<string, number>; }
	{
		return queueGatherDemand(gameState, this.Config, this.queueArrays);
	}

	// calculate the gather rates we'd want to be able to start all elements in our queues
	// TODO: many things.
	wantedGatherRates(gameState: CommonGameState): PetraRuntime.Dict<number>
	{
		return queueWantedGatherRates(gameState, this.Config, this.queueArrays);
	}

	printQueues(gameState: CommonGameState): void
	{
		let numWorkers = 0;
		gameState.getOwnUnits().forEach((ent) =>
		{
			if (
				ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER &&
				ent.getMetadata(PlayerID, "plan") === undefined
			)
			{
				numWorkers++;
			}
		});
		aiWarn("---------- QUEUES ------------ with pop " + gameState.getPopulation() + " and workers " + numWorkers);
		for (const [i, q] of queueEntries(this.queues))
		{
			if (q.hasQueuedUnits())
			{
				aiWarn(
					i + ": ( with priority " + this.priorities[i] + " and accounts " + uneval(this.accounts[i]) + ")",
				);
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
		{
			aiWarn(p + ": " + uneval(this.accounts[p]));
		}
		aiWarn("Current Resources: " + uneval(gameState.getResources()));
		aiWarn("Available Resources: " + uneval(this.getAvailableResources(gameState)));
		aiWarn("Wanted Gather Rates: " + uneval(hqOf(gameState).GetWantedGatherRates(gameState)));
		aiWarn("Current Gather Rates: " + uneval(gameState.ai.bases.GetCurrentGatherRates(gameState)));
		aiWarn("Most needed resources: " + uneval(hqOf(gameState).pickMostNeededResources(gameState)));
		aiWarn("------------------------------------");
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	clear(): void
	{
		for (const [, queue] of queueEntries(this.queues))
		{
			queue.empty();
		}
	}

	/**
	 * set accounts of queue i from the unaccounted resources
	 */
	setAccounts(
		gameState: CommonGameState,
		cost: ResourcesManager | Record<string, number>,
		i: PetraRuntime.QueueName,
	): void
	{
		const available = this.getAvailableResources(gameState);
		for (const res of Resources.GetCodes())
		{
			if (this.accounts[i][res] >= cost[res])
			{
				continue;
			}
			this.accounts[i][res] += Math.min(available[res], cost[res] - this.accounts[i][res]);
		}
	}

	/**
	 * transfer accounts from queue i to queue j
	 */
	transferAccounts(
		cost: ResourcesManager | Record<string, number>,
		i: PetraRuntime.QueueName,
		j: PetraRuntime.QueueName,
	): void
	{
		for (const res of Resources.GetCodes())
		{
			if (this.accounts[j][res] >= cost[res])
			{
				continue;
			}
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
			if (availableRes[res] < 0)
			{ // rescale the accounts if we've spent resources already accounted (e.g. by bartering)
				this.rescaleAccounts(gameState, res, availableRes);
			}

			if (!availableRes[res])
			{
				this.switchResource(gameState, res);
				continue;
			}
			const needs = this.queueNeeds(gameState, res, availableRes);
			this.allot(res, availableRes[res], needs);
		}
	}

	/** Scales every account of `res` down to what we really hold, the rest left available. */
	private rescaleAccounts(gameState: CommonGameState, res: string, availableRes: ResourcesManager): void
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

	/**
	 * The queues wanting more of `res`, by priority, and how much more.
	 * Okay so this is where it gets complicated.
	 * If a queue requires "res" for the next elements (in the queue)
	 * And the account is not high enough for it.
	 * Then we add it to the total priority.
	 * To try and be clever, we don't want a long queue to hog all resources. So two things:
	 * 	-if a queue has enough of resource X for the 1st element, its priority is decreased (factor 2).
	 * 	-queues accounts are capped at "resources for the first + 60% of the next"
	 * This avoids getting a high priority queue with many elements hogging all of one resource
	 * uselessly while it awaits for other resources. An account over its cap gives the rest back.
	 */
	private queueNeeds(gameState: CommonGameState, res: string, availableRes: ResourcesManager): QueueNeeds
	{
		const needs: QueueNeeds = { totalPriority: 0, tempPrio: {}, maxNeed: {} };
		for (const [j, queue] of queueEntries(this.queues))
		{
			// returns exactly the correct amount, ie 0 if we're not go.
			const queueCost = queue.maxAccountWanted(gameState, 0.6);
			if (queue.hasQueuedUnits() && this.accounts[j][res] < queueCost[res] && !queue.paused)
			{
				// adding us to the list of queues that need an update.
				needs.tempPrio[j] = this.priorities[j];
				needs.maxNeed[j] = queueCost[res] - this.accounts[j][res];
				// if we have enough of that resource for our first item in the queue, diminish our priority.
				const nextPlan = queue.getNext();
				if (nextPlan && this.accounts[j][res] >= nextPlan.getCost()[res])
				{
					needs.tempPrio[j] /= 2;
				}

				if (needs.tempPrio[j])
				{
					needs.totalPriority += needs.tempPrio[j];
				}
			}
			else if (this.accounts[j][res] > queueCost[res])
			{
				availableRes[res] += this.accounts[j][res] - queueCost[res];
				this.accounts[j][res] = queueCost[res];
			}
		}
		return needs;
	}

	/**
	 * Gives the queues in need their share of `availableRes`: at most
	 * tempPrio / totalPriority of it, less if that would overflow their need;
	 * what flooring leaves goes to any queue still short.
	 */
	private allot(res: string, availableRes: number, needs: QueueNeeds): void
	{
		const { totalPriority, tempPrio, maxNeed } = needs;
		let available = availableRes;
		let missing = false;
		for (const j in tempPrio)
		{
			// we'll add at much what can be allowed to this queue.
			let toAdd = Math.floor(availableRes * tempPrio[j] / totalPriority);
			if (toAdd >= maxNeed[j])
			{
				toAdd = maxNeed[j];
			}
			else
			{
				missing = true;
			}
			this.accounts[j][res] += toAdd;
			maxNeed[j] -= toAdd;
			available -= toAdd;
		}
		if (missing && available > 0)
		{ // distribute the rest (due to floor) in any queue
			for (const j in tempPrio)
			{
				const toAdd = Math.min(maxNeed[j], available);
				this.accounts[j][res] += toAdd;
				available -= toAdd;
				if (available <= 0)
				{
					break;
				}
			}
		}
		if (available < 0)
		{
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
			{
				continue;
			}

			const queueCost = queue.maxAccountWanted(gameState, 0);
			if (this.accounts[j][res] >= queueCost[res])
			{
				continue;
			}

			for (const [i, otherQueue] of queueEntries(this.queues))
			{
				if (i === j)
				{
					continue;
				}
				if (this.priorities[i] >= this.priorities[j] || otherQueue.switched !== 0)
				{
					continue;
				}
				if (this.accounts[j][res] + this.accounts[i][res] < queueCost[res])
				{
					continue;
				}

				const diff = queueCost[res] - this.accounts[j][res];
				this.accounts[j][res] += diff;
				this.accounts[i][res] -= diff;
				++otherQueue.switched;
				debugWarn(
					this.Config,
					2,
					() => "switching queue " + res + " from " + i + " to " + j + " in amount " + diff,
				);
				break;
			}
		}
	}

	/**
	 * Pay for the first plan of the highest-priority queue that can be paid in
	 * full from the resources no queue holds and the accounts of the queues of
	 * lower priority. distributeResources splits each resource between all the
	 * queues that want it, so that often none can start: 424 food in stock and
	 * the women's, the soldiers' and an attack's queues holding 105, 117 and
	 * 182 of the 150, 150 and 200 they need (FINDINGS §24); switchResource
	 * gathers them only when not a unit of the resource is left unbooked.
	 */
	completeBestPlan(gameState: CommonGameState): void
	{
		const codes = Resources.GetCodes();
		const free = this.getAvailableResources(gameState);
		for (let k = 0; k < this.queueArrays.length; ++k)
		{
			const [name, queue] = this.queueArrays[k];
			if (!queue.hasQueuedUnits() || queue.paused)
			{
				continue;
			}
			const plan = requireValue(queue.getNext());
			if (!plan.isGo(gameState))
			{
				continue;
			}
			const cost = plan.getCost();
			const account = this.accounts[name];
			if (account.canAfford(cost))
			{
				return;
			}
			// the queues below this one, the lowest first
			const donors = this.queueArrays.slice(k + 1).filter(([j]) => this.priorities[j] < this.priorities[name])
				.reverse();
			if (
				!codes.every((res) =>
					cost[res] - account[res] <=
						Math.max(0, free[res]) + donors.reduce((sum, [j]) => sum + this.accounts[j][res], 0)
				)
			)
			{
				continue;
			}
			for (const res of codes)
			{
				let short = cost[res] - account[res];
				if (short <= 0)
				{
					continue;
				}
				const fromFree = Math.min(short, Math.max(0, free[res]));
				account[res] += fromFree;
				short -= fromFree;
				for (const [j] of donors)
				{
					if (short <= 0)
					{
						break;
					}
					const taken = Math.min(short, this.accounts[j][res]);
					this.accounts[j][res] -= taken;
					account[res] += taken;
					short -= taken;
				}
			}
			return;
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
				const start = this.accounts[name].canAfford(item.getCost()) ? item.canStart(gameState) : undefined;
				// canStart may update the cost because of the costMultiplier so we must check it again
				if (start && this.accounts[name].canAfford(item.getCost()))
				{
					this.finishingTime = gameState.ai.elapsedTime;
					this.accounts[name].subtract(item.getCost());
					queue.startNext(start);
					queue.switched = 0;
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
			queue.check(gameState); // do basic sanity checks on the queue
			if (this.priorities[i] > 0)
			{
				continue;
			}
			aiWarn("QueueManager received bad priorities, please report this error: " + uneval(this.priorities));
			this.priorities[i] = 1; // TODO: make the Queue Manager not die when priorities are zero.
		}

		// Pause or unpause queues depending on the situation
		this.checkPausedQueues(gameState);

		// Let's assign resources to plans that need them
		this.distributeResources(gameState);
		this.completeBestPlan(gameState);

		// Start the next item in the queue if we can afford it.
		this.startNextItems(gameState);

		if (this.Config.debug > 1 && gameState.ai.playedTurn % 50 === 0)
		{
			this.printQueues(gameState);
		}

		Engine.ProfileStop();
	}

	// Recovery system: if short of workers after an attack, pause (and reset) some queues to favor worker training
	checkPausedQueues(gameState: CommonGameState): void
	{
		const numWorkers = gameState.countOwnEntitiesAndQueuedWithRole(Worker.ROLE_WORKER);
		const workersMin = Math.min(Math.max(12, 24 * this.Config.popScaling), this.Config.Economy.popPhase2);
		for (const [q, queue] of queueEntries(this.queues))
		{
			const toBePaused = pausedForWorkers(gameState, q, numWorkers, workersMin) && !feedsTheTown(gameState, q);
			if (!queue.paused && toBePaused)
			{
				queue.paused = true;
				this.accounts[q].reset();
			}
			else if (queue.paused && !toBePaused)
			{
				queue.paused = false;
			}

			// And reduce the batch sizes of attack queues
			if (q.indexOf("plan_") !== -1 && numWorkers < workersMin && queue.plans[0])
			{
				queue.plans[0].number = 1;
				if (queue.plans[1])
				{
					queue.plans[1].number = 1;
				}
			}
		}
	}

	canAfford(queue: PetraRuntime.QueueName, cost: ResourcesManager | Record<string, number>): boolean
	{
		if (!this.accounts[queue])
		{
			return false;
		}
		return this.accounts[queue].canAfford(cost);
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseQueue(queue: PetraRuntime.QueueName, scrapAccounts: boolean): void
	{
		const held = this.queues[queue];
		if (!held)
		{
			return;
		}
		held.paused = true;
		if (scrapAccounts)
		{
			this.accounts[queue].reset();
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseQueue(queue: PetraRuntime.QueueName): void
	{
		const held = this.queues[queue];
		if (held)
		{
			held.paused = false;
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	pauseAll(scrapAccounts: boolean, but: PetraRuntime.QueueName | undefined): void
	{
		for (const [q, queue] of queueEntries(this.queues))
		{
			if (q === but)
			{
				continue;
			}
			if (scrapAccounts)
			{
				this.accounts[q].reset();
			}
			queue.paused = true;
		}
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	unpauseAll(but: PetraRuntime.QueueName | undefined): void
	{
		for (const [q, queue] of queueEntries(this.queues))
		{
			if (q !== but)
			{
				queue.paused = false;
			}
		}
	}

	/** An attack plan's queue at this priority, made unless it exists (then it keeps its priority) */
	addQueue(queueName: PetraRuntime.AttackQueueName, priority: number): Queue
	{
		const existing = this.queues[queueName];
		if (existing !== undefined)
		{
			return existing;
		}

		const queue = new Queue();
		this.queues[queueName] = queue;
		this.priorities[queueName] = priority;
		this.accounts[queueName] = new ResourcesManager();

		this.queueArrays = sortedQueues(this.queues, this.priorities);
		return queue;
	}

	removeQueue(queueName: PetraRuntime.AttackQueueName): void
	{
		if (this.queues[queueName] === undefined)
		{
			return;
		}

		delete this.queues[queueName];
		delete this.priorities[queueName];
		delete this.accounts[queueName];

		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}

	getPriority(queueName: PetraRuntime.QueueName): number
	{
		return this.priorities[queueName];
	}

	changePriority(queueName: PetraRuntime.QueueName, newPriority: number): void
	{
		debugWarn(
			this.Config,
			1,
			() =>
				">>> Priority of queue " + queueName + " changed from " + this.priorities[queueName] +
				" to " + newPriority,
		);
		if (this.queues[queueName] !== undefined)
		{
			this.priorities[queueName] = newPriority;
		}
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
				aiWarn(
					"queueManager serialization: queue " + q + " >>> " + uneval(queues[q]) +
						" with accounts " + uneval(accounts[q]),
				);
			}
		}

		return { priorities: this.priorities, queues: queues, accounts: accounts };
	}

	/** A saved queue manager: its priorities, its queues with their plans, and their accounts */
	static restore(Config: Config, gameState: CommonGameState, data: SerializedQueueManager): QueueManager
	{
		const manager = new QueueManager(Config, configuredQueues());
		manager.resume(gameState, data);
		return manager;
	}

	private resume(gameState: CommonGameState, data: SerializedQueueManager): void
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
			this.queues[q] = Queue.restore(gameState, data.queues[q]);
			this.accounts[q] = new ResourcesManager();
			this.accounts[q].Deserialize(data.accounts[q]);
		}
		// the sorting is updated on priority change.
		this.queueArrays = sortedQueues(this.queues, this.priorities);
	}
}
