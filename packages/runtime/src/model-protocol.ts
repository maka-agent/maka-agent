/**
 * Maka-owned provider-boundary model protocol types.
 *
 * This module is the single seam where AI SDK message/value types cross into
 * Maka-owned territory. Runtime consumers (history projection, compaction,
 * context budget, request shape, the adapter itself) import these names from
 * here instead of importing `ai` directly, so that `ai`'s `ModelMessage` /
 * `JSONValue` shapes never leak past the `ModelAdapter` boundary.
 *
 * Per maka-agent/maka-agent#1381 (slice 1): define Maka-owned model message and
 * tool-value contracts; keep raw AI SDK types behind `ModelAdapter`. These are
 * type aliases to the AI SDK shapes today — the boundary is established by
 * ownership of the import site, not by re-deriving the union. A later slice may
 * replace the alias with a Maka-defined union once the lowering path is fully
 * owned, but that is out of scope for the seam.
 *
 * Schema helpers (`jsonSchema` / `zodSchema`) and SDK value imports
 * (`generateText`, `RetryError`, ...) remain local implementation details or
 * follow-up work (RFC #1381 follow-up Q2/Q4); they do not belong on this
 * boundary.
 */
import type { ModelMessage as AiModelMessage, JSONValue as AiJsonValue } from 'ai';

/**
 * The canonical provider-boundary message shape. One arm per role, matching
 * the AI SDK `ModelMessage` union used by `streamText` / `generateText`.
 */
export type ModelMessage = AiModelMessage;

/**
 * JSON value used in tool input/output and tool-result content. Owned here so
 * tool-output and pruning consumers do not import `ai` for it.
 */
export type JSONValue = AiJsonValue;
