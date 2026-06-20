"""Harbor OpenCode adapter wrapper with Maka benchmark cost metadata."""

import os
from contextlib import contextmanager
from typing import Any, Iterator

from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


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

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        with self._bridged_env():
            await super().run(instruction, environment, context)

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
        estimated_cost = context.cost_usd
        pricing_source = "opencode" if estimated_cost is not None else None

        if estimated_cost is None:
            pricing = self._pricing_from_env()
            if pricing is not None:
                estimated_cost = _estimate_cost(totals, pricing)
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
            "opencode_pricing_source": pricing_source or "missing_pricing",
        }

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

    def _pricing_from_env(self) -> dict[str, float] | None:
        input_rate = _optional_float(self._get_env("MAKA_TRIAL_INPUT_USD_PER_1M"))
        output_rate = _optional_float(self._get_env("MAKA_TRIAL_OUTPUT_USD_PER_1M"))
        if input_rate is None or output_rate is None:
            return None
        return {
            "input": input_rate,
            "output": output_rate,
            "cache_read": _optional_float(
                self._get_env("MAKA_TRIAL_CACHE_READ_USD_PER_1M")
            )
            or 0.0,
            "cache_write": _optional_float(
                self._get_env("MAKA_TRIAL_CACHE_WRITE_USD_PER_1M")
            )
            or 0.0,
        }


def _estimate_cost(totals: dict[str, int], pricing: dict[str, float]) -> float:
    return (
        totals["cache_miss"] / 1_000_000 * pricing["input"]
        + totals["output"] / 1_000_000 * pricing["output"]
        + totals["cache_read"] / 1_000_000 * pricing["cache_read"]
        + totals["cache_write"] / 1_000_000 * pricing["cache_write"]
    )


def _int_value(value: Any) -> int:
    return (
        int(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else 0
    )


def _optional_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None
