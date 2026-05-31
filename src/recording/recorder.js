import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { pcmToWav } from './wav.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/**
 * Branche l'enregistrement sur une connexion vocale : à chaque prise de parole,
 * capture le flux Opus de l'utilisateur, le décode en PCM, écrit un WAV et
 * logge son timing.
 */
export function attachRecorder(connection, session, { silenceMs = 800 } = {}) {
  const receiver = connection.receiver;
  const active = new Set(); // évite les doubles abonnements pendant une prise de parole

  receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);

    const promise = captureUtterance(receiver, userId, session, silenceMs)
      .catch((err) => console.error(`[recorder] capture ${userId} échouée :`, err))
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

  // Flux Opus brut, terminé après `silenceMs` de silence = fin de la prise de parole.
  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
  });

  // Décodage Opus -> PCM s16le via @discordjs/opus (pas de ffmpeg).
  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: 960,
  });

  const chunks = [];
  await pipeline(opusStream, decoder, async (source) => {
    for await (const chunk of source) chunks.push(chunk);
  });

  const wav = pcmToWav(Buffer.concat(chunks), {
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitDepth: 16,
  });
  await writeFile(file, wav);

  session.commitUtterance({
    index,
    userId,
    displayName,
    startMs,
    endMs: session.durationMs(),
    file,
  });
}

/** Attend la fin de toutes les captures en cours (à appeler avant de transcrire). */
export async function flushPending(session) {
  await Promise.allSettled([...session.pending]);
}
