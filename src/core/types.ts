/**
 * Configuration object defining resources and their available actions.
 * Keys are resource names, and values are arrays of action strings.
 * Use `as const` to ensure literal types are preserved.
 */
export type AccessControlConfig = Record<string, readonly string[]>;

/**
 * A single statement in an access control policy.
 * Defines a permission for a specific resource and actions.
 */
export type TAccessControlStatement<T extends AccessControlConfig> = {
	[R in keyof T]: {
		/** The resource this statement applies to. */
		resource: R;
		/** The actions allowed or denied. Can include '*' for all actions. */
		actions: readonly (T[R][number] | "*" | "")[];
		/** The effect of the statement: 'allow' grants access, 'deny' blocks it. */
		effect: "allow" | "deny";
		/** Optional contexts for Attribute-Based Access Control (ABAC). Access is granted if ANY context object matches (OR logic). */
		// biome-ignore lint/suspicious/noExplicitAny: Conditions can have any value type
		contexts?: readonly Record<string, any>[];
	};
}[keyof T];

/**
 * An access control policy consisting of an array of statements.
 */
export type TAccessControlPolicy<T extends AccessControlConfig> =
	readonly TAccessControlStatement<T>[];

/**
 * Strategy for resolving conflicting permissions (e.g., when one rule allows and another denies).
 * - `denyWins`: (Default) If any matching rule denies, access is denied.
 * - `firstWins`: The first matching rule in the policy array wins.
 * - `lastWins`: The last matching rule in the policy array wins.
 */
export type ConflictResolutionStrategy = "denyWins" | "firstWins" | "lastWins";

export interface AccessControlOptions {
	/** Optional default context merged into all permission checks. */
	// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
	defaultContext?: Record<string, any>;
	/** Strategy for resolving conflicting permissions. Defaults to 'denyWins'. */
	conflictResolution?: ConflictResolutionStrategy;
	/** Initial loading state for the store. Defaults to `false`. Only used by `createAccessControlStore`. */
	initialIsLoading?: boolean;
}

/**
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
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		context?: Record<string, any> | Record<string, any>[],
	) => boolean;
	/** Checks if ALL specified actions on a resource are allowed. */
	canAll: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		context?: Record<string, any> | Record<string, any>[],
	) => boolean;
	/** Checks if ANY of the specified actions on a resource are allowed. */
	canAny: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		context?: Record<string, any> | Record<string, any>[],
	) => boolean;
	/** Checks multiple actions on a resource at once. Returns an object mapping each action to its allow/deny status. */
	canThese: <R extends keyof T>(
		resource: R,
		actions: T[R][number][],
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		context?: Record<string, any> | Record<string, any>[],
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
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		defaultContext?: Record<string, any>,
        options?: { isLoading?: boolean }
	) => void;
    /** Manually sets the loading state and notifies listeners. */
    setLoading: (isLoading: boolean) => void;
	/** Subscribes to policy changes. Returns a cleanup function. */
	subscribe: (listener: () => void) => () => void;
	/** Returns a cached snapshot of the current access control state with all check methods. */
	getSnapshot: () => CoreAccessControlType<T>;
}

