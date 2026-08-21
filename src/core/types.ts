/**
 * Configuration object defining resources and their available actions.
 * Keys are resource names, and values are arrays of action strings.
 * Use `as const` to ensure literal types are preserved.
 */
export type AccessControlConfig = Record<string, readonly string[]>;

/**
 * A bag of attributes evaluated against a policy's conditions — passed per check, or once
 * as `defaultContext`.
 *
 * The value type is `any` rather than `unknown` deliberately, and this is the only place
 * the package needs it. `Record<string, unknown>` refuses object types without an index
 * signature, so a caller doing the ordinary thing —
 *
 *   interface AuthContext { role: string; tenantId: string }
 *   can("posts", "read", ctx)
 *
 * — would fail to compile. Evaluation never trusts these values: every one is narrowed
 * from `unknown` inside `conditions.ts` before it is compared.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above — `unknown` rejects interface-typed contexts
export type EvaluationContext = Record<string, any>;

/**
 * One ABAC condition. Keys are context paths (`"post.ownerId"` reads a nested value) and
 * values are either literals or operator specs — see `ConditionOperators`. Permissive for
 * the same reason as `EvaluationContext`: policies are often assembled from typed objects.
 */
// biome-ignore lint/suspicious/noExplicitAny: see EvaluationContext
export type Condition = Record<string, any>;

/** A dot path into the evaluation context, used as an operand: `{ $ref: "user.id" }`. */
export type ContextRef = { $ref: string };

/**
 * Operators recognised inside a condition value. Several on one path are ANDed, so
 * `{ age: { $gte: 18, $lt: 65 } }` is a range.
 *
 * Every operand may be a literal or a `{ $ref }` resolved from the context, which is how
 * a policy expresses "the post's owner is the current user" without baking in a user id:
 * `{ "post.ownerId": { $ref: "user.id" } }`.
 *
 * A comparison whose operands the context cannot supply is undecided rather than false. An
 * undecided deny is skipped and reported by `explain().undecidedDenies`. `$exists` is the
 * exception: deciding whether a path is absent is its whole purpose.
 */
export type ConditionOperators = {
	/** Strict equality. A bare condition value is sugar for this. */
	$eq?: unknown;
	/** Strict inequality. */
	$ne?: unknown;
	/** Context value is one of these. */
	$in?: readonly unknown[] | ContextRef;
	/** Context value is none of these. */
	$nin?: readonly unknown[] | ContextRef;
	/** Ordered comparisons over numbers, strings, bigints or Dates. */
	$gt?: unknown;
	$gte?: unknown;
	$lt?: unknown;
	$lte?: unknown;
	/** Substring of a string, or membership of an array, in the context. */
	$contains?: unknown;
	/** Whether the path is present in the context at all. */
	$exists?: boolean;
	/** Shorthand for `$eq` against the value at this context path. */
	$ref?: string;
};

/**
 * A single statement in an access control policy./**
 * A single statement in an access control policy.
 * Defines a permission for a specific resource and actions.
 */
export type TAccessControlStatement<T extends AccessControlConfig> = {
	[R in keyof T]: {
		/** The resource this statement applies to. */
		resource: R;
		/** The actions allowed or denied. Can include '*' for all actions. */
		actions: readonly (T[R][number] | "*")[];
		/** The effect of the statement: 'allow' grants access, 'deny' blocks it. */
		effect: "allow" | "deny";
		/** Optional contexts for Attribute-Based Access Control (ABAC). Access is granted if ANY
		 *  context object matches (OR logic), and every clause within one context must hold (AND).
		 *  Keys are context paths (`"post.ownerId"` reads a nested value); values are literals or
		 *  operator specs — see `ConditionOperators`. */
		contexts?: readonly Condition[];
	};
}[keyof T];

/**
 * An access control policy consisting of an array of statements.
 */
export type TAccessControlPolicy<T extends AccessControlConfig> =
	readonly TAccessControlStatement<T>[];

/**
 * Statements grouped by resource, so a check can look up its candidates instead of
 * scanning the whole policy. Built once per factory by `buildPolicyIndex`, then handed
 * to `evaluateAccess`/`evaluateAccessBulk` as an argument so they stay pure.
 */
export type PolicyIndex<T extends AccessControlConfig> = ReadonlyMap<
	keyof T,
	TAccessControlPolicy<T>
>;

/**
 * Strategy for resolving conflicting permissions (e.g., when one rule allows and another denies).
 *
 * Two models. Attribute-based, where precedence comes from how specifically a statement
 * matched:
 *
 * - `denyWins`: (Default) The most specific matching statements decide, and a deny among
 *   those wins. A specific allow therefore beats a broader deny — a global
 *   `deny(resource, ["*"])` does not override `allow(resource, ["delete"], { contexts })`.
 *   This is what lets a more specific allow act as an exception to a deny.
 * - `explicitDenyWins`: Any matching deny denies, whatever its specificity. This is the
 *   AWS IAM model, and the one to pick if you rely on a broad deny as a kill switch.
 *
 * And order-based, where precedence comes from position in the policy array:
 *
 * - `firstWins`: The first matching statement wins (the ordered ACL model).
 * - `lastWins`: The last matching statement wins — the only strategy under which
 *   `mergePolicies(base, override)` actually overrides.
 */
export type ConflictResolutionStrategy =
	| "denyWins"
	| "explicitDenyWins"
	| "firstWins"
	| "lastWins";

export interface AccessControlOptions {
	/** Optional default context merged into all permission checks. */
	defaultContext?: EvaluationContext;
	/** Strategy for resolving conflicting permissions. Defaults to 'denyWins'. */
	conflictResolution?: ConflictResolutionStrategy;
	/** Initial loading state for the store. Defaults to `false`. Only used by `createAccessControlStore`. */
	initialIsLoading?: boolean;
	/** Cache `can()` evaluation results within each snapshot. Cached results are discarded automatically
	 *  when the policy changes via `updatePolicy()` or `setLoading()`. Only applies to
	 *  `createAccessControlStore`. Defaults to `true`. */
	cache?: boolean;
}

/** One statement that took part in a decision, as reported by `explain()`. */
export type ExplainedStatement<T extends AccessControlConfig> = {
	/** Position of the statement among the statements for its own resource. */
	index: number;
	effect: "allow" | "deny";
	/** How many condition keys it matched on. The highest wins under the default strategy. */
	specificity: number;
	/** The statement itself. */
	statement: TAccessControlStatement<T>;
};

/**
 * A decision together with its reasoning, as returned by `explain()`.
 * `allowed` is always what `can()` returns for the same arguments — both go through
 * one resolver, so an explanation cannot disagree with the decision it describes.
 */
export type AccessExplanation<T extends AccessControlConfig> = {
	allowed: boolean;
	resource: keyof T;
	action: string;
	/** The strategy that resolved the decision. */
	strategy: ConflictResolutionStrategy;
	/** Every statement that matched, in policy order. */
	matched: ExplainedStatement<T>[];
	/** The statement the strategy settled on, or `null` when nothing matched. */
	decidedBy: ExplainedStatement<T> | null;
	/** Conditional denies the context could not settle, so they were skipped. This is usually
	 *  the answer to "why is my deny not applying?" — the context did not carry the keys the
	 *  deny's conditions name. */
	undecidedDenies: ExplainedStatement<T>[];
	/** One-line summary, for logs. */
	reason: string;
};

/**
 * The core access control interface returned by getAccessControl./**
 * The core access control interface returned by getAccessControl.
 * Contains the policy and helper functions for checking permissions.
 */
export interface CoreAccessControlType<T extends AccessControlConfig> {
	/** The current access control policy. */
	policy: TAccessControlPolicy<T>;
	/** Indicates if the policy is currently loading. */
	isLoading: boolean;
	/** Checks if a specific action on a resource is allowed. */
	can: <R extends keyof T>(
		resource: R,
		action: T[R][number],
		context?: EvaluationContext | EvaluationContext[],
	) => boolean;
	/** Checks if ALL specified actions on a resource are allowed. */
	canAll: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	) => boolean;
	/** Checks if ANY of the specified actions on a resource are allowed. */
	canAny: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	) => boolean;
	/** Explains how a decision was reached: which statements matched, which one the
	 *  strategy settled on, and which conditional denies the context could not settle. */
	explain: <R extends keyof T>(
		resource: R,
		action: T[R][number],
		context?: EvaluationContext | EvaluationContext[],
	) => AccessExplanation<T>;
	/** Checks multiple actions on a resource at once. Returns an object mapping each action to its allow/deny status. */
	canThese: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	) => Record<T[R][number], boolean>;
}

/**
 * The store interface returned by createAccessControlStore.
 * Provides state management and a snapshot with all check methods.
 */
export interface AccessControlStore<T extends AccessControlConfig> {
	/** Updates the current policy and optionally the default context, then notifies listeners. */
	updatePolicy: (
		newPolicy: TAccessControlPolicy<T>,
		defaultContext?: EvaluationContext,
		options?: { isLoading?: boolean },
	) => void;
	/** Manually sets the loading state and notifies listeners. */
	setLoading: (isLoading: boolean) => void;
	/** Subscribes to policy changes. Returns a cleanup function. */
	subscribe: (listener: () => void) => () => void;
	/** Returns a cached snapshot of the current access control state with all check methods. */
	getSnapshot: () => CoreAccessControlType<T>;
}
