import type { OrchestrationMode } from './orchestration.js';

export type ParsedSwarmCommand =
  | { kind: 'status' }
  | { kind: 'set_mode'; mode: OrchestrationMode }
  | { kind: 'run_once'; task: string };

/** Parse the exact `/swarm` command without treating lookalike prompts as commands. */
export function parseSwarmCommand(input: string): ParsedSwarmCommand | null {
  const trimmed = input.trim();
  const commandToken = trimmed.split(/\s+/, 1)[0] ?? '';
  if (commandToken !== '/swarm') return null;

  const tail = trimmed.slice(commandToken.length).trim();
  if (!tail || tail === 'status') return { kind: 'status' };
  if (tail === 'on') return { kind: 'set_mode', mode: 'swarm' };
  if (tail === 'off') return { kind: 'set_mode', mode: 'default' };
  return { kind: 'run_once', task: tail };
}
