import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type {
  PromptAbCandidateTaskLimitResult,
  PromptAbMetadataFilterInput,
  PromptAbMetadataFilterResult,
} from './prompt-ab-types.js';

export function filterPromptAbCandidateTasksByMetadata(
  input: PromptAbMetadataFilterInput,
): PromptAbMetadataFilterResult {
  const maxExpertTimeEstimateMin = input.maxExpertTimeEstimateMin ?? 30;
  if (!Number.isFinite(maxExpertTimeEstimateMin) || maxExpertTimeEstimateMin <= 0) {
    throw new Error(
      `maxExpertTimeEstimateMin must be positive (got ${String(maxExpertTimeEstimateMin)})`,
    );
  }
  const selectedTasks: FixedPromptTask[] = [];
  const longExpertEstimateTaskIds: string[] = [];
  const missingExpertEstimateTaskIds: string[] = [];
  for (const task of input.tasks) {
    const expertTimeEstimateMin = task.metadata?.expertTimeEstimateMin;
    if (expertTimeEstimateMin === undefined) {
      missingExpertEstimateTaskIds.push(task.id);
    } else if (expertTimeEstimateMin > maxExpertTimeEstimateMin) {
      longExpertEstimateTaskIds.push(task.id);
    } else {
      selectedTasks.push(task);
    }
  }
  return {
    maxExpertTimeEstimateMin,
    candidateTaskCount: input.tasks.length,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    selectedTasks,
    rejected: {
      longExpertEstimateTaskIds,
      missingExpertEstimateTaskIds,
    },
  };
}

export function limitPromptAbCandidateTasks(
  tasks: readonly FixedPromptTask[],
  limit: number | undefined,
): PromptAbCandidateTaskLimitResult {
  const selectedTasks = limit === undefined ? [...tasks] : tasks.slice(0, limit);
  return {
    limit: limit ?? null,
    inputTaskCount: tasks.length,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    selectedTasks,
    truncatedTaskIds: tasks.slice(selectedTasks.length).map((task) => task.id),
  };
}
