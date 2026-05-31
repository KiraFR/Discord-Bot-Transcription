import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSession, clearSession } from '../recording/registry.js';
import { flushPending } from '../recording/recorder.js';
import { transcribeSession } from '../transcription/gemini.js';
import { mergeTranscript, renderMarkdown, renderJson } from '../transcription/merge.js';
import { publishTranscript } from '../output/publish.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Arrête l’enregistrement, transcrit et publie le résultat.');

export async function execute(interaction) {
  const session = getSession(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: 'Aucune session d’enregistrement en cours.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  clearSession(interaction.guildId);

  await interaction.deferReply();

  // Quitte le vocal et laisse les captures en cours se terminer.
  session.connection?.destroy();
  console.log(`[stop] connexion fermée ; attente de ${session.pending.size} capture(s)…`);
  await flushPending(session);
  console.log('[stop] captures terminées.');
  session.writeTimeline();

  if (session.utterances.length === 0) {
    await interaction.editReply('Personne n’a parlé — rien à transcrire.');
    return;
  }

  try {
    console.log(`[stop] envoi de ${session.utterances.length} utterance(s) à Gemini (${config.geminiModel})…`);
    const results = await transcribeSession(session.utterances, {
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      lang: config.transcriptLang,
      glossary: config.glossary,
      participants: session.participants(),
    });
    console.log(`[stop] Gemini a répondu : ${results.length} segment(s).`);

    const merged = mergeTranscript(session.utterances, results);
    const markdown = renderMarkdown(merged, {
      date: new Date(session.startTime).toLocaleString('fr-FR'),
      participants: session.participants(),
      durationMs: session.durationMs(),
    });
    const json = renderJson(merged);

    writeFileSync(path.join(session.dir, 'transcript.md'), markdown, 'utf8');
    writeFileSync(
      path.join(session.dir, 'transcript.json'),
      JSON.stringify(json, null, 2),
      'utf8',
    );

    await publishTranscript(session.textChannel, {
      markdown,
      json,
      meta: { participants: session.participants(), utteranceCount: merged.length },
    });
    await interaction.editReply('✅ Transcription publiée.');
  } catch (err) {
    console.error('[stop] transcription échouée :', err);
    const isQuota =
      err?.status === 429 || /RESOURCE_EXHAUSTED|quota|credits|crédits/i.test(err?.message ?? '');
    const reason = isQuota
      ? 'quota / crédits Gemini épuisés — vérifie la facturation de ton projet sur AI Studio.'
      : err.message;
    await interaction.editReply(
      `❌ La transcription a échoué : ${reason}\n` +
        `L’audio est conservé dans \`${session.dir}\` pour réessayer.`,
    );
  }
}
