import { describe, expect, it, vi } from "vitest";
import { createAccessControlStore, definePolicy } from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
	comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

const policyA = definePolicy<AppConfig>().allow("posts", ["read"]).build();
const policyB = definePolicy<AppConfig>().allow("posts", ["create"]).build();

/**
 * These pin the contract a framework binding depends on. `useSyncExternalStore` decides
 * whether to re-render by comparing snapshot references, so "stable until something
 * changes" is an API guarantee, not an implementation detail — and the binding now lives
 * in a separate package that cannot see this code.
 */
describe("Store snapshot identity", () => {
	it("returns the same reference until something changes", () => {
		const store = createAccessControlStore<AppConfig>(policyA);

		const first = store.getSnapshot();
		expect(store.getSnapshot()).toBe(first);
		// Reading through the snapshot must not invalidate it
		first.can("posts", "read");
		expect(store.getSnapshot()).toBe(first);
	});

	it("returns a new reference after updatePolicy", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const before = store.getSnapshot();

		store.updatePolicy(policyB);

		expect(store.getSnapshot()).not.toBe(before);
	});

	it("returns a new reference after setLoading changes the state", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const before = store.getSnapshot();

		store.setLoading(true);

		expect(store.getSnapshot()).not.toBe(before);
		expect(store.getSnapshot().isLoading).toBe(true);
	});

	it("keeps the reference when setLoading is given the value it already has", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const before = store.getSnapshot();

		store.setLoading(false);

		expect(store.getSnapshot()).toBe(before);
	});

	it("keeps the reference when updatePolicy changes nothing", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const before = store.getSnapshot();

		store.updatePolicy(policyA);

		expect(store.getSnapshot()).toBe(before);
	});

	it("returns a new reference when only the default context changes", () => {
		const store = createAccessControlStore<AppConfig>(policyA, {
			defaultContext: { tenant: "acme" },
		});
		const before = store.getSnapshot();

		store.updatePolicy(policyA, { tenant: "globex" });

		expect(store.getSnapshot()).not.toBe(before);
	});

	it("exposes the policy it was built with on the snapshot", () => {
		const store = createAccessControlStore<AppConfig>(policyA);

		expect(store.getSnapshot().policy).toBe(policyA);
		store.updatePolicy(policyB);
		expect(store.getSnapshot().policy).toBe(policyB);
	});
});

describe("Store subscriptions", () => {
	it("notifies subscribers exactly once per real change", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const listener = vi.fn();
		store.subscribe(listener);

		store.updatePolicy(policyB);
		expect(listener).toHaveBeenCalledTimes(1);

		store.setLoading(true);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("does not notify on a no-op update", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const listener = vi.fn();
		store.subscribe(listener);

		store.updatePolicy(policyA);
		store.setLoading(false);

		expect(listener).not.toHaveBeenCalled();
	});

	it("stops notifying after the returned cleanup runs", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const listener = vi.fn();

		const unsubscribe = store.subscribe(listener);
		store.updatePolicy(policyB);
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		store.updatePolicy(policyA);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("supports several independent subscribers", () => {
		const store = createAccessControlStore<AppConfig>(policyA);
		const first = vi.fn();
		const second = vi.fn();

		const stopFirst = store.subscribe(first);
		store.subscribe(second);

		store.updatePolicy(policyB);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);

		stopFirst();
		store.updatePolicy(policyA);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it("drives a useSyncExternalStore-shaped consumer", () => {
		const store = createAccessControlStore<AppConfig>(policyA);

		// What the hook does: read a snapshot, re-read on notification, render when the
		// reference changed
		const renders: boolean[] = [];
		let current = store.getSnapshot();
		renders.push(current.can("posts", "create"));

		const unsubscribe = store.subscribe(() => {
			const next = store.getSnapshot();
			if (next !== current) {
				current = next;
				renders.push(current.can("posts", "create"));
			}
		});

		store.updatePolicy(policyB); // grants create
		store.updatePolicy(policyB); // no-op, must not re-render
		store.updatePolicy(policyA); // revokes it again
		unsubscribe();

		expect(renders).toEqual([false, true, false]);
	});
});
