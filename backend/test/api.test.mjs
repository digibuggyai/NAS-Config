/* Drives the real API over HTTP against a throwaway database: roles, product
 * CRUD, the append-only price history, and the payload the configurator reads. */

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "../db.js";
import { seed } from "../seed.js";
import { createApp } from "../index.js";

const dbFile = join(tmpdir(), `nas-test-${process.pid}.db`);
let base, server, adminCookie, repCookie;

/** fetch with cookie handling, since the session is an HttpOnly cookie. */
async function call(path, { method = "GET", body, cookie } = {}){
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
  const text = await res.text();
  let json = null;
  try{ json = JSON.parse(text); }catch{ /* not every response is JSON */ }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

const cookieFrom = header => header ? header.split(";")[0] : null;

test.before(async () => {
  await rm(dbFile, { force: true });
  await initDb({ file: dbFile });
  await seed({ adminEmail: "admin@test.local", adminPassword: "admin-password", quiet: true });

  // A rep account, to check the role gates from the other side.
  const { hashPassword } = await import("../auth.js");
  const { db } = await import("../db.js");
  await db().run(
    "INSERT INTO users (email, name, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)",
    ["rep@test.local", "Rep", await hashPassword("rep-password"), "rep", new Date().toISOString()]
  );

  server = createApp().listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  adminCookie = cookieFrom((await call("/api/auth/login", {
    method: "POST", body: { email: "admin@test.local", password: "admin-password" }
  })).setCookie);
  repCookie = cookieFrom((await call("/api/auth/login", {
    method: "POST", body: { email: "rep@test.local", password: "rep-password" }
  })).setCookie);
});

test.after(async () => {
  server?.close();
  await closeDb();
  // Windows keeps the file handle a moment after close; a leftover temp file is
  // harmless, so don't fail the run over it.
  await rm(dbFile, { force: true }).catch(() => {});
  await rm(dbFile + "-wal", { force: true }).catch(() => {});
  await rm(dbFile + "-shm", { force: true }).catch(() => {});
});

/* ---------------- auth ---------------- */

test("a wrong password is refused, and says nothing about which part was wrong", async () => {
  const bad = await call("/api/auth/login", { method:"POST", body:{ email:"admin@test.local", password:"nope" }});
  const noSuchUser = await call("/api/auth/login", { method:"POST", body:{ email:"ghost@test.local", password:"nope" }});
  assert.equal(bad.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(bad.json.error, noSuchUser.json.error);
  assert.equal(bad.setCookie, null);
});

test("signing in returns the user and sets a HttpOnly cookie", async () => {
  const res = await call("/api/auth/login", {
    method:"POST", body:{ email:"admin@test.local", password:"admin-password" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.role, "admin");
  assert.match(res.setCookie, /HttpOnly/);
  assert.match(res.setCookie, /SameSite=Lax/);
});

/* ---------------- role gates ---------------- */

test("the price list is public; the catalogue behind it is not", async () => {
  assert.equal((await call("/api/pricing")).status, 200);
  assert.equal((await call("/api/products")).status, 401);
});

test("/api/pricing (the internal tool's feed) still carries the minimum", async () => {
  const { json } = await call("/api/pricing");
  assert.ok(json.models.every(m => "minTax" in m), "every model has a floor price");
  assert.ok(Object.values(json.hddPricing).every(byLine =>
    Object.values(byLine).every(p => "min" in p)));
  assert.ok("min" in json.install);
  assert.ok("min" in json.amcRate);
});

test("/api/pricing/public carries the same catalogue with the minimum left out entirely", async () => {
  const [full, pub] = await Promise.all([call("/api/pricing"), call("/api/pricing/public")]);
  assert.equal(pub.status, 200);

  // Same products, same asking prices — this is the same tool minus one number,
  // not a cut-down version of it.
  assert.deepEqual(pub.json.models.map(m => m.id).sort(), full.json.models.map(m => m.id).sort());
  assert.deepEqual(pub.json.models.map(m => m.quote), full.json.models.map(m => m.quote));
  assert.deepEqual(pub.json.capacities, full.json.capacities);
  assert.equal(pub.json.install.quote, full.json.install.quote);

  // The floor price is absent, not just zeroed or hidden — nothing for a
  // customer to find by opening dev tools on a page built against this feed.
  assert.ok(pub.json.models.every(m => !("minTax" in m)));
  assert.ok(Object.values(pub.json.hddPricing).every(byLine =>
    Object.values(byLine).every(p => !("min" in p))));
  assert.ok(!("min" in pub.json.install));
  assert.ok(!("min" in pub.json.amcRate));
  assert.ok(pub.json.upgrades.every(u => !("min" in u)));
});

test("a rep cannot read or change the catalogue", async () => {
  assert.equal((await call("/api/products", { cookie: repCookie })).status, 403);
  assert.equal((await call("/api/users", { cookie: repCookie })).status, 403);
  const attempt = await call("/api/products", {
    method:"POST", cookie: repCookie,
    body:{ sku:"SNEAK", category:"NAS", name:"Sneak", bays:4 }
  });
  assert.equal(attempt.status, 403);
});

test("a rep can still save and read their own quotes", async () => {
  const created = await call("/api/quotes", {
    method:"POST", cookie: repCookie,
    body:{ ref:"DGB-TEST-1", customerName:"Test Co", totalMax:100000, totalMin:90000 }
  });
  assert.equal(created.status, 201);

  const list = await call("/api/quotes", { cookie: repCookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.quotes.some(q => q.ref === "DGB-TEST-1"));
});

test("an admin sees every rep's quotes, a rep sees only their own", async () => {
  await call("/api/quotes", {
    method:"POST", cookie: adminCookie,
    body:{ ref:"DGB-TEST-ADMIN", customerName:"Admin Co", totalMax:1, totalMin:1 }
  });
  const asAdmin = await call("/api/quotes", { cookie: adminCookie });
  const asRep = await call("/api/quotes", { cookie: repCookie });

  assert.ok(asAdmin.json.quotes.some(q => q.ref === "DGB-TEST-1"));
  assert.ok(asAdmin.json.quotes.some(q => q.ref === "DGB-TEST-ADMIN"));
  assert.ok(!asRep.json.quotes.some(q => q.ref === "DGB-TEST-ADMIN"));
});

/* ---------------- the seeded catalogue ---------------- */

test("the seeded price list reproduces the supplied sheet exactly", async () => {
  const { json } = await call("/api/pricing");

  assert.equal(json.models.length, 15);
  assert.equal(json.gstRate, 0.18);
  assert.deepEqual(json.capacities, [2,4,6,8,10,12,16]);
  assert.deepEqual(json.warnings, []);

  const expect = {
    "DS223J":22420, "DS225+":40120, "DS725+":89680, "TS-233-2G":22420, "TS-216G-4G":27730,
    "DS425+":63720, "DS925+":92630, "TS-433-4G":42480, "TS-462-4G":54280, "TS-464-8G":66080,
    "DS1525+":135700, "TS-664-8G":82600, "DS1825+":171100, "TS-832PX-4G":103250, "TS-873A-8G":123900
  };
  for(const m of json.models){
    assert.equal(m.minTax, expect[m.id], `${m.id} minimum`);
  }
  assert.deepEqual(json.install, { quote:5900, min:4130 });
  assert.deepEqual(json.amcRate, { quote:0.10, min:0.07 });
});

test("DS1525+ is a 5-bay chassis", async () => {
  const { json } = await call("/api/pricing");
  assert.equal(json.models.find(m => m.id === "DS1525+").bays, 5);
});

test("the minimum is derived from the base, never stored", async () => {
  const { json } = await call("/api/pricing");
  const ds = json.models.find(m => m.id === "DS425+");
  assert.equal(ds.minTax, Math.round(54000 * 1.18));      // 63720
});

/* ---------------- seeding ---------------- */

/* Runs before anything below changes a price, so "nothing changed" is the truth
 * being tested rather than an accident of ordering. */
test("re-seeding an untouched catalogue changes nothing", async () => {
  const before = (await call("/api/pricing")).json;
  const result = await seed({ quiet: true });
  const after = (await call("/api/pricing")).json;

  assert.equal(result.added, 0);
  assert.equal(result.repriced, 0, "no duplicate history entries");
  assert.deepEqual(after.models.map(m => m.id).sort(), before.models.map(m => m.id).sort());
});

/* ---------------- products ---------------- */

test("a product can be created, and appears in the price list once priced", async () => {
  const created = await call("/api/products", {
    method:"POST", cookie: adminCookie,
    body:{
      sku:"DS1621+", category:"NAS", name:"DS1621+", brand:"Synology", bays:6,
      raid:["RAID5","RAID6","RAID10"], expandable:true, unit:"per_unit",
      price:{ base:100000, quote:124000, note:"New line" }
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.product.price.min, 118000);   // 100000 x 1.18

  const { json } = await call("/api/pricing");
  const added = json.models.find(m => m.id === "DS1621+");
  assert.ok(added, "the new unit is quotable");
  assert.equal(added.bays, 6);
});

test("RAM and NIC products appear in the public payload as plain upgrades", async () => {
  const ram = await call("/api/products", {
    method:"POST", cookie: adminCookie,
    body:{
      sku:"RAM-8GB-TEST", category:"RAM", name:"8GB DDR4 SODIMM", brand:"Crucial", unit:"per_unit",
      price:{ base:4200, quote:4500 }
    }
  });
  assert.equal(ram.status, 201);
  assert.equal(ram.json.product.price.min, Math.round(4200 * 1.18));

  const nic = await call("/api/products", {
    method:"POST", cookie: adminCookie,
    body:{
      sku:"NIC-10G-TEST", category:"NIC", name:"10GbE PCIe Network Card", brand:"QNAP", unit:"per_unit",
      price:{ base:13200, quote:14000 }
    }
  });
  assert.equal(nic.status, 201);

  const { json } = await call("/api/pricing");
  const upgrades = json.upgrades.filter(u => u.sku === "RAM-8GB-TEST" || u.sku === "NIC-10G-TEST");
  assert.equal(upgrades.length, 2, "both are exposed to the public feed the configurator reads");

  const ramLine = json.upgrades.find(u => u.sku === "RAM-8GB-TEST");
  assert.equal(ramLine.category, "RAM");
  assert.equal(ramLine.quote, 4500);
  assert.equal(ramLine.min, Math.round(4200 * 1.18));

  // A NAS unit or a drive with no upgrades entered at all must not appear here —
  // the category is what puts a product in this list, nothing else.
  assert.ok(!json.upgrades.some(u => u.category !== "RAM" && u.category !== "NIC"));
});

test("a NAS without a bay count is refused, since it can't be sized", async () => {
  const res = await call("/api/products", {
    method:"POST", cookie: adminCookie,
    body:{ sku:"NO-BAYS", category:"NAS", name:"Mystery box" }
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /bay count/i);
});

test("a duplicate SKU is refused", async () => {
  const res = await call("/api/products", {
    method:"POST", cookie: adminCookie,
    body:{ sku:"DS425+", category:"NAS", name:"Clash", bays:4 }
  });
  assert.equal(res.status, 409);
});

test("deactivating hides a product from quoting but keeps its history", async () => {
  const before = (await call("/api/pricing")).json.models.length;
  const target = (await call("/api/products", { cookie: adminCookie }))
    .json.products.find(p => p.sku === "DS1621+");

  const res = await call(`/api/products/${target.id}`, { method:"DELETE", cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.product.active, false);

  assert.equal((await call("/api/pricing")).json.models.length, before - 1);
  const history = await call(`/api/products/${target.id}/prices`, { cookie: adminCookie });
  assert.equal(history.json.prices.length, 1, "the price it had is still on record");
});

/* ---------------- price history ---------------- */

test("changing a price appends to history rather than overwriting", async () => {
  const product = (await call("/api/products", { cookie: adminCookie }))
    .json.products.find(p => p.sku === "TS-433-4G");

  const before = (await call(`/api/products/${product.id}/prices`, { cookie: adminCookie })).json.prices.length;

  const res = await call(`/api/products/${product.id}/prices`, {
    method:"POST", cookie: adminCookie,
    body:{ base:38000, quote:47000, note:"Distributor increase" }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.product.price.base, 38000);
  assert.equal(res.json.product.price.min, Math.round(38000 * 1.18));

  const after = (await call(`/api/products/${product.id}/prices`, { cookie: adminCookie })).json.prices;
  assert.equal(after.length, before + 1);
  assert.equal(after[0].note, "Distributor increase");
  assert.equal(after[0].createdBy, "Administrator", "the change is attributed");
  assert.equal(after[1].base, 36000, "the old price is still there");
});

test("a future-dated price waits until its day", async () => {
  const product = (await call("/api/products", { cookie: adminCookie }))
    .json.products.find(p => p.sku === "TS-462-4G");
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0,10);

  await call(`/api/products/${product.id}/prices`, {
    method:"POST", cookie: adminCookie,
    body:{ base:50000, quote:62000, effectiveFrom: future, note:"April list" }
  });

  const today = (await call("/api/pricing")).json.models.find(m => m.id === "TS-462-4G");
  assert.equal(today.minTax, 54280, "still quoting the current price");

  const later = (await call(`/api/pricing?asOf=${future}`)).json.models.find(m => m.id === "TS-462-4G");
  assert.equal(later.minTax, Math.round(50000 * 1.18), "the new price applies from its date");
});

test("a price that isn't a number is refused", async () => {
  const product = (await call("/api/products", { cookie: adminCookie }))
    .json.products.find(p => p.sku === "TS-433-4G");
  const res = await call(`/api/products/${product.id}/prices`, {
    method:"POST", cookie: adminCookie, body:{ base:"about forty thousand" }
  });
  assert.equal(res.status, 400);
});

/* ---------------- users ---------------- */

test("the last active admin can't lock themselves out", async () => {
  const me = (await call("/api/users", { cookie: adminCookie })).json.users
    .find(u => u.email === "admin@test.local");
  const res = await call(`/api/users/${me.id}`, {
    method:"PATCH", cookie: adminCookie, body:{ role:"rep" }
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /last active admin/i);
});

test("a short password is refused", async () => {
  const res = await call("/api/users", {
    method:"POST", cookie: adminCookie,
    body:{ email:"short@test.local", password:"abc" }
  });
  assert.equal(res.status, 400);
});

/* ---------------- production hardening ---------------- */

test("security headers are set on every response", async () => {
  const res = await fetch(base + "/healthz");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-powered-by"), null, "the framework isn't advertised");
});

test("repeated wrong passwords are throttled", async () => {
  const { loginRateLimit, clearLoginAttempts } = await import("../ratelimit.js");

  // drive the middleware directly: the limit is per-IP and the test client
  // shares one, so this keeps it from throttling the rest of the suite
  const req = { method:"POST", ip:"203.0.113.9" };
  const run = () => new Promise(resolve => {
    const res = {
      statusCode: 200, body: null,
      set(){ return this; },
      status(c){ this.statusCode = c; return this; },
      json(b){ this.body = b; resolve(this); return this; }
    };
    loginRateLimit(req, res, () => resolve({ statusCode: 200, passed: true }));
  });

  for(let i = 0; i < 10; i++){
    const r = await run();
    assert.ok(r.passed, `attempt ${i + 1} still allowed`);
  }
  const blocked = await run();
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body.error, /Too many sign-in attempts/);

  // a successful sign-in wipes the strikes
  clearLoginAttempts("203.0.113.9");
  assert.ok((await run()).passed, "allowed again after a good sign-in");
});

test("a GET to the login path is not counted against the limit", async () => {
  const { loginRateLimit } = await import("../ratelimit.js");
  let passed = false;
  loginRateLimit({ method:"GET", ip:"203.0.113.10" }, {}, () => { passed = true; });
  assert.ok(passed);
});
