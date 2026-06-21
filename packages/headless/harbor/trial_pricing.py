"""Shared trial pricing helpers for Harbor benchmark adapters."""

from __future__ import annotations

import math
from typing import Any, Callable, TypedDict

_INPUT_KEY = "MAKA_TRIAL_INPUT_USD_PER_1M"
_OUTPUT_KEY = "MAKA_TRIAL_OUTPUT_USD_PER_1M"
_CACHE_READ_KEY = "MAKA_TRIAL_CACHE_READ_USD_PER_1M"
_CACHE_WRITE_KEY = "MAKA_TRIAL_CACHE_WRITE_USD_PER_1M"
_PRICING_KEYS = (_INPUT_KEY, _OUTPUT_KEY, _CACHE_READ_KEY, _CACHE_WRITE_KEY)


class TrialPricing(TypedDict):
    input: float
    output: float
    cache_read: float
    cache_write: float


class TrialTokenTotals(TypedDict):
    input: int
    output: int
    cache_read: int
    cache_write: int
    cache_miss: int


def pricing_from_env(get_env: Callable[[str], Any]) -> TrialPricing | None:
    raw_values = {key: get_env(key) for key in _PRICING_KEYS}
    if all(_is_unset(value) for value in raw_values.values()):
        return None
    return {
        "input": _required_rate(raw_values[_INPUT_KEY], _INPUT_KEY),
        "output": _required_rate(raw_values[_OUTPUT_KEY], _OUTPUT_KEY),
        "cache_read": _optional_rate(raw_values[_CACHE_READ_KEY], _CACHE_READ_KEY),
        "cache_write": _optional_rate(raw_values[_CACHE_WRITE_KEY], _CACHE_WRITE_KEY),
    }


def estimate_cost(totals: TrialTokenTotals, pricing: TrialPricing) -> float:
    return (
        totals["cache_miss"] / 1_000_000 * pricing["input"]
        + totals["output"] / 1_000_000 * pricing["output"]
        + totals["cache_read"] / 1_000_000 * pricing["cache_read"]
        + totals["cache_write"] / 1_000_000 * pricing["cache_write"]
    )


def _required_rate(value: Any, key: str) -> float:
    if _is_unset(value):
        raise ValueError(f"{key} must be set when trial pricing is configured")
    return _parse_rate(value, key)


def _optional_rate(value: Any, key: str) -> float:
    if _is_unset(value):
        return 0.0
    return _parse_rate(value, key)


def _parse_rate(value: Any, key: str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        rate = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            rate = float(value)
        except ValueError:
            raise ValueError(f"{key} must be a finite non-negative number") from None
    else:
        raise ValueError(f"{key} must be a finite non-negative number")
    if not math.isfinite(rate) or rate < 0:
        raise ValueError(f"{key} must be a finite non-negative number")
    return rate


def _is_unset(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())
