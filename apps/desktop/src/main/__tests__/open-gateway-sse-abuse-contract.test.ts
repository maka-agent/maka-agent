import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readRepo(path: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

describe('OpenGateway SSE abuse hardening contract', () => {
  it('keeps stream limits closed and rejects before SSE headers are written', async () => {
    const source = await readRepo('apps/desktop/src/main/open-gateway.ts');
    const openStream = source.match(/private openSessionEventStream\([^]*?\n  private removeEventClient/);

    assert.ok(openStream, 'openSessionEventStream block must exist');
    assert.match(source, /const OPEN_GATEWAY_EVENT_STREAM_TOTAL_LIMIT = 10;/);
    assert.match(source, /const OPEN_GATEWAY_EVENT_STREAM_PER_SESSION_LIMIT = 3;/);
    assert.ok(
      openStream![0].indexOf('too_many_event_streams') < openStream![0].indexOf("res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')"),
      'limit rejection must happen before event-stream headers are committed',
    );
    assert.match(
      openStream![0],
      /writeJson\(res, 429, \{ ok: false, error: 'too_many_event_streams' \}\);[\s\S]*return;/,
      'excess streams must use the stable closed 429 error shape',
    );
  });

  it('bases idle timeout on real SSE events, not heartbeat comments, and clears timers on removal', async () => {
    const source = await readRepo('apps/desktop/src/main/open-gateway.ts');
    const openStream = source.match(/private openSessionEventStream\([^]*?\n  private removeEventClient/);
    const removeClient = source.match(/private removeEventClient\([^]*?\n  private closeEventClients/);

    assert.ok(openStream, 'openSessionEventStream block must exist');
    assert.ok(removeClient, 'removeEventClient block must exist');
    assert.match(source, /const OPEN_GATEWAY_EVENT_IDLE_TIMEOUT_MS = 5 \* 60 \* 1_000;/);
    assert.match(openStream![0], /heartbeat: setInterval\(\(\) => \{[\s\S]*res\.write\(`: heartbeat \$\{this\.now\(\)\}\\n\\n`\);[\s\S]*\}, OPEN_GATEWAY_EVENT_HEARTBEAT_MS\)/);
    assert.doesNotMatch(
      openStream![0].match(/heartbeat: setInterval\(\(\) => \{[\s\S]*?\}, OPEN_GATEWAY_EVENT_HEARTBEAT_MS\)/)?.[0] ?? '',
      /resetIdleTimer/,
      'heartbeat comments must not reset the idle timer',
    );
    assert.match(openStream![0], /write\(chunk\) \{[\s\S]*res\.write\(chunk\);[\s\S]*resetIdleTimer\(\);[\s\S]*\}/);
    assert.match(removeClient![0], /if \(client\.closed\) return;[\s\S]*client\.closed = true;/);
    assert.match(removeClient![0], /clearInterval\(client\.heartbeat\);/);
    assert.match(removeClient![0], /clearTimeout\(client\.idleTimeout\);/);
  });
});
