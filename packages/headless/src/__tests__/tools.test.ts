import assert from 'node:assert/strict';
import { exec as childExec } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildChildAgentTools,
  LOAD_TOOLS_NAME,
  ToolAvailabilityRuntime,
} from '@maka/runtime';
import { createHeavyTaskEvidenceRecorder } from '../heavy-task-evidence.js';
import { createInMemoryTaskRunStore } from '../task-run-store.js';
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

    assert.deepEqual(calls, [{ command: 'npm test', cwd: '/workspace', timeoutMs: 12_000, boundedTail: true }]);
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

  test('Bash surfaces the executor result to history and bounds it for the model', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec() {
        return { exitCode: 0, stdout: big, stderr: '' };
      },
    });

    const result = await bash.impl(
      { command: 'noisy' },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    ) as { stdout: string };

    // emitOutput surfaces whatever the executor RETURNS to history (there is no
    // live per-chunk channel across the executor boundary — see the Harbor tests
    // for the real bounded path). The model-facing result is bounded further.
    assert.equal(emitted.find((event) => event.stream === 'stdout')?.chunk, big);
    assert.ok(result.stdout.includes('line5000'));
    assert.ok(result.stdout.includes('truncated'));
    assert.ok(!result.stdout.includes('line1\n'));
    assert.ok(result.stdout.length < big.length);
  });

  test('only Bash opts into bounded-tail; Read/Glob/Grep request full output', async () => {
    // Records the boundedTail flag of every exec() and returns empty output, so
    // the command-backed Read/Glob/Grep complete without running anything.
    const seen: Array<{ boundedTail: unknown }> = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        seen.push({ boundedTail: (input as { boundedTail?: boolean }).boundedTail });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await tool(tools, 'Bash').impl({ command: 'echo hi' }, toolCtx('/workspace'));
    await tool(tools, 'Read').impl({ path: 'src/f.txt' }, toolCtx('/workspace'));
    await tool(tools, 'Glob').impl({ pattern: '**/*.txt' }, toolCtx('/workspace'));
    await tool(tools, 'Grep').impl({ pattern: 'hello' }, toolCtx('/workspace'));

    assert.equal(seen[0].boundedTail, true, 'Bash opts into bounded tail');
    assert.ok(
      seen.slice(1).every((call) => !call.boundedTail),
      'Read/Glob/Grep must request full output, not a bounded tail',
    );
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
    assert.ok(!names.includes('inventory_submit'));
    assert.ok(!names.includes('todo_update'));
    assert.ok(!names.includes('self_check_submit'));
    assert.ok(!names.includes('engineering_record'));
    assert.ok(!names.includes('check_record'));
    assert.equal(names.filter((name) => name === 'Bash').length, 1);
    assert.deepEqual(buildChildAgentTools(tools).map((tool) => tool.name), ['Read', 'Glob', 'Grep']);
    assert.ok(!buildChildAgentTools(tools).some((tool) => ['Bash', 'Write', 'Edit'].includes(tool.name)));
  });

  test('progress, self-check, and engineering tools are included only when heavy-task recorders are enabled', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }, {
      heavyTaskProgress: {
        async recordInventory(input) {
          return {
            schemaVersion: 1,
            inventoryId: 'inventory-1',
            taskRunId: 'run-1',
            ts: 1,
            summary: input.summary,
            items: input.items,
            source: { kind: 'model_tool', toolCallId: 'tool-1' },
          };
        },
        async recordTodos(input) {
          return {
            schemaVersion: 1,
            todoSetId: 'todos-1',
            taskRunId: 'run-1',
            ts: 1,
            items: input.items,
            source: { kind: 'model_tool', toolCallId: 'tool-1' },
          };
        },
      },
      heavyTaskSelfCheck: {
        async recordSelfCheck(input) {
          return {
            accepted: true,
            selfCheck: {
              schemaVersion: 1,
              selfCheckId: 'self-check-1',
              taskRunId: 'run-1',
              ts: 1,
              status: input.status,
              publicReason: input.publicReason,
              commandEvidence: input.commandEvidence ?? [],
              artifactEvidence: input.artifactEvidence ?? [],
              guard: {
                status: 'accepted',
                checkedAt: 1,
                categories: [],
                publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
              },
              source: { kind: 'model_tool', toolCallId: 'tool-1' },
            },
          };
        },
      },
      heavyTaskEngineering: {
        async recordEngineering() {
          return {
            accepted: true,
            complete: true,
            missingLinks: [],
            record: {
              schemaVersion: 1,
              recordId: 'record-1',
              taskRunId: 'run-1',
              ts: 1,
              kind: 'hypothesis',
              title: 'Hypothesis',
              summary: 'A public hypothesis',
              status: 'proposed',
              completeness: 'complete',
              source: { kind: 'model_tool', toolCallId: 'tool-1', toolName: 'engineering_record' },
              links: {
                todoIds: ['todo-1'],
                evidenceIds: ['evidence-1'],
                toolCallIds: [],
                checkIds: [],
                artifactIds: [],
                changedFiles: [],
                patchIds: [],
                hypothesisIds: [],
                repairIds: [],
              },
              hypothesis: {
                expectedSignal: 'public check identifies the problem',
                rationaleEvidenceIds: ['evidence-1'],
              },
            },
          };
        },
        async recordCheck() {
          return {
            accepted: true,
            complete: true,
            missingLinks: [],
            checkId: 'check-1',
            record: {
              schemaVersion: 1,
              recordId: 'record-2',
              taskRunId: 'run-1',
              ts: 1,
              kind: 'targeted_check',
              title: 'Check',
              summary: 'A public check',
              status: 'passed',
              completeness: 'complete',
              source: { kind: 'model_tool', toolCallId: 'tool-1', toolName: 'check_record' },
              links: {
                todoIds: ['todo-1'],
                evidenceIds: ['evidence-1'],
                toolCallIds: ['tool-1'],
                checkIds: ['check-1'],
                artifactIds: [],
                changedFiles: [],
                patchIds: [],
                hypothesisIds: [],
                repairIds: [],
              },
              targetedCheck: {
                checkId: 'check-1',
                command: 'npm test',
                expectedSignal: 'pass',
                observedSignal: 'pass',
                result: 'pass',
              },
            },
          };
        },
      },
    });

    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('inventory_submit'));
    assert.ok(names.includes('todo_update'));
    assert.ok(names.includes('self_check_submit'));
    assert.ok(names.includes('engineering_record'));
    assert.ok(names.includes('check_record'));
  });

  test('Read, Write, Glob, and Grep delegate to native isolated executor methods', async () => {
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
      async globFiles(input) {
        calls.push({ name: 'Glob', input });
        return { files: ['container.txt'] };
      },
      async grepFiles(input) {
        calls.push({ name: 'Grep', input });
        return { matches: ['container.txt:1:needle'] };
      },
    });

    assert.deepEqual(await tool(tools, 'Read').impl({ path: join(cwd, 'target.txt'), offset: 1, limit: 2 }, toolCtx(cwd)), {
      content: 'container\n',
    });
    assert.deepEqual(await tool(tools, 'Write').impl({ path: join(cwd, 'target.txt'), content: 'external\n' }, toolCtx(cwd)), {
      ok: true,
      path: 'target.txt',
      bytes: 9,
    });
    assert.deepEqual(await tool(tools, 'Glob').impl({ pattern: `${cwd}/*.txt`, cwd: join(cwd, 'src') }, toolCtx(cwd)), {
      files: ['container.txt'],
    });
    assert.deepEqual(await tool(tools, 'Grep').impl({
      pattern: 'needle',
      path: join(cwd, 'src'),
      glob: `${cwd}/*.txt`,
    }, toolCtx(cwd)), {
      matches: ['container.txt:1:needle'],
    });

    assert.equal(await readFile(join(cwd, 'target.txt'), 'utf8'), 'host\n');
    assert.deepEqual(calls, [
      { name: 'Read', input: { cwd, path: 'target.txt', offset: 1, limit: 2 } },
      { name: 'Write', input: { cwd, path: 'target.txt', content: 'external\n' } },
      { name: 'Glob', input: { cwd, pattern: '*.txt', searchCwd: 'src' } },
      { name: 'Grep', input: { cwd, pattern: 'needle', path: 'src', glob: '*.txt' } },
    ]);
  });

  test('Edit ignores native file ops and always runs the shared replacer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-native-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'f.ts');
    await writeFile(file, 'function f() {\n    return 1;\n}\n', 'utf8');
    const nativeCalls: string[] = [];
    // A fully native-capable executor: Edit must STILL bypass these and run the
    // shared computeEditedSource via node -e (there is no native Edit hook).
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
      async readFile() { nativeCalls.push('readFile'); return { content: '' }; },
      async writeFile(input) { nativeCalls.push('writeFile'); return { ok: true, path: input.path, bytes: 0 }; },
      async globFiles() { nativeCalls.push('globFiles'); return { files: [] }; },
      async grepFiles() { nativeCalls.push('grepFiles'); return { matches: [] }; },
    });

    // The fuzzy match works and returns the shared-replacer metadata
    // (matchedVia/startLine/endLine) — proof it went through computeEditedSource,
    // not a native shortcut — and no native file op was consulted for Edit.
    assert.deepEqual(
      await tool(tools, 'Edit').impl(
        { path: 'src/f.ts', old_string: 'function f() {\n  return 1;\n}', new_string: 'function f() {\n    return 2;\n}' },
        toolCtx(cwd),
      ),
      { ok: true, path: 'src/f.ts', replacements: 1, matchedVia: 'line-trimmed', startLine: 1, endLine: 3 },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 2;\n}\n');
    assert.deepEqual(nativeCalls, []);
  });

  test('enabled heavy-task evidence recorder captures Bash, Read, Grep, Write, and Edit results', async () => {
    const store = createInMemoryTaskRunStore();
    let id = 0;
    const recorder = createHeavyTaskEvidenceRecorder({
      taskRunId: 'run-evidence',
      attemptId: 'attempt-1',
      store,
      now: () => 100 + id,
      newId: () => `id-${++id}`,
    });
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        if (input.command.startsWith("node -e '")) {
          return { exitCode: 0, stdout: '{"matchedVia":"exact","startLine":1,"endLine":1}', stderr: '' };
        }
        return { exitCode: 2, stdout: `large stdout\n${'x'.repeat(5_000)}`, stderr: 'short stderr\n' };
      },
      async readFile(input) {
        return { content: `read ${input.path}\n${'r'.repeat(5_000)}` };
      },
      async writeFile(input) {
        return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
      },
      async grepFiles() {
        return { matches: ['src/file.ts:1:needle'] };
      },
    }, { heavyTaskEvidence: recorder });
    const ctx = toolCtx('/workspace');

    await tool(tools, 'Bash').impl({ command: 'npm test' }, ctx);
    await tool(tools, 'Read').impl({ path: 'src/file.ts', limit: 10 }, ctx);
    await tool(tools, 'Grep').impl({ pattern: 'needle', path: 'src' }, ctx);
    await tool(tools, 'Write').impl({ path: 'src/out.txt', content: 'write payload must be omitted' }, ctx);
    await tool(tools, 'Edit').impl({ path: 'src/out.txt', old_string: 'old payload', new_string: 'new payload' }, ctx);

    const projection = await store.project('run-evidence');
    assert.deepEqual(projection.heavyTaskEvidence.map((item) => item.tool?.name), ['Bash', 'Read', 'Grep', 'Write', 'Edit']);
    assert.equal(projection.latestHeavyTaskEvidence?.tool?.name, 'Edit');
    assert.equal(projection.heavyTaskEvidence[0]?.tool?.outputs[0]?.truncated, true);
    const serialized = JSON.stringify(projection.heavyTaskEvidence);
    assert.doesNotMatch(serialized, /write payload must be omitted|old payload|new payload/);
  });

  test('sh-backed file tools fall back to command-backed isolated operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-fallback-'));
    await mkdir(join(cwd, 'src'));
    const absoluteFile = join(cwd, 'src', 'file.txt');
    const absoluteSrc = join(cwd, 'src');
    const absoluteGlob = `${cwd}/**/*.txt`;
    const calls: string[] = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        calls.push(input.command);
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: '/usr/bin:/bin' },
            maxBuffer: 1024 * 1024,
          });
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

    assert.deepEqual(await tool(tools, 'Write').impl({ path: absoluteFile, content: 'hello\nneedle\n' }, toolCtx(cwd)), {
      ok: true,
      path: 'src/file.txt',
      bytes: 13,
    });
    assert.deepEqual(await tool(tools, 'Read').impl({ path: absoluteFile, offset: 1, limit: 1 }, toolCtx(cwd)), {
      content: 'needle',
    });
    assert.deepEqual(await tool(tools, 'Glob').impl({ pattern: absoluteGlob }, toolCtx(cwd)), {
      files: ['src/file.txt'],
    });
    assert.deepEqual(await tool(tools, 'Grep').impl({ pattern: 'needle', path: absoluteSrc, glob: absoluteGlob }, toolCtx(cwd)), {
      matches: ['src/file.txt:2:needle'],
    });
    assert.equal(await readFile(join(cwd, 'src/file.txt'), 'utf8'), 'hello\nneedle\n');
    // Edit is intentionally excluded here: it runs via `node -e` (covered by the
    // dedicated Edit test below) while Read/Write/Glob/Grep stay POSIX-sh scripts
    // that must work with only base coreutils on PATH (here pinned to /usr/bin:/bin).
    assert.ok(calls.length >= 4);
    assert.ok(calls.every((command) => command.startsWith("sh -c '")));
    assert.ok(calls.every((command) => !command.includes('node -e')));
  });

  test('command-backed Edit runs the shared fuzzy matcher via node -e', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'f.ts');
    // 4-space indented body on disk; the model's old_string uses 2-space indent.
    await writeFile(file, 'function f() {\n    return 1;\n}\n', 'utf8');
    await chmod(file, 0o600); // editing must preserve the original mode, not widen it
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

    // Fuzzy: indentation drift is forgiven, and the matched span/strategy is reported.
    assert.deepEqual(
      await tool(tools, 'Edit').impl(
        { path: 'src/f.ts', old_string: 'function f() {\n  return 1;\n}', new_string: 'function f() {\n    return 2;\n}' },
        toolCtx(cwd),
      ),
      { ok: true, path: 'src/f.ts', replacements: 1, matchedVia: 'line-trimmed', startLine: 1, endLine: 3 },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 2;\n}\n');

    // Exact match still works and reports matchedVia: 'exact'.
    assert.deepEqual(
      await tool(tools, 'Edit').impl({ path: 'src/f.ts', old_string: 'return 2;', new_string: 'return 3;' }, toolCtx(cwd)),
      { ok: true, path: 'src/f.ts', replacements: 1, matchedVia: 'exact', startLine: 2, endLine: 2 },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 3;\n}\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600); // mode preserved across the tmp+rename

    // Edit refuses to follow a symlink out of the workspace (mirrors existing_target()).
    const outside = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src', 'link.txt'));
    await assert.rejects(
      async () => await tool(tools, 'Edit').impl({ path: 'src/link.txt', old_string: 'secret', new_string: 'edited' }, toolCtx(cwd)),
      /inside workspace/,
    );
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret\n');

    // Every Edit ran through node -e (the shared computeEditedSource), not sh.
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((command) => command.startsWith("node -e '")));
  });

  test('command-backed Edit edits a binary file byte-exactly without corrupting non-UTF-8 bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-bin-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'b.bin');
    // Lone 0xff / 0xfe are invalid UTF-8; decoding as utf8 would replace them with
    // U+FFFD and corrupt the file. The edit path must keep them byte-for-byte.
    await writeFile(file, Buffer.concat([Buffer.from([0xff]), Buffer.from('ABC', 'utf8'), Buffer.from([0xfe])]));
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

    // Exact byte-level replacement: the surrounding non-UTF-8 bytes are preserved.
    const result = await tool(tools, 'Edit').impl(
      { path: 'src/b.bin', old_string: 'ABC', new_string: 'XYZ' },
      toolCtx(cwd),
    );
    assert.equal((result as { matchedVia?: string }).matchedVia, 'exact');
    assert.deepEqual([...(await readFile(file))], [0xff, 0x58, 0x59, 0x5a, 0xfe]);

    // A non-exact (fuzzy) edit on a binary file is refused, not guessed — and the
    // file is left untouched.
    await assert.rejects(
      async () => await tool(tools, 'Edit').impl({ path: 'src/b.bin', old_string: 'X Y Z', new_string: 'Q' }, toolCtx(cwd)),
      /looks binary/,
    );
    assert.deepEqual([...(await readFile(file))], [0xff, 0x58, 0x59, 0x5a, 0xfe]);
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
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: '/usr/bin:/bin' },
            maxBuffer: 1024 * 1024,
          });
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
