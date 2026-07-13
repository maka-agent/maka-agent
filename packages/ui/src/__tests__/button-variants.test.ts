import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonVariants } from '../ui.js';

test('filled secondary buttons have distinct rest, hover, and pressed states', () => {
  const classes = buttonVariants({ variant: 'secondary' }).split(/\s+/);

  assert.ok(classes.includes('bg-secondary'));
  assert.ok(classes.includes('hover:bg-[var(--foreground-8)]'));
  assert.ok(classes.includes('hover:border-border-strong'));
  assert.ok(classes.includes('active:bg-[var(--foreground-10)]'));
  assert.ok(!classes.includes('hover:bg-muted'), 'secondary rest and hover must not resolve to the same color');
});
