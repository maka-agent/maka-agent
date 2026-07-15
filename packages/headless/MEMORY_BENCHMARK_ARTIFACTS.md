# Memory Benchmark Artifact Contract

`maka.memory_benchmark.run_manifest.v1` is the immutable identity for one model, reasoning-effort, strategy, dataset, and repetition configuration.

## Write Gate

Writers must pass `format: "maka.memory_benchmark.v1"`. This keeps the new contract opt-in until the runtime-policy and memory benchmark runners migrate. Existing A/B manifests and readers are unchanged.

## Compatibility

- Readers reject unknown `schemaVersion` values.
- Readers accept additive fields within v1 only when the stored fingerprint covers the complete body, including those fields.
- Removing, renaming, or changing the meaning of a field requires a new schema version.
- Frozen manifests are never overwritten. A changed model, reasoning effort, strategy, dataset, task list, repetition count, or artifact layout requires a new run id.

## Persistence

- A manifest is written to a complete temporary file and published atomically. A partial target manifest is never created by the v1 writer.
- Completed attempts are append-only JSONL records identified by the manifest fingerprint, task id, and repetition.
- Public WAL reads and appends derive their path from `runRoot + manifest.artifactPaths.attemptsJsonl`; callers cannot substitute a second ledger path for the same manifest.
- Each completed attempt seals the verifier file, transcript file, and exact token CSV row with SHA-256 digests. Offline recomputation rejects changed evidence.
- Attempt appends use a cross-process file lock; concurrent workers cannot create duplicate completion records.
- Readers ignore only a torn final JSONL line. Corruption before the final line fails explicitly.
- Appending the same completed attempt is idempotent only when the complete evidence is identical.
- Redacted JSON/text artifacts are create-only. Rewriting an existing path with different content fails.

## Verifier Authority

Attempt records contain artifact references, content digests, and a `harbor_post_exit` import declaration, not trusted pass/fail claims. `importHarborMemoryBenchmarkAttempt` is the supported host-owned completion path: it derives the attempt identity from the frozen manifest, reads the post-exit Harbor result/transcript/token row, and seals their exact bytes. Offline scoring requires verifier and transcript references to stay within the manifest-declared directories, requires the token row to use the declared CSV, verifies all three digests, and then scores the same verifier buffer that was hashed.

The v1 scorer accepts a verifier artifact only when it contains a numeric Harbor reward/score. A bare pass flag is not sufficient. If an imported document carries an explicit authority field, it must be an object identifying `official_harbor_verifier`; existing local/self-check verifier output remains non-authoritative. The trusted host-owned Harbor runner/import boundary establishes provenance; persisted literals are an auditable declaration, not a cryptographic signature. The benchmark contract preserves imported evidence immutably and does not claim to authenticate a hostile host.

The token reference format is `tokens.csv#<attempt-id>`. Offline scoring requires exactly one matching non-negative row and verifies that input, output, and reasoning tokens add up to the recorded total.

## Credentials

Manifest parsing rejects unredacted credential-bearing fields and common credential string forms, including bearer/basic authorization, API keys, access/refresh/session tokens, client secrets, URL userinfo, passwords, cookies, and provider-specific secret fields. Benchmark JSON, trace, transcript, error, and summary writers must use the exported redacted JSON/text writers. Credential values are never part of run identity or diagnostics.
