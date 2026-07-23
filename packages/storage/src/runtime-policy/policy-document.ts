import {
  createDefaultRuntimePolicy,
  decodeCanonicalRuntimePolicy,
  normalizeRuntimePolicyMutation,
  type MutateRuntimePolicyInput,
  type MutateRuntimePolicyResult,
  type RuntimePolicy,
  type RuntimePolicyMutation,
  type RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import { deepFreeze, nextRevision, record, revision } from './codec.js';
import {
  codecError,
  decodePersistedDomain,
  decodePolicyInput,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  POLICY_DOCUMENT_MAX_BYTES,
  readBoundedJsonDocument,
  serializeJsonDocument,
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
      policy: decodePersistedDomain(() => decodeCanonicalRuntimePolicy(document.policy)),
    };
  }

  async mutate(
    root: string,
    rawInput: MutateRuntimePolicyInput,
  ): Promise<MutateRuntimePolicyResult> {
    const input = decodePolicyInput(() => normalizeRuntimePolicyMutation(rawInput));
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
    if (serializeJsonDocument(next).length > POLICY_DOCUMENT_MAX_BYTES) {
      throw new RuntimePolicyStoreError(
        'invalid_policy_input',
        `runtime policy exceeds its ${POLICY_DOCUMENT_MAX_BYTES} byte limit`,
      );
    }
    await writeJsonDocument(root, FILE, next, POLICY_DOCUMENT_MAX_BYTES);
    return deepFreeze({ kind: 'committed', snapshot: policySnapshot(next) });
  }
}

export function policySnapshot(document: RuntimePolicyDocument): RuntimePolicySnapshot {
  return deepFreeze({ revision: document.revision, policy: structuredClone(document.policy) });
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
