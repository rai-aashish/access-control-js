import { describe, it, expect } from "vitest";
import { createAccessControl, getAccessControl } from "../src";

const config = {
  posts: ["read", "create", "update", "delete"],
  comments: ["create", "delete"],
} as const;

type AppConfig = typeof config;

describe("Access Control Smoke Tests", () => {
  it("should evaluate access correctly (server-side)", () => {
    const policy = [
      {
        resource: "posts",
        actions: ["read"],
        effect: "allow",
      },
    ] as const;

    const { can } = getAccessControl<AppConfig>(policy);

    expect(can("posts", "read")).toBe(true);
    expect(can("posts", "create")).toBe(false);
  });

  it("should evaluate access correctly (client-side/store)", () => {
    const store = createAccessControl<AppConfig>([]);

    expect(store.getSnapshot().can("posts", "read")).toBe(false);

    store.updatePolicy([
      {
        resource: "posts",
        actions: ["read", "create"],
        effect: "allow",
      },
    ]);

    expect(store.getSnapshot().can("posts", "read")).toBe(true);
    expect(store.getSnapshot().can("posts", "create")).toBe(true);
    expect(store.getSnapshot().can("posts", "delete")).toBe(false);
  });
});

describe("Default Context", () => {
  const contextPolicy = [
    {
      resource: "posts",
      actions: ["read"],
      effect: "allow",
      contexts: [{ churchId: "123" }],
    },
    {
      resource: "posts",
      actions: ["create"],
      effect: "allow",
      contexts: [{ churchId: "123", role: "admin" }],
    },
  ] as const;

  it("should auto-apply default context (server-side)", () => {
    const { can } = getAccessControl<AppConfig>(contextPolicy, {
      churchId: "123",
    });

    // Default context matches => allowed
    expect(can("posts", "read")).toBe(true);
    // Needs role: admin too, default only has churchId
    expect(can("posts", "create")).toBe(false);
    // Explicit context overrides default
    expect(can("posts", "create", { churchId: "123", role: "admin" })).toBe(
      true,
    );
  });

  it("should auto-apply default context (client-side/store)", () => {
    const store = createAccessControl<AppConfig>(contextPolicy, {
      churchId: "123",
    });

    const { can } = store.getSnapshot();
    expect(can("posts", "read")).toBe(true);
    expect(can("posts", "create")).toBe(false);
  });

  it("should allow updating default context via updatePolicy", () => {
    const store = createAccessControl<AppConfig>([], { churchId: "old" });

    store.updatePolicy(contextPolicy, { churchId: "123" });

    const { can } = store.getSnapshot();
    expect(can("posts", "read")).toBe(true);
  });

  it("should merge explicit context over default context", () => {
    const store = createAccessControl<AppConfig>(contextPolicy, {
      churchId: "123",
    });

    const { can } = store.getSnapshot();
    // Default context has churchId, explicit adds role
    expect(can("posts", "create", { role: "admin" })).toBe(true);
    // Wrong explicit overrides default
    expect(can("posts", "read", { churchId: "999" })).toBe(false);
  });
});
