/* HTTP API.
 *
 * Public:  GET /api/pricing            — what the configurator reads
 * Signed in (rep or admin): quotes
 * Admin only: products, prices, users
 */

import express from "express";
import { db, nowIso, todayIso, parseJson } from "./db.js";
import { buildPricingPayload, productsWithPrice, productWithPrice, minFor, gstRate } from "./pricing.js";
import {
  hashPassword, verifyPassword, createSession, destroySession, pruneSessions,
  readCookie, setSessionCookie, clearSessionCookie, requireRole
} from "./auth.js";

export const router = express.Router();

/** Wraps an async handler so a rejected promise becomes a 500 instead of a
 *  silently dropped request. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CATEGORIES = ["NAS","HDD","SSD","RAM","NIC","EXPANSION","SERVICE","ACCESSORY"];
const UNITS = ["per_unit","per_drive","percent_of_hardware","flat"];

/* ============================ auth ============================ */

router.post("/auth/login", wrap(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await db().get("SELECT * FROM users WHERE email = ?", [email]);

  // Same response either way: a wrong email must not be distinguishable from a
  // wrong password.
  const ok = user && (user.active === 1 || user.active === true) &&
             await verifyPassword(password, user.password_hash);
  if(!ok) return res.status(401).json({ error: "Wrong email or password" });

  await pruneSessions();
  const { token, expires } = await createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));

router.post("/auth/logout", wrap(async (req, res) => {
  await destroySession(readCookie(req));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get("/auth/me", (req, res) => res.json({ user: req.user || null }));

/* ============================ pricing feed ============================ */

/* Public on purpose: it is the price list the configurator quotes from, and the
   configurator itself is an internal page. It exposes prices, nothing else. */
router.get("/pricing", wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await buildPricingPayload({ asOf: req.query.asOf }));
}));

/* ============================ products ============================ */

router.get("/products", requireRole("admin"), wrap(async (req, res) => {
  res.json({ products: await productsWithPrice({ activeOnly: req.query.active === "1" }) });
}));

router.get("/products/:id", requireRole("admin"), wrap(async (req, res) => {
  const product = await productWithPrice(Number(req.params.id));
  if(!product) return res.status(404).json({ error: "No such product" });
  res.json({ product });
}));

router.post("/products", requireRole("admin"), wrap(async (req, res) => {
  const fields = validateProduct(req.body);
  if(fields.error) return res.status(400).json({ error: fields.error });

  const clash = await db().get("SELECT id FROM products WHERE sku = ?", [fields.sku]);
  if(clash) return res.status(409).json({ error: `SKU "${fields.sku}" is already used` });

  const { lastId } = await db().run(
    `INSERT INTO products (sku, category, name, brand, spec, bays, capacity_tb, raid,
                           expandable, network, network_upgrade, unit, active, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fields.sku, fields.category, fields.name, fields.brand, fields.spec, fields.bays,
     fields.capacityTb, JSON.stringify(fields.raid), fields.expandable ? 1 : 0, fields.network, fields.networkUpgrade,
     fields.unit, fields.active ? 1 : 0, fields.sortOrder, nowIso(), nowIso()]
  );

  // An opening price is optional; a product with none simply isn't quoted yet.
  if(fields.price) await insertPrice(lastId, fields.price, req.user.id);

  res.status(201).json({ product: await productWithPrice(lastId) });
}));

router.patch("/products/:id", requireRole("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db().get("SELECT * FROM products WHERE id = ?", [id]);
  if(!existing) return res.status(404).json({ error: "No such product" });

  const fields = validateProduct({ ...rowToInput(existing), ...req.body });
  if(fields.error) return res.status(400).json({ error: fields.error });

  if(fields.sku !== existing.sku){
    const clash = await db().get("SELECT id FROM products WHERE sku = ? AND id <> ?", [fields.sku, id]);
    if(clash) return res.status(409).json({ error: `SKU "${fields.sku}" is already used` });
  }

  await db().run(
    `UPDATE products SET sku=?, category=?, name=?, brand=?, spec=?, bays=?, capacity_tb=?,
            raid=?, expandable=?, network=?, network_upgrade=?, unit=?, active=?, sort_order=?, updated_at=?
      WHERE id=?`,
    [fields.sku, fields.category, fields.name, fields.brand, fields.spec, fields.bays,
     fields.capacityTb, JSON.stringify(fields.raid), fields.expandable ? 1 : 0, fields.network, fields.networkUpgrade,
     fields.unit, fields.active ? 1 : 0, fields.sortOrder, nowIso(), id]
  );

  if(req.body.price) await insertPrice(id, req.body.price, req.user.id);

  res.json({ product: await productWithPrice(id) });
}));

/* Deactivating keeps the product's price history and any quote that used it.
   Deleting outright is only allowed while nothing references it. */
router.delete("/products/:id", requireRole("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db().get("SELECT id FROM products WHERE id = ?", [id]);
  if(!existing) return res.status(404).json({ error: "No such product" });

  if(req.query.hard === "1"){
    await db().run("DELETE FROM products WHERE id = ?", [id]);
    return res.json({ deleted: true });
  }
  await db().run("UPDATE products SET active = 0, updated_at = ? WHERE id = ?", [nowIso(), id]);
  res.json({ product: await productWithPrice(id) });
}));

/* ============================ price history ============================ */

router.get("/products/:id/prices", requireRole("admin"), wrap(async (req, res) => {
  const rows = await db().all(
    `SELECT pr.*, p.unit, u.name AS created_by_name, u.email AS created_by_email
       FROM prices pr
       JOIN products p ON p.id = pr.product_id
       LEFT JOIN users u ON u.id = pr.created_by
      WHERE pr.product_id = ?
      ORDER BY pr.effective_from DESC, pr.id DESC`,
    [Number(req.params.id)]
  );
  const gst = await gstRate();
  res.json({
    prices: rows.map(r => ({
      id: r.id,
      base: Number(r.base_price),
      quote: Number(r.quote_price),
      min: minFor({ base: Number(r.base_price), unit: r.unit, gst }),
      effectiveFrom: String(r.effective_from).slice(0,10),
      note: r.note || "",
      createdAt: r.created_at,
      createdBy: r.created_by_name || r.created_by_email || null
    }))
  });
}));

router.post("/products/:id/prices", requireRole("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const product = await db().get("SELECT id FROM products WHERE id = ?", [id]);
  if(!product) return res.status(404).json({ error: "No such product" });

  const problem = validatePrice(req.body);
  if(problem) return res.status(400).json({ error: problem });

  await insertPrice(id, req.body, req.user.id);
  res.status(201).json({ product: await productWithPrice(id) });
}));

async function insertPrice(productId, price, userId){
  await db().run(
    `INSERT INTO prices (product_id, base_price, quote_price, effective_from, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [productId, Number(price.base), Number(price.quote ?? price.base),
     String(price.effectiveFrom || todayIso()).slice(0,10), String(price.note || ""), userId, nowIso()]
  );
}

/* ============================ quotes ============================ */

router.get("/quotes", requireRole("admin","rep"), wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  // A rep sees their own quotes; an admin sees everyone's.
  const mine = req.user.role !== "admin";
  const rows = await db().all(
    `SELECT q.id, q.ref, q.customer_name, q.customer_location, q.rep_name,
            q.total_max, q.total_min, q.status, q.created_at
       FROM quotes q
      ${mine ? "WHERE q.user_id = ?" : ""}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT ${limit}`,
    mine ? [req.user.id] : []
  );
  res.json({ quotes: rows.map(summary) });
}));

router.get("/quotes/:id", requireRole("admin","rep"), wrap(async (req, res) => {
  const row = await db().get("SELECT * FROM quotes WHERE id = ? OR ref = ?",
    [Number(req.params.id) || 0, req.params.id]);
  if(!row) return res.status(404).json({ error: "No such quote" });
  if(req.user.role !== "admin" && row.user_id !== req.user.id){
    return res.status(403).json({ error: "That quote belongs to someone else" });
  }
  res.json({ quote: { ...summary(row), config: parseJson(row.config, {}), lines: parseJson(row.lines, []) } });
}));

router.post("/quotes", requireRole("admin","rep"), wrap(async (req, res) => {
  const b = req.body || {};
  if(!b.ref) return res.status(400).json({ error: "A quote reference is required" });

  const existing = await db().get("SELECT id FROM quotes WHERE ref = ?", [String(b.ref)]);
  if(existing) return res.status(409).json({ error: "That reference has already been saved" });

  const { lastId } = await db().run(
    `INSERT INTO quotes (ref, customer_name, customer_location, rep_name, user_id, validity,
                         config, lines, total_max, total_min, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [String(b.ref), String(b.customerName || ""), String(b.customerLocation || ""),
     String(b.repName || req.user.name || ""), req.user.id, String(b.validity || ""),
     JSON.stringify(b.config || {}), JSON.stringify(b.lines || []),
     Number(b.totalMax) || 0, Number(b.totalMin) || 0, "draft", nowIso()]
  );
  res.status(201).json({ id: lastId, ref: b.ref });
}));

router.patch("/quotes/:id", requireRole("admin","rep"), wrap(async (req, res) => {
  const status = String(req.body?.status || "");
  if(!["draft","sent","won","lost"].includes(status)){
    return res.status(400).json({ error: "Status must be draft, sent, won or lost" });
  }
  const row = await db().get("SELECT * FROM quotes WHERE id = ?", [Number(req.params.id)]);
  if(!row) return res.status(404).json({ error: "No such quote" });
  if(req.user.role !== "admin" && row.user_id !== req.user.id){
    return res.status(403).json({ error: "That quote belongs to someone else" });
  }
  await db().run("UPDATE quotes SET status = ? WHERE id = ?", [status, row.id]);
  res.json({ ok: true });
}));

const summary = r => ({
  id: r.id, ref: r.ref,
  customerName: r.customer_name, customerLocation: r.customer_location,
  repName: r.rep_name, validity: r.validity,
  totalMax: Number(r.total_max), totalMin: Number(r.total_min),
  status: r.status, createdAt: r.created_at
});

/* ============================ users ============================ */

router.get("/users", requireRole("admin"), wrap(async (req, res) => {
  const rows = await db().all("SELECT id, email, name, role, active, created_at FROM users ORDER BY name, email");
  res.json({ users: rows.map(u => ({ ...u, active: u.active === 1 || u.active === true })) });
}));

router.post("/users", requireRole("admin"), wrap(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const role = req.body?.role === "admin" ? "admin" : "rep";

  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like an email address" });
  if(password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const clash = await db().get("SELECT id FROM users WHERE email = ?", [email]);
  if(clash) return res.status(409).json({ error: "Someone already uses that email" });

  const { lastId } = await db().run(
    "INSERT INTO users (email, name, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)",
    [email, String(req.body?.name || ""), await hashPassword(password), role, nowIso()]
  );
  res.status(201).json({ user: { id: lastId, email, name: req.body?.name || "", role, active: true } });
}));

router.patch("/users/:id", requireRole("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const user = await db().get("SELECT * FROM users WHERE id = ?", [id]);
  if(!user) return res.status(404).json({ error: "No such user" });

  const sets = [], params = [];
  if(req.body.name != null){ sets.push("name = ?"); params.push(String(req.body.name)); }
  if(req.body.role != null){ sets.push("role = ?"); params.push(req.body.role === "admin" ? "admin" : "rep"); }
  if(req.body.active != null){ sets.push("active = ?"); params.push(req.body.active ? 1 : 0); }
  if(req.body.password != null){
    if(String(req.body.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    sets.push("password_hash = ?"); params.push(await hashPassword(String(req.body.password)));
  }
  if(!sets.length) return res.status(400).json({ error: "Nothing to change" });

  // Locking yourself out of the only admin account would need database access to undo.
  if((req.body.role === "rep" || req.body.active === false) && user.role === "admin"){
    const others = await db().get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [id]);
    if(Number(others.n) === 0) return res.status(400).json({ error: "This is the last active admin" });
  }

  params.push(id);
  await db().run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  if(req.body.password != null || req.body.active === false){
    await db().run("DELETE FROM sessions WHERE user_id = ?", [id]);   // force a fresh sign-in
  }
  res.json({ ok: true });
}));

/* ============================ validation ============================ */

function rowToInput(r){
  return {
    sku: r.sku, category: r.category, name: r.name, brand: r.brand, spec: r.spec,
    bays: r.bays, capacityTb: r.capacity_tb, raid: parseJson(r.raid, []),
    expandable: r.expandable === 1 || r.expandable === true,
    unit: r.unit, active: r.active === 1 || r.active === true, sortOrder: r.sort_order
  };
}

function validateProduct(body = {}){
  const sku = String(body.sku ?? "").trim();
  const name = String(body.name ?? "").trim();
  const category = String(body.category ?? "").trim().toUpperCase();

  if(!sku) return { error: "SKU is required" };
  if(!name) return { error: "Name is required" };
  if(!CATEGORIES.includes(category)) return { error: `Category must be one of ${CATEGORIES.join(", ")}` };

  const unit = UNITS.includes(body.unit) ? body.unit : "per_unit";
  const bays = body.bays === "" || body.bays == null ? null : Number(body.bays);
  const capacityTb = body.capacityTb === "" || body.capacityTb == null ? null : Number(body.capacityTb);

  if(bays != null && !(bays >= 1)) return { error: "Bays must be a positive number" };
  if(capacityTb != null && !(capacityTb > 0)) return { error: "Capacity must be a positive number" };
  if(category === "NAS" && bays == null) return { error: "A NAS needs a bay count — it decides which chassis tier it competes in" };
  if((category === "HDD" || category === "SSD") && capacityTb == null) return { error: "A drive needs a capacity" };

  if(body.price){
    const problem = validatePrice(body.price);
    if(problem) return { error: problem };
  }

  return {
    sku, name, category, unit, bays, capacityTb,
    brand: String(body.brand ?? "").trim(),
    spec: String(body.spec ?? "").trim(),
    raid: Array.isArray(body.raid) ? body.raid : [],
    expandable: !!body.expandable,
    network: String(body.network ?? "").trim(),
    networkUpgrade: String(body.networkUpgrade ?? "").trim(),
    active: body.active == null ? true : !!body.active,
    sortOrder: Number(body.sortOrder) || 0,
    price: body.price || null
  };
}

function validatePrice(price = {}){
  const base = Number(price.base);
  const quote = price.quote === "" || price.quote == null ? base : Number(price.quote);
  if(!Number.isFinite(base) || base < 0) return "Base price (ex-GST) must be a number";
  if(!Number.isFinite(quote) || quote < 0) return "Quote price must be a number";
  if(price.effectiveFrom && !/^\d{4}-\d{2}-\d{2}/.test(String(price.effectiveFrom))){
    return "Effective date must look like 2026-09-10";
  }
  return null;
}
