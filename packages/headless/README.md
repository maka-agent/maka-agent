# @maka/headless

The single headless entry point for driving a Maka agent without a UI. Its
first mode is **eval**: run a **Config × Task** grid, capture each trajectory,
score it with the task's own command, and compare. RFC: [#31](https://github.com/jackwener/maka-agent/issues/31).

```
Config × Task  →  throwaway workspace  →  headless agent run  →  trajectory
                                                                     ↓
                              ResultRecord (JSONL)  ←  verification command
```

## CLI

```sh
maka-headless eval <spec.json> [--out <dir>]   # run the grid → results.jsonl + comparison.md
maka-headless compare <results.jsonl>          # print the comparison table
```

Try it with the bundled fake-backend demo (no API key needed):

```sh
maka-headless eval examples/demo.spec.json --out /tmp/maka-headless-demo
```

## Trust posture

`eval` is **untrusted by construction**: the config under test is something you
are *measuring*, possibly weak or adversarial, so it must not reach the host.
Without OS-level isolation the only safe enforcement is to **fail closed**:

- Only the inert **`fake`** backend runs. Any model-backed backend (`ai-sdk`,
  `pi-agent`) is **refused** before a run starts — it would execute
  shell / network / file tools on your machine, and the throwaway workspace is
  a copy, not a sandbox.
- Real-model eval lands once the **isolated executor** ships (a follow-up:
  per-run container, env allowlist so tools never inherit your secrets,
  network policy). Until then `eval` on a real backend exits non-zero with a
  clear refusal.

(An *operational* mode — intentionally running a trusted agent that *may* touch
the host — can slot into this same entry later. That is a different, explicit
trust posture, never the eval default.)

## Spec

A spec is `configs × tasks`. Task `workspaceDir` paths resolve relative to the
spec file, so a spec travels with its fixtures.

```jsonc
{
  "configs": [
    { "id": "fake", "backend": "fake", "llmConnectionSlug": "fake", "model": "fake-model" }
  ],
  "tasks": [
    { "id": "fix-bug", "instruction": "Make the failing test pass.",
      "workspaceDir": "./fixtures/fix-bug",
      "verification": {
        "command": "npm test",
        "timeoutMs": 120000,
        // REQUIRED grading boundary (see Grading). Use [] when the
        // verification reads nothing the agent could forge.
        "protectedPaths": ["test/"]
      } }
  ]
}
```

## Grading

Verification runs the task's `command` in the workspace; exit code 0 = pass.
A config must not be able to grade itself, so `verification.protectedPaths` is
**required**: list the test/grading files and they are restored from the
pristine fixture *after* the agent finishes and *before* the command runs — a
model that rewrote its own test to pass has that edit reverted. Declare `[]`
only when the verification reads nothing the agent can forge — as the bundled
`examples/demo` does, checking a fixture file the agent has no reason to touch.

## Exit code

`maka-headless eval` exits non-zero on an **infrastructure** failure (invalid
spec, refused backend, a run that crashed before producing a result). A run
that completed and merely **failed its verification** is valid benchmark data
and exits 0.

## Scope

MVP. Deliberately later, as pure additions: the isolated executor (and with it
real-model eval), parallel matrix execution, LLM/rule evaluators (today:
exit-code of a command), SWE-bench pack ingestion, and a richer report than the
markdown grid. Promote the contracts into `@maka/core` once a second consumer
exists.
