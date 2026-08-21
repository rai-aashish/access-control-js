// Declared locally so the package needs no @types/node; every use is typeof-guarded.
declare const process: { env?: Record<string, string | undefined> } | undefined;

/** True outside production builds. Gates development-only warnings. */
export const isDevelopment = (): boolean =>
	typeof process !== "undefined" && process?.env?.NODE_ENV !== "production";

/**
 * Warnings are emitted at most once per distinct message. A check can run on every
 * render, so an un-deduplicated warning would flood the console.
 */
const warnedMessages = new Set<string>();

export const warnOnce = (message: string): void => {
	if (!isDevelopment() || warnedMessages.has(message)) return;
	warnedMessages.add(message);
	console.warn(`[access-control-js] ${message}`);
};
