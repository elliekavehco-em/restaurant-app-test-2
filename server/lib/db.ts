/**
 * PLATFORM-MANAGED FILE — DO NOT EDIT OR DELETE.
 * The platform overwrites this file on every run; local changes are lost.
 *
 * SQLite database shared by all server code. Import it from server code as:
 *   import { db, migrate } from './lib/db.js';   // from server/index.ts
 *
 * - `db` is a node:sqlite DatabaseSync — synchronous, no await needed:
 *     db.prepare('SELECT * FROM products WHERE id = ?').get(id)
 *     db.prepare('INSERT INTO orders (item, qty) VALUES (?, ?)').run(item, qty)
 *     db.prepare('SELECT * FROM products').all()
 * - Call `migrate(sql)` ONCE at server startup with idempotent
 *   `CREATE TABLE IF NOT EXISTS ...` statements.
 * - ALWAYS use parameterized queries (the ? placeholders) — never build SQL
 *   strings from user input.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

// server/data/ is the ONLY directory that survives republishes — the
// platform mounts persistent storage there in production.
const DATA_DIR = path.join(process.cwd(), 'server', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

// WAL + busy timeout: concurrent requests queue instead of failing with
// SQLITE_BUSY, and a crash mid-write can't corrupt the database.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * Run the schema statements (CREATE TABLE IF NOT EXISTS ...) once at startup.
 * On a fresh deployment this creates the schema in an empty database.
 *
 * On a redeploy the tables already exist, and CREATE TABLE IF NOT EXISTS does
 * not change an existing table. So migrate() then brings each table in line
 * with the statement it was given: it adds the columns the table is missing,
 * and relaxes an old NOT NULL column (one with no default) that the statement
 * no longer requires. Rows and columns are always kept, never dropped.
 * It does not rename columns, change their types, or fill in data.
 */
export function migrate(schemaSql: string): void {
  try {
    db.exec(schemaSql);
  } catch (error) {
    // The statements themselves can fail on an old table, e.g. a CREATE INDEX
    // on a column the table does not have yet. Repair, then run them again
    // (they are idempotent); if nothing could be repaired, fail as before.
    // Here the app cannot reach its own ADD COLUMN code either (it crashes
    // first, on every start), so columns it manages are added too.
    if (!repairQuietly(schemaSql, true)) throw error;
    db.exec(schemaSql);
    return;
  }
  repairQuietly(schemaSql);
}

// Never throws: migrate() succeeding must not depend on the repair.
function repairQuietly(schemaSql: string, includeAppColumns = false): boolean {
  try {
    return repairSchema(schemaSql, includeAppColumns);
  } catch (error) {
    console.error('[db] schema repair skipped:', error);
    return false;
  }
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

const quoteName = (name: string) => '"' + name.replace(/"/g, '""') + '"';
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const columnsOf = (database: DatabaseSync, table: string) =>
  database.prepare('PRAGMA table_info(' + quoteName(table) + ')').all() as unknown as ColumnInfo[];
// The value an old NULL becomes when the declared column is NOT NULL.
const emptyValue = (column: ColumnInfo) =>
  column.dflt_value ?? (/INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/i.test(column.type) ? '0' : "''");
// ALTER TABLE ADD COLUMN only accepts a constant default.
const hasConstantDefault = (column: ColumnInfo) =>
  column.dflt_value === null ||
  !(column.dflt_value.trim().startsWith('(') || /CURRENT_(TIME|DATE|TIMESTAMP)/i.test(column.dflt_value));

// Columns the app adds by itself: named in its own ALTER TABLE ... ADD COLUMN,
// or as a quoted name next to ADD COLUMN code (a "column is missing" check, an
// ensureColumn('table', 'column', ...) helper). Such code often fills the new
// column in the same block it adds it, and runs that block only while the
// column is missing; adding the column first would silently skip the fill.
// So those columns are left to the app, exactly as before the repair existed.
let appColumnsSource: string | null = null;
function addedByApp(column: string): boolean {
  if (appColumnsSource === null) {
    const space = new RegExp('[' + String.fromCharCode(9, 10, 13, 32) + ']+', 'g');
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'data' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/[.](ts|js|mjs|cjs|mts|cts)$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf8');
          // The platform's own files (this one included) are not the app.
          if (!content.includes('PLATFORM-MANAGED FILE')) parts.push(content);
        }
      }
    };
    try { walk(path.join(process.cwd(), 'server')); } catch { /* unreadable: nothing is app-managed */ }
    const text = parts.join(' ').toLowerCase().replace(space, ' ');
    appColumnsSource = text.includes('add column') ? text : '';
  }
  if (!appColumnsSource) return false;
  const name = column.toLowerCase();
  const backtick = String.fromCharCode(96);
  return ['add column ' + name + ' ', 'add column "' + name + '"', 'add column ' + backtick + name + backtick,
    "'" + name + "'", '"' + name + '"', backtick + name + backtick].some((needle) => appColumnsSource!.includes(needle));
}

// Returns whether any table was changed.
function repairSchema(schemaSql: string, includeAppColumns: boolean): boolean {
  // The declared schema, built in a scratch database so SQLite does the
  // parsing: comparing PRAGMA table_info on both sides needs no SQL parser.
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(schemaSql);
    const tables = reference
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'")
      .all() as unknown as Array<{ name: string }>;
    let rebuilt = false;
    let changed = false;
    for (const { name } of tables) {
      try {
        const live = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)")
          .get(name) as unknown as { sql: string | null } | undefined;
        if (!live || !live.sql || /^CREATE VIRTUAL/i.test(live.sql)) continue;
        const wanted = columnsOf(reference, name);
        let current = columnsOf(db, name);
        if (!wanted.length || !current.length) continue;

        const absent = wanted.filter((column) => !current.some((item) => sameName(item.name, column.name)));
        // Left to the app's own ADD COLUMN code (see addedByApp).
        const appAdds = includeAppColumns
          ? []
          : absent.filter((column) => !column.pk && addedByApp(column.name)).map((column) => column.name);
        const missing = absent.filter((column) => !appAdds.includes(column.name));
        const tooStrict = current.some((column) => {
          if (!column.notnull || column.dflt_value !== null || column.pk) return false;
          const target = wanted.find((item) => sameName(item.name, column.name));
          return !target || !target.notnull || target.dflt_value !== null;
        });
        if (!missing.length && !tooStrict) continue;

        if (!tooStrict && missing.every((column) => !column.pk && hasConstantDefault(column))) {
          try {
            for (const column of missing) {
              const rule = column.notnull
                ? ' NOT NULL DEFAULT ' + emptyValue(column)
                : column.dflt_value !== null ? ' DEFAULT ' + column.dflt_value : '';
              db.exec('ALTER TABLE ' + quoteName(name) + ' ADD COLUMN ' + quoteName(column.name) + ' ' + column.type + rule + ';');
            }
            console.log('[db] schema repair: added ' + missing.map((column) => column.name).join(', ') + ' to ' + name);
            changed = true;
            continue;
          } catch {
            // A column ADD COLUMN cannot express: fall through to the rebuild.
            current = columnsOf(db, name);
          }
        }
        const rows = rebuildTable(reference, name, wanted, current, appAdds);
        rebuilt = true;
        changed = true;
        console.log('[db] schema repair: rebuilt ' + name + ' to match its CREATE TABLE statement (' + rows + ' rows kept)');
      } catch (error) {
        console.error('[db] schema repair: ' + name + ' left as it was:', error);
      }
    }
    // A rebuilt table lost the indexes declared for it in the schema.
    if (rebuilt) {
      try { db.exec(schemaSql); } catch { /* migrate() runs the statements itself */ }
    }
    return changed;
  } finally {
    reference.close();
  }
}

// Replace a table with its declared definition, keeping every row and column.
function rebuildTable(reference: DatabaseSync, table: string, wanted: ColumnInfo[], current: ColumnInfo[], appAdds: string[]): number {
  const staging = table + '__rebuild';
  // SQLite rewrites the CREATE statement under the staging name for us,
  // self-references included.
  let createSql = '';
  reference.exec('ALTER TABLE ' + quoteName(table) + ' RENAME TO ' + quoteName(staging) + ';');
  try {
    createSql = (reference
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(staging) as unknown as { sql: string }).sql;
  } finally {
    reference.exec('ALTER TABLE ' + quoteName(staging) + ' RENAME TO ' + quoteName(table) + ';');
  }

  // A new NOT NULL column with no default gets the same empty value for the
  // old rows as the ADD COLUMN path gives it; otherwise the copy would fail.
  const required = wanted.filter((column) =>
    column.notnull && column.dflt_value === null && !column.pk &&
    !current.some((item) => sameName(item.name, column.name)) &&
    !appAdds.some((name) => sameName(name, column.name)));
  const names = current.map((column) => quoteName(column.name))
    .concat(required.map((column) => quoteName(column.name))).join(', ');
  const values = current.map((column) => {
    const target = wanted.find((item) => sameName(item.name, column.name));
    return target && target.notnull && !target.pk
      ? 'COALESCE(' + quoteName(column.name) + ', ' + emptyValue(target) + ')'
      : quoteName(column.name);
  }).concat(required.map((column) => emptyValue(column))).join(', ');
  // Indexes and triggers go away with the old table; put back the ones that
  // were created outside the schema too.
  const attached = db
    .prepare("SELECT sql FROM sqlite_master WHERE lower(tbl_name) = lower(?) AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all(table) as unknown as Array<{ sql: string }>;
  let sequence: number | null = null;
  try {
    const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE lower(name) = lower(?)').get(table) as unknown as { seq: number } | undefined;
    sequence = row ? row.seq : null;
  } catch {
    // No AUTOINCREMENT table in this database.
  }

  // Off for the swap, so dropping the old table cascades nothing. Other
  // tables keep referring to this one by name and find the new one there.
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec('DROP TABLE IF EXISTS ' + quoteName(staging) + ';');
      db.exec(createSql + ';');
      // Not created here: the app adds these itself and may fill them as it does.
      for (const column of appAdds) {
        db.exec('ALTER TABLE ' + quoteName(staging) + ' DROP COLUMN ' + quoteName(column) + ';');
      }
      for (const column of current) {
        if (wanted.some((item) => sameName(item.name, column.name))) continue;
        db.exec('ALTER TABLE ' + quoteName(staging) + ' ADD COLUMN ' + quoteName(column.name) + ' ' + column.type + ';');
      }
      db.exec('INSERT INTO ' + quoteName(staging) + ' (' + names + ') SELECT ' + values + ' FROM ' + quoteName(table) + ';');
      const rows = (db.prepare('SELECT COUNT(*) AS n FROM ' + quoteName(staging)).get() as unknown as { n: number }).n;
      db.exec('DROP TABLE ' + quoteName(table) + ';');
      db.exec('ALTER TABLE ' + quoteName(staging) + ' RENAME TO ' + quoteName(table) + ';');
      for (const item of attached) {
        try { db.exec(item.sql + ';'); } catch { /* no longer valid for the new definition */ }
      }
      if (sequence !== null) {
        // Keep AUTOINCREMENT counting from where it was, so an id that was
        // deleted is never handed out again.
        try {
          db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?').run(sequence, table, sequence);
          db.prepare('INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)').run(table, sequence, table);
        } catch { /* the declared table is no longer AUTOINCREMENT */ }
      }
      db.exec('COMMIT;');
      return rows;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
