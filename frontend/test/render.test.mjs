/* Smoke test for the configurator: boots index.html in jsdom with the real
 * app.js and drives the page the way a rep would — storage, brand, RAID,
 * expandability, then the unit the tool suggests from all of it. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

let win;
test.before(async () => {
  // a real http origin, so localStorage works the way it does in a browser
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.fetch = () => Promise.reject(new Error("offline in tests"));
  global.setInterval = () => 0;            // don't leave the auto-refresh poll running

  const mod = await import(new URL("src/app.js", root).href);
  await mod.__ready;
  win = dom.window;
});

const $ = id => win.document.getElementById(id);
const text = id => $(id).textContent;
const pick = (sec, sel) => $(sec).querySelector(sel);
const all  = (sec, sel) => [...$(sec).querySelectorAll(sel)];
const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles:true }));
const choose = (sec, sel) => { const el = pick(sec, sel); el.checked = true; fire(el, "change"); return el; };

/* ---------------- shape ---------------- */

test("the sections run in the order the sales conversation does", () => {
  const ids = [...win.document.querySelectorAll(".sections .card > div[id]")].map(d => d.id);
  assert.deepEqual(ids, [
    "secStorage","secBrand","secBays","secRaid","secExpand",
    "secModel","secSpeed","secDrives","secAddons","secDetails"
  ]);
});

/* ---------------- 1. storage ---------------- */

test("storage is a list of capacities that can actually be built", () => {
  const sel = pick("secStorage", "#storageSelect");
  assert.ok(sel, "a picker, not a free-typed figure");

  const sizes = all("secStorage", "#storageSelect option").map(o => Number(o.value));
  assert.ok(sizes.length > 10, "a real range is offered");
  assert.deepEqual(sizes, [...sizes].sort((a,b) => a-b), "in order");
  assert.equal(new Set(sizes).size, sizes.length, "no duplicates");

  // no free-text entry survives, so an unbuildable figure can't be typed at all
  assert.equal(pick("secStorage", "#storageInput"), null);
  assert.equal(pick("secStorage", "#storageRange"), null);
});

test("every offered size is one whole drives can produce", () => {
  // at RAID 5 with the priced capacities, 2 TB is impossible: the smallest
  // parity array is 3 drives, and the smallest drive is 2 TB, giving 4 TB
  const values = all("secStorage", "#storageSelect option").map(o => Number(o.value));
  assert.ok(!values.includes(2), "2 TB can't be built at RAID 5");
  assert.ok(values.includes(4), "4 TB can: 3 x 2 TB");
  assert.ok(values.includes(20), "20 TB can: 3 x 10 TB");
});

test("the picker says what the chosen size is made of", () => {
  assert.match($("secStorage").textContent, /can be built at RAID5/);
  assert.match($("secStorage").textContent, /20 TB = \d+× \d+ TB at RAID5/);
});

test("changing RAID re-offers the sizes that level can produce", () => {
  const before = all("secStorage", "#storageSelect option").map(o => o.value);
  choose("secRaid", 'input[name="raid"][value="RAID10"]');
  const after = all("secStorage", "#storageSelect option").map(o => o.value);

  assert.notDeepEqual(after, before, "RAID 10 builds different capacities");
  assert.ok(!after.includes("10"), "10 TB isn't a RAID 10 capacity here");

  choose("secRaid", 'input[name="raid"][value="RAID5"]');
});

test("a size that stops being buildable moves to the nearest that is, and says so", () => {
  const sel = pick("secStorage", "#storageSelect");
  sel.value = "14";                       // 14 TB exists at RAID 5 (3 x 7? no — 8+6)
  fire(sel, "change");
  assert.equal(pick("secStorage", "#storageSelect").value, "14");

  // RAID 10 can't make 14 TB from these drives, so the tool moves and explains
  choose("secRaid", 'input[name="raid"][value="RAID10"]');
  const moved = Number(pick("secStorage", "#storageSelect").value);
  assert.notEqual(moved, 14);
  assert.match($("secStorage").textContent, /can't be built with these choices/);
  assert.match($("secStorage").textContent, /moved to/);

  choose("secRaid", 'input[name="raid"][value="RAID5"]');
  const back = pick("secStorage", "#storageSelect");
  back.value = "20";
  fire(back, "change");
});

/* ---------------- 2-4. the inputs the suggestion reads ---------------- */

test("brand can be left open or pinned to one make", () => {
  const brands = all("secBrand", 'input[name="brand"]').map(i => i.value);
  assert.ok(brands.includes("any"));
  assert.ok(brands.includes("Synology"));
  assert.ok(brands.includes("QNAP"));
  assert.equal(pick("secBrand", 'input[name="brand"]:checked').value, "any");
});

test("bays can be left to the tool or pinned to a size it stocks", () => {
  const tiles = all("secBays", 'input[name="bays"]');
  assert.deepEqual(tiles.map(t => t.value), ["", "2", "4", "5", "6", "8"]);
  assert.equal(pick("secBays", 'input[name="bays"]:checked').value, "", "Auto by default");
  // each size says what it would actually hold, so the choice is about capacity
  assert.match($("secBays").textContent, /TB/);
});

test("pinning a bay count re-recommends the drives that suit it", () => {
  choose("secBays", 'input[name="bays"][value="4"]');
  const four = $("secModel").querySelector(".model-card.selected .model-meta").textContent;
  assert.match(four, /in 4 bays/);

  choose("secBays", 'input[name="bays"][value="6"]');
  const six = $("secModel").querySelector(".model-card.selected .model-meta").textContent;
  assert.match(six, /in 6 bays/);
  assert.notEqual(six.replace(/\s+/g," "), four.replace(/\s+/g," "),
    "a different chassis gets a different drive combination");

  choose("secBays", 'input[name="bays"][value=""]');
});

test("a bay count nothing can satisfy says so instead of quoting", () => {
  // 2-bay chassis only do RAID 0/1, so RAID 5 at 2 bays is impossible
  choose("secBays", 'input[name="bays"][value="2"]');
  assert.match($("secBays").textContent, /No 2-bay unit can do this/);
  assert.equal(text("grandMax"), "—");
  assert.equal($("generatePdf").disabled, true);

  choose("secBays", 'input[name="bays"][value=""]');
  assert.match(text("grandMax"), /^₹[\d,]+$/);
});

test("RAID offers all five levels and defaults to 5", () => {
  assert.equal(all("secRaid", 'input[name="raid"]').length, 5);
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID5");
});

test("expandability is a single optional tick", () => {
  const box = pick("secExpand", 'input[name="expandable"]');
  assert.ok(box);
  assert.equal(box.checked, false);
});

/* ---------------- 5. the suggestion ---------------- */

test("a unit is suggested automatically and marked as the recommendation", () => {
  const cards = all("secModel", 'input[name="modelId"]');
  assert.ok(cards.length > 0);
  assert.ok(pick("secModel", ".model-card.selected"), "one is chosen for the rep");
  assert.match($("secModel").textContent, /Recommended/);
  assert.match($("secModel").textContent, /TB usable/);
  assert.match($("secModel").textContent, /spare bay/);
  assert.match(text("grandMax"), /^₹[\d,]+$/);
});

test("pinning a brand restricts what is suggested", () => {
  choose("secBrand", 'input[name="brand"][value="Synology"]');
  const names = all("secModel", 'input[name="modelId"]').map(i => i.value);
  assert.ok(names.length > 0);
  assert.ok(names.every(n => /^DS|^RS/.test(n)), `only Synology, got ${names.join(",")}`);

  choose("secBrand", 'input[name="brand"][value="any"]');
});

test("asking for expansion room narrows to the four units that take one", () => {
  choose("secExpand", 'input[name="expandable"]');
  const names = all("secModel", 'input[name="modelId"]').map(i => i.value);
  assert.ok(names.length > 0);
  for(const n of names){
    assert.ok(["DS725+","DS925+","DS1525+","DS1825+"].includes(n),
      `${n} is not expandable per the price sheet`);
  }
  // DS425+ is not expandable, whatever the "+" in its name suggests
  assert.ok(!names.includes("DS425+"));

  const box = pick("secExpand", 'input[name="expandable"]');
  box.checked = false;
  fire(box, "change");
});

test("choosing a different unit sticks, and can be handed back to the tool", () => {
  const cards = all("secModel", 'input[name="modelId"]');
  if(cards.length < 2) return;

  const before = text("grandMax");
  cards[1].checked = true;
  fire(cards[1], "change");
  assert.notEqual(text("grandMax"), before);
  assert.match($("secModel").textContent, /Chosen by you/);

  $("secModel").querySelector("#resetPick").click();
  assert.match($("secModel").textContent, /Recommended for/);
});

/* ---------------- 6. network speed ---------------- */

test("network speed reports what the chosen unit actually ships with", () => {
  // The offline snapshot carries no port data, so the section must say so
  // rather than invent a figure; against the live API it names the ports.
  const warn = pick("secSpeed", ".field-warn");
  const prompt = pick("secSpeed", ".select-prompt");
  assert.ok(warn || prompt, "it says something about the chosen unit");
  if(warn) assert.match(warn.textContent, /No network ports recorded/);
  assert.ok(all("secSpeed", 'input[name="speed"]').length >= 3, "a speed can still be quoted");
});

/* ---------------- 7. drives ---------------- */

test("drives default to automatic and can be pinned", () => {
  assert.equal(pick("secDrives", 'input[name="driveCap"]:checked').value, "");
  assert.equal(pick("secDrives", 'input[name="driveLine"]:checked').value, "");

  choose("secDrives", 'input[name="driveCap"][value="16"]');
  assert.match(text("quoteSummary"), /16TB/);

  // the suggestion re-runs within that constraint
  assert.ok(all("secModel", 'input[name="modelId"]').length > 0);

  choose("secDrives", 'input[name="driveCap"][value=""]');
});

/* ---------------- 8-9. the rest ---------------- */

test("add-ons move the total", () => {
  const rows = () => all("priceTableBody", "tr").map(r => r.textContent);
  assert.ok(rows().some(r => /Installation/.test(r)));

  const before = text("grandMax");
  choose("secAddons", 'input[name="includeAMC"]');
  assert.ok(rows().some(r => /AMC/.test(r)));
  assert.notEqual(text("grandMax"), before);
});

test("customer details re-price without redrawing the inputs", () => {
  const name = pick("secDetails", 'input[name="custName"]');
  name.value = "Aarav Enterprises";
  fire(name, "input");
  assert.equal(pick("secDetails", 'input[name="custName"]'), name);
  assert.equal(name.value, "Aarav Enterprises");
});

test("quote validity keeps its highlight", () => {
  const thirty = all("secDetails", 'input[name="validity"]').find(t => t.value === "30 days");
  thirty.checked = true;
  fire(thirty, "change");
  assert.ok(thirty.closest(".tile").classList.contains("selected"));
  assert.match(text("quoteSummary"), /30 days/);
});

/* ---------------- panel ---------------- */

test("the quotation panel leads with the unit being sold", () => {
  const model = pick("quoteSummary", ".qs-model");
  const brand = pick("quoteSummary", ".qs-brand");
  assert.ok(model, "the model headlines the panel");
  assert.match(model.textContent, /\S/);
  assert.match(brand.textContent, /-bay/, "with its make and chassis size");

  // and it comes before every detail row
  const first = $("quoteSummary").firstElementChild;
  assert.ok(first.classList.contains("qs-headline"));
});

test("the panel then covers what is delivered, then what was asked for", () => {
  const labels = all("quoteSummary", ".qs-row .k").map(k => k.textContent);
  assert.deepEqual(labels, [
    "Drives","Usable delivered","Network",
    "RAID","Target usable","Brand asked for","Bays asked for","Expandable","Valid for"
  ]);
});

test("the admin button is present and points at the admin", () => {
  assert.equal($("adminLink").getAttribute("href"), "/admin/");
});

test("the mobile quote sheet opens and closes", () => {
  $("openQuote").click();
  assert.ok($("quotePanel").classList.contains("open"));
  $("closeQuote").click();
  assert.equal($("quotePanel").classList.contains("open"), false);
});
