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
        };
        const url = 'https://api.open-meteo.com/v1/forecast';
        const responses = await fetchWeatherApi(url, params);
        const response = responses[0];
        const current = response.current();
        if (!current) {
          reply = 'Weather data unavailable.';
        } else {
          // Order: temperature_2m, weather_code, wind_speed_10m
          const temperatureC = current.variables(0)?.value();
          const temperatureF = temperatureC !== undefined ? (temperatureC * 9/5 + 32) : undefined;
          const weatherCode = current.variables(1)?.value();
          const windSpeed = current.variables(2)?.value();
          // Truncate to one decimal place
          const tempFStr = temperatureF !== undefined ? temperatureF.toFixed(1) : 'N/A';
          const windStr = windSpeed !== undefined ? windSpeed.toFixed(1) : 'N/A';
          const codeStr = weatherCode !== undefined ? (weatherCode === 0 ? 'Clear' : `See code ${weatherCode.toFixed(1)}`) : 'Unknown';
          reply = `Weather for ${name}, ${country}: ${tempFStr}°F, ${codeStr}, Wind: ${windStr} km/h`;
        }
      }
    } catch (err) {
      reply = 'Error fetching weather.';
    }
    bot.say(to, reply);
  },
};

export default weather;
