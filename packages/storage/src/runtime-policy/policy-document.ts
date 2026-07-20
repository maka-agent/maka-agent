import {
  createDefaultRuntimePolicy,
  type MutateRuntimePolicyInput,
  type MutateRuntimePolicyResult,
  type RuntimePolicy,
  type RuntimePolicyMutation,
  type RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core/settings';
import { WEB_SEARCH_PROVIDERS } from '@maka/core';
import {
  boolean,
  deepFreeze,
  integer,
  nextRevision,
  record,
  revision,
  string,
  stringArray,
} from './codec.js';
import { codecError, RuntimePolicyStoreError, type CodecSource } from './errors.js';
import {
  POLICY_DOCUMENT_MAX_BYTES,
  readBoundedJsonDocument,
  writeJsonDocument,
} from './document-io.js';

const FILE = 'runtime-policy.json';
const SCHEMA_VERSION = 1 as const;

export interface RuntimePolicyDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly policy: RuntimePolicy;
}

export class RuntimePolicyDocumentOwner {
  async read(root: string): Promise<RuntimePolicyDocument> {
    const value = await readBoundedJsonDocument(root, FILE, POLICY_DOCUMENT_MAX_BYTES);
    if (value === undefined) {
      return { schemaVersion: SCHEMA_VERSION, revision: 0, policy: createDefaultRuntimePolicy() };
    }
    const document = record(value, FILE, 'invalid_document', [
      'schemaVersion',
      'revision',
      'policy',
    ]);
    if (document.schemaVersion !== SCHEMA_VERSION) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: revision(document.revision, `${FILE}.revision`, 'invalid_document'),
      policy: parseRuntimePolicy(document.policy, FILE, 'invalid_document'),
    };
  }

  async mutate(
    root: string,
    rawInput: MutateRuntimePolicyInput,
  ): Promise<MutateRuntimePolicyResult> {
    const input = parseMutationInput(rawInput);
    const current = await this.read(root);
    if (current.revision !== input.expectedRevision) {
      return deepFreeze({
        kind: 'revision_conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      });
    }
    const next: RuntimePolicyDocument = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      policy: applyMutation(current.policy, input.operation),
    };
    await writeJsonDocument(root, FILE, next, POLICY_DOCUMENT_MAX_BYTES);
    return deepFreeze({ kind: 'committed', snapshot: policySnapshot(next) });
  }
}

export function policySnapshot(document: RuntimePolicyDocument): RuntimePolicySnapshot {
  return deepFreeze({ revision: document.revision, policy: structuredClone(document.policy) });
}

function parseMutationInput(value: unknown): MutateRuntimePolicyInput {
  const input = record(value, 'runtime policy mutation', 'invalid_policy_input', [
    'expectedRevision',
    'operation',
  ]);
  const operation = record(input.operation, 'runtime policy operation', 'invalid_policy_input', [
    'kind',
    'value',
  ]);
  const kind = operation.kind;
  const context = `runtime policy operation '${String(kind)}'`;
  let parsed: RuntimePolicyMutation;
  switch (kind) {
    case 'set_network_proxy':
      parsed = { kind, value: parseNetworkProxy(operation.value, context, 'invalid_policy_input') };
      break;
    case 'set_personalization':
      parsed = {
        kind,
        value: parsePersonalization(operation.value, context, 'invalid_policy_input'),
      };
      break;
    case 'set_memory':
      parsed = { kind, value: parseMemory(operation.value, context, 'invalid_policy_input') };
      break;
    case 'set_workspace_instructions':
      parsed = {
        kind,
        value: parseWorkspaceInstructions(operation.value, context, 'invalid_policy_input'),
      };
      break;
    case 'set_privacy':
      parsed = { kind, value: parsePrivacy(operation.value, context, 'invalid_policy_input') };
      break;
    case 'set_chat_defaults':
      parsed = { kind, value: parseChatDefaults(operation.value, context, 'invalid_policy_input') };
      break;
    case 'set_web_search':
      parsed = { kind, value: parseWebSearch(operation.value, context, 'invalid_policy_input') };
      break;
    default:
      throw new RuntimePolicyStoreError('invalid_policy_input', `${context} is unknown`);
  }
  return {
    expectedRevision: revision(
      input.expectedRevision,
      'runtime policy expected revision',
      'invalid_policy_input',
    ),
    operation: parsed,
  };
}

function applyMutation(policy: RuntimePolicy, operation: RuntimePolicyMutation): RuntimePolicy {
  switch (operation.kind) {
    case 'set_network_proxy':
      return { ...policy, networkProxy: operation.value };
    case 'set_personalization':
      return { ...policy, personalization: operation.value };
    case 'set_memory':
      return { ...policy, memory: operation.value };
    case 'set_workspace_instructions':
      return { ...policy, workspaceInstructions: operation.value };
    case 'set_privacy':
      return { ...policy, privacy: operation.value };
    case 'set_chat_defaults':
      return { ...policy, chatDefaults: operation.value };
    case 'set_web_search':
      return { ...policy, webSearch: operation.value };
  }
}

function parseRuntimePolicy(value: unknown, context: string, source: CodecSource): RuntimePolicy {
  const policy = record(value, context, source, [
    'networkProxy',
    'personalization',
    'memory',
    'workspaceInstructions',
    'privacy',
    'chatDefaults',
    'webSearch',
  ]);
  return {
    networkProxy: parseNetworkProxy(policy.networkProxy, `${context}.networkProxy`, source),
    personalization: parsePersonalization(
      policy.personalization,
      `${context}.personalization`,
      source,
    ),
    memory: parseMemory(policy.memory, `${context}.memory`, source),
    workspaceInstructions: parseWorkspaceInstructions(
      policy.workspaceInstructions,
      `${context}.workspaceInstructions`,
      source,
    ),
    privacy: parsePrivacy(policy.privacy, `${context}.privacy`, source),
    chatDefaults: parseChatDefaults(policy.chatDefaults, `${context}.chatDefaults`, source),
    webSearch: parseWebSearch(policy.webSearch, `${context}.webSearch`, source),
  };
}

function parseNetworkProxy(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['networkProxy'] {
  const item = record(value, context, source, [
    'enabled',
    'protocol',
    'host',
    'port',
    'authEnabled',
    'username',
    'bypassList',
    'autoBypassDomains',
  ]);
  const enabled = boolean(item.enabled, `${context}.enabled`, source);
  const rawHost = string(item.host, `${context}.host`, 255, source);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rawHost)) {
    throw new RuntimePolicyStoreError(
      source,
      `${context}.host must not contain control characters`,
    );
  }
  const host = rawHost.trim();
  if (source === 'invalid_document' && host !== rawHost) {
    throw new RuntimePolicyStoreError(
      source,
      `${context}.host must not contain surrounding whitespace`,
    );
  }
  if (enabled && host.length === 0) {
    throw new RuntimePolicyStoreError(source, `${context}.host must not be empty when enabled`);
  }
  if (item.protocol !== 'http' && item.protocol !== 'https' && item.protocol !== 'socks5') {
    throw new RuntimePolicyStoreError(source, `${context}.protocol is invalid`);
  }
  return {
    enabled,
    protocol: item.protocol,
    host,
    port: integer(item.port, `${context}.port`, 1, 65_535, source),
    authEnabled: boolean(item.authEnabled, `${context}.authEnabled`, source),
    username: string(item.username, `${context}.username`, 256, source),
    bypassList: stringArray(item.bypassList, `${context}.bypassList`, 256, source),
    autoBypassDomains: stringArray(
      item.autoBypassDomains,
      `${context}.autoBypassDomains`,
      256,
      source,
    ),
  };
}

function parsePersonalization(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['personalization'] {
  const item = record(value, context, source, ['displayName', 'assistantTone']);
  return {
    displayName: string(item.displayName, `${context}.displayName`, 256, source),
    assistantTone: string(item.assistantTone, `${context}.assistantTone`, 4_096, source),
  };
}

function parseMemory(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['memory'] {
  const item = record(value, context, source, ['enabled', 'agentReadEnabled']);
  return {
    enabled: boolean(item.enabled, `${context}.enabled`, source),
    agentReadEnabled: boolean(item.agentReadEnabled, `${context}.agentReadEnabled`, source),
  };
}

function parseWorkspaceInstructions(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['workspaceInstructions'] {
  const item = record(value, context, source, ['enabled']);
  return { enabled: boolean(item.enabled, `${context}.enabled`, source) };
}

function parsePrivacy(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['privacy'] {
  const item = record(value, context, source, ['incognitoActive']);
  return { incognitoActive: boolean(item.incognitoActive, `${context}.incognitoActive`, source) };
}

function parseChatDefaults(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['chatDefaults'] {
  const item = record(value, context, source, ['permissionMode']);
  if (!(CHAT_DEFAULT_PERMISSION_MODES as readonly unknown[]).includes(item.permissionMode)) {
    throw new RuntimePolicyStoreError(source, `${context}.permissionMode is invalid`);
  }
  return { permissionMode: item.permissionMode as RuntimePolicy['chatDefaults']['permissionMode'] };
}

function parseWebSearch(
  value: unknown,
  context: string,
  source: CodecSource,
): RuntimePolicy['webSearch'] {
  const item = record(value, context, source, ['enabled', 'defaultProvider']);
  if (!(WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(item.defaultProvider)) {
    throw new RuntimePolicyStoreError(source, `${context}.defaultProvider is invalid`);
  }
  return {
    enabled: boolean(item.enabled, `${context}.enabled`, source),
    defaultProvider: item.defaultProvider as RuntimePolicy['webSearch']['defaultProvider'],
  };
}
