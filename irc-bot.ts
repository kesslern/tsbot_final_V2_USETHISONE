
import irc from 'irc';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BotConfigSchema, type BotConfig } from './config-schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Plugin = {
    name: string;
    onMessage?: (from: string, to: string, message: string, bot: irc.Client) => void;
    onJoin?: (channel: string, nick: string, bot: irc.Client) => void;
    unload?: () => void;
};


// Dynamically import config and validate with Zod
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

const plugins: Record<string, Plugin> = {};

async function loadPlugin(pluginName: string, channel: string) {
    const pluginPath = path.join(__dirname, 'plugins', pluginName + '.ts');
    if (!fs.existsSync(pluginPath)) {
        bot.say(channel, `Plugin '${pluginName}' not found.`);
        bot.say(channel, `I looked at ${pluginPath}`);
        return;
    }
    try {
        // Add cache-busting query to force reload
        const pluginModule = await import(pluginPath + `?update=${Date.now()}`);
        const plugin: Plugin = pluginModule.default;
        plugins[pluginName] = plugin;
        bot.say(channel, `Plugin '${pluginName}' loaded.`);
    } catch (err) {
        bot.say(channel, `Failed to load plugin '${pluginName}': ${err}`);
    }
}

function unloadPlugin(pluginName: string, channel: string) {
    if (!plugins[pluginName]) {
        bot.say(channel, `Plugin '${pluginName}' is not loaded.`);
        return;
    }
    if (plugins[pluginName].unload) {
        plugins[pluginName].unload();
    }
    // No require cache to clear in ES modules, just delete from plugins
    delete plugins[pluginName];
    bot.say(channel, `Plugin '${pluginName}' unloaded.`);
}

async function reloadPlugin(pluginName: string, channel: string) {
    unloadPlugin(pluginName, channel);
    await loadPlugin(pluginName, channel);
}

bot.addListener('registered', () => {
    console.log(`Connected to ${config.server}`);
});

bot.addListener('join', (channel, nick) => {
    Object.values(plugins).forEach(plugin => {
        if (plugin.onJoin) plugin.onJoin(channel, nick, bot);
    });
});

bot.addListener('message', async (from, to, message) => {
    // Plugin management commands
    const loadMatch = message.match(/^!load (\w+)/i);
    const unloadMatch = message.match(/^!unload (\w+)/i);
    const reloadMatch = message.match(/^!reload (\w+)/i);
    if (loadMatch) {
        await loadPlugin(loadMatch[1], to);
        return;
    }
    if (unloadMatch) {
        unloadPlugin(unloadMatch[1], to);
        return;
    }
    if (reloadMatch) {
        await reloadPlugin(reloadMatch[1], to);
        return;
    }
    Object.values(plugins).forEach(plugin => {
        if (plugin.onMessage) plugin.onMessage(from, to, message, bot);
    });
});

bot.addListener('error', (message) => {
    console.error('IRC Error:', message);
});
