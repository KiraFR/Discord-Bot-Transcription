import { formatTimestamp } from '../util/time.js';

/**
 * Construit le préambule (instructions + contexte) envoyé à Gemini.
 */
export function buildPreamble({ lang, participants, glossary }) {
  const parts = [
    "Tu es un transcripteur. On te fournit une série de clips audio, un par prise de parole, dans l'ordre chronologique.",
    'Chaque clip est précédé d\'un marqueur "Utterance N — <locuteur> — <horodatage>".',
    `Transcris fidèlement le contenu parlé de CHAQUE clip en ${lang}.`,
    'Ne traduis pas, ne résume pas, ne commente pas : restitue les mots prononcés.',
    'Si un clip est inaudible ou vide, renvoie une chaîne vide pour son index.',
    'Réponds en JSON : un tableau d\'objets { "index": <entier du marqueur>, "text": "<transcription>" }.',
  ];
  if (participants?.length) {
    parts.push(`Participants à la conversation : ${participants.join(', ')}.`);
  }
  if (glossary) {
    parts.push(`Vocabulaire / noms propres susceptibles d'apparaître : ${glossary}.`);
  }
  return parts.join('\n');
}

/**
 * Construit la liste de "parts" pour un appel Gemini : le préambule, puis pour
 * chaque utterance un marqueur texte suivi de son audio inline.
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
      inlineData: { mimeType: e.mimeType ?? 'audio/wav', data: e.audioBase64 },
    });
  }
  return parts;
}

/**
 * Découpe les utterances en lots dont la taille base64 cumulée reste sous
 * `maxBytes` (pour rester sous la limite de requête inline de l'API).
 */
export function chunkBySize(entries, maxBytes) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const e of entries) {
    const entrySize = e.audioBase64 ? e.audioBase64.length : 0;
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
 * Parse et normalise la réponse JSON de Gemini.
 * @returns {Array<{index:number,text:string}>}
 */
export function parseResponse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Réponse Gemini non-JSON : ${err.message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('Réponse Gemini : un tableau était attendu.');
  }
  return data
    .filter((r) => r && typeof r.index === 'number')
    .map((r) => ({ index: r.index, text: typeof r.text === 'string' ? r.text : '' }));
}
