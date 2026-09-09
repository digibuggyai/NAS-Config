import test from "node:test";
import assert from "node:assert/strict";
import { normalise, validate, FALLBACK } from "../src/pricing.js";

const sheetish = {
  updatedAt: "2026-09-09T06:00:00.000Z",
  models: [
    { id:"TS-433-4G", brand:"QNAP", bays:"4", quote:"45000", minTax:"42480", raid:["RAID5","RAID6"], expandable:false }
  ],
  capacities: ["8","16"],
  hddPricing: {
    "8":  { "Exos": { quote:"45000", min:"43070" } },
    "16": { "Exos": { quote:82000, min:78470 } }
  },
  install: { quote:"5900", min:"4130" },
  rmaRate: { quote:0.10, min:0.07 }
};

test("coerces the sheet's strings into numbers", () => {
  const d = normalise(sheetish);
  assert.equal(d.models[0].bays, 4);
  assert.equal(d.models[0].quote, 45000);
  assert.deepEqual(d.capacities, [8, 16]);
  assert.equal(d.hddPricing[8]["Exos"].quote, 45000);
  assert.equal(d.install.min, 4130);
  assert.equal(validate(d), null);
});

test("drops models that can't be quoted", () => {
  const d = normalise({ ...sheetish, models: [
    ...sheetish.models,
    { id:"", quote:1, bays:4, raid:["RAID5"] },          // no id
    { id:"BROKEN", quote:"n/a", bays:4, raid:["RAID5"] } // unparseable price
  ]});
  assert.deepEqual(d.models.map(m => m.id), ["TS-433-4G"]);
});

test("falls back to the snapshot when the payload has no usable models", () => {
  const d = normalise({ models: [], hddPricing: {} });
  assert.equal(d.models.length, FALLBACK.models.length);
  assert.equal(validate(d), null);
});

test("capacities are derived when the payload omits them", () => {
  const d = normalise({ models: sheetish.models, hddPricing: sheetish.hddPricing });
  assert.deepEqual(d.capacities, [8, 16]);
});

test("capacities with no priced drive line are dropped", () => {
  const d = normalise({
    ...sheetish,
    capacities: [4, 8],
    hddPricing: { "4": { "IronWolf": { quote: 0 } }, "8": sheetish.hddPricing["8"] }
  });
  assert.deepEqual(d.capacities, [8]);
});

test("min defaults to the quote price when the sheet leaves it blank", () => {
  const d = normalise({
    ...sheetish,
    models: [{ id:"X", bays:4, quote:1000, raid:["RAID5"] }],
    hddPricing: { "8": { "Exos": { quote: 500 } } },
    install: { quote: 5900 }
  });
  assert.equal(d.models[0].minTax, 1000);
  assert.equal(d.hddPricing[8]["Exos"].min, 500);
  assert.equal(d.install.min, 5900);
});

test("validate rejects a nonsense RMA rate", () => {
  const d = normalise(sheetish);
  assert.equal(validate({ ...d, rmaRate: { quote: 10, min: 7 } }), "RMA rate out of range");
});
