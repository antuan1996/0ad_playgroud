import { BaseAI } from "simulation/ai/common-api/baseAI.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { Entity } from "simulation/ai/common-api/entity.js";
import { Config } from "./decision/config.ts";
import { Headquarters } from "./decision/headquarters.ts";
import type { HeadquartersEvents, HeadquartersSerializedData } from "./decision/headquarters.ts";
import { Queue } from "./execution/queue.ts";
import { QueueManager } from "./execution/queueManager.ts";
import { gameAnalysis } from "./decision/startingStrategy.ts";
import { seconds, secondsOf } from "./adapter/brands.ts";

type PetraBotSettings = Record<string, unknown> & {
	difficulty: number;
	behavior?: string;
};

/**
 * The version of what the bot saves (constraint 4, PLAN.md §1). Raise it with
 * any change to the shape of a manager's saved data: a save of another
 * version is refused with a message, and the bot starts afresh from the game
 * as it stands, as it does in a new game.
 */
export const SAVE_VERSION = 1;

/** The version a save says it is of, if it says one. */
function savedVersion(data: unknown): unknown
{
	return typeof data === "object" && data !== null && "saveVersion" in data ? data.saveVersion : undefined;
}

/** Whether a save is of the version this code reads (its other fields are trusted then). */
function isCurrentSave(data: unknown): data is PetraBotSavedData
{
	return savedVersion(data) === SAVE_VERSION;
}

type PetraBotSavedData = {
	saveVersion: number;
	canPlay: boolean;
	uniqueIDs: Record<string, number>;
	turn: number;
	playedTurn: number;
	elapsedTime: GameSeconds;
	savedEvents: HeadquartersEvents;
	config: Record<string, unknown>;
	queueManager: Parameters<QueueManager["Deserialize"]>[1];
	HQ: HeadquartersSerializedData;
};

/** Engine events come as a fixed set of named buckets, and EngineAIEvents has no index
	 *  signature: the bot walks its buckets explicitly instead of iterating over keys.
	 *  The helpers below are generic over a bucket's element type, which keeps every
	 *  bucket's concrete event type, so no cast is needed anywhere.
	 *
	 *  VESTIGIAL - kept only to stay 1:1 with the current JS reference. It used to convert
	 *  the "entityObj" property of each event between its saved form (raw entity data) and
	 *  its live form (an API3.Entity proxy), which the engine cannot rebuild on load; a fresh
	 *  object was needed to swap that property in. entityObj was removed from events upstream
	 *  in 2025 ("Remove usage of entityObj from Destroy event", "Remove remanents of entityObj"),
	 *  which deleted the conversion and left this loop behind. It now has no observable effect:
	 *  the engine deserializer already rebuilds plain objects (JS_NewPlainObject in
	 *  StdDeserializer.cpp), and nothing in the bot mutates an event or keeps a reference to
	 *  one across turns. */
function detachEvents<T>(events: Array<T>): void
{
	for (let i = 0; i < events.length; ++i)
	{
		const evt = events[i];
		// A plain copy of the event - vestigial, see the note on detachEvents.
		// Spreading a falsy slot yields an empty object, as the copy loop used to.
		events[i] = { ...evt };
	}
}

/** Returns a fresh bucket whose event objects are plain copies of the given ones. */
function detachEventsCopy<T>(events: Array<T>): Array<T>
{
	const copy: Array<T> = [];
	for (let i = 0; i < events.length; ++i)
	{
		const evt = events[i];
		// Empty slots are kept as they were serialized.
		if (evt)
			// A plain copy of the event itself.
			copy[i] = { ...evt };
		else
			copy[i] = evt;
	}
	return copy;
}

function createEmptyEvents(): HeadquartersEvents
{
	return {
		Create: [],
		Destroy: [],
		Attacked: [],
		ConstructionFinished: [],
		DiplomacyChanged: [],
		TrainingStarted: [],
		TrainingFinished: [],
		AIMetadata: [],
		PlayerDefeated: [],
		EntityRenamed: [],
		ValueModification: [],
		OwnershipChanged: [],
		Garrison: [],
		UnGarrison: [],
		TerritoriesChanged: [],
		TerritoryDecayChanged: [],
		TributeExchanged: [],
		AttackRequest: [],
		CeasefireEnded: [],
		DiplomacyRequest: [],
		TributeRequest: []
	};
}

/** Replaces every event of every bucket by a plain copy of itself, in place. */
function detachSavedEvents(events: HeadquartersEvents): void
{
	detachEvents(events.Create);
	detachEvents(events.Destroy);
	detachEvents(events.Attacked);
	detachEvents(events.ConstructionFinished);
	detachEvents(events.DiplomacyChanged);
	detachEvents(events.TrainingStarted);
	detachEvents(events.TrainingFinished);
	detachEvents(events.AIMetadata);
	detachEvents(events.PlayerDefeated);
	detachEvents(events.EntityRenamed);
	detachEvents(events.ValueModification);
	detachEvents(events.OwnershipChanged);
	detachEvents(events.Garrison);
	detachEvents(events.UnGarrison);
	detachEvents(events.TerritoriesChanged);
	detachEvents(events.TerritoryDecayChanged);
	detachEvents(events.TributeExchanged);
	detachEvents(events.AttackRequest);
	detachEvents(events.CeasefireEnded);
	detachEvents(events.DiplomacyRequest);
	detachEvents(events.TributeRequest);
}

/** Appends the events of the shared script to the saved ones.
	 *  AIMetadata is not used inside petra, so it is not merged. */
function mergeSharedEvents(saved: HeadquartersEvents, shared: HeadquartersEvents): void
{
	saved.Create = saved.Create.concat(shared.Create);
	saved.Destroy = saved.Destroy.concat(shared.Destroy);
	saved.Attacked = saved.Attacked.concat(shared.Attacked);
	saved.ConstructionFinished = saved.ConstructionFinished.concat(shared.ConstructionFinished);
	saved.DiplomacyChanged = saved.DiplomacyChanged.concat(shared.DiplomacyChanged);
	saved.TrainingStarted = saved.TrainingStarted.concat(shared.TrainingStarted);
	saved.TrainingFinished = saved.TrainingFinished.concat(shared.TrainingFinished);
	saved.PlayerDefeated = saved.PlayerDefeated.concat(shared.PlayerDefeated);
	saved.EntityRenamed = saved.EntityRenamed.concat(shared.EntityRenamed);
	saved.ValueModification = saved.ValueModification.concat(shared.ValueModification);
	saved.OwnershipChanged = saved.OwnershipChanged.concat(shared.OwnershipChanged);
	saved.Garrison = saved.Garrison.concat(shared.Garrison);
	saved.UnGarrison = saved.UnGarrison.concat(shared.UnGarrison);
	saved.TerritoriesChanged = saved.TerritoriesChanged.concat(shared.TerritoriesChanged);
	saved.TerritoryDecayChanged = saved.TerritoryDecayChanged.concat(shared.TerritoryDecayChanged);
	saved.TributeExchanged = saved.TributeExchanged.concat(shared.TributeExchanged);
	saved.AttackRequest = saved.AttackRequest.concat(shared.AttackRequest);
	saved.CeasefireEnded = saved.CeasefireEnded.concat(shared.CeasefireEnded);
	saved.DiplomacyRequest = saved.DiplomacyRequest.concat(shared.DiplomacyRequest);
	saved.TributeRequest = saved.TributeRequest.concat(shared.TributeRequest);
}

/** A fresh events object: new buckets, each holding plain copies of the events. */
function copySavedEvents(events: HeadquartersEvents): HeadquartersEvents
{
	return {
		"Create": detachEventsCopy(events.Create),
		"Destroy": detachEventsCopy(events.Destroy),
		"Attacked": detachEventsCopy(events.Attacked),
		"ConstructionFinished": detachEventsCopy(events.ConstructionFinished),
		"DiplomacyChanged": detachEventsCopy(events.DiplomacyChanged),
		"TrainingStarted": detachEventsCopy(events.TrainingStarted),
		"TrainingFinished": detachEventsCopy(events.TrainingFinished),
		"AIMetadata": detachEventsCopy(events.AIMetadata),
		"PlayerDefeated": detachEventsCopy(events.PlayerDefeated),
		"EntityRenamed": detachEventsCopy(events.EntityRenamed),
		"ValueModification": detachEventsCopy(events.ValueModification),
		"OwnershipChanged": detachEventsCopy(events.OwnershipChanged),
		"Garrison": detachEventsCopy(events.Garrison),
		"UnGarrison": detachEventsCopy(events.UnGarrison),
		"TerritoriesChanged": detachEventsCopy(events.TerritoriesChanged),
		"TerritoryDecayChanged": detachEventsCopy(events.TerritoryDecayChanged),
		"TributeExchanged": detachEventsCopy(events.TributeExchanged),
		"AttackRequest": detachEventsCopy(events.AttackRequest),
		"CeasefireEnded": detachEventsCopy(events.CeasefireEnded),
		"DiplomacyRequest": detachEventsCopy(events.DiplomacyRequest),
		"TributeRequest": detachEventsCopy(events.TributeRequest)
	};
}

export class PetraBot extends BaseAI
{
	Config: Config;
	HQ: Headquarters | undefined = undefined;
	canPlay: boolean = false;
	data: PetraBotSavedData | undefined = undefined;
	elapsedTime: GameSeconds = seconds(0);
	gameFinished: boolean = false;
	isDeserialized: boolean = false;
	playedTurn: number = 0;
	declare player: PlayerId;
	queueManager: QueueManager | undefined = undefined;
	queues: Record<string, Queue> = {};
	savedEvents: HeadquartersEvents;
	turn: number = 0;
	uniqueIDs: Record<string, number> = {};

	constructor(settings: PetraBotSettings)
	{
		super(settings);

		// played turn, because Petra doesn't play every turn.
		this.turn = 0;
		this.playedTurn = 0;
		this.elapsedTime = seconds(0);

		this.uniqueIDs = {
			"armies": 1,	// starts at 1 to allow easier tests on armies ID existence
			"bases": 1,	// base manager ID starts at one because "0" means "no base" on the map
			"plans": 0,	// training/building/research plans
			"transports": 1	// transport plans start at 1 because 0 might be used as none
		};

		this.Config = new Config(settings.difficulty, settings.behavior);

		this.savedEvents = createEmptyEvents();
	}

	CustomInit(gameState: CommonGameState): void
	{
		if (this.isDeserialized)
		{
			// WARNING: the deserializations should not modify the metadatas infos inside their init functions
			if (!this.data)
				return;
			this.canPlay = this.data.canPlay;
			this.turn = this.data.turn;
			this.playedTurn = this.data.playedTurn;
			this.elapsedTime = this.data.elapsedTime;
			this.savedEvents = this.data.savedEvents;
			// Kept for 1:1 with the JS reference; it is a no-op today - see detachEvents.
			// The JS reference rebuilt every event as a plain object here.
			// detachSavedEvents walks the 21 buckets of EngineAIEvents explicitly.
			detachSavedEvents(this.savedEvents);

			this.Config.Deserialize(this.data.config);

			this.queueManager = new QueueManager(this.Config, {});
			this.queueManager.Deserialize(gameState, this.data.queueManager);
			this.queues = this.queueManager.queues;

			this.HQ = new Headquarters(this.Config, true);
			this.HQ.init(gameState, this.queues);
			this.HQ.Deserialize(gameState, this.data.HQ);

			this.uniqueIDs = this.data.uniqueIDs;
			this.isDeserialized = false;
			this.data = undefined;

			// initialisation needed after the completion of the deserialization
			this.HQ.postinit(gameState);
		}
		else
		{
			this.Config.setConfig(gameState);

			// this.queues can only be modified by the queue manager or things will go awry.
			this.queues = {};
			for (const i in this.Config.priorities)
				this.queues[i] = new Queue();

			this.queueManager = new QueueManager(this.Config, this.queues);

			this.HQ = new Headquarters(this.Config, false);

			this.HQ.init(gameState, this.queues);

			// Try to analyze our starting position and set a strategy.
			this.canPlay = gameAnalysis(this.HQ, gameState);
		}
	}

	OnUpdate(sharedScript: CommonSharedScript): void
	{
		if (this.isDeserialized)
			this.Init(PlayerID, sharedScript);

		if (this.gameFinished || this.gameState.playerData.state == "defeated")
			return;

		mergeSharedEvents(this.savedEvents, sharedScript.events);

		// Run the update every n turns, offset depending on player ID to balance the load
		this.elapsedTime = secondsOf(this.gameState.getTimeElapsed());
		if (!this.playedTurn || (this.turn + this.player) % 8 == 5)
		{
			Engine.ProfileStart("PetraBot bot (player " + this.player +")");

			this.playedTurn++;

			if (!this.canPlay)
			{
				Engine.ProfileStop();
				return;
			}

			if (this.HQ)
				this.HQ.update(this.gameState, this.queues, this.savedEvents);

			if (this.queueManager)
				this.queueManager.update(this.gameState);

			// Every event of this turn has been processed: start with empty buckets.
			this.savedEvents = createEmptyEvents();

			Engine.ProfileStop();
		}

		this.turn++;
	}

	Serialize(): PetraBotSavedData
	{
		if (this.isDeserialized)
		{
			if (!this.data)
				throw new Error("Cannot serialize: data is undefined during deserialization");
			return this.data;
		}

		if (!this.queueManager || !this.HQ)
			throw new Error("Cannot serialize: queueManager or HQ is undefined");

		return {
			"saveVersion": SAVE_VERSION,
			"canPlay": this.canPlay,
			"uniqueIDs": this.uniqueIDs,
			"turn": this.turn,
			"playedTurn": this.playedTurn,
			"elapsedTime": this.elapsedTime,
			"savedEvents": copySavedEvents(this.savedEvents),
			"config": this.Config.Serialize(),
			"queueManager": this.queueManager.Serialize(),
			"HQ": this.HQ.Serialize()
		};
	}

	Deserialize(data: unknown, sharedScript: CommonSharedScript): void
	{
		// A save without a version comes from before versions (stage 3) or
		// from another bot: neither is a shape this code knows.
		if (!isCurrentSave(data))
		{
			aiWarn("Petra: this save is of version " + String(savedVersion(data)) + " and the bot reads version " +
				SAVE_VERSION + ": it starts afresh from the game as it stands");
			// the old save's notes on our units name bases and plans that no longer exist
			sharedScript._entityMetadata[this.player] = {};
			return;
		}
		this.isDeserialized = true;
		this.data = data;
	}
}
