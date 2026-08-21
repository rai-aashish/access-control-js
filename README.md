# Access Control JS

A lightweight, type-safe access control library for TypeScript applications. Designed to manage UI elements and actions based on a permission policy — so you can show, hide, or restrict features declaratively without scattering permission logic across your codebase. Supports both server-side (stateless) and client-side (reactive) environments.

## Installation

```bash
npm install access-control-js
```

## Features

- **Type-Safe**: Fully typed resources and actions based on your configuration.
- **Isomorphic**: Works on both server (Node.js/Next.js) and client (browser, any framework).
- **Reactive**: Built-in subscription store for UI updates.
- **Flexible**: Supports Role-Based (RBAC) and Attribute-Based (ABAC) access control, with comparison operators and context-relative rules.
- **Explainable**: `explain()` reports why a check came out the way it did.
- **Zero dependencies**, dual CJS/ESM, and tree-shakeable.

> **This is not an enforcement boundary.** A policy that reaches the browser is a hint about what to show, not a security control — anything on the client can be edited. Always re-check on the server, where `getAccessControl` is designed to run per request. The value of sharing one policy is that your UI and your server agree, not that the client can be trusted.

## Upgrading to 0.4.0

Four changes need attention. See [Migrating from 0.3.x](#migrating-from-03x) for details.

1. The factories take options only — a bare context object as the second argument is no longer accepted.
2. `""` is no longer a valid action.
3. Conditions holding objects, arrays or Dates now compare **by value** instead of by reference.
4. A policy is read when the instance is built, so mutating the array afterwards no longer has any effect.

## Recommended Folder Structure

```
@/lib/access-control/
  resources.ts   ← your resource & action config
  policy.ts      ← policy builder
  factory.ts     ← access control instance (client or server)
  index.ts       ← barrel export
```

---

## Usage

### Step 1 — Define Resources & Actions

```typescript
// @/lib/access-control/resources.ts
export const config = {
  posts: ['read', 'create', 'update', 'delete'],
  comments: ['create', 'delete'],
  admin: ['manage_users', 'view_logs'],
} as const;

export type AppConfig = typeof config;
```

---

### Step 2 — Define Your Policy

```typescript
// @/lib/access-control/policy.ts
import { definePolicy } from 'access-control-js';
import { type AppConfig } from './resources';

export const policy = definePolicy<AppConfig>()
  .allow('posts', ['read', 'create'])
  .deny('posts', ['delete'])
  .allow('comments', ['*'])
  .build();
```

#### Policy Builder API

| Method | Signature | Description |
|---|---|---|
| `definePolicy` | `definePolicy<T>()` | Creates a new typed `PolicyBuilder` |
| `.allow` | `.allow(resource, actions, options?)` | Adds an allow statement; `options.contexts` holds ABAC conditions |
| `.deny` | `.deny(resource, actions, options?)` | Adds a deny statement |
| `.build` | `.build()` | Returns the final `TAccessControlPolicy<T>` array |

Policies are plain arrays of plain objects. They serialize to JSON, so a policy can be built on your server, sent to the browser, and used unchanged.

---

### Step 3 — Create the Factory

Pick **one** depending on your environment.

#### Client-Side (browser, any framework)

Use `createAccessControlStore` to create a reactive store that can be updated after login.

```typescript
// @/lib/access-control/factory.ts
import { createAccessControlStore } from 'access-control-js';
import { type AppConfig } from './resources';
import { policy } from './policy';

export const authStore = createAccessControlStore<AppConfig>(policy);
```

**Check permissions:**

```typescript
import { authStore } from '@/lib/access-control/factory';

const { can } = authStore.getSnapshot();

can('posts', 'create'); // true | false
```

**Update policy after login:**

```typescript
import { authStore } from '@/lib/access-control/factory';

async function login() {
  const user = await api.login();
  authStore.updatePolicy(user.policy);
}
```

**Subscribe to policy changes:**

```typescript
import { authStore } from '@/lib/access-control/factory';

const updateUI = () => {
  const { can } = authStore.getSnapshot();
  const btn = document.getElementById('delete-btn');
  btn.style.display = can('posts', 'delete') ? 'block' : 'none';
};

updateUI();
authStore.subscribe(updateUI);

// Later, when policy updates...
authStore.updatePolicy(newPolicy); // UI updates automatically
```

#### `createAccessControlStore` Store API

| Method | Signature | Description |
|---|---|---|
| `updatePolicy` | `updatePolicy(policy, defaultContext?, options?)` | Replaces the policy, optionally updating default context and loading state |
| `setLoading` | `setLoading(boolean)` | Sets `isLoading` state and notifies subscribers |
| `subscribe` | `subscribe(listener)` | Registers a change listener; returns an unsubscribe function |
| `getSnapshot` | `getSnapshot()` | Returns a stable snapshot with `can`, `canAll`, `canAny`, `canThese`, `explain`, `policy`, `isLoading` |

The store makes two guarantees that framework bindings rely on, both covered by tests:

- `getSnapshot()` returns the **same object reference** until `updatePolicy` or `setLoading` changes something. Reading through a snapshot never invalidates it.
- Subscribers are notified **once per real change**. An update that changes nothing — the same policy, same default context, same loading state — neither rebuilds the snapshot nor notifies.

Together these make the store safe for React's `useSyncExternalStore` and its equivalents. See [Usage with Frameworks](#usage-with-frameworks).

---

#### Server-Side (API Routes / Server Components)

Use `getAccessControl` for stateless, per-request environments.

```typescript
// @/lib/access-control/factory.ts
import { getAccessControl } from 'access-control-js';
import { type AppConfig } from './resources';
import { policy } from './policy';

export const ac = getAccessControl<AppConfig>(policy);
```

**Use in an API route or Server Component:**

```typescript
import { getAccessControl } from 'access-control-js';

export async function POST(req: Request) {
  const user = await authenticate(req);
  const ac = getAccessControl<AppConfig>(user.policy);

  if (!ac.can('posts', 'create')) {
    return new Response('Forbidden', { status: 403 });
  }

  // perform action...
}
```

> Build the instance **per request** when the policy depends on the user. Module scope is shared across concurrent requests on the server, so a module-level instance holding one user's policy can answer another user's check.

#### `getAccessControl` API

Both factories expose the same check methods.

| Method | Signature | Description |
|---|---|---|
| `can` | `can(resource, action, context?)` | Returns `true` if the action is allowed |
| `canAll` | `canAll(resource, actions[], context?)` | Returns `true` if **all** actions are allowed |
| `canAny` | `canAny(resource, actions[], context?)` | Returns `true` if **any** action is allowed |
| `canThese` | `canThese(resource, actions[], context?)` | Returns a `Record<action, boolean>` |
| `explain` | `explain(resource, action, context?)` | Returns the decision plus its reasoning — see [Explaining a decision](#explaining-a-decision) |
| `policy` | `policy` | The policy array the instance was created with |
| `isLoading` | `isLoading` | Always `false` for stateless instances |

The policy is read when the instance is built, so mutating a policy array afterwards has no effect. Change policies through `updatePolicy` (store) or by building a new instance (server).

---

### Step 4 — Merging Policies

Combine a local static policy with a remote one fetched from your backend.

```typescript
// @/lib/access-control/policy.ts
import { definePolicy, mergePolicies, type TAccessControlPolicy } from 'access-control-js';
import { type AppConfig } from './resources';

// 1. Local base policy
const basePolicy = definePolicy<AppConfig>()
  .allow('posts', ['read'])
  .build();

// 2. Fetch remote policy (e.g., from DB or API)
const remotePolicy: TAccessControlPolicy<AppConfig> = await api.getPolicy();

// 3. Merge — statement order is preserved, which `firstWins`/`lastWins` depend on
export const policy = mergePolicies(basePolicy, remotePolicy);
```

| Function | Signature | Description |
|---|---|---|
| `mergePolicies` | `mergePolicies(...policies)` | Flattens multiple policy arrays into one |

---

## Conditions (ABAC)

A statement can carry `contexts` — conditions checked against the context you pass at call time.

```typescript
definePolicy<AppConfig>()
  .allow('posts', ['update'], { contexts: [{ role: 'editor' }] })
  .build();

ac.can('posts', 'update', { role: 'editor' }); // true
ac.can('posts', 'update', { role: 'viewer' }); // false
```

`contexts` is an array, and the statement matches if **any** entry matches (OR). Within one entry, every clause must hold (AND).

### Context paths

A condition key is a path, so it can read nested values:

```typescript
.allow('posts', ['update'], { contexts: [{ 'post.status': 'draft' }] })

ac.can('posts', 'update', { post: { status: 'draft' } }); // true
```

### Operators

A condition value is either a literal — sugar for `$eq` — or an operator spec. Several operators on one path are ANDed, so `{ $gte: 18, $lt: 65 }` is a range.

| Operator | Meaning |
|---|---|
| `$eq` | Equal. A bare value means this. |
| `$ne` | Not equal |
| `$in` | Context value is one of an array |
| `$nin` | Context value is none of an array |
| `$gt` `$gte` `$lt` `$lte` | Ordered comparison over numbers, strings, bigints or Dates |
| `$contains` | Substring of a string, or membership of an array, in the context |
| `$exists` | Whether the path is present in the context at all |
| `$ref` | Equal to the value at another context path |

```typescript
definePolicy<AppConfig>()
  .allow('posts', ['read'], { contexts: [{ status: { $in: ['draft', 'review'] } }] })
  .allow('posts', ['update'], { contexts: [{ level: { $gte: 3 }, tier: { $ne: 'free' } }] })
  .deny('posts', ['delete'], { contexts: [{ 'post.state': { $in: ['locked', 'archived'] } }] })
  .build();
```

### One policy for every user, with `$ref`

`$ref` resolves an operand from the context instead of hardcoding it, which is how "can edit what they own" becomes a policy rather than something rebuilt per user:

```typescript
export const policy = definePolicy<AppConfig>()
  .allow('posts', ['update'], {
    contexts: [{ 'post.ownerId': { $ref: 'user.id' } }],
  })
  .build();

// The same policy serves everyone — identity arrives with the check
ac.can('posts', 'update', { user: { id: 7 }, post: { ownerId: 7 } }); // true
ac.can('posts', 'update', { user: { id: 7 }, post: { ownerId: 9 } }); // false
```

`$ref` also works as an operand inside another operator:

```typescript
.allow('posts', ['update'], {
  contexts: [{ 'post.ownerId': { $in: { $ref: 'user.managedIds' } } }],
})
```

### How values are compared

- Primitives compare strictly, so `1` never equals `"1"`.
- **Plain objects, arrays and Dates compare by value.** Dates compare by timestamp; arrays are order-sensitive.
- `Map`, `Set`, class instances and functions compare **by reference**, because the library cannot know what equality should mean for them.
- Comparison stops at a depth of 8. Identical structures deeper than that compare unequal.

### Undecidable conditions

A condition can only be judged against a context that carries the keys it names. When it cannot, the answer is *unknown* rather than false — and an unknown **deny** is skipped, which fails open:

```typescript
const policy = definePolicy<AppConfig>()
  .allow('posts', ['delete'])
  .deny('posts', ['delete'], { contexts: [{ status: 'locked' }] })
  .build();

ac.can('posts', 'delete');                       // true  — deny skipped, status unknown
ac.can('posts', 'delete', { role: 'admin' });    // true  — still unknown
ac.can('posts', 'delete', { status: 'draft' });  // true  — deny provably does not apply
ac.can('posts', 'delete', { status: 'locked' }); // false — deny applies
```

The library tells you when this happens rather than changing the outcome for you:

- In development, a skipped conditional deny **logs a warning once**, naming the keys it needed.
- [`explain()`](#explaining-a-decision) reports them in `undecidedDenies`.

The durable fix is to make the context complete, so every deny is always decidable. `defaultContext` is the natural place for the parts that do not change per check:

```typescript
const store = createAccessControlStore<AppConfig>(policy, {
  defaultContext: { user, tenantId: user.tenantId },  // set once at login
});

can('document', 'write', { doc });  // every key your denies name is present
```

Partial knowledge still counts. If one clause of a condition definitively fails, the condition is settled even when another is unknown — false AND unknown is false:

```typescript
.deny('posts', ['delete'], { contexts: [{ status: 'locked', tenant: 'acme' }] })

ac.can('posts', 'delete', { tenant: 'globex' });  // true — cannot apply, whatever status is
```

`$exists` is never undecidable — deciding whether a path is absent is its purpose.

---

## Advanced

### Default Context

Pass a default context that is automatically merged into every permission check. Useful for multi-tenant apps and for setting the current user once.

```typescript
// Server-side
const ac = getAccessControl(policy, { defaultContext: { tenantId: '123' } });
ac.can('posts', 'read');                     // uses { tenantId: '123' }
ac.can('posts', 'read', { role: 'admin' });  // uses { tenantId: '123', role: 'admin' }

// Client-side — set at creation
const authStore = createAccessControlStore<AppConfig>(policy, {
  defaultContext: { tenantId: '123' },
});

// Update context alongside policy
authStore.updatePolicy(newPolicy, { tenantId: '456' });
```

Explicit context passed at call time overrides the default on matching keys.

### Explaining a decision

`explain()` answers "why?" — including the question the boolean cannot: *why is my deny not applying?*

```typescript
const result = ac.explain('posts', 'update', { status: 'locked' });

result.allowed;         // false
result.decidedBy;       // the statement the strategy settled on, or null
result.matched;         // every statement that matched, with its specificity
result.undecidedDenies; // conditional denies the context could not settle
result.strategy;        // the strategy that resolved it
result.reason;          // one line, for logs
```

```
posts:update denied by the deny statement at index 1 for this resource
(specificity 1), under denyWins.
```

`allowed` is always what `can()` returns for the same arguments — both go through one resolver.

### Loading State (UI)

```typescript
// Set initial loading state at creation
const store = createAccessControlStore([], { initialIsLoading: true });

// Or set it after creation
store.setLoading(true);

// Update policy and turn off loading in one go
store.updatePolicy(newPolicy, undefined, { isLoading: false });
```

### Result Caching

`createAccessControlStore` caches `can()` results by default. When several components run the same check during one render cycle, the result is served from memory instead of re-evaluating the policy.

The cache is scoped to the current snapshot and discarded whenever `updatePolicy()` or `setLoading()` changes something, so results always agree with the active policy. All four check methods share it.

```typescript
// Caching is on by default — no config needed
const authStore = createAccessControlStore<AppConfig>(policy);

// Explicitly disable if you need fresh evaluation on every call
const authStore = createAccessControlStore<AppConfig>(policy, { cache: false });
```

Details worth knowing:

- It holds at most 500 entries, evicting the least recently used.
- Contexts are keyed by value, including nested objects, arrays and Dates — so a fresh `{ user: { id: 7 } }` on every render still hits the cache.
- A context holding something compared by reference (a `Map`, a class instance) is **not** cached, since a serialized key could not tell two instances apart. It is evaluated every time instead.

> **Note:** Caching only applies to `createAccessControlStore`. `getAccessControl` is stateless and does not cache.

### Conflict Resolution

When both an allow and a deny match, a strategy decides.

You are picking a **model** first and a variant second.

**Attribute-based** — precedence comes from how specifically a statement matched:

| Strategy | Description |
|---|---|
| `denyWins` (default) | The most specific matching statements decide, and a deny among those wins |
| `explicitDenyWins` | **Any** matching deny denies, whatever its specificity (the AWS IAM model) |

**Order-based** — precedence comes from position in the policy array:

| Strategy | Description |
|---|---|
| `firstWins` | The first matching statement wins (the ordered ACL model) |
| `lastWins` | The last matching statement wins — the only strategy under which `mergePolicies(base, override)` actually overrides |

"Specificity" is the number of condition keys a statement matched on. The default therefore lets a **specific allow beat a broader deny**, which surprises people using a broad deny as a kill switch:

```typescript
const policy = definePolicy<AppConfig>()
  .deny('posts', ['*'])                                             // specificity 0
  .allow('posts', ['delete'], { contexts: [{ role: 'editor' }] })   // specificity 1
  .build();

getAccessControl(policy).can('posts', 'delete', { role: 'editor' });
// true — the more specific allow outranks the blanket deny

getAccessControl(policy, { conflictResolution: 'explicitDenyWins' })
  .can('posts', 'delete', { role: 'editor' });
// false — the deny is absolute
```

These two are **opposed capabilities, not safety levels**, so pick per policy:

- `denyWins` lets a more specific allow act as an **exception** to a deny — block a class of thing, then carve out a qualified carve-out:

  ```typescript
  .allow('posts', ['read'], { contexts: [{ tenant: 'acme' }] })
  .deny('posts',  ['read'], { contexts: [{ classification: 'restricted' }] })
  .allow('posts', ['read'], { contexts: [{ classification: 'restricted', role: 'compliance' }] })
  // the compliance officer reads restricted documents; nobody else does
  ```

- `explicitDenyWins` makes a deny **absolute**, which is what you want for a locked record, an archived document, a legal hold or a suspended account — but it makes the exception above impossible.

If your policy is a broad deny with specific allows layered on as exceptions, you need the default; `explicitDenyWins` would make those allows unreachable.

### `AccessControlOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultContext` | `EvaluationContext` | `undefined` | Merged into every check automatically |
| `conflictResolution` | `ConflictResolutionStrategy` | `'denyWins'` | Strategy for resolving conflicting allow/deny statements |
| `initialIsLoading` | `boolean` | `false` | Initial loading state (store only) |
| `cache` | `boolean` | `true` | Cache check results within each snapshot (store only) |

### Pure evaluation

The factories are conveniences over pure functions, exported for server-side use and for building your own layer on top.

| Function | Description |
|---|---|
| `evaluateAccess(policy, resource, action, context?, options?, index?)` | The single evaluator behind every check |
| `evaluateAccessBulk(policy, resource, actions, context?, options?, index?)` | Same, for several actions on one resource |
| `explainAccess(policy, resource, action, context?, options?, index?)` | Pure counterpart to `explain()`, useful for audit logs |
| `buildPolicyIndex(policy)` | Groups statements by resource; pass the result as `index` to skip re-scanning the policy on every call |

---

## Usage with Frameworks

There are no framework packages to install — the store is a plain subscribable object, so a binding is a few lines. The examples below assume `authStore` is exported from `@/lib/access-control/factory.ts`.

### React

`getSnapshot()`'s reference stability is exactly what `useSyncExternalStore` needs:

```typescript
// @/lib/access-control/factory.ts (add to existing file)
import { useSyncExternalStore } from 'react';

export const useAccessControl = () =>
  useSyncExternalStore(
    authStore.subscribe,
    authStore.getSnapshot,
    authStore.getSnapshot, // server snapshot — safe, the store is not mutated during render
  );
```

```tsx
import { useAccessControl } from '@/lib/access-control/factory';

export const CreatePostButton = () => {
  const { can, isLoading } = useAccessControl();

  if (isLoading) return <Spinner />;
  if (!can('posts', 'create')) return null;

  return <button>Create Post</button>;
};
```

---

### Vue

```typescript
// composables/useAccessControl.ts
import { shallowRef, onUnmounted } from 'vue';
import { authStore } from '@/lib/access-control/factory';

export const useAccessControl = () => {
  const snapshot = shallowRef(authStore.getSnapshot());

  const unsubscribe = authStore.subscribe(() => {
    snapshot.value = authStore.getSnapshot();
  });

  onUnmounted(unsubscribe);

  return snapshot;
};
```

```vue
<!-- CreatePostButton.vue -->
<script setup lang="ts">
import { useAccessControl } from '@/composables/useAccessControl';

const ac = useAccessControl();
</script>

<template>
  <span v-if="ac.isLoading">Loading...</span>
  <button v-else-if="ac.can('posts', 'create')">Create Post</button>
</template>
```

---

## Migrating from 0.3.x

### The factories take options only

Both factories used to accept either an options object or a bare context object, guessing which you meant from its keys — and the two guessed differently. Pass a context as `defaultContext`:

```diff
- getAccessControl(policy, { tenantId: '123' })
+ getAccessControl(policy, { defaultContext: { tenantId: '123' } })

- createAccessControlStore(policy, { tenantId: '123' })
+ createAccessControlStore(policy, { defaultContext: { tenantId: '123' } })
```

TypeScript flags every call site. In JavaScript, an unrecognised option key logs a warning in development.

### `""` is no longer a valid action

It was only ever in the type declarations and matched nothing. Remove it from any `actions` array; use `'*'` for "all actions".

### Non-primitive conditions compare by value

A condition holding an object, array or Date now compares structurally:

```typescript
.allow('posts', ['read'], { contexts: [{ scope: { org: 1 } }] })

ac.can('posts', 'read', { scope: { org: 1 } });
// 0.3.x: false — a different object reference
// 0.4.0: true  — equal by value
```

Reference comparison was unreachable in practice: a policy loaded as JSON can never share an object reference with your runtime context, so such a condition could only ever be false. If you relied on one never matching, remove it. `Map`, `Set` and class instances still compare by reference.

### A policy is read when the instance is built

Statements are grouped by resource up front, so a later in-place edit is invisible:

```typescript
const policy: TAccessControlStatement<AppConfig>[] = [
  { resource: 'posts', actions: ['read'], effect: 'allow' },
];
const ac = getAccessControl<AppConfig>(policy);

policy.push({ resource: 'posts', actions: ['delete'], effect: 'allow' });

ac.can('posts', 'delete');
// 0.3.x: true  — every check re-scanned the live array
// 0.4.0: false — the instance kept the policy it was handed
```

Change policies through `updatePolicy` on the store, or by building a new instance on the server. This was never a supported path; 0.3.x just happened to notice.

Related: `updatePolicy` now returns early when the policy, default context and loading state are all unchanged, so calling it with the same policy no longer rebuilds the snapshot or notifies subscribers. If you were using that to force a re-render or clear the cache, pass a new policy array instead — cached results stay valid when the policy has not changed, because evaluation is pure.

### New in 0.4.0

- [Operators and `$ref`](#operators) for context-relative conditions, and [context paths](#context-paths)
- [`explain()`](#explaining-a-decision)
- [`explicitDenyWins`](#conflict-resolution) for absolute denies
- [Undecidable denies](#undecidable-conditions) are reported instead of silently skipped
- Nested contexts are now cached, and the cache is bounded
