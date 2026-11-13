import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Everything the bot remembers between restarts, in data/bot.db (or $BOT_DATA_DIR/bot.db)

const dataDir = process.env.BOT_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'bot.db'));
db.exec(`
  PRAGMA journal_mode = WAL;

  -- LLM conversation per channel: recent messages verbatim, older ones as a summary
  CREATE TABLE IF NOT EXISTS conversations (
    channel TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '', -- tool groups the conversation was held with
    updated_at INTEGER NOT NULL
  );

  -- Facts the bot was asked to remember, scoped to the channel (or PM) they were told in
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Last thing each nick said in each channel
  CREATE TABLE IF NOT EXISTS seen (
    channel TEXT NOT NULL,
    nick_key TEXT NOT NULL,
    nick TEXT NOT NULL,
    message TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (channel, nick_key)
  );

  -- Messages to pass on: when the person next speaks (deliver_at NULL), or at a set time
  CREATE TABLE IF NOT EXISTS messages_to_deliver (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,
    from_nick TEXT NOT NULL,
    to_nick TEXT NOT NULL,
    to_key TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deliver_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS pending_by_nick ON messages_to_deliver (channel, to_key) WHERE deliver_at IS NULL;
  CREATE INDEX IF NOT EXISTS pending_by_time ON messages_to_deliver (deliver_at) WHERE deliver_at IS NOT NULL;
`);

// Databases created before the tools column existed
const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
if (!conversationColumns.some(c => c.name === 'tools')) {
  db.exec("ALTER TABLE conversations ADD COLUMN tools TEXT NOT NULL DEFAULT ''");
}

// IRC nicks are case-insensitive
const nickKey = (nick: string) => nick.toLowerCase();

// Conversations

export function loadConversation(channel: string): { messages: unknown[]; summary: string; tools: string } | undefined {
  const row = db.prepare('SELECT messages, summary, tools FROM conversations WHERE channel = ?').get(channel) as
    { messages: string; summary: string; tools: string } | undefined;
  return row && { messages: JSON.parse(row.messages) as unknown[], summary: row.summary, tools: row.tools };
}

export function saveConversation(channel: string, messages: unknown[], summary: string, tools: string) {
  db.prepare(`
    INSERT INTO conversations (channel, messages, summary, tools, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (channel) DO UPDATE SET messages = excluded.messages, summary = excluded.summary, tools = excluded.tools, updated_at = excluded.updated_at
  `).run(channel, JSON.stringify(messages), summary, tools, Date.now());
}

export function deleteConversation(channel: string) {
  db.prepare('DELETE FROM conversations WHERE channel = ?').run(channel);
}

// Notes

export type Note = { id: number; author: string; text: string; created_at: number };

export function addNote(channel: string, author: string, text: string): number {
  const result = db.prepare('INSERT INTO notes (channel, author, text, created_at) VALUES (?, ?, ?, ?)')
    .run(channel, author, text, Date.now());
  return Number(result.lastInsertRowid);
}

export function countNotes(channel: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE channel = ?').get(channel) as { n: number }).n;
}

// Notes containing every word of the query (or the newest notes when the query is empty)
export function searchNotes(channel: string, query: string, limit: number): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const where = words.map(() => "AND lower(text) LIKE ? ESCAPE '\\'").join(' ');
  const params = words.map(w => `%${w.replace(/[\\%_]/g, '\\$&')}%`);
  return db.prepare(`SELECT id, author, text, created_at FROM notes WHERE channel = ? ${where} ORDER BY id DESC LIMIT ?`)
    .all(channel, ...params, limit) as Note[];
}

export function deleteNote(channel: string, id: number): boolean {
  return db.prepare('DELETE FROM notes WHERE channel = ? AND id = ?').run(channel, id).changes > 0;
}

// Seen

export function recordSeen(channel: string, nick: string, message: string) {
  db.prepare(`
    INSERT INTO seen (channel, nick_key, nick, message, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (channel, nick_key) DO UPDATE SET nick = excluded.nick, message = excluded.message, at = excluded.at
  `).run(channel, nickKey(nick), nick, message, Date.now());
}

export function lastSeen(channel: string, nick: string): { nick: string; message: string; at: number } | undefined {
  return db.prepare('SELECT nick, message, at FROM seen WHERE channel = ? AND nick_key = ?').get(channel, nickKey(nick)) as
    { nick: string; message: string; at: number } | undefined;
}

// Tells and reminders

export type Delivery = { id: number; channel: string; from_nick: string; to_nick: string; message: string; created_at: number };

export function queueDelivery(channel: string, fromNick: string, toNick: string, message: string, deliverAt?: number) {
  db.prepare('INSERT INTO messages_to_deliver (channel, from_nick, to_nick, to_key, message, created_at, deliver_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channel, fromNick, toNick, nickKey(toNick), message, Date.now(), deliverAt ?? null);
}

export function countPendingFrom(fromNick: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages_to_deliver WHERE lower(from_nick) = ?').get(nickKey(fromNick)) as { n: number }).n;
}

// Removes and returns messages waiting for this nick to speak in this channel
export function takeTellsFor(channel: string, nick: string): Delivery[] {
  return db.prepare('DELETE FROM messages_to_deliver WHERE channel = ? AND to_key = ? AND deliver_at IS NULL RETURNING id, channel, from_nick, to_nick, message, created_at')
    .all(channel, nickKey(nick)) as Delivery[];
}

// Removes and returns reminders that are due
export function takeDueReminders(now: number): Delivery[] {
  return db.prepare('DELETE FROM messages_to_deliver WHERE deliver_at IS NOT NULL AND deliver_at <= ? RETURNING id, channel, from_nick, to_nick, message, created_at')
    .all(now) as Delivery[];
}
