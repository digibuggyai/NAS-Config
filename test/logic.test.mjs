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

test("bay tiers round up", () => {
  assert.equal(bayTierFor(1), 2);
  assert.equal(bayTierFor(3), 4);
  assert.equal(bayTierFor(5), 6);
  assert.equal(bayTierFor(7), 8);
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
  assert.equal(list[0].id, "TS-832PX-4G");        // cheapest expandable 8-bay
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
