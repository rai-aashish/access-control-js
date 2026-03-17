import { describe, it, expect } from "vitest";
import { definePolicy, getAccessControl } from "../src";

const config = {
  posts: ["read", "create", "update", "delete"],
  comments: ["create", "delete"],
  billing: ["view", "manage"],
} as const;

type AppConfig = typeof config;

describe("Policy Contexts (ABAC)", () => {
  it("should respect contexts defined in the policy", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["read"], { contexts: [{ public: true }] })
      .build();
      

    const { can } = getAccessControl(policy);

    // Should fail without context
    expect(can("posts", "read")).toBe(false);
    // Should pass with matching context
    expect(can("posts", "read", { public: true })).toBe(true);
    // Should fail with non-matching context
    expect(can("posts", "read", { public: false })).toBe(false);
  });

  it("should merge default context with check context", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["create"], { contexts: [{ role: "admin", churchId: "123" }] })
      .build();

    // Initialize with a default context (e.g. tenant ID)
    const { can } = getAccessControl(policy, { churchId: "123" });

    // Calling with just the role should pass, because churchId is provided by default
    expect(can("posts", "create", { role: "admin" })).toBe(true);

    // Explicit context overrides default: if we pass a different churchId, it should fail
    expect(can("posts", "create", { role: "admin", churchId: "456" })).toBe(false);
  });

  it("should handle multiple allowed contexts (OR logic)", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["update"], {
        contexts: [
          { role: "owner" },
          { role: "editor", status: "draft" }
        ]
      })
      .build();

    const { can } = getAccessControl(policy);

    // Schema 1: owner can update anything
    expect(can("posts", "update", { role: "owner", status: "published" })).toBe(true);

    // Schema 2: editor can only update if status is draft
    expect(can("posts", "update", { role: "editor", status: "draft" })).toBe(true);
    expect(can("posts", "update", { role: "editor", status: "published" })).toBe(false);
  });

  it("should work with canAll and mixed contexts", () => {
    const policy = definePolicy<AppConfig>()
      .allow("billing", ["view"], { contexts: [{ role: "accountant" }] })
      .allow("billing", ["manage"], { contexts: [{ role: "admin" }] })
      .build();

    const { canAll } = getAccessControl(policy);

    // Admin can view AND manage?
    // Wait, the policy says:
    // view -> requires accountant
    // manage -> requires admin
    // If I pass { role: 'admin' }, can I view? NO, because view requires role: accountant.
    
    // Let's adjust the policy to make sense for a single user with multiple roles or a role that inherits.
    // But for this test, let's test that canAll properly checks each action against the context.
    
    expect(canAll("billing", ["manage"], { role: "admin" })).toBe(true);
    expect(canAll("billing", ["view"], { role: "accountant" })).toBe(true);
    
    // If I have both traits (e.g. context object has both properties if the logic supported arrays of roles better, 
    // but here we match exact keys. distinct roles usually means distinct checks).
    // Let's test a failure case:
    expect(canAll("billing", ["view", "manage"], { role: "admin" })).toBe(false); 
    // ^ Fails because 'view' requires 'accountant', and we only passed 'admin'.
  });

  it("should use default context in canAll checks", () => {
    const policy = definePolicy<AppConfig>()
      .allow("comments", ["delete"], { contexts: [{ role: "moderator", churchId: "123" }] })
      .build();

    const { canAll } = getAccessControl(policy, { churchId: "123" });

    // Should pass because churchId comes from default, role comes from explicit
    expect(canAll("comments", ["delete"], { role: "moderator" })).toBe(true);
  });
});
