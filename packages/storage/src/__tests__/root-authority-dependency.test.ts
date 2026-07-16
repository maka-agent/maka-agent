import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');
const authorityEntrypoint = join(sourceRoot, 'root-authority.ts');

test('root authority cannot transitively reach domain Stores or Runtime composition', async () => {
  const violations: string[] = [];
  for (const path of await reachableModules(authorityEntrypoint)) {
    const localPath = relative(sourceRoot, path);
    if (localPath !== 'root-authority.ts' && !localPath.startsWith(`root-authority${sep}`)) {
      violations.push(`root authority reaches ${localPath}`);
    }
    for (const specifier of await moduleSpecifiers(path)) {
      if (isRelativeSpecifier(specifier)) {
        const target = sourcePathForSpecifier(path, specifier);
        if (!isInside(sourceRoot, target)) violations.push(`${localPath}: ${specifier}`);
        continue;
      }
      if (specifier.startsWith('node:') || specifier === 'fs-native-extensions') continue;
      violations.push(`${localPath}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

async function reachableModules(entrypoint: string): Promise<string[]> {
  const seen = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of await moduleSpecifiers(path)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const target = sourcePathForSpecifier(path, specifier);
      if (isInside(sourceRoot, target)) await visit(target);
    }
  };
  await visit(entrypoint);
  return [...seen];
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

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}
