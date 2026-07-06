export const MAX_INGEST_ITEMS = 8;
export const MAX_INGEST_FILE_BYTES = 50 * 1024 * 1024;

export type IngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

export type IngestPayload =
  | { approvalId: string; name: string; mimeType?: string }
  | { name: string; mimeType?: string; base64: string };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function encodeIngestItems(items: IngestInput[]): Promise<IngestPayload[]> {
  if (items.length > MAX_INGEST_ITEMS) throw new Error('附件数量超过 8 个');
  const out: IngestPayload[] = [];
  for (const item of items) {
    if ('file' in item) {
      // Reject oversized blobs before arrayBuffer() so the renderer never
      // loads the bytes into memory. Main-side resolveIngestItems is the
      // authoritative backstop; this guard exists only to avoid renderer OOM.
      if (item.file.size > MAX_INGEST_FILE_BYTES) throw new Error('附件大小超过 50MB');
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const mimeType = item.file.type || undefined;
      out.push({
        name: item.file.name || 'clipboard-image.png',
        ...(mimeType ? { mimeType } : {}),
        base64: bytesToBase64(bytes),
      });
    } else {
      out.push(item);
    }
  }
  return out;
}