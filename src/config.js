import 'dotenv/config';

const missing = [];

function required(name) {
  const value = process.env[name];
  if (!value) {
    missing.push(name);
    return '';
  }
  return value;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // Optional: if set, commands are registered to this single guild (instant
  // propagation, handy in dev). Otherwise they are registered globally.
  guildId: process.env.GUILD_ID || null,

  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Transcription target language (hint passed to Gemini).
  transcriptLang: process.env.TRANSCRIPT_LANG || 'French',
  // Silence (ms) that ends a turn of speech; falls back to 800 on bad input.
  silenceMs: positiveInt('SILENCE_MS', 800),
  storageDir: process.env.STORAGE_DIR || 'storage',
  // Proper nouns / jargon passed to Gemini to improve transcription.
  glossary: process.env.GLOSSARY || '',
};

// Fail fast, listing every missing variable at once.
if (missing.length > 0) {
  throw new Error(`Missing environment variable(s): ${missing.join(', ')}`);
}
