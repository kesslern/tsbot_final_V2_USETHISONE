import BetterSQLite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface Storage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  keys(): string[];
}

export function openDatabase(dbPath: string): BetterSQLite3.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSQLite3(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      plugin TEXT NOT NULL,
      key    TEXT NOT NULL,
      value  TEXT NOT NULL,
      PRIMARY KEY (plugin, key)
    )
  `);
  return db;
}

export function createStorage(db: BetterSQLite3.Database, pluginName: string): Storage {
  const stmtGet  = db.prepare('SELECT value FROM kv WHERE plugin = ? AND key = ?');
  const stmtSet  = db.prepare('INSERT OR REPLACE INTO kv (plugin, key, value) VALUES (?, ?, ?)');
  const stmtDel  = db.prepare('DELETE FROM kv WHERE plugin = ? AND key = ?');
  const stmtHas  = db.prepare('SELECT 1 FROM kv WHERE plugin = ? AND key = ?');
  const stmtKeys = db.prepare('SELECT key FROM kv WHERE plugin = ?');

  return {
    get(key) {
      const row = stmtGet.get(pluginName, key) as { value: string } | undefined;
      return row?.value;
    },
    set(key, value) {
      stmtSet.run(pluginName, key, value);
    },
    delete(key) {
      stmtDel.run(pluginName, key);
    },
    has(key) {
      return stmtHas.get(pluginName, key) !== undefined;
    },
    keys() {
      return (stmtKeys.all(pluginName) as { key: string }[]).map((r) => r.key);
    },
  };
}
