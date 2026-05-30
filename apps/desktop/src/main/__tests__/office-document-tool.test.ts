import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
  buildOfficeDocumentEditTool,
  buildOfficeDocumentTool,
  runOfficeDocumentEditOperation,
  runOfficeDocumentOperation,
} from '../office-document-tool.js';

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

  it('registers a separate permission-gated Office document editor', () => {
    const tool = buildOfficeDocumentEditTool();
    assert.equal(tool.name, 'OfficeDocumentEdit');
    assert.equal(tool.displayName, 'Office 文档编辑');
    assert.equal(tool.permissionRequired, true);
    assert.equal(tool.categoryHint, 'file_write');
    assert.match(tool.description, /create, add, set, and remove/);
    assert.match(tool.description, /prompts for file-write permission/);
    assert.match(tool.description, /never runs raw, watch, batch, shell/);
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
      assert.equal(result.kind, 'office_document');
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
      assert.equal(result.kind, 'office_document');
      assert.deepEqual(calls, [{ cmd: 'officecli', args: ['view', expectedPath, 'outline'] }]);
      assert.deepEqual(result.args, ['view', 'deck.pptx', 'outline']);
      assert.equal(result.path, 'deck.pptx');
      assert.equal(result.stdout.includes(realWorkspaceRoot), false);
      assert.match(result.stdout, /<workspace>\/deck\.pptx/);
    });
  });

  it('uses Chinese truncation markers and reports stderr truncation', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'deck.pptx'), 'not a real pptx');
      const longStdout = `${'a'.repeat(60_050)}stdout-tail`;
      const longStderr = `${'b'.repeat(60_050)}stderr-tail`;

      const stdoutOnly = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'deck.pptx',
        operation: 'view',
        viewMode: 'text',
        runner: fakeRunner((_cmd, _args, _options, callback) => {
          callback(null, longStdout, '');
        }),
      });
      assert.equal(stdoutOnly.ok, true);
      if (!stdoutOnly.ok) return;
      assert.equal(stdoutOnly.truncated, true);
      assert.match(stdoutOnly.stdout, /Office 文档输出已截断/);
      assert.doesNotMatch(stdoutOnly.stdout, /output truncated/);
      assert.equal(stdoutOnly.stdout.includes('stdout-tail'), false);

      const stderrOnly = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'deck.pptx',
        operation: 'validate',
        runner: fakeRunner((_cmd, _args, _options, callback) => {
          callback(null, 'ok', longStderr);
        }),
      });
      assert.equal(stderrOnly.ok, true);
      if (!stderrOnly.ok) return;
      assert.equal(stderrOnly.truncated, true);
      assert.match(stderrOnly.stderr ?? '', /Office 文档输出已截断/);
      assert.doesNotMatch(stderrOnly.stderr ?? '', /output truncated/);
      assert.equal((stderrOnly.stderr ?? '').includes('stderr-tail'), false);
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
      assert.equal(missingSelector.kind, 'office_document');
      assert.equal(missingSelector.ok ? null : missingSelector.reason, 'invalid_selector');

      const missingQuery = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'query',
        runner,
      });
      assert.equal(missingQuery.ok, false);
      assert.equal(missingQuery.kind, 'office_document');
      assert.equal(missingQuery.ok ? null : missingQuery.reason, 'invalid_query');

      const missingPath = await runOfficeDocumentOperation({
        cwd: workspaceRoot,
        operation: 'validate',
        runner,
      });
      assert.equal(missingPath.ok, false);
      assert.equal(missingPath.kind, 'office_document');
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
      assert.equal(result.kind, 'office_document');
      assert.equal(result.ok ? null : result.reason, 'officecli_missing');
    });
  });

  it('creates new Office documents through the write adapter without overwriting existing files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const realWorkspaceRoot = await realpath(workspaceRoot);
      const expectedPath = join(realWorkspaceRoot, 'draft.docx');
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const created = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'draft.docx',
        operation: 'create',
        runner: fakeRunner((cmd, args, _options, callback) => {
          calls.push({ cmd, args });
          callback(null, 'created', '');
        }),
      });

      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.kind, 'office_document');
      assert.equal(created.operation, 'create');
      assert.equal(created.path, 'draft.docx');
      assert.deepEqual(created.args, ['create', 'draft.docx']);
      assert.deepEqual(calls, [{ cmd: 'officecli', args: ['create', expectedPath] }]);

      await writeFile(join(workspaceRoot, 'existing.docx'), 'not a real docx');
      const existing = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'existing.docx',
        operation: 'create',
      });
      assert.equal(existing.ok, false);
      assert.equal(existing.ok ? null : existing.reason, 'file_exists');
    });
  });

  it('builds bounded add/set/remove edit args and keeps displayed paths relative', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'report.docx'), 'not a real docx');
      const realWorkspaceRoot = await realpath(workspaceRoot);
      const expectedPath = join(realWorkspaceRoot, 'report.docx');
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = fakeRunner((cmd, args, _options, callback) => {
        calls.push({ cmd, args });
        callback(null, 'ok', '');
      });

      const added = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'add',
        target: '/body',
        elementType: 'paragraph',
        props: { text: 'Executive Summary', bold: true, size: 14 },
        index: 0,
        runner,
      });
      assert.equal(added.ok, true);
      if (!added.ok) return;
      assert.deepEqual(added.args, [
        'add',
        'report.docx',
        '/body',
        '--type',
        'paragraph',
        '--prop',
        'text=Executive Summary',
        '--prop',
        'bold=true',
        '--prop',
        'size=14',
        '--index',
        '0',
      ]);

      const set = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'set',
        target: '/body/p[1]',
        props: { color: '1F4E79' },
        runner,
      });
      assert.equal(set.ok, true);

      const removed = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'remove',
        target: '/body/p[2]',
        runner,
      });
      assert.equal(removed.ok, true);

      assert.deepEqual(calls, [
        ['add', expectedPath, '/body', '--type', 'paragraph', '--prop', 'text=Executive Summary', '--prop', 'bold=true', '--prop', 'size=14', '--index', '0'],
        ['set', expectedPath, '/body/p[1]', '--prop', 'color=1F4E79'],
        ['remove', expectedPath, '/body/p[2]'],
      ].map((args) => ({ cmd: 'officecli', args })));
    });
  });

  it('fails closed on unsafe edit selectors, props, and paths', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'report.docx'), 'not a real docx');

      const missingTarget = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'remove',
      });
      assert.equal(missingTarget.ok, false);
      assert.equal(missingTarget.ok ? null : missingTarget.reason, 'invalid_selector');

      const badProps = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: 'report.docx',
        operation: 'set',
        target: '/body/p[1]',
        props: { 'bad key': 'value' },
      });
      assert.equal(badProps.ok, false);
      assert.equal(badProps.ok ? null : badProps.reason, 'invalid_props');

      const escaped = await runOfficeDocumentEditOperation({
        cwd: workspaceRoot,
        path: '../draft.docx',
        operation: 'create',
      });
      assert.equal(escaped.ok, false);
      assert.equal(escaped.ok ? null : escaped.reason, 'invalid_path');
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
