import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('PR-SESSION-STICKY-MODEL-0 contract', () => {
  it('captures the ready model when creating a desktop session', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');

    assert.match(main, /const requestedSlug = input\?\.llmConnectionSlug \?\? \(await connectionStore\.getDefault\(\)\)/);
    assert.match(main, /const \{ connection, model \} = await getReadyConnection\(requestedSlug, input\?\.model\)/);
    assert.match(main, /runtime\.createSession\(\{[\s\S]*llmConnectionSlug: connection\.slug,[\s\S]*model,/);
  });

  it('validates sends against the session model, not the latest provider default', async () => {
    const readiness = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/chat-readiness.ts'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');

    assert.match(readiness, /assertSessionCanSend\([\s\S]*header: Pick<SessionHeader, 'backend' \| 'llmConnectionSlug' \| 'model'>/);
    assert.match(readiness, /requireReadyConnection\(header\.llmConnectionSlug, deps, header\.model\)/);
    assert.match(readiness, /normalizeRequestedModel\(connection, requestedModel\)/);
    assert.match(readiness, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(requestedModel\)/);
    assert.match(main, /const \{ connection, apiKey, model \} = await getReadyConnection\(ctx\.header\.llmConnectionSlug, ctx\.header\.model\)/);
    assert.match(main, /header: \{ \.\.\.ctx\.header, model \}/);
    assert.match(main, /modelId: model/);
    assert.match(readiness, /Once a session has user messages, its connection\/model is sticky/);
    assert.match(readiness, /if \(header\.connectionLocked\) \{\s*throw error;\s*\}/);
  });

  it('preserves sticky model through branch sessions and session summaries', async () => {
    const runtime = await readFile(resolve(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');
    const storage = await readFile(resolve(REPO_ROOT, 'packages/storage/src/session-store.ts'), 'utf8');
    const core = await readFile(resolve(REPO_ROOT, 'packages/core/src/session.ts'), 'utf8');

    assert.match(runtime, /branchFromTurn[\s\S]*model: header\.model/);
    assert.match(runtime, /model: h\.model/);
    assert.match(storage, /model: header\.model/);
    assert.match(core, /Sticky session default model id, captured when the session is created/);
  });

  it('surfaces the session model in the chat header and explains default-model scope', async () => {
    const renderer = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const providers = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/ProvidersPanel.tsx'), 'utf8');

    assert.match(renderer, /normalizeActiveChatModel\(activeSession, activeConnection, chatModelChoices\)/);
    assert.match(ui, /本会话固定模型：\$\{props\.activeConnectionLabel\} · \$\{props\.activeModelLabel\}/);
    assert.match(ui, /设置里的默认模型只影响新建会话/);
    assert.match(providers, /默认模型只用于新建会话；已有会话会保留创建时的模型选择/);
  });

  it('lets the user explicitly switch the current session model from the chat header', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const globalTypes = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/global.d.ts'), 'utf8');
    const renderer = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');

    assert.match(main, /ipcMain\.handle\('sessions:setModel'[\s\S]*normalizeSessionModelSelection\(input\)/);
    assert.match(main, /getReadyConnection\(llmConnectionSlug, model\)/, 'model switch must reuse the send-path readiness gate');
    assert.match(main, /runtime\.updateSession\(sessionId, \{[\s\S]*llmConnectionSlug: ready\.connection\.slug,[\s\S]*model: ready\.model,[\s\S]*connectionLocked: true/);
    assert.match(main, /当前对话正在运行，等结束后再切换模型/);
    assert.match(main, /当前有工具调用正在等待确认，处理后再切换模型/);
    assert.match(preload, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(globalTypes, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(renderer, /modelChoices=\{chatModelChoices\}/);
    assert.match(renderer, /const pendingSessionModelChangesRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(renderer, /const sessionId = activeIdRef\.current;[\s\S]*pendingSessionModelChangesRef\.current\.has\(sessionId\)[\s\S]*window\.maka\.sessions\.setModel\(sessionId, input\)[\s\S]*finally \{[\s\S]*pendingSessionModelChangesRef\.current\.delete\(sessionId\);/);
    assert.match(renderer, /onModelChange=\{\(input\) => setSessionModel\(input\)\}/);
    assert.doesNotMatch(renderer, /onModelChange=\{\(input\) => void setSessionModel\(input\)\}/);
    assert.match(renderer, /PROVIDER_DEFAULTS\[connection\.providerType\]/);
    assert.match(renderer, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(model\.trim\(\)\)/);
    assert.match(ui, /function ChatModelSwitcher/);
    assert.match(ui, /activeModel\?: string/);
    assert.match(ui, /const currentModel = props\.activeModel \?\? props\.activeSession\.model/);
    assert.match(ui, /aria-label="切换当前会话模型"/);
    assert.match(ui, /const \[pending,\s*setPending\] = useState\(false\);/);
    assert.match(ui, /const pendingRef = useRef\(false\);/);
    assert.match(ui, /if \(pendingRef\.current\) return;/);
    assert.match(ui, /Promise\.resolve\(\)[\s\S]*\.then\(\(\) => props\.onChange\?\.\(next\)\)[\s\S]*\.finally\(\(\) => \{[\s\S]*pendingRef\.current = false;[\s\S]*setPending\(false\);/);
    assert.match(ui, /aria-busy=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /data-pending=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /<span className="maka-model-switcher-label">\{pending \? '切换中' : '模型'\}<\/span>/);
    assert.match(styles, /\.maka-model-switcher\s*\{/);
    assert.match(styles, /\.maka-model-switcher\[data-pending="true"\]\s*\{[\s\S]*cursor: progress;[\s\S]*\}/);
    assert.match(styles, /\.maka-model-switcher-select:focus-visible\s*\{/);
  });

  it('flags per-turn model departures against the session sticky model', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');

    assert.match(ui, /props\.activeSession\?\.model && props\.activeSession\.model\.length > 0/);
    assert.match(ui, /previousModelId=\{expectedModelId\}/);
    assert.match(ui, /本轮使用 \$\{turn\.modelId\}，session 期望 \$\{props\.previousModelId\}/);
    assert.match(ui, /本轮切换了模型/);
  });
});
