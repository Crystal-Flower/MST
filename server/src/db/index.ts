import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { config } from "../config";

/**
 * One tiny interface over two drivers: PGlite (embedded PostgreSQL, zero
 * install, the default for demos) and node-postgres for a real server or
 * Supabase (set DATABASE_URL). Both speak the same SQL.
 */
interface Driver {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
}

let driver: Driver | null = null;

async function connect(): Promise<Driver> {
  if (config.db.url) {
    const pool = new pg.Pool({ connectionString: config.db.url, max: 8 });
    // NUMERIC -> string (wei amounts), TIMESTAMPTZ stays Date.
    pg.types.setTypeParser(1700, (v) => v);
    pg.types.setTypeParser(20, (v) => Number(v));
    return {
      kind: "postgres",
      query: (sql, params) => pool.query(sql, params as any[]),
      exec: async (sql) => {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }
  const isMemory = !config.db.dir || config.db.dir.startsWith("memory:") || config.db.dir === ":memory:";
  if (!isMemory) {
    fs.mkdirSync(config.db.dir, { recursive: true });
  }
  const db = new PGlite(isMemory ? undefined : config.db.dir);
  await db.waitReady;
  return {
    kind: "pglite",
    query: (sql, params) => db.query(sql, params as any[]),
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

export async function initDb(): Promise<Driver> {
  if (driver) return driver;
  driver = await connect();
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  await driver.exec(schema);
  return driver;
}

function d(): Driver {
  if (!driver) throw new Error("database not initialised");
  return driver;
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await d().query(sql, params);
  return res.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string): Promise<void> {
  await d().exec(sql);
}

export function dbKind() {
  return driver?.kind ?? "pglite";
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await one<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Build "SET a = $2, b = $3" for dynamic partial updates. */
export function setClause(patch: Record<string, unknown>, offset = 1) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  return {
    sql: keys.map((k, i) => `${k} = $${i + offset}`).join(", "),
    values: keys.map((k) => {
      const v = patch[k];
      return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
    }),
  };
}

export async function update(table: string, id: string | number, patch: Record<string, unknown>) {
  const { sql, values } = setClause(patch, 2);
  if (!sql) return;
  await q(`UPDATE ${table} SET ${sql} WHERE id = $1`, [id, ...values]);
}

export async function closeDb() {
  await driver?.close();
  driver = null;
}
