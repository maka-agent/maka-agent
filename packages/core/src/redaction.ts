import { bashLiteralPrefixProofs } from './bash-command-boundaries.js';

const PUBLIC_REDACTED = '[redacted]';
const CRITICAL_REDACTED = 'REDACTED';

interface RedactionReplacement {
  readonly literal: string;
  readonly escapedString: string;
}

const PUBLIC_REPLACEMENT: RedactionReplacement = {
  literal: PUBLIC_REDACTED,
  escapedString: String.raw`\"[redacted]\"`,
};
const CRITICAL_REPLACEMENT: RedactionReplacement = {
  literal: CRITICAL_REDACTED,
  escapedString: String.raw`\"REDACTED\"`,
};

const SENSITIVE_KEY_REGEX_SOURCE = String.raw`(?:x-api-key|api[_-]?key|key|token|access[_-]?token|auth|authorization|password|secret)`;

const SENSITIVE_KEY_PATTERN = new RegExp(`^${SENSITIVE_KEY_REGEX_SOURCE}$`, 'i');
const SAFE_PAYLOAD_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/;
const MAX_ENCODED_SENSITIVE_KEY_LENGTH = 128;

const CRITICAL_PROVIDER_SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-)?[a-z0-9_-]{8,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[0-9A-Za-z_]{20,}\b/g,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
];
const AMBIGUOUS_HEX_CANDIDATE_PATTERN_SOURCE = String.raw`\b[a-f0-9]{40,}\b`;
const PUBLIC_PROVIDER_SECRET_PATTERNS: RegExp[] = [
  ...CRITICAL_PROVIDER_SECRET_PATTERNS,
  new RegExp(AMBIGUOUS_HEX_CANDIDATE_PATTERN_SOURCE, 'gi'),
];
const AUTHORIZATION_SCHEMES = ['bearer', 'basic', 'token'] as const;
const SENSITIVE_BASH_LONG_OPTION_KEYS = [
  'x-api-key',
  'api-key',
  'api_key',
  'apikey',
  'key',
  'token',
  'access-token',
  'access_token',
  'accesstoken',
  'auth',
  'authorization',
  'password',
  'secret',
] as const;

type RedactionContext = 'generic' | 'bash';
type SensitivePrefixKind = 'key_value' | 'url' | 'escaped_json';

interface SensitivePrefix {
  readonly key: string;
  readonly kind: SensitivePrefixKind;
  readonly operator: ':' | '=';
  readonly keyQuote?: '"' | "'";
  readonly valueStart: number;
  readonly unsafePrefix: boolean;
  readonly bashPrefixIsLiteral?: boolean;
  readonly outerValueQuote?: '"' | "'";
}

interface BashWord {
  readonly decoded: string;
  readonly staticParts: readonly string[];
  readonly end: number;
  readonly dynamic: boolean;
  readonly dynamicSensitiveLongOption: boolean;
}

interface SafeValueSpan {
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly resumeIndex: number;
}

interface RedactionSpan extends SafeValueSpan {
  readonly replacement: string;
}

interface LiteralRedactionScan {
  readonly publicSpans: readonly RedactionSpan[];
  readonly criticalSpans: readonly RedactionSpan[];
  readonly found: boolean;
  readonly complete: boolean;
}

interface BashLongOptionProjection {
  readonly publicSpan: RedactionSpan;
  readonly criticalSpan?: RedactionSpan;
}

export function redactSecrets(value: string): string {
  const serialized = redactSerializedJsonSecrets(value);
  const bashLongOptionScan = scanBashLongOptions(serialized, PUBLIC_REPLACEMENT);
  const withRedactedLongOptions = applyRedactionSpans(serialized, bashLongOptionScan.publicSpans);
  const genericScan = scanLiteralSensitiveValues(
    withRedactedLongOptions,
    'generic',
    PUBLIC_REPLACEMENT,
  );
  return redactProviderSecretTokens(
    applyRedactionSpans(withRedactedLongOptions, genericScan.publicSpans),
  );
}

export function redactSecretsForCriticalReview(value: string): string | undefined {
  const scan = scanLiteralSensitiveValues(value, 'generic', CRITICAL_REPLACEMENT);
  if (!scan.complete) return undefined;
  const redacted = applyRedactionSpans(value, scan.criticalSpans);
  if (containsCriticalProviderSecret(redacted) || containsUnsupportedCriticalHex(redacted, false)) {
    return undefined;
  }
  return redacted;
}

export function redactBashCommandSecretsForCriticalReview(value: string): string | undefined {
  const longOptionScan = scanBashLongOptions(value, CRITICAL_REPLACEMENT);
  if (!longOptionScan.complete) return undefined;
  const withRedactedLongOptions = applyRedactionSpans(value, longOptionScan.criticalSpans);
  const scan = scanLiteralSensitiveValues(withRedactedLongOptions, 'bash', CRITICAL_REPLACEMENT);
  if (!scan.complete) return undefined;
  const redacted = applyRedactionSpans(withRedactedLongOptions, scan.criticalSpans);
  if (containsCriticalProviderSecret(redacted)) return undefined;
  if (containsUnsupportedCriticalHex(redacted, true)) return undefined;
  if ((longOptionScan.found || scan.found) && containsHeredocOpener(value)) return undefined;
  return redacted;
}

function scanLiteralSensitiveValues(
  value: string,
  context: RedactionContext,
  replacement: RedactionReplacement,
): LiteralRedactionScan {
  const publicSpans: RedactionSpan[] = [];
  const criticalSpans: RedactionSpan[] = [];
  let index = 0;
  let found = false;
  let complete = true;
  const literalPrefixProofs = context === 'bash' ? bashLiteralPrefixProofs(value) : undefined;

  while (index < value.length) {
    const matchedPrefix = sensitivePrefixAt(value, index);
    if (matchedPrefix === undefined) {
      index += 1;
      continue;
    }
    const prefix =
      context === 'bash'
        ? {
            ...matchedPrefix,
            bashPrefixIsLiteral: literalPrefixProofs?.[index] === true,
          }
        : matchedPrefix;

    const resolved = resolveAuthorizationCredentialPrefix(value, prefix, context);
    const emptyResumeIndex = emptySensitiveValueResumeIndex(value, resolved, context);
    if (emptyResumeIndex !== undefined) {
      index = Math.max(emptyResumeIndex, index + 1);
      continue;
    }

    found = true;
    const span = resolved.unsafePrefix
      ? undefined
      : safeSensitiveValueSpan(value, resolved, context, replacement);
    if (span !== undefined) {
      const redaction = { ...span, replacement: replacement.literal };
      publicSpans.push(redaction);
      criticalSpans.push(redaction);
      index = Math.max(span.resumeIndex, span.payloadEnd, index + 1);
      continue;
    }

    complete = false;
    const publicSpan = publicSensitiveValueSpan(value, resolved, replacement);
    if (publicSpan !== undefined) publicSpans.push(publicSpan);
    index = Math.max(publicSpan?.resumeIndex ?? resolved.valueStart + 1, index + 1);
  }

  return { publicSpans, criticalSpans, found, complete };
}

function scanBashLongOptions(
  value: string,
  replacement: RedactionReplacement,
): LiteralRedactionScan {
  const publicSpans: RedactionSpan[] = [];
  const criticalSpans: RedactionSpan[] = [];
  let index = 0;
  let found = false;
  let complete = true;

  while (index < value.length) {
    if (isBashWordBoundary(value[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    const word = scanBashWord(value, start);
    if (word.end <= start) {
      index += 1;
      continue;
    }
    const projection = bashLongOptionProjection(value, start, word, replacement);
    if (projection !== undefined) {
      found = true;
      publicSpans.push(projection.publicSpan);
      if (projection.criticalSpan === undefined) complete = false;
      else criticalSpans.push(projection.criticalSpan);
    }
    index = word.end;
  }

  return { publicSpans, criticalSpans, found, complete };
}

function bashLongOptionProjection(
  value: string,
  start: number,
  optionWord: BashWord,
  replacement: RedactionReplacement,
): BashLongOptionProjection | undefined {
  if (optionWord.dynamic) {
    if (optionWord.dynamicSensitiveLongOption) {
      return {
        publicSpan: bashLongOptionSpan(start, optionWord.end, `'${PUBLIC_REDACTED}'`),
      };
    }
    const equals = splitBashWordAtStaticEquals(optionWord);
    if (
      !hasStaticLongOptionMarker(optionWord) ||
      (equals === undefined
        ? !couldDecodeAsSensitiveLongOption(optionWord.staticParts)
        : !equals.valuePossible || !couldDecodeAsSensitiveLongOption(equals.keyParts))
    )
      return undefined;

    let end = optionWord.end;
    if (equals === undefined) {
      const separatedValue = separatedBashValueWord(value, optionWord.end);
      if (separatedValue !== undefined) end = separatedValue.end;
    }
    const publicSpan = bashLongOptionSpan(start, end, `'${PUBLIC_REDACTED}'`);
    return { publicSpan };
  }

  if (!optionWord.decoded.startsWith('--')) return undefined;
  const separatorIndex = optionWord.decoded.indexOf('=');
  if (separatorIndex >= 0) {
    const key = optionWord.decoded.slice(2, separatorIndex);
    const decodedValue = optionWord.decoded.slice(separatorIndex + 1);
    if (!isSensitiveKey(key) || decodedValue === '') return undefined;
    const projected = canonicalBashLongOption(key, '=', replacement);
    const span = bashLongOptionSpan(start, optionWord.end, projected);
    return { publicSpan: span, criticalSpan: span };
  }

  const key = optionWord.decoded.slice(2);
  if (!isSensitiveKey(key)) return undefined;
  const separatedValue = separatedBashValueWord(value, optionWord.end);
  if (separatedValue === undefined || (!separatedValue.dynamic && separatedValue.decoded === ''))
    return undefined;
  if (separatedValue.dynamic) {
    const publicSpan = bashLongOptionSpan(start, separatedValue.end, `'${PUBLIC_REDACTED}'`);
    return { publicSpan };
  }
  const projected = canonicalBashLongOption(key, ' ', replacement);
  const span = bashLongOptionSpan(start, separatedValue.end, projected);
  return { publicSpan: span, criticalSpan: span };
}

function scanBashWord(value: string, start: number): BashWord {
  const staticParts = [''];
  let quote: 'single' | 'double' | undefined;
  let index = start;
  let dynamic = false;
  let dynamicSensitiveLongOption = false;

  const append = (character: string): void => {
    staticParts[staticParts.length - 1] += character;
  };
  const appendHole = (end: number): void => {
    dynamic = true;
    dynamicSensitiveLongOption ||= containsSensitiveBashLongOptionSource(value, index, end);
    staticParts.push('');
    index = end;
  };

  while (index < value.length) {
    const character = value[index]!;
    if (quote === undefined && isBashWordBoundary(character)) break;
    if (quote === 'single') {
      if (character === "'") {
        quote = undefined;
      } else append(character);
      index += 1;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') {
        quote = undefined;
        index += 1;
        continue;
      }
      const holeEnd = bashDynamicHoleEndAt(value, index, true);
      if (holeEnd !== undefined) {
        appendHole(holeEnd);
        continue;
      }
      if (character !== '\\') {
        append(character);
        index += 1;
        continue;
      }
    }
    if (character === "'") {
      quote = 'single';
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      index += 1;
      continue;
    }
    const holeEnd = bashDynamicHoleEndAt(value, index, false);
    if (holeEnd !== undefined) {
      appendHole(holeEnd);
      continue;
    }
    if (character === '\\') {
      const escaped = value[index + 1];
      if (escaped === '\n') {
        index += 2;
        continue;
      }
      if (escaped === '\r' && value[index + 2] === '\n') {
        index += 3;
        continue;
      }
      if (escaped === undefined) {
        dynamic = true;
        index += 1;
        break;
      }
      if (
        quote !== 'double' ||
        escaped === '$' ||
        escaped === '`' ||
        escaped === '"' ||
        escaped === '\\'
      ) {
        append(escaped);
        index += 2;
        continue;
      }
      append(character);
      index += 1;
      continue;
    }
    append(character);
    index += 1;
  }
  if (quote !== undefined) dynamic = true;
  return {
    decoded: staticParts.join(''),
    staticParts,
    end: index,
    dynamic,
    dynamicSensitiveLongOption,
  };
}

function containsSensitiveBashLongOptionSource(value: string, start: number, end: number): boolean {
  const source = value.slice(start, end).toLowerCase();
  return SENSITIVE_BASH_LONG_OPTION_KEYS.some((key) => {
    const marker = `--${key}`;
    let markerStart = source.indexOf(marker);
    while (markerStart >= 0) {
      const before = source[markerStart - 1];
      const after = source[markerStart + marker.length];
      if (
        (before === undefined || before === "'" || before === '"' || isBashWordBoundary(before)) &&
        (after === '=' || isHorizontalSpace(after))
      )
        return true;
      markerStart = source.indexOf(marker, markerStart + marker.length);
    }
    return false;
  });
}

function bashDynamicHoleEndAt(
  value: string,
  start: number,
  inDoubleQuote: boolean,
): number | undefined {
  const character = value[start];
  if (character === '`') return backtickHoleEnd(value, start);
  if (character === '$') {
    const opener = value[start + 1];
    if (opener === "'" || opener === '"') return start + 1;
    if (opener === '(' || opener === '{') {
      return balancedBashHoleEnd(value, start + 2, opener === '(' ? ')' : '}');
    }
    if (opener !== undefined && /[A-Za-z_]/.test(opener)) {
      let end = start + 2;
      while (/[A-Za-z0-9_]/.test(value[end] ?? '')) end += 1;
      return end;
    }
    if (opener !== undefined && /[0-9@*#?$!_-]/.test(opener)) return start + 2;
    return undefined;
  }
  if (inDoubleQuote) return undefined;
  if ((character === '<' || character === '>') && value[start + 1] === '(') {
    return balancedBashHoleEnd(value, start + 2, ')');
  }
  if (character === '*' || character === '?') return start + 1;
  if (character === '[') {
    const closing = value.indexOf(']', start + 1);
    return closing < 0 ? start + 1 : closing + 1;
  }
  if (character === '{') {
    const closing = value.indexOf('}', start + 1);
    return closing < 0 ? start + 1 : closing + 1;
  }
  return undefined;
}

function balancedBashHoleEnd(value: string, start: number, initialCloser: ')' | '}'): number {
  const closers: Array<')' | '}'> = [initialCloser];
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  let index = start;
  while (index < value.length) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === '\\' && quote !== "'") escaped = true;
      else if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '\\') escaped = true;
    else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') closers.push(')');
    else if (character === '{') closers.push('}');
    else if (character === ')' || character === '}') {
      if (character === closers.at(-1)) {
        closers.pop();
        if (closers.length === 0) return index + 1;
      }
    }
    index += 1;
  }
  return value.length;
}

function backtickHoleEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '`') return index + 1;
  }
  return value.length;
}

function splitBashWordAtStaticEquals(word: BashWord):
  | {
      readonly keyParts: readonly string[];
      readonly valuePossible: boolean;
    }
  | undefined {
  for (let index = 0; index < word.staticParts.length; index += 1) {
    const part = word.staticParts[index]!;
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    return {
      keyParts: [...word.staticParts.slice(0, index), part.slice(0, separatorIndex)],
      valuePossible: part.length > separatorIndex + 1 || index + 1 < word.staticParts.length,
    };
  }
  return undefined;
}

function hasStaticLongOptionMarker(word: BashWord): boolean {
  return word.staticParts.some((part) => part.includes('--'));
}

function couldDecodeAsSensitiveLongOption(staticParts: readonly string[]): boolean {
  return SENSITIVE_BASH_LONG_OPTION_KEYS.some((key) =>
    staticPartsCouldDecodeAs(staticParts, `--${key}`),
  );
}

function staticPartsCouldDecodeAs(staticParts: readonly string[], target: string): boolean {
  if (staticParts.length === 0) return false;
  const parts = staticParts.map((part) => part.toLowerCase());
  if (!target.startsWith(parts[0]!)) return false;
  let cursor = parts[0]!.length;
  for (let index = 1; index + 1 < parts.length; index += 1) {
    const next = target.indexOf(parts[index]!, cursor);
    if (next < 0) return false;
    cursor = next + parts[index]!.length;
  }
  if (parts.length === 1) return cursor === target.length;
  const suffix = parts.at(-1)!;
  const suffixStart = target.length - suffix.length;
  return suffixStart >= cursor && target.endsWith(suffix);
}

function separatedBashValueWord(value: string, optionEnd: number): BashWord | undefined {
  let start = optionEnd;
  while (isHorizontalSpace(value[start])) start += 1;
  if (start === optionEnd || value[start] === undefined || isBashWordBoundary(value[start]!))
    return undefined;
  return scanBashWord(value, start);
}

function canonicalBashLongOption(
  key: string,
  separator: '=' | ' ',
  replacement: RedactionReplacement,
): string {
  const projectedValue =
    replacement.literal === PUBLIC_REDACTED ? `'${replacement.literal}'` : replacement.literal;
  return `--${key}${separator}${projectedValue}`;
}

function bashLongOptionSpan(start: number, end: number, replacement: string): RedactionSpan {
  return {
    payloadStart: start,
    payloadEnd: end,
    resumeIndex: end,
    replacement,
  };
}

function isBashWordBoundary(character: string): boolean {
  return (
    isAnyWhitespace(character) ||
    character === ';' ||
    character === '|' ||
    character === '&' ||
    character === '(' ||
    character === ')' ||
    character === '<' ||
    character === '>'
  );
}

function sensitivePrefixAt(value: string, index: number): SensitivePrefix | undefined {
  const character = value[index];
  if (character === '?' || character === '&') {
    const key = scanLiteralKey(value, index + 1);
    if (key !== undefined && isSensitiveKey(key.value) && value[key.end] === '=') {
      return {
        key: key.value,
        kind: 'url',
        operator: '=',
        valueStart: key.end + 1,
        unsafePrefix: false,
      };
    }
  }

  const escapedQuoteEnd = backslashQuoteEndAt(value, index);
  if (escapedQuoteEnd !== undefined) {
    return scanEscapedJsonSensitivePrefix(value, index, escapedQuoteEnd);
  }

  if ((character === '"' || character === "'") && value[index - 1] !== '\\') {
    return scanQuotedSensitivePrefix(value, index, character);
  }

  if (character !== undefined && isKeyCharacter(character) && !isKeyCharacter(value[index - 1])) {
    const key = scanLiteralKey(value, index);
    if (key !== undefined && isSensitiveKey(key.value)) {
      return prefixAfterKey(value, key.value, key.end, 'key_value', index);
    }
  }

  return undefined;
}

function scanQuotedSensitivePrefix(
  value: string,
  start: number,
  quote: '"' | "'",
): SensitivePrefix | undefined {
  let index = start + 1;
  let decoded = '';
  let hadEscape = false;
  const sourceLimit = Math.min(value.length, start + MAX_ENCODED_SENSITIVE_KEY_LENGTH);

  while (index < sourceLimit) {
    const character = value[index]!;
    if (character === quote) {
      if (!isSensitiveKey(decoded)) return undefined;
      const prefix = prefixAfterKey(value, decoded, index + 1, 'key_value');
      return prefix === undefined
        ? undefined
        : { ...prefix, keyQuote: quote, unsafePrefix: prefix.unsafePrefix || hadEscape };
    }
    if (isKeyCharacter(character)) {
      decoded += character;
      index += 1;
      continue;
    }
    if (quote === '"' && character === '\\') {
      const escape = decodeUnicodeEscape(value, index, false);
      if (escape === undefined || !isKeyCharacter(escape.character)) return undefined;
      decoded += escape.character;
      hadEscape = true;
      index = escape.end;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function scanEscapedJsonSensitivePrefix(
  value: string,
  start: number,
  openingEnd: number,
): SensitivePrefix | undefined {
  let index = openingEnd;
  let decoded = '';
  let hadEscape = openingEnd !== start + 2;
  const sourceLimit = Math.min(value.length, openingEnd + MAX_ENCODED_SENSITIVE_KEY_LENGTH);

  while (index < sourceLimit) {
    const closingEnd = backslashQuoteEndAt(value, index);
    if (closingEnd !== undefined) {
      if (!isSensitiveKey(decoded)) return undefined;
      const prefix = prefixAfterKey(value, decoded, closingEnd, 'escaped_json');
      if (prefix === undefined) return undefined;
      return {
        ...prefix,
        unsafePrefix:
          prefix.unsafePrefix || hadEscape || closingEnd !== index + 2 || prefix.operator !== ':',
      };
    }
    const character = value[index]!;
    if (isKeyCharacter(character)) {
      decoded += character;
      index += 1;
      continue;
    }
    if (character === '\\') {
      const escape = decodeUnicodeEscape(value, index, true);
      if (escape === undefined || !isKeyCharacter(escape.character)) return undefined;
      decoded += escape.character;
      hadEscape = true;
      index = escape.end;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function decodeUnicodeEscape(
  value: string,
  start: number,
  escapedJson: boolean,
): { character: string; end: number } | undefined {
  let marker = start + 1;
  if (escapedJson && value[marker] === '\\') marker += 1;
  if (value[marker] !== 'u') return undefined;
  const codeUnit = value.slice(marker + 1, marker + 5);
  if (!/^[0-9a-f]{4}$/i.test(codeUnit)) return undefined;
  return {
    character: String.fromCharCode(Number.parseInt(codeUnit, 16)),
    end: marker + 5,
  };
}

function prefixAfterKey(
  value: string,
  key: string,
  keyEnd: number,
  kind: SensitivePrefixKind,
  keyStart?: number,
): SensitivePrefix | undefined {
  let index = keyEnd;
  let unsafePrefix = false;
  while (isHorizontalSpace(value[index])) index += 1;
  if (isOtherWhitespace(value[index])) {
    unsafePrefix = true;
    while (isAnyWhitespace(value[index])) index += 1;
  }
  const operator = value[index];
  if (operator !== ':' && operator !== '=') return undefined;
  index += 1;
  while (isHorizontalSpace(value[index])) index += 1;
  if (isOtherWhitespace(value[index])) {
    unsafePrefix = true;
    while (isAnyWhitespace(value[index])) index += 1;
  }
  return {
    key,
    kind,
    operator,
    valueStart: index,
    unsafePrefix,
    ...(kind === 'key_value' &&
    keyStart !== undefined &&
    (value[keyStart - 1] === '"' || value[keyStart - 1] === "'")
      ? { outerValueQuote: value[keyStart - 1] as '"' | "'" }
      : {}),
  };
}

function resolveAuthorizationCredentialPrefix(
  value: string,
  prefix: SensitivePrefix,
  context: RedactionContext,
): SensitivePrefix & {
  readonly authorizationCredential?: true;
  readonly authorizationSchemeOnly?: true;
  readonly authorizationScheme?: (typeof AUTHORIZATION_SCHEMES)[number];
  readonly authorizationClosingQuote?: '"' | "'" | 'escaped_json';
} {
  if (!/^(?:auth|authorization)$/i.test(prefix.key)) return prefix;
  const container = authorizationValueContainer(value, prefix);
  const scheme = authorizationSchemeAt(value, container.schemeStart);
  if (scheme === undefined) return prefix;
  let index = scheme.end;
  if (!isAnyWhitespace(value[index])) {
    if (!authorizationContainerBoundary(value, index, container, prefix, context)) {
      return prefix;
    }
    return {
      ...prefix,
      valueStart: index,
      authorizationSchemeOnly: true,
    };
  }
  let unsafePrefix = prefix.unsafePrefix;
  if (isOtherWhitespace(value[index])) unsafePrefix = true;
  while (isHorizontalSpace(value[index])) index += 1;
  if (isOtherWhitespace(value[index])) {
    unsafePrefix = true;
    while (isAnyWhitespace(value[index])) index += 1;
  }
  if (authorizationContainerBoundary(value, index, container, prefix, context)) {
    return {
      ...prefix,
      valueStart: index,
      authorizationSchemeOnly: true,
    };
  }
  return {
    ...prefix,
    valueStart: index,
    unsafePrefix,
    authorizationCredential: true,
    authorizationScheme: scheme.scheme,
    ...(container.closingQuote === undefined
      ? {}
      : { authorizationClosingQuote: container.closingQuote }),
  };
}

function authorizationValueContainer(
  value: string,
  prefix: SensitivePrefix,
): {
  schemeStart: number;
  closingQuote?: '"' | "'" | 'escaped_json';
} {
  if (prefix.kind === 'escaped_json' && isSingleBackslashQuote(value, prefix.valueStart)) {
    return { schemeStart: prefix.valueStart + 2, closingQuote: 'escaped_json' };
  }
  const valueQuote = value[prefix.valueStart];
  if (valueQuote === '"' || valueQuote === "'") {
    return { schemeStart: prefix.valueStart + 1, closingQuote: valueQuote };
  }
  if (prefix.outerValueQuote !== undefined) {
    return { schemeStart: prefix.valueStart, closingQuote: prefix.outerValueQuote };
  }
  return { schemeStart: prefix.valueStart };
}

function authorizationContainerBoundary(
  value: string,
  index: number,
  container: { closingQuote?: '"' | "'" | 'escaped_json' },
  prefix: SensitivePrefix,
  context: RedactionContext,
): boolean {
  if (container.closingQuote === 'escaped_json') {
    return (
      isSingleBackslashQuote(value, index) &&
      hasProvenOuterBoundary(value, index + 2, prefix, context)
    );
  }
  if (container.closingQuote !== undefined) {
    return (
      value[index] === container.closingQuote &&
      hasProvenOuterBoundary(value, index + 1, prefix, context)
    );
  }
  return hasLiteralUnquotedBoundary(value, index, prefix, context);
}

function emptySensitiveValueResumeIndex(
  value: string,
  prefix: SensitivePrefix & { readonly authorizationSchemeOnly?: true },
  context: RedactionContext,
): number | undefined {
  if (prefix.authorizationSchemeOnly) return prefix.valueStart;
  const quotedSchemeEnd = quotedAuthorizationSchemeEnd(value, prefix);
  if (
    quotedSchemeEnd !== undefined &&
    hasProvenOuterBoundary(value, quotedSchemeEnd, prefix, context)
  ) {
    return quotedSchemeEnd;
  }
  if (value[prefix.valueStart] === undefined) {
    return prefix.valueStart;
  }
  if (
    prefix.kind === 'escaped_json' &&
    isSingleBackslashQuote(value, prefix.valueStart) &&
    isSingleBackslashQuote(value, prefix.valueStart + 2) &&
    hasProvenOuterBoundary(value, prefix.valueStart + 4, prefix, context)
  ) {
    return prefix.valueStart + 4;
  }
  const quote = value[prefix.valueStart];
  if (
    (quote === '"' || quote === "'") &&
    value[prefix.valueStart + 1] === quote &&
    hasProvenOuterBoundary(value, prefix.valueStart + 2, prefix, context)
  ) {
    return prefix.valueStart + 2;
  }
  if (hasLiteralUnquotedBoundary(value, prefix.valueStart, prefix, context)) {
    return prefix.valueStart;
  }
  return undefined;
}

function quotedAuthorizationSchemeEnd(value: string, prefix: SensitivePrefix): number | undefined {
  if (!/^(?:auth|authorization)$/i.test(prefix.key)) return undefined;
  if (prefix.kind === 'escaped_json' && isSingleBackslashQuote(value, prefix.valueStart)) {
    const schemeStart = prefix.valueStart + 2;
    const schemeEnd = authorizationSchemeEndAt(value, schemeStart);
    if (schemeEnd === undefined) return undefined;
    let closing = schemeEnd;
    while (isHorizontalSpace(value[closing])) closing += 1;
    return isSingleBackslashQuote(value, closing) ? closing + 2 : undefined;
  }
  const quote = value[prefix.valueStart];
  if (quote !== '"' && quote !== "'") return undefined;
  const schemeStart = prefix.valueStart + 1;
  const schemeEnd = authorizationSchemeEndAt(value, schemeStart);
  if (schemeEnd === undefined) return undefined;
  let closing = schemeEnd;
  while (isHorizontalSpace(value[closing])) closing += 1;
  return value[closing] === quote ? closing + 1 : undefined;
}

function authorizationSchemeEndAt(value: string, start: number): number | undefined {
  return authorizationSchemeAt(value, start)?.end;
}

function authorizationSchemeAt(
  value: string,
  start: number,
): { scheme: (typeof AUTHORIZATION_SCHEMES)[number]; end: number } | undefined {
  for (const scheme of AUTHORIZATION_SCHEMES) {
    const end = start + scheme.length;
    if (value.slice(start, end).toLowerCase() === scheme) return { scheme, end };
  }
  return undefined;
}

function safeSensitiveValueSpan(
  value: string,
  prefix: SensitivePrefix & {
    readonly authorizationCredential?: true;
    readonly authorizationScheme?: (typeof AUTHORIZATION_SCHEMES)[number];
    readonly authorizationClosingQuote?: '"' | "'" | 'escaped_json';
  },
  context: RedactionContext,
  replacement: RedactionReplacement,
): SafeValueSpan | undefined {
  const canonical = canonicalReplacementSpan(value, prefix, context, replacement);
  if (canonical !== undefined) return canonical;
  if (prefix.authorizationCredential) {
    return safeAuthorizationCredentialSpan(value, prefix, context);
  }
  if (prefix.kind === 'escaped_json') {
    return safeEscapedJsonStringSpan(value, prefix, context);
  }

  const quote = value[prefix.valueStart];
  if (quote === '"' || quote === "'") {
    let end = prefix.valueStart + 1;
    while (isSafePayloadCharacter(value[end])) end += 1;
    if (value[end] !== quote) return undefined;
    const payload = value.slice(prefix.valueStart + 1, end);
    if (!isSafePayload(payload)) return undefined;
    const resumeIndex = end + 1;
    if (!hasProvenOuterBoundary(value, resumeIndex, prefix, context)) {
      return undefined;
    }
    return {
      payloadStart: prefix.valueStart + 1,
      payloadEnd: end,
      resumeIndex,
    };
  }

  if (prefix.keyQuote === '"' && prefix.operator === ':' && !prefix.authorizationCredential)
    return undefined;
  let end = prefix.valueStart;
  while (isSafePayloadCharacter(value[end])) end += 1;
  const payload = value.slice(prefix.valueStart, end);
  if (!isSafePayload(payload)) return undefined;
  if (!hasLiteralUnquotedBoundary(value, end, prefix, context)) return undefined;
  return { payloadStart: prefix.valueStart, payloadEnd: end, resumeIndex: end };
}

function safeAuthorizationCredentialSpan(
  value: string,
  prefix: SensitivePrefix & {
    readonly authorizationCredential?: true;
    readonly authorizationScheme?: (typeof AUTHORIZATION_SCHEMES)[number];
    readonly authorizationClosingQuote?: '"' | "'" | 'escaped_json';
  },
  context: RedactionContext,
): SafeValueSpan | undefined {
  let end = prefix.valueStart;
  while (isAuthorizationCredentialCharacter(value[end])) end += 1;
  const payload = value.slice(prefix.valueStart, end);
  if (!isSafeAuthorizationCredential(payload, prefix.authorizationScheme)) return undefined;

  if (prefix.authorizationClosingQuote === 'escaped_json') {
    if (!isSingleBackslashQuote(value, end)) return undefined;
    const resumeIndex = end + 2;
    return hasProvenOuterBoundary(value, resumeIndex, prefix, context)
      ? { payloadStart: prefix.valueStart, payloadEnd: end, resumeIndex }
      : undefined;
  }
  if (prefix.authorizationClosingQuote !== undefined) {
    if (value[end] !== prefix.authorizationClosingQuote) return undefined;
    const resumeIndex = end + 1;
    return hasProvenOuterBoundary(value, resumeIndex, prefix, context)
      ? { payloadStart: prefix.valueStart, payloadEnd: end, resumeIndex }
      : undefined;
  }
  return hasLiteralUnquotedBoundary(value, end, prefix, context)
    ? { payloadStart: prefix.valueStart, payloadEnd: end, resumeIndex: end }
    : undefined;
}

function canonicalReplacementSpan(
  value: string,
  prefix: SensitivePrefix,
  context: RedactionContext,
  replacement: RedactionReplacement,
): SafeValueSpan | undefined {
  if (
    prefix.kind === 'escaped_json' &&
    value.startsWith(replacement.escapedString, prefix.valueStart)
  ) {
    const payloadStart = prefix.valueStart + 2;
    const payloadEnd = payloadStart + replacement.literal.length;
    const resumeIndex = prefix.valueStart + replacement.escapedString.length;
    return hasProvenOuterBoundary(value, resumeIndex, prefix, context)
      ? { payloadStart, payloadEnd, resumeIndex }
      : undefined;
  }
  const quote = value[prefix.valueStart];
  if (
    (quote === '"' || quote === "'") &&
    value.startsWith(replacement.literal, prefix.valueStart + 1)
  ) {
    const payloadStart = prefix.valueStart + 1;
    const payloadEnd = payloadStart + replacement.literal.length;
    const resumeIndex = payloadEnd + 1;
    return value[payloadEnd] === quote &&
      hasProvenOuterBoundary(value, resumeIndex, prefix, context)
      ? { payloadStart, payloadEnd, resumeIndex }
      : undefined;
  }
  if (value.startsWith(replacement.literal, prefix.valueStart)) {
    const payloadEnd = prefix.valueStart + replacement.literal.length;
    return hasLiteralUnquotedBoundary(value, payloadEnd, prefix, context)
      ? {
          payloadStart: prefix.valueStart,
          payloadEnd,
          resumeIndex: payloadEnd,
        }
      : undefined;
  }
  return undefined;
}

function safeEscapedJsonStringSpan(
  value: string,
  prefix: SensitivePrefix,
  context: RedactionContext,
): SafeValueSpan | undefined {
  if (!isSingleBackslashQuote(value, prefix.valueStart)) return undefined;
  let end = prefix.valueStart + 2;
  while (isSafePayloadCharacter(value[end])) end += 1;
  if (!isSingleBackslashQuote(value, end)) return undefined;
  const payload = value.slice(prefix.valueStart + 2, end);
  if (!isSafePayload(payload)) return undefined;
  const resumeIndex = end + 2;
  if (!hasProvenOuterBoundary(value, resumeIndex, prefix, context)) {
    return undefined;
  }
  return {
    payloadStart: prefix.valueStart + 2,
    payloadEnd: end,
    resumeIndex,
  };
}

function hasProvenOuterBoundary(
  value: string,
  index: number,
  prefix: SensitivePrefix,
  context: RedactionContext,
): boolean {
  return isSafeOuterBoundary(
    value[index],
    prefix,
    context,
    context !== 'bash' || prefix.bashPrefixIsLiteral === true,
  );
}

function hasLiteralUnquotedBoundary(
  value: string,
  index: number,
  prefix: SensitivePrefix,
  context: RedactionContext,
): boolean {
  if (prefix.outerValueQuote !== undefined) return false;
  return isSafeOuterBoundary(value[index], prefix, context, prefix.bashPrefixIsLiteral === true);
}

function isSafeOuterBoundary(
  character: string | undefined,
  prefix: SensitivePrefix,
  context: RedactionContext,
  outerLexicalBoundaryIsProven: boolean,
): boolean {
  if (context === 'bash' && !outerLexicalBoundaryIsProven) return false;
  if (character === undefined) return true;
  if (
    outerLexicalBoundaryIsProven &&
    (isHorizontalSpace(character) || character === '\n' || character === '\r')
  )
    return true;
  if (prefix.kind === 'url' && (character === '&' || character === '#')) {
    return true;
  }
  if (
    (prefix.kind === 'escaped_json' || (prefix.keyQuote === '"' && prefix.operator === ':')) &&
    (character === ',' || character === '}' || character === ']')
  ) {
    return true;
  }
  return (
    context === 'bash' &&
    outerLexicalBoundaryIsProven &&
    (character === ';' || character === '|' || character === '&')
  );
}

function publicSensitiveValueSpan(
  value: string,
  prefix: SensitivePrefix & {
    readonly authorizationCredential?: true;
    readonly authorizationClosingQuote?: '"' | "'" | 'escaped_json';
  },
  replacement: RedactionReplacement,
): RedactionSpan | undefined {
  let payloadStart = prefix.valueStart;
  let quotedValueStart: number | undefined;
  let projectedReplacement = replacement.literal;
  let closingQuote: '"' | "'" | 'escaped_json' | undefined =
    prefix.authorizationClosingQuote ?? prefix.outerValueQuote;
  if (
    closingQuote === undefined &&
    prefix.kind === 'escaped_json' &&
    isSingleBackslashQuote(value, payloadStart)
  ) {
    closingQuote = 'escaped_json';
    quotedValueStart = payloadStart;
    payloadStart += 2;
  } else if (
    closingQuote === undefined &&
    (value[payloadStart] === '"' || value[payloadStart] === "'")
  ) {
    closingQuote = value[payloadStart] as '"' | "'";
    quotedValueStart = payloadStart;
    payloadStart += 1;
  }

  let payloadEnd: number;
  let resumeIndex: number;
  if (closingQuote === 'escaped_json') {
    payloadEnd = payloadStart;
    while (payloadEnd < value.length) {
      if (isSingleBackslashQuote(value, payloadEnd)) break;
      if (value[payloadEnd] === '\n' || value[payloadEnd] === '\r') break;
      payloadEnd += String.fromCodePoint(value.codePointAt(payloadEnd)!).length;
    }
    resumeIndex = isSingleBackslashQuote(value, payloadEnd) ? payloadEnd + 2 : payloadEnd;
    if (resumeIndex > payloadEnd && !isPublicUnquotedValueBoundary(value[resumeIndex], prefix)) {
      payloadEnd = publicUnquotedValueEnd(value, resumeIndex, prefix);
      resumeIndex = payloadEnd;
      if (quotedValueStart !== undefined) {
        payloadStart = quotedValueStart;
        projectedReplacement = replacement.escapedString;
      } else {
        projectedReplacement = `${replacement.literal}${String.raw`\"`}`;
      }
    }
  } else if (closingQuote !== undefined) {
    payloadEnd = payloadStart;
    while (payloadEnd < value.length) {
      const character = value[payloadEnd];
      if (character === closingQuote) break;
      if (character === '\n' || character === '\r') break;
      if (closingQuote === '"' && character === '\\' && value[payloadEnd + 1] !== undefined) {
        payloadEnd += 2;
      } else {
        payloadEnd += String.fromCodePoint(value.codePointAt(payloadEnd)!).length;
      }
    }
    resumeIndex = value[payloadEnd] === closingQuote ? payloadEnd + 1 : payloadEnd;
    if (resumeIndex > payloadEnd && !isPublicUnquotedValueBoundary(value[resumeIndex], prefix)) {
      payloadEnd = publicUnquotedValueEnd(value, resumeIndex, prefix);
      resumeIndex = payloadEnd;
      if (quotedValueStart !== undefined) {
        payloadStart = quotedValueStart;
        projectedReplacement = `${closingQuote}${replacement.literal}${closingQuote}`;
      } else {
        projectedReplacement = `${replacement.literal}${closingQuote}`;
      }
    }
  } else {
    const unquotedScanStart = value.startsWith(replacement.literal, payloadStart)
      ? payloadStart + replacement.literal.length
      : payloadStart;
    payloadEnd =
      prefix.kind === 'escaped_json'
        ? publicSimpleUnquotedValueEnd(value, unquotedScanStart, prefix)
        : publicUnquotedValueEnd(value, unquotedScanStart, prefix);
    resumeIndex = payloadEnd;
  }
  if (payloadEnd === payloadStart) {
    const character = value[payloadStart];
    if (character === undefined || character === '"' || character === "'") return undefined;
    payloadEnd += String.fromCodePoint(value.codePointAt(payloadStart)!).length;
  }
  return {
    payloadStart,
    payloadEnd,
    resumeIndex,
    replacement: projectedReplacement,
  };
}

function publicSimpleUnquotedValueEnd(
  value: string,
  start: number,
  prefix: SensitivePrefix,
): number {
  let index = start;
  while (!isPublicUnquotedValueBoundary(value[index], prefix)) {
    index += String.fromCodePoint(value.codePointAt(index)!).length;
  }
  return index;
}

function publicUnquotedValueEnd(value: string, start: number, prefix: SensitivePrefix): number {
  const expansionClosers: Array<')' | '}'> = [];
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let mismatchedExpansion = false;
  let index = start;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '\n' || character === '\r') return index;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === '\\' && quote !== "'") escaped = true;
      else if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      index += 1;
      continue;
    }
    const expansionCloser = expansionCloserAt(value, index);
    if (expansionCloser !== undefined) {
      expansionClosers.push(expansionCloser);
      index += 2;
      continue;
    }
    if (expansionClosers.length > 0) {
      if (character === '(') expansionClosers.push(')');
      else if (character === '{') expansionClosers.push('}');
      else if (character === ')' || character === '}') {
        if (character === expansionClosers.at(-1)) expansionClosers.pop();
        else mismatchedExpansion = true;
      }
      index += 1;
      continue;
    }
    if (!mismatchedExpansion && isPublicUnquotedValueBoundary(character, prefix)) return index;
    index += String.fromCodePoint(value.codePointAt(index)!).length;
  }
  return index;
}

function expansionCloserAt(value: string, index: number): ')' | '}' | undefined {
  const marker = value[index];
  const opener = value[index + 1];
  if (marker === '$' && opener === '{') return '}';
  if (opener === '(' && (marker === '$' || marker === '<' || marker === '>')) return ')';
  return undefined;
}

function isPublicUnquotedValueBoundary(
  character: string | undefined,
  prefix: SensitivePrefix,
): boolean {
  if (character === undefined || isAnyWhitespace(character)) return true;
  if (character === ';' || character === '|') return true;
  if (character === '&') return true;
  if (prefix.kind === 'url' && character === '#') return true;
  return (
    (prefix.kind === 'escaped_json' || (prefix.keyQuote === '"' && prefix.operator === ':')) &&
    (character === ',' || character === '}' || character === ']')
  );
}

function applyRedactionSpans(value: string, spans: readonly RedactionSpan[]): string {
  if (spans.length === 0) return value;
  const chunks: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.payloadStart < cursor || span.payloadEnd <= span.payloadStart) continue;
    chunks.push(value.slice(cursor, span.payloadStart), span.replacement);
    cursor = span.payloadEnd;
  }
  chunks.push(value.slice(cursor));
  return chunks.join('');
}

function scanLiteralKey(value: string, start: number): { value: string; end: number } | undefined {
  let end = start;
  while (end - start < MAX_ENCODED_SENSITIVE_KEY_LENGTH && isKeyCharacter(value[end])) {
    end += 1;
  }
  return end === start ? undefined : { value: value.slice(start, end), end };
}

function isSafePayload(value: string): boolean {
  return SAFE_PAYLOAD_PATTERN.test(value);
}

function isSafeAuthorizationCredential(
  value: string,
  scheme: (typeof AUTHORIZATION_SCHEMES)[number] | undefined,
): boolean {
  if (value.length === 0) return false;
  const firstPadding = value.indexOf('=');
  const body = firstPadding === -1 ? value : value.slice(0, firstPadding);
  const padding = firstPadding === -1 ? '' : value.slice(firstPadding);
  if (!/^[A-Za-z0-9._~+/-]+$/.test(body)) return false;
  if (padding.length > 2 || (padding.length > 0 && !/^=+$/.test(padding))) return false;
  return scheme !== 'basic' || body.length > 0;
}

function isAuthorizationCredentialCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9._~+/=-]/.test(character);
}

function isSafePayloadCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9._-]/.test(character);
}

function isKeyCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_-]/.test(character);
}

function isHorizontalSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

function isOtherWhitespace(character: string | undefined): boolean {
  return character !== undefined && !isHorizontalSpace(character) && /\s/u.test(character);
}

function isAnyWhitespace(character: string | undefined): boolean {
  return isHorizontalSpace(character) || isOtherWhitespace(character);
}

function isSingleBackslashQuote(value: string, index: number): boolean {
  return backslashQuoteEndAt(value, index) === index + 2;
}

function backslashQuoteEndAt(value: string, start: number): number | undefined {
  if (value[start] !== '\\' || value[start - 1] === '\\') return undefined;
  let index = start + 1;
  while (value[index] === '\\') index += 1;
  return value[index] === '"' ? index + 1 : undefined;
}

function containsHeredocOpener(value: string): boolean {
  for (let index = 0; index + 1 < value.length; index += 1) {
    if (
      value[index] === '<' &&
      value[index + 1] === '<' &&
      value[index - 1] !== '<' &&
      value[index + 2] !== '<'
    ) {
      return true;
    }
  }
  return false;
}

function redactSerializedJsonSecrets(value: string): string {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return value;
  }
  try {
    const redacted = redactJsonValue(JSON.parse(value));
    return redacted.changed ? JSON.stringify(redacted.value) : value;
  } catch {
    return value;
  }
}

function redactJsonValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactJsonValue(item);
      changed = changed || redacted.changed;
      return redacted.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      if (
        raw === '' ||
        (/^(?:auth|authorization)$/i.test(key) &&
          typeof raw === 'string' &&
          /^(?:bearer|basic|token)[ \t]*$/i.test(raw))
      ) {
        next[key] = raw;
        continue;
      }
      next[key] = PUBLIC_REDACTED;
      changed = true;
      continue;
    }
    const redacted = redactJsonValue(raw);
    next[key] = redacted.value;
    changed = changed || redacted.changed;
  }
  return { value: next, changed };
}

function redactProviderSecretTokens(value: string): string {
  let next = value;
  for (const pattern of PUBLIC_PROVIDER_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, PUBLIC_REDACTED);
    pattern.lastIndex = 0;
  }
  return next;
}

function containsCriticalProviderSecret(value: string): boolean {
  for (const pattern of CRITICAL_PROVIDER_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}

function containsUnsupportedCriticalHex(value: string, allowLiteralGitObject: boolean): boolean {
  const pattern = new RegExp(AMBIGUOUS_HEX_CANDIDATE_PATTERN_SOURCE, 'gi');
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!allowLiteralGitObject || !isLiteralGitObjectArgument(value, start, end)) return true;
  }
  return false;
}

function isLiteralGitObjectArgument(
  command: string,
  objectStart: number,
  objectEnd: number,
): boolean {
  const objectLength = objectEnd - objectStart;
  if (objectLength !== 40 && objectLength !== 64) return false;

  const prefix = command.slice(0, objectStart);
  const suffix = command.slice(objectEnd);
  if (
    !/^[ \t]*git[ \t]+(?:reset[ \t]+--hard|show|log|diff|checkout|revert|cherry-pick)[ \t]+$/i.test(
      prefix,
    ) ||
    !/^[ \t]*$/.test(suffix)
  )
    return false;

  let commandStart = 0;
  while (isHorizontalSpace(command[commandStart])) commandStart += 1;
  const literalProofs = bashLiteralPrefixProofs(command);
  return literalProofs[commandStart] === true && literalProofs[objectStart] === true;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function generalizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return 'Request timed out';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit exceeded';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth'))
    return 'Authentication failed';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return 'Provider returned an error';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return 'Network error';
  return fallback;
}

/**
 * Chinese-locale companion to `generalizedErrorMessage()` (PR110b
 * follow-up). Same classification rules; returns Chinese phrasing
 * instead of English. Used by surfaces that must enforce a
 * Chinese-only error copy contract (Quick Chat, onboarding setup
 * banners, etc.) — the English version would have leaked through any
 * matched category, breaking the gate.
 *
 * The fallback default is also Chinese so callers that don't supply
 * one still produce a Chinese-only result. Pass a more specific
 * Chinese fallback (e.g. "会话已创建但发送失败，请重试。") for better
 * UX when the classifier can't categorize.
 */
export function generalizedErrorMessageChinese(error: unknown, fallback = '操作失败'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return '请求超时';
  if (lower.includes('429') || lower.includes('rate')) return '触发模型速率限制';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return '鉴权失败';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return '模型服务返回错误';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return '网络错误';
  return fallback;
}
