import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeIngestItems } from '../../preload/attachment-ingest-payload.js';

describe('encodeIngestItems', () => {
  test('rejects more than 8 items without reading any file bytes', async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ approvalId: `a${i}`, name: `f${i}.txt` }));
    await assert.rejects(encodeIngestItems(items as never), /8/);
  });

  test('rejects a File over 50MB without calling arrayBuffer', async () => {
    let arrayBufferCalls = 0;
    const bigFile = {
      name: 'big.bin',
      type: 'application/octet-stream',
      size: 50 * 1024 * 1024 + 1,
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        return new ArrayBuffer(0);
      },
    } as unknown as File;
    await assert.rejects(encodeIngestItems([{ file: bigFile }]), /50/);
    assert.equal(arrayBufferCalls, 0, 'arrayBuffer must not be called for an oversized file');
  });

  test('passes approval items through untouched', async () => {
    const items = [{ approvalId: 'a1', name: 'f.txt', mimeType: 'text/plain' }];
    const out = await encodeIngestItems(items as never);
    assert.deepEqual(out, [{ approvalId: 'a1', name: 'f.txt', mimeType: 'text/plain' }]);
  });

  test('encodes a File under 50MB to base64', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = {
      name: 'img.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    const out = await encodeIngestItems([{ file }]);
    assert.equal(out.length, 1);
    const payload = out[0] as { name: string; mimeType: string; base64: string };
    assert.equal(payload.name, 'img.png');
    assert.equal(payload.mimeType, 'image/png');
    assert.equal(payload.base64, btoa(String.fromCharCode(...bytes)));
  });

  test('rejects a raw base64 item that is neither a File nor an approval token', async () => {
    await assert.rejects(
      encodeIngestItems([{ name: 'forged', base64: 'AAAA' }] as never),
      /无效/,
    );
  });
});
