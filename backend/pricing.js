/* Turns the products + prices tables into the payload the configurator reads.
 *
 * The configurator's shape (models / hddPricing / install / amcRate) is kept as
 * the public contract so the front end didn't have to change when the Google
 * Sheet was replaced by this database.
 */

import { db, bool, parseJson } from "./db.js";

/* The quoted floor is the ex-GST base plus tax. Kept as a setting rather than a
 * constant so a GST change is an admin edit, not a deploy. */
export async function gstRate(){
  const row = await db().get("SELECT value FROM settings WHERE key = 'gst_rate'");
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.18;
}

/* The price in force is the newest row whose effective_from has already passed;
   future-dated rows sit in the table until their day comes. */
const CURRENT_PRICE = `
  SELECT p.*, pr.base_price, pr.quote_price, pr.effective_from
    FROM products p
    LEFT JOIN prices pr ON pr.id = (
      SELECT id FROM prices
       WHERE product_id = p.id AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC
       LIMIT 1
    )
`;

/** Every product with the price currently in force. `asOf` lets an old quote be
 *  re-priced at the numbers that applied on its date. */
export async function productsWithPrice({ asOf = new Date().toISOString().slice(0,10), activeOnly = false } = {}){
  const where = activeOnly ? " WHERE p.active = 1" : "";
  const rows = await db().all(`${CURRENT_PRICE}${where} ORDER BY p.category, p.sort_order, p.name`, [asOf]);
  const gst = await gstRate();
  return rows.map(r => shape(r, gst));
}

export async function productWithPrice(id, asOf = new Date().toISOString().slice(0,10)){
  const row = await db().get(`${CURRENT_PRICE} WHERE p.id = ?`, [asOf, id]);
  return row ? shape(row, await gstRate()) : null;
}

/** A percentage line (AMC) is not a rupee amount, so GST doesn't apply to it. */
export function minFor({ base, unit, gst }){
  return unit === "percent_of_hardware" ? base : round2(base * (1 + gst));
}

const round2 = n => Math.round(n * 100) / 100;

function shape(r, gst){
  return {
    id: r.id,
    sku: r.sku,
    category: r.category,
    name: r.name,
    brand: r.brand || "",
    spec: r.spec || "",
    bays: r.bays ?? null,
    capacityTb: r.capacity_tb ?? null,
    raid: parseJson(r.raid, []),
    expandable: bool(r.expandable),
    network: r.network || "",
    networkUpgrade: r.network_upgrade || "",
    unit: r.unit,
    active: bool(r.active),
    sortOrder: r.sort_order,
    price: r.quote_price == null ? null : {
      base: Number(r.base_price),
      quote: Number(r.quote_price),
      min: minFor({ base: Number(r.base_price), unit: r.unit, gst }),
      effectiveFrom: String(r.effective_from).slice(0, 10)
    }
  };
}

/** The payload served at /api/pricing and consumed by src/pricing.js. */
export async function buildPricingPayload({ asOf } = {}){
  const products = (await productsWithPrice({ asOf, activeOnly: true })).filter(p => p.price);
  const warnings = [];

  const models = products
    .filter(p => p.category === "NAS")
    .filter(p => {
      if(p.bays) return true;
      warnings.push(`"${p.name}" has no bay count and can't be sized — set it in the admin.`);
      return false;
    })
    .map(p => ({
      id: p.sku,
      brand: p.brand,
      bays: p.bays,
      quote: p.price.quote,
      minTax: p.price.min,
      raid: p.raid.length ? p.raid : (p.bays <= 2 ? ["RAID0","RAID1"] : ["RAID0","RAID1","RAID5","RAID6","RAID10"]),
      expandable: p.expandable,
      network: p.network,
      networkUpgrade: p.networkUpgrade
    }));

  const hddPricing = {};
  for(const p of products){
    if(p.category !== "HDD" && p.category !== "SSD") continue;
    if(!p.capacityTb){
      warnings.push(`"${p.name}" has no capacity and can't be offered — set it in the admin.`);
      continue;
    }
    const line = p.name || p.brand || p.sku;
    (hddPricing[p.capacityTb] ||= {})[line] = { quote: p.price.quote, min: p.price.min };
  }

  const capacities = Object.keys(hddPricing).map(Number).sort((a,b) => a - b);

  // Services are matched by SKU so the admin can rename them freely.
  const install = findService(products, "INSTALL") ?? { quote: 0, min: 0 };
  const amc = findService(products, "AMC");
  const amcRate = amc
    // A percentage may be entered either as 10 or as 0.10.
    ? { quote: asFraction(amc.quote), min: asFraction(amc.min) }
    : { quote: 0.10, min: 0.07 };
  const gst = await gstRate();

  if(!models.length) warnings.push("No priced NAS units — nothing can be quoted.");
  if(!capacities.length) warnings.push("No priced drives — nothing can be quoted.");
  if(!findService(products, "INSTALL")) warnings.push("No installation price set; installation will quote as zero.");

  return {
    updatedAt: await lastPriceChange(),
    source: "DigiBuggy pricing database",
    gstRate: gst,
    models, capacities, hddPricing,
    install, amcRate,
    warnings
  };
}

function findService(products, sku){
  const p = products.find(x => x.sku === sku);
  return p ? { quote: p.price.quote, min: p.price.min } : null;
}

const asFraction = n => (n > 1 ? n / 100 : n);

async function lastPriceChange(){
  const row = await db().get("SELECT MAX(created_at) AS at FROM prices");
  return row?.at || null;
}
