# Access Control JS

A lightweight, type-safe access control library for TypeScript applications. Designed to manage UI elements and actions based on a permission policy — so you can show, hide, or restrict features declaratively without scattering permission logic across your codebase. Supports both server-side (stateless) and client-side (reactive) environments.

## Installation

```bash
npm install access-control-js
```

## Features

- **Type-Safe**: Fully typed resources and actions based on your configuration.
- **Isomorphic**: Works on both server (Node.js/Next.js) and client (React/Vanilla JS).
- **Reactive**: Built-in subscription store for UI updates.
- **Flexible**: Supports Role-Based (RBAC) and Attribute-Based (ABAC) access control.

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
| `.allow` | `.allow(resource, actions, contexts?)` | Adds an allow statement |
| `.deny` | `.deny(resource, actions, contexts?)` | Adds a deny statement |
| `.build` | `.build()` | Returns the final `TAccessControlPolicy<T>` array |

---

### Step 3 — Create the Factory

Pick **one** depending on your environment.

#### Client-Side (Vanilla JS / React)

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
| `getSnapshot` | `getSnapshot()` | Returns a stable snapshot with `can`, `canAll`, `canAny`, `canThese`, `policy`, `isLoading` |

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
import { ac } from '@/lib/access-control/factory';

export async function POST(req: Request) {
  if (!ac.can('posts', 'create')) {
    return new Response('Forbidden', { status: 403 });
  }

  // perform action...
}
```

#### `getAccessControl` API

| Method | Signature | Description |
|---|---|---|
| `can` | `can(resource, action, context?)` | Returns `true` if the action is allowed |
| `canAll` | `canAll(resource, actions[], context?)` | Returns `true` if **all** actions are allowed |
| `canAny` | `canAny(resource, actions[], context?)` | Returns `true` if **any** action is allowed |
| `canThese` | `canThese(checks[])` | Returns a `Record<action, boolean>` for each check |
| `policy` | `policy` | The policy array the instance was created with |
| `isLoading` | `isLoading` | Always `false` for stateless instances |

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

// 3. Merge — last policy takes precedence on overlaps
export const policy = mergePolicies(basePolicy, remotePolicy);
```

| Function | Signature | Description |
|---|---|---|
| `mergePolicies` | `mergePolicies(...policies)` | Flattens multiple policy arrays into one |

---

## Advanced

### Default Context (ABAC)

Pass a default context that is automatically merged into every permission check. Useful for multi-tenant apps.

```typescript
// Server-side
const ac = getAccessControl(policy, { defaultContext: { churchId: '123' } });
ac.can('posts', 'read');                     // uses { churchId: '123' }
ac.can('posts', 'read', { role: 'admin' });  // uses { churchId: '123', role: 'admin' }

// Client-side — set at creation
const authStore = createAccessControlStore<AppConfig>(policy, { defaultContext: { churchId: '123' } });

// Update context alongside policy
authStore.updatePolicy(newPolicy, { churchId: '456' });
```

### Loading State (UI)

```typescript
// Set initial loading state at creation
const store = createAccessControlStore([], { initialIsLoading: true });

// Or set it after creation
store.setLoading(true);

// In React
const { isLoading, can } = useAccessControl();
if (isLoading) return <Spinner />;

// Update policy and turn off loading in one go
store.updatePolicy(newPolicy, undefined, { isLoading: false });
```

### Result Caching

`createAccessControlStore` caches `can()` results by default. When multiple components call the same check (e.g. `can('posts', 'edit')`) during the same render cycle, the result is served from an in-memory cache instead of re-evaluating the policy each time.

The cache is scoped to the current snapshot — it is discarded automatically whenever `updatePolicy()` or `setLoading()` is called, so results are always consistent with the active policy.

```typescript
// Caching is on by default — no config needed
const authStore = createAccessControlStore<AppConfig>(policy);

// Explicitly disable if you need fresh evaluation on every call
const authStore = createAccessControlStore<AppConfig>(policy, { cache: false });
```

> **Note:** Caching only applies to `createAccessControlStore`. `getAccessControl` is stateless and does not cache.

### Conflict Resolution

By default, any deny rule at the highest specificity blocks access (`denyWins`). You can change this:

| Strategy | Description |
|---|---|
| `denyWins` (default) | Any deny rule at the highest specificity blocks access |
| `firstWins` | The first matching rule in the policy array determines the result |
| `lastWins` | The last matching rule in the policy array determines the result |

```typescript
const ac = getAccessControl(policy, { conflictResolution: 'lastWins' });
```

### `AccessControlOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultContext` | `Record<string, any>` | `undefined` | Merged into every `can()` call automatically |
| `conflictResolution` | `'denyWins' \| 'firstWins' \| 'lastWins'` | `'denyWins'` | Strategy for resolving conflicting allow/deny rules |
| `initialIsLoading` | `boolean` | `false` | Initial loading state for the store (only used by `createAccessControlStore`) |
| `cache` | `boolean` | `true` | Cache `can()` results within each snapshot; auto-invalidated on `updatePolicy()`/`setLoading()` (only used by `createAccessControlStore`) |

---

## Usage with Frameworks

The examples below assume `authStore` is already exported from `@/lib/access-control/factory.ts`.

### React

```typescript
// @/lib/access-control/factory.ts (add to existing file)
import { useSyncExternalStore } from 'react';

export const useAccessControl = () =>
  useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
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

