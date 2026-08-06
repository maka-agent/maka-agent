import { randomUUID } from 'node:crypto';
import { BROWSER_WORKFLOW_MAX_ACTIONS } from '@maka/core/browser-workflow';
import type {
  BrowserWorkflow,
  BrowserWorkflowAction,
  BrowserWorkflowDraft,
  BrowserWorkflowWaitConditionInput,
  BrowserWorkflowProgress,
} from '@maka/core/browser-workflow';
import {
  isBrowserWorkflow,
  isBrowserWorkflowWaitConditionInput,
  validateBrowserWorkflow,
} from '@maka/core/browser-workflow';
import type { IPage } from '@jackwener/opencli/types';
import type { BrowserViewManager } from './view-manager.js';
import type { BrowserViewController } from './controller.js';
import { withBrowserPage, type BrowserPageRun, type TakeoverMode } from './session.js';
import {
  normalizeBrowserRecorderEvent,
  setBrowserWorkflowNavigationRecorder,
  type BrowserWorkflowNavigationSource,
  type BrowserRecorderEvent,
} from './workflow-recorder.js';
import { runBrowserWorkflowAction } from './workflow-runner.js';
import { assertBrowserWorkflowWaitCondition } from './workflow-runner.js';
import type { BrowserWorkflowStore } from '@maka/storage';

export interface BrowserWorkflowServiceDeps {
  store: BrowserWorkflowStore;
  views: BrowserViewManager<BrowserViewController>;
  sendToRenderer(channel: 'browser:workflow-progress', payload: BrowserWorkflowProgress): void;
  runWithPage?: <T>(
    sessionId: string,
    label: string,
    run: BrowserPageRun<T>,
    opts?: { timeoutMs?: number; abort?: AbortSignal; takeover?: TakeoverMode },
  ) => Promise<T>;
}

export interface BrowserWorkflowRecordingHandle {
  recordingId: string;
  sessionId: string;
}

export interface BrowserWorkflowRecordingResult {
  draftId: string;
  actionCount: number;
  sensitiveActionIds: string[];
  actions: BrowserWorkflowAction[];
}

export interface BrowserWorkflowService {
  list(): Promise<BrowserWorkflow[]>;
  startRecording(sessionId: string): Promise<BrowserWorkflowRecordingHandle>;
  stopRecording(sessionId: string): Promise<BrowserWorkflowRecordingResult>;
  addWaitCondition(sessionId: string, input: BrowserWorkflowWaitConditionInput): Promise<string>;
  cancelRecording(sessionId: string): Promise<void>;
  saveRecording(draftId: string, name: string): Promise<BrowserWorkflow>;
  run(workflowId: string, sessionId: string, sensitiveValues?: Record<string, string>): Promise<void>;
  cancel(runId: string): void;
  rename(workflowId: string, name: string): Promise<BrowserWorkflow>;
  remove(workflowId: string): Promise<void>;
}

type Recording = {
  recordingId: string;
  sessionId: string;
  startedAt: number;
  actions: BrowserWorkflowAction[];
  seenEventIds: Set<string>;
  lastTypeByLocator: Map<string, RecordedTypeAction>;
  drainQueue: Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
};

type RecordedTypeAction = Extract<BrowserWorkflowAction, { kind: 'type' }> & { updatedAt: number };

type PendingDraft = BrowserWorkflowDraft;

export function createBrowserWorkflowService(deps: BrowserWorkflowServiceDeps): BrowserWorkflowService {
  const recordings = new Map<string, Recording>();
  const recordingStarts = new Set<string>();
  const drafts = new Map<string, PendingDraft>();
  const runs = new Map<string, { controller: AbortController; sessionId: string }>();
  const recordingTransitions = new Map<string, Promise<void>>();
  const runWithPage = deps.runWithPage ?? withBrowserPage;

  const emit = (progress: BrowserWorkflowProgress): void => {
    deps.sendToRenderer('browser:workflow-progress', progress);
  };

  function viewFor(sessionId: string): BrowserViewController {
    return deps.views.getOrCreate(sessionId);
  }

  function serializeRecordingTransition<T>(sessionId: string, transition: () => Promise<T>): Promise<T> {
    const previous = recordingTransitions.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(transition);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    recordingTransitions.set(sessionId, settled);
    void settled.finally(() => {
      if (recordingTransitions.get(sessionId) === settled) recordingTransitions.delete(sessionId);
    });
    return result;
  }

  function addNavigation(
    recording: Recording,
    url: string,
    source: BrowserWorkflowNavigationSource,
  ): void {
    if (!/^https?:\/\//i.test(url)) return;
    const previous = recording.actions.at(-1);
    if (
      source === 'interaction' &&
      (previous?.kind === 'click' || (previous?.kind === 'type' && previous.submit))
    ) {
      appendAction(recording, { id: randomUUID(), kind: 'wait', url, timeoutMs: 30_000 });
      return;
    }
    if (previous?.kind === 'navigate' && previous.url === url) return;
    appendAction(recording, { id: randomUUID(), kind: 'navigate', url });
  }

  function appendAction(recording: Recording, action: BrowserWorkflowAction): boolean {
    if (recording.actions.length >= BROWSER_WORKFLOW_MAX_ACTIONS) return false;
    recording.actions.push(action);
    emitRecordingProgress(recording);
    return true;
  }

  async function drain(recording: Recording): Promise<void> {
    const raw = await viewFor(recording.sessionId).drainWorkflowRecorderEvents();
    for (const value of raw) {
      const event = normalizeBrowserRecorderEvent(value);
      if (event) addEvent(recording, event);
    }
  }

  function queueDrain(recording: Recording): Promise<void> {
    const next = recording.drainQueue.then(() => drain(recording));
    recording.drainQueue = next.catch(() => {});
    return next;
  }

  function queueNavigation(
    sessionId: string,
    url: string,
    source: BrowserWorkflowNavigationSource,
  ): Promise<void> {
    const recording = recordings.get(sessionId);
    if (!recording) return Promise.resolve();
    const next = recording.drainQueue.then(async () => {
      await drain(recording);
      addNavigation(recording, url, source);
    });
    recording.drainQueue = next.catch(() => {});
    return next;
  }

  function addEvent(recording: Recording, event: BrowserRecorderEvent): void {
    if (event.eventId) {
      if (recording.seenEventIds.has(event.eventId)) return;
      recording.seenEventIds.add(event.eventId);
    }
    if (event.kind === 'click') {
      appendAction(recording, { id: randomUUID(), kind: 'click', locator: event.locator });
      return;
    }
    const locatorKey = JSON.stringify(event.locator);
    const previous = recording.lastTypeByLocator.get(locatorKey);
    if (previous && recording.actions.at(-1)?.id === previous.id && event.timestamp - previous.updatedAt < 1500) {
      previous.sensitive = previous.sensitive || event.sensitive === true;
      previous.submit = previous.submit || event.submit === true;
      if (previous.sensitive) delete previous.value;
      else previous.value = event.value ?? '';
      previous.updatedAt = event.timestamp;
      emitRecordingProgress(recording);
      return;
    }
    const action: RecordedTypeAction = {
      id: randomUUID(),
      kind: 'type',
      locator: event.locator,
      ...(event.sensitive ? {} : { value: event.value ?? '' }),
      sensitive: event.sensitive === true,
      submit: event.submit === true,
      updatedAt: event.timestamp,
    };
    if (appendAction(recording, action)) recording.lastTypeByLocator.set(locatorKey, action);
  }

  function emitRecordingProgress(recording: Recording): void {
    if (!recordings.has(recording.sessionId)) return;
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId: recording.sessionId,
      status: 'running',
      current: recording.actions.length,
      total: 0,
    });
  }

  async function startRecording(sessionId: string): Promise<BrowserWorkflowRecordingHandle> {
    if (recordings.has(sessionId)) throw new Error('A browser workflow recording is already active for this page.');
    if ([...runs.values()].some((run) => run.sessionId === sessionId)) {
      throw new Error('A browser workflow is running for this page. Wait for it to finish before recording.');
    }
    recordingStarts.add(sessionId);
    try {
      const view = viewFor(sessionId);
      await view.startWorkflowRecorder();
      const recordingId = randomUUID();
      const startedAt = Date.now();
      const recording: Recording = {
        recordingId,
        sessionId,
        startedAt,
        actions: [],
        seenEventIds: new Set(),
        lastTypeByLocator: new Map(),
        drainQueue: Promise.resolve(),
        timer: null,
      };
      recording.timer = setInterval(() => void queueDrain(recording).catch(() => {}), 100);
      recordings.set(sessionId, recording);
      const url = view.state().url;
      if (/^https?:\/\//i.test(url)) addNavigation(recording, url, 'explicit');
      emit({
        runId: recordingId,
        workflowId: 'recording',
        sessionId,
        status: 'running',
        current: recording.actions.length,
        total: 0,
      });
      return { recordingId, sessionId };
    } finally {
      recordingStarts.delete(sessionId);
    }
  }

  async function stopRecording(sessionId: string): Promise<BrowserWorkflowRecordingResult> {
    const recording = recordings.get(sessionId);
    if (!recording) throw new Error('No browser workflow recording is active for this page.');
    recordings.delete(sessionId);
    if (recording.timer) clearInterval(recording.timer);
    recording.timer = null;
    try {
      await queueDrain(recording);
    } finally {
      const trailing = await viewFor(sessionId).stopWorkflowRecorder().catch(() => []);
      for (const value of trailing) {
        const event = normalizeBrowserRecorderEvent(value);
        if (event) addEvent(recording, event);
      }
    }
    const actions = recording.actions.map((action) => {
      if (action.kind !== 'type') return action;
      const { updatedAt: _updatedAt, ...clean } = action as typeof action & { updatedAt: number };
      if (clean.sensitive) delete clean.value;
      return clean;
    });
    if (actions.length === 0) throw new Error('No browser actions were recorded. Perform a page action and try again.');
    const draftId = randomUUID();
    drafts.set(draftId, { actions, startedAt: recording.startedAt, endedAt: Date.now() });
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId,
      status: 'completed',
      current: actions.length,
      total: actions.length,
    });
    return {
      draftId,
      actionCount: actions.length,
      sensitiveActionIds: actions.filter((action) => action.kind === 'type' && action.sensitive).map((action) => action.id),
      actions,
    };
  }

  async function addWaitCondition(sessionId: string, input: BrowserWorkflowWaitConditionInput): Promise<string> {
    if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
    const recording = recordings.get(sessionId);
    if (!recording) throw new Error('No browser workflow recording is active for this page.');
    if (recording.actions.length >= BROWSER_WORKFLOW_MAX_ACTIONS) {
      throw new Error(`Browser workflow recordings are limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions.`);
    }
    await queueDrain(recording);
    await runWithPage(
      sessionId,
      'validate browser workflow wait condition',
      (page) => assertBrowserWorkflowWaitCondition(page, input),
      { takeover: 'observe', timeoutMs: Math.min(input.timeoutMs, 25_000) },
    );
    const action: BrowserWorkflowAction = {
      id: randomUUID(),
      kind: 'wait',
      ...(input.kind === 'selector' ? { selector: input.value.trim() } : { text: input.value.trim() }),
      timeoutMs: input.timeoutMs,
    };
    if (!appendAction(recording, action)) {
      throw new Error(`Browser workflow recordings are limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions.`);
    }
    return action.id;
  }

  async function cancelRecording(sessionId: string): Promise<void> {
    const recording = recordings.get(sessionId);
    if (!recording) return;
    recordings.delete(sessionId);
    if (recording.timer) clearInterval(recording.timer);
    recording.timer = null;
    await viewFor(sessionId).stopWorkflowRecorder().catch(() => []);
    emit({
      runId: recording.recordingId,
      workflowId: 'recording',
      sessionId,
      status: 'canceled',
      current: recording.actions.length,
      total: recording.actions.length,
      message: 'Browser workflow recording canceled.',
    });
  }

  async function saveRecording(draftId: string, name: string): Promise<BrowserWorkflow> {
    const draft = drafts.get(draftId);
    if (!draft) throw new Error('The browser workflow draft is no longer available. Record it again.');
    const normalizedName = name.trim().slice(0, 200);
    if (!normalizedName) throw new Error('Workflow name cannot be empty.');
    const now = Date.now();
    const workflow: BrowserWorkflow = {
      schemaVersion: 1,
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      actions: draft.actions,
    };
    validateBrowserWorkflow(workflow);
    await deps.store.save(workflow);
    drafts.delete(draftId);
    return workflow;
  }

  async function run(
    workflowId: string,
    sessionId: string,
    sensitiveValues: Record<string, string> = {},
  ): Promise<void> {
    const workflow = await deps.store.get(workflowId);
    if (!workflow || !isBrowserWorkflow(workflow)) throw new Error('Browser workflow not found.');
    const missingSensitiveAction = workflow.actions.find(
      (action) => action.kind === 'type' && action.sensitive && typeof sensitiveValues[action.id] !== 'string',
    );
    if (missingSensitiveAction?.kind === 'type') {
      throw new Error(`Sensitive value required for workflow action ${missingSensitiveAction.id}.`);
    }
    if (recordings.has(sessionId) || recordingStarts.has(sessionId)) {
      throw new Error('A browser workflow recording is active for this page. Stop recording before replaying a workflow.');
    }
    const runId = randomUUID();
    if (runs.size > 0) {
      throw new Error('Another browser workflow is already running.');
    }
    const controller = new AbortController();
    runs.set(runId, { controller, sessionId });
    const total = workflow.actions.length;
    const timeoutMs = Math.max(
      25_000,
      workflow.actions.reduce(
        (sum, action) => sum + (action.kind === 'wait' ? action.timeoutMs + 5_000 : 35_000),
        0,
      ),
    );
    let completed = 0;
    emit({ runId, workflowId, sessionId, status: 'running', current: 0, total });
    try {
      await runWithPage(
        sessionId,
        `workflow ${workflow.name}`,
        async (page: IPage) => {
          for (let index = 0; index < workflow.actions.length; index += 1) {
            if (controller.signal.aborted) throw new Error('Browser workflow canceled.');
            await runBrowserWorkflowAction(page, workflow.actions[index], sensitiveValues);
            completed = index + 1;
            emit({ runId, workflowId, sessionId, status: 'running', current: completed, total });
          }
        },
        { abort: controller.signal, takeover: 'mutate', timeoutMs },
      );
      if (controller.signal.aborted) throw new Error('Browser workflow canceled.');
      emit({ runId, workflowId, sessionId, status: 'completed', current: total, total });
    } catch (error) {
      const canceled = controller.signal.aborted || (error instanceof Error && /canceled/i.test(error.message));
      emit({
        runId,
        workflowId,
        sessionId,
        status: canceled ? 'canceled' : 'failed',
        current: completed,
        total,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      runs.delete(runId);
    }
  }

  async function rename(workflowId: string, name: string): Promise<BrowserWorkflow> {
    const workflow = await deps.store.get(workflowId);
    if (!workflow) throw new Error('Browser workflow not found.');
    const normalizedName = name.trim().slice(0, 200);
    if (!normalizedName) throw new Error('Workflow name cannot be empty.');
    const next = { ...workflow, name: normalizedName, updatedAt: Date.now() };
    await deps.store.save(next);
    return next;
  }

  setBrowserWorkflowNavigationRecorder(queueNavigation, async (sessionId) => {
    const recording = recordings.get(sessionId);
    if (recording) await queueDrain(recording);
  }, (sessionId, value) => {
    const recording = recordings.get(sessionId);
    const event = normalizeBrowserRecorderEvent(value);
    if (recording && event) addEvent(recording, event);
  });
  return {
    list: () => deps.store.loadAll(),
    startRecording: (sessionId) => serializeRecordingTransition(sessionId, () => startRecording(sessionId)),
    stopRecording: (sessionId) => serializeRecordingTransition(sessionId, () => stopRecording(sessionId)),
    addWaitCondition: (sessionId, input) =>
      serializeRecordingTransition(sessionId, () => addWaitCondition(sessionId, input)),
    cancelRecording: (sessionId) => serializeRecordingTransition(sessionId, () => cancelRecording(sessionId)),
    saveRecording,
    run,
    cancel(runId) {
      runs.get(runId)?.controller.abort();
    },
    rename,
    remove: (workflowId) => deps.store.remove(workflowId),
  };
}
