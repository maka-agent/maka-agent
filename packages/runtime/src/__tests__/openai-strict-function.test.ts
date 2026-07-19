import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOpenAIStrictObjectSchema,
  projectOpenAIStrictFunctionArgs,
} from '../openai-strict-function.js';

const knownKeys = [
  'action',
  'app',
  'window_id',
  'include_screenshot',
  'observation_id',
  'element_id',
  'value',
] as const;
const allowedKeysByAction = {
  list_apps: ['action'],
  observe: ['action', 'app', 'window_id', 'include_screenshot'],
  click_element: ['action', 'observation_id', 'element_id'],
  set_value: ['action', 'observation_id', 'element_id', 'value'],
} as const;

test('OpenAI strict object schemas require every nullable property', () => {
  const schema = createOpenAIStrictObjectSchema({
    properties: {
      action: { type: 'string', enum: ['list_apps', 'observe'] },
      app: { type: 'string' },
      coordinate: {
        type: 'array',
        items: { type: 'integer' },
      },
    },
  });
  assert.deepEqual(schema.required, ['action', 'app', 'coordinate']);
  assert.deepEqual((schema.properties as Record<string, unknown>).app, {
    type: ['string', 'null'],
  });
  assert.deepEqual((schema.properties as Record<string, unknown>).coordinate, {
    type: ['array', 'null'],
    items: { type: 'integer' },
  });
});

test('strict function projection drops only known irrelevant non-null fields', () => {
  assert.deepEqual(
    projectOpenAIStrictFunctionArgs({
      value: {
        action: 'set_value',
        app: 'pid:42',
        window_id: 7,
        include_screenshot: null,
        observation_id: 'obs-1',
        element_id: 'field-1',
        value: 'next',
      },
      knownKeys,
      allowedKeysByAction,
    }),
    {
      args: {
        action: 'set_value',
        observation_id: 'obs-1',
        element_id: 'field-1',
        value: 'next',
      },
      discardedKeys: ['app', 'window_id'],
    },
  );
});

test('strict function projection rejects unknown keys, accessors, and actions', () => {
  assert.throws(
    () =>
      projectOpenAIStrictFunctionArgs({
        value: { action: 'observe', surprise: true },
        knownKeys,
        allowedKeysByAction,
      }),
    /unknown_keys:surprise/,
  );

  const accessor = { action: 'observe' };
  Object.defineProperty(accessor, 'app', {
    enumerable: true,
    get() {
      throw new Error('must not run');
    },
  });
  assert.throws(
    () =>
      projectOpenAIStrictFunctionArgs({
        value: accessor,
        knownKeys,
        allowedKeysByAction,
      }),
    /not_data_property:app/,
  );

  assert.throws(
    () =>
      projectOpenAIStrictFunctionArgs({
        value: { action: 'left_click' },
        knownKeys,
        allowedKeysByAction,
      }),
    /unknown_action:left_click/,
  );
});
