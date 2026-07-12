import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CuSafetySentinel } from './cu-safety-sentinel.mjs';

function sample({
  atMs,
  pid = 100,
  x = 10,
  y = 20,
  pointer = false,
  focus = false,
}) {
  return {
    type: 'sample',
    atMs,
    frontmostPid: pid,
    cursor: { x, y },
    physicalPointerInput: pointer,
    physicalFocusInput: focus,
  };
}

function harness() {
  const emitted = [];
  const sentinel = new CuSafetySentinel({ emit: (event) => emitted.push(event) });
  sentinel.observe(sample({ atMs: 0 }));
  return { emitted, sentinel };
}

test('establishes a baseline and brackets an action window', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'click-1' });
  sentinel.observe(sample({ atMs: 5 }));
  const end = sentinel.endAction({ actionId: 'click-1' });

  assert.deepEqual(emitted.map((event) => event.type), [
    'baseline',
    'action_window',
    'action_window',
  ]);
  assert.equal(end.phase, 'end');
  assert.equal(end.violations, 0);
});

test('reports agent-caused frontmost PID and real cursor changes', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'unsafe-action' });
  sentinel.observe(sample({ atMs: 5, pid: 200, x: 80, y: 90 }));

  assert.deepEqual(
    emitted.filter((event) => event.type === 'violation').map((event) => event.kind),
    ['frontmost_pid_changed', 'real_cursor_changed'],
  );
  assert.equal(sentinel.endAction({}).violations, 2);
});

test('allows the user to keep working during an action window', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'background-type' });
  sentinel.observe(sample({
    atMs: 5,
    pid: 200,
    x: 40,
    y: 50,
    pointer: true,
    focus: true,
  }));
  sentinel.observe(sample({
    atMs: 10,
    pid: 200,
    x: 40,
    y: 50,
  }));

  assert.deepEqual(
    emitted.filter((event) => event.type === 'user_activity').map((event) => event.channel),
    ['frontmost', 'cursor'],
  );
  assert.equal(emitted.some((event) => event.type === 'violation'), false);
  assert.equal(sentinel.endAction({}).violations, 0);
});

test('L4: concurrent user cursor motion does not mask an agent focus steal', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'l4-pointer-vs-focus' });
  sentinel.observe(sample({
    atMs: 5,
    pid: 200,
    x: 40,
    y: 50,
    pointer: true,
    focus: false,
  }));

  assert.deepEqual(
    emitted.filter((event) => ['user_activity', 'violation'].includes(event.type))
      .map((event) => [event.type, event.channel ?? event.kind]),
    [
      ['violation', 'frontmost_pid_changed'],
      ['user_activity', 'cursor'],
    ],
  );
});

test('L4: concurrent user focus input does not mask an agent cursor warp', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'l4-focus-vs-pointer' });
  sentinel.observe(sample({
    atMs: 5,
    pid: 200,
    x: 40,
    y: 50,
    pointer: false,
    focus: true,
  }));

  assert.deepEqual(
    emitted.filter((event) => ['user_activity', 'violation'].includes(event.type))
      .map((event) => [event.type, event.channel ?? event.kind]),
    [
      ['user_activity', 'frontmost'],
      ['violation', 'real_cursor_changed'],
    ],
  );
});

test('L4: user activity rebases the window without hiding a later agent mutation', () => {
  const { emitted, sentinel } = harness();
  sentinel.startAction({ actionId: 'l4-continued-work' });
  sentinel.observe(sample({ atMs: 5, x: 20, y: 30, pointer: true }));
  sentinel.observe(sample({ atMs: 10, x: 90, y: 100 }));

  const relevant = emitted.filter((event) => ['user_activity', 'violation'].includes(event.type));
  assert.deepEqual(relevant.map((event) => event.type), ['user_activity', 'violation']);
  assert.deepEqual(relevant[1].from, { x: 20, y: 30 });
  assert.deepEqual(relevant[1].to, { x: 90, y: 100 });
});

test('changes outside an action window become the next baseline', () => {
  const { emitted, sentinel } = harness();
  sentinel.observe(sample({ atMs: 5, pid: 300, x: 70, y: 80 }));
  sentinel.startAction({ actionId: 'next-action' });
  sentinel.observe(sample({ atMs: 10, pid: 300, x: 70, y: 80 }));

  assert.equal(emitted.some((event) => event.type === 'violation'), false);
  assert.deepEqual(sentinel.baseline.cursor, { x: 70, y: 80 });
  assert.equal(sentinel.baseline.frontmostPid, 300);
});

test('Swift sampler uses HID state and separate pointer/focus evidence', async (t) => {
  const source = await readFile(new URL('./cu-safety-sentinel.swift', import.meta.url), 'utf8');
  assert.match(source, /CGEventSource\.secondsSinceLastEventType\(\.hidSystemState/);
  assert.match(source, /physicalPointerInput/);
  assert.match(source, /physicalFocusInput/);
  assert.match(source, /\.mouseMoved/);
  assert.match(source, /\.leftMouseDown/);
  assert.match(source, /keyState\(\.hidSystemState,\s*key:\s*48\)/);
  assert.match(source, /\.contains\(\.maskCommand\)/);
  assert.doesNotMatch(source, /let focusEventTypes[\s\S]*?\.keyDown/);

  if (process.platform !== 'darwin') {
    t.skip('Swift Cocoa sampler only typechecks on macOS');
    return;
  }
  const result = spawnSync('swiftc', ['-typecheck', new URL(
    './cu-safety-sentinel.swift',
    import.meta.url,
  ).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
