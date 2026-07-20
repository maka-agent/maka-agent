export type InteractionStoreErrorCode =
  | 'invalid_input'
  | 'invalid_record'
  | 'request_not_found'
  | 'io_failed';

export class InteractionStoreError extends Error {
  constructor(
    readonly code: InteractionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InteractionStoreError';
  }
}

export function invalidInput(message: string, cause?: unknown): InteractionStoreError {
  return new InteractionStoreError(
    'invalid_input',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function invalidRecord(message: string, cause?: unknown): InteractionStoreError {
  return new InteractionStoreError(
    'invalid_record',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function ioFailed(message: string, cause?: unknown): InteractionStoreError {
  return new InteractionStoreError(
    'io_failed',
    message,
    cause === undefined ? undefined : { cause },
  );
}
