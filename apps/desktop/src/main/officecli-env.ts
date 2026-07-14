import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function bundledOfficeCliToolsDirs(resourcesPath = currentResourcesPath()): string[] {
  const dirs = resourcesPath ? [join(resourcesPath, 'tools')] : [];
  const devToolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'tools');
  if (!dirs.includes(devToolsDir)) dirs.push(devToolsDir);
  return dirs;
}

export function prependBundledOfficeCliTools(currentPath: string, resourcesPath = currentResourcesPath()): string {
  const toolsPath = bundledOfficeCliToolsDirs(resourcesPath).join(delimiter);
  if (!toolsPath) return currentPath;
  return currentPath ? `${toolsPath}${delimiter}${currentPath}` : toolsPath;
}

export function buildOfficeCliEnv(baseEnv: NodeJS.ProcessEnv = process.env, resourcesPath = currentResourcesPath()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, OFFICECLI_SKIP_UPDATE: '1' };
  const pathValue = envValueCaseInsensitive(env, 'PATH') ?? '';
  const nextPath = prependBundledOfficeCliTools(pathValue, resourcesPath);
  stripPathKeys(env);
  if (nextPath) env.PATH = nextPath;
  return env;
}

function currentResourcesPath(): string {
  return (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
}

function envValueCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function stripPathKeys(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
}
