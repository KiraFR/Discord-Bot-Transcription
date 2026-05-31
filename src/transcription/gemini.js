import { GoogleGenAI, Type } from '@google/genai';
import { readFile, stat } from 'node:fs/promises';
import { buildParts, chunkBySize, parseResponse } from './gemini-core.js';

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      index: { type: Type.INTEGER },
      text: { type: Type.STRING },
    },
    required: ['index', 'text'],
  },
};

// Conservative cap on base64 size per request, well under the ~20 MB inline
// request limit, leaving headroom for markers/preamble/JSON overhead.
// Sessions larger than this are split across several requests.
const MAX_BATCH_BASE64 = 8 * 1024 * 1024;
// base64 inflates raw bytes by ~4/3.
const BASE64_RATIO = 4 / 3;

const MAX_OUTPUT_TOKENS = 65536;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  const status = err?.status ?? err?.code;
  if (RETRYABLE_STATUS.has(Number(status))) return true;
  return /\b(429|503|500|502|504|timeout|ECONNRESET|ETIMEDOUT|fetch failed)\b/i.test(
    err?.message ?? '',
  );
}

/**
 * Call Gemini once for a batch, with retry/backoff on transient errors.
 * Returns the response, or throws after exhausting attempts.
 */
async function generateWithRetry(ai, { model, parts, label }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        const backoff = 500 * 2 ** (attempt - 1);
        console.warn(`[gemini] ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message} — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Transcribe one batch of utterances. If the model truncates the JSON
 * (finishReason MAX_TOKENS) and the batch holds more than one utterance, split
 * it in half and recurse. Returns parsed { index, text } entries.
 */
async function transcribeBatch(ai, batch, meta) {
  const parts = buildParts(batch, meta);
  const label = `batch[${batch[0].index}..${batch.at(-1).index}]`;
  const response = await generateWithRetry(ai, { model: meta.model, parts, label });

  const finishReason = response?.candidates?.[0]?.finishReason;
  const blockReason = response?.promptFeedback?.blockReason;

  if ((finishReason === 'MAX_TOKENS' || !response.text) && batch.length > 1) {
    const mid = Math.ceil(batch.length / 2);
    console.warn(`[gemini] ${label} truncated/incomplete (finishReason=${finishReason}) — splitting in two.`);
    const left = await transcribeBatch(ai, batch.slice(0, mid), meta);
    const right = await transcribeBatch(ai, batch.slice(mid), meta);
    return [...left, ...right];
  }

  if (!response.text) {
    // Single utterance with no usable text: surface it rather than crash the run.
    console.warn(`[gemini] ${label} returned no text (finishReason=${finishReason}, blockReason=${blockReason ?? 'none'}).`);
    return batch.map((e) => ({ index: e.index, text: '' }));
  }

  return parseResponse(response.text);
}

/**
 * Transcribe all turns of a session.
 *
 * Reads audio lazily, one batch at a time, to bound memory. Each batch is sized
 * (estimated) under the inline request limit. A batch failure degrades to empty
 * texts for that batch rather than failing the whole session.
 *
 * @param {Array<{index:number,displayName:string,startMs:number,file:string}>} timeline
 * @returns {Promise<Array<{index:number,text:string}>>}
 */
export async function transcribeSession(timeline, { apiKey, model, lang, glossary, participants }) {
  if (timeline.length === 0) return [];

  const sorted = [...timeline].sort((a, b) => a.startMs - b.startMs);

  // Estimate base64 size from file size (without reading the audio yet).
  const sized = [];
  for (const u of sorted) {
    let bytes = 0;
    try {
      bytes = (await stat(u.file)).size;
    } catch {
      bytes = 0;
    }
    sized.push({ ...u, size: Math.ceil(bytes * BASE64_RATIO) });
  }

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  const batches = chunkBySize(sized, MAX_BATCH_BASE64);
  const meta = { model, lang, glossary, participants };
  const results = [];

  for (const batch of batches) {
    // Read this batch's audio just-in-time, then release it.
    const entries = [];
    for (const u of batch) {
      const buf = await readFile(u.file);
      entries.push({
        index: u.index,
        displayName: u.displayName,
        startMs: u.startMs,
        audioBase64: buf.toString('base64'),
        mimeType: 'audio/ogg',
      });
    }

    try {
      results.push(...(await transcribeBatch(ai, entries, meta)));
    } catch (err) {
      // One failed batch must not lose the rest of the session.
      console.error(`[gemini] batch [${batch[0].index}..${batch.at(-1).index}] permanently failed: ${err.message}`);
      // Leave these indices absent so merge marks them as missing.
    }
  }

  return results;
}
