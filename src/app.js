import { loadPricing } from "./pricing.js";
import { AUTO_REFRESH_MS } from "./config.js";
import {
  RAID_INFO, USE_CASE_INFO, inr, computeDrives, bayTierFor,
  validBrandsForCapacity, candidateModels, priceQuote
} from "./logic.js";
import { buildPdf, quoteRef, quoteFilename } from "./pdf.js";

const $ = id => document.getElementById(id);

let PRICING = null;                    // set in init()

/* Every answer lives here; the UI is drawn from it. Text inputs are the one
 * exception — they write into state on input but are not redrawn, so the caret
 * stays put while someone is typing. */
const answers = {
  targetTB: 20,
  useCase: "general",
  raid: "RAID1",
  driveCap: 8,
  driveBrand: null,
  speed: "1GbE",
  expandable: false,
  includeInstall: true,
  includeRMA: false,
  modelId: null,
  custName: "", custLocation: "", repName: "", validity: "15 days"
};

const ui = { step: 1, maxStep: 1, lastQuote: null, priceSource: null };

const STEPS = [
  { key:"storage", label:"Storage",  eyebrow:"Step 1",
    title:"How much storage does the customer need?",
    blurb:"Set the usable capacity they need today, then pick what the system is for — it pre-fills a sensible RAID level and network speed." },
  { key:"drives",  label:"Drives",   eyebrow:"Step 2",
    title:"RAID level and disks",
    blurb:"These decide how many drives are needed and which chassis size the quote lands on. Every default is overridable." },
  { key:"model",   label:"Unit",     eyebrow:"Step 3",
    title:"Pick the NAS unit",
    blurb:"Units in the price sheet that fit the bay count and RAID level above, cheapest first." },
  { key:"addons",  label:"Add-ons",  eyebrow:"Step 4",
    title:"Services to include",
    blurb:"Both are optional and priced from the sheet." },
  { key:"details", label:"Details",  eyebrow:"Step 5",
    title:"Who is this quote for?",
    blurb:"These appear on the PDF header." }
];

const CAPACITY_NOTE = { 2:"Entry", 4:"Common", 6:"", 8:"Popular", 10:"", 12:"High density", 16:"Max density" };

const SPEEDS = [
  { v:"1GbE",   sub:"Standard office network" },
  { v:"2.5GbE", sub:"Multi-user media work" },
  { v:"10GbE",  sub:"Virtualization, low latency" },
  { v:"Not sure — advise customer", sub:"Flag for the technical team" }
];

/* ================= price list freshness ================= */

function applyPricing(result){
  PRICING = result.data;
  ui.priceSource = result.source;

  const note = $("dataSyncNote");
  note.textContent = result.note;
  note.classList.toggle("stale", !!result.stale);

  // Parser complaints from the Apps Script (a skipped model, a missing header row)
  // belong in front of the rep, not only in the console.
  const warnEl = $("priceWarnings");
  const warnings = result.warnings || [];
  warnEl.hidden = !warnings.length;
  if(warnings.length){
    warnEl.innerHTML = "<span>⚠</span><span><b>Price sheet:</b> " +
      warnings.map(escapeHtml).join(" ") + "</span>";
    console.warn("[pricing] sheet warnings:", warnings);
  }

  // The sheet may have dropped the capacity or drive line that was selected.
  if(!PRICING.capacities.includes(answers.driveCap)){
    answers.driveCap = PRICING.capacities.includes(8) ? 8 : PRICING.capacities[0];
  }
  const brands = validBrandsForCapacity(PRICING.hddPricing, answers.driveCap);
  if(!brands.includes(answers.driveBrand)) answers.driveBrand = brands[0] ?? null;
}

/** Re-reads the price list and redraws, keeping the rep's current answers.
 *  `silent` is used by the background refresh so a quiet poll doesn't flicker
 *  the panel mid-call. */
async function refreshPrices({ silent = false } = {}){
  const btn = $("refreshPrices");
  if(!silent){
    btn.disabled = true;
    $("dataSyncNote").textContent = "Fetching latest prices…";
  }
  try{
    applyPricing(await loadPricing());
    lastFetchAt = Date.now();
    renderStep();
    renderQuote();
  }finally{
    btn.disabled = false;
  }
}

/* Keeps a long-open tab honest: poll on an interval, and catch up when the rep
 * returns to a tab that has been in the background. Both skip while hidden, so
 * an idle tab isn't hammering the endpoint all night. */
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

/** Everything the current answers imply — recomputed rather than stored. */
function derive(){
  const calc = computeDrives(answers.raid, answers.driveCap, answers.targetTB);
  const tier = bayTierFor(calc.bayNeed);
  const candidates = candidateModels(PRICING.models, tier, answers.raid, answers.expandable);

  if(candidates.length && !candidates.some(m => m.id === answers.modelId)){
    answers.modelId = candidates[0].id;
  }
  if(!candidates.length) answers.modelId = null;

  const model = PRICING.models.find(m => m.id === answers.modelId) || null;
  const price = priceQuote({
    model, calc,
    drivePrice: PRICING.hddPricing[answers.driveCap]?.[answers.driveBrand],
    install: PRICING.install,
    rmaRate: PRICING.rmaRate,
    includeInstall: answers.includeInstall,
    includeRMA: answers.includeRMA
  });

  return { calc, tier, candidates, model, price };
}

/* ================= step rendering ================= */

function tile(name, value, title, sub, selected, extraClass = ""){
  return `<label class="tile ${extraClass} ${selected ? "selected" : ""}">
    <input type="radio" name="${name}" value="${escapeAttr(value)}"${selected ? " checked" : ""}>
    <span class="tile-title">${title}</span>
    ${sub ? `<span class="tile-sub">${sub}</span>` : ""}
  </label>`;
}

function renderStep(){
  const step = STEPS[ui.step - 1];
  const d = derive();

  $("stepBody").innerHTML =
    `<div class="step-head">
       <div class="step-eyebrow">${step.eyebrow} of ${STEPS.length}</div>
       <h2>${step.title}</h2>
       <p>${step.blurb}</p>
     </div>` + STEP_BODY[step.key](d);

  renderProgress();
  renderNav(d);
}

const STEP_BODY = {
  storage(){
    const presets = [10, 20, 50, 100];
    return `
      <div class="field">
        <span class="field-label">Usable storage needed</span>
        <div class="storage-row">
          <div class="storage-value mono">${answers.targetTB}<small>TB</small></div>
          <div class="slider-wrap">
            <input type="range" id="storageRange" min="2" max="200" step="1"
                   value="${answers.targetTB}" aria-label="Usable storage in terabytes">
            <div class="range-scale"><span>2 TB</span><span>200 TB</span></div>
          </div>
        </div>
        <div class="presets">
          ${presets.map(p =>
            `<button type="button" class="chip${answers.targetTB === p ? " on" : ""}" data-preset="${p}">${p} TB</button>`
          ).join("")}
        </div>
      </div>

      <div class="field">
        <span class="field-label">What will they mainly use it for?</span>
        <div class="tiles cols-2">
          ${[
            ["general","General file sharing &amp; backup","Everyday shared storage"],
            ["media","Media &amp; video editing","Large files, multiple editors"],
            ["surveillance","Surveillance / CCTV","Continuous camera recording"],
            ["virtualization","Virtualization &amp; business apps","VMs and business-critical loads"],
            ["archival","Archival / cold backup","Long-term retention"],
            ["database","Database / trading","Low-latency, high-write"]
          ].map(([v,t,s]) => tile("useCase", v, t, s, answers.useCase === v)).join("")}
        </div>
        <p class="hint">${USE_CASE_INFO[answers.useCase].note}</p>
      </div>`;
  },

  drives(){
    const brands = validBrandsForCapacity(PRICING.hddPricing, answers.driveCap);
    return `
      <div class="field">
        <span class="field-label">RAID level</span>
        <div class="tiles">
          ${[
            ["RAID0","RAID 0","Striping · no redundancy"],
            ["RAID1","RAID 1","Mirrored · 50% usable"],
            ["RAID5","RAID 5","Parity · survives 1 failure"],
            ["RAID6","RAID 6","Dual parity · survives 2"],
            ["RAID10","RAID 10","Mirror + stripe · fast rebuild"]
          ].map(([v,t,s]) => tile("raid", v, t, s, answers.raid === v)).join("")}
        </div>
        <p class="hint">${RAID_INFO[answers.raid].label}</p>
      </div>

      <div class="field">
        <span class="field-label">Drive capacity, per disk</span>
        <div class="tiles compact">
          ${PRICING.capacities.map(c =>
            tile("driveCap", c, `${c} TB`, CAPACITY_NOTE[c] || "", answers.driveCap === c, "compact")
          ).join("")}
        </div>
      </div>

      <div class="field">
        <span class="field-label">Drive line</span>
        <div class="tiles">
          ${brands.length
            ? brands.map(b => {
                const p = PRICING.hddPricing[answers.driveCap][b];
                return tile("driveBrand", b, b, `${inr(p.min)} – ${inr(p.quote)} each`, answers.driveBrand === b);
              }).join("")
            : `<p class="hint">No drive line is priced at ${answers.driveCap} TB in the sheet.</p>`}
        </div>
      </div>

      <div class="field">
        <span class="field-label">Network speed the customer needs</span>
        <div class="tiles">
          ${SPEEDS.map(s => tile("speed", s.v, s.v, s.sub, answers.speed === s.v)).join("")}
        </div>
        <p class="hint">Captured as a requirement note on the quote — not matched against per-model NIC specs.</p>
      </div>

      <div class="field">
        <label class="tile tile-check ${answers.expandable ? "selected" : ""}">
          <input type="checkbox" name="expandable"${answers.expandable ? " checked" : ""}>
          <span>
            <span class="tile-title">Customer wants room to expand later</span>
            <span class="tile-sub">Floats expansion-capable units to the top of the list</span>
          </span>
        </label>
      </div>`;
  },

  model(d){
    const warning = d.calc.exceeded
      ? `<div class="banner"><span>⚠</span><span><b>${d.calc.units}× ${d.tier}-bay units needed.</b>
          ${answers.driveCap} TB drives in ${answers.raid} top out around ${d.calc.usablePerUnit} TB usable per
          chassis — this target needs multiple units, or larger drives. Pricing is scaled to ${d.calc.units} units.</span></div>`
      : "";

    const list = d.candidates.length
      ? d.candidates.map((m, i) => `
          <label class="model-card ${m.id === answers.modelId ? "selected" : ""}">
            <input type="radio" name="modelId" value="${escapeAttr(m.id)}"${m.id === answers.modelId ? " checked" : ""}>
            <span class="model-main">
              <span class="model-title-row">
                <span class="model-name">${escapeHtml(m.id)}</span>
                <span class="badge badge-brand">${escapeHtml(m.brand)}</span>
                ${i === 0 && !answers.expandable ? '<span class="badge badge-best">Best price</span>' : ""}
                ${m.expandable ? '<span class="badge badge-expand">Expandable</span>' : ""}
              </span>
              <span class="model-meta">${m.bays}-bay · ${d.calc.drivesPerUnit} of ${m.bays} bays used · supports ${m.raid.join(", ").replace(/RAID/g,"R")}</span>
            </span>
            <span class="model-price">
              <span class="max mono">${inr(m.quote * d.calc.units)}</span>
              <span class="min mono">${inr(m.minTax * d.calc.units)} min</span>
            </span>
          </label>`).join("")
      : `<p class="hint">No unit in the price sheet has ${d.tier} bays with ${answers.raid} support.
         Go back and widen the RAID level or use a larger drive.</p>`;

    return warning + `<div class="model-list">${list}</div>`;
  },

  addons(){
    const rma = `${Math.round(PRICING.rmaRate.min*100)}% – ${Math.round(PRICING.rmaRate.quote*100)}%`;
    return `
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

      <label class="addon-row ${answers.includeRMA ? "on" : ""}">
        <span class="addon-left">
          <input type="checkbox" name="includeRMA"${answers.includeRMA ? " checked" : ""}>
          <span>
            <span class="addon-title">Extended RMA coverage</span>
            <span class="addon-sub">Percentage of the hardware subtotal — installation is not marked up.</span>
          </span>
        </span>
        <span class="addon-price">${rma} of hardware</span>
      </label>`;
  },

  details(){
    return `
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
                tile("validity", v, v, "", answers.validity === v, "compact")
              ).join("")}
            </div>
          </div>
        </div>
      </div>`;
  }
};

/* ================= chrome ================= */

function renderProgress(){
  const full = STEPS.map((s, i) => {
    const n = i + 1;
    const cls = n === ui.step ? "current" : n < ui.step ? "done" : "";
    const reachable = n <= ui.maxStep;
    return `<button type="button" class="pstep ${cls}" data-goto="${n}"${reachable ? "" : " disabled"}
              ${n === ui.step ? 'aria-current="step"' : ""}>
        <span class="pdot">${n < ui.step ? "✓" : n}</span>
        <span class="plabel">${s.label}</span>
      </button>`;
  }).join("");

  const pct = (ui.step / STEPS.length) * 100;
  $("progress").innerHTML =
    `<div class="progress">${full}</div>
     <div class="progress-compact">
       <span class="pc-text">Step ${ui.step} / ${STEPS.length}</span>
       <span class="pc-track"><span class="pc-fill" style="width:${pct}%"></span></span>
       <span class="pc-text">${STEPS[ui.step-1].label}</span>
     </div>`;
}

function renderNav(d){
  const last = ui.step === STEPS.length;
  $("backBtn").disabled = ui.step === 1;
  $("stepCount").textContent = `${ui.step} of ${STEPS.length}`;
  $("nextLabel").textContent = last ? "Download PDF" : "Next";
  $("nextBtn").disabled = ui.step === 3 && !d.model;
}

function goTo(step){
  ui.step = Math.min(Math.max(step, 1), STEPS.length);
  ui.maxStep = Math.max(ui.maxStep, ui.step);
  renderStep();
  renderQuote();
  document.querySelector(".stage")?.scrollIntoView({ block:"start", behavior:"smooth" });
}

/* ================= quotation panel ================= */

/* The panel fills in as the rep works. Until they have actually reached the unit
 * step, nothing has been chosen — showing a priced quote there would put a total
 * in front of the customer that nobody selected, and would let the rep send a PDF
 * for a configuration they never picked. So earlier steps show what is known and
 * leave the money blank. */
function isPriced(){ return ui.maxStep >= 3; }

function renderQuote(){
  const d = derive();
  const { calc, model, price } = d;
  const priced = isPriced();

  $("quoteRef").textContent = (priced ? "Draft · " : "Not yet priced · ") +
    new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});

  const useCaseLabel = {
    general:"General file sharing & backup", media:"Media / video editing",
    surveillance:"Surveillance / CCTV", virtualization:"Virtualization & business apps",
    archival:"Archival / cold backup", database:"Database / trading systems"
  }[answers.useCase];

  // Each summary row appears once the step that decides it has been completed.
  const done = ui.maxStep;
  const summary = [
    ["Target usable", `${answers.targetTB} TB`, true, done >= 1],
    ["Use case", useCaseLabel, false, done >= 1],
    ["RAID", answers.raid, true, done >= 2],
    ["Drives", answers.driveBrand
        ? `${price.totalDrives}× ${answers.driveCap}TB ${answers.driveBrand}`
        : "—", true, done >= 2],
    ["Usable delivered", usableLine(calc), true, done >= 2],
    ["NAS unit", model ? `${model.id}${calc.units > 1 ? ` × ${calc.units}` : ""}` : "—", true, done >= 3]
  ];

  $("quoteSummary").innerHTML = summary
    .filter(([,,, show]) => show)
    .map(([k, v, mono]) =>
      `<div class="qs-row"><span class="k">${k}</span><span class="v${mono ? " mono" : ""}">${escapeHtml(v)}</span></div>`
    ).join("") ||
    `<p class="panel-empty">Answer the first step and the quotation builds here.</p>`;

  const rows = [
    [`NAS unit${calc.units > 1 ? " × " + calc.units : ""}`, model ? model.id : "—", price.nasQuote, price.nasMin],
    [`Hard drives × ${price.totalDrives}`, `${answers.driveCap}TB ${answers.driveBrand ?? "—"}`, price.hddQuote, price.hddMin]
  ];
  if(answers.includeInstall) rows.push(["Installation & setup", "", price.installQuote, price.installMin]);
  if(answers.includeRMA)     rows.push(["Extended RMA coverage", "", price.rmaQuote, price.rmaMin]);

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

  const pdfBtn = $("generatePdf");
  pdfBtn.disabled = !priced || !model;
  $("quotePanel").classList.toggle("unpriced", !priced);
  $("runningTotal").classList.toggle("unpriced", !priced);
  if(!priced) statusMsg("Pick a NAS unit in step 3 to price the quote.", "");
  else if($("pdfStatus").textContent.startsWith("Pick a NAS unit")) statusMsg("", "");

  ui.lastQuote = !priced ? null : {
    targetTB: answers.targetTB, useCaseLabel,
    raid: answers.raid, raidLabel: RAID_INFO[answers.raid].label, speed: answers.speed,
    model, units: calc.units, drivesPerUnit: calc.drivesPerUnit, totalDrives: price.totalDrives,
    driveCap: answers.driveCap, driveBrand: answers.driveBrand,
    usableDelivered: calc.totalUsable, exceeded: calc.exceeded,
    rows: rows.map(([label, note, max, min]) => [note ? `${label} (${note})` : label, max, min]),
    grandQuote: price.grandQuote, grandMin: price.grandMin, expandable: answers.expandable,
    cust: {
      name: answers.custName.trim(), location: answers.custLocation.trim(),
      rep: answers.repName.trim(), validity: answers.validity
    }
  };
}

/** RAID minimums mean the delivered capacity often overshoots the target — say so
 *  rather than leaving the rep to explain an unexplained number to the customer. */
function usableLine(calc){
  const over = calc.totalUsable - answers.targetTB;
  if(over <= 0) return `${calc.totalUsable} TB`;
  const min = RAID_INFO[answers.raid].minDrives;
  return `${calc.totalUsable} TB (${answers.raid} needs ${min}+ drives)`;
}

/* mobile bottom sheet */
function openQuote(){
  $("quotePanel").classList.add("open");
  $("scrim").hidden = false;
}
function closeQuote(){
  $("quotePanel").classList.remove("open");
  $("scrim").hidden = true;
}

/* ================= PDF ================= */

function statusMsg(text, cls){
  const el = $("pdfStatus");
  el.textContent = text;
  el.className = "pdf-status" + (cls ? " " + cls : "");
}

function handleGeneratePdf(){
  const q = ui.lastQuote;
  if(!q || !q.model){
    statusMsg("Reach step 3 and pick a NAS unit first.", "err");
    return;
  }
  if(!window.jspdf){
    statusMsg("PDF library didn't load — check your connection.", "err");
    return;
  }
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

/** Answers that change which options exist need the step redrawn; the rest only
 *  affect the quotation panel. */
const REDRAWS_STEP = new Set(["useCase","raid","driveCap","expandable","includeInstall","includeRMA","modelId"]);

function onStepInput(e){
  const el = e.target;
  const name = el.name;
  if(!name) return;

  if(el.type === "checkbox")      answers[name] = el.checked;
  else if(name === "driveCap")    answers.driveCap = Number(el.value);
  else if(name === "targetTB")    answers.targetTB = Number(el.value);
  else                            answers[name] = el.value;

  // Picking a use case re-applies its defaults; the rep can still override both.
  if(name === "useCase"){
    answers.raid = USE_CASE_INFO[el.value].raid;
    answers.speed = USE_CASE_INFO[el.value].speed;
  }
  // A capacity with a different set of priced drive lines needs a valid line.
  if(name === "driveCap"){
    const brands = validBrandsForCapacity(PRICING.hddPricing, answers.driveCap);
    if(!brands.includes(answers.driveBrand)) answers.driveBrand = brands[0] ?? null;
  }

  if(REDRAWS_STEP.has(name)) renderStep();
  renderQuote();
}

function bindEvents(){
  const body = $("stepBody");

  body.addEventListener("change", onStepInput);

  // live feedback while dragging the slider and while typing
  body.addEventListener("input", e => {
    if(e.target.id === "storageRange"){
      answers.targetTB = Number(e.target.value);
      const v = body.querySelector(".storage-value");
      if(v) v.innerHTML = `${answers.targetTB}<small>TB</small>`;
      body.querySelectorAll("[data-preset]").forEach(c =>
        c.classList.toggle("on", Number(c.dataset.preset) === answers.targetTB));
      renderQuote();
    } else if(e.target.type === "text"){
      answers[e.target.name] = e.target.value;
      renderQuote();
    }
  });

  body.addEventListener("click", e => {
    const chip = e.target.closest("[data-preset]");
    if(chip){
      answers.targetTB = Number(chip.dataset.preset);
      renderStep();
      renderQuote();
    }
  });

  $("progress").addEventListener("click", e => {
    const btn = e.target.closest("[data-goto]");
    if(btn && !btn.disabled) goTo(Number(btn.dataset.goto));
  });

  $("backBtn").addEventListener("click", () => goTo(ui.step - 1));
  $("nextBtn").addEventListener("click", () => {
    if(ui.step === STEPS.length){
      handleGeneratePdf();
      if(window.matchMedia("(max-width: 900px)").matches) openQuote();
    } else {
      goTo(ui.step + 1);
    }
  });

  $("generatePdf").addEventListener("click", handleGeneratePdf);
  $("refreshPrices").addEventListener("click", () => refreshPrices());
  $("openQuote").addEventListener("click", openQuote);
  $("closeQuote").addEventListener("click", closeQuote);
  $("scrim").addEventListener("click", closeQuote);

  document.addEventListener("keydown", e => {
    if(e.key === "Escape") closeQuote();
  });
}

/* ================= helpers ================= */

function escapeHtml(s){
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

/* ================= init ================= */

async function init(){
  applyPricing(await loadPricing());
  answers.raid = USE_CASE_INFO[answers.useCase].raid;
  answers.speed = USE_CASE_INFO[answers.useCase].speed;

  bindEvents();
  renderStep();
  renderQuote();
  startAutoRefresh();
}

/* Exported so tests can await start-up; the browser just runs it. */
export const __ready = init();
