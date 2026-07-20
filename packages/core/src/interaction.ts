import {
  MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  type AdditionalPermissionAccess,
  type AdditionalPermissionRiskSummary,
  type AdditionalPermissionScope,
} from './additional-permissions.js';
import {
  COMPUTER_USE_APPROVAL_ACTIONS,
  type ComputerUseApprovalAction,
  type ComputerUsePublicApprovalReview,
} from './computer-use.js';
import {
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  categorizeBash,
  isToolCategory,
  permissionReasonForCategory,
  type AdditionalPermissionPathReview,
  type AdditionalPermissionRequest,
  type AdditionalPermissionReview,
  type ApprovalRiskLevel,
  type ApprovalsReviewer,
  type PermissionRequest,
  type PermissionRequestPayload,
  type PermissionResponse,
  type SandboxEscalationRequest,
  type SandboxEscalationRiskSummary,
  type ToolCategory,
} from './permission.js';
import {
  InteractionPermissionProjectionError,
  decodePublicToolIntentReview,
  knownToolBaseCategory,
  knownToolUsesBashCategorizer,
  publicToolCommandSemanticText,
  publicToolReviewMatchesIdentity,
  publicToolReviewRememberAllowed,
  type PublicToolBrowserReview,
  type PublicToolCommandReview,
  type PublicToolIntentReview,
  type PublicToolPatchReview,
  type PublicToolPathReview,
  type PublicToolStdinInputReview,
  type PublicToolStdinReview,
  type PublicToolStdinSize,
  type PublicToolWebReview,
} from './tool-intent.js';
import type { UserQuestionRequest } from './user-question.js';

export {
  InteractionPermissionProjectionError,
  type InteractionPermissionProjectionErrorReason,
} from './tool-intent.js';

export const INTERACTION_MIN_QUESTIONS = 1;
export const INTERACTION_MAX_QUESTIONS = 3;
export const INTERACTION_MIN_OPTIONS_PER_QUESTION = 2;
export const INTERACTION_MAX_OPTIONS_PER_QUESTION = 3;
export const INTERACTION_QUESTION_MAX_BYTES = 1024;
export const INTERACTION_OPTION_LABEL_MAX_BYTES = 256;
export const INTERACTION_OPTION_DESCRIPTION_MAX_BYTES = 512;
export const INTERACTION_ANSWER_MAX_BYTES = 2048;
export const INTERACTION_PERMISSION_COMMAND_MAX_BYTES = 8 * 1024;
export const INTERACTION_PERMISSION_CWD_MAX_BYTES = 4 * 1024;
export const INTERACTION_PERMISSION_PATH_MAX_BYTES = 4 * 1024;
export const INTERACTION_PERMISSION_WEB_TARGET_MAX_BYTES = 4 * 1024;
export const INTERACTION_REQUEST_MAX_BYTES = 12 * 1024;
export const INTERACTION_COMPUTER_USE_ACTIONS = COMPUTER_USE_APPROVAL_ACTIONS;
export const INTERACTION_ID_MAX_BYTES = 256;

const INTERACTION_TOOL_NAME_MAX_BYTES = 256;
const UTF8_ENCODER = new TextEncoder();

export const INTERACTION_CLOSURE_REASONS = [
  'turn_stopped',
  'turn_terminal',
  'timed_out',
  'host_restarted',
] as const;

export type InteractionPermissionReason = PermissionRequest['reason'];
export type InteractionPermissionDecision = PermissionResponse['decision'];
export type InteractionClosureReason = (typeof INTERACTION_CLOSURE_REASONS)[number];
export type InteractionQuestionClosureReason = Exclude<InteractionClosureReason, 'timed_out'>;
export type InteractionComputerUseAction = ComputerUseApprovalAction;

export type InteractionPermissionCommandReview = PublicToolCommandReview;
export type InteractionPermissionPathReview = PublicToolPathReview;
export type InteractionPermissionStdinInputReview = PublicToolStdinInputReview;
export type InteractionPermissionStdinSize = PublicToolStdinSize;
export type InteractionPermissionStdinReview = PublicToolStdinReview;
export type InteractionPermissionWebReview = PublicToolWebReview;
export type InteractionPermissionBrowserReview = PublicToolBrowserReview;
export type InteractionPermissionPatchReview = PublicToolPatchReview;
export type InteractionPermissionComputerUseReview = ComputerUsePublicApprovalReview;
export type InteractionToolPermissionReview = PublicToolIntentReview;
export type InteractionAdditionalPermissionPathReview = AdditionalPermissionPathReview;
export type InteractionPermissionAdditionalPermissionsReview = AdditionalPermissionReview;
export type InteractionPermissionReview = PublicToolIntentReview | AdditionalPermissionReview;

type WithoutRequestIdentity<T> = T extends unknown ? Omit<T, 'requestId' | 'toolUseId'> : never;

export type InteractionPermissionPrompt = WithoutRequestIdentity<PermissionRequestPayload>;

export interface InteractionQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface InteractionQuestion {
  readonly question: string;
  readonly options: readonly InteractionQuestionOption[];
}

export type InteractionRequest =
  | {
      readonly kind: 'permission';
      readonly toolUseId: string;
      readonly prompt: InteractionPermissionPrompt;
    }
  | {
      readonly kind: 'question';
      readonly toolUseId: string;
      readonly questions: readonly InteractionQuestion[];
    };

export type InteractionPermissionDecisionFields =
  | {
      readonly decision: 'allow';
      readonly rememberForTurn: boolean;
    }
  | {
      readonly decision: 'deny';
      readonly rememberForTurn: false;
    };

export type InteractionPermissionAnswer = InteractionPermissionDecisionFields & {
  readonly kind: 'permission';
};

export type InteractionAnswer =
  | InteractionPermissionAnswer
  | {
      readonly kind: 'question';
      readonly answers: readonly (string | null)[];
    };

interface InteractionCanonicalPermissionOutcomeBase {
  readonly kind: 'permission_answer';
  readonly reviewer: ApprovalsReviewer;
  readonly riskLevel?: ApprovalRiskLevel;
  readonly committedAt: number;
}

export type InteractionCanonicalPermissionOutcome = InteractionCanonicalPermissionOutcomeBase &
  InteractionPermissionDecisionFields;

export interface InteractionCanonicalQuestionOutcome {
  readonly kind: 'question_answer';
  readonly answers: readonly (string | null)[];
  readonly committedAt: number;
}

export interface InteractionCanonicalClosureOutcome {
  readonly kind: 'closure';
  readonly reason: InteractionClosureReason;
  readonly committedAt: number;
}

export type InteractionCanonicalOutcome =
  | InteractionCanonicalPermissionOutcome
  | InteractionCanonicalQuestionOutcome
  | InteractionCanonicalClosureOutcome;

export type InteractionQuestionProjectionInput = Pick<
  UserQuestionRequest,
  'toolUseId' | 'questions'
>;

export function decodeInteractionRequest(value: unknown): InteractionRequest {
  const record = requirePlainRecord(value, 'Interaction request');
  let request: InteractionRequest;
  if (record.kind === 'permission') {
    requireFields(record, ['kind', 'toolUseId', 'prompt']);
    request = {
      kind: 'permission',
      toolUseId: requireBoundedString(
        record.toolUseId,
        'Interaction toolUseId',
        INTERACTION_ID_MAX_BYTES,
      ),
      prompt: decodeInteractionPermissionPrompt(record.prompt),
    };
  } else if (record.kind === 'question') {
    requireFields(record, ['kind', 'toolUseId', 'questions']);
    request = {
      kind: 'question',
      toolUseId: requireBoundedString(
        record.toolUseId,
        'Interaction toolUseId',
        INTERACTION_ID_MAX_BYTES,
      ),
      questions: requireBoundedArray(
        record.questions,
        'Interaction questions',
        INTERACTION_MIN_QUESTIONS,
        INTERACTION_MAX_QUESTIONS,
      ).map(decodeInteractionQuestion),
    };
  } else {
    return invalid('Invalid Interaction request kind');
  }
  requireSerializedByteLimit(request, 'Interaction request', INTERACTION_REQUEST_MAX_BYTES);
  return deepFreeze(request);
}

export function decodeInteractionAnswer(value: unknown): InteractionAnswer {
  const record = requirePlainRecord(value, 'Interaction answer');
  if (record.kind === 'permission') {
    requireFields(record, ['kind', 'decision', 'rememberForTurn']);
    const decision = requirePermissionDecision(record.decision);
    const rememberForTurn = requireBoolean(record.rememberForTurn, 'rememberForTurn');
    if (decision === 'deny') {
      if (rememberForTurn) invalid('Denied Interaction permission cannot be remembered');
      return Object.freeze({ kind: 'permission', decision: 'deny', rememberForTurn: false });
    }
    return Object.freeze({ kind: 'permission', decision: 'allow', rememberForTurn });
  }
  if (record.kind === 'question') {
    requireFields(record, ['kind', 'answers']);
    return deepFreeze({ kind: 'question', answers: decodeQuestionAnswers(record.answers) });
  }
  return invalid('Invalid Interaction answer kind');
}

export function decodeInteractionCanonicalOutcome(value: unknown): InteractionCanonicalOutcome {
  const record = requirePlainRecord(value, 'Interaction canonical outcome');
  if (record.kind === 'permission_answer') {
    requireFields(
      record,
      ['kind', 'decision', 'rememberForTurn', 'reviewer', 'committedAt'],
      ['riskLevel'],
    );
    const decision = requirePermissionDecision(record.decision);
    const rememberForTurn = requireBoolean(record.rememberForTurn, 'rememberForTurn');
    if (decision === 'deny' && rememberForTurn) {
      return invalid('Denied Interaction permission cannot be remembered');
    }
    const common = {
      kind: 'permission_answer' as const,
      reviewer: requirePermissionReviewer(record.reviewer),
      ...(record.riskLevel === undefined
        ? {}
        : { riskLevel: requirePermissionRiskLevel(record.riskLevel) }),
      committedAt: requireCommitTime(record.committedAt),
    };
    return deepFreeze(
      decision === 'deny'
        ? { ...common, decision: 'deny' as const, rememberForTurn: false as const }
        : { ...common, decision: 'allow' as const, rememberForTurn },
    );
  }
  if (record.kind === 'question_answer') {
    requireFields(record, ['kind', 'answers', 'committedAt']);
    return deepFreeze({
      kind: 'question_answer',
      answers: decodeQuestionAnswers(record.answers),
      committedAt: requireCommitTime(record.committedAt),
    });
  }
  if (record.kind === 'closure') {
    requireFields(record, ['kind', 'reason', 'committedAt']);
    return Object.freeze({
      kind: 'closure',
      reason: requireClosureReason(record.reason),
      committedAt: requireCommitTime(record.committedAt),
    });
  }
  return invalid('Invalid Interaction canonical outcome kind');
}

export function interactionAnswerMatchesRequestKind(
  request: InteractionRequest,
  answer: InteractionAnswer,
): boolean {
  return request.kind === answer.kind;
}

export function interactionOutcomeMatchesRequestKind(
  request: InteractionRequest,
  outcome: InteractionCanonicalOutcome,
): boolean {
  if (outcome.kind === 'closure') return true;
  return request.kind === 'permission'
    ? outcome.kind === 'permission_answer'
    : outcome.kind === 'question_answer';
}

export function interactionQuestionAnswerCountMatchesRequest(
  request: Extract<InteractionRequest, { kind: 'question' }>,
  answers: readonly (string | null)[],
): boolean {
  return request.questions.length === answers.length;
}

export function interactionRememberForTurnIsEligible(
  request: InteractionRequest,
  answer: InteractionPermissionDecisionFields,
): boolean {
  if (request.kind !== 'permission') return false;
  if (!answer.rememberForTurn) return true;
  return (
    answer.decision === 'allow' &&
    request.prompt.kind === 'tool_permission' &&
    request.prompt.rememberForTurnAllowed
  );
}

export function isInteractionAnswerValidForRequest(
  request: InteractionRequest,
  answer: InteractionAnswer,
): boolean {
  if (!interactionAnswerMatchesRequestKind(request, answer)) return false;
  if (answer.kind === 'question') {
    return interactionQuestionAnswerCountMatchesRequest(
      request as Extract<InteractionRequest, { kind: 'question' }>,
      answer.answers,
    );
  }
  return interactionRememberForTurnIsEligible(request, answer);
}

export function isInteractionCanonicalOutcomeValidForRequest(
  request: InteractionRequest,
  outcome: InteractionCanonicalOutcome,
): boolean {
  if (!interactionOutcomeMatchesRequestKind(request, outcome)) return false;
  if (outcome.kind === 'closure') {
    return request.kind === 'permission' || outcome.reason !== 'timed_out';
  }
  if (outcome.kind === 'question_answer') {
    return interactionQuestionAnswerCountMatchesRequest(
      request as Extract<InteractionRequest, { kind: 'question' }>,
      outcome.answers,
    );
  }
  return interactionRememberForTurnIsEligible(request, outcome);
}

export function interactionCanonicalOutcomesEquivalent(
  left: InteractionCanonicalOutcome,
  right: InteractionCanonicalOutcome,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'permission_answer' && right.kind === 'permission_answer') {
    return left.decision === right.decision && left.rememberForTurn === right.rememberForTurn;
  }
  if (left.kind === 'question_answer' && right.kind === 'question_answer') {
    return answersEqual(left.answers, right.answers);
  }
  return left.kind === 'closure' && right.kind === 'closure' && left.reason === right.reason;
}

export function projectInteractionPermissionRequest(
  request: PermissionRequestPayload,
): Extract<InteractionRequest, { kind: 'permission' }> {
  const record = requirePlainRecord(request, 'Permission request');
  requireBoundedString(record.requestId, 'Permission requestId', INTERACTION_ID_MAX_BYTES);
  const toolUseId = requireBoundedString(
    record.toolUseId,
    'Interaction toolUseId',
    INTERACTION_ID_MAX_BYTES,
  );
  const projected = {
    kind: 'permission' as const,
    toolUseId,
    prompt: decodeInteractionPermissionPrompt(permissionPromptFromRequest(record)),
  };
  requirePermissionProjectionByteLimit(projected);
  return deepFreeze(projected);
}

export function projectInteractionQuestionRequest(
  request: InteractionQuestionProjectionInput,
): Extract<InteractionRequest, { kind: 'question' }> {
  const record = requirePlainRecord(request, 'User question request');
  requireFields(record, ['toolUseId', 'questions']);
  const projected = {
    kind: 'question' as const,
    toolUseId: requireBoundedString(
      record.toolUseId,
      'Interaction toolUseId',
      INTERACTION_ID_MAX_BYTES,
    ),
    questions: requireBoundedArray(
      record.questions,
      'Interaction questions',
      INTERACTION_MIN_QUESTIONS,
      INTERACTION_MAX_QUESTIONS,
    ).map(decodeInteractionQuestion),
  };
  requireSerializedByteLimit(projected, 'Interaction request', INTERACTION_REQUEST_MAX_BYTES);
  return deepFreeze(projected);
}

function permissionPromptFromRequest(request: Record<string, unknown>): Record<string, unknown> {
  const prompt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== 'requestId' && key !== 'toolUseId') prompt[key] = value;
  }
  return prompt;
}

function decodeInteractionPermissionPrompt(value: unknown): InteractionPermissionPrompt {
  const record = requirePlainRecord(value, 'Interaction permission prompt');
  if (record.kind === 'tool_permission') {
    requireFields(record, [
      'kind',
      'toolName',
      'category',
      'reason',
      'review',
      'rememberForTurnAllowed',
    ]);
    const toolName = requireBoundedString(
      record.toolName,
      'Interaction permission toolName',
      INTERACTION_TOOL_NAME_MAX_BYTES,
    );
    const category = requireToolCategory(record.category);
    const reason = requireToolPermissionReason(record.reason);
    const review = decodePublicToolIntentReview(record.review);
    const rememberForTurnAllowed = requireBoolean(
      record.rememberForTurnAllowed,
      'rememberForTurnAllowed',
    );
    requireToolPermissionSemantics(toolName, category, reason, review, rememberForTurnAllowed);
    return deepFreeze({
      kind: 'tool_permission',
      toolName,
      category,
      reason,
      review,
      rememberForTurnAllowed,
    });
  }
  if (record.kind === 'additional_permissions') {
    requireFields(record, [
      'kind',
      'toolName',
      'category',
      'reason',
      'review',
      'risk',
      'alsoApprovesToolExecution',
      'availableDecisions',
    ]);
    if (
      record.reason !== 'additional_permissions' ||
      record.alsoApprovesToolExecution !== false ||
      !isAllowOnceDenyTuple(record.availableDecisions)
    )
      invalid('Invalid additional permission prompt');
    const toolName = requireBoundedString(
      record.toolName,
      'Interaction permission toolName',
      INTERACTION_TOOL_NAME_MAX_BYTES,
    );
    const category = requireToolCategory(record.category);
    requireAdditionalPermissionCategory(toolName, category);
    const review = decodeAdditionalPermissionReview(record.review);
    const risk = decodeAdditionalPermissionRisk(record.risk);
    if (review.networkEnabled !== risk.networkEnabled) {
      invalid('Additional permission network review does not match risk');
    }
    return deepFreeze({
      kind: 'additional_permissions',
      toolName,
      category,
      reason: 'additional_permissions',
      review,
      risk,
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'] as const,
    });
  }
  if (record.kind === 'sandbox_escalation') {
    requireFields(record, [
      'kind',
      'toolName',
      'category',
      'reason',
      'review',
      'trigger',
      'risk',
      'alsoApprovesToolExecution',
      'availableDecisions',
    ]);
    const review = decodePublicToolIntentReview(record.review);
    if (
      record.toolName !== 'Bash' ||
      record.reason !== 'sandbox_escalation' ||
      review.kind !== 'command' ||
      !isAllowOnceDenyTuple(record.availableDecisions)
    )
      invalid('Invalid sandbox escalation prompt');
    const category = requireToolCategory(record.category);
    if (category !== categorizeBash(publicToolCommandSemanticText(review))) {
      invalid('Sandbox escalation category does not match command review');
    }
    return deepFreeze({
      kind: 'sandbox_escalation',
      toolName: 'Bash',
      category,
      reason: 'sandbox_escalation',
      review,
      trigger: requireSandboxEscalationTrigger(record.trigger),
      risk: decodeSandboxEscalationRisk(record.risk),
      alsoApprovesToolExecution: requireBoolean(
        record.alsoApprovesToolExecution,
        'alsoApprovesToolExecution',
      ),
      availableDecisions: ['allow_once', 'deny'] as const,
    });
  }
  return invalid('Invalid Interaction permission prompt kind');
}

function decodeAdditionalPermissionReview(value: unknown): AdditionalPermissionReview {
  const record = requirePlainRecord(value, 'additional permission review');
  requireFields(record, ['kind', 'cwd', 'paths', 'networkEnabled']);
  if (record.kind !== 'additional_permissions')
    invalid('Invalid additional permission review kind');
  const cwd = decodeCanonicalPathText(record.cwd);
  const paths = requireBoundedArray(
    record.paths,
    'additional permission paths',
    0,
    MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  ).map((entry) => decodeAdditionalPermissionPath(entry, cwd));
  const networkEnabled = requireBoolean(record.networkEnabled, 'networkEnabled');
  if (paths.length === 0 && !networkEnabled) {
    invalid('Additional permission review must not be empty');
  }
  return deepFreeze({ kind: 'additional_permissions', cwd, paths, networkEnabled });
}

function decodeAdditionalPermissionPath(
  value: unknown,
  cwd: string,
): AdditionalPermissionPathReview {
  const record = requirePlainRecord(value, 'additional permission path');
  requireFields(record, ['path', 'access', 'scope']);
  if (record.access !== 'read' && record.access !== 'write') {
    invalid('Invalid additional permission access');
  }
  if (record.scope !== 'exact' && record.scope !== 'subtree') {
    invalid('Invalid additional permission scope');
  }
  const review = decodePublicToolIntentReview({
    kind: 'path',
    operation: record.access,
    path: record.path,
    cwd,
  });
  if (review.kind !== 'path') invalid('Invalid additional permission path review');
  return {
    path: review.path,
    access: record.access as AdditionalPermissionAccess,
    scope: record.scope as AdditionalPermissionScope,
  };
}

function decodeCanonicalPathText(value: unknown): string {
  const review = decodePublicToolIntentReview({
    kind: 'path',
    operation: 'read',
    path: value,
    cwd: value,
  }) as PublicToolPathReview;
  return review.path;
}

function requireToolPermissionSemantics(
  toolName: string,
  category: ToolCategory,
  reason: InteractionPermissionReason,
  review: PublicToolIntentReview,
  rememberForTurnAllowed: boolean,
): void {
  if (permissionReasonForCategory(category) !== reason) {
    invalid('Tool permission category does not match reason');
  }
  if (!publicToolReviewMatchesIdentity({ toolName, category, review })) {
    invalid('Tool permission review does not match tool identity');
  }
  if (
    rememberForTurnAllowed &&
    !publicToolReviewRememberAllowed({
      toolName,
      category,
      review,
    })
  ) {
    invalid('Tool permission review cannot be remembered for the turn');
  }
  if (knownToolUsesBashCategorizer(toolName)) {
    if (
      review.kind !== 'command' ||
      category !== categorizeBash(publicToolCommandSemanticText(review))
    )
      invalid('Bash permission category does not match command review');
  }
}

function requireAdditionalPermissionCategory(toolName: string, category: ToolCategory): void {
  if (knownToolUsesBashCategorizer(toolName)) {
    if (
      category !== 'shell_unsafe' &&
      category !== 'fs_destructive' &&
      category !== 'git_destructive' &&
      category !== 'privileged'
    )
      invalid('Invalid Bash additional permission category');
    return;
  }
  const expected = knownToolBaseCategory(toolName);
  if (expected === undefined || expected !== category) {
    invalid('Additional permission category does not match a known tool');
  }
}

function decodeInteractionQuestion(value: unknown): InteractionQuestion {
  const record = requirePlainRecord(value, 'Interaction question');
  requireFields(record, ['question', 'options']);
  return deepFreeze({
    question: requireBoundedString(
      record.question,
      'Interaction question text',
      INTERACTION_QUESTION_MAX_BYTES,
    ),
    options: requireBoundedArray(
      record.options,
      'Interaction question options',
      INTERACTION_MIN_OPTIONS_PER_QUESTION,
      INTERACTION_MAX_OPTIONS_PER_QUESTION,
    ).map(decodeInteractionQuestionOption),
  });
}

function decodeInteractionQuestionOption(value: unknown): InteractionQuestionOption {
  const record = requirePlainRecord(value, 'Interaction question option');
  requireFields(record, ['label'], ['description']);
  return Object.freeze({
    label: requireBoundedString(
      record.label,
      'Interaction question option label',
      INTERACTION_OPTION_LABEL_MAX_BYTES,
    ),
    ...(record.description === undefined
      ? {}
      : {
          description: requireBoundedString(
            record.description,
            'Interaction question option description',
            INTERACTION_OPTION_DESCRIPTION_MAX_BYTES,
          ),
        }),
  });
}

function decodeQuestionAnswers(value: unknown): readonly (string | null)[] {
  return Object.freeze(
    requireBoundedArray(
      value,
      'Interaction question answers',
      INTERACTION_MIN_QUESTIONS,
      INTERACTION_MAX_QUESTIONS,
    ).map((answer) =>
      answer === null
        ? null
        : requireBoundedString(answer, 'Interaction question answer', INTERACTION_ANSWER_MAX_BYTES),
    ),
  );
}

function decodeAdditionalPermissionRisk(value: unknown): AdditionalPermissionRiskSummary {
  const record = requirePlainRecord(value, 'additional permission risk');
  requireFields(record, ['outsideWorkspace', 'protectedMetadata', 'networkEnabled']);
  return Object.freeze({
    outsideWorkspace: requireBoolean(record.outsideWorkspace, 'outsideWorkspace'),
    protectedMetadata: requireBoolean(record.protectedMetadata, 'protectedMetadata'),
    networkEnabled: requireBoolean(record.networkEnabled, 'networkEnabled'),
  });
}

function decodeSandboxEscalationRisk(value: unknown): SandboxEscalationRiskSummary {
  const record = requirePlainRecord(value, 'sandbox escalation risk');
  requireFields(record, [
    'unsandboxedExecution',
    'unrestrictedFileSystem',
    'unrestrictedNetwork',
    'protectedMetadataExposed',
  ]);
  if (
    record.unsandboxedExecution !== true ||
    record.unrestrictedFileSystem !== true ||
    record.unrestrictedNetwork !== true ||
    record.protectedMetadataExposed !== true
  )
    invalid('Invalid sandbox escalation risk');
  return Object.freeze({
    unsandboxedExecution: true,
    unrestrictedFileSystem: true,
    unrestrictedNetwork: true,
    protectedMetadataExposed: true,
  });
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${label} must contain only plain data properties`);
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
    invalid('Interaction record has invalid fields');
}

function requireBoundedArray(
  value: unknown,
  label: string,
  minCount: number,
  maxCount: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minCount ||
    value.length > maxCount ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid(`Invalid ${label}`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${label} must be a dense plain array`);
    }
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    UTF8_ENCODER.encode(value).byteLength > maxBytes
  )
    return invalid(`Invalid ${label}`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return invalid(`Invalid ${label}`);
  return value;
}

function requireToolCategory(value: unknown): ToolCategory {
  if (!isToolCategory(value)) return invalid('Invalid Interaction permission category');
  return value;
}

function requireToolPermissionReason(value: unknown): InteractionPermissionReason {
  if (
    value !== 'shell_dangerous' &&
    value !== 'file_write' &&
    value !== 'fs_destructive' &&
    value !== 'network' &&
    value !== 'git_destructive' &&
    value !== 'privileged' &&
    value !== 'browser' &&
    value !== 'computer_use' &&
    value !== 'custom'
  )
    return invalid('Invalid Interaction permission reason');
  return value;
}

function requirePermissionDecision(value: unknown): InteractionPermissionDecision {
  if (value !== 'allow' && value !== 'deny') {
    return invalid('Invalid Interaction permission decision');
  }
  return value;
}

function requirePermissionReviewer(value: unknown): ApprovalsReviewer {
  if (!(APPROVALS_REVIEWERS as readonly unknown[]).includes(value)) {
    return invalid('Invalid Interaction permission reviewer');
  }
  return value as ApprovalsReviewer;
}

function requirePermissionRiskLevel(value: unknown): ApprovalRiskLevel {
  if (!(APPROVAL_RISK_LEVELS as readonly unknown[]).includes(value)) {
    return invalid('Invalid Interaction permission risk level');
  }
  return value as ApprovalRiskLevel;
}

function requireSandboxEscalationTrigger(value: unknown): SandboxEscalationRequest['trigger'] {
  if (value !== 'proactive' && value !== 'sandbox_denial') {
    return invalid('Invalid sandbox escalation trigger');
  }
  return value;
}

function requireClosureReason(value: unknown): InteractionClosureReason {
  if (!(INTERACTION_CLOSURE_REASONS as readonly unknown[]).includes(value)) {
    return invalid('Invalid Interaction closure reason');
  }
  return value as InteractionClosureReason;
}

function requireCommitTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return invalid('Invalid Interaction commit time');
  }
  return value;
}

function isAllowOnceDenyTuple(value: unknown): value is readonly ['allow_once', 'deny'] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 2 ||
    Reflect.ownKeys(value).length !== 3
  )
    return false;
  const first = Object.getOwnPropertyDescriptor(value, '0');
  const second = Object.getOwnPropertyDescriptor(value, '1');
  return (
    first !== undefined &&
    second !== undefined &&
    'value' in first &&
    'value' in second &&
    first.enumerable === true &&
    second.enumerable === true &&
    first.value === 'allow_once' &&
    second.value === 'deny'
  );
}

function requireSerializedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined || UTF8_ENCODER.encode(serialized).byteLength > maxBytes) {
    invalid(`${label} exceeds its byte limit`);
  }
}

function requirePermissionProjectionByteLimit(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) invalid('Interaction permission projection is not serializable');
  if (UTF8_ENCODER.encode(serialized).byteLength > INTERACTION_REQUEST_MAX_BYTES) {
    throw new InteractionPermissionProjectionError();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function answersEqual(
  left: readonly (string | null)[],
  right: readonly (string | null)[],
): boolean {
  return left.length === right.length && left.every((answer, index) => answer === right[index]);
}

function invalid(message: string): never {
  throw new Error(message);
}
