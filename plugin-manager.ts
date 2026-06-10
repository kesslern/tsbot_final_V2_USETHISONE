import irc from 'irc';
import path from 'path';
import fs from 'fs';
import type BetterSQLite3 from 'better-sqlite3';
import { openDatabase, createStorage, type Storage } from './storage.ts';

export type Plugin = {
  name: string;
  onMessage?: (params: { from: string; to: string; message: string; bot: irc.Client; storage: Storage }) => void;
  onJoin?: (params: { channel: string; nick: string; bot: irc.Client; storage: Storage }) => void;
  unload?: () => void;
};

export class PluginManager {
  private plugins: Record<string, Plugin> = {};
  private storages: Record<string, Storage> = {};
  private pluginDir: string;
  private bot: irc.Client;
  private db: BetterSQLite3.Database;

  constructor(pluginDir: string, bot: irc.Client) {
    this.pluginDir = pluginDir;
    this.bot = bot;
    this.db = openDatabase(path.join(pluginDir, '..', 'data', 'bot.db'));
  }

  async loadPlugin(pluginName: string, channel: string) {
    const pluginPath = path.join(this.pluginDir, pluginName + '.ts');
    if (!fs.existsSync(pluginPath)) {
      this.bot.say(channel, `Plugin '${pluginName}' not found.`);
      this.bot.say(channel, `I looked at ${pluginPath}`);
      return;
    }
    try {
      const pluginModule = await import(pluginPath + `?update=${Date.now()}`);
      const plugin: Plugin = pluginModule.default;
      this.plugins[pluginName] = plugin;
      this.storages[pluginName] = createStorage(this.db, pluginName);
      this.bot.say(channel, `Plugin '${pluginName}' loaded.`);
    } catch (err) {
      this.bot.say(channel, `Failed to load plugin '${pluginName}': ${err}`);
    }
  }

  unloadPlugin(pluginName: string, channel: string) {
    if (!this.plugins[pluginName]) {
      this.bot.say(channel, `Plugin '${pluginName}' is not loaded.`);
      return;
    }
    if (this.plugins[pluginName].unload) {
      this.plugins[pluginName].unload();
    }
    delete this.plugins[pluginName];
    delete this.storages[pluginName];
    this.bot.say(channel, `Plugin '${pluginName}' unloaded.`);
  }

  async reloadPlugin(pluginName: string, channel: string) {
    this.unloadPlugin(pluginName, channel);
    await this.loadPlugin(pluginName, channel);
  }

  handleJoin(channel: string, nick: string) {
    Object.entries(this.plugins).forEach(([name, plugin]) => {
      if (plugin.onJoin) {
        plugin.onJoin({ channel, nick, bot: this.bot, storage: this.storages[name] });
      }
    });
  }

  handleMessage(from: string, to: string, message: string) {
    Object.entries(this.plugins).forEach(([name, plugin]) => {
      if (plugin.onMessage) {
        plugin.onMessage({ from, to, message, bot: this.bot, storage: this.storages[name] });
      }
    });
  }
}
