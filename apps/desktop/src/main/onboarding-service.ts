/**
 * Onboarding service — main-process glue between the @maka/core
 * onboarding contract and the desktop stores/IPC (PR110b).
 *
 * The service produces `OnboardingSnapshot` via:
 *   1. ConnectionStore.list() + ConnectionStore.getDefault()
 *   2. Per-connection secret presence resolved in PARALLEL via the
 *      credential store (@kenji PR110b perf gate — never serialize
 *      these lookups).
 *   3. SessionStore.list() (the runtime layer's listSessions handles
 *      this for us; we pass it in as a callback)
 *   4. SettingsStore.get() for milestones (already sanitized by
 *      normalizeSettings on read)
 *   5. `deriveOnboardingState()` from @maka/core
 *
 * The service NEVER throws credential errors to the renderer; a
 * failed secret lookup is treated as "no secret" with a generalized
 * dev-safe log line.
 *
 * Quick Chat input validation lives here too: setMilestone arguments
 * are checked against the closed enum + status union before reaching
 * the SettingsStore.
 */

import {
  deriveOnboardingState,
  ONBOARDING_MILESTONE_IDS,
  type OnboardingMilestone,
  type OnboardingMilestoneId,
  type OnboardingState,
  type SessionSummary,
} from '@maka/core';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { CredentialStore } from './credential-store.js';

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
}

export interface OnboardingServiceDeps {
  listConnections(): Promise<LlmConnection[]>;
  getDefaultSlug(): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  getMilestones(): Promise<OnboardingMilestone[]>;
  upsertMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
  clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
  hasApiKey(slug: string): Promise<boolean>;
}

export interface OnboardingService {
  getSnapshot(): Promise<OnboardingSnapshot>;
  setMilestone(
    id: unknown,
    status: unknown,
  ): Promise<OnboardingSnapshot>;
  clearMilestone(id: unknown): Promise<OnboardingSnapshot>;
}

/**
 * Build the desktop OnboardingService. The constructor takes injected
 * deps (rather than reading the global stores) so the service is
 * trivially unit-testable: a fake `OnboardingServiceDeps` mirrors the
 * real stores in tests.
 */
export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  return {
    async getSnapshot(): Promise<OnboardingSnapshot> {
      const [connections, defaultSlug, sessions, milestones] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
        deps.getMilestones(),
      ]);

      // @kenji PR110b perf gate: per-connection secret lookup must run
      // in parallel, NOT serialized. Even with 4-5 connections, async
      // safeStorage reads can add up to noticeable startup latency on
      // cold open.
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            const hasKey = await deps.hasApiKey(connection.slug);
            return [connection.slug, hasKey] as const;
          } catch (error) {
            // @kenji + @xuan PR110b gate: credential errors must NOT
            // leak to the renderer. Log a generalized dev-safe line
            // and treat the connection as having no secret. The user
            // ends up on `needs_connection_credentials` for that
            // slug, which is the right user-facing fix path anyway.
            console.warn(
              `[onboarding] failed to read secret for ${connection.slug}; treating as missing.`,
              describeErrorClass(error),
            );
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);

      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions,
        secrets,
      });

      return { state, milestones };
    },

    async setMilestone(id: unknown, status: unknown): Promise<OnboardingSnapshot> {
      // Strict input validation BEFORE touching the store.
      if (typeof id !== 'string' || !isOnboardingMilestoneId(id)) {
        throw new Error('INVALID_MILESTONE_ID');
      }
      if (status !== 'completed' && status !== 'skipped') {
        throw new Error('INVALID_MILESTONE_STATUS');
      }
      // Timestamp is stamped inside the store (Date.now()); renderer
      // never controls it.
      const milestones = await deps.upsertMilestone(id, status);
      // After the write, re-derive snapshot. State could change (e.g.
      // the user finished `first_chat_sent` while in `ready_empty`
      // → next derive should reflect new history). Re-using the
      // already-fetched milestones avoids a settings round-trip.
      const [connections, defaultSlug, sessions] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
      ]);
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            return [connection.slug, await deps.hasApiKey(connection.slug)] as const;
          } catch {
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);
      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions,
        secrets,
      });
      return { state, milestones };
    },

    async clearMilestone(id: unknown): Promise<OnboardingSnapshot> {
      if (typeof id !== 'string' || !isOnboardingMilestoneId(id)) {
        throw new Error('INVALID_MILESTONE_ID');
      }
      const milestones = await deps.clearMilestone(id);
      const [connections, defaultSlug, sessions] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
        deps.listSessions(),
      ]);
      const secretEntries = await Promise.all(
        connections.map(async (connection) => {
          try {
            return [connection.slug, await deps.hasApiKey(connection.slug)] as const;
          } catch {
            return [connection.slug, false] as const;
          }
        }),
      );
      const secrets: Record<string, boolean> = Object.fromEntries(secretEntries);
      const state = deriveOnboardingState({
        connections,
        defaultSlug: defaultSlug ?? undefined,
        sessions,
        secrets,
      });
      return { state, milestones };
    },
  };
}

function isOnboardingMilestoneId(value: string): value is OnboardingMilestoneId {
  return (ONBOARDING_MILESTONE_IDS as readonly string[]).includes(value);
}

/**
 * Return a generalized error class string ('error_name' or 'unknown')
 * suitable for dev logs. We never log the underlying error message
 * because it might contain credential bytes / paths / etc.
 */
function describeErrorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'unknown';
}

/**
 * Bind helpers that wire the live `SettingsStore` + `ConnectionStore`
 * + credential store to `OnboardingServiceDeps`. Exposed separately so
 * tests can mix-and-match: real settings store + fake credential store,
 * etc.
 */
export function bindOnboardingDeps(input: {
  settingsStore: {
    get(): Promise<{ onboarding: { milestones: OnboardingMilestone[] } }>;
    upsertOnboardingMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingMilestone[]>;
    clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
  };
  connectionStore: {
    list(): Promise<LlmConnection[]>;
    getDefault(): Promise<string | null>;
  };
  credentialStore: Pick<CredentialStore, 'getSecret'>;
  listSessions(): Promise<SessionSummary[]>;
}): OnboardingServiceDeps {
  return {
    listConnections: () => input.connectionStore.list(),
    getDefaultSlug: () => input.connectionStore.getDefault(),
    listSessions: () => input.listSessions(),
    getMilestones: async () => (await input.settingsStore.get()).onboarding.milestones,
    upsertMilestone: (id, status) => input.settingsStore.upsertOnboardingMilestone(id, status),
    clearMilestone: (id) => input.settingsStore.clearOnboardingMilestone(id),
    hasApiKey: async (slug) => {
      const key = await input.credentialStore.getSecret(slug, 'api_key');
      return typeof key === 'string' && key.length > 0;
    },
  };
}
