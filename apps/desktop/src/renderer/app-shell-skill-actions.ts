import type { Dispatch, SetStateAction } from 'react';
import { generalizedErrorMessageChinese } from '@maka/core';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from '@maka/ui';
import { createSkillFailureCopy, openSkillFailureCopy } from './app-shell-copy';
import { createOpenSkillAction } from './app-shell-open-skill-action';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

export interface AppShellSkillActions {
  refreshSkills(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshManagedSkillSources(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshBundledSkillCatalog(options?: { shouldShowError?: () => boolean }): Promise<void>;
  createSkillTemplate(): Promise<void>;
  importManagedSkillSource(): Promise<void>;
  installManagedSkill(sourceId: string): Promise<void>;
  installBundledSkill(id: string): Promise<void>;
  previewManagedSkillUpdate(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  updateManagedSkill(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): Promise<boolean>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  deleteSkill(skillId: string): Promise<void>;
  openSkill(skillId: string): Promise<void>;
}

export function createAppShellSkillActions(deps: {
  isSkillsSurfaceActive: () => boolean;
  setSkills: Dispatch<SetStateAction<SkillEntry[]>>;
  setManagedSkillSources: Dispatch<SetStateAction<ManagedSkillSourceEntry[]>>;
  setBundledSkillCatalog: Dispatch<SetStateAction<BundledSkillCatalogEntry[]>>;
  toastApi: ToastApi;
}): AppShellSkillActions {
  const { isSkillsSurfaceActive, setBundledSkillCatalog, setManagedSkillSources, setSkills, toastApi } = deps;
  const openSkill = createOpenSkillAction({ isSkillsSurfaceActive, toastApi });

  async function refreshSkills(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.list();
      setSkills(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error('刷新技能失败', generalizedErrorMessageChinese(error, '刷新技能失败，请稍后重试。'));
      }
    }
  }

  async function refreshManagedSkillSources(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.sources.list();
      setManagedSkillSources(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error('刷新来源库失败', generalizedErrorMessageChinese(error, '刷新来源库失败，请稍后重试。'));
      }
    }
  }

  async function refreshBundledSkillCatalog(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.catalog.list();
      setBundledSkillCatalog(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error('刷新内置技能失败', generalizedErrorMessageChinese(error, '刷新内置技能失败，请稍后重试。'));
      }
    }
  }

  async function installBundledSkill(id: string) {
    try {
      const result = await window.maka.skills.catalog.install(id);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法安装内置 Skill', managedInstallFailureCopy(result.reason));
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshBundledSkillCatalog({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) toastApi.success('已安装内置 Skill', `${result.skill.id}/SKILL.md 已放到当前工作区。`);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法安装内置 Skill', generalizedErrorMessageChinese(error, '无法安装内置 Skill，请稍后重试。'));
      }
    }
  }

  async function createSkillTemplate() {
    try {
      const result = await window.maka.skills.createStarter();
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法创建示例技能', createSkillFailureCopy(result.reason));
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (!isSkillsSurfaceActive()) return;
      // Idempotent seeding: a repeat 添加 click reuses the existing 示例技能
      // instead of minting a duplicate. Tell the user we opened the existing
      // one rather than pretending a new skill was created.
      if (result.created) {
        toastApi.success('已创建示例技能', `${result.skill.id}/SKILL.md 已放到工作区 skills 目录。`);
      } else {
        toastApi.success('已打开现有示例技能', '示例技能已存在，直接打开了 SKILL.md（不会重复创建）。');
      }
      const openResult = await window.maka.skills.open(result.skill.id, 'file');
      if (!openResult.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法打开示例技能', openSkillFailureCopy(openResult.reason));
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法创建示例技能', generalizedErrorMessageChinese(error, '无法创建示例技能，请稍后重试。'));
      }
    }
  }

  async function importManagedSkillSource() {
    try {
      const result = await window.maka.skills.sources.importLocalFile();
      if (!result.ok) {
        if (result.reason !== 'cancelled' && isSkillsSurfaceActive()) {
          toastApi.error('无法导入 Skill 来源', managedSourceFailureCopy(result.reason));
        }
        return;
      }
      await refreshManagedSkillSources({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) toastApi.success('已导入 Skill 来源', result.source.name);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法导入 Skill 来源', generalizedErrorMessageChinese(error, '无法导入 Skill 来源，请稍后重试。'));
      }
    }
  }

  async function installManagedSkill(sourceId: string) {
    try {
      const result = await window.maka.skills.installManaged(sourceId);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法安装 Skill', managedInstallFailureCopy(result.reason));
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshManagedSkillSources({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) toastApi.success('已安装 Skill', `${result.skill.id}/SKILL.md 已放到当前工作区。`);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法安装 Skill', generalizedErrorMessageChinese(error, '无法安装 Skill，请稍后重试。'));
      }
    }
  }

  async function previewManagedSkillUpdate(skillId: string): Promise<ManagedSkillUpdatePreview | null> {
    try {
      const result = await window.maka.skills.previewUpdate(skillId);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法预览 Skill 更新', managedPreviewFailureCopy(result.reason));
        return null;
      }
      return result.preview;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法预览 Skill 更新', generalizedErrorMessageChinese(error, '无法预览 Skill 更新，请稍后重试。'));
      }
      return null;
    }
  }

  async function updateManagedSkill(skillId: string, options: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string } = {}): Promise<boolean> {
    try {
      const result = await window.maka.skills.updateManaged(skillId, options);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法更新 Skill', managedUpdateFailureCopy(result.reason));
        return false;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(options.force ? '已覆盖更新 Skill' : '已更新 Skill', `${result.skill.id}/SKILL.md 已更新到来源库版本。`);
      }
      return true;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法更新 Skill', generalizedErrorMessageChinese(error, '无法更新 Skill，请稍后重试。'));
      }
      return false;
    }
  }

  async function setSkillEnabled(skillId: string, enabled: boolean) {
    try {
      const result = await window.maka.skills.setEnabled(skillId, enabled);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法切换 Skill', skillRuntimeFailureCopy(result.reason));
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(enabled ? '已启用 Skill' : '已停用 Skill', `${result.skill.name} 已更新当前项目的运行状态。`);
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法切换 Skill', generalizedErrorMessageChinese(error, '无法切换 Skill，请稍后重试。'));
      }
    }
  }

  async function deleteSkill(skillId: string) {
    try {
      const result = await window.maka.skills.delete(skillId);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error('无法删除 Skill', deleteSkillFailureCopy(result.reason));
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      // A deleted bundled skill must reappear as installable under 内置, so
      // refresh the catalog's installed flags after removal.
      await refreshBundledSkillCatalog({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) toastApi.success('已删除 Skill', `${skillId} 已从当前工作区移除。`);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error('无法删除 Skill', generalizedErrorMessageChinese(error, '无法删除 Skill，请稍后重试。'));
      }
    }
  }

  return {
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    createSkillTemplate,
    importManagedSkillSource,
    installManagedSkill,
    installBundledSkill,
    previewManagedSkillUpdate,
    updateManagedSkill,
    setSkillEnabled,
    deleteSkill,
    openSkill,
  };
}

function managedSourceFailureCopy(reason: 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' | 'cancelled'): string {
  if (reason === 'invalid_skill') return '请选择有效的 SKILL.md 文件。';
  if (reason === 'already_exists') return '来源库里已经有同名 Skill。';
  if (reason === 'blocked_path') return '该文件路径不允许导入。';
  if (reason === 'write_failed') return '写入来源库失败，请检查文件权限。';
  return '已取消。';
}

function managedInstallFailureCopy(reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed'): string {
  if (reason === 'not_found') return '没有找到这个 Skill 来源。';
  if (reason === 'already_exists') return '当前工作区已经有同名 Skill。';
  if (reason === 'blocked_path') return '目标路径不允许写入。';
  return '写入工作区失败，请检查文件权限。';
}

function managedUpdateFailureCopy(reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed'): string {
  if (reason === 'not_managed') return '这个 Skill 不是受管理来源。';
  if (reason === 'source_missing') return '来源库中找不到对应来源。';
  if (reason === 'local_modified') return '工作区副本已经被修改。请打开本地文件和来源文件手动比较后再更新。';
  if (reason === 'metadata_error') return 'Skill 元数据异常，不能安全更新。';
  if (reason === 'blocked_path') return '目标路径不允许写入。';
  return '写入工作区失败，请检查文件权限。';
}

function managedPreviewFailureCopy(reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed'): string {
  if (reason === 'not_managed') return '这个 Skill 不是受管理来源。';
  if (reason === 'source_missing') return '来源库中找不到对应来源。';
  if (reason === 'metadata_error') return 'Skill 元数据异常，不能安全预览。';
  if (reason === 'blocked_path') return '目标路径不允许读取。';
  return '读取 Skill 内容失败，请检查文件权限。';
}

function deleteSkillFailureCopy(reason: 'not_found' | 'blocked_path' | 'delete_failed'): string {
  if (reason === 'not_found') return '当前工作区找不到这个 Skill。';
  if (reason === 'blocked_path') return 'Skill 路径不允许删除。';
  return '删除 Skill 失败，请检查文件权限。';
}

function skillRuntimeFailureCopy(reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed'): string {
  if (reason === 'not_found') return '当前工作区找不到这个 Skill。';
  if (reason === 'blocked_path') return 'Skill 状态路径不允许写入。';
  if (reason === 'state_error') return '当前工作区的 Skill 状态文件异常，需要先修复。';
  return '写入当前项目的 Skill 状态失败，请检查文件权限。';
}
