import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

function ffmpegArgs(inRate, inChannels, outRate, bitrate) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 's16le', // input: raw PCM
    '-ar', String(inRate),
    '-ac', String(inChannels),
    '-i', 'pipe:0',
    '-ar', String(outRate), // output: resampled
    '-ac', '1', // mono
    '-c:a', 'libopus',
    '-b:a', bitrate,
    '-f', 'ogg',
    'pipe:1',
  ];
}

/**
 * Encode a PCM s16le stream into Opus/Ogg (mono, resampled) at `file`.
 *
 * On any error the ffmpeg process is killed and the output stream destroyed, so
 * no zombie process or open file descriptor is left behind.
 *
 * @param {import('node:stream').Readable} pcmStream  interleaved PCM s16le
 * @param {string} file  output .ogg path
 * @returns {Promise<void>} resolves once ffmpeg exits and the file is written
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

    const cleanup = () => {
      try {
        ff.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      out.destroy();
      pcmStream.destroy();
    };

    const finish = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        cleanup();
        reject(err);
      } else if (ffDone && outDone) {
        settled = true;
        resolve();
      }
    };

    ff.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    ff.on('error', finish); // e.g. ffmpeg binary not found
    ff.stdin.on('error', () => {}); // EPIPE if ffmpeg dies before the pipe ends
    pcmStream.on('error', finish);
    out.on('error', finish);

    ff.stdout.pipe(out);

    ff.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`ffmpeg failed (code ${code}): ${stderr.trim()}`));
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
