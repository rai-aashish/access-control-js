import { describe, expect, it } from "vitest";
// Reaching into the internal module on purpose: this pins the invariant that the two
// functions have to satisfy together, which no public API can express.
import { deepEquals, encodeValueForKey } from "../src/core/conditions";

/** A spread of values, including pairs that are equal by value but distinct objects. */
const values: unknown[] = [
	1,
	"1",
	true,
	false,
	null,
	undefined,
	0,
	-0,
	1n,
	new Date("2026-01-01"),
	new Date("2026-01-01"),
	new Date("2026-06-01"),
	{},
	{ a: 1 },
	{ a: 1 },
	{ a: "1" },
	{ a: 1, b: 2 },
	{ b: 2, a: 1 },
	[],
	[1],
	[1],
	[1, 2],
	[2, 1],
	{ nested: { deep: [1, { x: true }] } },
	{ nested: { deep: [1, { x: true }] } },
];

describe("Cache keys agree with equality", () => {
	it("two values share a key exactly when they compare equal", () => {
		for (const a of values) {
			for (const b of values) {
				const keyA = encodeValueForKey(a);
				const keyB = encodeValueForKey(b);

				// A refused key makes no claim — the value is simply not cached
				if (keyA === null || keyB === null) continue;

				expect(keyA === keyB).toBe(deepEquals(a, b));
			}
		}
	});

	it("refuses a key to anything compared by reference", () => {
		expect(encodeValueForKey(new Map())).toBeNull();
		expect(encodeValueForKey(new Set())).toBeNull();
		expect(encodeValueForKey(() => undefined)).toBeNull();
		expect(encodeValueForKey(Symbol("s"))).toBeNull();
		// Refusal propagates out of any container holding one
		expect(encodeValueForKey({ inner: new Map() })).toBeNull();
		expect(encodeValueForKey([new Map()])).toBeNull();
		expect(encodeValueForKey({ a: { b: { c: new Set() } } })).toBeNull();
	});

	it("keys primitives, Dates, plain objects and arrays", () => {
		expect(encodeValueForKey(1)).not.toBeNull();
		expect(encodeValueForKey("x")).not.toBeNull();
		expect(encodeValueForKey(null)).not.toBeNull();
		expect(encodeValueForKey(undefined)).not.toBeNull();
		expect(encodeValueForKey(new Date())).not.toBeNull();
		expect(encodeValueForKey({ user: { id: 7 } })).not.toBeNull();
		expect(encodeValueForKey([1, { a: "b" }])).not.toBeNull();
	});

	it("distinguishes a type from its string form, and null from undefined", () => {
		expect(encodeValueForKey(1)).not.toBe(encodeValueForKey("1"));
		expect(encodeValueForKey(1n)).not.toBe(encodeValueForKey(1));
		expect(encodeValueForKey(true)).not.toBe(encodeValueForKey("true"));
		expect(encodeValueForKey(null)).not.toBe(encodeValueForKey(undefined));
		expect(encodeValueForKey({})).not.toBe(encodeValueForKey([]));
	});

	it("refuses a key past the depth it can compare", () => {
		const chain = (levels: number): Record<string, unknown> =>
			levels === 0 ? { end: true } : { next: chain(levels - 1) };

		expect(encodeValueForKey(chain(3))).not.toBeNull();
		expect(encodeValueForKey(chain(12))).toBeNull();
	});

	it("survives a cycle instead of overflowing the stack", () => {
		const cyclic: Record<string, unknown> = { name: "a" };
		cyclic.self = cyclic;

		expect(encodeValueForKey(cyclic)).toBeNull();
		expect(deepEquals(cyclic, cyclic)).toBe(true); // same reference, settled up front

		const other: Record<string, unknown> = { name: "a" };
		other.self = other;
		expect(deepEquals(cyclic, other)).toBe(false);
	});
});
