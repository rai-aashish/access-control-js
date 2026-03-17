import { describe, it, expect } from "vitest";
import { definePolicy, mergePolicies, getAccessControl } from "../src";

const config = {
  posts: ["read", "create", "update", "delete"],
  comments: ["create", "delete"],
  admin: ["manage_users"],
} as const;

type AppConfig = typeof config;

describe("Policy Builder", () => {
  it("should build a simple allow policy", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["read", "create"])
      .build();

    expect(policy).toHaveLength(1);
    expect(policy[0]).toEqual({
      resource: "posts",
      actions: ["read", "create"],
      effect: "allow",
      contexts: undefined,
    });
  });

  it("should chain allow and deny statements", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["read"])
      .deny("posts", ["delete"])
      .build();

    expect(policy).toHaveLength(2);
    expect(policy[0].effect).toBe("allow");
    expect(policy[1].effect).toBe("deny");
  });

  it("should handle wildcard actions", () => {
    const policy = definePolicy<AppConfig>()
      .allow("comments", ["*"])
      .build();

    expect(policy[0].actions).toEqual(["*"]);
  });

  it("should include contexts when provided", () => {
    const policy = definePolicy<AppConfig>()
      .allow("admin", ["manage_users"], { contexts: [{ role: "superadmin" }] })
      .build();

    expect(policy[0].contexts).toEqual([{ role: "superadmin" }]);
  });

  it("should work with getAccessControl", () => {
    const policy = definePolicy<AppConfig>()
      .allow("posts", ["read"])
      .deny("posts", ["delete"])
      .build();

    const { can } = getAccessControl(policy,{contexts:[{role:"admin"}]});

    expect(can("posts", "read")).toBe(true);
    expect(can("posts", "delete")).toBe(false);


  });
});

describe("mergePolicies", () => {
  it("should merge two policy arrays", () => {
    const policy1 = definePolicy<AppConfig>().allow("posts", ["read"]).build();
    const policy2 = definePolicy<AppConfig>().allow("comments", ["create"]).build();

    const merged = mergePolicies(policy1, policy2);

    expect(merged).toHaveLength(2);
    expect(merged[0].resource).toBe("posts");
    expect(merged[1].resource).toBe("comments");
  });

  it("should flatten nested arrays correctly", () => {
    const p1 = [{ resource: "a", actions: [], effect: "allow" }] as any;
    const p2 = [{ resource: "b", actions: [], effect: "allow" }] as any;
    
    const merged = mergePolicies(p1, p2);
    expect(merged).toHaveLength(2);
  });

  it("should be compatible with getAccessControl after merging", () => {
    const basePolicy = definePolicy<AppConfig>().allow("posts", ["read"]).build();
    const adminPolicy = definePolicy<AppConfig>().allow("posts", ["delete"]).build();

    // Merging: adminPolicy comes later, but order doesn't strictly matter for distinct permissions.
    // For conflicting permissions, specificity rules apply.
    const merged = mergePolicies(basePolicy, adminPolicy);

    const { can } = getAccessControl(merged);

    expect(can("posts", "read")).toBe(true);
    expect(can("posts", "delete")).toBe(true);
  });
});
