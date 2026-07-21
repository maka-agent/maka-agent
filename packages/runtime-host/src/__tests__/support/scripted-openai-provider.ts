import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ScriptedOpenAiRequest {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface ScriptedOpenAiProvider {
  readonly baseUrl: string;
  readonly requests: ScriptedOpenAiRequest[];
  readonly handlerErrors: unknown[];
  close(): Promise<void>;
}

export async function startScriptedOpenAiProvider(input: {
  readonly modelId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly finalText: string;
}): Promise<ScriptedOpenAiProvider> {
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
        if (requests.length === 1) {
          respondStream(
            response,
            input.modelId,
            'scripted-tool-call',
            {
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
            'tool_calls',
          );
          return;
        }
        respondStream(
          response,
          input.modelId,
          `scripted-final-${requests.length}`,
          { role: 'assistant', content: input.finalText },
          'stop',
        );
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
  modelId: string,
  id: string,
  delta: Record<string, unknown>,
  finishReason: 'tool_calls' | 'stop',
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}
