export async function runAsyncActionBoundary(
  action: () => void | Promise<void>,
  onSettled: () => void,
): Promise<void> {
  try {
    await action();
  } catch {
    // The caller-owned action is responsible for visible error handling.
    // This boundary only prevents local pending chrome from leaking a rejection.
  } finally {
    onSettled();
  }
}
