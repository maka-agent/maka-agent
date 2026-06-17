import type {
  ToolSourceEconomyDiagnostic,
  ToolSourceId,
} from '@maka/core/usage-stats/types';
import { z } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export const CONNECT_TOOL_SOURCE_NAME = 'connect_tool_source';
export const CORE_TOOL_SOURCE_ID = 'core';

const DEFAULT_CORE_TOOL_NAMES = ['Read', 'Glob', 'Grep'] as const;

export interface ToolSourceDefinition {
  id: ToolSourceId;
  toolNames: readonly string[];
  label?: string;
  description?: string;
}

export type ToolSourceEconomyConfig =
  | { mode?: 'full' }
  | {
      mode: 'source_economy';
      coreToolNames?: readonly string[];
      initialSourceIds?: readonly ToolSourceId[];
      connectorToolName?: string;
      sourceDefinitions?: readonly ToolSourceDefinition[];
    };

export interface ToolSourceEconomySelection {
  tools: MakaTool[];
  diagnostic?: ToolSourceEconomyDiagnostic;
}

interface SourceInfo {
  id: ToolSourceId;
  label?: string;
  description?: string;
  toolNames: string[];
}

interface SourceCatalog {
  coreToolNames: Set<string>;
  sourceByToolName: Map<string, ToolSourceId>;
  sources: Map<ToolSourceId, SourceInfo>;
}

export class ToolSourceEconomyRuntime {
  private readonly enabledSourceIds = new Set<ToolSourceId>();
  private readonly mode: 'full' | 'source_economy';
  private readonly connectorToolName: string;
  private readonly catalog: SourceCatalog;

  constructor(
    private readonly tools: readonly MakaTool[],
    config: ToolSourceEconomyConfig | undefined,
  ) {
    const economyConfig = config?.mode === 'source_economy' ? config : undefined;
    this.mode = economyConfig ? 'source_economy' : 'full';
    this.connectorToolName = economyConfig
      ? economyConfig.connectorToolName ?? CONNECT_TOOL_SOURCE_NAME
      : CONNECT_TOOL_SOURCE_NAME;
    this.catalog = buildSourceCatalog(tools, economyConfig);

    if (economyConfig) {
      for (const sourceId of economyConfig.initialSourceIds ?? []) {
        if (this.catalog.sources.has(sourceId)) {
          this.enabledSourceIds.add(sourceId);
        }
      }
    }
  }

  selectTools(): ToolSourceEconomySelection {
    if (this.mode === 'full') {
      return { tools: [...this.tools] };
    }

    const visibleTools = this.tools.filter((tool) => this.isToolVisible(tool));
    const connectorTool = this.buildConnectorTool();
    return {
      tools: [...visibleTools, connectorTool],
      diagnostic: this.buildDiagnostic(),
    };
  }

  private isToolVisible(tool: MakaTool): boolean {
    if (this.catalog.coreToolNames.has(tool.name)) return true;
    const sourceId = this.catalog.sourceByToolName.get(tool.name);
    if (sourceId === undefined) return true;
    return this.enabledSourceIds.has(sourceId);
  }

  private buildConnectorTool(): MakaTool<{ source: string }, ConnectToolSourceResult> {
    return {
      name: this.connectorToolName,
      description: 'Enable a named tool source for later requests in this backend instance.',
      parameters: z.object({
        source: z.string().min(1).describe('Source id to enable for later model requests.'),
      }),
      permissionRequired: false,
      impl: ({ source }) => this.connectSource(source),
    };
  }

  private connectSource(source: string): ConnectToolSourceResult {
    const sourceInfo = this.catalog.sources.get(source);
    if (!sourceInfo) {
      return {
        ok: false,
        source,
        error: 'unknown_source',
        enabledSources: this.sortedEnabledSourceIds(),
        availableSources: this.availableSources(),
      };
    }

    const toolNames = sourceInfo.toolNames
      .filter((toolName) => !this.catalog.coreToolNames.has(toolName))
      .sort((a, b) => a.localeCompare(b));
    if (toolNames.length === 0) {
      return {
        ok: false,
        source,
        error: 'source_has_no_tools',
        enabledSources: this.sortedEnabledSourceIds(),
        availableSources: this.availableSources(),
      };
    }

    const wasEnabled = this.enabledSourceIds.has(source);
    this.enabledSourceIds.add(source);
    return {
      ok: true,
      source,
      newlyEnabled: !wasEnabled,
      enabledSources: this.sortedEnabledSourceIds(),
      availableSources: this.availableSources(),
      availableNextRequest: true,
      tools: toolNames,
    };
  }

  private buildDiagnostic(): ToolSourceEconomyDiagnostic {
    const availableSourceIds = this.availableSources().map((source) => source.id);
    return {
      mode: 'source_economy',
      enabledSourceIds: this.sortedEnabledSourceIds(),
      availableSourceIds,
      connectorToolName: this.connectorToolName,
      coreToolNames: [...this.catalog.coreToolNames].sort((a, b) => a.localeCompare(b)),
      visibleToolNamesBySource: sourceToolNamesById(this.catalog.sources),
    };
  }

  private availableSources(): ConnectToolSourceAvailableSource[] {
    return [...this.catalog.sources.values()]
      .filter((source) => source.toolNames.length > 0 && !this.enabledSourceIds.has(source.id))
      .map((source) => ({
        id: source.id,
        ...(source.label !== undefined ? { label: source.label } : {}),
        ...(source.description !== undefined ? { description: source.description } : {}),
        toolCount: source.toolNames.length,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private sortedEnabledSourceIds(): ToolSourceId[] {
    return [...this.enabledSourceIds].sort((a, b) => a.localeCompare(b));
  }
}

export type ConnectToolSourceResult =
  | {
      ok: true;
      source: string;
      newlyEnabled: boolean;
      enabledSources: string[];
      availableSources: ConnectToolSourceAvailableSource[];
      availableNextRequest: true;
      tools: string[];
    }
  | {
      ok: false;
      source: string;
      error: 'unknown_source' | 'source_has_no_tools';
      enabledSources: string[];
      availableSources: ConnectToolSourceAvailableSource[];
    };

export interface ConnectToolSourceAvailableSource {
  id: string;
  label?: string;
  description?: string;
  toolCount: number;
}

function buildSourceCatalog(
  tools: readonly MakaTool[],
  config: Extract<ToolSourceEconomyConfig, { mode: 'source_economy' }> | undefined,
): SourceCatalog {
  const coreToolNames = new Set(config?.coreToolNames ?? DEFAULT_CORE_TOOL_NAMES);
  const sourceByToolName = new Map<string, ToolSourceId>();
  const sources = new Map<ToolSourceId, SourceInfo>();

  for (const definition of config?.sourceDefinitions ?? []) {
    if (!definition.id || definition.id === CORE_TOOL_SOURCE_ID) continue;
    const info = ensureSourceInfo(sources, definition.id, definition.label, definition.description);
    for (const toolName of definition.toolNames) {
      if (!toolName || coreToolNames.has(toolName) || sourceByToolName.has(toolName)) continue;
      sourceByToolName.set(toolName, definition.id);
      info.toolNames.push(toolName);
    }
  }

  for (const tool of tools) {
    const source = tool.toolSource;
    if (source?.id === CORE_TOOL_SOURCE_ID) {
      coreToolNames.add(tool.name);
      continue;
    }
    if (coreToolNames.has(tool.name) || sourceByToolName.has(tool.name) || !source?.id) continue;
    const info = ensureSourceInfo(sources, source.id, source.label, source.description);
    sourceByToolName.set(tool.name, source.id);
    info.toolNames.push(tool.name);
  }

  const knownToolNames = new Set(tools.map((tool) => tool.name));
  for (const [sourceId, info] of sources) {
    info.toolNames = [...new Set(info.toolNames)]
      .filter((toolName) => knownToolNames.has(toolName) && !coreToolNames.has(toolName))
      .sort((a, b) => a.localeCompare(b));
    if (info.toolNames.length === 0) {
      sources.delete(sourceId);
    }
  }

  return { coreToolNames, sourceByToolName, sources };
}

function ensureSourceInfo(
  sources: Map<ToolSourceId, SourceInfo>,
  id: ToolSourceId,
  label: string | undefined,
  description: string | undefined,
): SourceInfo {
  const existing = sources.get(id);
  if (existing) {
    return existing;
  }
  const next: SourceInfo = {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    toolNames: [],
  };
  sources.set(id, next);
  return next;
}

function sourceToolNamesById(sources: Map<ToolSourceId, SourceInfo>): Record<ToolSourceId, string[]> {
  const out: Record<ToolSourceId, string[]> = {};
  for (const source of [...sources.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    out[source.id] = [...source.toolNames].sort((a, b) => a.localeCompare(b));
  }
  return out;
}
