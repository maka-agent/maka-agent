#!/usr/bin/env node

import { runHarborCellFromEnv } from '#harbor-cell';

try {
  const result = await runHarborCellFromEnv(process.env);
  console.log(
    JSON.stringify({
      status: result.output.status,
      errorClass: result.output.errorClass,
      outputPath: result.outputPath,
      runtimeEventsPath: result.runtimeEventsPath,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`maka run-cell failed: ${message}`);
  process.exitCode = 1;
}
