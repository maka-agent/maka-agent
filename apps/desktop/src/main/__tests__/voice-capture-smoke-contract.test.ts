import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SETTINGS_MODAL = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');

describe('voice capture smoke Settings contract', () => {
  it('does not present voice models as a coming-soon nav item', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    const voiceNav = src.match(/\{\s*id:\s*'voice-models'[\s\S]*?\},/);
    assert.ok(voiceNav, 'voice-models nav item must exist');
    assert.doesNotMatch(voiceNav![0], /comingSoon:\s*true/, 'voice-models nav must not be tagged as coming soon');
    assert.match(src, /case\s+'voice-models':\s*\n\s*return\s+<VoiceModelsSettingsPage\s*\/>/);
    assert.doesNotMatch(src, /'voice-models':\s*\{[\s\S]*当前尚未实现/, 'voice-models must not keep stale roadmap copy');
  });

  it('runs only a local renderer capture smoke and validates it through the core voice contract', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    assert.match(src, /navigator\.mediaDevices\.getUserMedia/, 'voice page must request local microphone capture');
    assert.match(src, /new MediaRecorder\(stream\)/, 'voice page must use MediaRecorder for local smoke');
    assert.match(src, /validateVoiceCaptureRequest/, 'voice page must validate capture facts through @maka/core/voice');
    assert.match(src, /样本未保存/, 'voice page must tell users that the sample is not saved');
    assert.match(src, /等待运行本机录音自检/, 'voice idle state should read as an actionable local check');
    assert.doesNotMatch(src, /尚未运行本机录音自检/, 'voice idle state should not read like unfinished implementation copy');
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*voice/i, 'voice smoke must not persist audio state in localStorage');
  });

  it('capability center reports voice as partial smoke, not a dead placeholder', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const voiceBlock = src.match(/id:\s*'voice'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\n\s*\}\),/);
    assert.ok(voiceBlock, 'voice capability block must exist');
    assert.match(voiceBlock![0], /state:\s*'partial'/, 'voice feature must be partial, not not_available');
    assert.match(voiceBlock![0], /本地麦克风录音自检已可用/, 'voice feature reason must name the shipped smoke path');
    assert.doesNotMatch(voiceBlock![0], /voice capture\/playback not implemented/, 'old placeholder reason must not return');
  });

  it('capability center reports local memory as partial instead of missing write contract only', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const memoryBlock = src.match(/id:\s*'memory_write'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\n\s*\}\),/);
    assert.ok(memoryBlock, 'memory capability block must exist');
    assert.match(memoryBlock![0], /label:\s*'Memory'/, 'capability label should cover visible local memory, not only writes');
    assert.match(memoryBlock![0], /state:\s*'partial'/, 'memory feature must be partial, not not_available');
    assert.match(memoryBlock![0], /本地 MEMORY\.md 已可见/, 'memory reason must name the shipped transparent file');
    assert.doesNotMatch(memoryBlock![0], /memory write contract not implemented/, 'old placeholder reason must not return');
  });

  it('capability center reports activity recorder as partial local Daily Review aggregation', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const activityBlock = src.match(/id:\s*'activity_recorder'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\n\s*\}\),/);
    assert.ok(activityBlock, 'activity recorder capability block must exist');
    assert.match(activityBlock![0], /state:\s*'partial'/, 'activity recorder must be partial, not not_available');
    assert.match(activityBlock![0], /Daily Review 已聚合本地会话/, 'activity reason must name the shipped local aggregation path');
    assert.match(activityBlock![0], /当前不包含屏幕与应用级录制/, 'activity reason must keep the unshipped recorder boundary visible without implementation-status copy');
    assert.doesNotMatch(activityBlock![0], /activity timeline not implemented/, 'old placeholder reason must not return');
  });

  it('capability center uses user-facing unavailable copy instead of implementation placeholders', async () => {
    const [settings, snapshot] = await Promise.all([
      readFile(SETTINGS_MODAL, 'utf8'),
      readFile(CAPABILITY_SNAPSHOT, 'utf8'),
    ]);
    assert.match(settings, /case\s+'not_available':\s*return\s+'未开放'/, 'not_available label should be product-facing copy');
    assert.doesNotMatch(settings, /尚未实现/, 'Settings capability UI must not render not_available as unfinished implementation copy');
    assert.doesNotMatch(snapshot, /not implemented|missing_token|local gateway disabled|未接入|尚未接入|helper/, 'capability reasons must not leak internal placeholder/error identifiers');
    assert.match(snapshot, /本机控制需要独立权限确认与审计/, 'Computer Use must keep a clear product boundary reason');
    assert.match(snapshot, /本地 Gateway 已关闭/, 'Open Gateway disabled state must use user-facing copy');
    assert.match(snapshot, /等待生成访问 token/, 'Open Gateway missing token state must use actionable waiting copy');
    assert.doesNotMatch(snapshot, /缺少访问 token/, 'Open Gateway missing token state should not read like a raw missing-field error');
  });
});
