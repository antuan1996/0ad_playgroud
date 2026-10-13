import { BaseAI } from "simulation/ai/common-api/baseAI.js";
import { Config } from "./config.js";
import { Headquarters } from "./headquarters.js";
import { Queue } from "./queue.js";
import { QueueManager } from "./queueManager.js";
import { gameAnalysis } from "./startingStrategy.js";
function createEmptyEvents() {
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
export class PetraBot extends BaseAI {
    Config;
    HQ = undefined;
    canPlay = false;
    data = undefined;
    elapsedTime = 0;
    gameFinished = false;
    isDeserialized = false;
    playedTurn = 0;
    queueManager = undefined;
    queues = {};
    savedEvents;
    turn = 0;
    uniqueIDs = {};
    constructor(settings) {
        super(settings);
        // played turn, because Petra doesn't play every turn.
        this.turn = 0;
        this.playedTurn = 0;
        this.elapsedTime = 0;
        this.uniqueIDs = {
            "armies": 1, // starts at 1 to allow easier tests on armies ID existence
            "bases": 1, // base manager ID starts at one because "0" means "no base" on the map
            "plans": 0, // training/building/research plans
            "transports": 1 // transport plans start at 1 because 0 might be used as none
        };
        this.Config = new Config(settings.difficulty, settings.behavior);
        this.savedEvents = createEmptyEvents();
    }
    CustomInit(gameState) {
        if (this.isDeserialized) {
            // WARNING: the deserializations should not modify the metadatas infos inside their init functions
            if (!this.data)
                return;
            this.canPlay = this.data.canPlay;
            this.turn = this.data.turn;
            this.playedTurn = this.data.playedTurn;
            this.elapsedTime = this.data.elapsedTime;
            this.savedEvents = this.data.savedEvents;
            for (const key in this.savedEvents) {
                for (const i in this.savedEvents[key]) {
                    const evt = this.savedEvents[key][i];
                    const evtmod = {};
                    for (const keyevt in evt) {
                        evtmod[keyevt] = evt[keyevt];
                        this.savedEvents[key][i] = evtmod;
                    }
                }
            }
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
        else {
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
    OnUpdate(sharedScript) {
        if (this.isDeserialized)
            this.Init(PlayerID, sharedScript);
        if (this.gameFinished || this.gameState.playerData.state == "defeated")
            return;
        for (const i in sharedScript.events) {
            if (i == "AIMetadata") // not used inside petra
                continue;
            if (this.savedEvents[i] !== undefined)
                this.savedEvents[i] = this.savedEvents[i].concat(sharedScript.events[i]);
            else
                this.savedEvents[i] = sharedScript.events[i];
        }
        // Run the update every n turns, offset depending on player ID to balance the load
        this.elapsedTime = this.gameState.getTimeElapsed() / 1000;
        if (!this.playedTurn || (this.turn + this.player) % 8 == 5) {
            Engine.ProfileStart("PetraBot bot (player " + this.player + ")");
            this.playedTurn++;
            if (!this.canPlay) {
                Engine.ProfileStop();
                return;
            }
            if (this.HQ)
                this.HQ.update(this.gameState, this.queues, this.savedEvents);
            if (this.queueManager)
                this.queueManager.update(this.gameState);
            for (const i in this.savedEvents)
                this.savedEvents[i] = [];
            Engine.ProfileStop();
        }
        this.turn++;
    }
    Serialize() {
        if (this.isDeserialized) {
            if (!this.data)
                throw new Error("Cannot serialize: data is undefined during deserialization");
            return this.data;
        }
        const savedEvents = createEmptyEvents();
        for (const key in this.savedEvents) {
            savedEvents[key] = this.savedEvents[key].slice();
            for (const i in savedEvents[key]) {
                if (!savedEvents[key][i])
                    continue;
                const evt = savedEvents[key][i];
                const evtmod = {};
                for (const keyevt in evt)
                    evtmod[keyevt] = evt[keyevt];
                savedEvents[key][i] = evtmod;
            }
        }
        if (!this.queueManager || !this.HQ)
            throw new Error("Cannot serialize: queueManager or HQ is undefined");
        return {
            "canPlay": this.canPlay,
            "uniqueIDs": this.uniqueIDs,
            "turn": this.turn,
            "playedTurn": this.playedTurn,
            "elapsedTime": this.elapsedTime,
            "savedEvents": savedEvents,
            "config": this.Config.Serialize(),
            "queueManager": this.queueManager.Serialize(),
            "HQ": this.HQ.Serialize()
        };
    }
    Deserialize(data, sharedScript) {
        this.isDeserialized = true;
        this.data = data;
    }
}
