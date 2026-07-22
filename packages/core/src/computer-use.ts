/**
 * Provider-neutral Computer Use contract.
 *
 * This module owns the closed action vocabulary and its decode, approval,
 * public projection, and remember-scope semantics. It does not select a
 * provider, capture a screen, or dispatch input.
 */

import { redactSecrets } from './redaction.js';

export const COMPUTER_USE_ERROR_CODES = [
  'permission_missing',
  'permission_pending',
  'policy_denied',
  'policy_forbidden',
  'invalid_coordinate',
  'capture_failed',
  'sensitivity_blocked',
  'unsupported_action',
  'aborted',
  'timeout',
  'no_active_frame',
  'no_active_session',
  'stale_frame',
  'stale_epoch',
  'target_missing',
  'ambiguous_target',
  'target_changed',
  'target_occluded',
  'page_target_changed',
  'duplicate_action',
  'user_intervened',
  'reobserve_required',
  'screen_locked',
  'blocked_url',
  'user_stopped',
  'service_unavailable',
  'service_mismatch',
  'outcome_unknown',
] as const;

export type ComputerUseErrorCode = (typeof COMPUTER_USE_ERROR_CODES)[number];

export function isComputerUseErrorCode(value: unknown): value is ComputerUseErrorCode {
  return (
    typeof value === 'string' && (COMPUTER_USE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface CuPoint {
  x: number;
  y: number;
}

export interface CuRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ComputerUseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerUseFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface ComputerUseDisplayIdentity {
  displayId: string;
  logicalBounds: ComputerUseRect;
  sourceBoundsPx: ComputerUseRect;
  scaleFactor: number;
}

export interface ComputerUsePageIdentity {
  cdpPort: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
  documentFingerprint?: string;
}

export interface ComputerUseWindowIdentity {
  pid: number;
  windowId: number;
  bundleId?: string;
  appName?: string;
  title?: string;
  bounds?: ComputerUseRect;
  sourceBoundsPx?: ComputerUseRect;
  zIndex?: number;
  contentFingerprint?: string;
  page?: ComputerUsePageIdentity;
}

export interface ComputerUseObservationIdentity extends ComputerUseFrameIdentity {
  capturedAt: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays: ComputerUseDisplayIdentity[];
  target: ComputerUseWindowIdentity;
}

export interface ComputerUseBoundAction extends ComputerUseFrameIdentity {
  actionFingerprint: string;
  target: ComputerUseWindowIdentity;
  display?: ComputerUseDisplayIdentity;
  elementId?: string;
  sourceCoordinate?: CuPoint;
  sourceStartCoordinate?: CuPoint;
  windowCoordinate?: CuPoint;
  windowStartCoordinate?: CuPoint;
  coordinateSpace?: 'window-screenshot-local';
}

export const CU_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type CuScrollDirection = (typeof CU_SCROLL_DIRECTIONS)[number];

export const CU_ACTION_TYPES = [
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'hold_key',
  'scroll',
  'wait',
  'zoom',
] as const;

export const COMPUTER_USE_ACTION_TYPES = CU_ACTION_TYPES;
export type CuActionType = (typeof CU_ACTION_TYPES)[number];

export type CuAction =
  | { type: 'screenshot' }
  | { type: 'cursor_position' }
  | { type: 'mouse_move'; coordinate: CuPoint }
  | { type: 'left_click'; coordinate: CuPoint; text?: string }
  | { type: 'right_click'; coordinate: CuPoint; text?: string }
  | { type: 'middle_click'; coordinate: CuPoint; text?: string }
  | { type: 'double_click'; coordinate: CuPoint; text?: string }
  | { type: 'triple_click'; coordinate: CuPoint; text?: string }
  | { type: 'left_mouse_down'; coordinate: CuPoint }
  | { type: 'left_mouse_up'; coordinate: CuPoint }
  | { type: 'left_click_drag'; startCoordinate: CuPoint; coordinate: CuPoint; text?: string }
  | { type: 'type'; text: string }
  | { type: 'key'; text: string }
  | { type: 'hold_key'; text: string; durationMs: number }
  | {
      type: 'scroll';
      coordinate: CuPoint;
      scrollDirection: CuScrollDirection;
      scrollAmount: number;
      text?: string;
    }
  | { type: 'wait'; durationMs: number }
  | { type: 'zoom'; region: CuRegion };

export const COMPUTER_USE_FRAME_SOURCE_KINDS = ['live-capture'] as const;
export type ComputerUseFrameSourceKind = (typeof COMPUTER_USE_FRAME_SOURCE_KINDS)[number];

export interface ComputerUseScreenFrame {
  actionId: string;
  sourceKind: ComputerUseFrameSourceKind;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
  capturedAt: number;
}

export const COMPUTER_USE_DISPATCH_TIERS = [
  'ax',
  'semantic-background',
  'coordinate-background',
] as const;

export type ComputerUseDispatchTier = (typeof COMPUTER_USE_DISPATCH_TIERS)[number];

export const COMPUTER_USE_EFFECTS = ['confirmed', 'unverifiable', 'suspected_noop'] as const;

export type ComputerUseEffect = (typeof COMPUTER_USE_EFFECTS)[number];

export interface ComputerUseDispatchEvidence {
  effect?: ComputerUseEffect;
  reason?: string;
}

export type ComputerUseActionOutcome =
  | {
      ok: true;
      mutation: false;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation?: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: true;
      mutation: true;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      message: string;
      evidence?: ComputerUseDispatchEvidence;
      completedSubSteps?: number;
    };

/**
 * Approval is a capability gate, not proof that an action is fresh or valid.
 * Runtime must still establish an active observation and validate the target.
 */
export const COMPUTER_USE_APPROVAL_CLASSES = [
  'metadata_read',
  'screenshot_read',
  'pointer_mutation',
  'keyboard_mutation',
  'semantic_mutation',
] as const;

export type ComputerUseApprovalClass = (typeof COMPUTER_USE_APPROVAL_CLASSES)[number];

export type ComputerUseIntentValidationReason = 'unknown_action' | 'malformed_action';

export class ComputerUseIntentValidationError extends Error {
  constructor(
    readonly reason: ComputerUseIntentValidationReason,
    message: string,
  ) {
    super(message);
    this.name = 'ComputerUseIntentValidationError';
  }
}

type ComputerUseTarget = Readonly<{ app: string; windowId: number }>;

export interface ComputerUseElementIdentity {
  readonly token?: string;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
}

type ComputerUseExecutionIntent =
  | { readonly action: 'list_apps' }
  | {
      readonly action: 'observe';
      readonly app?: string;
      readonly window_id?: number;
      readonly include_screenshot: boolean;
    }
  | { readonly action: 'screenshot'; readonly app?: string; readonly window_id?: number }
  | { readonly action: 'cursor_position' }
  | { readonly action: 'wait'; readonly duration: number }
  | {
      readonly action: 'click_element';
      readonly observation_id: string;
      readonly element_id: string;
    }
  | {
      readonly action: 'set_value';
      readonly observation_id: string;
      readonly element_id: string;
      readonly value: string;
    }
  | {
      readonly action: 'select_text' | 'secondary_action';
      readonly observation_id: string;
      readonly element_id: string;
      readonly text: string;
    }
  | {
      readonly action: 'press_key' | 'type' | 'key';
      readonly observation_id: string;
      readonly text: string;
    }
  | {
      readonly action: 'hold_key';
      readonly observation_id: string;
      readonly text: string;
      readonly duration: number;
    }
  | {
      readonly action: 'mouse_move' | 'left_mouse_down' | 'left_mouse_up';
      readonly observation_id: string;
      readonly coordinate: readonly [number, number];
    }
  | {
      readonly action:
        | 'left_click'
        | 'right_click'
        | 'middle_click'
        | 'double_click'
        | 'triple_click';
      readonly observation_id: string;
      readonly coordinate: readonly [number, number];
      readonly text?: string;
    }
  | {
      readonly action: 'left_click_drag';
      readonly observation_id: string;
      readonly start_coordinate: readonly [number, number];
      readonly coordinate: readonly [number, number];
      readonly text?: string;
    }
  | {
      readonly action: 'scroll';
      readonly observation_id: string;
      readonly coordinate: readonly [number, number];
      readonly scroll_direction: CuScrollDirection;
      readonly scroll_amount: number;
      readonly text?: string;
    }
  | {
      readonly action: 'zoom';
      readonly observation_id: string;
      readonly region: readonly [number, number, number, number];
    };

export type ComputerUseApprovalAction = ComputerUseExecutionIntent['action'];

type ComputerUseElementAction = Extract<
  ComputerUseExecutionIntent,
  { readonly action: 'click_element' | 'set_value' | 'select_text' | 'secondary_action' }
>;
type ComputerUseMutationAction = Exclude<
  ComputerUseExecutionIntent,
  { readonly action: 'list_apps' | 'observe' | 'screenshot' | 'cursor_position' | 'wait' }
>;

type ComputerUseIntentFor<E extends ComputerUseExecutionIntent> =
  E extends ComputerUseMutationAction
    ? Readonly<{
        execution: Readonly<E>;
        target: ComputerUseTarget;
      }> &
        (E extends ComputerUseElementAction
          ? Readonly<{ elementIdentity: Readonly<ComputerUseElementIdentity> }>
          : Readonly<Record<never, never>>)
    : Readonly<{ execution: Readonly<E> }>;

type NarrowComputerUseExecutionIntent<Action extends ComputerUseApprovalAction> =
  ComputerUseExecutionIntent extends infer Intent
    ? Intent extends { readonly action: infer SupportedAction }
      ? Action extends SupportedAction
        ? Omit<Intent, 'action'> & Readonly<{ action: Action }>
        : never
      : never
    : never;

type ComputerUseIntentForAction<Action extends ComputerUseApprovalAction> = ComputerUseIntentFor<
  NarrowComputerUseExecutionIntent<Action>
>;

export type ComputerUseIntent = ComputerUseIntentFor<ComputerUseExecutionIntent>;

type ComputerUseActionOnlyApprovalAction = 'list_apps' | 'cursor_position' | 'wait';
type ComputerUseTargetMutationApprovalAction = Exclude<
  ComputerUseApprovalAction,
  ComputerUseActionOnlyApprovalAction | 'observe' | 'screenshot'
>;

type ComputerUsePublicApprovalReviewFor<Action extends ComputerUseApprovalAction> =
  Action extends ComputerUseActionOnlyApprovalAction
    ? {
        readonly kind: 'computer_use';
        readonly action: Action;
      }
    : Action extends 'observe'
      ? {
          readonly kind: 'computer_use';
          readonly action: 'observe';
          readonly app?: string;
          readonly windowId?: number;
          readonly includeScreenshot: boolean;
        }
      : Action extends 'screenshot'
        ? {
            readonly kind: 'computer_use';
            readonly action: 'screenshot';
            readonly app?: string;
            readonly windowId?: number;
          }
        : Action extends ComputerUseTargetMutationApprovalAction
          ? {
              readonly kind: 'computer_use';
              readonly action: Action;
              readonly app: string;
              readonly windowId: number;
            }
          : never;

export type ComputerUsePublicApprovalReview = {
  [Action in ComputerUseApprovalAction]: ComputerUsePublicApprovalReviewFor<Action>;
}[ComputerUseApprovalAction];

type ComputerUseRememberRule = 'always' | 'never' | 'target' | 'observed_target';
type ComputerUsePublicShape = 'action_only' | 'observe' | 'optional_target' | 'required_target';
type ComputerUsePublicShapeFor<Action extends ComputerUseApprovalAction> =
  Action extends ComputerUseActionOnlyApprovalAction
    ? 'action_only'
    : Action extends 'observe'
      ? 'observe'
      : Action extends 'screenshot'
        ? 'optional_target'
        : 'required_target';

interface ComputerUseActionDefinition<
  Action extends ComputerUseApprovalAction = ComputerUseApprovalAction,
> {
  readonly action: Action;
  readonly publicShape: ComputerUsePublicShapeFor<Action>;
  readonly rememberRule: ComputerUseRememberRule;
  readonly decodeIntent: (record: Record<string, unknown>) => ComputerUseIntentForAction<Action>;
  readonly approvalClass: (review: ComputerUsePublicApprovalReview) => ComputerUseApprovalClass;
  readonly projectPublic: (intent: ComputerUseIntent) => ComputerUsePublicApprovalReview;
  readonly decodePublic: (record: Record<string, unknown>) => ComputerUsePublicApprovalReview;
  readonly scopeMaterial: (intent: ComputerUseIntent) => readonly unknown[] | undefined;
}

type ComputerUseActionRegistry = {
  readonly [Action in ComputerUseApprovalAction]: ComputerUseActionDefinition<Action>;
};

const ID_MAX_BYTES = 256;
const APP_MAX_BYTES = 512;
const TEXT_MAX_BYTES = 8_000;
const ELEMENT_TEXT_MAX_BYTES = 4_096;
const PUBLIC_TEXT_MAX_BYTES = 256;
const UTF8_ENCODER = new TextEncoder();
const UNSAFE_PUBLIC_TEXT_CHARACTER =
  /[\u0000-\u001F\u007F-\u009F\p{Bidi_Control}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

function defineAction<Action extends ComputerUseApprovalAction>(
  action: Action,
  decodeIntent: ComputerUseActionDefinition<Action>['decodeIntent'],
  approvalClass: ComputerUseApprovalClass | ComputerUseActionDefinition<Action>['approvalClass'],
  remember: ComputerUseRememberRule,
  publicShape: ComputerUsePublicShapeFor<Action>,
): ComputerUseActionDefinition<Action> {
  const resolveApprovalClass =
    typeof approvalClass === 'function' ? approvalClass : () => approvalClass;
  return {
    action,
    publicShape,
    rememberRule: remember,
    decodeIntent,
    approvalClass: resolveApprovalClass,
    projectPublic(intent) {
      return projectPublicComputerUseIntent(action, publicShape, intent);
    },
    decodePublic(record) {
      return decodePublicComputerUseReview(action, publicShape, record);
    },
    scopeMaterial(intent) {
      if (remember === 'never') return undefined;
      const review = projectPublicComputerUseIntent(action, publicShape, intent);
      const approval = resolveApprovalClass(review);
      if (remember === 'always') return [action, approval];
      const target = targetFromIntent(intent);
      if (target === undefined) return undefined;
      if (remember === 'target') {
        return [action, approval, target.app ?? null, target.windowId ?? null];
      }
      const observationId = observationIdFromIntent(intent);
      return observationId === undefined
        ? undefined
        : [action, approval, target.app, target.windowId, observationId];
    },
  };
}

const COMPUTER_USE_ACTION_REGISTRY: ComputerUseActionRegistry = {
  list_apps: defineAction(
    'list_apps',
    decodeNoArgumentAction('list_apps'),
    'metadata_read',
    'always',
    'action_only',
  ),
  observe: defineAction(
    'observe',
    decodeObserveIntent,
    (review) =>
      review.action === 'observe' && review.includeScreenshot ? 'screenshot_read' : 'metadata_read',
    'target',
    'observe',
  ),
  screenshot: defineAction(
    'screenshot',
    decodeTargetReadAction('screenshot'),
    'screenshot_read',
    'target',
    'optional_target',
  ),
  cursor_position: defineAction(
    'cursor_position',
    decodeNoArgumentAction('cursor_position'),
    'metadata_read',
    'never',
    'action_only',
  ),
  wait: defineAction('wait', decodeWaitIntent, 'metadata_read', 'never', 'action_only'),
  click_element: defineAction(
    'click_element',
    decodeElementAction('click_element'),
    'semantic_mutation',
    'observed_target',
    'required_target',
  ),
  set_value: defineAction(
    'set_value',
    decodeElementAction('set_value'),
    'semantic_mutation',
    'observed_target',
    'required_target',
  ),
  select_text: defineAction(
    'select_text',
    decodeElementAction('select_text'),
    'semantic_mutation',
    'observed_target',
    'required_target',
  ),
  secondary_action: defineAction(
    'secondary_action',
    decodeElementAction('secondary_action'),
    'semantic_mutation',
    'observed_target',
    'required_target',
  ),
  press_key: defineAction(
    'press_key',
    decodeKeyboardAction('press_key'),
    'keyboard_mutation',
    'observed_target',
    'required_target',
  ),
  type: defineAction(
    'type',
    decodeKeyboardAction('type'),
    'keyboard_mutation',
    'observed_target',
    'required_target',
  ),
  key: defineAction(
    'key',
    decodeKeyboardAction('key'),
    'keyboard_mutation',
    'observed_target',
    'required_target',
  ),
  hold_key: defineAction(
    'hold_key',
    decodeHoldKeyIntent,
    'keyboard_mutation',
    'observed_target',
    'required_target',
  ),
  mouse_move: defineAction(
    'mouse_move',
    decodeCoordinateAction('mouse_move'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  left_click: defineAction(
    'left_click',
    decodePointerAction('left_click'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  right_click: defineAction(
    'right_click',
    decodePointerAction('right_click'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  middle_click: defineAction(
    'middle_click',
    decodePointerAction('middle_click'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  double_click: defineAction(
    'double_click',
    decodePointerAction('double_click'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  triple_click: defineAction(
    'triple_click',
    decodePointerAction('triple_click'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  left_mouse_down: defineAction(
    'left_mouse_down',
    decodeCoordinateAction('left_mouse_down'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  left_mouse_up: defineAction(
    'left_mouse_up',
    decodeCoordinateAction('left_mouse_up'),
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  left_click_drag: defineAction(
    'left_click_drag',
    decodeDragIntent,
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  scroll: defineAction(
    'scroll',
    decodeScrollIntent,
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
  zoom: defineAction(
    'zoom',
    decodeZoomIntent,
    'pointer_mutation',
    'observed_target',
    'required_target',
  ),
};

export const COMPUTER_USE_APPROVAL_ACTIONS: readonly ComputerUseApprovalAction[] = Object.freeze(
  Object.keys(COMPUTER_USE_ACTION_REGISTRY) as ComputerUseApprovalAction[],
);

export function decodeComputerUseIntent(value: unknown): ComputerUseIntent {
  const record = requirePlainRecord(value, 'Computer Use intent');
  const action = record.action;
  if (typeof action !== 'string' || !Object.hasOwn(COMPUTER_USE_ACTION_REGISTRY, action)) {
    throw new ComputerUseIntentValidationError(
      'unknown_action',
      'Computer Use action is not supported',
    );
  }
  try {
    const definition = definitionForAction(action as ComputerUseApprovalAction);
    return deepFreezeComputerIntent(definition.decodeIntent(record));
  } catch (error) {
    if (error instanceof ComputerUseIntentValidationError) throw error;
    throw new ComputerUseIntentValidationError(
      'malformed_action',
      error instanceof Error ? error.message : 'Computer Use action is malformed',
    );
  }
}

export function computerUseExecutionArgs(intent: ComputerUseIntent): ComputerUseExecutionIntent {
  return intent.execution;
}

export function computerUseApprovalClass(intent: ComputerUseIntent): ComputerUseApprovalClass {
  const definition = definitionForIntent(intent);
  const review = definition.projectPublic(intent);
  return definition.approvalClass(review);
}

export function projectComputerUsePublicApprovalReview(
  intent: ComputerUseIntent,
): ComputerUsePublicApprovalReview {
  return deepFreezeComputerIntent(definitionForIntent(intent).projectPublic(intent));
}

export function decodeComputerUsePublicApprovalReview(
  value: unknown,
): ComputerUsePublicApprovalReview {
  const record = requirePlainRecord(value, 'Computer Use public approval review');
  if (record.kind !== 'computer_use') malformed('Invalid Computer Use public review kind');
  const action = record.action;
  if (typeof action !== 'string' || !Object.hasOwn(COMPUTER_USE_ACTION_REGISTRY, action)) {
    throw new ComputerUseIntentValidationError(
      'unknown_action',
      'Computer Use public review action is not supported',
    );
  }
  const definition = definitionForAction(action as ComputerUseApprovalAction);
  return deepFreezeComputerIntent(definition.decodePublic(record));
}

export function computerUsePublicReviewApprovalClass(
  review: ComputerUsePublicApprovalReview,
): ComputerUseApprovalClass {
  const definition = definitionForAction(review.action);
  return definition.approvalClass(review);
}

export function computerUsePublicReviewRememberAllowed(
  review: ComputerUsePublicApprovalReview,
): boolean {
  return definitionForAction(review.action).rememberRule !== 'never';
}

/** @internal Scope material stays inside the turn-local permission owner. */
export function computerUseRememberScopeMaterial(
  intent: ComputerUseIntent,
): readonly unknown[] | undefined {
  return definitionForIntent(intent).scopeMaterial(intent);
}

function decodeNoArgumentAction<Action extends 'list_apps' | 'cursor_position'>(
  action: Action,
): ComputerUseActionDefinition<Action>['decodeIntent'] {
  return (record) => {
    requireFields(record, ['action']);
    return { execution: { action } } as ComputerUseIntentForAction<Action>;
  };
}

function decodeObserveIntent(
  record: Record<string, unknown>,
): ComputerUseIntentForAction<'observe'> {
  requireFields(record, ['action'], ['app', 'window_id', 'include_screenshot']);
  const target = decodeOptionalExecutionTarget(record);
  if (target.app === undefined && target.window_id === undefined) {
    malformed('Computer Use observe requires an app or window id');
  }
  if (record.include_screenshot !== undefined && typeof record.include_screenshot !== 'boolean') {
    malformed('Computer Use include_screenshot must be boolean');
  }
  return {
    execution: {
      action: 'observe',
      ...target,
      include_screenshot: record.include_screenshot !== false,
    },
  };
}

function decodeTargetReadAction(
  action: 'screenshot',
): ComputerUseActionDefinition<'screenshot'>['decodeIntent'] {
  return (record) => {
    requireFields(record, ['action'], ['app', 'window_id']);
    const target = decodeOptionalExecutionTarget(record);
    if (target.app === undefined && target.window_id === undefined) {
      malformed(`Computer Use ${action} requires an app or window id`);
    }
    return { execution: { action, ...target } };
  };
}

function decodeWaitIntent(record: Record<string, unknown>): ComputerUseIntentForAction<'wait'> {
  requireFields(record, ['action'], ['duration']);
  return {
    execution: {
      action: 'wait',
      duration: requireDuration(record.duration),
    },
  };
}

function decodeElementAction<
  Action extends 'click_element' | 'set_value' | 'select_text' | 'secondary_action',
>(action: Action): ComputerUseActionDefinition<Action>['decodeIntent'] {
  return (record) => {
    const valueField =
      action === 'set_value'
        ? 'value'
        : action === 'select_text' || action === 'secondary_action'
          ? 'text'
          : undefined;
    requireFields(
      record,
      ['action', 'observation_id', 'element_id', 'app', 'window_id', 'element_identity'],
      valueField === undefined ? [] : [valueField],
    );
    const common = decodeObservedMutation(record);
    const elementId = requireBoundedString(
      record.element_id,
      'Computer Use element id',
      ID_MAX_BYTES,
    );
    const elementIdentity = decodeElementIdentity(record.element_identity);
    const extra =
      valueField === undefined
        ? {}
        : {
            [valueField]: requireBoundedString(
              record[valueField],
              `Computer Use ${valueField}`,
              TEXT_MAX_BYTES,
              true,
            ),
          };
    return {
      execution: {
        action,
        observation_id: common.observationId,
        element_id: elementId,
        ...extra,
      },
      target: common.target,
      elementIdentity,
    } as unknown as ComputerUseIntentForAction<Action>;
  };
}

function decodeKeyboardAction<Action extends 'press_key' | 'type' | 'key'>(
  action: Action,
): ComputerUseActionDefinition<Action>['decodeIntent'] {
  return (record) => {
    requireFields(record, ['action', 'observation_id', 'text', 'app', 'window_id']);
    const common = decodeObservedMutation(record);
    return {
      execution: {
        action,
        observation_id: common.observationId,
        text: requireBoundedString(record.text, 'Computer Use key text', TEXT_MAX_BYTES),
      },
      target: common.target,
    } as ComputerUseIntentForAction<Action>;
  };
}

function decodeHoldKeyIntent(
  record: Record<string, unknown>,
): ComputerUseIntentForAction<'hold_key'> {
  requireFields(record, ['action', 'observation_id', 'text', 'app', 'window_id'], ['duration']);
  const common = decodeObservedMutation(record);
  return {
    execution: {
      action: 'hold_key',
      observation_id: common.observationId,
      text: requireBoundedString(record.text, 'Computer Use key text', TEXT_MAX_BYTES),
      duration: requireDuration(record.duration),
    },
    target: common.target,
  };
}

function decodeCoordinateAction<Action extends 'mouse_move' | 'left_mouse_down' | 'left_mouse_up'>(
  action: Action,
): ComputerUseActionDefinition<Action>['decodeIntent'] {
  return (record) => {
    requireFields(record, ['action', 'observation_id', 'coordinate', 'app', 'window_id']);
    const common = decodeObservedMutation(record);
    return {
      execution: {
        action,
        observation_id: common.observationId,
        coordinate: requireCoordinate(record.coordinate),
      },
      target: common.target,
    } as ComputerUseIntentForAction<Action>;
  };
}

function decodePointerAction<
  Action extends 'left_click' | 'right_click' | 'middle_click' | 'double_click' | 'triple_click',
>(action: Action): ComputerUseActionDefinition<Action>['decodeIntent'] {
  return (record) => {
    requireFields(record, ['action', 'observation_id', 'coordinate', 'app', 'window_id'], ['text']);
    const common = decodeObservedMutation(record);
    return {
      execution: {
        action,
        observation_id: common.observationId,
        coordinate: requireCoordinate(record.coordinate),
        ...optionalTextField(record, 'text'),
      },
      target: common.target,
    } as ComputerUseIntentForAction<Action>;
  };
}

function decodeDragIntent(
  record: Record<string, unknown>,
): ComputerUseIntentForAction<'left_click_drag'> {
  requireFields(
    record,
    ['action', 'observation_id', 'start_coordinate', 'coordinate', 'app', 'window_id'],
    ['text'],
  );
  const common = decodeObservedMutation(record);
  return {
    execution: {
      action: 'left_click_drag',
      observation_id: common.observationId,
      start_coordinate: requireCoordinate(record.start_coordinate),
      coordinate: requireCoordinate(record.coordinate),
      ...optionalTextField(record, 'text'),
    },
    target: common.target,
  };
}

function decodeScrollIntent(record: Record<string, unknown>): ComputerUseIntentForAction<'scroll'> {
  requireFields(
    record,
    ['action', 'observation_id', 'coordinate', 'app', 'window_id'],
    ['scroll_direction', 'scroll_amount', 'text'],
  );
  const common = decodeObservedMutation(record);
  const direction = record.scroll_direction === undefined ? 'down' : record.scroll_direction;
  if (!(CU_SCROLL_DIRECTIONS as readonly unknown[]).includes(direction)) {
    malformed('Invalid Computer Use scroll direction');
  }
  const amount = record.scroll_amount === undefined ? 3 : record.scroll_amount;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > 100) {
    malformed('Invalid Computer Use scroll amount');
  }
  return {
    execution: {
      action: 'scroll',
      observation_id: common.observationId,
      coordinate: requireCoordinate(record.coordinate),
      scroll_direction: direction as CuScrollDirection,
      scroll_amount: amount as number,
      ...optionalTextField(record, 'text'),
    },
    target: common.target,
  };
}

function decodeZoomIntent(record: Record<string, unknown>): ComputerUseIntentForAction<'zoom'> {
  requireFields(record, ['action', 'observation_id', 'region', 'app', 'window_id']);
  const common = decodeObservedMutation(record);
  return {
    execution: {
      action: 'zoom',
      observation_id: common.observationId,
      region: requireRegion(record.region),
    },
    target: common.target,
  };
}

function decodeObservedMutation(record: Record<string, unknown>): {
  readonly observationId: string;
  readonly target: ComputerUseTarget;
} {
  return {
    observationId: requireBoundedString(
      record.observation_id,
      'Computer Use observation id',
      ID_MAX_BYTES,
    ),
    target: {
      app: requireAppString(record.app),
      windowId: requirePositiveSafeInteger(record.window_id, 'Computer Use window id'),
    },
  };
}

function decodeElementIdentity(value: unknown): ComputerUseElementIdentity {
  const record = requirePlainRecord(value, 'Computer Use element identity');
  requireFields(record, ['role'], ['token', 'label', 'value']);
  return {
    ...(record.token === undefined
      ? {}
      : { token: requireBoundedString(record.token, 'Computer Use element token', ID_MAX_BYTES) }),
    role: requireBoundedString(record.role, 'Computer Use element role', ELEMENT_TEXT_MAX_BYTES),
    ...(record.label === undefined
      ? {}
      : {
          label: requireBoundedString(
            record.label,
            'Computer Use element label',
            ELEMENT_TEXT_MAX_BYTES,
            true,
          ),
        }),
    ...(record.value === undefined
      ? {}
      : {
          value: requireBoundedString(
            record.value,
            'Computer Use element value',
            ELEMENT_TEXT_MAX_BYTES,
            true,
          ),
        }),
  };
}

function projectPublicComputerUseIntent<Action extends ComputerUseApprovalAction>(
  action: Action,
  publicShape: ComputerUsePublicShapeFor<Action>,
  intent: ComputerUseIntent,
): ComputerUsePublicApprovalReviewFor<Action> {
  if (publicShape === 'action_only') {
    return { kind: 'computer_use', action } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  const target = targetFromIntent(intent);
  if (target === undefined) malformed('Computer Use action is missing its canonical target');
  if (publicShape === 'observe') {
    const execution = intent.execution as NarrowComputerUseExecutionIntent<'observe'>;
    return {
      kind: 'computer_use',
      action,
      ...(target.app === undefined ? {} : { app: projectPublicText(target.app) }),
      ...(target.windowId === undefined ? {} : { windowId: target.windowId }),
      includeScreenshot: execution.include_screenshot,
    } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  if (publicShape === 'optional_target') {
    return {
      kind: 'computer_use',
      action,
      ...(target.app === undefined ? {} : { app: projectPublicText(target.app) }),
      ...(target.windowId === undefined ? {} : { windowId: target.windowId }),
    } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  if (target.app === undefined || target.windowId === undefined) {
    malformed('Computer Use mutation is missing its canonical target');
  }
  return {
    kind: 'computer_use',
    action,
    app: projectPublicText(target.app),
    windowId: target.windowId,
  } as ComputerUsePublicApprovalReviewFor<Action>;
}

function decodePublicComputerUseReview<Action extends ComputerUseApprovalAction>(
  action: Action,
  publicShape: ComputerUsePublicShapeFor<Action>,
  record: Record<string, unknown>,
): ComputerUsePublicApprovalReviewFor<Action> {
  if (record.action !== action)
    malformed('Computer Use public review action does not match its descriptor');
  if (publicShape === 'action_only') {
    requireFields(record, ['kind', 'action']);
    return { kind: 'computer_use', action } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  if (publicShape === 'observe') {
    requireFields(record, ['kind', 'action', 'includeScreenshot'], ['app', 'windowId']);
    if (typeof record.includeScreenshot !== 'boolean') malformed('Invalid screenshot visibility');
    return {
      kind: 'computer_use',
      action,
      ...decodePublicTarget(record),
      includeScreenshot: record.includeScreenshot,
    } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  if (publicShape === 'optional_target') {
    requireFields(record, ['kind', 'action'], ['app', 'windowId']);
    return {
      kind: 'computer_use',
      action,
      ...decodePublicTarget(record),
    } as ComputerUsePublicApprovalReviewFor<Action>;
  }
  requireFields(record, ['kind', 'action', 'app', 'windowId']);
  return {
    kind: 'computer_use',
    action,
    app: requireCanonicalPublicText(record.app, 'Computer Use app'),
    windowId: requirePositiveSafeInteger(record.windowId, 'Computer Use window id'),
  } as ComputerUsePublicApprovalReviewFor<Action>;
}

function definitionForAction<Action extends ComputerUseApprovalAction>(
  action: Action,
): ComputerUseActionDefinition<Action> {
  return COMPUTER_USE_ACTION_REGISTRY[action];
}

function definitionForIntent(intent: ComputerUseIntent): ComputerUseActionDefinition {
  return definitionForAction(intent.execution.action) as ComputerUseActionDefinition;
}

function targetFromIntent(intent: ComputerUseIntent):
  | {
      readonly app?: string;
      readonly windowId?: number;
    }
  | undefined {
  if ('target' in intent) return intent.target;
  if (intent.execution.action !== 'observe' && intent.execution.action !== 'screenshot') {
    return undefined;
  }
  return {
    ...(intent.execution.app === undefined ? {} : { app: intent.execution.app }),
    ...(intent.execution.window_id === undefined ? {} : { windowId: intent.execution.window_id }),
  };
}

function observationIdFromIntent(intent: ComputerUseIntent): string | undefined {
  return 'observation_id' in intent.execution ? intent.execution.observation_id : undefined;
}

function decodeOptionalExecutionTarget(record: Record<string, unknown>): {
  readonly app?: string;
  readonly window_id?: number;
} {
  return {
    ...(record.app === undefined ? {} : { app: requireAppString(record.app) }),
    ...(record.window_id === undefined
      ? {}
      : { window_id: requirePositiveSafeInteger(record.window_id, 'Computer Use window id') }),
  };
}

function decodePublicTarget(record: Record<string, unknown>): {
  readonly app?: string;
  readonly windowId?: number;
} {
  if (record.app === undefined && record.windowId === undefined) {
    malformed('Computer Use public review requires a target');
  }
  return {
    ...(record.app === undefined
      ? {}
      : { app: requireCanonicalPublicText(record.app, 'Computer Use app') }),
    ...(record.windowId === undefined
      ? {}
      : { windowId: requirePositiveSafeInteger(record.windowId, 'Computer Use window id') }),
  };
}

function optionalTextField(
  record: Record<string, unknown>,
  key: 'text',
): Readonly<{ text?: string }> {
  return record[key] === undefined
    ? {}
    : { text: requireBoundedString(record[key], 'Computer Use text', TEXT_MAX_BYTES, true) };
}

function requireCoordinate(value: unknown): readonly [number, number] {
  const tuple = requireIntegerTuple(value, 2, 'Computer Use coordinate');
  return [tuple[0]!, tuple[1]!];
}

function requireRegion(value: unknown): readonly [number, number, number, number] {
  const tuple = requireIntegerTuple(value, 4, 'Computer Use region');
  return [tuple[0]!, tuple[1]!, tuple[2]!, tuple[3]!];
}

function requireIntegerTuple(value: unknown, length: number, label: string): readonly number[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1
  )
    malformed(`Invalid ${label}`);
  const tuple: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    )
      malformed(`Invalid ${label}`);
    tuple.push(descriptor.value);
  }
  return tuple;
}

function requireDuration(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60) {
    malformed('Invalid Computer Use duration');
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    !isWellFormedUnicode(value) ||
    UTF8_ENCODER.encode(value).byteLength > maxBytes
  )
    malformed(`Invalid ${label}`);
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) malformed(`Invalid ${label}`);
  return value as number;
}

function requireAppString(value: unknown): string {
  const app = requireBoundedString(value, 'Computer Use app', APP_MAX_BYTES);
  if (app.trim().length === 0 || UNSAFE_PUBLIC_TEXT_CHARACTER.test(app)) {
    malformed('Invalid Computer Use app');
  }
  return app;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    malformed(`${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      malformed(`${label} must contain only data properties`);
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
    malformed('Computer Use action has invalid fields');
}

function projectPublicText(value: string): string {
  if (!isWellFormedUnicode(value) || UNSAFE_PUBLIC_TEXT_CHARACTER.test(value)) {
    malformed('Computer Use public text is unsafe');
  }
  const normalized = redactSecrets(value).replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) malformed('Computer Use public text is empty');
  let projected = '';
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (bytes + characterBytes > PUBLIC_TEXT_MAX_BYTES) break;
    projected += character;
    bytes += characterBytes;
  }
  return projected;
}

function requireCanonicalPublicText(value: unknown, label: string): string {
  const text = requireBoundedString(value, label, PUBLIC_TEXT_MAX_BYTES);
  if (projectPublicText(text) !== text) malformed(`${label} is not canonical public text`);
  return text;
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

function deepFreezeComputerIntent<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeComputerIntent(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function malformed(message: string): never {
  throw new ComputerUseIntentValidationError('malformed_action', message);
}
