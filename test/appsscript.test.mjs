/* Exercises the Apps Script parser (apps-script/Code.gs) against synthetic grids
 * shaped like the Pricing tab. The .gs file is plain ES5 with no module system,
 * so it is evaluated in a Node vm context here — the same way Apps Script runs it. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
const gs = vm.createContext({ Logger:{ log(){} }, ContentService:{}, SpreadsheetApp:{} });
vm.runInContext(src, gs);

/* Values built inside the vm have that realm's prototypes, so deepEqual would
 * reject them on identity alone. Round-trip them into this realm first. */
const plain = v => JSON.parse(JSON.stringify(v));

const NAS_GRID = [
  ["DigiBuggy NAS price list", "", "", "", ""],
  ["", "", "", "", ""],
  ["Model", "Brand", "Bays", "Quote Price", "With Tax", "RAID"],
  ["DS223J", "Synology", 2, 24000, 22420, "RAID 0/1"],
  ["DS425+", "Synology", 4, 67000, 63720, "RAID 5/6/10"],
  ["TS-873A-8G", "QNAP", 8, 130000, 123900, ""]
];

test("reads models by header name, wherever the header row sits", () => {
  const warnings = [];
  const models = plain(gs.readModels(NAS_GRID, warnings));
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    id:"DS223J", brand:"Synology", bays:2, quote:24000, minTax:22420,
    raid:["RAID0","RAID1"], expandable:false
  });
  assert.deepEqual(models[1].raid, ["RAID5","RAID6","RAID10"]);
  assert.equal(models[2].expandable, true);           // from EXPANDABLE_HINTS
  assert.deepEqual(models[2].raid, plain(gs.RAID_ALL));      // blank RAID cell, 8-bay
});

test("survives reordered columns and prices written as text", () => {
  const grid = [
    ["Quote", "Model", "With tax", "No. of bays"],
    ["₹ 45,000", "TS-433-4G", "42,480", "4"]
  ];
  const models = plain(gs.readModels(grid, []));
  assert.equal(models.length, 1);
  assert.equal(models[0].quote, 45000);
  assert.equal(models[0].minTax, 42480);
  assert.equal(models[0].bays, 4);
  assert.equal(models[0].brand, "QNAP");              // inferred from the model prefix
});

test("a model with no price is skipped and reported, not silently dropped", () => {
  const warnings = [];
  const models = plain(gs.readModels([
    ["Model", "Bays", "Quote Price"],
    ["DS223J", 2, 24000],
    ["DS999X", 4, ""]
  ], warnings));
  assert.deepEqual(models.map(m => m.id), ["DS223J"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DS999X/);
});

test("reads the HDD table with Quote/Minimum column pairs per brand", () => {
  const grid = [
    ["Hard disks", ""],
    ["Capacity", "Exos", "Minimum", "IronWolf", "Minimum"],
    ["2 TB", 21000, 20060, 19000, 18054],
    ["4 TB", "", "", 22000, 21004],
    ["8 TB", 45000, 43070, "", ""]
  ];
  const { capacities, pricing } = plain(gs.readHdd(grid, []));
  assert.deepEqual(capacities, [2, 4, 8]);
  assert.deepEqual(pricing["2"], {
    "Exos":{quote:21000, min:20060}, "IronWolf":{quote:19000, min:18054}
  });
  assert.deepEqual(Object.keys(pricing["4"]), ["IronWolf"]);   // blank Exos = not priced
  assert.deepEqual(Object.keys(pricing["8"]), ["Exos"]);
});

test("a new drive line in the sheet needs no code change", () => {
  const { pricing } = plain(gs.readHdd([
    ["Capacity", "Exos", "Minimum", "Some New Line", "Minimum"],
    ["16 TB", 82000, 78470, 79000, 75000]
  ], []));
  assert.equal(pricing["16"]["Some New Line"].quote, 79000);
});

test("picks up installation and AMC rows anywhere on the tab", () => {
  const rates = plain(gs.readRates([
    ["", "", ""],
    ["Installation", 5900, 4130],
    ["AMC", "10%", "7%"]
  ], []));
  assert.deepEqual(rates.install, { quote:5900, min:4130 });
  assert.deepEqual(rates.amcRate, { quote:0.10, min:0.07 });
});

test("a sheet still labelling the row RMA is still read", () => {
  const rates = plain(gs.readRates([["Extended RMA", "12%", "9%"]], []));
  assert.deepEqual(rates.amcRate, { quote:0.12, min:0.09 });
});

test("falls back to defaults and warns when the rate rows are missing", () => {
  const warnings = [];
  const rates = plain(gs.readRates([["Model", "Quote Price"]], warnings));
  assert.deepEqual(rates.install, { quote:5900, min:4130 });
  assert.deepEqual(rates.amcRate, { quote:0.10, min:0.07 });
  assert.equal(warnings.length, 2);
});

test("RAID cells parse in whatever notation the sheet uses", () => {
  assert.deepEqual(plain(gs.parseRaid("RAID 0/1")), ["RAID0","RAID1"]);
  assert.deepEqual(plain(gs.parseRaid("RAID 5, RAID 6, RAID 10")), ["RAID5","RAID6","RAID10"]);
  assert.deepEqual(plain(gs.parseRaid("0 / 1 / 5")), ["RAID0","RAID1","RAID5"]);
  assert.deepEqual(plain(gs.parseRaid("n/a")), []);
  assert.deepEqual(plain(gs.parseRaid("")), []);
});
