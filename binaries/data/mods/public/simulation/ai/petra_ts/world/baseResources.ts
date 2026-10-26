/**
 * The resources a base can reach (PLAN.md §3.4, world/): for each resource,
 * the supplies within reach of the base's dropsites, by band of distance
 * ("nearby", "medium", "faraway"), nearest first, and the dropsites they were
 * listed for. A base (decision/baseManager.ts) owns one and keeps its fields'
 * old names; what the base decides with them (workers, new dropsites, the
 * dropsite's sharing with allies) stays with the base.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import type { ResourceSupply } from "../decision/baseManager.ts";
import { getLandAccess, requireValue } from "../adapter/entityExtend.ts";

export class BaseResources
{
	/** The dropsites the lists were made for (a removed one is left undefined). */
	dropsites: Record<number, boolean | undefined> = {};
	/** The supplies within reach, by resource, then by band of distance. */
	dropsiteSupplies: Record<string, Record<string, ResourceSupply[]>> = {};

	constructor()
	{
		for (const res of Resources.GetCodes())
			this.dropsiteSupplies[res] = { "nearby": [], "medium": [], "faraway": [] };
	}

	/**
	 * Lists the supplies within reach of a new dropsite of the base, by band of
	 * distance; false if the dropsite was listed already. `baseAccess` is the
	 * base's land; the baseless pool (`baseless`) takes each dropsite's own.
	 */
	addDropsite(gameState: CommonGameState, dropsite: CommonEntity, baseAccess: AccessIndex | undefined, baseless: boolean,
		maxDistResourceSquare: number, debug: number): boolean
	{
		if (this.dropsites[dropsite.id()])
		{
			if (debug > 0)
				warn("assignResourceToDropsite: dropsite already in the list. Should never happen");
			return false;
		}

		let accessIndex = baseAccess;
		const dropsitePos = dropsite.position();
		const dropsiteId = dropsite.id();
		this.dropsites[dropsiteId] = true;

		if (baseless)
			accessIndex = getLandAccess(gameState, dropsite);

		const dropsiteTypes = dropsite.resourceDropsiteTypes();
		if (dropsiteTypes)
			for (const type of dropsiteTypes)
			{
				const resources = gameState.getResourceSupplies(type);
				if (!resources.length)
					continue;

				const nearby = this.dropsiteSupplies[type].nearby;
				const medium = this.dropsiteSupplies[type].medium;
				const faraway = this.dropsiteSupplies[type].faraway;

				resources.forEach(function(supply: CommonEntity): void 
				{
					if (!supply.position())
						return;
					// Moving resources and fields are treated differently.
					if (supply.hasClasses(["Animal", "Field"]))
						return;
					// quick accessibility check
					if (getLandAccess(gameState, supply) !== accessIndex)
						return;

					const dist = SquareVectorDistance(supply.position(), dropsitePos);
					if (dist < maxDistResourceSquare)
					{
						if (dist < maxDistResourceSquare/16)        // distmax/4
							nearby.push({ "dropsite": dropsiteId, "id": supply.id(), "dist": dist });
						else if (dist < maxDistResourceSquare/4)    // distmax/2
							medium.push({ "dropsite": dropsiteId, "id": supply.id(), "dist": dist });
						else
							faraway.push({ "dropsite": dropsiteId, "id": supply.id(), "dist": dist });
					}
				});

				nearby.sort((r1: ResourceSupply, r2: ResourceSupply): number => r1.dist - r2.dist);
				medium.sort((r1: ResourceSupply, r2: ResourceSupply): number => r1.dist - r2.dist);
				faraway.sort((r1: ResourceSupply, r2: ResourceSupply): number => r1.dist - r2.dist);

				/*
				let debug = false;
				if (debug)
				{
					faraway.forEach(function(res){
						debugShade([res.id], [2,0,0]);
					});
					medium.forEach(function(res){
						debugShade([res.id], [0,2,0]);
					});
					nearby.forEach(function(res){
						debugShade([res.id], [0,0,2]);
					});
				}
				*/
			}
		return true;
	}

	/** Drops a dropsite, and every supply listed for it or whose entity is gone, from all the lists. */
	removeDropsite(gameState: CommonGameState, entityID: EntityId): void
	{
		if (!entityID)
			return;

		const removeSupply = function(supply: ResourceSupply[]): void
		{
			for (let i = 0; i < supply.length; ++i)
			{
				// resource assigned to the removed dropsite, or whose supply
				// entity no longer stands in the game: remove it. Port-only
				// deviation: the reference's first clause reads a supply[i].ent
				// field that nothing ever writes, so it always fires and a
				// single dropsite removal wiped every book of every dropsite;
				// here the removal follows the intent the original comments
				// describe (pinned port-only in tests/baseManager.test.ts).
				if (supply[i].dropsite === entityID || !gameState.getEntityById(supply[i].id))
					supply.splice(i--, 1);
			}
		};

		for (const type in this.dropsiteSupplies)
		{
			removeSupply(this.dropsiteSupplies[type].nearby);
			removeSupply(this.dropsiteSupplies[type].medium);
			removeSupply(this.dropsiteSupplies[type].faraway);
		}

		this.dropsites[entityID] = undefined;
	}

	getResourceLevel(gameState: CommonGameState, type: string, distances: string[] = ["nearby", "medium", "faraway"]): number
	{
		let count = 0;
		const check: Record<number, boolean> = {};
		for (const proxim of distances)
			for (const supply of this.dropsiteSupplies[type][proxim])
			{
				if (check[supply.id])    // avoid double counting as same resource can appear several time
					continue;
				check[supply.id] = true;
				const supplyEntity = gameState.getEntityById(supply.id);
				if (supplyEntity)
					count += requireValue(supplyEntity.resourceSupplyAmount());
			}
		return count;
	}

	/** Drops the supply at `index` of the list for `resource` in `band`: its entity is gone. */
	forgetSupplyAt(resource: string, band: string, index: number): void
	{
		this.dropsiteSupplies[resource][band].splice(index, 1);
	}
}
