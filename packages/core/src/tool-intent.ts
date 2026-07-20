import {
  computerUseExecutionArgs,
  computerUsePublicReviewRememberAllowed,
  computerUseRememberScopeMaterial,
  decodeComputerUseIntent,
  decodeComputerUsePublicApprovalReview,
  projectComputerUsePublicApprovalReview,
  type ComputerUseIntent,
  type ComputerUsePublicApprovalReview,
} from './computer-use.js';
import {
  redactBashCommandSecretsForCriticalReview,
  redactSecretsForCriticalReview,
} from './redaction.js';
import { isSafeTaskId } from './task-ledger.js';
import type { ToolCategory } from './permission.js';

export type CanonicalToolValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalToolValue[]
  | { readonly [key: string]: CanonicalToolValue };

const CANONICAL_TOOL_INTENT: unique symbol = Symbol('CanonicalToolIntent');

interface CanonicalToolIntentBase {
  readonly [CANONICAL_TOOL_INTENT]: true;
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly cwd: string;
}

export type CanonicalToolIntent =
  | (CanonicalToolIntentBase & {
      readonly kind: 'tool';
      readonly args: CanonicalToolValue;
    })
  | (CanonicalToolIntentBase & {
      readonly kind: 'computer_use';
      readonly computerUse: ComputerUseIntent;
    });

/** @internal Callers must use permission.createCanonicalToolIntent(). */
export interface CreateCanonicalToolIntentWithCategoryInput {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly cwd: string;
  readonly args: unknown;
}

export type InteractionPermissionProjectionErrorReason = 'unrepresentable_review';

export class InteractionPermissionProjectionError extends Error {
  readonly reason: InteractionPermissionProjectionErrorReason = 'unrepresentable_review';

  constructor() {
    super('Permission review cannot be safely represented');
    this.name = 'InteractionPermissionProjectionError';
  }
}

export interface PublicToolCommandReview {
  readonly kind: 'command';
  readonly command: string;
  readonly cwd: string;
}

export interface PublicToolPathReview {
  readonly kind: 'path';
  readonly operation: 'read' | 'write' | 'edit' | 'format_json';
  readonly path: string;
  readonly cwd: string;
  readonly sortKeys?: boolean;
}

export type PublicToolSearchReview =
  | {
      readonly kind: 'search';
      readonly operation: 'glob';
      readonly pattern: string;
      readonly root: string;
      readonly cwd: string;
    }
  | {
      readonly kind: 'search';
      readonly operation: 'grep';
      readonly pattern: string;
      readonly root: string;
      readonly glob?: string;
      readonly cwd: string;
    };

export interface PublicToolStdinInputReview {
  readonly text: string;
  readonly bytes: number;
}

export interface PublicToolStdinSize {
  readonly cols: number;
  readonly rows: number;
}

export interface PublicToolStdinReview {
  readonly kind: 'stdin';
  readonly ref: string;
  readonly input?: PublicToolStdinInputReview;
  readonly size?: PublicToolStdinSize;
}

export interface PublicToolWebReview {
  readonly kind: 'web';
  readonly targetKind: 'url' | 'query';
  readonly target: string;
}

interface PublicToolBrowserReviewBase {
  readonly kind: 'browser';
}

export type PublicToolBrowserReview =
  | (PublicToolBrowserReviewBase & {
      readonly action: 'navigate';
      readonly url: string;
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'snapshot';
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'click';
      readonly ref: string;
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'type';
      readonly ref: string;
      readonly text: string;
      readonly submit: boolean;
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'wait';
      readonly condition: 'text' | 'selector';
      readonly value: string;
      readonly timeoutSeconds: number;
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'wait';
      readonly condition: 'duration';
      readonly seconds: number;
    })
  | (PublicToolBrowserReviewBase & {
      readonly action: 'extract';
      readonly selector?: string;
      readonly start: number;
    });

export interface PublicToolPatchReview {
  readonly kind: 'patch';
  readonly operation: 'create_file' | 'update_file' | 'delete_file';
  readonly path: string;
  readonly cwd: string;
}

export type PublicToolAgentReview =
  | {
      readonly kind: 'agent';
      readonly operation: 'spawn';
      readonly profile: string;
      readonly writeBack: 'summary' | 'patch';
      readonly isolation: 'same_workspace' | 'worktree';
      readonly taskId?: string;
    }
  | {
      readonly kind: 'agent';
      readonly operation: 'dispatch';
      readonly member: string;
    }
  | {
      readonly kind: 'agent';
      readonly operation: 'swarm';
      readonly itemCount: number;
      readonly resumeCount: number;
      readonly concurrency: number;
      readonly profiles: readonly string[];
      readonly writeBack: readonly ('summary' | 'patch')[];
      readonly isolation: readonly ('same_workspace' | 'worktree')[];
    };

export interface PublicToolRuntimeResourceReview {
  readonly kind: 'runtime_resource';
  readonly operation: 'read' | 'stop';
  readonly ref: string;
}

export interface PublicToolSkillReview {
  readonly kind: 'skill';
  readonly name: string;
}

export interface PublicToolQuestionReview {
  readonly kind: 'question';
  readonly questionCount: number;
}

export type PublicToolIntentReview =
  | PublicToolCommandReview
  | PublicToolPathReview
  | PublicToolSearchReview
  | PublicToolStdinReview
  | PublicToolWebReview
  | PublicToolBrowserReview
  | PublicToolPatchReview
  | PublicToolAgentReview
  | PublicToolRuntimeResourceReview
  | PublicToolSkillReview
  | PublicToolQuestionReview
  | ComputerUsePublicApprovalReview;

const authenticatedIntents = new WeakSet<object>();
const UTF8_ENCODER = new TextEncoder();
const TOOL_NAME_MAX_BYTES = 256;
const CWD_MAX_BYTES = 4 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
const COMMAND_MAX_BYTES = 8 * 1024;
const WEB_TARGET_MAX_BYTES = 4 * 1024;
const TEXT_MAX_BYTES = 8 * 1024;
const REF_MAX_BYTES = 8 * 1024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 100_000;
const MAX_BROWSER_WAIT_SECONDS = 120;
const MAX_STDIN_DIMENSION = 1_000_000;
const OFFICE_DOCUMENT_PATH_MAX_CHARS = 500;
const OFFICE_DOCUMENT_ELEMENT_TYPE_MAX_CHARS = 80;
const OFFICE_DOCUMENT_PROP_KEY_MAX_CHARS = 80;
const OFFICE_DOCUMENT_PROP_STRING_MAX_CHARS = 500;
const OFFICE_DOCUMENT_INDEX_MAX = 9_999;
const EXPLORE_AGENT_OBJECTIVE_MAX_CHARS = 600;
const EXPLORE_AGENT_ROOTS_MAX = 5;
const EXPLORE_AGENT_QUERIES_MAX = 8;
const EXPLORE_AGENT_IGNORE_PATHS_MAX = 20;
const EXPLORE_AGENT_PATH_MAX_CHARS = 240;
const EXPLORE_AGENT_QUERY_MAX_CHARS = 120;
const EXPLORE_AGENT_MAX_FILES = 80;
const EXPLORE_AGENT_MAX_MATCHES = 120;
const AGENT_SWARM_MAX_ITEMS = 32;
const AGENT_SWARM_MAX_CONCURRENCY = 5;
const AGENT_SWARM_TASK_MAX_CHARS = 60_000;
const UNSAFE_REVIEW_FORMAT_CHARACTER =
  /[\p{Bidi_Control}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/u;

interface KnownToolDescriptor {
  readonly category: ToolCategory;
  readonly usesBashCategorizer: boolean;
  readonly project: (intent: CanonicalToolIntent) => PublicToolIntentReview;
  readonly matchesReview: (review: PublicToolIntentReview) => boolean;
  readonly rememberAllowed: (review: PublicToolIntentReview) => boolean;
  readonly rememberScope: (intent: CanonicalToolIntent) => readonly unknown[] | undefined;
}

function defineKnownTool(
  descriptor: Omit<
    KnownToolDescriptor,
    'usesBashCategorizer' | 'rememberAllowed' | 'rememberScope'
  > & {
    readonly usesBashCategorizer?: boolean;
    readonly rememberAllowed?: KnownToolDescriptor['rememberAllowed'];
    readonly rememberScope?: KnownToolDescriptor['rememberScope'];
  },
): KnownToolDescriptor {
  const rememberScope = descriptor.rememberScope ?? (() => undefined);
  return Object.freeze({
    ...descriptor,
    usesBashCategorizer: descriptor.usesBashCategorizer ?? false,
    rememberAllowed: descriptor.rememberAllowed ?? (() => descriptor.rememberScope !== undefined),
    rememberScope,
  });
}

const KNOWN_TOOL_DESCRIPTORS = Object.freeze({
  Bash: defineKnownTool({
    category: 'shell_unsafe',
    usesBashCategorizer: true,
    project: (intent) => projectCommandReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'command',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'command')),
  }),
  Read: defineKnownTool({
    category: 'read',
    project: (intent) => projectReadReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) =>
      (review.kind === 'path' && review.operation === 'read') ||
      (review.kind === 'runtime_resource' && review.operation === 'read'),
    rememberAllowed: (review) => review.kind === 'path' && review.operation === 'read',
    rememberScope: (intent) => {
      const args = toolIntentArgs(intent);
      return Object.hasOwn(args, 'ref')
        ? undefined
        : privateToolScope(intent, propertyString(args, 'path'));
    },
  }),
  Write: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectPathReview(toolIntentArgs(intent), intent.cwd, 'write'),
    matchesReview: (review) => review.kind === 'path' && review.operation === 'write',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'path')),
  }),
  Edit: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectPathReview(toolIntentArgs(intent), intent.cwd, 'edit'),
    matchesReview: (review) => review.kind === 'path' && review.operation === 'edit',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'path')),
  }),
  FormatJson: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectFormatJsonReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'path' && review.operation === 'format_json',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'path')),
  }),
  OfficeDocumentEdit: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectOfficeDocumentEditReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) =>
      review.kind === 'path' && (review.operation === 'write' || review.operation === 'edit'),
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'path')),
  }),
  Glob: defineKnownTool({
    category: 'read',
    project: (intent) => projectGlobReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'search' && review.operation === 'glob',
    rememberScope: (intent) => {
      const args = toolIntentArgs(intent);
      return privateToolScope(
        intent,
        optionalString(args.cwd) ?? '.',
        propertyString(args, 'pattern'),
      );
    },
  }),
  Grep: defineKnownTool({
    category: 'read',
    project: (intent) => projectGrepReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'search' && review.operation === 'grep',
    rememberScope: grepRememberScope,
  }),
  search_files: defineKnownTool({
    category: 'read',
    project: (intent) => projectGrepReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'search' && review.operation === 'grep',
    rememberScope: grepRememberScope,
  }),
  WriteStdin: defineKnownTool({
    category: 'shell_unsafe',
    project: (intent) => projectStdinReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'stdin',
  }),
  WebFetch: defineKnownTool({
    category: 'web_read',
    project: (intent) => projectWebReview(toolIntentArgs(intent), 'url'),
    matchesReview: (review) => review.kind === 'web' && review.targetKind === 'url',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'url')),
  }),
  WebSearch: defineKnownTool({
    category: 'web_read',
    project: (intent) => projectWebReview(toolIntentArgs(intent), 'query'),
    matchesReview: (review) => review.kind === 'web' && review.targetKind === 'query',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'query')),
  }),
  patch: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectPatchReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'patch',
    rememberScope: patchRememberScope,
  }),
  apply_patch: defineKnownTool({
    category: 'file_write',
    project: (intent) => projectPatchReview(toolIntentArgs(intent), intent.cwd),
    matchesReview: (review) => review.kind === 'patch',
    rememberScope: patchRememberScope,
  }),
  browser_navigate: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('navigate', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'navigate',
    rememberScope: browserRememberScope,
  }),
  browser_snapshot: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('snapshot', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'snapshot',
    rememberScope: browserRememberScope,
  }),
  browser_click: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('click', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'click',
    rememberScope: browserRememberScope,
  }),
  browser_type: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('type', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'type',
    rememberScope: browserRememberScope,
  }),
  browser_wait: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('wait', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'wait',
    rememberScope: browserRememberScope,
  }),
  browser_extract: defineKnownTool({
    category: 'browser',
    project: (intent) => projectBrowserReview('extract', toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'browser' && review.action === 'extract',
    rememberScope: browserRememberScope,
  }),
  agent_spawn: defineKnownTool({
    category: 'subagent',
    project: (intent) => projectAgentSpawnReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'agent' && review.operation === 'spawn',
    rememberScope: (intent) => {
      const args = toolIntentArgs(intent);
      return privateToolScope(
        intent,
        propertyString(args, 'profile'),
        propertyString(args, 'write_back'),
        propertyString(args, 'isolation'),
        optionalString(args.task_id) ?? null,
      );
    },
  }),
  agent_swarm: defineKnownTool({
    category: 'subagent',
    project: (intent) => projectAgentSwarmReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'agent' && review.operation === 'swarm',
    rememberAllowed: () => false,
  }),
  ExploreAgent: defineKnownTool({
    category: 'subagent',
    project: (intent) => projectExploreAgentReview(toolIntentArgs(intent)),
    matchesReview: (review) =>
      review.kind === 'agent' &&
      review.operation === 'spawn' &&
      review.profile === 'local_read' &&
      review.writeBack === 'summary' &&
      review.isolation === 'same_workspace' &&
      review.taskId === undefined,
    rememberAllowed: () => false,
  }),
  expert_dispatch: defineKnownTool({
    category: 'subagent',
    project: (intent) => projectExpertDispatchReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'agent' && review.operation === 'dispatch',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'member')),
  }),
  StopBackgroundTask: defineKnownTool({
    category: 'custom_tool',
    project: (intent) => projectRuntimeResourceReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'runtime_resource' && review.operation === 'stop',
  }),
  Skill: defineKnownTool({
    category: 'read',
    project: (intent) => projectSkillReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'skill',
    rememberScope: (intent) =>
      privateToolScope(intent, propertyString(toolIntentArgs(intent), 'name')),
  }),
  AskUserQuestion: defineKnownTool({
    category: 'custom_tool',
    project: (intent) => projectQuestionReview(toolIntentArgs(intent)),
    matchesReview: (review) => review.kind === 'question',
  }),
  maka_computer: defineKnownTool({
    category: 'computer_use',
    project: (intent) => {
      if (intent.kind !== 'computer_use') throw new InteractionPermissionProjectionError();
      return projectComputerUsePublicApprovalReview(intent.computerUse);
    },
    matchesReview: (review) => review.kind === 'computer_use',
    rememberAllowed: (review) =>
      review.kind === 'computer_use' && computerUsePublicReviewRememberAllowed(review),
    rememberScope: (intent) => {
      if (intent.kind !== 'computer_use') throw new InteractionPermissionProjectionError();
      const material = computerUseRememberScopeMaterial(intent.computerUse);
      return material === undefined ? undefined : ['computer_use', ...material];
    },
  }),
});

type KnownToolName = keyof typeof KNOWN_TOOL_DESCRIPTORS;

/** @internal Permission classification consumes this registry-derived category. */
export function knownToolBaseCategory(toolName: string): ToolCategory | undefined {
  return knownToolDescriptor(toolName)?.category;
}

/** @internal Bash is the only known tool whose final category depends on private args. */
export function knownToolUsesBashCategorizer(toolName: string): boolean {
  return knownToolDescriptor(toolName)?.usesBashCategorizer === true;
}

/** @internal Registry-derived public category view. */
export function knownToolCategoryEntries(): readonly (readonly [string, ToolCategory])[] {
  return Object.freeze(
    Object.entries(KNOWN_TOOL_DESCRIPTORS).map(([toolName, descriptor]) =>
      Object.freeze([toolName, descriptor.category] as const),
    ),
  );
}

/** @internal Category classification belongs to permission.createCanonicalToolIntent(). */
export function createCanonicalToolIntentWithCategory(
  input: CreateCanonicalToolIntentWithCategoryInput,
): CanonicalToolIntent {
  const toolName = requirePrivateString(input.toolName, 'tool name', TOOL_NAME_MAX_BYTES);
  const cwd = requirePrivateString(input.cwd, 'tool cwd', CWD_MAX_BYTES);
  if (input.category === 'computer_use' && toolName !== 'maka_computer') {
    throw new TypeError('Computer Use intent requires the canonical maka_computer producer');
  }
  const intent =
    input.category === 'computer_use'
      ? {
          kind: 'computer_use' as const,
          toolName,
          category: input.category,
          cwd,
          computerUse: decodeComputerUseIntent(input.args),
        }
      : {
          kind: 'tool' as const,
          toolName,
          category: input.category,
          cwd,
          args: cloneCanonicalValue(input.args),
        };
  Object.defineProperty(intent, CANONICAL_TOOL_INTENT, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  deepFreeze(intent);
  authenticatedIntents.add(intent);
  return intent as CanonicalToolIntent;
}

export function canonicalToolExecutionArgs(intent: CanonicalToolIntent): unknown {
  requireCanonicalToolIntent(intent);
  return intent.kind === 'computer_use'
    ? computerUseExecutionArgs(intent.computerUse)
    : intent.args;
}

export function requireCanonicalToolIntent(value: unknown): asserts value is CanonicalToolIntent {
  if (typeof value !== 'object' || value === null || !authenticatedIntents.has(value)) {
    throw new TypeError('Tool intent is not an authenticated canonical intent');
  }
}

export function projectPublicToolIntentReview(
  intent: CanonicalToolIntent,
): PublicToolIntentReview | undefined {
  requireCanonicalToolIntent(intent);
  return knownToolDescriptor(intent.toolName)?.project(intent);
}

export function projectPublicToolApprovalReview(
  intent: CanonicalToolIntent,
): PublicToolIntentReview {
  requireCanonicalToolIntent(intent);
  try {
    const review = projectPublicToolIntentReview(intent);
    if (review === undefined) throw new InteractionPermissionProjectionError();
    return review;
  } catch {
    throw new InteractionPermissionProjectionError();
  }
}

/** @internal Closed path projector shared with additional-permission review. */
export function projectPublicToolPathReview(input: {
  readonly operation: PublicToolPathReview['operation'];
  readonly path: string;
  readonly cwd: string;
  readonly sortKeys?: boolean;
}): PublicToolPathReview {
  if (input.operation === 'format_json' && typeof input.sortKeys !== 'boolean') {
    throw new InteractionPermissionProjectionError();
  }
  if (input.operation !== 'format_json' && input.sortKeys !== undefined) {
    throw new InteractionPermissionProjectionError();
  }
  return freezeReview({
    kind: 'path',
    operation: input.operation,
    path: projectReviewText(input.path, 'path', PATH_MAX_BYTES),
    cwd: projectReviewText(input.cwd, 'cwd', CWD_MAX_BYTES),
    ...(input.operation === 'format_json' ? { sortKeys: input.sortKeys! } : {}),
  });
}

export function decodePublicToolIntentReview(value: unknown): PublicToolIntentReview {
  const record = requirePlainRecord(value, 'public tool review');
  switch (record.kind) {
    case 'command':
      requireFields(record, ['kind', 'command', 'cwd']);
      return freezeReview({
        kind: 'command',
        command: requireCanonicalBashReviewText(record.command, 'command', COMMAND_MAX_BYTES),
        cwd: requireCanonicalReviewText(record.cwd, 'cwd', CWD_MAX_BYTES),
      });
    case 'path':
      return decodePathReview(record);
    case 'search':
      return decodeSearchReview(record);
    case 'stdin':
      return decodeStdinReview(record);
    case 'web':
      return decodeWebReview(record);
    case 'browser':
      return decodeBrowserReview(record);
    case 'patch':
      return decodePatchReview(record);
    case 'agent':
      return decodeAgentReview(record);
    case 'runtime_resource':
      requireFields(record, ['kind', 'operation', 'ref']);
      if (record.operation !== 'read' && record.operation !== 'stop') invalidReview();
      return freezeReview({
        kind: 'runtime_resource',
        operation: record.operation,
        ref: requireCanonicalReviewText(record.ref, 'runtime resource ref', REF_MAX_BYTES),
      });
    case 'skill':
      requireFields(record, ['kind', 'name']);
      return freezeReview({
        kind: 'skill',
        name: requireCanonicalReviewText(record.name, 'skill name', REF_MAX_BYTES),
      });
    case 'question':
      requireFields(record, ['kind', 'questionCount']);
      return freezeReview({
        kind: 'question',
        questionCount: requireInteger(record.questionCount, 'question count', 1, 3),
      });
    case 'computer_use':
      return decodeComputerUsePublicApprovalReview(record);
    default:
      return invalidReview();
  }
}

export function isPublicToolIntentReview(value: unknown): value is PublicToolIntentReview {
  try {
    decodePublicToolIntentReview(value);
    return true;
  } catch {
    return false;
  }
}

export function publicToolReviewMatchesIdentity(input: {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly review: PublicToolIntentReview;
}): boolean {
  const { toolName, category, review } = input;
  const descriptor = knownToolDescriptor(toolName);
  return (
    descriptor !== undefined &&
    descriptorMatchesCategory(descriptor, category) &&
    descriptor.matchesReview(review)
  );
}

export function publicToolReviewRememberAllowed(input: {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly review: PublicToolIntentReview;
}): boolean {
  const { toolName, category, review } = input;
  const descriptor = knownToolDescriptor(toolName);
  return (
    descriptor !== undefined &&
    descriptorMatchesCategory(descriptor, category) &&
    descriptor.matchesReview(review) &&
    descriptor.rememberAllowed(review)
  );
}

export function publicToolCommandSemanticText(review: PublicToolCommandReview): string {
  return decodeCanonicalReviewString(review.command);
}

/** @internal Scope material never crosses a durable or wire boundary. */
export function canonicalToolRememberScopeMaterial(
  intent: CanonicalToolIntent,
): readonly unknown[] | undefined {
  requireCanonicalToolIntent(intent);
  return knownToolDescriptor(intent.toolName)?.rememberScope(intent);
}

function knownToolDescriptor(toolName: string): KnownToolDescriptor | undefined {
  return Object.hasOwn(KNOWN_TOOL_DESCRIPTORS, toolName)
    ? KNOWN_TOOL_DESCRIPTORS[toolName as KnownToolName]
    : undefined;
}

function descriptorMatchesCategory(
  descriptor: KnownToolDescriptor,
  category: ToolCategory,
): boolean {
  if (!descriptor.usesBashCategorizer) return descriptor.category === category;
  return (
    category === 'shell_unsafe' ||
    category === 'fs_destructive' ||
    category === 'git_destructive' ||
    category === 'privileged'
  );
}

function toolIntentArgs(intent: CanonicalToolIntent): Record<string, CanonicalToolValue> {
  if (intent.kind !== 'tool') throw new InteractionPermissionProjectionError();
  return requireProjectionRecord(intent.args);
}

function privateToolScope(
  intent: CanonicalToolIntent,
  ...material: readonly unknown[]
): readonly unknown[] {
  return [intent.category, intent.toolName, intent.cwd, ...material];
}

function grepRememberScope(intent: CanonicalToolIntent): readonly unknown[] {
  const args = toolIntentArgs(intent);
  return privateToolScope(
    intent,
    optionalString(args.path) ?? '.',
    optionalString(args.glob) ?? null,
    propertyString(args, 'pattern'),
  );
}

function patchRememberScope(intent: CanonicalToolIntent): readonly unknown[] {
  const operation = requireProjectionRecord(toolIntentArgs(intent).operation);
  return privateToolScope(
    intent,
    propertyString(operation, 'type'),
    propertyString(operation, 'path'),
  );
}

function browserRememberScope(): readonly unknown[] {
  return ['browser'];
}

function projectCommandReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolCommandReview {
  requireFields(
    args,
    ['command'],
    ['timeout_ms', 'run_in_background', 'pty', 'sandbox_permissions', 'shell'],
  );
  if (args.timeout_ms !== undefined) requireNumber(args.timeout_ms, 'timeout_ms', 86_400_000);
  if (args.run_in_background !== undefined)
    requireBoolean(args.run_in_background, 'run_in_background');
  if (args.pty !== undefined) requireBoolean(args.pty, 'pty');
  if (args.shell !== undefined) propertyString(args, 'shell');
  if (args.sandbox_permissions !== undefined)
    validateBashSandboxPermissions(args.sandbox_permissions);
  return freezeReview({
    kind: 'command',
    command: projectReviewText(propertyString(args, 'command'), 'command', COMMAND_MAX_BYTES, true),
    cwd: projectReviewText(cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function validateBashSandboxPermissions(value: CanonicalToolValue): void {
  const declaration = requireProjectionRecord(value);
  const mode = propertyString(declaration, 'mode');
  if (mode === 'use_default') {
    requireFields(declaration, ['mode']);
    return;
  }
  if (mode === 'require_escalated') {
    requireFields(declaration, ['mode', 'justification']);
    propertyString(declaration, 'justification');
    return;
  }
  if (mode !== 'with_additional_permissions') {
    throw new InteractionPermissionProjectionError();
  }
  requireFields(declaration, ['mode', 'justification'], ['file_system', 'network']);
  propertyString(declaration, 'justification');
  if (declaration.network !== undefined && declaration.network !== true) {
    throw new InteractionPermissionProjectionError();
  }
  if (declaration.file_system === undefined) return;
  const fileSystem = requireProjectionRecord(declaration.file_system);
  requireFields(fileSystem, ['entries']);
  if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > 32) {
    throw new InteractionPermissionProjectionError();
  }
  for (const entryValue of fileSystem.entries) {
    const entry = requireProjectionRecord(entryValue);
    requireFields(entry, ['path', 'access', 'scope']);
    propertyString(entry, 'path');
    const access = propertyString(entry, 'access');
    const scope = propertyString(entry, 'scope');
    if ((access !== 'read' && access !== 'write') || (scope !== 'exact' && scope !== 'subtree'))
      throw new InteractionPermissionProjectionError();
  }
}

function projectReadReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolPathReview | PublicToolRuntimeResourceReview {
  if (Object.hasOwn(args, 'ref')) {
    requireFields(args, ['ref']);
    return freezeReview({
      kind: 'runtime_resource',
      operation: 'read',
      ref: projectReviewText(propertyString(args, 'ref'), 'runtime resource ref', REF_MAX_BYTES),
    });
  }
  return projectPathReview(args, cwd, 'read');
}

function projectPathReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
  operation: 'read' | 'write' | 'edit',
): PublicToolPathReview {
  const fields =
    operation === 'read'
      ? { required: ['path'], optional: ['offset', 'limit'] }
      : operation === 'write'
        ? { required: ['path', 'content'], optional: [] }
        : { required: ['path', 'old_string', 'new_string'], optional: [] };
  requireFields(args, fields.required, fields.optional);
  if (operation === 'read') {
    if (args.offset !== undefined) requireInteger(args.offset, 'read offset', 0);
    if (args.limit !== undefined) requireInteger(args.limit, 'read limit', 1);
  } else if (operation === 'write') {
    propertyString(args, 'content', true);
  } else {
    propertyString(args, 'old_string', true);
    propertyString(args, 'new_string', true);
  }
  return projectPublicToolPathReview({
    operation,
    path: propertyString(args, 'path'),
    cwd,
  });
}

function projectFormatJsonReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolPathReview {
  requireFields(args, ['path'], ['sort_keys']);
  const sortKeys =
    args.sort_keys === undefined ? false : requireBoolean(args.sort_keys, 'sort_keys');
  return projectPublicToolPathReview({
    operation: 'format_json',
    path: propertyString(args, 'path'),
    cwd,
    sortKeys,
  });
}

function projectOfficeDocumentEditReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolPathReview {
  requireFields(args, ['path', 'operation'], ['target', 'elementType', 'props', 'index']);
  const path = propertyBoundedString(args, 'path', 1, OFFICE_DOCUMENT_PATH_MAX_CHARS);
  const operation = propertyString(args, 'operation');
  if (
    operation !== 'create' &&
    operation !== 'add' &&
    operation !== 'set' &&
    operation !== 'remove'
  )
    throw new InteractionPermissionProjectionError();
  if (args.target !== undefined) {
    propertyBoundedString(args, 'target', 1, OFFICE_DOCUMENT_PATH_MAX_CHARS);
  }
  if (args.elementType !== undefined) {
    propertyBoundedString(args, 'elementType', 1, OFFICE_DOCUMENT_ELEMENT_TYPE_MAX_CHARS);
  }
  if (args.props !== undefined) validateOfficeDocumentProps(args.props);
  if (args.index !== undefined) {
    requireInteger(args.index, 'Office document index', 0, OFFICE_DOCUMENT_INDEX_MAX);
  }
  return projectPublicToolPathReview({
    operation: operation === 'create' ? 'write' : 'edit',
    path,
    cwd,
  });
}

function validateOfficeDocumentProps(value: CanonicalToolValue): void {
  const props = requireProjectionRecord(value);
  for (const [key, prop] of Object.entries(props)) {
    requireBoundedString(key, 1, OFFICE_DOCUMENT_PROP_KEY_MAX_CHARS);
    if (typeof prop === 'string') {
      requireBoundedString(prop, 0, OFFICE_DOCUMENT_PROP_STRING_MAX_CHARS);
    } else if (typeof prop !== 'number' && typeof prop !== 'boolean') {
      throw new InteractionPermissionProjectionError();
    }
  }
}

function projectGlobReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolSearchReview {
  requireFields(args, ['pattern'], ['cwd']);
  return freezeReview({
    kind: 'search',
    operation: 'glob',
    pattern: projectReviewText(propertyString(args, 'pattern'), 'glob pattern', TEXT_MAX_BYTES),
    root: projectReviewText(optionalString(args.cwd) ?? '.', 'glob root', PATH_MAX_BYTES),
    cwd: projectReviewText(cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function projectGrepReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolSearchReview {
  requireFields(args, ['pattern'], ['path', 'glob']);
  return freezeReview({
    kind: 'search',
    operation: 'grep',
    pattern: projectReviewText(propertyString(args, 'pattern'), 'grep pattern', TEXT_MAX_BYTES),
    root: projectReviewText(optionalString(args.path) ?? '.', 'grep root', PATH_MAX_BYTES),
    ...(args.glob === undefined
      ? {}
      : { glob: projectReviewText(propertyString(args, 'glob'), 'grep glob', TEXT_MAX_BYTES) }),
    cwd: projectReviewText(cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function projectStdinReview(args: Record<string, CanonicalToolValue>): PublicToolStdinReview {
  requireFields(args, ['ref'], ['input', 'size']);
  if (args.input === undefined && args.size === undefined)
    throw new InteractionPermissionProjectionError();
  return freezeReview({
    kind: 'stdin',
    ref: projectReviewText(propertyString(args, 'ref'), 'stdin ref', REF_MAX_BYTES),
    ...(args.input === undefined
      ? {}
      : {
          input: {
            text: projectReviewText(
              propertyString(args, 'input', true),
              'stdin input',
              TEXT_MAX_BYTES,
              false,
              true,
            ),
            bytes: UTF8_ENCODER.encode(propertyString(args, 'input', true)).byteLength,
          },
        }),
    ...(args.size === undefined ? {} : { size: projectStdinSize(args.size) }),
  });
}

function projectStdinSize(value: CanonicalToolValue): PublicToolStdinSize {
  const size = requireProjectionRecord(value);
  requireFields(size, ['cols', 'rows']);
  return {
    cols: requireInteger(size.cols, 'stdin cols', 1, MAX_STDIN_DIMENSION),
    rows: requireInteger(size.rows, 'stdin rows', 1, MAX_STDIN_DIMENSION),
  };
}

function projectWebReview(
  args: Record<string, CanonicalToolValue>,
  targetKind: 'url' | 'query',
): PublicToolWebReview {
  requireFields(args, [targetKind]);
  return freezeReview({
    kind: 'web',
    targetKind,
    target: projectReviewText(propertyString(args, targetKind), targetKind, WEB_TARGET_MAX_BYTES),
  });
}

function projectPatchReview(
  args: Record<string, CanonicalToolValue>,
  cwd: string,
): PublicToolPatchReview {
  requireFields(args, ['operation'], ['callId']);
  if (args.callId !== undefined) propertyString(args, 'callId');
  const operation = requireProjectionRecord(args.operation);
  if (
    operation.type !== 'create_file' &&
    operation.type !== 'update_file' &&
    operation.type !== 'delete_file'
  )
    throw new InteractionPermissionProjectionError();
  requireFields(
    operation,
    operation.type === 'delete_file' ? ['type', 'path'] : ['type', 'path', 'diff'],
  );
  if (operation.type !== 'delete_file') propertyString(operation, 'diff', true);
  return freezeReview({
    kind: 'patch',
    operation: operation.type,
    path: projectReviewText(propertyString(operation, 'path'), 'patch path', PATH_MAX_BYTES),
    cwd: projectReviewText(cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function projectBrowserReview(
  action: PublicToolBrowserReview['action'],
  args: Record<string, CanonicalToolValue>,
): PublicToolBrowserReview {
  if (action === 'navigate') {
    requireFields(args, ['url']);
    return freezeReview({
      kind: 'browser',
      action: 'navigate',
      url: projectReviewText(propertyString(args, 'url'), 'browser URL', WEB_TARGET_MAX_BYTES),
    });
  }
  if (action === 'snapshot') {
    requireFields(args, []);
    return freezeReview({ kind: 'browser', action: 'snapshot' });
  }
  if (action === 'click') {
    requireFields(args, ['ref']);
    return freezeReview({
      kind: 'browser',
      action: 'click',
      ref: projectReviewText(propertyString(args, 'ref'), 'browser ref', REF_MAX_BYTES),
    });
  }
  if (action === 'type') {
    requireFields(args, ['ref', 'text'], ['submit']);
    return freezeReview({
      kind: 'browser',
      action: 'type',
      ref: projectReviewText(propertyString(args, 'ref'), 'browser ref', REF_MAX_BYTES),
      text: projectReviewText(
        propertyString(args, 'text', true),
        'browser text',
        TEXT_MAX_BYTES,
        false,
        true,
      ),
      submit: args.submit === undefined ? false : requireBoolean(args.submit, 'browser submit'),
    });
  }
  if (action === 'wait') return projectBrowserWaitReview(args);
  if (action === 'extract') {
    requireFields(args, [], ['selector', 'start']);
    return freezeReview({
      kind: 'browser',
      action: 'extract',
      ...(args.selector === undefined
        ? {}
        : {
            selector: projectReviewText(
              propertyString(args, 'selector', true),
              'browser selector',
              REF_MAX_BYTES,
              false,
              true,
            ),
          }),
      start: args.start === undefined ? 0 : requireInteger(args.start, 'browser start', 0),
    });
  }
  throw new InteractionPermissionProjectionError();
}

function projectBrowserWaitReview(
  args: Record<string, CanonicalToolValue>,
): PublicToolBrowserReview {
  requireFields(args, [], ['text', 'selector', 'time', 'timeout']);
  const conditions = [args.text, args.selector, args.time].filter((value) => value !== undefined);
  if (conditions.length !== 1) throw new InteractionPermissionProjectionError();
  if (args.time !== undefined) {
    return freezeReview({
      kind: 'browser',
      action: 'wait',
      condition: 'duration',
      seconds: requireNumber(args.time, 'browser wait', MAX_BROWSER_WAIT_SECONDS),
    });
  }
  const condition = args.text !== undefined ? 'text' : 'selector';
  const value = propertyString(args, condition);
  return freezeReview({
    kind: 'browser',
    action: 'wait',
    condition,
    value: projectReviewText(value, `browser ${condition}`, TEXT_MAX_BYTES),
    timeoutSeconds:
      args.timeout === undefined
        ? condition === 'selector'
          ? 10
          : 30
        : requireNumber(args.timeout, 'browser timeout', MAX_BROWSER_WAIT_SECONDS),
  });
}

function projectAgentSpawnReview(args: Record<string, CanonicalToolValue>): PublicToolAgentReview {
  requireFields(args, ['profile', 'task', 'write_back', 'isolation'], ['task_id']);
  const writeBack = propertyString(args, 'write_back');
  const isolation = propertyString(args, 'isolation');
  if (writeBack !== 'summary' && writeBack !== 'patch')
    throw new InteractionPermissionProjectionError();
  if (isolation !== 'same_workspace' && isolation !== 'worktree') {
    throw new InteractionPermissionProjectionError();
  }
  propertyString(args, 'task');
  return freezeReview({
    kind: 'agent',
    operation: 'spawn',
    profile: projectReviewText(propertyString(args, 'profile'), 'agent profile', REF_MAX_BYTES),
    writeBack,
    isolation,
    ...(args.task_id === undefined
      ? {}
      : { taskId: projectReviewText(propertyString(args, 'task_id'), 'task id', REF_MAX_BYTES) }),
  });
}

function projectAgentSwarmReview(args: Record<string, CanonicalToolValue>): PublicToolAgentReview {
  requireFields(args, ['items', 'max_concurrency'], ['resume_run_ids']);
  if (
    !Array.isArray(args.items) ||
    args.items.length > AGENT_SWARM_MAX_ITEMS
  ) {
    throw new InteractionPermissionProjectionError();
  }

  const resumeRunIds =
    args.resume_run_ids === undefined ? {} : requireProjectionRecord(args.resume_run_ids);
  const resumeEntries = Object.entries(resumeRunIds);
  if (
    args.items.length + resumeEntries.length < 1 ||
    args.items.length + resumeEntries.length > AGENT_SWARM_MAX_ITEMS
  ) {
    throw new InteractionPermissionProjectionError();
  }
  for (const [sourceRunId, prompt] of resumeEntries) {
    if (sourceRunId.trim() !== sourceRunId) throw new InteractionPermissionProjectionError();
    projectReviewText(sourceRunId, 'agent swarm source run', REF_MAX_BYTES);
    if (typeof prompt !== 'string' || prompt.trim() !== prompt) {
      throw new InteractionPermissionProjectionError();
    }
    requireBoundedString(prompt, 1, AGENT_SWARM_TASK_MAX_CHARS);
  }

  const itemIds = new Set<string>();
  const profiles = new Set<string>();
  const writeBack = new Set<'summary' | 'patch'>();
  const isolation = new Set<'same_workspace' | 'worktree'>();
  for (const itemValue of args.items) {
    const item = requireProjectionRecord(itemValue);
    requireFields(item, ['item_id', 'profile', 'task', 'write_back', 'isolation']);
    const itemId = propertyString(item, 'item_id');
    if (!isSafeTaskId(itemId) || itemIds.has(itemId)) {
      throw new InteractionPermissionProjectionError();
    }
    itemIds.add(itemId);
    propertyBoundedString(item, 'task', 1, AGENT_SWARM_TASK_MAX_CHARS);
    profiles.add(
      projectReviewText(propertyString(item, 'profile'), 'agent profile', REF_MAX_BYTES),
    );

    const itemWriteBack = propertyString(item, 'write_back');
    if (itemWriteBack !== 'summary' && itemWriteBack !== 'patch') {
      throw new InteractionPermissionProjectionError();
    }
    writeBack.add(itemWriteBack);

    const itemIsolation = propertyString(item, 'isolation');
    if (itemIsolation !== 'same_workspace' && itemIsolation !== 'worktree') {
      throw new InteractionPermissionProjectionError();
    }
    isolation.add(itemIsolation);
  }

  return freezeReview({
    kind: 'agent',
    operation: 'swarm',
    itemCount: args.items.length + resumeEntries.length,
    resumeCount: resumeEntries.length,
    concurrency: requireInteger(
      args.max_concurrency,
      'agent swarm concurrency',
      1,
      AGENT_SWARM_MAX_CONCURRENCY,
    ),
    profiles: [...profiles],
    writeBack: [...writeBack],
    isolation: [...isolation],
  });
}

function projectExploreAgentReview(
  args: Record<string, CanonicalToolValue>,
): PublicToolAgentReview {
  requireFields(
    args,
    ['objective'],
    ['roots', 'queries', 'ignorePaths', 'stoppingCondition', 'maxFiles', 'maxMatches'],
  );
  propertyBoundedString(args, 'objective', 4, EXPLORE_AGENT_OBJECTIVE_MAX_CHARS);
  if (args.roots !== undefined) {
    validateBoundedStringArray(args.roots, EXPLORE_AGENT_ROOTS_MAX, EXPLORE_AGENT_PATH_MAX_CHARS);
  }
  if (args.queries !== undefined) {
    validateBoundedStringArray(
      args.queries,
      EXPLORE_AGENT_QUERIES_MAX,
      EXPLORE_AGENT_QUERY_MAX_CHARS,
    );
  }
  if (args.ignorePaths !== undefined) {
    validateBoundedStringArray(
      args.ignorePaths,
      EXPLORE_AGENT_IGNORE_PATHS_MAX,
      EXPLORE_AGENT_PATH_MAX_CHARS,
    );
  }
  if (args.stoppingCondition !== undefined) {
    propertyBoundedString(args, 'stoppingCondition', 1, EXPLORE_AGENT_PATH_MAX_CHARS);
  }
  if (args.maxFiles !== undefined) {
    requireInteger(args.maxFiles, 'Explore agent maxFiles', 1, EXPLORE_AGENT_MAX_FILES);
  }
  if (args.maxMatches !== undefined) {
    requireInteger(args.maxMatches, 'Explore agent maxMatches', 1, EXPLORE_AGENT_MAX_MATCHES);
  }
  return freezeReview({
    kind: 'agent',
    operation: 'spawn',
    profile: 'local_read',
    writeBack: 'summary',
    isolation: 'same_workspace',
  });
}

function projectExpertDispatchReview(
  args: Record<string, CanonicalToolValue>,
): PublicToolAgentReview {
  requireFields(args, ['member', 'task']);
  propertyString(args, 'task');
  return freezeReview({
    kind: 'agent',
    operation: 'dispatch',
    member: projectReviewText(propertyString(args, 'member'), 'expert member', REF_MAX_BYTES),
  });
}

function projectRuntimeResourceReview(
  args: Record<string, CanonicalToolValue>,
): PublicToolRuntimeResourceReview {
  requireFields(args, ['ref']);
  return freezeReview({
    kind: 'runtime_resource',
    operation: 'stop',
    ref: projectReviewText(propertyString(args, 'ref'), 'runtime resource ref', REF_MAX_BYTES),
  });
}

function projectSkillReview(args: Record<string, CanonicalToolValue>): PublicToolSkillReview {
  requireFields(args, ['name']);
  return freezeReview({
    kind: 'skill',
    name: projectReviewText(propertyString(args, 'name'), 'skill name', REF_MAX_BYTES),
  });
}

function projectQuestionReview(args: Record<string, CanonicalToolValue>): PublicToolQuestionReview {
  requireFields(args, ['questions']);
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
    throw new InteractionPermissionProjectionError();
  }
  return freezeReview({ kind: 'question', questionCount: args.questions.length });
}

function decodePathReview(record: Record<string, unknown>): PublicToolPathReview {
  requireFields(record, ['kind', 'operation', 'path', 'cwd'], ['sortKeys']);
  if (
    record.operation !== 'read' &&
    record.operation !== 'write' &&
    record.operation !== 'edit' &&
    record.operation !== 'format_json'
  )
    return invalidReview();
  if (record.operation === 'format_json') {
    if (typeof record.sortKeys !== 'boolean') return invalidReview();
  } else if (record.sortKeys !== undefined) return invalidReview();
  return freezeReview({
    kind: 'path',
    operation: record.operation,
    path: requireCanonicalReviewText(record.path, 'path', PATH_MAX_BYTES),
    cwd: requireCanonicalReviewText(record.cwd, 'cwd', CWD_MAX_BYTES),
    ...(record.operation === 'format_json' ? { sortKeys: record.sortKeys as boolean } : {}),
  });
}

function decodeSearchReview(record: Record<string, unknown>): PublicToolSearchReview {
  if (record.operation === 'glob') {
    requireFields(record, ['kind', 'operation', 'pattern', 'root', 'cwd']);
    return freezeReview({
      kind: 'search',
      operation: 'glob',
      pattern: requireCanonicalReviewText(record.pattern, 'glob pattern', TEXT_MAX_BYTES),
      root: requireCanonicalReviewText(record.root, 'glob root', PATH_MAX_BYTES),
      cwd: requireCanonicalReviewText(record.cwd, 'cwd', CWD_MAX_BYTES),
    });
  }
  if (record.operation !== 'grep') return invalidReview();
  requireFields(record, ['kind', 'operation', 'pattern', 'root', 'cwd'], ['glob']);
  return freezeReview({
    kind: 'search',
    operation: 'grep',
    pattern: requireCanonicalReviewText(record.pattern, 'grep pattern', TEXT_MAX_BYTES),
    root: requireCanonicalReviewText(record.root, 'grep root', PATH_MAX_BYTES),
    ...(record.glob === undefined
      ? {}
      : { glob: requireCanonicalReviewText(record.glob, 'grep glob', TEXT_MAX_BYTES) }),
    cwd: requireCanonicalReviewText(record.cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function decodeStdinReview(record: Record<string, unknown>): PublicToolStdinReview {
  requireFields(record, ['kind', 'ref'], ['input', 'size']);
  if (record.input === undefined && record.size === undefined) return invalidReview();
  return freezeReview({
    kind: 'stdin',
    ref: requireCanonicalReviewText(record.ref, 'stdin ref', REF_MAX_BYTES),
    ...(record.input === undefined ? {} : { input: decodeStdinInput(record.input) }),
    ...(record.size === undefined ? {} : { size: decodeStdinSize(record.size) }),
  });
}

function decodeStdinInput(value: unknown): PublicToolStdinInputReview {
  const record = requirePlainRecord(value, 'stdin input review');
  requireFields(record, ['text', 'bytes']);
  return {
    text: requireCanonicalReviewText(record.text, 'stdin input', TEXT_MAX_BYTES, true),
    bytes: requireInteger(record.bytes, 'stdin bytes', 0),
  };
}

function decodeStdinSize(value: unknown): PublicToolStdinSize {
  const record = requirePlainRecord(value, 'stdin size review');
  requireFields(record, ['cols', 'rows']);
  return {
    cols: requireInteger(record.cols, 'stdin cols', 1, MAX_STDIN_DIMENSION),
    rows: requireInteger(record.rows, 'stdin rows', 1, MAX_STDIN_DIMENSION),
  };
}

function decodeWebReview(record: Record<string, unknown>): PublicToolWebReview {
  requireFields(record, ['kind', 'targetKind', 'target']);
  if (record.targetKind !== 'url' && record.targetKind !== 'query') return invalidReview();
  return freezeReview({
    kind: 'web',
    targetKind: record.targetKind,
    target: requireCanonicalReviewText(record.target, 'web target', WEB_TARGET_MAX_BYTES),
  });
}

function decodePatchReview(record: Record<string, unknown>): PublicToolPatchReview {
  requireFields(record, ['kind', 'operation', 'path', 'cwd']);
  if (
    record.operation !== 'create_file' &&
    record.operation !== 'update_file' &&
    record.operation !== 'delete_file'
  )
    return invalidReview();
  return freezeReview({
    kind: 'patch',
    operation: record.operation,
    path: requireCanonicalReviewText(record.path, 'patch path', PATH_MAX_BYTES),
    cwd: requireCanonicalReviewText(record.cwd, 'cwd', CWD_MAX_BYTES),
  });
}

function decodeAgentReview(record: Record<string, unknown>): PublicToolAgentReview {
  if (record.operation === 'spawn') {
    requireFields(record, ['kind', 'operation', 'profile', 'writeBack', 'isolation'], ['taskId']);
    if (record.writeBack !== 'summary' && record.writeBack !== 'patch') return invalidReview();
    if (record.isolation !== 'same_workspace' && record.isolation !== 'worktree')
      return invalidReview();
    return freezeReview({
      kind: 'agent',
      operation: 'spawn',
      profile: requireCanonicalReviewText(record.profile, 'agent profile', REF_MAX_BYTES),
      writeBack: record.writeBack,
      isolation: record.isolation,
      ...(record.taskId === undefined
        ? {}
        : { taskId: requireCanonicalReviewText(record.taskId, 'task id', REF_MAX_BYTES) }),
    });
  }
  if (record.operation === 'swarm') {
    requireFields(record, [
      'kind',
      'operation',
      'itemCount',
      'resumeCount',
      'concurrency',
      'profiles',
      'writeBack',
      'isolation',
    ]);
    const itemCount = requireInteger(
      record.itemCount,
      'agent swarm item count',
      1,
      AGENT_SWARM_MAX_ITEMS,
    );
    const resumeCount = requireInteger(
      record.resumeCount,
      'agent swarm resume count',
      0,
      itemCount,
    );
    const spawnCount = itemCount - resumeCount;
    return freezeReview({
      kind: 'agent',
      operation: 'swarm',
      itemCount,
      resumeCount,
      concurrency: requireInteger(
        record.concurrency,
        'agent swarm concurrency',
        1,
        AGENT_SWARM_MAX_CONCURRENCY,
      ),
      profiles: decodeAgentProfileSummary(record.profiles, spawnCount),
      writeBack: decodeAgentWriteBackSummary(record.writeBack, spawnCount),
      isolation: decodeAgentIsolationSummary(record.isolation, spawnCount),
    });
  }
  if (record.operation !== 'dispatch') return invalidReview();
  requireFields(record, ['kind', 'operation', 'member']);
  return freezeReview({
    kind: 'agent',
    operation: 'dispatch',
    member: requireCanonicalReviewText(record.member, 'expert member', REF_MAX_BYTES),
  });
}

function decodeAgentProfileSummary(value: unknown, spawnCount: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    (spawnCount === 0 ? value.length !== 0 : value.length < 1 || value.length > spawnCount)
  ) {
    return invalidReview();
  }
  const profiles: string[] = [];
  for (const profile of value) {
    profiles.push(requireCanonicalReviewText(profile, 'agent profile', REF_MAX_BYTES));
  }
  if (new Set(profiles).size !== profiles.length) return invalidReview();
  return profiles;
}

function decodeAgentWriteBackSummary(
  value: unknown,
  spawnCount: number,
): readonly ('summary' | 'patch')[] {
  if (
    !Array.isArray(value) ||
    (spawnCount === 0
      ? value.length !== 0
      : value.length < 1 || value.length > Math.min(2, spawnCount))
  ) {
    return invalidReview();
  }
  const modes: ('summary' | 'patch')[] = [];
  for (const mode of value) {
    if (mode !== 'summary' && mode !== 'patch') return invalidReview();
    modes.push(mode);
  }
  if (new Set(modes).size !== modes.length) return invalidReview();
  return modes;
}

function decodeAgentIsolationSummary(
  value: unknown,
  spawnCount: number,
): readonly ('same_workspace' | 'worktree')[] {
  if (
    !Array.isArray(value) ||
    (spawnCount === 0
      ? value.length !== 0
      : value.length < 1 || value.length > Math.min(2, spawnCount))
  ) {
    return invalidReview();
  }
  const modes: ('same_workspace' | 'worktree')[] = [];
  for (const mode of value) {
    if (mode !== 'same_workspace' && mode !== 'worktree') return invalidReview();
    modes.push(mode);
  }
  if (new Set(modes).size !== modes.length) return invalidReview();
  return modes;
}

function decodeBrowserReview(record: Record<string, unknown>): PublicToolBrowserReview {
  switch (record.action) {
    case 'navigate':
      requireFields(record, ['kind', 'action', 'url']);
      return freezeReview({
        kind: 'browser',
        action: 'navigate',
        url: requireCanonicalReviewText(record.url, 'browser URL', WEB_TARGET_MAX_BYTES),
      });
    case 'snapshot':
      requireFields(record, ['kind', 'action']);
      return freezeReview({ kind: 'browser', action: 'snapshot' });
    case 'click':
      requireFields(record, ['kind', 'action', 'ref']);
      return freezeReview({
        kind: 'browser',
        action: 'click',
        ref: requireCanonicalReviewText(record.ref, 'browser ref', REF_MAX_BYTES),
      });
    case 'type':
      requireFields(record, ['kind', 'action', 'ref', 'text', 'submit']);
      return freezeReview({
        kind: 'browser',
        action: 'type',
        ref: requireCanonicalReviewText(record.ref, 'browser ref', REF_MAX_BYTES),
        text: requireCanonicalReviewText(record.text, 'browser text', TEXT_MAX_BYTES, true),
        submit: requireBoolean(record.submit, 'browser submit'),
      });
    case 'wait':
      return decodeBrowserWaitReview(record);
    case 'extract':
      requireFields(record, ['kind', 'action', 'start'], ['selector']);
      return freezeReview({
        kind: 'browser',
        action: 'extract',
        ...(record.selector === undefined
          ? {}
          : {
              selector: requireCanonicalReviewText(
                record.selector,
                'browser selector',
                REF_MAX_BYTES,
                true,
              ),
            }),
        start: requireInteger(record.start, 'browser start', 0),
      });
    default:
      return invalidReview();
  }
}

function decodeBrowserWaitReview(record: Record<string, unknown>): PublicToolBrowserReview {
  if (record.condition === 'duration') {
    requireFields(record, ['kind', 'action', 'condition', 'seconds']);
    return freezeReview({
      kind: 'browser',
      action: 'wait',
      condition: 'duration',
      seconds: requireNumber(record.seconds, 'browser wait', MAX_BROWSER_WAIT_SECONDS),
    });
  }
  if (record.condition !== 'text' && record.condition !== 'selector') return invalidReview();
  requireFields(record, ['kind', 'action', 'condition', 'value', 'timeoutSeconds']);
  return freezeReview({
    kind: 'browser',
    action: 'wait',
    condition: record.condition,
    value: requireCanonicalReviewText(record.value, 'browser wait value', TEXT_MAX_BYTES),
    timeoutSeconds: requireNumber(
      record.timeoutSeconds,
      'browser timeout',
      MAX_BROWSER_WAIT_SECONDS,
    ),
  });
}

function projectReviewText(
  value: string,
  label: string,
  maxBytes: number,
  bash = false,
  allowEmpty = false,
): string {
  if ((!allowEmpty && value.length === 0) || !isWellFormedUnicode(value)) {
    throw new InteractionPermissionProjectionError();
  }
  const redacted = bash
    ? redactBashCommandSecretsForCriticalReview(value)
    : redactSecretsForCriticalReview(value);
  if (redacted === undefined) throw new InteractionPermissionProjectionError();
  const escaped = escapeUnsafeReviewCharacters(redacted);
  if (UTF8_ENCODER.encode(escaped).byteLength > maxBytes) {
    throw new InteractionPermissionProjectionError();
  }
  return escaped;
}

function requireCanonicalReviewText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') return invalidReview();
  const decoded = decodeCanonicalReviewString(value);
  let canonical: string;
  try {
    canonical = projectReviewText(decoded, label, maxBytes, false, allowEmpty);
  } catch {
    return invalidReview();
  }
  if (canonical !== value) return invalidReview();
  return value;
}

function requireCanonicalBashReviewText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') return invalidReview();
  const decoded = decodeCanonicalReviewString(value);
  let canonical: string;
  try {
    canonical = projectReviewText(decoded, label, maxBytes, true);
  } catch {
    return invalidReview();
  }
  if (canonical !== value) return invalidReview();
  return value;
}

function escapeUnsafeReviewCharacters(value: string): string {
  let safe = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    safe +=
      character === '\\'
        ? '\\\\'
        : isUnsafeReviewCharacter(character)
          ? `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`
          : character;
  }
  return safe;
}

function decodeCanonicalReviewString(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; ) {
    const character = String.fromCodePoint(value.codePointAt(index)!);
    if (character !== '\\') {
      if (isUnsafeReviewCharacter(character)) return invalidReview();
      decoded += character;
      index += character.length;
      continue;
    }
    if (value[index + 1] === '\\') {
      decoded += '\\';
      index += 2;
      continue;
    }
    const match = /^\\u\{([0-9A-F]{4,6})\}/.exec(value.slice(index));
    if (match === null) return invalidReview();
    const codePoint = Number.parseInt(match[1]!, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return invalidReview();
    }
    const escaped = String.fromCodePoint(codePoint);
    const canonical = `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
    if (match[0] !== canonical || !isUnsafeReviewCharacter(escaped)) return invalidReview();
    decoded += escaped;
    index += match[0].length;
  }
  return decoded;
}

function isUnsafeReviewCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint !== 0x20 && UNSAFE_REVIEW_FORMAT_CHARACTER.test(character))
  );
}

function cloneCanonicalValue(value: unknown): CanonicalToolValue {
  const active = new WeakSet<object>();
  let nodes = 0;
  const clone = (candidate: unknown, depth: number): CanonicalToolValue => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new TypeError('Tool arguments exceed canonical intent limits');
    }
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      if (typeof candidate === 'string' && !isWellFormedUnicode(candidate)) {
        throw new TypeError('Tool arguments contain malformed Unicode');
      }
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw new TypeError('Tool arguments contain a non-finite number');
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('Tool arguments must be JSON-compatible data');
    }
    if (active.has(candidate)) throw new TypeError('Tool arguments must not be cyclic');
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (
          Object.getPrototypeOf(candidate) !== Array.prototype ||
          candidate.length > MAX_CANONICAL_NODES ||
          Reflect.ownKeys(candidate).length !== candidate.length + 1
        )
          throw new TypeError('Tool argument arrays must be dense plain arrays');
        const next: CanonicalToolValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (
            descriptor === undefined ||
            !('value' in descriptor) ||
            descriptor.enumerable !== true
          )
            throw new TypeError('Tool argument arrays must contain enumerable data properties');
          next.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(next);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Tool argument objects must be plain records');
      }
      const next: Record<string, CanonicalToolValue> = {};
      for (const key of Reflect.ownKeys(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          typeof key !== 'string' ||
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        )
          throw new TypeError('Tool argument objects must contain enumerable data properties');
        Object.defineProperty(next, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(next);
    } finally {
      active.delete(candidate);
    }
  };
  return clone(value, 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function freezeReview<T extends PublicToolIntentReview>(review: T): T {
  return deepFreeze(review);
}

function requireProjectionRecord(value: CanonicalToolValue): Record<string, CanonicalToolValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InteractionPermissionProjectionError();
  }
  return value as Record<string, CanonicalToolValue>;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(`${label} must contain only data properties`);
    }
  }
  return value as Record<string, unknown>;
}

function requireFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  )
    throw new InteractionPermissionProjectionError();
}

function propertyString(
  record: Record<string, CanonicalToolValue>,
  key: string,
  allowEmpty = false,
): string {
  const value = record[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new InteractionPermissionProjectionError();
  }
  return value;
}

function propertyBoundedString(
  record: Record<string, CanonicalToolValue>,
  key: string,
  minChars: number,
  maxChars: number,
): string {
  const value = record[key];
  if (typeof value !== 'string') throw new InteractionPermissionProjectionError();
  return requireBoundedString(value, minChars, maxChars);
}

function requireBoundedString(value: string, minChars: number, maxChars: number): string {
  if (value.length < minChars || value.length > maxChars) {
    throw new InteractionPermissionProjectionError();
  }
  return value;
}

function validateBoundedStringArray(
  value: CanonicalToolValue,
  maxItems: number,
  maxChars: number,
): void {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new InteractionPermissionProjectionError();
  }
  for (const item of value) {
    if (typeof item !== 'string') throw new InteractionPermissionProjectionError();
    requireBoundedString(item, 1, maxChars);
  }
}

function optionalString(value: CanonicalToolValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InteractionPermissionProjectionError();
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${label}`);
  return value;
}

function requireInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as number;
}

function requireNumber(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function requirePrivateString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    UTF8_ENCODER.encode(value).byteLength > maxBytes
  )
    throw new TypeError(`Invalid canonical ${label}`);
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function invalidReview(): never {
  throw new TypeError('Invalid public tool intent review');
}
