/**
 * Shared product tool vocabulary (#1099).
 *
 * Tool is the catalog atom. Surface is optional and only for jointly governed
 * packs (deferred `load_tools` groups and/or a shared host product boundary).
 * Hosts own implementations; this module owns names and metadata. Derive
 * HostCapabilities / ToolAvailability groups from catalog ∩ host binding.
 */

export const TOOL_HOST_IDS = ['desktop', 'cli', 'headless'] as const;
export type ToolHostId = (typeof TOOL_HOST_IDS)[number];

/** Whether a host product surface may bind the pack. Not a runtime enable flag. */
export type ToolHostSupport = 'supported' | 'unsupported';

/**
 * Reserved for future policy projections (e.g. read-only). v1 does not consume
 * these; hosts and permission stay unchanged.
 */
export type ToolEffect = 'read' | 'write' | 'shell' | 'network' | 'ui' | 'agent';

export interface CatalogToolDef {
  name: string;
  /** Optional future policy tags; unused by v1 product paths. */
  effects?: readonly ToolEffect[];
  /** Feeds HostCapabilities.capabilities when the tool is bound (e.g. office). */
  capabilityTags?: readonly string[];
}

export interface CatalogSurfaceDef {
  id: string;
  label: string;
  description: string;
  /** v1 packs are deferred load groups only. */
  economy: 'deferred';
  toolNames: readonly string[];
  hosts: Record<ToolHostId, ToolHostSupport>;
}

/** Always-on product tools (no surface) plus every surface member. */
export const MAKA_CATALOG_TOOLS: readonly CatalogToolDef[] = [
  // Core file / shell
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Write' },
  { name: 'Edit' },
  { name: 'FormatJson' },
  { name: 'Glob' },
  { name: 'Grep' },
  { name: 'StopBackgroundTask' },
  { name: 'WriteStdin' },
  // Host product always-on
  { name: 'AskUserQuestion' },
  { name: 'Skill' },
  { name: 'WebSearch' },
  { name: 'ExploreAgent' },
  { name: 'Automation' },
  { name: 'GoalSet' },
  { name: 'GoalClear' },
  { name: 'GoalStatus' },
  { name: 'GoalPause' },
  { name: 'GoalResume' },
  { name: 'task_create' },
  { name: 'task_update' },
  { name: 'task_list' },
  { name: 'task_get' },
  // Legacy task-ledger aliases still registered on some hosts
  { name: 'TaskCreate' },
  { name: 'TaskUpdate' },
  // Agent team
  { name: 'team_message' },
  { name: 'team_inbox' },
  { name: 'team_task_list' },
  { name: 'team_task_claim' },
  // office surface
  { name: 'OfficeDocument', capabilityTags: ['office'] },
  { name: 'OfficeDocumentEdit', capabilityTags: ['office'] },
  // browser surface
  { name: 'browser_navigate' },
  { name: 'browser_snapshot' },
  { name: 'browser_click' },
  { name: 'browser_type' },
  { name: 'browser_wait' },
  { name: 'browser_extract' },
  // computer_use surface
  { name: 'maka_computer' },
  // rive surface
  { name: 'RiveWorkflow' },
  // agent surface (id matches AGENT_TOOL_GROUP_ID / buildSubagentToolGroup)
  { name: 'agent_spawn' },
  { name: 'agent_swarm' },
  { name: 'agent_list' },
  { name: 'agent_output' },
];

const DESKTOP_ONLY: Record<ToolHostId, ToolHostSupport> = {
  desktop: 'supported',
  cli: 'unsupported',
  headless: 'unsupported',
};

const ALL_HOSTS: Record<ToolHostId, ToolHostSupport> = {
  desktop: 'supported',
  cli: 'supported',
  headless: 'supported',
};

/**
 * Jointly governed deferred packs. Id `agent` matches the existing
 * ToolAvailability group (`buildSubagentToolGroup`), not a separate "subagent" id.
 */
export const MAKA_CATALOG_SURFACES: readonly CatalogSurfaceDef[] = [
  {
    id: 'office',
    label: 'Office',
    description: 'Read and edit Office documents (Word, Excel, PowerPoint, PDF).',
    economy: 'deferred',
    toolNames: ['OfficeDocument', 'OfficeDocumentEdit'],
    hosts: DESKTOP_ONLY,
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Drive the embedded browser: navigate, snapshot, click, type, wait, extract.',
    economy: 'deferred',
    toolNames: [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_wait',
      'browser_extract',
    ],
    hosts: DESKTOP_ONLY,
  },
  {
    id: 'computer_use',
    label: 'Computer',
    description: 'Observe and operate an explicitly approved local application.',
    economy: 'deferred',
    toolNames: ['maka_computer'],
    hosts: DESKTOP_ONLY,
  },
  {
    id: 'rive',
    label: 'Rive',
    description:
      'Durable multi-agent Rive workflows: validate/import/run/status, scheduler, retries.',
    economy: 'deferred',
    toolNames: ['RiveWorkflow'],
    hosts: DESKTOP_ONLY,
  },
  {
    id: 'agent',
    label: 'Agent',
    description: 'Spawn, fan out, and inspect foreground child agents.',
    economy: 'deferred',
    toolNames: ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output'],
    hosts: ALL_HOSTS,
  },
];

const TOOL_BY_NAME = new Map(MAKA_CATALOG_TOOLS.map((tool) => [tool.name, tool]));
const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_BY_NAME.keys());

export function catalogToolByName(name: string): CatalogToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

export function catalogToolNameSet(): ReadonlySet<string> {
  return TOOL_NAME_SET;
}

/** Bound names that are not catalog rows (sorted). Empty means the binding is catalog-clean. */
export function unknownBoundToolNames(boundToolNames: Iterable<string>): string[] {
  const unknown: string[] = [];
  for (const name of boundToolNames) {
    if (!TOOL_BY_NAME.has(name)) unknown.push(name);
  }
  return unknown.sort();
}

export function catalogSurfaceById(id: string): CatalogSurfaceDef | undefined {
  return MAKA_CATALOG_SURFACES.find((surface) => surface.id === id);
}
