import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatRedactedJson, formatToolIntent } from '@maka/ui';

describe('tool and permission args redaction', () => {
  it('redacts JSON-shaped args before they are rendered', () => {
    const rendered = formatRedactedJson({
      command: 'curl -H "Authorization: Bearer sk-live-secret-token" https://example.test',
      nested: { apiKey: 'sk-ant-test-secret-token-12345' },
    });

    assert.doesNotMatch(rendered, /sk-live-secret-token/);
    assert.doesNotMatch(rendered, /sk-ant-test-secret-token-12345/);
    assert.match(rendered, /Authorization: Bearer/);
    assert.match(rendered, /command/);
  });

  it('routes ToolActivity and PermissionDialog args through formatRedactedJson', async () => {
    const [toolSource, permissionSource] = await Promise.all([
      readFile(join(process.cwd(), '../../packages/ui/src/tool-activity.tsx'), 'utf8'),
      readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8'),
    ]);
    const toolActivity = toolSource.match(/export function ToolActivity[\s\S]*?function ToolOutputStream/)?.[0] ?? '';
    const permissionDialog = permissionSource.match(/export function PermissionDialog[\s\S]*?function renderPermissionSummary/)?.[0] ?? '';

    assert.match(toolActivity, /\{formatRedactedJson\(item\.args\)\}/);
    assert.doesNotMatch(toolActivity, /JSON\.stringify\(item\.args/);
    assert.match(permissionDialog, /\{formatRedactedJson\([\s\S]*?props\.request\.additionalPermissions[\s\S]*?props\.request\.args,[\s\S]*?\)\}/);
    assert.doesNotMatch(permissionDialog, /JSON\.stringify\(props\.request\.(?:args|additionalPermissions)/);
  });

  it('redacts and caps model-authored tool intents before rendering', async () => {
    const rendered = formatToolIntent(
      `Use curl with Authorization: Bearer sk-live-secret-token ${'x'.repeat(320)}`,
    );

    assert.doesNotMatch(rendered, /sk-live-secret-token/);
    assert.match(rendered, /Authorization: Bearer/);
    assert.ok(rendered.length <= 241);

    const source = await readFile(join(process.cwd(), '../../packages/ui/src/tool-activity.tsx'), 'utf8');
    const toolActivity = source.match(/export function ToolActivity[\s\S]*?function ToolOutputStream/)?.[0] ?? '';
    assert.match(toolActivity, /\{formatToolIntent\(item\.intent\)\}/);
    assert.doesNotMatch(toolActivity, /\{item\.intent\}/);
  });

  it('redacts permission summary previews before rendering command, path, or file content', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8');
    const summary = source.match(/function renderPermissionSummary[\s\S]*?function permissionValuePreview/)?.[0] ?? '';

    assert.match(summary, /\{redactSecrets\(command\)\}/);
    assert.match(summary, /\{redactSecrets\(path\)\}/);
    assert.match(summary, /const preview = permissionTextPreview\(content, 600\);/);
    assert.match(summary, /\{permissionTextPreview\(oldString, 400\)\}/);
    assert.match(summary, /\{permissionTextPreview\(newString, 400\)\}/);
    assert.doesNotMatch(summary, /\{command\}<\/pre>/);
    assert.doesNotMatch(summary, /\{path\}<\/code>/);
    assert.doesNotMatch(summary, /oldString\.slice/);
    assert.doesNotMatch(summary, /newString\.slice/);
  });
});
