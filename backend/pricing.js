/* Turns the products + prices tables into the payload the configurator reads.
 *
 * The configurator's shape (models / hddPricing / install / amcRate) is kept as
 * the public contract so the front end didn't have to change when the Google
 * Sheet was replaced by this database.
 */

import { db, bool, parseJson, todayIso } from "./db.js";

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
export async function productsWithPrice({ asOf = todayIso(), activeOnly = false } = {}){
  const where = activeOnly ? " WHERE p.active = 1" : "";
  const rows = await db().all(`${CURRENT_PRICE}${where} ORDER BY p.category, p.sort_order, p.name`, [asOf]);
  const gst = await gstRate();
  return rows.map(r => shape(r, gst));
}

export async function productWithPrice(id, asOf = todayIso()){
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

/**
 * The payload served at /api/pricing (and, with the minimum stripped,
 * /api/pricing/public) and consumed by src/pricing.js.
 *
 * `includeMin` decides whether the negotiating floor leaves this function at
 * all — a customer-facing surface needs the number to never exist in the
 * response, not just be hidden by the page that renders it. Everything else
 * about the shape is identical between the two, by design: the customer view
 * is meant to be the same tool minus one number, not a different tool.
 */
export async function buildPricingPayload({ asOf, includeMin = true } = {}){
  const products = (await productsWithPrice({ asOf, activeOnly: true })).filter(p => p.price);
  const warnings = [];
  const price = (quote, min) => includeMin ? { quote, min } : { quote };

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
      ...(includeMin ? { minTax: p.price.min } : {}),
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
    (hddPricing[p.capacityTb] ||= {})[line] = price(p.price.quote, p.price.min);
  }

  const capacities = Object.keys(hddPricing).map(Number).sort((a,b) => a - b);

  /* RAM and NIC are optional per-unit hardware add-ons: no per-model compatibility
     data exists (which RAM fits which slot, which card fits which PCIe form
     factor), so every priced product in these categories is offered as a plain
     choice and the rep/admin judges fit. The configurator parses the NIC's speed
     straight out of its name/spec (the same "10GbE" pattern used for a NAS's own
     ports), so naming a card "10GbE PCIe Network Card" is what makes it show up
     as unlocking that speed — no extra field to fill in. */
  const upgrades = products
    .filter(p => p.category === "RAM" || p.category === "NIC")
    .map(p => ({
      sku: p.sku, category: p.category, name: p.name, brand: p.brand, spec: p.spec,
      ...price(p.price.quote, p.price.min)
    }));

  // Services are matched by SKU so the admin can rename them freely.
  const installService = findService(products, "INSTALL");
  const install = installService ? price(installService.quote, installService.min) : price(0, 0);
  const amc = findService(products, "AMC");
  const amcRate = amc
    // A percentage may be entered either as 10 or as 0.10.
    ? price(asFraction(amc.quote), asFraction(amc.min))
    : price(0.10, 0.07);
  const gst = await gstRate();

  if(!models.length) warnings.push("No priced NAS units — nothing can be quoted.");
  if(!capacities.length) warnings.push("No priced drives — nothing can be quoted.");
  if(!installService) warnings.push("No installation price set; installation will quote as zero.");

  return {
    updatedAt: await lastPriceChange(),
    source: "DigiBuggy pricing database",
    gstRate: gst,
    models, capacities, hddPricing,
    install, amcRate, upgrades,
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
