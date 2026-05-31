import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { Session } from '../recording/session.js';
import { attachRecorder } from '../recording/recorder.js';
import { getSession, setSession, clearSession } from '../recording/registry.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Join your voice channel and start transcribing.')
  .setDMPermission(false);

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: 'Join a voice channel first, then run `/record`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (getSession(interaction.guildId)) {
    await interaction.reply({
      content: 'A recording session is already running on this server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reserve the per-guild slot synchronously (no await between the check above
  // and setSession) so a concurrent /record can't start a second session.
  const names = new Map();
  for (const [id, member] of voiceChannel.members) {
    names.set(id, member.displayName);
  }
  const session = new Session({
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    textChannel: interaction.channel,
    storageDir: config.storageDir,
    names,
  });
  setSession(interaction.guildId, session);

  // Immediate ACK: establishing the voice connection can exceed Discord's 3s window.
  await interaction.deferReply();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // CRUCIAL: otherwise the bot receives no audio
    selfMute: true,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] state: ${oldState.status} -> ${newState.status}`);
  });
  connection.on('error', (err) => {
    console.error('[voice] connection error:', err);
  });

  // If the connection drops mid-session, try to recover; otherwise tear down and
  // free the guild slot so it doesn't stay wedged as "already recording".
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Reconnecting on its own — let it.
    } catch {
      connection.destroy();
      if (getSession(interaction.guildId) === session) {
        clearSession(interaction.guildId);
      }
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(
      `[voice] never reached "ready" in 20s — last state: ${connection.state.status}`,
      '| detail:',
      err?.message ?? err,
    );
    connection.destroy();
    clearSession(interaction.guildId);
    await interaction.editReply('Could not connect to the voice channel.');
    return;
  }

  session.connection = connection;
  attachRecorder(connection, session, { silenceMs: config.silenceMs });

  await interaction.editReply(
    '🔴 **Recording started.** This voice channel is being recorded for ' +
      'transcription. Type `/stop` to finish.',
  );
}
