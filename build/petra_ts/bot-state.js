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
 * And its economy every 30 game seconds, at the times the replay samples its
 * statistics (economy.txt with match.sh -b):
 *   ECONLOG {"t":..,"player":..,"estimate":{..},"wanted":{..},"order":[..],"gatherers":{..},
 *            "states":{..},"rawRate":{..},"tripDist":{..},"stock":{..},"workers":..,"pop":..[,"layout":[..]]}
 * per resource: the bot's estimate of its gather rate (GetCurrentGatherRates),
 * the rate its queues want (wantedGatherRates), the order pickMostNeededResources
 * gives them, the gatherers on it (food: gatherers, hunters, fishers), what they
 * do (gathering, walking to the supply, carrying back, other), the sum of the
 * gather rates of those gathering (read from their orders, see gatherRate: the
 * bot's estimate reads 0 for them), the food by source (fruit, grain, meat,
 * fish: gatherers, those gathering, their rate, the median trip from the supply
 * to our nearest food dropsite), and the median distance from their supply to its
 * dropsite (from the bases' supply lists); the first line also has each base's
 * supply lists (count, amount and median distance per band), the start's layout.
 * economy-log.ts reads it with the replay's 30 s statistics (what was really
 * gathered).
 * And the defense armies' lives (defense.txt with match.sh -b, one line per
 * event: created, progress every 30 s, ended with its dead and killed):
 *   DEFENSELOG {"t":..,"player":..,"event":..,"army":..,"type":..,"age":..,..}
 * And a probe of the common API at game minutes 6 and 20 (apiprobe.txt with
 * match.sh -b, one line per call, probe and player):
 *   APIPROBE {"t":..,"player":..,"call":"<kind> <method>(<args>)","n":..,"undefined":..,"nan":..,..,"values":[..]}
 * every read-only method of Entity and Template, called on up to three
 * entities of each template (own, gaia, enemy) and on our trainable and
 * buildable templates, with each argument it takes, and per call what came
 * back: how often undefined, null, NaN (or NaN inside), 0, false, empty, thrown,
 * and a few distinct values. An accessor that reads what the engine no longer
 * provides shows as always undefined, 0 or NaN (the order data's change,
 * FINDINGS §18, would have shown as currentGatherRate always 0).
 * It only reads: the game is the same with it or without (same fingerprint).
 *
 * It is for reading while debugging, nothing checks it (match-checks.ts): it
 * follows the bot's internal structure, which changes with the bot. A section
 * that no longer fits it becomes {"error": "..."} in its line, so a refactor
 * cannot make the dump break the bot's turn.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { VectorDistance } from "simulation/ai/common-api/utils.js";
import { PetraBot } from "simulation/ai/petra_out/_petrabot.js";

const DUMP_FIRST = 60;
const DUMP_EVERY = 120;
/** seconds between two progress lines of a plan in preparation */
const PROGRESS_EVERY = 60;
/** seconds between two economy lines: the replay's statistics are sampled as often */
const ECONOMY_EVERY = 30;
/** game seconds at which the common API is probed (apiProbe) */
const API_PROBE_AT = [360, 1200];
/** entity methods that send a command or write metadata: the probe never calls them */
const API_PROBE_SKIP = new Set(["constructor", "get", "queryInterface", "hasClass", "hasClasses",
	"getMetadata", "setMetadata", "deleteMetadata", "deleteAllMetadata",
	"attack", "attackMove", "barter", "collectTreasure", "construct", "destroy", "flee", "garrison", "gather",
	"guard", "move", "moveApart", "moveToRange", "removeGuard", "repair", "research", "returnResources",
	"setRallyPoint", "setStance", "stopAllProduction", "stopMoving", "stopProduction", "tradeRoute", "train",
	"unload", "unloadAll", "unsetRallyPoint"]);

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
		const defense = section(() => this.logDefense());
		if (defense && "error" in defense)
			print("DEFENSELOG " + JSON.stringify({ "t": Math.round(this.elapsedTime), "player": PlayerID, "event": "error", ...defense }) + "\n");
		this.nextEconomyLine ??= ECONOMY_EVERY;
		if (this.elapsedTime >= this.nextEconomyLine)
		{
			this.nextEconomyLine += ECONOMY_EVERY;
			const economy = section(() => this.economyLine());
			print("ECONLOG " + JSON.stringify({ "t": Math.round(this.elapsedTime), "player": PlayerID, ...economy }) + "\n");
		}
		this.nextApiProbe ??= 0;
		if (this.nextApiProbe < API_PROBE_AT.length && this.elapsedTime >= API_PROBE_AT[this.nextApiProbe])
		{
			++this.nextApiProbe;
			// one line per accessor: the engine's print drops a line of tens of kilobytes
			const result = section(() => this.apiProbe());
			const head = { "t": Math.round(this.elapsedTime), "player": PlayerID };
			if ("error" in result)
				print("APIPROBE " + JSON.stringify({ ...head, ...result }) + "\n");
			else
				for (const key in result.probe)
					print("APIPROBE " + JSON.stringify({ ...head, "call": key, ...result.probe[key] }) + "\n");
		}
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

	/**
	 * What the bot believes about its gathering and what its gatherers do. The
	 * rate estimates are cached per turn by the bot, and the caches live until
	 * the headquarters' next update: one turn in eight. Reading them here must
	 * not fill a cache a later turn would use, so each is left as it was found.
	 */
	economyLine()
	{
		const gameState = this.gameState;
		const HQ = this.HQ;
		const basesManager = HQ.basesManager;
		const codes = Resources.GetCodes();
		const hadCurrent = "currentRates" in basesManager.turnCache;
		const current = basesManager.turnCache.currentRates;
		const hadWanted = "wantedRates" in HQ.turnCache;
		const wanted = HQ.turnCache.wantedRates;
		let estimate, wantedRates, order;
		try
		{
			estimate = { ...HQ.GetCurrentGatherRates(gameState) };
			wantedRates = { ...HQ.GetWantedGatherRates(gameState) };
			order = HQ.pickMostNeededResources(gameState).map(need => need.type);
		}
		finally
		{
			if (hadCurrent)
				basesManager.turnCache.currentRates = current;
			else
				delete basesManager.turnCache.currentRates;
			if (hadWanted)
				HQ.turnCache.wantedRates = wanted;
			else
				delete HQ.turnCache.wantedRates;
		}
		const round = (record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, Math.round(v * 100) / 100]));

		// the distance of each listed supply to its dropsite
		const tripOf = new Map();
		for (const base of basesManager.baseManagers)
			for (const type in base.dropsiteSupplies)
				for (const band of ["nearby", "medium", "faraway"])
					for (const supply of base.dropsiteSupplies[type][band])
						if (!tripOf.has(supply.id) || tripOf.get(supply.id) > supply.dist)
							tripOf.set(supply.id, supply.dist);

		const gatherers = {};
		const states = {};
		const rawRate = {};
		const trips = {};
		for (const res of codes)
		{
			states[res] = { "gathering": 0, "approaching": 0, "returning": 0, "other": 0 };
			rawRate[res] = 0;
			trips[res] = [];
		}
		gatherers.food = { "gatherer": 0, "hunter": 0, "fisher": 0 };
		// food by where it comes from: the supply its gatherers' orders name
		// (fruit, grain, meat, fish; "none" without one), and the trip from that
		// supply to the nearest built dropsite of ours that takes food
		const foodDropsites = gameState.getOwnStructures().filter(filters.isBuilt()).toEntityArray()
			.filter(drop => drop.resourceDropsiteTypes()?.includes("food") && drop.position());
		const foodSources = {};
		for (const ent of gameState.getOwnEntitiesByRole("worker", true).values())
		{
			const subrole = ent.getMetadata(PlayerID, "subrole");
			let res;
			if (subrole == "gatherer")
				res = ent.getMetadata(PlayerID, "gather-type");
			else if (subrole == "hunter" || subrole == "fisher")
				res = "food";
			if (!res || !(res in states))
				continue;
			if (res == "food")
				++gatherers.food[subrole];
			else
				gatherers[res] = (gatherers[res] ?? 0) + 1;
			const state = ent.unitAIState() ?? "";
			const kind = state.endsWith("GATHER.GATHERING") ? "gathering" :
				state.includes("RETURNINGRESOURCE") ? "returning" :
					state.includes("GATHER.APPROACHING") || state.includes("GATHER.FINDINGNEWTARGET") ? "approaching" : "other";
			++states[res][kind];
			if (kind == "gathering" && ent.position())
				rawRate[res] += this.gatherRate(ent);
			const supply = ent.getMetadata(PlayerID, "supply");
			if (supply !== undefined && tripOf.has(supply))
				trips[res].push(Math.sqrt(tripOf.get(supply)));
			if (res == "food")
			{
				const data = ent.unitAIOrderData().map(order => order.data).filter(Boolean);
				const target = data[0]?.target ?? data[1]?.target;
				let source = target === undefined ? undefined : gameState.getEntityById(target);
				if (source && !source.resourceSupplyType())
				{
					// carrying back to a dropsite: the supply is the next order's
					const next = data[1]?.target;
					source = next === undefined ? undefined : gameState.getEntityById(next);
				}
				const specific = source?.resourceSupplyType()?.specific ?? "none";
				const entry = foodSources[specific] ??= { "gatherers": 0, "gathering": 0, "rate": 0, "trips": [] };
				++entry.gatherers;
				if (specific == "none")
				{
					// what the gatherers with no supply do: their state and orders
					const what = (state.split(".").slice(1).join(".") || "-") + " [" +
						ent.unitAIOrderData().map(order => order.type).join(",") + "] " + subrole +
						(ent.isIdle() ? " idle" : "");
					(entry.doing ??= {})[what] = (entry.doing[what] ?? 0) + 1;
				}
				if (kind == "gathering")
				{
					++entry.gathering;
					entry.rate += this.gatherRate(ent);
				}
				const at = source?.position();
				if (at && foodDropsites.length)
					entry.trips.push(Math.min(...foodDropsites.map(drop => VectorDistance(at, drop.position()))));
			}
		}
		const median = (values) =>
		{
			if (!values.length)
				return undefined;
			const sorted = [...values].sort((a, b) => a - b);
			return Math.round(sorted[Math.floor(sorted.length / 2)]);
		};
		const resources = gameState.getResources();
		const line = {
			"estimate": round(estimate),
			"wanted": round(wantedRates),
			order,
			gatherers,
			states,
			"rawRate": round(rawRate),
			"tripDist": Object.fromEntries(codes.map(res => [res, median(trips[res])])),
			"foodSources": Object.fromEntries(Object.entries(foodSources).map(([source, entry]) => [source,
				{ "gatherers": entry.gatherers, "gathering": entry.gathering, "rate": round({ "r": entry.rate }).r,
					"trip": median(entry.trips), ...(entry.doing ? { "doing": entry.doing } : {}) }])),
			"stock": Object.fromEntries(codes.map(res => [res, Math.round(resources[res])])),
			"workers": gameState.getOwnEntitiesByRole("worker", true).length,
			"pop": gameState.getPopulation(),
			"fronts": section(() => this.fronts())
		};
		if (!this.loggedLayout)
		{
			this.loggedLayout = true;
			line.layout = section(() => this.layout());
		}
		return line;
	}

	/**
	 * The rate a unit gathers at while gathering: what Entity.currentGatherRate
	 * computes, but read from the order's data. Since the engine's commit
	 * 4b516b336e unitAIOrderData() returns the orders ({type, data}), not their
	 * data, so currentGatherRate finds no target and returns 0 (FINDINGS §18).
	 */
	gatherRate(ent)
	{
		const target = ent.unitAIOrderData()[0]?.data?.target;
		const supply = target === undefined ? undefined : this.gameState.getEntityById(target);
		const type = supply?.resourceSupplyType();
		if (!type)
			return 0;
		return (+ent.get("ResourceGatherer/BaseSpeed") * +ent.get("ResourceGatherer/Rates/" + type.generic + "." + type.specific)) || 0;
	}

	/**
	 * Where the fighting is: our soldiers (units that can attack, not support)
	 * in our territory, in no one's and in an enemy's, and those of them in an
	 * attack plan; and the enemy units we see in our territory.
	 */
	fronts()
	{
		const territory = this.HQ.geography?.territoryMap ?? this.HQ.territoryMap;
		const where = (pos) =>
		{
			const owner = territory.getOwner(pos);
			return owner == PlayerID ? "home" : owner == 0 ? "neutral" : this.gameState.isPlayerEnemy(owner) ? "enemy" : "home";
		};
		const ours = { "home": 0, "neutral": 0, "enemy": 0 };
		const attacking = { "home": 0, "neutral": 0, "enemy": 0 };
		for (const ent of this.gameState.getOwnUnits().values())
		{
			const pos = ent.position();
			if (!pos || ent.hasClass("Support") || !ent.attackTypes())
				continue;
			const place = where(pos);
			++ours[place];
			if (ent.getMetadata(PlayerID, "role") == "attack" || typeof ent.getMetadata(PlayerID, "plan") == "number" &&
				ent.getMetadata(PlayerID, "plan") >= 0)
				++attacking[place];
		}
		let enemiesHome = 0;
		for (const ent of this.gameState.getEnemyUnits().values())
		{
			const pos = ent.position();
			if (pos && territory.getOwner(pos) == PlayerID && !ent.hasClass("Support"))
				++enemiesHome;
		}
		return { ours, attacking, enemiesHome };
	}

	/** Each base's supply lists: per resource and band, the count, the amount and the median distance to the dropsite. */
	layout()
	{
		return this.HQ.basesManager.baseManagers.map(base =>
		{
			const supplies = {};
			for (const type in base.dropsiteSupplies)
			{
				supplies[type] = {};
				for (const band of ["nearby", "medium", "faraway"])
				{
					const list = base.dropsiteSupplies[type][band];
					let amount = 0;
					const dists = [];
					for (const supply of list)
					{
						const ent = this.gameState.getEntityById(supply.id);
						amount += ent?.resourceSupplyAmount() ?? 0;
						dists.push(Math.sqrt(supply.dist));
					}
					dists.sort((a, b) => a - b);
					supplies[type][band] = [list.length, Math.round(amount),
						dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : undefined];
				}
			}
			return { "id": base.ID, supplies };
		});
	}

	/**
	 * The defense armies' lives (defense.txt with match.sh -b): each army's
	 * creation, a snapshot every 30 s while it lives, and its end, with how
	 * many of the defenders it ever had died and how many of its foes it
	 * killed (gone from the game while it fought them; a foe that walked out
	 * of sight counts as gone too, so "killed" is an upper bound).
	 */
	logDefense()
	{
		const defenseManager = this.HQ?.defenseManager;
		if (!defenseManager)
			return undefined;
		this.defenseArmies ??= new Map();
		const now = Math.round(this.elapsedTime);
		const live = new Set();
		for (const army of defenseManager.armies)
		{
			live.add(army.ID);
			let known = this.defenseArmies.get(army.ID);
			if (!known)
			{
				known = { "created": now, "own": new Set(), "foes": new Set(), "maxOwn": 0, "maxFoes": 0, "lastLine": now, "army": army };
				this.defenseArmies.set(army.ID, known);
			}
			for (const id of army.ownEntities)
				known.own.add(id);
			for (const id of army.foeEntities)
				known.foes.add(id);
			known.maxOwn = Math.max(known.maxOwn, army.ownEntities.length);
			known.maxFoes = Math.max(known.maxFoes, army.foeEntities.length);
			known.type = army.type;
			const snapshot = this.defenseSnapshot(army);
			known.last = snapshot;
			if (known.created == now)
				this.defenseLine("created", army.ID, known, snapshot);
			else if (now - known.lastLine >= 30)
			{
				known.lastLine = now;
				this.defenseLine("progress", army.ID, known, snapshot);
			}
		}
		for (const [id, known] of this.defenseArmies)
		{
			if (live.has(id))
				continue;
			const dead = [...known.own].filter(ent => !this.gameState.getEntityById(ent)).length;
			const killed = [...known.foes].filter(ent => !this.gameState.getEntityById(ent)).length;
			this.defenseLine("ended", id, known, { "defenders": known.own.size, "foesSeen": known.foes.size,
				"maxOwn": known.maxOwn, "maxFoes": known.maxFoes, dead, killed, "last": known.last });
			this.defenseArmies.delete(id);
		}
		return undefined;
	}

	/** An army now: its foes and defenders, their strengths, and how far its defenders are from the foes. */
	defenseSnapshot(army)
	{
		const at = army.foePosition;
		const dists = [];
		if (at)
			for (const id of army.ownEntities)
			{
				const pos = this.gameState.getEntityById(id)?.position();
				if (pos)
					dists.push(Math.round(VectorDistance(pos, at)));
			}
		dists.sort((a, b) => a - b);
		const territory = this.HQ.geography?.territoryMap ?? this.HQ.territoryMap;
		const owner = at ? territory.getOwner(at) : undefined;
		return {
			"foes": army.foeEntities.length, "own": army.ownEntities.length,
			"foeStrength": Math.round(army.foeStrength), "ownStrength": Math.round(army.ownStrength),
			"where": owner == PlayerID ? "home" : owner == 0 ? "neutral" : "other",
			"distMedian": dists.length ? dists[Math.floor(dists.length / 2)] : undefined,
			"distMax": dists.length ? dists[dists.length - 1] : undefined,
			"near": dists.filter(d => d <= 40).length
		};
	}

	defenseLine(event, id, known, detail)
	{
		print("DEFENSELOG " + JSON.stringify({ "t": Math.round(this.elapsedTime), "player": PlayerID, event, "army": id,
			"type": known.type, "age": Math.round(this.elapsedTime) - known.created, ...detail }) + "\n");
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

	/** What every read-only common-API accessor returns on a sample of entities and templates (APIPROBE). */
	apiProbe()
	{
		const gameState = this.gameState;
		const civ = gameState.getPlayerCiv();
		const resources = Resources.GetCodes();
		const enemies = gameState.getEnemyEntities().toEntityArray();
		const target = enemies.find(ent => ent.hasClass("Unit")) ?? enemies[0];
		const targetStructure = enemies.find(ent => ent.hasClass("Structure"));
		const researcher = gameState.getOwnEntitiesByClass("CivCentre", true).toEntityArray()[0];
		const attackTypes = ["Melee", "Ranged", "Capture", "Slaughter"];
		/** argument lists to call a method with, by the names of its parameters */
		const argumentsFor = params =>
		{
			let lists = [[]];
			for (const name of params)
			{
				const values = {
					"type": [...attackTypes, ...resources],
					"gameState": [gameState],
					"civ": [civ],
					"researcher": [undefined, researcher],
					"aClass": ["Unit", "Structure", "Cavalry"],
					"target": [target, targetStructure],
					"allowCapture": [true],
					"productionQueue": [undefined],
					"againstClass": ["Cavalry", "Structure"],
					"territory": ["own", "neutral", "enemy"],
					"player": [PlayerID],
					"resourceType": resources,
					"percentToStopAt": [],
					"iid": []
				}[name] ?? (name == "type" ? resources : undefined);
				if (!values)
					return undefined;
				lists = lists.flatMap(list => values.map(value => [...list, value]));
			}
			return lists;
		};
		const label = value => value === undefined ? "undefined" : value === gameState ? "gameState" :
			typeof value == "object" && value?.id ? "ent:" + (value.hasClass("Structure") ? "structure" : "unit") : String(value);
		const methods = [];
		for (let proto = Object.getPrototypeOf(enemies[0] ?? gameState.getOwnEntities().toEntityArray()[0]);
			proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
			for (const name of Object.getOwnPropertyNames(proto))
			{
				const fn = Object.getOwnPropertyDescriptor(proto, name).value;
				if (typeof fn != "function" || API_PROBE_SKIP.has(name) || methods.some(m => m.name == name))
					continue;
				const params = (/\(([^)]*)\)/.exec(fn.toString())?.[1] ?? "").split(",")
					.map(p => p.split("=")[0].trim()).filter(p => p);
				const lists = argumentsFor(params);
				if (lists)
					methods.push({ name, isEntityOnly: proto.constructor.name == "Entity", lists });
			}
		const hasNaN = value => typeof value == "number" ? isNaN(value) :
			value && typeof value == "object" && !value.id && Object.values(value).some(hasNaN);
		const probe = {};
		const record = (key, call) =>
		{
			const stats = probe[key] ??= { "n": 0 };
			const add = what => { stats[what] = (stats[what] ?? 0) + 1; };
			++stats.n;
			let value;
			try
			{
				value = call();
			}
			catch(e)
			{
				add("threw");
				stats.error ??= String(e).slice(0, 120);
				return;
			}
			if (value === undefined) add("undefined");
			else if (value === null) add("null");
			else if (hasNaN(value)) add("nan");
			else if (value === 0) add("zero");
			else if (value === false) add("false");
			else if (typeof value == "object" && !value.id && !Object.keys(value).length) add("empty");
			const sample = typeof value == "object" && value?.id ? "ent" : JSON.stringify(value)?.slice(0, 60);
			const samples = stats.values ??= [];
			if (samples.length < 4 && !samples.includes(sample))
				samples.push(sample);
		};
		const probeObject = (kind, object, isEntity) =>
		{
			for (const method of methods)
			{
				if (method.isEntityOnly && !isEntity)
					continue;
				for (const args of method.lists)
					record(kind + " " + method.name + "(" + args.map(label).join(",") + ")", () => object[method.name](...args));
			}
		};
		const seen = {};
		for (const ent of gameState.entities.values())
		{
			const owner = ent.owner();
			const kind = owner == PlayerID ? "own" : owner == 0 ? "gaia" : gameState.isPlayerEnemy(owner) ? "enemy" : "other";
			const key = kind + ent.templateName();
			if ((seen[key] = (seen[key] ?? 0) + 1) > 3)
				continue;
			probeObject(kind, ent, true);
		}
		const templates = new Set();
		for (const ent of gameState.getOwnEntities().values())
			for (const name of [...(ent.trainableEntities(civ) ?? []), ...(ent.buildableEntities(civ) ?? [])])
				templates.add(name);
		for (const name of templates)
		{
			const template = gameState.getTemplate(name);
			if (template)
				probeObject("template", template, false);
		}
		return { probe };
	}
}
