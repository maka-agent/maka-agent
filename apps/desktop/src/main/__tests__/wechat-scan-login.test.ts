import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { fetchWeChatQrcode } from '../wechat-scan-login.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WeChat scan login', () => {
  it('renders Alma iLink qrcode_img_content into an image data URL', async () => {
    const rawQrContent = 'https://ilinkai.weixin.qq.com/connect/weixin-login?qrcode=scan-token-123';
    const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: init?.headers });
      return new Response(JSON.stringify({
        ret: 0,
        qrcode_img_content: rawQrContent,
        qrcode: 'poll-token-123',
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchWeChatQrcode();

    assert.equal(result.qrToken, 'poll-token-123');
    assert.match(result.qrcodeUrl, /^data:image\/png;base64,/);
    assert.notEqual(result.qrcodeUrl, rawQrContent);
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? '', /\/ilink\/bot\/get_bot_qrcode\?bot_type=3$/);
    assert.ok((requests[0]?.headers as Record<string, string> | undefined)?.['X-WECHAT-UIN']);
  });
});
