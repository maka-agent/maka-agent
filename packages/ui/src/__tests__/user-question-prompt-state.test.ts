import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { UserQuestionRequestEvent } from '@maka/core';
import {
  buildUserQuestionResponse,
  canLeaveQuestion,
  createQuestionDrafts,
  type QuestionAnswerDraft,
} from '../user-question-prompt-state.js';

const request = {
  type: 'user_question_request',
  id: 'event-1',
  ts: 0,
  turnId: 'turn-1',
  requestId: 'request-1',
  toolUseId: 'tool-1',
  questions: [
    { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Second?', options: [{ label: 'Same' }, { label: 'Same' }] },
    { question: 'Third?', options: [{ label: 'X' }, { label: 'Y' }] },
  ],
} satisfies UserQuestionRequestEvent;

describe('user question prompt state', () => {
  test('starts unanswered and preserves null when Next is explicit', () => {
    const drafts = createQuestionDrafts(request.questions);
    assert.deepEqual(drafts, [null, null, null]);
    assert.equal(canLeaveQuestion(drafts[0]), true);
    assert.deepEqual(buildUserQuestionResponse(request, drafts).answers, [null, null, null]);
  });

  test('maps option identity by index so duplicate labels remain selectable', () => {
    const drafts = createQuestionDrafts(request.questions);
    drafts[1] = { kind: 'option', optionIndex: 1 };
    assert.deepEqual(buildUserQuestionResponse(request, drafts).answers, [null, 'Same', null]);
  });

  test('requires non-empty Other and trims it once on submit', () => {
    const blank: QuestionAnswerDraft = { kind: 'other', value: '   ' };
    const answer: QuestionAnswerDraft = { kind: 'other', value: '  My answer  ' };
    assert.equal(canLeaveQuestion(blank), false);
    assert.equal(canLeaveQuestion(answer), true);
    assert.deepEqual(buildUserQuestionResponse(request, [answer, null, null]).answers, ['My answer', null, null]);
  });
});
