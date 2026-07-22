import {
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  type PermissionRequestPayload,
  type PermissionResponse,
} from './permission.js';
import { isAttachmentRef, isStorageRef } from './events.js';
import { projectInteractionPermissionRequest } from './interaction.js';
import type { UserQuestion, UserQuestionOption, UserQuestionRequest } from './user-question.js';
import { defineObjectShape, hasExactShape, isOptionalString, isRecord } from './record-schema.js';

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

export { isAttachmentRef, isStorageRef };

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
