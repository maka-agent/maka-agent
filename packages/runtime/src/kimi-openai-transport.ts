interface KimiOpenAiTransport {
  fetch: typeof globalThis.fetch;
  transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown>;
}

type KimiReasoningField = 'reasoning_content' | 'reasoning';

export function createKimiOpenAiTransport(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): KimiOpenAiTransport {
  let reasoningField: KimiReasoningField = 'reasoning_content';
  return {
    fetch: async (input, init) =>
      normalizeKimiOpenAiResponse(await fetchImpl(input, init), (observed) => {
        reasoningField = observed;
      }),
    transformRequestBody: (body) => replayAssistantReasoning(body, reasoningField),
  };
}

async function normalizeKimiOpenAiResponse(
  response: Response,
  observeReasoning: (field: KimiReasoningField) => void,
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream') && response.body) {
    return responseWithBody(
      response,
      response.body.pipeThrough(kimiSseNormalizer(observeReasoning)),
    );
  }
  if (contentType.includes('application/json')) {
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return responseWithBody(response, raw);
    }
    return responseWithBody(
      response,
      JSON.stringify(normalizeKimiPayload(parsed, observeReasoning)),
    );
  }
  return response;
}

function kimiSseNormalizer(
  observeReasoning: (field: KimiReasoningField) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        controller.enqueue(
          encoder.encode(normalizeSseLine(buffered.slice(0, newline + 1), observeReasoning)),
        );
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) {
        controller.enqueue(encoder.encode(normalizeSseLine(buffered, observeReasoning)));
      }
    },
  });
}

function normalizeSseLine(
  line: string,
  observeReasoning: (field: KimiReasoningField) => void,
): string {
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  const body = newline ? line.slice(0, -newline.length) : line;
  const match = /^(\s*data:\s*)(.*)$/.exec(body);
  if (!match || match[2] === '[DONE]') return line;
  try {
    return `${match[1]}${JSON.stringify(normalizeKimiPayload(JSON.parse(match[2]!), observeReasoning))}${newline}`;
  } catch {
    return line;
  }
}

function normalizeKimiPayload(
  value: unknown,
  observeReasoning: (field: KimiReasoningField) => void,
): unknown {
  if (!isRecord(value)) return value;
  observeKimiReasoningField(value, observeReasoning);
  const nestedUsage = Array.isArray(value.choices)
    ? value.choices.find((choice) => isRecord(choice) && isRecord(choice.usage))
    : undefined;
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(nestedUsage)
      ? nestedUsage.usage
      : undefined;
  if (!isRecord(usage)) return value;
  const normalizedUsage = normalizeKimiUsage(usage);
  return value.usage === normalizedUsage ? value : { ...value, usage: normalizedUsage };
}

function observeKimiReasoningField(
  payload: Record<string, unknown>,
  observe: (field: KimiReasoningField) => void,
): void {
  if (!Array.isArray(payload.choices)) return;
  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    for (const carrier of [choice.message, choice.delta]) {
      if (!isRecord(carrier)) continue;
      if (typeof carrier.reasoning_content === 'string') observe('reasoning_content');
      else if (typeof carrier.reasoning === 'string') observe('reasoning');
    }
  }
}

function replayAssistantReasoning(
  body: Record<string, unknown>,
  field: KimiReasoningField,
): Record<string, unknown> {
  if (field !== 'reasoning' || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((value) => {
    if (!isRecord(value) || value.role !== 'assistant') return value;
    if (typeof value.reasoning_content !== 'string') return value;
    const { reasoning_content: reasoning, ...message } = value;
    changed = true;
    return { ...message, reasoning };
  });
  return changed ? { ...body, messages } : body;
}

function normalizeKimiUsage(usage: Record<string, unknown>): Record<string, unknown> {
  if (typeof usage.cached_tokens !== 'number') return usage;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  if (typeof details.cached_tokens === 'number') return usage;
  return {
    ...usage,
    prompt_tokens_details: { ...details, cached_tokens: usage.cached_tokens },
  };
}

function responseWithBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
