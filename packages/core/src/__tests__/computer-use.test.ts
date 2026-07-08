import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_TOOL_TYPE,
  COMPUTER_USE_BETA_HEADER,
  COMPUTER_USE_FRAME_MAX_BYTES,
  COMPUTER_USE_FRAME_SOURCE_KINDS,
  COMPUTER_USE_DISPATCH_TIERS,
  CU_ACTION_TYPES,
  CU_SCROLL_DIRECTIONS,
  isComputerUseErrorCode,
  exceedsComputerUseFrameCap,
  type CuAction,
  type ComputerUseActionOutcome,
  type ComputerUseScreenFrame,
} from '../computer-use.js';

describe('Computer Use core types (PR-CORE-CU-0)', () => {
  test('S17 closed error enum is exactly the 8 gated codes', () => {
    // Adding/removing a code here is a deliberate contract change and must be
    // mirrored in smoke.md Path 18 S17. Lock it.
    expect([...COMPUTER_USE_ERROR_CODES]).toEqual([
      'permission_missing',
      'overlay_failed',
      'invalid_coordinate',
      'capture_failed',
      'sensitivity_blocked',
      'unsupported_action',
      'aborted',
      'timeout',
    ]);
  });

  test('isComputerUseErrorCode accepts every gated code and rejects others', () => {
    for (const code of COMPUTER_USE_ERROR_CODES) {
      expect(isComputerUseErrorCode(code)).toBe(true);
    }
    expect(isComputerUseErrorCode('success')).toBe(false);
    expect(isComputerUseErrorCode('')).toBe(false);
    expect(isComputerUseErrorCode(undefined)).toBe(false);
    expect(isComputerUseErrorCode(42)).toBe(false);
  });

  test('S15b frame cap is 2 MB and the boundary predicate is exclusive', () => {
    expect(COMPUTER_USE_FRAME_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(exceedsComputerUseFrameCap(COMPUTER_USE_FRAME_MAX_BYTES)).toBe(false);
    expect(exceedsComputerUseFrameCap(COMPUTER_USE_FRAME_MAX_BYTES + 1)).toBe(true);
    expect(exceedsComputerUseFrameCap(0)).toBe(false);
  });

  test('frame source kinds are the two S15b-distinguished sources', () => {
    expect([...COMPUTER_USE_FRAME_SOURCE_KINDS]).toEqual(['live-capture', 'cached-still']);
  });

  test('dispatch ladder is ordered clean→fragile→degraded', () => {
    // The runner reports which rung ran so degradation is never silent.
    expect([...COMPUTER_USE_DISPATCH_TIERS]).toEqual([
      'ax',
      'coordinate-background',
      'foreground-visible',
    ]);
  });

  test('normalized action vocabulary matches computer_20251124 (minus OS-only variants)', () => {
    expect(CU_ACTION_TYPES).toHaveLength(17);
    for (const t of [
      'screenshot',
      'left_click',
      'double_click',
      'triple_click',
      'left_click_drag',
      'type',
      'key',
      'hold_key',
      'scroll',
      'wait',
      'zoom',
    ]) {
      expect(CU_ACTION_TYPES.includes(t as (typeof CU_ACTION_TYPES)[number])).toBe(true);
    }
    expect([...CU_SCROLL_DIRECTIONS]).toEqual(['up', 'down', 'left', 'right']);
  });

  test('model tool contract constants are pinned to the Opus-4.8 generation', () => {
    expect(COMPUTER_USE_TOOL_TYPE).toBe('computer_20251124');
    expect(COMPUTER_USE_BETA_HEADER).toBe('computer-use-2025-11-24');
  });

  test('CuAction discriminated union constructs the load-bearing shapes', () => {
    // Compile-time coverage; the runtime asserts keep the shapes honest.
    const click: CuAction = { type: 'left_click', coordinate: { x: 10, y: 20 }, text: 'super' };
    const drag: CuAction = {
      type: 'left_click_drag',
      startCoordinate: { x: 1, y: 2 },
      coordinate: { x: 3, y: 4 },
    };
    const scroll: CuAction = {
      type: 'scroll',
      coordinate: { x: 5, y: 6 },
      scrollDirection: 'down',
      scrollAmount: 3,
    };
    expect(click.type).toBe('left_click');
    expect(drag.type).toBe('left_click_drag');
    expect(scroll.type).toBe('scroll');
  });

  test('ComputerUseActionOutcome encodes success-with-tier and typed failure', () => {
    const frame: ComputerUseScreenFrame = {
      actionId: 'act-1',
      sourceKind: 'live-capture',
      mimeType: 'image/png',
      widthPx: 1280,
      heightPx: 800,
      byteLength: 1024,
      capturedAt: 0,
    };
    const ok: ComputerUseActionOutcome = { ok: true, tier: 'ax', verified: true, frame };
    const err: ComputerUseActionOutcome = {
      ok: false,
      error: 'permission_missing',
      message: 'accessibility not granted at action-start',
      completedSubSteps: 0,
    };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(isComputerUseErrorCode(err.error)).toBe(true);
    if (ok.ok) expect(ok.frame?.sourceKind).toBe('live-capture');
  });
});
