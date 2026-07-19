// Display-facing defensive secret masking.
//
// This module is the single source of truth for the display-layer
// redactor shared by the desktop quiet panel (@maka/ui) and the TUI
// (@maka/cli). It was extracted from packages/ui/src/redact.ts so both
// surfaces use the same patterns and the same `<redacted>` marker.
//
// The backend (main process) has its own separate redactor in
// redaction.ts for log/persistence sanitization — the two are intentionally
// different: the display redactor prefers false positives (masking a
// benign hex is better than leaking a real token), while the backend
// redactor is stricter to avoid over-redacting structured logs.

interface Pattern {
  /** Stable identifier for the masked region in the output. */
  label: string;
  regex: RegExp;
  /** How to render the replacement; default is `<label redacted>`. */
  replacement?: (match: RegExpExecArray) => string;
}

// Order matters: more specific contextual patterns first so they don't get
// partly eaten by a broader rule (e.g. an `Authorization: Bearer [redacted] header
// must mask the whole `Bearer xxx`, not just the token portion).
const PATTERNS: Pattern[] = [
  // Authorization: Bearer <token>  /  Authorization: Basic <b64>
  {
    label: 'authorization header',
    regex: /\b(authorization\s*[:=]\s*)(bearer|basic|token)\s+([^\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]} <redacted>`,
  },
  // URL query secrets:  ?key=[redacted]  ?token=[redacted]  ?api_key=[redacted]  &access_token=[redacted]
  // (runs before the api-key-header rule so the URL form isn't mangled.)
  {
    label: 'url query secret',
    regex: /([?&])(access_token|api[_-]?key|apikey|auth|token|secret|signature)=([^&\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]}=<redacted>`,
  },
  // x-api-key: [redacted]  /  api-key: [redacted]  (HTTP headers; require start-of-line or
  // a space/quote before to avoid matching the URL-query form above.)
  {
    label: 'api key header',
    regex: /(^|[\s"'<>(])((?:x-)?api[-_]?key)\s*[:=]\s*([^\s"'<>]+)/gim,
    replacement: (m) => `${m[1]}${m[2]}: <redacted>`,
  },
  // Common provider key prefixes
  // OpenAI: sk-..., Anthropic: sk-ant-..., Google API: AIza..., GitHub: ghp_/gho_/ghu_/ghs_/ghr_
  // Slack tokens: xox[abprs]-...
  {
    label: 'provider api key',
    regex:
      /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[opusr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{16,})\b/g,
  },
  // Long high-entropy hex/base64 strings (40+ chars) — best-effort catch.
  // Conservative: require word boundaries and the whole match to be one
  // alphanum/hyphen/underscore run, so we don't eat normal prose accidentally.
  {
    label: 'long opaque token',
    regex: /\b(?=[A-Fa-f0-9_-]*[A-Fa-f0-9])[A-Fa-f0-9_-]{40,}\b/g,
  },
];

const DEFAULT_REPLACEMENT = '<redacted>';

/**
 * Mask obvious secret-like substrings in arbitrary runtime text. Idempotent —
 * running it twice never produces nested `<redacted>` markers.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (...args) => {
      const match = args as unknown as RegExpExecArray;
      return pattern.replacement ? pattern.replacement(match) : DEFAULT_REPLACEMENT;
    });
  }
  return output;
}
