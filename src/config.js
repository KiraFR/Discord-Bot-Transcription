import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // Optionnel : si défini, les commandes sont enregistrées sur ce seul serveur
  // (propagation instantanée, pratique en dev). Sinon enregistrement global.
  guildId: process.env.GUILD_ID || null,

  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  transcriptLang: process.env.TRANSCRIPT_LANG || 'français',
  silenceMs: Number(process.env.SILENCE_MS || 800),
  storageDir: process.env.STORAGE_DIR || 'storage',
  // Noms propres / jargon passés à Gemini pour améliorer la transcription.
  glossary: process.env.GLOSSARY || '',
};
