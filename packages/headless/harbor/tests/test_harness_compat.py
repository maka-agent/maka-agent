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
  failure), and install_spec/network_allowlist return the shapes Pier consumes;
- under plain Harbor (real, or simulated via meta-path poisoning of ``pier``):
  the harbor tree is selected and the modules import and instantiate cleanly.

Run under an interpreter that has Harbor or Pier installed, e.g. either uv tool
venv (pytest is optional; a ``__main__`` runner executes every ``test_*``
function):

    ~/.local/share/uv/tools/datacurve-pier/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
    ~/.local/share/uv/tools/harbor/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_HARBOR_DIR = Path(__file__).resolve().parent.parent
if str(_HARBOR_DIR) not in sys.path:
    sys.path.insert(0, str(_HARBOR_DIR))

_ADAPTER_MODULES = ("harness_compat", "maka_agent", "kimi_code_agent")

try:
    from pier.agents.installed.base import BaseInstalledAgent as PierBaseInstalledAgent
    from pier.models.agent.network import NetworkAllowlist
    from pier.models.trial.result import AgentInfo as PierAgentInfo

    _PIER_IMPORTABLE = True
except ImportError:  # pragma: no cover - depends on the running interpreter
    NetworkAllowlist = None  # type: ignore[assignment]
    _PIER_IMPORTABLE = False


def _fresh_adapters():
    for name in _ADAPTER_MODULES:
        sys.modules.pop(name, None)
    return (
        importlib.import_module("maka_agent"),
        importlib.import_module("kimi_code_agent"),
    )


def test_pier_tree_selected_and_agent_info_is_pier_type() -> None:
    if not _PIER_IMPORTABLE:
        return  # skipped: interpreter has no Pier (plain-Harbor env)
    maka_mod, kimi_mod = _fresh_adapters()
    for cls in (maka_mod.MakaAgent, kimi_mod.MakaKimiCodeAgent):
        assert issubclass(cls, PierBaseInstalledAgent), cls.__mro__
        agent = cls(logs_dir=Path("/tmp"), model_name="k3")
        # The DeepSWE pilot failed pydantic validation because agent_info was a
        # harbor-tree AgentInfo; Pier's TrialResult only accepts its own type.
        info = agent.to_agent_info()
        assert isinstance(info, PierAgentInfo), type(info)
        assert agent.install_spec() is None


def test_maka_agent_network_shape_under_pier() -> None:
    if not _PIER_IMPORTABLE:
        return  # skipped: interpreter has no Pier (plain-Harbor env)
    maka_mod, _ = _fresh_adapters()
    allow = maka_mod.MakaAgent(logs_dir=Path("/tmp")).network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    # Host-side LLM mode needs no container egress -> empty allowlist.
    assert allow.domains == []


def test_kimi_agent_network_shape_under_pier() -> None:
    if not _PIER_IMPORTABLE:
        return  # skipped: interpreter has no Pier (plain-Harbor env)
    _, kimi_mod = _fresh_adapters()

    default_allow = kimi_mod.MakaKimiCodeAgent(logs_dir=Path("/tmp")).network_allowlist()
    assert isinstance(default_allow, NetworkAllowlist)
    # Default endpoint is https://api.kimi.com/coding/v1.
    assert default_allow.domains == ["api.kimi.com"]

    configured = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://api.kimi.com/coding/v1"},
    )
    assert configured.network_allowlist().domains == ["api.kimi.com"]

    proxied = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    # Domain only: host is extracted, port/path/scheme are dropped.
    assert proxied.network_allowlist().domains == ["proxy.internal"]


def test_harbor_tree_used_without_pier() -> None:
    prefix = "pier"
    saved_pier = {
        key: mod
        for key, mod in sys.modules.items()
        if key == prefix or key.startswith(prefix + ".")
    }
    for key in list(saved_pier):
        del sys.modules[key]
    for key in _ADAPTER_MODULES:
        sys.modules.pop(key, None)

    class _BlockPier:
        def find_spec(self, name, path=None, target=None):  # noqa: ANN001, ARG002
            if name == prefix or name.startswith(prefix + "."):
                raise ModuleNotFoundError(f"pier blocked for test: {name}", name=name)
            return None

    finder = _BlockPier()
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
            # Pier-only hooks stay resolvable but inert under plain Harbor.
            assert agent.install_spec() is None
            assert agent.network_allowlist() is None
    finally:
        sys.meta_path.remove(finder)
        for key in _ADAPTER_MODULES:
            sys.modules.pop(key, None)
        sys.modules.update(saved_pier)
        # Restore adapters imported against the real (unblocked) tree.
        for key in _ADAPTER_MODULES[1:]:
            importlib.import_module(key)


def _main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
        except Exception as error:  # noqa: BLE001 - standalone runner reports all
            failures += 1
            print(f"FAIL {test.__name__}: {error!r}")
        else:
            pier_only = "under_pier" in test.__name__ or test.__name__.startswith(
                "test_pier_"
            )
            skipped = pier_only and not _PIER_IMPORTABLE
            print(f"{'SKIP' if skipped else 'PASS'} {test.__name__}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed"
          f"{'' if _PIER_IMPORTABLE else ' (Pier not importable: pier-tree tests skipped)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
