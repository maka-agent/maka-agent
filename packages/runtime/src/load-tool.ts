import { z } from 'zod';

import type { MakaTool } from './tool-runtime.js';

/** Canonical name of the always-on catalog/lookup tool. */
export const LOAD_TOOL_NAME = 'load_tool';

/**
 * One catalog card. A namespace groups one or more deferred tools that load
 * together (e.g. the six `browser_*` tools load as one `browser` group). The
 * `summary` is the one-line description shown to the model so it knows the
 * capability exists — only the parameter schema is deferred, never the
 * existence.
 */
export interface DeferredNamespaceCard {
  namespace: string;
  summary: string;
  toolNames: string[];
}

export type DeferredToolCatalog = readonly DeferredNamespaceCard[];

/**
 * Resolve the set of deferred tool names activated by a set of loaded
 * namespaces. Unknown namespaces are ignored (forward-compatible: a stale
 * `load_tool` call in replayed history never throws here). Shared by the
 * `load_tool` impl and the backend's per-step activation derivation.
 */
export function toolNamesForNamespaces(
  catalog: DeferredToolCatalog,
  namespaces: Iterable<string>,
): Set<string> {
  const wanted = new Set(namespaces);
  const names = new Set<string>();
  for (const card of catalog) {
    if (wanted.has(card.namespace)) {
      for (const name of card.toolNames) names.add(name);
    }
  }
  return names;
}

function renderCatalog(catalog: DeferredToolCatalog): string {
  const lines = catalog.map((card) => `- ${card.namespace}: ${card.summary}`);
  return [
    'Load additional tool groups on demand. These capabilities exist but their full',
    'parameter schemas are withheld to keep each turn lean. Call load_tool with a',
    'namespace; the tools it returns become callable on your next step.',
    '',
    'Available groups:',
    ...lines,
  ].join('\n');
}

/**
 * Build the always-on `load_tool` catalog tool from a deferred-tool catalog.
 * It is a lookup (not a search): the model sees every namespace card in the
 * description and expands one by name. The result is intentionally thin —
 * `{ loaded: [...toolNames] }`, never the schema (which would double-bill once
 * in history and once in the provider tools on the next step).
 */
export function buildLoadTool(catalog: DeferredToolCatalog): MakaTool {
  const namespaces = catalog.map((card) => card.namespace);
  const namespaceSchema =
    namespaces.length > 0
      ? z.enum(namespaces as [string, ...string[]])
      : z.string();

  return {
    name: LOAD_TOOL_NAME,
    description: renderCatalog(catalog),
    exposure: 'direct',
    permissionRequired: false,
    parameters: z.object({
      namespace: namespaceSchema.describe('The tool group to load.'),
    }),
    impl: ({ namespace }: { namespace: string }) => {
      const card = catalog.find((c) => c.namespace === namespace);
      if (!card) {
        const available = catalog.map((c) => c.namespace).join(', ');
        throw new Error(`Unknown tool group "${namespace}". Available: ${available}.`);
      }
      return { loaded: [...card.toolNames] };
    },
  };
}
