import type {
    AccessControlConfig,
    AccessControlOptions,
    AccessControlStore,
    CoreAccessControlType,
    TAccessControlPolicy,
} from "./types";

type MatchedStatement = {
    effect: "allow" | "deny";
    specificity: number;
    index: number;
};

/**
 * Collects matching statements for a single action against pre-filtered relevant statements.
 * Deduplicates by (index, specificity) — a statement can only contribute once per specificity
 * level regardless of how many context combinations match it.
 * Breaks early on the first input context that satisfies a policy condition.
 */
const collectMatchedStatements = <T extends AccessControlConfig>(
    relevantStatements: TAccessControlPolicy<T>,
    action: string,
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    inputContexts: Record<string, any>[],
): MatchedStatement[] => {
    const matched: MatchedStatement[] = [];
    const seen = new Set<string>();

    relevantStatements.forEach((stmt, index) => {
        // biome-ignore lint/suspicious/noExplicitAny: action is a string subtype
        const actionMatches = stmt.actions.includes("*") || stmt.actions.includes(action as any);
        if (!actionMatches) return;

        const policyConditions = stmt.contexts || [];

        // No conditions — matches everything at specificity 0
        if (policyConditions.length === 0) {
            matched.push({ effect: stmt.effect, specificity: 0, index });
            return;
        }

        if (inputContexts.length === 0) return;

        // OR logic: any policy condition matching any input context is a match
        for (const policyCondition of policyConditions) {
            const conditionKeys = Object.keys(policyCondition);
            const specificity = conditionKeys.length;
            const dedupeKey = `${index}:${specificity}`;
            if (seen.has(dedupeKey)) continue;

            for (const inputContext of inputContexts) {
                const allKeysMatch = conditionKeys.every(
                    (k) => inputContext[k] === policyCondition[k],
                );
                if (allKeysMatch) {
                    seen.add(dedupeKey);
                    matched.push({ effect: stmt.effect, specificity, index });
                    break; // No need to check further input contexts for this condition
                }
            }
        }
    });

    return matched;
};

/**
 * Resolves a non-empty list of matched statements to allow/deny using the given strategy.
 */
const resolveConflict = (
    matchedStatements: MatchedStatement[],
    strategy: string,
): boolean => {
    if (strategy === "firstWins") {
        matchedStatements.sort((a, b) => a.index - b.index);
        return matchedStatements[0].effect === "allow";
    }

    if (strategy === "lastWins") {
        matchedStatements.sort((a, b) => b.index - a.index);
        return matchedStatements[0].effect === "allow";
    }

    // Default: "denyWins" — most specific statements take precedence; deny wins among ties
    matchedStatements.sort((a, b) => b.specificity - a.specificity);
    const maxSpecificity = matchedStatements[0].specificity;
    const mostSpecific = matchedStatements.filter((s) => s.specificity === maxSpecificity);
    return !mostSpecific.some((s) => s.effect === "deny");
};

/**
 * Pure function to evaluate access against a specific policy state.
 * This helper ensures logic is consistent across both static and dynamic implementations.
 */
export const evaluateAccess = <T extends AccessControlConfig, R extends keyof T>(
    policy: TAccessControlPolicy<T>,
    resource: R,
    action: T[R][number],
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    context?: Record<string, any> | Record<string, any>[],
    options?: AccessControlOptions,
): boolean => {
    const inputContexts = Array.isArray(context) ? context : context ? [context] : [];
    const relevantStatements = policy.filter((stmt) => stmt.resource === resource);
    const matchedStatements = collectMatchedStatements(relevantStatements, action, inputContexts);

    if (matchedStatements.length === 0) return false;

    return resolveConflict(matchedStatements, options?.conflictResolution ?? "denyWins");
};

/**
 * Bulk version of evaluateAccess to check multiple actions on the same resource
 * with the same context. Minimizes redundant policy filtering and context processing.
 */
export const evaluateAccessBulk = <T extends AccessControlConfig, R extends keyof T>(
    policy: TAccessControlPolicy<T>,
    resource: R,
    actions: T[R][number][],
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    context?: Record<string, any> | Record<string, any>[],
    options?: AccessControlOptions,
): Record<T[R][number], boolean> => {
    const results = {} as Record<T[R][number], boolean>;

    if (actions.length === 0) return results;

    // Normalize context and filter statements ONCE for all actions
    const inputContexts = Array.isArray(context) ? context : context ? [context] : [];
    const relevantStatements = policy.filter((stmt) => stmt.resource === resource);

    if (relevantStatements.length === 0) {
        for (const action of actions) results[action] = false;
        return results;
    }

    const strategy = options?.conflictResolution ?? "denyWins";

    for (const action of actions) {
        const matchedStatements = collectMatchedStatements(relevantStatements, action, inputContexts);
        results[action] = matchedStatements.length === 0
            ? false
            : resolveConflict(matchedStatements, strategy);
    }

    return results;
};

/**
 * Merges a default context into an explicit context.
 * Default context acts as a base — explicit context keys override default ones.
 */
const mergeContext = (
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    defaultContext?: Record<string, any>,
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    explicitContext?: Record<string, any> | Record<string, any>[],
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
): Record<string, any> | Record<string, any>[] | undefined => {
    if (!defaultContext) return explicitContext;
    if (!explicitContext) return defaultContext;
    if (Array.isArray(explicitContext)) {
        return explicitContext.map((c) => ({ ...defaultContext, ...c }));
    }
    return { ...defaultContext, ...explicitContext };
};

/**
 * Creates a static access control interface.
 * Ideal for server-side use (e.g., API routes, Server Components) where the policy is fixed per request.
 *
 * @param accessControlPolicy - The policy to evaluate.
 * @param options - Optional configuration options (default context, conflict resolution).
 * @returns An object containing `can`, `canAll`, and `canAny` functions.
 */
export const getAccessControl = <T extends AccessControlConfig>(
    accessControlPolicy: TAccessControlPolicy<T>,
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    optionsOrContext?: AccessControlOptions | Record<string, any>,
): CoreAccessControlType<T> => {
    // Backward compatibility: if second arg is a plain object without known option keys, treat as context
    let options: AccessControlOptions = {};
    if (optionsOrContext) {
        if ("conflictResolution" in optionsOrContext || "defaultContext" in optionsOrContext) {
            options = optionsOrContext as AccessControlOptions;
        } else {
            options = { defaultContext: optionsOrContext };
        }
    }

    const { defaultContext } = options;

    const can = <R extends keyof T>(
        resource: R,
        action: T[R][number],
        // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
        context?: Record<string, any> | Record<string, any>[],
    ): boolean => {
        return evaluateAccess(
            accessControlPolicy,
            resource,
            action,
            mergeContext(defaultContext, context),
            options,
        );
    };

    const canAll = <R extends keyof T>(
        resource: R,
        actions: T[R][number][],
        // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
        context?: Record<string, any> | Record<string, any>[],
    ): boolean => {
        const results = canThese(resource, actions, context);
        return Object.values(results).every((v) => v === true);
    };

    const canAny = <R extends keyof T>(
        resource: R,
        actions: T[R][number][],
        // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
        context?: Record<string, any> | Record<string, any>[],
    ): boolean => {
        const results = canThese(resource, actions, context);
        return Object.values(results).some((v) => v === true);
    };

    const canThese = <R extends keyof T>(
        resource: R,
        actions: T[R][number][],
        // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
        context?: Record<string, any> | Record<string, any>[],
    ): Record<T[R][number], boolean> => {
        return evaluateAccessBulk(
            accessControlPolicy,
            resource,
            actions,
            mergeContext(defaultContext, context),
            options,
        );
    };

    return {
        policy: accessControlPolicy,
        isLoading: false, // Static policies are never loading
        can,
        canAll,
        canAny,
        canThese,
    };
};

/**
 * Creates an updatable access control store with subscription capabilities.
 * Ideal for client-side use where the policy may load asynchronously or change over time.
 *
 * @param initialPolicy - The initial policy to use.
 * @param options - Optional configuration options (default context, conflict resolution, initialIsLoading).
 * @returns An object containing policy updater, subscription method, and snapshot.
 */
export const createAccessControlStore = <T extends AccessControlConfig>(
    initialPolicy: TAccessControlPolicy<T>,
    // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
    optionsOrContext?: AccessControlOptions | Record<string, any>,
): AccessControlStore<T> => {
     // Backward compatibility handling
    let options: AccessControlOptions = {};
    if (optionsOrContext) {
        if ("conflictResolution" in optionsOrContext || "defaultContext" in optionsOrContext) {
            options = optionsOrContext as AccessControlOptions;
        } else {
            options = { defaultContext: optionsOrContext };
        }
    }

    let currentPolicy = initialPolicy;
    let currentDefaultContext = options.defaultContext;
    let currentIsLoading = options.initialIsLoading ?? false;
    
    const listeners = new Set<() => void>();

    // Build a snapshot with all check methods bound to a specific policy.
    // Cached and only rebuilt on updatePolicy/setLoading calls.
    const buildSnapshot = (
        policy: TAccessControlPolicy<T>,
        // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
            defCtx?: Record<string, any>,
        loading?: boolean,
    ): CoreAccessControlType<T> => {
        const snapshotCanThese = <R extends keyof T>(
            resource: R,
            actions: T[R][number][],
            // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
            context?: Record<string, any> | Record<string, any>[],
        ): Record<T[R][number], boolean> =>
            evaluateAccessBulk(policy, resource, actions, mergeContext(defCtx, context), options);

        const snapshotCan = <R extends keyof T>(
            resource: R,
            action: T[R][number],
            // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
            context?: Record<string, any> | Record<string, any>[],
        ): boolean => snapshotCanThese(resource, [action], context)[action];

        return {
            policy,
            isLoading: loading ?? false,
            can: snapshotCan,
            canAll: <R extends keyof T>(
                resource: R,
                actions: T[R][number][],
                // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
                context?: Record<string, any> | Record<string, any>[],
            ): boolean => actions.every((a) => snapshotCan(resource, a, context)),
            canAny: <R extends keyof T>(
                resource: R,
                actions: T[R][number][],
                // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
                context?: Record<string, any> | Record<string, any>[],
            ): boolean => {
                const results = snapshotCanThese(resource, actions, context);
                return Object.values(results).some((a) => a === true);
            },
            canThese: snapshotCanThese,
        };
    };

    let snapshot = buildSnapshot(currentPolicy, currentDefaultContext, currentIsLoading);

    const notifyListeners = () => {
        for (const listener of listeners) {
            listener();
        }
    };

    return {
        updatePolicy: (
            newPolicy: TAccessControlPolicy<T>,
            // biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
            defaultContext?: Record<string, any>,
            updateOptions?: { isLoading?: boolean }
        ) => {
            currentPolicy = newPolicy;
            if (defaultContext !== undefined) {
                currentDefaultContext = defaultContext;
            }
            if (updateOptions?.isLoading !== undefined) {
                currentIsLoading = updateOptions.isLoading;
            }
            snapshot = buildSnapshot(currentPolicy, currentDefaultContext, currentIsLoading);
            notifyListeners();
        },
        setLoading: (isLoading: boolean) => {
            if (currentIsLoading === isLoading) return;
            currentIsLoading = isLoading;
            snapshot = buildSnapshot(currentPolicy, currentDefaultContext, currentIsLoading);
            notifyListeners();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
    };
};