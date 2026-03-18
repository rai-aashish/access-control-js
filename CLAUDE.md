# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package

**`access-control-js`** — published on npm as `access-control-js`.

## Commands

```bash
# Build (CJS + ESM with type declarations)
npm run build

# Run tests
npm test

# Run a single test file
npx vitest run tests/policy.test.ts

# Lint
npm run lint

# Format
npm run format
```

## Rules

### Do

- Run `npm test` after any logic change to `src/core/` before considering a task done.
- Keep `evaluateAccess()` a pure function — no side effects, no external I/O.
- Preserve both CJS (`dist/index.js`) and ESM (`dist/index.mjs`) outputs; never break dual-format exports.
- Use the fluent `definePolicy<T>()` builder when writing new policy fixtures or examples.
- Keep the generic `T extends AccessControlConfig` constraint intact on all public API signatures.
- Write tests in `tests/` using Vitest; co-locate edge-case tests with the feature they cover.

### Don't

- Don't introduce runtime dependencies — this library ships zero deps by design.
- Don't add React-specific code inside `src/core/`; React integration lives only at the entry point level.
- Don't change the conflict-resolution default (`denyWins`) without an explicit user request.
- Don't mutate policy arrays in place; always return new arrays/objects from builder methods.
- Don't remove or weaken TypeScript generics to silence type errors — fix the types properly.
- Don't use `any` types; use `unknown` or tighten the generics instead.

## Architecture

**`access-control-js`** is a lightweight, type-safe access control library for TypeScript supporting both RBAC and ABAC patterns.

### Core API Surface

Two entry points for different environments:

- **`getAccessControl(policy, options?)`** — Stateless, for server-side use (API routes, Server Components). `isLoading` is always `false`.
- **`createAccessControlStore(initialPolicy?, options?)`** — Reactive store with subscriptions for client-side use. Compatible with React's `useSyncExternalStore`.

Both expose: `can(resource, action, context?)`, `canAll(resource, actions[], context?)`, `canAny(resource, actions[], context?)`, `canThese(checks[])`.

### Policy Evaluation (`src/core/policy.ts`)

`evaluateAccess()` is the single pure function at the heart of everything. It:
1. Filters statements by resource
2. Matches actions (exact or `*` wildcard)
3. Applies ABAC context with **OR logic** — any policy condition matching any input context grants/denies
4. Resolves conflicts via strategy: `denyWins` (default, specificity-based), `firstWins`, `lastWins`
5. Returns `false` when no statements match

`evaluateAccessBulk()` filters statements once then evaluates multiple actions — used by `canThese()`.

### Type System (`src/core/types.ts`)

The generic `T extends AccessControlConfig` (a `Record<string, string[]>`) constrains all APIs at compile time. Resources are keys, actions are the string union from each key's array.

### Policy Builder (`src/core/policy-builder.ts`)

`definePolicy<T>()` creates a `PolicyBuilder` with a fluent `.allow()` / `.deny()` / `.build()` API. `mergePolicies(...policies)` flattens multiple policy arrays — useful for combining static base policies with dynamic user-fetched policies.

### Client-Side Store Pattern

`createAccessControlStore()` uses a subscription + snapshot pattern. Snapshots are rebuilt only on `updatePolicy()` or `setLoading()` calls, not on reads — making `getSnapshot()` safe for `useSyncExternalStore`.

### Default Context

`options.defaultContext` is merged into every `can()` call automatically. Explicit context passed at call time overrides the default on matching keys. This enables setting a user's role/attributes once at store creation rather than on every check.
