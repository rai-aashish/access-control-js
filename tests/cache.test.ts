import { describe, it, expect } from "vitest";
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

describe("Result caching (options.cache)", () => {
    it("returns the same result on repeated can() calls (smoke test)", () => {
        const store = createAccessControlStore<AppConfig>(basePolicy, { cache: true });
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "delete")).toBe(false);
        expect(snap.can("posts", "delete")).toBe(false);
    });

    it("caches results — second identical can() is served from cache, not re-evaluated", () => {
        // Use a mutable array so we can prove re-evaluation doesn't happen
        const mutablePolicy: any[] = [
            { resource: "posts", actions: ["read"], effect: "allow" },
        ];

        const store = createAccessControlStore<AppConfig>(mutablePolicy, { cache: true });
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read")).toBe(true); // evaluates + caches

        // Silently clear the policy array, bypassing updatePolicy (no new snapshot)
        mutablePolicy.length = 0;

        // With cache: still true — result came from cache, not re-evaluated against empty policy
        expect(snap.can("posts", "read")).toBe(true);
    });

    it("without cache, results are re-evaluated on each call", () => {
        const mutablePolicy: any[] = [
            { resource: "posts", actions: ["read"], effect: "allow" },
        ];

        const store = createAccessControlStore<AppConfig>(mutablePolicy, { cache: false });
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read")).toBe(true); // evaluates

        mutablePolicy.length = 0; // clear policy, no new snapshot

        // Without cache: re-evaluates against the now-empty policy → false
        expect(snap.can("posts", "read")).toBe(false);
    });

    it("cache is invalidated after updatePolicy()", () => {
        const store = createAccessControlStore<AppConfig>(basePolicy, { cache: true });

        expect(store.getSnapshot().can("posts", "delete")).toBe(false);

        store.updatePolicy([
            ...basePolicy,
            { resource: "posts", actions: ["delete"], effect: "allow" },
        ]);

        // New snapshot — cache was discarded, fresh evaluation
        expect(store.getSnapshot().can("posts", "delete")).toBe(true);
    });

    it("cache is invalidated after setLoading()", () => {
        const store = createAccessControlStore<AppConfig>(basePolicy, { cache: true });
        const snap1 = store.getSnapshot();

        expect(snap1.can("posts", "read")).toBe(true);

        store.setLoading(true);
        const snap2 = store.getSnapshot();

        // snap2 is a new snapshot with a fresh cache
        expect(snap2).not.toBe(snap1);
        expect(snap2.can("posts", "read")).toBe(true); // result still correct
    });

    it("canAll() serves each action from cache on repeated calls", () => {
        const mutablePolicy: any[] = [
            { resource: "posts", actions: ["read", "create"], effect: "allow" },
        ];

        const store = createAccessControlStore<AppConfig>(mutablePolicy, { cache: true });
        const snap = store.getSnapshot();

        snap.canAll("posts", ["read", "create"]); // caches "read" and "create" individually

        mutablePolicy.length = 0; // clear policy

        // canAll calls can() per action — both hit the cache
        expect(snap.canAll("posts", ["read", "create"])).toBe(true);
    });

    it("cache key is stable regardless of context key order", () => {
        const mutablePolicy: any[] = [
            {
                resource: "posts",
                actions: ["read"],
                effect: "allow",
                contexts: [{ role: "admin" }],
            },
        ];

        const store = createAccessControlStore<AppConfig>(mutablePolicy, { cache: true });
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read", { role: "admin" })).toBe(true); // evaluates + caches

        mutablePolicy.length = 0; // clear policy

        // Same logical context — same stable cache key → cache hit
        expect(snap.can("posts", "read", { role: "admin" })).toBe(true);
    });

    it("correct results without cache (options.cache omitted)", () => {
        const store = createAccessControlStore<AppConfig>(basePolicy);
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "delete")).toBe(false);
    });

    it("correct results without cache (options.cache: false)", () => {
        const store = createAccessControlStore<AppConfig>(basePolicy, { cache: false });
        const snap = store.getSnapshot();

        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "read")).toBe(true);
        expect(snap.can("posts", "delete")).toBe(false);
    });
});
