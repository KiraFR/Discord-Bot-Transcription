import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { encodePcmToOpus } from './encode.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const OUT_RATE = 16000; // Gemini ré-échantillonne à 16 kHz : inutile d'envoyer plus
const BITRATE = '24k';

/**
 * Branche l'enregistrement sur une connexion vocale : à chaque prise de parole,
 * capture le flux Opus, le décode en PCM, le ré-encode en Opus/Ogg 16 kHz mono
 * (via ffmpeg) et logge son timing.
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
  session.activeStreams.add(opusStream);

  // Opus 48 kHz stéréo -> PCM s16le (via @discordjs/opus).
  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: 960,
  });
  opusStream.on('error', (err) => decoder.destroy(err));
  // Si le flux se ferme sans 'end' (connexion/abonnement coupé à /stop), on
  // termine le décodeur pour que ffmpeg finalise le fichier et que la capture
  // se résolve au lieu de rester pendante.
  opusStream.once('close', () => {
    if (!decoder.writableEnded) decoder.end();
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
  } finally {
    session.activeStreams.delete(opusStream);
  }
}

/** Coupe tous les abonnements audio en cours (à appeler à l'arrêt de la session). */
export function stopAllStreams(session) {
  for (const stream of session.activeStreams) {
    stream.destroy();
  }
}

/**
 * Attend la fin de toutes les captures en cours, avec un garde-fou : passé
 * `timeoutMs`, on continue quoi qu'il arrive (pour ne jamais figer /stop).
 */
export async function flushPending(session, timeoutMs = 10_000) {
  const all = Promise.allSettled([...session.pending]);
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
