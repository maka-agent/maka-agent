import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { PiCliJsonTransport, type PiCliJsonSpawn } from '../pi-cli-json-transport.js';

describe('PiCliJsonTransport', () => {
  test('spawns pi JSON mode and maps text, tools, and usage into PiAgentFrames', async () => {
    const child = testChild(
      Readable.from([
        `${JSON.stringify({ type: 'session', id: 'session-1' })}\n`,
        `${JSON.stringify({ type: 'agent_start' })}\n`,
        `${JSON.stringify({ type: 'turn_start' })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_start' },
        })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' },
        })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_end' },
        })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_start' },
        })}\n`,
        `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_end' },
        })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_start',
            partial: {
              content: [
                {
                  type: 'toolCall',
                  id: 'call-1',
                  name: 'write',
                  arguments: { path: 'solved.txt' },
                },
              ],
            },
          },
        })}\n`,
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            partial: {
              content: [
                {
                  type: 'toolCall',
                  id: 'call-1',
                  name: 'write',
                  arguments: { path: 'solved.txt', content: 'ok' },
                },
              ],
            },
          },
        })}\n`,
        `${JSON.stringify({
          type: 'message_start',
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'write',
            isError: false,
            content: [{ type: 'text', text: 'partial result' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'write',
            isError: false,
            content: [{ type: 'text', text: 'Successfully wrote solved.txt' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              usage: {
                input: 12,
                output: 3,
                cacheRead: 4,
                cacheWrite: 5,
                totalTokens: 24,
                cost: { total: 0.00045 },
              },
            },
            {
              role: 'assistant',
              usage: {
                input: 6,
                output: 2,
                cacheRead: 1,
                cacheWrite: 0,
                totalTokens: 9,
                cost: { total: 0.0001 },
              },
            },
          ],
        })}\n`,
        `${JSON.stringify({ type: 'turn_end' })}\n`,
      ]),
    );

    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    let capturedPrompt = '';
    child.stdin.on('data', (chunk) => {
      capturedPrompt += String(chunk);
    });
    const spawn: PiCliJsonSpawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };
    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      provider: 'volcengine',
      spawn,
    });

    const frames = [];
    for await (const frame of transport.send({
      sessionId: 's1',
      turnId: 't1',
      cwd: '/tmp/task',
      text: 'solve it',
    })) {
      frames.push(frame);
    }

    assert.deepEqual(calls[0]?.args, [
      '--mode',
      'json',
      '--no-context-files',
      '--no-session',
      '--provider',
      'volcengine',
      '--model',
      'glm-5.2',
      '-p',
    ]);
    assert.equal(capturedPrompt, 'solve it');
    assert.deepEqual((calls[0].options as { cwd?: string }).cwd, '/tmp/task');
    assert.deepEqual(frames, [
      { type: 'text_delta', text: 'hi' },
      {
        type: 'tool_start',
        toolUseId: 'call-1',
        toolName: 'write',
        args: { path: 'solved.txt', content: 'ok' },
      },
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        isError: false,
        content: { kind: 'text', text: 'Successfully wrote solved.txt' },
      },
      {
        type: 'token_usage',
        input: 18,
        output: 5,
        cacheHitInput: 5,
        cacheWriteInput: 5,
        total: 33,
        costUsd: 0.00055,
      },
      { type: 'complete' },
    ]);
  });

  test('waits for the Pi process to close before yielding complete', async () => {
    const stdout = new PassThrough();
    const child = testChild(stdout);

    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const spawn: PiCliJsonSpawn = () => {
      markSpawned();
      return child;
    };
    const transport = new PiCliJsonTransport({ command: 'pi-test', model: 'glm-5.2', spawn });
    const frames: unknown[] = [];
    const done = (async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        frames.push(frame);
      }
    })();

    await spawned;
    stdout.write(`${agentEndLine()}\n`);
    stdout.end();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      frames.map((frame) => (frame as { type?: string }).type),
      ['token_usage'],
    );

    child.emit('close', 0, null);
    await done;

    assert.deepEqual(
      frames.map((frame) => (frame as { type?: string }).type),
      ['token_usage', 'complete'],
    );
  });

  test('fails instead of completing when Pi exits non-zero after agent_end', async () => {
    const child = testChild(
      Readable.from([`${agentEndLine()}\n`]),
      Readable.from(['late failure']),
    );

    const spawn: PiCliJsonSpawn = () => {
      setImmediate(() => child.emit('close', 1, null));
      return child;
    };
    const transport = new PiCliJsonTransport({ command: 'pi-test', model: 'glm-5.2', spawn });
    const frames: unknown[] = [];

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        frames.push(frame);
      }
    }, /pi exited with code 1: late failure/);

    assert.deepEqual(
      frames.map((frame) => (frame as { type?: string }).type),
      ['token_usage'],
    );
  });

  test('fails closed on unsupported Pi JSON events', async () => {
    const child = testChild(Readable.from([`${JSON.stringify({ type: 'new_protocol_event' })}\n`]));

    const spawn: PiCliJsonSpawn = () => {
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    const transport = new PiCliJsonTransport({ command: 'pi-test', model: 'glm-5.2', spawn });

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        void frame;
      }
    }, /pi emitted unsupported JSON event: new_protocol_event/);
  });

  test('fails closed when text_delta is missing a string delta', async () => {
    const child = testChild(
      Readable.from([
        `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } })}\n`,
      ]),
    );

    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      spawn: () => child,
    });

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        void frame;
      }
    }, /pi text_delta missing string delta/);
  });

  test('fails closed when toolcall_end is missing a valid tool call', async () => {
    const child = testChild(
      Readable.from([
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            partial: { content: [{ type: 'toolCall', id: 'call-1', arguments: { path: 'x' } }] },
          },
        })}\n`,
      ]),
    );

    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      spawn: () => child,
    });

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        void frame;
      }
    }, /pi toolcall_end missing valid tool call/);
  });

  test('kills the Pi process when stdout parsing fails before close', async () => {
    const child = testChild(Readable.from([`${JSON.stringify({ type: 'new_protocol_event' })}\n`]));
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = (signal) => {
      killSignals.push(signal);
      return true;
    };

    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      spawn: () => child,
    });

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        void frame;
      }
    }, /pi emitted unsupported JSON event: new_protocol_event/);

    assert.deepEqual(killSignals, ['SIGTERM']);
  });

  test('fails under control when stdin write emits an error', async () => {
    const child = testChild(new PassThrough());
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = (signal) => {
      killSignals.push(signal);
      return true;
    };
    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      spawn: () => {
        setImmediate(() => child.stdin.emit('error', new Error('broken pipe')));
        return child;
      },
    });

    await assert.rejects(async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        void frame;
      }
    }, /pi stdin write failed: broken pipe/);

    assert.deepEqual(killSignals, ['SIGTERM']);
  });

  test('fails when stdin errors after stdout ends but before close', async () => {
    const stdout = new PassThrough();
    const child = testChild(stdout);
    const transport = new PiCliJsonTransport({
      command: 'pi-test',
      model: 'glm-5.2',
      spawn: () => child,
    });
    const frames: unknown[] = [];
    const done = (async () => {
      for await (const frame of transport.send({
        sessionId: 's1',
        turnId: 't1',
        cwd: '/tmp/task',
        text: 'solve it',
      })) {
        frames.push(frame);
      }
    })();

    stdout.write(`${agentEndLine()}\n`);
    stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.stdin.emit('error', new Error('late broken pipe'));
    child.emit('close', 0, null);

    await assert.rejects(done, /pi stdin write failed: late broken pipe/);
    assert.deepEqual(
      frames.map((frame) => (frame as { type?: string }).type),
      ['token_usage'],
    );
  });
});

type TestPiChild = EventEmitter & {
  stdin: PassThrough;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function testChild(stdout: Readable, stderr: Readable = Readable.from([])): TestPiChild {
  const child = new EventEmitter() as TestPiChild;
  child.stdin = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  return child;
}

function agentEndLine(): string {
  return JSON.stringify({
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        usage: {
          input: 1,
          output: 2,
          totalTokens: 3,
        },
      },
    ],
  });
}
