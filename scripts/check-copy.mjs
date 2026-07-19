#!/usr/bin/env node
/**
 * check-copy.mjs — mechanical UI-copy lint.
 *
 * Enforces the machine-checkable half of the four-source copy rules
 * (vercel writing-guidelines + anthropics frontend-design + taste-skill,
 * adapted for Chinese product copy):
 *
 *   [pressure-word]   营销压力词「轻松 / 一键 / 只需」在 UI 字符串中禁用 —
 *                     they promise ease the user may not feel; describe the
 *                     actual action instead (writing-guidelines: never
 *                     easy/simple/quick).
 *   [ascii-ellipsis]  中文 UI 字符串里的 `...` 应为省略号字符 `…`
 *                     (web-interface-guidelines typography)。
 *
 * Judgment-required rules (same-intent-same-label, AI 腔清单, error =
 * 原因+修复路径) stay in human review.
 *
 * Exceptions: append `// copy-allow: <reason>` on the same line.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
  join(REPO_ROOT, 'packages', 'ui', 'src'),
];

const PRESSURE_WORDS = /轻松|一键|只需/;
const CJK = /[一-鿿]/;
// A quoted string segment on the line that contains CJK + a banned pattern.
const STRING_SEGMENT = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const root of SCAN_ROOTS) {
  for (const file of await collect(root)) {
    const rel = relative(REPO_ROOT, file);
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (line.includes('copy-allow:')) return;
      // Strip line comments so prose in comments never trips the lint.
      const code = line.replace(/\/\/.*$/, '');
      for (const match of code.matchAll(STRING_SEGMENT)) {
        const text = match[2];
        if (!CJK.test(text)) continue;
        if (PRESSURE_WORDS.test(text)) {
          violations.push(
            `  [pressure-word] ${rel}:${index + 1}\n    ${line.trim().slice(0, 120)}`,
          );
        }
        if (text.includes('...')) {
          violations.push(
            `  [ascii-ellipsis] ${rel}:${index + 1}\n    ${line.trim().slice(0, 120)}`,
          );
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`[check-copy] FAILED — ${violations.length} copy violations:`);
  for (const violation of violations) console.error(violation);
  console.error('\nFix options:');
  console.error('  - pressure-word  → 描述实际动作（「一条命令完成」而非「轻松完成」）');
  console.error('  - ascii-ellipsis → 使用省略号字符 `…`（加载中… 而非 加载中...）');
  console.error('\nGenuine exceptions: add `// copy-allow: <reason>` on the same line.');
  process.exit(1);
}
console.log('[check-copy] OK — pressure-word, ascii-ellipsis clean.');
