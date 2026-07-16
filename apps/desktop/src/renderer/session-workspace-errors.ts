const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

const SESSION_WORKSPACE_UNAVAILABLE_TOAST = {
  title: '工作目录不可用',
  description: '工作目录不存在或无法访问。请选择有效目录创建新任务。',
} as const;

export function showSessionWorkspaceUnavailableToast(
  toastApi: { error(title: string, description?: string): void },
): void {
  toastApi.error(
    SESSION_WORKSPACE_UNAVAILABLE_TOAST.title,
    SESSION_WORKSPACE_UNAVAILABLE_TOAST.description,
  );
}

export function isSessionWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const event = error as { code?: unknown; message?: unknown };
  return event.code === SESSION_WORKSPACE_UNAVAILABLE_CODE
    || (typeof event.message === 'string' && event.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`));
}
