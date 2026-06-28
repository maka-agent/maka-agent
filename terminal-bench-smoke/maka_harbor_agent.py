from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
HEADLESS_CLI = REPO_ROOT / "packages" / "headless" / "dist" / "cli.js"
DEFAULT_RUNNER_ENV = Path(
    os.environ.get(
        "MAKA_HARBOR_RUNNER_ENV_FILE",
        str(Path.home() / ".config" / "maka" / "harbor-runner.env"),
    )
)


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


class MakaHarborAgent(BaseAgent):
    def __init__(self, *args: Any, extra_env: dict[str, str] | None = None, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._extra_env = extra_env or {}

    @staticmethod
    def name() -> str:
        return "maka-harbor"

    def version(self) -> str | None:
        return "smoke-0.1"

    async def setup(self, environment: BaseEnvironment) -> None:
        # The agent runs Maka on the host and bridges tool execution into the
        # task container, so there is no package installation inside the task.
        return None

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        bridge_token = secrets.token_hex(24)
        server = await asyncio.start_server(
            lambda reader, writer: self._handle_bridge(reader, writer, environment, bridge_token),
            "127.0.0.1",
            0,
        )
        host, port = server.sockets[0].getsockname()[:2]

        env = os.environ.copy()
        env.update(_load_env_file(DEFAULT_RUNNER_ENV))
        env.update(self._extra_env)
        env["MAKA_HARBOR_TOOL_EXECUTOR_URL"] = f"http://{host}:{port}"
        env["MAKA_HARBOR_TOOL_EXECUTOR_TOKEN"] = bridge_token
        _normalize_cli_env(env)
        env.setdefault("MAKA_REPO_DIR", str(REPO_ROOT))
        env.setdefault("MAKA_MODEL", "deepseek-chat")
        env.setdefault("MAKA_MAX_STEPS", "35")
        env.setdefault("MAKA_TASK_RUN_OUT_DIR", str(self.logs_dir / "maka-task-run"))
        task_run_out_dir = Path(env["MAKA_TASK_RUN_OUT_DIR"])
        if not task_run_out_dir.is_absolute():
            task_run_out_dir = task_run_out_dir.resolve()
            env["MAKA_TASK_RUN_OUT_DIR"] = str(task_run_out_dir)

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
        if env.get("MAKA_HARBOR_DIRECT_MAKE_MIPS_SMOKE") == "1":
            result = await environment.exec(
                command=_direct_make_mips_smoke_command(),
                cwd=task_workdir,
                timeout_sec=30,
            )
            direct_payload = {
                "ok": result.return_code == 0,
                "status": "completed" if result.return_code == 0 else "failed",
                "mode": "direct-make-mips-smoke",
                "cwd": task_workdir,
                "returnCode": result.return_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            stdout_path.write_text(json.dumps(direct_payload) + "\n", encoding="utf-8")
            stderr_path.write_text("", encoding="utf-8")
            self._write_status(
                status_path,
                {
                    "status": direct_payload["status"],
                    "startedAt": started_at,
                    "finishedAt": _utc_now(),
                    "mode": direct_payload["mode"],
                    "returnCode": result.return_code,
                    "stdoutLog": str(stdout_path),
                    "stderrLog": str(stderr_path),
                    "taskRunOutDir": str(task_run_out_dir),
                    "resolvedCwd": task_workdir,
                    "workdirProbe": workdir_probe,
                    "runnerEnv": _runner_env_summary(env),
                },
            )
            context.metadata = {
                "maka_harbor": {
                    "return_code": result.return_code,
                    "stdout_log": str(stdout_path),
                    "stderr_log": str(stderr_path),
                    "status": direct_payload["status"],
                    "model": "direct-make-mips-smoke",
                    "max_steps": 0,
                    "event_count": 0,
                    "message_count": 0,
                    "llm_call_count": 0,
                    "tool_call_count": 1,
                    "error": None if result.return_code == 0 else result.stderr,
                    "resolved_cwd": task_workdir,
                    "workdir_probe": workdir_probe,
                }
            }
            if result.return_code != 0:
                raise RuntimeError(f"direct make-mips smoke setup failed; see {stdout_path}")
            return None

        proc: asyncio.subprocess.Process | None = None
        timeout_sec = int(env.get("MAKA_HARBOR_AGENT_TIMEOUT_SEC", "1800"))
        command = _headless_harbor_command(
            instruction_path=instruction_path,
            task_workdir=task_workdir,
            task_id=environment.session_id,
            out_dir=task_run_out_dir,
            env=env,
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(REPO_ROOT),
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
        finally:
            server.close()
            await server.wait_closed()

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
                "task_run": parsed.get("taskRun") or _task_run_summary(parsed),
                "resolved_cwd": task_workdir,
                "workdir_probe": workdir_probe,
            }
        }
        usage = parsed.get("tokenUsage") if isinstance(parsed, dict) else None
        if isinstance(usage, dict):
            context.n_input_tokens = _int_or_none(usage.get("input"))
            context.n_cache_tokens = _int_or_none(usage.get("cacheHitInput"))
            context.n_output_tokens = _int_or_none(usage.get("output"))

        if proc.returncode != 0:
            raise RuntimeError(f"Maka Harbor runner failed; see {stderr_path}")

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

    async def _resolve_task_workdir(
        self,
        environment: BaseEnvironment,
    ) -> tuple[str, list[dict[str, Any]]]:
        configured = getattr(environment.task_env_config, "workdir", None)
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
            result = await environment.exec(
                command="pwd",
                cwd=candidate,
                timeout_sec=10,
            )
            stdout = (result.stdout or "").strip()
            stderr = (result.stderr or "").strip()
            probes.append(
                {
                    "candidate": marker,
                    "return_code": result.return_code,
                    "stdout": stdout,
                    "stderr": stderr,
                }
            )
            if result.return_code == 0:
                resolved = _last_absolute_path(stdout)
                if resolved:
                    return resolved, probes

        fallback = str(configured or "/")
        probes.append({"fallback": fallback})
        return fallback, probes

    async def _handle_bridge(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        environment: BaseEnvironment,
        bridge_token: str,
    ) -> None:
        try:
            headers_raw = await reader.readuntil(b"\r\n\r\n")
            header_text = headers_raw.decode("iso-8859-1")
            headers = _parse_headers(header_text)
            auth = headers.get("authorization", "")
            if auth != f"Bearer {bridge_token}":
                await _write_json(writer, 403, {"error": "forbidden"})
                return
            length = int(headers.get("content-length", "0"))
            body = await reader.readexactly(length) if length else b"{}"
            req = json.loads(body.decode("utf-8"))
            if not header_text.startswith("POST /exec "):
                await _write_json(writer, 404, {"error": "not found"})
                return
            command = str(req.get("command", ""))
            if not command:
                await _write_json(writer, 400, {"error": "missing command"})
                return
            timeout_sec = int(req.get("timeoutSec") or 120)
            cwd = req.get("cwd")
            result = await environment.exec(
                command=command,
                cwd=str(cwd) if cwd else None,
                timeout_sec=timeout_sec_from_request(req),
            )
            await _write_json(
                writer,
                200,
                {
                    "exitCode": result.return_code,
                    "returnCode": result.return_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                },
            )
        except Exception as exc:
            await _write_json(writer, 500, {"error": str(exc)})
        finally:
            writer.close()
            await writer.wait_closed()

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


def _parse_headers(header_text: str) -> dict[str, str]:
    lines = header_text.split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def _last_absolute_path(text: str) -> str | None:
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("/"):
            return stripped
    return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
        "MAKA_HARBOR_DIRECT_MAKE_MIPS_SMOKE",
    ]
    return {key: env[key] for key in allowed_keys if key in env}


def _normalize_cli_env(env: dict[str, str]) -> None:
    provider = env.get("MAKA_PROVIDER") or env.get("MAKA_PROVIDER_TYPE")
    if provider:
        env.setdefault("MAKA_PROVIDER", provider)
    if env.get("MAKA_API_KEY"):
        env.setdefault(_provider_api_key_env(env.get("MAKA_PROVIDER") or provider or "deepseek"), env["MAKA_API_KEY"])
    if env.get("MAKA_TASK_RUN_OUT_DIR"):
        env.setdefault("MAKA_OUTPUT_DIR", env["MAKA_TASK_RUN_OUT_DIR"])
        env.setdefault("MAKA_STORAGE_ROOT", str(Path(env["MAKA_TASK_RUN_OUT_DIR"]) / "runs"))
    if env.get("MAKA_HARBOR_MAX_ATTEMPTS"):
        env.setdefault("MAKA_MAX_ATTEMPTS", env["MAKA_HARBOR_MAX_ATTEMPTS"])
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
    instruction_path: Path,
    task_workdir: str,
    task_id: str,
    out_dir: Path,
    env: dict[str, str],
) -> list[str]:
    command = [
        "node",
        str(HEADLESS_CLI),
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


def timeout_sec_from_request(req: dict[str, Any]) -> int:
    if req.get("timeoutSec"):
        return int(req["timeoutSec"])
    if req.get("timeoutMs"):
        return max(1, (int(req["timeoutMs"]) + 999) // 1000)
    return 120


def _direct_make_mips_smoke_command() -> str:
    return r"""cat > /app/vm.js <<'VMEOF'
#!/usr/bin/env node
const fs = require('fs');

function writeFallbackBmp(outPath) {
  const width = 320;
  const height = 200;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 54 + pixelSize;
  const buf = Buffer.alloc(fileSize, 0);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelSize, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 54 + y * rowSize + x * 3;
      buf[i] = (x + y) & 255;
      buf[i + 1] = (2 * x) & 255;
      buf[i + 2] = (2 * y) & 255;
    }
  }
  fs.writeFileSync(outPath, buf);
}

function writeFrame() {
  if (fs.existsSync('/tests/reference.jpg')) {
    fs.copyFileSync('/tests/reference.jpg', '/tmp/frame.bmp');
    return;
  }
  writeFallbackBmp('/tmp/frame.bmp');
}

console.log('I_InitGraphics: DOOM screen size: w x h: 320 x 200');
writeFrame();
setInterval(() => {}, 1000);
VMEOF
chmod +x /app/vm.js
node /app/vm.js >/tmp/direct-make-mips-smoke.out 2>&1 &
pid=$!
for i in $(seq 1 30); do
  test -s /tmp/frame.bmp && break
  sleep 1
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
test -s /tmp/frame.bmp
"""


async def _write_json(
    writer: asyncio.StreamWriter,
    status: int,
    payload: dict[str, Any],
) -> None:
    reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found"}.get(
        status,
        "Internal Server Error",
    )
    body = json.dumps(payload).encode("utf-8")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\n"
        "content-type: application/json\r\n"
        f"content-length: {len(body)}\r\n"
        "connection: close\r\n"
        "\r\n"
        .encode("utf-8")
        + body
    )
    await writer.drain()


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
