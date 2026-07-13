const SAFE_TRACE_KEYS = new Set([
  'type',
  'actionType',
  'path',
  'effect',
  'verified',
  'supported',
  'ok',
  'durationMs',
  'at',
  'expectedPid',
  'expectedWindowId',
  'winnerPid',
  'winnerWindowId',
  'winnerZIndex',
]);

function safeUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function actionType(action) {
  return typeof action?.type === 'string'
    ? action.type
    : typeof action?.action === 'string'
      ? action.action
      : 'unknown';
}

function resultCode(text) {
  if (typeof text !== 'string') return undefined;
  const failed = text.match(/\bfailed:\s*([a-z][a-z0-9_]{1,63})\b/i);
  if (failed) return failed[1];
  const status = text.match(/\b(?:ok|error)=([a-z][a-z0-9_]{1,63})\b/i);
  return status?.[1];
}

export function sanitizeCuActionRecord(record) {
  return {
    type: actionType(record?.action ?? record),
    ...(Number.isFinite(record?.durationMs) ? { durationMs: record.durationMs } : {}),
    ...(Number.isFinite(record?.modelLatencyMs) ? { modelLatencyMs: record.modelLatencyMs } : {}),
    ...(Number.isFinite(record?.toolLatencyMs) ? { toolLatencyMs: record.toolLatencyMs } : {}),
    ...(Number.isFinite(record?.displayLagMs) ? { displayLagMs: record.displayLagMs } : {}),
    ...(resultCode(record?.text) ? { resultCode: resultCode(record.text) } : {}),
  };
}

export function sanitizeCuTrace(trace) {
  if (!trace || typeof trace !== 'object') return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(trace)) {
    if (!SAFE_TRACE_KEYS.has(key)) continue;
    if (
      typeof value === 'string'
      || typeof value === 'boolean'
      || Number.isFinite(value)
    ) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function sanitizeCuModelPlans(plans) {
  return Array.isArray(plans)
    ? plans.map((plan) => ({
        turn: plan?.turn,
        actionTypes: Array.isArray(plan?.actions)
          ? plan.actions.map((action) => actionType(action))
          : [],
      }))
    : [];
}

export function sanitizeCuDirectReport(report) {
  return {
    schemaVersion: report.schemaVersion,
    evidenceClass: report.evidenceClass,
    scenarioId: report.scenarioId,
    producer: 'cu-openai-model-e2e',
    transportClass: 'live-network',
    policyMode: report.policyMode ?? 'bypassed',
    model: report.model,
    endpointOrigin: safeUrlOrigin(report.baseUrl),
    totalLatencyMs: report.totalLatencyMs,
    loopStatus: report.loopStatus,
    turns: report.turns,
    state: report.state,
    actions: Array.isArray(report.actions) ? report.actions.map(sanitizeCuActionRecord) : [],
    traces: Array.isArray(report.traces) ? report.traces.map(sanitizeCuTrace).filter(Boolean) : [],
    display: report.display,
  };
}
