# Workspace privacy context

`WorkspacePrivacyContext` is the shared contract for privacy-sensitive operations. Its current shape is deliberately small:

```ts
export interface WorkspacePrivacyContext {
  incognitoActive: boolean;
}
```

## Authority

The main process owns the effective workspace privacy state. Renderers may request a change and display the current value, but a renderer-provided value is never proof of the effective state.

The current authority path is:

- `apps/desktop/src/renderer/settings/general-settings-page.tsx` requests settings changes.
- `apps/desktop/src/main/main.ts` resolves the effective state through `getWorkspacePrivacyContext()`.
- Main-process consumers receive that resolved context rather than trusting renderer input.

`defaultWorkspacePrivacyContext()` returns `{ incognitoActive: false }` for explicit initialization. `validateWorkspacePrivacyContext()` rejects malformed input; it never converts missing or invalid data to `false`. Boundaries that cannot resolve a valid authoritative context must fail closed.

## Consumer rule

`incognitoActive: false` only means that incognito mode did not block the operation. It is not general permission to read, write, search, capture, or transmit data. Every consumer must still apply its own settings, permission, and retention rules.

When `incognitoActive` is true, current durable-data consumers enforce these boundaries:

- Thread search returns a disabled result instead of searching stored threads.
- Local memory rejects durable reads and writes.

New privacy-sensitive consumers must take the main-owned context at their existing boundary and define a fail-closed incognito result. Do not add another incognito flag, copy the state into a parallel store, or let a renderer self-attest.

## Contract changes

Adding fields, changing scope, or changing default semantics is a cross-cutting contract change. Update the core type and validator, main-process authority path, every consumer, tests, and this document together.
