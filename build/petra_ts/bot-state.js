/**
 * Petra TS with a dump of its own state, for match.sh -b: the bot's decisions
 * hang on AI-side state the engine never sees (entity metadata, queues and their
 * accounts, plans, base resource lists), so the timeline cannot show it.
 *
 * prepare-bot.ts state copies this file into petra_out/_botstate.js and points
 * data.json at PetraBotState. Every two game minutes (minutes 1, 3, 5, ..., as
 * the timeline) it prints one line:
 *   BOTSTATE {"minute":..,"player":..,"hq":{..},"workers":{..},"gathering":{..},"workersByBase":{..},"idleWorkers":{..},
 *             "bases":[..],"queues":{..},"attacks":{..},"defenseArmies":..}
 * It also logs the attack plans' lives (attacks.txt with match.sh -b, one line
 * per event):
 *   ATTACKLOG {"t":..,"player":..,"event":"created"|"started"|"aborted"|"finished"|"progress",
 *              "name":..,"type":..,"age":..,..}
 * created, started, aborted (it left the upcoming plans without starting) and
 * finished (a started plan ended) as they happen, seen turn by turn; progress
 * every minute for each plan in preparation. An abort carries the plan's last
 * snapshot (the turn before it went): its units per category against the
 * minimum and the target, units queued for it and whether its queues were
 * paused, its account, the free population, workers and stock, whether it could
 * start and the build orders it had left), and its state and units as it went
 * (the attack manager updates one turn in eight, so the snapshot can be a few
 * turns old); analysed by attack-log.ts.
 * It only reads: the game is the same with it or without (same fingerprint).
 *
 * It is for reading while debugging, nothing checks it (match-checks.ts): it
 * follows the bot's internal structure, which changes with the bot. A section
 * that no longer fits it becomes {"error": "..."} in its line, so a refactor
 * cannot make the dump break the bot's turn.
 */
import { PetraBot } from "simulation/ai/petra_out/_petrabot.js";

const DUMP_FIRST = 60;
const DUMP_EVERY = 120;
/** seconds between two progress lines of a plan in preparation */
const PROGRESS_EVERY = 60;

/** The value of read(), or what went wrong reading it. */
function section(read)
{
	try
	{
		return read();
	}
	catch(e)
	{
		return { "error": String(e) };
	}
}

export class PetraBotState extends PetraBot
{
	OnUpdate(sharedScript)
	{
		super.OnUpdate(sharedScript);
		if (this.gameState?.playerData?.state != "active")
			return;
		const log = section(() => this.logAttacks());
		if (log && "error" in log)
			print("ATTACKLOG " + JSON.stringify({ "t": Math.round(this.elapsedTime), "player": PlayerID, "event": "error", ...log }) + "\n");
		this.nextStateDump ??= DUMP_FIRST;
		if (this.elapsedTime < this.nextStateDump)
			return;
		this.nextStateDump += DUMP_EVERY;
		print("BOTSTATE " + JSON.stringify(this.stateDump()) + "\n");
	}

	stateDump()
	{
		const units = section(() => this.workerState());
		return {
			"minute": Math.round(this.elapsedTime / 60),
			"player": PlayerID,
			"hq": section(() => this.hqState()),
			...("error" in units ? { "workers": units } : units),
			"bases": section(() => this.baseState()),
			"queues": section(() => this.queueState()),
			"attacks": section(() => this.attackState()),
			"defenseArmies": section(() => this.HQ.defenseManager.armies.length)
		};
	}

	hqState()
	{
		const HQ = this.HQ;
		return {
			"phase": HQ.currentPhase,
			"phasing": HQ.phasing,
			"saveResources": !!HQ.saveResources,
			"saveSpace": !!HQ.saveSpace,
			"needFarm": !!HQ.needFarm,
			"canBuildUnits": HQ.canBuildUnits,
			"targetNumWorkers": HQ.targetNumWorkers,
			"popPhase2": this.Config.Economy.popPhase2,
			// seconds since a worker last found nothing to gather, per resource
			"lastFailedGather": Object.fromEntries(Object.entries(HQ.lastFailedGather ?? {})
				.map(([type, time]) => [type, Math.round(this.gameState.ai.elapsedTime - time)]))
		};
	}

	/** Units by "role/subrole", gatherers by what they gather, workers by base. */
	workerState()
	{
		const count = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
		const workers = {};
		const gathering = {};
		const workersByBase = {};
		// what the idle workers are: class, the resource they were last given,
		// and what the engine has them do
		const idleWorkers = {};
		for (const ent of this.gameState.getOwnUnits().values())
		{
			const role = ent.getMetadata(PlayerID, "role") ?? "none";
			const subrole = ent.getMetadata(PlayerID, "subrole");
			count(workers, subrole ? role + "/" + subrole : role);
			if (role == "worker" && subrole == "idle")
				count(idleWorkers, [ent.hasClass("Support") ? "Support" : ent.hasClass("CitizenSoldier") ? "CitizenSoldier" : "other",
					ent.getMetadata(PlayerID, "gather-type") ?? "-", ent.unitAIState() ?? "-"].join(" "));
			if (subrole == "gatherer")
				count(gathering, ent.getMetadata(PlayerID, "gather-type") ?? "none");
			if (role == "worker")
				count(workersByBase[ent.getMetadata(PlayerID, "base") ?? "none"] ??= {}, subrole ?? "none");
		}
		// where our units stand: those in an enemy's territory, by role and what the engine has them do
		const inEnemyLand = {};
		const territory = this.HQ.geography?.territoryMap ?? this.HQ.territoryMap;
		for (const ent of this.gameState.getOwnUnits().values())
		{
			const pos = ent.position();
			if (!pos || !territory)
				continue;
			const owner = territory.getOwner(pos);
			if (owner == 0 || owner == PlayerID || !this.gameState.isPlayerEnemy(owner))
				continue;
			const role = ent.getMetadata(PlayerID, "role") ?? "none";
			const subrole = ent.getMetadata(PlayerID, "subrole");
			count(inEnemyLand, (subrole ? role + "/" + subrole : role) + " " + (ent.unitAIState() ?? "-").split(".").slice(1, 3).join("."));
		}
		return { workers, gathering, workersByBase, idleWorkers, inEnemyLand };
	}

	/** Each base's resource lists, by distance band, and the amount within reach. */
	baseState()
	{
		const gameState = this.gameState;
		return this.HQ.basesManager.baseManagers.map(base =>
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
				"position": anchor?.position()?.map(Math.round),
				"access": base.accessIndex,
				supplies
			};
		});
	}

	/** Queues with what is planned and what is set aside for it. */
	queueState()
	{
		const queueManager = this.queueManager;
		const queues = {};
		for (const name in queueManager.queues)
		{
			const plans = queueManager.queues[name].plans;
			const account = queueManager.accounts[name];
			const reserved = {};
			for (const type of Resources.GetCodes())
				if (account?.[type])
					reserved[type] = account[type];
			if (!plans.length && !Object.keys(reserved).length)
				continue;
			queues[name] = {
				"priority": queueManager.priorities[name],
				"plans": plans.map(plan => plan.type + (plan.number > 1 ? " x" + plan.number : "")),
				reserved
			};
		}
		return queues;
	}

	/** One line of the attack log. */
	attackLine(event, plan, detail = {})
	{
		const known = this.attackPlans.get(plan.name);
		print("ATTACKLOG " + JSON.stringify({
			"t": Math.round(this.elapsedTime), "player": PlayerID, event, "name": plan.name, "type": plan.type,
			"age": known ? Math.round(this.elapsedTime - known.created) : 0, ...detail
		}) + "\n");
	}

	/** What a plan in preparation has, lacks and waits on. */
	attackSnapshot(plan)
	{
		const gameState = this.gameState;
		const cats = {};
		for (const cat in plan.unitStat)
			cats[cat] = [plan.unit[cat]?.length ?? 0, plan.unitStat[cat].minSize, plan.unitStat[cat].targetSize];
		const queues = [plan.queue, plan.queueChamp, plan.queueSiege].filter(Boolean);
		const account = this.queueManager.accounts["plan_" + plan.name];
		const resources = gameState.getResources();
		return {
			"state": plan.state,
			"units": plan.unitCollection.length,
			cats,
			"queued": queues.reduce((n, q) => n + q.countQueuedUnits(), 0),
			"paused": queues.some(q => q.paused),
			"account": account ? Object.fromEntries(Object.entries(account.Serialize().amounts).map(([k, v]) => [k, Math.round(v)])) : undefined,
			"canStart": plan.canStart(),
			"buildOrders": plan.buildOrders?.length ?? 0,
			"pop": gameState.getPopulation(),
			"popMax": gameState.getPopulationMax(),
			"workers": gameState.getOwnEntitiesByRole("worker", true).length,
			"stock": { "food": Math.round(resources.food), "wood": Math.round(resources.wood),
				"stone": Math.round(resources.stone), "metal": Math.round(resources.metal) }
		};
	}

	/** Compares the attack plans with the last turn's and logs what changed. */
	logAttacks()
	{
		const attackManager = this.HQ?.attackManager;
		if (!attackManager)
			return undefined;
		this.attackPlans ??= new Map();
		const upcoming = new Map();
		const started = new Map();
		for (const type in attackManager.upcomingAttacks)
			for (const plan of attackManager.upcomingAttacks[type])
				upcoming.set(plan.name, plan);
		for (const type in attackManager.startedAttacks)
			for (const plan of attackManager.startedAttacks[type])
				started.set(plan.name, plan);
		for (const [name, known] of this.attackPlans)
		{
			if (known.started)
			{
				if (!started.has(name))
				{
					this.attackLine("finished", known.plan, { "units": known.plan.unitCollection.length,
						"atStart": known.atStart, "inField": Math.round(this.elapsedTime - known.started) });
					this.attackPlans.delete(name);
				}
				continue;
			}
			if (upcoming.has(name))
				continue;
			if (started.has(name))
			{
				known.started = this.elapsedTime;
				known.atStart = known.plan.unitCollection.length;
				this.attackLine("started", known.plan, { "units": known.atStart });
			}
			else
			{
				// the plan as it left: aborted in "completing", it found no target to start on
				this.attackLine("aborted", known.plan, { "last": known.last,
					"stateAtEnd": known.plan.state, "unitsAtEnd": known.plan.unitCollection.length });
				this.attackPlans.delete(name);
			}
		}
		for (const [name, plan] of upcoming)
		{
			let known = this.attackPlans.get(name);
			if (!known)
			{
				known = { plan, "created": this.elapsedTime, "lastProgress": this.elapsedTime };
				this.attackPlans.set(name, known);
				this.attackLine("created", plan, this.attackSnapshot(plan));
			}
			known.last = this.attackSnapshot(plan);
			if (this.elapsedTime - known.lastProgress >= PROGRESS_EVERY)
			{
				known.lastProgress = this.elapsedTime;
				this.attackLine("progress", plan, known.last);
			}
		}
		return undefined;
	}

	attackState()
	{
		const attackManager = this.HQ.attackManager;
		const attacks = {};
		for (const [state, lists] of [["upcoming", attackManager.upcomingAttacks], ["started", attackManager.startedAttacks]])
			for (const type in lists)
				for (const plan of lists[type])
					(attacks[state] ??= []).push({
						"name": plan.name,
						type,
						"state": plan.state,
						"target": plan.targetPlayer,
						"units": plan.unitCollection.length,
						...(state == "started" ? this.startedDetail(plan) : {})
					});
		return attacks;
	}

	/** Where a started attack is and what its units do. */
	startedDetail(plan)
	{
		const states = {};
		const holders = {};
		for (const ent of plan.unitCollection.values())
		{
			const key = (ent.position() ? "" : "inside:") + (ent.unitAIState() ?? "-");
			states[key] = (states[key] ?? 0) + 1;
			const holderId = ent.position() ? undefined : ent.garrisonHolderID();
			const holder = holderId === undefined ? undefined : this.gameState.getEntityById(holderId);
			if (holderId !== undefined)
			{
				const name = (holder ? holder.templateName() + " (" + holder.owner() + ")" : "gone " + holderId) +
					" plan " + ent.getMetadata(PlayerID, "plan") + " type " + ent.getMetadata(PlayerID, "garrisonType") +
					" subrole " + ent.getMetadata(PlayerID, "subrole");
				holders[name] = (holders[name] ?? 0) + 1;
			}
		}
		return {
			"paused": plan.paused, "position": plan.position?.map(Math.round),
			"targetEntity": plan.target ? plan.target.templateName() + "@" + plan.target.position()?.map(Math.round) : undefined,
			"targetPos": plan.targetPos?.map(Math.round),
			"unitStates": states,
			"holders": holders
		};
	}
}
