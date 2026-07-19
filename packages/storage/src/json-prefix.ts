export type JsonRecordClassification = 'complete' | 'incomplete-prefix' | 'invalid';

/** Classifies whether bytes missing only from the end could make this valid JSON. */
export function classifyJsonRecord(value: string): JsonRecordClassification {
  try {
    JSON.parse(value);
    return 'complete';
  } catch {
    // Only parse failures need the stricter prefix distinction below.
  }
  return new JsonPrefixParser(value).classify();
}

class JsonPrefixParser {
  private index = 0;

  constructor(private readonly value: string) {}

  classify(): JsonRecordClassification {
    this.skipWhitespace();
    const state = this.parseValue(0);
    if (state !== 'complete') return state;
    this.skipWhitespace();
    return this.index === this.value.length ? 'complete' : 'invalid';
  }

  private parseValue(depth: number): JsonRecordClassification {
    if (depth > 512) return 'invalid';
    if (this.index === this.value.length) return 'incomplete-prefix';
    switch (this.value[this.index]) {
      case '{':
        return this.parseObject(depth + 1);
      case '[':
        return this.parseArray(depth + 1);
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true');
      case 'f':
        return this.parseLiteral('false');
      case 'n':
        return this.parseLiteral('null');
      default:
        return this.parseNumber();
    }
  }

  private parseObject(depth: number): JsonRecordClassification {
    this.index += 1;
    this.skipWhitespace();
    if (this.index === this.value.length) return 'incomplete-prefix';
    if (this.value[this.index] === '}') {
      this.index += 1;
      return 'complete';
    }
    while (true) {
      if (this.value[this.index] !== '"') return 'invalid';
      const key = this.parseString();
      if (key !== 'complete') return key;
      this.skipWhitespace();
      if (this.index === this.value.length) return 'incomplete-prefix';
      if (this.value[this.index] !== ':') return 'invalid';
      this.index += 1;
      this.skipWhitespace();
      const item = this.parseValue(depth);
      if (item !== 'complete') return item;
      this.skipWhitespace();
      if (this.index === this.value.length) return 'incomplete-prefix';
      const delimiter = this.value[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return 'complete';
      }
      if (delimiter !== ',') return 'invalid';
      this.index += 1;
      this.skipWhitespace();
      if (this.index === this.value.length) return 'incomplete-prefix';
      if (this.value[this.index] === '}') return 'invalid';
    }
  }

  private parseArray(depth: number): JsonRecordClassification {
    this.index += 1;
    this.skipWhitespace();
    if (this.index === this.value.length) return 'incomplete-prefix';
    if (this.value[this.index] === ']') {
      this.index += 1;
      return 'complete';
    }
    while (true) {
      const item = this.parseValue(depth);
      if (item !== 'complete') return item;
      this.skipWhitespace();
      if (this.index === this.value.length) return 'incomplete-prefix';
      const delimiter = this.value[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return 'complete';
      }
      if (delimiter !== ',') return 'invalid';
      this.index += 1;
      this.skipWhitespace();
      if (this.index === this.value.length) return 'incomplete-prefix';
      if (this.value[this.index] === ']') return 'invalid';
    }
  }

  private parseString(): JsonRecordClassification {
    this.index += 1;
    while (this.index < this.value.length) {
      const code = this.value.charCodeAt(this.index);
      const char = this.value[this.index]!;
      this.index += 1;
      if (char === '"') return 'complete';
      if (code < 0x20) return 'invalid';
      if (char !== '\\') continue;
      if (this.index === this.value.length) return 'incomplete-prefix';
      const escape = this.value[this.index]!;
      this.index += 1;
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u') return 'invalid';
      const remaining = this.value.length - this.index;
      if (remaining < 4) {
        const suffix = this.value.slice(this.index);
        return /^[0-9a-fA-F]*$/.test(suffix) ? 'incomplete-prefix' : 'invalid';
      }
      if (!/^[0-9a-fA-F]{4}$/.test(this.value.slice(this.index, this.index + 4))) {
        return 'invalid';
      }
      this.index += 4;
    }
    return 'incomplete-prefix';
  }

  private parseLiteral(literal: string): JsonRecordClassification {
    const available = this.value.slice(this.index, this.index + literal.length);
    if (!literal.startsWith(available)) return 'invalid';
    if (available.length < literal.length) {
      this.index = this.value.length;
      return 'incomplete-prefix';
    }
    this.index += literal.length;
    return 'complete';
  }

  private parseNumber(): JsonRecordClassification {
    const start = this.index;
    if (this.value[this.index] === '-') {
      this.index += 1;
      if (this.index === this.value.length) return 'incomplete-prefix';
    }
    const first = this.value[this.index];
    if (first === '0') {
      this.index += 1;
      if (isDigit(this.value[this.index])) return 'invalid';
    } else if (isNonZeroDigit(first)) {
      this.index += 1;
      while (isDigit(this.value[this.index])) this.index += 1;
    } else {
      this.index = start;
      return 'invalid';
    }

    if (this.value[this.index] === '.') {
      this.index += 1;
      if (this.index === this.value.length) return 'incomplete-prefix';
      if (!isDigit(this.value[this.index])) return 'invalid';
      while (isDigit(this.value[this.index])) this.index += 1;
    }
    if (this.value[this.index] === 'e' || this.value[this.index] === 'E') {
      this.index += 1;
      if (this.index === this.value.length) return 'incomplete-prefix';
      if (this.value[this.index] === '+' || this.value[this.index] === '-') {
        this.index += 1;
        if (this.index === this.value.length) return 'incomplete-prefix';
      }
      if (!isDigit(this.value[this.index])) return 'invalid';
      while (isDigit(this.value[this.index])) this.index += 1;
    }
    return 'complete';
  }

  private skipWhitespace(): void {
    while (
      this.value[this.index] === ' ' ||
      this.value[this.index] === '\t' ||
      this.value[this.index] === '\n' ||
      this.value[this.index] === '\r'
    ) {
      this.index += 1;
    }
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isNonZeroDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}
