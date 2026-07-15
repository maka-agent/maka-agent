import path from 'node:path';
import { test, expect } from './fixtures.js';

const fixtureServer = path.resolve(
  process.cwd(),
  '../../packages/mcp/dist/__fixtures__/stdio-server.js',
);

test('MCP Settings completes stdio add, discovery, disable, and delete', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: 'MCP' }).click();
  await expect(settings.getByRole('heading', { name: 'MCP' })).toBeVisible();

  await settings.getByRole('button', { name: '添加第一个 server' }).click();
  await settings.getByLabel('Server ID').fill('e2e-fixture');
  await settings.getByLabel('Command').fill(process.execPath);
  await settings.getByLabel('Arguments').fill(fixtureServer);
  await settings.getByRole('button', { name: '保存并连接' }).click();

  await expect(settings.getByText('e2e-fixture', { exact: true })).toBeVisible();
  await expect(settings.getByText('echo', { exact: true })).toBeVisible();
  await expect(settings.getByText('rich', { exact: true })).toBeVisible();
  await expect(settings.getByText('4 tools', { exact: true })).toBeVisible();

  const config = await page.evaluate(() => window.maka.mcp.getConfig());
  expect(config.mcpServers['e2e-fixture']).toMatchObject({
    enabled: true,
    command: process.execPath,
    args: [fixtureServer],
  });

  const screenshotPath = process.env.MAKA_MCP_E2E_SCREENSHOT;
  if (screenshotPath) await settings.screenshot({ path: screenshotPath });

  await settings.getByLabel('e2e-fixture 启用状态').click();
  await expect(settings.getByText('已停用', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture']?.enabled;
  }).toBe(false);

  page.once('dialog', (dialog) => dialog.accept());
  await settings.getByRole('button', { name: '删除' }).click();
  await expect(settings.getByText('还没有 MCP server')).toBeVisible();
  await expect.poll(async () => {
    const next = await page.evaluate(() => window.maka.mcp.getConfig());
    return next.mcpServers['e2e-fixture'];
  }).toBeUndefined();
});
