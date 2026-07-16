import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');
const packageName = '@maka/runtime-host';

test('protocol and client stay within their subpaths and the root-authority boundary', async () => {
  const violations: string[] = [];
  const publicEntrypoints = await readPublicEntrypoints();
  for (const area of ['protocol', 'client'] as const) {
    const entrypoint = publicEntrypoints.get(area);
    assert.ok(entrypoint, `missing public ${area} entrypoint`);
    for (const path of await reachableModules(entrypoint, publicEntrypoints)) {
      const localPath = relative(sourceRoot, path);
      const topLevelArea = localPath.split(sep)[0];
      if (
        localPath === 'candidate-main.ts'
        || topLevelArea === 'server'
        || (area === 'protocol' && topLevelArea !== 'protocol')
      ) {
        violations.push(`${area} reaches ${localPath}`);
      }
      for (const specifier of await moduleSpecifiers(path)) {
        const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
        if (target) {
          if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
          continue;
        }
        if (isRuntimeHostImport(specifier)) violations.push(`${path}: ${specifier}`);
        if (isRuntimeImport(specifier)) violations.push(`${path}: ${specifier}`);
        if (isStorageImport(specifier) && (area === 'protocol' || specifier !== '@maka/storage/root-authority')) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('M1 Host source cannot reach Runtime or bypass package storage boundaries', async () => {
  const violations: string[] = [];
  for (const path of await listTypeScriptFiles(sourceRoot)) {
    if (relative(sourceRoot, path).split(sep)[0] === '__tests__') continue;
    for (const specifier of await moduleSpecifiers(path)) {
      if (isRelativeSpecifier(specifier)) {
        const target = sourcePathForSpecifier(path, specifier);
        if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
        continue;
      }
      if (isRuntimeImport(specifier)) violations.push(`${path}: ${specifier}`);
      if (isStorageImport(specifier) && specifier !== '@maka/storage/root-authority') {
        violations.push(`${path}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

async function reachableModules(
  entrypoint: string,
  publicEntrypoints: ReadonlyMap<string, string>,
): Promise<string[]> {
  const seen = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of await moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (!target) continue;
      if (isInside(sourceRoot, target)) await visit(target);
    }
  };
  await visit(entrypoint);
  return [...seen];
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

async function moduleSpecifiers(path: string): Promise<string[]> {
  const source = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        specifiers.push(node.arguments[0].text);
      }
    }
    if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
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
  for (const area of ['protocol', 'client', 'server']) {
    const target = manifest.exports?.[`./${area}`];
    if (typeof target !== 'string') throw new Error(`missing ${packageName}/${area} export`);
    assert.match(target, /^\.\/dist\/.+\.js$/, `invalid ${packageName}/${area} export target`);
    const sourcePath = resolve(sourceRoot, target.slice('./dist/'.length).replace(/\.js$/, '.ts'));
    assert.ok(isInside(sourceRoot, sourcePath), `${packageName}/${area} export escapes the package source`);
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

function isRuntimeImport(specifier: string): boolean {
  return specifier === '@maka/runtime' || specifier.startsWith('@maka/runtime/');
}

function isRuntimeHostImport(specifier: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isStorageImport(specifier: string): boolean {
  return specifier === '@maka/storage' || specifier.startsWith('@maka/storage/');
}
