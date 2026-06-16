import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PrefixChangeReason } from '@maka/core/usage-stats/types';
import type { ModelMessage } from 'ai';
import { toJSONSchema } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export interface CanonicalToolSet {
  providerTools: MakaTool[];
  activeTools: string[];
}

export interface RequestShapeInput {
  connection: LlmConnection;
  modelId: string;
  systemPrompt?: string;
  providerOptions?: Record<string, unknown>;
  providerTools: readonly MakaTool[];
  activeTools: readonly string[];
  priorMessages: readonly ModelMessage[];
}

export interface RequestShapeComponents {
  modelProviderHash: string;
  systemPromptHash: string;
  providerOptionsHash: string;
  toolSchemaHash: string;
  historyProjectionHash: string;
}

export type DurablePrefixComponents = Omit<RequestShapeComponents, 'historyProjectionHash'>;

export interface RequestShapeDiagnostic {
  /** Durable provider prefix shape, excluding prior-history projection. */
  prefixHash: string;
  prefixChangeReason: PrefixChangeReason;
  /** Full request shape, including prior-history projection. */
  requestShapeHash: string;
  requestShapeChangeReason: PrefixChangeReason;
  componentHashes: RequestShapeComponents;
}

export function canonicalizeToolSet(
  tools: readonly MakaTool[],
  invalidTool: MakaTool,
): CanonicalToolSet {
  const visibleTools = tools
    .filter((tool) => tool.name !== invalidTool.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    providerTools: [...visibleTools, invalidTool],
    activeTools: visibleTools.map((tool) => tool.name),
  };
}

export function computeRequestShapeDiagnostic(
  input: RequestShapeInput,
  prior: RequestShapeDiagnostic | undefined,
): RequestShapeDiagnostic {
  const componentHashes: RequestShapeComponents = {
    modelProviderHash: stableHash({
      providerId: input.connection.providerType,
      connectionSlug: input.connection.slug,
      modelId: input.modelId,
    }),
    systemPromptHash: stableHash(input.systemPrompt ?? ''),
    providerOptionsHash: stableHash(input.providerOptions ?? {}),
    toolSchemaHash: stableHash({
      activeTools: [...input.activeTools],
      providerTools: input.providerTools.map(toolShapeForDiagnostics),
    }),
    historyProjectionHash: stableHash(input.priorMessages.map(messageShapeForHash)),
  };
  const durablePrefixComponents = durableComponents(componentHashes);
  const prefixHash = stableHash(durablePrefixComponents);
  const requestShapeHash = stableHash(componentHashes);
  return {
    prefixHash,
    prefixChangeReason: classifyDurablePrefixChange(
      durablePrefixComponents,
      prior ? durableComponents(prior.componentHashes) : undefined,
    ),
    requestShapeHash,
    requestShapeChangeReason: classifyRequestShapeChange(componentHashes, prior?.componentHashes),
    componentHashes,
  };
}

export function toolSchemaCharsForDiagnostics(
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
): number {
  return stableStringify({
    activeTools: [...activeTools],
    providerTools: providerTools.map(toolShapeForDiagnostics),
  }).length;
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function classifyDurablePrefixChange(
  current: DurablePrefixComponents,
  prior: DurablePrefixComponents | undefined,
): PrefixChangeReason {
  if (!prior) return 'first_turn';
  if (current.modelProviderHash !== prior.modelProviderHash) return 'model_or_provider_changed';
  if (current.systemPromptHash !== prior.systemPromptHash) return 'system_prompt_changed';
  if (current.toolSchemaHash !== prior.toolSchemaHash) return 'tool_schema_changed';
  if (current.providerOptionsHash !== prior.providerOptionsHash) return 'provider_options_changed';
  return 'stable';
}

function classifyRequestShapeChange(
  current: RequestShapeComponents,
  prior: RequestShapeComponents | undefined,
): PrefixChangeReason {
  if (!prior) return 'first_turn';
  if (current.modelProviderHash !== prior.modelProviderHash) return 'model_or_provider_changed';
  if (current.systemPromptHash !== prior.systemPromptHash) return 'system_prompt_changed';
  if (current.toolSchemaHash !== prior.toolSchemaHash) return 'tool_schema_changed';
  if (current.providerOptionsHash !== prior.providerOptionsHash) return 'provider_options_changed';
  if (current.historyProjectionHash !== prior.historyProjectionHash) return 'history_projection_changed';
  return 'stable';
}

function durableComponents(components: RequestShapeComponents): DurablePrefixComponents {
  return {
    modelProviderHash: components.modelProviderHash,
    systemPromptHash: components.systemPromptHash,
    providerOptionsHash: components.providerOptionsHash,
    toolSchemaHash: components.toolSchemaHash,
  };
}

function toolShapeForDiagnostics(tool: MakaTool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schemaShapeForHash(tool.parameters),
  };
}

function schemaShapeForHash(schema: unknown): unknown {
  if (isObjectLike(schema)) {
    try {
      return stripJsonSchemaRuntimeFields(toJSONSchema(schema as never, {
        io: 'input',
        target: 'draft-07',
        unrepresentable: 'any',
        cycles: 'ref',
        reused: 'inline',
      }));
    } catch {
      // Fall through to structural canonicalization for plain JSON-schema-like objects.
    }
  }
  return schema;
}

function stripJsonSchemaRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaRuntimeFields);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '~standard' || key === '$schema') continue;
    out[key] = stripJsonSchemaRuntimeFields(entry);
  }
  return out;
}

function messageShapeForHash(message: ModelMessage): unknown {
  const raw = message as unknown as { role?: unknown; content?: unknown };
  return {
    role: typeof raw.role === 'string' ? raw.role : 'unknown',
    content: contentShapeForHash(raw.content),
  };
}

function contentShapeForHash(content: unknown): unknown {
  if (typeof content === 'string') {
    return { type: 'text', chars: content.length };
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!isObjectLike(part)) return { type: typeof part };
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      return {
        type,
        ...(typeof part.toolName === 'string' ? { toolName: part.toolName } : {}),
        ...(typeof part.toolCallId === 'string' ? { toolCallId: part.toolCallId } : {}),
        ...(typeof part.text === 'string' ? { chars: part.text.length } : {}),
        ...('output' in part ? { output: payloadShapeForHash(part.output) } : {}),
      };
    });
  }
  return { type: typeof content };
}

function payloadShapeForHash(value: unknown): unknown {
  const serialized = stableStringify(value);
  return {
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    chars: serialized.length,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    hash: stableHash(value),
  };
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return shouldSortArray(parentKey)
      ? items.slice().sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      : items;
  }
  if (value instanceof Date) return value.toISOString();
  if (!isObjectLike(value)) return String(value);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key], key);
  }
  return out;
}

function shouldSortArray(parentKey: string | undefined): boolean {
  return parentKey === 'required' || parentKey === 'enum';
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
