/* Database access.
 *
 * Speaks SQLite by default (a file, nothing to provision) and Postgres when
 * DATABASE_URL is set — which is what most managed platforms hand you, and what
 * you want there anyway, since their disks are usually ephemeral.
 *
 * Queries are written once, in SQLite-flavoured SQL with `?` placeholders. The
 * Postgres driver rewrites the handful of differences on the way through.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let driver = null;

/* ---------------- placeholder + dialect translation ---------------- */

/** `?, ?` -> `$1, $2`, leaving anything inside string literals alone. */
function toPgPlaceholders(sql){
  let i = 0, out = "", inString = false;
  for(let c = 0; c < sql.length; c++){
    const ch = sql[c];
    if(ch === "'") inString = !inString;
    out += (ch === "?" && !inString) ? `$${++i}` : ch;
  }
  return out;
}

/** Rewrites the schema for Postgres. Only the column types differ. */
function schemaForPg(sql){
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "SERIAL PRIMARY KEY")
    .replace(/DEFAULT CURRENT_TIMESTAMP/g, "DEFAULT CURRENT_TIMESTAMP")
    .replace(/\bREAL\b/g, "DOUBLE PRECISION");
}

/* ---------------- SQLite (libsql) ----------------
 *
 * @libsql/client rather than better-sqlite3: it ships prebuilt binaries, so a
 * checkout works without a C++ toolchain installed. The same client also talks
 * to a hosted Turso database if this ever needs to outlive a single machine.
 */

async function sqliteDriver(file){
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: file.startsWith("libsql:") || file.startsWith("http") ? file : `file:${file}` });

  await client.execute("PRAGMA foreign_keys = ON");

  return {
    kind: "sqlite",
    async all(sql, params = []){ return (await client.execute({ sql, args: params })).rows.map(plain); },
    async get(sql, params = []){
      const rows = (await client.execute({ sql, args: params })).rows;
      return rows.length ? plain(rows[0]) : null;
    },
    async run(sql, params = []){
      const r = await client.execute({ sql, args: params });
      return { changes: r.rowsAffected, lastId: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
    },
    async exec(sql){ await client.executeMultiple(sql); },
    async transaction(fn){
      const tx = await client.transaction("write");
      try{
        const out = await fn();
        await tx.commit();
        return out;
      }catch(e){
        await tx.rollback();
        throw e;
      }
    },
    async close(){ client.close(); }
  };
}

/* libsql rows are array-like objects; copy the named columns off so callers see
   an ordinary object whichever driver is in use. */
function plain(row){
  return Object.fromEntries(Object.entries(row).filter(([k]) => !/^\d+$/.test(k)));
}

/* ---------------- Postgres ---------------- */

async function postgresDriver(url){
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    // Managed Postgres almost always terminates TLS with its own certificate.
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  const query = async (sql, params) => (await pool.query(toPgPlaceholders(sql), params)).rows;

  return {
    kind: "postgres",
    async all(sql, params = []){ return query(sql, params); },
    async get(sql, params = []){ return (await query(sql, params))[0] ?? null; },
    async run(sql, params = []){
      // `id` is returned so inserts can report the new row the same way SQLite does.
      const wantsId = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
      const res = await pool.query(toPgPlaceholders(wantsId ? sql + " RETURNING id" : sql), params);
      return { changes: res.rowCount, lastId: res.rows[0]?.id ?? null };
    },
    async exec(sql){ await pool.query(schemaForPg(sql)); },
    async transaction(fn){
      const client = await pool.connect();
      try{
        await client.query("BEGIN");
        const out = await fn();
        await client.query("COMMIT");
        return out;
      }catch(e){
        await client.query("ROLLBACK");
        throw e;
      }finally{
        client.release();
      }
    },
    async close(){ await pool.end(); }
  };
}

/* ---------------- lifecycle ---------------- */

/** Opens the database and applies the schema. Safe to call more than once. */
export async function initDb({ url = process.env.DATABASE_URL, file = process.env.SQLITE_FILE } = {}){
  if(driver) return driver;

  driver = url
    ? await postgresDriver(url)
    : await sqliteDriver(file || join(here, "data", "nas.db"));

  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  await driver.exec(schema);
  return driver;
}

export function db(){
  if(!driver) throw new Error("initDb() has not been called");
  return driver;
}

export async function closeDb(){
  if(driver){ await driver.close(); driver = null; }
}

/* ---------------- helpers ---------------- */

/** SQLite has no boolean type, so both drivers store 0/1 and read it back here. */
export const bool = v => v === true || v === 1 || v === "1" || v === "t" || v === "true";

export function parseJson(value, fallback){
  if(value == null) return fallback;
  if(typeof value === "object") return value;         // Postgres json columns
  try{ return JSON.parse(value); }catch{ return fallback; }
}

export const nowIso = () => new Date().toISOString();
export const todayIso = () => new Date().toISOString().slice(0, 10);
