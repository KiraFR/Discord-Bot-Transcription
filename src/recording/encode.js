import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

function ffmpegArgs(inRate, inChannels, outRate, bitrate) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 's16le', // entrée : PCM brut
    '-ar', String(inRate),
    '-ac', String(inChannels),
    '-i', 'pipe:0',
    '-ar', String(outRate), // sortie : ré-échantillonnée
    '-ac', '1', // mono
    '-c:a', 'libopus',
    '-b:a', bitrate,
    '-f', 'ogg',
    'pipe:1',
  ];
}

/**
 * Encode un flux PCM s16le en Opus/Ogg (mono, ré-échantillonné) dans `file`.
 *
 * @param {import('node:stream').Readable} pcmStream  PCM s16le entrelacé
 * @param {string} file  chemin de sortie .ogg
 * @returns {Promise<void>} résolue quand ffmpeg a terminé et le fichier est écrit
 */
export function encodePcmToOpus(pcmStream, file, opts = {}) {
  const { inRate = 48000, inChannels = 2, outRate = 16000, bitrate = '24k' } = opts;

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ffmpegArgs(inRate, inChannels, outRate, bitrate));
    const out = createWriteStream(file);

    let stderr = '';
    let settled = false;
    let ffDone = false;
    let outDone = false;

    const finish = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        reject(err);
      } else if (ffDone && outDone) {
        settled = true;
        resolve();
      }
    };

    ff.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    ff.on('error', finish); // ex. binaire ffmpeg introuvable
    ff.stdin.on('error', () => {}); // EPIPE si ffmpeg meurt avant la fin du pipe
    pcmStream.on('error', finish);
    out.on('error', finish);

    ff.stdout.pipe(out);

    ff.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`ffmpeg a échoué (code ${code}) : ${stderr.trim()}`));
      } else {
        ffDone = true;
        finish();
      }
    });
    out.on('close', () => {
      outDone = true;
      finish();
    });

    pcmStream.pipe(ff.stdin);
  });
}
