# Voice Threat Model

> Archived on 2026-07-13. This document records the docs/core-only PR-VOICE-0 boundary, not the current voice product implementation. Source and focused tests own the active contract.

This document is the PR-VOICE-0 contract boundary. It is intentionally docs/core-only: no microphone capture, no STT/TTS provider call, no IPC, no preload, no renderer, no storage, and no bot/platform voice send.

## Contract Goals

The first Voice contract locks the safe shape before runtime work exists:

- default voice input is `off`;
- capture modes are limited to `push_to_talk` and `toggle_to_record`;
- no always-on capture;
- microphone permission must be explicit and fail-closed;
- capture has duration, byte, sample-rate, and channel caps;
- transcript output must be editable before send;
- transcript persistence defaults to composer-only or discarded;
- raw audio is never telemetry and never persisted;
- transcript-to-memory is disabled;
- cloud STT/TTS fallback is not automatic;
- auto voice policies remain disabled contract variants until a later opt-in PR.

## Assets

- microphone permission state;
- raw microphone audio;
- decoded PCM samples;
- transcript text;
- TTS input text and generated audio;
- STT/TTS provider credentials;
- bot platform tokens and chat/channel identifiers;
- local model files;
- per-turn voice metadata such as duration, sample rate, channels, and source.

## Trust Boundaries

| Boundary | Risk | Required guard |
|---|---|---|
| Renderer capture -> main/preload | forged payload, huge audio, permission confusion | typed IPC in a later PR, caps, permission snapshot, fail-closed denied/restricted |
| Raw audio -> STT provider | audio leaves device silently | no silent cloud fallback; explicit provider enablement required |
| Transcript -> composer/session/memory | accidental durable persistence | editable-before-send, composer-only by default, memory disabled |
| TTS text -> provider | prompt/private text sent to provider | explicit provider validation and manual preview only in first TTS PR |
| Main -> subprocess (`ffmpeg`, local model) | shell injection, hang, temp file leak | future implementation must use structured args, timeouts, owned temp paths |
| Bot platform voice send | wrong target/token leak | future platform contract; no shell `curl` |
| Health/Settings -> renderer | fake readiness | canonical `VoiceCapabilitySnapshot`; renderer presentation only |

## No-Copy List From reference implementation

Do not copy these reference implementation behaviors:

- defaultSession microphone/media auto-grant;
- shell `curl` for STT/TTS/provider/platform sends;
- API keys in command-line args;
- silent cloud fallback for raw audio;
- Discord `language=zh` hardcode;
- uncapped `Float32Array` / `number[]` IPC for long audio;
- raw WAV/MP3 fallback pretending to be voice-message ready;
- automatic voice reply enabled by default;
- transcript promotion to memory without review;
- raw audio or transcript in telemetry/logs.

## Contract Gates

1. `VoiceCapabilitySnapshot` defaults to disabled/off.
2. `VoiceInputMode` excludes always-on capture.
3. `VoiceTtsPolicy` keeps auto/inbound/smart disabled.
4. denied/restricted/not-determined permission blocks capture.
5. duration/bytes/sample-rate/channels are capped before runtime.
6. local transcript output must be `editableBeforeSend: true`.
7. cloud transcript source is blocked by default.
8. transcript persistence is limited to `composer_only` or `discarded`.
9. privacy flags for audio persistence, transcript-to-memory, raw audio telemetry, and transcript telemetry are false literals.

## Out Of Scope

- real mic capture;
- MediaRecorder or AudioContext wiring;
- STT provider execution;
- TTS provider execution;
- local model download/setup;
- ffmpeg/subprocess execution;
- IPC/preload/global type changes;
- renderer UI;
- storage or session writes;
- bot platform voice-in/out;
- memory promotion.

## Future PR Sequence

1. PR-VOICE-1: local mic -> composer STT, local-only, push/toggle, capped, no auto-send.
2. PR-VOICE-2: TTS manual preview, provider validated, no auto-send.
3. PR-VOICE-3: bot voice-in/out with platform-specific sender contracts.
4. PR-VOICE-4: cloud STT/TTS explicit opt-in.
5. PR-VOICE-5: smart/inbound auto voice, opt-in only, with memory/incognito gates.
