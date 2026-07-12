import { redactSecrets } from './redaction.js';

export const WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS = 160;

export interface WriteStdinInputPreview {
  text: string;
  bytes: number;
  truncated: boolean;
}

export function projectWriteStdinInput(input: string): WriteStdinInputPreview {
  const bytes = new TextEncoder().encode(input).byteLength;
  const exact = exactTerminalInputLabel(input);
  if (exact) return { text: exact, bytes, truncated: false };

  const safe = redactSecrets(input);
  const chars = Array.from(safe);
  let text = '';
  let length = 0;
  let consumed = 0;
  for (const char of chars) {
    const display = terminalInputCharDisplay(char);
    const displayLength = Array.from(display).length;
    if (length + displayLength > WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS) break;
    text += display;
    length += displayLength;
    consumed += 1;
  }
  return { text, bytes, truncated: consumed < chars.length };
}

export function readWriteStdinInputPreview(args: unknown): WriteStdinInputPreview | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).inputPreview;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const preview = value as Record<string, unknown>;
  if (
    typeof preview.text !== 'string'
    || !Number.isSafeInteger(preview.bytes)
    || (preview.bytes as number) < 0
    || typeof preview.truncated !== 'boolean'
    || !isSafeProjectedInputText(preview.text)
  ) {
    return undefined;
  }
  return {
    text: preview.text,
    bytes: preview.bytes as number,
    truncated: preview.truncated,
  };
}

function isSafeProjectedInputText(text: string): boolean {
  const chars = Array.from(text);
  return chars.length <= WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS
    && redactSecrets(text) === text
    && chars.every((char) => terminalInputCharDisplay(char) === char);
}

export function projectToolActivityArgs(toolName: string, args: unknown): unknown {
  if (toolName !== 'WriteStdin') return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const input = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof input.ref === 'string') summary.ref = input.ref;
  if (typeof input.input === 'string') {
    summary.inputPreview = projectWriteStdinInput(input.input);
  } else {
    const preview = readWriteStdinInputPreview(input);
    if (preview) summary.inputPreview = preview;
  }
  if (input.size && typeof input.size === 'object' && !Array.isArray(input.size)) {
    const size = input.size as Record<string, unknown>;
    if (typeof size.cols === 'number' && typeof size.rows === 'number') {
      summary.size = { cols: size.cols, rows: size.rows };
    }
  }
  return summary;
}

function exactTerminalInputLabel(input: string): string | undefined {
  switch (input) {
    case '\r':
    case '\n':
    case '\r\n':
      return 'Enter';
    case '\u0003':
      return 'Ctrl-C';
    case '\u0004':
      return 'Ctrl-D';
    case '\u001b':
      return 'Esc';
    case '\b':
      return 'Backspace';
    case '\u007f':
      return 'Delete';
    default:
      return undefined;
  }
}

function terminalInputCharDisplay(char: string): string {
  switch (char) {
    case '\r':
      return '\\r';
    case '\n':
      return '\\n';
    case '\t':
      return '\\t';
    case '\b':
      return '<Backspace>';
    case '\u0003':
      return '<Ctrl-C>';
    case '\u0004':
      return '<Ctrl-D>';
    case '\u001b':
      return '<Esc>';
    case '\u007f':
      return '<Delete>';
    default: {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x20 || isInvisibleCodePoint(codePoint)) {
        return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
      }
      return char;
    }
  }
}

function isInvisibleCodePoint(codePoint: number): boolean {
  return /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(String.fromCodePoint(codePoint));
}
