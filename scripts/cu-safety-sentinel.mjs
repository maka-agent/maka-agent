import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const samplerPath = join(here, 'cu-safety-sentinel.swift');

function sameCursor(left, right, tolerance) {
  return Math.hypot(left.x - right.x, left.y - right.y) <= tolerance;
}

function validateSample(sample) {
  if (
    sample?.type !== 'sample'
    || !Number.isFinite(sample.atMs)
    || !Number.isInteger(sample.frontmostPid)
    || !Number.isFinite(sample.cursor?.x)
    || !Number.isFinite(sample.cursor?.y)
    || typeof sample.physicalPointerInput !== 'boolean'
    || typeof sample.physicalFocusInput !== 'boolean'
  ) {
    throw new Error(`invalid CUA safety sample: ${JSON.stringify(sample)}`);
  }
}

export class CuSafetySentinel {
  constructor({ cursorTolerance = 1, emit = () => {} } = {}) {
    this.cursorTolerance = cursorTolerance;
    this.emit = emit;
    this.current = undefined;
    this.baseline = undefined;
    this.action = undefined;
    this.sequence = 0;
  }

  event(type, details = {}) {
    const event = {
      type,
      sequence: ++this.sequence,
      atMs: this.current?.atMs ?? details.atMs ?? 0,
      ...details,
    };
    this.emit(event);
    return event;
  }

  observe(sample) {
    validateSample(sample);
    const previous = this.current;
    this.current = {
      atMs: sample.atMs,
      frontmostPid: sample.frontmostPid,
      cursor: { x: sample.cursor.x, y: sample.cursor.y },
    };

    if (!previous) {
      this.baseline = structuredClone(this.current);
      return [this.event('baseline', { baseline: structuredClone(this.baseline) })];
    }

    const events = [];
    const focusChanged = previous.frontmostPid !== this.current.frontmostPid;
    const cursorChanged = !sameCursor(previous.cursor, this.current.cursor, this.cursorTolerance);

    if (!focusChanged && !cursorChanged) return events;

    if (!this.action) {
      const channels = [];
      if (focusChanged) channels.push('frontmost');
      if (cursorChanged) channels.push('cursor');
      events.push(this.event('baseline', {
        reason: 'outside_action_window',
        channels,
        baseline: structuredClone(this.current),
      }));
      this.baseline = structuredClone(this.current);
      return events;
    }

    if (focusChanged) {
      if (sample.physicalFocusInput) {
        events.push(this.event('user_activity', {
          actionId: this.action.id,
          channel: 'frontmost',
          from: previous.frontmostPid,
          to: this.current.frontmostPid,
        }));
      } else {
        events.push(this.event('violation', {
          actionId: this.action.id,
          kind: 'frontmost_pid_changed',
          from: previous.frontmostPid,
          to: this.current.frontmostPid,
        }));
        this.action.violations += 1;
      }
    }

    if (cursorChanged) {
      const change = {
        from: structuredClone(previous.cursor),
        to: structuredClone(this.current.cursor),
        distance: Math.hypot(
          this.current.cursor.x - previous.cursor.x,
          this.current.cursor.y - previous.cursor.y,
        ),
      };
      if (sample.physicalPointerInput) {
        events.push(this.event('user_activity', {
          actionId: this.action.id,
          channel: 'cursor',
          ...change,
        }));
      } else {
        events.push(this.event('violation', {
          actionId: this.action.id,
          kind: 'real_cursor_changed',
          ...change,
        }));
        this.action.violations += 1;
      }
    }

    this.baseline = structuredClone(this.current);
    return events;
  }

  startAction({ actionId, metadata } = {}) {
    if (!this.current) throw new Error('cannot start an action window before baseline');
    if (this.action) throw new Error(`action window already open: ${this.action.id}`);
    if (typeof actionId !== 'string' || !actionId.trim()) {
      throw new Error('actionId must be a non-empty string');
    }

    this.action = {
      id: actionId,
      metadata,
      startedAtMs: this.current.atMs,
      violations: 0,
    };
    return this.event('action_window', {
      phase: 'start',
      actionId,
      metadata,
      baseline: structuredClone(this.current),
    });
  }

  endAction({ actionId } = {}) {
    if (!this.action) throw new Error('no action window is open');
    if (actionId !== undefined && actionId !== this.action.id) {
      throw new Error(`cannot end action ${actionId}; ${this.action.id} is open`);
    }

    const completed = this.action;
    this.action = undefined;
    this.baseline = structuredClone(this.current);
    return this.event('action_window', {
      phase: 'end',
      actionId: completed.id,
      startedAtMs: completed.startedAtMs,
      violations: completed.violations,
      baseline: structuredClone(this.baseline),
    });
  }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runCli() {
  const stateMachineOnly = process.argv.includes('--state-machine');
  const failFast = process.argv.includes('--fail-fast');
  const sentinel = new CuSafetySentinel({
    emit(event) {
      emitJson(event);
      if (failFast && event.type === 'violation') {
        process.exitCode = 2;
        sampler?.kill('SIGTERM');
      }
    },
  });
  let sampler;

  function accept(message) {
    switch (message.type) {
      case 'sample':
        sentinel.observe(message);
        break;
      case 'action_start':
        sentinel.startAction({ actionId: message.actionId, metadata: message.metadata });
        break;
      case 'action_end':
        sentinel.endAction({ actionId: message.actionId });
        break;
      case 'stop':
        sampler?.kill('SIGTERM');
        break;
      default:
        throw new Error(`unknown CUA safety message type: ${message.type}`);
    }
  }

  const controls = createInterface({ input: process.stdin, crlfDelay: Infinity });
  controls.on('line', (line) => {
    if (!line.trim()) return;
    try {
      accept(JSON.parse(line));
    } catch (error) {
      emitJson({ type: 'error', message: error.message });
      process.exitCode = 1;
    }
  });

  if (stateMachineOnly) return;

  sampler = spawn('swift', [samplerPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const samples = createInterface({ input: sampler.stdout, crlfDelay: Infinity });
  samples.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'error') throw new Error(message.message);
      accept(message);
    } catch (error) {
      emitJson({ type: 'error', message: error.message });
      process.exitCode = 1;
      sampler.kill('SIGTERM');
    }
  });
  sampler.stderr.setEncoding('utf8');
  sampler.stderr.on('data', (chunk) => process.stderr.write(chunk));
  sampler.on('error', (error) => {
    emitJson({ type: 'error', message: `failed to start Swift sampler: ${error.message}` });
    process.exitCode = 1;
  });
  sampler.on('exit', (code, signal) => {
    if (process.exitCode === undefined && code && signal !== 'SIGTERM') {
      process.exitCode = code;
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli();
