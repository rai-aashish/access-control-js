import { describe, expect, it, vi } from "vitest";
import { definePolicy, getAccessControl } from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

// A deny that only applies to locked posts, over an unconditional allow.
const lockedPolicy = definePolicy<AppConfig>()
	.allow("posts", ["delete"])
	.deny("posts", ["delete"], { contexts: [{ status: "locked" }] })
	.build();

/**
 * A condition the context cannot settle is *unknown*, which is not the same as one that
 * provably does not apply. An unknown deny is skipped — it fails open — so the distinction
 * is what lets explain() report it and the dev warning surface it. Without three-valued
 * judging there would be no way to tell the two apart.
 */
describe("Undecidable denies", () => {
	const explainDelete = (context?: Record<string, unknown>) =>
		getAccessControl<AppConfig>(lockedPolicy).explain(
			"posts",
			"delete",
			context,
		);

	it("skips a deny it cannot judge, and reports it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = explainDelete();

			expect(result.allowed).toBe(true); // fails open
			expect(result.undecidedDenies).toHaveLength(1);
			expect(result.undecidedDenies[0]?.index).toBe(1);
			expect(result.reason).toContain("could not settle it");
		} finally {
			warn.mockRestore();
		}
	});

	it("still cannot judge it when the context omits the key it names", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// role is supplied but status is not
			const result = explainDelete({ role: "admin" });

			expect(result.allowed).toBe(true);
			expect(result.undecidedDenies).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("judges it once the context settles the question", () => {
		const notApplying = explainDelete({ status: "draft" });
		expect(notApplying.allowed).toBe(true);
		expect(notApplying.undecidedDenies).toEqual([]); // decided, not skipped

		const applying = explainDelete({ status: "locked" });
		expect(applying.allowed).toBe(false);
		expect(applying.undecidedDenies).toEqual([]);
		expect(applying.decidedBy?.effect).toBe("deny");
	});

	it("settles a condition on a definite failure even when another clause is unknown", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["update"])
			.deny("posts", ["update"], {
				contexts: [{ status: "locked", tenant: "acme" }],
			})
			.build();

		// tenant provably differs, so the deny cannot apply whatever status is —
		// false AND unknown is false, so this is decided rather than skipped
		const result = getAccessControl<AppConfig>(policy).explain(
			"posts",
			"update",
			{ tenant: "globex" },
		);

		expect(result.allowed).toBe(true);
		expect(result.undecidedDenies).toEqual([]);
	});

	it("tracks denies only — an undecidable allow simply grants nothing", () => {
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["read"], { contexts: [{ role: "editor" }] })
			.build();

		const result = getAccessControl<AppConfig>(policy).explain("posts", "read");

		expect(result.allowed).toBe(false);
		expect(result.undecidedDenies).toEqual([]);
	});

	it("reports every undecidable deny, not just the first", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const policy = definePolicy<AppConfig>()
				.allow("posts", ["create"])
				.deny("posts", ["create"], { contexts: [{ region: "eu" }] })
				.deny("posts", ["create"], { contexts: [{ quotaExceeded: true }] })
				.build();

			const result = getAccessControl<AppConfig>(policy).explain(
				"posts",
				"create",
			);

			expect(result.undecidedDenies).toHaveLength(2);
			expect(result.reason).toContain("2 conditional denies");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("Development warnings", () => {
	it("warns once when a conditional deny is skipped", () => {
		// A message unique to this test: warnings are deduplicated by their text.
		const policy = definePolicy<AppConfig>()
			.allow("comments", ["delete"])
			.deny("comments", ["delete"], { contexts: [{ ownerId: 7 }] })
			.build();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { can } = getAccessControl<AppConfig>(policy);

			expect(can("comments", "delete")).toBe(true);
			can("comments", "delete"); // same message — must not warn again

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("ownerId");
			expect(warn.mock.calls[0]?.[0]).toContain("Pass those keys");
		} finally {
			warn.mockRestore();
		}
	});

	it("warns when a context object is passed where options belong", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			getAccessControl<AppConfig>(lockedPolicy, {
				// @ts-expect-error — a bare context object is no longer accepted here
				tenantId: "abc",
			});

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("defaultContext");
		} finally {
			warn.mockRestore();
		}
	});
});
