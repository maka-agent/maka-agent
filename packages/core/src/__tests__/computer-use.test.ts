import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ComputerUseIntentValidationError,
  computerUseApprovalClass,
  computerUseExecutionArgs,
  computerUsePublicReviewApprovalClass,
  computerUsePublicReviewRememberAllowed,
  decodeComputerUseIntent,
  decodeComputerUsePublicApprovalReview,
  projectComputerUsePublicApprovalReview,
  type ComputerUseApprovalAction,
  type ComputerUseApprovalClass,
} from '../computer-use.js';
import { createCanonicalToolIntent } from '../permission.js';
import { canonicalToolExecutionArgs, projectPublicToolApprovalReview } from '../tool-intent.js';

const TARGET = {
  app: 'Editor',
  window_id: 7,
  observation_id: 'frame-private-7',
} as const;

const ELEMENT = {
  element_id: 'field-private-2',
  element_identity: {
    token: 'element-private-token',
    role: 'AXTextField',
    label: 'API token',
    value: 'token=old/private-value',
  },
} as const;

type ComputerUseActionCases = {
  readonly [Action in ComputerUseApprovalAction]: {
    readonly args: Record<string, unknown> & { readonly action: Action };
    readonly approvalClass: ComputerUseApprovalClass;
    readonly rememberAllowed: boolean;
  };
};

const ACTION_CASES = {
  list_apps: {
    args: { action: 'list_apps' },
    approvalClass: 'metadata_read',
    rememberAllowed: true,
  },
  observe: {
    args: { action: 'observe', app: 'Editor', include_screenshot: false },
    approvalClass: 'metadata_read',
    rememberAllowed: true,
  },
  screenshot: {
    args: { action: 'screenshot', app: 'Editor' },
    approvalClass: 'screenshot_read',
    rememberAllowed: true,
  },
  cursor_position: {
    args: { action: 'cursor_position' },
    approvalClass: 'metadata_read',
    rememberAllowed: false,
  },
  wait: { args: { action: 'wait' }, approvalClass: 'metadata_read', rememberAllowed: false },
  click_element: {
    args: { action: 'click_element', ...TARGET, ...ELEMENT },
    approvalClass: 'semantic_mutation',
    rememberAllowed: true,
  },
  set_value: {
    args: { action: 'set_value', ...TARGET, ...ELEMENT, value: 'private input' },
    approvalClass: 'semantic_mutation',
    rememberAllowed: true,
  },
  select_text: {
    args: { action: 'select_text', ...TARGET, ...ELEMENT, text: 'private selection' },
    approvalClass: 'semantic_mutation',
    rememberAllowed: true,
  },
  secondary_action: {
    args: { action: 'secondary_action', ...TARGET, ...ELEMENT, text: 'private action' },
    approvalClass: 'semantic_mutation',
    rememberAllowed: true,
  },
  press_key: {
    args: { action: 'press_key', ...TARGET, text: 'ENTER' },
    approvalClass: 'keyboard_mutation',
    rememberAllowed: true,
  },
  type: {
    args: { action: 'type', ...TARGET, text: 'private input' },
    approvalClass: 'keyboard_mutation',
    rememberAllowed: true,
  },
  key: {
    args: { action: 'key', ...TARGET, text: 'CMD+A' },
    approvalClass: 'keyboard_mutation',
    rememberAllowed: true,
  },
  hold_key: {
    args: { action: 'hold_key', ...TARGET, text: 'SHIFT' },
    approvalClass: 'keyboard_mutation',
    rememberAllowed: true,
  },
  mouse_move: {
    args: { action: 'mouse_move', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  left_click: {
    args: { action: 'left_click', ...TARGET, coordinate: [10, 20], text: 'private label' },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  right_click: {
    args: { action: 'right_click', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  middle_click: {
    args: { action: 'middle_click', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  double_click: {
    args: { action: 'double_click', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  triple_click: {
    args: { action: 'triple_click', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  left_mouse_down: {
    args: { action: 'left_mouse_down', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  left_mouse_up: {
    args: { action: 'left_mouse_up', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  left_click_drag: {
    args: { action: 'left_click_drag', ...TARGET, start_coordinate: [1, 2], coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  scroll: {
    args: { action: 'scroll', ...TARGET, coordinate: [10, 20] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
  zoom: {
    args: { action: 'zoom', ...TARGET, region: [1, 2, 30, 40] },
    approvalClass: 'pointer_mutation',
    rememberAllowed: true,
  },
} satisfies ComputerUseActionCases;

describe('Computer Use action registry', () => {
  test('decodes every supported action into execution, approval, and public semantics', () => {
    for (const [action, { args, approvalClass, rememberAllowed }] of Object.entries(ACTION_CASES)) {
      const intent = decodeComputerUseIntent(args);
      const execution = computerUseExecutionArgs(intent);
      const review = projectComputerUsePublicApprovalReview(intent);

      assert.equal(execution.action, action);
      assert.equal(computerUseApprovalClass(intent), approvalClass);
      assert.equal(review.action, action);
      assert.equal(computerUsePublicReviewApprovalClass(review), approvalClass);
      assert.equal(computerUsePublicReviewRememberAllowed(review), rememberAllowed);
      assert.deepEqual(
        decodeComputerUsePublicApprovalReview(JSON.parse(JSON.stringify(review))),
        review,
      );
      assert.ok(Object.isFrozen(intent));
      assert.ok(Object.isFrozen(execution));
      assert.ok(Object.isFrozen(review));
    }
  });

  test('normalizes execution defaults once in the canonical intent', () => {
    assert.deepEqual(
      computerUseExecutionArgs(
        decodeComputerUseIntent({
          action: 'observe',
          app: 'Editor',
        }),
      ),
      {
        action: 'observe',
        app: 'Editor',
        include_screenshot: true,
      },
    );
    assert.equal(
      computerUseApprovalClass(
        decodeComputerUseIntent({
          action: 'observe',
          window_id: 7,
        }),
      ),
      'screenshot_read',
    );
    assert.deepEqual(
      computerUseExecutionArgs(
        decodeComputerUseIntent({
          action: 'scroll',
          ...TARGET,
          coordinate: [10, 20],
        }),
      ),
      {
        action: 'scroll',
        observation_id: TARGET.observation_id,
        coordinate: [10, 20],
        scroll_direction: 'down',
        scroll_amount: 3,
      },
    );
    assert.deepEqual(
      computerUseExecutionArgs(
        decodeComputerUseIntent({
          action: 'hold_key',
          ...TARGET,
          text: 'SHIFT',
        }),
      ),
      {
        action: 'hold_key',
        observation_id: TARGET.observation_id,
        text: 'SHIFT',
        duration: 0,
      },
    );
  });

  test('keeps private execution and target facts in one frozen canonical intent', () => {
    const coordinate = [12, 34];
    const source = {
      action: 'left_click',
      ...TARGET,
      coordinate,
      text: 'token=new/private-value',
    };
    const intent = createCanonicalToolIntent({
      toolName: 'maka_computer',
      cwd: '/workspace',
      args: source,
    });

    coordinate[0] = 999;
    source.text = 'changed after canonicalization';

    assert.equal(intent.kind, 'computer_use');
    if (intent.kind !== 'computer_use') return;
    assert.deepEqual(canonicalToolExecutionArgs(intent), {
      action: 'left_click',
      observation_id: TARGET.observation_id,
      coordinate: [12, 34],
      text: 'token=new/private-value',
    });
    assert.ok('target' in intent.computerUse);
    if ('target' in intent.computerUse) {
      assert.deepEqual(intent.computerUse.target, { app: 'Editor', windowId: 7 });
    }
    assert.deepEqual(projectPublicToolApprovalReview(intent), {
      kind: 'computer_use',
      action: 'left_click',
      app: 'Editor',
      windowId: 7,
    });
    assert.ok(Object.isFrozen(intent));
    assert.ok(Object.isFrozen(intent.computerUse));
    assert.ok(Object.isFrozen(canonicalToolExecutionArgs(intent)));
  });

  test('projects secret-shaped app text without exposing private action material', () => {
    const intent = createCanonicalToolIntent({
      toolName: 'maka_computer',
      cwd: '/workspace',
      args: {
        action: 'set_value',
        ...TARGET,
        app: 'Editor token=app/private-value',
        ...ELEMENT,
        value: 'Authorization: Basic dXNlcjpwYXNz=',
      },
    });

    assert.deepEqual(projectPublicToolApprovalReview(intent), {
      kind: 'computer_use',
      action: 'set_value',
      app: 'Editor token=[redacted]',
      windowId: 7,
    });
    assert.deepEqual(canonicalToolExecutionArgs(intent), {
      action: 'set_value',
      observation_id: TARGET.observation_id,
      element_id: ELEMENT.element_id,
      value: 'Authorization: Basic dXNlcjpwYXNz=',
    });
  });

  test('bounds multibyte public app text without splitting Unicode', () => {
    const intent = decodeComputerUseIntent({
      action: 'observe',
      app: '界'.repeat(170),
      include_screenshot: false,
    });
    const review = projectComputerUsePublicApprovalReview(intent);

    assert.equal(review.action, 'observe');
    if (review.action !== 'observe') return;
    assert.ok(review.app);
    assert.ok(new TextEncoder().encode(review.app).byteLength <= 256);
    assert.deepEqual(
      decodeComputerUsePublicApprovalReview(JSON.parse(JSON.stringify(review))),
      review,
    );
  });

  test('rejects unknown, malformed, and unbound mutation actions before projection', () => {
    const malformed = [
      { action: 'future_action', app: 'Editor' },
      { action: 'observe' },
      { action: 'type', ...TARGET },
      { action: 'type', observation_id: 'frame-1', text: 'x' },
      { action: 'click_element', ...TARGET, ...ELEMENT, extra: true },
      { action: 'mouse_move', ...TARGET, coordinate: [1, -1] },
      { action: 'observe', app: '\uD800' },
      { action: 'observe', app: '   ' },
      { action: 'observe', app: 'Editor\u202Etxt' },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_direction: null },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_direction: 'diagonal' },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_amount: null },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_amount: '3' },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_amount: -1 },
      { action: 'scroll', ...TARGET, coordinate: [10, 20], scroll_amount: 101 },
    ];

    for (const value of malformed) {
      assert.throws(() => decodeComputerUseIntent(value), ComputerUseIntentValidationError);
    }
    assert.throws(
      () => decodeComputerUseIntent(malformed[0]),
      (error: unknown) =>
        error instanceof ComputerUseIntentValidationError && error.reason === 'unknown_action',
    );
  });

  test('rejects accessor-backed inputs without invoking private getters', () => {
    let reads = 0;
    const value = Object.defineProperty({}, 'action', {
      enumerable: true,
      get() {
        reads += 1;
        return 'list_apps';
      },
    });

    assert.throws(() => decodeComputerUseIntent(value), ComputerUseIntentValidationError);
    assert.equal(reads, 0);
  });

  test('rejects disguised sparse and accessor-backed coordinates without reading them', () => {
    const disguisedSparse = new Array(2);
    disguisedSparse[1] = 20;
    Object.defineProperty(disguisedSparse, Symbol('padding'), {
      value: 10,
      enumerable: true,
    });
    let reads = 0;
    const accessorCoordinate = [10, 20];
    Object.defineProperty(accessorCoordinate, '0', {
      enumerable: true,
      get() {
        reads += 1;
        return 10;
      },
    });

    for (const coordinate of [disguisedSparse, accessorCoordinate]) {
      assert.throws(
        () =>
          decodeComputerUseIntent({
            action: 'mouse_move',
            ...TARGET,
            coordinate,
          }),
        ComputerUseIntentValidationError,
      );
    }
    assert.equal(reads, 0);
  });

  test('public decoder rejects private scope and future action fields', () => {
    assert.throws(
      () =>
        decodeComputerUsePublicApprovalReview({
          kind: 'computer_use',
          action: 'type',
          app: 'Editor',
          windowId: 7,
          observationId: 'frame-private-7',
        }),
      ComputerUseIntentValidationError,
    );
    assert.throws(
      () =>
        decodeComputerUsePublicApprovalReview({
          kind: 'computer_use',
          action: 'future_action',
        }),
      ComputerUseIntentValidationError,
    );
  });
});
