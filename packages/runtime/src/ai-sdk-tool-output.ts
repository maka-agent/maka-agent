import type { JSONValue } from 'ai';
import type { ToolModelOutput } from './tool-runtime.js';

/**
 * AI SDK 7 tool-result `output` wrapper: the provider-visible result of a tool
 * call, discriminated by type. Shared by the conversation backend (live turns)
 * and the history-compaction summarizer so both emit identical, schema-valid
 * tool-result content.
 */
export type AiSdkToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: JSONValue }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: JSONValue }
  | ToolModelOutput;

/**
 * Coerce an arbitrary tool result into a JSON-safe value (non-JSON scalars are
 * stringified). Used to satisfy the `{type:'json'|'error-json', value}` arms.
 */
export function jsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    typeof value === 'object'
  ) {
    return value as JSONValue;
  }
  return String(value);
}

/**
 * Wrap a raw tool result as the AI SDK 7 tool-result `output` content, choosing
 * the text vs json arm by value type and the error vs success arm by `isError`.
 */
export function toolResultOutput(value: unknown, isError: boolean): AiSdkToolResultOutput {
  if (isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value: jsonValue(value) };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value: jsonValue(value) };
}
