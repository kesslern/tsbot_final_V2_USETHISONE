import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import { addNote, countNotes, countPendingFrom, deleteNote, lastSeen, queueDelivery, searchNotes } from './bot-db.ts';
import { calculate } from './calculator.ts';
import { fetchImage } from './image-fetch.ts';
import { ketchScrape, ketchSearch } from './ketch.ts';
import { getWeatherReport } from './weather-report.ts';
import { TOOL_GROUPS, type ToolGroup } from './config-schema.ts';

// Tools the LLM can call. Each group can be switched on or off with `tools` in the llamacpp config.

// view_image is left out because it needs a vision model
export const DEFAULT_TOOL_GROUPS: ToolGroup[] = TOOL_GROUPS.filter(group => group !== 'fetch_page' && group !== 'view_image');

// Who is asking and where, for tools that act on behalf of a person in a channel
export type ToolContext = {
  channel: string; // channel name, or the other person's nick in a PM
  isChannel: boolean;
  asker: () => string; // nick of whoever asked the current question
  maxPageChars: number; // longest page text fetch_page hands the model
  maxImageBytes: number; // largest image view_image downloads
};

const MAX_NOTE_LENGTH = 400;
const MAX_NOTES_PER_CHANNEL = 500;
const MAX_PENDING_PER_NICK = 10;
const MAX_REMINDER_DAYS = 90;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });

// pi validates arguments against the schema before calling execute, so params are typed safely
function tool<T extends TSchema>(definition: Omit<AgentTool<T>, 'execute'> & {
  execute: (params: Static<T>, signal?: AbortSignal) => Promise<string>;
}): AgentTool {
  const { execute, ...rest } = definition;
  return { ...rest, execute: async (_id, params, signal) => text(await execute(params as Static<T>, signal)) } as AgentTool;
}

export function ago(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const units: [string, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));

function buildGroup(group: ToolGroup, ctx: ToolContext): AgentTool[] {
  switch (group) {
    case 'current_time':
      return [tool({
        name: 'current_time',
        label: 'Current time',
        description: 'Get the current date and time, optionally in a specific time zone.',
        parameters: Type.Object({
          timezone: Type.Optional(Type.String({ description: 'IANA time zone such as America/New_York or Europe/Paris. Omit for the bot\'s local time.' })),
        }),
        // Throws a RangeError for unknown zones, which pi reports back to the model
        execute: async ({ timezone }) =>
          new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone }).format(new Date()),
      })];

    case 'weather':
      return [tool({
        name: 'weather',
        label: 'Weather',
        description: 'Get current weather conditions and a 3-day forecast for a place.',
        parameters: Type.Object({
          location: Type.String({ description: 'City or place name only, e.g. "Boston" or "Paris"' }),
        }),
        execute: ({ location }) => getWeatherReport(location),
      })];

    case 'web_search':
      return [tool({
        name: 'web_search',
        label: 'Web search',
        description: 'Search the web to check facts (people, history, dates, numbers) or find current information and news. '
          + 'Use it rather than answering factual questions from memory. Returns titles, URLs and short summaries.',
        parameters: Type.Object({
          query: Type.String({ description: 'What to search for' }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Number of results (default 5)' })),
        }),
        execute: ({ query, limit }, signal) => ketchSearch(query, limit ?? 5, signal),
      })];

    case 'fetch_page':
      return [tool({
        name: 'fetch_page',
        label: 'Fetch page',
        description: 'Read the main text of a web page, e.g. a result from web_search, when its summary is not enough.',
        parameters: Type.Object({
          url: Type.String({ description: 'Full http or https URL of the page' }),
        }),
        execute: ({ url }, signal) => ketchScrape(url, ctx.maxPageChars, signal),
      })];

    case 'view_image':
      return [{
        name: 'view_image',
        label: 'View image',
        description: 'Download an image from a URL and look at it, e.g. when someone links a picture or asks what an image shows. '
          + 'Also works on a page link (such as imgur) by using the page\'s preview image.',
        parameters: Type.Object({
          url: Type.String({ description: 'Full http or https URL of the image or page' }),
        }),
        execute: async (_id, params, signal) => {
          const image = await fetchImage((params as { url: string }).url, ctx.maxImageBytes, signal);
          return {
            content: [
              { type: 'text', text: `Image from ${image.url} (${image.mimeType}, ${Math.round(image.bytes / 1024)} KB):` },
              { type: 'image', data: image.data, mimeType: image.mimeType },
            ],
            details: {},
          };
        },
      } as AgentTool];

    case 'calculate':
      return [tool({
        name: 'calculate',
        label: 'Calculate',
        description: 'Evaluate an arithmetic expression exactly. Use this for any maths instead of working it out yourself. '
          + 'Supports + - * / % ^, parentheses, pi, e, and sqrt cbrt abs exp ln log log2 sin cos tan asin acos atan floor ceil round min max pow.',
        parameters: Type.Object({
          expression: Type.String({ description: 'e.g. "83 * (2/3) / (97 - 83)" or "sqrt(2) ^ 10"' }),
        }),
        execute: async ({ expression }) => `${expression} = ${calculate(expression)}`,
      })];

    case 'notes':
      return [
        tool({
          name: 'remember',
          label: 'Remember',
          description: 'Save a fact to long-term memory for this channel, e.g. something about a person or the channel. '
            + 'Use when someone asks you to remember something, or shares a lasting fact about themselves.',
          parameters: Type.Object({
            fact: Type.String({ description: 'The fact, written so it makes sense on its own later, e.g. "nathan lives in EST"' }),
          }),
          execute: async ({ fact }) => {
            const trimmed = fact.trim();
            if (!trimmed) throw new Error('Nothing to remember.');
            if (trimmed.length > MAX_NOTE_LENGTH) throw new Error(`Notes are limited to ${MAX_NOTE_LENGTH} characters.`);
            if (countNotes(ctx.channel) >= MAX_NOTES_PER_CHANNEL) throw new Error('Memory is full for this channel; forget some notes first.');
            const id = addNote(ctx.channel, ctx.asker(), trimmed);
            return `Saved as note #${id}.`;
          },
        }),
        tool({
          name: 'recall',
          label: 'Recall',
          description: 'Search long-term memory for this channel. Use before answering questions about people, preferences, or anything you were told to remember.',
          parameters: Type.Object({
            query: Type.String({ description: 'Words to look for, e.g. a nick or topic. Empty string lists the newest notes.' }),
          }),
          execute: async ({ query }) => {
            const notes = searchNotes(ctx.channel, query, 15);
            if (notes.length === 0) return query ? `No notes matching "${query}".` : 'No notes saved yet.';
            return notes.map(n => `#${n.id} (from ${n.author}, ${ago(n.created_at)}): ${n.text}`).join('\n');
          },
        }),
        tool({
          name: 'forget_note',
          label: 'Forget note',
          description: 'Delete a note from long-term memory by its number, e.g. when it is wrong or someone asks you to forget it.',
          parameters: Type.Object({
            id: Type.Integer({ description: 'Note number, as shown by recall' }),
          }),
          execute: async ({ id }) => {
            if (!deleteNote(ctx.channel, id)) throw new Error(`There is no note #${id} in this channel.`);
            return `Forgot note #${id}.`;
          },
        }),
      ];

    case 'seen':
      return [tool({
        name: 'seen',
        label: 'Seen',
        description: 'Find out when someone last spoke in this channel and what they said.',
        parameters: Type.Object({
          nick: Type.String({ description: 'IRC nickname' }),
        }),
        execute: async ({ nick }) => {
          if (!ctx.isChannel) throw new Error('seen only works in channels.');
          const entry = lastSeen(ctx.channel, nick);
          if (!entry) return `I haven't seen ${nick} speak in ${ctx.channel}.`;
          return `${entry.nick} last spoke ${ago(entry.at)} (${formatTime(entry.at)}): ${entry.message}`;
        },
      })];

    case 'tell':
      return [
        tool({
          name: 'tell',
          label: 'Tell',
          description: 'Pass a message on to someone the next time they speak in this channel.',
          parameters: Type.Object({
            nick: Type.String({ description: 'Who to tell' }),
            message: Type.String({ description: 'The message to pass on' }),
          }),
          execute: async ({ nick, message }) => {
            if (!ctx.isChannel) throw new Error('tell only works in channels.');
            checkDelivery(ctx.asker(), message);
            queueDelivery(ctx.channel, ctx.asker(), nick, message.trim());
            return `I'll tell ${nick} next time they speak here.`;
          },
        }),
        tool({
          name: 'remind',
          label: 'Remind',
          description: 'Post a reminder for someone in this channel at a set time. Give either delay_minutes or at.',
          parameters: Type.Object({
            nick: Type.String({ description: 'Who to remind; usually the person asking' }),
            message: Type.String({ description: 'What to remind them about' }),
            delay_minutes: Type.Optional(Type.Number({ minimum: 1, description: 'Minutes from now' })),
            at: Type.Optional(Type.String({ description: 'ISO 8601 date and time with a UTC offset, e.g. 2026-10-02T09:00:00-04:00' })),
          }),
          execute: async ({ nick, message, delay_minutes, at }) => {
            const asker = ctx.asker();
            // In a PM, "channel" is the asker's nick, so reminders can only go to them
            if (!ctx.isChannel && nick.toLowerCase() !== asker.toLowerCase()) {
              throw new Error('In a private message I can only remind the person asking.');
            }
            checkDelivery(asker, message);
            const when = delay_minutes !== undefined ? Date.now() + delay_minutes * 60_000 : at !== undefined ? Date.parse(at) : NaN;
            if (Number.isNaN(when)) throw new Error('Give delay_minutes, or a valid ISO 8601 time in at.');
            if (when <= Date.now()) throw new Error('That time has already passed.');
            if (when > Date.now() + MAX_REMINDER_DAYS * 86_400_000) throw new Error(`Reminders can be at most ${MAX_REMINDER_DAYS} days ahead.`);
            queueDelivery(ctx.channel, asker, nick, message.trim(), when);
            return `Reminder set for ${nick} at ${formatTime(when)}.`;
          },
        }),
      ];
  }
}

function checkDelivery(fromNick: string, message: string) {
  if (!message.trim()) throw new Error('The message is empty.');
  if (message.length > MAX_NOTE_LENGTH) throw new Error(`Messages are limited to ${MAX_NOTE_LENGTH} characters.`);
  if (countPendingFrom(fromNick) >= MAX_PENDING_PER_NICK) {
    throw new Error(`${fromNick} already has ${MAX_PENDING_PER_NICK} messages waiting to be delivered.`);
  }
}

export function buildTools(groups: readonly ToolGroup[], ctx: ToolContext): AgentTool[] {
  return groups.flatMap(group => buildGroup(group, ctx));
}

// Added to the system prompt, since small models answer from memory unless told to look things up
export function toolGuidance(groups: readonly ToolGroup[]): string {
  if (!groups.includes('web_search')) return '';
  const read = groups.includes('fetch_page') ? ', and use fetch_page on a result (e.g. Wikipedia) when the summaries are thin' : '';
  return 'Your memory of specific facts is unreliable. Before answering a factual question about real people, events, dates, '
    + 'places, numbers, or anything recent, call web_search and base your answer on the results' + read + '. '
    + 'Do not guess. Only skip searching for opinions, small talk, or things already established in this conversation. '
    + 'If the results do not settle it, say you are not sure.';
}
