import { Client, GatewayIntentBits, Events, REST, Routes, MessageFlags } from 'discord.js';
import { config } from './config.js';
import * as record from './commands/record.js';
import * as stop from './commands/stop.js';

const commands = [record, stop];
const commandMap = new Map(commands.map((c) => [c.data.name, c]));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

async function registerCommands() {
  const rest = new REST().setToken(config.discordToken);
  const body = commands.map((c) => c.data.toJSON());
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.guildId), {
      body,
    });
    console.log(`Commands registered on guild ${config.guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.discordClientId), { body });
    console.log('Global commands registered (propagation up to ~1h).');
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[interaction] ${interaction.commandName}:`, err);
    const msg = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// Don't let an async error in the voice/recorder stack take the whole bot down.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

try {
  await registerCommands();
  await client.login(config.discordToken);
} catch (err) {
  console.error(
    'Startup failed — check DISCORD_TOKEN, the applications.commands scope, and DISCORD_CLIENT_ID.',
  );
  console.error(err);
  process.exit(1);
}
