import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { rm } from 'node:fs/promises';
import { getSession, clearSession } from '../recording/registry.js';
import { flushPending, stopAllStreams } from '../recording/recorder.js';

export const data = new SlashCommandBuilder()
  .setName('cancel')
  .setDescription('Stop and discard the recording without transcribing.')
  .setDMPermission(false);

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

  // Stop capturing and let in-flight writes settle (so no file handle is open
  // when we delete), then leave voice.
  stopAllStreams(session);
  await flushPending(session);
  session.connection?.destroy();

  // Discard the recorded audio — nothing is ever sent to Gemini.
  try {
    await rm(session.dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[cancel] could not delete session dir:', err.message);
  }

  await interaction
    .editReply('🚫 Recording cancelled — nothing was sent to Gemini and the audio was discarded.')
    .catch(() => {});
}
