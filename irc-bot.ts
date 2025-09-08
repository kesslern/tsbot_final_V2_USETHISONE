import irc from 'irc';

import path from 'path';
import { fileURLToPath } from 'url';
import { BotConfigSchema, type BotConfig } from './config-schema.ts';
import { PluginManager } from './plugin-manager.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config: BotConfig;
try {
  const configModule = await import('./config.ts');
  const parsed = BotConfigSchema.safeParse(configModule.default);
  if (!parsed.success) {
    console.error('Invalid config:', parsed.error.format());
    process.exit(1);
  }
  config = parsed.data;
} catch (err) {
  console.error('Failed to load config:', err);
  process.exit(1);
}

const bot = new irc.Client(config.server, config.nick, {
  channels: config.channels,
  port: config.port,
  autoConnect: true,
});

const pluginManager = new PluginManager(path.join(__dirname, 'plugins'), bot);

bot.addListener('registered', () => {
  console.log(`Connected to ${config.server}`);
});

bot.addListener('join', (channel, nick) => {
  pluginManager.handleJoin(channel, nick);
});

bot.addListener('message', async (from, to, message) => {
  const prefix = config.prefix;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loadMatch = message.match(new RegExp(`^${escapedPrefix}load (\\w+)`, 'i'));
  const unloadMatch = message.match(new RegExp(`^${escapedPrefix}unload (\\w+)`, 'i'));
  const reloadMatch = message.match(new RegExp(`^${escapedPrefix}reload (\\w+)`, 'i'));
  const isAdmin = config.admins.includes(from);
  if (loadMatch || unloadMatch || reloadMatch) {
    if (!isAdmin) {
      bot.say(to, 'You are not authorized to manage plugins.');
      return;
    }
  }
  if (loadMatch) {
    await pluginManager.loadPlugin(loadMatch[1], to);
    return;
  }
  if (unloadMatch) {
    pluginManager.unloadPlugin(unloadMatch[1], to);
    return;
  }
  if (reloadMatch) {
    await pluginManager.reloadPlugin(reloadMatch[1], to);
    return;
  }
  pluginManager.handleMessage(from, to, message);
});

bot.addListener('error', (message) => {
  console.error('IRC Error:', message);
});
