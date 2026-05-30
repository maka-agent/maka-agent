import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime';

export const EXPLORE_AGENT_TOOL_NAME = 'ExploreAgent';

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_MATCHES = 60;
const MAX_ROOTS = 5;
const MAX_QUERIES = 8;
const MAX_DISCOVERED_FILES = 250;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MATCH_CONTEXT_CHARS = 220;

const PROJECT_MANIFEST_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'vite.config.ts',
  'vite.config.js',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Package.swift',
]);

const DOCUMENTATION_FILES = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
]);

const ENTRYPOINT_NAMES = new Set([
  'main.ts',
  'main.tsx',
  'main.js',
  'main.jsx',
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'server.ts',
  'server.js',
  'app.ts',
  'app.tsx',
  'app.js',
  'app.jsx',
]);

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
  '.cache',
  '.svelte-kit',
  'DerivedData',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.lock',
  '.log',
  '.mjs',
  '.md',
  '.mdx',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const SENSITIVE_TEXT_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

export interface ExploreAgentResult {
  kind: 'explore_agent';
  ok: boolean;
  mode: 'read_only';
  objective: string;
  roots: string[];
  queries: string[];
  filesInspected: number;
  filesSkipped: number;
  sensitiveFilesSkipped: number;
  bytesRead: number;
  progress: string[];
  evidence: Array<{ type: 'match' | 'candidate'; path: string; line?: number; label: string; score?: number }>;
  candidateFiles: Array<{ path: string; score: number; reasons: string[] }>;
  matches: Array<{ path: string; line: number; query: string; snippet: string }>;
  notes: string[];
  reason?: 'invalid_objective' | 'invalid_root' | 'no_readable_roots';
  message?: string;
}

export function buildExploreAgentTool(): MakaTool<
  {
    objective: string;
    roots?: string[];
    queries?: string[];
    maxFiles?: number;
    maxMatches?: number;
  },
  ExploreAgentResult
> {
  return {
    name: EXPLORE_AGENT_TOOL_NAME,
    displayName: '只读探索',
    description:
      'Run a bounded read-only local exploration worker for a self-contained research question. ' +
      'It inspects filenames and text snippets under the session cwd only, returns candidate files and source-grounded matches, ' +
      'and never writes files, starts services, installs packages, or uses the network. Use it when a separate investigation saves main-thread work.',
    parameters: z.object({
      objective: z.string().min(4).max(600).describe('Specific research objective for the read-only worker.'),
      roots: z.array(z.string().min(1).max(240)).max(MAX_ROOTS).optional()
        .describe('Optional relative roots under the session cwd. Defaults to the session cwd.'),
      queries: z.array(z.string().min(1).max(120)).max(MAX_QUERIES).optional()
        .describe('Optional search terms. If omitted, terms are derived from the objective.'),
      maxFiles: z.number().int().min(1).max(80).optional(),
      maxMatches: z.number().int().min(1).max(120).optional(),
    }),
    permissionRequired: true,
    categoryHint: 'subagent',
    impl: async ({ objective, roots, queries, maxFiles, maxMatches }, { cwd, emitOutput }) => {
      return runReadOnlyExplore({
        cwd,
        objective,
        roots,
        queries,
        maxFiles,
        maxMatches,
        onProgress: (message) => emitOutput('stdout', `${message}\n`),
      });
    },
  };
}

export async function runReadOnlyExplore(input: {
  cwd: string;
  objective: string;
  roots?: string[];
  queries?: string[];
  maxFiles?: number;
  maxMatches?: number;
  onProgress?: (message: string) => void;
}): Promise<ExploreAgentResult> {
  const objective = normalizeText(input.objective).slice(0, 600);
  if (objective.length < 4) {
    return failure('invalid_objective', objective, [], [], '只读探索需要一个明确的研究目标。');
  }

  const workspaceRoot = await realpath(input.cwd);
  const roots = normalizeRoots(input.roots);
  const queryTerms = normalizeQueries(input.queries, objective);
  const maxFiles = clampInteger(input.maxFiles, 1, 80, DEFAULT_MAX_FILES);
  const maxMatches = clampInteger(input.maxMatches, 1, 120, DEFAULT_MAX_MATCHES);
  const discoveryBudget = Math.min(MAX_DISCOVERED_FILES, Math.max(maxFiles * 4, maxFiles));
  const progress = createProgressReporter(input.onProgress);
  progress.report(`只读探索：准备范围（${roots.length} 个 root，${queryTerms.length} 个查询词）`);

  const resolvedRoots: Array<{ abs: string; rel: string }> = [];
  for (const root of roots) {
    const resolved = resolve(workspaceRoot, root);
    if (!isInside(workspaceRoot, resolved)) {
      return failure('invalid_root', objective, roots, queryTerms, `root 必须位于会话工作目录内：${root}`, progress.messages);
    }
    try {
      const actual = await realpath(resolved);
      if (!isInside(workspaceRoot, actual)) {
        return failure('invalid_root', objective, roots, queryTerms, `root 不能穿过符号链接离开工作目录：${root}`, progress.messages);
      }
      const rootStat = await stat(actual);
      if (!rootStat.isDirectory() && !rootStat.isFile()) continue;
      resolvedRoots.push({ abs: actual, rel: toRelative(workspaceRoot, actual) });
    } catch {
      // Missing roots are reported through notes instead of failing the whole worker.
    }
  }
  if (resolvedRoots.length === 0) {
    return failure('no_readable_roots', objective, roots, queryTerms, '没有可读取的研究范围。', progress.messages);
  }
  progress.report(`只读探索：确认 ${resolvedRoots.length} 个可读范围：${resolvedRoots.map((root) => root.rel).join(', ')}`);

  const files: string[] = [];
  const notes: string[] = [
    '只读探索边界：不写文件、不联网、不启动进程。',
    `搜索预算：最多读取 ${maxFiles} 个文件、返回 ${maxMatches} 处命中、读取 ${Math.round(MAX_TOTAL_BYTES / 1024)} KiB 文本。`,
  ];
  let filesSkipped = 0;
  let sensitiveFilesSkipped = 0;
  for (const root of resolvedRoots) {
    const before = files.length;
    const skippedBefore = filesSkipped;
    const sensitiveBefore = sensitiveFilesSkipped;
    const listed = await listTextFiles(root.abs, workspaceRoot, discoveryBudget - files.length);
    files.push(...listed.files);
    filesSkipped += listed.skipped;
    sensitiveFilesSkipped += listed.sensitiveSkipped;
    if (listed.truncated) notes.push(`范围 ${root.rel} 已到达候选文件预算，后续文件未继续扫描。`);
    if (files.length === before) notes.push(`范围 ${root.rel} 在预算内没有可读取文本文件。`);
    const found = files.length - before;
    const skipped = filesSkipped - skippedBefore;
    const sensitive = sensitiveFilesSkipped - sensitiveBefore;
    progress.report(`只读探索：扫描 ${root.rel}，找到 ${found} 个文本候选，跳过 ${skipped} 项${sensitive > 0 ? `（含 ${sensitive} 个敏感文件）` : ''}`);
    if (files.length >= discoveryBudget) break;
  }
  files.sort((left, right) => {
    const leftRel = toRelative(workspaceRoot, left);
    const rightRel = toRelative(workspaceRoot, right);
    const leftScore = scorePath(leftRel, queryTerms).score;
    const rightScore = scorePath(rightRel, queryTerms).score;
    return rightScore - leftScore || leftRel.localeCompare(rightRel);
  });
  if (files.some((file) => scorePath(toRelative(workspaceRoot, file), queryTerms).reasons.some((reason) => reason.startsWith('project ')))) {
    notes.push('广泛研究会优先读取项目配置、文档、入口和测试线索。');
  }
  const filesToInspect = files.slice(0, maxFiles);
  if (files.length > filesToInspect.length) notes.push(`已发现 ${files.length} 个文本候选；按查询命中和项目结构分读取前 ${filesToInspect.length} 个。`);

  const candidates = new Map<string, { path: string; score: number; reasons: Set<string> }>();
  const matches: ExploreAgentResult['matches'] = [];
  let bytesRead = 0;
  let inspected = 0;

  progress.report(`只读探索：开始读取 ${filesToInspect.length} 个候选文件`);
  for (const file of filesToInspect) {
    const rel = toRelative(workspaceRoot, file);
    const filenameScore = scorePath(rel, queryTerms);
    if (filenameScore.score > 0) {
      candidates.set(rel, {
        path: rel,
        score: filenameScore.score,
        reasons: new Set(filenameScore.reasons),
      });
    }

    let fileStat;
    try {
      fileStat = await stat(file);
    } catch {
      filesSkipped++;
      continue;
    }
    if (fileStat.size > MAX_FILE_BYTES || bytesRead >= MAX_TOTAL_BYTES) {
      filesSkipped++;
      continue;
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      filesSkipped++;
      continue;
    }
    if (looksBinary(text)) {
      filesSkipped++;
      continue;
    }
    inspected++;
    bytesRead += Buffer.byteLength(text, 'utf8');
    const fileMatches = findMatches(rel, text, queryTerms, maxMatches - matches.length);
    if (fileMatches.length > 0) {
      matches.push(...fileMatches);
      const current = candidates.get(rel) ?? { path: rel, score: 0, reasons: new Set<string>() };
      current.score += fileMatches.length * 3;
      current.reasons.add('content match');
      candidates.set(rel, current);
    }
    if (matches.length >= maxMatches || bytesRead >= MAX_TOTAL_BYTES) break;
    if (inspected > 0 && inspected % 10 === 0) {
      progress.report(`只读探索：已读取 ${inspected} 个文件，命中 ${matches.length} 处`);
    }
  }

  const candidateFiles = Array.from(candidates.values())
    .map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      reasons: Array.from(candidate.reasons).sort(),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 20);

  const evidence = buildEvidenceAnchors(matches, candidateFiles);
  if (matches.length === 0) notes.push('没有找到内容命中；候选文件可作为下一步阅读清单。');
  if (sensitiveFilesSkipped > 0) notes.push(`已跳过 ${sensitiveFilesSkipped} 个疑似本地凭据/密钥文件，只报告数量不读取内容。`);
  if (bytesRead >= MAX_TOTAL_BYTES) notes.push('总读取预算已用尽，部分候选文件未继续读取。');
  progress.report(`只读探索：完成，读取 ${inspected} 个文件，命中 ${matches.length} 处，候选 ${candidateFiles.length} 个`);

  return {
    kind: 'explore_agent',
    ok: true,
    mode: 'read_only',
    objective,
    roots: resolvedRoots.map((root) => root.rel),
    queries: queryTerms,
    filesInspected: inspected,
    filesSkipped,
    sensitiveFilesSkipped,
    bytesRead,
    progress: progress.messages,
    evidence,
    candidateFiles,
    matches,
    notes,
  };
}

function createProgressReporter(onProgress: ((message: string) => void) | undefined): {
  messages: string[];
  report(message: string): void;
} {
  let emitted = 0;
  const messages: string[] = [];
  return {
    messages,
    report(message) {
      if (emitted >= 12) return;
      emitted++;
      messages.push(message);
      onProgress?.(message);
    },
  };
}

async function listTextFiles(root: string, workspaceRoot: string, budget: number): Promise<{
  files: string[];
  skipped: number;
  sensitiveSkipped: number;
  truncated: boolean;
}> {
  const files: string[] = [];
  let skipped = 0;
  let sensitiveSkipped = 0;
  let truncated = false;

  async function walk(abs: string): Promise<void> {
    if (files.length >= budget) {
      truncated = true;
      return;
    }
    let entryStat;
    try {
      entryStat = await lstat(abs);
    } catch {
      skipped++;
      return;
    }
    if (entryStat.isSymbolicLink()) {
      skipped++;
      return;
    }
    if (entryStat.isFile()) {
      if (isSensitiveTextFile(abs)) {
        skipped++;
        sensitiveSkipped++;
      } else if (isLikelyTextFile(abs)) {
        files.push(abs);
      } else {
        skipped++;
      }
      return;
    }
    if (!entryStat.isDirectory()) {
      skipped++;
      return;
    }
    if (abs !== root && shouldSkipDir(abs)) {
      skipped++;
      return;
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= budget) {
        truncated = true;
        return;
      }
      const child = join(abs, entry.name);
      if (!isInside(workspaceRoot, child)) {
        skipped++;
        continue;
      }
      await walk(child);
    }
  }

  await walk(root);
  return { files, skipped, sensitiveSkipped, truncated };
}

function normalizeRoots(roots: string[] | undefined): string[] {
  const normalized = (roots && roots.length > 0 ? roots : ['.'])
    .map((root) => root.trim())
    .filter(Boolean)
    .slice(0, MAX_ROOTS);
  return normalized.length > 0 ? normalized : ['.'];
}

function normalizeQueries(queries: string[] | undefined, objective: string): string[] {
  const explicit = (queries ?? []).map(normalizeText).filter((query) => query.length > 0);
  const source = explicit.length > 0 ? explicit : deriveQueries(objective);
  return Array.from(new Set(source.map((query) => query.slice(0, 120)))).slice(0, MAX_QUERIES);
}

function deriveQueries(objective: string): string[] {
  const words = objective
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase()));
  return words.length > 0 ? words.slice(0, MAX_QUERIES) : [objective.slice(0, 80)];
}

const COMMON_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'project',
  'research',
  'please',
]);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function shouldSkipDir(abs: string): boolean {
  return IGNORED_DIRS.has(basename(abs));
}

function isLikelyTextFile(abs: string): boolean {
  return TEXT_EXTENSIONS.has(extname(abs).toLowerCase());
}

function isSensitiveTextFile(abs: string): boolean {
  const base = basename(abs).toLowerCase();
  if (SENSITIVE_TEXT_FILE_NAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(base)) return true;
  return false;
}

function scorePath(path: string, queries: string[]): { score: number; reasons: string[] } {
  const lowerPath = path.toLowerCase();
  const base = basename(path);
  const lowerBase = base.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (PROJECT_MANIFEST_FILES.has(base)) {
    score += 12;
    reasons.push('project manifest');
  }
  if (DOCUMENTATION_FILES.has(base)) {
    score += 10;
    reasons.push('project documentation');
  }
  if (ENTRYPOINT_NAMES.has(lowerBase)) {
    score += 8;
    reasons.push('project entrypoint');
  }
  if (/\b(__tests__|tests?|specs?|e2e)\b/i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)) {
    score += 6;
    reasons.push('project test surface');
  }
  if (/\b(src|app|packages|apps)\b/i.test(path)) {
    score += 2;
    reasons.push('project source surface');
  }
  for (const query of queries) {
    const lowerQuery = query.toLowerCase();
    if (lowerPath.includes(lowerQuery)) {
      score += 5;
      reasons.push(`path contains "${query}"`);
    }
  }
  return { score, reasons };
}

function findMatches(path: string, text: string, queries: string[], remaining: number): ExploreAgentResult['matches'] {
  if (remaining <= 0) return [];
  const matches: ExploreAgentResult['matches'] = [];
  const lines = text.split(/\r?\n/);
  const lowerQueries = queries.map((query) => ({ raw: query, lower: query.toLowerCase() }));
  for (let index = 0; index < lines.length; index++) {
    const lowerLine = lines[index]!.toLowerCase();
    const query = lowerQueries.find((item) => lowerLine.includes(item.lower));
    if (!query) continue;
    matches.push({
      path,
      line: index + 1,
      query: query.raw,
      snippet: capSnippet(lines[index]!),
    });
    if (matches.length >= remaining) break;
  }
  return matches;
}

function buildEvidenceAnchors(
  matches: ExploreAgentResult['matches'],
  candidateFiles: ExploreAgentResult['candidateFiles'],
): ExploreAgentResult['evidence'] {
  const anchors: ExploreAgentResult['evidence'] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    if (anchors.length >= 10) break;
    const key = `${match.path}:${match.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      type: 'match',
      path: match.path,
      line: match.line,
      label: `内容命中：${match.query}`,
    });
  }

  for (const candidate of candidateFiles) {
    if (anchors.length >= 10) break;
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    anchors.push({
      type: 'candidate',
      path: candidate.path,
      label: evidenceLabelForCandidate(candidate.reasons),
      score: candidate.score,
    });
  }

  return anchors;
}

function evidenceLabelForCandidate(reasons: string[]): string {
  if (reasons.includes('project manifest')) return '项目配置锚点';
  if (reasons.includes('project documentation')) return '项目文档锚点';
  if (reasons.includes('project entrypoint')) return '入口文件锚点';
  if (reasons.includes('project test surface')) return '测试线索锚点';
  if (reasons.includes('project source surface')) return '源码线索锚点';
  if (reasons.includes('content match')) return '内容命中锚点';
  return '候选阅读锚点';
}

function capSnippet(line: string): string {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MATCH_CONTEXT_CHARS).join('');
}

function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function failure(
  reason: NonNullable<ExploreAgentResult['reason']>,
  objective: string,
  roots: string[],
  queries: string[],
  message: string,
  progress: string[] = [],
): ExploreAgentResult {
  return {
    kind: 'explore_agent',
    ok: false,
    mode: 'read_only',
    objective,
    roots,
    queries,
    filesInspected: 0,
    filesSkipped: 0,
    sensitiveFilesSkipped: 0,
    bytesRead: 0,
    progress,
    evidence: [],
    candidateFiles: [],
    matches: [],
    notes: ['只读探索边界：不写文件、不联网、不启动进程。'],
    reason,
    message,
  };
}
