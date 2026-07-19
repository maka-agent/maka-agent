"""Process-scope helpers shared by Harbor agent adapters."""

from __future__ import annotations

import shlex


COMMAND_SCOPE_ENV = "MAKA_HARBOR_COMMAND_SCOPE"
COMMAND_ID_ENV = "MAKA_HARBOR_COMMAND_ID"
COMMAND_SCOPE_ROOT = "/tmp/maka-harbor-command-scopes"


def scoped_command(command: str, scope: str, command_id: str) -> str:
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    pgid_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.pgid")
    return (
        f"mkdir -p -- {scope_dir}; set -m; "
        f"env {COMMAND_SCOPE_ENV}={shlex.quote(scope)} "
        f"{COMMAND_ID_ENV}={shlex.quote(command_id)} "
        f"bash -lc {shlex.quote(command)} & "
        "command_pid=$!; "
        f"printf '%s\\n' \"$command_pid\" > {pgid_path}; "
        "wait \"$command_pid\"; command_status=$?; "
        f"kill -0 -- \"-$command_pid\" 2>/dev/null || rm -f -- {pgid_path}; "
        "exit \"$command_status\""
    )


def scoped_process_cleanup_command(scope: str, signal: str) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    return (
        f"for pgid_file in {scope_dir}/*.pgid; do "
        "[ -r \"$pgid_file\" ] || continue; "
        "pgid=$(cat -- \"$pgid_file\"); "
        "case $pgid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} -- \"-$pgid\" 2>/dev/null || true; "
        "done; "
        + _marked_process_cleanup_command(scope, signal)
        + (f"; rm -rf -- {scope_dir}" if signal == "KILL" else "")
    )


def scoped_command_cleanup_command(
    scope: str, command_ids: list[str], signal: str
) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    pgid_paths = [
        shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.pgid")
        for command_id in command_ids
    ]
    if not pgid_paths:
        return ":"
    paths = " ".join(pgid_paths)
    command = (
        f"for pgid_file in {paths}; do "
        "[ -r \"$pgid_file\" ] || continue; "
        "pgid=$(cat -- \"$pgid_file\"); "
        "case $pgid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} -- \"-$pgid\" 2>/dev/null || true; "
        "done; "
        + _marked_process_cleanup_command(scope, signal, command_ids)
    )
    return command + (f"; rm -f -- {paths}" if signal == "KILL" else "")


def _marked_process_cleanup_command(
    scope: str, signal: str, command_ids: list[str] | None = None
) -> str:
    scope_marker = shlex.quote(f"{COMMAND_SCOPE_ENV}={scope}")
    command_filter = ""
    if command_ids is not None:
        command_checks = " || ".join(
            "tr '\\000' '\\n' 2>/dev/null < \"$env_file\" | grep -Fx -- "
            + shlex.quote(f"{COMMAND_ID_ENV}={command_id}")
            + " > /dev/null"
            for command_id in command_ids
        )
        command_filter = f" && {{ {command_checks}; }}"
    return (
        "for env_file in /proc/[0-9]*/environ; do "
        "[ -r \"$env_file\" ] || continue; "
        f"if tr '\\000' '\\n' 2>/dev/null < \"$env_file\" | grep -Fx -- {scope_marker} > /dev/null"
        f"{command_filter}; then "
        "pid=${env_file#/proc/}; pid=${pid%/environ}; "
        f"kill -{signal} \"$pid\" 2>/dev/null || true; "
        "fi; done"
    )
