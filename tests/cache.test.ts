import { describe, expect, it } from "vitest";
import type { TAccessControlStatement } from "../src";
import { createAccessControlStore } from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

const basePolicy = [
	{ resource: "posts", actions: ["read", "create"], effect: "allow" },
	{ resource: "comments", actions: ["create"], effect: "allow" },
] as const;

type PostAction = AppConfig["posts"][number];

/**
 * A policy whose single condition counts how many times it is evaluated. Matching reads
 * the condition's value, so the getter fires once per evaluation; a cache hit skips
 * evaluation entirely, which is what lets these tests observe caching directly.
 *
 * This replaces clearing the policy array in place. The policy is now grouped by resource
 * when the instance is built, so a later in-place mutation is invisible to the evaluator
 * and can no longer be used to detect a cache hit.
 */
const countingPolicy = (actions: readonly PostAction[] = ["read"]) => {
	let evaluations = 0;
	const policy: TAccessControlStatement<AppConfig>[] = [
		{
			resource: "posts",
			actions,
			effect: "allow",
			contexts: [
				{
					get role() {
						evaluations++;
						return "admin";
					},
				},
			],
		},
	];
	return { policy, evaluations: () => evaluations };
};

describe("Result caching (options.cache)", () => {
	it("returns the same result on repeated can() calls (smoke test)", () => {
		const store = createAccessControlStore<AppConfig>(basePolicy, {
			cache: true,
		});
		const snap = store.getSnapshot();

		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "delete")).toBe(false);
		expect(snap.can("posts", "delete")).toBe(false);
	});

	it("caches results — a second identical can() is not re-evaluated", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
		expect(evaluations()).toBe(1);

		expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
		expect(evaluations()).toBe(1); // served from cache, not re-evaluated
	});

	it("without cache, results are re-evaluated on each call", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: false,
		}).getSnapshot();

		expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
		expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
		expect(evaluations()).toBe(2);
	});

	it("cache is invalidated after updatePolicy()", () => {
		const store = createAccessControlStore<AppConfig>(basePolicy, {
			cache: true,
		});

		expect(store.getSnapshot().can("posts", "delete")).toBe(false);

		store.updatePolicy([
			...basePolicy,
			{ resource: "posts", actions: ["delete"], effect: "allow" },
		]);

		// New snapshot — cache was discarded, fresh evaluation
		expect(store.getSnapshot().can("posts", "delete")).toBe(true);
	});

	it("cache is invalidated after setLoading()", () => {
		const store = createAccessControlStore<AppConfig>(basePolicy, {
			cache: true,
		});
		const snap1 = store.getSnapshot();

		expect(snap1.can("posts", "read")).toBe(true);

		store.setLoading(true);
		const snap2 = store.getSnapshot();

		// snap2 is a new snapshot with a fresh cache
		expect(snap2).not.toBe(snap1);
		expect(snap2.can("posts", "read")).toBe(true); // result still correct
	});

	it("canAll() serves each action from cache on repeated calls", () => {
		const { policy, evaluations } = countingPolicy(["read", "create"]);
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.canAll("posts", ["read", "create"], { role: "admin" })).toBe(
			true,
		);
		expect(evaluations()).toBe(2); // one per action

		expect(snap.canAll("posts", ["read", "create"], { role: "admin" })).toBe(
			true,
		);
		expect(evaluations()).toBe(2); // both actions came from cache
	});

	it("canAny() and canThese() share the same cache as can()", () => {
		const { policy, evaluations } = countingPolicy(["read", "create"]);
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
		const afterCan = evaluations();

		expect(snap.canAny("posts", ["read"], { role: "admin" })).toBe(true);
		expect(evaluations()).toBe(afterCan);

		expect(snap.canThese("posts", ["read"], { role: "admin" })).toEqual({
			read: true,
		});
		expect(evaluations()).toBe(afterCan);
	});

	it("cache key is stable regardless of context key order", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { role: "admin", tenant: 1 })).toBe(true);
		expect(evaluations()).toBe(1);

		// Same logical context, keys in the other order — same key, so a cache hit
		expect(snap.can("posts", "read", { tenant: 1, role: "admin" })).toBe(true);
		expect(evaluations()).toBe(1);
	});

	it("correct results without cache (options.cache omitted)", () => {
		const store = createAccessControlStore<AppConfig>(basePolicy);
		const snap = store.getSnapshot();

		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "delete")).toBe(false);
	});

	it("correct results without cache (options.cache: false)", () => {
		const store = createAccessControlStore<AppConfig>(basePolicy, {
			cache: false,
		});
		const snap = store.getSnapshot();

		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "read")).toBe(true);
		expect(snap.can("posts", "delete")).toBe(false);
	});
});

describe("Result cache correctness", () => {
	// Mirrors CACHE_MAX_ENTRIES in src/core/policy.ts
	const CAP = 500;

	it("matches plain objects structurally, so they can share a cache entry", () => {
		const tenantA = { id: 1 };
		const tenantB = { id: 1 }; // structurally identical, different reference
		const policy: TAccessControlStatement<AppConfig>[] = [
			{
				resource: "posts",
				actions: ["read"],
				effect: "allow",
				contexts: [{ tenant: tenantA }],
			},
		];

		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { tenant: tenantA })).toBe(true);
		// Plain objects compare by value, so tenantB matches too and the shared cache
		// key is faithful rather than a collision
		expect(snap.can("posts", "read", { tenant: tenantB })).toBe(true);
		expect(snap.can("posts", "read", { tenant: { id: 2 } })).toBe(false);
	});

	it("keeps reference semantics for values it cannot compare by value", () => {
		// A Map is not a plain object, so equality stays by reference — and a serialized
		// cache key must therefore not be used for it
		const groupsA = new Map([["id", 1]]);
		const groupsB = new Map([["id", 1]]);
		const policy: TAccessControlStatement<AppConfig>[] = [
			{
				resource: "posts",
				actions: ["read"],
				effect: "allow",
				contexts: [{ groups: groupsA }],
			},
		];

		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { groups: groupsA })).toBe(true);
		// If this were cached under a structural key it would wrongly answer true
		expect(snap.can("posts", "read", { groups: groupsB })).toBe(false);
	});

	it("caches nested contexts, which $ref conditions depend on", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		snap.can("posts", "read", { role: "admin", user: { id: 7 } });
		expect(evaluations()).toBe(1);

		// A fresh object of the same shape — nested values used to make a context
		// uncacheable, so this re-evaluated every time
		snap.can("posts", "read", { role: "admin", user: { id: 7 } });
		expect(evaluations()).toBe(1);
	});

	it("caches Date contexts by timestamp", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		snap.can("posts", "read", { role: "admin", at: new Date("2026-01-01") });
		expect(evaluations()).toBe(1);

		snap.can("posts", "read", { role: "admin", at: new Date("2026-01-01") });
		expect(evaluations()).toBe(1);

		snap.can("posts", "read", { role: "admin", at: new Date("2026-06-01") });
		expect(evaluations()).toBe(2); // a different instant is a different key
	});

	it("does not conflate primitives of different types in cache keys", () => {
		const policy: TAccessControlStatement<AppConfig>[] = [
			{
				resource: "posts",
				actions: ["read"],
				effect: "allow",
				contexts: [{ level: 1 }],
			},
		];

		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(snap.can("posts", "read", { level: 1 })).toBe(true);
		expect(snap.can("posts", "read", { level: "1" })).toBe(false);
		expect(snap.can("posts", "read", { level: true })).toBe(false);
	});

	it("caches array contexts regardless of their order", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		expect(
			snap.can("posts", "read", [{ role: "viewer" }, { role: "admin" }]),
		).toBe(true);
		const afterFirst = evaluations();

		// Same contexts in the other order — OR matching makes order irrelevant, so it's a hit
		expect(
			snap.can("posts", "read", [{ role: "admin" }, { role: "viewer" }]),
		).toBe(true);
		expect(evaluations()).toBe(afterFirst);
	});

	it("evicts the least recently used entry once the cache is full", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		snap.can("posts", "read", { role: "admin", id: 0 }); // first entry in
		for (let i = 1; i <= CAP; i++) {
			snap.can("posts", "read", { role: "admin", id: i }); // one past capacity
		}
		expect(evaluations()).toBe(CAP + 1);

		// {id:0} was least recently used and has been evicted → evaluated again
		snap.can("posts", "read", { role: "admin", id: 0 });
		expect(evaluations()).toBe(CAP + 2);

		// The newest entry is still cached
		snap.can("posts", "read", { role: "admin", id: CAP });
		expect(evaluations()).toBe(CAP + 2);
	});

	it("keeps a recently read entry alive when the cache overflows", () => {
		const { policy, evaluations } = countingPolicy();
		const snap = createAccessControlStore<AppConfig>(policy, {
			cache: true,
		}).getSnapshot();

		snap.can("posts", "read", { role: "admin", id: 0 });
		for (let i = 1; i < CAP; i++) {
			snap.can("posts", "read", { role: "admin", id: i }); // cache exactly full
		}
		snap.can("posts", "read", { role: "admin", id: 0 }); // hit: refreshes to newest
		expect(evaluations()).toBe(CAP);

		snap.can("posts", "read", { role: "admin", id: CAP }); // overflow → evicts {id:1}
		const before = evaluations();

		snap.can("posts", "read", { role: "admin", id: 0 }); // survived: recently read
		expect(evaluations()).toBe(before);

		snap.can("posts", "read", { role: "admin", id: 1 }); // evicted as least recently used
		expect(evaluations()).toBe(before + 1);
	});
});
