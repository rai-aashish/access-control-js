import { describe, it, expect } from "vitest";
import { definePolicy, getAccessControl } from "../src";

// Define a comprehensive config for our scenarios
const config = {
  budget: ["view", "create", "approve", "delete"],
  document: ["read", "write", "delete", "publish"],
  system: ["reboot", "backup", "restore", "update", "*"], // * is implicitly supported by the logic
  post: ["read", "create", "update", "delete", "publish"],
} as const;

type AppConfig = typeof config;

describe("Production Scenarios", () => {
  describe("Scenario 1: RBAC + ABAC Hybrid (Department Head)", () => {
    // Policy:
    // - Employees can view budgets.
    // - Managers can create/approve budgets ONLY for their department.
    const policy = definePolicy<AppConfig>()
      .allow("budget", ["view"], { contexts: [{ role: "employee" }] })
      .allow("budget", ["create", "approve"], {
        contexts: [
          { role: "manager", department: "engineering" },
          { role: "manager", department: "marketing" },
          // A generic rule could be just { role: "manager" } but we want strict department matching in the policy
          // Ideally, we'd use a dynamic matcher, but for this static engine, we match properties.
          // Let's model it as: Access is granted if context matches.
        ],
      })
      .build();

    const { can } = getAccessControl(policy);

    it("allows employees to view", () => {
        expect(can("budget", "view", { role: "employee" })).toBe(true);
    });

    it("prevents employees from approving", () => {
        expect(can("budget", "approve", { role: "employee" })).toBe(false);
    });

    it("allows managers to approve their own department budget", () => {
        // Engineering manager approving engineering budget
        expect(can("budget", "approve", { role: "manager", department: "engineering" })).toBe(true);
    });

    it("prevents managers from approving other departments (implicit deny)", () => {
        // Engineering manager trying to match 'marketing' rules? 
        // The policy has a rule for { role: "manager", department: "marketing" }.
        // If I pass { role: "manager", department: "engineering" }, it does NOT match the marketing rule.
        // It DOES match the engineering rule.
        // If I pass { role: "manager", department: "sales" }, it matches neither.
        expect(can("budget", "approve", { role: "manager", department: "sales" })).toBe(false);
    });
    
    it("prevents cross-department approval context mismatch", () => {
         // This tests that to approve, you must supply the context that matches a rule.
         // In a real app, 'department' might be efficiently checked by ensuring the User's department == Resource's department.
         // Here we simulate that the *context* passed to `can` contains the required attributes.
         expect(can("budget", "approve", { role: "manager", department: "marketing" })).toBe(true);
    });
  });

  describe("Scenario 2: Deny Overrides (Blacklist)", () => {
    // Policy:
    // - Users can read documents.
    // - BUT, no one can read 'restricted' documents (unless maybe super admin, but let's keep it simple).
    
    const policy = definePolicy<AppConfig>()
      .allow("document", ["read"], { contexts: [{ role: "user" }] })
      .deny("document", ["read"], { contexts: [{ classification: "restricted" }] })
      .build();

    // Default strategy is denyWins
    const { can } = getAccessControl(policy, { conflictResolution: "denyWins" });

    it("allows user to read normal documents", () => {
      expect(can("document", "read", { role: "user", classification: "public" })).toBe(true);
    });

    it("denies user reading restricted documents", () => {
      expect(can("document", "read", { role: "user", classification: "restricted" })).toBe(false);
    });

    it("denies access if only classification matches (must have Allow role too)", () => {
        // If I am NOT a user, I shouldn't have access even if public.
        expect(can("document", "read", { role: "guest", classification: "public" })).toBe(false);
    });
  });

  describe("Scenario 3: Wildcards & Super Admin", () => {
    const policy = definePolicy<AppConfig>()
      .allow("system", ["*"], { contexts: [{ role: "super_admin" }] })
      .build();

    const { can } = getAccessControl(policy);

    it("allows super admin to do anything on system", () => {
      expect(can("system", "reboot", { role: "super_admin" })).toBe(true);
      expect(can("system", "backup", { role: "super_admin" })).toBe(true);
    });

    it("denies others", () => {
        expect(can("system", "reboot", { role: "admin" })).toBe(false);
    });
  });

  describe("Scenario 4: Multi-Profile User (Dual Role)", () => {
    // Policy:
    // - Member can view.
    // - Moderator can delete.
    const policy = definePolicy<AppConfig>()
      .allow("post", ["read"], { contexts: [{ role: "member" }] })
      .allow("post", ["delete"], { contexts: [{ role: "moderator" }] })
      // Let's add a complex one: VIP member can publish
      .allow("post", ["publish"], { contexts: [{ role: "member", status: "vip" }] })
      .build();

    const { can } = getAccessControl(policy);

    it("allows actions based on multiple merged contexts", () => {
      // User has multiple roles/attributes. We pass them as an array.
      // The engine implementation should check if ANY context object in the array satisfies the policy (or if the specialized `mergeContext` logic handles it).
      
      // Actually, let's verify how `evaluateAccess` works. 
      // It iterates through inputContexts. If ANY input context matches the policy condition, access is granted?
      // Re-reading `policy.ts`:
      // `inputContexts.forEach(inputContext => { ... if (allKeysMatch) ... })`
      // Yes, if any of the provided contexts matches the policy requirement, it's a match.
      
      const userContexts = [
          { role: "member", status: "regular" },
          { role: "moderator" }
      ];

      // Should be able to read (because of member role)
      expect(can("post", "read", userContexts)).toBe(true);

      // Should be able to delete (because of moderator role)
      expect(can("post", "delete", userContexts)).toBe(true);

      // Should NOT be able to publish (needs member + vip)
      expect(can("post", "publish", userContexts)).toBe(false);
    });
    
    it("allows actions when one context satisfies a complex condition", () => {
        const vipUserContexts = [
            { role: "member", status: "vip" },
            { role: "editor" }
        ];
        expect(can("post", "publish", vipUserContexts)).toBe(true);
    });
  });

  describe("Scenario 5: Conflict Resolution (Ordering)", () => {
      // Resource: document
      // Rule 1: Allow all (generic)
      // Rule 2: Deny specific (exception)
      
      // In a "firstWins" scenario, if we put Allow first, Deny is ignored.
      // In a "lastWins" scenario, if Deny is last, it overrides.
      
      const setupPolicy = () => definePolicy<AppConfig>()
        .allow("document", ["delete"], { contexts: [{ role: "admin" }] }) // Statement 0
        .deny("document", ["delete"], { contexts: [{ unsafe: true }] })   // Statement 1
        .build();

      it("handles denyWins (default/standard)", () => {
          const policy = setupPolicy();
          const { can } = getAccessControl(policy, { conflictResolution: "denyWins" });
          
          // Matches Allow (role=admin) AND Deny (unsafe=true) -> Deny wins
          expect(can("document", "delete", { role: "admin", unsafe: true })).toBe(false);
          
          // Matches only Allow -> Allow
          expect(can("document", "delete", { role: "admin", unsafe: false })).toBe(true);
      });

      it("handles firstWins", () => {
          const policy = setupPolicy();
          const { can } = getAccessControl(policy, { conflictResolution: "firstWins" });
          
          // Matches Allow (index 0) and Deny (index 1). First is Allow.
          expect(can("document", "delete", { role: "admin", unsafe: true })).toBe(true);
      });

      it("handles lastWins", () => {
           // Let's swap the order to make it interesting or just rely on index.
           // Default policy: 0=Allow, 1=Deny.
           const policy = setupPolicy();
           const { can } = getAccessControl(policy, { conflictResolution: "lastWins" });
           
           // Matches Allow (0) and Deny (1). Last is Deny.
           expect(can("document", "delete", { role: "admin", unsafe: true })).toBe(false);
           
           // If we only match Allow?
           expect(can("document", "delete", { role: "admin" })).toBe(true);
      });
  });

  describe("Scenario 6: Bulk Checks (canThese)", () => {
    const policy = definePolicy<AppConfig>()
      .allow("post", ["read", "create"], { contexts: [{ role: "user" }] })
      .allow("post", ["update"], { contexts: [{ role: "editor" }] })
      .deny("post", ["delete"], { contexts: [{ role: "user" }] })
      .build();

    const { canThese } = getAccessControl(policy);

    it("returns an object with multiple permission results", () => {
      const results = canThese("post", ["read", "create", "update", "delete"], { role: "user" });

      expect(results).toEqual({
        read: true,
        create: true,
        update: false,
        delete: false
      });
    });

    it("works with merged default context", () => {
      const { canThese: canTheseWithCtx } = getAccessControl(policy, { role: "user" });
      const results = canTheseWithCtx("post", ["read", "delete"]);

      expect(results).toEqual({
        read: true,
        delete: false
      });
    });

    it("handles multiple contexts correctly in bulk", () => {
        const results = canThese("post", ["read", "update"], [
            { role: "user" },
            { role: "editor" }
        ]);

        expect(results).toEqual({
            read: true,
            update: true
        });
    });
  });
});
