import type { MakaTool } from '@maka/runtime';
import { buildBuiltinTools } from '@maka/runtime';
import { z } from 'zod';
import type { IsolatedToolExecutor } from './isolation.js';

/**
 * Build Maka's standard headless tool surface with Bash routed through an
 * isolated executor. The pure file tools remain host-side but are path-confined
 * to the throwaway workspace by @maka/runtime's builtin implementations; the
 * dangerous part is process execution, which must not inherit host secrets or
 * filesystem reachability.
 */
export function buildIsolatedHeadlessTools(executor: IsolatedToolExecutor): MakaTool[] {
  const pureTools = buildBuiltinTools().filter((tool) => tool.name !== 'Bash');
  return [buildIsolatedBashTool(executor), ...pureTools];
}

export function buildIsolatedBashTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the isolated headless task workspace.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    impl: async ({ command, timeout_ms }, { cwd, emitOutput }) => {
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout_ms ?? 120_000,
      });
      if (result.stdout) emitOutput('stdout', result.stdout);
      if (result.stderr) emitOutput('stderr', result.stderr);
      return {
        kind: 'terminal',
        cwd,
        cmd: command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}
