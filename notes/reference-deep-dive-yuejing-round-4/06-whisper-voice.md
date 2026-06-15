# 06 — Reference app Whisper voice transcription: local + cloud + IPC decode

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Whisper is the voice input path for bot integrations (round-4
> [`04-bot-integration-contract.md`](./04-bot-integration-contract.md))
> and the desktop microphone surface. Rounds 1-3 never traced it.
> This note covers the 3-tier dispatch (local model → OpenAI
> cloud → null), the IPC PCM decode round-trip, language
> detection mapping, and the settings shape.

## Settings shape

From the api-spec (round-4 [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)):

```typescript
whisper: {
  enabled: boolean;
  model: string;     // e.g., 'base', 'small', 'medium', 'turbo'
  language: string;  // ISO 639-1 like 'en', 'zh', 'auto'
}
```

Plus a keybinding (`keybindings.toggleWhisper`) for hands-free
push-to-talk. Settings → Voice panel persists the model + auto-
detect language choice.

## 3-tier dispatch

`main.js:36755-36786` (the `transcribeVoice` entry point):

```js
async transcribeVoice(audioUrl) {
  const audioBuffer = await fetch(audioUrl).then(r => r.arrayBuffer()).then(Buffer.from);
  const settings = JSON.parse(To.getSettings().settingsData);
  if (settings?.whisper?.enabled === false) return null;     // (1) gate

  const model = settings?.whisper?.model || "base";
  const language = settings?.whisper?.language || "auto";

  // Tier 1: local model (if downloaded)
  if (wb.isModelDownloaded(model)) {
    try {
      await wb.initialize(model, language);
      const t = await this.transcribeVoiceLocal(audioBuffer);
      if (t) return t;
    } catch {
      console.log("[MessageBridge] Local Whisper failed, falling back to cloud");
    }
  }

  // Tier 2: OpenAI cloud
  const openaiKey = this.getOpenAIApiKey();
  if (openaiKey) return await this.transcribeVoiceCloud(audioBuffer, openaiKey);

  // Tier 3: null (no transcription available)
  return null;
}
```

The cascade is **explicit and inspectable**:
1. Local model is preferred (latency + privacy).
2. Cloud is a fallback when local fails OR isn't downloaded.
3. If user disables Whisper OR has no OpenAI key, return null
   (bot path interprets as "voice message couldn't be
   transcribed" — agent gets `[Voice message transcription
   failed]` instead of literal text).

## Local Whisper service

`main.js:34225-34310`. Wraps `@fugood/whisper.node` (a
native-addon binding to whisper.cpp).

### Lazy module loading

`loadWhisperModule()` is deferred until first use — keeps the
Electron startup fast even on machines without the native
binding installed. Failure throws a specific error: "Please
ensure @fugood/whisper.node is installed correctly."

### Model storage

```js
this.modelsDir = U.join(userData, "whisper_models");
getModelPath(modelId) {
  return U.join(this.modelsDir, `ggml-${modelId}.bin`);
}
isModelDownloaded(id) { return v.existsSync(this.getModelPath(id)); }
getDownloadedModels() {
  return fs.readdirSync(this.modelsDir)
    .filter(f => f.startsWith("ggml-") && f.endsWith(".bin"))
    .map(f => f.replace("ggml-", "").replace(".bin", ""));
}
```

Standard ggml model naming. Files live at
`{userData}/whisper_models/ggml-base.bin`,
`{userData}/whisper_models/ggml-small.bin`, etc. The REST API
(`main.js:53600-53602`) exposes:

- `GET /api/whisper/models` — list available + downloaded.
- `POST /api/whisper/models/:modelId/download` — fetch a model.

So the operator agent (round-4 01) can list/download models via
curl too.

### Init contract

`main.js:34261-34300`:

```js
async initialize(modelId, language = "auto") {
  if (this.isInitializing) return;                // re-entrance guard
  if (this.whisperContext && this.currentModelId === modelId) {
    this.currentLanguage = language;              // model already loaded, swap lang
    return;
  }
  this.isInitializing = true;
  try {
    await this.loadWhisperModule();
    const modelPath = this.getModelPath(modelId);
    if (!fs.existsSync(modelPath)) throw new Error(`Model not found: ${modelPath}`);
    if (this.whisperContext) await this.whisperContext.release(); // free old
    this.whisperContext = await initWhisper({ filePath: modelPath, useGpu: true });
    this.currentModelId = modelId;
    this.currentLanguage = language;
  } finally {
    this.isInitializing = false;
  }
}
```

Notable:
- **`useGpu: true`** by default. Falls back gracefully if no GPU
  is available (whisper.cpp handles).
- **Old context released** before loading new model — prevents
  RAM leak when user switches model.
- **Single-flight via `isInitializing`** — concurrent init calls
  return immediately.

## IPC PCM decode round-trip

The interesting bit at `main.js:36830-36874`. Local Whisper
needs **PCM audio** at 16kHz mono. But the audio comes in as
OGG (Telegram), MP4 (Discord), etc. — encoded formats.

```js
async transcribeVoiceLocal(encodedAudio) {
  const window = electron.getAllWindows()[0];
  if (!window || window.isDestroyed()) return null;

  const id = `tg-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pcm = await new Promise(resolve => {
    let done = false;
    const handler = (_event, msg) => {
      if (msg.id !== id) return;
      ipcMain.removeListener("telegram-decode-audio-result", handler);
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (!msg.pcm) {
        console.log("[MessageBridge] Renderer audio decode failed:", msg.error);
        return resolve(null);
      }
      resolve(new Float32Array(msg.pcm));
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener("telegram-decode-audio-result", handler);
      if (!done) { done = true; resolve(null); }
    }, 15_000);                                         // 15s timeout
    ipcMain.on("telegram-decode-audio-result", handler);
    window.webContents.send("telegram-decode-audio", {
      id,
      buffer: Array.from(encodedAudio),
    });
  });

  if (!pcm) return null;
  const text = await wb.transcribe(pcm, 16_000);
  return text ? { text, language: null } : null;
}
```

This is a **main-process → renderer → main-process** round-trip.
Why? The Electron renderer has access to Web Audio APIs
(`OfflineAudioContext`, `decodeAudioData`) — Node lacks them.
The renderer becomes a decode service:

```
Main process               Renderer
─────────────              ────────
encodedAudio buffer  →    decode via Web Audio
                          extract Float32Array @ 16kHz mono
                    ←     PCM Float32Array
PCM → whisper.cpp
text
```

15-second timeout cap on decode (`main.js:36855-36861`). If the
audio is corrupt or huge, bail rather than hang the bot.

ID-based request matching ensures concurrent decodes (multiple
voice messages arriving simultaneously) don't crosswire.
Belt-and-braces `done` flag prevents double-resolve on timeout
races.

## Cloud fallback

`main.js:36787-36829`:

```js
async transcribeVoiceCloud(audioBuffer, openaiKey) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) return null;

  const json = await res.json();
  if (!json.text) return null;
  const language = json.language ? mapLanguageCode(json.language) : null;
  return { text: json.text, language };
}
```

Three points:
- **`response_format: "verbose_json"`** — gets language detection
  for free. Cloud returns the detected language; local doesn't
  (more on that below).
- **No PCM round-trip** — OpenAI accepts encoded audio directly.
- **Hardcoded `audio/ogg` content type** — works for Telegram
  voice notes; might mislabel Discord MP4 voice messages but
  OpenAI's API tolerates this.

## Language detection mapping

`main.js:36805-36809`:

```js
const r = s.language
  ? ((lang) => {
      const t = lang.toLowerCase().trim();
      return t.length <= 3 && Nb[t] ? t : Ob[t] || t;
    })(s.language)
  : null;
```

OpenAI returns languages either as ISO codes (`"en"`, `"zh"`) or
as English names (`"english"`, `"chinese"`, `"mandarin"`). The
mapper:
- If short (≤3 chars) AND in the `Nb` whitelist of known ISO
  codes: pass through.
- Else look up in `Ob` (name → ISO).
- Else: return as-is.

This normalization is critical for the bot system prompt which
matches the user's language — round-4 04 mandated "ALWAYS reply
in the SAME LANGUAGE the user is writing in." Without
normalization, "english" vs "en" would cause inconsistent
prompt-building decisions downstream.

Asymmetry vs local: `transcribeVoiceLocal` returns `language:
null`. whisper.cpp's native binding doesn't include language
detection in this call path (or at least reference app doesn't request
it). The bot prompt's language-match logic must rely on the
TEXT content of the transcription, not the detected language.

## Discord voice fallback path

`main.js:37361-37385`:

```js
// First try cloud
`curl -s -X POST https://api.openai.com/v1/audio/transcriptions
  -H "Authorization: Bearer ${key}"
  -F "file=@${path}"
  -F "model=whisper-1"
  -F "language=zh"`
// Fallback to system whisper CLI
`whisper "${path}" --model turbo --language zh --output_format txt --output_dir /tmp 2>/dev/null`
```

Discord bot uses a SHELL-based dispatch (the bot runs CLI
commands instead of in-process calls). Same 3-tier cascade
spirit but different mechanism:
1. cURL to OpenAI cloud (uses `language=zh` — hardcoded to
   Chinese, suspicious; round-5 worth checking).
2. Shell out to the user's system `whisper` binary if present.
3. Log failure.

The hardcoded `language=zh` differs from the in-process bot
path that auto-detects. Bug or feature? Probably a leftover
from when this owner's primary group was Chinese-speaking.
Flagged as round-5 candidate.

## REST API surface

`main.js:53600-53602`:

```js
GET  /api/whisper/models                    // list available
POST /api/whisper/models/:modelId/download  // download a model
```

Operator agent (round-4 01) can list and download models via
curl. No transcription endpoint — voice input comes through the
renderer or bot bridges, never through HTTP.

## What Maka has today

Zero. No voice input. No Whisper integration. No microphone
permission flow.

## Ranked Maka improvements

1. **Hands-free voice input via Web Audio in the renderer.**
   No native binding needed for the entry path — Web Audio
   capture + send to OpenAI cloud is ~100 lines and
   immediately useful. Local Whisper via `@fugood/whisper.node`
   is a Phase 2.

2. **`whisper.enabled` opt-in setting with privacy implications
   surfaced.** Cloud transcription sends audio to OpenAI.
   Settings panel should make the privacy trade-off clear:
   "Voice → text uses OpenAI Whisper API. Your audio is sent
   to OpenAI."

3. **Adopt the 3-tier dispatch shape EVEN with only cloud
   available.** The function signature `(audioBuffer) →
   {text, language} | null` plus the enabled gate + key gate
   matches reference app's shape. When Maka adds local Whisper later,
   the function stays the same.

4. **Language-code normalization.** OpenAI's verbose_json
   returns mixed ISO codes and English names. Mapping helper
   that returns canonical ISO codes (with whitelist + fallback)
   is a 20-line port. Worth doing UP FRONT — fixing language-
   match-language conditional bugs later is painful.

5. **Renderer-as-decoder pattern.** If/when Maka adds local
   Whisper, the IPC PCM decode round-trip is the right
   architecture. Avoids bundling a native audio decoder in
   the Node main process. Cross-ref the round-3 05 page-context
   Readability pattern — same "let the renderer do the
   Web-API thing" idea applied to audio.

## Open questions for future rounds

- Why does the Discord cloud path hardcode `language=zh` while
  the in-process path uses `language=auto`? Locally-scoped bug
  for the owner's primary group? Worth confirming.
- whisper.cpp via `@fugood/whisper.node` supports streaming
  (continuous transcription). Does reference app use it, or only
  one-shot? Streaming would let "you can interrupt me by
  speaking" UX work.
- The `whisper-1` cloud model is OpenAI's older one. `gpt-4o-
  transcribe` and `gpt-4o-mini-transcribe` are now available
  with better quality + language detection. Does reference app have a
  migration plan?
- TTS is implemented at `main.js:36876` (the `textToSpeech`
  paired call). Round-5 candidate to trace.

## Cross-refs

- Round 3: [`05-readability-execution-context.md`](../reference app-deep-dive-yuejing-round-3/05-readability-execution-context.md)
  — the renderer-as-Web-API-host pattern. Readability needs
  page context; Whisper needs Web Audio. Same architectural
  shape.
- Round 4: [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)
  — `GET /api/whisper/models` is exposed via the same REST
  server.
- Round 4: [`04-bot-integration-contract.md`](./04-bot-integration-contract.md)
  — bot voice messages are auto-transcribed via this path
  before being injected into the agent's context as `[Voice
  message transcription]`.
