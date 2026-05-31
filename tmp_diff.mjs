import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './src/config.js';
import { transcribeSession } from './src/transcription/gemini.js';
import { mergeTranscript, renderMarkdown } from './src/transcription/merge.js';

// Dernière session disposant d'un timeline.json.
const storage = config.storageDir;
const sessions = [];
for (const guild of readdirSync(storage)) {
  const guildDir = path.join(storage, guild);
  for (const sess of readdirSync(guildDir)) {
    const tl = path.join(guildDir, sess, 'timeline.json');
    if (existsSync(tl)) sessions.push({ id: sess, dir: path.join(guildDir, sess), tl });
  }
}
sessions.sort((a, b) => a.id.localeCompare(b.id));
const session = sessions.at(-1);

const timeline = JSON.parse(readFileSync(session.tl, 'utf8'));
const participants = [...new Set(timeline.map((u) => u.displayName))];
const durationMs = Math.max(...timeline.map((u) => u.endMs));
console.log(`[diff] session ${session.id} — ${timeline.length} utterances — ${participants.join(', ')}`);

async function run(model) {
  console.log(`[diff] ${model}…`);
  const results = await transcribeSession(timeline, {
    apiKey: config.geminiApiKey,
    model,
    lang: config.transcriptLang,
    glossary: config.glossary,
    participants,
  });
  const merged = mergeTranscript(timeline, results);
  return renderMarkdown(merged, { date: session.id, participants, durationMs });
}

const proMd = await run('gemini-2.5-pro');

writeFileSync(path.join(session.dir, 'transcript.pro.md'), proMd, 'utf8');

console.log('\n========== PRO ==========\n');
console.log(proMd);
console.log(`\n[diff] écrit : ${path.join(session.dir, 'transcript.pro.md')}`);
