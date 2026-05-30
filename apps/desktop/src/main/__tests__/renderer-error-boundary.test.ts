import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('renderer error boundary exposes a redacted copyable diagnostic report', async () => {
  const source = await readFile(join(process.cwd(), 'src/renderer/error-boundary.tsx'), 'utf8');
  const css = await readFile(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');

  assert.match(source, /import\s+\{\s*redactSecrets\s*\}\s+from\s+'@maka\/ui'/);
  assert.match(source, /export function formatRendererErrorReport/);
  assert.match(source, /return redactSecrets\(lines\.join\('\\n'\)\)/);
  assert.match(source, /const safeStack = redactSecrets\(/);
  assert.match(source, /navigator\.clipboard\.writeText\(formatRendererErrorReport\(error, errorInfo\)\)/);
  assert.match(source, /复制诊断信息/);
  assert.match(source, /系统剪贴板不可用/);
  assert.match(css, /\.maka-error-copy-status/);
});
