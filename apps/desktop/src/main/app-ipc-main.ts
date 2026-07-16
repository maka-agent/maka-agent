import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { arch as osArch, release as osRelease } from 'node:os';
import { app, ipcMain, shell } from 'electron';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime';
import type { createMainWindowController } from './main-window.js';
import type { ProjectRootController } from './project-root-controller.js';
import { resolveOpenPath, type OpenPathResult } from './open-path-guard.js';
import { getVisualSmokeState, type resolveVisualSmokeFixture } from './visual-smoke-fixture.js';
import type { resolveBuildInfo } from './build-info.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;
type VisualSmokeFixture = ReturnType<typeof resolveVisualSmokeFixture>;
type BuildInfo = ReturnType<typeof resolveBuildInfo>;

export interface AppIpcDeps {
  mainWindowController: MainWindowController;
  projectRoot: ProjectRootController;
  getSessionProjectRoot(sessionId: string): Promise<string>;
  getProjectRoot(sessionId: unknown): Promise<string>;
  workspaceRoot: string;
  buildInfo: BuildInfo;
  visualSmokeFixture: VisualSmokeFixture;
}

/**
 * Sanitize a single path segment for use under `screenshots/`. Allows
 * only `[a-zA-Z0-9._-]`; rejects everything else (slashes, `..`, NUL,
 * UTF-8 letters). Returns null when the input is empty after sanitization
 * so the capture IPC can fail-closed rather than write to an attacker-
 * controlled relative path.
 */
function sanitizeSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

export function registerAppIpc(deps: AppIpcDeps): void {
  const { mainWindowController, projectRoot, workspaceRoot, buildInfo, visualSmokeFixture } = deps;
  // Call-time read of the shared project-root authority: every handler must
  // observe the latest selection, not a snapshot taken at registration.
  const currentProjectRoot = (): Promise<string> => projectRoot.current();

  ipcMain.handle('window:setTitlebarControlsVisible', (event, visible: unknown): void => {
    mainWindowController.setTitlebarControlsVisible(event.sender, visible);
  });
  // PR-SHOW-AFTER-FIRST-COMMIT: the renderer signals its first React commit so
  // the hidden window (main-window.ts show: false) is revealed only once real
  // content can paint. Idempotent + visual-smoke-safe inside the controller.
  ipcMain.handle('window:notifyRendererReady', (): void => {
    mainWindowController.notifyRendererReady();
  });
  ipcMain.handle('window:setThemeSource', (event, themePref: unknown): void => {
    mainWindowController.setThemeSource(event.sender, themePref);
  });
  // PR-WINDOW-TITLEBAR-0: re-sync the native titleBarOverlay color when the
  // renderer resolves a new light/dark mode or palette. No-op outside Windows.
  ipcMain.handle('window:setTitleBarOverlayTheme', (event, theme: unknown): void => {
    mainWindowController.setTitleBarOverlayTheme(event.sender, theme);
  });
  ipcMain.handle('app:info', async () => {
    const projectPath = await currentProjectRoot();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      platform: process.platform,
      arch: osArch(),
      osRelease: osRelease(),
      workspacePath: workspaceRoot,
      projectPath,
      projectGit: await resolveProjectGitInfo(projectPath),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
    };
  });
  ipcMain.handle('app:sessionProjectInfo', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Invalid project-context session id.');
    }
    const projectPath = await deps.getSessionProjectRoot(sessionId);
    return {
      projectPath,
      projectGit: await resolveProjectGitInfo(projectPath),
    };
  });
  ipcMain.handle('app:openPath', async (_event, key: string, sessionId: unknown): Promise<OpenPathResult> => {
    const projectPath = key === 'project'
      ? await deps.getProjectRoot(sessionId)
      : await currentProjectRoot();
    const resolved = await resolveOpenPath({ key, workspaceRoot, projectRoot: projectPath });
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open-failed' };
    return { ok: true, opened: resolved.key };
  });
  ipcMain.handle(
    'app:selectProjectDirectory',
    async (): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'cancelled' | 'missing-selection' }
    > => {
      const result = await mainWindowController.showOpenDialog({
        title: '选择工作目录',
        properties: ['openDirectory'],
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled) return { ok: false, reason: 'cancelled' };
      if (!selectedPath) return { ok: false, reason: 'missing-selection' };
      const projectPath = await resolveProjectRoot([selectedPath]);
      projectRoot.setSelected(projectPath);
      return {
        ok: true,
        projectPath,
        projectGit: await resolveProjectGitInfo(projectPath),
      };
    },
  );
  ipcMain.handle(
    'app:selectProjectRoot',
    async (_event, projectPath: unknown): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > => {
      const explicitRoot = await projectRoot.resolveExplicit(projectPath);
      if (!explicitRoot.ok) return explicitRoot;
      const resolved = explicitRoot.projectPath;
      projectRoot.setSelected(resolved);
      return {
        ok: true,
        projectPath: resolved,
        projectGit: await resolveProjectGitInfo(resolved),
      };
    },
  );
  ipcMain.handle(
    'app:resolveProjectGitInfo',
    async (
      _event,
      projectPath: unknown,
    ): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > => {
      if (projectPath !== undefined) {
        const explicitRoot = await projectRoot.resolveExplicit(projectPath);
        if (!explicitRoot.ok) return explicitRoot;
        const resolved = explicitRoot.projectPath;
        return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
      }
      const resolved = await currentProjectRoot();
      return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
    },
  );
  ipcMain.handle('visualSmoke:getState', () => getVisualSmokeState(visualSmokeFixture));
  /**
   * PR-IR-01 screenshot capture (dev/test-only).
   *
   * Available only when `MAKA_VISUAL_SMOKE_FIXTURE` is set — refuses
   * otherwise so real users / packaged builds can't be coerced into
   * dumping the renderer to disk. The capture script
   * (`scripts/capture-screenshots.mjs`) drives this IPC after the
   * fixture finishes settling.
   *
   * Returns the absolute path of the written file or a structured
   * failure reason. The renderer never sees absolute paths (per the
   * filesystem-boundary contract); the script reads the result back
   * over IPC because it owns the screenshot directory.
   */
  ipcMain.handle(
    'visualSmoke:capture',
    async (
      _event,
      input: { scenario: string; variant: string },
    ): Promise<
      | { ok: true; path: string }
      | { ok: false; reason: 'not_in_fixture_mode' | 'invalid_input' | 'capture_failed' | 'write_failed' }
    > => {
      if (!visualSmokeFixture) return { ok: false, reason: 'not_in_fixture_mode' };
      const scenario = sanitizeSegment(input?.scenario);
      const variant = sanitizeSegment(input?.variant);
      if (!scenario || !variant) return { ok: false, reason: 'invalid_input' };
      let image: Electron.NativeImage;
      try {
        const capture = await mainWindowController.capturePage();
        if (!capture) return { ok: false, reason: 'capture_failed' };
        image = capture;
      } catch {
        return { ok: false, reason: 'capture_failed' };
      }
      const dir = join(workspaceRoot, 'screenshots', scenario);
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
      const filePath = join(dir, `${variant}.png`);
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(filePath, image.toPNG());
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
      // Deterministic stdout marker so the driver script
      // (`scripts/capture-screenshots.mjs`) can match on the line and
      // know the capture completed without polling the filesystem.
      // The line is single-token whitespace-separated so it's easy to
      // parse by regex.
      console.log(`[visual-smoke] captured scenario=${scenario} variant=${variant} path=${filePath}`);
      return { ok: true, path: filePath };
    },
  );
}
