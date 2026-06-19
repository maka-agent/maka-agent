import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { hashSystemPrompt } from '../fixed-prompt-controller.js';
import {
  createCliPromptCandidateGit,
  createScriptedMetaAgent,
  extractTrajectoryDigest,
  renderMetaAgentPrompt,
  runPromptCandidateRound,
  type MetaAgentPromptInput,
  type MetaAgentPromptResult,
} from '../prompt-candidate-loop.js';

const execFileAsync = promisify(execFile);

describe('prompt candidate loop', () => {
  test('passes only program, results TSV, and held-in digests to the meta-agent', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\nheld-out-secret\ttrue\n', 'utf8');

      let seenInput: MetaAgentPromptInput | undefined;
      await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath,
        heldInDigests: [
          {
            taskId: 'task-a',
            errorClass: 'verification_failed',
            summary: 'last command missed the requested output',
          },
        ],
        heldOutDigests: [
          {
            taskId: 'held-out-secret',
            errorClass: 'verification_failed',
            summary: 'do not leak this held-out trajectory',
          },
        ],
        metaAgent: async (input): Promise<MetaAgentPromptResult> => {
          seenInput = input;
          return { systemPrompt: 'candidate prompt\n', summary: 'tightened output instruction' };
        },
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      });

      assert.ok(seenInput);
      assert.equal(seenInput.program, 'Improve the prompt conservatively.\n');
      assert.equal(seenInput.resultsTsv, 'task_id\tpassed\ntask-a\tfalse\n');
      assert.equal(seenInput.currentSystemPrompt, 'original prompt\n');
      assert.deepEqual(seenInput.heldInDigests.map((digest) => digest.taskId), ['task-a']);
      assert.equal(JSON.stringify(seenInput).includes('held-out-secret'), false);
      assert.equal(JSON.stringify(seenInput).includes('do not leak'), false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'candidate prompt\n');

      const events = (await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(events, [
        {
          schemaVersion: 1,
          type: 'prompt_candidate_committed',
          id: 'id-1',
          ts: 100,
          runId: 'run-1',
          roundId: 'round-1',
          commitSha: 'commit-1',
          summary: 'tightened output instruction',
          promptHash: hashSystemPrompt('candidate prompt\n'),
        },
      ]);
    });
  });

  test('rejects overlapping held-in and held-out task digests', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [{ taskId: 'task-a', summary: 'held-in summary' }],
          heldOutDigests: [{ taskId: 'task-a', summary: 'held-out summary' }],
          metaAgent: async () => {
            called = true;
            return { systemPrompt: 'candidate prompt\n', summary: 'changed prompt' };
          },
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /held-in and held-out task sets must be disjoint/,
      );

      assert.equal(called, false);
    });
  });

  test('fails closed when the prompt edit changes files outside system_prompt.md', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let committed = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          heldOutDigests: [],
          metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md', 'program.md'],
            commit: async () => {
              committed = true;
              return 'commit-1';
            },
            restoreSystemPrompt: async () => {
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /only system_prompt.md may change/,
      );

      assert.equal(committed, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('rejects a symlinked system prompt before writing outside the repo', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const outsidePath = join(dir, '..', 'outside-system-prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(outsidePath, 'outside prompt\n', 'utf8');
      await symlink(outsidePath, systemPromptPath);
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /system_prompt.md must be a regular file/,
      );

      assert.equal(await readFile(outsidePath, 'utf8'), 'outside prompt\n');
    });
  });

  test('rejects a system prompt through a symlinked parent before writing outside the repo', async () => {
    await withDir(async (dir) => {
      await withDir(async (outsideDir) => {
        const programPath = join(dir, 'program.md');
        const promptLinkPath = join(dir, 'prompts');
        const outsidePath = join(outsideDir, 'system_prompt.md');
        const systemPromptPath = join(promptLinkPath, 'system_prompt.md');
        const resultsTsvPath = join(dir, 'results.tsv');
        await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
        await writeFile(outsidePath, 'outside prompt\n', 'utf8');
        await symlink(outsideDir, promptLinkPath);
        await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

        await assert.rejects(
          runPromptCandidateRound({
            runId: 'run-1',
            roundId: 'round-1',
            programPath,
            systemPromptPath,
            resultsTsvPath,
            resultsJsonlPath: join(dir, 'results.jsonl'),
            heldInDigests: [],
            metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
            git: {
              gitRootPath: dir,
              systemPromptGitPath: 'prompts/system_prompt.md',
              assertSystemPromptClean: async () => {},
              changedFiles: async () => ['prompts/system_prompt.md'],
              commit: async () => 'commit-1',
              restoreSystemPrompt: async () => {
                await writeFile(systemPromptPath, 'outside prompt\n', 'utf8');
              },
            },
            now: () => 100,
            newId: idFactory(),
          }),
          /system_prompt.md must stay inside the git cwd/,
        );

        assert.equal(await readFile(outsidePath, 'utf8'), 'outside prompt\n');
      });
    });
  });

  test('rejects changes to a different system_prompt.md path', async () => {
    await withDir(async (dir) => {
      const promptDir = join(dir, 'prompts');
      await mkdir(promptDir);
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(promptDir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let committed = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'prompts/system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md'],
            commit: async () => {
              committed = true;
              return 'commit-1';
            },
            restoreSystemPrompt: async () => {
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /only prompts\/system_prompt.md may change/,
      );

      assert.equal(committed, false);
    });
  });

  test('rejects mismatched input and git system prompt paths before writing', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath: programPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => {
            called = true;
            return { systemPrompt: 'candidate prompt\n', summary: 'changed prompt' };
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /system prompt path must match git prompt path/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(programPath, 'utf8'), 'Improve the prompt conservatively.\n');
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('restores the original prompt when committing the candidate fails', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let restored = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md'],
            commit: async () => {
              throw new Error('commit rejected');
            },
            restoreSystemPrompt: async () => {
              restored = true;
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /commit rejected/,
      );

      assert.equal(restored, true);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('extracts a bounded digest from raw runtime events', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(runtimeEventsPath, [
        JSON.stringify(runtimeEvent('call-1', 'Read', { path: '/app/first.txt' })),
        JSON.stringify(runtimeEvent('call-2', 'Bash', { command: 'pytest -q' })),
        JSON.stringify(runtimeEvent('call-3', 'Write', { path: '/app/out.txt', content: 'long raw content that should not appear' })),
        '',
      ].join('\n'), 'utf8');

      const digest = await extractTrajectoryDigest({
        taskId: 'task-a',
        errorClass: 'verification_failed',
        runtimeEventsPath,
        verifierSummary: 'expected output missing',
      });

      assert.deepEqual(digest, {
        taskId: 'task-a',
        errorClass: 'verification_failed',
        summary: 'expected output missing',
        recentToolCalls: [
          { name: 'Bash', argsPreview: 'command' },
          { name: 'Write', argsPreview: 'content,path' },
        ],
      });
      assert.equal(JSON.stringify(digest).includes('long raw content'), false);
    });
  });

  test('scripted meta-agent renders a fixed prompt and parses JSON output', async () => {
    const input: MetaAgentPromptInput = {
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve conservatively.',
      currentSystemPrompt: 'original prompt',
      resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
      heldInDigests: [
        {
          taskId: 'task-a',
          errorClass: 'verification_failed',
          summary: 'missing expected line',
          recentToolCalls: [{ name: 'Bash', argsPreview: 'command' }],
        },
      ],
    };
    const prompt = renderMetaAgentPrompt(input);
    assert.match(prompt, /Improve conservatively/);
    assert.match(prompt, /task-a/);
    assert.match(prompt, /original prompt/);

    const metaAgent = createScriptedMetaAgent({
      complete: async ({ prompt: renderedPrompt }) => {
        assert.equal(renderedPrompt, prompt);
        return JSON.stringify({
          systemPrompt: 'candidate prompt\n',
          summary: 'ask for exact output line',
        });
      },
    });

    assert.deepEqual(await metaAgent(input), {
      systemPrompt: 'candidate prompt\n',
      summary: 'ask for exact output line',
    });
  });

  test('CLI git adapter commits only system_prompt.md with the round message', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInDigests: [],
        metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
        git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter resolves a relative system prompt path from cwd', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(join(dir, 'system_prompt.md'), 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        programPath,
        systemPromptPath: join(dir, 'system_prompt.md'),
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInDigests: [],
        metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
        git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath: 'system_prompt.md' }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter uses repo-root paths when cwd is a subdirectory', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const packageDir = join(dir, 'packages', 'headless');
      await mkdir(packageDir, { recursive: true });
      const programPath = join(packageDir, 'program.md');
      const systemPromptPath = join(packageDir, 'system_prompt.md');
      const resultsTsvPath = join(packageDir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(packageDir, 'results.jsonl'),
        heldInDigests: [],
        metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
        git: createCliPromptCandidateGit({ cwd: packageDir, systemPromptPath: 'system_prompt.md' }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter restores worktree and index when commit fails', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
      await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
      await chmod(hookPath, 0o755);

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => ({ systemPrompt: 'candidate prompt\n', summary: 'changed prompt' }),
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
      );

      const cached = await execFileAsync('git', ['diff', '--cached', '--', 'system_prompt.md'], { cwd: dir });
      const worktree = await execFileAsync('git', ['diff', '--', 'system_prompt.md'], { cwd: dir });
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
      assert.equal(cached.stdout, '');
      assert.equal(worktree.stdout, '');
    });
  });

  test('CLI git adapter rejects a dirty system prompt before candidate writes', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      await writeFile(systemPromptPath, 'manual prompt edit\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInDigests: [],
          metaAgent: async () => {
            called = true;
            return { systemPrompt: 'candidate prompt\n', summary: 'changed prompt' };
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /system_prompt.md must be clean before candidate round/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'manual prompt edit\n');
    });
  });
});

function gitNoop(gitRootPath = process.cwd()) {
  return {
    gitRootPath,
    systemPromptGitPath: 'system_prompt.md',
    assertSystemPromptClean: async () => {},
    changedFiles: async () => ['system_prompt.md'],
    commit: async () => 'commit-1',
    restoreSystemPrompt: async () => {},
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

function runtimeEvent(id: string, name: string, args: unknown) {
  return {
    id,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id, name, args },
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-candidate-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
