# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); while the major version is
`0`, a minor bump may carry breaking changes.

## 0.4.0

### Breaking

- **Both factories take options only.** `getAccessControl` and `createAccessControlStore`
  used to accept either an options object or a bare context object, guessing from its keys
  which was meant — and the two guessed differently, so `{ cache: true }` was a context to
  one and options to the other. Pass a context as `defaultContext`. TypeScript flags every
  call site; in JavaScript an unrecognised option key warns in development.
- **Non-primitive conditions compare by value.** A condition holding a plain object, array
  or Date now compares structurally rather than by reference. Reference comparison was
  unreachable in practice — a policy loaded as JSON can never share an object reference
  with a runtime context, so such a condition could only ever be false. `Map`, `Set`, class
  instances and functions still compare by reference.
- **`""` is no longer a valid action.** It existed only in the type declarations and
  matched nothing. Use `'*'` for all actions.
- **A policy is read when the instance is built.** Mutating a policy array afterwards has
  no effect; change policies through `updatePolicy` or by building a new instance. This was
  never a supported path, but `getAccessControl` previously re-scanned the array on every
  check and so happened to notice.

### Added

- **Condition operators**: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`,
  `$contains`, `$exists`. Several on one path are ANDed, so `{ $gte: 18, $lt: 65 }` is a
  range. A bare value remains sugar for `$eq`, so existing policies are unchanged.
- **Context paths**: a condition key such as `"post.ownerId"` reads a nested value.
- **`$ref`**: resolves an operand from the context by path, so one policy can serve every
  user — `{ "post.ownerId": { $ref: "user.id" } }` expresses ownership without baking in
  an id. Works as an operator shorthand and as an operand inside another operator.
- **`explain(resource, action, context?)`** on both factories, and the pure
  `explainAccess`. Reports which statements matched, which one the strategy settled on,
  which conditional denies the context could not settle, and a one-line reason. Its verdict
  always agrees with `can()` — both resolve through one function.
- **`explicitDenyWins`** conflict strategy: any matching deny denies, whatever its
  specificity — the AWS IAM model, and what you want when a deny is a hard stop. It is the
  opposite capability to the default, not a safer version of it: `denyWins` lets a more
  specific allow act as an exception to a deny, which `explicitDenyWins` makes impossible.
- **Undecidable denies are reported rather than silently skipped.** A conditional deny the
  context cannot judge still fails open, as before, but it now warns once in development
  naming the keys it needed, and `explain().undecidedDenies` lists every one. There is no
  option to change the outcome — make the context complete instead, which `defaultContext`
  exists for.
- **`buildPolicyIndex`**, and an optional `index` parameter on `evaluateAccess`,
  `evaluateAccessBulk` and `explainAccess`, for callers that evaluate against one policy
  repeatedly.
- **`EvaluationContext` and `Condition`** types, plus `ConditionOperators`, `ContextRef`,
  `AccessExplanation`, `ExplainedStatement` and `PolicyIndex`.
- **`"sideEffects": false`**, so bundlers can drop unused exports. Importing only
  `getAccessControl` leaves the store out of the bundle.

### Fixed

- **The result cache could contradict the evaluator.** Cache keys came from
  `JSON.stringify` while matching compared with `===`, so two structurally identical
  objects passed as context collapsed into one entry and the second check was served the
  first one's answer. Keys are now faithful to the comparison they mirror, and a value
  compared by reference makes its context uncacheable rather than mis-keyed. Caching is on
  by default, so this was the default path.
- **The result cache was unbounded.** It now holds at most 500 entries, evicting the least
  recently used. It previously grew for the life of a snapshot, so per-row context checks
  leaked.
- **`canAny` and `canThese` bypassed the cache** while `canAll` used it. All four check
  methods now share one cached path.
- **`updatePolicy` notified subscribers on a no-op**, rebuilding the snapshot and
  re-rendering every subscriber even when the policy, default context and loading state
  were all unchanged. It now returns early, matching `setLoading`. If you relied on a
  same-policy update to force a re-render or discard the cache, pass a new policy array
  instead; cached results stay valid when the policy has not changed, because evaluation
  is pure.
- **A check with no context skipped conditions entirely**, so `$exists: false` could never
  match. Conditions are now judged against an empty context instead.

### Changed

- Statements are grouped by resource once per instance, so a check is a map lookup instead
  of a scan of the whole policy.
- The store's snapshot is built on `getAccessControl` rather than reimplementing the check
  methods, so server and client share one implementation.
- Conditions are judged three-valued: a clause the context cannot settle is *unknown*
  rather than false, and a provable failure elsewhere in the condition still settles it.
  This is what allows an undecidable deny to be reported rather than being
  indistinguishable from one that provably does not apply.
- Nested contexts are cached, which the `$ref` pattern depends on — a fresh
  `{ user: { id: 7 } }` on every render still hits the cache.

## 0.3.0

- Added result caching for `can()` evaluations in `createAccessControlStore`, with a
  `cache` option.

## 0.2.0

- Added `initialIsLoading` to control the store's initial loading state.

## 0.1.0

- Initial release: `getAccessControl`, `createAccessControlStore`, `definePolicy`,
  `mergePolicies`, RBAC and ABAC evaluation with `denyWins`, `firstWins` and `lastWins`
  conflict resolution.
