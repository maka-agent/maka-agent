export function projectToolActivityArgs(toolName: string, args: unknown): unknown {
  if (toolName !== 'WriteStdin') return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const input = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof input.ref === 'string') summary.ref = input.ref;
  if (typeof input.input === 'string') {
    summary.inputBytes = new TextEncoder().encode(input.input).byteLength;
  } else if (Number.isSafeInteger(input.inputBytes) && (input.inputBytes as number) >= 0) {
    summary.inputBytes = input.inputBytes;
  }
  if (input.size && typeof input.size === 'object' && !Array.isArray(input.size)) {
    const size = input.size as Record<string, unknown>;
    if (typeof size.cols === 'number' && typeof size.rows === 'number') {
      summary.size = { cols: size.cols, rows: size.rows };
    }
  }
  if (typeof input.yield_time_ms === 'number') summary.yield_time_ms = input.yield_time_ms;
  return summary;
}
