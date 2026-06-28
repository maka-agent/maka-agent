import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkDestructiveShellCommand, formatDestructiveCommandGuardMessage } from '../destructive-command-guard.js';

describe('destructive-command guard', () => {
  test('allows ordinary build, test, and inspection commands', () => {
    for (const command of [
      'npm test',
      'python -m pytest tests/test_app.py',
      'grep -R needle src',
      'echo "rm -rf /app" # quoted/documentary text only',
      'chmod 644 output.txt',
    ]) {
      assert.equal(checkDestructiveShellCommand(command).allowed, true, command);
    }
  });

  test('blocks direct deletion and truncation commands', () => {
    for (const command of [
      'rm -f *.gcda *.gcno *.gcov',
      'rmdir build',
      'truncate -s 0 /app/report.jsonl',
      '/bin/rm /var/www/html/hello.html',
    ]) {
      const result = checkDestructiveShellCommand(command);
      assert.equal(result.allowed, false, command);
      assert.match(formatDestructiveCommandGuardMessage(result), /refused this Bash command/);
    }
  });

  test('blocks find/xargs deletion forms and recursive ownership changes', () => {
    for (const command of [
      'find . -name "*.gcno" -delete',
      'find . -type f -exec rm -f {} ;',
      'printf "%s\\n" a b | xargs rm -f',
      'chmod -R 777 /app',
      'chown --recursive root:root .',
    ]) {
      assert.equal(checkDestructiveShellCommand(command).allowed, false, command);
    }
  });

  test('blocks process and service control commands', () => {
    for (const command of [
      'kill $(ps aux | awk \'/qemu/ {print $2}\')',
      'pkill -f qemu',
      'killall node',
      'systemctl stop ssh',
      'service main restart',
    ]) {
      assert.equal(checkDestructiveShellCommand(command).allowed, false, command);
    }
  });

  test('blocks nested shell -c destructive commands through common wrappers', () => {
    for (const command of [
      "sh -c 'rm -rf /app/tmp'",
      "bash -lc 'find . -delete'",
      "env FOO=bar timeout 10s sudo rm -rf /app",
    ]) {
      assert.equal(checkDestructiveShellCommand(command).allowed, false, command);
    }
  });

  test('blocks forceful mv but allows non-recursive permission edits', () => {
    assert.equal(checkDestructiveShellCommand('mv -f new.txt report.txt').allowed, false);
    assert.equal(checkDestructiveShellCommand('mv draft.txt final.txt').allowed, true);
    assert.equal(checkDestructiveShellCommand('chown user:group report.txt').allowed, true);
  });
});
