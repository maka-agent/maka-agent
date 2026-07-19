export interface ResumeParkToastCopy {
  title: string;
  description: string;
}

const RESUME_PARK_REASON_COPY: Readonly<Record<string, string>> = {
  dangling_tool_state: '上次工具执行中断，已安全保留记录，暂不能自动恢复。',
  pending_permission: '上次执行仍在等待权限确认。',
  background_operation_pending: '仍有后台操作未结束，暂不能安全恢复。',
  workspace_identity_mismatch: '当前工作区与中断时不一致。',
  workspace_identity_missing: '无法确认中断时的工作区。',
  workspace_cwd_mismatch: '当前工作目录与中断时不一致。',
  workspace_ref_missing: '中断时的工作区已不可用。',
  tool_catalog_mismatch: '可用工具已发生变化，无法安全继续。',
  checkpoint_restore_failed: '工作区检查点恢复失败。',
  source_run_unreadable: '上次运行记录无法完整读取。',
  runtime_ledger_unreadable: '上次运行账本无法完整读取。',
  runtime_ledger_empty: '上次运行没有可回放的记录。',
  terminal_repair_failed: '上次运行记录修复失败。',
  provider_resume_head_unsupported: '当前模型不支持这个恢复起点。',
  provider_resume_boundary_unsupported: '当前模型不支持这个恢复边界。',
  continuation_already_exists: '该中断任务已经创建过续跑。',
  resume_feature_disabled: '安全恢复功能尚未启用。',
};

export function resumeParkToastCopy(reasons: readonly string[]): ResumeParkToastCopy {
  if (reasons.length === 1 && reasons[0] === 'resume_candidate_missing') {
    return {
      title: '没有可恢复的对话',
      description: '会话已是最新状态。',
    };
  }

  const descriptions = [...new Set(
    reasons
      .map((reason) => RESUME_PARK_REASON_COPY[reason])
      .filter((description): description is string => description !== undefined),
  )];

  return {
    title: '暂时无法安全恢复',
    description: descriptions.length > 0
      ? descriptions.join(' ')
      : '当前会话不满足安全恢复条件。',
  };
}
