#!/usr/bin/env node

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

await chmod(join(process.cwd(), 'dist', 'cli.js'), 0o755);
