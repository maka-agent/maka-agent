// Renderer-side defensive secret masking. Backend (main) is the
// authoritative redactor — settings, logs, and persisted state are sanitized
// there per @kenji's contracts. This module exists as a second layer for any
// surface that displays *runtime* strings (e.g. tool stderr, raw provider
// error text) which may have escaped redaction at the source.
//
// Goals:
//   - Mask obvious secret-like substrings before display + clipboard copy
//   - Prefer false positives over false negatives (a missed mask is worse
//     than masking a benign-looking hex)
//   - Never throw — degraded text still beats no text in an error surface
//
// Non-goals:
//   - Detecting every possible credential format. We rely on backend
//     redaction for the comprehensive list; this is a safety net.

interface Pattern {
  /** Stable identifier for the masked region in the output. */
  label: string;
  regex: RegExp;
  /** How to render the replacement; default is `<label redacted>`. */
  replacement?: (match: RegExpExecArray) => string;
}

// Order matters: more specific contextual patterns first so they don't get
// partly eaten by a broader rule (e.g. an `Authorization: Bearer xxx` header
// must mask the whole `Bearer xxx`, not just the token portion).
const PATTERNS: Pattern[] = [
  // Authorization: Bearer <token>  /  Authorization: Basic <b64>
  {
    label: 'authorization header',
    regex: /\b(authorization\s*[:=]\s*)(bearer|basic|token)\s+([^\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]} <redacted>`,
  },
  // URL query secrets:  ?key=xxx  ?token=xxx  ?api_key=xxx  &access_token=xxx
  // (runs before the api-key-header rule so the URL form isn't mangled.)
  {
    label: 'url query secret',
    regex: /([?&])(access_token|api[_-]?key|apikey|auth|token|secret|signature)=([^&\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]}=<redacted>`,
  },
  // x-api-key: xxx  /  api-key: xxx  (HTTP headers; require start-of-line or
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
    regex: /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[opusr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{16,})\b/g,
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
