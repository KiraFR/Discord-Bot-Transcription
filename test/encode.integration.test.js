import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePcmToOpus } from '../src/recording/encode.js';

// Test d'intégration : exerce réellement ffmpeg-static + libopus.
test('encodePcmToOpus produit un Ogg/Opus valide depuis du PCM', async () => {
  // 0,5 s de PCM s16le 48 kHz stéréo (du silence suffit à valider le conteneur).
  const samples = 48000 / 2;
  const pcm = Buffer.alloc(samples * 2 * 2); // 2 canaux * 2 octets

  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  const file = path.join(dir, 'out.ogg');
  try {
    await encodePcmToOpus(Readable.from(pcm), file, { outRate: 16000, bitrate: '24k' });
    const buf = await readFile(file);
    assert.ok(buf.length > 0, 'fichier non vide');
    assert.equal(buf.toString('ascii', 0, 4), 'OggS', 'magic Ogg en début de fichier');
    assert.ok(buf.includes(Buffer.from('OpusHead')), 'en-tête OpusHead présent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
