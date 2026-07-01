/**
 * Extracts a function declaration's source block by brace matching,
 * skipping over string literals, template literals, and comments so
 * that braces inside them do not skew the depth count.
 *
 * Tracks parenthesis depth past the parameter list before looking
 * for the body brace, so inline parameter types like
 * `props: { foo: string }` are not mistaken for the function body.
 *
 * Throws when the function is missing or its braces do not balance,
 * so a stale extraction boundary fails loudly instead of silently
 * degrading to an empty string.
 */
export function extractFunctionBlock(source: string, functionName: string): string {
  const head = new RegExp(`(?:export\\s+)?function\\s+${functionName}\\s*\\(`);
  const headMatch = source.match(head);
  if (!headMatch || headMatch.index === undefined) {
    throw new Error(`extractFunctionBlock: "${functionName}" not found`);
  }

  const blockStart = headMatch.index;

  // Advance past the parameter list by tracking paren depth so that
  // inline type braces inside the parameter list (e.g. `props: { … }`)
  // are not mistaken for the function body opener.
  let i = blockStart + headMatch[0].length - 1;
  let parenDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) { i++; break; }
    }
    i++;
  }

  // Find the body opener — the first '{' after the parameter list.
  while (i < source.length && source[i] !== '{') i++;
  if (i === source.length) {
    throw new Error(`extractFunctionBlock: no body brace for "${functionName}"`);
  }

  // Brace-match the body.
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(blockStart, i + 1);
    }
    i++;
  }

  throw new Error(`extractFunctionBlock: unbalanced braces for "${functionName}"`);
}
