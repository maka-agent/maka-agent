import { redactSecrets } from '@maka/core/redaction';
import type { OpenAIComputerRequest } from './openai-computer-codec.js';
import type { OpenAIComputerTransport } from './openai-computer-loop.js';

const ERROR_DETAIL_MAX_CHARS = 1_000;
const RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;

export interface OpenAIResponsesTransportOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  headers?: HeadersInit;
  queryParams?: Record<string, string | number | boolean | undefined>;
}

export class OpenAIResponsesTransport implements OpenAIComputerTransport {
  readonly #url: URL;
  readonly #headers: Headers;
  readonly #secrets: string[];

  constructor(options: OpenAIResponsesTransportOptions) {
    this.#url = responsesUrl(options.baseUrl, options.queryParams);
    this.#headers = new Headers(options.headers);
    this.#headers.set('content-type', 'application/json');

    const bearerToken = options.bearerToken ?? options.apiKey;
    if (bearerToken) {
      this.#headers.set('authorization', `Bearer ${bearerToken}`);
    }

    this.#secrets = [
      options.apiKey,
      options.bearerToken,
      this.#url.username,
      this.#url.password,
      ...this.#headers.values(),
      ...this.#url.searchParams.values(),
    ].filter((value): value is string => Boolean(value));
  }

  async create(request: OpenAIComputerRequest, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify(request),
      signal,
    });
    const body = await readBoundedResponseText(response, RESPONSE_BODY_MAX_BYTES);

    if (!response.ok) {
      const detail = safeErrorDetail(body, this.#secrets);
      const statusText = safeErrorDetail(response.statusText, this.#secrets);
      throw new Error(
        `openai_responses_http_error: ${response.status}${statusText ? ` ${statusText}` : ''}` +
          (detail ? `: ${detail}` : ''),
      );
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('openai_responses_malformed_json');
    }
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('openai_responses_body_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('openai_responses_body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function createOpenAIResponsesTransport(
  options: OpenAIResponsesTransportOptions,
): OpenAIComputerTransport {
  return new OpenAIResponsesTransport(options);
}

function responsesUrl(
  baseUrl: string,
  queryParams: OpenAIResponsesTransportOptions['queryParams'],
): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/responses$/i, '');
  url.pathname = basePath.endsWith('/v1') ? `${basePath}/responses` : `${basePath}/v1/responses`;
  for (const [key, value] of Object.entries(queryParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function safeErrorDetail(body: string, secrets: string[]): string {
  let redacted = body;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  redacted = redactSecrets(redacted).replace(/\s+/g, ' ').trim();
  if (redacted.length <= ERROR_DETAIL_MAX_CHARS) return redacted;
  return `${redacted.slice(0, ERROR_DETAIL_MAX_CHARS)}...[truncated]`;
}
