import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createCanonicalToolIntent,
  preToolUse,
  TurnPermissionMemory,
  type ToolCategory,
} from '../permission.js';
import {
  InteractionPermissionProjectionError,
  canonicalToolExecutionArgs,
  canonicalToolRememberScopeMaterial,
  decodePublicToolIntentReview,
  projectPublicToolApprovalReview,
  projectPublicToolIntentReview,
  publicToolReviewMatchesIdentity,
  publicToolReviewRememberAllowed,
  requireCanonicalToolIntent,
} from '../tool-intent.js';

function canonical(toolName: string, args: unknown, categoryHint?: ToolCategory) {
  return createCanonicalToolIntent({
    toolName,
    args,
    cwd: '/workspace',
    ...(categoryHint === undefined ? {} : { categoryHint }),
  });
}

const PRODUCERS: readonly {
  readonly toolName: string;
  readonly args: unknown;
  readonly categoryHint?: ToolCategory;
  readonly reviewKind: string;
}[] = [
  { toolName: 'Read', args: { path: 'README.md', offset: 0, limit: 20 }, reviewKind: 'path' },
  {
    toolName: 'Read',
    args: { ref: 'maka://runtime/background-tasks/task-1' },
    reviewKind: 'runtime_resource',
  },
  { toolName: 'Write', args: { path: 'a.txt', content: 'private body' }, reviewKind: 'path' },
  {
    toolName: 'Edit',
    args: { path: 'a.txt', old_string: 'old', new_string: 'new' },
    reviewKind: 'path',
  },
  { toolName: 'FormatJson', args: { path: 'a.json', sort_keys: true }, reviewKind: 'path' },
  {
    toolName: 'OfficeDocumentEdit',
    args: {
      path: 'report.docx',
      operation: 'add',
      target: '/body',
      elementType: 'paragraph',
      props: { text: 'private document body', level: 2, enabled: true },
      index: 0,
    },
    reviewKind: 'path',
  },
  { toolName: 'Glob', args: { pattern: '**/*.ts', cwd: 'src' }, reviewKind: 'search' },
  {
    toolName: 'Grep',
    args: { pattern: 'permission', path: 'src', glob: '*.ts' },
    reviewKind: 'search',
  },
  { toolName: 'search_files', args: { pattern: 'permission', path: 'src' }, reviewKind: 'search' },
  { toolName: 'Bash', args: { command: 'npm test', timeout_ms: 10_000 }, reviewKind: 'command' },
  {
    toolName: 'WriteStdin',
    args: { ref: 'maka://runtime/background-tasks/pty-1', input: 'y\r' },
    reviewKind: 'stdin',
  },
  { toolName: 'WebFetch', args: { url: 'https://example.test' }, reviewKind: 'web' },
  { toolName: 'WebSearch', args: { query: 'current standards' }, reviewKind: 'web' },
  {
    toolName: 'patch',
    args: { operation: { type: 'delete_file', path: 'src/old.ts' }, callId: 'patch-1' },
    reviewKind: 'patch',
  },
  {
    toolName: 'apply_patch',
    args: { operation: { type: 'update_file', path: 'src/new.ts', diff: '@@ -1 +1 @@' } },
    reviewKind: 'patch',
  },
  { toolName: 'browser_navigate', args: { url: 'https://example.test' }, reviewKind: 'browser' },
  { toolName: 'browser_snapshot', args: {}, reviewKind: 'browser' },
  { toolName: 'browser_click', args: { ref: '#save' }, reviewKind: 'browser' },
  {
    toolName: 'browser_type',
    args: { ref: '#name', text: 'private', submit: false },
    reviewKind: 'browser',
  },
  { toolName: 'browser_wait', args: { selector: '#done', timeout: 15 }, reviewKind: 'browser' },
  { toolName: 'browser_extract', args: { selector: '#result', start: 0 }, reviewKind: 'browser' },
  {
    toolName: 'agent_spawn',
    args: {
      profile: 'local_read',
      task: 'private delegated task',
      write_back: 'summary',
      isolation: 'same_workspace',
      task_id: 'task-1',
    },
    reviewKind: 'agent',
  },
  {
    toolName: 'agent_swarm',
    args: {
      items: [
        {
          item_id: 'private-item-1',
          profile: 'local_read',
          task: 'private delegated task one',
          write_back: 'summary',
          isolation: 'same_workspace',
        },
        {
          item_id: 'private-item-2',
          profile: 'local_read',
          task: 'private delegated task two',
          write_back: 'summary',
          isolation: 'same_workspace',
        },
      ],
      max_concurrency: 3,
    },
    reviewKind: 'agent',
  },
  {
    toolName: 'ExploreAgent',
    args: {
      objective: 'Inspect the private permission boundary',
      roots: ['packages/core/src'],
      queries: ['permission', 'private-token'],
      ignorePaths: ['dist'],
      stoppingCondition: 'Return the owning modules and evidence',
      maxFiles: 40,
      maxMatches: 80,
    },
    reviewKind: 'agent',
  },
  {
    toolName: 'expert_dispatch',
    args: { member: 'security', task: 'private expert task' },
    reviewKind: 'agent',
  },
  {
    toolName: 'StopBackgroundTask',
    args: { ref: 'maka://runtime/background-tasks/task-1' },
    reviewKind: 'runtime_resource',
  },
  { toolName: 'Skill', args: { name: 'review' }, reviewKind: 'skill' },
  {
    toolName: 'AskUserQuestion',
    args: { questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] },
    reviewKind: 'question',
  },
  {
    toolName: 'maka_computer',
    args: { action: 'observe', app: 'Editor', include_screenshot: false },
    reviewKind: 'computer_use',
  },
];

describe('canonical tool intent', () => {
  test('deep-clones and freezes the sole execution/review intent', () => {
    const nested = { headers: ['private-token'] };
    const args = { url: 'https://example.test', nested };
    const intent = canonical('CustomRead', args, 'read');

    nested.headers[0] = 'changed';
    args.url = 'https://changed.test';

    assert.deepEqual(canonicalToolExecutionArgs(intent), {
      url: 'https://example.test',
      nested: { headers: ['private-token'] },
    });
    assert.ok(Object.isFrozen(intent));
    assert.ok(Object.isFrozen(canonicalToolExecutionArgs(intent)));
    assert.ok(Object.isFrozen((canonicalToolExecutionArgs(intent) as { nested: object }).nested));
  });

  test('authenticates canonical identity instead of accepting structural copies', () => {
    const intent = canonical('Write', { path: 'a.txt', content: 'private' });
    assert.doesNotThrow(() => requireCanonicalToolIntent(intent));
    assert.throws(() => requireCanonicalToolIntent({ ...intent }), TypeError);
    assert.throws(() => canonicalToolExecutionArgs({ ...intent } as typeof intent), TypeError);
  });

  test('rejects cyclic, accessor-backed, sparse, and malformed Unicode arguments', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'value';
    const disguisedSparse = new Array(2);
    disguisedSparse[1] = 'value';
    Object.defineProperty(disguisedSparse, Symbol('padding'), {
      value: 'not-an-array-element',
      enumerable: true,
    });
    let getterReads = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'private';
      },
    });
    let arrayGetterReads = 0;
    const accessorArray = ['placeholder'];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        arrayGetterReads += 1;
        return 'private';
      },
    });

    for (const args of [
      cyclic,
      sparse,
      disguisedSparse,
      accessorArray,
      { value: '\uD800' },
      accessor,
    ]) {
      assert.throws(() => canonical('Custom', args), TypeError);
    }
    assert.equal(getterReads, 0);
    assert.equal(arrayGetterReads, 0);
  });

  test('Bash classification never reads accessor-backed private arguments', () => {
    let getterReads = 0;
    const args = Object.defineProperty({}, 'command', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'rm private.txt';
      },
    });

    assert.throws(() => canonical('Bash', args), TypeError);
    assert.equal(getterReads, 0);
  });
});

describe('closed public tool reviews', () => {
  test('projects every known producer into a strict JSON round-trip', () => {
    for (const producer of PRODUCERS) {
      const intent = canonical(producer.toolName, producer.args, producer.categoryHint);
      const review = projectPublicToolIntentReview(intent);
      assert.ok(review, producer.toolName);
      assert.equal(review.kind, producer.reviewKind, producer.toolName);
      assert.deepEqual(
        decodePublicToolIntentReview(JSON.parse(JSON.stringify(review))),
        review,
        producer.toolName,
      );
      assert.ok(Object.isFrozen(review), producer.toolName);
    }
  });

  test('keeps private payloads executable while exposing only risk semantics', () => {
    const intent = canonical('agent_spawn', {
      profile: 'local_read',
      task: 'Inspect Authorization: Basic dXNlcjpwYXNz=',
      write_back: 'summary',
      isolation: 'same_workspace',
    });

    assert.deepEqual(canonicalToolExecutionArgs(intent), {
      profile: 'local_read',
      task: 'Inspect Authorization: Basic dXNlcjpwYXNz=',
      write_back: 'summary',
      isolation: 'same_workspace',
    });
    assert.deepEqual(projectPublicToolApprovalReview(intent), {
      kind: 'agent',
      operation: 'spawn',
      profile: 'local_read',
      writeBack: 'summary',
      isolation: 'same_workspace',
    });
  });

  test('canonicalizes and admits a non-rememberable swarm with only aggregate public risk', () => {
    const args = {
      items: [
        {
          item_id: 'private-alpha',
          profile: 'local_read',
          task: 'Inspect Authorization: Basic dXNlcjpwYXNz=',
          write_back: 'summary',
          isolation: 'same_workspace',
        },
        {
          item_id: 'private-beta',
          profile: 'local_read',
          task: 'Find private deployment credentials',
          write_back: 'patch',
          isolation: 'worktree',
        },
        {
          item_id: 'private-gamma',
          profile: 'web_research',
          task: 'Research a private launch plan',
          write_back: 'summary',
          isolation: 'same_workspace',
        },
      ],
      max_concurrency: 3,
    };
    const intent = canonical('agent_swarm', args);
    const review = projectPublicToolApprovalReview(intent);

    assert.deepEqual(canonicalToolExecutionArgs(intent), args);
    assert.deepEqual(review, {
      kind: 'agent',
      operation: 'swarm',
      itemCount: 3,
      resumeCount: 0,
      concurrency: 3,
      profiles: ['local_read', 'web_research'],
      writeBack: ['summary', 'patch'],
      isolation: ['same_workspace', 'worktree'],
    });
    assert.deepEqual(decodePublicToolIntentReview(JSON.parse(JSON.stringify(review))), review);
    assert.doesNotMatch(
      JSON.stringify(review),
      /Authorization|credentials|launch plan|private-alpha|private-beta|private-gamma/,
    );
    assert.equal(intent.category, 'subagent');
    assert.equal(
      publicToolReviewMatchesIdentity({
        toolName: intent.toolName,
        category: intent.category,
        review,
      }),
      true,
    );
    assert.equal(
      publicToolReviewRememberAllowed({
        toolName: intent.toolName,
        category: intent.category,
        review,
      }),
      false,
    );
    assert.equal(canonicalToolRememberScopeMaterial(intent), undefined);

    const admission = preToolUse({
      intent,
      mode: 'ask',
      turnMemory: new TurnPermissionMemory(),
    });
    assert.equal(admission.kind, 'prompt');
    if (admission.kind !== 'prompt') throw new Error('Expected permission prompt');
    assert.equal('rememberScope' in admission, false);
    assert.equal(admission.prompt.rememberForTurnAllowed, false);
    assert.deepEqual(admission.prompt.review, review);
  });

  test('projects resume-only and mixed swarms without exposing resume or task identities', () => {
    const resumeOnlyArgs = {
      items: [],
      resume_run_ids: {
        'private-run-alpha': 'Continue private task alpha',
        'private-run-beta': 'Continue private task beta',
      },
      max_concurrency: 3,
    };
    const resumeOnlyIntent = canonical('agent_swarm', resumeOnlyArgs);
    const resumeOnlyReview = projectPublicToolApprovalReview(resumeOnlyIntent);
    assert.deepEqual(canonicalToolExecutionArgs(resumeOnlyIntent), resumeOnlyArgs);
    assert.deepEqual(resumeOnlyReview, {
      kind: 'agent',
      operation: 'swarm',
      itemCount: 2,
      resumeCount: 2,
      concurrency: 3,
      profiles: [],
      writeBack: [],
      isolation: [],
    });
    assert.deepEqual(
      decodePublicToolIntentReview(JSON.parse(JSON.stringify(resumeOnlyReview))),
      resumeOnlyReview,
    );

    const mixedArgs = {
      items: [
        {
          item_id: 'private-new-item',
          profile: 'local_read',
          task: 'Inspect private task gamma',
          write_back: 'summary',
          isolation: 'same_workspace',
        },
      ],
      resume_run_ids: { 'private-run-gamma': 'Continue private task delta' },
      max_concurrency: 2,
    };
    const mixedIntent = canonical('agent_swarm', mixedArgs);
    const mixedReview = projectPublicToolApprovalReview(mixedIntent);
    assert.deepEqual(canonicalToolExecutionArgs(mixedIntent), mixedArgs);
    assert.deepEqual(mixedReview, {
      kind: 'agent',
      operation: 'swarm',
      itemCount: 2,
      resumeCount: 1,
      concurrency: 2,
      profiles: ['local_read'],
      writeBack: ['summary'],
      isolation: ['same_workspace'],
    });
    assert.deepEqual(decodePublicToolIntentReview(JSON.parse(JSON.stringify(mixedReview))), mixedReview);
    assert.doesNotMatch(
      JSON.stringify({ resumeOnlyReview, mixedReview }),
      /private-run|private task|private-new-item/,
    );
  });

  test('fails closed for non-canonical swarm args and malformed public summaries', () => {
    const item = {
      item_id: 'item-1',
      profile: 'local_read',
      task: 'private task',
      write_back: 'summary',
      isolation: 'same_workspace',
    };
    const malformedArgs = [
      { items: [item] },
      {
        items: [
          {
            item_id: item.item_id,
            profile: item.profile,
            task: item.task,
            isolation: item.isolation,
          },
        ],
        max_concurrency: 3,
      },
      { items: [{ ...item, futureControl: true }], max_concurrency: 3 },
      { items: [item, item], max_concurrency: 3 },
      { items: [], max_concurrency: 3 },
      { items: [], resume_run_ids: {}, max_concurrency: 3 },
      { items: [], resume_run_ids: { ' run-1': 'Continue.' }, max_concurrency: 3 },
      { items: [], resume_run_ids: { 'run-1': '' }, max_concurrency: 3 },
      {
        items: Array.from({ length: 33 }, (_, index) => ({
          ...item,
          item_id: `item-${index}`,
        })),
        max_concurrency: 3,
      },
      {
        items: Array.from({ length: 32 }, (_, index) => ({
          ...item,
          item_id: `item-${index}`,
        })),
        resume_run_ids: { 'run-extra': 'Continue.' },
        max_concurrency: 3,
      },
      { items: [item], max_concurrency: 6 },
    ];
    for (const args of malformedArgs) {
      assert.throws(
        () => projectPublicToolApprovalReview(canonical('agent_swarm', args)),
        InteractionPermissionProjectionError,
      );
    }

    const review = {
      kind: 'agent',
      operation: 'swarm',
      itemCount: 2,
      resumeCount: 0,
      concurrency: 3,
      profiles: ['local_read'],
      writeBack: ['summary'],
      isolation: ['same_workspace'],
    };
    assert.throws(
      () => decodePublicToolIntentReview({ ...review, task: 'private task' }),
      InteractionPermissionProjectionError,
    );
    const { resumeCount: _resumeCount, ...legacyReview } = review;
    assert.throws(
      () => decodePublicToolIntentReview(legacyReview),
      InteractionPermissionProjectionError,
    );
    for (const malformedReview of [
      { ...review, profiles: [] },
      { ...review, profiles: ['local_read', 'local_read'] },
      { ...review, profiles: ['local_read', 'web', 'code'] },
      { ...review, itemCount: 1, writeBack: ['summary', 'patch'] },
      { ...review, resumeCount: 1, profiles: [] },
      { ...review, resumeCount: -1 },
      { ...review, resumeCount: 0.5 },
      { ...review, resumeCount: 3 },
      { ...review, resumeCount: 2, writeBack: [], isolation: [], profiles: ['local_read'] },
      { ...review, profiles: new Array(1) },
    ]) {
      assert.throws(() => decodePublicToolIntentReview(malformedReview), TypeError);
    }
  });

  test('projects Office document writes by path while preserving complete edit arguments', () => {
    const args = {
      path: 'private-report.docx',
      operation: 'add',
      target: '/body',
      elementType: 'paragraph',
      props: {
        text: 'Authorization: Basic dXNlcjpwYXNz=',
        level: 2,
        enabled: true,
      },
      index: 3,
    };
    const intent = canonical('OfficeDocumentEdit', args);

    assert.deepEqual(canonicalToolExecutionArgs(intent), args);
    assert.deepEqual(projectPublicToolApprovalReview(intent), {
      kind: 'path',
      operation: 'edit',
      path: 'private-report.docx',
      cwd: '/workspace',
    });
    assert.deepEqual(
      projectPublicToolApprovalReview(
        canonical('OfficeDocumentEdit', {
          path: 'new-report.docx',
          operation: 'create',
        }),
      ),
      {
        kind: 'path',
        operation: 'write',
        path: 'new-report.docx',
        cwd: '/workspace',
      },
    );
    for (const operation of ['add', 'set', 'remove'] as const) {
      assert.deepEqual(
        projectPublicToolApprovalReview(
          canonical('OfficeDocumentEdit', {
            path: 'existing-report.docx',
            operation,
          }),
        ),
        {
          kind: 'path',
          operation: 'edit',
          path: 'existing-report.docx',
          cwd: '/workspace',
        },
      );
    }
  });

  test('projects ExploreAgent as a fixed local-read spawn without exposing its task', () => {
    const args = {
      objective: 'Inspect Authorization: Basic dXNlcjpwYXNz=',
      roots: ['packages/core/src'],
      queries: ['private permission query'],
      ignorePaths: ['private-generated-output'],
      stoppingCondition: 'Stop after finding private ownership evidence',
      maxFiles: 30,
      maxMatches: 60,
    };
    const intent = canonical('ExploreAgent', args);

    assert.deepEqual(canonicalToolExecutionArgs(intent), args);
    const review = projectPublicToolApprovalReview(intent);
    assert.deepEqual(review, {
      kind: 'agent',
      operation: 'spawn',
      profile: 'local_read',
      writeBack: 'summary',
      isolation: 'same_workspace',
    });
    assert.doesNotMatch(
      JSON.stringify(review),
      /Authorization|permission query|generated-output|ownership/,
    );
  });

  test('fails closed when OfficeDocumentEdit arguments depart from the producer schema', () => {
    const valid = { path: 'report.docx', operation: 'set' };
    const malformed = [
      { ...valid, path: '' },
      { ...valid, path: 'x'.repeat(501) },
      { ...valid, operation: 'view' },
      { ...valid, target: '' },
      { ...valid, elementType: 'x'.repeat(81) },
      { ...valid, props: { '': 'value' } },
      { ...valid, props: { text: 'x'.repeat(501) } },
      { ...valid, props: { nested: { private: true } } },
      { ...valid, index: 10_000 },
      { ...valid, futureControl: true },
    ];

    for (const args of malformed) {
      assert.throws(
        () => projectPublicToolApprovalReview(canonical('OfficeDocumentEdit', args)),
        InteractionPermissionProjectionError,
      );
    }
  });

  test('fails closed when ExploreAgent arguments depart from the producer schema', () => {
    const valid = { objective: 'Inspect permission ownership' };
    const malformed = [
      { objective: 'abc' },
      { ...valid, roots: Array.from({ length: 6 }, () => 'src') },
      { ...valid, roots: [''] },
      { ...valid, queries: ['x'.repeat(121)] },
      { ...valid, ignorePaths: Array.from({ length: 21 }, () => 'dist') },
      { ...valid, stoppingCondition: '' },
      { ...valid, maxFiles: 0 },
      { ...valid, maxMatches: 120.5 },
      { ...valid, futureLimit: 1 },
    ];

    for (const args of malformed) {
      assert.throws(
        () => projectPublicToolApprovalReview(canonical('ExploreAgent', args)),
        InteractionPermissionProjectionError,
      );
    }
  });

  test('fails approval admission for malformed known shapes and unknown effect producers', () => {
    const malformed = [
      canonical('Write', { path: 'a.txt', content: 42 }),
      canonical('Bash', { command: 'echo ok', pty: 'yes' }),
      canonical('browser_wait', { selector: '#done', text: 'done' }),
      canonical('patch', { path: 'a.txt', patch: '@@' }),
      canonical('agent_spawn', { profile: 'local_read', task: 'inspect' }),
    ];
    for (const intent of malformed) {
      assert.throws(
        () => projectPublicToolApprovalReview(intent),
        InteractionPermissionProjectionError,
      );
    }

    const dynamic = canonical(
      'mcp__server__send',
      { serverId: 'server', toolName: 'send', arguments: { private: 'value' } },
      'network_send',
    );
    assert.equal(projectPublicToolIntentReview(dynamic), undefined);
    assert.throws(
      () => projectPublicToolApprovalReview(dynamic),
      InteractionPermissionProjectionError,
    );
    assert.throws(
      () => canonical('alternate_computer', { action: 'list_apps' }, 'computer_use'),
      TypeError,
    );
  });

  test('public review decoder rejects hidden non-wire fields', () => {
    const review = {
      kind: 'browser',
      action: 'click',
      ref: '#save',
    };
    Object.defineProperty(review, 'rawArgs', {
      value: { private: 'value' },
      enumerable: false,
    });

    assert.throws(() => decodePublicToolIntentReview(review), TypeError);
  });

  test('provider tokens still fail closed for approval while Git commit identity is retained', () => {
    const provider = canonical('Bash', { command: 'echo ghp_abcdefghijklmnopqrstuvwxyz' });
    assert.throws(
      () => projectPublicToolApprovalReview(provider),
      InteractionPermissionProjectionError,
    );

    const command = 'git reset --hard 0123456789abcdef0123456789abcdef01234567';
    const git = canonical('Bash', { command });
    assert.equal(git.category, 'git_destructive');
    assert.deepEqual(projectPublicToolApprovalReview(git), {
      kind: 'command',
      command,
      cwd: '/workspace',
    });
  });

  test('redacts GNU long-option secrets from Bash approval reviews', () => {
    const secret = 'opaque-secret';
    const cases = [
      [
        `vendor-cli --api-key=${secret} --mode review; rm foo`,
        'vendor-cli --api-key=REDACTED --mode review; rm foo',
      ],
      [
        `vendor-cli "--token"=${secret} --mode review; rm foo`,
        'vendor-cli --token=REDACTED --mode review; rm foo',
      ],
      [
        `vendor-cli --token'='${secret} --mode review; rm foo`,
        'vendor-cli --token=REDACTED --mode review; rm foo',
      ],
      [`vendor-cli "--token=${secret}"; rm foo`, 'vendor-cli --token=REDACTED; rm foo'],
    ] as const;

    for (const [command, expected] of cases) {
      const review = projectPublicToolApprovalReview(canonical('Bash', { command }));
      assert.deepEqual(review, { kind: 'command', command: expected, cwd: '/workspace' });
      assert.doesNotMatch(JSON.stringify(review), new RegExp(secret));
      assert.deepEqual(decodePublicToolIntentReview(JSON.parse(JSON.stringify(review))), review);
    }

    assert.throws(
      () =>
        projectPublicToolApprovalReview(
          canonical('Bash', {
            command: 'vendor-cli $(true)"--to"ken=opaque-secret; rm foo',
          }),
        ),
      InteractionPermissionProjectionError,
    );
  });
});
