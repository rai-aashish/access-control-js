import { describe, expect, it, vi } from "vitest";
import {
	createAccessControlStore,
	definePolicy,
	getAccessControl,
} from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

describe("explain()", () => {
	it("reports nothing matching as a deny", () => {
		const { explain } = getAccessControl<AppConfig>([]);
		const result = explain("posts", "read");

		expect(result.allowed).toBe(false);
		expect(result.matched).toEqual([]);
		expect(result.decidedBy).toBeNull();
		expect(result.resource).toBe("posts");
		expect(result.action).toBe("read");
		expect(result.strategy).toBe("denyWins");
		expect(result.reason).toContain("No statement matched posts:read");
	});

	it("names the statement that decided an allow", () => {
		const policy = definePolicy<AppConfig>().allow("posts", ["read"]).build();
		const { explain } = getAccessControl<AppConfig>(policy);
		const result = explain("posts", "read");

		expect(result.allowed).toBe(true);
		expect(result.matched).toHaveLength(1);
		expect(result.decidedBy?.index).toBe(0);
		expect(result.decidedBy?.effect).toBe("allow");
		expect(result.decidedBy?.specificity).toBe(0);
		expect(result.decidedBy?.statement).toBe(policy[0]);
		expect(result.reason).toContain("allowed");
	});

	it("shows why a specific allow outranks a broad deny", () => {
		const policy = definePolicy<AppConfig>()
			.deny("posts", ["*"])
			.allow("posts", ["delete"], { contexts: [{ role: "editor" }] })
			.build();
		const { explain } = getAccessControl<AppConfig>(policy);
		const result = explain("posts", "delete", { role: "editor" });

		expect(result.allowed).toBe(true);
		// Both statements matched; the more specific one won
		expect(result.matched).toHaveLength(2);
		expect(result.matched.map((m) => m.specificity).sort()).toEqual([0, 1]);
		expect(result.decidedBy?.effect).toBe("allow");
		expect(result.decidedBy?.specificity).toBe(1);
		expect(result.reason).toContain("specificity 1");
	});

	it("names the deny under explicitDenyWins", () => {
		const policy = definePolicy<AppConfig>()
			.deny("posts", ["*"])
			.allow("posts", ["delete"], { contexts: [{ role: "editor" }] })
			.build();
		const { explain } = getAccessControl<AppConfig>(policy, {
			conflictResolution: "explicitDenyWins",
		});
		const result = explain("posts", "delete", { role: "editor" });

		expect(result.allowed).toBe(false);
		expect(result.strategy).toBe("explicitDenyWins");
		expect(result.decidedBy?.effect).toBe("deny");
		expect(result.decidedBy?.index).toBe(0);
	});

	it("surfaces the conditional deny that was skipped", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const policy = definePolicy<AppConfig>()
				.allow("posts", ["update"])
				.deny("posts", ["update"], { contexts: [{ region: "eu" }] })
				.build();
			const { explain } = getAccessControl<AppConfig>(policy);
			const result = explain("posts", "update", { role: "editor" });

			// This is the answer to "why is my deny not applying?"
			expect(result.allowed).toBe(true);
			expect(result.undecidedDenies).toHaveLength(1);
			expect(result.undecidedDenies[0]?.index).toBe(1);
			expect(result.reason).toContain("could not settle it");
		} finally {
			warn.mockRestore();
		}
	});

	it("reports no undecided denies once the context settles them", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"])
			.deny("posts", ["update"], { contexts: [{ region: "eu" }] })
			.build();
		const { explain } = getAccessControl<AppConfig>(policy);
		const result = explain("posts", "update", { region: "eu" });

		expect(result.allowed).toBe(false);
		expect(result.undecidedDenies).toEqual([]);
		expect(result.decidedBy?.effect).toBe("deny");
	});

	it("explains operator conditions and applies the default context", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"], {
				contexts: [{ "post.ownerId": { $ref: "user.id" } }],
			})
			.build();
		const { explain } = getAccessControl<AppConfig>(policy, {
			defaultContext: { user: { id: 7 } },
		});

		expect(explain("posts", "update", { post: { ownerId: 7 } }).allowed).toBe(
			true,
		);
		expect(explain("posts", "update", { post: { ownerId: 9 } }).allowed).toBe(
			false,
		);
	});

	it("is available on a store snapshot", () => {
		const policy = definePolicy<AppConfig>().allow("posts", ["read"]).build();
		const store = createAccessControlStore<AppConfig>(policy);
		const result = store.getSnapshot().explain("posts", "read");

		expect(result.allowed).toBe(true);
		expect(result.decidedBy?.effect).toBe("allow");
	});

	it("reflects the policy the snapshot was built with, not a later one", () => {
		const store = createAccessControlStore<AppConfig>([]);
		const stale = store.getSnapshot();

		store.updatePolicy(
			definePolicy<AppConfig>().allow("posts", ["read"]).build(),
		);

		expect(stale.explain("posts", "read").allowed).toBe(false);
		expect(store.getSnapshot().explain("posts", "read").allowed).toBe(true);
	});
});

describe("explain() agrees with can()", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	// A policy with overlapping allows, denies, operators and varying specificity
	const policy = definePolicy<AppConfig>()
		.deny("posts", ["*"], { contexts: [{ suspended: true }] })
		.allow("posts", ["read", "update"])
		.deny("posts", ["update"], { contexts: [{ status: "locked" }] })
		.allow("posts", ["update"], {
			contexts: [{ "post.ownerId": { $ref: "user.id" }, status: "draft" }],
		})
		.allow("posts", ["delete"], { contexts: [{ role: { $in: ["admin"] } }] })
		.build();

	const contexts = [
		undefined,
		{},
		{ suspended: true },
		{ status: "locked" },
		{ status: "draft" },
		{ role: "admin" },
		{ user: { id: 1 }, post: { ownerId: 1 }, status: "draft" },
		{ user: { id: 1 }, post: { ownerId: 2 }, status: "locked" },
		[{ role: "admin" }, { status: "draft" }],
	];

	const strategies = [
		"denyWins",
		"explicitDenyWins",
		"firstWins",
		"lastWins",
	] as const;

	it("returns the same verdict across every strategy and context", () => {
		try {
			for (const conflictResolution of strategies) {
				const { can, explain } = getAccessControl<AppConfig>(policy, {
					conflictResolution,
				});

				for (const action of ["read", "update", "delete"] as const) {
					for (const context of contexts) {
						expect(explain("posts", action, context).allowed).toBe(
							can("posts", action, context),
						);
					}
				}
			}
		} finally {
			warn.mockRestore();
		}
	});
});
