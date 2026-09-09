/* Smoke test for the wizard: boots index.html in jsdom with the real app.js and
 * walks the five steps the way a rep would, checking that each one renders the
 * controls it should and that the quotation panel keeps up. Catches broken
 * element ids and template mistakes that unit tests on the maths never would. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

/* app.js runs on import and touches the document, so each test needs its own
 * DOM installed as the global before that import is evaluated. Node caches ES
 * modules, so the module is imported once and the DOM is set up around it. */
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

test("boots on the first step with the built-in price snapshot", () => {
  assert.match(text("stepCount"), /1 of 5/);
  assert.match(text("dataSyncNote"), /snapshot|price list/i);
  assert.equal(win.document.querySelectorAll(".pstep").length, 5);
  assert.ok($("stepBody").querySelector("#storageRange"), "storage slider rendered");
});

test("step 1 offers the use cases and a storage slider", () => {
  const useCases = $("stepBody").querySelectorAll('input[name="useCase"]');
  assert.equal(useCases.length, 6);
  assert.equal($("stepBody").querySelector('input[name="useCase"]:checked').value, "general");
});

test("nothing is priced before the rep has chosen a unit", () => {
  // The panel must not show a total for a configuration nobody picked.
  assert.equal(text("grandMax"), "—");
  assert.equal(text("grandMin"), "—");
  assert.equal(text("rtAmount"), "—");
  assert.ok($("quotePanel").classList.contains("unpriced"));
  assert.equal($("generatePdf").disabled, true);
  assert.match(text("quoteRef"), /Not yet priced/);
});

test("what the rep has answered still shows in the panel", () => {
  assert.match(text("quoteSummary"), /Target usable/);
  assert.match(text("quoteSummary"), /20 TB/);
  assert.doesNotMatch(text("quoteSummary"), /NAS unit/);   // step 3 not reached
});

test("choosing a use case applies its RAID default", () => {
  const media = $("stepBody").querySelector('input[name="useCase"][value="media"]');
  media.checked = true;
  media.dispatchEvent(new win.Event("change", { bubbles:true }));

  assert.equal($("stepBody").querySelector('input[name="useCase"]:checked').value, "media");
  assert.equal(text("grandMax"), "—", "still unpriced on step 1");
});

test("Next walks to step 2, which renders RAID and drive choices", () => {
  $("nextBtn").click();
  assert.match(text("stepCount"), /2 of 5/);
  assert.equal($("stepBody").querySelectorAll('input[name="raid"]').length, 5);
  assert.ok($("stepBody").querySelectorAll('input[name="driveCap"]').length >= 5);
  assert.ok($("stepBody").querySelectorAll('input[name="driveBrand"]').length >= 1);
});

test("changing capacity keeps the drive line valid for that capacity", () => {
  const six = $("stepBody").querySelector('input[name="driveCap"][value="6"]');
  six.checked = true;
  six.dispatchEvent(new win.Event("change", { bubbles:true }));

  const brands = [...$("stepBody").querySelectorAll('input[name="driveBrand"]')].map(i => i.value);
  assert.deepEqual(brands, ["WD Ultrastar"]);       // the only line priced at 6 TB
  assert.match(text("quoteSummary"), /WD Ultrastar/);
});

test("step 3 lists only units matching the bay tier and RAID level", () => {
  const eight = $("stepBody").querySelector('input[name="driveCap"][value="8"]');
  eight.checked = true;
  eight.dispatchEvent(new win.Event("change", { bubbles:true }));

  $("nextBtn").click();
  assert.match(text("stepCount"), /3 of 5/);

  const cards = [...$("stepBody").querySelectorAll('input[name="modelId"]')];
  assert.ok(cards.length > 0, "at least one candidate unit");
  assert.ok($("stepBody").querySelector(".model-card.selected"), "one is preselected");
  assert.ok($("stepBody").textContent.includes("Best price"));

  // reaching step 3 is what turns the quotation into a real, sendable quote
  assert.match(text("grandMax"), /^₹[\d,]+$/);
  assert.equal(text("grandMax"), text("rtAmount"));
  assert.equal($("generatePdf").disabled, false);
  assert.match(text("quoteSummary"), /NAS unit/);
});

test("picking a different unit changes the total", () => {
  const cards = [...$("stepBody").querySelectorAll('input[name="modelId"]')];
  if(cards.length < 2) return;                       // nothing to switch to
  const before = text("grandMax");
  cards[1].checked = true;
  cards[1].dispatchEvent(new win.Event("change", { bubbles:true }));
  assert.notEqual(text("grandMax"), before);
});

test("step 4 toggles add-ons into the price table", () => {
  $("nextBtn").click();
  assert.match(text("stepCount"), /4 of 5/);

  const rows = () => [...$("priceTableBody").querySelectorAll("tr")].map(r => r.textContent);
  assert.ok(rows().some(r => /Installation/.test(r)), "installation on by default");

  const rma = $("stepBody").querySelector('input[name="includeRMA"]');
  const before = text("grandMax");
  rma.checked = true;
  rma.dispatchEvent(new win.Event("change", { bubbles:true }));

  assert.ok(rows().some(r => /RMA/.test(r)));
  assert.notEqual(text("grandMax"), before);
});

test("step 5 collects customer details without redrawing mid-typing", () => {
  $("nextBtn").click();
  assert.match(text("stepCount"), /5 of 5/);
  assert.equal(text("nextLabel"), "Download PDF");

  const name = $("stepBody").querySelector('input[name="custName"]');
  name.value = "Aarav Enterprises";
  name.dispatchEvent(new win.Event("input", { bubbles:true }));

  // the same node is still in the document, so the caret can't have jumped
  assert.equal($("stepBody").querySelector('input[name="custName"]'), name);
  assert.equal(name.value, "Aarav Enterprises");
});

test("the progress rail navigates back to a visited step", () => {
  win.document.querySelector('.pstep[data-goto="2"]').click();
  assert.match(text("stepCount"), /2 of 5/);
  assert.ok($("stepBody").querySelector('input[name="raid"]'));
});

test("a target beyond one chassis raises the multi-unit banner", () => {
  const r6 = $("stepBody").querySelector('input[name="raid"][value="RAID6"]');
  r6.checked = true;
  r6.dispatchEvent(new win.Event("change", { bubbles:true }));

  const slider = $("stepBody").querySelector("#storageRange");
  if(slider){ slider.value = "200"; slider.dispatchEvent(new win.Event("input", { bubbles:true })); }
  else {
    win.document.querySelector('.pstep[data-goto="1"]').click();
    const s = $("stepBody").querySelector("#storageRange");
    s.value = "200";
    s.dispatchEvent(new win.Event("input", { bubbles:true }));
    win.document.querySelector('.pstep[data-goto="3"]').click();
  }

  win.document.querySelector('.pstep[data-goto="3"]').click();
  assert.match($("stepBody").textContent, /units needed/);
});

test("the mobile quote sheet opens and closes", () => {
  $("openQuote").click();
  assert.ok($("quotePanel").classList.contains("open"));
  assert.equal($("scrim").hidden, false);

  $("closeQuote").click();
  assert.equal($("quotePanel").classList.contains("open"), false);
  assert.equal($("scrim").hidden, true);
});
