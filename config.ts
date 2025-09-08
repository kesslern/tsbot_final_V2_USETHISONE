import type { BotConfig } from './config-schema.ts';

const config: BotConfig = {
  server: 'irc.libera.chat',
  port: 6667,
  nick: 'TypeScriptBot',
  channels: ['#examplechannel'],
  admins: ['YourNick'],
};

export default config;
