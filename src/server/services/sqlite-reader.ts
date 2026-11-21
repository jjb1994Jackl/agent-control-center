import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
// Use the runtime's SQLite rather than a platform CLI with a different WAL/VFS.
// The connection is always read-only, short-lived and uses bound parameters.
// Rows come back as plain objects of unknown shape: each caller narrows the columns it reads.
function readSqlite(file: string, sql: string, params: SQLInputValue[] = []): Array<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  try { return database.prepare(sql).all(...params); }
  finally { database.close(); }
}
export { readSqlite };
