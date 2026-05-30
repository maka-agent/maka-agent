import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExploreAgentTool, runReadOnlyExplore } from '../explore-agent-tool.js';

describe('ExploreAgent read-only worker', () => {
  it('exposes a permission-gated subagent tool', () => {
    const tool = buildExploreAgentTool();
    assert.equal(tool.name, 'ExploreAgent');
    assert.equal(tool.permissionRequired, true);
    assert.equal(tool.categoryHint, 'subagent');
    assert.match(tool.description, /read-only/);
    assert.match(tool.description, /never writes/);
  });

  it('returns source-grounded matches without absolute paths', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(join(workspaceRoot, 'src', 'permission.ts'), [
        'export const policy = {',
        "  explore: 'read-only subagent',",
        '};',
      ].join('\n'));
      await writeFile(join(workspaceRoot, 'README.md'), '# Demo\npermission model overview');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study permission policy',
        roots: ['.'],
        queries: ['permission', 'subagent'],
        maxFiles: 10,
        maxMatches: 10,
      });

      assert.equal(result.ok, true);
      assert.equal(result.kind, 'explore_agent');
      assert.equal(result.mode, 'read_only');
      assert.deepEqual(result.roots, ['.']);
      assert.equal(typeof result.startedAt, 'number');
      assert.equal(typeof result.completedAt, 'number');
      assert.equal(typeof result.durationMs, 'number');
      assert.ok(result.completedAt >= result.startedAt);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.filesInspected >= 2);
      assert.ok(result.matches.some((match) => match.path === 'src/permission.ts' && match.query === 'subagent'));
      assert.ok(result.candidateFiles.some((file) => file.path === 'src/permission.ts'));
      assert.equal(result.sensitiveFilesSkipped, 0);
      assert.ok(result.evidence.some((item) => item.type === 'match' && item.path === 'src/permission.ts' && item.line === 2));
      assert.match(result.summary, /读取 \d+ 个文件 · 命中 \d+ 处 · 证据 \d+ 个 · 候选 \d+ 个 · 耗时 /);
      assert.match(result.report, /目标：study permission policy/);
      assert.match(result.report, /证据锚点：/);
      assert.match(result.report, /src\/permission\.ts:2/);
      assert.match(result.report, /命中片段：/);
      assert.match(result.report, /耗时 \d+(?:\.\d)?(?: ms|s|m \d+s)/);
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
      assert.ok(result.notes.some((note) => /不写文件、不联网、不启动进程/.test(note)));
      assert.equal(result.notes.some((note) => /Read-only worker|Search budget/.test(note)), false);
    });
  });

  it('rejects roots outside cwd and skips symlinked content', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-explore-outside-'));
      try {
        await writeFile(join(outside, 'secret.ts'), 'subscription_token = "secret"');
        await symlink(outside, join(workspaceRoot, 'linked-outside'));

        const invalid = await runReadOnlyExplore({
          cwd: workspaceRoot,
          objective: 'inspect secret',
          roots: ['../'],
          queries: ['secret'],
        });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.reason, 'invalid_root');

        const result = await runReadOnlyExplore({
          cwd: workspaceRoot,
          objective: 'inspect secret',
          roots: ['.'],
          queries: ['secret'],
        });
        assert.equal(result.ok, true);
        assert.equal(result.matches.length, 0);
        assert.equal(JSON.stringify(result).includes('subscription_token'), false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('returns a structured failure when the session cwd is unreadable', async () => {
    const missingRoot = join(tmpdir(), `maka-explore-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const result = await runReadOnlyExplore({
      cwd: missingRoot,
      objective: 'inspect missing workspace',
      roots: ['.'],
      queries: ['workspace'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_root');
    assert.equal(result.message, '会话工作目录不可读取。');
    assert.equal(result.summary, '未完成：会话工作目录不可读取。');
    assert.equal(result.filesInspected, 0);
    assert.equal(result.matches.length, 0);
    assert.equal(JSON.stringify(result).includes(missingRoot), false);
    assert.equal(typeof result.durationMs, 'number');
  });

  it('skips sensitive local credential files even when they match the query', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(join(workspaceRoot, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret');
      await writeFile(join(workspaceRoot, '.npmrc'), '//registry.example/:_authToken=npm_secret');
      await writeFile(join(workspaceRoot, 'credentials.json'), '{"refresh_token":"secret-refresh"}');
      await writeFile(join(workspaceRoot, 'src', 'config.ts'), 'export const secretBoundary = "redacted in docs";');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study secret boundary',
        roots: ['.'],
        queries: ['secret'],
        maxFiles: 20,
        maxMatches: 20,
      });

      assert.equal(result.ok, true);
      assert.ok(result.matches.some((match) => match.path === 'src/config.ts'));
      assert.equal(result.sensitiveFilesSkipped, 3);
      assert.ok(result.notes.some((note) => /已跳过 3 个疑似本地凭据\/密钥文件/.test(note)));
      assert.match(result.report, /跳过 \d+ 个（含敏感 3 个）/);
      assert.equal(JSON.stringify(result).includes('sk-ant-secret'), false);
      assert.equal(JSON.stringify(result).includes('npm_secret'), false);
      assert.equal(JSON.stringify(result).includes('secret-refresh'), false);
      assert.equal(result.candidateFiles.some((file) => file.path === '.env' || file.path === '.npmrc' || file.path === 'credentials.json'), false);
      assert.equal(result.evidence.some((item) => item.path === '.env' || item.path === '.npmrc' || item.path === 'credentials.json'), false);
    });
  });

  it('runs through the tool impl with the session cwd only', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const tool = buildExploreAgentTool();
      const output: string[] = [];
      const result = await tool.impl(
        { objective: 'find reference notes', queries: ['reference'] },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: (_stream, chunk) => output.push(chunk),
        },
      );
      assert.equal(result.kind, 'explore_agent');
      assert.equal(result.ok, true);
      assert.ok(result.matches.some((match) => match.path === 'notes.md'));
      assert.ok(result.progress.some((message) => /准备范围/.test(message)));
      assert.ok(result.progress.some((message) => /完成/.test(message)));
      assert.equal(result.progress.join('').includes(workspaceRoot), false);
      assert.ok(output.some((chunk) => /准备范围/.test(chunk)));
      assert.ok(output.some((chunk) => /完成/.test(chunk)));
      assert.equal(output.join('').includes(workspaceRoot), false);
    });
  });

  it('honors runtime abort signals before scanning files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const abort = new AbortController();
      abort.abort();

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find reference notes',
        queries: ['reference'],
        abortSignal: abort.signal,
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'aborted');
      assert.equal(result.message, '只读探索已取消。');
      assert.equal(result.filesInspected, 0);
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.evidence, []);
      assert.equal(result.report, '');
      assert.equal(JSON.stringify(result).includes('reference explore worker notes'), false);
    });
  });

  it('forwards the runtime abort signal through the tool impl', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const tool = buildExploreAgentTool();
      const abort = new AbortController();
      abort.abort();

      const result = await tool.impl(
        { objective: 'find reference notes', queries: ['reference'] },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: abort.signal,
          emitOutput: () => undefined,
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'aborted');
      assert.equal(result.message, '只读探索已取消。');
      assert.equal(result.filesInspected, 0);
    });
  });

  it('emits bounded progress checkpoints for long scans', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 25; index++) {
        await writeFile(join(workspaceRoot, `file-${index}.md`), `alpha reference ${index}`);
      }
      const progress: string[] = [];
      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find alpha references',
        queries: ['alpha'],
        maxFiles: 25,
        maxMatches: 25,
        onProgress: (message) => progress.push(message),
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.progress, progress);
      assert.ok(progress.length >= 5);
      assert.ok(progress.length <= 12);
      assert.ok(progress.some((message) => /已读取 10 个文件/.test(message)));
      assert.ok(progress.some((message) => /完成，读取/.test(message)));
      assert.equal(progress.join('\n').includes(workspaceRoot), false);
    });
  });

  it('prioritizes project landmarks during broad research scans', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await mkdir(join(workspaceRoot, 'tests'), { recursive: true });
      for (let index = 0; index < 20; index++) {
        await writeFile(join(workspaceRoot, `aaa-filler-${index}.md`), `filler ${index}`);
      }
      await writeFile(join(workspaceRoot, 'package.json'), '{"scripts":{"test":"node --test"}}');
      await writeFile(join(workspaceRoot, 'README.md'), '# Landmark project');
      await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'export function boot() {}');
      await writeFile(join(workspaceRoot, 'tests', 'boot.test.ts'), 'test("boot", () => undefined)');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'map this project architecture',
        roots: ['.'],
        queries: ['unlikely-query'],
        maxFiles: 6,
        maxMatches: 6,
      });

      assert.equal(result.ok, true);
      assert.ok(result.candidateFiles.some((file) => file.path === 'package.json' && file.reasons.includes('project manifest')));
      assert.ok(result.candidateFiles.some((file) => file.path === 'README.md' && file.reasons.includes('project documentation')));
      assert.ok(result.candidateFiles.some((file) => file.path === 'src/main.ts' && file.reasons.includes('project entrypoint')));
      assert.ok(result.candidateFiles.some((file) => file.path === 'tests/boot.test.ts' && file.reasons.includes('project test surface')));
      assert.ok(result.evidence.some((item) => item.type === 'candidate' && item.path === 'package.json' && item.label === '项目配置锚点'));
      assert.ok(result.evidence.some((item) => item.type === 'candidate' && item.path === 'README.md' && item.label === '项目文档锚点'));
      assert.ok(result.notes.some((note) => /优先读取项目配置、文档、入口和测试线索/.test(note)));
      assert.ok(result.notes.some((note) => /按查询命中和项目结构分/.test(note)));
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('keeps user-visible result notes localized', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'alpha');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find beta references',
        roots: ['.'],
        queries: ['beta'],
        maxFiles: 5,
        maxMatches: 5,
      });

      assert.equal(result.ok, true);
      assert.ok(result.notes.some((note) => /没有找到内容命中/.test(note)));
      assert.equal(
        result.notes.some((note) => /Read-only worker|Search budget|No content matches|Candidate discovery|Project landmark|Total byte budget|Scope /.test(note)),
        false,
      );

      const failed = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'x',
      });
      assert.equal(failed.ok, false);
      assert.ok(failed.notes.some((note) => /不写文件、不联网、不启动进程/.test(note)));
      assert.equal(failed.notes.some((note) => /Read-only worker/.test(note)), false);
    });
  });

  it('keeps the generated research report bounded and source-grounded', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 20; index++) {
        await writeFile(join(workspaceRoot, `report-${index}.md`), `alpha line ${index}\nalpha detail ${index}`);
      }

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'summarize alpha report evidence',
        roots: ['.'],
        queries: ['alpha'],
        maxFiles: 20,
        maxMatches: 60,
      });

      assert.equal(result.ok, true);
      assert.ok(result.report.length <= 6000);
      assert.match(result.report, /目标：summarize alpha report evidence/);
      assert.match(result.report, /下一步阅读：/);
      assert.equal(result.report.includes(workspaceRoot), false);
    });
  });

  it('has a structured chat preview instead of raw JSON fallback', async () => {
    const [components, events] = await Promise.all([
      readFile(join(process.cwd(), '../../packages/ui/src/components.tsx'), 'utf8'),
      readFile(join(process.cwd(), '../../packages/core/src/events.ts'), 'utf8'),
    ]);

    assert.match(events, /kind: 'explore_agent'/);
    assert.match(events, /summary\?: string/);
    assert.match(components, /function ExploreAgentPreview/);
    assert.match(components, /content\.kind === 'explore_agent'/);
    const previewBlock = components.match(/function ExploreAgentPreview[\s\S]*?function formatBytes/)?.[0] ?? '';
    assert.match(previewBlock, /result\.progress/);
    assert.match(previewBlock, /result\.evidence/);
    assert.match(previewBlock, /result\.summary/);
    assert.match(previewBlock, /result\.report/);
    assert.match(previewBlock, /result\.durationMs/);
    assert.match(previewBlock, /探索过程/);
    assert.match(previewBlock, /证据锚点/);
    assert.match(previewBlock, /研究报告/);
    assert.match(previewBlock, /耗时/);
    assert.match(previewBlock, /resultSummary/);
    assert.match(previewBlock, /复制报告/);
    assert.match(previewBlock, /reportText\.length === 0/);
    assert.match(previewBlock, /navigator\.clipboard\.writeText\(redactSecrets\(reportText\)\)/);
    assert.doesNotMatch(previewBlock, /writeText\(result\.report\)/);
    assert.match(previewBlock, /sensitiveFilesSkipped/);
    assert.match(previewBlock, /已取消/);
    assert.match(previewBlock, /项目配置/);
    assert.match(previewBlock, /入口文件/);
    assert.match(previewBlock, /redactSecrets/);
    assert.doesNotMatch(previewBlock, /<a\s/i, 'ExploreAgent preview should not create links from tool result paths');
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-explore-agent-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
