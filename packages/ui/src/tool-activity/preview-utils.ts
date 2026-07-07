import { redactSecrets } from '../redact.js';

export const TOOL_LINE_CAP = 500;

/**
 * Build the markdown source for a text-kind tool result (#546 PR6): redact,
 * translate the user-visible boilerplate, cap the line count, then escape
 * every `&` so the markdown pipeline cannot decode character references the
 * redactor never saw. An entity-encoded key (`sk&#45;…`) matches no redaction
 * pattern, and micromark would decode it into the clear — the old <pre> path
 * displayed such text literally (codex review P1). Escaping `&` after
 * redaction means micromark's single decode pass exactly restores the
 * original bytes as text content: display parity with <pre>, zero decode
 * gain for an attacker, markdown structure (headings/lists/links) intact.
 */
export function toolTextToProseSource(text: string): string {
  const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(text)));
  const suffixed = capped > 0 ? `${body}\n\n… 已隐藏 ${capped} 行` : body;
  return suffixed.replace(/&/g, '&amp;');
}

export function capLines(text: string): { body: string; capped: number } {
  const lines = text.split('\n');
  if (lines.length <= TOOL_LINE_CAP) return { body: text, capped: 0 };
  return {
    body: lines.slice(0, TOOL_LINE_CAP).join('\n'),
    capped: lines.length - TOOL_LINE_CAP,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatUserVisibleToolText(text: string): string {
  return text.replace(/\bUser denied permission\b/g, '用户已拒绝权限请求');
}
