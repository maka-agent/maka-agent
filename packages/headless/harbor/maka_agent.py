"""Harbor adapter for running a Maka RuntimeRunner cell in the task workdir."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Step, Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from trial_pricing import estimate_cost, pricing_from_env


class MakaAgent(BaseInstalledAgent):
    """Run Maka inside the Harbor task container and expose the shared cell output."""

    SUPPORTS_ATIF = True

    _RUN_LOG_FILENAME = "maka-run.log"
    _CELL_OUTPUT_FILENAME = "maka-cell-output.json"

    CLI_FLAGS = [
        CliFlag(
            "system_prompt",
            cli="",
            type="str",
            default="",
            env_fallback="MAKA_SYSTEM_PROMPT",
        ),
        CliFlag(
            "maka_repo",
            cli="",
            type="str",
            default="/opt/maka-agent",
            env_fallback="MAKA_REPO_ROOT",
        ),
        CliFlag(
            "backend",
            cli="",
            type="str",
            default="ai-sdk",
            env_fallback="MAKA_BACKEND",
        ),
        CliFlag(
            "provider",
            cli="",
            type="str",
            default="",
            env_fallback="MAKA_PROVIDER",
        ),
    ]

    @staticmethod
    def name() -> str:
        return "maka"

    def get_version_command(self) -> str | None:
        return "node --version"

    async def install(self, environment: BaseEnvironment) -> None:
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        run_cell = Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs"
        dist_index = Path(maka_repo) / "packages" / "headless" / "dist" / "index.js"
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0); "
                "if [ \"$NODE_MAJOR\" -lt 22 ]; then "
                "  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; "
                "  elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; "
                "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates; "
                "  fi; "
                "  export NVM_DIR=\"/usr/local/nvm\"; "
                "  mkdir -p \"$NVM_DIR\"; "
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | PROFILE=/dev/null bash; "
                "  . \"$NVM_DIR/nvm.sh\"; "
                "  nvm install 22; "
                "  nvm alias default 22; "
                "  chmod -R a+rX \"$NVM_DIR\"; "
                "  for bin in node npm npx; do "
                "    BIN_PATH=\"$(. \"$NVM_DIR/nvm.sh\" && which \"$bin\")\"; "
                "    ln -sf \"$BIN_PATH\" \"/usr/local/bin/$bin\"; "
                "  done; "
                "fi"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "node --version && "
                "NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]') && "
                "test \"$NODE_MAJOR\" -ge 22 && "
                f"test -f {shlex.quote(str(run_cell))} && "
                f"test -f {shlex.quote(str(dist_index))}"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agent_dir = EnvironmentPaths.agent_dir
        await self.exec_as_agent(environment, command=f"mkdir -p {agent_dir.as_posix()}")

        instruction_path = agent_dir / "instruction.txt"
        local_instruction_path = self.logs_dir / "instruction.txt"
        local_instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_instruction_path, instruction_path.as_posix())

        run_cell_path = self._run_cell_path()
        env = self._cell_env(instruction_path)
        run_log_path = agent_dir / self._RUN_LOG_FILENAME
        shell_script = (
            "set -o pipefail; "
            f"node {shlex.quote(run_cell_path)} "
            f"2>&1 | tee {shlex.quote(run_log_path.as_posix())}"
        )
        command = f"bash -lc {shlex.quote(shell_script)}"
        await self.exec_as_agent(environment, command=command, env=env, timeout_sec=900)
        await self._download_cell_output(environment)
        output = self._read_cell_output(required=True)
        self._apply_cell_output(context, output)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._apply_cell_output(context)

    def _run_cell_path(self) -> str:
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        return str(Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs")

    def _cell_env(self, instruction_path: Any) -> dict[str, str]:
        system_prompt = self._resolved_flags.get("system_prompt", "") or self._get_env("MAKA_SYSTEM_PROMPT") or ""
        model = self.model_name or self._get_env("MAKA_MODEL") or "deepseek/deepseek-chat"
        backend = self._resolved_flags.get("backend", "ai-sdk")
        provider = self._resolved_flags.get("provider", "") or self._get_env("MAKA_PROVIDER") or ""
        env = {
            "MAKA_BACKEND": backend,
            "MAKA_MODEL": model,
            "MAKA_INSTRUCTION_FILE": instruction_path.as_posix(),
            "MAKA_SYSTEM_PROMPT": system_prompt,
            "MAKA_OUTPUT_DIR": EnvironmentPaths.agent_dir.as_posix(),
            "MAKA_STORAGE_ROOT": (EnvironmentPaths.agent_dir / "maka-storage").as_posix(),
        }
        if provider:
            env["MAKA_PROVIDER"] = provider
        for key in (
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_BASE_URL",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "MOONSHOT_API_KEY",
            "GOOGLE_API_KEY",
            "ANTHROPIC_API_KEY",
            "ZAI_API_KEY",
            "ZAI_BASE_URL",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    async def _download_cell_output(self, environment: BaseEnvironment) -> None:
        remote = EnvironmentPaths.agent_dir / self._CELL_OUTPUT_FILENAME
        local = self.logs_dir / self._CELL_OUTPUT_FILENAME
        try:
            await environment.download_file(remote.as_posix(), local)
        except Exception as exc:  # noqa: BLE001 - best-effort metadata hydration.
            self.logger.debug("Could not download Maka cell output %s: %s", remote, exc)

    def _read_cell_output(self, *, required: bool) -> dict[str, Any] | None:
        output_path = self.logs_dir / self._CELL_OUTPUT_FILENAME
        if not output_path.exists():
            if required:
                raise RuntimeError(f"Maka cell did not write {self._CELL_OUTPUT_FILENAME}")
            return None
        try:
            output = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            if required:
                raise RuntimeError(f"Maka cell output is not valid JSON: {output_path}") from exc
            self.logger.debug("Could not read Maka cell output %s: %s", output_path, exc)
            return None
        if not isinstance(output, dict):
            if required:
                raise RuntimeError(f"Maka cell output must be a JSON object: {output_path}")
            self.logger.debug("Maka cell output %s was not a JSON object", output_path)
            return None
        return output

    def _apply_cell_output(self, context: AgentContext, output: dict[str, Any] | None = None) -> None:
        if output is None:
            output = self._read_cell_output(required=False)
        if output is None:
            return

        token_summary = output.get("tokenSummary")
        if isinstance(token_summary, dict):
            _apply_trial_pricing(self, token_summary)
            context.n_input_tokens = int(token_summary.get("input") or 0)
            context.n_output_tokens = int(token_summary.get("output") or 0)
            context.n_cache_tokens = int(
                token_summary.get("cachedInput")
                or token_summary.get("cacheHitInput")
                or 0
            )
            context.cost_usd = float(token_summary.get("costUsd") or 0)

        context.metadata = {
            **(context.metadata or {}),
            "maka_status": output.get("status"),
            "maka_error_class": output.get("errorClass"),
            "maka_prompt_hash": output.get("promptHash"),
            "maka_cell_output": str(self.logs_dir / self._CELL_OUTPUT_FILENAME),
            "maka_runtime_events": output.get("runtimeEventsPath"),
            "maka_cached_input_tokens": _optional_int(token_summary, "cachedInput"),
            "maka_cache_hit_input_tokens": _optional_int(token_summary, "cacheHitInput"),
            "maka_cache_miss_input_tokens": _optional_int(token_summary, "cacheMissInput"),
            "maka_cache_write_input_tokens": _optional_int(token_summary, "cacheWriteInput"),
            "maka_estimated_cost_usd": _optional_float(token_summary, "costUsd"),
            "maka_pricing_source": token_summary.get("pricingSource") if isinstance(token_summary, dict) else None,
        }
        self._write_trajectory(output)

    def _write_trajectory(self, output: dict[str, Any]) -> None:
        token_summary = output.get("tokenSummary")
        final_metrics = FinalMetrics(
            total_prompt_tokens=_optional_int(token_summary, "input"),
            total_completion_tokens=_optional_int(token_summary, "output"),
            total_cost_usd=_optional_float(token_summary, "costUsd"),
            total_steps=output.get("steps") if isinstance(output.get("steps"), int) else None,
            extra={
                "maka_status": output.get("status"),
                "maka_error_class": output.get("errorClass"),
                "maka_prompt_hash": output.get("promptHash"),
                "runtime_events_path": output.get("runtimeEventsPath"),
                "cached_input_tokens": _optional_int(token_summary, "cachedInput"),
                "cache_hit_input_tokens": _optional_int(token_summary, "cacheHitInput"),
                "cache_miss_input_tokens": _optional_int(token_summary, "cacheMissInput"),
                "cache_write_input_tokens": _optional_int(token_summary, "cacheWriteInput"),
                "estimated_cost_usd": _optional_float(token_summary, "costUsd"),
                "pricing_source": token_summary.get("pricingSource") if isinstance(token_summary, dict) else None,
            },
        )
        trajectory = Trajectory(
            session_id=(output.get("runtimeRefs") or {}).get("sessionId"),
            agent=Agent(name="maka", version=self.version() or "unknown", model_name=self.model_name),
            steps=[
                Step(step_id=1, source="user", message="Harbor task instruction"),
                Step(step_id=2, source="agent", message=f"Maka cell {output.get('status', 'finished')}"),
            ],
            final_metrics=final_metrics,
        )
        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8")
        except OSError as exc:
            self.logger.debug("Could not write Maka trajectory %s: %s", trajectory_path, exc)


def _optional_int(value: Any, key: str) -> int | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _optional_float(value: Any, key: str) -> float | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _apply_trial_pricing(agent: MakaAgent, token_summary: dict[str, Any]) -> None:
    pricing = pricing_from_env(agent._get_env)
    if pricing is None:
        return

    input_tokens = _optional_int(token_summary, "input") or 0
    output_tokens = _optional_int(token_summary, "output") or 0
    cache_read = (
        _optional_int(token_summary, "cachedInput")
        or _optional_int(token_summary, "cacheHitInput")
        or 0
    )
    cache_write = _optional_int(token_summary, "cacheWriteInput") or 0
    cache_miss = _optional_int(token_summary, "cacheMissInput")
    if cache_miss is None:
        cache_miss = max(0, input_tokens - cache_read - cache_write)

    token_summary["costUsd"] = estimate_cost(
        {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cache_miss": cache_miss,
        },
        pricing,
    )
    token_summary["pricingSource"] = agent._get_env("MAKA_TRIAL_PRICING_SOURCE") or "env"
