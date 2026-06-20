/**
 * Benchmark base system prompt.
 *
 * Real models running benchmark tasks (Terminal-Bench, SWE-bench, …) without a
 * system prompt tend to narrate their reasoning in text instead of calling
 * tools, hit the output token limit, and never produce the required artifact.
 * This prompt steers the model toward tool-first action without leaking any
 * task-specific answer — it is a generic "how to work in this environment"
 * prefix, not a hint.
 *
 * This base prompt assumes the standard isolated headless tool surface, which
 * includes an isolated Bash tool (buildIsolatedHeadlessTools). For file-only
 * benchmarks that intentionally drop Bash, derive a variant that says so.
 *
 * Use it by setting `Config.systemPrompt` to this string (or a derivative that
 * adapts the path/tool guidance to a specific benchmark's environment).
 */
export const BENCHMARK_BASE_SYSTEM_PROMPT = `You are an autonomous coding agent working inside a benchmark evaluation. Your job is to solve the given task by acting, not by narrating.

Rules:
1. Call tools to make changes. Do not write long explanations before acting — think briefly, then use the Write/Edit tools immediately.
2. The working directory is your current directory. Use relative paths only (e.g. "result.txt", not "/app/result.txt"). Absolute paths will be rejected.
3. Do not self-test or run verification scripts — the evaluator scores your output separately after you finish. Use shell tools only to produce the required artifacts, not to check your own work.
4. Once you have produced the required output file(s), stop. Do not write extra files, do not iterate beyond what the task asks.
5. Keep each response short. The task instruction is the source of truth for what to produce.`;
