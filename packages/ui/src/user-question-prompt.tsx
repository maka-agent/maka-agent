import { useEffect, useId, useRef, useState } from 'react';
import type { UserQuestionRequestEvent, UserQuestionResponse } from '@maka/core';
import { ChoiceCard, ChoiceCardGroup } from './primitives/choice-card.js';
import { Input } from './primitives/input.js';
import { Button } from './ui.js';
import { useMountedRef } from './use-mounted-ref.js';
import {
  buildUserQuestionResponse,
  canLeaveQuestion,
  createQuestionDrafts,
  type QuestionAnswerDraft,
} from './user-question-prompt-state.js';

const OTHER_VALUE = '__other__';

export function UserQuestionPrompt(props: {
  request: UserQuestionRequestEvent;
  onRespond(response: UserQuestionResponse): void | Promise<void>;
  onStop(): void | Promise<void>;
  stopPending?: boolean;
}) {
  const titleId = useId();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionAnswerDraft[]>(() => createQuestionDrafts(props.request.questions));
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(props.request.requestId);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    setQuestionIndex(0);
    setDrafts(createQuestionDrafts(props.request.questions));
    responsePendingRef.current = false;
    setResponsePending(false);
    const frame = window.requestAnimationFrame(() => firstOptionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.request.requestId, props.request.questions]);

  const question = props.request.questions[questionIndex];
  if (!question) return null;
  const draft = drafts[questionIndex] ?? null;
  const selectedValue = draft?.kind === 'option'
    ? `option:${draft.optionIndex}`
    : draft?.kind === 'other' ? OTHER_VALUE : '';
  const interactionDisabled = Boolean(props.stopPending) || responsePending;
  const canContinue = canLeaveQuestion(draft) && !interactionDisabled;
  const isLast = questionIndex === props.request.questions.length - 1;

  function updateDraft(next: QuestionAnswerDraft) {
    setDrafts((current) => current.map((candidate, index) => index === questionIndex ? next : candidate));
  }

  function select(value: string) {
    if (value === OTHER_VALUE) {
      updateDraft(draft?.kind === 'other' ? draft : { kind: 'other', value: '' });
      return;
    }
    const optionIndex = Number(value.slice('option:'.length));
    updateDraft({ kind: 'option', optionIndex });
  }

  async function submit() {
    if (responsePendingRef.current || !canLeaveQuestion(draft)) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await props.onRespond(buildUserQuestionResponse(props.request, drafts));
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  return (
    <section
      className="maka-composer-interaction maka-user-question-prompt composer"
      role="region"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner agents-parchment-paper-surface">
        <header className="maka-permission-header">
          <div className="maka-permission-title-row">
            <h2 className="maka-permission-title" id={titleId}>{question.question}</h2>
            <span className="maka-question-progress">{questionIndex + 1} / {props.request.questions.length}</span>
          </div>
        </header>

        <ChoiceCardGroup
          aria-label={question.question}
          className="maka-question-options"
          value={selectedValue}
          onValueChange={select}
        >
          {question.options.map((option, optionIndex) => (
            <ChoiceCard
              ref={optionIndex === 0 ? firstOptionRef : undefined}
              className="maka-question-option"
              value={`option:${optionIndex}`}
              key={`${optionIndex}:${option.label}`}
              disabled={interactionDisabled}
            >
              <span className="maka-question-radio" aria-hidden="true" />
              <span className="maka-question-option-copy">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </ChoiceCard>
          ))}
          <ChoiceCard
            className="maka-question-option"
            value={OTHER_VALUE}
            disabled={interactionDisabled}
          >
            <span className="maka-question-radio" aria-hidden="true" />
            <span className="maka-question-option-copy">
              <strong>其他</strong>
              <small>输入一个不同的答案。</small>
            </span>
          </ChoiceCard>
        </ChoiceCardGroup>

        {draft?.kind === 'other' && (
          <Input
            autoFocus
            aria-label="其他答案"
            className="maka-question-other-input"
            placeholder="输入你的答案"
            value={draft.value}
            disabled={interactionDisabled}
            onChange={(event) => updateDraft({ kind: 'other', value: event.currentTarget.value })}
          />
        )}

        <footer className="permissionActions maka-question-actions">
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={props.stopPending}
            onClick={() => void props.onStop()}
          >
            {props.stopPending ? '停止中…' : '停止'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={questionIndex === 0 || interactionDisabled}
            onClick={() => setQuestionIndex((current) => current - 1)}
          >
            上一题
          </Button>
          <Button
            type="button"
            variant="default"
            size="md"
            disabled={!canContinue}
            onClick={() => isLast ? void submit() : setQuestionIndex((current) => current + 1)}
          >
            {responsePending ? '正在提交…' : isLast ? '提交答案' : '下一题'}
          </Button>
        </footer>
      </div>
    </section>
  );
}
