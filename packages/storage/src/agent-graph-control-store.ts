import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeAgentGraphIntentClaim,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimRequest,
  type AgentGraphIntentClaimResult,
  type AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import { appendJsonl } from './jsonl-append.js';
import { SQLITE_SESSION_METADATA_DATABASE_NAME } from './session-store.js';
import {
  createSqliteSessionMetadataStore,
  type SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';
import { chainWrite } from './write-queue.js';

export const AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH = join(
  'agent-graph-control',
  'intent-claims.jsonl',
);

export type AgentGraphControlStoreFailpoint = 'after_sqlite_intent_claim';

export interface AgentGraphControlStoreOptions {
  now?: () => number;
  failpoint?: (point: AgentGraphControlStoreFailpoint) => void;
}

export interface AgentGraphControlStore extends AgentGraphIntentClaimStore {
  close(): void;
}

export function createAgentGraphControlStore(
  workspaceRoot: string,
  options: AgentGraphControlStoreOptions = {},
): AgentGraphControlStore {
  return new SqliteAgentGraphControlStore(workspaceRoot, options);
}

/**
 * SQLite is the query and atomicity authority. JSONL is a durable audit mirror
 * of claims already committed in SQLite; it is never imported as authority.
 */
class SqliteAgentGraphControlStore implements AgentGraphControlStore {
  private readonly sqlite: SqliteSessionMetadataStore;
  private readonly ledgerPath: string;
  private readonly ready: Promise<void>;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: AgentGraphControlStoreOptions,
  ) {
    this.ledgerPath = join(workspaceRoot, AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH);
    const sqlitePath = join(workspaceRoot, SQLITE_SESSION_METADATA_DATABASE_NAME);
    if (existsSync(this.ledgerPath) && !existsSync(sqlitePath)) {
      throw new Error(
        'Agent graph SQLite authority is missing; JSONL audit records cannot rebuild it',
      );
    }
    this.sqlite = createSqliteSessionMetadataStore(sqlitePath, { now: options.now });
    this.ready = this.reconcileAuditMirror();
    void this.ready.catch(() => {});
  }

  async claimAgentGraphIntent(
    request: AgentGraphIntentClaimRequest,
  ): Promise<AgentGraphIntentClaimResult> {
    await this.ensureReady();
    let result: AgentGraphIntentClaimResult | undefined;
    await chainWrite(this.writeQueues, 'intent-claims', async () => {
      result = await this.sqlite.claimAgentGraphIntent(request);
      this.options.failpoint?.('after_sqlite_intent_claim');
      await this.ensureAuditClaim(result.claim);
    });
    if (!result) throw new Error('Agent graph intent claim was not persisted');
    return result;
  }

  async readAgentGraphIntentClaim(
    graphId: string,
    intentId: string,
  ): Promise<AgentGraphIntentClaim | undefined> {
    await this.ensureReady();
    return this.sqlite.readAgentGraphIntentClaim(graphId, intentId);
  }

  async listAgentGraphIntentClaims(graphId?: string): Promise<AgentGraphIntentClaim[]> {
    await this.ensureReady();
    return this.sqlite.listAgentGraphIntentClaims(graphId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }

  private async reconcileAuditMirror(): Promise<void> {
    const auditClaims = await this.readAuditClaims();
    const sqliteClaims = await this.sqlite.listAgentGraphIntentClaims();
    const sqliteByIdentity = new Map(sqliteClaims.map((claim) => [claimKey(claim), claim]));
    const auditByIdentity = new Map<string, AgentGraphIntentClaim>();

    for (const claim of auditClaims) {
      const key = claimKey(claim);
      const duplicate = auditByIdentity.get(key);
      if (duplicate && !isDeepStrictEqual(duplicate, claim)) {
        throw new Error(`Conflicting agent graph JSONL audit claim: ${key}`);
      }
      auditByIdentity.set(key, claim);
      const authoritative = sqliteByIdentity.get(key);
      if (!authoritative) {
        throw new Error(`Agent graph JSONL audit claim is missing from SQLite authority: ${key}`);
      }
      if (!isDeepStrictEqual(authoritative, claim)) {
        throw new Error(`Agent graph JSONL audit claim disagrees with SQLite authority: ${key}`);
      }
    }

    for (const claim of sqliteClaims) {
      if (!auditByIdentity.has(claimKey(claim))) await this.appendAuditClaim(claim);
    }
  }

  private async ensureAuditClaim(claim: AgentGraphIntentClaim): Promise<void> {
    const claims = await this.readAuditClaims();
    const matching = claims.filter((candidate) => claimKey(candidate) === claimKey(claim));
    if (matching.some((candidate) => !isDeepStrictEqual(candidate, claim))) {
      throw new Error(
        `Agent graph JSONL audit claim disagrees with SQLite authority: ${claimKey(claim)}`,
      );
    }
    if (matching.length === 0) await this.appendAuditClaim(claim);
  }

  private async appendAuditClaim(claim: AgentGraphIntentClaim): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await appendJsonl(this.ledgerPath, `${JSON.stringify(claim)}\n`, {
      durable: true,
      durabilityRoot: this.workspaceRoot,
    });
  }

  private async readAuditClaims(): Promise<AgentGraphIntentClaim[]> {
    let text: string;
    try {
      text = await readFile(this.ledgerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const claims: AgentGraphIntentClaim[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        claims.push(decodeAgentGraphIntentClaim(JSON.parse(line)));
      } catch (error) {
        throw new Error(
          `Invalid agent graph intent claim JSONL line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return claims;
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('Agent graph control store is closed');
    await this.ready;
  }
}

function claimKey(claim: Pick<AgentGraphIntentClaim, 'graphId' | 'intentId'>): string {
  return `${claim.graphId}\u0000${claim.intentId}`;
}
