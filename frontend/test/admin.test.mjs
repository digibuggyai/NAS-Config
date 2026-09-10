/* Boots the real admin page against a stubbed API and drives the parts a person
 * touches: the cascading category filter, and the product editor's fields. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("admin/index.html", root), "utf8");

const PRODUCTS = [
  { id:1, sku:"DS425+", category:"NAS", name:"DS425+", brand:"Synology", spec:"", bays:4,
    capacityTb:null, raid:["RAID5"], expandable:false, network:"2.5GbE ×1 + 1GbE ×1",
    networkUpgrade:"", unit:"per_unit", active:true, sortOrder:0,
    price:{ base:54000, quote:67000, min:63720, effectiveFrom:"2026-09-10" } },
  { id:2, sku:"DS925+", category:"NAS", name:"DS925+", brand:"Synology", spec:"", bays:4,
    capacityTb:null, raid:["RAID5"], expandable:true, network:"2.5GbE ×2",
    networkUpgrade:"", unit:"per_unit", active:true, sortOrder:1,
    price:{ base:78500, quote:97000, min:92630, effectiveFrom:"2026-09-10" } },
  { id:3, sku:"TS-433-4G", category:"NAS", name:"TS-433-4G", brand:"QNAP", spec:"", bays:4,
    capacityTb:null, raid:["RAID5"], expandable:false, network:"2.5GbE ×1 + 1GbE ×1",
    networkUpgrade:"", unit:"per_unit", active:true, sortOrder:2,
    price:{ base:36000, quote:45000, min:42480, effectiveFrom:"2026-09-10" } },
  { id:4, sku:"HDD-8TB-EXOS", category:"HDD", name:"Exos", brand:"Seagate", spec:"8 TB",
    bays:null, capacityTb:8, raid:[], expandable:false, network:"", networkUpgrade:"",
    unit:"per_drive", active:true, sortOrder:0,
    price:{ base:36500, quote:45000, min:43070, effectiveFrom:"2026-09-10" } },
  { id:5, sku:"HDD-4TB-IRONWOLF", category:"HDD", name:"IronWolf", brand:"Seagate", spec:"4 TB",
    bays:null, capacityTb:4, raid:[], expandable:false, network:"", networkUpgrade:"",
    unit:"per_drive", active:true, sortOrder:1,
    price:{ base:17800, quote:22000, min:21004, effectiveFrom:"2026-09-10" } },
  { id:6, sku:"HDD-6TB-WD", category:"HDD", name:"WD Ultrastar", brand:"Western Digital",
    spec:"6 TB", bays:null, capacityTb:6, raid:[], expandable:false, network:"",
    networkUpgrade:"", unit:"per_drive", active:true, sortOrder:2,
    price:{ base:28000, quote:35000, min:33040, effectiveFrom:"2026-09-10" } },
  { id:7, sku:"INSTALL", category:"SERVICE", name:"On-site installation", brand:"", spec:"",
    bays:null, capacityTb:null, raid:[], expandable:false, network:"", networkUpgrade:"",
    unit:"per_unit", active:true, sortOrder:0,
    price:{ base:3500, quote:5900, min:4130, effectiveFrom:"2026-09-10" } }
];

let win, $, fire;

test.before(async () => {
  const dom = new JSDOM(html, { url:"http://localhost/admin/", pretendToBeVisual:true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;

  const json = data => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(data)
  });
  global.fetch = (url) => {
    const path = String(url);
    if(path.includes("/auth/me"))  return json({ user:{ id:1, email:"a@b.c", name:"Admin", role:"admin" }});
    if(path.includes("/products")) return json({ products: PRODUCTS });
    if(path.includes("/quotes"))   return json({ quotes: [] });
    if(path.includes("/users"))    return json({ users: [] });
    if(path.includes("/pricing"))  return json({ gstRate: 0.18 });
    return json({});
  };

  await import(new URL("admin/admin.js", root).href);
  await new Promise(r => setTimeout(r, 50));   // let the boot fetches settle

  win = dom.window;
  $ = id => win.document.getElementById(id);
  fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles:true }));
});

const text = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
const items = sel => [...win.document.querySelectorAll(sel)];

/* ---------------- the cascading filter ---------------- */

test("the filter opens on click and lists only categories in the catalogue", () => {
  assert.equal($("categoryMenu").hidden, true, "closed to begin with");
  $("categoryTrigger").click();
  assert.equal($("categoryMenu").hidden, false);

  const cats = items("#categoryMenu > .menu-row > .menu-item").map(b => b.dataset.cat);
  assert.deepEqual(cats, ["NAS","HDD","SERVICE"]);
  assert.ok(!cats.includes("RAM"), "an empty category isn't offered");
});

test("hovering a category opens its lines", () => {
  const row = win.document.querySelector('.menu-row[data-row="NAS"]');
  assert.equal(row.querySelector(".submenu").hidden, true);

  fire(row, "mouseover");
  const sub = row.querySelector(".submenu");
  assert.equal(sub.hidden, false, "the flyout opens");
  assert.deepEqual(
    [...sub.querySelectorAll(".menu-item")].map(b => b.dataset.line),
    ["", "QNAP", "Synology"],
    "an 'all' entry plus each brand, alphabetically"
  );
});

test("a NAS lists brands; a drive lists drive families", () => {
  fire(win.document.querySelector('.menu-row[data-row="HDD"]'), "mouseover");
  const lines = items('.menu-row[data-row="HDD"] .submenu .menu-item').map(b => b.dataset.line);
  assert.deepEqual(lines, ["", "Exos", "IronWolf", "WD Ultrastar"]);
});

test("only one flyout is open at a time", () => {
  fire(win.document.querySelector('.menu-row[data-row="NAS"]'), "mouseover");
  const open = items("#categoryMenu .submenu:not([hidden])");
  assert.equal(open.length, 1);
  assert.equal(open[0].dataset.sub, "NAS");
});

test("each entry counts what it would show", () => {
  const nas = win.document.querySelector('.menu-row[data-row="NAS"] > .menu-item');
  assert.match(text(nas), /NAS ?3/, "three NAS units in the stub");

  fire(win.document.querySelector('.menu-row[data-row="NAS"]'), "mouseover");
  const synology = win.document.querySelector('.menu-row[data-row="NAS"] [data-line="Synology"]');
  assert.match(text(synology), /Synology ?2/);
});

test("picking a line filters the table and names the filter", () => {
  fire(win.document.querySelector('.menu-row[data-row="NAS"]'), "mouseover");
  win.document.querySelector('.menu-row[data-row="NAS"] [data-line="Synology"]').click();

  assert.equal($("categoryMenu").hidden, true, "the menu closes on choosing");
  assert.equal(text($("categoryLabel")), "NAS · Synology");

  const shown = items("#productRows tr:not(.cat-row) .name").map(text);
  assert.deepEqual(shown, ["DS425+","DS925+"]);
  assert.match(text($("productNote")), /2 products in NAS · Synology/);
});

test("picking the category itself drops the line filter", () => {
  $("categoryTrigger").click();
  win.document.querySelector('.menu-row[data-row="NAS"] > .menu-item').click();

  assert.equal(text($("categoryLabel")), "NAS");
  const shown = items("#productRows tr:not(.cat-row) .name").map(text);
  assert.deepEqual(shown, ["DS425+","DS925+","TS-433-4G"]);
});

test("All categories restores everything", () => {
  $("categoryTrigger").click();
  win.document.querySelector('#categoryMenu > .menu-item[data-cat=""]').click();

  assert.equal(text($("categoryLabel")), "All categories");
  assert.equal(items("#productRows tr:not(.cat-row)").length, PRODUCTS.length);
});

test("the filter combines with the search box", () => {
  $("categoryTrigger").click();
  fire(win.document.querySelector('.menu-row[data-row="NAS"]'), "mouseover");
  win.document.querySelector('.menu-row[data-row="NAS"] [data-line="Synology"]').click();

  $("productSearch").value = "925";
  fire($("productSearch"), "input");
  assert.deepEqual(items("#productRows tr:not(.cat-row) .name").map(text), ["DS925+"]);

  $("productSearch").value = "";
  fire($("productSearch"), "input");
});

test("clicking away closes the menu", () => {
  $("categoryTrigger").click();
  assert.equal($("categoryMenu").hidden, false);
  win.document.body.click();
  assert.equal($("categoryMenu").hidden, true);
});

/* ---------------- the product editor ---------------- */

test("the editor loads a product's fields, network included", () => {
  $("categoryTrigger").click();
  win.document.querySelector('#categoryMenu > .menu-item[data-cat=""]').click();

  win.document.querySelector('[data-edit="2"]').click();      // DS925+
  const f = $("productForm").elements;

  assert.equal(f.sku.value, "DS925+");
  assert.equal(f.bays.value, "4");
  assert.equal(f.network.value, "2.5GbE ×2");
  assert.equal(f.expandable.value, "1");
  assert.equal(f.priceBase.value, "78500");
  assert.equal(f.priceQuote.value, "97000");
});

test("the editor shows the minimum it will derive from the base", () => {
  const f = $("productForm").elements;
  f.priceBase.value = "100000";
  fire(f.priceBase, "input");

  // 100000 + 18% GST = 118000, worked out rather than typed
  assert.match(text($("computedMin")), /1,18,000/);
  assert.match(text($("computedMin")), /18% GST/);
});
