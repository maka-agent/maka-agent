import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

describe('desktop agent-team collaboration wiring', () => {
  it('shares one durable mailbox/task ledger across lead and child tools', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readFile(mainPath, 'utf8');

    assert.match(main, /const agentMailboxStore = createAgentMailboxStore\(workspaceRoot\)/);
    assert.match(
      main,
      /buildAgentTeamLeadTools\(\{[\s\S]*?mailbox: agentMailboxStore,[\s\S]*?taskLedger: taskLedgerStore/,
    );
    assert.match(
      main,
      /buildAgentTeamChildTools\(\{[\s\S]*?mailbox: agentMailboxStore,[\s\S]*?taskLedger: taskLedgerStore/,
    );
    assert.match(main, /const childAgentTools = buildChildAgentTools\([\s\S]*?\.\.\.agentTeamChildTools/);
    assert.match(
      main,
      /buildExpertDispatchToolForTeamId\(expertTeamId, \{ taskLedger: taskLedgerStore \}\)/,
    );
    assert.match(main, /tools: expertDispatchTool[\s\S]*?\.\.\.agentTeamLeadTools/);
    assert.match(main, /agentTeam,/);
  });
});
