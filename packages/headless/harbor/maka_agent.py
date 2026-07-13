"""Harbor adapter for running a Maka RuntimeRunner cell in the task workdir."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shlex
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Step, Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from trial_pricing import estimate_cost, pricing_from_env


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

    def get_version_command(self) -> str | None:
        return "node --version"

    async def install(self, environment: BaseEnvironment) -> None:
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

    _DEFAULT_CELL_TIMEOUT_SEC = 900

    def _cell_timeout_sec(self) -> int:
        """Wall-clock budget for the in-container cell. A hard-coded value turns
        slow-but-healthy tasks into infra failures, so the operator can raise it
        via MAKA_CELL_TIMEOUT_SEC; a malformed value falls back to the default."""
        raw = self._get_env("MAKA_CELL_TIMEOUT_SEC")
        if not raw:
            return self._DEFAULT_CELL_TIMEOUT_SEC
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return self._DEFAULT_CELL_TIMEOUT_SEC
        return value if value > 0 else self._DEFAULT_CELL_TIMEOUT_SEC

    def _host_side_llm_enabled(self) -> bool:
        return bool(self._get_env("MAKA_HOST_API_KEY_FILE") or self._get_env("MAKA_HOST_API_KEY"))

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
            raise RuntimeError("backend=ai-sdk requires MAKA_HOST_API_KEY or MAKA_HOST_API_KEY_FILE")
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


class _ToolExecutorServer:
    def __init__(self, agent: MakaAgent, environment: BaseEnvironment) -> None:
        self._agent = agent
        self._environment = environment
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.token = secrets.token_urlsafe(32)
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
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path != "/exec":
            _write_http(handler, 404, {"error": "not found"})
            return
        if handler.headers.get("authorization") != f"Bearer {self.token}":
            _write_http(handler, 401, {"error": "unauthorized"})
            return
        try:
            length = int(handler.headers.get("content-length") or "0")
            payload = json.loads(handler.rfile.read(length).decode("utf-8"))
            command = payload.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError("command is required")
            cwd = payload.get("cwd")
            timeout_ms = payload.get("timeoutMs")
            timeout_sec = _timeout_sec(timeout_ms)
            assert self._loop is not None
            future = asyncio.run_coroutine_threadsafe(
                self._agent.exec_as_agent(
                    self._environment,
                    command=command,
                    cwd=cwd if isinstance(cwd, str) and cwd else None,
                    timeout_sec=timeout_sec,
                ),
                self._loop,
            )
            result = future.result(timeout=(timeout_sec or self._agent._cell_timeout_sec()) + 30)
            _write_http(handler, 200, {
                "exitCode": _exec_exit_code(result),
                "stdout": _exec_stdout(result),
                "stderr": _exec_stderr(result),
            })
        except Exception as exc:  # noqa: BLE001 - RPC boundary returns tool failure text.
            _write_http(handler, 500, {"error": str(exc)})


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
    for name in ("exit_code", "exitCode", "returncode"):
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
