import { detectUiLocale } from '../locale-helpers.js';
import type { ToolActivityItem } from '../materialize.js';
import { loadToolDisplayName } from '../tool-format.js';
import { formatUserVisibleToolText } from './preview-utils.js';
import { trowActivityKind, type TrowActivityKind } from './trow-summary.js';

export interface ToolActivityPresentation {
  kind: TrowActivityKind;
  summary: string;
  needsAttention: boolean;
}

export interface ToolDisclosureState {
  open: boolean;
  manuallySet: boolean;
}

const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(['load_tools', 'load_tool']);

export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

export function resolveToolDisplayName(item: ToolActivityItem): string {
  if (item.displayName) return item.displayName;
  if (isConnectorTool(item.toolName)) return loadToolDisplayName(detectUiLocale());
  return item.toolName;
}

export function deriveToolActivityPresentation(item: ToolActivityItem): ToolActivityPresentation {
  return {
    kind: trowActivityKind(item.toolName, item.activityKind),
    summary: formatUserVisibleToolText(item.intent ?? '') || resolveToolDisplayName(item),
    needsAttention: item.status === 'waiting_permission' || item.status === 'errored',
  };
}

export function createToolDisclosureState(presentation: ToolActivityPresentation): ToolDisclosureState {
  return { open: presentation.needsAttention, manuallySet: false };
}

export function syncToolDisclosureState(
  current: ToolDisclosureState,
  presentation: ToolActivityPresentation,
): ToolDisclosureState {
  if (presentation.needsAttention) {
    return current.open ? current : createToolDisclosureState(presentation);
  }
  if (current.manuallySet) return current;
  return createToolDisclosureState(presentation);
}

export function setToolDisclosureOpen(
  current: ToolDisclosureState,
  open: boolean,
): ToolDisclosureState {
  return { ...current, open, manuallySet: true };
}
