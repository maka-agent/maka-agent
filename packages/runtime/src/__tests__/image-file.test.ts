import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceImage } from '../image-file.js';

test('readWorkspaceImage rejects images whose dimensions exceed the model input limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-file-'));
  const path = join(root, 'oversized.png');
  const png = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(8001, 16);
  png.writeUInt32BE(8001, 20);
  png[24] = 8;
  png[25] = 6;
  await writeFile(path, png);

  try {
    await assert.rejects(readWorkspaceImage(path), /dimensions.*downscale/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
