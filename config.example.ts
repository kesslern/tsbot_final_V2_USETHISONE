import type { BotConfig } from './config-schema.ts';

const config: BotConfig = {
  server: 'irc.libera.chat',
  port: 6667,
  nick: 'TypeScriptBot',
  channels: ['#examplechannel'],
  admins: ['YourNick'],
  prefix: '!',
  plugins: ['weather', 'llamacpp'],
  llamacpp: {
    baseUrl: 'http://192.168.1.100:8080/v1',
    systemPrompt: 'You are a millenial human with opinions. Keep your responses concise. Chat with those who engage with you. Be somewhat rude and sarcastic. Always be truthful.',
    temperature: 0.3,
    top_p: 0.8,
    maxHistoryExchanges: 5,
    channelContextMessages: 20,
    contextWindow: 8192, // match llama-server's --ctx-size
    // llama-server needs --jinja for tool calls. web_search and fetch_page need the ketch CLI.
    // fetch_page lets anyone in the channel make the bot load web pages (private addresses are refused).
    // notes = remember/recall/forget_note, tell = tell/remind. History, notes, seen and reminders live in data/bot.db.
    // view_image lets the model download and look at linked images (or a page's preview image).
    // It needs a vision model: start llama-server with --mmproj and set vision: true. JPEG, PNG, GIF and BMP only.
    tools: ['current_time', 'weather', 'web_search', 'fetch_page', 'calculate', 'notes', 'seen', 'tell', 'view_image'],
    vision: true,
    maxImageBytes: 8_000_000,
    compactAtTokens: 4000, // summarize older history once the kept part is this big; keep well under contextWindow
    timeoutSeconds: 120, // searching and reading pages takes extra round trips
    maxToolTurns: 5,
  },
};

export default config;
