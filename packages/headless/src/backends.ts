import { type BackendRegistry, FakeBackend } from '@maka/runtime';

/**
 * Backend wiring for headless eval. The engine stays backend-agnostic
 * (runExperiment takes `registerBackends`); today only the inert stub is
 * wired, because eval fails closed on anything that runs real tools.
 *
 * The real ('ai-sdk') backend — model + builtin tools + credential plumbing —
 * returns alongside the isolated executor (follow-up PR), since it can only
 * run safely inside one.
 */

/** Register the deterministic stub backend ('fake') — no model, no tools. */
export function registerFakeBackend(registry: BackendRegistry): void {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
}
