"""Harbor OpenCode adapter wrapper with Maka benchmark cost metadata."""

from __future__ import annotations

import os
import shlex
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from trial_pricing import estimate_cost, pricing_from_env


class MakaOpenCodeAgent(OpenCode):
    """Run Harbor's OpenCode agent while normalizing trial cost fields."""

    _BRIDGED_ENV_KEYS = (
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
    )

    @staticmethod
    def name() -> str:
        return "opencode"

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        with self._bridged_env():
            await self._run_with_stop_sentinel(instruction, environment)
        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "OpenCode emitted error event(s): " + "; ".join(messages[:3])
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        self._apply_cost_metadata(context)

    @contextmanager
    def _bridged_env(self) -> Iterator[None]:
        previous: dict[str, str | None] = {}
        for key in self._BRIDGED_ENV_KEYS:
            value = self._get_env(key)
            if value is None:
                continue
            previous[key] = os.environ.get(key)
            os.environ[key] = value
        try:
            yield
        finally:
            for key, old_value in previous.items():
                if old_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = old_value

    def _apply_cost_metadata(self, context: AgentContext) -> None:
        totals = self._token_totals(context)
        reported_cost = context.cost_usd
        estimated_cost = context.cost_usd
        pricing_source = "opencode" if estimated_cost is not None else None

        pricing = pricing_from_env(self._get_env)
        if pricing is not None:
            estimated_cost = estimate_cost(totals, pricing)
            context.cost_usd = estimated_cost
            pricing_source = self._get_env("MAKA_TRIAL_PRICING_SOURCE") or "env"

        context.metadata = {
            **(context.metadata or {}),
            "opencode_input_tokens": totals["input"],
            "opencode_output_tokens": totals["output"],
            "opencode_cached_input_tokens": totals["cache_read"],
            "opencode_cache_hit_input_tokens": totals["cache_read"],
            "opencode_cache_miss_input_tokens": totals["cache_miss"],
            "opencode_cache_write_input_tokens": totals["cache_write"],
            "opencode_estimated_cost_usd": estimated_cost,
            "opencode_reported_cost_usd": reported_cost,
            "opencode_pricing_source": pricing_source or "missing_pricing",
        }

    async def _run_with_stop_sentinel(
        self,
        instruction: str,
        environment: BaseEnvironment,
    ) -> None:
        self._instruction = instruction
        escaped_instruction = shlex.quote(instruction)

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, _ = self.model_name.split("/", 1)
        env = self._provider_env(provider)
        env["OPENCODE_FAKE_VCS"] = "git"

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)

        mcp_command = self._build_register_config_command()
        if mcp_command:
            await self.exec_as_agent(environment, command=mcp_command, env=env)

        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        runner_path = self._stop_runner_path()
        grace_ms = self._stop_grace_ms()
        command = (
            ". ~/.nvm/nvm.sh; "
            f"node {shlex.quote(runner_path)} "
            "--output /logs/agent/opencode.txt "
            f"--grace-ms {grace_ms} "
            "-- "
            f"opencode --model={shlex.quote(self.model_name)} run --format=json "
            f"{cli_flags_arg}--thinking --dangerously-skip-permissions -- "
            f"{escaped_instruction}"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    def _stop_runner_path(self) -> str:
        maka_repo = self._get_env("MAKA_REPO_ROOT") or "/opt/maka-agent"
        return str(
            Path(maka_repo)
            / "packages"
            / "headless"
            / "harbor"
            / "opencode-stop-runner.mjs"
        )

    def _stop_grace_ms(self) -> int:
        raw = self._get_env("MAKA_OPENCODE_STOP_GRACE_MS")
        if raw is None:
            return 2000
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return 2000
        return max(0, value)

    def _provider_env(self, provider: str) -> dict[str, str]:
        keys: list[str] = []
        if provider == "amazon-bedrock":
            keys.extend(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"])
        elif provider == "anthropic":
            keys.append("ANTHROPIC_API_KEY")
        elif provider == "azure":
            keys.extend(["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])
        elif provider == "deepseek":
            keys.append("DEEPSEEK_API_KEY")
        elif provider == "github-copilot":
            keys.append("GITHUB_TOKEN")
        elif provider == "google":
            keys.extend(
                [
                    "GEMINI_API_KEY",
                    "GOOGLE_GENERATIVE_AI_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    "GOOGLE_CLOUD_PROJECT",
                    "GOOGLE_CLOUD_LOCATION",
                    "GOOGLE_GENAI_USE_VERTEXAI",
                    "GOOGLE_API_KEY",
                ]
            )
        elif provider == "groq":
            keys.append("GROQ_API_KEY")
        elif provider == "huggingface":
            keys.append("HF_TOKEN")
        elif provider == "llama":
            keys.append("LLAMA_API_KEY")
        elif provider == "mistral":
            keys.append("MISTRAL_API_KEY")
        elif provider == "openai":
            keys.extend(["OPENAI_API_KEY", "OPENAI_BASE_URL"])
        elif provider == "opencode":
            keys.append("OPENCODE_API_KEY")
        elif provider == "xai":
            keys.append("XAI_API_KEY")
        elif provider == "openrouter":
            keys.append("OPENROUTER_API_KEY")

        env: dict[str, str] = {}
        for key in keys:
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    def _token_totals(self, context: AgentContext) -> dict[str, int]:
        parsed = self._token_totals_from_stdout()
        if parsed is not None:
            return parsed

        input_tokens = int(getattr(context, "n_input_tokens", 0) or 0)
        output_tokens = int(getattr(context, "n_output_tokens", 0) or 0)
        cache_read = int(getattr(context, "n_cache_tokens", 0) or 0)
        cache_miss = max(0, input_tokens - cache_read)
        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": 0,
            "cache_miss": cache_miss,
        }

    def _token_totals_from_stdout(self) -> dict[str, int] | None:
        if not hasattr(self, "_parse_stdout"):
            return None
        events = self._parse_stdout()
        if not events:
            return None

        input_tokens = 0
        output_tokens = 0
        cache_read = 0
        cache_write = 0
        saw_tokens = False
        for event in events:
            if event.get("type") != "step_finish":
                continue
            part = event.get("part")
            if not isinstance(part, dict):
                continue
            tokens = part.get("tokens")
            if not isinstance(tokens, dict):
                continue
            saw_tokens = True
            step_input = _int_value(tokens.get("input"))
            step_output = _int_value(tokens.get("output"))
            cache = tokens.get("cache")
            step_cache_read = (
                _int_value(cache.get("read")) if isinstance(cache, dict) else 0
            )
            step_cache_write = (
                _int_value(cache.get("write")) if isinstance(cache, dict) else 0
            )
            input_tokens += step_input + step_cache_read
            output_tokens += step_output
            cache_read += step_cache_read
            cache_write += step_cache_write

        if not saw_tokens:
            return None

        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cache_miss": max(0, input_tokens - cache_read - cache_write),
        }

def _int_value(value: Any) -> int:
    return (
        int(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else 0
    )
