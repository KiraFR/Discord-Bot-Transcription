import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession, clearSession } from '../recording/registry.js';
import { flushPending, stopAllStreams } from '../recording/recorder.js';
import { transcribeSession, isFatalQuotaError } from '../transcription/gemini.js';
import { mergeTranscript, renderMarkdown, renderJson, countMissing } from '../transcription/merge.js';
import { publishTranscript } from '../output/publish.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop recording, transcribe and publish the result.')
  .setDMPermission(false);

// editReply can fail if the interaction token has expired (long sessions);
// never let that cascade into another throw.
async function safeEdit(interaction, content) {
  try {
    await interaction.editReply(content);
  } catch (err) {
    console.error('[stop] editReply failed:', err.message);
  }
}

export async function execute(interaction) {
  const session = getSession(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: 'No recording session is running.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  clearSession(interaction.guildId);

  await interaction.deferReply();

  // Cut in-progress captures, wait for them to finalize, then leave voice.
  stopAllStreams(session);
  console.log(`[stop] stopping captures; waiting for ${session.pending.size} in progress…`);
  await flushPending(session);
  console.log('[stop] captures done.');
  session.connection?.destroy();
  session.writeTimeline();

  if (session.utterances.length === 0) {
    await safeEdit(interaction, 'No one spoke — nothing to transcribe.');
    return;
  }

  // 1) Transcribe — a failure here genuinely means transcription failed.
  let merged;
  try {
    console.log(`[stop] sending ${session.utterances.length} utterance(s) to Gemini (${config.geminiModel})…`);
    const results = await transcribeSession(session.utterances, {
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      lang: config.transcriptLang,
      glossary: config.glossary,
      participants: session.participants(),
    });
    console.log(`[stop] Gemini responded: ${results.length} segment(s).`);
    merged = mergeTranscript(session.utterances, results);
  } catch (err) {
    console.error('[stop] transcription failed:', err);
    const quota = isFatalQuotaError(err);
    const embed = new EmbedBuilder()
      .setColor(0xed4245) // Discord red
      .setTitle(quota ? '❌ Transcription failed — Gemini quota / credits' : '❌ Transcription failed')
      .setDescription(
        quota
          ? 'Gemini refused the request for a **quota / credits** reason. ' +
            'Check your project billing on [Google AI Studio](https://aistudio.google.com/).'
          : `\`\`\`${String(err.message).slice(0, 1000)}\`\`\``,
      )
      .setFooter({ text: `Audio kept in ${session.dir} — you can retry.` });
    await safeEdit(interaction, { embeds: [embed] });
    return;
  }

  // 2) Render + persist artifacts.
  const markdown = renderMarkdown(merged, {
    date: new Date(session.startTime).toLocaleString('en-GB'),
    participants: session.participants(),
    durationMs: session.durationMs(),
  });
  const json = renderJson(merged);
  try {
    await writeFile(path.join(session.dir, 'transcript.md'), markdown, 'utf8');
    await writeFile(path.join(session.dir, 'transcript.json'), JSON.stringify(json, null, 2), 'utf8');
  } catch (err) {
    console.error('[stop] writing transcript files failed:', err.message);
  }

  // 3) Publish — a failure here means posting failed, NOT transcription.
  try {
    await publishTranscript(session.textChannel, {
      markdown,
      json,
      meta: {
        participants: session.participants(),
        utteranceCount: merged.length,
        missingCount: countMissing(merged),
      },
    });
    await safeEdit(interaction, '✅ Transcript published.');
  } catch (err) {
    console.error('[stop] publishing failed:', err);
    await safeEdit(
      interaction,
      `⚠️ Transcription succeeded but posting failed: ${err.message}\nFiles are saved in \`${session.dir}\`.`,
    );
  }
}
