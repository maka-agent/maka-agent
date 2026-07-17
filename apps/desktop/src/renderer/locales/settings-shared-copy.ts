import type { UiCatalog, UiLocale } from '@maka/core';

export type SettingsSharedCopy = {
  modalLabel: string;
  contentLabel: string;
  sidebarLabel: string;
  navigationLabel: string;
  backToApp: string;
  close: string;
  loading: string;
  retry: string;
  save: string;
  cancel: string;
  copy: string;
  copied: string;
  failed: string;
  settingsLoadFailed: string;
  usageLoadFailed: string;
  unknownError: string;
  unavailablePage: string;
  ready: string;
};

const SETTINGS_SHARED_COPY_BY_LOCALE = {
  zh: {
    modalLabel: '设置',
    contentLabel: '设置内容',
    sidebarLabel: '设置侧栏',
    navigationLabel: '设置分组',
    backToApp: '返回应用',
    close: '关闭',
    loading: '正在加载设置',
    retry: '重试',
    save: '保存',
    cancel: '取消',
    copy: '复制',
    copied: '已复制',
    failed: '失败',
    settingsLoadFailed: '载入设置失败',
    usageLoadFailed: '载入使用统计失败',
    unknownError: '出现错误，请稍后重试。',
    unavailablePage: '该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。',
    ready: '就绪',
  },
  en: {
    modalLabel: 'Settings',
    contentLabel: 'Settings content',
    sidebarLabel: 'Settings sidebar',
    navigationLabel: 'Settings sections',
    backToApp: 'Back to app',
    close: 'Close',
    loading: 'Loading settings',
    retry: 'Try again',
    save: 'Save',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    failed: 'Failed',
    settingsLoadFailed: 'Could not load settings',
    usageLoadFailed: 'Could not load usage statistics',
    unknownError: 'Something went wrong. Try again.',
    unavailablePage: 'This page is part of the Maka settings tree and will activate with its runtime capability.',
    ready: 'Ready',
  },
} satisfies UiCatalog<SettingsSharedCopy>;

export function getSettingsSharedCopy(locale: UiLocale): SettingsSharedCopy {
  return SETTINGS_SHARED_COPY_BY_LOCALE[locale];
}
