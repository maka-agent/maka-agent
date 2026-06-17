import { canonicalizeToolSet } from './request-shape.js';
import { LOAD_TOOL_NAME, toolNamesForNamespaces, type DeferredToolCatalog } from './load-tool.js';
import type { MakaTool } from './tool-runtime.js';

/**
 * The minimal shape this module needs from an AI SDK `StepResult`: the tool
 * calls made in that step. Kept structural so the derivation is decoupled from
 * the SDK types and trivially testable.
 */
export interface StepLike {
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
}

function extractNamespace(input: unknown): string | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === 'object' && typeof (value as { namespace?: unknown }).namespace === 'string') {
    return (value as { namespace: string }).namespace;
  }
  return undefined;
}

/**
 * Collect the deferred namespaces that have been loaded so far this turn by
 * scanning prior steps' `load_tool` calls. Stateless: derived purely from the
 * step history the SDK hands `prepareStep`, so there is no race with tool
 * execution and no per-turn mutable accumulator.
 */
export function loadedNamespacesFromSteps(steps: ReadonlyArray<StepLike> | undefined): Set<string> {
  const out = new Set<string>();
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (call?.toolName !== LOAD_TOOL_NAME) continue;
      const namespace = extractNamespace(call.input);
      if (namespace) out.add(namespace);
    }
  }
  return out;
}

/**
 * The minimal shape this module needs from a durable `RuntimeEvent`: a
 * `function_call` content carrying the tool name and args. Kept structural so
 * the seed is decoupled from the `@maka/core` event types and trivially
 * testable.
 */
export interface RuntimeEventLike {
  content?: { kind?: string; name?: string; args?: unknown } | undefined;
}

/**
 * Reconstruct the cross-turn loaded namespaces from the durable RuntimeEvent
 * ledger (Slice 7, Codex Δ4). Scans committed `load_tool` calls — the same
 * shape the in-turn derivation reads from step history — so a tool loaded in an
 * earlier turn is re-advertised at the next turn's start. Durable by
 * construction: it survives history compaction and session recovery because it
 * reads the ledger, not the prompt tail. Append-only ratchet: an aborted load
 * simply never reaches committed history, and re-loading on retry is idempotent.
 */
export function seedNamespacesFromRuntimeEvents(
  events: ReadonlyArray<RuntimeEventLike> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const event of events ?? []) {
    const content = event?.content;
    if (!content || content.kind !== 'function_call' || content.name !== LOAD_TOOL_NAME) continue;
    const namespace = extractNamespace(content.args);
    if (namespace) out.add(namespace);
  }
  return out;
}

export interface DeferredPrepareStepInput {
  /** Full registry (used to recompute the active subset). */
  tools: readonly MakaTool[];
  /** The repair/invalid tool, kept out of the advertised set. */
  invalidTool: MakaTool;
  /** Namespace → deferred tool names. */
  catalog: DeferredToolCatalog;
  /**
   * Durable namespaces loaded in prior turns (cross-turn ratchet, Slice 7).
   * Empty when only same-turn activation is wired.
   */
  seedNamespaces?: ReadonlySet<string>;
  /**
   * Receives the active-tool snapshot computed for the step about to run, so
   * the execute-boundary guard can reject a deferred tool that is not yet
   * active in this step (Slice 5).
   */
  onActiveSnapshot?: (active: ReadonlySet<string>) => void;
}

/**
 * Compute the model-visible active tool names for the next step:
 * direct tools + `load_tool` + every deferred tool whose namespace is loaded
 * (seed from prior turns ∪ this turn's `load_tool` calls). Append-only by
 * construction — the loaded set never shrinks within a turn.
 */
export function computeActiveTools(
  input: DeferredPrepareStepInput,
  steps: ReadonlyArray<StepLike> | undefined,
): string[] {
  const namespaces = new Set<string>([
    ...(input.seedNamespaces ?? []),
    ...loadedNamespacesFromSteps(steps),
  ]);
  const loadedNames = toolNamesForNamespaces(input.catalog, namespaces);
  const active = canonicalizeToolSet(input.tools, input.invalidTool, loadedNames).activeTools;
  input.onActiveSnapshot?.(new Set(active));
  return active;
}

/**
 * Build the `prepareStep` callback the AI SDK invokes before every step. It
 * re-derives `activeTools` from the step history so a tool loaded at step N is
 * advertised to the provider at step N+1 of the same turn — without mutating
 * the cached prefix tools array out from under the SDK.
 */
export function buildDeferredPrepareStep(
  input: DeferredPrepareStepInput,
): (options: { steps?: ReadonlyArray<StepLike> }) => { activeTools: string[] } {
  return ({ steps }) => ({ activeTools: computeActiveTools(input, steps) });
}
