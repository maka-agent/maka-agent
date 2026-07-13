# Maka documentation

This page is the authority map for Maka documentation. Code and contract tests remain the final authority when documentation disagrees with the implementation.

## Where information belongs

- Root and package READMEs describe stable product entry points, public seams, and local ownership.
- `docs/` contains current cross-cutting architecture, security, product, and validation contracts.
- GitHub issues and pull requests contain implementation plans, migration progress, and time-sensitive TODOs.
- `docs/archive/` preserves completed plans and superseded material for historical context. Archived documents are not current implementation guidance.

## Start here

- [Backend architecture](../ARCHITECTURE.md) ([中文](../ARCHITECTURE.zh-CN.md))
- [Desktop architecture](../apps/desktop/README.md)
- [Renderer architecture](../apps/desktop/src/renderer/README.md)
- [Headless usage and isolation](../packages/headless/README.md)
- [Runtime package](../packages/runtime/README.md)
- [UI package architecture](../packages/ui/README.md)
- [Security policy](../SECURITY.md)

## Current contracts

### Runtime and Headless

- [Session task ledger lifecycle](./session-task-ledger-lifecycle.md)
- [AHE target protocol](./ahe-target-protocol.md)
- [AHE evidence export](./ahe-evidence-export.md)
- [Skill catalog policy](./skill-catalog-policy.md)
- [Backend architecture chapters](./architecture/)

### Frontend and validation

- [Product design](../DESIGN.md)
- [Frontend CSS governance](./frontend-css-governance.md)

### Security and privacy

- [Workspace privacy context](./workspace-privacy-context.md)
- [Runtime sandbox boundary](../packages/runtime/src/sandbox/README.md)

## Historical material

- [Runtime kernel extraction](./archive/runtime-kernel.md)
- [Runtime v2 architecture evolution](./archive/runtime-v2-architecture-evolution.md)
- [Runtime v2 implementation notes](./archive/runtime-v2-implementation-notes.md)
- [DeepSeek Reasonix cost runtime design](./archive/deepseek-reasonix-cost-runtime-design.md)
- [Documentation archive](./archive/README.md)

## Maintenance

- Add stable cross-cutting documentation to the closest section above.
- Put local architecture beside the code and link it from **Start here**.
- Keep progress and TODOs in issues or pull requests instead of copying them into stable documents.
- Move completed plans to `docs/archive/`; remove a document only after its unique references are updated or no longer needed.
- Prefer updating an existing authority over adding a parallel document.
