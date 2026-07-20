import {
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  type PermissionRequestPayload,
  type PermissionResponse,
} from './permission.js';
import type { AttachmentRef, StorageRef } from './events.js';
import { projectInteractionPermissionRequest } from './interaction.js';
import type { UserQuestion, UserQuestionOption, UserQuestionRequest } from './user-question.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';

const PERMISSION_RESPONSE_SHAPE = defineObjectShape<PermissionResponse>()(
  ['requestId', 'decision'],
  ['rememberForTurn', 'reviewer', 'riskLevel'],
);

const QUESTION_REQUEST_SHAPE = defineObjectShape<UserQuestionRequest>()(
  ['requestId', 'toolUseId', 'questions'],
  [],
);
const QUESTION_SHAPE = defineObjectShape<UserQuestion>()(['question', 'options'], []);
const QUESTION_OPTION_SHAPE = defineObjectShape<UserQuestionOption>()(['label'], ['description']);

const ATTACHMENT_SHAPE = defineObjectShape<AttachmentRef>()(
  ['kind', 'name', 'mimeType', 'bytes', 'ref'],
  [],
);
type SessionFileRef = Extract<StorageRef, { kind: 'session_file' }>;
type WorkspaceFileRef = Extract<StorageRef, { kind: 'workspace_file' }>;
type ExternalFileRef = Extract<StorageRef, { kind: 'external_file' }>;
const SESSION_FILE_REF_SHAPE = defineObjectShape<SessionFileRef>()(
  ['kind', 'sessionId', 'relativePath'],
  [],
);
const WORKSPACE_FILE_REF_SHAPE = defineObjectShape<WorkspaceFileRef>()(
  ['kind', 'relativePath'],
  [],
);
const EXTERNAL_FILE_REF_SHAPE = defineObjectShape<ExternalFileRef>()(['kind', 'absolutePath'], []);

export function isPermissionRequestPayload(value: unknown): value is PermissionRequestPayload {
  try {
    projectInteractionPermissionRequest(value as unknown as PermissionRequestPayload);
    return true;
  } catch {
    return false;
  }
}

export function isPermissionResponse(value: unknown): value is PermissionResponse {
  return (
    isRecord(value) &&
    hasExactShape(value, PERMISSION_RESPONSE_SHAPE) &&
    typeof value.requestId === 'string' &&
    isPermissionDecisionFields(value)
  );
}

export function isPermissionDecisionFields(value: Record<string, unknown>): boolean {
  return (
    (value.decision === 'allow' || value.decision === 'deny') &&
    (value.rememberForTurn === undefined || typeof value.rememberForTurn === 'boolean') &&
    !(value.decision === 'deny' && value.rememberForTurn === true) &&
    (value.reviewer === undefined ||
      (APPROVALS_REVIEWERS as readonly unknown[]).includes(value.reviewer)) &&
    (value.riskLevel === undefined ||
      (APPROVAL_RISK_LEVELS as readonly unknown[]).includes(value.riskLevel))
  );
}

export function isUserQuestionRequest(value: unknown): value is UserQuestionRequest {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_REQUEST_SHAPE) &&
    typeof value.requestId === 'string' &&
    typeof value.toolUseId === 'string' &&
    Array.isArray(value.questions) &&
    value.questions.every(isUserQuestion)
  );
}

export function isAttachmentRef(value: unknown): value is AttachmentRef {
  return (
    isRecord(value) &&
    hasExactShape(value, ATTACHMENT_SHAPE) &&
    ['image', 'pdf', 'doc', 'code', 'other'].includes(value.kind as string) &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    isFiniteNumber(value.bytes) &&
    value.bytes >= 0 &&
    isStorageRef(value.ref)
  );
}

export function isStorageRef(value: unknown): value is StorageRef {
  if (!isRecord(value)) return false;
  if (value.kind === 'session_file') {
    return (
      hasExactShape(value, SESSION_FILE_REF_SHAPE) &&
      typeof value.sessionId === 'string' &&
      typeof value.relativePath === 'string'
    );
  }
  if (value.kind === 'workspace_file') {
    return hasExactShape(value, WORKSPACE_FILE_REF_SHAPE) && typeof value.relativePath === 'string';
  }
  return (
    value.kind === 'external_file' &&
    hasExactShape(value, EXTERNAL_FILE_REF_SHAPE) &&
    typeof value.absolutePath === 'string'
  );
}

function isUserQuestion(value: unknown): value is UserQuestion {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_SHAPE) &&
    typeof value.question === 'string' &&
    Array.isArray(value.options) &&
    value.options.every(isUserQuestionOption)
  );
}

function isUserQuestionOption(value: unknown): value is UserQuestionOption {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_OPTION_SHAPE) &&
    typeof value.label === 'string' &&
    isOptionalString(value.description)
  );
}
