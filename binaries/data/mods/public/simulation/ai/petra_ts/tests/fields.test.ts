/**
 * fields: whether a base plans another field (decision/fields.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type FieldCensus, nextField } from "../decision/fields.ts";

/** a base with two fields, none being built, Petra's provision of two, no limit */
function base(overrides: Partial<FieldCensus> = {}): FieldCensus
{
	return { "berries": 0, "fieldsFirst": false, "fields": 2, "foundations": 0, "queued": 0,
		"maxFields": false, "provision": 2, "saving": false, ...overrides };
}

describe("fields", () =>
{
	it("plans the first field once the berries fall below 600, or bring in less", () =>
	{
		assert.equal(nextField(base({ "fields": 0, "berries": 1200 })), "enough", "plenty of berries");
		assert.equal(nextField(base({ "fields": 0, "berries": 500 })), "first");
		assert.equal(nextField(base({ "fields": 0, "berries": 1200, "fieldsFirst": true })), "first", "they bring in less");
		assert.equal(nextField(base({ "fields": 0, "queued": 1, "berries": 100 })), "enough", "one is queued: it is the first");
	});

	it("keeps two fields in construction, one with berries left, saving or past five fields", () =>
	{
		assert.equal(nextField(base({ "foundations": 1 })), "more");
		assert.equal(nextField(base({ "foundations": 1, "queued": 1 })), "enough");
		assert.equal(nextField(base({ "foundations": 1, "berries": 400 })), "enough", "berries left");
		assert.equal(nextField(base({ "foundations": 1, "saving": true })), "enough");
		assert.equal(nextField(base({ "fields": 6, "foundations": 1 })), "enough");
		assert.equal(nextField(base({ "foundations": 0, "fields": 6 })), "more", "never fewer than one");
	});

	it("one more at a time while the berries bring in less", () =>
	{
		assert.equal(nextField(base({ "foundations": 2, "fieldsFirst": true })), "more");
		assert.equal(nextField(base({ "foundations": 3, "fieldsFirst": true })), "enough");
	});

	it("is full at the HQ's limit, where the base may build a corral instead", () =>
	{
		assert.equal(nextField(base({ "fields": 4, "queued": 1, "maxFields": 5 })), "full");
		assert.equal(nextField(base({ "fields": 4, "maxFields": 5 })), "more");
	});
});
