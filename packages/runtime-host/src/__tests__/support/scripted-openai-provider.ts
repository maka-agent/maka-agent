import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ScriptedOpenAiRequest {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly body: Record<string, unknown>;
}

export type ScriptedOpenAiResponse =
  | {
      readonly kind: 'stream';
      readonly modelId: string;
      readonly id: string;
      readonly delta: Record<string, unknown>;
      readonly finishReason: 'tool_calls' | 'stop';
      readonly beforeRespond?: Promise<void>;
    }
  | {
      readonly kind: 'json';
      readonly modelId: string;
      readonly id: string;
      readonly text: string;
      readonly beforeRespond?: Promise<void>;
    };

export interface ScriptedOpenAiProvider {
  readonly baseUrl: string;
  readonly requests: ScriptedOpenAiRequest[];
  readonly handlerErrors: unknown[];
  close(): Promise<void>;
}

type LegacyScript = {
  readonly modelId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly finalText: string;
};

export async function startScriptedOpenAiProvider(
  input: { readonly responses: readonly ScriptedOpenAiResponse[] } | LegacyScript,
): Promise<ScriptedOpenAiProvider> {
  const responses = 'responses' in input ? [...input.responses] : legacyResponses(input);
  const requests: ScriptedOpenAiRequest[] = [];
  const handlerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
        requests.push({
          authorization: request.headers.authorization,
          method: request.method,
          path: request.url,
          body,
        });
        const scripted = responses.shift();
        assert.ok(scripted, `Unexpected OpenAI request ${requests.length}`);
        await scripted.beforeRespond;
        if (scripted.kind === 'stream') {
          respondStream(response, scripted);
        } else {
          respondJson(response, scripted);
        }
      } catch (error) {
        handlerErrors.push(error);
        response.destroy(error as Error);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    handlerErrors,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function legacyResponses(input: LegacyScript): ScriptedOpenAiResponse[] {
  return [
    {
      kind: 'stream',
      modelId: input.modelId,
      id: 'scripted-tool-call',
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: input.toolCallId,
            type: 'function',
            function: {
              name: input.toolName,
              arguments: JSON.stringify(input.toolArgs),
            },
          },
        ],
      },
      finishReason: 'tool_calls',
    },
    {
      kind: 'stream',
      modelId: input.modelId,
      id: 'scripted-final',
      delta: { role: 'assistant', content: input.finalText },
      finishReason: 'stop',
    },
  ];
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function respondStream(
  response: ServerResponse,
  scripted: Extract<ScriptedOpenAiResponse, { kind: 'stream' }>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: scripted.id,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: scripted.modelId,
      choices: [{ index: 0, delta: scripted.delta, finish_reason: scripted.finishReason }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondJson(
  response: ServerResponse,
  scripted: Extract<ScriptedOpenAiResponse, { kind: 'json' }>,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: scripted.id,
      object: 'chat.completion',
      created: Date.now(),
      model: scripted.modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: scripted.text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
  );
}
