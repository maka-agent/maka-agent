import {
  WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS,
  type PublicToolIntentReview,
} from '@maka/core';

export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}`);
}

/**
 * Adapts Core's closed public review into the established tool-card view model.
 * This is presentation data only; canonical execution arguments never reach UI.
 */
export function projectToolReviewPresentation(
  review: PublicToolIntentReview | undefined,
): unknown {
  if (review === undefined) return undefined;

  switch (review.kind) {
    case 'command':
      return { command: review.command, cwd: review.cwd };
    case 'path':
      return {
        path: review.path,
        cwd: review.cwd,
        operation: review.operation,
        ...(review.sortKeys === undefined ? {} : { sort_keys: review.sortKeys }),
      };
    case 'search':
      return {
        pattern: review.pattern,
        path: review.root,
        cwd: review.cwd,
        operation: review.operation,
        ...(review.operation === 'grep' && review.glob !== undefined
          ? { glob: review.glob }
          : {}),
      };
    case 'stdin':
      return {
        ref: review.ref,
        ...(review.input === undefined
          ? {}
          : {
              inputPreview: {
                text: Array.from(review.input.text)
                  .slice(0, WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS)
                  .join(''),
                bytes: review.input.bytes,
                truncated:
                  Array.from(review.input.text).length > WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS,
              },
            }),
        ...(review.size === undefined ? {} : { size: review.size }),
      };
    case 'web':
      return { [review.targetKind]: review.target };
    case 'browser':
      return projectBrowserReview(review);
    case 'patch':
      return { operation: review.operation, path: review.path, cwd: review.cwd };
    case 'agent':
      switch (review.operation) {
        case 'spawn':
          return {
            operation: review.operation,
            profile: review.profile,
            write_back: review.writeBack,
            isolation: review.isolation,
            ...(review.taskId === undefined ? {} : { task_id: review.taskId }),
          };
        case 'dispatch':
          return { operation: review.operation, member: review.member };
        case 'swarm':
          return [
            `${review.itemCount} ${review.itemCount === 1 ? 'task' : 'tasks'}`,
            `concurrency ${review.concurrency}`,
            ...(review.resumeCount > 0 ? [`resumed ${review.resumeCount}`] : []),
            ...(review.profiles.length > 0 ? [`profiles ${review.profiles.join(', ')}`] : []),
            ...(review.writeBack.length > 0
              ? [`write-back ${review.writeBack.join(', ')}`]
              : []),
            ...(review.isolation.length > 0
              ? [`isolation ${review.isolation.join(', ')}`]
              : []),
          ].join(' · ');
      }
      return assertNever(review, 'agent review operation');
    case 'runtime_resource':
      return { operation: review.operation, ref: review.ref };
    case 'skill':
      return { name: review.name };
    case 'question':
      return { questionCount: review.questionCount };
    case 'computer_use':
      return { ...review };
  }
  return assertNever(review, 'public tool review');
}

function projectBrowserReview(
  review: Extract<PublicToolIntentReview, { kind: 'browser' }>,
): Record<string, unknown> {
  switch (review.action) {
    case 'navigate':
      return { action: review.action, url: review.url };
    case 'snapshot':
      return { action: review.action };
    case 'click':
      return { action: review.action, ref: review.ref };
    case 'type':
      return {
        action: review.action,
        ref: review.ref,
        text: review.text,
        submit: review.submit,
      };
    case 'wait':
      return review.condition === 'duration'
        ? { action: review.action, condition: review.condition, seconds: review.seconds }
        : {
            action: review.action,
            condition: review.condition,
            value: review.value,
            timeoutSeconds: review.timeoutSeconds,
          };
    case 'extract':
      return {
        action: review.action,
        start: review.start,
        ...(review.selector === undefined ? {} : { selector: review.selector }),
      };
  }
  return assertNever(review, 'browser review action');
}
