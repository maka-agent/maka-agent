import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function openingTags(source: string, tagName: 'input' | 'select' | 'textarea'): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${tagName}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const start = match.index;
    let cursor = start;
    let inQuote: '"' | "'" | null = null;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>' && source[cursor - 1] !== '=') {
        tags.push(source.slice(start, cursor + 1));
        break;
      }
      cursor += 1;
    }
  }
  return tags;
}

describe('Settings form accessibility labels', () => {
  it('keeps every Settings input/select/textarea named for assistive tech', async () => {
    for (const path of [
      'apps/desktop/src/renderer/settings/SettingsModal.tsx',
      'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    ]) {
      const src = await readRepo(path);
      for (const tagName of ['input', 'select', 'textarea'] as const) {
        for (const tag of openingTags(src, tagName)) {
          assert.match(
            tag,
            /aria-label=|ariaLabel=/,
            `${path} has unnamed <${tagName}>: ${tag.replace(/\s+/g, ' ').slice(0, 180)}`,
          );
        }
      }
    }
  });

  it('names the high-risk Settings fields found by the real app AX sweep', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const providers = await readRepo('apps/desktop/src/renderer/settings/ProvidersPanel.tsx');

    for (const label of [
      'Telegram 代理地址',
      'Discord 代理地址',
      '允许的用户 ID',
      '联网搜索真实查询',
      '代理服务器地址',
      '代理端口',
      '开放网关监听地址',
      '开放网关端口',
      '开放网关会话 sessionId',
      '按模型或工具筛选请求记录',
      '请求状态筛选',
      'MEMORY.md 内容',
    ]) {
      assert.ok(settings.includes(`aria-label="${label}"`), `SettingsModal must label ${label}`);
    }

    for (const label of [
      '模型供应商 Slug',
      '模型供应商显示名称',
      '模型供应商 Base URL',
      '模型供应商默认模型',
      '模型连接 Slug',
      '搜索模型',
    ]) {
      assert.ok(providers.includes(`aria-label="${label}"`), `ProvidersPanel must label ${label}`);
    }
  });
});
