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

// Load plugins from config on startup
if (config.plugins && config.plugins.length > 0) {
  console.log(`Loading ${config.plugins.length} plugin(s) from config...`);
  for (const pluginName of config.plugins) {
    await pluginManager.loadPluginSilent(pluginName);
  }
}

bot.addListener('registered', () => {
  console.log(`Connected to ${config.server}`);
});

bot.addListener('join', (channel, nick) => {
  pluginManager.handleJoin(channel, nick);
});

const handleMessage = async (from: string, to: string, message: string) => {
  const prefix = config.prefix;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loadMatch = message.match(new RegExp(`^${escapedPrefix}load (\\w+)`, 'i'));
  const unloadMatch = message.match(new RegExp(`^${escapedPrefix}unload (\\w+)`, 'i'));
  const reloadMatch = message.match(new RegExp(`^${escapedPrefix}reload (\\w+)`, 'i'));
  const reloadConfigMatch = message.match(new RegExp(`^${escapedPrefix}reloadconfig`, 'i'));
  const isAdmin = config.admins.includes(from);

  if (loadMatch || unloadMatch || reloadMatch || reloadConfigMatch) {
    if (!isAdmin) {
      bot.say(to, 'You are not authorized to manage plugins.');
      return;
    }
  }

  if (reloadConfigMatch) {
    try {
      // Reload config with cache bust
      const configModule = await import('./config.ts?update=' + Date.now());
      const parsed = BotConfigSchema.safeParse(configModule.default);
      if (!parsed.success) {
        bot.say(to, 'Failed to reload config: Invalid configuration.');
        console.error('Config validation error:', parsed.error.format());
        return;
      }
      config = parsed.data;
      bot.say(to, 'Config reloaded successfully. Note: Some plugins may need to be reloaded to pick up changes.');
    } catch (err) {
      bot.say(to, `Failed to reload config: ${err}`);
      console.error('Config reload error:', err);
    }
    return;
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
  pluginManager.handleMessage(from, to, message, config);
};

bot.addListener('message', async (from, to, message) => {
  await handleMessage(from, to, message);
});

// Handle private messages explicitly
bot.addListener('pm', async (from, message) => {
  console.log(`PM from ${from}: ${message}`);
  await handleMessage(from, from, message);
});

bot.addListener('error', (message) => {
  console.error('IRC Error:', message);
});
