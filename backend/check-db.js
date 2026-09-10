/* Proves a database is actually usable before you trust production to it.
 *
 *   npm run db:check
 *
 * Connects, applies the schema, and exercises the operations the app depends
 * on — including the two that behave differently on Postgres (an insert into a
 * table with no `id` column, and a text column defaulting to a timestamp).
 * Everything it writes is removed again.
 */

import { loadEnv } from "./env.js";
import { initDb, db, closeDb, nowIso } from "./db.js";

loadEnv();

const ok   = m => console.log("  \x1b[32m✓\x1b[0m " + m);
const fail = m => console.log("  \x1b[31m✗\x1b[0m " + m);

const target = process.env.DATABASE_URL
  ? redact(process.env.DATABASE_URL)
  : (process.env.SQLITE_FILE || "backend/data/nas.db (SQLite)");

function redact(url){
  try{
    const u = new URL(url);
    return `${u.protocol}//${u.username ? u.username + ":***@" : ""}${u.host}${u.pathname}`;
  }catch{ return "(unparseable DATABASE_URL)"; }
}

let failures = 0;
async function step(name, fn){
  try{
    await fn();
    ok(name);
  }catch(e){
    fail(`${name}\n      ${e.message}`);
    failures++;
  }
}

console.log(`\nChecking ${target}\n`);

const started = Date.now();
try{
  await initDb();
  ok(`connected and schema applied (${Date.now() - started} ms)`);
}catch(e){
  fail("could not connect: " + e.message);
  console.log("\nNothing else can run. Check the connection string and that the database is awake.\n");
  process.exit(1);
}

const d = db();
console.log(`  driver: ${d.kind}\n`);

await step("read the product catalogue", async () => {
  const row = await d.get("SELECT COUNT(*) AS n FROM products");
  console.log(`      ${Number(row.n)} products`);
});

await step("insert into a table with an id (prices) and get the id back", async () => {
  const p = await d.get("SELECT id FROM products LIMIT 1");
  if(!p) throw new Error("no products yet — run `npm run seed` first");
  const res = await d.run(
    `INSERT INTO prices (product_id, base_price, quote_price, effective_from, note, created_by, created_at)
     VALUES (?,?,?,?,?,NULL,?)`,
    [p.id, 1, 1, "1970-01-01", "db:check", nowIso()]
  );
  if(!res.lastId) throw new Error("no id returned from the insert");
  await d.run("DELETE FROM prices WHERE id = ?", [res.lastId]);
});

/* This is the one that breaks on Postgres if RETURNING id is added blindly —
   and it runs on every single login. */
await step("insert into a table with NO id column (sessions)", async () => {
  const u = await d.get("SELECT id FROM users LIMIT 1");
  if(!u) throw new Error("no users yet — seed with ADMIN_EMAIL/ADMIN_PASSWORD first");
  await d.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    ["db-check-token", u.id, nowIso(), nowIso()]
  );
  await d.run("DELETE FROM sessions WHERE token_hash = ?", ["db-check-token"]);
});

/* Text columns default to a timestamp; Postgres needs that cast explicitly. */
await step("a row that relies on the created_at default", async () => {
  await d.run("INSERT INTO settings (key, value) VALUES (?,?)", ["db_check", "x"]);
  const row = await d.get("SELECT value, updated_at FROM settings WHERE key = ?", ["db_check"]);
  if(!row?.updated_at) throw new Error("updated_at did not default to anything");
  await d.run("DELETE FROM settings WHERE key = ?", ["db_check"]);
});

await step("a query whose parameters sit beside a literal question mark", async () => {
  const rows = await d.all("SELECT id FROM products WHERE name <> 'why?' AND id > ? LIMIT ?", [0, 3]);
  if(!Array.isArray(rows)) throw new Error("expected rows back");
});

await step("the pricing payload builds", async () => {
  const { buildPricingPayload } = await import("./pricing.js");
  const p = await buildPricingPayload();
  console.log(`      ${p.models.length} NAS units, ${p.capacities.length} drive sizes, ` +
              `${p.warnings.length} warning(s)`);
  if(p.warnings.length) p.warnings.forEach(w => console.log(`      ! ${w}`));
});

await closeDb();

console.log(failures
  ? `\n${failures} check(s) failed — do not point production at this yet.\n`
  : "\nAll checks passed. This database is ready.\n");
process.exit(failures ? 1 : 0);
