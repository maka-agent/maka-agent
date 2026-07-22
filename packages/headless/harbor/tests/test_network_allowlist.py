"""Behavior contract for the Pier network_allowlist / install_spec hooks.

Pier (Datacurve's Harbor fork) calls ``agent.install_spec()`` and
``agent.network_allowlist()`` when it builds a trial's environment
(``pier/trial/execution.py`` -> ``_create_environment``); plain Harbor 0.13.2
calls neither. These tests assert both adapters (a) return the right shapes when
Pier is importable and (b) still import when Pier is absent (the Terminal-Bench
plain-Harbor path), simulated via ``sys.modules`` / meta-path poisoning.

Run under an interpreter that has Harbor + Pier installed, e.g. the
``datacurve-pier`` uv tool venv (pytest is optional; a ``__main__`` runner
executes every ``test_*`` function):

    ~/.local/share/uv/tools/datacurve-pier/bin/python \
        packages/headless/harbor/tests/test_network_allowlist.py
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_HARBOR_DIR = Path(__file__).resolve().parent.parent
if str(_HARBOR_DIR) not in sys.path:
    sys.path.insert(0, str(_HARBOR_DIR))

try:
    from pier.models.agent.network import NetworkAllowlist

    _PIER_IMPORTABLE = True
except ImportError:  # pragma: no cover - depends on the running interpreter
    NetworkAllowlist = None  # type: ignore[assignment]
    _PIER_IMPORTABLE = False


def _fresh(name: str):
    sys.modules.pop(name, None)
    return importlib.import_module(name)


def test_maka_agent_shapes_under_pier() -> None:
    if not _PIER_IMPORTABLE:
        return  # skipped: interpreter has no Pier (plain-Harbor env)
    mod = _fresh("maka_agent")
    agent = mod.MakaAgent(logs_dir=Path("/tmp"))
    assert agent.install_spec() is None
    allow = agent.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    # Host-side LLM mode needs no container egress -> empty allowlist.
    assert allow.domains == []


def test_kimi_agent_shapes_under_pier() -> None:
    if not _PIER_IMPORTABLE:
        return  # skipped: interpreter has no Pier (plain-Harbor env)
    mod = _fresh("kimi_code_agent")

    default_agent = mod.MakaKimiCodeAgent(logs_dir=Path("/tmp"))
    assert default_agent.install_spec() is None
    default_allow = default_agent.network_allowlist()
    assert isinstance(default_allow, NetworkAllowlist)
    # Default endpoint is https://api.kimi.com/coding/v1.
    assert default_allow.domains == ["api.kimi.com"]

    configured = mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://api.kimi.com/coding/v1"},
    )
    assert configured.network_allowlist().domains == ["api.kimi.com"]

    proxied = mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    # Domain only: host is extracted, port/path/scheme are dropped.
    assert proxied.network_allowlist().domains == ["proxy.internal"]


def test_modules_import_without_pier() -> None:
    # Prime Harbor (and the local sibling modules) into sys.modules first so the
    # reimport under the Pier block re-triggers only the guarded `import pier`
    # line, not Harbor's own import machinery.
    importlib.import_module("maka_agent")
    importlib.import_module("kimi_code_agent")

    prefix = "pier"
    saved_pier = {
        key: mod
        for key, mod in sys.modules.items()
        if key == prefix or key.startswith(prefix + ".")
    }
    for key in list(saved_pier):
        del sys.modules[key]
    for key in ("maka_agent", "kimi_code_agent"):
        sys.modules.pop(key, None)

    class _BlockPier:
        def find_spec(self, name, path=None, target=None):  # noqa: ANN001, ARG002
            if name == prefix or name.startswith(prefix + "."):
                raise ModuleNotFoundError(f"pier blocked for test: {name}", name=name)
            return None

    finder = _BlockPier()
    sys.meta_path.insert(0, finder)
    try:
        maka = importlib.import_module("maka_agent")
        kimi = importlib.import_module("kimi_code_agent")
        # The guarded import degrades to None when Pier is absent...
        assert maka._NetworkAllowlist is None
        assert kimi._NetworkAllowlist is None
        # ...and the never-called-under-plain-Harbor hooks stay resolvable.
        assert maka.MakaAgent(logs_dir=Path("/tmp")).install_spec() is None
        assert maka.MakaAgent(logs_dir=Path("/tmp")).network_allowlist() is None
        assert kimi.MakaKimiCodeAgent(logs_dir=Path("/tmp")).install_spec() is None
        assert (
            kimi.MakaKimiCodeAgent(logs_dir=Path("/tmp")).network_allowlist() is None
        )
    finally:
        sys.meta_path.remove(finder)
        for key in ("maka_agent", "kimi_code_agent"):
            sys.modules.pop(key, None)
        sys.modules.update(saved_pier)
        # Restore adapters imported against the real (unblocked) Pier.
        importlib.import_module("maka_agent")
        importlib.import_module("kimi_code_agent")


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
            skipped = test.__name__.endswith("under_pier") and not _PIER_IMPORTABLE
            print(f"{'SKIP' if skipped else 'PASS'} {test.__name__}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed"
          f"{'' if _PIER_IMPORTABLE else ' (Pier not importable: under-pier tests skipped)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
