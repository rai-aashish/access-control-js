# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package

**`access-control-js`** — published on npm as `access-control-js`.

## CodeGraph

This repository is indexed by CodeGraph (`.codegraph/` at the root). Reach for it **before**
grep, find, or opening files when you need to locate code or understand how something is
wired — one call returns the relevant symbols' verbatim source plus the call paths between
them, including dynamic-dispatch hops grep cannot follow.

- **MCP tool** (when available): `codegraph_explore`. Name a file or symbol in the query to
  read its current line-numbered source.
- **Shell** (always works): `codegraph explore "<symbol names or question>"`

Other commands worth knowing: `codegraph node <symbol>` for one symbol plus its
caller/callee trail, `codegraph impact <symbol>` before changing a widely-used function, and
`codegraph affected <files...>` to find the tests a change touches.

### Keeping the index fresh

The index does not update itself. After a **major** change, tell the user it is stale and ask
whether to reindex — do not run it unprompted, since it is their call:

```bash
codegraph status   # check staleness first
codegraph sync     # incremental — changes since the last index
codegraph index    # full rebuild from scratch
```

Major means the shape of the codebase moved: files added, renamed, deleted or moved; a module
split or merged; public API signatures changed; dependencies added or removed. Editing the
body of an existing function is not major — `codegraph explore` re-reads source at query time,
so ordinary edits stay accurate without a reindex.

## Commands

```bash
# Build (CJS + ESM with type declarations)
npm run build

# Run tests
npm test

# Run a single test file
npx vitest run tests/policy.test.ts

# Typecheck (no emit; tsup builds the declarations)
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

## Rules

### Do

- Run `npm test`, `npm run typecheck` and `npm run lint` after any logic change to `src/core/`
  before considering a task done. All three are expected to pass clean.
- Keep `evaluateAccess()` a pure function — no side effects, no external I/O.
- Preserve both CJS (`dist/index.js`) and ESM (`dist/index.mjs`) outputs; never break dual-format exports.
- Use the fluent `definePolicy<T>()` builder when writing new policy fixtures or examples.
- Keep the generic `T extends AccessControlConfig` constraint intact on all public API signatures.
- Write tests in `tests/` using Vitest; co-locate edge-case tests with the feature they cover.
- Use CodeGraph to explore before grepping, and prompt for a reindex after major structural changes — see [CodeGraph](#codegraph).

### Don't

- Don't introduce runtime dependencies — this library ships zero deps by design.
- Don't add framework-specific code anywhere in `src/`. Bindings for React, Vue and the rest
  live in their own package that consumes this one; the core stays framework-agnostic and
  imports nothing from a framework.
- Don't change the conflict-resolution default (`denyWins`) without an explicit user request.
- Don't mutate policy arrays in place; always return new arrays/objects from builder methods. A
  policy is read when an instance is built, so a later in-place edit is invisible.
- Don't remove or weaken TypeScript generics to silence type errors — fix the types properly.
- Don't use `any` types; use `unknown` or tighten the generics instead. The two exceptions are
  `EvaluationContext` and `Condition` in `types.ts`, which are `Record<string, any>` on purpose:
  `Record<string, unknown>` refuses object types without an index signature, so an
  interface-typed context would fail to compile for consumers. Keep `any` confined to those two
  definitions, and keep narrowing from `unknown` everywhere inside `conditions.ts`.

## Architecture

**`access-control-js`** is a lightweight, type-safe access control library for TypeScript supporting both RBAC and ABAC patterns. Zero runtime dependencies, dual CJS/ESM, `"sideEffects": false`.

### Core API Surface

Two entry points for different environments:

- **`getAccessControl(policy, options?)`** — Stateless, for server-side use (API routes, Server Components). `isLoading` is always `false`. Build it **per request** when the policy depends on the user; module scope is shared across concurrent requests.
- **`createAccessControlStore(initialPolicy, options?)`** — Reactive store with subscriptions for client-side use. Compatible with `useSyncExternalStore`.

Both expose `can(resource, action, context?)`, `canAll(resource, actions[], context?)`, `canAny(resource, actions[], context?)`, `canThese(resource, actions[], context?)` and `explain(resource, action, context?)`.

Options are options only — a bare context object as the second argument is not accepted; pass it as `defaultContext`.

### Policy Evaluation (`src/core/policy.ts`)

`evaluateAccess()` is the single pure function at the heart of everything. It:
1. Resolves the resource's statements — an O(1) lookup in a `PolicyIndex` when one is passed, otherwise a scan of the policy
2. Matches actions (exact or `*` wildcard)
3. Judges each condition against each input context, three-valued (see `conditions.ts`)
4. Resolves conflicts by strategy: `denyWins` (default) / `specificityWins` (its alias) / `explicitDenyWins` / `firstWins` / `lastWins`
5. Returns `false` when no statements match

`resolveDecision()` picks the winner and names the statement responsible; `resolveConflict()` is just its boolean view. `explainAccess()` goes through the same resolver, which is why `can()` and `explain()` cannot disagree — keep it that way.

`buildPolicyIndex()` groups statements by resource, preserving order within a resource because `firstWins`/`lastWins` depend on it. Both factories build one up front.

`evaluateAccessBulk()` resolves statements once then evaluates several actions — used by `getAccessControl().canThese()`. The store's snapshot instead routes all four methods through one cached `can`, since with the index a per-action lookup is cheap and sharing the cache is worth more.

### Conditions (`src/core/conditions.ts`)

Statement `contexts` are ORed; clauses within one context are ANDed. Condition keys are context paths (`"post.ownerId"`), and values are literals — sugar for `$eq` — or operator specs: `$eq $ne $in $nin $gt $gte $lt $lte $contains $exists $ref`. `$ref` resolves an operand from the context by path, which is what lets one policy serve every user.

`judgeCondition()` returns `"match" | "no-match" | "unknown"`. Unknown means the context could not settle the clause; a definite failure elsewhere still settles the condition, since false AND unknown is false. This three-valued result is what makes `strictDeny` meaningful — without it an unevaluatable deny is silently skipped, which fails open. `$exists` is never unknown; deciding absence is its purpose.

`deepEquals()` and `encodeValueForKey()` are a **pair** and live together deliberately: the first defines what equality means, the second decides what can appear in a cache key. Primitives compare strictly, Dates by timestamp, plain objects and arrays by value; `Map`, `Set`, class instances and functions by reference — and anything compared by reference is refused a cache key, since a serialized key cannot tell two instances apart. Both stop at a depth of 8, which keeps cycles safe. **If you teach one a new case, teach the other.** `tests/value-equality.test.ts` fails if they drift.

### Type System (`src/core/types.ts`)

The generic `T extends AccessControlConfig` (a `Record<string, readonly string[]>`) constrains all APIs at compile time. Resources are keys, actions are the string union from each key's array, plus `"*"`.

`EvaluationContext` and `Condition` are the two named context types — see the `any` exception in the rules above.

### Policy Builder (`src/core/policy-builder.ts`)

`definePolicy<T>()` creates a `PolicyBuilder` with a fluent `.allow()` / `.deny()` / `.build()` API. `mergePolicies(...policies)` flattens multiple policy arrays — useful for combining static base policies with dynamic user-fetched policies. Policies stay plain serializable arrays, so one can be built on the server and used unchanged in the browser.

### Client-Side Store Pattern

`createAccessControlStore()` uses a subscription + snapshot pattern, with the snapshot built on top of `getAccessControl` so server and client share one implementation of every check.

Two guarantees are **API surface**, not implementation detail — a binding package in another repo compiles against them, and `tests/store-contract.test.ts` holds them:

- `getSnapshot()` returns the same object reference until `updatePolicy` or `setLoading` changes something. Reads never invalidate it.
- Subscribers are notified once per real change. An update where policy, default context and loading state are all unchanged neither rebuilds nor notifies.

### Result Caching

The store caches check results per snapshot, on by default, shared by all four check methods; `explain()` is deliberately uncached. At most 500 entries with LRU eviction. Keys come from `encodeValueForKey`, so nested contexts and Dates cache by value — which the `$ref` pattern depends on — while a context holding a reference-compared value is evaluated every time instead. `getAccessControl` is stateless and does not cache.

### Default Context

`options.defaultContext` is merged into every check automatically. Explicit context passed at call time overrides the default on matching keys. This enables setting a user's role/attributes once at store creation rather than on every check.

### Development Warnings (`src/core/dev.ts`)

`warnOnce()` logs at most once per distinct message, gated on `NODE_ENV !== "production"` behind a `typeof process` guard so a browser bundle without a process shim simply stays quiet. Checks can run on every render, so never warn without deduplication. Used for skipped conditional denies, unrecognised options, and operator misuse.
