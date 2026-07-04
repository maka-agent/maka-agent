import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveMakaWorkspaceRoot } from '../workspace-root.js';

describe('Maka workspace root resolver', () => {
  test('resolves the desktop default workspace under Electron userData on macOS', () => {
    assert.equal(
      resolveMakaWorkspaceRoot({ platform: 'darwin', homeDir: '/Users/ada', env: {} }),
      '/Users/ada/Library/Application Support/Maka/workspaces/default',
    );
  });

  test('resolves the desktop default workspace under Electron userData on Linux', () => {
    assert.equal(
      resolveMakaWorkspaceRoot({ platform: 'linux', homeDir: '/home/ada', env: {} }),
      '/home/ada/.config/Maka/workspaces/default',
    );
  });

  test('resolves the desktop default workspace under Electron userData on Windows', () => {
    assert.equal(
      resolveMakaWorkspaceRoot({
        platform: 'win32',
        homeDir: 'C:\\Users\\Ada',
        env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
      }),
      'C:\\Users\\Ada\\AppData\\Roaming\\Maka\\workspaces\\default',
    );
  });
});
