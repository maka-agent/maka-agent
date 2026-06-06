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
  assert.match(source, /copyState: 'idle' \| 'pending' \| 'copied' \| 'failed'/);
  assert.match(source, /private mounted = false/);
  assert.match(source, /private copyRequestSeq = 0/);
  assert.match(source, /componentDidMount\(\): void \{[\s\S]*this\.mounted = true;[\s\S]*\}/);
  assert.match(source, /componentWillUnmount\(\): void \{[\s\S]*this\.mounted = false;[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*\}/);
  assert.match(source, /componentDidCatch\(error: Error, info: ErrorInfo\): void \{[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*this\.setState\(\{ errorInfo: info \}\);[\s\S]*\}/);
  assert.match(source, /private handleReset = \(\) => \{[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*this\.setState\(\{ error: null, errorInfo: null, copyState: 'idle' \}\);[\s\S]*\};/);
  assert.match(source, /private isCurrentCopyRequest\(copyRequestId: number, error: Error\): boolean \{[\s\S]*return this\.mounted && this\.copyRequestSeq === copyRequestId && this\.state\.error === error;[\s\S]*\}/);
  assert.match(source, /if \(!error \|\| this\.state\.copyState === 'pending'\) return;/);
  assert.match(source, /const copyRequestId = \+\+this\.copyRequestSeq/);
  assert.match(source, /this\.setState\(\{ copyState: 'pending' \}\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(formatRendererErrorReport\(error, errorInfo\)\)/);
  assert.match(source, /if \(this\.isCurrentCopyRequest\(copyRequestId, error\)\) this\.setState\(\{ copyState: 'copied' \}\)/);
  assert.match(source, /if \(this\.isCurrentCopyRequest\(copyRequestId, error\)\) this\.setState\(\{ copyState: 'failed' \}\)/);
  assert.doesNotMatch(source, /await navigator\.clipboard\.writeText\(formatRendererErrorReport\(error, errorInfo\)\);\s*this\.setState\(\{ copyState: 'copied' \}\)/);
  assert.doesNotMatch(source, /\} catch \{\s*this\.setState\(\{ copyState: 'failed' \}\)/);
  assert.match(source, /copyPending \? '复制中…'/);
  assert.match(source, /disabled=\{copyPending\}/);
  assert.match(source, /aria-busy=\{copyPending \? 'true' : undefined\}/);
  assert.match(source, /data-copy-state=\{copyState\}/);
  assert.match(source, /复制诊断信息/);
  assert.match(source, /剪贴板不可用或被系统拒绝；可以手动选择上面的错误摘要。/);
  assert.match(css, /\.maka-error-copy-status/);
  assert.match(css, /\.maka-error-copy-action\[data-copy-state="pending"\]/);
  assert.match(css, /\.maka-error-copy-action\[data-copy-state="failed"\]/);
});
