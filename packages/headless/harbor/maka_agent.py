"""Harbor adapter for running a Maka RuntimeRunner cell in the task workdir."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import re
import secrets
import shlex
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Step, Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from process_scope import (
    COMMAND_SCOPE_ENV as _COMMAND_SCOPE_ENV,
    COMMAND_SCOPE_ROOT as _COMMAND_SCOPE_ROOT,
    scoped_command as _scoped_command,
    scoped_command_cleanup_command as _scoped_command_cleanup_command,
    scoped_process_cleanup_command as _scoped_process_cleanup_command,
)
from trial_pricing import estimate_cost, pricing_from_env

# Default wall-clock budget for a single bridged tool command when the client
# does not request its own timeout. Matches the in-container executor floor
# (HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS = 120_000) rather than the whole-cell
# budget, so an individual command cannot silently borrow the 15-minute cell
# deadline.
_BRIDGE_DEFAULT_TIMEOUT_SEC = 120

# Location of this adapter and the repo it ships in. The task-run host mode
# spawns `node <repo>/packages/headless/dist/cli.js` on the host, so it needs to
# find the built headless CLI relative to this file when no explicit repo root
# env is set.
_HARBOR_DIR = Path(__file__).resolve().parent
_HEADLESS_DIR = _HARBOR_DIR.parent
_REPO_ROOT_DEFAULT = _HEADLESS_DIR.parent.parent
_DEFAULT_RUNNER_ENV = Path(
    os.environ.get(
        "MAKA_HARBOR_RUNNER_ENV_FILE",
        str(Path.home() / ".config" / "maka" / "harbor-runner.env"),
    )
)


_HOST_NODE_ENV_ALLOWLIST = {
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    # Windows-specific variables Node/OpenSSL need to initialize the CSPRNG
    # and resolve system paths when the host cell is launched from a subprocess.
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "COMSPEC",
}

def _host_node_process_env(cell_env: dict[str, str]) -> dict[str, str]:
    env = {key: value for key in _HOST_NODE_ENV_ALLOWLIST if (value := os.environ.get(key))}
    env.update(cell_env)
    return env


# 2^53 - 1, matches JS Number.MAX_SAFE_INTEGER so the TS host and this adapter
# agree on the upper bound for MAKA_CELL_TIMEOUT_SEC; an over-long digit string
# is malformed, not a giant timeout.
_MAX_SAFE_INTEGER = 9007199254740991
# ASCII decimal positive integer literal only; [0-9] (not \d) rejects Unicode
# digits on both sides. Matches the TS host's lenientPositiveIntEnv.
_POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")


class MakaAgent(BaseInstalledAgent):
    """Run Maka inside the Harbor task container and expose the shared cell output."""

    SUPPORTS_ATIF = True

    _RUN_LOG_FILENAME = "maka-run.log"
    _CELL_OUTPUT_FILENAME = "maka-cell-output.json"
    _CELL_USAGE_CHECKPOINT_FILENAME = "maka-cell-usage-checkpoint.json"

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
        CliFlag(
            "economy_task_mode",
            cli="",
            type="bool",
            default=False,
            env_fallback="MAKA_ECONOMY_TASK_MODE",
        ),
    ]

    @staticmethod
    def name() -> str:
        return "maka"

    def _harbor_mode(self) -> str:
        """cell (default) runs a RuntimeRunner cell; task-run runs the full
        task-run controller on the host and bridges tool execution into the
        container via the shared _ToolExecutorServer. task-run is the
        heavy-task / autonomous experiment path."""
        mode = (self._get_env("MAKA_HARBOR_MODE") or "cell").strip()
        if mode not in ("cell", "task-run"):
            raise RuntimeError(f"MAKA_HARBOR_MODE must be cell or task-run, got {mode!r}")
        return mode

    def get_version_command(self) -> str | None:
        # task-run runs Maka on the host, not in the container, so there is no
        # in-container binary to version-check.
        if self._harbor_mode() == "task-run":
            return None
        return "node --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if self._harbor_mode() == "task-run":
            # Host-bridge task-run: node and the headless CLI run on the host and
            # bridge tool execution into the task container, so nothing installs
            # inside the task. Fail fast if the built CLI is missing.
            cli_path = self._headless_cli_path()
            if not cli_path.is_file():
                raise RuntimeError(
                    f"headless CLI not built at {cli_path}; run `npm run build` in packages/headless"
                )
            return
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        self._harbor_backend()
        run_cell = (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs").as_posix()
        run_host_cell = (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-host-cell.mjs").as_posix()
        dist_index = (Path(maka_repo) / "packages" / "headless" / "dist" / "index.js").as_posix()
        dist_harbor_cell = (Path(maka_repo) / "packages" / "headless" / "dist" / "harbor-cell.js").as_posix()
        if self._host_side_llm_enabled():
            await self.exec_as_agent(
                environment,
                command=(
                    f"test -f {shlex.quote(run_host_cell)} && "
                    f"test -f {shlex.quote(dist_harbor_cell)}"
                ),
            )
            return
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
                f"test -f {shlex.quote(run_cell)} && "
                f"test -f {shlex.quote(run_host_cell)} && "
                f"test -f {shlex.quote(dist_index)}"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if self._harbor_mode() == "task-run":
            await self._run_task_run_host(instruction, environment, context)
            return
        agent_dir = EnvironmentPaths.agent_dir
        await self.exec_as_agent(environment, command=f"mkdir -p {agent_dir.as_posix()}")

        instruction_path = agent_dir / "instruction.txt"
        local_instruction_path = self.logs_dir / "instruction.txt"
        local_instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_instruction_path, instruction_path.as_posix())

        if self._host_side_llm_enabled():
            await self._run_host_cell(environment, local_instruction_path)
        else:
            run_cell_path = self._run_cell_path()
            env = self._cell_env(instruction_path)
            run_log_path = agent_dir / self._RUN_LOG_FILENAME
            shell_script = (
                "set -o pipefail; "
                f"node {shlex.quote(run_cell_path)} "
                f"2>&1 | tee {shlex.quote(run_log_path.as_posix())}"
            )
            command = f"bash -lc {shlex.quote(shell_script)}"
            await self.exec_as_agent(environment, command=command, env=env, timeout_sec=self._cell_timeout_sec())
            await self._download_cell_output(environment)
        output = self._read_cell_output(required=True)
        self._apply_cell_output(context, output)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._apply_cell_output(context)

    def _run_cell_path(self) -> str:
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        return (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs").as_posix()

    def _run_host_cell_path(self) -> str:
        maka_repo = self._get_env("MAKA_HOST_REPO_ROOT") or os.getcwd()
        return (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-host-cell.mjs").as_posix()

    def _host_repo_root(self) -> Path:
        override = self._get_env("MAKA_HOST_REPO_ROOT") or self._get_env("MAKA_REPO_DIR")
        return Path(override) if override else _REPO_ROOT_DEFAULT

    def _headless_cli_path(self) -> Path:
        return self._host_repo_root() / "packages" / "headless" / "dist" / "cli.js"

    _DEFAULT_CELL_TIMEOUT_SEC = 900
    _DEFAULT_CELL_SETTLEMENT_GRACE_SEC = 30

    def _cell_timeout_sec(self) -> int:
        """Wall-clock budget for the in-container cell. A hard-coded value turns
        slow-but-healthy tasks into infra failures, so the operator can raise it
        via MAKA_CELL_TIMEOUT_SEC; a malformed value falls back to the default.

        Accepted syntax is an ASCII decimal positive integer literal (no sign,
        no leading zero, no exponent/decimal form, no Unicode digits), and the
        value is capped at 2^53 - 1 (JS Number.MAX_SAFE_INTEGER). This matches
        the TS host's lenientPositiveIntEnv so both sides agree on exactly which
        strings are valid: "1e3", "1.0", "+1800", "01800", "1٢", and over-long
        digit strings all fall back to the default.
        """
        raw = self._get_env("MAKA_CELL_TIMEOUT_SEC")
        if not raw:
            return self._DEFAULT_CELL_TIMEOUT_SEC
        stripped = raw.strip()
        if _POSITIVE_INT_RE.fullmatch(stripped) is None:
            return self._DEFAULT_CELL_TIMEOUT_SEC
        try:
            value = int(stripped)
        except ValueError:
            # CPython caps integer-string conversion length; an over-long value
            # is malformed, not a giant timeout.
            return self._DEFAULT_CELL_TIMEOUT_SEC
        return value if value <= _MAX_SAFE_INTEGER else self._DEFAULT_CELL_TIMEOUT_SEC

    def _cell_settlement_grace_sec(self) -> int:
        raw = self._get_env("MAKA_CELL_SETTLEMENT_GRACE_SEC")
        if not raw:
            return self._DEFAULT_CELL_SETTLEMENT_GRACE_SEC
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return self._DEFAULT_CELL_SETTLEMENT_GRACE_SEC
        return value if value > 0 else self._DEFAULT_CELL_SETTLEMENT_GRACE_SEC

    def _cell_soft_timeout_ms(self) -> int:
        timeout_sec = self._cell_timeout_sec()
        grace_sec = self._cell_settlement_grace_sec()
        if grace_sec >= timeout_sec:
            raise RuntimeError(
                "MAKA_CELL_SETTLEMENT_GRACE_SEC must be smaller than MAKA_CELL_TIMEOUT_SEC"
            )
        return (timeout_sec - grace_sec) * 1000

    def _host_side_llm_enabled(self) -> bool:
        return bool(
            self._get_env("MAKA_HOST_API_KEY_FILE")
            or self._get_env("MAKA_HOST_API_KEY")
            or self._get_env("MAKA_HOST_NO_AUTH") == "true"
        )

    def _harbor_backend(self) -> str:
        backend = self._resolved_flags.get("backend", "") or self._get_env("MAKA_BACKEND") or "ai-sdk"
        if backend not in ("ai-sdk", "fake"):
            raise RuntimeError(f"backend={backend} is not supported by Maka Harbor v1; use backend=ai-sdk or backend=fake")
        return backend

    async def _run_host_cell(self, environment: BaseEnvironment, local_instruction_path: Path) -> None:
        container_cwd = await self._container_cwd(environment)
        async with _ToolExecutorServer(self, environment) as executor:
            env = self._host_cell_env(local_instruction_path, container_cwd, executor)
            run_log_path = self.logs_dir / self._RUN_LOG_FILENAME
            process = await asyncio.create_subprocess_exec(
                "node",
                self._run_host_cell_path(),
                cwd=self._get_env("MAKA_HOST_REPO_ROOT") or os.getcwd(),
                env=_host_node_process_env(env),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self._cell_timeout_sec())
            except BaseException as error:
                if process.returncode is None:
                    process.kill()
                stdout, stderr = await process.communicate()
                run_log_path.write_bytes(stdout + stderr)
                if isinstance(error, asyncio.TimeoutError):
                    raise RuntimeError(f"Maka host cell exceeded {self._cell_timeout_sec()}s") from error
                raise
            run_log_path.write_bytes(stdout + stderr)
            if process.returncode == 124:
                # run-host-cell uses 124 only after it has settled the runtime at
                # the soft deadline and persisted maka-cell-output.json. Freeze the
                # task before grading by reclaiming every process started through
                # this cell, including background commands that already returned
                # to the model but can still mutate packages or workspace files.
                executor.mark_reclaim_scoped_processes()
                return
            if process.returncode != 0:
                message = (stderr or stdout).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"Maka host cell exited {process.returncode}: {message}")

    async def _container_cwd(self, environment: BaseEnvironment) -> str:
        result = await self.exec_as_agent(environment, command="pwd")
        cwd = _exec_stdout(result).strip()
        return cwd or "."

    def _host_cell_env(self, local_instruction_path: Path, container_cwd: str, executor: "_ToolExecutorServer") -> dict[str, str]:
        env = self._cell_env(Path("/logs/agent/instruction.txt"))
        env["MAKA_INSTRUCTION_FILE"] = str(local_instruction_path)
        env["MAKA_OUTPUT_DIR"] = str(self.logs_dir)
        env["MAKA_STORAGE_ROOT"] = str(self.logs_dir / "maka-storage")
        env["MAKA_WORKDIR"] = container_cwd
        env["MAKA_HARBOR_TOOL_EXECUTOR_URL"] = executor.url
        env["MAKA_HARBOR_TOOL_EXECUTOR_TOKEN"] = executor.token
        env["MAKA_CELL_SOFT_TIMEOUT_MS"] = str(self._cell_soft_timeout_ms())
        for key in ("MAKA_HOST_API_KEY", "MAKA_HOST_API_KEY_FILE", "MAKA_HOST_API_KEY_ENV_NAME", "MAKA_HOST_BASE_URL"):
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    def _cell_env(self, instruction_path: Any) -> dict[str, str]:
        system_prompt = self._resolved_flags.get("system_prompt", "") or self._get_env("MAKA_SYSTEM_PROMPT") or ""
        model = self.model_name or self._get_env("MAKA_MODEL") or "deepseek/deepseek-v4-flash"
        backend = self._harbor_backend()
        provider = self._resolved_flags.get("provider", "") or self._get_env("MAKA_PROVIDER") or ""
        economy_task_flag = self._resolved_flags.get("economy_task_mode")
        economy_task_env = self._get_env("MAKA_ECONOMY_TASK_MODE")
        economy_task_mode = True if economy_task_flag is True else economy_task_env == "true"
        if backend == "ai-sdk" and not self._host_side_llm_enabled():
            raise RuntimeError("backend=ai-sdk requires host-side provider configuration")
        env = {
            "MAKA_BACKEND": backend,
            "MAKA_MODEL": model,
            "MAKA_INSTRUCTION_FILE": instruction_path.as_posix(),
            "MAKA_SYSTEM_PROMPT": system_prompt,
            "MAKA_OUTPUT_DIR": EnvironmentPaths.agent_dir.as_posix(),
            "MAKA_STORAGE_ROOT": (EnvironmentPaths.agent_dir / "maka-storage").as_posix(),
            "MAKA_ECONOMY_TASK_MODE": "true" if economy_task_mode else "false",
        }
        if provider:
            env["MAKA_PROVIDER"] = provider
        for key in (
            # Forward trial pricing so the in-container cell prices unknown models
            # (e.g. deepseek-v4-flash) the same way trial_pricing.py prices the trial;
            # otherwise the cell emits costUsd=0 and the controller flags every task.
            "MAKA_TRIAL_INPUT_USD_PER_1M",
            "MAKA_TRIAL_OUTPUT_USD_PER_1M",
            "MAKA_TRIAL_CACHE_READ_USD_PER_1M",
            "MAKA_TRIAL_CACHE_WRITE_USD_PER_1M",
            "MAKA_TRIAL_PRICING_SOURCE",
            "MAKA_REASONING_EFFORT",
            # Default per-command timeout floor for the in-container Bash tool, so
            # long builds/tests do not hit a hard-coded 2-minute ceiling.
            "MAKA_CELL_COMMAND_TIMEOUT_MS",
            # Benchmark-safe deterministic continuation. These are consumed by
            # run-host-cell.mjs/run-cell.mjs, not by the provider backend.
            "MAKA_HARBOR_CONTINUATION",
            "MAKA_HARBOR_CONTINUATION_MAX_TURNS",
            "MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS",
            "MAKA_HARBOR_CONTINUATION_PROMPT",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value
        for key, value in os.environ.items():
            if key.startswith("MAKA_CONTEXT_"):
                env[key] = value
        for key, value in getattr(self, "_extra_env", {}).items():
            if key.startswith("MAKA_CONTEXT_") and value is not None:
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
        deadline_settlement = output.get("deadlineSettlement")
        if (
            not isinstance(output.get("tokenSummary"), dict)
            and isinstance(deadline_settlement, dict)
            and deadline_settlement.get("source") == "benchmark.deadline"
        ):
            checkpoint_path = self.logs_dir / self._CELL_USAGE_CHECKPOINT_FILENAME
            try:
                checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                if isinstance(checkpoint, dict):
                    output["tokenSummary"] = checkpoint
                    output_path.write_text(f"{json.dumps(output, indent=2)}\n", encoding="utf-8")
            except (OSError, json.JSONDecodeError) as exc:
                self.logger.debug("Could not hydrate Maka deadline usage from %s: %s", checkpoint_path, exc)
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
            "maka_provider_visible_tool_count": _optional_int(output.get("toolSummary"), "providerVisibleToolCount"),
            "maka_actual_tool_calls": _optional_int(output.get("toolSummary"), "actualToolCalls"),
            "maka_actual_tool_names": _optional_string_list(output.get("toolSummary"), "actualToolNames"),
            "maka_actual_tool_call_counts": _optional_dict(output.get("toolSummary"), "actualToolCallCounts"),
        }
        self._write_trajectory(output)

    def _write_trajectory(self, output: dict[str, Any]) -> None:
        token_summary = output.get("tokenSummary")
        tool_summary = output.get("toolSummary")
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
                "provider_visible_tool_count": _optional_int(tool_summary, "providerVisibleToolCount"),
                "actual_tool_calls": _optional_int(tool_summary, "actualToolCalls"),
                "actual_tool_names": _optional_string_list(tool_summary, "actualToolNames"),
                "actual_tool_call_counts": _optional_dict(tool_summary, "actualToolCallCounts"),
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


    async def _run_task_run_host(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run the full task-run controller on the host, bridging tool execution
        into the task container."""
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        env = os.environ.copy()
        env.update(_load_env_file(_DEFAULT_RUNNER_ENV))
        env.update(getattr(self, "_extra_env", {}) or {})
        _normalize_cli_env(env)
        env.setdefault("MAKA_REPO_DIR", str(self._host_repo_root()))
        env.setdefault("MAKA_MODEL", "deepseek-chat")
        env.setdefault("MAKA_MAX_STEPS", "35")
        env.setdefault("MAKA_TASK_RUN_OUT_DIR", str(self.logs_dir / "maka-task-run"))
        task_run_out_dir = Path(env["MAKA_TASK_RUN_OUT_DIR"])
        if not task_run_out_dir.is_absolute():
            task_run_out_dir = task_run_out_dir.resolve()
            env["MAKA_TASK_RUN_OUT_DIR"] = str(task_run_out_dir)
        # _normalize_cli_env derives MAKA_OUTPUT_DIR/MAKA_STORAGE_ROOT from
        # MAKA_TASK_RUN_OUT_DIR; re-apply now that the out dir is finalized.
        env.setdefault("MAKA_OUTPUT_DIR", str(task_run_out_dir))
        env.setdefault("MAKA_STORAGE_ROOT", str(task_run_out_dir / "runs"))

        task_workdir, workdir_probe = await self._resolve_task_workdir(environment)

        stdout_path = self.logs_dir / "maka-harbor.stdout.json"
        stderr_path = self.logs_dir / "maka-harbor.stderr.log"
        status_path = self.logs_dir / "maka-harbor.status.json"
        instruction_path = self.logs_dir / "instruction.txt"
        started_at = _utc_now()
        task_run_out_dir.mkdir(parents=True, exist_ok=True)
        instruction_path.write_text(instruction, encoding="utf-8")
        stdout_path.write_bytes(b"")
        stderr_path.write_bytes(b"")
        self._write_status(
            status_path,
            {
                "status": "starting",
                "startedAt": started_at,
                "stdoutLog": str(stdout_path),
                "stderrLog": str(stderr_path),
                "taskRunOutDir": str(task_run_out_dir),
                "resolvedCwd": task_workdir,
                "workdirProbe": workdir_probe,
                "runnerEnv": _runner_env_summary(env),
            },
        )

        timeout_sec = int(env.get("MAKA_HARBOR_AGENT_TIMEOUT_SEC", "1800"))
        proc: asyncio.subprocess.Process | None = None
        async with _ToolExecutorServer(self, environment) as executor:
            env["MAKA_HARBOR_TOOL_EXECUTOR_URL"] = executor.url
            env["MAKA_HARBOR_TOOL_EXECUTOR_TOKEN"] = executor.token
            command = _headless_harbor_command(
                cli_path=self._headless_cli_path(),
                instruction_path=instruction_path,
                task_workdir=task_workdir,
                task_id=str(getattr(environment, "session_id", None) or env.get("MAKA_TASK_ID") or "terminal-bench-task"),
                out_dir=task_run_out_dir,
                env=env,
            )
            try:
                proc = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=str(self._host_repo_root()),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                )
                self._write_status(
                    status_path,
                    {
                        "status": "running",
                        "startedAt": started_at,
                        "updatedAt": _utc_now(),
                        "runnerPid": proc.pid,
                        "timeoutSec": timeout_sec,
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                stdout, stderr = await self._communicate_streaming(
                    proc=proc,
                    stdin_payload=b"",
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    timeout_sec=timeout_sec,
                )
            except asyncio.TimeoutError:
                self._write_status(
                    status_path,
                    {
                        "status": "timeout",
                        "startedAt": started_at,
                        "finishedAt": _utc_now(),
                        "runnerPid": proc.pid if proc else None,
                        "returnCode": proc.returncode if proc else None,
                        "timeoutSec": timeout_sec,
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                raise
            except Exception as exc:
                self._write_status(
                    status_path,
                    {
                        "status": "failed",
                        "startedAt": started_at,
                        "finishedAt": _utc_now(),
                        "runnerPid": proc.pid if proc else None,
                        "returnCode": proc.returncode if proc else None,
                        "error": str(exc),
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                raise

            # A non-zero runner exit is an infrastructure failure. Flag it inside
            # the executor scope so __aexit__ reclaims scoped background processes
            # instead of preserving them as if the run had completed. A clean exit
            # (return code 0) still preserves verifier-visible services.
            if proc is not None and proc.returncode != 0:
                executor.mark_reclaim_scoped_processes()

        parsed = self._parse_node_result(stdout)
        assert proc is not None
        self._write_status(
            status_path,
            {
                "status": "completed" if proc.returncode == 0 else "failed",
                "startedAt": started_at,
                "finishedAt": _utc_now(),
                "runnerPid": proc.pid,
                "returnCode": proc.returncode,
                "parsedStatus": parsed.get("status"),
                "benchmarkFailureKind": parsed.get("benchmarkFailureKind"),
                "benchmarkFailureShouldThrow": parsed.get("benchmarkFailureShouldThrow"),
                "stdoutBytes": len(stdout),
                "stderrBytes": len(stderr),
                "stdoutLog": str(stdout_path),
                "stderrLog": str(stderr_path),
                "taskRunOutDir": str(task_run_out_dir),
                "resolvedCwd": task_workdir,
                "workdirProbe": workdir_probe,
                "runnerEnv": _runner_env_summary(env),
                "command": _redacted_command(command),
            },
        )
        context.metadata = {
            **(context.metadata or {}),
            "maka_harbor": {
                "return_code": proc.returncode,
                "stdout_log": str(stdout_path),
                "stderr_log": str(stderr_path),
                "status": parsed.get("status"),
                "model": parsed.get("model"),
                "max_steps": parsed.get("maxSteps"),
                "autonomous": parsed.get("autonomous"),
                "autonomous_max_attempts": parsed.get("autonomousMaxAttempts"),
                "autonomous_max_runtime_steps": parsed.get("autonomousMaxRuntimeSteps"),
                "autonomous_max_wall_time_ms": parsed.get("autonomousMaxWallTimeMs"),
                "event_count": parsed.get("eventCount"),
                "message_count": parsed.get("messageCount"),
                "llm_call_count": parsed.get("llmCallCount"),
                "tool_call_count": parsed.get("toolCallCount"),
                "error": parsed.get("error"),
                "benchmark_failure_kind": parsed.get("benchmarkFailureKind"),
                "benchmark_failure_should_throw": parsed.get("benchmarkFailureShouldThrow"),
                "task_run": parsed.get("taskRun") or _task_run_summary(parsed),
                "resolved_cwd": task_workdir,
                "workdir_probe": workdir_probe,
            },
        }
        usage = parsed.get("tokenUsage") if isinstance(parsed, dict) else None
        if isinstance(usage, dict):
            context.n_input_tokens = _int_or_none(usage.get("input"))
            context.n_cache_tokens = _int_or_none(usage.get("cacheHitInput"))
            context.n_output_tokens = _int_or_none(usage.get("output"))

        if proc.returncode != 0:
            raise RuntimeError(f"Maka Harbor task-run failed; see {stderr_path}")

    async def _resolve_task_workdir(
        self,
        environment: BaseEnvironment,
    ) -> tuple[str, list[dict[str, Any]]]:
        configured = getattr(getattr(environment, "task_env_config", None), "workdir", None)
        candidates: list[str | None] = []
        if configured:
            candidates.append(str(configured))
        candidates.extend([None, "/app", "/workspace", "/"])

        seen: set[str] = set()
        probes: list[dict[str, Any]] = []
        for candidate in candidates:
            marker = "<default>" if candidate is None else candidate
            if marker in seen:
                continue
            seen.add(marker)
            # Probe with a bare exec: an invalid candidate directory makes `pwd`
            # exit non-zero, and that must skip to the next candidate rather than
            # abort the whole probe (exec_as_agent would raise on the first miss).
            result = await environment.exec(
                command="pwd",
                cwd=candidate,
                timeout_sec=10,
            )
            stdout = _exec_stdout(result).strip()
            stderr = _exec_stderr(result).strip()
            return_code = _exec_exit_code(result)
            probes.append(
                {
                    "candidate": marker,
                    "return_code": return_code,
                    "stdout": stdout,
                    "stderr": stderr,
                }
            )
            if return_code == 0:
                resolved = _last_absolute_path(stdout)
                if resolved:
                    return resolved, probes

        fallback = str(configured or "/")
        probes.append({"fallback": fallback})
        return fallback, probes

    async def _communicate_streaming(
        self,
        *,
        proc: asyncio.subprocess.Process,
        stdin_payload: bytes,
        stdout_path: Path,
        stderr_path: Path,
        timeout_sec: int,
    ) -> tuple[bytes, bytes]:
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []
        stdin_task = asyncio.create_task(self._write_process_stdin(proc, stdin_payload))
        stdout_task = asyncio.create_task(self._tee_stream(proc.stdout, stdout_path, stdout_chunks))
        stderr_task = asyncio.create_task(self._tee_stream(proc.stderr, stderr_path, stderr_chunks))

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
            await asyncio.wait_for(
                asyncio.gather(stdin_task, stdout_task, stderr_task),
                timeout=30,
            )
        except asyncio.TimeoutError:
            with stderr_path.open("ab") as handle:
                marker = {
                    "event": "maka_harbor_timeout",
                    "timeoutSec": timeout_sec,
                    "at": _utc_now(),
                }
                handle.write(("\n" + json.dumps(marker) + "\n").encode("utf-8"))
                handle.flush()
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=10)
            raise
        finally:
            for task in (stdin_task, stdout_task, stderr_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stdin_task, stdout_task, stderr_task, return_exceptions=True)

        return b"".join(stdout_chunks), b"".join(stderr_chunks)

    @staticmethod
    async def _write_process_stdin(
        proc: asyncio.subprocess.Process,
        payload: bytes,
    ) -> None:
        if proc.stdin is None:
            return
        try:
            proc.stdin.write(payload)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()
            with contextlib.suppress(Exception):
                await proc.stdin.wait_closed()

    @staticmethod
    async def _tee_stream(
        reader: asyncio.StreamReader | None,
        path: Path,
        chunks: list[bytes],
    ) -> None:
        if reader is None:
            return
        with path.open("ab") as handle:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                handle.write(chunk)
                handle.flush()

    @staticmethod
    def _write_status(path: Path, payload: dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def _parse_node_result(stdout: bytes) -> dict[str, Any]:
        text = stdout.decode("utf-8", errors="replace").strip()
        if not text:
            return {}
        # The runner writes one JSON object to stdout. If a dependency writes
        # noise, use the last JSON-looking line.
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return json.loads(line)
        return {}


class _ToolExecutorServer:
    def __init__(self, agent: MakaAgent, environment: BaseEnvironment) -> None:
        self._agent = agent
        self._environment = environment
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._futures: set[concurrent.futures.Future[Any]] = set()
        self._future_command_ids: dict[concurrent.futures.Future[Any], str] = {}
        self._futures_lock = threading.Lock()
        self._accepting_requests = False
        self._reclaim_scoped_processes = False
        self._command_cleanup_error: BaseException | None = None
        self.token = secrets.token_urlsafe(32)
        self.command_scope = secrets.token_urlsafe(24)
        self.url = ""

    async def __aenter__(self) -> "_ToolExecutorServer":
        self._loop = asyncio.get_running_loop()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name.
                outer._handle_post(self)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib callback name.
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        host, port = self._server.server_address
        self.url = f"http://{host}:{port}"
        with self._futures_lock:
            self._accepting_requests = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def mark_reclaim_scoped_processes(self) -> None:
        """Make teardown stop active scoped commands before returning.

        Callers use this after a settled deadline or a non-zero runner exit,
        where waiting for a bridged command to finish would either overrun the
        outer benchmark timeout or leave an orphan that can affect grading.
        """
        self._reclaim_scoped_processes = True

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        stop_error: BaseException | None = None
        cleanup_error: BaseException | None = None
        reclaim_scope = exc_type is not None or self._reclaim_scoped_processes
        try:
            cleanup_error = await self._stop_server(reclaim_scoped_processes=reclaim_scope)
        except BaseException as error:
            stop_error = error
        if stop_error is not None and not reclaim_scope:
            cleanup_error = await self._cleanup_all_scoped_processes()
        with self._futures_lock:
            command_cleanup_error = self._command_cleanup_error
        if stop_error is not None:
            raise stop_error
        if cleanup_error is not None:
            raise cleanup_error
        if command_cleanup_error is not None:
            raise command_cleanup_error

    async def _stop_server(self, *, reclaim_scoped_processes: bool) -> BaseException | None:
        with self._futures_lock:
            self._accepting_requests = False
            futures = list(self._futures)
        if reclaim_scoped_processes:
            cleanup_error = await self._drain_futures_with_cleanup(futures)
        else:
            cleanup_error = await self._drain_futures(futures)
        if self._server is not None:
            await asyncio.to_thread(self._server.shutdown)
            await asyncio.to_thread(self._server.server_close)
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, 5)
        return cleanup_error

    async def _drain_futures(
        self, futures: list[concurrent.futures.Future[Any]]
    ) -> None:
        if futures:
            await asyncio.gather(
                *(asyncio.wrap_future(future) for future in futures),
                return_exceptions=True,
            )

    async def _drain_futures_with_cleanup(
        self,
        futures: list[concurrent.futures.Future[Any]],
    ) -> BaseException | None:
        while any(not future.done() for future in futures):
            cleanup_error = await self._cleanup_processes(None)
            if cleanup_error is not None:
                for future in futures:
                    future.cancel()
                await self._drain_futures(futures)
                return cleanup_error
            await asyncio.sleep(0.2)
        await self._drain_futures(futures)
        return await self._cleanup_processes(None)

    async def _cleanup_processes(
        self, command_ids: list[str] | None
    ) -> BaseException | None:
        first_error: BaseException | None = None
        try:
            await self._cleanup_processes_with_signal(command_ids, "TERM")
        except BaseException as error:
            first_error = error
        await asyncio.sleep(0.2)
        try:
            await self._cleanup_processes_with_signal(command_ids, "KILL")
        except BaseException as error:
            if first_error is None:
                first_error = error
        return first_error

    async def _cleanup_all_scoped_processes(self) -> BaseException | None:
        return await self._cleanup_processes(None)

    async def _cleanup_processes_with_signal(
        self, command_ids: list[str] | None, signal: str
    ) -> None:
        command = (
            _scoped_process_cleanup_command(self.command_scope, signal)
            if command_ids is None
            else _scoped_command_cleanup_command(
                self.command_scope, command_ids, signal
            )
        )
        await self._agent.exec_as_agent(self._environment, command=command)

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path != "/exec":
            _write_http(handler, 404, {"error": "not found"})
            return
        if handler.headers.get("authorization") != f"Bearer {self.token}":
            _write_http(handler, 401, {"error": "unauthorized"})
            return
        command_id: str | None = None
        future: concurrent.futures.Future[Any] | None = None
        try:
            length = int(handler.headers.get("content-length") or "0")
            payload = json.loads(handler.rfile.read(length).decode("utf-8"))
            command = payload.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError("command is required")
            cwd = payload.get("cwd")
            timeout_ms = payload.get("timeoutMs")
            timeout_sec = _timeout_sec(timeout_ms) or _BRIDGE_DEFAULT_TIMEOUT_SEC
            command_id = secrets.token_urlsafe(12)
            assert self._loop is not None
            with self._futures_lock:
                if not self._accepting_requests:
                    raise RuntimeError("tool executor is shutting down")
                # Run the bridged tool command as a bare container exec, not via
                # exec_as_agent: a non-zero exit is a *successful* transport
                # response (the tool ran and reported a failure), and the agent's
                # _extra_env must never leak into the model's command environment.
                future = asyncio.run_coroutine_threadsafe(
                    self._environment.exec(
                        command=_scoped_command(
                            command,
                            self.command_scope,
                            command_id,
                        ),
                        cwd=cwd if isinstance(cwd, str) and cwd else None,
                        timeout_sec=timeout_sec,
                    ),
                    self._loop,
                )
                self._futures.add(future)
                self._future_command_ids[future] = command_id
            future.add_done_callback(self._discard_future)
            result = future.result(timeout=timeout_sec + 30)
            return_code = _exec_exit_code(result)
            _write_http(handler, 200, {
                "exitCode": return_code,
                "returnCode": return_code,
                "stdout": _exec_stdout(result),
                "stderr": _exec_stderr(result),
            })
        except Exception as exc:  # noqa: BLE001 - RPC boundary returns tool failure text.
            if command_id is not None and future is not None:
                cleanup_error = self._cleanup_failed_command(command_id)
                if cleanup_error is not None:
                    with self._futures_lock:
                        if self._command_cleanup_error is None:
                            self._command_cleanup_error = cleanup_error
            _write_http(handler, 500, {"error": str(exc)})

    def _cleanup_failed_command(self, command_id: str) -> BaseException | None:
        assert self._loop is not None
        cleanup = asyncio.run_coroutine_threadsafe(
            self._cleanup_processes([command_id]),
            self._loop,
        )
        try:
            return cleanup.result(timeout=30)
        except BaseException as error:
            return error

    def _discard_future(self, future: concurrent.futures.Future[Any]) -> None:
        with self._futures_lock:
            self._futures.discard(future)
            self._future_command_ids.pop(future, None)


def _write_http(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _timeout_sec(value: Any) -> int | None:
    if isinstance(value, (int, float)) and value > 0:
        return max(1, int((value + 999) // 1000))
    return None


def _exec_stdout(result: Any) -> str:
    value = getattr(result, "stdout", "")
    return value if isinstance(value, str) else ""


def _exec_stderr(result: Any) -> str:
    value = getattr(result, "stderr", "")
    return value if isinstance(value, str) else ""


def _exec_exit_code(result: Any) -> int:
    # Harbor 0.13.2 ExecResult exposes the exit status as `return_code`; the
    # other names stay for compatibility with older/stubbed exec results.
    for name in ("return_code", "exit_code", "exitCode", "returncode"):
        value = getattr(result, name, None)
        if isinstance(value, int):
            return value
    return 0


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


def _optional_string_list(value: Any, key: str) -> list[str] | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        return None
    return raw


def _optional_dict(value: Any, key: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return raw if isinstance(raw, dict) else None


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


# ---------------------------------------------------------------------------
# task-run host mode helpers
# ---------------------------------------------------------------------------


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _normalize_cli_env(env: dict[str, str]) -> None:
    provider = env.get("MAKA_PROVIDER") or env.get("MAKA_PROVIDER_TYPE")
    if provider:
        env.setdefault("MAKA_PROVIDER", provider)
    if env.get("MAKA_API_KEY"):
        env.setdefault(
            _provider_api_key_env(env.get("MAKA_PROVIDER") or provider or "deepseek"),
            env["MAKA_API_KEY"],
        )
    if env.get("MAKA_TASK_RUN_OUT_DIR"):
        env.setdefault("MAKA_OUTPUT_DIR", env["MAKA_TASK_RUN_OUT_DIR"])
        env.setdefault("MAKA_STORAGE_ROOT", str(Path(env["MAKA_TASK_RUN_OUT_DIR"]) / "runs"))
    if env.get("MAKA_HARBOR_MAX_ATTEMPTS"):
        env.setdefault("MAKA_MAX_ATTEMPTS", env["MAKA_HARBOR_MAX_ATTEMPTS"])
    if env.get("MAKA_AUTONOMOUS_MAX_ATTEMPTS"):
        env.setdefault("MAKA_MAX_ATTEMPTS", env["MAKA_AUTONOMOUS_MAX_ATTEMPTS"])
    if env.get("MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS"):
        env.setdefault("MAKA_MAX_RUNTIME_STEPS", env["MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS"])
    if env.get("MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC"):
        env.setdefault("MAKA_MAX_WALL_TIME_SEC", env["MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC"])
    if env.get("MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT"):
        env.setdefault(
            "MAKA_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
            env["MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT"],
        )
    if env.get("MAKA_HARBOR_HEAVY_TASK_MODE"):
        env.setdefault("MAKA_HEAVY_TASK_MODE", env["MAKA_HARBOR_HEAVY_TASK_MODE"])
    env.setdefault("MAKA_BACKEND", "ai-sdk")


def _provider_api_key_env(provider: str) -> str:
    if provider == "zai-coding-plan":
        return "ZAI_API_KEY"
    if provider == "moonshot":
        return "MOONSHOT_API_KEY"
    if provider == "google":
        return "GOOGLE_API_KEY"
    if provider in {"anthropic", "kimi-coding-plan", "claude-subscription"}:
        return "ANTHROPIC_API_KEY"
    if provider in {"openai", "openai-compatible"}:
        return "OPENAI_API_KEY"
    return "DEEPSEEK_API_KEY"


def _headless_harbor_command(
    *,
    cli_path: Path,
    instruction_path: Path,
    task_workdir: str,
    task_id: str,
    out_dir: Path,
    env: dict[str, str],
) -> list[str]:
    command = [
        "node",
        str(cli_path),
        "harbor",
        "run",
        "--mode",
        "task-run",
        "--backend",
        env.get("MAKA_BACKEND", "ai-sdk"),
        "--isolation",
        "harbor-http",
        "--instruction-file",
        str(instruction_path),
        "--workdir",
        task_workdir,
        "--task-id",
        task_id,
        "--task-run-id",
        env.get("MAKA_TASK_RUN_ID", f"harbor-{task_id}"),
        "--out",
        str(out_dir),
        "--storage-root",
        env.get("MAKA_STORAGE_ROOT", str(out_dir / "runs")),
        "--include-events",
    ]
    if env.get("MAKA_PROVIDER"):
        command.extend(["--provider", env["MAKA_PROVIDER"]])
    if env.get("MAKA_MODEL"):
        command.extend(["--model", env["MAKA_MODEL"]])
    if env.get("MAKA_HARBOR_USE_TASK_RUN") == "1" and env.get("MAKA_HARBOR_AUTONOMOUS", "1") != "0":
        command.append("--autonomous")
    if env.get("MAKA_HEAVY_TASK_MODE") in {"1", "true", "TRUE", "yes", "on", "enabled"}:
        command.append("--heavy-task")
    return command


def _redacted_command(command: list[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    for arg in command:
        if skip_next:
            redacted.append("<redacted>")
            skip_next = False
            continue
        redacted.append(arg)
        if arg in {"--api-key", "--api-key-file"}:
            skip_next = True
    return redacted


def _task_run_summary(parsed: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskRunId": parsed.get("taskRunId"),
        "status": parsed.get("status"),
        "taxonomy": parsed.get("taxonomy"),
        "scored": parsed.get("scored"),
        "authoritative": parsed.get("authoritative"),
        "exportDir": parsed.get("exportDir"),
        "files": parsed.get("files"),
        "result": parsed.get("result"),
    }


def _runner_env_summary(env: dict[str, str]) -> dict[str, str]:
    allowed_keys = [
        "MAKA_REPO_DIR",
        "MAKA_MODEL",
        "MAKA_MAX_STEPS",
        "MAKA_TASK_RUN_OUT_DIR",
        "MAKA_OUTPUT_DIR",
        "MAKA_STORAGE_ROOT",
        "MAKA_BACKEND",
        "MAKA_PROVIDER",
        "MAKA_HARBOR_MODE",
        "MAKA_HARBOR_USE_TASK_RUN",
        "MAKA_HARBOR_AUTONOMOUS",
        "MAKA_AUTONOMOUS",
        "MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
        "MAKA_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
        "MAKA_HEAVY_TASK_MODE",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_ARCHIVE_REQUIRED",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME",
        "MAKA_CONTEXT_ARCHIVE_RETRIEVAL",
        "MAKA_HARBOR_AGENT_TIMEOUT_SEC",
        "MAKA_HARBOR_MAX_ATTEMPTS",
        "MAKA_AUTONOMOUS_MAX_ATTEMPTS",
        "MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS",
        "MAKA_AUTONOMOUS_MAX_WALL_TIME_MS",
    ]
    return {key: env[key] for key in allowed_keys if key in env}


def _last_absolute_path(text: str) -> str | None:
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("/"):
            return stripped
    return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
