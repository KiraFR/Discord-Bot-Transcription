# Discord Transcription Bot

A Discord bot that joins a voice channel on command, records **each participant
separately**, then delegates transcription to **Gemini** at the end of the
session to produce a **merged chronological transcript** (who said what, in
order, timestamped). The result is posted in the text channel.

> Detailed design:
> [docs/superpowers/specs/2026-05-31-discord-transcription-bot-design.md](docs/superpowers/specs/2026-05-31-discord-transcription-bot-design.md)

## How it works

- `/record` → the bot joins your voice channel, **announces the recording**, and
  captures each user's audio into a separate `.ogg` (one file per utterance),
  logging the timing in `timeline.json`.
- `/stop` → the bot leaves the voice channel, sends the audio + context to
  Gemini, gets back the text per utterance, merges it chronologically from the
  timeline, and posts `transcript.md` + `transcript.json` in the channel.

Discord already delivers a **per-user audio stream**: no diarization needed, one
file = one speaker. Opus is decoded to PCM (via `@discordjs/opus`) then
re-encoded to **Opus/Ogg 16 kHz mono** via ffmpeg — tiny files, with no loss in
transcription quality (Gemini resamples to 16 kHz anyway). The ffmpeg binary is
provided by `ffmpeg-static`: no system install required.

> ⚠️ **GDPR / consent.** The bot sends participants' voices to Google (Gemini
> API) and announces it on start. Intended for a private server with informed
> participants. Revisit the legal aspects if the bot becomes public.

## Requirements

- **Node.js ≥ 22.12**
- A **Discord bot** (token + client ID)
- A **Gemini API key** (Google AI Studio)
- **ffmpeg**: no need to install it — the binary ships with the `ffmpeg-static`
  package (downloaded during `npm install`).
- For the native modules (`sodium-native`, `@discordjs/opus`):
  - **Windows**: prebuilt binaries are usually fetched automatically. If the
    build fails, install the build tools ("Desktop development with C++" via
    Visual Studio Build Tools, + Python 3).
  - **Debian/Linux**: `apt-get install build-essential python3` (already handled
    by the `Dockerfile`).

## Install

```bash
npm install
cp .env.example .env   # then fill in the values
```

### Create the Discord bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token into `DISCORD_TOKEN`.
3. **General Information** tab → copy the **Application ID** into
   `DISCORD_CLIENT_ID`.
4. **Bot** tab → enable the **Server Members Intent** (used for display names).
   The *Voice State* intent is enabled by default.
5. **Invite the bot**: **OAuth2 → URL Generator** tab, scopes `bot` +
   `applications.commands`, permissions **Connect**, **Speak**, **Send
   Messages**, **Attach Files**. Open the generated URL to add it to your server.

### Gemini key

<https://aistudio.google.com/apikey> → create a key and put it in
`GEMINI_API_KEY`. Default model: `gemini-2.5-flash` (fast and cheap).

### Environment variables

See [.env.example](.env.example). In development, set `GUILD_ID` (your test
server's ID) so the slash commands appear **immediately**; without it,
registration is global and can take up to ~1h to propagate.

## Run

```bash
npm start
```

Then in Discord: join a voice channel, type `/record`, talk, then `/stop`.

## Tests

The pure functions (merging, formatting, parsing Gemini's response, WAV/Opus
encoding) are covered by tests that run **without a token or network
dependencies** (the ffmpeg encode test uses the bundled `ffmpeg-static`):

```bash
npm test
```

Live audio capture (`recording/recorder.js`) is not covered by automated tests —
verify it manually in real conditions (`/record` → talk → `/stop`).

## Docker deployment (Debian)

```bash
docker build -t discord-transcription-bot .
docker run --env-file .env -v "$PWD/storage:/app/storage" discord-transcription-bot
```

The `storage/` volume keeps audio and transcripts across runs.

## Structure

```
src/
  index.js                  # Discord client, command registration, routing
  config.js                 # loads/validates .env
  commands/record.js        # /record: joins voice, starts capture
  commands/stop.js          # /stop: transcribes, merges, publishes
  recording/session.js      # session state (paths, timeline, names)
  recording/recorder.js     # capture Opus -> PCM -> ffmpeg -> .ogg + timing log
  recording/encode.js       # re-encode PCM -> Opus/Ogg 16k mono (ffmpeg)
  recording/registry.js     # active sessions per server
  transcription/gemini.js       # Gemini network call
  transcription/gemini-core.js  # request building / parsing (pure, tested)
  transcription/merge.js        # chronological merge + md/json render (pure, tested)
  output/publish.js         # Discord post + attachments
storage/                    # per-session data (audio + transcripts), gitignored
```
