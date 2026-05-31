import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePcmToOpus } from '../src/recording/encode.js';

// Integration test: actually exercises ffmpeg-static + libopus.
test('encodePcmToOpus produces a valid Ogg/Opus file from PCM', async () => {
  // 0.5s of s16le 48 kHz stereo PCM (silence is enough to validate the container).
  const samples = 48000 / 2;
  const pcm = Buffer.alloc(samples * 2 * 2); // 2 channels * 2 bytes

  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  const file = path.join(dir, 'out.ogg');
  try {
    await encodePcmToOpus(Readable.from(pcm), file, { outRate: 16000, bitrate: '24k' });
    const buf = await readFile(file);
    assert.ok(buf.length > 0, 'non-empty file');
    assert.equal(buf.toString('ascii', 0, 4), 'OggS', 'Ogg magic at start of file');
    assert.ok(buf.includes(Buffer.from('OpusHead')), 'OpusHead header present');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
