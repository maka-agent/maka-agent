import { nativeImage } from 'electron';
import { computeResizeDimensions } from './attachment-resize.js';

/**
 * Resize an image attachment's bytes so its longest edge fits the
 * attachment cap, then re-encode as PNG. Uses Electron's nativeImage, so
 * this runs in the main process only and is not unit-tested — the size
 * math lives in the tested {@link computeResizeDimensions}. GIFs collapse
 * to their first frame (accepted trade-off; animated GIF attachments are
 * rare and the alternative is shipping the full bytes).
 */
export async function resizeImageForAttachment(bytes: Uint8Array): Promise<Uint8Array> {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  const size = img.getSize();
  const target = computeResizeDimensions(size.width, size.height);
  if (!target) return bytes;
  const resized = img.resize({ width: target.width, height: target.height });
  return resized.toPNG();
}
