import { encodeValueForKey, judgeCondition } from "./conditions";
import { isDevelopment, warnOnce } from "./dev";
import type {
	AccessControlConfig,
	AccessControlOptions,
	AccessControlStore,
	AccessExplanation,
	CoreAccessControlType,
	EvaluationContext,
	ExplainedStatement,
	PolicyIndex,
	TAccessControlPolicy,
	TAccessControlStatement,
} from "./types";

/** Stand-in when a check supplies no context at all, so conditions can still be judged. */
const EMPTY_CONTEXT: Record<string, unknown> = {};

/** A match is exactly what `explain()` reports, so the shape is shared. */
type MatchedStatement<T extends AccessControlConfig> = ExplainedStatement<T>;

/**
 * Collects matching statements for a single action against pre-filtered relevant statements.
 * Deduplicates by (index, specificity) — a statement can only contribute once per specificity
 * level regardless of how many context combinations match it.
 * Breaks early on the first input context that satisfies a policy condition.
 *
 * `undecidedDenies`, when supplied, collects conditional denies the context could not
 * settle and that were therefore skipped. Only `explain()` passes it; the hot path
 * leaves it undefined and allocates nothing.
 */
const collectMatchedStatements = <T extends AccessControlConfig>(
	relevantStatements: TAccessControlPolicy<T>,
	action: string,
	inputContexts: EvaluationContext[],
	undecidedDenies?: MatchedStatement<T>[],
): MatchedStatement<T>[] => {
	const matched: MatchedStatement<T>[] = [];
	const seen = new Set<string>();

	relevantStatements.forEach((stmt, index) => {
		const actionMatches =
			// biome-ignore lint/suspicious/noExplicitAny: action is a string subtype
			stmt.actions.includes("*") || stmt.actions.includes(action as any);
		if (!actionMatches) return;

		const policyConditions = stmt.contexts || [];

		// No conditions — matches everything at specificity 0
		if (policyConditions.length === 0) {
			matched.push({
				effect: stmt.effect,
				specificity: 0,
				index,
				statement: stmt,
			});
			return;
		}

		// With no context supplied, judge against an empty one rather than skipping. Every
		// path is then absent, which reads as unknown for ordinary clauses — the same
		// outcome as before — while letting `$exists: false` decide, as it should.
		const contexts = inputContexts.length > 0 ? inputContexts : [EMPTY_CONTEXT];

		// OR logic: any policy condition matching any input context is a match
		for (const policyCondition of policyConditions) {
			const conditionKeys = Object.keys(policyCondition);
			const specificity = conditionKeys.length;
			const dedupeKey = `${index}:${specificity}`;
			if (seen.has(dedupeKey)) continue;

			let isMatch = false;
			// A condition the context cannot settle is unknown, which is not the same as
			// "does not apply" — the difference is reported below.
			let isDecidable = false;

			for (const inputContext of contexts) {
				const judgement = judgeCondition(policyCondition, inputContext);
				if (judgement === "match") {
					isMatch = true;
					break; // No need to check further input contexts for this condition
				}
				if (judgement === "no-match") isDecidable = true;
			}

			if (isMatch) {
				seen.add(dedupeKey);
				matched.push({
					effect: stmt.effect,
					specificity,
					index,
					statement: stmt,
				});
				continue;
			}

			if (isDecidable || stmt.effect !== "deny") continue;

			// An undecidable deny is skipped, which fails open. Nothing else would surface
			// that, so record it for explain() and tell the developer once.
			undecidedDenies?.push({
				effect: "deny",
				specificity,
				index,
				statement: stmt,
			});
			warnOnce(
				`A deny statement for "${String(stmt.resource)}:${action}" was skipped because ` +
					`the context did not supply: ${conditionKeys.join(", ")}. Pass those keys so the ` +
					"deny can be evaluated.",
			);
		}
	});

	return matched;
};

/** The outcome of a strategy, together with the statement that produced it. */
type Decision<T extends AccessControlConfig> = {
	allowed: boolean;
	decidedBy: MatchedStatement<T> | null;
};

/** Lowest index among candidates — the earliest statement in policy order. */
const earliest = <T extends AccessControlConfig>(
	candidates: MatchedStatement<T>[],
): MatchedStatement<T> | null =>
	candidates.length === 0
		? null
		: candidates.reduce((a, b) => (b.index < a.index ? b : a));

/**
 * Resolves matched statements to allow/deny using the given strategy, and names the
 * statement responsible. An empty list means nothing matched, which is a deny.
 *
 * `can()` and `explain()` both go through here, so an explanation can never disagree
 * with the decision it describes.
 *
 * Picks winners by reduction rather than sorting: the caller's array is left
 * untouched and each strategy costs one pass instead of a sort.
 */
const resolveDecision = <T extends AccessControlConfig>(
	matchedStatements: MatchedStatement<T>[],
	strategy: string,
): Decision<T> => {
	if (matchedStatements.length === 0)
		return { allowed: false, decidedBy: null };

	if (strategy === "firstWins" || strategy === "lastWins") {
		const winner = matchedStatements.reduce((a, b) =>
			strategy === "firstWins"
				? b.index < a.index
					? b
					: a
				: b.index > a.index
					? b
					: a,
		);
		return { allowed: winner.effect === "allow", decidedBy: winner };
	}

	// Any matching deny denies, whatever its specificity (the AWS IAM model)
	if (strategy === "explicitDenyWins") {
		const deny = earliest(matchedStatements.filter((s) => s.effect === "deny"));
		if (deny) return { allowed: false, decidedBy: deny };
		return { allowed: true, decidedBy: earliest(matchedStatements) };
	}

	// Default "denyWins": the most specific statements take precedence, and a deny among
	// those wins — which is what lets a more specific allow act as an exception
	const maxSpecificity = matchedStatements.reduce(
		(max, s) => (s.specificity > max ? s.specificity : max),
		0,
	);
	const mostSpecific = matchedStatements.filter(
		(s) => s.specificity === maxSpecificity,
	);
	const deny = earliest(mostSpecific.filter((s) => s.effect === "deny"));
	if (deny) return { allowed: false, decidedBy: deny };
	return { allowed: true, decidedBy: earliest(mostSpecific) };
};

/** Boolean-only view of resolveDecision, for the check path. */
const resolveConflict = <T extends AccessControlConfig>(
	matchedStatements: MatchedStatement<T>[],
	strategy: string,
): boolean => resolveDecision(matchedStatements, strategy).allowed;

/**
 * Groups a policy's statements by resource. Statement order within a resource is
 * preserved, which `firstWins`/`lastWins` depend on.
 *
 * Build this once per policy and pass it to the evaluators; without it they fall
 * back to scanning the whole policy on every check.
 */
export const buildPolicyIndex = <T extends AccessControlConfig>(
	policy: TAccessControlPolicy<T>,
): PolicyIndex<T> => {
	const index = new Map<keyof T, TAccessControlStatement<T>[]>();
	for (const stmt of policy) {
		const existing = index.get(stmt.resource);
		if (existing) {
			existing.push(stmt);
		} else {
			index.set(stmt.resource, [stmt]);
		}
	}
	return index;
};

/** Shared empty result, so a miss on the index allocates nothing. */
const EMPTY_STATEMENTS: readonly never[] = [];

/** Statements for one resource: from the index when there is one, else by scanning. */
const statementsFor = <T extends AccessControlConfig, R extends keyof T>(
	policy: TAccessControlPolicy<T>,
	resource: R,
	index?: PolicyIndex<T>,
): TAccessControlPolicy<T> =>
	index
		? (index.get(resource) ?? EMPTY_STATEMENTS)
		: policy.filter((stmt) => stmt.resource === resource);

/**
 * Pure function to evaluate access against a specific policy state.
 * This helper ensures logic is consistent across both static and dynamic implementations.
 */
export const evaluateAccess = <
	T extends AccessControlConfig,
	R extends keyof T,
>(
	policy: TAccessControlPolicy<T>,
	resource: R,
	action: T[R][number],
	context?: EvaluationContext | EvaluationContext[],
	options?: AccessControlOptions,
	index?: PolicyIndex<T>,
): boolean => {
	const inputContexts = Array.isArray(context)
		? context
		: context
			? [context]
			: [];
	const matchedStatements = collectMatchedStatements(
		statementsFor(policy, resource, index),
		action,
		inputContexts,
	);

	return resolveConflict(
		matchedStatements,
		options?.conflictResolution ?? "denyWins",
	);
};

/**
 * Bulk version of evaluateAccess to check multiple actions on the same resource
 * with the same context. Minimizes redundant policy filtering and context processing.
 */
export const evaluateAccessBulk = <
	T extends AccessControlConfig,
	R extends keyof T,
>(
	policy: TAccessControlPolicy<T>,
	resource: R,
	actions: T[R][number][],
	context?: EvaluationContext | EvaluationContext[],
	options?: AccessControlOptions,
	index?: PolicyIndex<T>,
): Record<T[R][number], boolean> => {
	const results = {} as Record<T[R][number], boolean>;

	if (actions.length === 0) return results;

	// Normalize context and resolve statements ONCE for all actions
	const inputContexts = Array.isArray(context)
		? context
		: context
			? [context]
			: [];
	const relevantStatements = statementsFor(policy, resource, index);

	if (relevantStatements.length === 0) {
		for (const action of actions) results[action] = false;
		return results;
	}

	const strategy = options?.conflictResolution ?? "denyWins";

	for (const action of actions) {
		results[action] = resolveConflict(
			collectMatchedStatements(relevantStatements, action, inputContexts),
			strategy,
		);
	}

	return results;
};

/** Renders a decision as one line, for logs and for the `reason` field. */
const buildReason = <T extends AccessControlConfig>(
	resource: keyof T,
	action: string,
	strategy: string,
	decision: Decision<T>,
	undecidedCount: number,
): string => {
	const target = `${String(resource)}:${action}`;
	const skipped =
		undecidedCount === 0
			? ""
			: undecidedCount === 1
				? " 1 conditional deny was skipped because the context could not settle it."
				: ` ${undecidedCount} conditional denies were skipped because the context could not ` +
					"settle them.";

	if (!decision.decidedBy) {
		return `No statement matched ${target}, so access is denied.${skipped}`;
	}

	const { effect, index, specificity } = decision.decidedBy;
	const verb = decision.allowed ? "allowed" : "denied";
	return (
		`${target} ${verb} by the ${effect} statement at index ${index} for this resource ` +
		`(specificity ${specificity}), under ${strategy}.${skipped}`
	);
};

/**
 * Pure counterpart to `evaluateAccess` that reports the reasoning behind a decision
 * rather than just the answer. Useful for debugging a surprising check and for audit
 * logs. `allowed` always agrees with `evaluateAccess` given the same arguments.
 */
export const explainAccess = <T extends AccessControlConfig, R extends keyof T>(
	policy: TAccessControlPolicy<T>,
	resource: R,
	action: T[R][number],
	context?: EvaluationContext | EvaluationContext[],
	options?: AccessControlOptions,
	index?: PolicyIndex<T>,
): AccessExplanation<T> => {
	const inputContexts = Array.isArray(context)
		? context
		: context
			? [context]
			: [];
	const strategy = options?.conflictResolution ?? "denyWins";
	const undecidedDenies: MatchedStatement<T>[] = [];
	const matched = collectMatchedStatements(
		statementsFor(policy, resource, index),
		action,
		inputContexts,
		undecidedDenies,
	);
	const decision = resolveDecision(matched, strategy);

	return {
		allowed: decision.allowed,
		resource,
		action,
		strategy,
		matched,
		decidedBy: decision.decidedBy,
		undecidedDenies,
		reason: buildReason(
			resource,
			action,
			strategy,
			decision,
			undecidedDenies.length,
		),
	};
};

/**
 * Merges a default context into an explicit context.
 * Default context acts as a base — explicit context keys override default ones.
 */
const mergeContext = (
	defaultContext?: EvaluationContext,
	explicitContext?: EvaluationContext | EvaluationContext[],
): EvaluationContext | EvaluationContext[] | undefined => {
	if (!defaultContext) return explicitContext;
	if (!explicitContext) return defaultContext;
	if (Array.isArray(explicitContext)) {
		return explicitContext.map((c) => ({ ...defaultContext, ...c }));
	}
	return { ...defaultContext, ...explicitContext };
};

const KNOWN_OPTION_KEYS = new Set([
	"defaultContext",
	"conflictResolution",
	"initialIsLoading",
	"cache",
]);

/**
 * Flags unrecognised option keys in development. Mostly this catches a context object
 * passed as the second argument, which earlier versions accepted.
 */
const warnOnUnknownOptions = (options: AccessControlOptions): void => {
	if (!isDevelopment()) return;
	const unknown = Object.keys(options).filter((k) => !KNOWN_OPTION_KEYS.has(k));
	if (unknown.length === 0) return;
	warnOnce(
		`Unrecognised option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
			"A context object is no longer accepted as the second argument — pass it as " +
			"`defaultContext`.",
	);
};

/**
 * Creates a static access control interface.
 * Ideal for server-side use (e.g., API routes, Server Components) where the policy is fixed per request.
 *
 * @param accessControlPolicy - The policy to evaluate.
 * @param options - Optional configuration (default context, conflict resolution).
 * @returns An object containing `can`, `canAll`, `canAny` and `canThese` functions.
 */
export const getAccessControl = <T extends AccessControlConfig>(
	accessControlPolicy: TAccessControlPolicy<T>,
	options: AccessControlOptions = {},
): CoreAccessControlType<T> => {
	warnOnUnknownOptions(options);

	const { defaultContext } = options;

	// Grouped once here, so each check is a map lookup rather than a scan of the policy.
	const index = buildPolicyIndex(accessControlPolicy);

	const can = <R extends keyof T>(
		resource: R,
		action: T[R][number],
		context?: EvaluationContext | EvaluationContext[],
	): boolean => {
		return evaluateAccess(
			accessControlPolicy,
			resource,
			action,
			mergeContext(defaultContext, context),
			options,
			index,
		);
	};

	const canAll = <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	): boolean => {
		const results = canThese(resource, actions, context);
		return Object.values(results).every((v) => v === true);
	};

	const canAny = <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	): boolean => {
		const results = canThese(resource, actions, context);
		return Object.values(results).some((v) => v === true);
	};

	const explain = <R extends keyof T>(
		resource: R,
		action: T[R][number],
		context?: EvaluationContext | EvaluationContext[],
	): AccessExplanation<T> => {
		return explainAccess(
			accessControlPolicy,
			resource,
			action,
			mergeContext(defaultContext, context),
			options,
			index,
		);
	};

	const canThese = <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		context?: EvaluationContext | EvaluationContext[],
	): Record<T[R][number], boolean> => {
		return evaluateAccessBulk(
			accessControlPolicy,
			resource,
			actions,
			mergeContext(defaultContext, context),
			options,
			index,
		);
	};

	return {
		policy: accessControlPolicy,
		isLoading: false, // Static policies are never loading
		can,
		canAll,
		canAny,
		canThese,
		explain,
	};
};

/** Maximum number of `can()` results retained per snapshot cache. */
const CACHE_MAX_ENTRIES = 500;

/**
 * Builds a stable cache key for a context, or `null` when the context cannot be keyed
 * faithfully — see `encodeValueForKey`, which decides that and lives beside the equality
 * it has to agree with.
 *
 * An array of contexts is sorted, since matching is OR across them and their order cannot
 * affect the result.
 */
const cacheKeyForContext = (
	ctx?: EvaluationContext | EvaluationContext[],
): string | null => {
	if (!ctx) return "";
	if (!Array.isArray(ctx)) return encodeValueForKey(ctx);

	const parts: string[] = [];
	for (const entry of ctx) {
		const entryKey = encodeValueForKey(entry);
		if (entryKey === null) return null;
		parts.push(entryKey);
	}
	return `[${parts.sort().join(",")}]`;
};

/**
 * Reads a cached result, refreshing its recency. A Map preserves insertion order, so
 * deleting and re-setting the key moves it to the most-recently-used end.
 */
const readCache = (
	cache: Map<string, boolean>,
	key: string,
): boolean | undefined => {
	if (!cache.has(key)) return undefined;
	const value = cache.get(key) as boolean;
	cache.delete(key);
	cache.set(key, value);
	return value;
};

/** Writes a result, evicting the least-recently-used entry once at capacity. */
const writeCache = (
	cache: Map<string, boolean>,
	key: string,
	value: boolean,
): void => {
	if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
};

/**
 * Creates an updatable access control store with subscription capabilities.
 * Ideal for client-side use where the policy may load asynchronously or change over time.
 *
 * @param initialPolicy - The initial policy to use.
 * @param options - Optional configuration (default context, conflict resolution, cache,
 *   initialIsLoading).
 * @returns An object containing policy updater, subscription method, and snapshot.
 */
export const createAccessControlStore = <T extends AccessControlConfig>(
	initialPolicy: TAccessControlPolicy<T>,
	options: AccessControlOptions = {},
): AccessControlStore<T> => {
	warnOnUnknownOptions(options);

	let currentPolicy = initialPolicy;
	let currentDefaultContext = options.defaultContext;
	let currentIsLoading = options.initialIsLoading ?? false;

	const listeners = new Set<() => void>();

	// Build a snapshot with all check methods bound to a specific policy.
	// Cached and only rebuilt on updatePolicy/setLoading calls.
	const buildSnapshot = (
		policy: TAccessControlPolicy<T>,
		defCtx?: EvaluationContext,
		loading?: boolean,
	): CoreAccessControlType<T> => {
		// The snapshot evaluates through a stateless instance, so server and client
		// share one implementation of every check. The cache below wraps it, which is
		// what keeps canThese/canAll/canAny on the same cached path as can().
		const base = getAccessControl<T>(policy, {
			...options,
			defaultContext: defCtx,
		});

		const resultCache =
			options.cache !== false ? new Map<string, boolean>() : null;

		const cachedCan = <R extends keyof T>(
			resource: R,
			action: T[R][number],
			context?: EvaluationContext | EvaluationContext[],
		): boolean => {
			if (!resultCache) return base.can(resource, action, context);

			const contextKey = cacheKeyForContext(context);
			// Non-primitive context values cannot be keyed faithfully — evaluate, but don't store.
			if (contextKey === null) return base.can(resource, action, context);

			const key = `${JSON.stringify(String(resource))}:${JSON.stringify(String(action))}:${contextKey}`;
			const cached = readCache(resultCache, key);
			if (cached !== undefined) return cached;

			const result = base.can(resource, action, context);
			writeCache(resultCache, key, result);
			return result;
		};

		// Routed per action through cachedCan rather than the bulk evaluator: with the
		// policy indexed by resource, resolving statements per action is a map lookup,
		// so sharing the cache is worth more than filtering once.
		const cachedCanThese = <R extends keyof T>(
			resource: R,
			actions: T[R][number][],
			context?: EvaluationContext | EvaluationContext[],
		): Record<T[R][number], boolean> => {
			const results = {} as Record<T[R][number], boolean>;
			for (const action of actions) {
				results[action] = cachedCan(resource, action, context);
			}
			return results;
		};

		return {
			policy,
			isLoading: loading ?? false,
			can: cachedCan,
			canAll: <R extends keyof T>(
				resource: R,
				actions: T[R][number][],
				context?: EvaluationContext | EvaluationContext[],
			): boolean => actions.every((a) => cachedCan(resource, a, context)),
			canAny: <R extends keyof T>(
				resource: R,
				actions: T[R][number][],
				context?: EvaluationContext | EvaluationContext[],
			): boolean => actions.some((a) => cachedCan(resource, a, context)),
			canThese: cachedCanThese,
			// Deliberately uncached: an explanation is a debug view, and it reports the
			// reasoning rather than reusing a stored answer
			explain: base.explain,
		};
	};

	let snapshot = buildSnapshot(
		currentPolicy,
		currentDefaultContext,
		currentIsLoading,
	);

	const notifyListeners = () => {
		for (const listener of listeners) {
			listener();
		}
	};

	return {
		updatePolicy: (
			newPolicy: TAccessControlPolicy<T>,
			defaultContext?: EvaluationContext,
			updateOptions?: { isLoading?: boolean },
		) => {
			const nextDefaultContext =
				defaultContext !== undefined ? defaultContext : currentDefaultContext;
			const nextIsLoading = updateOptions?.isLoading ?? currentIsLoading;

			// Nothing actually changed, so there is nothing to rebuild or announce. This
			// matches setLoading, which has always bailed, and keeps the store from
			// re-rendering every subscriber on a no-op update. Cached results stay valid
			// because evaluation is pure.
			if (
				newPolicy === currentPolicy &&
				nextDefaultContext === currentDefaultContext &&
				nextIsLoading === currentIsLoading
			) {
				return;
			}

			currentPolicy = newPolicy;
			currentDefaultContext = nextDefaultContext;
			currentIsLoading = nextIsLoading;
			snapshot = buildSnapshot(
				currentPolicy,
				currentDefaultContext,
				currentIsLoading,
			);
			notifyListeners();
		},
		setLoading: (isLoading: boolean) => {
			if (currentIsLoading === isLoading) return;
			currentIsLoading = isLoading;
			snapshot = buildSnapshot(
				currentPolicy,
				currentDefaultContext,
				currentIsLoading,
			);
			notifyListeners();
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
	};
};
