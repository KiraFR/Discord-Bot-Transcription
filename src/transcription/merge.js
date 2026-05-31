import { formatTimestamp } from '../util/time.js';

// Placeholder used when Gemini returned no entry at all for an utterance index
// (as opposed to an explicit empty string, which means "inaudible" → dropped).
export const MISSING_TEXT = '[missing transcription]';

/**
 * Merge the timeline (source of truth for order and timestamps) with the texts
 * returned by Gemini (joined by `index`). Produces a chronologically sorted
 * list of utterances.
 *
 * - An index present in the results with empty/whitespace text is treated as
 *   "inaudible" and dropped.
 * - An index absent from the results is kept with a visible MISSING_TEXT marker
 *   so silent data loss (e.g. a truncated Gemini response) is surfaced.
 *
 * @param {Array<{index:number,userId:string,displayName:string,startMs:number,endMs:number}>} timeline
 * @param {Array<{index:number,text:string}>} geminiResults
 */
export function mergeTranscript(timeline, geminiResults) {
  const textByIndex = new Map(geminiResults.map((r) => [r.index, r.text]));
  return timeline
    .map((u) => {
      const present = textByIndex.has(u.index);
      const text = present ? (textByIndex.get(u.index) ?? '').trim() : MISSING_TEXT;
      return {
        index: u.index,
        startMs: u.startMs,
        endMs: u.endMs,
        start: formatTimestamp(u.startMs),
        end: formatTimestamp(u.endMs),
        userId: u.userId,
        speaker: u.displayName,
        text,
        missing: !present,
      };
    })
    .filter((u) => u.missing || u.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);
}

/** How many merged utterances are missing a transcription (for reporting). */
export function countMissing(merged) {
  return merged.filter((u) => u.missing).length;
}

/**
 * Render the merged transcript as readable Markdown.
 */
export function renderMarkdown(merged, meta = {}) {
  const lines = ['# Transcript', ''];
  if (meta.date) lines.push(`**Date:** ${meta.date}`);
  if (meta.participants?.length) {
    lines.push(`**Participants:** ${meta.participants.join(', ')}`);
  }
  if (meta.durationMs != null) {
    lines.push(`**Duration:** ${formatTimestamp(meta.durationMs)}`);
  }
  lines.push('', '---', '');
  for (const u of merged) {
    lines.push(`**[${u.start}] ${u.speaker}:** ${u.text}`, '');
  }
  return lines.join('\n');
}

/**
 * Render the merged transcript as a serializable JSON structure.
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
