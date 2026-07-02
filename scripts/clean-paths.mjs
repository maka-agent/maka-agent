#!/usr/bin/env node
import { rm } from 'node:fs/promises';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node scripts/clean-paths.mjs <path> [path...]');
  process.exit(1);
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}
