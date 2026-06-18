import { type BackendRegistry, FakeBackend } from '@maka/runtime';

/**
 * Backend wiring for headless eval. The engine stays backend-agnostic
 * (runExperiment takes `registerBackends`); the default remains only the inert
 * stub. Real backend callers must provide their own factory and an explicit
 * `realBackendIsolation` boundary to runExperiment.
 */

/** Register the deterministic stub backend ('fake') — no model, no tools. */
export function registerFakeBackend(registry: BackendRegistry): void {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
}
