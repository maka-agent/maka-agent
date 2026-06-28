export interface DestructiveCommandViolation {
  command: string;
  reason: string;
  segment: string;
}

export interface DestructiveCommandGuardResult {
  allowed: boolean;
  violations: DestructiveCommandViolation[];
}

interface ShellWord {
  kind: 'word';
  value: string;
}

interface ShellSeparator {
  kind: 'separator';
}

type ShellToken = ShellWord | ShellSeparator;

const BLOCKED_COMMANDS = new Set([
  'kill',
  'killall',
  'pkill',
  'rm',
  'rmdir',
  'service',
  'shred',
  'systemctl',
  'truncate',
  'unlink',
]);

const WRAPPER_COMMANDS = new Set(['builtin', 'command', 'doas', 'exec', 'sudo']);
const SHELL_COMMANDS = new Set(['bash', 'dash', 'sh', 'zsh']);

export function checkDestructiveShellCommand(command: string): DestructiveCommandGuardResult {
  const violations = scanTokens(tokenizeShell(command), 0);
  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function formatDestructiveCommandGuardMessage(result: DestructiveCommandGuardResult): string {
  const first = result.violations[0];
  if (!first) return 'Maka destructive-command guard allowed the command.';
  const detail = result.violations.length === 1
    ? first.reason
    : `${first.reason} (${result.violations.length} policy violations found)`;
  return [
    `Maka destructive-command guard refused this Bash command: ${detail}.`,
    'Use Read/Grep for inspection and Write/Edit for targeted file changes; avoid broad delete, service-control, or process-kill operations in benchmark containers.',
  ].join('\n');
}

function scanTokens(tokens: ShellToken[], depth: number): DestructiveCommandViolation[] {
  if (depth > 3) return [];
  const violations: DestructiveCommandViolation[] = [];
  let segment: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'separator') {
      violations.push(...scanSegment(segment, depth));
      segment = [];
    } else {
      segment.push(token.value);
    }
  }
  violations.push(...scanSegment(segment, depth));
  return violations;
}

function scanSegment(words: string[], depth: number): DestructiveCommandViolation[] {
  const compact = words.filter((word) => word.length > 0);
  if (compact.length === 0) return [];
  const normalized = unwrapCommand(compact);
  if (normalized.length === 0) return [];
  const command = commandName(normalized[0]);
  const segment = compact.join(' ');

  if (SHELL_COMMANDS.has(command)) {
    return scanNestedShellCommand(normalized, depth);
  }

  if (command === 'find') return scanFindCommand(normalized, segment);
  if (command === 'chmod' || command === 'chown' || command === 'chgrp') {
    if (hasRecursiveFlag(normalized.slice(1))) {
      return [violation(command, 'recursive permission/ownership changes are blocked', segment)];
    }
    return [];
  }
  if (command === 'mv') {
    if (normalized.slice(1).some(isForceFlag)) {
      return [violation(command, 'forceful mv can overwrite or remove task artifacts', segment)];
    }
    return [];
  }
  if (command === 'xargs') return scanXargsCommand(normalized, segment);
  if (BLOCKED_COMMANDS.has(command)) {
    return [violation(command, `${command} is blocked in model-authored Bash`, segment)];
  }
  return [];
}

function unwrapCommand(words: string[]): string[] {
  let rest = stripAssignments(words);
  let changed = true;
  while (changed && rest.length > 0) {
    changed = false;
    const command = commandName(rest[0]);
    if (WRAPPER_COMMANDS.has(command)) {
      rest = stripAssignments(rest.slice(1));
      changed = true;
    } else if (command === 'env') {
      rest = unwrapEnv(rest.slice(1));
      changed = true;
    } else if (command === 'timeout') {
      rest = unwrapTimeout(rest.slice(1));
      changed = true;
    }
  }
  return rest;
}

function stripAssignments(words: string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

function unwrapEnv(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === '-i' || word === '-' || word.startsWith('-S') || word.startsWith('-0')) {
      index += 1;
    } else if (word === '-u' || word === '--unset') {
      index += 2;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
    } else {
      break;
    }
  }
  return stripAssignments(words.slice(index));
}

function unwrapTimeout(words: string[]): string[] {
  let index = 0;
  while (index < words.length && words[index].startsWith('-')) {
    index += optionConsumesValue(words[index]) ? 2 : 1;
  }
  if (index < words.length) index += 1;
  return stripAssignments(words.slice(index));
}

function optionConsumesValue(option: string): boolean {
  return option === '-s' || option === '--signal' || option === '-k' || option === '--kill-after';
}

function scanNestedShellCommand(words: string[], depth: number): DestructiveCommandViolation[] {
  const cIndex = words.findIndex((word) => word === '-c' || word.endsWith('c') && /^-[A-Za-z]+$/.test(word));
  if (cIndex < 0 || cIndex + 1 >= words.length) return [];
  const nestedCommand = words[cIndex + 1];
  return scanTokens(tokenizeShell(nestedCommand), depth + 1);
}

function scanFindCommand(words: string[], segment: string): DestructiveCommandViolation[] {
  const violations: DestructiveCommandViolation[] = [];
  if (words.includes('-delete')) {
    violations.push(violation('find', 'find -delete is blocked', segment));
  }
  for (let index = 1; index < words.length - 1; index += 1) {
    if (words[index] !== '-exec' && words[index] !== '-execdir') continue;
    const nested = commandName(words[index + 1]);
    if (BLOCKED_COMMANDS.has(nested) || nested === 'mv') {
      violations.push(violation('find', `find ${words[index]} ${nested} is blocked`, segment));
    }
  }
  return violations;
}

function scanXargsCommand(words: string[], segment: string): DestructiveCommandViolation[] {
  const nested = words.map(commandName).find((word) => BLOCKED_COMMANDS.has(word) || word === 'mv');
  return nested ? [violation('xargs', `xargs ${nested} is blocked`, segment)] : [];
}

function hasRecursiveFlag(words: string[]): boolean {
  return words.some((word) => word === '--recursive' || /^-[^-]*R/.test(word));
}

function isForceFlag(word: string): boolean {
  return word === '-f' || word === '--force' || /^-[^-]*f/.test(word);
}

function violation(command: string, reason: string, segment: string): DestructiveCommandViolation {
  return { command, reason, segment };
}

function commandName(word: string): string {
  const trimmed = word.trim();
  const slash = trimmed.lastIndexOf('/');
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

function tokenizeShell(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushWord = () => {
    if (current.length > 0) {
      tokens.push({ kind: 'word', value: current });
      current = '';
    }
  };
  const pushSeparator = () => {
    pushWord();
    if (tokens[tokens.length - 1]?.kind !== 'separator') tokens.push({ kind: 'separator' });
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      pushSeparator();
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      if (ch === '\n') pushSeparator();
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      pushSeparator();
      continue;
    }
    current += ch;
  }
  pushWord();
  return tokens;
}
