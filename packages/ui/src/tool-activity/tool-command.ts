/**
 * Pull the shell command string out of a command-tool's args (bash / shell).
 * Returns undefined for a non-command shape so callers fall back to path /
 * pattern presentation or redacted JSON.
 */
export function extractToolCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.command ?? record.cmd ?? record.script;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}
