const SECRET_PATTERNS: RegExp[] = [
  /\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s"'<>]+/gi,
  /\b((?:x-api-key|api-key|api_key|access_token|token|password|secret)\s*[:=]\s*)[^\s"'&<>]+/gi,
  /\b(sk-(?:ant-)?[a-z0-9_-]{8,})\b/gi,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(gh[pousr]_[0-9A-Za-z_]{20,})\b/g,
  /\b(xox[abprs]-[0-9A-Za-z-]{10,})\b/g,
  /\b([a-f0-9]{40,})\b/gi,
];

export function redactSecrets(value: string): string {
  let next = redactUrlQuerySecrets(value);
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (_match, prefixOrSecret: string) => {
      if (prefixOrSecret.includes(':') || prefixOrSecret.includes('=')) return `${prefixOrSecret}[redacted]`;
      return '[redacted]';
    });
  }
  return next;
}

function redactUrlQuerySecrets(value: string): string {
  return value.replace(/([?&])([^=\s&?#]+)=([^&\s#]*)/g, (match, sep: string, key: string) => {
    if (!isSensitiveKey(key)) return match;
    return `${sep}${key}=[redacted]`;
  });
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|key|token|access[_-]?token|auth|authorization|password|secret)$/i.test(key);
}

export function generalizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return 'Request timed out';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit exceeded';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return 'Authentication failed';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return 'Provider unavailable';
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('econn') || lower.includes('enotfound')) return 'Network error';
  return fallback;
}
