import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { buildOfficeDocumentTool, runOfficeDocumentOperation } from '../office-document-tool.js';

describe('OfficeDocument read-only tool', () => {
  it('registers a read-only Office document adapter without permission prompts', () => {
    const tool = buildOfficeDocumentTool();
    assert.equal(tool.name, 'OfficeDocument');
    assert.equal(tool.permissionRequired, false);
    assert.match(tool.description, /read-only/);
    assert.match(tool.description, /Allowed operations are help/);
    assert.match(tool.description, /view outline\/text\/stats\/issues\/annotated/);
    assert.doesNotMatch(tool.description, /\badd\b.*\bset\b.*\bclose\b/);
  });

  it('supports read-only officecli help without a document path', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const result = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        operation: 'help',
        topic: 'pptx',
        runner: fakeRunner((cmd, args, _options, callback) => {
          calls.push({ cmd, args });
          callback(null, 'pptx help', '');
        }),
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(calls, [{ cmd: 'officecli', args: ['help', 'pptx'] }]);
      assert.deepEqual(result.args, ['help', 'pptx']);
      assert.equal(result.path, undefined);
      assert.equal(result.stdout, 'pptx help');
    });
  });

  it('builds safe officecli args and returns relative paths only', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'deck.pptx'), 'not a real pptx');
      const realWorkspaceRoot = await realpath(workspaceRoot);
      const expectedPath = join(realWorkspaceRoot, 'deck.pptx');
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const result = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'deck.pptx',
        operation: 'view',
        viewMode: 'outline',
        runner: fakeRunner((cmd, args, _options, callback) => {
          calls.push({ cmd, args });
          callback(null, `${expectedPath}\nSlide 1: Hello`, '');
        }),
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(calls, [{ cmd: 'officecli', args: ['view', expectedPath, 'outline'] }]);
      assert.deepEqual(result.args, ['view', 'deck.pptx', 'outline']);
      assert.equal(result.path, 'deck.pptx');
      assert.equal(result.stdout.includes(realWorkspaceRoot), false);
      assert.match(result.stdout, /<workspace>\/deck\.pptx/);
    });
  });

  it('supports get/query/validate but rejects missing selector/query', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'report.docx'), 'not a real docx');
      const realWorkspaceRoot = await realpath(workspaceRoot);
      const expectedPath = join(realWorkspaceRoot, 'report.docx');
      const argsSeen: string[][] = [];
      const runner = fakeRunner((_cmd, args, _options, callback) => {
        argsSeen.push(args);
        callback(null, 'ok', '');
      });

      assert.equal((await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'get',
        selector: '/body/p[1]',
        depth: 3,
        runner,
      })).ok, true);
      assert.equal((await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'query',
        query: 'paragraph[style=Heading1]',
        runner,
      })).ok, true);
      assert.equal((await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'validate',
        runner,
      })).ok, true);

      assert.deepEqual(argsSeen, [
        ['get', expectedPath, '/body/p[1]', '--depth', '3'],
        ['query', expectedPath, 'paragraph[style=Heading1]'],
        ['validate', expectedPath],
      ]);

      const missingSelector = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'get',
        runner,
      });
      assert.equal(missingSelector.ok, false);
      assert.equal(missingSelector.ok ? null : missingSelector.reason, 'invalid_selector');

      const missingQuery = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'query',
        runner,
      });
      assert.equal(missingQuery.ok, false);
      assert.equal(missingQuery.ok ? null : missingQuery.reason, 'invalid_query');

      const missingPath = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        operation: 'validate',
        runner,
      });
      assert.equal(missingPath.ok, false);
      assert.equal(missingPath.ok ? null : missingPath.reason, 'invalid_path');
    });
  });

  it('fails closed on path escapes, unsupported extensions, directories, and symlinks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-office-outside-'));
      try {
        await mkdir(join(workspaceRoot, 'dir.docx'));
        await writeFile(join(workspaceRoot, 'notes.txt'), 'text');
        await writeFile(join(outside, 'secret.docx'), 'secret');
        await symlink(join(outside, 'secret.docx'), join(workspaceRoot, 'linked.docx'));

        const escaped = await runOfficeDocumentOperation({
          cwd: workspaceRoot,
          path: '../secret.docx',
          operation: 'validate',
        });
        assert.equal(escaped.ok, false);
        assert.equal(escaped.ok ? null : escaped.reason, 'invalid_path');

        const unsupported = await runOfficeDocumentOperation({
          cwd: workspaceRoot,
          path: 'notes.txt',
          operation: 'validate',
        });
        assert.equal(unsupported.ok, false);
        assert.equal(unsupported.ok ? null : unsupported.reason, 'unsupported_extension');

        const directory = await runOfficeDocumentOperation({
          cwd: workspaceRoot,
          path: 'dir.docx',
          operation: 'validate',
        });
        assert.equal(directory.ok, false);
        assert.equal(directory.ok ? null : directory.reason, 'not_file');

        const linked = await runOfficeDocumentOperation({
          cwd: workspaceRoot,
          path: 'linked.docx',
          operation: 'validate',
        });
        assert.equal(linked.ok, false);
        assert.equal(linked.ok ? null : linked.reason, 'symlink_escape');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('maps officecli process failures to stable reasons', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'sheet.xlsx'), 'not a real xlsx');
      const missing = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'sheet.xlsx',
        operation: 'validate',
        runner: fakeRunner((_cmd, _args, _options, callback) => {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          callback(error, '', '');
        }),
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.ok ? null : missing.reason, 'officecli_missing');

      const timeout = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'sheet.xlsx',
        operation: 'validate',
        runner: fakeRunner((_cmd, _args, _options, callback) => {
          const error = new Error('timeout') as NodeJS.ErrnoException & { killed?: boolean };
          error.code = 'ETIMEDOUT';
          error.killed = true;
          callback(error, '', '');
        }),
      });
      assert.equal(timeout.ok, false);
      assert.equal(timeout.ok ? null : timeout.reason, 'officecli_timeout');
    });
  });

  it('runs through the tool impl with session cwd', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'slides.pptx'), 'not a real pptx');
      const tool = buildOfficeDocumentTool();
      const result = await tool.impl(
        { path: 'slides.pptx', operation: 'validate' },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.reason, 'officecli_missing');
    });
  });
});

function fakeRunner(
  fn: (
    cmd: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
) {
  return ((cmd: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => fn(cmd, args, options, callback));
    return new EventEmitter() as never;
  }) as never;
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-office-document-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
