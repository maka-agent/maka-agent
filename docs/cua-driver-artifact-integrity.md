# cua-driver Artifact Integrity Boundary

This repository pins one macOS universal cua-driver compatibility artifact by
release URL and SHA-256. The preparation and check scripts prove:

- the downloaded archive bytes match the committed archive hash;
- the extracted Mach-O bytes match a separately committed binary hash;
- the binary reports the expected version and contains arm64 and x86_64;
- the current code signature is structurally valid;
- the tracked top-level license and source-claim files match their committed hashes;
- archive paths and entry types are checked before extraction.

They do not prove:

- that the binary was reproducibly built from `sourceCommit` or `Cargo.lock`;
- that the source commit or release asset has a trusted signature/attestation;
- complete third-party dependency license notices or an SBOM;
- Developer ID nested signing, notarization, stapling, Gatekeeper acceptance,
  or the final packaged Maka.app responsibility chain.

Accordingly, `check:cua-driver-artifact` is an integrity check for local
development and pre-package inputs. It is intentionally not part of
`check:release`. The manifest keeps `distributionReady: false` until a later
release-pipeline change supplies verified build provenance, third-party
notices, Developer ID signing, notarization, and packaged-app smoke evidence.
