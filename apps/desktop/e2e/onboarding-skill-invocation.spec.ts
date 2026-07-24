import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function createStarterSkillAndReload(page: Page): Promise<void> {
  const result = await page.evaluate(() => window.maka.skills.createStarter());
  expect(result.ok).toBe(true);
  await page.reload();
  await expect(page.locator('.maka-onboarding-quickchat-input')).toBeVisible();
}

async function selectStarterSkill(page: Page): Promise<void> {
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('/');
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option', { name: /示例技能/ })).toBeVisible();
  await quickChat.press('Enter');
  await expect(page.locator('.maka-composer-skill-chip')).toContainText('示例技能');
  await expect(quickChat).toHaveValue('');
}

test('first-run Quick Chat selects a structured Skill from slash suggestions', async ({
  window: page,
}) => {
  await createStarterSkillAndReload(page);
  await selectStarterSkill(page);

  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  const chip = page.locator('.maka-composer-skill-chip');
  await expect(chip).toHaveCSS('min-height', '32px');
  const removeButton = chip.getByRole('button');
  await expect(removeButton).toHaveCSS('height', '32px');
  await removeButton.focus();
  await removeButton.press('Enter');
  await expect(chip).toHaveCount(0);
  await expect(quickChat).toBeFocused();

  await selectStarterSkill(page);
  await quickChat.press('Backspace');
  await expect(chip).toHaveCount(0);
});

test('slash suggestions follow Runtime project discovery and host gating', async ({
  invocableSkillsWindow: page,
}) => {
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('/');
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toContainText('Project Only');
  await expect(listbox).toContainText('Workspace Only');
  await expect(listbox).toContainText('Agent Write');
  await expect(listbox).not.toContainText('Host Incompatible');

  const planNames = await page.evaluate(async () =>
    (await window.maka.skills.listInvocable(undefined, {
      collaborationMode: 'plan',
    })).map((skill) => skill.name),
  );
  expect(planNames).not.toContain('Agent Write');
});

test('ready-empty slash suggestions follow the selected Deep Research mode', async ({
  invocableSkillsWindow: page,
}) => {
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  const listbox = page.getByRole('listbox', { name: '技能' });

  await quickChat.fill('/');
  await expect(listbox).toBeVisible();
  await expect(listbox).not.toContainText('Deep Research Only');
  await quickChat.fill('');

  await page.getByRole('button', { name: '深度研究一个项目' }).click();
  await expect(page.getByText('深度研究 · 只读分析')).toBeVisible();
  await quickChat.fill('/');
  await expect(listbox).toContainText('Deep Research Only');
});

test('open Skill suggestions follow current collaboration capabilities', async ({
  invocableSkillsWindow: page,
}) => {
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('Open a session');
  await quickChat.press('Enter');
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  await expect(composer).toBeVisible();
  const [session] = await page.evaluate(() => window.maka.sessions.list());
  if (!session) throw new Error('Quick Chat did not create a session');

  const listNames = (sessionId: string) =>
    page.evaluate(
      async (id) => (await window.maka.skills.listInvocable(id)).map((skill) => skill.name),
      sessionId,
    );

  await expect.poll(() => listNames(session.id)).toContain('Agent Write');
  await composer.fill('/');
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toContainText('Agent Write');

  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list()))[0]?.status)
    .not.toBe('running');
  await page.evaluate(
    ({ sessionId }) => window.maka.sessions.setCollaborationMode(sessionId, 'plan'),
    { sessionId: session.id },
  );
  await expect.poll(() => listNames(session.id)).not.toContain('Agent Write');
  await expect(listbox).not.toContainText('Agent Write');
});

test('chip-only send renders a readable user message', async ({ window: page }) => {
  await createStarterSkillAndReload(page);
  await selectStarterSkill(page);

  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.press('Enter');

  await expect(page.getByLabel('你发送的消息').first()).toContainText('/skill:starter-skill');
});

test('blocked first-run Skill invocation keeps the complete Quick Chat draft', async ({
  window: page,
}) => {
  await createStarterSkillAndReload(page);
  await selectStarterSkill(page);
  const disabled = await page.evaluate(() => window.maka.skills.setEnabled('starter-skill', false));
  expect(disabled.ok).toBe(true);

  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('run it');
  await quickChat.press('Enter');

  await expect(page.getByText('Skill 调用失败，消息未发送')).toBeVisible();
  await expect(quickChat).toHaveValue('run it');
  await expect(page.locator('.maka-composer-skill-chip')).toContainText('示例技能');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
});
