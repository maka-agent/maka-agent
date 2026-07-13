import { test, expect } from './fixtures';

test('adds SiliconFlow from the provider catalog as an in-pane Settings flow', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
  await page.getByPlaceholder('搜索服务商').fill('SiliconFlow');
  await page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ }).click();

  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('moonshotai/Kimi-K2.6');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'SiliconFlow', exact: true }).first()).toBeVisible();
  await expect(page.getByText('moonshotai/Kimi-K2.6', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.providerConfigOverlay')).toHaveCount(0);
});

test('adds Cerebras with its exact snapshot model and API-key credential field', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Cerebras');
  const catalogMark = page.locator('.providerCatalogRow[data-provider="cerebras"] .providerLogo .providerAssetMask');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Cerebras/ }).click();
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.cerebras.ai/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('gpt-oss-120b');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Cerebras', exact: true }).first()).toBeVisible();
  const detailMark = page.locator('.providerSubpageHeader .providerLogo[data-provider="cerebras"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('gpt-oss-120b', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds NVIDIA with its exact snapshot model and shared upstream mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('NVIDIA');
  const catalogMark = page.locator('.providerCatalogRow[data-provider="nvidia"] .providerLogo .providerAssetMask');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：NVIDIA/ }).click();
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://integrate.api.nvidia.com/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('nvidia/nemotron-3-super-120b-a12b');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'NVIDIA', exact: true }).first()).toBeVisible();
  const detailMark = page.locator('.providerSubpageHeader .providerLogo[data-provider="nvidia"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('nvidia/nemotron-3-super-120b-a12b', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds MiniMax Coding Plan under its independent provider id with an exact snapshot model', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '模型计划' }).click();
  await page.getByPlaceholder('搜索服务商').fill('MiniMax Coding Plan');
  await expect(
    page.locator('.providerCatalogRow[data-provider="minimax-coding-plan"] .providerLogo img[src*="minimax-logo-only-vertical-color-bg-white-text-"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: /添加模型供应商：MiniMax Coding Plan/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('minimax-coding-plan');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.minimax.io/anthropic');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('MiniMax-M3');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'MiniMax Coding Plan', exact: true }).first()).toBeVisible();
  await expect(
    page.locator('.providerSubpageHeader .providerLogo[data-provider="minimax-coding-plan"] img[src*="minimax-logo-only-vertical-color-bg-white-text-"]'),
  ).toBeVisible();
  await expect(page.getByText('MiniMax-M3', { exact: true }).first()).toBeVisible();
});

test('adds Tencent Coding Plan with its exact access path and shared Tencent Cloud mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '模型计划' }).click();
  await page.getByPlaceholder('搜索服务商').fill('Tencent Coding Plan');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="tencent-coding-plan"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Tencent Coding Plan/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('tencent-coding-plan');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.lkeap.cloud.tencent.com/coding/v3');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('tc-code-latest');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Tencent Coding Plan (China)', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="tencent-coding-plan"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('tc-code-latest', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Tencent Token Plan with its exact access path and shared Tencent Cloud mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '模型计划' }).click();
  await page.getByPlaceholder('搜索服务商').fill('Tencent Token Plan');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="tencent-token-plan"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Tencent Token Plan/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('tencent-token-plan');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.lkeap.cloud.tencent.com/plan/v3');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('tc-code-latest');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Tencent Token Plan', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="tencent-token-plan"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('tc-code-latest', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds xAI with its exact snapshot model and API-key credential field', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('xAI');
  const catalogMark = page.locator('.providerCatalogRow[data-provider="xai"] .providerLogo .providerAssetMask');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：xAI/ }).click();
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('grok-4.5');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'xAI', exact: true }).first()).toBeVisible();
  const detailMark = page.locator('.providerSubpageHeader .providerLogo[data-provider="xai"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('grok-4.5', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Together AI with its exact snapshot model and shared theme-aware brand mask', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Together AI');
  const catalogMark = page.locator('.providerCatalogRow[data-provider="togetherai"] .providerLogo .providerAssetMask');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Together AI/ }).click();
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('MiniMaxAI/MiniMax-M3');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Together AI', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
  const detailMark = page.locator('.providerSubpageHeader .providerLogo[data-provider="togetherai"] .providerAssetMask');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('MiniMaxAI/MiniMax-M3', { exact: true }).first()).toBeVisible();
});

test('adds Fireworks AI with its exact snapshot model and shared upstream mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Fireworks AI');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="fireworks-ai"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Fireworks AI/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('fireworks-ai');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.fireworks.ai/inference/v1/');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('accounts/fireworks/models/kimi-k2p6');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Fireworks AI', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="fireworks-ai"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('accounts/fireworks/models/kimi-k2p6', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

function maskRenderContract(element: Element): { usesAssetMask: boolean; followsForeground: boolean } {
  const style = getComputedStyle(element);
  return {
    usesAssetMask: style.maskImage.startsWith('url('),
    followsForeground: style.backgroundColor === style.color,
  };
}

test('adds LM Studio as a no-auth local runtime with the shared official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '本地' }).click();
  await page.getByPlaceholder('搜索服务商').fill('LM Studio');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="lm-studio"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：LM Studio/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('lm-studio');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('http://localhost:1234/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('');
  await expect(page.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'LM Studio', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="lm-studio"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByLabel(/LM Studio 模型密钥/)).toHaveCount(0);
});

test('adds LocalAI with its default endpoint, optional key, and official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '本地' }).click();
  await page.getByPlaceholder('搜索服务商').fill('LocalAI');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="localai"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：LocalAI/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('localai');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('http://localhost:8080/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('qwen3-8b');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'LocalAI', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="localai"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Mistral with its exact snapshot model, API-key field, and shared official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Mistral');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="mistral"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Mistral/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('mistral');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.mistral.ai/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('mistral-large-latest');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Mistral', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="mistral"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('mistral-large-latest', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Tencent TokenHub with its exact snapshot model, API-key field, and shared official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Tencent');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="tencent-tokenhub"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Tencent TokenHub/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('tencent-tokenhub');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://tokenhub.tencentmaas.com/v1');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('hy3');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Tencent TokenHub', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="tencent-tokenhub"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('hy3', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

for (const stepfun of [
  { label: 'StepFun (China)', providerType: 'stepfun', baseUrl: 'https://api.stepfun.com/v1', tab: 'API', model: 'step-3.7-flash' },
  { label: 'StepFun Step Plan (China)', providerType: 'stepfun-step-plan', baseUrl: 'https://api.stepfun.com/step_plan/v1', tab: '模型计划', model: 'step-3.7-flash' },
  { label: 'StepFun (Global)', providerType: 'stepfun-ai', baseUrl: 'https://api.stepfun.ai/v1', tab: 'API', model: 'step-3.7-flash' },
] as const) test(`adds ${stepfun.label} with its exact snapshot model, API-key field, and shared official mark`, async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: stepfun.tab, exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('StepFun');
  const catalogMark = page.locator(
    `.providerCatalogRow[data-provider="${stepfun.providerType}"] .providerLogo .providerAssetMask`,
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: `添加模型供应商：${stepfun.label}` }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue(stepfun.providerType);
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue(stepfun.baseUrl);
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue(stepfun.model);
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: stepfun.label, exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    `.providerSubpageHeader .providerLogo[data-provider="${stepfun.providerType}"] .providerAssetMask`,
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText(stepfun.model, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Volcengine Ark China with its exact snapshot model, API-key field, and shared official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('Volcengine');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="volcengine-ark"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Volcengine Ark \(China\)/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('volcengine-ark');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://ark.cn-beijing.volces.com/api/v3');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('doubao-seed-2-0-pro-260215');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Volcengine Ark (China)', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="volcengine-ark"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('doubao-seed-2-0-pro-260215', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

test('adds Volcengine Ark Coding Plan under its independent access path and shared official mark', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '模型计划' }).click();
  await page.getByPlaceholder('搜索服务商').fill('Volcengine');
  const catalogMark = page.locator(
    '.providerCatalogRow[data-provider="volcengine-coding-plan"] .providerLogo .providerAssetMask',
  );
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：Volcengine Ark Coding Plan \(China\)/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('volcengine-coding-plan');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://ark.cn-beijing.volces.com/api/coding/v3');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('ark-code-latest');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'Volcengine Ark Coding Plan (China)', exact: true }).first()).toBeVisible();
  const detailMark = page.locator(
    '.providerSubpageHeader .providerLogo[data-provider="volcengine-coding-plan"] .providerAssetMask',
  );
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('ark-code-latest', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新模型列表' })).toBeDisabled();
});

test('restores keyboard focus across provider child pages', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  const addProvider = page.getByRole('button', { name: '添加服务商' });
  await addProvider.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();

  await page.getByPlaceholder('搜索服务商').fill('SiliconFlow');
  const siliconFlow = page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ });
  await siliconFlow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(siliconFlow).toBeFocused();

  const catalogBack = page.getByRole('button', { name: '返回模型连接' });
  await catalogBack.focus();
  await page.keyboard.press('Enter');
  await expect(addProvider).toBeFocused();

  const existingConnection = page.getByRole('button', { name: /模型连接：E2E/ });
  await existingConnection.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(existingConnection).toBeFocused();
});
