import { loadPricing } from "./pricing.js";
import { AUTO_REFRESH_MS } from "./config.js";
import {
  RAID_INFO, inr, computeDrives, validBrandsForCapacity,
  suggestBuilds, bestBuildPerModel, networkFor, bestNetworkAmong, topSpeed, labelForSpeed,
  buildableSizes, nearestBuildable, suggestBuildsForBudget, suggestBudgetPlan, MAX_UNITS
} from "./logic.js";
import { buildPdf, quoteRef, quoteFilename } from "./pdf.js";

const $ = id => document.getElementById(id);

let PRICING = null;                    // set in init()

/* Every answer lives here; the sections are drawn from it. Text inputs are the
 * one exception — they write into state on input but are never redrawn, so the
 * caret stays put while someone is typing. */
const answers = {
  storageMode: "capacity",             // "capacity" = pick a TB target · "budget" = pick a ₹ amount
  targetTB: 20,
  budget: 200000,
  brand: "any",
  bays: null,                          // null = let the tool choose the chassis
  raid: "RAID5",
  raidAuto: true,                      // only consulted in budget mode — see renderRaid()
  expandable: false,

  // Chosen by the suggestion, overridable in section 6.
  modelId: null,
  driveCap: null,
  driveLine: null,
  autoPick: true,                      // false once the rep picks a unit themselves

  speed: null,                         // what to print on the quote
  ramSku: null,                        // optional per-unit RAM upgrade
  nicSku: null,                        // optional per-unit network card
  includeInstall: true,
  includeAMC: false,
  custName: "", custLocation: "", repName: "", validity: "15 days"
};

const ui = { lastQuote: null, priceSource: null, storageMoved: null };

const RAID_TILES = [
  ["RAID0","RAID 0","Striping · no redundancy"],
  ["RAID1","RAID 1","Mirrored · 50% usable"],
  ["RAID5","RAID 5","Parity · survives 1 failure"],
  ["RAID6","RAID 6","Dual parity · survives 2"],
  ["RAID10","RAID 10","Mirror + stripe · fast rebuild"]
];

const SPEED_CHOICES = [
  { v:"1GbE",   sub:"Standard office network" },
  { v:"2.5GbE", sub:"Multi-user media work" },
  { v:"10GbE",  sub:"Virtualization, low latency" }
];

/* ================= price list freshness ================= */

function applyPricing(result){
  PRICING = result.data;
  ui.priceSource = result.source;

  const note = $("dataSyncNote");
  note.textContent = result.note;
  note.classList.toggle("stale", !!result.stale);

  const warnEl = $("priceWarnings");
  const warnings = result.warnings || [];
  warnEl.hidden = !warnings.length;
  if(warnings.length){
    warnEl.innerHTML = "<span>⚠</span><span><b>Price list:</b> " +
      warnings.map(escapeHtml).join(" ") + "</span>";
    console.warn("[pricing] warnings:", warnings);
  }
}

async function refreshPrices({ silent = false } = {}){
  const btn = $("refreshPrices");
  if(!silent){
    btn.disabled = true;
    $("dataSyncNote").textContent = "Fetching latest prices…";
  }
  try{
    applyPricing(await loadPricing());
    lastFetchAt = Date.now();
    renderAll();
  }finally{
    btn.disabled = false;
  }
}

let lastFetchAt = Date.now();

function startAutoRefresh(){
  if(!AUTO_REFRESH_MS) return;
  setInterval(() => {
    if(document.visibilityState === "visible") refreshPrices({ silent:true });
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "visible" && Date.now() - lastFetchAt > AUTO_REFRESH_MS){
      refreshPrices({ silent:true });
    }
  });
}

/* ================= derived configuration ================= */

/** Everything the current answers imply. The suggestion drives the whole page:
 *  drive size, drive count and chassis are chosen together, because they aren't
 *  independent — bigger drives need fewer bays, which allows a cheaper unit. */
function derive(){
  return answers.storageMode === "budget" ? deriveByBudget() : deriveByCapacity();
}

function deriveByCapacity(){
  // Every usable capacity these drives and chassis can actually produce. The
  // rep picks from this rather than typing a figure nothing can build.
  const sizes = buildableSizes({
    raid: answers.raid,
    models: PRICING.models,
    capacities: PRICING.capacities,
    hddPricing: PRICING.hddPricing,
    brand: answers.brand,
    bays: answers.bays,
    expandableOnly: answers.expandable,
    maxUnits: MAX_UNITS
  });

  if(!sizes.length){
    return {
      error: "Nothing on the price list can be built with these choices — widen the brand, bays or RAID level.",
      mode: "capacity", sizes, builds: [], options: [], build: null, model: null, price: zeroPrice()
    };
  }

  // Narrowing the choices can retire the size that was picked; move to the
  // closest one that still exists rather than quoting something impossible.
  if(!sizes.includes(answers.targetTB)){
    const moved = nearestBuildable(answers.targetTB, sizes);
    ui.storageMoved = moved !== answers.targetTB ? { from: answers.targetTB, to: moved } : null;
    answers.targetTB = moved;
  } else {
    ui.storageMoved = null;
  }

  const builds = suggestBuilds({
    targetTB: answers.targetTB,
    raid: answers.raid,
    brand: answers.brand,
    bays: answers.bays,
    expandableOnly: answers.expandable,
    models: PRICING.models,
    hddPricing: PRICING.hddPricing,
    capacities: PRICING.capacities
  });

  return finishDerive({ mode: "capacity", sizes, error: null, builds });
}

/** The budget flow is the mirror image of the capacity one: instead of finding
 *  the cheapest build that reaches a target, it finds the build that gets the
 *  most usable storage out of a fixed amount of money — RAID included, unless
 *  the rep has pinned one. */
function deriveByBudget(){
  ui.storageMoved = null;
  const budget = answers.budget;

  if(!Number.isFinite(budget) || budget <= 0){
    return {
      error: "Enter a budget to size against.",
      mode: "budget", sizes: [], builds: [], options: [], build: null, model: null, price: zeroPrice()
    };
  }

  const common = {
    models: PRICING.models, hddPricing: PRICING.hddPricing, capacities: PRICING.capacities,
    brand: answers.brand, bays: answers.bays, expandableOnly: answers.expandable, maxUnits: MAX_UNITS
  };

  let builds;
  if(answers.raidAuto){
    const plan = suggestBudgetPlan({ budget, ...common });
    if(!plan){
      return {
        error: `Nothing on the price list fits ${inr(budget)} with these choices — widen the brand or bays, or raise the budget.`,
        mode: "budget", sizes: [], builds: [], options: [], build: null, model: null, price: zeroPrice()
      };
    }
    answers.raid = plan.raid;          // keep the RAID section showing what was picked
    builds = plan.builds;
  } else {
    builds = suggestBuildsForBudget({ budget, raid: answers.raid, ...common });
    if(!builds.length){
      return {
        error: `No ${answers.raid} build fits ${inr(budget)} with these choices — try Auto, or a different RAID level.`,
        mode: "budget", sizes: [], builds: [], options: [], build: null, model: null, price: zeroPrice()
      };
    }
  }

  const d = finishDerive({ mode: "budget", sizes: [], error: null, builds });
  // The rest of the page (network speed, PDF) talks in terms of a target — a
  // budget build's delivered capacity IS that target once one has been chosen.
  if(d.build) answers.targetTB = d.build.totalUsable;
  return d;
}

/** The part both sizing modes share once they have a ranked list of builds:
 *  narrow by any drive choice the rep pinned, then settle on a unit. */
function finishDerive({ mode, sizes, error, builds }){
  // Section 8 constrains the suggestion rather than fighting it.
  const narrowed = builds.filter(b =>
    (answers.driveCap == null || b.driveCap === answers.driveCap) &&
    (answers.driveLine == null || b.driveLine === answers.driveLine));
  const pool = narrowed.length ? narrowed : builds;

  const options = bestBuildPerModel(pool);

  // Auto until the rep chooses; their choice then survives every other change
  // that doesn't invalidate it.
  let build = answers.autoPick
    ? options[0] ?? null
    : pool.find(b => b.model.id === answers.modelId) ?? null;

  if(!build && !answers.autoPick){
    answers.autoPick = true;
    build = options[0] ?? null;
  }
  if(build) answers.modelId = build.model.id;

  return { error, mode, sizes, builds, options, build, model: build?.model ?? null, price: priceFor(build) };
}

function zeroPrice(){
  return { totalDrives:0, nasQuote:0, nasMin:0, hddQuote:0, hddMin:0,
           ramQuote:0, ramMin:0, nicQuote:0, nicMin:0,
           installQuote:0, installMin:0, amcQuote:0, amcMin:0,
           hwQuote:0, hwMin:0, grandQuote:0, grandMin:0 };
}

/** The RAM/NIC product the rep picked, or null once it stops existing in the
 *  price list (an admin can deactivate one mid-session). */
function selectedUpgrade(category, sku){
  if(!sku) return null;
  return (PRICING.upgrades || []).find(u => u.category === category && u.sku === sku) ?? null;
}
const selectedRam = () => selectedUpgrade("RAM", answers.ramSku);
const selectedNic = () => selectedUpgrade("NIC", answers.nicSku);

function priceFor(build){
  if(!build) return zeroPrice();
  const drive = PRICING.hddPricing[build.driveCap]?.[build.driveLine] ?? { quote:0, min:0 };
  const totalDrives = build.drivesPerUnit * build.units;

  const nasQuote = build.model.quote * build.units;
  const nasMin   = build.model.minTax * build.units;
  const hddQuote = drive.quote * totalDrives;
  const hddMin   = drive.min * totalDrives;

  // One per chassis: two units means two RAM sticks and two network cards.
  const ram = selectedRam();
  const nic = selectedNic();
  const ramQuote = ram ? ram.quote * build.units : 0;
  const ramMin   = ram ? ram.min   * build.units : 0;
  const nicQuote = nic ? nic.quote * build.units : 0;
  const nicMin   = nic ? nic.min   * build.units : 0;

  const installQuote = answers.includeInstall ? PRICING.install.quote * build.units : 0;
  const installMin   = answers.includeInstall ? PRICING.install.min   * build.units : 0;

  const hwQuote = nasQuote + hddQuote + ramQuote + nicQuote;
  const hwMin   = nasMin + hddMin + ramMin + nicMin;
  const amcQuote = answers.includeAMC ? hwQuote * PRICING.amcRate.quote : 0;
  const amcMin   = answers.includeAMC ? hwMin   * PRICING.amcRate.min   : 0;

  return {
    totalDrives, nasQuote, nasMin, hddQuote, hddMin, ramQuote, ramMin, nicQuote, nicMin,
    installQuote, installMin, amcQuote, amcMin, hwQuote, hwMin,
    grandQuote: hwQuote + installQuote + amcQuote,
    grandMin:   hwMin   + installMin   + amcMin
  };
}

/* ================= sections ================= */

function tile(name, value, title, sub, selected, extraClass = ""){
  return `<label class="tile ${extraClass} ${selected ? "selected" : ""}">
    <input type="radio" name="${name}" value="${escapeAttr(value)}"${selected ? " checked" : ""}>
    <span class="tile-title">${title}</span>
    ${sub ? `<span class="tile-sub">${sub}</span>` : ""}
  </label>`;
}

const BUDGET_PRESETS = [100000, 150000, 200000, 300000, 500000];

/* --- 1. storage --- */
function renderStorage(d){
  const modeToggle = `
    <div class="field">
      <div class="tiles cols-2">
        ${tile("storageMode", "capacity", "By capacity", "Pick a TB target", answers.storageMode === "capacity")}
        ${tile("storageMode", "budget", "By budget", "Pick an amount to spend", answers.storageMode === "budget")}
      </div>
    </div>`;

  $("secStorage").innerHTML = modeToggle +
    (answers.storageMode === "budget" ? renderBudgetBody(d) : renderCapacityBody(d));
}

function renderCapacityBody(d){
  if(d.error){
    return `<p class="field-error">⚠ ${escapeHtml(d.error)}</p>`;
  }

  const presets = [10, 20, 50, 100].map(p => nearestBuildable(p, d.sizes))
    .filter((v, i, a) => v != null && a.indexOf(v) === i);

  const build = d.build;
  return `
    <div class="field">
      <div class="storage-row">
        <div class="storage-entry">
          <select id="storageSelect" class="storage-select mono" aria-label="Usable storage">
            ${d.sizes.map(v =>
              `<option value="${v}"${v === answers.targetTB ? " selected" : ""}>${v} TB</option>`
            ).join("")}
          </select>
        </div>
        <div class="storage-note">
          <p class="hint">${d.sizes.length} sizes can be built at ${answers.raid}${
            answers.bays != null ? ` in a ${answers.bays}-bay chassis` : ""}${
            answers.brand !== "any" ? ` from ${escapeHtml(answers.brand)}` : ""}.
            Anything not listed can't be made from whole drives.</p>
          ${build ? `<p class="hint"><b>${answers.targetTB} TB</b> = ${build.drivesPerUnit}× ${build.driveCap} TB at ${answers.raid}${
            build.units > 1 ? ` × ${build.units} units` : ""}.</p>` : ""}
        </div>
      </div>
      <div class="presets">
        ${presets.map(p =>
          `<button type="button" class="chip${answers.targetTB === p ? " on" : ""}" data-preset="${p}">${p} TB</button>`
        ).join("")}
      </div>
      ${ui.storageMoved
        ? `<p class="field-warn">⚠ ${ui.storageMoved.from} TB can't be built with these choices — moved to
           ${ui.storageMoved.to} TB, the closest that can.</p>`
        : ""}
    </div>`;
}

function renderBudgetBody(d){
  const build = d.build;
  return `
    <div class="field">
      <div class="storage-row">
        <div class="storage-entry">
          <span class="storage-unit">₹</span>
          <input type="number" id="budgetInput" class="storage-input budget mono" min="1000" step="1000"
                 value="${answers.budget ?? ""}" inputmode="numeric" aria-label="Budget in rupees">
        </div>
        <div class="storage-note">
          <p class="hint">The tool finds the NAS, drives and RAID level that deliver the most usable
            storage for this amount — RAID is picked automatically unless you choose one in step 4.</p>
          ${build ? `<p class="hint">${inr(answers.budget)} buys <b>${build.totalUsable} TB</b> usable at
            ${answers.raid}${build.units > 1 ? ` × ${build.units} units` : ""}.</p>` : ""}
        </div>
      </div>
      <div class="presets">
        ${BUDGET_PRESETS.map(p =>
          `<button type="button" class="chip${answers.budget === p ? " on" : ""}" data-budget-preset="${p}">${inr(p)}</button>`
        ).join("")}
      </div>
      ${d.error ? `<p class="field-error">⚠ ${escapeHtml(d.error)}</p>` : ""}
    </div>`;
}

/* --- 2. brand --- */
function renderBrand(){
  const brands = [...new Set(PRICING.models.map(m => m.brand).filter(Boolean))].sort();
  $("secBrand").innerHTML = `
    <div class="tiles">
      ${tile("brand", "any", "No preference", "Suggest from both", answers.brand === "any")}
      ${brands.map(b => tile("brand", b, b, `${PRICING.models.filter(m => m.brand === b).length} units`,
        answers.brand.toLowerCase() === b.toLowerCase())).join("")}
    </div>`;
}

/* --- 3. bays --- */
function renderBays(d){
  const tiers = [...new Set(PRICING.models.map(m => m.bays))].sort((a,b) => a - b);

  // What each size can actually hold at the current RAID and target, so the
  // choice is made on capacity rather than on a number.
  const reach = tier => {
    const best = d.builds.find(b => b.model.bays === tier);
    return best ? `${best.drivesPerUnit}× ${best.driveCap} TB${best.units > 1 ? ` · ${best.units} units` : ""}` : "won't reach it";
  };

  $("secBays").innerHTML = `
    <div class="tiles compact">
      ${tile("bays", "", "Auto", "Best fit", answers.bays == null, "compact")}
      ${tiers.map(t => tile("bays", t, `${t}-bay`, reach(t), answers.bays === t, "compact")).join("")}
    </div>
    ${answers.bays != null && !d.options.length
      ? `<p class="field-error">⚠ No ${answers.bays}-bay unit can do this — try Auto or another size.</p>`
      : `<p class="hint">${answers.bays == null
          ? "The suggestion below picks the chassis and the drives that fit it best."
          : `Drives below are recommended for a ${answers.bays}-bay chassis.`}</p>`}`;
}

/* --- 4. RAID --- */
function renderRaid(){
  const auto = answers.storageMode === "budget" && answers.raidAuto;
  const note = auto
    ? `<p class="select-prompt">Chosen automatically for the most usable capacity within ${inr(answers.budget)} —
        pick a level yourself if the customer needs specific redundancy.</p>`
    : answers.storageMode === "budget"
      ? `<p class="hint">Chosen by you. <button type="button" class="link-btn" id="resetRaid">Let the tool choose again</button></p>`
      : "";

  $("secRaid").innerHTML = note + `
    <div class="tiles">
      ${RAID_TILES.map(([v,t,s]) => tile("raid", v, t, s, answers.raid === v)).join("")}
    </div>
    <p class="hint">${RAID_INFO[answers.raid].label}</p>`;
}

/* --- 4. expandability --- */
function renderExpand(d){
  const expandables = PRICING.models.filter(m => m.expandable);
  $("secExpand").innerHTML = `
    <label class="tile tile-check ${answers.expandable ? "selected" : ""}">
      <input type="checkbox" name="expandable"${answers.expandable ? " checked" : ""}>
      <span>
        <span class="tile-title">Customer wants room to expand later</span>
        <span class="tile-sub">Only units that take an expansion unit will be suggested</span>
      </span>
    </label>
    <p class="hint">${
      answers.expandable
        ? `Suggesting from ${expandables.length} expandable unit${expandables.length === 1 ? "" : "s"}: ` +
          escapeHtml(expandables.map(m => m.id).join(", ")) + "."
        : `${expandables.length} of ${PRICING.models.length} units in the price list take an expansion unit.`
    }</p>`;
}

/* --- 5. suggested NAS --- */
function renderModel(d){
  if(d.error){
    $("secModel").innerHTML = `<p class="field-error">⚠ Nothing to suggest until the storage figure can be built.</p>`;
    return;
  }
  if(!d.options.length){
    $("secModel").innerHTML =
      `<p class="field-error">⚠ No unit in the price list can do ${answers.targetTB} TB at ${answers.raid}` +
      `${answers.brand !== "any" ? ` from ${escapeHtml(answers.brand)}` : ""}` +
      `${answers.expandable ? ", with room to expand" : ""}. Widen one of the choices above.</p>`;
    return;
  }

  const cards = d.options.map((b, i) => {
    const chosen = b.model.id === d.build?.model.id;
    const overDelivery = b.totalUsable - answers.targetTB;
    return `<label class="model-card ${chosen ? "selected" : ""}">
      <input type="radio" name="modelId" value="${escapeAttr(b.model.id)}"${chosen ? " checked" : ""}>
      <span class="model-main">
        <span class="model-title-row">
          <span class="model-name">${escapeHtml(b.model.id)}</span>
          <span class="badge badge-brand">${escapeHtml(b.model.brand)}</span>
          ${i === 0 ? '<span class="badge badge-best">Recommended</span>' : ""}
          ${b.model.expandable ? '<span class="badge badge-expand">Expandable</span>' : ""}
          ${b.units > 1 ? `<span class="badge badge-warn">${b.units} units</span>` : ""}
        </span>
        <span class="model-meta">
          ${b.drivesPerUnit}× ${b.driveCap} TB ${escapeHtml(b.driveLine)} in ${b.model.bays} bays${b.units > 1 ? ` × ${b.units} units` : ""}
          · ${b.totalUsable} TB usable${overDelivery > 0 ? ` (${overDelivery} TB over)` : ""}
          · ${b.spareBays} spare bay${b.spareBays === 1 ? "" : "s"}
        </span>
      </span>
      <span class="model-price">
        <span class="max mono">${inr(b.totalQuote)}</span>
        <span class="min mono">${inr(b.totalMin)} min</span>
      </span>
    </label>`;
  }).join("");

  const auto = answers.autoPick
    ? `<p class="select-prompt">Recommended for ${answers.targetTB} TB at ${answers.raid} — pick another if the customer prefers.</p>`
    : `<p class="hint">Chosen by you. <button type="button" class="link-btn" id="resetPick">Use the recommendation instead</button></p>`;

  $("secModel").innerHTML = auto + `<div class="model-list">${cards}</div>`;
}

/* --- 7. network speed --- */
function renderSpeed(d){
  const model = d.model;
  const net = networkFor(model);
  const bestAvailable = bestNetworkAmong(d.options);

  // A network card added in step 9 raises what this build can actually do,
  // whether or not the chassis has a fast port built in.
  const nic = selectedNic();
  const nicTopGb = nic ? topSpeed(`${nic.name} ${nic.spec}`) : 0;
  const effectiveTopGb = Math.max(net?.topGb ?? 0, nicTopGb);

  // Default to the fastest link the chosen unit actually has.
  if(answers.speed == null){
    answers.speed = labelForSpeed(effectiveTopGb) ?? net?.quotable ?? null;
  }

  let head;
  if(!model){
    head = `<p class="hint">Pick a unit above and its network ports show here.</p>`;
  } else if(!net && !nic){
    head = `<p class="field-warn">⚠ No network ports recorded for ${escapeHtml(model.id)}. An admin can add them in
            <a href="/admin/" target="_blank" rel="noopener">the pricing admin</a>, or add a network card in step 9.</p>`;
  } else {
    const faster = bestAvailable && bestAvailable.topGb > (net?.topGb ?? 0) ? bestAvailable : null;
    head = (net
      ? `<p class="select-prompt">${escapeHtml(model.id)} ships with ${escapeHtml(net.builtIn)} —
           the fastest link this build has out of the box.</p>`
      : `<p class="field-warn">⚠ No built-in network ports recorded for ${escapeHtml(model.id)}.</p>`) +
      (nic
        ? `<p class="hint">Network card added: <b>${escapeHtml(nic.name)}</b> (${inr(nic.min)} – ${inr(nic.quote)} each) —
             reaches ${escapeHtml(labelForSpeed(nicTopGb) ?? nic.spec)}.</p>`
        : net?.upgrade
          ? `<p class="hint">Can reach ${escapeHtml(net.upgrade)}. Add a matching card in step 9 to quote it —
             the ability alone isn't priced.</p>`
          : "") +
      (faster
        ? `<p class="hint">Faster on the shortlist: <b>${escapeHtml(faster.model.id)}</b> has ${escapeHtml(faster.builtIn)}
           built in, if the customer needs the throughput.</p>`
        : "");
  }

  const choices = ["1GbE","2.5GbE","10GbE"].map(v => ({
    v,
    sub: effectiveTopGb >= parseFloat(v)
      ? (nicTopGb >= parseFloat(v) && (net?.topGb ?? 0) < parseFloat(v) ? "Supported with the network card added" : "Supported by this unit")
      : "Needs a faster unit or a card"
  }));

  $("secSpeed").innerHTML = head + `
    <div class="field">
      <span class="field-label">Print on the quotation as</span>
      <div class="tiles">
        ${choices.map(c => tile("speed", c.v, c.v, c.sub, answers.speed === c.v)).join("")}
        ${tile("speed", "Not sure — advise customer", "Not sure", "Flag for the technical team",
            answers.speed === "Not sure — advise customer")}
      </div>
    </div>`;
}

/* --- 8. drives --- */
function renderDrives(d){
  const b = d.build;
  const caps = PRICING.capacities;
  const lines = answers.driveCap ? validBrandsForCapacity(PRICING.hddPricing, answers.driveCap)
                                 : [...new Set(caps.flatMap(c => Object.keys(PRICING.hddPricing[c] || {})))];

  $("secDrives").innerHTML = `
    ${b ? `<p class="select-prompt">The suggestion uses ${b.drivesPerUnit}× ${b.driveCap} TB ${escapeHtml(b.driveLine)}.</p>` : ""}
    <div class="field">
      <span class="field-label">Drive capacity</span>
      <div class="tiles compact">
        ${tile("driveCap", "", "Auto", "Best value", answers.driveCap == null, "compact")}
        ${caps.map(c => tile("driveCap", c, `${c} TB`, "", answers.driveCap === c, "compact")).join("")}
      </div>
    </div>
    <div class="field">
      <span class="field-label">Drive line</span>
      <div class="tiles">
        ${tile("driveLine", "", "Auto", "Cheapest that fits", answers.driveLine == null)}
        ${lines.map(l => {
          const price = answers.driveCap ? PRICING.hddPricing[answers.driveCap][l] : null;
          return tile("driveLine", l, escapeHtml(l),
            price ? `${inr(price.min)} – ${inr(price.quote)} each` : "", answers.driveLine === l);
        }).join("")}
      </div>
      ${answers.driveCap == null && answers.driveLine
        ? `<p class="hint">Priced at whichever capacity the suggestion picks.</p>` : ""}
    </div>`;
}

/* --- 9. RAM & network upgrade --- */
function renderUpgrades(){
  const upgrades = PRICING.upgrades || [];
  const ramOptions = upgrades.filter(u => u.category === "RAM");
  const nicOptions = upgrades.filter(u => u.category === "NIC");

  const optionBlock = (label, name, options, current, describe) => options.length
    ? `<div class="field">
        <span class="field-label">${label}</span>
        <div class="tiles">
          ${tile(name, "", "None", "Not needed", current == null)}
          ${options.map(u => tile(name, u.sku, escapeHtml(u.name), describe(u), current === u.sku)).join("")}
        </div>
      </div>`
    : `<div class="field">
        <span class="field-label">${label}</span>
        <p class="hint">Nothing priced yet — add a product in the ${name === "ramSku" ? "RAM" : "NIC"} category in
          <a href="/admin/" target="_blank" rel="noopener">the pricing admin</a> and it appears here.</p>
      </div>`;

  $("secUpgrades").innerHTML =
    optionBlock("RAM upgrade", "ramSku", ramOptions, answers.ramSku,
      u => `${inr(u.min)} – ${inr(u.quote)} each`) +
    optionBlock("Network card", "nicSku", nicOptions, answers.nicSku, u => {
      const speed = labelForSpeed(topSpeed(`${u.name} ${u.spec}`));
      return `${speed ? speed + " · " : ""}${inr(u.min)} – ${inr(u.quote)} each`;
    });
}

/* --- 10. add-ons --- */
function renderAddons(){
  const amc = `${Math.round(PRICING.amcRate.min*100)}% – ${Math.round(PRICING.amcRate.quote*100)}%`;
  $("secAddons").innerHTML = `
    <label class="addon-row ${answers.includeInstall ? "on" : ""}">
      <span class="addon-left">
        <input type="checkbox" name="includeInstall"${answers.includeInstall ? " checked" : ""}>
        <span>
          <span class="addon-title">On-site installation &amp; setup</span>
          <span class="addon-sub">Racking, RAID configuration, network setup. Charged per NAS unit.</span>
        </span>
      </span>
      <span class="addon-price">${inr(PRICING.install.min)} – ${inr(PRICING.install.quote)}</span>
    </label>

    <label class="addon-row ${answers.includeAMC ? "on" : ""}">
      <span class="addon-left">
        <input type="checkbox" name="includeAMC"${answers.includeAMC ? " checked" : ""}>
        <span>
          <span class="addon-title">AMC — annual maintenance cost</span>
          <span class="addon-sub">Percentage of the hardware subtotal — installation is not marked up.</span>
        </span>
      </span>
      <span class="addon-price">${amc} of hardware</span>
    </label>`;
}

/* --- 10. details (rendered once; redrawing would move the caret) --- */
function renderDetails(){
  $("secDetails").innerHTML = `
    <div class="field">
      <div class="grid-2">
        <div>
          <span class="field-label">Customer / company name</span>
          <input type="text" name="custName" value="${escapeAttr(answers.custName)}" placeholder="e.g. Aarav Enterprises" autocomplete="off">
        </div>
        <div>
          <span class="field-label">Location</span>
          <input type="text" name="custLocation" value="${escapeAttr(answers.custLocation)}" placeholder="City" autocomplete="off">
        </div>
      </div>
    </div>
    <div class="field">
      <div class="grid-2">
        <div>
          <span class="field-label">Prepared by</span>
          <input type="text" name="repName" value="${escapeAttr(answers.repName)}" placeholder="Sales rep name" autocomplete="off">
        </div>
        <div>
          <span class="field-label">Quote validity</span>
          <div class="tiles compact">
            ${["7 days","15 days","30 days"].map(v =>
              tile("validity", v, v, "", answers.validity === v, "compact")).join("")}
          </div>
        </div>
      </div>
    </div>`;
}

/** Redraws every section that reacts to an answer, then the quotation. */
function renderAll(){
  const active = document.activeElement;
  const focusName = active && active.name ? active.name : null;
  const focusValue = active ? active.value : null;

  const d = derive();
  renderStorage(d);
  renderBrand();
  renderBays(d);
  renderRaid();
  renderExpand(d);
  renderModel(d);
  renderSpeed(d);
  renderDrives(d);
  renderUpgrades();
  renderAddons();
  renderQuote(d);

  if(focusName){
    const group = [...document.getElementsByName(focusName)];
    const el = group.find(n => n.value === focusValue) || group[0];
    if(el && el !== document.activeElement && !el.closest("#secDetails")) el.focus({ preventScroll:true });
  }
}

/* ================= quotation panel ================= */

function renderQuote(d = derive()){
  const { build, model, price } = d;
  const priced = !!build && !d.error;

  $("quoteRef").textContent = (priced ? "Draft · " : "Not yet priced · ") +
    new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});

  const ram = build ? selectedRam() : null;
  const nic = build ? selectedNic() : null;

  const rows = build ? [
    [`NAS unit${build.units > 1 ? " × " + build.units : ""}`, build.model.id, price.nasQuote, price.nasMin],
    [`Hard drives × ${price.totalDrives}`, `${build.driveCap}TB ${build.driveLine}`, price.hddQuote, price.hddMin]
  ] : [];
  if(ram) rows.push([`RAM upgrade × ${build.units}`, ram.name, price.ramQuote, price.ramMin]);
  if(nic) rows.push([`Network card × ${build.units}`, nic.name, price.nicQuote, price.nicMin]);
  if(build && answers.includeInstall) rows.push(["Installation & setup", "", price.installQuote, price.installMin]);
  if(build && answers.includeAMC)     rows.push(["AMC (annual maintenance)", "", price.amcQuote, price.amcMin]);

  /* The unit leads: it is what the customer is being sold, and what they ask
     about first. Everything under it is either what the unit delivers or the
     answers that led to it. */
  const headline = build
    ? `<div class="qs-headline">
         <span class="qs-model">${escapeHtml(build.model.id)}${build.units > 1 ? ` × ${build.units}` : ""}</span>
         <span class="qs-brand">${escapeHtml(build.model.brand)} · ${build.model.bays}-bay</span>
       </div>`
    : `<div class="qs-headline empty"><span class="qs-model">No unit yet</span>
         <span class="qs-brand">Choose one in section 6</span></div>`;

  const summaryRows = [
    ["Drives", build ? `${price.totalDrives}× ${build.driveCap}TB ${build.driveLine}` : "—", true],
    ["Usable delivered", build ? `${build.totalUsable} TB` : "—", true],
    ["Network", answers.speed || "—", true],
    ["RAID", answers.raid, true],
    ["Target usable", `${answers.targetTB} TB`, true]
  ];
  if(answers.storageMode === "budget") summaryRows.push(["Budget", inr(answers.budget), true]);
  if(ram) summaryRows.push(["RAM upgrade", ram.name, false]);
  if(nic) summaryRows.push(["Network card", nic.name, false]);
  summaryRows.push(
    ["Brand asked for", answers.brand === "any" ? "No preference" : answers.brand, false],
    ["Bays asked for", answers.bays == null ? "Auto" : `${answers.bays}-bay`, false],
    ["Expandable", answers.expandable ? "Required" : "Not required", false],
    ["Valid for", answers.validity, false]
  );

  $("quoteSummary").innerHTML = headline + summaryRows.map(([k,v,mono]) =>
    `<div class="qs-row"><span class="k">${k}</span><span class="v${mono ? " mono" : ""}">${escapeHtml(v)}</span></div>`
  ).join("");

  $("priceTableBody").innerHTML = priced
    ? rows.map(([label, note, max, min]) =>
        `<tr><td>${escapeHtml(label)}${note ? `<span class="item-note">${escapeHtml(note)}</span>` : ""}</td>` +
        `<td class="mono">${inr(max)}</td><td class="mono">${inr(min)}</td></tr>`
      ).join("")
    : `<tr class="pending"><td>NAS unit</td><td class="mono">—</td><td class="mono">—</td></tr>
       <tr class="pending"><td>Hard drives</td><td class="mono">—</td><td class="mono">—</td></tr>`;

  $("grandMax").textContent = priced ? inr(price.grandQuote) : "—";
  $("grandMin").textContent = priced ? inr(price.grandMin) : "—";
  $("rtAmount").textContent = priced ? inr(price.grandQuote) : "—";

  $("generatePdf").disabled = !priced;
  $("quotePanel").classList.toggle("unpriced", !priced);
  $("runningTotal").classList.toggle("unpriced", !priced);

  if(d.error) statusMsg(d.error, "err");
  else if(!priced) statusMsg("No unit fits these choices yet.", "");
  else if(/can't be built|No unit fits/.test($("pdfStatus").textContent)) statusMsg("", "");

  ui.lastQuote = !priced ? null : {
    targetTB: answers.targetTB,
    raid: answers.raid, raidLabel: RAID_INFO[answers.raid].label,
    speed: answers.speed || "Not specified",
    model, units: build.units, drivesPerUnit: build.drivesPerUnit, totalDrives: price.totalDrives,
    driveCap: build.driveCap, driveBrand: build.driveLine,
    usableDelivered: build.totalUsable, exceeded: build.units > 1,
    /* The customer document carries quantity and rate per line, and only the
       quote price. The minimum is the rep's negotiating floor and never leaves
       the building — it is deliberately absent from this payload. */
    lines: quotationLines(build, price),
    grandQuote: price.grandQuote,
    expandable: answers.expandable,
    cust: {
      name: answers.custName.trim(), location: answers.custLocation.trim(),
      rep: answers.repName.trim(), validity: answers.validity
    }
  };
}

/** The priced lines as a customer would read them: what, how many, at what rate. */
function quotationLines(build, price){
  const drive = PRICING.hddPricing[build.driveCap]?.[build.driveLine] ?? { quote: 0 };
  const lines = [
    {
      description: `${build.model.id} — ${build.model.brand} ${build.model.bays}-bay NAS`,
      detail: build.model.network ? `Network: ${build.model.network}` : "",
      qty: build.units,
      rate: build.model.quote,
      amount: price.nasQuote
    },
    {
      description: `${build.driveCap} TB ${build.driveLine} NAS hard drive`,
      detail: `${build.drivesPerUnit} per unit, configured as ${answers.raid}`,
      qty: price.totalDrives,
      rate: drive.quote,
      amount: price.hddQuote
    }
  ];

  const ram = selectedRam();
  if(ram){
    lines.push({
      description: ram.name,
      detail: [ram.brand, ram.spec].filter(Boolean).join(" · ") || "RAM upgrade",
      qty: build.units,
      rate: ram.quote,
      amount: price.ramQuote
    });
  }

  const nic = selectedNic();
  if(nic){
    lines.push({
      description: nic.name,
      detail: [nic.brand, nic.spec].filter(Boolean).join(" · ") || "Network card",
      qty: build.units,
      rate: nic.quote,
      amount: price.nicQuote
    });
  }

  if(answers.includeInstall){
    lines.push({
      description: "On-site installation & setup",
      detail: "Racking, RAID configuration, network setup",
      qty: build.units,
      rate: PRICING.install.quote,
      amount: price.installQuote
    });
  }
  if(answers.includeAMC){
    lines.push({
      description: "Annual maintenance cost (AMC)",
      detail: `${Math.round(PRICING.amcRate.quote * 100)}% of hardware value`,
      qty: null,
      rate: null,
      amount: price.amcQuote
    });
  }
  return lines;
}

function openQuote(){ $("quotePanel").classList.add("open"); $("scrim").hidden = false; }
function closeQuote(){ $("quotePanel").classList.remove("open"); $("scrim").hidden = true; }

/* ================= PDF ================= */

function statusMsg(text, cls){
  const el = $("pdfStatus");
  el.textContent = text;
  el.className = "pdf-status" + (cls ? " " + cls : "");
}

async function handleGeneratePdf(){
  const q = ui.lastQuote;
  if(!q || !q.model){ statusMsg("Nothing to quote yet.", "err"); return; }
  if(!window.jspdf){ statusMsg("PDF library didn't load — check your connection.", "err"); return; }

  const btn = $("generatePdf");
  btn.disabled = true;
  statusMsg("Building PDF…");
  try{
    const doc = await buildPdf({ ...q, ref: quoteRef() });
    doc.save(quoteFilename(q.cust.name));
    statusMsg("Downloaded.", "ok");
  }catch(e){
    console.error(e);
    statusMsg("Couldn't build the PDF — see the console.", "err");
  }finally{
    btn.disabled = false;
  }
}

/* ================= events ================= */

function onChange(e){
  const el = e.target;
  const name = el.name;
  if(!name) return;

  if(el.type === "checkbox")       answers[name] = el.checked;
  else if(name === "bays")         answers.bays = el.value === "" ? null : Number(el.value);
  else if(name === "driveCap")     answers.driveCap = el.value === "" ? null : Number(el.value);
  else if(name === "driveLine")    answers.driveLine = el.value === "" ? null : el.value;
  else if(name === "ramSku")       answers.ramSku = el.value === "" ? null : el.value;
  else if(name === "nicSku")       answers.nicSku = el.value === "" ? null : el.value;
  else if(name === "modelId"){     answers.modelId = el.value; answers.autoPick = false; }
  else if(name === "raid"){
    answers.raid = el.value;
    // Picking a level by hand in budget mode overrides the automatic choice
    // until the rep asks for it back — see the "Let the tool choose again" link.
    if(answers.storageMode === "budget") answers.raidAuto = false;
  }
  else if(name === "storageMode"){
    answers.storageMode = el.value;
    if(el.value === "budget"){
      answers.raidAuto = true;
      if(!Number.isFinite(answers.budget) || answers.budget <= 0) answers.budget = 200000;
    }
  }
  else                             answers[name] = el.value;

  // The recorded speed belongs to a unit, so a new unit — or a new card — re-reads it.
  if(["modelId","brand","raid","bays","nicSku"].includes(name)) answers.speed = null;

  if(el.closest("#secDetails")){
    syncTileSelection(name);
    renderQuote();
  } else {
    renderAll();
  }
}

/** Moves the selected highlight within a radio group without re-rendering it. */
function syncTileSelection(name){
  [...document.getElementsByName(name)].forEach(input => {
    const tile = input.closest(".tile, .model-card, .addon-row");
    if(!tile) return;
    tile.classList.toggle(tile.classList.contains("addon-row") ? "on" : "selected", input.checked);
  });
}

function bindEvents(){
  const main = document.querySelector(".sections");

  main.addEventListener("change", onChange);

  main.addEventListener("input", e => {
    if(e.target.type === "text"){
      answers[e.target.name] = e.target.value;
      renderQuote();
    } else if(e.target.id === "budgetInput"){
      const v = Number(e.target.value);
      answers.budget = e.target.value !== "" && Number.isFinite(v) ? v : null;
      renderAll();
    }
  });

  main.addEventListener("change", e => {
    if(e.target.id === "storageSelect"){
      answers.targetTB = Number(e.target.value);
      ui.storageMoved = null;                 // this one was deliberate
      renderAll();
    }
  });

  main.addEventListener("click", e => {
    const chip = e.target.closest("[data-preset]");
    if(chip){
      answers.targetTB = Number(chip.dataset.preset);
      ui.storageMoved = null;
      renderAll();
      return;
    }
    const budgetChip = e.target.closest("[data-budget-preset]");
    if(budgetChip){
      answers.budget = Number(budgetChip.dataset.budgetPreset);
      renderAll();
      return;
    }
    if(e.target.id === "resetPick"){
      answers.autoPick = true;
      renderAll();
      return;
    }
    if(e.target.id === "resetRaid"){
      answers.raidAuto = true;
      renderAll();
    }
  });

  $("generatePdf").addEventListener("click", handleGeneratePdf);
  $("refreshPrices").addEventListener("click", () => refreshPrices());
  $("openQuote").addEventListener("click", openQuote);
  $("closeQuote").addEventListener("click", closeQuote);
  $("scrim").addEventListener("click", closeQuote);
  document.addEventListener("keydown", e => { if(e.key === "Escape") closeQuote(); });
}

/* ================= helpers ================= */

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}
const escapeAttr = escapeHtml;

/* ================= admin link ================= */

async function showSignedInUser(){
  try{
    const res = await fetch("/api/auth/me", { cache:"no-store" });
    if(!res.ok) return;
    const { user } = await res.json();
    if(!user) return;
    $("adminLabel").innerHTML = `<span class="who">${escapeHtml(user.name || user.email)}</span>`;
    $("adminLink").title = `Signed in as ${user.email} (${user.role})`;
  }catch(e){ /* no backend: the button still links to the admin */ }
}

/* ================= init ================= */

async function init(){
  applyPricing(await loadPricing());
  bindEvents();
  renderDetails();
  renderAll();
  startAutoRefresh();
  showSignedInUser();
}

/* Exported so tests can await start-up; the browser just runs it. */
export const __ready = init();
