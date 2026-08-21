import { describe, expect, it, vi } from "vitest";
import { definePolicy, getAccessControl } from "../src";

/**
 * The README is the primary interface to this package, so its distinctive claims are
 * asserted here. Anything documented that is not covered by another test file belongs
 * in this one, so the docs cannot drift from the behaviour.
 */
const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

describe("README — conditions", () => {
	it("ORs across contexts and ANDs within one", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"], {
				contexts: [{ role: "editor", tier: "pro" }, { role: "admin" }],
			})
			.build();
		const { can } = getAccessControl<AppConfig>(policy);

		expect(can("posts", "update", { role: "admin" })).toBe(true);
		expect(can("posts", "update", { role: "editor", tier: "pro" })).toBe(true);
		// AND within an entry: editor alone is not enough
		expect(can("posts", "update", { role: "editor", tier: "free" })).toBe(
			false,
		);
	});

	it("combines operators across keys", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"], {
				contexts: [{ level: { $gte: 3 }, tier: { $ne: "free" } }],
			})
			.build();
		const { can } = getAccessControl<AppConfig>(policy);

		expect(can("posts", "update", { level: 3, tier: "pro" })).toBe(true);
		expect(can("posts", "update", { level: 2, tier: "pro" })).toBe(false);
		expect(can("posts", "update", { level: 5, tier: "free" })).toBe(false);
	});

	it("denies on a nested path with $in", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["delete"])
			.deny("posts", ["delete"], {
				contexts: [{ "post.state": { $in: ["locked", "archived"] } }],
			})
			.build();
		const { can } = getAccessControl<AppConfig>(policy);

		expect(can("posts", "delete", { post: { state: "draft" } })).toBe(true);
		expect(can("posts", "delete", { post: { state: "locked" } })).toBe(false);
		expect(can("posts", "delete", { post: { state: "archived" } })).toBe(false);
	});

	it("compares a non-primitive condition by value, as the migration note says", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["read"], { contexts: [{ scope: { org: 1 } }] })
			.build();

		// 0.3.x answered false here; 0.4.0 answers true
		expect(
			getAccessControl<AppConfig>(policy).can("posts", "read", {
				scope: { org: 1 },
			}),
		).toBe(true);
	});
});

describe("README — default context", () => {
	const policy = definePolicy<AppConfig>()
		.allow("posts", ["read"], { contexts: [{ tenantId: "123" }] })
		.allow("posts", ["create"], {
			contexts: [{ tenantId: "123", role: "admin" }],
		})
		.build();

	it("merges into every check, and explicit context overrides it", () => {
		const ac = getAccessControl<AppConfig>(policy, {
			defaultContext: { tenantId: "123" },
		});

		expect(ac.can("posts", "read")).toBe(true);
		expect(ac.can("posts", "create")).toBe(false); // needs role too
		expect(ac.can("posts", "create", { role: "admin" })).toBe(true);
		// An explicit value wins on a matching key
		expect(ac.can("posts", "read", { tenantId: "999" })).toBe(false);
	});
});

describe("README — undecidable denies", () => {
	const policy = definePolicy<AppConfig>()
		.allow("posts", ["delete"])
		.deny("posts", ["delete"], { contexts: [{ status: "locked" }] })
		.build();

	it("skips a deny the context cannot settle, and reports it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ac = getAccessControl<AppConfig>(policy);

			expect(ac.can("posts", "delete")).toBe(true);
			expect(ac.can("posts", "delete", { role: "admin" })).toBe(true);
			expect(ac.explain("posts", "delete").undecidedDenies).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("applies the deny once the context supplies the key", () => {
		const { can } = getAccessControl<AppConfig>(policy);

		expect(can("posts", "delete", { status: "locked" })).toBe(false);
		expect(can("posts", "delete", { status: "draft" })).toBe(true);
	});
});

describe("README — conflict resolution", () => {
	const policy = definePolicy<AppConfig>()
		.deny("posts", ["*"])
		.allow("posts", ["delete"], { contexts: [{ role: "editor" }] })
		.build();

	it("lets a specific allow outrank a blanket deny by default", () => {
		expect(
			getAccessControl<AppConfig>(policy).can("posts", "delete", {
				role: "editor",
			}),
		).toBe(true);
	});

	it("makes the deny absolute under explicitDenyWins", () => {
		expect(
			getAccessControl<AppConfig>(policy, {
				conflictResolution: "explicitDenyWins",
			}).can("posts", "delete", { role: "editor" }),
		).toBe(false);
	});
});

describe("README — explain()", () => {
	it("returns the documented fields", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"])
			.deny("posts", ["update"], { contexts: [{ status: "locked" }] })
			.build();

		const result = getAccessControl<AppConfig>(policy).explain(
			"posts",
			"update",
			{ status: "locked" },
		);

		expect(result.allowed).toBe(false);
		expect(result.strategy).toBe("denyWins");
		expect(result.decidedBy?.effect).toBe("deny");
		expect(result.decidedBy?.index).toBe(1);
		expect(result.decidedBy?.specificity).toBe(1);
		expect(result.matched).toHaveLength(2);
		expect(result.undecidedDenies).toEqual([]);
		// The reason line quoted in the README
		expect(result.reason).toBe(
			"posts:update denied by the deny statement at index 1 for this resource " +
				"(specificity 1), under denyWins.",
		);
	});
});

describe("README — pure evaluation", () => {
	it("accepts a prebuilt index", async () => {
		const { buildPolicyIndex, evaluateAccess, explainAccess } = await import(
			"../src"
		);
		const policy = definePolicy<AppConfig>().allow("posts", ["read"]).build();
		const index = buildPolicyIndex(policy);

		expect(
			evaluateAccess(policy, "posts", "read", undefined, undefined, index),
		).toBe(true);
		expect(
			explainAccess(policy, "posts", "read", undefined, undefined, index)
				.allowed,
		).toBe(true);
	});
});
