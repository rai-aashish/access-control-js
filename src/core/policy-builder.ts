import type {
	AccessControlConfig,
	TAccessControlPolicy,
} from "./types";

/**
 * A fluent builder class to help create access control policies.
 * Use `definePolicy()` to start a chain.
 */
export class PolicyBuilder<T extends AccessControlConfig> {
	private statements: TAccessControlPolicy<T> = [];

	/**
	 * Allows one or more actions on a specific resource.
	 * @param resource The resource to grant access to.
	 * @param actions The actions to allow (or "*" for all).
	 * @param options Optional configuration, like ABAC contexts.
	 */
	allow<R extends keyof T>(
		resource: R,
		actions: readonly (T[R][number] | "*" | "")[],
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		options?: { contexts?: readonly Record<string, any>[] },
	): this {
		this.statements = [
			...this.statements,
			{
				resource,
				actions,
				effect: "allow",
				contexts: options?.contexts,
			},
		] as unknown as TAccessControlPolicy<T>;
		return this;
	}

	/**
	 * Denies one or more actions on a specific resource.
	 * @param resource The resource to deny access to.
	 * @param actions The actions to deny (or "*" for all).
	 * @param options Optional configuration, like ABAC contexts.
	 */
	deny<R extends keyof T>(
		resource: R,
		actions: readonly (T[R][number] | "*" | "")[],
		// biome-ignore lint/suspicious/noExplicitAny: Context can have any value type
		options?: { contexts?: readonly Record<string, any>[] },
	): this {
		this.statements = [
			...this.statements,
			{
				resource,
				actions,
				effect: "deny",
				contexts: options?.contexts,
			},
		] as unknown as TAccessControlPolicy<T>;
		return this;
	}

	/**
	 * Returns the constructed policy as a plain array.
	 * This array is fully serializable and can be merged with other policies.
	 */
	build(): TAccessControlPolicy<T> {
		return [...this.statements];
	}
}

/**
 * Helper to start building a policy using the fluent API.
 * @returns A new PolicyBuilder instance.
 */
export const definePolicy = <T extends AccessControlConfig>(): PolicyBuilder<T> => {
	return new PolicyBuilder<T>();
};

/**
 * Merges multiple policy arrays into a single policy array.
 * Useful for combining static policies with dynamic ones fetched from a backend.
 * @param policies The list of policy arrays to merge.
 * @returns A single flattened policy array.
 */
export const mergePolicies = <T extends AccessControlConfig>(
	...policies: TAccessControlPolicy<T>[]
): TAccessControlPolicy<T> => {
	return policies.flat() as unknown as TAccessControlPolicy<T>;
};
