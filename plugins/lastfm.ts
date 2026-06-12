import type { Plugin } from '../plugin-manager.ts';
import type { Storage } from '../storage.ts';

type LastfmError = { error: number; message: string };

type LastfmTrack = {
  name: string;
  artist: { '#text': string };
  album: { '#text': string };
  '@attr'?: { nowplaying: 'true' };
  date?: { uts: string; '#text': string };
};

type LastfmRecentTracksResponse = { recenttracks: { track: LastfmTrack[] } };
type LastfmTopArtist = { name: string; playcount: string };
type LastfmTopArtistsResponse = { topartists: { artist: LastfmTopArtist[] } };

function isLastfmError(data: unknown): data is LastfmError {
  return typeof (data as LastfmError).error === 'number';
}

async function fetchLastfm<T>(method: string, params: Record<string, string>): Promise<T | LastfmError> {
  const apiKey = process.env.LASTFM_API_KEY;
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  url.search = new URLSearchParams({ method, api_key: apiKey!, format: 'json', ...params }).toString();
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T | LastfmError;
}

function resolveLastfmUser(nick: string, storage: Storage): string | undefined {
  return storage.get('nick:' + nick.toLowerCase());
}

const lastfm: Plugin = {
  name: 'lastfm',
  onMessage: async ({ from, to, message, bot, storage }) => {
    const fmsetMatch = message.match(/^!fmset\s+(\S+)/i);
    if (fmsetMatch) {
      const username = fmsetMatch[1];
      storage.set('nick:' + from.toLowerCase(), username);
      bot.say(to, `${from}: Last.fm username set to ${username}`);
      return;
    }

    const npMatch = message.match(/^!np(?:\s+(\S+))?/i);
    if (npMatch) {
      const apiKey = process.env.LASTFM_API_KEY;
      if (!apiKey) { bot.say(to, 'Last.fm API key is not configured.'); return; }
      const targetNick = npMatch[1] ?? from;
      const lfmUser = resolveLastfmUser(targetNick, storage);
      if (!lfmUser) { bot.say(to, `${targetNick} has not set a Last.fm username. Use !fmset <username>`); return; }
      try {
        const data = await fetchLastfm<LastfmRecentTracksResponse>('user.getRecentTracks', { user: lfmUser, limit: '1' });
        if (isLastfmError(data)) { bot.say(to, `Last.fm error: ${data.message}`); return; }
        const tracks = data.recenttracks.track;
        if (!tracks.length) { bot.say(to, `${targetNick} hasn't scrobbled anything yet.`); return; }
        const track = tracks[0];
        const artist = track.artist['#text'];
        const album = track.album['#text'];
        const albumStr = album ? ` [${album}]` : '';
        const trackStr = `${artist} - ${track.name}${albumStr}`;
        const nowPlaying = track['@attr']?.nowplaying === 'true';
        if (nowPlaying) {
          bot.say(to, `${targetNick} [${lfmUser}] is now playing: ${trackStr}`);
        } else {
          const date = track.date?.['#text'] ?? '';
          const dateStr = date ? ` (${date})` : '';
          bot.say(to, `${targetNick} [${lfmUser}] last played: ${trackStr}${dateStr}`);
        }
      } catch {
        bot.say(to, 'Error fetching Last.fm data.');
      }
      return;
    }

    const taMatch = message.match(/^!topartists(?:\s+(\S+))?/i);
    if (taMatch) {
      const apiKey = process.env.LASTFM_API_KEY;
      if (!apiKey) { bot.say(to, 'Last.fm API key is not configured.'); return; }
      const targetNick = taMatch[1] ?? from;
      const lfmUser = resolveLastfmUser(targetNick, storage);
      if (!lfmUser) { bot.say(to, `${targetNick} has not set a Last.fm username. Use !fmset <username>`); return; }
      try {
        const data = await fetchLastfm<LastfmTopArtistsResponse>('user.getTopArtists', { user: lfmUser, limit: '5', period: 'overall' });
        if (isLastfmError(data)) { bot.say(to, `Last.fm error: ${data.message}`); return; }
        const artists = data.topartists.artist;
        if (!artists.length) { bot.say(to, `${targetNick} has no scrobble history.`); return; }
        const list = artists.map((a, i) => `${i + 1}. ${a.name} (${a.playcount} plays)`).join(' | ');
        bot.say(to, `${targetNick} [${lfmUser}]'s top artists: ${list}`);
      } catch {
        bot.say(to, 'Error fetching Last.fm data.');
      }
    }
  },
};

export default lastfm;
