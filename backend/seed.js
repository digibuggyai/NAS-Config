/* Seeds the catalogue and an opening admin account.
 *
 *   npm run seed
 *
 * Safe to re-run: products are matched on SKU and updated rather than
 * duplicated, and a price is only written when it differs from the one already
 * in force — so re-seeding never pollutes the price history.
 *
 * Source: the DigiBuggy price list as supplied on 10 Sep 2026. `base` is the
 * ex-GST figure; the quoted minimum is derived as base x 1.18 at read time.
 */

import { loadEnv } from "./env.js";
import { initDb, db, closeDb, nowIso, todayIso } from "./db.js";
import { hashPassword } from "./auth.js";

const EFFECTIVE_FROM = "2026-09-10";

/* How later changes are labelled in the price history. Override per run:
 *   UPDATE_NOTE="Distributor list 1 Oct" npm run seed */
const UPDATE_NOTE = process.env.UPDATE_NOTE || "price sheet update";

/* Set at the start of each run: whether the catalogue was empty before it. */
const seeding = { firstRun: false };

/* ---------------- NAS units ---------------- */
/* [sku, brand, bays, base (ex-GST), quote (asking, incl. GST), expandable]
   Expandability is column F of the price sheet: only these four take an
   expansion unit, whatever the product line might suggest. */
const NAS = [
  ["DS223J",      "Synology", 2,  19000,  24000, false],
  ["DS225+",      "Synology", 2,  34000,  42000, false],
  ["DS725+",      "Synology", 2,  76000,  94000, true ],
  ["TS-233-2G",   "QNAP",     2,  19000,  24000, false],
  ["TS-216G-4G",  "QNAP",     2,  23500,  29000, false],

  ["DS425+",      "Synology", 4,  54000,  67000, false],
  ["DS925+",      "Synology", 4,  78500,  97000, true ],
  ["TS-433-4G",   "QNAP",     4,  36000,  45000, false],
  ["TS-462-4G",   "QNAP",     4,  46000,  57000, false],
  ["TS-464-8G",   "QNAP",     4,  56000,  69000, false],

  ["DS1525+",     "Synology", 5, 115000, 142000, true ],   // 5-bay, not 8

  ["TS-664-8G",   "QNAP",     6,  70000,  87000, false],

  ["DS1825+",     "Synology", 8, 145000, 180000, true ],
  ["TS-832PX-4G", "QNAP",     8,  87500, 108000, false],
  ["TS-873A-8G",  "QNAP",     8, 105000, 130000, false]
];

/* Network ports, from the manufacturers' own specification pages (Sep 2026).
 * `builtIn` is what ships in the box — the speed the configurator quotes.
 * `upgrade` is what an add-in card or module can reach, quoted as a note only,
 * because the card is not in this price list. */
const NETWORK = {
  // Synology — synology.com/en-global/products/<model>#specs
  "DS223J":      { builtIn:"1GbE ×1" },
  "DS225+":      { builtIn:"2.5GbE ×1 + 1GbE ×1" },
  "DS725+":      { builtIn:"2.5GbE ×1 + 1GbE ×1" },
  "DS425+":      { builtIn:"2.5GbE ×1 + 1GbE ×1" },
  "DS925+":      { builtIn:"2.5GbE ×2" },
  "DS1525+":     { builtIn:"2.5GbE ×2", upgrade:"10GbE via E10G22-T1-Mini module" },
  "DS1825+":     { builtIn:"2.5GbE ×2", upgrade:"up to 25GbE via PCIe add-in card" },

  // QNAP — qnap.com product pages
  "TS-233-2G":   { builtIn:"1GbE ×1" },
  "TS-216G-4G":  { builtIn:"2.5GbE ×1 + 1GbE ×1" },
  "TS-433-4G":   { builtIn:"2.5GbE ×1 + 1GbE ×1" },
  "TS-462-4G":   { builtIn:"2.5GbE ×1", upgrade:"10GbE via PCIe card" },
  "TS-464-8G":   { builtIn:"2.5GbE ×2", upgrade:"10GbE via PCIe card" },
  "TS-664-8G":   { builtIn:"2.5GbE ×2", upgrade:"10GbE via PCIe card" },
  "TS-832PX-4G": { builtIn:"10GbE SFP+ ×2 + 2.5GbE ×2" },
  "TS-873A-8G":  { builtIn:"2.5GbE ×2", upgrade:"5GbE/10GbE via PCIe Gen3 card" }
};

const RAID_2BAY = ["RAID0","RAID1"];
const RAID_MULTI = ["RAID0","RAID1","RAID5","RAID6","RAID10"];

/* ---------------- drives ---------------- */
/* [capacity TB, line, base (ex-GST), quote (asking, incl. GST)] */
const DRIVES = [
  [2,  "Exos",         17000, 21000],
  [2,  "IronWolf",     15300, 19000],
  [4,  "Exos",         21800, 27010.2],   // added 15 Sep 2026
  [4,  "IronWolf",     17800, 22000],
  [6,  "WD Ultrastar", 24000, 35000],     // base 28000 -> 24000, 15 Sep 2026
  [8,  "Exos",         36500, 45000],
  [10, "Exos",         42000, 52000],
  [10, "IronWolf",     40000, 50000],
  [10, "WD Ultrastar", 40500, 50000],
  [12, "Exos",         55000, 68000],
  [12, "WD Ultrastar", 53000, 65000],
  [16, "Exos",         66500, 82000],
  [16, "WD Ultrastar", 67000, 82000]      // base 66000 -> 67000, 15 Sep 2026
];

const DRIVE_BRAND = { "Exos":"Seagate", "IronWolf":"Seagate", "WD Ultrastar":"Western Digital" };

/* ---------------- services ---------------- */
/* AMC is a percentage, so GST doesn't apply: base is the floor %, quote the asking %. */
const SERVICES = [
  { sku:"INSTALL", name:"On-site installation & setup", unit:"per_unit",
    spec:"Racking, RAID configuration, network setup", base:3500, quote:5900 },
  { sku:"AMC", name:"AMC — annual maintenance cost", unit:"percent_of_hardware",
    spec:"Percentage of the hardware subtotal", base:7, quote:10 }
];

export async function seed({ adminEmail, adminPassword, quiet = false } = {}){
  const log = (...a) => { if(!quiet) console.log(...a); };
  let added = 0, updated = 0, repriced = 0;
  seeding.firstRun = Number((await db().get("SELECT COUNT(*) AS n FROM products")).n) === 0;

  await setSetting("gst_rate", "0.18");
  await setSetting("company_name", "DigiBuggy (DGB India)");

  for(const [i, [sku, brand, bays, base, quote, expandable]] of NAS.entries()){
    const r = await upsert({
      sku, category:"NAS", name:sku, brand,
      spec:`${bays}-bay desktop NAS`,
      bays, capacityTb:null,
      raid: bays <= 2 ? RAID_2BAY : RAID_MULTI,
      expandable, unit:"per_unit", sortOrder:i,
      network: NETWORK[sku]?.builtIn ?? "",
      networkUpgrade: NETWORK[sku]?.upgrade ?? ""
    }, { base, quote });
    added += r.added; updated += r.updated; repriced += r.repriced;
  }

  for(const [i, [cap, line, base, quote]] of DRIVES.entries()){
    const r = await upsert({
      sku: `HDD-${cap}TB-${line.replace(/\s+/g,"").toUpperCase()}`,
      category:"HDD", name:line, brand: DRIVE_BRAND[line] || "",
      spec:`${cap} TB NAS drive`,
      bays:null, capacityTb:cap, raid:[], expandable:false,
      unit:"per_drive", sortOrder: i, network:"", networkUpgrade:""
    }, { base, quote });
    added += r.added; updated += r.updated; repriced += r.repriced;
  }

  for(const [i, s] of SERVICES.entries()){
    const r = await upsert({
      sku:s.sku, category:"SERVICE", name:s.name, brand:"", spec:s.spec,
      bays:null, capacityTb:null, raid:[], expandable:false,
      unit:s.unit, sortOrder:i, network:"", networkUpgrade:""
    }, { base:s.base, quote:s.quote });
    added += r.added; updated += r.updated; repriced += r.repriced;
  }

  log(`Catalogue: ${added} added, ${updated} updated, ${repriced} price change(s) recorded.`);

  if(adminEmail && adminPassword){
    const existing = await db().get("SELECT id FROM users WHERE email = ?", [adminEmail.toLowerCase()]);
    if(existing){
      log(`Admin ${adminEmail} already exists — left alone.`);
    } else {
      await db().run(
        "INSERT INTO users (email, name, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)",
        [adminEmail.toLowerCase(), "Administrator", await hashPassword(adminPassword), "admin", nowIso()]
      );
      log(`Admin account created: ${adminEmail}`);
    }
  }

  return { added, updated, repriced };
}

async function upsert(p, price){
  const existing = await db().get("SELECT * FROM products WHERE sku = ?", [p.sku]);
  let id, added = 0, updated = 0;

  if(existing){
    id = existing.id;
    updated = 1;
    await db().run(
      `UPDATE products SET category=?, name=?, brand=?, spec=?, bays=?, capacity_tb=?, raid=?,
              expandable=?, network=?, network_upgrade=?, unit=?, sort_order=?, updated_at=? WHERE id=?`,
      [p.category, p.name, p.brand, p.spec, p.bays, p.capacityTb, JSON.stringify(p.raid),
       p.expandable ? 1 : 0, p.network, p.networkUpgrade, p.unit, p.sortOrder, nowIso(), id]
    );
  } else {
    added = 1;
    ({ lastId: id } = await db().run(
      `INSERT INTO products (sku, category, name, brand, spec, bays, capacity_tb, raid,
                             expandable, network, network_upgrade, unit, active, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      [p.sku, p.category, p.name, p.brand, p.spec, p.bays, p.capacityTb, JSON.stringify(p.raid),
       p.expandable ? 1 : 0, p.network, p.networkUpgrade, p.unit, p.sortOrder, nowIso(), nowIso()]
    ));
  }

  // Only write a price row when something actually changed, so re-running the
  // seed doesn't fill the history with identical entries.
  //
  // Compared against the price IN FORCE, not the newest row: a price scheduled
  // for next month must not make the seed think today's price has changed and
  // write a row that supersedes it.
  const current = await db().get(
    `SELECT base_price, quote_price FROM prices
      WHERE product_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [id, todayIso()]
  );
  let repriced = 0;
  if(!current || Number(current.base_price) !== price.base || Number(current.quote_price) !== price.quote){
    // Only a catalogue seeded from nothing gets the opening date. A product added
    // or repriced later is dated the day it happened, so history reads true.
    const opening = !current && seeding.firstRun;
    await db().run(
      `INSERT INTO prices (product_id, base_price, quote_price, effective_from, note, created_by, created_at)
       VALUES (?,?,?,?,?,NULL,?)`,
      [id, price.base, price.quote, opening ? EFFECTIVE_FROM : todayIso(),
       opening ? "Opening price list" : (current ? `Repriced: ${UPDATE_NOTE}` : `Added: ${UPDATE_NOTE}`),
       nowIso()]
    );
    repriced = 1;
  }

  return { added, updated, repriced };
}

async function setSetting(key, value){
  const existing = await db().get("SELECT key FROM settings WHERE key = ?", [key]);
  if(existing) return;                                   // never clobber an edited setting
  await db().run("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)", [key, value, nowIso()]);
}

/* Run directly: node server/seed.js */
if(process.argv[1] && process.argv[1].endsWith("seed.js")){
  loadEnv();
  await initDb();
  await seed({
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD
  });
  await closeDb();
}
