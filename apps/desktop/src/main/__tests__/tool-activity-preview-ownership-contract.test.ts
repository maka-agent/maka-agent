import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const UI_ROOT = join(REPO_ROOT, 'packages/ui/src');
const TOOL_ACTIVITY = join(UI_ROOT, 'tool-activity.tsx');
const PREVIEW_ROOT = join(UI_ROOT, 'tool-activity');

const PREVIEW_OWNERS: ReadonlyArray<{
  file: string;
  exports: readonly string[];
  contentKinds: readonly string[];
}> = [
  {
    file: 'agent-preview.tsx',
    exports: ['SubagentPreview', 'ExploreAgentPreview'],
    contentKinds: ['subagent', 'explore_agent'],
  },
  {
    file: 'file-diff-preview.tsx',
    exports: ['FileDiffPreview'],
    contentKinds: ['file_diff'],
  },
  {
    file: 'office-document-preview.tsx',
    exports: ['OfficeDocumentPreview'],
    contentKinds: ['office_document'],
  },
  {
    file: 'rive-workflow-preview.tsx',
    exports: ['RiveWorkflowPreview'],
    contentKinds: ['rive_workflow'],
  },
  {
    file: 'terminal-preview.tsx',
    exports: ['TerminalPreview'],
    contentKinds: ['terminal'],
  },
  {
    file: 'web-search-preview.tsx',
    exports: ['WebSearchPreview', 'WebSearchErrorPreview'],
    contentKinds: ['web_search', 'web_search_error'],
  },
];

describe('ToolActivity preview ownership contract', () => {
  it('keeps tool-activity.tsx as the shell instead of the result-preview owner', async () => {
    const source = await readFile(TOOL_ACTIVITY, 'utf8');

    assert.match(
      source,
      /import \{ OverlayPreview \} from '\.\/tool-activity\/overlay-preview\.js';/,
      'ToolActivity shell must delegate result rendering to the overlay preview router',
    );
    for (const owner of PREVIEW_OWNERS) {
      for (const exportName of owner.exports) {
        assert.doesNotMatch(
          source,
          new RegExp(`function\\s+${exportName}\\b`),
          `${exportName} must stay in packages/ui/src/tool-activity/${owner.file}`,
        );
      }
      const importPath = `./tool-activity/${owner.file.replace(/\.tsx$/, '.js')}`;
      assert.doesNotMatch(
        source,
        new RegExp(`from ['"]${escapeRegExp(importPath)}['"]`),
        `ToolActivity shell must not bypass overlay-preview with a direct ${owner.file} import`,
      );
    }
  });

  it('keeps each result preview in its focused owner file and routed by OverlayPreview', async () => {
    const overlay = await readFile(join(PREVIEW_ROOT, 'overlay-preview.tsx'), 'utf8');

    assert.match(overlay, /export function OverlayPreview/);
    for (const owner of PREVIEW_OWNERS) {
      const ownerSource = await readFile(join(PREVIEW_ROOT, owner.file), 'utf8');
      const importPath = `./${owner.file.replace(/\.tsx$/, '.js')}`;
      assert.match(
        overlay,
        new RegExp(`from ['"]${escapeRegExp(importPath)}['"]`),
        `OverlayPreview must import ${owner.file}`,
      );
      for (const exportName of owner.exports) {
        assert.match(
          ownerSource,
          new RegExp(`export function\\s+${exportName}\\b`),
          `${owner.file} must export ${exportName}`,
        );
      }
      for (const kind of owner.contentKinds) {
        assert.match(
          overlay,
          new RegExp(`content\\.kind === ['"]${escapeRegExp(kind)}['"]`),
          `OverlayPreview must route ${kind} results`,
        );
      }
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
