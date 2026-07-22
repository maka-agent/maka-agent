import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = join(process.cwd(), 'src');
const packageRoot = resolve(sourceRoot, '..');
const distRoot = join(packageRoot, 'dist');
const harborRoot = join(packageRoot, 'harbor');
const storageCompositionModule = join(sourceRoot, 'headless-storage.ts');
const taskRunStoreModule = join(sourceRoot, 'task-run-store.ts');
const rawStorageWriterFixture = join(
  sourceRoot,
  '__tests__',
  'fixtures',
  'raw-storage-writer-imports.mjs',
);
const productionJavaScriptModules = listProductionJavaScriptModules(harborRoot);
const rawStorageWriterFactories = [
  'createAgentRunStore',
  'createArtifactStore',
  'createRuntimeEventStore',
  'createSessionStore',
] as const;
const compilerApi = new API({ cwd: process.cwd() });
const projectConfig = join(process.cwd(), 'tsconfig.json');
const compilerSnapshot = compilerApi.updateSnapshot({
  openProjects: [projectConfig],
  openFiles: [...productionJavaScriptModules, rawStorageWriterFixture],
});
const compilerProject = loadCompilerProject();

async function dependencyScannerComputedLoadFixture(target: string): Promise<void> {
  await import(`node:url`);
  await import(target);
  require(target);
}
void dependencyScannerComputedLoadFixture;

function dependencyScannerLoaderCapabilityFixture(): void {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerLoaderCapabilityFixture;

function dependencyScannerRequireAliasFixture(): void {
  const load = require;
  load('@maka/storage');
}
void dependencyScannerRequireAliasFixture;

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error(`TypeScript did not load ${projectConfig}`);
  return project;
}

test('only the Headless storage composition imports production writer factories', async () => {
  const violations: string[] = [];
  const productionModules = [
    ...(await listProductionTypeScriptFiles(sourceRoot)),
    ...productionJavaScriptModules,
  ];
  for (const path of productionModules) {
    const references = moduleReferences(path);
    if (path === storageCompositionModule) continue;
    const localPath = relative(sourceRoot, path);
    for (const reference of references) {
      for (const symbol of forbiddenWriterSymbols(path, reference)) {
        violations.push(`${localPath}: ${reference.specifier} -> ${symbol}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('dependency scanning fails closed on computed loads and loader capabilities', () => {
  const fixturePath = join(sourceRoot, '__tests__', 'headless-storage-dependency.test.ts');
  const scan = scanModuleReferences(fixturePath);
  assert.ok(scan.references.some((reference) => reference.specifier === 'node:url'));
  assert.deepEqual(
    scan.nonStaticLoads.map((load) => load.slice(load.lastIndexOf(': ') + 2)).sort(),
    ['import(...)', 'require(...)'],
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((capability) => /getBuiltinModule/.test(capability)),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((capability) => /createRequire/.test(capability)),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((capability) => /require alias/.test(capability)),
  );
  assert.throws(
    () => moduleReferences(fixturePath),
    /Dependency boundary requires explicit module declarations/,
  );
});

test('dependency scanning identifies the allowlisted writer factory imports', () => {
  const symbols = moduleReferences(storageCompositionModule)
    .flatMap((reference) => forbiddenWriterSymbols(storageCompositionModule, reference))
    .sort();
  assert.deepEqual(symbols, [
    'createArtifactStore',
    'openHeadlessExecutionStoresForWrite',
    'openHeadlessTaskRunWriter',
  ]);
});

test('dependency scanning rejects every raw Storage writer factory', () => {
  const symbols = moduleReferences(rawStorageWriterFixture)
    .flatMap((reference) => forbiddenWriterSymbols(rawStorageWriterFixture, reference))
    .sort();
  assert.deepEqual(symbols, [
    'createAgentRunStore',
    'createRuntimeEventStore',
    'createSessionStore',
  ]);
});

interface ModuleReference {
  specifier: string;
  importedNames: string[] | null;
}

function forbiddenWriterSymbols(importer: string, reference: ModuleReference): string[] {
  const { importedNames, specifier } = reference;
  if (specifier === '@maka/storage') {
    if (importedNames === null) return [...rawStorageWriterFactories];
    return importedNames.filter(isRawStorageWriterFactory);
  }
  if (specifier === '@maka/storage/execution-stores') {
    if (importedNames === null) return ['writer opener'];
    return importedNames.filter(isExecutionStoresWriterOpener);
  }
  if (
    isRelativeSpecifier(specifier) &&
    sourcePathForSpecifier(importer, specifier) === taskRunStoreModule &&
    importsSymbol(importedNames, 'openHeadlessTaskRunWriter')
  ) {
    return ['openHeadlessTaskRunWriter'];
  }
  return [];
}

function isRawStorageWriterFactory(
  symbol: string,
): symbol is (typeof rawStorageWriterFactories)[number] {
  return rawStorageWriterFactories.includes(symbol as (typeof rawStorageWriterFactories)[number]);
}

function importsSymbol(importedNames: readonly string[] | null, symbol: string): boolean {
  return importedNames === null || importedNames.includes(symbol);
}

function isExecutionStoresWriterOpener(symbol: string): boolean {
  return /^open[A-Za-z0-9]*ForWrite$/.test(symbol);
}

async function listProductionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === '__tests__') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listProductionTypeScriptFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function listProductionJavaScriptModules(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listProductionJavaScriptModules(path));
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) files.push(path);
  }
  return files.sort();
}

function moduleReferences(path: string): ModuleReference[] {
  const scan = scanModuleReferences(path);
  const violations = [...scan.nonStaticLoads, ...scan.forbiddenLoaderCapabilities];
  if (violations.length > 0) {
    throw new Error(
      `Dependency boundary requires explicit module declarations:\n${violations.join('\n')}`,
    );
  }
  return scan.references;
}

function scanModuleReferences(path: string): {
  references: ModuleReference[];
  nonStaticLoads: string[];
  forbiddenLoaderCapabilities: string[];
} {
  const source =
    compilerProject.program.getSourceFile(path) ??
    compilerSnapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const references: ModuleReference[] = [];
  const nonStaticLoads: string[] = [];
  const forbiddenLoaderCapabilities = new Set<string>();
  const visit = (node: ts.Node) => {
    const loaderCapability = forbiddenLoaderCapability(node);
    if (loaderCapability) forbiddenLoaderCapabilities.add(`${path}: ${loaderCapability}`);

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        importedNames: importDeclarationNames(node),
      });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        importedNames: exportDeclarationNames(node),
      });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const target = node.moduleReference.expression;
      if (target && ts.isStringLiteralLikeNode(target) && !node.isTypeOnly) {
        references.push({ specifier: target.text, importedNames: null });
      }
    }
    if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const target = node.arguments[0];
      if (target && ts.isStringLiteralLikeNode(target)) {
        references.push({ specifier: target.text, importedNames: null });
      } else {
        nonStaticLoads.push(`${path}: ${moduleLoadName(node)}(...)`);
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({ specifier: node.argument.literal.text, importedNames: [] });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return {
    references,
    nonStaticLoads,
    forbiddenLoaderCapabilities: [...forbiddenLoaderCapabilities],
  };
}

function importDeclarationNames(node: ts.ImportDeclaration): string[] | null {
  const clause = node.importClause;
  if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
  const names: string[] = [];
  if (clause.name) names.push('default');
  if (!clause.namedBindings) return names;
  if (ts.isNamespaceImport(clause.namedBindings)) return null;
  for (const element of clause.namedBindings.elements) {
    if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

function exportDeclarationNames(node: ts.ExportDeclaration): string[] | null {
  if (node.isTypeOnly) return [];
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return null;
  const names: string[] = [];
  for (const element of node.exportClause.elements) {
    if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

function isModuleLoadCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

function moduleLoadName(node: ts.CallExpression): 'import' | 'require' {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require';
}

function forbiddenLoaderCapability(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) && node.text === 'require' && !isDirectRequireCall(node)) {
    return 'require alias';
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'getBuiltinModule') return 'getBuiltinModule';
    if (node.name.text === 'createRequire') return 'createRequire';
  }
  if (ts.isElementAccessExpression(node)) {
    const name = node.argumentExpression;
    if (name && ts.isStringLiteralLikeNode(name)) {
      if (name.text === 'getBuiltinModule') return 'getBuiltinModule';
      if (name.text === 'createRequire') return 'createRequire';
    }
  }
  if (ts.isIdentifier(node) && node.text === 'createRequire') return 'createRequire';
  if (ts.isIdentifier(node) && node.text === 'getBuiltinModule') return 'getBuiltinModule';
  return undefined;
}

function isDirectRequireCall(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function sourcePathForSpecifier(importer: string, specifier: string): string {
  const resolvedTarget = resolve(dirname(importer), specifier);
  const target = resolvedTarget.startsWith(`${distRoot}${sep}`)
    ? join(sourceRoot, relative(distRoot, resolvedTarget))
    : resolvedTarget;
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}
