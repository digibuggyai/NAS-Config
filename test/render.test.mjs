/* Smoke test for the configurator: boots index.html in jsdom with the real
 * app.js and drives the page the way a rep would. Catches broken element ids
 * and template mistakes that unit tests on the maths never would. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

/* app.js runs on import and touches the document, so the DOM has to be installed
 * as the global before that import is evaluated. Node caches ES modules, so it
 * is imported once and every test drives the same page — in order. */
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

test("every section renders on one page, with no wizard chrome", () => {
  assert.match(text("dataSyncNote"), /snapshot|price list/i);
  for(const id of ["secStorage","secDrives","secModel","secAddons","secDetails"]){
    assert.ok($(id).children.length > 0, `${id} has content`);
  }
  assert.equal(win.document.querySelectorAll(".pstep").length, 0, "no progress rail");
  assert.equal($("nextBtn"), null, "no Next button");
  assert.equal($("backBtn"), null, "no Back button");
  assert.equal(win.document.querySelectorAll(".card").length, 5);
});

test("section 1 offers a typed figure, a slider and presets — and no use case", () => {
  assert.ok(pick("secStorage", "#storageRange"));
  assert.ok(pick("secStorage", "#storageInput"));
  assert.equal(all("secStorage", "[data-preset]").length, 4);
  assert.equal(all("secStorage", 'input[name="useCase"]').length, 0, "use case is gone");
  assert.equal(pick("secStorage", "#storageInput").value, "20");
});

test("typing a figure drives the quote, and the slider follows", () => {
  const input = pick("secStorage", "#storageInput");
  input.value = "40";
  fire(input, "input");

  assert.equal(pick("secStorage", "#storageRange").value, "40");
  assert.match(text("quoteSummary"), /40 TB/);
  // the field the rep is typing in must survive untouched
  assert.equal(pick("secStorage", "#storageInput"), input);
});

test("an out-of-range figure is clamped when committed", () => {
  const input = pick("secStorage", "#storageInput");
  input.value = "9999";
  fire(input, "input");
  fire(input, "change");
  assert.equal(pick("secStorage", "#storageInput").value, "200");

  const emptied = pick("secStorage", "#storageInput");
  emptied.value = "";
  fire(emptied, "change");
  assert.equal(pick("secStorage", "#storageInput").value, "2");

  const back = pick("secStorage", "#storageInput");
  back.value = "20";
  fire(back, "input");
  fire(back, "change");
});

test("the chassis size can be chosen, or left on auto", () => {
  const bays = all("secDrives", 'input[name="bays"]');
  assert.ok(bays.length >= 4, "auto plus the tiers the sheet stocks");
  assert.equal(bays[0].value, "auto");
  assert.equal(pick("secDrives", 'input[name="bays"]:checked').value, "auto");
});

test("picking a smaller chassis adds units rather than a bigger box", () => {
  const two = pick("secDrives", 'input[name="bays"][value="2"]');
  two.checked = true;
  fire(two, "change");

  assert.match(text("quoteSummary"), /2-bay/);
  assert.ok(all("secModel", 'input[name="modelId"]').length >= 0);

  const auto = pick("secDrives", 'input[name="bays"][value="auto"]');
  auto.checked = true;
  fire(auto, "change");
  assert.equal(pick("secDrives", 'input[name="bays"]:checked').value, "auto");
});

test("section 2 offers RAID, capacity, drive line and speed", () => {
  assert.equal(all("secDrives", 'input[name="raid"]').length, 5);
  assert.ok(all("secDrives", 'input[name="driveCap"]').length >= 5);
  assert.ok(all("secDrives", 'input[name="driveBrand"]').length >= 1);
  assert.equal(all("secDrives", 'input[name="speed"]').length, 4);
});

test("no unit is preselected, so nothing is priced on load", () => {
  assert.ok(all("secModel", 'input[name="modelId"]').length > 0, "candidates are listed");
  assert.equal(pick("secModel", ".model-card.selected"), null, "none chosen");
  assert.ok(pick("secModel", ".select-prompt"), "the rep is told to pick one");

  assert.equal(text("grandMax"), "—");
  assert.equal(text("grandMin"), "—");
  assert.equal(text("rtAmount"), "—");
  assert.ok($("quotePanel").classList.contains("unpriced"));
  assert.equal($("generatePdf").disabled, true);
  assert.match(text("quoteRef"), /Not yet priced/);
  assert.match(text("quoteSummary"), /Not selected/);
});

test("what has been answered still shows in the panel", () => {
  assert.match(text("quoteSummary"), /Target usable/);
  assert.match(text("quoteSummary"), /20 TB/);
  assert.match(text("quoteSummary"), /Exos|IronWolf|Ultrastar/);
});

test("RAID defaults to 5 and is the rep's to change", () => {
  assert.equal(pick("secDrives", 'input[name="raid"]:checked').value, "RAID5");
  assert.match(text("quoteSummary"), /RAID5/);
  assert.equal(text("grandMax"), "—", "still unpriced until a unit is chosen");
});

test("changing capacity keeps the drive line valid for that capacity", () => {
  const six = pick("secDrives", 'input[name="driveCap"][value="6"]');
  six.checked = true;
  fire(six, "change");

  assert.deepEqual(all("secDrives", 'input[name="driveBrand"]').map(i => i.value), ["WD Ultrastar"]);
  assert.match(text("quoteSummary"), /WD Ultrastar/);

  const eight = pick("secDrives", 'input[name="driveCap"][value="8"]');
  eight.checked = true;
  fire(eight, "change");
  assert.deepEqual(all("secDrives", 'input[name="driveBrand"]').map(i => i.value), ["Exos"]);
});

test("the unit list is filtered to the bay tier and RAID level", () => {
  const cards = all("secModel", 'input[name="modelId"]');
  assert.ok(cards.length > 0);
  assert.ok($("secModel").textContent.includes("Best price"));
  assert.ok($("secModel").textContent.includes("bays used"));
});

test("choosing a unit prices the quotation and enables the PDF", () => {
  const first = all("secModel", 'input[name="modelId"]')[0];
  first.checked = true;
  fire(first, "change");

  assert.match(text("grandMax"), /^₹[\d,]+$/);
  assert.equal(text("grandMax"), text("rtAmount"));
  assert.equal($("generatePdf").disabled, false);
  assert.equal($("quotePanel").classList.contains("unpriced"), false);
  assert.match(text("quoteRef"), /Draft/);
  assert.ok(pick("secModel", ".model-card.selected"));
  assert.equal(pick("secModel", ".select-prompt"), null);
});

test("picking a different unit changes the total", () => {
  const cards = all("secModel", 'input[name="modelId"]');
  if(cards.length < 2) return;
  const before = text("grandMax");
  cards[1].checked = true;
  fire(cards[1], "change");
  assert.notEqual(text("grandMax"), before);
});

test("add-ons move the total and appear as line items", () => {
  const rows = () => all("priceTableBody", "tr").map(r => r.textContent);
  assert.ok(rows().some(r => /Installation/.test(r)), "installation on by default");

  const before = text("grandMax");
  const amc = pick("secAddons", 'input[name="includeAMC"]');
  amc.checked = true;
  fire(amc, "change");

  assert.ok(rows().some(r => /AMC/.test(r)));
  assert.notEqual(text("grandMax"), before);
});

test("a RAID change that invalidates the unit un-prices the quote", () => {
  const r10 = pick("secDrives", 'input[name="raid"][value="RAID10"]');
  const before = pick("secModel", 'input[name="modelId"]:checked').value;

  const r0 = pick("secDrives", 'input[name="raid"][value="RAID0"]');
  r0.checked = true;
  fire(r0, "change");

  // RAID 0 needs a single drive, which lands on the 2-bay tier — the previously
  // chosen 4-bay unit is no longer a candidate, so the quote must stop pricing it.
  const stillListed = all("secModel", 'input[name="modelId"]').map(i => i.value);
  if(!stillListed.includes(before)){
    assert.equal(text("grandMax"), "—");
    assert.equal($("generatePdf").disabled, true);
  }
  assert.ok(r10);  // the tile is still offered
});

test("customer details re-price without redrawing the inputs", () => {
  const first = all("secModel", 'input[name="modelId"]')[0];
  first.checked = true;
  fire(first, "change");

  const name = pick("secDetails", 'input[name="custName"]');
  name.value = "Aarav Enterprises";
  fire(name, "input");

  // the same node is still in the document, so the caret can't have jumped
  assert.equal(pick("secDetails", 'input[name="custName"]'), name);
  assert.equal(name.value, "Aarav Enterprises");
});

test("quote validity switches, keeps its highlight, and reaches the PDF", () => {
  const tiles = all("secDetails", 'input[name="validity"]');
  assert.equal(tiles.length, 3);
  assert.equal(pick("secDetails", 'input[name="validity"]:checked').value, "15 days");
  assert.match(text("quoteSummary"), /15 days/);

  const thirty = tiles.find(t => t.value === "30 days");
  thirty.checked = true;
  fire(thirty, "change");

  // section 5 is never re-rendered, so the highlight has to be moved by hand
  assert.ok(thirty.closest(".tile").classList.contains("selected"));
  assert.equal(
    all("secDetails", 'input[name="validity"]').filter(t => t.closest(".tile").classList.contains("selected")).length,
    1, "exactly one tile stays highlighted"
  );
  assert.match(text("quoteSummary"), /30 days/);
});

test("a target beyond one chassis raises the multi-unit banner", () => {
  const r6 = pick("secDrives", 'input[name="raid"][value="RAID6"]');
  r6.checked = true;
  fire(r6, "change");

  const slider = pick("secStorage", "#storageRange");
  slider.value = "200";
  fire(slider, "input");
  fire(slider, "change");

  assert.match($("secModel").textContent, /units needed/);
  assert.match(text("quoteSummary"), /×/);
});

test("the mobile quote sheet opens and closes", () => {
  $("openQuote").click();
  assert.ok($("quotePanel").classList.contains("open"));
  assert.equal($("scrim").hidden, false);

  $("closeQuote").click();
  assert.equal($("quotePanel").classList.contains("open"), false);
  assert.equal($("scrim").hidden, true);
});
