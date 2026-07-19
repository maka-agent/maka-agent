import { createHash } from 'node:crypto';

export const RSI_R2_FAILURE_PATTERNS = [
  'coverage_regression',
  'tool_failed',
  'max_tokens',
  'runtime_error',
  'verification_failed',
  'other',
] as const;

export type RsiR2FailurePattern = (typeof RSI_R2_FAILURE_PATTERNS)[number];

export interface ValidateRsiPromptTextOptions {
  fieldName: string;
  maxChars: number;
}

export interface CanonicalRsiTokenListOptions {
  fieldName: string;
  maxItems: number;
}

const PROMPT_SAFE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const FORBIDDEN_TEXT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'code_fence', pattern: /```/ },
  { name: 'held_out', pattern: /held[-_ ]?out/i },
  { name: 'expected_output', pattern: /expected[-_ ]?output/i },
  { name: 'verifier', pattern: /\bverifier\b/i },
  { name: 'test_path', pattern: /(?:^|[\s"'`])(?:\.\/|\/app\/)?tests\//i },
  {
    name: 'controller_artifact',
    pattern: /\b(?:runtime-events|results)\.(?:jsonl|tsv)\b|\bresultsJsonlPath\b/i,
  },
];

export function isRsiR2FailurePattern(value: unknown): value is RsiR2FailurePattern {
  return (
    typeof value === 'string' && (RSI_R2_FAILURE_PATTERNS as readonly string[]).includes(value)
  );
}

export function promptSafeToken(value: string, fallback: string): string {
  if (typeof fallback !== 'string' || !PROMPT_SAFE_TOKEN_RE.test(fallback)) {
    throw new Error('fallback must be prompt-safe');
  }
  if (typeof value !== 'string') {
    throw new Error('value must be prompt-safe');
  }
  return PROMPT_SAFE_TOKEN_RE.test(value) ? value : fallback;
}

export function validateRsiPromptText(
  value: string,
  options: ValidateRsiPromptTextOptions,
): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${options.fieldName} must be non-empty`);
  if (text.length > options.maxChars) {
    throw new Error(`${options.fieldName} exceeds ${options.maxChars} chars`);
  }
  if (/\r|\n/.test(text)) throw new Error(`${options.fieldName} must be single-line`);
  for (const forbidden of FORBIDDEN_TEXT_PATTERNS) {
    if (forbidden.pattern.test(text)) {
      throw new Error(`${options.fieldName} contains forbidden ${forbidden.name}`);
    }
  }
  return text;
}

export function canonicalRsiTokenList(
  values: readonly string[],
  options: CanonicalRsiTokenListOptions,
): string[] {
  if (values.length > options.maxItems) {
    throw new Error(`${options.fieldName} exceeds ${options.maxItems} items`);
  }
  const canonical = values.map((value, index) => {
    if (typeof value !== 'string' || !PROMPT_SAFE_TOKEN_RE.test(value)) {
      throw new Error(`${options.fieldName}[${index}] must be prompt-safe`);
    }
    return value;
  });
  const deduped = [...new Set(canonical)].sort(comparePromptSafeTokens);
  return deduped;
}

function comparePromptSafeTokens(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function hashRsiHeldInTaskSet(taskIds: readonly string[]): string {
  const canonical = canonicalRsiTokenList(taskIds, {
    fieldName: 'heldInTaskIds',
    maxItems: Number.MAX_SAFE_INTEGER,
  });
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `sha256:${digest}`;
}
