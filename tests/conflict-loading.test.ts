import { describe, it, expect, vi } from "vitest";
import { definePolicy, getAccessControl, createAccessControlStore } from "../src";

const config = {
  posts: ["read", "create", "update", "delete"],
  comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

describe("Conflict Resolution Strategies", () => {
  // Policy with conflicting rules:
  // 1. Allow read
  // 2. Deny read
  const conflictingPolicy = definePolicy<AppConfig>()
    .allow("posts", ["read"])
    .deny("posts", ["read"])
    .build();

  it("should default to denyWins", () => {
    const { can } = getAccessControl(conflictingPolicy);
    expect(can("posts", "read")).toBe(false);
  });

  it("should support denyWins explicit strategy", () => {
    const { can } = getAccessControl(conflictingPolicy, { conflictResolution: "denyWins" });
    expect(can("posts", "read")).toBe(false);
  });

  it("should support firstWins strategy", () => {
    // First rule is ALLOW
    const { can } = getAccessControl(conflictingPolicy, { conflictResolution: "firstWins" });
    expect(can("posts", "read")).toBe(true);
  });

  it("should support lastWins strategy", () => {
    // Last rule is DENY
    const { can } = getAccessControl(conflictingPolicy, { conflictResolution: "lastWins" });
    expect(can("posts", "read")).toBe(false);
  });

  it("should verify lastWins with reverse order", () => {
    // 1. Deny read
    // 2. Allow read
    const reversePolicy = definePolicy<AppConfig>()
      .deny("posts", ["read"])
      .allow("posts", ["read"])
      .build();

    const { can } = getAccessControl(reversePolicy, { conflictResolution: "lastWins" });
    expect(can("posts", "read")).toBe(true);
  });
});

describe("Loading State", () => {
  it("should initialize with isLoading: false by default", () => {
    const store = createAccessControlStore<AppConfig>([]);
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("should update isLoading via setLoading", () => {
    const store = createAccessControlStore<AppConfig>([]);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setLoading(true);
    
    expect(store.getSnapshot().isLoading).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setLoading(false);
    expect(store.getSnapshot().isLoading).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("should update isLoading via updatePolicy", () => {
    const store = createAccessControlStore<AppConfig>([]);
    
    // Set loading to true
    store.setLoading(true);
    expect(store.getSnapshot().isLoading).toBe(true);

    // Update policy and turn off loading
    store.updatePolicy([], undefined, { isLoading: false });
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("should maintain isLoading state if not specified in updatePolicy", () => {
    const store = createAccessControlStore<AppConfig>([]);
    store.setLoading(true);

    store.updatePolicy([]); // isLoading should remain true
    expect(store.getSnapshot().isLoading).toBe(true);
  });
});
