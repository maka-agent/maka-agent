import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = join(process.cwd(), '..', '..');
const STORY_PATH = 'packages/ui/stories/chat-surface.stories.tsx';

async function readStory(): Promise<string> {
  return readFile(join(REPO_ROOT, STORY_PATH), 'utf8');
}

describe('chat surface Storybook contract', () => {
  it('exports the PR2 chat surface states from the Storybook stories directory', async () => {
    const story = await readStory();

    assert.match(story, /title:\s*['"]Product\/Chat Surface['"]/);
    for (const exportName of [
      'EmptyChat',
      'StreamingResponse',
      'WithToolActivity',
      'Processing',
      'BranchedConversation',
      'ComposerPendingAndDisabled',
      'ImportActions',
      'LongMessages',
      'NarrowViewport',
    ]) {
      assert.match(
        story,
        new RegExp(`export const ${exportName}\\b`),
        `${STORY_PATH} must export ${exportName} for #390 PR2 review coverage.`,
      );
    }
  });
});
