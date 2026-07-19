/**
 * Contract for the composer `@`/`/` mention popups
 * (feat/composer-mentions, docs/archive/composer-mentions-spec-2026-07-14.md).
 *
 * Pins the fragile ordering + SSR-safety guarantees:
 *   1. The mention-popup keyboard branch runs BEFORE the Esc/drag branch and
 *      BEFORE the send fall-through, so Enter selects a mention (never sends).
 *   2. The mention Escape branch closes ONLY the popup — it must not call
 *      setDragActive or props.onStop (Esc-with-popup keeps the drag highlight
 *      and never stops the stream).
 *   3. Composer rendered with minimal props (no mention props) stays green and
 *      renders no listbox — the mention feature is fully inert without wiring.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, LocaleProvider } from '@maka/ui';

const COMPOSER_TSX = join(process.cwd(), '../../packages/ui/src/composer.tsx');

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

function keydownBody(source: string): string {
  return source.match(/function onTextareaKeyDown\(event: KeyboardEvent<HTMLTextAreaElement>\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
}

describe('composer mention popup contract', () => {
  it('runs the mention keyboard branch before the Esc/drag and send branches', async () => {
    const source = await readFile(COMPOSER_TSX, 'utf8');
    const keydown = keydownBody(source);
    assert.notEqual(keydown, '', 'onTextareaKeyDown body must be found');

    const mentionAt = keydown.indexOf('if (mentionPopupOpen) {');
    const escDragAt = keydown.indexOf("event.key === 'Escape' && dragActive");
    const streamingAt = keydown.indexOf("event.key === 'Escape' && props.streaming");
    const sendAt = keydown.indexOf("if (event.key !== 'Enter') return;");

    assert.ok(mentionAt >= 0, 'mention popup branch must exist in onTextareaKeyDown');
    assert.ok(escDragAt >= 0 && streamingAt >= 0 && sendAt >= 0, 'anchor branches must exist');
    assert.ok(mentionAt < escDragAt, 'mention branch must precede the Esc/drag branch');
    assert.ok(mentionAt < streamingAt, 'mention branch must precede the streaming Esc branch');
    assert.ok(mentionAt < sendAt, 'mention branch must precede the Enter→send fall-through');
  });

  it('Enter/Tab select a mention with preventDefault (so Enter cannot send)', async () => {
    const source = await readFile(COMPOSER_TSX, 'utf8');
    const keydown = keydownBody(source);
    const mentionBlock = keydown.slice(keydown.indexOf('if (mentionPopupOpen) {'));
    assert.match(
      mentionBlock,
      /if \(event\.key === 'Enter' \|\| event\.key === 'Tab'\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?selectMention\(mentionActiveIndex\);/,
      'Enter/Tab with items must preventDefault and select the active mention',
    );
  });

  it('the mention Escape branch closes only the popup (no drag clear, no stop)', async () => {
    const source = await readFile(COMPOSER_TSX, 'utf8');
    const keydown = keydownBody(source);
    const mentionStart = keydown.indexOf('if (mentionPopupOpen) {');
    const escDragAt = keydown.indexOf("event.key === 'Escape' && dragActive");
    // The slice of the mention branch that precedes the drag branch.
    const mentionBlock = keydown.slice(mentionStart, escDragAt);
    assert.match(
      mentionBlock,
      /if \(event\.key === 'Escape'\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?closeMention\(\);[\s\S]*?return;/,
      'popup-open Escape must preventDefault + closeMention + return',
    );
    assert.doesNotMatch(mentionBlock, /setDragActive/, 'mention branch must not touch drag state');
    assert.doesNotMatch(mentionBlock, /onStop/, 'mention branch must not stop the stream');
  });

  it('renders inert (no listbox) when mention props are absent (SSR minimal props)', () => {
    const markup = renderWithLocale(
      createElement(Composer, { onSend: () => {}, onStop: () => {} }),
    );
    assert.doesNotMatch(markup, /role="listbox"/, 'no popup without mention props');
    assert.doesNotMatch(markup, /maka-composer-mention-popup/, 'popup markup must be absent');
  });
});
