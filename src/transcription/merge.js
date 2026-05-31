import { formatTimestamp } from '../util/time.js';

/**
 * Fusionne la timeline (source de vérité de l'ordre et des horodatages) avec
 * les textes renvoyés par Gemini (associés par `index`). Produit une liste
 * d'utterances triées chronologiquement, sans celles dont le texte est vide.
 *
 * @param {Array<{index:number,userId:string,displayName:string,startMs:number,endMs:number}>} timeline
 * @param {Array<{index:number,text:string}>} geminiResults
 */
export function mergeTranscript(timeline, geminiResults) {
  const textByIndex = new Map(geminiResults.map((r) => [r.index, r.text]));
  return timeline
    .map((u) => ({
      index: u.index,
      startMs: u.startMs,
      endMs: u.endMs,
      start: formatTimestamp(u.startMs),
      end: formatTimestamp(u.endMs),
      userId: u.userId,
      speaker: u.displayName,
      text: (textByIndex.get(u.index) ?? '').trim(),
    }))
    .filter((u) => u.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Rend le transcript fusionné en Markdown lisible.
 */
export function renderMarkdown(merged, meta = {}) {
  const lines = ['# Transcription', ''];
  if (meta.date) lines.push(`**Date :** ${meta.date}`);
  if (meta.participants?.length) {
    lines.push(`**Participants :** ${meta.participants.join(', ')}`);
  }
  if (meta.durationMs != null) {
    lines.push(`**Durée :** ${formatTimestamp(meta.durationMs)}`);
  }
  lines.push('', '---', '');
  for (const u of merged) {
    lines.push(`**[${u.start}] ${u.speaker} :** ${u.text}`, '');
  }
  return lines.join('\n');
}

/**
 * Rend le transcript fusionné en structure JSON sérialisable.
 */
export function renderJson(merged) {
  return merged.map((u) => ({
    start: u.start,
    end: u.end,
    startMs: u.startMs,
    endMs: u.endMs,
    speaker: u.speaker,
    userId: u.userId,
    text: u.text,
  }));
}
