import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { Session } from '../recording/session.js';
import { attachRecorder } from '../recording/recorder.js';
import { getSession, setSession } from '../recording/registry.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Rejoint ton salon vocal et démarre la transcription.');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: 'Rejoins d’abord un salon vocal, puis relance `/record`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (getSession(interaction.guildId)) {
    await interaction.reply({
      content: 'Une session d’enregistrement est déjà en cours sur ce serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ACK immédiat : la connexion vocale peut dépasser la fenêtre de 3 s de Discord.
  await interaction.deferReply();

  // Pré-remplit la table des noms à partir des membres présents dans le vocal.
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

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // CRUCIAL : sinon le bot ne reçoit aucun audio
    selfMute: true,
  });

  // Instrumentation : trace les transitions d'état pour diagnostiquer un échec
  // de connexion vocale (reste en signalling/connecting, passe en disconnected…).
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] état : ${oldState.status} -> ${newState.status}`);
  });
  connection.on('error', (err) => {
    console.error('[voice] erreur de connexion :', err);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(
      `[voice] jamais "ready" en 20 s — dernier état : ${connection.state.status}`,
      '| détail :',
      err?.message ?? err,
    );
    connection.destroy();
    await interaction.editReply('Impossible de se connecter au salon vocal.');
    return;
  }

  session.connection = connection;
  attachRecorder(connection, session, { silenceMs: config.silenceMs });
  setSession(interaction.guildId, session);

  await interaction.editReply(
    '🔴 **Enregistrement démarré.** La conversation de ce salon vocal est ' +
      'enregistrée pour transcription. Tapez `/stop` pour terminer.',
  );
}
