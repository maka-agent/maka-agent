import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import { test, expect } from './fixtures.js';

test('answers three questions and continues the same fake-backend turn', async ({ window: page }) => {
  const composer = page.locator('.maka-onboarding-quickchat-input');
  await composer.fill(FAKE_ASK_USER_QUESTION_PROMPT);
  await composer.press('Enter');

  const prompt = page.locator('.maka-user-question-prompt');
  await expect(prompt).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeHidden();
  await expect(prompt.getByText('1 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByText('先验证核心流程，再逐步扩大范围。')).toBeVisible();

  await prompt.getByRole('radio', { name: /邀请制/ }).click();
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('2 / 3', { exact: true })).toBeVisible();
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('3 / 3', { exact: true })).toBeVisible();
  await prompt.getByRole('radio', { name: /其他/ }).click();
  const other = prompt.getByRole('textbox', { name: '其他答案' });
  await expect(prompt.getByRole('button', { name: '提交答案' })).toBeDisabled();
  await other.fill('自定义节奏');
  await prompt.getByRole('button', { name: '提交答案' }).click();

  await expect(prompt).toHaveCount(0);
  await expect(page.getByText(/Fake question answers: 邀请制 \/ 未回答 \/ 自定义节奏/)).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeVisible();
});
