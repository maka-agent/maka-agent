import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  experimentRunLayout,
  runExperiment,
  type ExperimentRunLayout,
} from '../experiment-engine.js';
import { withDir } from './helpers/temp-dir.js';

describe('runExperiment', () => {
  test('resolves the standard controller/jobs/prompts layout', () => {
    const layout = experimentRunLayout('/runs/abc');
    assert.deepEqual(layout, {
      runRoot: '/runs/abc',
      controllerDir: '/runs/abc/controller',
      jobsDir: '/runs/abc/jobs',
      promptsDir: '/runs/abc/prompts',
      resultsJsonlPath: '/runs/abc/controller/results.jsonl',
    });
  });

  test('materializes dirs and prompts, runs, then persists artifacts in order', async () => {
    await withDir(async (dir) => {
      const runRoot = join(dir, 'run-1');
      const events: string[] = [];
      let runLayout: ExperimentRunLayout | undefined;

      const summary = await runExperiment<{ decision: string }>({
        runRoot,
        prompts: (layout) => {
          events.push('prompts');
          return [{ path: join(layout.promptsDir, 'system.md'), content: 'hello prompt' }];
        },
        run: async (layout) => {
          runLayout = layout;
          // Directories and the prompt file must already exist before the run.
          assert.ok((await stat(layout.controllerDir)).isDirectory());
          assert.ok((await stat(layout.jobsDir)).isDirectory());
          assert.equal(
            await readFile(join(layout.promptsDir, 'system.md'), 'utf8'),
            'hello prompt',
          );
          // Artifacts must not be written yet.
          assert.deepEqual((await readdir(runRoot)).sort(), ['controller', 'jobs', 'prompts']);
          events.push('run');
          return { decision: 'keep' };
        },
        artifacts: (result, layout) => {
          events.push('artifacts');
          assert.equal(layout, runLayout);
          return [
            {
              path: join(runRoot, 'result.json'),
              content: `${JSON.stringify(result)}\n`,
            },
          ];
        },
      });

      assert.deepEqual(summary, { decision: 'keep' });
      assert.deepEqual(events, ['prompts', 'run', 'artifacts']);
      assert.equal(await readFile(join(runRoot, 'result.json'), 'utf8'), '{"decision":"keep"}\n');
    });
  });

  test('awaits an async artifacts builder', async () => {
    await withDir(async (dir) => {
      const runRoot = join(dir, 'run-2');
      await runExperiment<number>({
        runRoot,
        prompts: () => [],
        run: async () => 7,
        artifacts: async (value) => [{ path: join(runRoot, 'value.txt'), content: String(value) }],
      });
      assert.equal(await readFile(join(runRoot, 'value.txt'), 'utf8'), '7');
    });
  });
});
