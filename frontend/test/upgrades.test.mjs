/* RAM upgrades, network cards, and sizing by budget all depend on catalogue
 * data the offline FALLBACK snapshot doesn't carry (no admin ever priced them
 * there), so this file boots its own instance of the app against a fixture
 * payload that does — proving the whole chain from /api/pricing to the totals
 * actually works, not just that the empty state renders. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

/* Deliberately small: one drive line at one capacity, two NAS units, so the
 * suggestion arithmetic in each test is easy to verify by hand.
 *   TS-433-4G  QNAP  4-bay  ₹45,000  2.5GbE ×1 + 1GbE ×1
 *   DS1825+    Synology 8-bay ₹1,80,000  2.5GbE ×2   (too dear for the budget tests)
 *   10 TB IronWolf  ₹50,000 / ₹47,200 min
 */
const FIXTURE = {
  updatedAt: "2026-09-15",
  models: [
    { id:"TS-433-4G", brand:"QNAP", bays:4, quote:45000, minTax:42480,
      raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false,
      network:"2.5GbE ×1 + 1GbE ×1", networkUpgrade:"10GbE via PCIe card" },
    { id:"DS1825+", brand:"Synology", bays:8, quote:180000, minTax:171100,
      raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true,
      network:"2.5GbE ×2", networkUpgrade:"" }
  ],
  capacities: [10],
  hddPricing: { 10: { "IronWolf": { quote:50000, min:47200 } } },
  install: { quote:5900, min:4130 },
  amcRate: { quote:0.10, min:0.07 },
  upgrades: [
    { sku:"RAM-8GB", category:"RAM", name:"8GB DDR4 SODIMM", brand:"Crucial", spec:"", quote:4500, min:4200 },
    { sku:"NIC-10G", category:"NIC", name:"10GbE PCIe Network Card", brand:"QNAP", spec:"", quote:14000, min:13200 }
  ],
  warnings: []
};

let win;
test.before(async () => {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.setInterval = () => 0;
  // the endpoint is always configured, so loadPricing() takes this fetch branch
  // rather than falling through to the offline snapshot
  global.fetch = async () => ({ ok: true, json: async () => FIXTURE });

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
const rupees = n => Number(text(n).replace(/[^\d.]/g, ""));

test("the fixture actually loaded, not the offline fallback", () => {
  assert.match(text("dataSyncNote"), /Live prices/);
  assert.equal(all("secModel", 'input[name="modelId"]').length, 2);
});

/* ---------------- RAM & network card ---------------- */

test("RAM and NIC options from the catalogue are offered, defaulting to None", () => {
  assert.equal(pick("secUpgrades", 'input[name="ramSku"]:checked').value, "");
  assert.equal(pick("secUpgrades", 'input[name="nicSku"]:checked').value, "");
  assert.ok(pick("secUpgrades", 'input[name="ramSku"][value="RAM-8GB"]'));
  assert.ok(pick("secUpgrades", 'input[name="nicSku"][value="NIC-10G"]'));
});

test("adding RAM charges its price once per NAS unit", () => {
  const before = rupees("grandMax");
  choose("secUpgrades", 'input[name="ramSku"][value="RAM-8GB"]');

  assert.equal(rupees("grandMax"), before + 4500);   // one unit in this build
  assert.match(text("quoteSummary"), /RAM upgrade/);
  assert.match(text("quoteSummary"), /8GB DDR4 SODIMM/);
  const rows = all("priceTableBody", "tr").map(r => r.textContent);
  assert.ok(rows.some(r => /RAM upgrade/.test(r) && /8GB DDR4 SODIMM/.test(r)));

  choose("secUpgrades", 'input[name="ramSku"][value=""]');   // back to None
});

test("adding a network card changes the price — the reported bug", () => {
  const before = rupees("grandMax");
  choose("secUpgrades", 'input[name="nicSku"][value="NIC-10G"]');

  assert.equal(rupees("grandMax"), before + 14000);
  const rows = all("priceTableBody", "tr").map(r => r.textContent);
  assert.ok(rows.some(r => /Network card/.test(r) && /10GbE PCIe Network Card/.test(r)));
});

test("the added card unlocks the speed it actually provides", () => {
  // TS-433-4G ships with 2.5GbE; the 10GbE tile was a dead end before the card
  // existed as a purchasable line, and must say so differently now that it isn't.
  const ten = pick("secSpeed", 'input[name="speed"][value="10GbE"]').closest(".tile");
  assert.match(ten.querySelector(".tile-sub").textContent, /Supported with the network card added/);
  assert.match($("secSpeed").textContent, /Network card added.*10GbE PCIe Network Card/s);

  choose("secUpgrades", 'input[name="nicSku"][value=""]');   // back to None for later tests
});

/* ---------------- sizing by budget ---------------- */

test("switching to budget mode replaces the TB picker with an amount", () => {
  choose("secStorage", 'input[name="storageMode"][value="budget"]');
  assert.ok(pick("secStorage", "#budgetInput"));
  assert.equal(pick("secStorage", "#budgetInput").value, "200000");
  assert.equal(pick("secStorage", "#storageSelect"), null);
});

test("RAID is chosen automatically, preferring redundancy the budget can afford", () => {
  // At ₹2,00,000 with only 10 TB IronWolf priced: RAID 6 and RAID 10 both need 4
  // drives on this 4-bay chassis (₹2,45,000 — over budget). RAID 5 needs only 3
  // (₹1,95,000, 20 TB) and fits, so it wins — not RAID 0, which would fit more
  // drives for the same money but throws away fault tolerance to do it. DS1825+
  // costs more than the whole budget before a single drive is added.
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID5");
  assert.match($("secRaid").textContent, /Chosen automatically/);
  assert.match(text("quoteSummary"), /20 TB/);
  assert.equal(pick("secModel", 'input[name="modelId"]:checked')?.value, "TS-433-4G");
  assert.equal(rupees("grandMax"), 195000 + 5900);
});

test("budget presets set the amount and re-suggest — dropping to less redundancy only when it must", () => {
  const chip = pick("secStorage", '[data-budget-preset="150000"]');
  chip.click();
  assert.equal(pick("secStorage", "#budgetInput").value, "150000");

  // ₹1,50,000 can no longer afford RAID 5's 3 drives (₹1,95,000). RAID 1 needs
  // only its fixed pair (₹1,45,000) and still protects the data, so it's chosen
  // over RAID 0 — even though 2 RAID-0 drives would deliver more raw capacity
  // (20 TB) for about the same money.
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID1");
  assert.match(text("quoteSummary"), /10 TB/);
  assert.equal(rupees("grandMax"), 145000 + 5900);
});

test("picking a RAID level by hand overrides the automatic choice", () => {
  // Back to a budget where the automatic pick is RAID5/20TB, so the override
  // is a real, visible change rather than landing on the same answer.
  const input = pick("secStorage", "#budgetInput");
  input.value = "200000";
  fire(input, "input");
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID5");

  choose("secRaid", 'input[name="raid"][value="RAID0"]');
  assert.match($("secRaid").textContent, /Chosen by you/);
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID0");
  // RAID0 does fit more at this budget (3 drives, 30 TB) — the point of
  // overriding is that the rep can choose that trade-off deliberately.
  assert.match(text("quoteSummary"), /30 TB/);

  const reset = pick("secRaid", "#resetRaid");
  assert.ok(reset, "a way back to the automatic choice is offered");
  reset.click();
  assert.match($("secRaid").textContent, /Chosen automatically/);
  assert.equal(pick("secRaid", 'input[name="raid"]:checked').value, "RAID5");
});

test("a budget nothing can meet says so", () => {
  const input = pick("secStorage", "#budgetInput");
  input.value = "10000";
  fire(input, "input");

  // Not even RAID 0's cheapest single drive (₹95,000) fits ten thousand rupees.
  assert.match($("secStorage").textContent, /Nothing on the price list fits/);
  assert.equal(text("grandMax"), "—");
  assert.equal($("generatePdf").disabled, true);

  input.value = "200000";
  fire(input, "input");
});

test("switching back to capacity mode restores the TB picker", () => {
  choose("secStorage", 'input[name="storageMode"][value="capacity"]');
  assert.ok(pick("secStorage", "#storageSelect"));
  assert.equal(pick("secStorage", "#budgetInput"), null);
});
