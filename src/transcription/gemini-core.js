import { formatTimestamp } from '../util/time.js';

// Rough per-utterance overhead (text marker + JSON structure) added on top of
// the audio payload when sizing a batch, so we don't undershoot the request limit.
export const MARKER_OVERHEAD_BYTES = 160;

/**
 * Build the preamble (instructions + context) sent to Gemini.
 */
export function buildPreamble({ lang, participants, glossary }) {
  const parts = [
    'You are a transcriber. You are given a series of audio clips, one per turn of speech, in chronological order.',
    'Each clip is preceded by a marker "Utterance N — <speaker> — <timestamp>".',
    `Faithfully transcribe the spoken content of EACH clip in ${lang}.`,
    'Do not translate, summarize or comment: return the words as spoken.',
    'If a clip is inaudible or empty, return an empty string for its index.',
    'Return exactly one object per provided index.',
    'Respond as JSON: an array of objects { "index": <integer from the marker>, "text": "<transcription>" }.',
  ];
  if (participants?.length) {
    parts.push(`Conversation participants: ${participants.join(', ')}.`);
  }
  if (glossary) {
    parts.push(`Vocabulary / proper nouns that may appear: ${glossary}.`);
  }
  return parts.join('\n');
}

/**
 * Build the list of "parts" for a Gemini call: the preamble, then for each
 * utterance a text marker followed by its inline audio.
 *
 * @param {Array<{index:number,displayName:string,startMs:number,audioBase64:string,mimeType?:string}>} entries
 */
export function buildParts(entries, meta) {
  const parts = [{ text: buildPreamble(meta) }];
  for (const e of entries) {
    parts.push({
      text: `Utterance ${e.index} — ${e.displayName} — ${formatTimestamp(e.startMs)}`,
    });
    parts.push({
      inlineData: { mimeType: e.mimeType ?? 'audio/ogg', data: e.audioBase64 },
    });
  }
  return parts;
}

/**
 * Split utterances into batches whose cumulative size stays under `maxBytes`,
 * to remain below the inline request limit. Size is taken from `audioBase64`
 * length when present, otherwise from a pre-computed `size` field, plus a fixed
 * per-entry overhead for the marker/JSON.
 */
export function chunkBySize(entries, maxBytes) {
  const sizeOf = (e) =>
    (e.audioBase64 ? e.audioBase64.length : (e.size ?? 0)) + MARKER_OVERHEAD_BYTES;

  const batches = [];
  let current = [];
  let size = 0;
  for (const e of entries) {
    const entrySize = sizeOf(e);
    if (current.length > 0 && size + entrySize > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += entrySize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Parse and normalize Gemini's JSON response.
 * @returns {Array<{index:number,text:string}>}
 */
export function parseResponse(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Empty Gemini response (no text returned).');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Non-JSON Gemini response: ${err.message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('Gemini response: an array was expected.');
  }
  return data
    .filter((r) => r && typeof r.index === 'number')
    .map((r) => ({ index: r.index, text: typeof r.text === 'string' ? r.text : '' }));
}
