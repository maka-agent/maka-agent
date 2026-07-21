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
  await expect(listbox).not.toContainText('Host Incompatible');
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
