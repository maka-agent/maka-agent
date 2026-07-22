import assert from 'node:assert/strict';
import { createCanonicalToolIntent, type ToolCategory } from '@maka/core/permission';

import {
  PermissionEngine,
  type EvaluateInput,
  type EvaluateResult,
  type PermissionEngineDeps,
} from './permission-engine.js';

type TestPermissionIdentity = {
  toolName: string;
  args: unknown;
  cwd?: string;
  categoryHint?: ToolCategory;
};

export type TestPermissionInput =
  | (Omit<Extract<EvaluateInput, { stage: 'base' }>, 'intent' | 'stage'> &
      TestPermissionIdentity & { stage?: 'base' })
  | (Omit<Extract<EvaluateInput, { stage: 'additional_permissions' }>, 'intent'> &
      TestPermissionIdentity)
  | (Omit<Extract<EvaluateInput, { stage: 'sandbox_escalation' }>, 'intent'> &
      TestPermissionIdentity);

/** Test adapter that authenticates legacy-shaped fixture data at the test boundary. */
export class TestPermissionEngine extends PermissionEngine {
  constructor(
    deps: PermissionEngineDeps,
    private readonly defaultCwd = '/workspace',
  ) {
    super(deps);
  }

  override evaluate(input: EvaluateInput | TestPermissionInput): EvaluateResult {
    if ('intent' in input) return super.evaluate(input);
    const { toolName, args, cwd = this.defaultCwd, categoryHint } = input;
    const intent = createCanonicalToolIntent({
      toolName,
      args,
      cwd,
      ...(categoryHint === undefined ? {} : { categoryHint }),
    });
    if (input.stage === 'additional_permissions') {
      const {
        toolName: _toolName,
        args: _args,
        cwd: _cwd,
        categoryHint: _categoryHint,
        ...stage
      } = input;
      return super.evaluate({ ...stage, intent });
    }
    if (input.stage === 'sandbox_escalation') {
      const {
        toolName: _toolName,
        args: _args,
        cwd: _cwd,
        categoryHint: _categoryHint,
        ...stage
      } = input;
      return super.evaluate({ ...stage, intent });
    }
    const {
      toolName: _toolName,
      args: _args,
      cwd: _cwd,
      categoryHint: _categoryHint,
      ...base
    } = input;
    return super.evaluate({ ...base, stage: 'base', intent });
  }
}

export function expect(actual: unknown) {
  return {
    not: {
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
      toContain(expected: string) {
        assert.ok(
          !String(actual).includes(expected),
          `expected ${String(actual)} not to contain ${expected}`,
        );
      },
    },
    toBe(expected: unknown) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(actual, expected);
    },
    toBeCloseTo(expected: number, precision = 2) {
      assert.ok(Math.abs(Number(actual) - expected) < 10 ** -precision);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toContain(expected: string) {
      assert.ok(String(actual).includes(expected));
    },
    toHaveLength(expected: number) {
      assert.strictEqual((actual as { length: number }).length, expected);
    },
    toMatch(expected: RegExp) {
      assert.match(String(actual), expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      assert.deepStrictEqual(
        Object.fromEntries(
          Object.keys(expected).map((key) => [key, (actual as Record<string, unknown>)[key]]),
        ),
        expected,
      );
    },
  };
}
