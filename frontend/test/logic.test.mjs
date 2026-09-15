import test from "node:test";
import assert from "node:assert/strict";
import {
  usableForN, computeDrives, bayTierFor, candidateModels, priceQuote
} from "../src/logic.js";
import { FALLBACK } from "../src/pricing.js";

test("RAID usable capacity", () => {
  assert.equal(usableForN("RAID0",  4, 8), 32);
  assert.equal(usableForN("RAID1",  2, 8), 8);
  assert.equal(usableForN("RAID5",  4, 8), 24);
  assert.equal(usableForN("RAID6",  4, 8), 16);
  assert.equal(usableForN("RAID10", 4, 8), 16);
});

test("picks the smallest drive count that meets the target", () => {
  const c = computeDrives("RAID5", 8, 20);        // needs (n-1)*8 >= 20 -> n=4
  assert.equal(c.drivesPerUnit, 4);
  assert.equal(c.units, 1);
  assert.equal(c.totalUsable, 24);
  assert.equal(c.exceeded, false);
});

test("RAID 10 steps in pairs", () => {
  const c = computeDrives("RAID10", 8, 20);       // (n/2)*8 >= 20 -> n=6
  assert.equal(c.drivesPerUnit, 6);
  assert.equal(c.totalUsable, 24);
});

test("RAID 1 is always two drives, scaling by whole units", () => {
  const c = computeDrives("RAID1", 8, 20);
  assert.equal(c.drivesPerUnit, 2);
  assert.equal(c.units, 3);
  assert.equal(c.totalUsable, 24);
  assert.equal(c.exceeded, true);
});

test("scales past a single 8-bay chassis", () => {
  const c = computeDrives("RAID6", 16, 200);      // (8-2)*16 = 96 per unit
  assert.equal(c.drivesPerUnit, 8);
  assert.equal(c.usablePerUnit, 96);
  assert.equal(c.units, 3);
  assert.equal(c.exceeded, true);
});

test("an explicit chassis size caps the drives per unit", () => {
  // 20 TB at RAID 5 fits one 4-bay box, but the rep asked for 2-bay chassis.
  const c = computeDrives("RAID5", 8, 20, 2);
  assert.equal(c.drivesPerUnit, 2);
  assert.equal(c.usablePerUnit, 8);        // (2-1) x 8
  assert.equal(c.units, 3);
  assert.equal(c.exceeded, true);
  assert.equal(c.totalUsable, 24);
});

test("a larger chassis than needed still uses only the drives required", () => {
  const c = computeDrives("RAID5", 8, 20, 8);
  assert.equal(c.drivesPerUnit, 4);
  assert.equal(c.units, 1);
  assert.equal(c.exceeded, false);
});

test("RAID 10 leaves the odd bay empty rather than half-filling a mirror", () => {
  const c = computeDrives("RAID10", 4, 100, 6);   // 6 bays, pairs only
  assert.equal(c.drivesPerUnit, 6);
  const odd = computeDrives("RAID10", 4, 100, 7); // 7 bays -> fill 6
  assert.equal(odd.drivesPerUnit, 6);
  assert.equal(odd.usablePerUnit, 12);
});

test("the chassis cap defaults to the 8-bay ceiling", () => {
  assert.deepEqual(computeDrives("RAID6", 16, 200), computeDrives("RAID6", 16, 200, 8));
});

test("an impossible chassis size is rejected rather than looping", () => {
  assert.throws(() => computeDrives("RAID5", 8, 20, 1), /at least 2/);
});

test("bay tiers round up to a size actually sold", () => {
  assert.equal(bayTierFor(1), 2);
  assert.equal(bayTierFor(3), 4);
  assert.equal(bayTierFor(5), 5);      // the DS1525+ is a 5-bay chassis
  assert.equal(bayTierFor(7), 8);
});

test("the tier list comes from the catalogue, not a hardcoded ladder", () => {
  // A price list with only 4- and 8-bay units must never route to a 6-bay tier.
  assert.equal(bayTierFor(5, [4, 8]), 8);
  assert.equal(bayTierFor(3, [4, 8]), 4);
  // Beyond the largest chassis sold, the largest is the answer.
  assert.equal(bayTierFor(99, [2, 4]), 4);
});

test("candidates are filtered by bay tier + RAID, cheapest first", () => {
  const list = candidateModels(FALLBACK.models, 4, "RAID5", false);
  assert.ok(list.length > 0);
  assert.equal(list[0].id, "TS-433-4G");
  assert.ok(list.every(m => m.bays === 4 && m.raid.includes("RAID5")));
  assert.deepEqual([...list].sort((a,b) => a.quote-b.quote).map(m=>m.id), list.map(m=>m.id));
});

test("2-bay models are excluded from RAID 5", () => {
  assert.equal(candidateModels(FALLBACK.models, 2, "RAID5", false).length, 0);
});

test("preferExpandable floats expandable units up", () => {
  const list = candidateModels(FALLBACK.models, 8, "RAID5", true);
  // Per column F of the price sheet only the DS1825+ is expandable at 8 bays —
  // the QNAP PX/A units are not, whatever their product line suggests.
  assert.equal(list[0].id, "DS1825+");
});

test("expandability follows the price sheet, not the model name", () => {
  const expandable = FALLBACK.models.filter(m => m.expandable).map(m => m.id).sort();
  assert.deepEqual(expandable, ["DS1525+","DS1825+","DS725+","DS925+"]);
});

test("total = NAS×units + drives + install + AMC%", () => {
  const model = FALLBACK.models.find(m => m.id === "TS-433-4G");
  const calc = computeDrives("RAID5", 8, 20);     // 4 drives, 1 unit
  const p = priceQuote({
    model, calc,
    drivePrice: FALLBACK.hddPricing[8]["Exos"],   // 45000 / 43070
    install: FALLBACK.install,
    amcRate: FALLBACK.amcRate,
    includeInstall: true,
    includeAMC: true
  });
  assert.equal(p.totalDrives, 4);
  assert.equal(p.hwQuote, 45000 + 45000*4);
  assert.equal(p.amcQuote, (45000 + 180000) * 0.10);
  assert.equal(p.grandQuote, 225000 + 5900 + 22500);
});

test("AMC is charged on hardware only, not on installation", () => {
  const model = FALLBACK.models.find(m => m.id === "TS-433-4G");
  const calc = computeDrives("RAID5", 8, 20);
  const args = {
    model, calc, drivePrice: FALLBACK.hddPricing[8]["Exos"],
    install: FALLBACK.install, amcRate: FALLBACK.amcRate, includeAMC: true
  };
  const withInstall = priceQuote({ ...args, includeInstall: true });
  const without     = priceQuote({ ...args, includeInstall: false });
  assert.equal(withInstall.amcQuote, without.amcQuote);
});

test("multi-unit quotes scale NAS, drives and installation", () => {
  const model = FALLBACK.models.find(m => m.id === "DS1825+");
  const calc = computeDrives("RAID6", 16, 200);   // 8 drives × 3 units
  const p = priceQuote({
    model, calc, drivePrice: FALLBACK.hddPricing[16]["Exos"],
    install: FALLBACK.install, amcRate: FALLBACK.amcRate,
    includeInstall: true, includeAMC: false
  });
  assert.equal(p.totalDrives, 24);
  assert.equal(p.nasQuote, 180000 * 3);
  assert.equal(p.installQuote, 5900 * 3);
});

test("an unpriced drive line contributes nothing rather than NaN", () => {
  const model = FALLBACK.models.find(m => m.id === "TS-433-4G");
  const calc = computeDrives("RAID5", 8, 20);
  const p = priceQuote({
    model, calc, drivePrice: undefined,
    install: FALLBACK.install, amcRate: FALLBACK.amcRate,
    includeInstall: false, includeAMC: false
  });
  assert.equal(p.hddQuote, 0);
  assert.equal(p.grandQuote, 45000);
});

/* ---------------- network speed ---------------- */

test("the top speed of a ports string is the fastest link in it", async () => {
  const { topSpeed, labelForSpeed, networkFor } = await import("../src/logic.js");

  assert.equal(topSpeed("1GbE ×1"), 1);
  assert.equal(topSpeed("2.5GbE ×1 + 1GbE ×1"), 2.5, "a 1GbE port alongside doesn't slow it down");
  assert.equal(topSpeed("10GbE SFP+ ×2 + 2.5GbE ×2"), 10);
  assert.equal(topSpeed(""), 0);
  assert.equal(topSpeed(undefined), 0);

  assert.equal(labelForSpeed(2.5), "2.5GbE");
  assert.equal(labelForSpeed(25), "10GbE", "quotations only talk in 1/2.5/10");
  assert.equal(labelForSpeed(0), null);

  const net = networkFor({ network:"2.5GbE ×2", networkUpgrade:"10GbE via PCIe card" });
  assert.equal(net.quotable, "2.5GbE", "the card isn't in the quote, so it isn't quoted");
  assert.equal(net.upgrade, "10GbE via PCIe card");
  assert.equal(networkFor({}), null);
});

/* ---------------- sizing by budget ---------------- */

test("suggestBuildsForBudget finds the most usable capacity a fixed amount buys", async () => {
  const { suggestBuildsForBudget } = await import("../src/logic.js");
  const models = [{ id:"TS-433-4G", brand:"QNAP", bays:4, quote:45000, minTax:42480, raid:["RAID0"], expandable:false }];
  const hddPricing = { 10: { IronWolf: { quote:50000, min:47200 } } };

  const builds = suggestBuildsForBudget({
    budget: 200000, raid: "RAID0", models, hddPricing, capacities: [10]
  });

  // Per unit: 1 drive = 95000, 2 = 145000, 3 = 195000, 4 = 245000 (excluded).
  // A single chassis with 3 drives (195000, 30 TB) beats every combination of
  // more, cheaper chassis under the same budget — including 2 x 1-drive units
  // (190000, only 20 TB) — which is exactly why the search checks unit counts
  // too rather than assuming one chassis is always the answer.
  assert.ok(builds.every(b => b.totalQuote <= 200000));
  assert.equal(builds[0].drivesPerUnit, 3, "ranked by usable capacity, most first");
  assert.equal(builds[0].units, 1);
  assert.equal(builds[0].totalUsable, 30);
  assert.equal(builds[0].totalQuote, 195000);
});

test("nothing above budget is offered, and an impossible budget returns nothing", async () => {
  const { suggestBuildsForBudget } = await import("../src/logic.js");
  const models = [{ id:"TS-433-4G", brand:"QNAP", bays:4, quote:45000, minTax:42480, raid:["RAID0"], expandable:false }];
  const hddPricing = { 10: { IronWolf: { quote:50000, min:47200 } } };

  assert.deepEqual(
    suggestBuildsForBudget({ budget: 90000, raid:"RAID0", models, hddPricing, capacities:[10] }),
    []
  );
  assert.deepEqual(
    suggestBuildsForBudget({ budget: 0, raid:"RAID0", models, hddPricing, capacities:[10] }),
    []
  );
});

test("suggestBudgetPlan keeps redundancy whenever the budget can afford it at all", async () => {
  const { suggestBudgetPlan } = await import("../src/logic.js");
  const models = [{
    id:"TS-433-4G", brand:"QNAP", bays:4, quote:45000, minTax:42480,
    raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false
  }];
  const hddPricing = { 10: { IronWolf: { quote:50000, min:47200 } } };

  // RAID6/RAID10 both need all 4 bays here (₹2,45,000) — over ₹2,00,000. RAID5
  // needs only 3 drives (₹1,95,000) and fits, so it wins over RAID0, even though
  // RAID0 would deliver more raw terabytes for about the same spend.
  const plan = suggestBudgetPlan({ budget: 200000, models, hddPricing, capacities:[10] });
  assert.equal(plan.raid, "RAID5");
  assert.equal(plan.builds[0].totalUsable, 20);

  // Drop the budget below what even RAID1's fixed pair costs (₹1,45,000): only
  // RAID0 (a single ₹95,000 drive) still fits, so redundancy is genuinely
  // unaffordable and the tool falls all the way back to it.
  const tight = suggestBudgetPlan({ budget: 100000, models, hddPricing, capacities:[10] });
  assert.equal(tight.raid, "RAID0");

  // A huge budget affords RAID6 outright, so the most protective level wins.
  const generous = suggestBudgetPlan({ budget: 100000000, models, hddPricing, capacities:[10] });
  assert.equal(generous.raid, "RAID6");
});

test("suggestBudgetPlan returns null when nothing on the list fits", async () => {
  const { suggestBudgetPlan } = await import("../src/logic.js");
  const models = [{ id:"TS-433-4G", brand:"QNAP", bays:4, quote:45000, minTax:42480, raid:["RAID0"], expandable:false }];
  const hddPricing = { 10: { IronWolf: { quote:50000, min:47200 } } };
  assert.equal(suggestBudgetPlan({ budget: 1000, models, hddPricing, capacities:[10] }), null);
});
