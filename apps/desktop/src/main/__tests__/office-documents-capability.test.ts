import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readAllRendererCss } from './css-test-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');
const MAIN = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const OFFICE_DOCUMENT_TOOL = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'office-document-tool.ts');
const OFFICECLI_PROBE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'officecli-probe.ts');
const OFFICECLI_ENV = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'officecli-env.ts');
const OFFICECLI_MANIFEST = join(REPO_ROOT, 'apps', 'desktop', 'bundled-tools.json');
const PREPARE_OFFICECLI = join(REPO_ROOT, 'scripts', 'prepare-officecli.mjs');
const CHECK_OFFICECLI_BUNDLE = join(REPO_ROOT, 'scripts', 'check-officecli-bundle.mjs');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const PERMISSION = join(REPO_ROOT, 'packages', 'core', 'src', 'permission.ts');
const CORE_EVENTS = join(REPO_ROOT, 'packages', 'core', 'src', 'events.ts');
const TOOL_RESULT_PREVIEW = join(REPO_ROOT, 'packages', 'ui', 'src', 'tool-activity', 'tool-result-preview.tsx');
const PERMISSION_DIALOG = join(REPO_ROOT, 'packages', 'ui', 'src', 'permission-dialog.tsx');

describe('Office document capability contract', () => {
  it('surfaces Office 文档 as a capability backed by officecli probe', async () => {
    const [snapshot, main] = await Promise.all([
      readFile(CAPABILITY_SNAPSHOT, 'utf8'),
      readFile(MAIN, 'utf8'),
    ]);

    assert.match(snapshot, /officeDocumentsCapability\(input\.officeCliProbe, now\)/);
    assert.match(snapshot, /id:\s*'office_documents'/);
    assert.match(snapshot, /label:\s*'Office 文档'/);
    assert.match(snapshot, /officecli/);
    assert.match(snapshot, /读取、校验与按次授权编辑/);
    assert.match(snapshot, /安装 officecli 后重启 Maka 或刷新能力快照/);
    assert.match(snapshot, /officecli --version/);
    assert.match(snapshot, /等待刷新 OfficeCLI 状态/);
    assert.doesNotMatch(snapshot, /尚未探测 officecli/, 'Office capability no-probe copy should read as a refreshable state, not unfinished implementation');
    const officeCapabilityBlock = snapshot.match(/function officeDocumentsCapability[\s\S]*?function officeCliProbeReason/)?.[0] ?? '';
    assert.match(officeCapabilityBlock, /state:\s*'not_run'/, 'Missing OfficeCLI is a setup warning, not an app-wide runtime error state');
    assert.doesNotMatch(officeCapabilityBlock, /读取与校验。|只读|生成/, 'Office capability copy must not lag behind the permission-gated edit tool');
    assert.match(main, /probeOfficeCli\(\{ now: permissions\.checkedAt \}\)/);
    assert.match(main, /probeOfficeCli\(\{ now \}\)/);
  });

  it('renders capability guidance as visible action copy', async () => {
    const [settings, styles] = await Promise.all([
      readSettingsCombinedSource(),
      readAllRendererCss(),
    ]);

    assert.match(settings, /capability\.guidance\.length > 0/);
    assert.match(settings, /处理建议/);
    assert.match(settings, /OFFICECLI_INSTALL_COMMAND/);
    assert.match(settings, /复制 macOS\/Linux 安装命令/);
    assert.match(settings, /<div className="settingsCapabilityGuidanceActions" role="group" aria-label="Office 文档安装辅助">/);
    assert.doesNotMatch(settings, /<div className="settingsCapabilityGuidanceActions" aria-label="Office 文档安装辅助">/);
    assert.match(settings, /copyingOfficeCliInstallRef\.current/, 'OfficeCLI install copy action must have a ref-backed double-click guard');
    assert.match(settings, /if \(copyingOfficeCliInstallRef\.current\) return;/);
    assert.match(settings, /const capabilityRowMountedRef = useRef\(false\);/);
    assert.match(
      settings,
      /useEffect\(\(\) => \{[\s\S]*capabilityRowMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*capabilityRowMountedRef\.current = false;[\s\S]*copyingOfficeCliInstallRef\.current = false;/,
      'OfficeCLI install copy action must release ownership when its capability row unmounts',
    );
    assert.match(settings, /disabled=\{copyingOfficeCliInstall\}/);
    assert.match(settings, /copyingOfficeCliInstall \? '复制中…' : '复制 macOS\/Linux 安装命令'/);
    assert.match(
      settings,
      /await navigator\.clipboard\.writeText\(OFFICECLI_INSTALL_COMMAND\);[\s\S]*if \(capabilityRowMountedRef\.current\) \{[\s\S]*toast\.success\('已复制安装命令', '在终端执行后点击刷新重新探测。'\);/,
      'OfficeCLI install copy success toast must not fire after the row unmounts',
    );
    assert.match(
      settings,
      /catch \{[\s\S]*if \(capabilityRowMountedRef\.current\) \{[\s\S]*toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\);/,
      'OfficeCLI install copy failure toast must not fire after the row unmounts',
    );
    assert.match(
      settings,
      /finally \{[\s\S]*copyingOfficeCliInstallRef\.current = false;[\s\S]*if \(capabilityRowMountedRef\.current\) \{[\s\S]*setCopyingOfficeCliInstall\(false\);/,
      'OfficeCLI install copy cleanup must not write React pending state after unmount',
    );
    assert.match(settings, /iOfficeAI\/OfficeCLI\/releases/);
    assert.doesNotMatch(settings, /execFile\(|spawn\(|child_process/);
    assert.match(styles, /\.settingsCapabilityGuidance/);
    assert.match(styles, /\.settingsCapabilityGuidanceActions/);
  });

  it('allows only read-only officecli commands as safe shell prefixes', async () => {
    const permission = await readFile(PERMISSION, 'utf8');
    assert.match(permission, /'officecli view'/);
    assert.match(permission, /'officecli get'/);
    assert.match(permission, /'officecli query'/);
    assert.match(permission, /'officecli validate'/);
    assert.doesNotMatch(permission, /'officecli set'/);
    assert.doesNotMatch(permission, /'officecli add'/);
    assert.doesNotMatch(permission, /'officecli close'/);
  });

  it('resolves bundled OfficeCLI tools before falling back to PATH', async () => {
    const [tool, probe, env, manifest, prepareScript, checkScript, packageJson] = await Promise.all([
      readFile(OFFICE_DOCUMENT_TOOL, 'utf8'),
      readFile(OFFICECLI_PROBE, 'utf8'),
      readFile(OFFICECLI_ENV, 'utf8'),
      readFile(OFFICECLI_MANIFEST, 'utf8'),
      readFile(PREPARE_OFFICECLI, 'utf8'),
      readFile(CHECK_OFFICECLI_BUNDLE, 'utf8'),
      readFile(PACKAGE_JSON, 'utf8'),
    ]);

    assert.match(env, /resourcesPath/);
    assert.match(env, /join\(resourcesPath, 'tools'\)/);
    assert.match(env, /resources', 'tools'/);
    assert.match(env, /prependBundledOfficeCliTools/);
    assert.match(env, /OFFICECLI_SKIP_UPDATE: '1'/);
    assert.match(probe, /buildOfficeCliEnv\(\)/);
    assert.match(tool, /buildOfficeCliEnv\(\)/);
    assert.doesNotMatch(tool, /env:\s*\{\s*\.\.\.process\.env,\s*OFFICECLI_SKIP_UPDATE/);

    assert.match(manifest, /iOfficeAI\/OfficeCLI/);
    assert.match(manifest, /darwin-arm64/);
    assert.match(manifest, /win32-x64/);
    assert.match(prepareScript, /SHA256SUMS/);
    assert.match(prepareScript, /DEFAULT_FETCH_TIMEOUT_MS\s*=\s*300_000/);
    assert.match(prepareScript, /MAKA_OFFICECLI_FETCH_TIMEOUT_MS/);
    assert.match(prepareScript, /FETCH_TIMEOUT_MS/);
    assert.match(prepareScript, /AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
    assert.match(prepareScript, /Timed out downloading/);
    assert.match(prepareScript, /Checksum mismatch/);
    assert.match(prepareScript, /resources', 'tools'/);
    assert.match(checkScript, /OfficeCLI bundle missing/);
    assert.match(checkScript, /npm run prepare:officecli -- --platform/);
    assert.match(checkScript, /officeCliVersionMatches/);
    assert.match(packageJson, /"prepare:officecli": "node scripts\/prepare-officecli\.mjs"/);
    assert.match(packageJson, /"check:officecli-bundle": "node scripts\/check-officecli-bundle\.mjs"/);
    assert.match(
      packageJson,
      /"check:release": "npm run check:stale && npm run check:officecli-bundle(?: && [^"]+)*"/,
      'release checks must continue to gate on stale dist and OfficeCLI bundle integrity before any additional release checks',
    );
  });

  it('renders Office document tool results through a structured preview, not raw JSON', async () => {
    const [events, previewSource, styles] = await Promise.all([
      readFile(CORE_EVENTS, 'utf8'),
      readFile(TOOL_RESULT_PREVIEW, 'utf8'),
      readAllRendererCss(),
    ]);

    assert.match(events, /kind:\s*'office_document'/);
    assert.match(previewSource, /content\.kind === 'office_document'/);
    assert.match(previewSource, /function OfficeDocumentPreview/);
    assert.match(previewSource, /redactSecrets\(result\.stdout/);
    assert.match(previewSource, /redactSecrets\(result\.stderr/);
    assert.match(previewSource, /capLines\(redactSecrets\(result\.stdout/);
    assert.match(previewSource, /data-kind="office_document"/);
    assert.match(previewSource, /function presentOfficeDocumentReason/);
    assert.match(previewSource, /officecli 未安装/);
    assert.match(previewSource, /Office 文档操作未完成。/);
    assert.match(previewSource, /操作超时/);
    assert.match(previewSource, /操作失败/);
    const officePreviewBlock = previewSource.match(/function OfficeDocumentPreview[\s\S]*?function presentOfficeDocumentReason/)?.[0] ?? '';
    const officeReasonBlock = previewSource.match(/function presentOfficeDocumentReason[\s\S]*?\n\}/)?.[0] ?? '';
    assert.doesNotMatch(`${officePreviewBlock}\n${officeReasonBlock}`, /Office 文档读取未完成。|读取超时|读取失败|read-only Office adapter/, 'Office result preview must describe read and edit operations, not only reads');
    assert.doesNotMatch(previewSource, /诊断：\{redactSecrets\(result\.reason\)\}/);
    const officeBranch = previewSource.indexOf("content.kind === 'office_document'");
    const jsonBranch = previewSource.indexOf("content.kind === 'json'");
    assert.ok(officeBranch > 0, 'Office document branch must exist');
    assert.ok(jsonBranch > 0, 'JSON branch must exist');
    assert.ok(officeBranch < jsonBranch, 'Office document results must be intercepted before raw JSON rendering');
    // #332 PR4: the office preview shell migrated onto the @maka/ui previewVariants
    // literalize table; the bespoke selectors are retired and the render site wires
    // the governed parts instead.
    assert.doesNotMatch(styles, /\.maka-office-document-preview/, 'retired office preview selector must be gone post-migration');
    assert.doesNotMatch(styles, /\.maka-office-document-stream/, 'retired office stream selector must be gone post-migration');
    assert.match(previewSource, /previewVariants\(\{ part: 'office' \}\)/, 'office preview must render the governed previewVariants office surface');
    assert.match(previewSource, /previewVariants\(\{ part: 'office-stream' \}\)/, 'office stdout/stderr must render the governed previewVariants office-stream surface');
  });

  it('summarizes Office document edits in the permission dialog before raw args', async () => {
    const components = await readFile(PERMISSION_DIALOG, 'utf8');
    const summaryBlock = components.match(/function renderPermissionSummary[\s\S]*?function permissionValuePreview/)?.[0] ?? '';

    assert.match(summaryBlock, /case 'OfficeDocumentEdit'/, 'OfficeDocumentEdit permission requests need a dedicated summary branch');
    assert.match(summaryBlock, /即将编辑 Office 文档/, 'Permission dialog must say that an Office document is being edited');
    assert.match(summaryBlock, /操作 <strong>\{redactSecrets\(operation\)\}<\/strong>/, 'Permission dialog must show create/add/set/remove');
    assert.match(summaryBlock, /目标 <code>\{redactSecrets\(target\)\}<\/code>/, 'Permission dialog must show the selector target when present');
    assert.match(summaryBlock, /permissionValuePreview\(value\)/, 'Permission dialog must summarize bounded props without dumping raw JSON first');
    assert.match(summaryBlock, /另有 \${hiddenProps} 个属性/, 'Permission dialog must cap long prop lists');
    assert.match(components, /function permissionValuePreview/, 'Permission prop rendering should use a bounded helper');
  });
});
