import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');
const MAIN = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const PERMISSION = join(REPO_ROOT, 'packages', 'core', 'src', 'permission.ts');
const CORE_EVENTS = join(REPO_ROOT, 'packages', 'core', 'src', 'events.ts');
const UI_COMPONENTS = join(REPO_ROOT, 'packages', 'ui', 'src', 'components.tsx');

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
    assert.doesNotMatch(officeCapabilityBlock, /读取与校验。|只读|生成/, 'Office capability copy must not lag behind the permission-gated edit tool');
    assert.match(main, /probeOfficeCli\(\{ now: permissions\.checkedAt \}\)/);
    assert.match(main, /probeOfficeCli\(\{ now \}\)/);
  });

  it('renders capability guidance as visible action copy', async () => {
    const [settings, styles] = await Promise.all([
      readFile(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8'),
      readFile(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8'),
    ]);

    assert.match(settings, /capability\.guidance\.length > 0/);
    assert.match(settings, /处理建议/);
    assert.match(settings, /OFFICECLI_INSTALL_COMMAND/);
    assert.match(settings, /复制 macOS\/Linux 安装命令/);
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

  it('renders Office document tool results through a structured preview, not raw JSON', async () => {
    const [events, components, styles] = await Promise.all([
      readFile(CORE_EVENTS, 'utf8'),
      readFile(UI_COMPONENTS, 'utf8'),
      readFile(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8'),
    ]);

    assert.match(events, /kind:\s*'office_document'/);
    assert.match(components, /content\.kind === 'office_document'/);
    assert.match(components, /function OfficeDocumentPreview/);
    assert.match(components, /redactSecrets\(result\.stdout/);
    assert.match(components, /redactSecrets\(result\.stderr/);
    assert.match(components, /capLines\(redactSecrets\(result\.stdout/);
    assert.match(components, /data-kind="office_document"/);
    assert.match(components, /function presentOfficeDocumentReason/);
    assert.match(components, /officecli 未安装/);
    assert.match(components, /Office 文档操作未完成。/);
    assert.match(components, /操作超时/);
    assert.match(components, /操作失败/);
    const officePreviewBlock = components.match(/function OfficeDocumentPreview[\s\S]*?function presentOfficeDocumentReason/)?.[0] ?? '';
    const officeReasonBlock = components.match(/function presentOfficeDocumentReason[\s\S]*?\n\}/)?.[0] ?? '';
    assert.doesNotMatch(`${officePreviewBlock}\n${officeReasonBlock}`, /Office 文档读取未完成。|读取超时|读取失败|read-only Office adapter/, 'Office result preview must describe read and edit operations, not only reads');
    assert.doesNotMatch(components, /诊断：\{redactSecrets\(result\.reason\)\}/);
    const officeBranch = components.indexOf("content.kind === 'office_document'");
    const jsonBranch = components.indexOf("content.kind === 'json'");
    assert.ok(officeBranch > 0, 'Office document branch must exist');
    assert.ok(jsonBranch > 0, 'JSON branch must exist');
    assert.ok(officeBranch < jsonBranch, 'Office document results must be intercepted before raw JSON rendering');
    assert.match(styles, /\.maka-office-document-preview/);
    assert.match(styles, /\.maka-office-document-stream/);
  });

  it('summarizes Office document edits in the permission dialog before raw args', async () => {
    const components = await readFile(UI_COMPONENTS, 'utf8');
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
