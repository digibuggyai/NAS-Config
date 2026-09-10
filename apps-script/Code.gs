/**
 * NAS Configurator — pricing endpoint.
 *
 * Bound to the "NAS COLD MESSAGE" spreadsheet. Reads the Pricing tab and serves
 * it as the JSON the configurator expects, so prices update by editing the sheet.
 *
 * Deploy: Extensions > Apps Script, paste this in, then Deploy > New deployment >
 * Web app, "Execute as: Me", "Who has access: Anyone". Copy the /exec URL into
 * src/config.js. See apps-script/README.md.
 *
 * Nothing here hardcodes cell positions. Tables are located by matching header
 * TEXT against the synonym lists below, so rows and columns can move. If the sheet
 * gains a column with a new name, add the name to the relevant list — that is the
 * only edit this file should ever need.
 */

var SHEET_NAME = 'Pricing';

/* Header synonyms, lowercased, matched as substrings. First match wins. */
var HEADERS = {
  model:      ['model', 'nas model', 'device', 'unit', 'product'],
  brand:      ['brand', 'make', 'manufacturer'],
  bays:       ['bay', 'bays', 'no of bays', 'no. of bays', 'drive bays'],
  quote:      ['quote price', 'quote', 'list price', 'max', 'mrp'],
  min:        ['with tax', 'minimum', 'min price', 'min', 'best price', 'net'],
  raid:       ['raid'],
  expandable: ['expandable', 'expansion'],
  capacity:   ['capacity', 'size', 'hdd size', 'drive size', 'tb']
};

/* Fallbacks for facts the sheet may not carry as columns. Sheet values always win. */
var BAY_HINTS = {
  'DS223J': 2, 'DS225+': 2, 'DS725+': 2, 'TS-233-2G': 2, 'TS-216G-4G': 2,
  'DS425+': 4, 'DS925+': 4, 'TS-433-4G': 4, 'TS-462-4G': 4, 'TS-464-8G': 4,
  'TS-664-8G': 6,
  'DS1525+': 8, 'DS1825+': 8, 'TS-832PX-4G': 8, 'TS-873A-8G': 8
};

/* Expandability is product-line knowledge, not sheet data — see README "Known gaps". */
var EXPANDABLE_HINTS = {
  'DS225+': true, 'DS725+': true, 'DS425+': true, 'DS925+': true,
  'DS1525+': true, 'DS1825+': true, 'TS-832PX-4G': true, 'TS-873A-8G': true
};

/* 4-bay and larger chassis are quoted as supporting the full RAID set; 2-bay is
   limited to 0/1. Used only when the sheet's RAID cell is blank or unparseable. */
var RAID_ALL = ['RAID0', 'RAID1', 'RAID5', 'RAID6', 'RAID10'];
var RAID_2BAY = ['RAID0', 'RAID1'];

var DEFAULT_INSTALL = { quote: 5900, min: 4130 };
var DEFAULT_AMC = { quote: 0.10, min: 0.07 };

/* ============================ entry point ============================ */

function doGet(e) {
  var debug = !!(e && e.parameter && e.parameter.debug);
  var payload;
  try {
    payload = buildPricing(debug);
  } catch (err) {
    payload = { error: String(err && err.message || err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload, null, debug ? 2 : 0))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run this from the editor to eyeball the output before deploying. */
function preview() {
  Logger.log(JSON.stringify(buildPricing(true), null, 2));
}

function buildPricing(debug) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No sheet named "' + SHEET_NAME + '"');

  var grid = sheet.getDataRange().getValues();
  var warnings = [];

  var models = readModels(grid, warnings);
  var hdd = readHdd(grid, warnings);
  var rates = readRates(grid, warnings);

  if (!models.length) warnings.push('No NAS models parsed — check the model/quote headers.');
  if (!hdd.capacities.length) warnings.push('No HDD prices parsed — check the capacity/brand headers.');

  var out = {
    updatedAt: new Date().toISOString(),
    source: SpreadsheetApp.getActive().getName() + ' > ' + SHEET_NAME,
    models: models,
    capacities: hdd.capacities,
    hddPricing: hdd.pricing,
    install: rates.install,
    amcRate: rates.amcRate,
    warnings: warnings
  };
  if (debug) out.debug = { rows: grid.length, cols: grid[0] ? grid[0].length : 0 };
  return out;
}

/* ============================ NAS models ============================ */

function readModels(grid, warnings) {
  var head = findHeaderRow(grid, ['model'], ['quote']);
  if (!head) return [];

  var col = head.cols;
  var models = [];

  for (var r = head.row + 1; r < grid.length; r++) {
    var id = text(grid[r][col.model]);
    if (!id) {
      // one blank line is a spacer; two in a row ends the table
      if (!text(grid[r + 1] && grid[r + 1][col.model])) break;
      continue;
    }
    if (looksLikeHeader(id)) break;

    var quote = num(grid[r][col.quote]);
    var min = col.min != null ? num(grid[r][col.min]) : null;
    if (quote == null) { warnings.push('Skipped "' + id + '" — no quote price.'); continue; }

    var bays = col.bays != null ? num(grid[r][col.bays]) : null;
    if (bays == null) bays = BAY_HINTS[id] || null;
    if (bays == null) { warnings.push('Skipped "' + id + '" — no bay count in the sheet or hints.'); continue; }

    var raid = parseRaid(col.raid != null ? grid[r][col.raid] : '');
    if (!raid.length) raid = bays <= 2 ? RAID_2BAY : RAID_ALL;

    var expandable;
    if (col.expandable != null && text(grid[r][col.expandable])) {
      expandable = /^(y|yes|true|1)/i.test(text(grid[r][col.expandable]));
    } else {
      expandable = !!EXPANDABLE_HINTS[id];
    }

    models.push({
      id: id,
      brand: col.brand != null ? text(grid[r][col.brand]) : guessBrand(id),
      bays: bays,
      quote: quote,
      minTax: min == null ? quote : min,
      raid: raid,
      expandable: expandable
    });
  }
  return models;
}

function guessBrand(id) {
  if (/^ds|^rs/i.test(id)) return 'Synology';
  if (/^ts|^tv/i.test(id)) return 'QNAP';
  return '';
}

function parseRaid(cell) {
  var s = text(cell);
  if (!s) return [];
  // "RAID 5/6/10", "RAID 0, RAID 1", "0/1" all land in the same place
  var nums = s.match(/\d+/g) || [];
  var seen = {}, out = [];
  for (var i = 0; i < nums.length; i++) {
    var lvl = 'RAID' + String(parseInt(nums[i], 10));
    if (RAID_ALL.indexOf(lvl) !== -1 && !seen[lvl]) { seen[lvl] = true; out.push(lvl); }
  }
  return out;
}

/* ============================ HDD pricing ============================

   Handles the common shapes:
     A) capacity rows × brand columns, each brand one price column
     B) capacity rows × brand columns, each brand a Quote + Minimum pair
   Brand names are read from the header row itself, so adding a drive line to the
   sheet needs no change here. A brand column pairs with the next column when that
   next header reads like a "minimum"/"with tax" column.
*/

function readHdd(grid, warnings) {
  var head = findHeaderRow(grid, ['capacity'], null, { after: 0, requireBrands: true });
  if (!head) return { capacities: [], pricing: {} };

  var row = grid[head.row];
  var capCol = head.cols.capacity;
  var brands = [];

  for (var c = 0; c < row.length; c++) {
    if (c === capCol) continue;
    var label = text(row[c]);
    if (!label || isRateWord(label)) continue;
    if (matchesAny(label, HEADERS.quote) || matchesAny(label, HEADERS.min)) continue; // sub-header, claimed below

    var next = text(row[c + 1]);
    var pairsWithNext = next && matchesAny(next, HEADERS.min);
    brands.push({ name: label, quoteCol: c, minCol: pairsWithNext ? c + 1 : null });
  }

  var pricing = {}, capacities = [];

  for (var r = head.row + 1; r < grid.length; r++) {
    var capText = text(grid[r][capCol]);
    if (!capText) {
      if (!text(grid[r + 1] && grid[r + 1][capCol])) break;
      continue;
    }
    var cap = num(capText);
    if (cap == null) continue;

    var entry = {};
    for (var b = 0; b < brands.length; b++) {
      var q = num(grid[r][brands[b].quoteCol]);
      if (q == null || q === 0) continue;                 // blank = not priced
      var m = brands[b].minCol != null ? num(grid[r][brands[b].minCol]) : null;
      entry[brands[b].name] = { quote: q, min: m == null ? q : m };
    }
    if (Object.keys(entry).length) {
      pricing[String(cap)] = entry;
      if (capacities.indexOf(cap) === -1) capacities.push(cap);
    }
  }

  capacities.sort(function (a, b) { return a - b; });
  if (!brands.length) warnings.push('Found a capacity column but no drive-line columns beside it.');
  return { capacities: capacities, pricing: pricing };
}

/* ============================ install / AMC ============================

   Looked up as labelled rows anywhere on the tab: the first numeric cell on an
   "installation" row is the quote price and the next one the minimum; the AMC
   (annual maintenance cost) row is read the same way, with percentages
   normalised to fractions. "RMA" and "warranty" are still matched because the
   sheet used those words before the line was renamed.
*/

function readRates(grid, warnings) {
  var install = findLabelledPair(grid, ['installation', 'install', 'setup']);
  var amc = findLabelledPair(grid, ['amc', 'annual maintenance', 'maintenance', 'rma', 'warranty']);

  if (!install) warnings.push('No installation row found — using default ' + DEFAULT_INSTALL.quote + '/' + DEFAULT_INSTALL.min + '.');
  if (!amc) warnings.push('No AMC row found — using default 10%/7%.');

  return {
    install: install ? { quote: install[0], min: install[1] } : DEFAULT_INSTALL,
    amcRate: amc ? { quote: asFraction(amc[0]), min: asFraction(amc[1]) } : DEFAULT_AMC
  };
}

function asFraction(n) { return n > 1 ? n / 100 : n; }

function findLabelledPair(grid, words) {
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      var label = text(grid[r][c]);
      if (!label || !matchesAny(label, words)) continue;
      var found = [];
      for (var k = c + 1; k < grid[r].length && found.length < 2; k++) {
        var v = num(grid[r][k]);
        if (v != null) found.push(v);
      }
      if (found.length) return [found[0], found.length > 1 ? found[1] : found[0]];
    }
  }
  return null;
}

/* ============================ header matching ============================ */

/**
 * Finds the first row whose cells satisfy every key in `required` (and, if given,
 * `alsoRequired`), returning the row index and a key -> column-index map.
 */
function findHeaderRow(grid, required, alsoRequired, opts) {
  opts = opts || {};
  var need = required.concat(alsoRequired || []);

  for (var r = opts.after || 0; r < grid.length; r++) {
    var cols = mapHeaderCells(grid[r]);
    var ok = true;
    for (var i = 0; i < need.length; i++) {
      if (cols[need[i]] == null) { ok = false; break; }
    }
    if (!ok) continue;
    if (opts.requireBrands && countNonEmpty(grid[r]) < 2) continue;
    return { row: r, cols: cols };
  }
  return null;
}

function mapHeaderCells(row) {
  var cols = {};
  for (var c = 0; c < row.length; c++) {
    var label = text(row[c]);
    if (!label) continue;
    for (var key in HEADERS) {
      if (cols[key] != null) continue;
      if (matchesAny(label, HEADERS[key])) { cols[key] = c; break; }
    }
  }
  return cols;
}

function matchesAny(label, words) {
  var s = String(label).toLowerCase().trim();
  for (var i = 0; i < words.length; i++) {
    if (s.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

function looksLikeHeader(s) {
  return matchesAny(s, HEADERS.model) || matchesAny(s, HEADERS.capacity);
}

function isRateWord(s) {
  return matchesAny(s, ['installation', 'install', 'amc', 'annual maintenance', 'rma', 'warranty', 'total', 'gst', 'tax %']);
}

/* ============================ cell helpers ============================ */

function text(v) {
  return v == null ? '' : String(v).trim();
}

function num(v) {
  if (typeof v === 'number') return isNaN(v) ? null : v;
  var s = text(v).replace(/[₹,\s]/g, '').replace(/(tb|gb|%)$/i, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function countNonEmpty(row) {
  var n = 0;
  for (var i = 0; i < row.length; i++) if (text(row[i])) n++;
  return n;
}
