import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PERMISSION_POLICY,
  TOOL_CATEGORIES,
  TurnPermissionMemory,
  categorizeBash,
  classifyToolUse,
  createCanonicalToolIntent,
  matchToolPermissionRules,
  preToolUse,
  projectAdditionalPermissionReview,
  type PermissionMode,
  type PreToolUseResult,
  type ToolCategory,
} from '../permission.js';
import {
  InteractionPermissionProjectionError,
  canonicalToolExecutionArgs,
} from '../tool-intent.js';
import { ComputerUseIntentValidationError } from '../computer-use.js';

function canonical(toolName: string, args: unknown, categoryHint?: ToolCategory) {
  return createCanonicalToolIntent({
    toolName,
    args,
    cwd: '/workspace',
    ...(categoryHint === undefined ? {} : { categoryHint }),
  });
}

function evaluate(
  toolName: string,
  args: unknown,
  mode: PermissionMode,
  turnMemory = new TurnPermissionMemory(),
  categoryHint?: ToolCategory,
  sandbox?: { platformSandboxAvailable: boolean },
): PreToolUseResult {
  return preToolUse({
    intent: canonical(toolName, args, categoryHint),
    mode,
    turnMemory,
    ...(sandbox === undefined ? {} : { sandbox }),
  });
}

function requirePrompt(result: PreToolUseResult) {
  assert.equal(result.kind, 'prompt');
  if (result.kind !== 'prompt') throw new Error('Expected permission prompt');
  return result;
}

describe('tool classification', () => {
  test('built-in identity owns category even when a caller supplies a conflicting hint', () => {
    assert.equal(canonical('Write', { path: 'a', content: 'x' }, 'read').category, 'file_write');
    assert.equal(
      canonical('OfficeDocumentEdit', { path: 'a.docx', operation: 'create' }, 'read').category,
      'file_write',
    );
    assert.equal(
      canonical('ExploreAgent', { objective: 'Inspect local files' }, 'network_send').category,
      'subagent',
    );
    assert.equal(canonical('browser_click', { ref: '#save' }, 'read').category, 'browser');
    assert.equal(
      canonical('Bash', { command: 'rm obsolete.txt' }, 'read').category,
      'fs_destructive',
    );
    assert.equal(
      classifyToolUse({ toolName: 'mcp__server__send', args: {}, categoryHint: 'network_send' }),
      'network_send',
    );
    assert.equal(canonical('toString', {}).category, 'custom_tool');
  });

  test('Bash classifier scans command boundaries, wrappers, nested shells, and backticks', () => {
    const cases: readonly [string, ToolCategory][] = [
      ['ls -la', 'shell_unsafe'],
      ['git status', 'shell_unsafe'],
      ['rm file.txt', 'fs_destructive'],
      ['dd if=/dev/zero of=target', 'fs_destructive'],
      ['truncate -s 0 target', 'fs_destructive'],
      ['shred target', 'fs_destructive'],
      ['mkfs.ext4 /dev/example', 'fs_destructive'],
      ['git restore .', 'fs_destructive'],
      ['git checkout -- src/file.ts', 'fs_destructive'],
      ['echo ok; /bin/rm file.txt', 'fs_destructive'],
      ["& 'Remove-Item' target", 'fs_destructive'],
      ['Get-ChildItem; CLEAR-CONTENT target', 'fs_destructive'],
      ['cmd /c "echo ok & del target"', 'fs_destructive'],
      ['echo "$(rm file.txt)"', 'fs_destructive'],
      ['echo `rm file.txt`', 'fs_destructive'],
      ['nohup env FOO=bar timeout 30 rm file.txt', 'fs_destructive'],
      ["bash -c 'echo ok; rm target'", 'fs_destructive'],
      [String.raw`pwsh -Command "Write-Host ok; Remove-Item x"`, 'fs_destructive'],
      ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'fs_destructive'],
      ['find . -exec rm {} ;', 'fs_destructive'],
      ['echo ok | xargs rm', 'fs_destructive'],
      ['git reset --hard HEAD', 'git_destructive'],
      ['echo ok && git push --force origin main', 'git_destructive'],
      ['git branch -D obsolete', 'git_destructive'],
      ['git clean -fd', 'git_destructive'],
      ['git rebase -i HEAD~2', 'git_destructive'],
      ['sudo true', 'privileged'],
      ['Get-Process app | kill', 'privileged'],
      ['Start-Process app -Verb RunAs', 'privileged'],
      ['sc stop service-name', 'privileged'],
      ['net start service-name', 'privileged'],
      ['Restart-Computer', 'privileged'],
      ['icacls target /grant user:F', 'privileged'],
      ['R`M file.txt', 'fs_destructive'],
      ['de^l file.txt', 'fs_destructive'],
      ['Stop`-Process 123', 'privileged'],
    ];

    for (const [command, expected] of cases) {
      assert.equal(categorizeBash(command), expected, command);
    }
  });

  test('destructive text that is not a command head does not upgrade the reason', () => {
    for (const command of ['echo rm file.txt', 'printf "git reset --hard"', 'echo Remove-Item']) {
      assert.equal(categorizeBash(command), 'shell_unsafe', command);
    }
  });
});

describe('preToolUse policy', () => {
  test('returns explicit allow, block, and prompt variants', () => {
    assert.deepEqual(evaluate('Read', { path: 'README.md' }, 'explore'), {
      kind: 'allow',
      category: 'read',
      source: 'policy',
    });

    const blocked = evaluate('Write', { path: 'a.txt', content: 'x' }, 'explore');
    assert.equal(blocked.kind, 'block');
    if (blocked.kind === 'block') {
      assert.equal(blocked.category, 'file_write');
      assert.match(blocked.reason, /blocked/);
    }

    const prompted = requirePrompt(
      evaluate('Write', { path: 'a.txt', content: 'private file content' }, 'ask'),
    );
    assert.deepEqual(prompted.prompt, {
      kind: 'tool_permission',
      toolName: 'Write',
      category: 'file_write',
      reason: 'file_write',
      review: {
        kind: 'path',
        operation: 'write',
        path: 'a.txt',
        cwd: '/workspace',
      },
      rememberForTurnAllowed: true,
    });
  });

  test('execute only auto-allows ordinary shell when sandbox enforcement is available', () => {
    const args = { command: 'npm install lodash' };
    assert.equal(
      evaluate('Bash', args, 'execute', new TurnPermissionMemory(), undefined, {
        platformSandboxAvailable: true,
      }).kind,
      'allow',
    );
    assert.equal(
      evaluate('Bash', args, 'execute', new TurnPermissionMemory(), undefined, {
        platformSandboxAvailable: false,
      }).kind,
      'prompt',
    );
    assert.equal(
      evaluate(
        'Bash',
        { command: 'rm file.txt' },
        'execute',
        new TurnPermissionMemory(),
        undefined,
        {
          platformSandboxAvailable: true,
        },
      ).kind,
      'prompt',
    );
  });

  test('bypass allows all categories without constructing an approval projection', () => {
    const unsupported = canonical(
      'mcp__server__send',
      { serverId: 'server', toolName: 'send', arguments: { private: 'value' } },
      'network_send',
    );
    assert.deepEqual(
      preToolUse({
        intent: unsupported,
        mode: 'bypass',
        turnMemory: new TurnPermissionMemory(),
      }),
      {
        kind: 'allow',
        category: 'network_send',
        source: 'policy',
      },
    );
  });

  test('MCP prompt admission remains fail closed without a closed review', () => {
    assert.throws(
      () =>
        evaluate(
          'mcp__server__send',
          { serverId: 'server', toolName: 'send', arguments: {} },
          'ask',
          new TurnPermissionMemory(),
          'network_send',
        ),
      InteractionPermissionProjectionError,
    );
  });

  test('asks with closed reviews while retaining private Office and ExploreAgent execution args', () => {
    const officeArgs = {
      path: 'report.docx',
      operation: 'set',
      target: '/body/p[1]',
      props: { text: 'private report body', reviewed: false },
    };
    const officeIntent = canonical('OfficeDocumentEdit', officeArgs);
    const office = requirePrompt(
      preToolUse({
        intent: officeIntent,
        mode: 'ask',
        turnMemory: new TurnPermissionMemory(),
      }),
    );
    assert.deepEqual(canonicalToolExecutionArgs(officeIntent), officeArgs);
    assert.deepEqual(office.prompt.review, {
      kind: 'path',
      operation: 'edit',
      path: 'report.docx',
      cwd: '/workspace',
    });
    assert.equal(office.prompt.rememberForTurnAllowed, true);

    const exploreArgs = {
      objective: 'Find private permission ownership evidence',
      roots: ['packages/core/src'],
      queries: ['private query'],
      ignorePaths: ['private-output'],
      stoppingCondition: 'Stop after private ownership is established',
      maxFiles: 30,
      maxMatches: 60,
    };
    const exploreIntent = canonical('ExploreAgent', exploreArgs);
    const explore = requirePrompt(
      preToolUse({
        intent: exploreIntent,
        mode: 'ask',
        turnMemory: new TurnPermissionMemory(),
      }),
    );
    assert.deepEqual(canonicalToolExecutionArgs(exploreIntent), exploreArgs);
    assert.deepEqual(explore.prompt.review, {
      kind: 'agent',
      operation: 'spawn',
      profile: 'local_read',
      writeBack: 'summary',
      isolation: 'same_workspace',
    });
    assert.equal(explore.rememberScope, undefined);
    assert.equal(explore.prompt.rememberForTurnAllowed, false);
  });

  test('real Bash optional controls do not create a generic argument review', () => {
    const result = requirePrompt(
      evaluate(
        'Bash',
        {
          command: 'echo token=opaque-secret',
          timeout_ms: 10_000,
          run_in_background: true,
          pty: true,
          sandbox_permissions: {
            mode: 'with_additional_permissions',
            file_system: {
              entries: [{ path: '/tmp/output', access: 'write', scope: 'subtree' }],
            },
            network: true,
            justification: 'Build the requested artifact',
          },
        },
        'ask',
      ),
    );

    assert.deepEqual(result.prompt.review, {
      kind: 'command',
      command: 'echo token=REDACTED',
      cwd: '/workspace',
    });
  });
});

describe('turn-local permission memory', () => {
  test('remembering an opaque scope authorizes only the same private material', () => {
    const memory = new TurnPermissionMemory();
    const first = requirePrompt(
      evaluate('Write', { path: 'a.txt', content: 'first private body' }, 'ask', memory),
    );
    assert.ok(first.rememberScope);
    memory.remember(first.rememberScope!);

    const same = evaluate(
      'Write',
      { path: 'a.txt', content: 'different private body' },
      'ask',
      memory,
    );
    assert.deepEqual(same, {
      kind: 'allow',
      category: 'file_write',
      source: 'remembered',
    });

    assert.equal(
      evaluate('Write', { path: 'b.txt', content: 'first private body' }, 'ask', memory).kind,
      'prompt',
    );
  });

  test('OfficeDocumentEdit remember scope follows the document path, not private edits', () => {
    const memory = new TurnPermissionMemory();
    const create = requirePrompt(
      evaluate('OfficeDocumentEdit', { path: 'report.docx', operation: 'create' }, 'ask', memory),
    );
    memory.remember(create.rememberScope!);

    assert.deepEqual(
      evaluate(
        'OfficeDocumentEdit',
        {
          path: 'report.docx',
          operation: 'set',
          target: '/body/p[1]',
          props: { text: 'different private body' },
        },
        'ask',
        memory,
      ),
      {
        kind: 'allow',
        category: 'file_write',
        source: 'remembered',
      },
    );
    assert.equal(
      evaluate(
        'OfficeDocumentEdit',
        { path: 'other.docx', operation: 'remove', target: '/body/p[1]' },
        'ask',
        memory,
      ).kind,
      'prompt',
    );
  });

  test('opaque scope identity cannot cross turn owners', () => {
    const firstTurn = new TurnPermissionMemory();
    const secondTurn = new TurnPermissionMemory();
    const prompt = requirePrompt(
      evaluate('Write', { path: 'a.txt', content: 'x' }, 'ask', firstTurn),
    );
    assert.ok(prompt.rememberScope);
    assert.throws(() => secondTurn.remember(prompt.rememberScope!), TypeError);
    assert.throws(() => secondTurn.isRemembered(prompt.rememberScope!), TypeError);
  });

  test('remember scope preserves cwd and exact Bash command semantics', () => {
    const pathMemory = new TurnPermissionMemory();
    const firstPath = requirePrompt(
      preToolUse({
        intent: createCanonicalToolIntent({
          toolName: 'Write',
          args: { path: 'same.txt', content: 'private' },
          cwd: '/workspace/one',
        }),
        mode: 'ask',
        turnMemory: pathMemory,
      }),
    );
    pathMemory.remember(firstPath.rememberScope!);
    assert.equal(
      preToolUse({
        intent: createCanonicalToolIntent({
          toolName: 'Write',
          args: { path: 'same.txt', content: 'changed' },
          cwd: '/workspace/two',
        }),
        mode: 'ask',
        turnMemory: pathMemory,
      }).kind,
      'prompt',
    );

    const commandMemory = new TurnPermissionMemory();
    const firstCommand = requirePrompt(
      preToolUse({
        intent: createCanonicalToolIntent({
          toolName: 'Bash',
          args: { command: "printf '%s' 'a  b'" },
          cwd: '/workspace',
        }),
        mode: 'ask',
        turnMemory: commandMemory,
      }),
    );
    commandMemory.remember(firstCommand.rememberScope!);
    assert.equal(
      preToolUse({
        intent: createCanonicalToolIntent({
          toolName: 'Bash',
          args: { command: "printf '%s' 'a b'" },
          cwd: '/workspace',
        }),
        mode: 'ask',
        turnMemory: commandMemory,
      }).kind,
      'prompt',
    );
  });

  test('WriteStdin approves only complete literals and is never rememberable', () => {
    const input = [
      'token="alpha-opaque"',
      'visible after first',
      "password='beta-opaque'",
      'visible after second',
    ].join('\n');
    const prompt = requirePrompt(
      evaluate(
        'WriteStdin',
        {
          ref: 'maka://runtime/background-tasks/pty-1',
          input,
          size: { cols: 120, rows: 40 },
        },
        'ask',
      ),
    );

    assert.equal(prompt.rememberScope, undefined);
    assert.deepEqual(prompt.prompt.review, {
      kind: 'stdin',
      ref: 'maka://runtime/background-tasks/pty-1',
      input: {
        text: String.raw`token="REDACTED"\u{000A}visible after first\u{000A}password='REDACTED'\u{000A}visible after second`,
        bytes: new TextEncoder().encode(input).byteLength,
      },
      size: { cols: 120, rows: 40 },
    });
    assert.equal(prompt.prompt.rememberForTurnAllowed, false);

    assert.throws(
      () =>
        evaluate(
          'WriteStdin',
          {
            ref: 'maka://runtime/background-tasks/pty-1',
            input: 'token=alpha/opaque-tail\nvisible after secret',
          },
          'ask',
        ),
      InteractionPermissionProjectionError,
    );
  });

  test('one browser approval carries the closed browser loop for the turn', () => {
    const memory = new TurnPermissionMemory();
    const navigate = requirePrompt(
      evaluate(
        'browser_navigate',
        { url: 'https://example.test/account?token=opaque-token&tab=billing' },
        'ask',
        memory,
      ),
    );
    assert.deepEqual(navigate.prompt.review, {
      kind: 'browser',
      action: 'navigate',
      url: 'https://example.test/account?token=REDACTED&tab=billing',
    });
    memory.remember(navigate.rememberScope!);

    assert.deepEqual(evaluate('browser_click', { ref: '#confirm' }, 'ask', memory), {
      kind: 'allow',
      category: 'browser',
      source: 'remembered',
    });
  });

  test('Computer Use scope separates metadata, screenshots, and observed mutation actions', () => {
    const memory = new TurnPermissionMemory();
    const metadataArgs = {
      action: 'observe',
      app: 'Editor',
      window_id: 7,
      include_screenshot: false,
    };
    const metadata = requirePrompt(evaluate('maka_computer', metadataArgs, 'execute', memory));
    memory.remember(metadata.rememberScope!);

    assert.equal(evaluate('maka_computer', metadataArgs, 'execute', memory).kind, 'allow');
    assert.equal(
      evaluate(
        'maka_computer',
        {
          ...metadataArgs,
          include_screenshot: true,
        },
        'execute',
        memory,
      ).kind,
      'prompt',
    );
    assert.equal(
      evaluate(
        'maka_computer',
        {
          action: 'type',
          app: 'Editor',
          window_id: 7,
          observation_id: 'frame-7',
          text: 'private input',
        },
        'execute',
        memory,
      ).kind,
      'prompt',
    );
  });
});

describe('canonical intent and rule boundaries', () => {
  test('execution consumes the original private canonical values, never the public review', () => {
    const intent = canonical('browser_type', {
      ref: '#password',
      text: 'Authorization: Basic dXNlcjpwYXNz=',
      submit: true,
    });

    assert.deepEqual(canonicalToolExecutionArgs(intent), {
      ref: '#password',
      text: 'Authorization: Basic dXNlcjpwYXNz=',
      submit: true,
    });
    assert.deepEqual(
      requirePrompt(
        preToolUse({
          intent,
          mode: 'ask',
          turnMemory: new TurnPermissionMemory(),
        }),
      ).prompt.review,
      {
        kind: 'browser',
        action: 'type',
        ref: '#password',
        text: 'Authorization: Basic REDACTED',
        submit: true,
      },
    );
  });

  test('permission rules match authenticated canonical intent and deny wins', () => {
    const intent = canonical('Bash', { command: 'npm test' });
    assert.equal(
      matchToolPermissionRules({
        intent,
        rules: [{ effect: 'allow', kind: 'bash_exact', command: 'npm test' }],
      }),
      'allow',
    );
    assert.equal(
      matchToolPermissionRules({
        intent,
        rules: [
          { effect: 'allow', kind: 'tool', toolName: 'Bash' },
          { effect: 'deny', kind: 'category', category: 'shell_unsafe' },
        ],
      }),
      'deny',
    );
  });

  test('policy and explicit rules reject structural copies of canonical intents', () => {
    const intent = canonical('Read', { path: 'README.md' });
    const forged = { ...intent } as typeof intent;

    assert.throws(
      () =>
        preToolUse({
          intent: forged,
          mode: 'explore',
          turnMemory: new TurnPermissionMemory(),
        }),
      TypeError,
    );
    assert.throws(
      () =>
        matchToolPermissionRules({
          intent: forged,
          rules: [{ effect: 'allow', kind: 'category', category: 'read' }],
        }),
      TypeError,
    );
  });

  test('unknown and malformed Computer Use actions fail during canonicalization', () => {
    assert.throws(
      () =>
        canonical('maka_computer', {
          action: 'future_action',
        }),
      ComputerUseIntentValidationError,
    );
    assert.throws(
      () =>
        canonical('maka_computer', {
          action: 'type',
          observation_id: 'frame-1',
          text: 'x',
        }),
      ComputerUseIntentValidationError,
    );
  });
});

describe('additional permission public projection', () => {
  test('projects only closed path/network risk semantics', () => {
    assert.deepEqual(
      projectAdditionalPermissionReview({
        cwd: '/workspace',
        profile: {
          fileSystem: {
            entries: [
              {
                path: '/tmp/token=opaque-secret',
                access: 'write',
                scope: 'subtree',
              },
            ],
          },
          network: { enabled: true },
        },
      }),
      {
        kind: 'additional_permissions',
        cwd: '/workspace',
        paths: [
          {
            path: '/tmp/token=REDACTED',
            access: 'write',
            scope: 'subtree',
          },
        ],
        networkEnabled: true,
      },
    );
  });

  test('fails closed when a path cannot be completely redacted', () => {
    assert.throws(
      () =>
        projectAdditionalPermissionReview({
          cwd: '/workspace',
          profile: {
            fileSystem: {
              entries: [
                {
                  path: '/tmp/sk-ant-abcdefghijklmnop',
                  access: 'read',
                  scope: 'exact',
                },
              ],
            },
          },
        }),
      InteractionPermissionProjectionError,
    );
  });
});

describe('permission matrix', () => {
  test('defines every mode/category pair and preserves irreversible prompts', () => {
    for (const mode of ['explore', 'ask', 'execute', 'bypass'] as const) {
      assert.deepEqual(Object.keys(PERMISSION_POLICY[mode]).sort(), [...TOOL_CATEGORIES].sort());
    }
    for (const category of [
      'fs_destructive',
      'git_destructive',
      'privileged',
      'browser',
      'computer_use',
    ] as const) {
      assert.equal(PERMISSION_POLICY.execute[category], 'prompt');
    }
    for (const category of TOOL_CATEGORIES) {
      assert.equal(PERMISSION_POLICY.bypass[category], 'allow');
    }
  });
});
