import { describe, expect, it } from "vitest";
import * as api from "../src";
import { definePolicy, getAccessControl } from "../src";

const config = {
	posts: ["read", "create", "update", "delete"],
} as const;

type AppConfig = typeof config;

/**
 * The published surface is now a dependency of other packages, so a change to it is a
 * decision rather than a side effect. This test makes an accidental addition or removal
 * fail here first.
 */
describe("Public API", () => {
	it("exports exactly the documented runtime surface", () => {
		expect(Object.keys(api).sort()).toEqual([
			"PolicyBuilder",
			"buildPolicyIndex",
			"createAccessControlStore",
			"definePolicy",
			"evaluateAccess",
			"evaluateAccessBulk",
			"explainAccess",
			"getAccessControl",
			"mergePolicies",
		]);
	});

	it("keeps internals off the surface", () => {
		// Condition judging and the dev-warning helpers are implementation detail
		expect(api).not.toHaveProperty("judgeCondition");
		expect(api).not.toHaveProperty("deepEquals");
		expect(api).not.toHaveProperty("encodeValueForKey");
		expect(api).not.toHaveProperty("warnOnce");
	});

	it("accepts an interface-typed context", () => {
		// `Record<string, unknown>` would reject this, which is why EvaluationContext is
		// deliberately permissive. If someone tightens it, this stops compiling.
		interface AuthContext {
			role: string;
			tenantId: string;
		}

		const ctx: AuthContext = { role: "editor", tenantId: "acme" };
		const policy = definePolicy<AppConfig>()
			.allow("posts", ["read"], { contexts: [{ role: "editor" }] })
			.build();

		expect(getAccessControl<AppConfig>(policy).can("posts", "read", ctx)).toBe(
			true,
		);
	});

	it("accepts an interface-typed default context and condition", () => {
		interface Tenant {
			tenantId: string;
		}

		const defaultContext: Tenant = { tenantId: "acme" };
		const condition: Tenant = { tenantId: "acme" };

		const policy = definePolicy<AppConfig>()
			.allow("posts", ["read"], { contexts: [condition] })
			.build();

		expect(
			getAccessControl<AppConfig>(policy, { defaultContext }).can(
				"posts",
				"read",
			),
		).toBe(true);
	});
});
