import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonVariants } from '../ui.js';

test('Button exposes only the governed 32px and 28px geometry tiers', () => {
  const medium = buttonVariants({ size: 'md' });
  const small = buttonVariants({ size: 'sm' });
  const icon = buttonVariants({ size: 'icon' });
  const iconSmall = buttonVariants({ size: 'icon-sm' });

  assert.match(medium, /\bh-8\b/);
  assert.match(medium, /\bpx-3\b/);
  assert.match(small, /\bh-7\b/);
  assert.match(small, /\bpx-2\b/);
  assert.match(icon, /\bh-8\b/);
  assert.match(icon, /\bw-8\b/);
  assert.match(iconSmall, /\bh-7\b/);
  assert.match(iconSmall, /\bw-7\b/);
});

test('Button neutral variants share one restrained interaction hierarchy', () => {
  const secondary = buttonVariants({ variant: 'secondary' });
  const ghost = buttonVariants({ variant: 'ghost' });
  const quiet = buttonVariants({ variant: 'quiet' });

  assert.match(secondary, /\bborder\b/);
  assert.match(secondary, /\bbg-transparent\b/);
  for (const classes of [secondary, ghost, quiet]) {
    assert.match(classes, /\bfont-normal\b/);
    assert.match(classes, /hover:bg-\[var\(--state-hover-bg\)\]/);
    assert.match(classes, /active:bg-\[var\(--state-selected-bg\)\]/);
  }
});

test('Button focus and solid states stay visibly distinct without elevation', () => {
  const primary = buttonVariants({ variant: 'default' });
  const destructive = buttonVariants({ variant: 'destructive' });

  assert.match(primary, /\bfont-medium\b/);
  assert.match(destructive, /\bfont-medium\b/);
  assert.ok(!primary.includes('shadow-'));
  assert.ok(!primary.includes('ring-offset'));
  assert.notEqual(primary.match(/hover:[^ ]+/)?.[0], primary.match(/active:[^ ]+/)?.[0]);
  assert.notEqual(destructive.match(/hover:[^ ]+/)?.[0], destructive.match(/active:[^ ]+/)?.[0]);
});
