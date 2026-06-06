# Alma deep-dive round 6 — yuejing

Rounds 1-5 closed at 37 source-grounded notes. Round 6 opens
for shorter focused notes on smaller subsystems that thread
through multiple already-covered areas — useful precisely
because the connection points are now well-mapped.

## Round 6 inventory

| # | Note | Subsystem | Status |
|---|---|---|---|
| 00 | `00-OVERVIEW.md` | This file (round-6 index) | **shipped** |
| 01 | `01-title-generation.md` | Thread title auto-generation pipeline (first 4 messages × 500 chars + toolModel + 3-broadcast UX) | **shipped** |
| 02 | `02-skill-extraction.md` | Auto-extract reusable skill from conversation: double-gate (cumulative ≥5 tool calls + delta-since-last-analysis) + condense-old/emphasize-recent asymmetric context (300 vs 3000 chars + plain vs bold) + JSON salvage regex + watermark-on-both-paths + existing-skills injection prevents duplicates + 'VERY selective' prompt design | **shipped** |
| 03 | `03-capability-discovery.md` | 4-tier capability resolution (regex pattern override → in-memory cache `Sc` → DB cache → models.dev API) + 10-min TTL + dual-key cache (bare modelId + providerId:modelId) + longest-substring fallback for dated variants + post-hoc `Rc` overrides (chatgpt-4o-latest functionCalling=false) + image-model functionCalling:false explicit override | **shipped** |

## Candidates for next notes

- **Skill extraction pipeline** (`analyzeAndExtractSkill` at
  main.js:59931): auto-creates skills from conversations with
  ≥5 tool calls. Round-3 01 mentioned the meta-loop but didn't
  trace the trigger condition.
- **Plugin provider system** (`Nl.isPluginProvider`): a third
  category alongside DB providers and ACP. Round-5 07 noted but
  didn't trace.
- **The actual streamText loop**: rounds covered everything
  around it (prepareStep, tool dispatch, safety modes) but the
  central call configuration is still not assembled in one
  place.
- **Capability discovery** (POST /api/providers/:id/models/
  fetch): how does alma probe each provider's available models
  + capabilities?
- **Renderer architecture**: the React app shape, preload
  contract, IPC channel taxonomy.

## Reading order

Round 6 is open-ended. Each note is **source-grounded** — every
claim cites `main.js:NNNN`. Cross-references back to rounds 1-5
use relative paths.
