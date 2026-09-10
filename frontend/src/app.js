import { loadPricing } from "./pricing.js";
import { AUTO_REFRESH_MS } from "./config.js";
import {
  RAID_INFO, inr, computeDrives, validBrandsForCapacity,
  suggestBuilds, bestBuildPerModel, networkFor, bestNetworkAmong,
  buildableSizes, nearestBuildable, MAX_UNITS
} from "./logic.js";
import { buildPdf, quoteRef, quoteFilename } from "./pdf.js";

const $ = id => document.getElementById(id);

let PRICING = null;                    // set in init()

/* Every answer lives here; the sections are drawn from it. Text inputs are the
 * one exception — they write into state on input but are never redrawn, so the
 * caret stays put while someone is typing. */
const answers = {
  targetTB: 20,
  brand: "any",
  bays: null,                          // null = let the tool choose the chassis
  raid: "RAID5",
  expandable: false,

  // Chosen by the suggestion, overridable in section 7.
  modelId: null,
  driveCap: null,
  driveLine: null,
  autoPick: true,                      // false once the rep picks a unit themselves

  speed: null,                         // what to print on the quote
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
      sizes, builds: [], options: [], build: null, model: null, price: zeroPrice()
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

  // Section 7 constrains the suggestion rather than fighting it.
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

  return { error: null, sizes, builds, options, build, model: build?.model ?? null, price: priceFor(build) };
}

function zeroPrice(){
  return { totalDrives:0, nasQuote:0, nasMin:0, hddQuote:0, hddMin:0,
           installQuote:0, installMin:0, amcQuote:0, amcMin:0,
           hwQuote:0, hwMin:0, grandQuote:0, grandMin:0 };
}

function priceFor(build){
  if(!build) return zeroPrice();
  const drive = PRICING.hddPricing[build.driveCap]?.[build.driveLine] ?? { quote:0, min:0 };
  const totalDrives = build.drivesPerUnit * build.units;

  const nasQuote = build.model.quote * build.units;
  const nasMin   = build.model.minTax * build.units;
  const hddQuote = drive.quote * totalDrives;
  const hddMin   = drive.min * totalDrives;

  const installQuote = answers.includeInstall ? PRICING.install.quote * build.units : 0;
  const installMin   = answers.includeInstall ? PRICING.install.min   * build.units : 0;

  const hwQuote = nasQuote + hddQuote;
  const hwMin   = nasMin + hddMin;
  const amcQuote = answers.includeAMC ? hwQuote * PRICING.amcRate.quote : 0;
  const amcMin   = answers.includeAMC ? hwMin   * PRICING.amcRate.min   : 0;

  return {
    totalDrives, nasQuote, nasMin, hddQuote, hddMin,
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

/* --- 1. storage --- */
function renderStorage(d){
  if(d.error){
    $("secStorage").innerHTML = `<p class="field-error">⚠ ${escapeHtml(d.error)}</p>`;
    return;
  }

  const presets = [10, 20, 50, 100].map(p => nearestBuildable(p, d.sizes))
    .filter((v, i, a) => v != null && a.indexOf(v) === i);

  const build = d.build;
  $("secStorage").innerHTML = `
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
  $("secRaid").innerHTML = `
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

  // Default to the fastest link the chosen unit actually has.
  if(answers.speed == null && net?.quotable) answers.speed = net.quotable;

  let head;
  if(!model){
    head = `<p class="hint">Pick a unit above and its network ports show here.</p>`;
  } else if(!net){
    head = `<p class="field-warn">⚠ No network ports recorded for ${escapeHtml(model.id)}. An admin can add them in
            <a href="/admin/" target="_blank" rel="noopener">the pricing admin</a>.</p>`;
  } else {
    const faster = bestAvailable && bestAvailable.topGb > net.topGb ? bestAvailable : null;
    head = `<p class="select-prompt">${escapeHtml(model.id)} ships with ${escapeHtml(net.builtIn)} —
              the fastest link this build has out of the box.</p>` +
      (net.upgrade
        ? `<p class="hint">Can reach ${escapeHtml(net.upgrade)}. The card isn't in this price list, so it isn't quoted.</p>`
        : "") +
      (faster
        ? `<p class="hint">Faster on the shortlist: <b>${escapeHtml(faster.model.id)}</b> has ${escapeHtml(faster.builtIn)}
           built in, if the customer needs the throughput.</p>`
        : "");
  }

  const choices = ["1GbE","2.5GbE","10GbE"].map(v => ({
    v,
    sub: net && net.topGb >= parseFloat(v) ? "Supported by this unit" : "Needs a faster unit or a card"
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

/* --- 9. add-ons --- */
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

  const rows = build ? [
    [`NAS unit${build.units > 1 ? " × " + build.units : ""}`, build.model.id, price.nasQuote, price.nasMin],
    [`Hard drives × ${price.totalDrives}`, `${build.driveCap}TB ${build.driveLine}`, price.hddQuote, price.hddMin]
  ] : [];
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
    ["Target usable", `${answers.targetTB} TB`, true],
    ["Brand asked for", answers.brand === "any" ? "No preference" : answers.brand, false],
    ["Bays asked for", answers.bays == null ? "Auto" : `${answers.bays}-bay`, false],
    ["Expandable", answers.expandable ? "Required" : "Not required", false],
    ["Valid for", answers.validity, false]
  ];

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
    rows: rows.map(([label, note, max, min]) => [note ? `${label} (${note})` : label, max, min]),
    grandQuote: price.grandQuote, grandMin: price.grandMin, expandable: answers.expandable,
    cust: {
      name: answers.custName.trim(), location: answers.custLocation.trim(),
      rep: answers.repName.trim(), validity: answers.validity
    }
  };
}

function openQuote(){ $("quotePanel").classList.add("open"); $("scrim").hidden = false; }
function closeQuote(){ $("quotePanel").classList.remove("open"); $("scrim").hidden = true; }

/* ================= PDF ================= */

function statusMsg(text, cls){
  const el = $("pdfStatus");
  el.textContent = text;
  el.className = "pdf-status" + (cls ? " " + cls : "");
}

function handleGeneratePdf(){
  const q = ui.lastQuote;
  if(!q || !q.model){ statusMsg("Nothing to quote yet.", "err"); return; }
  if(!window.jspdf){ statusMsg("PDF library didn't load — check your connection.", "err"); return; }

  const btn = $("generatePdf");
  btn.disabled = true;
  statusMsg("Building PDF…");
  try{
    buildPdf({ ...q, ref: quoteRef() }).save(quoteFilename(q.cust.name));
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
  else if(name === "modelId"){     answers.modelId = el.value; answers.autoPick = false; }
  else                             answers[name] = el.value;

  // The recorded speed belongs to a unit, so a new unit re-reads it.
  if(["modelId","brand","raid","bays"].includes(name)) answers.speed = null;

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
    if(e.target.id === "resetPick"){
      answers.autoPick = true;
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
