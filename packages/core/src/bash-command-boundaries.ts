const BASH_COMMAND_BOUNDARY_CHARACTERS = '|;&\n\r(){}`';

export function splitBashCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = '';
  for (const character of command) {
    if (isBashCommandBoundaryCharacter(character)) {
      segments.push(segment);
      segment = '';
    } else {
      segment += character;
    }
  }
  segments.push(segment);
  return segments;
}

export function isBashCommandBoundaryCharacter(character: string): boolean {
  return character.length === 1 && BASH_COMMAND_BOUNDARY_CHARACTERS.includes(character);
}

/**
 * Proves where a sensitive prefix is in a literal top-level shell context.
 * This is a finite lexical cursor, not a shell parser: expansion, backticks,
 * concatenation, or ambiguous quoting fail closed until a proven top-level
 * command boundary resets the cursor.
 */
export function bashLiteralPrefixProofs(command: string): readonly boolean[] {
  const proofs = new Array<boolean>(command.length + 1).fill(false);
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let escaped = false;
  let literalPrefix = true;
  let quotedLiteralPrefix = false;
  const expectedExpansionClosers: Array<')' | '}'> = [];
  let mismatchedExpansion = false;

  for (let index = 0; index < command.length; index += 1) {
    proofs[index] =
      !mismatchedExpansion &&
      expectedExpansionClosers.length === 0 &&
      ((quote === undefined && literalPrefix) ||
        ((quote === 'single' || quote === 'double') && quotedLiteralPrefix));
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      literalPrefix = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") {
        quote = undefined;
        quotedLiteralPrefix = false;
      }
      literalPrefix = false;
      continue;
    }
    if (quote === 'double') {
      if (character === '\\') escaped = true;
      else if (character === '"') {
        quote = undefined;
        quotedLiteralPrefix = false;
      } else if (character === '$' || character === '`') {
        quotedLiteralPrefix = false;
      }
      literalPrefix = false;
      continue;
    }
    if (quote === 'backtick') {
      if (character === '\\') escaped = true;
      else if (character === '`') {
        quote = undefined;
        quotedLiteralPrefix = false;
      }
      literalPrefix = false;
      continue;
    }

    const expansionCloser = expansionCloserAt(command, index);
    if (expansionCloser !== undefined) {
      literalPrefix = false;
      expectedExpansionClosers.push(expansionCloser);
      index += 1;
      continue;
    }

    if (expectedExpansionClosers.length > 0) {
      literalPrefix = false;
      if (character === '(') {
        expectedExpansionClosers.push(')');
      } else if (character === '{') {
        expectedExpansionClosers.push('}');
      } else if (character === ')' || character === '}') {
        if (character === expectedExpansionClosers.at(-1)) {
          expectedExpansionClosers.pop();
        } else {
          mismatchedExpansion = true;
        }
      } else if (character === "'") {
        quote = 'single';
        quotedLiteralPrefix = false;
      } else if (character === '"') {
        quote = 'double';
        quotedLiteralPrefix = false;
      } else if (character === '`') {
        quote = 'backtick';
        quotedLiteralPrefix = false;
      } else if (character === '\\') {
        escaped = true;
      }
      continue;
    }

    if (character === "'") {
      quote = 'single';
      quotedLiteralPrefix = literalPrefix;
      literalPrefix = false;
    } else if (character === '"') {
      quote = 'double';
      quotedLiteralPrefix = literalPrefix;
      literalPrefix = false;
    } else if (character === '`') {
      quote = 'backtick';
      quotedLiteralPrefix = false;
      literalPrefix = false;
    } else if (character === '\\') {
      escaped = true;
      literalPrefix = false;
    } else if (character === '$') {
      literalPrefix = false;
    } else if ((character === '(' || character === '{') && literalPrefix) {
      literalPrefix = true;
    } else if (character === ')' || character === '}') {
      literalPrefix = false;
    } else if (
      character === '|' ||
      character === ';' ||
      character === '&' ||
      character === '\n' ||
      character === '\r'
    ) {
      if (!mismatchedExpansion) literalPrefix = true;
    }
  }
  proofs[command.length] =
    !mismatchedExpansion &&
    expectedExpansionClosers.length === 0 &&
    ((quote === undefined && literalPrefix) ||
      ((quote === 'single' || quote === 'double') && quotedLiteralPrefix));
  return proofs;
}

function expansionCloserAt(command: string, index: number): ')' | '}' | undefined {
  const marker = command[index];
  const opener = command[index + 1];
  if (marker === '$' && opener === '{') return '}';
  if (opener === '(' && (marker === '$' || marker === '<' || marker === '>')) return ')';
  return undefined;
}
