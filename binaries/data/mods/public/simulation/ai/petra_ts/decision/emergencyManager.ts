import { emergency as chatEmergency } from "../adapter/chatHelper.ts";
import type { Config } from "../world/config.ts";

/** The fields a save keeps. */
export type SerializedEmergencyManager = Pick<EmergencyManager, "referencePopulation" | "referenceStructureCount" | "numRoots" | "hasEmergency">;

/**
 * Checks for emergencies and acts accordingly
 */
export class EmergencyManager
{
	Config: Config;

	referencePopulation = 0;
	referenceStructureCount = 0;
	numRoots = 0;
	hasEmergency = false;

	constructor(Config: Config)
	{
		this.Config = Config;
	}

	/** At the start of a game: the population, structures and territory roots an emergency is measured against */
	static start(Config: Config, gameState: CommonGameState): EmergencyManager
	{
		const manager = new EmergencyManager(Config);
		manager.referencePopulation = gameState.getPopulation();
		manager.referenceStructureCount = gameState.getOwnStructures().length;
		manager.numRoots = manager.rootCount(gameState);
		return manager;
	}

	update(gameState: CommonGameState): void
	{
		if (this.hasEmergency)
		{
			this.emergencyUpdate(gameState);
			return;
		}
		const pop = gameState.getPopulation();
		const nStructures = gameState.getOwnStructures().length;
		const nRoots = this.rootCount(gameState);
		const factors = this.Config.emergencyValues;
		if (((pop / this.referencePopulation) < factors.population || pop === 0) &&
			((nStructures / this.referenceStructureCount) < factors.structures || nStructures === 0))
			this.setEmergency(gameState, true);
		else if ((nRoots / this.numRoots) <= factors.roots || (nRoots === 0 && this.numRoots !== 0))
			this.setEmergency(gameState, true);

		if (pop > this.referencePopulation || this.hasEmergency)
			this.referencePopulation = pop;
		if (nStructures > this.referenceStructureCount || this.hasEmergency)
			this.referenceStructureCount = nStructures;
		if (nRoots > this.numRoots || this.hasEmergency)
			this.numRoots = nRoots;
	}

	emergencyUpdate(gameState: CommonGameState): void
	{
		const pop = gameState.getPopulation();
		const nStructures = gameState.getOwnStructures().length;
		const nRoots = this.rootCount(gameState);

		if ((pop > this.referencePopulation * 1.2 &&
			nStructures > this.referenceStructureCount * 1.2) ||
			nRoots > this.numRoots)
		{
			this.setEmergency(gameState, false);
			this.referencePopulation = pop;
			this.referenceStructureCount = nStructures;
			this.numRoots = nRoots;
		}
	}

	rootCount(gameState: CommonGameState): number
	{
		let roots = 0;
		gameState.getOwnStructures().toEntityArray().forEach((ent) =>
		{
			const influence = ent?.get("TerritoryInfluence");
			if (typeof influence === "object" && influence !== null &&
				"Root" in influence && influence.Root === "true")
				roots++;
		});
		return roots;
	}

	setEmergency(gameState: CommonGameState, enable: boolean): void
	{
		this.hasEmergency = enable;
		chatEmergency(gameState, enable);
	}

	Serialize(): SerializedEmergencyManager
	{
		return {
			"referencePopulation": this.referencePopulation,
			"referenceStructureCount": this.referenceStructureCount,
			"numRoots": this.numRoots,
			"hasEmergency": this.hasEmergency
		};
	}

	/** A saved emergency manager: its references and whether it is in an emergency */
	static restore(Config: Config, data: SerializedEmergencyManager): EmergencyManager
	{
		const manager = new EmergencyManager(Config);
		manager.resume(data);
		return manager;
	}

	private resume(data: SerializedEmergencyManager): void
	{
		this.referencePopulation = data.referencePopulation;
		this.referenceStructureCount = data.referenceStructureCount;
		this.numRoots = data.numRoots;
		this.hasEmergency = data.hasEmergency;
	}
}
