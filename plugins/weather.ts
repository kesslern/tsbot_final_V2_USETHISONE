import type { Plugin } from '../plugin-manager.ts';
import { getWeatherReport } from '../weather-report.ts';

const weather: Plugin = {
  name: 'weather',
  onMessage: async ({ to, message, bot }) => {
    const match = message.match(/^!weather\s+(.+)/i);
    if (!match) return;
    const location = match[1].trim();
    let reply: string;
    try {
      reply = await getWeatherReport(location);
    } catch {
      reply = 'Error fetching weather.';
    }
    bot.say(to, reply);
  }
}

export default weather;
