import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTranscript,
  renderMarkdown,
  renderJson,
  countMissing,
  MISSING_TEXT,
} from '../src/transcription/merge.js';
import { formatTimestamp } from '../src/util/time.js';
import { parseResponse, chunkBySize, buildParts } from '../src/transcription/gemini-core.js';

test('formatTimestamp formats as HH:MM:SS', () => {
  assert.equal(formatTimestamp(0), '00:00:00');
  assert.equal(formatTimestamp(1000), '00:00:01');
  assert.equal(formatTimestamp(61_000), '00:01:01');
  assert.equal(formatTimestamp(3_661_000), '01:01:01');
});

test('formatTimestamp treats non-finite/negative input as 0', () => {
  assert.equal(formatTimestamp(NaN), '00:00:00');
  assert.equal(formatTimestamp(undefined), '00:00:00');
  assert.equal(formatTimestamp(-5000), '00:00:00');
});

test('mergeTranscript merges, sorts by startMs and joins text by index', () => {
  const timeline = [
    { index: 0, userId: 'u1', displayName: 'Alice', startMs: 5000, endMs: 7000 },
    { index: 1, userId: 'u2', displayName: 'Bob', startMs: 1000, endMs: 2000 },
  ];
  const results = [
    { index: 1, text: 'Hi' },
    { index: 0, text: 'Hello' },
  ];
  const merged = mergeTranscript(timeline, results);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].speaker, 'Bob'); // smaller startMs first
  assert.equal(merged[0].text, 'Hi');
  assert.equal(merged[1].speaker, 'Alice');
  assert.equal(merged[1].start, '00:00:05');
});

test('mergeTranscript drops inaudible (present but empty) utterances', () => {
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

test('mergeTranscript keeps a visible marker for indices Gemini did not return', () => {
  const timeline = [
    { index: 0, userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000 },
    { index: 1, userId: 'u2', displayName: 'Bob', startMs: 2000, endMs: 3000 },
  ];
  const results = [{ index: 0, text: 'present' }]; // index 1 missing
  const merged = mergeTranscript(timeline, results);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].text, MISSING_TEXT);
  assert.equal(merged[1].missing, true);
  assert.equal(countMissing(merged), 1);
});

test('renderMarkdown produces one timestamped line per utterance (English headers)', () => {
  const merged = [
    {
      index: 0, start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
      speaker: 'Bob', userId: 'u2', text: 'Hi',
    },
  ];
  const md = renderMarkdown(merged, { participants: ['Alice', 'Bob'] });
  assert.match(md, /# Transcript/);
  assert.match(md, /\*\*\[00:00:01\] Bob:\*\* Hi/);
  assert.match(md, /\*\*Participants:\*\* Alice, Bob/);
});

test('renderJson exposes the structured fields', () => {
  const merged = [
    {
      index: 0, start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
      speaker: 'Bob', userId: 'u2', text: 'Hi',
    },
  ];
  const json = renderJson(merged);
  assert.deepEqual(json[0], {
    start: '00:00:01', end: '00:00:02', startMs: 1000, endMs: 2000,
    speaker: 'Bob', userId: 'u2', text: 'Hi',
  });
});

test('parseResponse parses a JSON array and normalizes', () => {
  const out = parseResponse('[{"index":0,"text":"a"},{"index":1,"text":"b"}]');
  assert.deepEqual(out, [
    { index: 0, text: 'a' },
    { index: 1, text: 'b' },
  ]);
});

test('parseResponse rejects empty/undefined responses', () => {
  assert.throws(() => parseResponse(undefined));
  assert.throws(() => parseResponse(''));
});

test('parseResponse rejects non-JSON', () => {
  assert.throws(() => parseResponse('not json'));
});

test('parseResponse rejects a non-array object', () => {
  assert.throws(() => parseResponse('{"index":0}'));
});

test('chunkBySize isolates each entry when the limit is tiny', () => {
  const entries = [
    { index: 0, audioBase64: 'aaaa' },
    { index: 1, audioBase64: 'bbbb' },
    { index: 2, audioBase64: 'cccc' },
  ];
  const batches = chunkBySize(entries, 6);
  assert.equal(batches.length, 3);
});

test('chunkBySize keeps a single batch when everything fits', () => {
  const entries = [
    { index: 0, audioBase64: 'aa' },
    { index: 1, audioBase64: 'bb' },
  ];
  const batches = chunkBySize(entries, 1_000_000);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test('chunkBySize caps batches by utterance count', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ index: i, audioBase64: 'a' }));
  const batches = chunkBySize(entries, 1_000_000, 2); // size never the limit
  assert.deepEqual(batches.map((b) => b.length), [2, 2, 1]);
});

test('buildParts interleaves text marker + audio and starts with the preamble', () => {
  const parts = buildParts(
    [{ index: 3, displayName: 'Alice', startMs: 5000, audioBase64: 'ZZ', mimeType: 'audio/ogg' }],
    { lang: 'French', participants: ['Alice'], glossary: '' },
  );
  assert.equal(parts.length, 3); // preamble + marker + audio
  assert.match(parts[0].text, /JSON/);
  assert.match(parts[1].text, /Utterance 3 — Alice — 00:00:05/);
  assert.deepEqual(parts[2].inlineData, { mimeType: 'audio/ogg', data: 'ZZ' });
});
