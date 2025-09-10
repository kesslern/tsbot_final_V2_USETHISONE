import type { Plugin } from '../plugin-manager.ts';
import { fetchWeatherApi } from 'openmeteo';

const weather: Plugin = {
  name: 'weather',
  onMessage: async ({ from, to, message, bot }) => {
    const match = message.match(/^!weather\s+(.+)/i);
    if (!match) return;
    const location = match[1].trim();
    let reply: string;
    try {
      // Geocoding API to get lat/lon
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
      if (!geoRes.ok) throw new Error('Could not fetch location info.');
      const geoData = (await geoRes.json()) as { results?: { latitude: number; longitude: number; name: string; country: string }[] };
      if (!geoData.results || geoData.results.length === 0) {
        reply = `Location not found: ${location}`;
      } else {
        const { latitude, longitude, name, country } = geoData.results[0];
        // Use openmeteo npm package for weather
        const params = {
          latitude: [latitude],
          longitude: [longitude],
          current: 'temperature_2m,weather_code,wind_speed_10m',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min',
          timezone: 'auto',
        };
        const url = 'https://api.open-meteo.com/v1/forecast';
        const responses = await fetchWeatherApi(url, params);
        const response = responses[0];
        const current = response.current();
        const daily = response.daily();
        if (!current || !daily) {
          reply = 'Weather data unavailable.';
        } else {
          // Current
          const temperatureC = current.variables(0)?.value();
          const temperatureF = temperatureC !== undefined ? (temperatureC * 9/5 + 32) : undefined;
          const weatherCode = current.variables(1)?.value();
          const windSpeed = current.variables(2)?.value();
          // Truncate to one decimal place
          const tempFStr = temperatureF !== undefined ? temperatureF.toFixed(1) : 'N/A';
          const windStr = windSpeed !== undefined ? windSpeed.toFixed(1) : 'N/A';
          const codeStr = weatherCode !== undefined ? weatherEmoji(weatherCode) : '❓';

          // Forecast
          const days = 3;
          const forecastLines: string[] = [];
          const range = (start: number, stop: number, step: number) => Array.from({ length: (stop - start) / step }, (_, i) => start + i * step);
          const timeArr = range(Number(daily.time()), Number(daily.timeEnd()), daily.interval()).map(
            (t) => new Date((t + response.utcOffsetSeconds()) * 1000)
          );
          const weatherCodes = daily.variables(0)?.valuesArray() || [];
          const tempMax = daily.variables(1)?.valuesArray() || [];
          const tempMin = daily.variables(2)?.valuesArray() || [];
          for (let i = 0; i < Math.min(days, timeArr.length); i++) {
            const day = timeArr[i].toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            const maxF = (tempMax[i] * 9/5 + 32).toFixed(1);
            const minF = (tempMin[i] * 9/5 + 32).toFixed(1);
            const emoji = weatherEmoji(weatherCodes[i]);
            forecastLines.push(`${emoji} ${day}: ${minF}°F - ${maxF}°F`);
          }

          reply = `Current conditions in ${name}, ${country}: ${codeStr} 🌡️ ${tempFStr}°F, 💨 ${windStr} km/h
Forecast: ${forecastLines.join(' | ')}`;
        }
      }
    } catch (err) {
      reply = 'Error fetching weather.';
    }
    bot.say(to, reply);
  }
}

// Map weather codes to emoji (simplified)
function weatherEmoji(code: number | undefined): string {
  if (code === undefined) return '❓';
  if (code === 0) return '☀️'; // Clear
  if ([1, 2, 3].includes(code)) return '⛅'; // Mainly clear, partly cloudy
  if ([45, 48].includes(code)) return '🌫️'; // Fog
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️'; // Drizzle
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '🌧️'; // Rain
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄️'; // Snow
  if ([95, 96, 99].includes(code)) return '⛈️'; // Thunderstorm
  return '🌡️';
}

export default weather;
