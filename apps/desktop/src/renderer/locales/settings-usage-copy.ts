import type { UiCatalog, UiLocale } from '@maka/core';

export type UsageSettingsCopy = {
  saveFailed: string; toolbarAria: string; rangeAria: string; ranges: readonly [string, string, string, string];
  refreshingAria: string; refreshAria: string; summaryAria: string; totalRequests: string; totalCost: string; costHelp: string;
  totalTokens: string; tokenDetail(input: number, output: number): string; cacheTokens: string; cacheDetail(miss: number, read: number, creation: number): string;
  viewAria: string; tabs: readonly [string, string, string, string, string]; filtersAria: string; filterPlaceholder: string; filterAria: string;
  statusAria: string; statuses: readonly [string, string, string]; details: string; detailsAria: string; recordCount(count: number): string; clearFilters: string;
  summaryOnly: string; showDetails: string; filteredEmpty: string; requestEmpty: string;
  pricing: {
    title: string; description: string; add: string; customize: string; edit: string; remove: string; reset: string;
    save: string; cancel: string; saving: string; removing: string; formAria: string;
    modelKey: string; modelKeyPlaceholder: string; inputRate: string; outputRate: string;
    cacheReadRate: string; cacheWriteRate: string; invalid: string; loading: string;
    loadFailed: string; retry: string; retrying: string; reconciliationRequired: string;
    saveFailed: string; deleteFailed: string; saved: string; removed: string;
    removeTitle(modelKey: string): string;
    removeDescription(modelKey: string, effect: 'restore_builtin' | 'become_unpriced'): string;
    sourceBuiltin: string; sourceCustomWithFallback: string; sourceCustomOnly: string;
    unavailable: string; reviewRequired: string; savedRefreshFailed: string; outcomeUnknown: string;
    actionsAria: string; noCache: string;
  };
  tables: {
    providersAria: string; modelsAria: string; toolsAria: string; pricingAria: string; requestsAria: string;
    providerHeaders: string[]; modelHeaders: string[]; toolHeaders: string[]; pricingHeaders: string[]; requestHeaders: string[];
    noPricing: string; modelKind: string; toolKind: string; openSession(label: string): string; success: string; error: string;
    providerEmptyTitle: string; providerEmptyBody: string; modelEmptyTitle: string; modelEmptyBody: string;
    toolEmptyTitle: string; toolEmptyBody: string; pricingEmptyBody: string;
  };
};

const SETTINGS_USAGE_COPY = {
  zh: {
    saveFailed: '保存使用统计设置失败', toolbarAria: '使用统计范围与刷新', rangeAria: '使用统计时间范围', ranges: ['24h', '7天', '30天', '全部'],
    refreshingAria: '正在刷新使用统计', refreshAria: '刷新使用统计', summaryAria: '使用统计汇总指标', totalRequests: '总请求', totalCost: '总费用', costHelp: '以模型供应商最终结算为准',
    totalTokens: '总 Token', tokenDetail: (input, output) => `输入 ${input} / 输出 ${output}`, cacheTokens: '缓存 Token',
    cacheDetail: (miss, read, creation) => `新 ${miss} / 命中 ${read} / 创建 ${creation}`, viewAria: '使用统计视图', tabs: ['请求日志', '供应商统计', '模型统计', '工具统计', '定价配置'],
    filtersAria: '请求记录筛选', filterPlaceholder: '按模型或工具筛选…', filterAria: '按模型或工具筛选请求记录', statusAria: '请求状态筛选',
    statuses: ['全部状态', '成功', '错误'], details: '详情记录', detailsAria: '显示使用统计详情记录', recordCount: (count) => `共 ${count} 条记录`, clearFilters: '清除筛选',
    summaryOnly: '当前仅显示汇总指标。打开详情记录后，可以查看逐条模型请求和工具调用，按模型、工具或状态筛选，并用于排查费用与失败请求。',
    showDetails: '显示明细', filteredEmpty: '没有符合筛选条件的请求记录', requestEmpty: '暂无请求记录',
    pricing: {
      title: '自定义定价覆盖',
      description: '为特定模型设置输入、输出和缓存价格；未覆盖的模型继续使用内置定价。',
      add: '添加价格', customize: '自定义', edit: '编辑', remove: '删除', reset: '恢复', save: '保存价格', cancel: '取消', saving: '保存中…', removing: '删除中…',
      formAria: '自定义模型定价表单', modelKey: '模型标识', modelKeyPlaceholder: 'provider:model，例如 openai:gpt-4o',
      inputRate: '输入价格 / 1M Token', outputRate: '输出价格 / 1M Token', cacheReadRate: '缓存读取 / 1M Token', cacheWriteRate: '缓存写入 / 1M Token',
      invalid: '请填写模型标识、输入价格和输出价格；价格必须是大于或等于 0 的数字。', loading: '正在加载定价覆盖…',
      loadFailed: '加载定价覆盖失败', retry: '重试加载', retrying: '重试中…', reconciliationRequired: '请重新加载最新定价状态，确认结果后再继续编辑。',
      saveFailed: '保存定价覆盖失败', deleteFailed: '删除定价覆盖失败', saved: '定价覆盖已保存', removed: '定价覆盖已删除',
      removeTitle: (modelKey) => `删除 ${modelKey} 的定价覆盖？`,
      removeDescription: (modelKey, effect) => effect === 'restore_builtin'
        ? `将删除 ${modelKey} 的 override。之后新激活的模型工作会恢复内置价格；正在运行的工作保持启动时的价格。`
        : `将删除 ${modelKey} 的 override。之后新激活的模型工作会变为未定价，而不是 $0；正在运行的工作保持启动时的价格。`,
      sourceBuiltin: '内置', sourceCustomWithFallback: '自定义 · 有内置回退', sourceCustomOnly: '仅自定义',
      unavailable: 'Host-backed Pricing port 尚未注入', reviewRequired: '定价已经发生变化，请核对最新值后再次保存。',
      savedRefreshFailed: '定价已经保存，但最新定价列表暂时无法加载。', outcomeUnknown: '写入结果无法确定，请刷新最新定价后再操作。',
      actionsAria: '定价覆盖操作', noCache: '未设置',
    },
    tables: {
      providersAria: '使用统计供应商统计表', modelsAria: '使用统计模型统计表', toolsAria: '使用统计工具统计表', pricingAria: '使用统计定价配置表', requestsAria: '使用统计请求日志表',
      providerHeaders: ['供应商', '请求', 'Token', '费用'], modelHeaders: ['模型', '请求', 'Token', '费用'], toolHeaders: ['工具', '调用', '成功', '错误', '平均耗时'],
      pricingHeaders: ['供应商', '模型', '来源', '输入 / 1M', '输出 / 1M', '缓存读取 / 1M', '缓存写入 / 1M', '操作'], requestHeaders: ['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态'],
      noPricing: '暂无定价覆盖配置', modelKind: '模型', toolKind: '工具', openSession: (label) => `打开 ${label}`, success: '成功', error: '错误',
      providerEmptyTitle: '暂无供应商用量', providerEmptyBody: '完成一次模型请求后，这里会按供应商聚合请求数、Token 与费用。',
      modelEmptyTitle: '暂无模型用量', modelEmptyBody: '完成一次模型请求后，这里会按模型聚合请求数、Token 与费用。',
      toolEmptyTitle: '暂无工具调用', toolEmptyBody: '智能体调用工具后，这里会按工具聚合调用次数、成功、错误与平均耗时。',
      pricingEmptyBody: '未配置定价覆盖时，费用按内置模型定价表结算；在此可为特定模型登记自定义价格。',
    },
  },
  en: {
    saveFailed: 'Failed to save usage settings', toolbarAria: 'Usage range and refresh', rangeAria: 'Usage time range', ranges: ['24h', '7 days', '30 days', 'All'],
    refreshingAria: 'Refreshing usage', refreshAria: 'Refresh usage', summaryAria: 'Usage summary metrics', totalRequests: 'Total requests', totalCost: 'Total cost', costHelp: 'Final billing is determined by the model provider',
    totalTokens: 'Total tokens', tokenDetail: (input, output) => `Input ${input} / output ${output}`, cacheTokens: 'Cache tokens',
    cacheDetail: (miss, read, creation) => `New ${miss} / hit ${read} / created ${creation}`, viewAria: 'Usage view', tabs: ['Request log', 'Providers', 'Models', 'Tools', 'Pricing'],
    filtersAria: 'Request filters', filterPlaceholder: 'Filter by model or tool…', filterAria: 'Filter requests by model or tool', statusAria: 'Filter by request status',
    statuses: ['All statuses', 'Success', 'Error'], details: 'Detailed records', detailsAria: 'Show detailed usage records', recordCount: (count) => `${count} ${count === 1 ? 'record' : 'records'}`, clearFilters: 'Clear filters',
    summaryOnly: 'Only summary metrics are shown. Enable detailed records to inspect individual model requests and tool calls, filter by model, tool, or status, and investigate costs or failures.',
    showDetails: 'Show details', filteredEmpty: 'No requests match these filters', requestEmpty: 'No request records',
    pricing: {
      title: 'Custom pricing overrides',
      description: 'Set input, output, and cache rates for a model; uncovered models continue using built-in pricing.',
      add: 'Add pricing', customize: 'Customize', edit: 'Edit', remove: 'Delete', reset: 'Reset', save: 'Save pricing', cancel: 'Cancel', saving: 'Saving…', removing: 'Deleting…',
      formAria: 'Custom model pricing form', modelKey: 'Model key', modelKeyPlaceholder: 'provider:model, for example openai:gpt-4o',
      inputRate: 'Input / 1M tokens', outputRate: 'Output / 1M tokens', cacheReadRate: 'Cache read / 1M tokens', cacheWriteRate: 'Cache write / 1M tokens',
      invalid: 'Enter a model key, input price, and output price. Prices must be numbers greater than or equal to 0.', loading: 'Loading pricing overrides…',
      loadFailed: 'Failed to load pricing overrides', retry: 'Retry pricing load', retrying: 'Retrying…', reconciliationRequired: 'Reload the latest pricing state before continuing to edit.',
      saveFailed: 'Failed to save pricing override', deleteFailed: 'Failed to delete pricing override', saved: 'Pricing override saved', removed: 'Pricing override deleted',
      removeTitle: (modelKey) => `Delete pricing override for ${modelKey}?`,
      removeDescription: (modelKey, effect) => effect === 'restore_builtin'
        ? `This removes the override for ${modelKey}. New model work will use built-in pricing; running work keeps its start-time pricing.`
        : `This removes the override for ${modelKey}. New model work becomes unpriced, not $0; running work keeps its start-time pricing.`,
      sourceBuiltin: 'Builtin', sourceCustomWithFallback: 'Custom · builtin fallback', sourceCustomOnly: 'Custom only',
      unavailable: 'The Host-backed Pricing port is not injected yet', reviewRequired: 'Pricing changed while you were editing. Review the latest values and save again.',
      savedRefreshFailed: 'Pricing was saved, but the latest pricing list could not be loaded.', outcomeUnknown: 'The write result is unknown. Refresh pricing before trying again.',
      actionsAria: 'Pricing override actions', noCache: 'Not set',
    },
    tables: {
      providersAria: 'Usage by provider', modelsAria: 'Usage by model', toolsAria: 'Usage by tool', pricingAria: 'Usage pricing configuration', requestsAria: 'Usage request log',
      providerHeaders: ['Provider', 'Requests', 'Tokens', 'Cost'], modelHeaders: ['Model', 'Requests', 'Tokens', 'Cost'], toolHeaders: ['Tool', 'Calls', 'Success', 'Errors', 'Average duration'],
      pricingHeaders: ['Provider', 'Model', 'Source', 'Input / 1M', 'Output / 1M', 'Cache read / 1M', 'Cache write / 1M', 'Actions'], requestHeaders: ['Time', 'Type', 'Target', 'Session', 'Tokens', 'Cost', 'Latency', 'Status'],
      noPricing: 'No pricing overrides', modelKind: 'Model', toolKind: 'Tool', openSession: (label) => `Open ${label}`, success: 'Success', error: 'Error',
      providerEmptyTitle: 'No provider usage', providerEmptyBody: 'After a model request, provider request counts, tokens, and costs appear here.',
      modelEmptyTitle: 'No model usage', modelEmptyBody: 'After a model request, request counts, tokens, and costs appear here by model.',
      toolEmptyTitle: 'No tool calls', toolEmptyBody: 'After an agent calls a tool, calls, successes, errors, and average duration appear here by tool.',
      pricingEmptyBody: 'Without pricing overrides, costs use the built-in model pricing table. Add custom prices here for specific models.',
    },
  },
} satisfies UiCatalog<UsageSettingsCopy>;

export function getUsageSettingsCopy(locale: UiLocale): UsageSettingsCopy {
  return SETTINGS_USAGE_COPY[locale];
}
