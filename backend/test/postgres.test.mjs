/* The Postgres path shares every query with SQLite; only placeholders and a few
 * column types differ. Those two rewrites are all that stands between the two
 * databases, so they are tested directly — a live Postgres isn't needed to know
 * whether the translation is right. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toPgPlaceholders, schemaForPg } from "../db.js";

test("positional placeholders are numbered in order", () => {
  assert.equal(
    toPgPlaceholders("INSERT INTO users (email, name) VALUES (?, ?)"),
    "INSERT INTO users (email, name) VALUES ($1, $2)"
  );
  assert.equal(
    toPgPlaceholders("SELECT * FROM p WHERE a = ? AND b = ? AND c = ?"),
    "SELECT * FROM p WHERE a = $1 AND b = $2 AND c = $3"
  );
});

test("a question mark inside a string literal is left alone", () => {
  // this would otherwise corrupt the data being written
  assert.equal(
    toPgPlaceholders("UPDATE q SET note = 'why?' WHERE id = ?"),
    "UPDATE q SET note = 'why?' WHERE id = $1"
  );
  assert.equal(
    toPgPlaceholders("SELECT ? WHERE k = 'a?b?c' AND j = ?"),
    "SELECT $1 WHERE k = 'a?b?c' AND j = $2"
  );
});

test("a query with no placeholders is untouched", () => {
  const sql = "SELECT COUNT(*) AS n FROM prices";
  assert.equal(toPgPlaceholders(sql), sql);
});

test("the real queries in the app translate cleanly", () => {
  const real = [
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    "SELECT base_price, quote_price FROM prices WHERE product_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
    "UPDATE products SET active = 0, updated_at = ? WHERE id = ?"
  ];
  for(const sql of real){
    const out = toPgPlaceholders(sql);
    assert.ok(!out.includes("?"), `every placeholder converted in: ${sql}`);
    const expected = (sql.match(/\?/g) || []).length;
    assert.equal((out.match(/\$\d+/g) || []).length, expected);
  }
});

test("the schema converts to Postgres types", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const pg = schemaForPg(schema);

  assert.ok(!pg.includes("AUTOINCREMENT"), "SQLite's autoincrement is gone");
  assert.ok(pg.includes("SERIAL PRIMARY KEY"), "replaced by SERIAL");
  assert.ok(!/\bREAL\b/.test(pg), "REAL is not a Postgres type here");
  assert.ok(pg.includes("DOUBLE PRECISION"));

  // everything else must survive untouched
  assert.equal((schema.match(/CREATE TABLE/g) || []).length, (pg.match(/CREATE TABLE/g) || []).length);
  assert.equal((schema.match(/CREATE INDEX/g) || []).length, (pg.match(/CREATE INDEX/g) || []).length);
  assert.ok(pg.includes("REFERENCES users(id)"), "foreign keys are unchanged");
});

test("the Postgres driver is actually installed", async () => {
  // Without this dependency, setting DATABASE_URL crashes the server on boot.
  const pg = await import("pg");
  assert.ok(pg.default.Pool, "pg exposes a Pool");
});

test("only tables that have an id column get RETURNING id", async () => {
  const { insertReturnsId } = await import("../db.js");

  // sessions is keyed by token_hash and settings by key: asking Postgres for
  // RETURNING id on those is an error, and sessions are written on every login
  assert.equal(insertReturnsId("INSERT INTO sessions (token_hash, user_id) VALUES (?,?)"), false);
  assert.equal(insertReturnsId("INSERT INTO settings (key, value) VALUES (?,?)"), false);

  assert.equal(insertReturnsId("INSERT INTO users (email) VALUES (?)"), true);
  assert.equal(insertReturnsId("INSERT INTO products (sku) VALUES (?)"), true);
  assert.equal(insertReturnsId("INSERT INTO prices (product_id) VALUES (?)"), true);
  assert.equal(insertReturnsId("INSERT INTO quotes (ref) VALUES (?)"), true);

  // never doubled up, and never on a read
  assert.equal(insertReturnsId("INSERT INTO users (email) VALUES (?) RETURNING id"), false);
  assert.equal(insertReturnsId("SELECT * FROM users"), false);
  assert.equal(insertReturnsId("  insert   into   products (sku) values (?)"), true, "whitespace and case");
});

test("a text column's timestamp default is cast for Postgres", () => {
  const pg = schemaForPg("created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
  // Postgres has no implicit timestamptz -> text cast, so the raw form is a
  // "column is of type text but default expression is of type timestamp" error
  assert.ok(!pg.includes("DEFAULT CURRENT_TIMESTAMP"));
  assert.ok(pg.includes("now()::text"));
});

test("every timestamp default in the real schema is cast", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const pg = schemaForPg(schema);
  const raw = (schema.match(/DEFAULT CURRENT_TIMESTAMP/g) || []).length;
  assert.ok(raw > 0, "the schema does use the default");
  assert.equal((pg.match(/DEFAULT CURRENT_TIMESTAMP/g) || []).length, 0);
  assert.equal((pg.match(/DEFAULT \(now\(\)::text\)/g) || []).length, raw);
});

test("loading .env never overwrites the real environment", async () => {
  const { loadEnv } = await import("../env.js");
  const result = loadEnv("does-not-exist.env");
  assert.equal(result.loaded, false, "a missing file is not an error");

  process.env.NAS_TEST_KEEP = "from-platform";
  const { writeFileSync, rmSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  // fileURLToPath, not .pathname: on Windows the latter keeps a leading slash
  // and percent-encoding, so the file is written in one place and read from another
  const tmp = fileURLToPath(new URL("../data/.env.test", import.meta.url));
  writeFileSync(tmp, '# a comment\nNAS_TEST_KEEP=from-file\nNAS_TEST_NEW="quoted value"\n');
  loadEnv(tmp);

  assert.equal(process.env.NAS_TEST_KEEP, "from-platform", "the platform's value wins");
  assert.equal(process.env.NAS_TEST_NEW, "quoted value", "quotes are stripped");
  rmSync(tmp);
  delete process.env.NAS_TEST_KEEP;
  delete process.env.NAS_TEST_NEW;
});

test("libpq-only connection parameters are dropped before pg sees them", async () => {
  const { stripLibpqParams } = await import("../db.js");

  // Neon hands out exactly this shape; node-postgres warns on sslmode and has no
  // channel binding, so both are removed and the driver's ssl option governs.
  const neon = "postgresql://u:p@ep-x-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const out = stripLibpqParams(neon);
  assert.ok(!out.includes("sslmode"));
  assert.ok(!out.includes("channel_binding"));
  assert.ok(out.startsWith("postgresql://u:p@ep-x-pooler.c-2.us-east-2.aws.neon.tech/neondb"));

  // anything else in the string is left alone
  const withOther = stripLibpqParams("postgresql://u:p@h/db?sslmode=require&application_name=nas");
  assert.ok(withOther.includes("application_name=nas"));

  // and an unparseable string is passed through rather than mangled
  assert.equal(stripLibpqParams("not a url"), "not a url");
});

test("today is the India business date, not the UTC date", async () => {
  const { todayIso } = await import("../db.js");

  // 00:51 IST on the 15th is still 19:21 UTC on the 14th. Before the fix, a price
  // entered in the first 5.5 hours of an Indian morning was dated the day before.
  assert.equal(todayIso(new Date("2026-09-14T19:21:00Z")), "2026-09-15");

  // just before IST midnight it is still the same day in both
  assert.equal(todayIso(new Date("2026-09-14T18:29:00Z")), "2026-09-14");

  // and the shape is what effective_from stores
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
});
