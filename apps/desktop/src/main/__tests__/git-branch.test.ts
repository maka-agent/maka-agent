import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecFileException } from 'node:child_process';
import { listLocalBranches, checkoutBranch } from '../git-branch.js';

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

function fakeExecFile(onExecute: (args: readonly string[]) => {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}): ExecFileCallback {
  return (
    _file: string,
    args: readonly string[],
    _options: { cwd: string; timeout: number; windowsHide: boolean },
    cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    const result = onExecute(args);
    cb(result.error, result.stdout, result.stderr);
  };
}

function errnoException(code: string, message?: string): ExecFileException {
  const err = new Error(message ?? code) as NodeJS.ErrnoException & ExecFileException;
  err.code = code;
  err.name = 'Error';
  return err as unknown as ExecFileException;
}

async function withGitRepo(run: (gitRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-test-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('listLocalBranches', () => {
  it('parses `git branch --list` output with current branch marked by *', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile((args) => {
        assert.deepEqual(args, ['branch', '--list']);
        return { error: null, stdout: '* main\n  develop\n  feature/sidebar\n', stderr: '' };
      });
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, true);
      assert.deepEqual(result.branches, ['main', 'develop', 'feature/sidebar']);
      assert.equal(result.current, 'main');
    });
  });

  it('detects detached HEAD (no * branch)', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile(() => ({
        error: null,
        stdout: '* (HEAD detached at abc1234)\n  main\n  develop\n',
        stderr: '',
      }));
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, true);
      assert.deepEqual(result.branches, ['main', 'develop']);
      assert.equal(result.current, undefined);
    });
  });

  it('handles a single-branch repo', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile(() => ({
        error: null,
        stdout: '* main\n',
        stderr: '',
      }));
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, true);
      assert.deepEqual(result.branches, ['main']);
      assert.equal(result.current, 'main');
    });
  });

  it('deduplicates branch names', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile(() => ({
        error: null,
        stdout: '* main\n  develop\n  develop\n',
        stderr: '',
      }));
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, true);
      assert.deepEqual(result.branches, ['main', 'develop']);
      assert.equal(result.current, 'main');
    });
  });

  it('returns not-a-repo when project lacks .git metadata', async () => {
    const result = await listLocalBranches('/tmp/non-existent');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-a-repo');
  });

  it('returns missing-git when git binary is not found (ENOENT)', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile(() => ({
        error: errnoException('ENOENT', 'spawn git ENOENT'),
        stdout: '',
        stderr: '',
      }));
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'missing-git');
    });
  });

  it('returns timeout when git takes too long', async () => {
    await withGitRepo(async (root) => {
      const execFileImpl = fakeExecFile(() => ({
        error: Object.assign(errnoException('ETIMEDOUT', 'timeout'), { killed: true }),
        stdout: '',
        stderr: '',
      }));
      const result = await listLocalBranches(root, { execFileImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'timeout');
    });
  });
});

describe('checkoutBranch', () => {
  it('switches to a valid branch and returns the new branch name', async () => {
    await withGitRepo(async (root) => {
      const gitCalls: string[][] = [];
      const execFileImpl = fakeExecFile((args) => {
        gitCalls.push([...args]);
        return { error: null, stdout: '', stderr: '' };
      });
      const result = await checkoutBranch(root, 'develop', { execFileImpl });
      assert.ok(result.ok);
      assert.deepEqual(gitCalls, [
        ['status', '--porcelain'],
        ['checkout', 'develop'],
      ]);
    });
  });

  it('rejects invalid branch names', async () => {
    const result = await checkoutBranch('/fake/repo', 'bad; branch');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'failed');
    assert.match(result.message ?? '', /无效的分支名/);
  });

  it('rejects empty branch name', async () => {
    const result = await checkoutBranch('/fake/repo', '');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'failed');
  });

  it('refuses checkout when worktree is dirty', async () => {
    await withGitRepo(async (root) => {
      const gitCalls: string[][] = [];
      const execFileImpl = fakeExecFile((args) => {
        gitCalls.push([...args]);
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { error: null, stdout: 'M  index.ts\n', stderr: '' };
        }
        return { error: null, stdout: '', stderr: '' };
      });
      const result = await checkoutBranch(root, 'develop', { execFileImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'dirty');
      assert.equal(result.message, '工作区有未提交的更改，请先提交或暂存。');
      // The only git command that was run was `git status --porcelain`;
      // `git checkout` must NOT be called on a dirty worktree.
      assert.deepEqual(gitCalls, [['status', '--porcelain']]);
    });
  });

  it('fails closed when dirty-check status command fails', async () => {
    await withGitRepo(async (root) => {
      const gitCalls: string[][] = [];
      const execFileImpl = fakeExecFile((args) => {
        gitCalls.push([...args]);
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return {
            error: errnoException('EACCES', 'status failed'),
            stdout: '',
            stderr: 'fatal: cannot inspect worktree',
          };
        }
        return { error: null, stdout: '', stderr: '' };
      });
      const result = await checkoutBranch(root, 'develop', { execFileImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'failed');
      assert.equal(result.message, 'fatal: cannot inspect worktree');
      assert.deepEqual(gitCalls, [['status', '--porcelain']]);
    });
  });

  it('fails closed when dirty-check status command times out', async () => {
    await withGitRepo(async (root) => {
      const gitCalls: string[][] = [];
      const execFileImpl = fakeExecFile((args) => {
        gitCalls.push([...args]);
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return {
            error: Object.assign(errnoException('ETIMEDOUT', 'timeout'), { killed: true }),
            stdout: '',
            stderr: '',
          };
        }
        return { error: null, stdout: '', stderr: '' };
      });
      const result = await checkoutBranch(root, 'develop', { execFileImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'timeout');
      assert.deepEqual(gitCalls, [['status', '--porcelain']]);
    });
  });
});
