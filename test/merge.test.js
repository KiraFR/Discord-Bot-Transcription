import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranscript, renderMarkdown, renderJson } from '../src/transcription/merge.js';
import { formatTimestamp } from '../src/util/time.js';
import { parseResponse, chunkBySize, buildParts } from '../src/transcription/gemini-core.js';
import { pcmToWav } from '../src/recording/wav.js';

test('formatTimestamp formate en HH:MM:SS', () => {
  assert.equal(formatTimestamp(0), '00:00:00');
  assert.equal(formatTimestamp(1000), '00:00:01');
  assert.equal(formatTimestamp(61_000), '00:01:01');
  assert.equal(formatTimestamp(3_661_000), '01:01:01');
});

test('mergeTranscript fusionne, trie par startMs et associe le texte par index', () => {
  const timeline = [
    { index: 0, userId: 'u1', displayName: 'Alice', startMs: 5000, endMs: 7000 },
    { index: 1, userId: 'u2', displayName: 'Bob', startMs: 1000, endMs: 2000 },
  ];
  const results = [
    { index: 1, text: 'Salut' },
    { index: 0, text: 'Bonjour' },
  ];
  const merged = mergeTranscript(timeline, results);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].speaker, 'Bob'); // startMs plus petit => en premier
  assert.equal(merged[0].text, 'Salut');
  assert.equal(merged[1].speaker, 'Alice');
  assert.equal(merged[1].start, '00:00:05');
});

test('mergeTranscript ignore les prises de parole sans texte', () => {
  const timeline = [
    { index: 0, userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000 },
    { index: 1, userId: 'u1', displayName: 'Alice', startMs: 2000, endMs: 3000 },
  ];
  const results = [
    { index: 0, text: '   ' },
    { index: 1, text: 'ok' },
  ];
  const merged = mergeTranscript(timeline, results);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'ok');
});

test('renderMarkdown produit une ligne horodatée par prise de parole', () => {
  const merged = [
    {
      index: 0, start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
      speaker: 'Bob', userId: 'u2', text: 'Salut',
    },
  ];
  const md = renderMarkdown(merged, { participants: ['Alice', 'Bob'] });
  assert.match(md, /\*\*\[00:00:01\] Bob :\*\* Salut/);
  assert.match(md, /Participants :\*\* Alice, Bob/);
});

test('renderJson expose les champs structurés', () => {
  const merged = [
    {
      index: 0, start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
      speaker: 'Bob', userId: 'u2', text: 'Salut',
    },
  ];
  const json = renderJson(merged);
  assert.deepEqual(json[0], {
    start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
    speaker: 'Bob', userId: 'u2', text: 'Salut',
  });
});

test('parseResponse parse un tableau JSON et normalise', () => {
  const out = parseResponse('[{"index":0,"text":"a"},{"index":1,"text":"b"}]');
  assert.deepEqual(out, [
    { index: 0, text: 'a' },
    { index: 1, text: 'b' },
  ]);
});

test('parseResponse rejette du non-JSON', () => {
  assert.throws(() => parseResponse('pas du json'));
});

test('parseResponse rejette un objet non-tableau', () => {
  assert.throws(() => parseResponse('{"index":0}'));
});

test('chunkBySize isole chaque entrée quand la limite est petite', () => {
  const entries = [
    { index: 0, audioBase64: 'aaaa' },
    { index: 1, audioBase64: 'bbbb' },
    { index: 2, audioBase64: 'cccc' },
  ];
  const batches = chunkBySize(entries, 6);
  assert.equal(batches.length, 3);
});

test('chunkBySize garde un seul lot si tout rentre', () => {
  const entries = [
    { index: 0, audioBase64: 'aa' },
    { index: 1, audioBase64: 'bb' },
  ];
  const batches = chunkBySize(entries, 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test('pcmToWav préfixe un en-tête RIFF/WAVE valide', () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 8 octets de PCM
  const wav = pcmToWav(pcm, { sampleRate: 48000, channels: 2, bitDepth: 16 });

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length); // taille du fichier - 8
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 2); // canaux
  assert.equal(wav.readUInt32LE(24), 48000); // sample rate
  assert.equal(wav.readUInt32LE(28), 48000 * 2 * 2); // byte rate
  assert.equal(wav.readUInt16LE(34), 16); // bits par échantillon
  assert.equal(wav.readUInt32LE(40), pcm.length); // taille des données
});

test('buildParts intercale marqueur texte + audio et démarre par le préambule', () => {
  const parts = buildParts(
    [{ index: 3, displayName: 'Alice', startMs: 5000, audioBase64: 'ZZ', mimeType: 'audio/ogg' }],
    { lang: 'français', participants: ['Alice'], glossary: '' },
  );
  assert.equal(parts.length, 3); // préambule + marqueur + audio
  assert.match(parts[0].text, /JSON/);
  assert.match(parts[1].text, /Utterance 3 — Alice — 00:00:05/);
  assert.deepEqual(parts[2].inlineData, { mimeType: 'audio/ogg', data: 'ZZ' });
});
