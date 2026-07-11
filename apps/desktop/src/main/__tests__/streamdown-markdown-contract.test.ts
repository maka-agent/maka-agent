import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parseMarkdownIntoBlocks } from 'streamdown';

const uiSource = (name: string) => readFile(
  fileURLToPath(new URL(`../../../../../packages/ui/src/${name}`, import.meta.url)),
  'utf8',
);

it('uses Streamdown streaming mode for live answers without a second fade owner', async () => {
  const [body, wrapper, chat] = await Promise.all([
    uiSource('markdown-body.tsx'),
    uiSource('markdown.tsx'),
    uiSource('chat-view.tsx'),
  ]);

  assert.match(body, /import \{[^}]*Streamdown[^}]*\} from 'streamdown';/);
  assert.match(body, /mode=\{props\.streaming \? 'streaming' : 'static'\}/);
  assert.match(body, /parseIncompleteMarkdown=\{props\.streaming\}/);
  assert.doesNotMatch(body, /ReactMarkdown|streamFadeRehypePlugin/);
  assert.match(wrapper, /MarkdownBody text=\{props\.text\} streaming=\{props\.streaming\}/);
  assert.match(chat, /<Markdown text=\{displayed\} streaming \/>/);
  assert.doesNotMatch(chat, /<Markdown text=\{displayed\} streamFade=/);
});

it('keeps completed Markdown blocks stable while the trailing table grows', () => {
  const first = parseMarkdownIntoBlocks('结论先行。\n\n| 名称 | 状态 |\n| --- | --- |');
  const next = parseMarkdownIntoBlocks('结论先行。\n\n| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |');

  assert.equal(first[0], '结论先行。');
  assert.equal(next[0], first[0]);
  assert.equal(first.length, 3);
  assert.equal(next.length, 3);
});
