import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(process.cwd(), '../..');

async function read(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

describe('Desktop explicit Skill invocation contract', () => {
  it('keeps selected Skills as structured chips instead of textarea tokens', async () => {
    const popup = await read('packages/ui/src/use-mention-popup.ts');
    const composer = await read('packages/ui/src/composer.tsx');
    const draft = await read('packages/ui/src/use-composer-skill-draft.ts');

    assert.match(popup, /input\.onSelectSkill\?\.\(\{ id: item\.id, name: item\.name \}\)/);
    assert.match(popup, /value\.slice\(0, current\.start\)/);
    assert.doesNotMatch(popup, /skillMentionInsertion\(item\.id\)/);
    assert.match(composer, /className="maka-composer-skill-chip"/);
    assert.match(composer, /props\.onSend\(text, skillIds\)/);
    assert.match(draft, /storeRef = useRef<Map<string, ComposerSkillSelection\[\]>>/);
  });

  it('re-resolves structured ids and direct tokens before consuming attachments', async () => {
    const sessions = await read('apps/desktop/src/main/sessions-ipc-main.ts');
    const sendPlan = await read('apps/desktop/src/main/session-send-skill-plan.ts');
    const runtime = await read('packages/runtime/src/skill-invocation.ts');

    const preparationAt = sessions.indexOf('const sendPlan = await prepareSessionSendSkillPlan');
    const resolveAt = sessions.indexOf('resolveSessionSend({', preparationAt);
    const sendAt = sessions.indexOf('const iterator = runtime.sendMessage(sessionId', resolveAt);
    assert.ok(preparationAt >= 0 && resolveAt > preparationAt && sendAt > resolveAt);
    assert.match(sessions, /prepareSkillInvocation\(sessionId, sendCommand\.text, sendCommand\.skillIds\)/);
    assert.match(sendPlan, /if \(preparation\.disposition === 'blocked'\)/);
    assert.match(runtime, /\.\.\.\(input\.skillIds \?\? \[\]\)/);
    assert.match(runtime, /Every invocation token is removed before provider handoff/);
    assert.match(
      sessions,
      /sendCommand\.text\.trim\(\)\.length > 0[\s\S]*\.map\(\(skill\) => `\/skill:\$\{skill\.id\}`\)/,
      'chip-only sends must retain a readable user message instead of persisting a blank bubble',
    );
  });

  it('uses the session project root and host without depending on Skill management IPC', async () => {
    const main = await read('apps/desktop/src/main/main.ts');
    assert.match(main, /resolveSkillDiscoveryPaths\([\s\S]*resolveProjectRootForContext\(sessionId\)[\s\S]*workspaceRoot/);
    assert.match(main, /desktopSessionSkillHosts\.get\(sessionId\) \?\? desktopHostCapabilities/);
    assert.doesNotMatch(main, /resolveDesktopSkillDiscoverySource/);
  });

  it('scopes transient failure feedback to the composer that initiated the send', async () => {
    const renderer = await read('apps/desktop/src/renderer/app-shell-chat-actions.ts');
    assert.match(
      renderer,
      /if \(newChatOwner && isNewChatSendSurfaceActive\(newChatOwner\)\) \{\s*showSkillInvocationFailures/,
    );
    assert.match(
      renderer,
      /if \(activeIdRef\.current === sessionId\) \{\s*showSkillInvocationFailures/,
    );
  });

  it('keeps a deterministic screenshot scenario for the real structured chip', async () => {
    const fixture = await read('apps/desktop/src/main/visual-smoke-fixture.ts');
    const renderer = await read('apps/desktop/src/renderer/app-shell-visual-smoke.ts');
    const capture = await read('scripts/capture-screenshots.mjs');
    assert.match(fixture, /case 'composer-skill-invocation':[\s\S]*composerSkills:/);
    assert.match(renderer, /composerRef\.current\?\.setSkills\(state\.composerSkills\)/);
    assert.match(capture, /'composer-skill-invocation'/);
  });
});
