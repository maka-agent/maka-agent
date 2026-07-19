import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  defaultVoiceCapabilitySnapshot,
  defaultVoicePrivacyFlags,
  normalizeVoiceInputMode,
  normalizeVoiceTranscriptText,
  normalizeVoiceTtsPolicy,
  validateVoiceCaptureRequest,
  validateVoiceTranscriptResult,
  validateVoiceTtsRequest,
} from '../voice.js';

describe('voice contract defaults', () => {
  it('defaults voice capability to disabled/off with no persistence or telemetry', () => {
    assert.deepEqual(defaultVoiceCapabilitySnapshot(), {
      inputMode: 'off',
      microphonePermission: 'unknown',
      sttProvider: 'disabled',
      localSttModelReady: false,
      cloudSttEnabled: false,
      ttsProvider: 'disabled',
      ttsPolicy: 'off',
      captureCaps: {
        maxDurationMs: VOICE_MAX_CAPTURE_DURATION_MS,
        maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
        maxSampleRate: 48_000,
        maxChannels: 1,
      },
      privacy: {
        persistAudio: false,
        transcriptToMemory: false,
        telemetryIncludesRawAudio: false,
        telemetryIncludesTranscript: false,
      },
      readiness: 'disabled',
      reasons: ['voice_disabled'],
    });
  });

  it('locks privacy flags to false literals', () => {
    const privacy = defaultVoicePrivacyFlags();
    assert.equal(privacy.persistAudio, false);
    assert.equal(privacy.transcriptToMemory, false);
    assert.equal(privacy.telemetryIncludesRawAudio, false);
    assert.equal(privacy.telemetryIncludesTranscript, false);
  });
});

describe('voice mode and policy normalizers', () => {
  it('defaults missing input mode and TTS policy to off', () => {
    assert.deepEqual(normalizeVoiceInputMode(undefined), { ok: true, value: 'off' });
    assert.deepEqual(normalizeVoiceTtsPolicy(undefined), { ok: true, value: 'off' });
  });

  it('rejects always-on capture and automatic output policies', () => {
    assert.equal(normalizeVoiceInputMode('always_on').ok, false);
    assert.equal(normalizeVoiceTtsPolicy('always').ok, false);
    assert.equal(normalizeVoiceTtsPolicy('smart').ok, false);
  });

  it('allows only bounded input modes', () => {
    assert.deepEqual(normalizeVoiceInputMode('push_to_talk'), { ok: true, value: 'push_to_talk' });
    assert.deepEqual(normalizeVoiceInputMode('toggle_to_record'), {
      ok: true,
      value: 'toggle_to_record',
    });
  });
});

describe('voice capture validation', () => {
  const validCapture = {
    mode: 'push_to_talk',
    permission: 'granted',
    durationMs: 5_000,
    audioBytes: 256_000,
    sampleRate: 16_000,
    channels: 1,
  };

  it('rejects disabled capture before reading audio facts', () => {
    const result = validateVoiceCaptureRequest({ ...validCapture, mode: 'off' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
  });

  it('fails closed for malformed runtime capture payloads', () => {
    for (const bad of [null, undefined, 'voice', 42, [], true]) {
      const result = validateVoiceCaptureRequest(bad);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
  });

  it('fails closed when microphone permission is denied or restricted', () => {
    for (const permission of ['denied', 'restricted', 'not_determined']) {
      const result = validateVoiceCaptureRequest({ ...validCapture, permission });
      assert.equal(result.ok, false);
    }
  });

  it('enforces duration, byte, sample-rate, and channel caps', () => {
    assert.equal(
      validateVoiceCaptureRequest({
        ...validCapture,
        durationMs: VOICE_MAX_CAPTURE_DURATION_MS + 1,
      }).ok,
      false,
    );
    assert.equal(
      validateVoiceCaptureRequest({ ...validCapture, audioBytes: VOICE_MAX_AUDIO_BYTES + 1 }).ok,
      false,
    );
    assert.equal(validateVoiceCaptureRequest({ ...validCapture, sampleRate: 96_000 }).ok, false);
    assert.equal(validateVoiceCaptureRequest({ ...validCapture, channels: 2 }).ok, false);
  });

  it('accepts a bounded push-to-talk capture request', () => {
    const result = validateVoiceCaptureRequest(validCapture);
    assert.equal(result.ok, true);
  });
});

describe('transcript validation', () => {
  it('normalizes transcript text and strips control characters', () => {
    assert.deepEqual(normalizeVoiceTranscriptText(' hello\u0000\nworld '), {
      ok: true,
      value: 'hello world',
    });
  });

  it('rejects empty transcript text', () => {
    const result = normalizeVoiceTranscriptText(' \n\t ');
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.reason, 'transcript_empty');
  });

  it('requires editable-before-send', () => {
    const result = validateVoiceTranscriptResult({
      text: 'hello',
      source: 'local_model',
      durationMs: 1000,
      sampleRate: 16_000,
      channels: 1,
      editableBeforeSend: false,
      persistence: 'composer_only',
    });
    assert.equal(result.ok, false);
  });

  it('fails closed for malformed runtime transcript payloads', () => {
    for (const bad of [null, undefined, 'hello', 42, [], true]) {
      const result = validateVoiceTranscriptResult(bad);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
  });

  it('enforces duration, sample-rate, and channel caps on transcript results', () => {
    const base = {
      text: 'hello',
      source: 'local_model',
      durationMs: 1000,
      sampleRate: 16_000,
      channels: 1,
      editableBeforeSend: true,
      persistence: 'composer_only',
    };
    assert.equal(
      validateVoiceTranscriptResult({ ...base, durationMs: VOICE_MAX_CAPTURE_DURATION_MS + 1 }).ok,
      false,
    );
    assert.equal(validateVoiceTranscriptResult({ ...base, sampleRate: 96_000 }).ok, false);
    assert.equal(validateVoiceTranscriptResult({ ...base, channels: 2 }).ok, false);
  });

  it('blocks cloud transcript source by default', () => {
    const result = validateVoiceTranscriptResult({
      text: 'hello',
      source: 'cloud_provider',
      durationMs: 1000,
      sampleRate: 16_000,
      channels: 1,
      editableBeforeSend: true,
      persistence: 'composer_only',
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.reason, 'cloud_not_enabled');
  });

  it('accepts local composer-only transcript results', () => {
    const result = validateVoiceTranscriptResult({
      text: 'hello',
      source: 'local_model',
      durationMs: 1000,
      sampleRate: 16_000,
      channels: 1,
      confidence: 0.9,
      editableBeforeSend: true,
      persistence: 'composer_only',
    });
    assert.equal(result.ok, true);
  });
});

describe('TTS validation', () => {
  it('fails closed for malformed runtime TTS payloads', () => {
    for (const bad of [null, undefined, 'hello', 42, [], true]) {
      const result = validateVoiceTtsRequest(bad);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
  });

  it('keeps automatic voice policies disabled by contract', () => {
    for (const policy of ['off', 'inbound_disabled', 'smart_disabled']) {
      const result = validateVoiceTtsRequest({ text: 'hello', provider: 'local', policy });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
  });

  it('allows manual preview only when a provider is explicitly selected', () => {
    const valid = validateVoiceTtsRequest({
      text: 'hello',
      provider: 'local',
      policy: 'manual_preview',
    });
    assert.equal(valid.ok, true);

    const invalid = validateVoiceTtsRequest({
      text: 'hello',
      provider: 'disabled',
      policy: 'manual_preview',
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.ok ? undefined : invalid.reason, 'provider_not_ready');
  });
});
