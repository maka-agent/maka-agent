import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = join(process.cwd(), 'src');
const packageName = '@maka/runtime-host';
const compilerApi = new API({ cwd: process.cwd() });
const projectConfig = join(process.cwd(), 'tsconfig.json');
const compilerSnapshot = compilerApi.updateSnapshot({ openProjects: [projectConfig] });
const compilerProject = loadCompilerProject();
const allowedHostExternalImports = new Set([
  '@maka/storage/root-authority',
  'node:child_process',
  'node:crypto',
  'node:fs/promises',
  'node:net',
  'node:path',
  'node:perf_hooks',
  'node:url',
  'node:util',
]);
const allowedServerExternalImports = new Set([
  ...allowedHostExternalImports,
  '@maka/core/agent-run',
  '@maka/core',
  '@maka/core/automation',
  '@maka/core/artifacts',
  '@maka/core/backend-types',
  '@maka/core/computer-use',
  '@maka/core/events',
  '@maka/core/expert-team',
  '@maka/core/explore-agent',
  '@maka/core/interaction',
  '@maka/core/local-memory',
  '@maka/core/llm-connections',
  '@maka/core/memory',
  '@maka/core/model-metadata',
  '@maka/core/redaction',
  '@maka/core/runtime-event',
  '@maka/core/runtime-policy',
  '@maka/core/session',
  '@maka/core/shell-run',
  '@maka/core/task-ledger',
  '@maka/core/usage-stats/types',
  '@maka/runtime',
  '@maka/runtime/browser-tools',
  '@maka/storage',
  '@maka/storage/artifact-stores',
  '@maka/storage/execution-stores',
  '@maka/storage/memory-store',
  '@maka/storage/runtime-policy-stores',
  '@maka/storage/shell-run-store',
  '@maka/storage/task-ledger-store',
  '@maka/storage/pricing-store',
  '@maka/storage/usage-stores',
  'ai',
  'node:async_hooks',
  'node:fs',
  'node:http',
  'node:os',
]);
const allowedExternalImports = {
  client: allowedHostExternalImports,
  protocol: new Set([
    '@maka/core/attachments',
    '@maka/core/artifacts',
    '@maka/core/browser',
    '@maka/core/computer-use',
    '@maka/core/events',
    '@maka/core/interaction',
    '@maka/core/local-memory',
    '@maka/core/runtime-policy',
    '@maka/core/task-ledger',
    '@maka/core/usage-stats/pricing',
    '@maka/core/usage-stats/types',
    'node:util',
  ]),
} as const;
const nativeBrowserEntrypoint = 'native-provider/browser';
const nativeBrowserSourcePath = join(sourceRoot, 'native-provider', 'browser.ts');
const allowedNativeBrowserExternalImports = new Set(['@maka/runtime/browser-tools']);
const nativeComputerUseEntrypoint = 'native-provider/computer-use';
const nativeComputerUseSourcePath = join(sourceRoot, 'native-provider', 'computer-use.ts');
const allowedNativeComputerUseExternalImports = new Set([
  '@maka/core/computer-use',
  '@maka/core/redaction',
  '@maka/runtime',
  'node:crypto',
]);
const nativeOAuthPresentationEntrypoint = 'native-provider/oauth-presentation';
const nativeOAuthPresentationSourcePath = join(
  sourceRoot,
  'native-provider',
  'oauth-presentation.ts',
);

async function dependencyScannerFixture(target: string): Promise<void> {
  await import(`node:url`);
  await import(target);
}
void dependencyScannerFixture;

function dependencyScannerLoaderCapabilityFixture(): void {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/headless');
}
void dependencyScannerLoaderCapabilityFixture;

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error(`TypeScript did not load ${projectConfig}`);
  return project;
}

test('protocol and client stay within their subpaths and the root-authority boundary', async () => {
  const violations: string[] = [];
  const publicEntrypoints = await readPublicEntrypoints();
  for (const area of ['protocol', 'client'] as const) {
    const entrypoint = publicEntrypoints.get(area);
    assert.ok(entrypoint, `missing public ${area} entrypoint`);
    for (const path of reachableModules(entrypoint, publicEntrypoints)) {
      const localPath = relative(sourceRoot, path);
      const topLevelArea = localPath.split(sep)[0];
      if (
        localPath === 'candidate-main.ts' ||
        topLevelArea === 'server' ||
        (area === 'protocol' && topLevelArea !== 'protocol')
      ) {
        violations.push(`${area} reaches ${localPath}`);
      }
      for (const specifier of moduleSpecifiers(path)) {
        const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
        if (target) {
          if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
          continue;
        }
        const allowedImports =
          topLevelArea === 'protocol'
            ? allowedExternalImports.protocol
            : allowedExternalImports[area];
        if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('serving Runtime dependencies stay within server and explicit adapter boundaries', async () => {
  const violations: string[] = [];
  for (const path of await listTypeScriptFiles(sourceRoot)) {
    const localPath = relative(sourceRoot, path);
    const topLevelArea = localPath.split(sep)[0];
    if (topLevelArea === '__tests__') continue;
    const allowedImports =
      path === nativeBrowserSourcePath
        ? allowedNativeBrowserExternalImports
        : path === nativeComputerUseSourcePath
          ? allowedNativeComputerUseExternalImports
          : topLevelArea === 'server' || localPath === 'candidate-main.ts'
            ? allowedServerExternalImports
            : topLevelArea === 'protocol'
              ? allowedExternalImports.protocol
              : allowedHostExternalImports;
    for (const specifier of moduleSpecifiers(path)) {
      if (isRelativeSpecifier(specifier)) {
        const target = sourcePathForSpecifier(path, specifier);
        if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
        continue;
      }
      if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the public native Computer Use leaf stays within its exact adapter boundary', async () => {
  const publicEntrypoints = await readPublicEntrypoints();
  const entrypoint = publicEntrypoints.get(nativeComputerUseEntrypoint);
  assert.ok(entrypoint, `missing public ${nativeComputerUseEntrypoint} entrypoint`);
  assert.equal(entrypoint, nativeComputerUseSourcePath);
  const violations: string[] = [];
  for (const path of reachableModules(entrypoint, publicEntrypoints)) {
    const localPath = relative(sourceRoot, path);
    const topLevelArea = localPath.split(sep)[0];
    if (localPath === 'candidate-main.ts' || topLevelArea === 'server') {
      violations.push(`${nativeComputerUseEntrypoint} reaches ${localPath}`);
    }
    for (const specifier of moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (target) {
        if (!isInside(sourceRoot, target)) {
          violations.push(`${path}: ${specifier}`);
          continue;
        }
        if (path === entrypoint) {
          const targetArea = relative(sourceRoot, target).split(sep)[0];
          if (targetArea !== 'client' && targetArea !== 'protocol') {
            violations.push(`${path}: ${specifier}`);
          }
        }
        continue;
      }
      if (isStorageWriterDependency(specifier)) {
        violations.push(`${localPath}: ${specifier}`);
        continue;
      }
      const allowedImports =
        path === entrypoint
          ? allowedNativeComputerUseExternalImports
          : topLevelArea === 'protocol'
            ? allowedExternalImports.protocol
            : allowedHostExternalImports;
      if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the public native Browser leaf stays within its exact adapter boundary', async () => {
  assert.equal(allowedNativeBrowserExternalImports.has('@maka/runtime'), false);
  const publicEntrypoints = await readPublicEntrypoints();
  const entrypoint = publicEntrypoints.get(nativeBrowserEntrypoint);
  assert.ok(entrypoint, `missing public ${nativeBrowserEntrypoint} entrypoint`);
  assert.equal(entrypoint, nativeBrowserSourcePath);
  const violations: string[] = [];
  for (const path of reachableModules(entrypoint, publicEntrypoints)) {
    const localPath = relative(sourceRoot, path);
    const topLevelArea = localPath.split(sep)[0];
    if (localPath === 'candidate-main.ts' || topLevelArea === 'server') {
      violations.push(`${nativeBrowserEntrypoint} reaches ${localPath}`);
    }
    for (const specifier of moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (target) {
        if (!isInside(sourceRoot, target)) {
          violations.push(`${path}: ${specifier}`);
          continue;
        }
        if (path === entrypoint) {
          const targetArea = relative(sourceRoot, target).split(sep)[0];
          if (targetArea !== 'client' && targetArea !== 'protocol') {
            violations.push(`${path}: ${specifier}`);
          }
        }
        continue;
      }
      if (isStorageWriterDependency(specifier)) {
        violations.push(`${localPath}: ${specifier}`);
        continue;
      }
      const allowedImports =
        path === entrypoint
          ? allowedNativeBrowserExternalImports
          : topLevelArea === 'protocol'
            ? allowedExternalImports.protocol
            : allowedHostExternalImports;
      if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the public native OAuth presentation leaf stays within its exact adapter boundary', async () => {
  const publicEntrypoints = await readPublicEntrypoints();
  const entrypoint = publicEntrypoints.get(nativeOAuthPresentationEntrypoint);
  assert.ok(entrypoint, `missing public ${nativeOAuthPresentationEntrypoint} entrypoint`);
  assert.equal(entrypoint, nativeOAuthPresentationSourcePath);
  const violations: string[] = [];
  for (const path of reachableModules(entrypoint, publicEntrypoints)) {
    const localPath = relative(sourceRoot, path);
    const topLevelArea = localPath.split(sep)[0];
    if (localPath === 'candidate-main.ts' || topLevelArea === 'server') {
      violations.push(`${nativeOAuthPresentationEntrypoint} reaches ${localPath}`);
    }
    for (const specifier of moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (target) {
        if (!isInside(sourceRoot, target)) {
          violations.push(`${path}: ${specifier}`);
          continue;
        }
        if (path === entrypoint) {
          const targetArea = relative(sourceRoot, target).split(sep)[0];
          if (targetArea !== 'client' && targetArea !== 'protocol') {
            violations.push(`${path}: ${specifier}`);
          }
        }
        continue;
      }
      if (isStorageWriterDependency(specifier)) {
        violations.push(`${localPath}: ${specifier}`);
        continue;
      }
      const allowedImports =
        topLevelArea === 'protocol' ? allowedExternalImports.protocol : allowedHostExternalImports;
      if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the production Candidate dependency graph remains non-serving', () => {
  const publicEntrypoints = new Map<string, string>();
  const reached = reachableModules(join(sourceRoot, 'candidate-main.ts'), publicEntrypoints);
  const forbiddenLocalModules = new Set([
    'server/execution-candidate.ts',
    'server/execution-composition.ts',
    'server/root-turn-coordinator.ts',
    'server/runtime-resource-coordinator.ts',
  ]);
  const violations: string[] = [];
  for (const path of reached) {
    const localPath = relative(sourceRoot, path);
    if (forbiddenLocalModules.has(localPath)) violations.push(localPath);
    for (const specifier of moduleSpecifiers(path)) {
      if (isServingDependency(specifier)) {
        violations.push(`${localPath}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the public server entrypoint does not expose serving execution composition', async () => {
  const publicEntrypoints = await readPublicEntrypoints();
  const serverEntrypoint = publicEntrypoints.get('server');
  assert.ok(serverEntrypoint, 'missing public server entrypoint');
  const forbidden = new Set([
    'server/execution-candidate.ts',
    'server/execution-composition.ts',
    'server/native-computer-use-provider.ts',
    'server/root-turn-coordinator.ts',
    'server/runtime-resource-coordinator.ts',
  ]);
  const violations: string[] = [];
  for (const path of reachableModules(serverEntrypoint, publicEntrypoints)) {
    const localPath = relative(sourceRoot, path);
    if (forbidden.has(localPath)) violations.push(localPath);
    for (const specifier of moduleSpecifiers(path)) {
      if (isServingDependency(specifier)) violations.push(`${localPath}: ${specifier}`);
    }
  }
  assert.deepEqual(violations.sort(), []);
});

test('dependency scanning fails closed on computed loads, loader aliases, and unapproved packages', () => {
  const scan = scanModuleReferences(join(sourceRoot, '__tests__', 'dependency-boundary.test.ts'));
  assert.ok(scan.specifiers.includes('node:url'));
  assert.equal(scan.specifiers.includes('node:module'), false);
  assert.equal(allowedHostExternalImports.has('node:module'), false);
  assert.equal(allowedHostExternalImports.has('@maka/headless'), false);
  assert.equal(scan.nonStaticLoads.length, 1);
  assert.match(scan.nonStaticLoads[0] ?? '', /import\(\.\.\.\)/);
  assert.equal(scan.forbiddenLoaderCapabilities.length, 1);
  assert.match(scan.forbiddenLoaderCapabilities[0] ?? '', /getBuiltinModule/);
});

test('serving dependencies include the Storage barrel and every writer subpath', () => {
  assert.equal(isServingDependency('@maka/runtime'), true);
  assert.equal(isServingDependency('@maka/storage'), true);
  assert.equal(isServingDependency('@maka/storage/future-writer'), true);
  assert.equal(isServingDependency('@maka/storage/root-authority'), false);
});

function isServingDependency(specifier: string): boolean {
  return (
    specifier === '@maka/runtime' ||
    (specifier !== '@maka/storage/root-authority' &&
      (specifier === '@maka/storage' || specifier.startsWith('@maka/storage/')))
  );
}

function isStorageWriterDependency(specifier: string): boolean {
  return (
    specifier !== '@maka/storage/root-authority' &&
    (specifier === '@maka/storage' || specifier.startsWith('@maka/storage/'))
  );
}

function reachableModules(
  entrypoint: string,
  publicEntrypoints: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (!target) continue;
      if (isInside(sourceRoot, target)) visit(target);
    }
  };
  visit(entrypoint);
  return [...seen];
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function moduleSpecifiers(path: string): string[] {
  const scan = scanModuleReferences(path);
  const violations = [...scan.nonStaticLoads, ...scan.forbiddenLoaderCapabilities];
  if (violations.length > 0) {
    throw new Error(
      `Dependency boundary requires explicit module declarations:\n${violations.join('\n')}`,
    );
  }
  return scan.specifiers;
}

function scanModuleReferences(path: string): {
  specifiers: string[];
  nonStaticLoads: string[];
  forbiddenLoaderCapabilities: string[];
} {
  const source = compilerProject.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const specifiers: string[] = [];
  const nonStaticLoads: string[] = [];
  const forbiddenLoaderCapabilities: string[] = [];
  const visit = (node: ts.Node) => {
    if (forbiddenLoaderCapabilities.length === 0 && isGetBuiltinModuleAccess(node)) {
      forbiddenLoaderCapabilities.push(`${path}: getBuiltinModule`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const target = node.arguments[0];
      if (target && ts.isStringLiteralLikeNode(target)) specifiers.push(target.text);
      else
        nonStaticLoads.push(
          `${path}: ${node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require'}(...)`,
        );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { specifiers, nonStaticLoads, forbiddenLoaderCapabilities };
}

function isGetBuiltinModuleAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'getBuiltinModule';
  if (ts.isElementAccessExpression(node)) {
    return Boolean(
      node.argumentExpression &&
        ts.isStringLiteralLikeNode(node.argumentExpression) &&
        node.argumentExpression.text === 'getBuiltinModule',
    );
  }
  return ts.isIdentifier(node) && node.text === 'getBuiltinModule';
}

function sourcePathForSpecifier(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

function sourcePathForLocalSpecifier(
  importer: string,
  specifier: string,
  publicEntrypoints: ReadonlyMap<string, string>,
): string | undefined {
  if (isRelativeSpecifier(specifier)) return sourcePathForSpecifier(importer, specifier);
  if (!specifier.startsWith(`${packageName}/`)) return undefined;
  return publicEntrypoints.get(specifier.slice(packageName.length + 1));
}

async function readPublicEntrypoints(): Promise<Map<string, string>> {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    name?: unknown;
    exports?: Record<string, unknown>;
  };
  assert.equal(manifest.name, packageName);
  const entrypoints = new Map<string, string>();
  for (const area of [
    'protocol',
    'client',
    'server',
    nativeBrowserEntrypoint,
    nativeComputerUseEntrypoint,
    nativeOAuthPresentationEntrypoint,
  ]) {
    const target = manifest.exports?.[`./${area}`];
    if (typeof target !== 'string') throw new Error(`missing ${packageName}/${area} export`);
    assert.match(target, /^\.\/dist\/.+\.js$/, `invalid ${packageName}/${area} export target`);
    const sourcePath = resolve(sourceRoot, target.slice('./dist/'.length).replace(/\.js$/, '.ts'));
    assert.ok(
      isInside(sourceRoot, sourcePath),
      `${packageName}/${area} export escapes the package source`,
    );
    entrypoints.set(area, sourcePath);
  }
  return entrypoints;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}
