# Discord Transcription Bot — Design

**Date:** 2026-05-31
**Status:** approved (implemented; this is the design record)

## Goal

A Discord bot that joins a voice channel on command, records each participant
separately, then delegates transcription to Gemini at the end of the session to
produce a **merged chronological transcript** (who said what, in order,
timestamped). The result is posted in the text channel.

## Key architecture choices

- **Batch, not live.** We record during the session and transcribe once at the
  end (`/stop`). This removes the entire real-time pipeline (streaming STT,
  ffmpeg resampling, per-utterance orchestration, local GPU).
- **A single Node.js app.** No separate STT service: Gemini is remote.
- **Transcription delegated to Gemini.** Audio + timing metadata sent to the
  Google Gen AI API; Gemini provides the text, our code provides the order and
  timestamps.
- **No diarization needed.** Discord already delivers a per-user Opus stream
  (SSRC → user ID mapping): one file = one speaker.

### Accepted GDPR trade-off

Participants' voices are sent to Google (Gemini API). Acceptable for private
server use with informed participants. The bot **announces the recording** at
`/record`. Revisit if the bot becomes public.

## End-to-end flow

```
/record → joins the caller's voice channel (selfDeaf:false)
        → announces "🔴 recording for transcription"
        → for each speaking user: capture Opus → write one .ogg per turn
        → log each turn's timing to timeline.json
/stop   → leaves voice, finalizes files
        → builds the Gemini request (sorted audio + context) → structured JSON
        → merges into a chronological transcript
        → posts a summary + attaches transcript.md and transcript.json
```

## Components

| Component | Role | Depends on |
|-----------|------|------------|
| `commands/record.js`, `commands/stop.js` | Slash-command handlers | discord.js, recording |
| `recording/session.js` | Session state: paths, timeline, participants | — |
| `recording/recorder.js` | Joins voice, subscribes to streams, writes .ogg, logs timing | @discordjs/voice, prism-media |
| `recording/encode.js` | Re-encodes PCM → Opus/Ogg 16k mono (ffmpeg) | ffmpeg-static |
| `transcription/gemini.js` | Builds the request, calls Gemini, parses JSON | @google/genai |
| `transcription/merge.js` | Sorts utterances, injects text, renders md + json | — (pure functions) |
| `output/publish.js` | Posts the message + attaches files | discord.js |
| `config.js` | Loads and validates `.env` | — |
| `index.js` | Bootstraps the client, registers commands, wires events | everything |

Each unit has a single role and a clear interface; `merge.js` and the parsing in
`gemini-core.js` are pure functions, testable in isolation.

## Audio capture (detail)

- On each user's `speaking.start` (deduplicated with a `Set` so we subscribe only
  once per turn), we `subscribe` to the Opus stream with
  `EndBehaviorType.AfterSilence` (configurable silence duration, ~800 ms).
- **Opus → PCM → ffmpeg → Opus/Ogg 16 kHz mono.** The initial plan (writing raw
  Opus via `prism.opus.OggLogicalBitstream`) was dropped: that API only exists in
  a GitHub/beta build of `prism-media`, not in stable npm (1.3.5). So we decode
  Opus to s16le PCM via `prism.opus.Decoder` (backed by `@discordjs/opus`), then
  **re-encode with ffmpeg** (`recording/encode.js`) to **Opus/Ogg 16 kHz mono**
  (~24 kbps). The ffmpeg binary ships with the `ffmpeg-static` package (no system
  install). Since Gemini resamples to 16 kHz internally, 16 kHz mono does not
  degrade transcription, and files are ~60× smaller than 48 kHz stereo WAV: a
  whole session often fits in a single Gemini call.
- **One .ogg file per turn:**
  `storage/<guildId>/<sessionId>/<userId>/<index>.ogg` (`startMs` lives in
  `timeline.json`).
- In parallel, `timeline.json` accumulates one entry per turn:
  `{ userId, displayName, index, startMs, endMs }` where `startMs` is relative to
  the session start. **This is the source of truth for order and timestamps.**

## Gemini transcription

**Chosen strategy (option A — per-turn splitting):**

- We build **one Gemini call** containing the utterances sorted by `startMs`,
  each as an *audio part* (`audio/ogg`) preceded by a text marker
  (`Utterance 12 — Alice — 00:03:12`), followed by the **context** (participant
  names, optional glossary/jargon) and a `responseSchema` = array of
  `{ index, text }`.
- The timestamp and speaker come from **our** timeline (deterministic); Gemini
  only provides the text. Reliable alignment, and the context improves proper
  nouns.

**Long sessions** (beyond the ~20 MB inline request limit): split into batches,
several calls, results concatenated. A batch that gets truncated
(`finishReason: MAX_TOKENS`) is split in half and retried; transient errors
(429/5xx) are retried with backoff; a failed batch degrades to missing turns
rather than failing the whole run. Switching to the Gemini File API for very
large sessions is a future enhancement (not yet implemented).

**Model:** `gemini-2.5-flash` by default (fast, cheap, good at audio),
`gemini-2.5-pro` configurable via `.env` for difficult audio.
**SDK:** `@google/genai`.
**Language:** configurable, English default (hint passed to Gemini).

## Merge & output

- Sort all utterances by `startMs`, inject the text returned by Gemini, render
  two artifacts:
  - `transcript.md`: `[HH:MM:SS] Alice: …`, one line per turn.
  - `transcript.json`: `[{ start, end, speaker, userId, text }]`.
- Turns Gemini did not return are kept with a visible `[missing transcription]`
  marker so data loss is surfaced.
- The bot posts a short message in the channel where `/stop` was run and attaches
  both files (oversized attachments are skipped and kept on disk).
- The `.ogg` files and `timeline.json` are **kept on disk** after publishing
  (allows re-transcription if the Gemini call fails).

## Commands & consent

- `/record`: joins the caller's voice channel, starts recording, **announces the
  recording** in the text channel (GDPR / Discord ToS consent). Refuses if the
  caller is not in voice or a session is already active on the server.
- `/stop`: ends the session, transcribes, publishes. Refuses if no session is
  active.
- `/cancel`: ends the session, leaves voice, **discards the recorded audio** and
  transcribes nothing (never sent to Gemini). Refuses if no session is active.

## Error handling

- **No one spoke** → graceful message, no Gemini call.
- **Voice disconnect mid-session** → try to recover; otherwise tear down and free
  the guild slot so it isn't wedged.
- **Gemini call failure** → keep audio + timeline, clear error message in the
  channel; manual re-transcription remains possible (files are there).
- **Discord posting failure** → reported separately from transcription, so a
  successful transcript isn't mislabeled as failed.
- **Missing native modules** (sodium, opus) → voice connection fails; documented
  in the README.

## Stack & deployment

- **Runtime:** Node 22.12+.
- **Dependencies:** discord.js v14, `@discordjs/voice`, `prism-media`,
  `sodium-native`, `@discordjs/opus`, `ffmpeg-static`, `@google/genai`.
- **Config (`.env`):** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GEMINI_API_KEY`,
  `GEMINI_MODEL`, `TRANSCRIPT_LANG`, `SILENCE_MS`, `GUILD_ID` (optional, for fast
  command registration in dev).
- **Dev:** on Windows (npm install builds the native modules; build
  prerequisites documented in the README).
- **Prod:** Docker on Debian (`node:22-bookworm-slim` + `build-essential`),
  volume mounted for `storage/`.

### Project structure

```
src/
  index.js
  config.js
  commands/
    record.js
    stop.js
  recording/
    session.js
    recorder.js
    encode.js
    registry.js
  transcription/
    gemini.js
    gemini-core.js
    merge.js
  output/
    publish.js
  util/
    time.js
storage/              # per-session data (audio + json), gitignored
docs/
Dockerfile
.env.example
README.md
package.json
```

## Tests

- **Unit:** `merge.js` (sort/format, pure functions), the parsing/chunking in
  `gemini-core.js`, the WAV/encode path, and `flushPending`. Request building is
  factored to be testable without the network.
- **Recorder (live audio):** hard to test without a real voice connection →
  manual test checklist; the ffmpeg encode path is covered by a real integration
  test using the bundled `ffmpeg-static`.
- Transparency about what is covered vs. manually verified.

## Out of scope (YAGNI)

- Real-time transcription / live captions.
- Local STT (faster-whisper / whisper.cpp) — dropped in favor of Gemini.
- Public multi-server bot with fine-grained per-participant consent.
- Diarization (unnecessary: Discord already separates per user).
- Automatic summary / minutes (possible later, not in this scope).
