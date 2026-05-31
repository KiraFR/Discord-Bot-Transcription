import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { encodePcmToOpus } from './encode.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const OUT_RATE = 16000; // Gemini resamples to 16 kHz: no point sending more
const BITRATE = '24k';

/**
 * Attach recording to a voice connection: on each turn of speech, capture the
 * Opus stream, decode it to PCM, re-encode to Opus/Ogg 16 kHz mono (via ffmpeg)
 * and log its timing.
 */
export function attachRecorder(connection, session, { silenceMs = 800 } = {}) {
  const receiver = connection.receiver;
  const active = new Set(); // avoid double-subscribing during a single turn

  receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);

    const promise = captureUtterance(receiver, userId, session, silenceMs)
      .catch((err) => console.error(`[recorder] capture for ${userId} failed:`, err))
      .finally(() => {
        active.delete(userId);
        session.pending.delete(promise);
      });
    session.pending.add(promise);
  });
}

async function captureUtterance(receiver, userId, session, silenceMs) {
  const startMs = session.durationMs();
  const displayName = session.resolveName(userId);
  const { index, file } = session.reserveUtterance(userId);

  // Raw Opus stream, ended after `silenceMs` of silence = end of the turn.
  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
  });
  session.activeStreams.add(opusStream);

  // Opus 48 kHz stereo -> PCM s16le (via @discordjs/opus).
  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: 960,
  });
  opusStream.on('error', (err) => decoder.destroy(err));
  // If the stream closes without 'end' (connection/subscription cut at /stop),
  // end the decoder so ffmpeg finalizes the file and the capture resolves
  // instead of hanging.
  opusStream.once('close', () => {
    if (!decoder.destroyed && !decoder.writableEnded) decoder.end();
  });

  try {
    // PCM -> ffmpeg -> Opus/Ogg 16 kHz mono.
    await encodePcmToOpus(opusStream.pipe(decoder), file, {
      inRate: SAMPLE_RATE,
      inChannels: CHANNELS,
      outRate: OUT_RATE,
      bitrate: BITRATE,
    });

    session.commitUtterance({
      index,
      userId,
      displayName,
      startMs,
      endMs: session.durationMs(),
      file,
    });
  } catch (err) {
    // Tear down both ends so nothing is left hanging on failure.
    opusStream.destroy();
    decoder.destroy();
    throw err;
  } finally {
    session.activeStreams.delete(opusStream);
  }
}

/** Cut all in-progress audio subscriptions (call when stopping the session). */
export function stopAllStreams(session) {
  for (const stream of session.activeStreams) {
    stream.destroy();
  }
}

/**
 * Wait for all in-progress captures to finish, with a safety net: past
 * `timeoutMs`, proceed regardless so /stop can never hang indefinitely.
 */
export async function flushPending(session, timeoutMs = 10_000) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled([...session.pending]), guard]);
  } finally {
    clearTimeout(timer);
  }
}
