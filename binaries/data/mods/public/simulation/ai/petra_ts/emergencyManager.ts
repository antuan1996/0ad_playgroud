import { emergency as chatEmergency } from "./chatHelper.ts";
import type { Config } from "./config.ts";

/**
 * Checks for emergencies and acts accordingly
 */
export class EmergencyManager
{
	declare Config: Config;

	referencePopulation = 0;
	referenceStructureCount = 0;
	numRoots = 0;
	hasEmergency = false;

	constructor(Config: Config)
	{
		this.Config = Config;
	}

	init(gameState: CommonGameState): void
	{
		this.referencePopulation = gameState.getPopulation();
		this.referenceStructureCount = gameState.getOwnStructures().length;
		this.numRoots = this.rootCount(gameState);
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
		if (((pop / this.referencePopulation) < factors.population || pop == 0) &&
			((nStructures / this.referenceStructureCount) < factors.structures || nStructures == 0))
			this.setEmergency(gameState, true);
		else if ((nRoots / this.numRoots) <= factors.roots || (nRoots == 0 && this.numRoots != 0))
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
		const factors = this.Config.emergencyValues;

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
		gameState.getOwnStructures().toEntityArray().forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
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

	Serialize(): Record<string, unknown>
	{
		return {
			"referencePopulation": this.referencePopulation,
			"referenceStructureCount": this.referenceStructureCount,
			"numRoots": this.numRoots,
			"hasEmergency": this.hasEmergency
		};
	}

	Deserialize(data: Record<string, unknown>): void
	{
		for (const key in data)
			this[key as keyof this] = data[key] as this[keyof this];
	}
}
