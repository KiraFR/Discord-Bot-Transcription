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
// Also cap the number of utterances per request. Large requests (many audio
// parts) make Gemini exceed its own processing deadline (504 DEADLINE_EXCEEDED),
// so keep batches small; oversized ones are split adaptively (see transcribeBatch).
const MAX_BATCH_UTTERANCES = 40;
// base64 inflates raw bytes by ~4/3.
const BASE64_RATIO = 4 / 3;

const MAX_OUTPUT_TOKENS = 65536;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;
// Transient errors worth retrying at the SAME size (server-side blips/overload).
// 504/DEADLINE_EXCEEDED is deliberately excluded: it means the request is too
// heavy, so we split it smaller instead of retrying identically.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  const status = Number(err?.status ?? err?.code);
  if (RETRYABLE_STATUS.has(status)) return true;
  return /\b(500|502|503|ECONNRESET|ETIMEDOUT)\b|fetch failed/i.test(err?.message ?? '');
}

// A too-heavy request (timeout / deadline / gateway timeout): retrying the same
// size won't help — split it into smaller batches instead.
function isOverloadedOrTimeout(err) {
  const status = Number(err?.status ?? err?.code);
  return status === 504 || /DEADLINE_EXCEEDED|timed out|timeout/i.test(err?.message ?? '');
}

/**
 * Errors that won't be fixed by trying other batches (quota/credits exhausted,
 * billing, bad/forbidden API key). These should abort the whole run so the
 * caller can report them clearly, rather than being swallowed per-batch.
 */
export function isFatalQuotaError(err) {
  const status = Number(err?.status ?? err?.code);
  const msg = `${err?.message ?? ''}`;
  return (
    status === 401 ||
    status === 403 ||
    /RESOURCE_EXHAUSTED|quota|credit|billing|PERMISSION_DENIED|API[_ ]?key|exhausted/i.test(msg)
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

/** Accumulate a response's token usage into the running tally (billed even when truncated). */
function addUsage(usage, response) {
  const u = response?.usageMetadata;
  if (!u) return;
  const prompt = u.promptTokenCount ?? 0;
  const output = u.candidatesTokenCount ?? 0;
  usage.promptTokens += prompt;
  usage.outputTokens += output;
  usage.totalTokens += u.totalTokenCount ?? prompt + output;
}

/** Split a batch in two and transcribe each half (used when a request is too heavy). */
async function splitAndTranscribe(ai, batch, meta, usage) {
  const mid = Math.ceil(batch.length / 2);
  const left = await transcribeBatch(ai, batch.slice(0, mid), meta, usage);
  const right = await transcribeBatch(ai, batch.slice(mid), meta, usage);
  return [...left, ...right];
}

/**
 * Transcribe one batch of utterances. Adaptive: if the request times out / is
 * overloaded, or the model truncates the JSON (MAX_TOKENS) or returns no text,
 * and the batch holds more than one utterance, split it in half and recurse.
 * Token usage is accumulated into `usage`. Returns parsed { index, text } entries.
 */
async function transcribeBatch(ai, batch, meta, usage) {
  const label = `batch[${batch[0].index}..${batch.at(-1).index}]`;

  let response;
  try {
    response = await generateWithRetry(ai, {
      model: meta.model,
      parts: buildParts(batch, meta),
      label,
    });
  } catch (err) {
    if (isFatalQuotaError(err)) throw err; // abort whole run; caller reports it
    if (batch.length > 1 && (isOverloadedOrTimeout(err) || isRetryable(err))) {
      console.warn(`[gemini] ${label} ${err.message} — splitting into smaller batches.`);
      return splitAndTranscribe(ai, batch, meta, usage);
    }
    throw err; // single utterance or non-splittable error → caller marks missing
  }

  addUsage(usage, response); // count tokens even if we end up splitting below

  const finishReason = response?.candidates?.[0]?.finishReason;
  const blockReason = response?.promptFeedback?.blockReason;

  if ((finishReason === 'MAX_TOKENS' || !response.text) && batch.length > 1) {
    console.warn(`[gemini] ${label} truncated/incomplete (finishReason=${finishReason}) — splitting in two.`);
    return splitAndTranscribe(ai, batch, meta, usage);
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
 * @returns {Promise<{results: Array<{index:number,text:string}>, usage: {promptTokens:number,outputTokens:number,totalTokens:number}}>}
 */
export async function transcribeSession(timeline, { apiKey, model, lang, glossary, participants }) {
  const usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (timeline.length === 0) return { results: [], usage };

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
  const batches = chunkBySize(sized, MAX_BATCH_BASE64, MAX_BATCH_UTTERANCES);
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
      results.push(...(await transcribeBatch(ai, entries, meta, usage)));
    } catch (err) {
      // Quota/credits/auth errors won't be fixed by trying other batches — abort
      // the whole run so the caller can report it clearly (not silently lose
      // everything to "[missing transcription]").
      if (isFatalQuotaError(err)) throw err;
      // Otherwise, one failed batch must not lose the rest of the session.
      console.error(`[gemini] batch [${batch[0].index}..${batch.at(-1).index}] permanently failed: ${err.message}`);
      // Leave these indices absent so merge marks them as missing.
    }
  }

  return { results, usage };
}
