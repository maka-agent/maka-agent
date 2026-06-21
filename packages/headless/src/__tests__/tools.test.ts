import assert from 'node:assert/strict';
import { exec as childExec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildChildAgentTools,
  LOAD_TOOLS_NAME,
  ToolAvailabilityRuntime,
} from '@maka/runtime';
import { buildIsolatedBashTool, buildIsolatedHeadlessToolAvailability, buildIsolatedHeadlessTools } from '../tools.js';

const execAsync = promisify(childExec);

describe('isolated headless tools', () => {
  test('Bash delegates execution to the isolated executor', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 7, stdout: 'out\n', stderr: 'err\n' };
      },
    });

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_000 },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    );

    assert.deepEqual(calls, [{ command: 'npm test', cwd: '/workspace', timeoutMs: 12_000 }]);
    assert.deepEqual(emitted, [
      { stream: 'stdout', chunk: 'out\n' },
      { stream: 'stderr', chunk: 'err\n' },
    ]);
    assert.deepEqual(result, {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'npm test',
      exitCode: 7,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  test('standard isolated tool surface exposes externalized file tools to local-read children', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const names = tools.map((tool) => tool.name);
    assert.equal(names[0], 'Bash');
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'));
    assert.ok(names.includes('agent_spawn'));
    assert.ok(names.includes('agent_list'));
    assert.ok(names.includes('agent_output'));
    assert.equal(names.filter((name) => name === 'Bash').length, 1);
    assert.deepEqual(buildChildAgentTools(tools).map((tool) => tool.name), ['Read', 'Glob', 'Grep']);
    assert.ok(!buildChildAgentTools(tools).some((tool) => ['Bash', 'Write', 'Edit'].includes(tool.name)));
  });

  test('Read, Write, Edit, Glob, and Grep delegate to native isolated executor methods', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-host-'));
    await writeFile(join(cwd, 'target.txt'), 'host\n', 'utf8');
    const calls: Array<{ name: string; input: unknown }> = [];
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        throw new Error('file tools must use native isolated methods when available');
      },
      async readFile(input) {
        calls.push({ name: 'Read', input });
        return { content: 'container\n' };
      },
      async writeFile(input) {
        calls.push({ name: 'Write', input });
        return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
      },
      async editFile(input) {
        calls.push({ name: 'Edit', input });
        return { ok: true, path: input.path, replacements: 1 };
      },
      async globFiles(input) {
        calls.push({ name: 'Glob', input });
        return { files: ['container.txt'] };
      },
      async grepFiles(input) {
        calls.push({ name: 'Grep', input });
        return { matches: ['container.txt:1:needle'] };
      },
    });

    assert.deepEqual(await tool(tools, 'Read').impl({ path: 'target.txt', offset: 1, limit: 2 }, toolCtx(cwd)), {
      content: 'container\n',
    });
    assert.deepEqual(await tool(tools, 'Write').impl({ path: 'target.txt', content: 'external\n' }, toolCtx(cwd)), {
      ok: true,
      path: 'target.txt',
      bytes: 9,
    });
    assert.deepEqual(
      await tool(tools, 'Edit').impl({ path: 'target.txt', old_string: 'host', new_string: 'external' }, toolCtx(cwd)),
      { ok: true, path: 'target.txt', replacements: 1 },
    );
    assert.deepEqual(await tool(tools, 'Glob').impl({ pattern: '*.txt', cwd: 'src' }, toolCtx(cwd)), {
      files: ['container.txt'],
    });
    assert.deepEqual(await tool(tools, 'Grep').impl({ pattern: 'needle', path: 'src', glob: '*.txt' }, toolCtx(cwd)), {
      matches: ['container.txt:1:needle'],
    });

    assert.equal(await readFile(join(cwd, 'target.txt'), 'utf8'), 'host\n');
    assert.deepEqual(calls, [
      { name: 'Read', input: { cwd, path: 'target.txt', offset: 1, limit: 2 } },
      { name: 'Write', input: { cwd, path: 'target.txt', content: 'external\n' } },
      { name: 'Edit', input: { cwd, path: 'target.txt', oldString: 'host', newString: 'external' } },
      { name: 'Glob', input: { cwd, pattern: '*.txt', searchCwd: 'src' } },
      { name: 'Grep', input: { cwd, pattern: 'needle', path: 'src', glob: '*.txt' } },
    ]);
  });

  test('file tools fall back to command-backed isolated operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-fallback-'));
    await mkdir(join(cwd, 'src'));
    const calls: string[] = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        calls.push(input.command);
        try {
          const { stdout, stderr } = await execAsync(input.command, { cwd: input.cwd, maxBuffer: 1024 * 1024 });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    assert.deepEqual(await tool(tools, 'Write').impl({ path: 'src/file.txt', content: 'hello\nneedle\n' }, toolCtx(cwd)), {
      ok: true,
      path: 'src/file.txt',
      bytes: 13,
    });
    assert.deepEqual(await tool(tools, 'Read').impl({ path: 'src/file.txt', offset: 1, limit: 1 }, toolCtx(cwd)), {
      content: 'needle',
    });
    assert.deepEqual(
      await tool(tools, 'Edit').impl({ path: 'src/file.txt', old_string: 'hello', new_string: 'hi' }, toolCtx(cwd)),
      { ok: true, path: 'src/file.txt', replacements: 1 },
    );
    assert.deepEqual(await tool(tools, 'Glob').impl({ pattern: '**/*.txt' }, toolCtx(cwd)), {
      files: ['src/file.txt'],
    });
    assert.deepEqual(await tool(tools, 'Grep').impl({ pattern: 'needle', glob: '**/*.txt' }, toolCtx(cwd)), {
      matches: ['src/file.txt:2:needle'],
    });
    assert.equal(await readFile(join(cwd, 'src/file.txt'), 'utf8'), 'hi\nneedle\n');
    assert.ok(calls.length >= 5);
    assert.ok(calls.every((command) => command.startsWith("node -e '")));
  });

  test('command-backed file tools do not follow symlinks outside the isolated workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-headless-tools-outside-'));
    await mkdir(join(cwd, 'src'));
    await writeFile(join(outside, 'secret.txt'), 'outside needle\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src', 'link.txt'));
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, { cwd: input.cwd, maxBuffer: 1024 * 1024 });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Write').impl({ path: 'src/link.txt', content: 'overwrite\n' }, toolCtx(cwd)),
      /inside workspace/,
    );
    await assert.rejects(async () => await tool(tools, 'Read').impl({ path: 'src/link.txt' }, toolCtx(cwd)), /inside workspace/);
    assert.deepEqual(await tool(tools, 'Grep').impl({ pattern: 'outside', glob: '**/*.txt' }, toolCtx(cwd)), {
      matches: [],
    });
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside needle\n');
  });

  test('isolated file tools reject path escapes before executor invocation', async () => {
    let calls = 0;
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        calls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const ctx = toolCtx('/workspace');

    await assert.rejects(async () => await tool(tools, 'Read').impl({ path: '/etc/passwd' }, ctx), /inside the isolated workspace/);
    await assert.rejects(async () => await tool(tools, 'Write').impl({ path: '../x', content: '' }, ctx), /inside the isolated workspace/);
    await assert.rejects(
      async () => await tool(tools, 'Edit').impl({ path: 'nested/../../x', old_string: 'a', new_string: 'b' }, ctx),
      /inside the isolated workspace/,
    );
    await assert.rejects(async () => await tool(tools, 'Glob').impl({ pattern: '/tmp/*.txt' }, ctx), /inside the isolated workspace/);
    await assert.rejects(async () => await tool(tools, 'Grep').impl({ pattern: 'x', glob: '../*.txt' }, ctx), /inside the isolated workspace/);
    assert.equal(calls, 0);
  });

  test('standard isolated tool availability defers parent-facing agent tools', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const plan = new ToolAvailabilityRuntime(
      tools,
      buildIsolatedHeadlessToolAvailability(),
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare([]);

    assert.ok(plan.activeTools.includes('Bash'));
    assert.ok(plan.activeTools.includes('Read'));
    assert.ok(plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
    assert.ok(!plan.activeTools.includes('agent_list'));
    assert.ok(!plan.activeTools.includes('agent_output'));

    const loaded = plan.prepareStep!({
      steps: [{ toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: { group: 'agent' } }] }],
    }).activeTools;
    assert.ok(loaded.includes('agent_spawn'));
    assert.ok(loaded.includes('agent_list'));
    assert.ok(loaded.includes('agent_output'));
  });

  test('standard isolated tool availability does not reintroduce agent tools into local-read children', () => {
    const parentTools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const childTools = buildChildAgentTools(parentTools);
    const plan = new ToolAvailabilityRuntime(
      childTools,
      buildIsolatedHeadlessToolAvailability(),
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare([]);

    assert.deepEqual([...plan.activeTools].sort(), ['Glob', 'Grep', 'Read']);
    assert.equal(plan.prepareStep, undefined);
    assert.ok(!plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
  });

  test('README real-backend sketch preserves child tool overrides', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

    assert.ok(
      readme.includes('tools: [...(ctx.tools ?? buildIsolatedHeadlessTools(context.toolExecutor!))],'),
    );
  });
});

function tool(tools: ReturnType<typeof buildIsolatedHeadlessTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function toolCtx(cwd: string) {
  return {
    sessionId: 's',
    turnId: 't',
    cwd,
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
