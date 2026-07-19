/**
 * Derive HostCapabilities and deferred ToolAvailability groups from the shared
 * tool catalog ∩ host binding (#1099 S1). Hosts still construct MakaTool
 * instances; this module only projects names and surface metadata.
 */

import { MAKA_CATALOG_SURFACES, catalogToolByName, type ToolHostId } from '@maka/core/tool-catalog';
import type { HostCapabilities } from './skills.js';
import type { ToolGroup } from './tool-availability.js';

/** Build skill-host capability surface from the tools this process actually bound. */
export function buildHostCapabilitiesFromBinding(
  boundToolNames: Iterable<string>,
): HostCapabilities {
  const toolNames = new Set<string>();
  const capabilities = new Set<string>();
  for (const name of boundToolNames) {
    toolNames.add(name);
    const tags = catalogToolByName(name)?.capabilityTags;
    if (!tags) continue;
    for (const tag of tags) capabilities.add(tag);
  }
  if (capabilities.size === 0) return { toolNames };
  return { toolNames, capabilities };
}

/**
 * Deferred `load_tools` groups for a host: catalog surfaces that are supported
 * on the host, deferred, and have at least one bound member. Unsupported
 * affinity never appears, even if a name were somehow bound.
 */
export function buildDeferredToolGroupsFromCatalog(
  host: ToolHostId,
  boundToolNames: Iterable<string>,
): ToolGroup[] {
  const bound = boundToolNames instanceof Set ? boundToolNames : new Set(boundToolNames);
  const groups: ToolGroup[] = [];
  for (const surface of MAKA_CATALOG_SURFACES) {
    if (surface.economy !== 'deferred') continue;
    if (surface.hosts[host] !== 'supported') continue;
    const toolNames = surface.toolNames.filter((name) => bound.has(name));
    if (toolNames.length === 0) continue;
    groups.push({
      id: surface.id,
      label: surface.label,
      description: surface.description,
      toolNames,
    });
  }
  return groups;
}
