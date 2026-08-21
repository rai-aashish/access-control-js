import { describe, expect, it, vi } from "vitest";
import { definePolicy, getAccessControl } from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

/** Builds a one-statement allow policy around a single condition. */
const allowWhen = (contexts: readonly Record<string, unknown>[]) =>
	getAccessControl<AppConfig>(
		definePolicy<AppConfig>().allow("posts", ["update"], { contexts }).build(),
	);

describe("Condition operators", () => {
	it("treats a bare value as $eq", () => {
		const { can } = allowWhen([{ role: "editor" }]);

		expect(can("posts", "update", { role: "editor" })).toBe(true);
		expect(can("posts", "update", { role: "viewer" })).toBe(false);
	});

	it("$eq and $ne", () => {
		const eq = allowWhen([{ role: { $eq: "editor" } }]);
		expect(eq.can("posts", "update", { role: "editor" })).toBe(true);
		expect(eq.can("posts", "update", { role: "viewer" })).toBe(false);

		const ne = allowWhen([{ status: { $ne: "locked" } }]);
		expect(ne.can("posts", "update", { status: "draft" })).toBe(true);
		expect(ne.can("posts", "update", { status: "locked" })).toBe(false);
	});

	it("$in and $nin", () => {
		const inOp = allowWhen([{ status: { $in: ["draft", "review"] } }]);
		expect(inOp.can("posts", "update", { status: "review" })).toBe(true);
		expect(inOp.can("posts", "update", { status: "published" })).toBe(false);

		const ninOp = allowWhen([{ status: { $nin: ["locked", "archived"] } }]);
		expect(ninOp.can("posts", "update", { status: "draft" })).toBe(true);
		expect(ninOp.can("posts", "update", { status: "locked" })).toBe(false);
	});

	it("orders numbers", () => {
		const { can } = allowWhen([{ level: { $gte: 3 } }]);

		expect(can("posts", "update", { level: 3 })).toBe(true);
		expect(can("posts", "update", { level: 4 })).toBe(true);
		expect(can("posts", "update", { level: 2 })).toBe(false);
	});

	it("orders strings", () => {
		const { can } = allowWhen([{ tier: { $gt: "b" } }]);

		expect(can("posts", "update", { tier: "c" })).toBe(true);
		expect(can("posts", "update", { tier: "a" })).toBe(false);
	});

	it("orders Dates by timestamp", () => {
		const cutoff = new Date("2026-01-01T00:00:00Z");
		const { can } = allowWhen([{ publishedAt: { $lte: cutoff } }]);

		expect(
			can("posts", "update", { publishedAt: new Date("2025-06-01T00:00:00Z") }),
		).toBe(true);
		expect(
			can("posts", "update", { publishedAt: new Date("2026-06-01T00:00:00Z") }),
		).toBe(false);
	});

	it("ANDs several operators on one path", () => {
		const { can } = allowWhen([{ age: { $gte: 18, $lt: 65 } }]);

		expect(can("posts", "update", { age: 18 })).toBe(true);
		expect(can("posts", "update", { age: 64 })).toBe(true);
		expect(can("posts", "update", { age: 17 })).toBe(false);
		expect(can("posts", "update", { age: 65 })).toBe(false);
	});

	it("$contains over strings and arrays", () => {
		const inString = allowWhen([{ email: { $contains: "@acme.com" } }]);
		expect(inString.can("posts", "update", { email: "a@acme.com" })).toBe(true);
		expect(inString.can("posts", "update", { email: "a@other.com" })).toBe(
			false,
		);

		const inArray = allowWhen([{ groups: { $contains: "editors" } }]);
		expect(
			inArray.can("posts", "update", { groups: ["viewers", "editors"] }),
		).toBe(true);
		expect(inArray.can("posts", "update", { groups: ["viewers"] })).toBe(false);
	});

	it("$exists decides presence, including when the path is absent", () => {
		const present = allowWhen([{ apiKey: { $exists: true } }]);
		expect(present.can("posts", "update", { apiKey: "k" })).toBe(true);
		expect(present.can("posts", "update", { user: 1 })).toBe(false);

		const absent = allowWhen([{ apiKey: { $exists: false } }]);
		expect(absent.can("posts", "update", { user: 1 })).toBe(true);
		expect(absent.can("posts", "update", { apiKey: "k" })).toBe(false);
		// Decidable with no context at all — every path is absent
		expect(absent.can("posts", "update")).toBe(true);
	});
});

describe("Context paths and $ref", () => {
	it("reads nested values through a dot path", () => {
		const { can } = allowWhen([{ "post.status": "draft" }]);

		expect(can("posts", "update", { post: { status: "draft" } })).toBe(true);
		expect(can("posts", "update", { post: { status: "locked" } })).toBe(false);
		expect(can("posts", "update", { post: {} })).toBe(false);
	});

	it("expresses ownership without baking a user id into the policy", () => {
		const { can } = allowWhen([{ "post.ownerId": { $ref: "user.id" } }]);

		expect(
			can("posts", "update", { user: { id: 7 }, post: { ownerId: 7 } }),
		).toBe(true);
		expect(
			can("posts", "update", { user: { id: 7 }, post: { ownerId: 9 } }),
		).toBe(false);
	});

	it("resolves a $ref operand inside another operator", () => {
		const { can } = allowWhen([
			{ "post.ownerId": { $in: { $ref: "user.managedIds" } } },
		]);

		expect(
			can("posts", "update", {
				user: { managedIds: [1, 2, 3] },
				post: { ownerId: 2 },
			}),
		).toBe(true);
		expect(
			can("posts", "update", {
				user: { managedIds: [1, 2, 3] },
				post: { ownerId: 9 },
			}),
		).toBe(false);
	});

	it("leaves the comparison undecided when a $ref points nowhere", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const policy = definePolicy<AppConfig>()
				.allow("posts", ["update"])
				.deny("posts", ["update"], {
					contexts: [{ "post.ownerId": { $ref: "user.id" } }],
				})
				.build();

			// The deny cannot be judged without user.id, so it is skipped and reported
			const result = getAccessControl<AppConfig>(policy).explain(
				"posts",
				"update",
				{ post: { ownerId: 7 } },
			);

			expect(result.allowed).toBe(true);
			expect(result.undecidedDenies).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("Three-valued conditions", () => {
	it("operators do not change specificity, so conflict resolution is unaffected", () => {
		// One key either way: the deny is more specific than the bare allow and wins
		const withOperators = definePolicy<AppConfig>()
			.allow("posts", ["delete"])
			.deny("posts", ["delete"], { contexts: [{ level: { $lt: 5 } }] })
			.build();
		const { can } = getAccessControl<AppConfig>(withOperators);

		expect(can("posts", "delete", { level: 3 })).toBe(false);
		expect(can("posts", "delete", { level: 9 })).toBe(true);
	});
});

describe("Operator misuse", () => {
	it("treats {} and objects mixing $ and plain keys as literal values", () => {
		const empty = allowWhen([{ meta: {} }]);
		// Compared as a literal value, so it matches {} and nothing else. An empty
		// operator spec would instead have matched any value present.
		expect(empty.can("posts", "update", { meta: {} })).toBe(true);
		expect(empty.can("posts", "update", { meta: { a: 1 } })).toBe(false);

		const mixed = allowWhen([{ meta: { $eq: 1, plain: 2 } }]);
		// Also a literal: it matches that exact shape, and does not act as `$eq: 1`
		expect(mixed.can("posts", "update", { meta: { $eq: 1, plain: 2 } })).toBe(
			true,
		);
		expect(mixed.can("posts", "update", { meta: 1 })).toBe(false);
	});

	it("warns and never matches on an unknown operator", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { can } = allowWhen([{ level: { $between: [1, 5] } }]);

			expect(can("posts", "update", { level: 3 })).toBe(false);
			expect(warn.mock.calls[0]?.[0]).toContain("$between");
		} finally {
			warn.mockRestore();
		}
	});

	it("warns and never matches when ordering mismatched kinds", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { can } = allowWhen([{ publishedAt: { $lt: "2026-01-01" } }]);

			// A Date against a string: comparable individually, different kinds together
			expect(
				can("posts", "update", { publishedAt: new Date("2025-01-01") }),
			).toBe(false);
			expect(warn.mock.calls[0]?.[0]).toContain("different kinds");
		} finally {
			warn.mockRestore();
		}
	});

	it("warns and never matches when $in has no array to search", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { can } = allowWhen([{ status: { $in: "draft" } }]);

			expect(can("posts", "update", { status: "draft" })).toBe(false);
			expect(warn.mock.calls[0]?.[0]).toContain("$in");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("Value equality", () => {
	it("compares plain objects and arrays by value", () => {
		const nested = allowWhen([{ scope: { org: 1, teams: ["a", "b"] } }]);

		expect(
			nested.can("posts", "update", { scope: { org: 1, teams: ["a", "b"] } }),
		).toBe(true);
		// A different key order is the same value
		expect(
			nested.can("posts", "update", { scope: { teams: ["a", "b"], org: 1 } }),
		).toBe(true);
		expect(
			nested.can("posts", "update", { scope: { org: 2, teams: ["a", "b"] } }),
		).toBe(false);
	});

	it("treats array order as significant", () => {
		const { can } = allowWhen([{ tags: ["a", "b"] }]);

		expect(can("posts", "update", { tags: ["a", "b"] })).toBe(true);
		expect(can("posts", "update", { tags: ["b", "a"] })).toBe(false);
		expect(can("posts", "update", { tags: ["a", "b", "c"] })).toBe(false);
	});

	it("finds object members with $in and $contains", () => {
		const inOp = allowWhen([{ scope: { $in: [{ org: 1 }, { org: 2 }] } }]);
		expect(inOp.can("posts", "update", { scope: { org: 2 } })).toBe(true);
		expect(inOp.can("posts", "update", { scope: { org: 3 } })).toBe(false);

		const contains = allowWhen([{ scopes: { $contains: { org: 1 } } }]);
		expect(contains.can("posts", "update", { scopes: [{ org: 1 }] })).toBe(
			true,
		);
		expect(contains.can("posts", "update", { scopes: [{ org: 9 }] })).toBe(
			false,
		);
	});

	it("compares Dates by timestamp, and not against look-alike objects", () => {
		const when = new Date("2026-03-01T12:00:00Z");
		const { can } = allowWhen([{ at: when }]);

		expect(
			can("posts", "update", { at: new Date("2026-03-01T12:00:00Z") }),
		).toBe(true);
		expect(
			can("posts", "update", { at: new Date("2026-03-02T12:00:00Z") }),
		).toBe(false);
		expect(can("posts", "update", { at: {} })).toBe(false);
	});

	it("keeps reference semantics for values it cannot compare by value", () => {
		const groups = new Set(["editors"]);
		const { can } = allowWhen([{ groups }]);

		expect(can("posts", "update", { groups })).toBe(true);
		expect(can("posts", "update", { groups: new Set(["editors"]) })).toBe(
			false,
		);
	});

	it("stops comparing past a depth limit, so identical deep structures differ", () => {
		const chain = (levels: number): Record<string, unknown> =>
			levels === 0 ? { end: true } : { next: chain(levels - 1) };

		const shallow = allowWhen([{ path: chain(3) }]);
		expect(shallow.can("posts", "update", { path: chain(3) })).toBe(true);

		// Deeper than the comparison looks: unequal even though the shapes match
		const deep = allowWhen([{ path: chain(12) }]);
		expect(deep.can("posts", "update", { path: chain(12) })).toBe(false);
	});
});
