export type OperationMode = 'command' | 'query' | 'control';
export type RetryPolicy = 'none' | 'safe' | 'semantic';
export type AdmissionClass = 'bootstrap' | 'ready' | 'session';

export type HostOperationErrorCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'authorization_in_progress'
  | 'capability_unavailable'
  | 'invalid_request'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'already_resolved'
  | 'controller_held'
  | 'controller_invalid'
  | 'resource_terminal'
  | 'outcome_unknown'
  | 'internal_failure';

export interface HostOperationError<C extends HostOperationErrorCode = HostOperationErrorCode> {
  code: C;
  message: string;
}

export interface OperationSpec<Input, Output, ErrorCode extends HostOperationErrorCode> {
  mode: OperationMode;
  decodeInput(value: unknown): Input;
  decodeOutput(value: unknown): Output;
  errors: readonly ErrorCode[];
  retry: RetryPolicy;
  admission: AdmissionClass;
}

type AnyOperationSpec = OperationSpec<unknown, unknown, HostOperationErrorCode>;
type AnyOperationSpecMap = Readonly<Record<string, AnyOperationSpec>>;
type DuplicateOperationKeys<Left, Right> = Extract<keyof Left, keyof Right>;
type RequireDisjointOperationKeys<Left, Right> = [DuplicateOperationKeys<Left, Right>] extends [
  never,
]
  ? unknown
  : {
      readonly duplicateOperationKeys: DuplicateOperationKeys<Left, Right>;
    };

export function defineOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: OperationSpec<Input, Output, ErrorCode>,
): OperationSpec<Input, Output, ErrorCode> {
  return spec;
}

export function composeOperationSpecMaps<
  const Left extends AnyOperationSpecMap,
  const Right extends AnyOperationSpecMap,
>(left: Left, right: Right & RequireDisjointOperationKeys<Left, Right>): Left & Right {
  const combined: Record<string, AnyOperationSpec> = { ...left };
  for (const key of Object.keys(right)) {
    if (Object.hasOwn(combined, key)) {
      throw new Error(`Duplicate Runtime Host operation key: ${key}`);
    }
    const spec = right[key];
    if (spec) combined[key] = spec;
  }
  return combined as Left & Right;
}
