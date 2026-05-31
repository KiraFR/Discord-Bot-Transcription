import { GoogleGenAI, Type } from '@google/genai';
import { readFile } from 'node:fs/promises';
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

// ~15 Mo de base64 par requête, sous la limite inline (~20 Mo) de l'API.
const MAX_BATCH_BASE64 = 15 * 1024 * 1024;

/**
 * Transcrit toutes les prises de parole d'une session.
 *
 * @param {Array<{index:number,displayName:string,startMs:number,file:string}>} timeline
 * @returns {Promise<Array<{index:number,text:string}>>}
 */
export async function transcribeSession(timeline, { apiKey, model, lang, glossary, participants }) {
  if (timeline.length === 0) return [];

  const sorted = [...timeline].sort((a, b) => a.startMs - b.startMs);

  const entries = [];
  for (const u of sorted) {
    const buf = await readFile(u.file);
    entries.push({
      index: u.index,
      displayName: u.displayName,
      startMs: u.startMs,
      audioBase64: buf.toString('base64'),
      mimeType: 'audio/wav',
    });
  }

  const ai = new GoogleGenAI({ apiKey });
  const batches = chunkBySize(entries, MAX_BATCH_BASE64);
  const results = [];

  for (const batch of batches) {
    const parts = buildParts(batch, { lang, glossary, participants });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    results.push(...parseResponse(response.text));
  }

  return results;
}
