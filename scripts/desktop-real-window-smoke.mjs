#!/usr/bin/env node
/**
 * PR-DESKTOP-SMOKE-0: real Electron window smoke runner.
 *
 * This is intentionally a human-in-the-loop gate. Visual smoke screenshots
 * cannot verify native macOS resize hit areas, titlebar drag, or keyboard
 * traversal through a live Electron window. This script launches a clean,
 * isolated Maka window and records the reviewer-confirmed result as JSON +
 * Markdown under `apps/desktop/tests/real-window-smoke/`.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const REPORT_DIR = join(DESKTOP_DIR, 'tests', 'real-window-smoke');
const DEFAULT_SCENARIO = 'sidebar-search-modal-open';
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 840;

export const REAL_WINDOW_SMOKE_CHECKS = [
  {
    id: 'launch-clean-window',
    prompt: 'The app launches a real Electron window from a clean smoke user-data dir, with no ErrorBoundary/crash screen.',
  },
  {
    id: 'resize-left-edge',
    prompt: 'Dragging the left window edge resizes the window.',
  },
  {
    id: 'resize-right-edge',
    prompt: 'Dragging the right window edge resizes the window.',
  },
  {
    id: 'resize-top-edge',
    prompt: 'Dragging the top window edge resizes the window.',
  },
  {
    id: 'resize-bottom-edge',
    prompt: 'Dragging the bottom window edge resizes the window.',
  },
  {
    id: 'resize-corners',
    prompt: 'Dragging all four corners resizes diagonally.',
  },
  {
    id: 'titlebar-drag',
    prompt: 'Dragging an allowed titlebar/blank header region moves the window.',
  },
  {
    id: 'controls-no-drag',
    prompt: 'Sidebar rows, buttons, inputs, and modal controls do not drag the window.',
  },
  {
    id: 'search-modal-cycle',
    prompt: 'Search modal opens and closes with the close button, backdrop, and Escape.',
  },
  {
    id: 'keyboard-path',
    prompt: 'Tab/Shift+Tab stays inside the active modal, Enter activates focused controls, and Escape returns focus to the trigger.',
  },
  {
    id: 'modal-resize-hit-area',
    prompt: 'With Search modal open, window edges/corners still resize.',
  },
  {
    id: 'renderer-health',
    prompt: 'After closing the modal and switching sidebar modules, no ErrorBoundary or React hook error appears.',
  },
];

function parseArgs(argv) {
  const args = {
    scenario: DEFAULT_SCENARIO,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    noLaunch: false,
    cleanupStale: true,
    assumeYes: false,
    failNote: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--width') args.width = Number(argv[++i]);
    else if (arg === '--height') args.height = Number(argv[++i]);
    else if (arg === '--no-launch') args.noLaunch = true;
    else if (arg === '--no-cleanup-stale') args.cleanupStale = false;
    else if (arg === '--yes') args.assumeYes = true;
    else if (arg === '--fail-note') args.failNote = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`[real-window-smoke] unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: desktop-real-window-smoke.mjs [--scenario name] [--width n] [--height n] [--no-launch] [--no-cleanup-stale] [--fail-note text]

Launches a real Electron window with an isolated smoke workspace, then prompts
the reviewer to confirm native desktop behavior that screenshots cannot prove.

Default scenario: ${DEFAULT_SCENARIO}
Report dir: ${relative(REPO_ROOT, REPORT_DIR)}
`);
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

function parsePsOutput(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
}

function isStaleMakaElectronProcess(entry) {
  if (!entry || entry.pid === process.pid) return false;
  const command = entry.command;
  if (!command.includes('Electron.app/Contents/MacOS/Electron')) return false;
  if (!command.includes('--user-data-dir=')) return false;
  return /--user-data-dir=(?:\/private)?\/tmp\/maka-(?:visual-smoke|real-window-smoke|p0fix|uxp|v\d|copy|long|modal|narr|test-cap-debug)/.test(command) ||
    /--user-data-dir=(?:\/private)?\/var\/folders\/.+\/maka-real-window-smoke-/.test(command);
}

async function listElectronRootProcesses() {
  const result = await execFileText('ps', ['-axo', 'pid,ppid,command']);
  if (!result.ok) return [];
  return parsePsOutput(result.stdout).filter((entry) =>
    entry.command.includes('Electron.app/Contents/MacOS/Electron'),
  );
}

async function cleanupStaleElectronProcesses(enabled) {
  if (!enabled) return [];
  const stale = (await listElectronRootProcesses()).filter(isStaleMakaElectronProcess);
  if (stale.length === 0) return [];
  console.log(`[real-window-smoke] cleaning ${stale.length} stale Maka Electron process(es): ${stale.map((entry) => entry.pid).join(', ')}`);
  await Promise.all(stale.map((entry) => execFileText('kill', [String(entry.pid)])));
  await new Promise((resolve) => setTimeout(resolve, 750));
  const survivors = (await listElectronRootProcesses()).filter((entry) =>
    stale.some((staleEntry) => staleEntry.pid === entry.pid),
  );
  if (survivors.length > 0) {
    console.log(`[real-window-smoke] SIGKILL stale survivor(s): ${survivors.map((entry) => entry.pid).join(', ')}`);
    await Promise.all(survivors.map((entry) => execFileText('kill', ['-9', String(entry.pid)])));
  }
  return stale.map(({ pid, ppid, command }) => ({ pid, ppid, command }));
}

async function ensureRepoRoot() {
  const pkg = join(REPO_ROOT, 'package.json');
  if (!existsSync(pkg)) {
    console.error(`[real-window-smoke] cannot locate repo root (no package.json at ${pkg})`);
    process.exit(2);
  }
  const root = JSON.parse(await readFile(pkg, 'utf8'));
  if (!root.workspaces || !Array.isArray(root.workspaces)) {
    console.error('[real-window-smoke] expected npm workspaces root; aborting.');
    process.exit(2);
  }
}

async function resolveElectronBin() {
  const electronModule = join(REPO_ROOT, 'node_modules', 'electron');
  if (!existsSync(electronModule)) {
    console.error('[real-window-smoke] electron not installed; run `npm install` first.');
    process.exit(2);
  }
  try {
    const exportPath = (await import('electron')).default;
    if (typeof exportPath === 'string') return exportPath;
  } catch (err) {
    console.error('[real-window-smoke] failed to resolve electron:', err);
    process.exit(2);
  }
  console.error('[real-window-smoke] electron resolved to a non-string path.');
  process.exit(2);
}

async function launchElectron(args, diagnostics) {
  if (args.noLaunch) return null;
  const electronBin = await resolveElectronBin();
  const userDataDir = join(
    os.tmpdir(),
    `maka-real-window-smoke-${args.scenario}-${process.pid}`,
  );
  const env = {
    ...process.env,
    MAKA_VISUAL_SMOKE_FIXTURE: args.scenario,
    MAKA_VISUAL_SMOKE_WIDTH: String(args.width),
    MAKA_VISUAL_SMOKE_HEIGHT: String(args.height),
    MAKA_REAL_WINDOW_SMOKE: '1',
  };
  const launchArgs = ['.', `--user-data-dir=${userDataDir}`];
  const child = spawn(electronBin, launchArgs, {
    cwd: DESKTOP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launchCommand = `${electronBin} ${launchArgs.join(' ')}`;
  diagnostics.launch = {
    command: launchCommand,
    cwd: DESKTOP_DIR,
    electronPid: child.pid ?? null,
    userDataDir,
  };
  console.log(`[real-window-smoke] launched Electron pid=${child.pid ?? 'unknown'} userDataDir=${userDataDir}`);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code, signal) => {
    if (code !== null) console.log(`[real-window-smoke] Electron exited with code ${code}`);
    else if (signal) console.log(`[real-window-smoke] Electron exited via ${signal}`);
  });
  return { child, userDataDir, command: launchCommand, electronPid: child.pid ?? null };
}

async function promptChecks(args) {
  if (args.failNote !== null) {
    const note = args.failNote.trim() || 'real-window smoke was explicitly marked as failed by the reviewer';
    return REAL_WINDOW_SMOKE_CHECKS.map((check) => ({ ...check, ok: false, note }));
  }
  const rl = createInterface({ input, output });
  const results = [];
  try {
    for (const check of REAL_WINDOW_SMOKE_CHECKS) {
      if (args.assumeYes) {
        results.push({ ...check, ok: true, note: 'auto-confirmed by --yes' });
        continue;
      }
      let answer = '';
      while (!/^(y|yes|n|no)$/i.test(answer.trim())) {
        answer = await rl.question(`[real-window-smoke] ${check.prompt} (y/n): `);
      }
      const ok = /^(y|yes)$/i.test(answer.trim());
      let note = '';
      if (!ok) {
        note = await rl.question('[real-window-smoke] Failure note (what failed / where): ');
      }
      results.push({ ...check, ok, note });
    }
  } finally {
    rl.close();
  }
  return results;
}

async function writeReport(args, launchInfo, results, diagnostics) {
  await mkdir(REPORT_DIR, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const git = await readGitHead();
  const ok = results.every((result) => result.ok);
  const report = {
    ok,
    createdAt: now.toISOString(),
    git,
    scenario: args.scenario,
    viewport: { width: args.width, height: args.height },
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    userDataDir: launchInfo?.userDataDir ?? null,
    diagnostics,
    checks: results.map(({ id, prompt, ok: resultOk, note }) => ({ id, prompt, ok: resultOk, note })),
  };
  const jsonPath = join(REPORT_DIR, `${stamp}.json`);
  const mdPath = join(REPORT_DIR, `${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(report));
  console.log(`[real-window-smoke] report: ${relative(REPO_ROOT, mdPath)}`);
  return report;
}

async function readGitHead() {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve) => {
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }, (err, stdout) => {
        resolve(err ? 'unknown' : stdout.trim());
      });
    });
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Maka Real Window Smoke Report',
    '',
    `- Result: ${report.ok ? 'PASS' : 'FAIL'}`,
    `- Created: ${report.createdAt}`,
    `- Git: ${report.git}`,
    `- Scenario: ${report.scenario}`,
    `- Viewport: ${report.viewport.width}x${report.viewport.height}`,
    `- Platform: ${report.platform}`,
    report.userDataDir ? `- User data dir: \`${report.userDataDir}\`` : '- User data dir: not launched by script',
    report.diagnostics?.launch?.electronPid ? `- Electron PID: ${report.diagnostics.launch.electronPid}` : '- Electron PID: not launched by script',
    report.diagnostics?.launch?.command ? `- Launch command: \`${escapeMd(report.diagnostics.launch.command)}\`` : '- Launch command: not launched by script',
    `- Stale Electron processes cleaned: ${report.diagnostics?.staleElectronProcesses?.length ?? 0}`,
    '',
    '| Check | Result | Note |',
    '|---|---|---|',
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.ok ? 'PASS' : 'FAIL'} | ${escapeMd(check.note || check.prompt)} |`);
  }
  if ((report.diagnostics?.staleElectronProcesses?.length ?? 0) > 0) {
    lines.push('', '## Cleaned Stale Electron Processes', '');
    for (const processInfo of report.diagnostics.staleElectronProcesses) {
      lines.push(`- pid=${processInfo.pid} ppid=${processInfo.ppid} command=\`${escapeMd(processInfo.command)}\``);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  await ensureRepoRoot();
  const diagnostics = {
    argv: process.argv.slice(2),
    staleElectronProcesses: await cleanupStaleElectronProcesses(args.cleanupStale),
  };
  console.log('[real-window-smoke] This gate requires a human to test native window behavior.');
  console.log('[real-window-smoke] Build first via `npm --workspace @maka/desktop run smoke:real-window`.');
  console.log(`[real-window-smoke] scenario=${args.scenario} viewport=${args.width}x${args.height}`);
  const launchInfo = await launchElectron(args, diagnostics);
  const results = await promptChecks(args);
  const report = await writeReport(args, launchInfo, results, diagnostics);
  if (launchInfo?.child && !launchInfo.child.killed) {
    launchInfo.child.kill('SIGTERM');
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[real-window-smoke] fatal:', err);
    process.exit(1);
  });
}
