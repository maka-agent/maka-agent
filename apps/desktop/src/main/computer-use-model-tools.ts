import type { MakaTool, ToolAvailabilityConfig } from '@maka/runtime';

export function computerUseToolsForModel(
  tools: readonly MakaTool[],
  computerUseTools: readonly MakaTool[],
  supportsVision: boolean,
): MakaTool[] {
  if (supportsVision || computerUseTools.length === 0) return [...tools];
  const computerUseToolNames = new Set(computerUseTools.map((tool) => tool.name));
  return tools.filter((tool) => !computerUseToolNames.has(tool.name));
}

export function computerUseAvailabilityForModel(
  availability: ToolAvailabilityConfig,
  supportsVision: boolean,
): ToolAvailabilityConfig {
  if (supportsVision || !availability.groups) return availability;
  return {
    ...availability,
    groups: availability.groups.filter((group) => group.id !== 'computer_use'),
  };
}
