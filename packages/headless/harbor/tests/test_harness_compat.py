"""Behavior contract for the harbor/pier harness-tree selection.

Pier 0.3.0 (Datacurve's Harbor fork) builds a trial by calling
``agent.install_spec()`` and ``agent.network_allowlist()``
(``pier/trial/execution.py`` -> ``_create_environment``) and validates
``TrialResult.agent_info`` against ``pier.models.trial.result.AgentInfo``
(``pier/trial/trial.py`` -> ``run``). Plain Harbor 0.13.2 has none of that and
its parallel classes are type-incompatible with Pier's. ``harness_compat``
selects the tree at import time; these tests lock:

- under Pier: the adapters subclass Pier's BaseInstalledAgent, their
  ``to_agent_info()`` returns Pier's AgentInfo (the exact DeepSWE pilot
  failure), and install_spec/network_allowlist return the shapes and raise the
  configuration errors Pier consumes;
- under plain Harbor (real, or simulated via meta-path poisoning of ``pier``):
  the harbor tree is selected and the modules import and instantiate cleanly;
- a pier package that exists but fails its own import re-raises instead of
  silently falling back to the compat harbor tree.

Run under an interpreter that has Harbor or Pier installed, e.g. either uv tool
venv (pytest is optional; a ``__main__`` runner executes every ``test_*``
function). Setting ``MAKA_HARNESS_COMPAT_EXPECT=pier`` turns missing pier
coverage into a failure instead of a skip:

    ~/.local/share/uv/tools/datacurve-pier/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
    ~/.local/share/uv/tools/harbor/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

_HARBOR_DIR = Path(__file__).resolve().parent.parent
if str(_HARBOR_DIR) not in sys.path:
    sys.path.insert(0, str(_HARBOR_DIR))

_ADAPTER_MODULES = ("harness_compat", "maka_agent", "kimi_code_agent")

# Sentinel returned by tests that cannot run under this interpreter; the
# __main__ runner counts these as skips, not passes. pytest treats the return
# value as a no-op, so the file stays runnable either way.
SKIPPED = object()

try:
    from pier.agents.installed.base import BaseInstalledAgent as PierBaseInstalledAgent
    from pier.models.agent.network import NetworkAllowlist
    from pier.models.trial.result import AgentInfo as PierAgentInfo

    _PIER_IMPORTABLE = True
except ImportError:  # pragma: no cover - depends on the running interpreter
    NetworkAllowlist = None  # type: ignore[assignment]
    _PIER_IMPORTABLE = False


def _pier_gate() -> bool:
    """True when pier-tree coverage can run under this interpreter.

    With MAKA_HARNESS_COMPAT_EXPECT=pier, expected-but-unavailable pier
    coverage is a failure, not a skip, so a misconfigured pier-side CI job
    cannot go green while silently testing nothing.
    """
    if _PIER_IMPORTABLE:
        return True
    if os.environ.get("MAKA_HARNESS_COMPAT_EXPECT") == "pier":
        raise AssertionError(
            "MAKA_HARNESS_COMPAT_EXPECT=pier but pier is not importable"
        )
    return False


def _fresh_adapters():
    for name in _ADAPTER_MODULES:
        sys.modules.pop(name, None)
    return (
        importlib.import_module("maka_agent"),
        importlib.import_module("kimi_code_agent"),
    )


def _raises(callable_, exception_type, *fragments) -> None:
    try:
        callable_()
    except exception_type as error:
        text = str(error)
        for fragment in fragments:
            assert fragment in text, (fragment, text)
        return
    raise AssertionError(f"expected {exception_type.__name__}")


class _RaisingPierFinder:
    """Meta-path finder that makes ``import pier`` raise a chosen error."""

    def __init__(self, error_factory) -> None:
        self._error_factory = error_factory

    def find_spec(self, name, path=None, target=None):  # noqa: ANN001, ARG002
        if name == "pier" or name.startswith("pier."):
            raise self._error_factory(name)
        return None


def _without_pier_modules():
    saved = {
        key: mod
        for key, mod in sys.modules.items()
        if key == "pier" or key.startswith("pier.")
    }
    for key in list(saved):
        del sys.modules[key]
    for key in _ADAPTER_MODULES:
        sys.modules.pop(key, None)
    return saved


def _restore_modules(saved_pier) -> None:
    for key in _ADAPTER_MODULES:
        sys.modules.pop(key, None)
    sys.modules.update(saved_pier)


def test_pier_tree_selected_and_agent_info_is_pier_type():
    if not _pier_gate():
        return SKIPPED
    maka_mod, kimi_mod = _fresh_adapters()
    for cls in (maka_mod.MakaAgent, kimi_mod.MakaKimiCodeAgent):
        assert issubclass(cls, PierBaseInstalledAgent), cls.__mro__
        agent = cls(logs_dir=Path("/tmp"), model_name="k3")
        # The DeepSWE pilot failed pydantic validation because agent_info was a
        # harbor-tree AgentInfo; Pier's TrialResult only accepts its own type.
        info = agent.to_agent_info()
        assert isinstance(info, PierAgentInfo), type(info)
        assert agent.install_spec() is None


def test_maka_agent_network_policy_under_pier():
    if not _pier_gate():
        return SKIPPED
    maka_mod, _ = _fresh_adapters()

    # Host-side LLM mode: model calls happen on the host, container is offline.
    host_side = maka_mod.MakaAgent(
        logs_dir=Path("/tmp"), extra_env={"MAKA_HOST_NO_AUTH": "true"}
    )
    allow = host_side.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == []

    # The inert fake backend makes no model calls at all. Configure it via the
    # CLI_FLAGS kwarg: in both harbor 0.13.2 and pier 0.3.0 env_fallback reads
    # os.environ only, so extra_env cannot set a flag with a truthy default.
    fake = maka_mod.MakaAgent(logs_dir=Path("/tmp"), backend="fake")
    assert fake.network_allowlist().domains == []

    # backend=ai-sdk without host-side provider config would need in-container
    # egress the empty allowlist forbids; fail at environment creation instead.
    mismatched = maka_mod.MakaAgent(logs_dir=Path("/tmp"))
    _raises(
        mismatched.network_allowlist,
        RuntimeError,
        "host-side provider configuration",
        "backend=fake",
    )


def test_kimi_agent_network_shape_under_pier():
    if not _pier_gate():
        return SKIPPED
    _, kimi_mod = _fresh_adapters()

    configured = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://api.kimi.com/coding/v1"},
    )
    allow = configured.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == ["api.kimi.com"]

    proxied = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    # Domain only: host is extracted, port/path/scheme are dropped.
    assert proxied.network_allowlist().domains == ["proxy.internal"]

    # No fallback domain: a missing proxy URL fails at allowlist time with the
    # same error _runtime_env raises, instead of granting spurious egress.
    unset = kimi_mod.MakaKimiCodeAgent(logs_dir=Path("/tmp"))
    _raises(
        unset.network_allowlist,
        ValueError,
        "Kimi Code requires the host provider proxy",
    )

    # Pier's NetworkAllowlist rejects ':' domains, so IPv6 literals cannot be
    # allowlisted; the adapter refuses them explicitly.
    ipv6 = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://[2001:db8::1]:8443/v1"},
    )
    _raises(ipv6.network_allowlist, ValueError, "IPv6")


def test_harbor_tree_used_without_pier():
    saved_pier = _without_pier_modules()
    finder = _RaisingPierFinder(
        lambda name: ModuleNotFoundError(f"pier blocked for test: {name}", name=name)
    )
    sys.meta_path.insert(0, finder)
    try:
        from harbor.agents.installed.base import (
            BaseInstalledAgent as HarborBaseInstalledAgent,
        )

        compat = importlib.import_module("harness_compat")
        assert compat.IS_PIER is False
        assert compat.NetworkAllowlist is None
        maka = importlib.import_module("maka_agent")
        kimi = importlib.import_module("kimi_code_agent")
        for cls in (maka.MakaAgent, kimi.MakaKimiCodeAgent):
            # The plain-Harbor path must keep subclassing the harbor tree so
            # Terminal-Bench's Harbor 0.13.2 runner keeps validating its own
            # AgentInfo type.
            assert issubclass(cls, HarborBaseInstalledAgent), cls.__mro__
            agent = cls(logs_dir=Path("/tmp"))
            # Pier-only hooks stay resolvable but inert under plain Harbor:
            # they return None before any mode or proxy-URL validation runs.
            assert agent.install_spec() is None
            assert agent.network_allowlist() is None
    finally:
        sys.meta_path.remove(finder)
        _restore_modules(saved_pier)


def test_broken_pier_install_reraises():
    # A pier package that exists but fails its own import (here: a missing
    # dependency) must re-raise instead of silently selecting the compat
    # harbor tree, which would reproduce the TrialResult.agent_info failure.
    saved_pier = _without_pier_modules()
    finder = _RaisingPierFinder(
        lambda name: ModuleNotFoundError("No module named 'socksio'", name="socksio")
    )
    sys.meta_path.insert(0, finder)
    try:
        try:
            importlib.import_module("harness_compat")
        except ModuleNotFoundError as error:
            assert error.name == "socksio", error
        else:
            raise AssertionError("harness_compat swallowed a broken pier import")
    finally:
        sys.meta_path.remove(finder)
        _restore_modules(saved_pier)


def _main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    passes = failures = skips = 0
    for test in tests:
        try:
            result = test()
        except Exception as error:  # noqa: BLE001 - standalone runner reports all
            failures += 1
            print(f"FAIL {test.__name__}: {error!r}")
        else:
            if result is SKIPPED:
                skips += 1
                print(f"SKIP {test.__name__} (pier not importable)")
            else:
                passes += 1
                print(f"PASS {test.__name__}")
    print(f"\n{passes} passed, {skips} skipped, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
