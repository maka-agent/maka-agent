/**
 * Permission system: PermissionMode + ToolCategory + Mode × Category policy
 * matrix + pure `preToolUse()` evaluator. Runtime owns requestId generation.
 *
 * Purity rule: `preToolUse()` is deterministic given its input — no UUIDs,
 * no clock reads, no I/O. PermissionEngine in runtime wraps it and supplies
 * requestId at the call site.
 */

import { splitBashCommandSegments } from './bash-command-boundaries.js';
import {
  validateAdditionalPermissionProfile,
  type AdditionalPermissionProfile,
} from './additional-permissions.js';
import {
  canonicalToolExecutionArgs,
  canonicalToolRememberScopeMaterial,
  createCanonicalToolIntentWithCategory,
  InteractionPermissionProjectionError,
  knownToolBaseCategory,
  knownToolCategoryEntries,
  knownToolUsesBashCategorizer,
  projectPublicToolApprovalReview,
  projectPublicToolPathReview,
  publicToolReviewRememberAllowed,
  requireCanonicalToolIntent,
  type CanonicalToolIntent,
  type PublicToolCommandReview,
  type PublicToolIntentReview,
} from './tool-intent.js';

// ============================================================================
// Mode + Tool categories
// ============================================================================

export const PERMISSION_MODES = ['explore', 'ask', 'execute', 'bypass'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVALS_REVIEWERS = ['user', 'auto_review'] as const;
export type ApprovalsReviewer = (typeof APPROVALS_REVIEWERS)[number];

export const APPROVAL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

export interface ActiveApprovalRoutingPolicy {
  readonly reviewer: ApprovalsReviewer;
  readonly sandboxEscalationAllowed: boolean;
}

export function approvalRoutingPolicyForMode(
  mode: PermissionMode,
): ActiveApprovalRoutingPolicy | null {
  switch (mode) {
    case 'ask':
      return { reviewer: 'user', sandboxEscalationAllowed: true };
    case 'execute':
      return { reviewer: 'auto_review', sandboxEscalationAllowed: true };
    case 'explore':
      return { reviewer: 'user', sandboxEscalationAllowed: false };
    case 'bypass':
      return null;
  }
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Canonical category names use Claude SDK terminology. Pi adapter MUST
 *  translate Pi-native tool names into these before they reach the runtime. */
export type ToolCategory =
  | 'read' //              Read, search_files, Grep, Glob, ls
  | 'web_read' //          WebFetch, WebSearch (GET-class)
  | 'file_write' //        Write, Edit, patch (create / append / overwrite)
  | 'fs_destructive' //    rm, rmdir, dd, truncate, shred, mkfs, find -delete, ...
  | 'shell_unsafe' //      default Bash bucket
  | 'git_destructive' //   git reset --hard, push --force, branch -D, ...
  | 'network_send' //      POST / PUT / DELETE
  | 'privileged' //        sudo, chmod, chown, kill, systemctl
  | 'browser' //           embedded-browser observe→act on the user's logged-in sessions
  | 'computer_use' //      host-level observation and input on the user's real applications
  | 'custom_tool' //       our own session-scoped tools without a stricter category hint
  | 'subagent'; //         read-only delegated exploration tools

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'read',
  'web_read',
  'file_write',
  'fs_destructive',
  'shell_unsafe',
  'git_destructive',
  'network_send',
  'privileged',
  'browser',
  'computer_use',
  'custom_tool',
  'subagent',
];

export function isToolCategory(value: unknown): value is ToolCategory {
  return typeof value === 'string' && (TOOL_CATEGORIES as readonly string[]).includes(value);
}

export type ToolPermissionRule =
  | {
      effect: 'allow' | 'deny';
      kind: 'category';
      category: ToolCategory;
    }
  | {
      effect: 'allow' | 'deny';
      kind: 'bash_exact';
      command: string;
    }
  | {
      effect: 'allow' | 'deny';
      kind: 'tool';
      toolName: string;
    };

export interface ToolPermissionRuleMatchInput {
  intent: CanonicalToolIntent;
  rules: readonly ToolPermissionRule[];
}

/** Explicit deny rules always win over explicit allow rules, regardless of argv order. */
export function matchToolPermissionRules(
  input: ToolPermissionRuleMatchInput,
): 'allow' | 'deny' | undefined {
  requireCanonicalToolIntent(input.intent);
  if (
    input.rules.some((rule) => rule.effect === 'deny' && toolPermissionRuleMatches(rule, input))
  ) {
    return 'deny';
  }
  if (
    input.rules.some((rule) => rule.effect === 'allow' && toolPermissionRuleMatches(rule, input))
  ) {
    return 'allow';
  }
  return undefined;
}

function toolPermissionRuleMatches(
  rule: ToolPermissionRule,
  input: Omit<ToolPermissionRuleMatchInput, 'rules'>,
): boolean {
  if (rule.kind === 'category') return rule.category === input.intent.category;
  if (rule.kind === 'tool') return rule.toolName === input.intent.toolName;
  const args = canonicalToolExecutionArgs(input.intent);
  const command = (args as { command?: unknown } | null)?.command;
  return (
    input.intent.toolName === 'Bash' && typeof command === 'string' && command === rule.command
  );
}

// ============================================================================
// Tool execution environment facts
// ============================================================================

export type ToolExecutionIsolation = 'none' | 'worktree' | 'container' | 'remote';
export type ToolExecutionWriteBack = 'direct' | 'diff_review';
export type ToolExecutionNetwork = 'host' | 'sandbox' | 'disabled';
export type ToolExecutionSecrets = 'host_env' | 'brokered' | 'none';

export interface ToolExecutionFacts {
  isolation: ToolExecutionIsolation;
  writesAffectHost: boolean;
  writeBack: ToolExecutionWriteBack;
  network: ToolExecutionNetwork;
  secrets: ToolExecutionSecrets;
}

// ============================================================================
// Policy matrix
// ============================================================================

export type PolicyDecision = 'allow' | 'prompt' | 'block';

export const PERMISSION_POLICY: Record<PermissionMode, Record<ToolCategory, PolicyDecision>> = {
  explore: {
    read: 'allow',
    // PR-AGENT-WEB-SEARCH-TOOL-0: explicit network egress (WebSearch
    // via Tavily) prompts in non-autonomous modes. Agent-issued web
    // requests are out-of-process side effects the user must confirm,
    // even in the otherwise read-only `explore` mode.
    web_read: 'prompt',
    file_write: 'block',
    fs_destructive: 'block',
    shell_unsafe: 'block',
    git_destructive: 'block',
    network_send: 'block',
    privileged: 'block',
    // Driving the user's logged-in browser is an out-of-process effect; explore
    // mode is read-only-local, so block it like other network/write effects.
    browser: 'block',
    computer_use: 'block',
    custom_tool: 'prompt',
    subagent: 'allow',
  },
  ask: {
    read: 'allow',
    web_read: 'prompt',
    file_write: 'prompt',
    fs_destructive: 'prompt',
    shell_unsafe: 'prompt',
    git_destructive: 'prompt',
    network_send: 'prompt',
    privileged: 'prompt',
    browser: 'prompt',
    computer_use: 'prompt',
    custom_tool: 'allow',
    subagent: 'prompt',
  },
  execute: {
    read: 'allow',
    web_read: 'allow',
    file_write: 'allow',
    network_send: 'allow',
    custom_tool: 'allow',
    subagent: 'allow',
    // Shell stays prompt in the static table. policyDecisionForInput upgrades
    // shell_unsafe to allow only when runtime proves the active profile can be
    // enforced by a platform sandbox; otherwise this fail-closed default wins.
    shell_unsafe: 'prompt',
    // Irreversible ops ALWAYS prompt, even in execute mode.
    fs_destructive: 'prompt',
    git_destructive: 'prompt',
    privileged: 'prompt',
    // Browser act/observe drives the user's logged-in sessions — effectively
    // irreversible (it can post, send, buy). Prompt even in execute so the
    // visible view stays a confirmed safety net, not a default-allow. The
    // user's "allow for this turn" then carries the observe→act loop.
    browser: 'prompt',
    // Computer Use uses target- and action-class scope keys. Remembering a
    // metadata read never authorizes a screenshot or mutation.
    computer_use: 'prompt',
  },
  bypass: {
    read: 'allow',
    web_read: 'allow',
    file_write: 'allow',
    fs_destructive: 'allow',
    shell_unsafe: 'allow',
    git_destructive: 'allow',
    network_send: 'allow',
    privileged: 'allow',
    browser: 'allow',
    computer_use: 'allow',
    custom_tool: 'allow',
    subagent: 'allow',
  },
};

// ============================================================================
// Tool name → category mapping (Claude SDK canonical names)
// ============================================================================

export const BUILTIN_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = Object.freeze(
  Object.fromEntries(knownToolCategoryEntries()) as Record<string, ToolCategory>,
);

// ============================================================================
// Shell command categorization
// ============================================================================

// There is no SAFE_SHELL_PREFIXES allowlist: a shell command cannot be proven
// safe from its string. Any prefix that accepts arguments can hide execution
// in them — PowerShell `echo (Set-Content x)` runs Set-Content first; `$(...)`,
// backtick, and `iex` do the same in bash/PowerShell; even "read-only" commands
// like `git status` can trigger fsmonitor helpers. Eight review rounds of
// enumerating dangerous shapes proved the futility of the inverse (deciding a
// Turing-complete shell's runtime effect from a static string is undecidable).
// So categorizeBash never returns an auto-safe category; read-only needs go
// through typed tools (Read/Glob/Grep — fixed argv, no shell), and every shell command is at
// least shell_unsafe → prompt. The categories below only make the confirmation
// REASON accurate (delete vs elevate vs generic); they are no longer the safety
// boundary, so a missed pattern is a wording nit, not a bypass.

export const PRIVILEGED_SHELL_PREFIXES: readonly string[] = [
  'sudo ',
  'su ',
  'chmod ',
  'chown ',
  'chgrp ',
  'mount ',
  'umount ',
  'kill ',
  'killall ',
  'systemctl ',
  'launchctl ',
  'shutdown',
  'reboot',
];

/** PowerShell/cmd equivalents of the privileged boundary above: process
 *  termination (kill/killall), service control (systemctl), power
 *  (shutdown/reboot), and ACL/ownership (chmod/chown). Case-insensitive
 *  because PowerShell is. */
export const PRIVILEGED_SHELL_PATTERNS: readonly RegExp[] = [
  // kill is PowerShell's default alias for Stop-Process; bare `kill` also
  // shows up as the tail of `Get-Process x | kill`. (POSIX `kill ` prefix is
  // handled separately for the pid-argument form.)
  /^(kill|stop-process|spps|taskkill)\b/i,
  // Elevation intent: -Verb RunAs is the PowerShell form of `runas`. Anchor on
  // the flag itself, not the Start-Process alias, so plain Start-Process stays
  // shell_unsafe while any elevated launch prompts.
  /(^|\s)-verb\s+runas\b/i,
  // Service control mirrors the blanket `systemctl ` prefix above: every
  // mutating verb prompts; read-only queries (sc query, Get-Service) do not.
  // sasv/spsv are the documented default aliases of Start-/Stop-Service.
  /^((start|stop|restart|set|new|remove|suspend|resume)-service|sasv|spsv)\b/i,
  /^sc\s+(stop|start|pause|continue|delete|config|create|failure|sdset)\b/i,
  /^net\s+(stop|start|pause|continue)\b/i,
  /^(stop-computer|restart-computer)\b/i,
  /^(icacls|takeown|set-acl|runas)\b/i,
];

/** Irreversible filesystem operations. `rm` in any form (incl. single-file
 *  `rm foo.txt`) lands here so auto/execute mode still prompts. Anchored to
 *  the start of every statement segment (see commandSegments), not just the
 *  whole command. */
export const FS_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^dd\s+/,
  /^truncate\b/,
  /^shred\b/,
  /^mkfs\b/,
  /^git\s+restore\s+(\.\s*$|--\s+\S+)/, //          git restore . or git restore -- <path>
  /^git\s+checkout\s+--\s+\S+/, //                  git checkout -- <path>
  // Pipeline / batch destructors via find/xargs
  /^find\s+.*\s-delete\b/,
  /^find\s+.*\s-exec\s+.*\b(rm|shred|truncate|dd)\b/,
  /^xargs\s+.*\b(rm|shred|truncate|dd)\b/,
  // PowerShell / cmd.exe deletes plus the POSIX rm family. On Windows the
  // Bash tool runs PowerShell and steers the model toward its syntax
  // (shell-detect.ts), so these land in fs_destructive to make the confirmation
  // REASON accurate (delete, not generic) — not to gate allow-vs-prompt, which
  // is already closed: shell_unsafe prompts too, so a miss only mislabels the
  // reason. Case-insensitive because PowerShell is (harmless for the POSIX
  // names: an upper-cased rm is still rm-shaped). Applied on POSIX too: the only
  // real collision is Ruby's docs tool `ri`, and the failure mode is an extra
  // prompt, not a bypass.
  /^remove-item\b/i,
  /^(rm|rmdir|ri|del|erase|rd)\b/i,
  /^(clear-content|clc)\b/i,
];

export const PIPE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\|\s*xargs\b[^\n;&|]*\b(rm|shred|truncate|dd)\b/,
  /\|\s*(sh|bash|zsh)\b/,
];

export const DESTRUCTIVE_GIT_PATTERNS: readonly RegExp[] = [
  /^git\s+reset\s+--hard\b/,
  /^git\s+push\s+(--force|-f)\b/,
  /^git\s+branch\s+-D\b/,
  /^git\s+clean\s+-fd?\b/,
  /^git\s+checkout\s+\.\s*$/,
  /^git\s+rebase\s+-i\b/,
];

/**
 * Positions where a command name can start: the beginning, plus after every
 * statement / pipeline / scriptblock / substitution boundary. Splitting is
 * deliberately quote-naive; quote-AWARE splitting would be strictly worse,
 * because `$( )` and backticks expand INSIDE double quotes in both dialects —
 * not splitting there would hide `echo "$(rm x)"`. Naive splitting never
 * drops content, it only cuts it up: every byte lands in some segment, and
 * normalizeSegmentHead strips unclosed-quote remnants off segment heads
 * (`"del` from a payload cut at an inner `&` still matches). So extra
 * boundaries add scan candidates; they do not hide them.
 */
function commandSegments(cmd: string): string[] {
  return splitBashCommandSegments(cmd)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Commands that defer to the real command later in the segment. */
const WRAPPER_COMMANDS = new Set([
  'nohup',
  'nice',
  'time',
  'timeout',
  'env',
  'command',
  'exec',
  'stdbuf',
]);

/** Shell-in-shell heads whose literal payload can be categorized recursively.
 *  Interpreters (python -c, node -e) are deliberately absent: we know these
 *  shells' dialects, we do not parse arbitrary languages. */
const NESTED_SHELL_HEADS: ReadonlyArray<{ head: RegExp; flag: RegExp }> = [
  { head: /^(sh|bash|zsh)$/, flag: /(?:^|\s)-\w*c\s+([\s\S]+)$/ },
  { head: /^(pwsh|powershell)$/i, flag: /\s-c(?:ommand)?\s+([\s\S]+)$/i },
  { head: /^cmd$/i, flag: /\s\/[ck]\s+([\s\S]+)$/i },
];

/**
 * Canonicalize the segment's first token to the command name it resolves to:
 * unwrap quotes (`& 'Remove-Item' x`), drop a leading escape (`\rm`), a path
 * prefix (`/bin/rm`, `C:\...\taskkill.exe`) and the .exe suffix, and skip
 * wrapper commands plus their option-ish arguments (`nohup`, `timeout 30`,
 * `env FOO=bar`). Only the UPGRADE checks (privileged/fs/git) see this
 * normalization — the safe-prefix check keeps the raw command, so a local
 * script named `./ls` can never be upgraded to a read category.
 */
function normalizeSegmentHead(segment: string): string {
  let rest = segment;
  for (let hops = 0; hops < 5; hops++) {
    const quoted = /^(['"])(.+?)\1(\s+|$)/.exec(rest);
    const bare = quoted ? null : /^(\S+)(\s*)([\s\S]*)$/.exec(rest);
    if (!quoted && !bare) return rest;
    let head = quoted ? quoted[2]! : bare![1]!;
    const tail = quoted ? rest.slice(quoted[0].length) : bare![3]!;
    head = head
      // Quote chars anywhere in the name: unclosed remnants of a payload cut
      // mid-string (`"del`) and PowerShell quote interruptions (Remove''-Item
      // executes Remove-Item — verified on real pwsh). Caret is cmd.exe's
      // escape char (de^l executes del). Fold them out of the NAME only; the
      // safe-prefix check never sees this normalization.
      .replace(/['"^]/g, '')
      .replace(/^\\/, '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.exe$/i, '');
    if (WRAPPER_COMMANDS.has(head.toLowerCase())) {
      rest = tail.replace(/^((-\S+|\S+=\S*|\d+[smhd]?)\s+)*/, '');
      continue;
    }
    return tail ? `${head} ${tail}` : head;
  }
  return rest;
}

/** Head-normalized segments, plus (recursively) the segments of any literal
 *  shell-in-shell payload: `cmd /c del foo.txt` also yields `del foo.txt`. */
function scanSegments(cmd: string, depth: number): string[] {
  const out: string[] = [];
  for (const raw of commandSegments(cmd)) {
    const segment = normalizeSegmentHead(raw);
    out.push(segment);
    if (depth === 0) continue;
    const payload = nestedShellPayload(segment);
    if (payload) out.push(...scanSegments(payload, depth - 1));
  }
  return out;
}

function nestedShellPayload(segment: string): string | undefined {
  const head = /^\S*/.exec(segment)![0];
  for (const shell of NESTED_SHELL_HEADS) {
    if (!shell.head.test(head)) continue;
    const match = shell.flag.exec(segment);
    if (!match) return undefined;
    const payload = match[1]!.trim();
    const unquoted = /^(['"])([\s\S]*)\1$/.exec(payload);
    return unquoted ? unquoted[2] : payload;
  }
  return undefined;
}

function isPrivilegedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    PRIVILEGED_SHELL_PREFIXES.some((p) => lower.startsWith(p)) ||
    PRIVILEGED_SHELL_PATTERNS.some((re) => re.test(segment))
  );
}

/**
 * Categorize a shell command into a permission bucket. There is no auto-safe
 * outcome: no shell command is auto-allowed (see the note above the privileged
 * prefixes). This function's job is only to pick the most accurate confirmation
 * REASON — privileged > fs_destructive > git_destructive > shell_unsafe — by
 * scanning EVERY statement segment (with a canonicalized first token), so
 * `cd /tmp; rm -rf stuff`, `Get-ChildItem . | ForEach-Object { Remove-Item $_ }`,
 * and `& 'Remove-Item' x` all read as destructive. Since the fallback
 * shell_unsafe already prompts, a missed variant only mislabels the reason; it
 * never changes allow-vs-prompt.
 */
export function categorizeBash(cmd: string): ToolCategory {
  const t = cmd.trim();
  // Backtick is BOTH a split boundary (bash command substitution — `rm x` runs
  // even inside double quotes, so it must stay a boundary) AND PowerShell's
  // in-name escape (R`M runs rm, Remove`-Item runs Remove-Item — verified on
  // real pwsh). Splitting alone would leave the PS name as two innocent halves,
  // so scan the split segments AND a backtick-collapsed variant of the command.
  const segments = scanSegments(cmd, 2);
  if (cmd.includes('`')) segments.push(...scanSegments(cmd.replace(/`/g, ''), 2));
  if (segments.some((s) => isPrivilegedSegment(s))) return 'privileged';
  if (segments.some((s) => FS_DESTRUCTIVE_PATTERNS.some((re) => re.test(s))))
    return 'fs_destructive';
  if (PIPE_DESTRUCTIVE_PATTERNS.some((re) => re.test(t))) return 'fs_destructive';
  if (segments.some((s) => DESTRUCTIVE_GIT_PATTERNS.some((re) => re.test(s))))
    return 'git_destructive';
  return 'shell_unsafe';
}

// ============================================================================
// Pre-tool-use 3-step evaluator (pure)
// ============================================================================

export interface PreToolUseInput {
  intent: CanonicalToolIntent;
  mode: PermissionMode;
  turnMemory: TurnPermissionMemory;
  /**
   * Platform sandbox availability for sandbox-aware policy decisions. Unsafe
   * shell in execute mode is only auto-allowed when the runtime can actually
   * enforce the active profile with a platform sandbox.
   */
  sandbox?: {
    platformSandboxAvailable: boolean;
  };
}

export interface CreateCanonicalToolIntentInput {
  readonly toolName: string;
  readonly args: unknown;
  readonly cwd: string;
  readonly categoryHint?: ToolCategory;
}

export type PreToolUseResult =
  | {
      readonly kind: 'allow';
      readonly category: ToolCategory;
      readonly source: 'policy' | 'remembered';
    }
  | {
      readonly kind: 'block';
      readonly category: ToolCategory;
      readonly reason: string;
    }
  | {
      readonly kind: 'prompt';
      readonly category: ToolCategory;
      readonly prompt: ToolPermissionPrompt;
      readonly rememberScope?: PermissionRememberScope;
    };

export function classifyToolUse(input: {
  toolName: string;
  args: unknown;
  categoryHint?: ToolCategory;
}): ToolCategory {
  const builtinCategory = knownToolBaseCategory(input.toolName);
  let category: ToolCategory = builtinCategory ?? input.categoryHint ?? 'custom_tool';
  if (knownToolUsesBashCategorizer(input.toolName)) {
    const cmd = stringDataProperty(input.args, 'command');
    if (typeof cmd === 'string') category = categorizeBash(cmd);
  }
  return category;
}

export function createCanonicalToolIntent(
  input: CreateCanonicalToolIntentInput,
): CanonicalToolIntent {
  if (input.categoryHint !== undefined && !isToolCategory(input.categoryHint)) {
    throw new TypeError('Invalid canonical tool category hint');
  }
  return createCanonicalToolIntentWithCategory({
    toolName: input.toolName,
    args: input.args,
    cwd: input.cwd,
    category: classifyToolUse(input),
  });
}

export function preToolUse(input: PreToolUseInput): PreToolUseResult {
  const { intent } = input;
  requireCanonicalToolIntent(intent);
  const category = intent.category;
  const decision = policyDecisionForInput(input, category);
  if (decision === 'allow') {
    return { kind: 'allow', category, source: 'policy' };
  }
  if (decision === 'block') {
    return {
      kind: 'block',
      category,
      reason: `Tool category "${category}" is blocked in mode "${input.mode}"`,
    };
  }

  const review = projectPublicToolApprovalReview(intent);
  const rememberScope = publicToolReviewRememberAllowed({
    toolName: intent.toolName,
    category,
    review,
  })
    ? input.turnMemory.scopeFor(intent)
    : undefined;
  if (rememberScope !== undefined && input.turnMemory.isRemembered(rememberScope)) {
    return { kind: 'allow', category, source: 'remembered' };
  }

  return {
    kind: 'prompt',
    category,
    ...(rememberScope === undefined ? {} : { rememberScope }),
    prompt: {
      kind: 'tool_permission',
      toolName: intent.toolName,
      category,
      reason: permissionReasonForCategory(category),
      review,
      rememberForTurnAllowed: rememberScope !== undefined,
    },
  };
}

function stringDataProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function policyDecisionForInput(input: PreToolUseInput, category: ToolCategory): PolicyDecision {
  const decision = PERMISSION_POLICY[input.mode][category];
  if (input.mode === 'execute' && category === 'shell_unsafe') {
    return input.sandbox?.platformSandboxAvailable === true ? 'allow' : 'prompt';
  }
  return decision;
}

declare const PERMISSION_REMEMBER_SCOPE: unique symbol;

export interface PermissionRememberScope {
  readonly [PERMISSION_REMEMBER_SCOPE]: true;
}

export class TurnPermissionMemory {
  readonly #scopesByMaterial = new Map<string, PermissionRememberScope>();
  readonly #ownedScopes = new Set<PermissionRememberScope>();
  readonly #rememberedScopes = new Set<PermissionRememberScope>();

  scopeFor(intent: CanonicalToolIntent): PermissionRememberScope | undefined {
    const material = canonicalToolRememberScopeMaterial(intent);
    if (material === undefined) return undefined;
    const key = JSON.stringify(material);
    if (key === undefined) throw new TypeError('Permission scope material is not canonical');
    const existing = this.#scopesByMaterial.get(key);
    if (existing !== undefined) return existing;
    const scope = Object.freeze({}) as PermissionRememberScope;
    this.#scopesByMaterial.set(key, scope);
    this.#ownedScopes.add(scope);
    return scope;
  }

  remember(scope: PermissionRememberScope): void {
    if (!this.#ownedScopes.has(scope)) {
      throw new TypeError('Permission remember scope belongs to another turn');
    }
    this.#rememberedScopes.add(scope);
  }

  isRemembered(scope: PermissionRememberScope): boolean {
    if (!this.#ownedScopes.has(scope)) {
      throw new TypeError('Permission remember scope belongs to another turn');
    }
    return this.#rememberedScopes.has(scope);
  }
}

export function permissionReasonForCategory(category: ToolCategory): PermissionRequest['reason'] {
  switch (category) {
    case 'shell_unsafe':
      return 'shell_dangerous';
    case 'file_write':
      return 'file_write';
    case 'fs_destructive':
      return 'fs_destructive';
    case 'network_send':
      return 'network';
    case 'git_destructive':
      return 'git_destructive';
    case 'privileged':
      return 'privileged';
    case 'browser':
      return 'browser';
    case 'computer_use':
      return 'computer_use';
    default:
      return 'custom';
  }
}

// ============================================================================
// Request / Response shapes
// ============================================================================

export interface ToolPermissionPrompt {
  kind: 'tool_permission';
  toolName: string;
  category: ToolCategory;
  reason:
    | 'shell_dangerous'
    | 'file_write'
    | 'fs_destructive'
    | 'network'
    | 'git_destructive'
    | 'privileged'
    | 'browser'
    | 'computer_use'
    | 'custom';
  review: PublicToolIntentReview;
  rememberForTurnAllowed: boolean;
}

export interface PermissionRequest extends ToolPermissionPrompt {
  requestId: string;
  toolUseId: string;
}

export interface AdditionalPermissionPathReview {
  readonly path: string;
  readonly access: import('./additional-permissions.js').AdditionalPermissionAccess;
  readonly scope: import('./additional-permissions.js').AdditionalPermissionScope;
}

export interface AdditionalPermissionReview {
  readonly kind: 'additional_permissions';
  readonly cwd: string;
  readonly paths: readonly AdditionalPermissionPathReview[];
  readonly networkEnabled: boolean;
}

export function projectAdditionalPermissionReview(input: {
  readonly cwd: string;
  readonly profile: AdditionalPermissionProfile;
}): AdditionalPermissionReview {
  const validated = validateAdditionalPermissionProfile(input.profile);
  if (!validated.ok) throw new InteractionPermissionProjectionError();
  const cwdReview = projectPublicToolPathReview({
    operation: 'read',
    path: input.cwd,
    cwd: input.cwd,
  });
  const paths = (validated.profile.fileSystem?.entries ?? []).map((entry) => {
    const pathReview = projectPublicToolPathReview({
      operation: entry.access,
      path: entry.path,
      cwd: input.cwd,
    });
    return Object.freeze({
      path: pathReview.path,
      access: entry.access,
      scope: entry.scope,
    });
  });
  return Object.freeze({
    kind: 'additional_permissions',
    cwd: cwdReview.cwd,
    paths: Object.freeze(paths),
    networkEnabled: validated.profile.network?.enabled === true,
  });
}

export interface AdditionalPermissionRequest {
  kind: 'additional_permissions';
  requestId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
  reason: 'additional_permissions';
  review: AdditionalPermissionReview;
  risk: import('./additional-permissions.js').AdditionalPermissionRiskSummary;
  alsoApprovesToolExecution: false;
  availableDecisions: readonly ['allow_once', 'deny'];
}

export interface SandboxEscalationRiskSummary {
  readonly unsandboxedExecution: true;
  readonly unrestrictedFileSystem: true;
  readonly unrestrictedNetwork: true;
  readonly protectedMetadataExposed: true;
}

export interface SandboxEscalationRequest {
  kind: 'sandbox_escalation';
  requestId: string;
  toolUseId: string;
  toolName: 'Bash';
  category: ToolCategory;
  reason: 'sandbox_escalation';
  review: PublicToolCommandReview;
  trigger: 'proactive' | 'sandbox_denial';
  risk: SandboxEscalationRiskSummary;
  alsoApprovesToolExecution: boolean;
  availableDecisions: readonly ['allow_once', 'deny'];
}

/** Permission prompt payloads that may be carried by canonical runtime events. */
export type PermissionRequestPayload =
  | PermissionRequest
  | AdditionalPermissionRequest
  | SandboxEscalationRequest;

export interface PermissionResponse {
  requestId: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  reviewer?: ApprovalsReviewer;
  riskLevel?: ApprovalRiskLevel;
}
