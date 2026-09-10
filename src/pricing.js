/* Pricing data source.
 *
 * Prices live in the "NAS COLD MESSAGE" Google Sheet and are edited there. An
 * Apps Script web app (apps-script/Code.gs) serves the Pricing tab as JSON, and
 * this module fetches it on every page load, so a price edited in the sheet is
 * quoted by the next rep to open the tool.
 *
 * Sources are tried in order, and the quote panel always says which one was used:
 *   1. the sheet endpoint          — live
 *   2. localStorage cache          — last good sheet response
 *   3. data/pricing.json           — checked-in transcription
 *   4. the built-in snapshot below — so the tool never opens empty
 */

import {
  SHEET_ENDPOINT, FETCH_TIMEOUT_MS, CACHE_KEY, CACHE_STALE_AFTER_MS, ENDPOINT_OVERRIDE_KEY
} from "./config.js";

export const FALLBACK = {
  updatedAt: null,
  models: [
    { id:"DS223J",      brand:"Synology", bays:2, quote:24000,  minTax:22420,  raid:["RAID0","RAID1"], expandable:false },
    { id:"DS225+",      brand:"Synology", bays:2, quote:42000,  minTax:40120,  raid:["RAID0","RAID1"], expandable:true  },
    { id:"DS725+",      brand:"Synology", bays:2, quote:94000,  minTax:89680,  raid:["RAID0","RAID1"], expandable:true  },
    { id:"TS-233-2G",   brand:"QNAP",     bays:2, quote:24000,  minTax:22420,  raid:["RAID0","RAID1"], expandable:false },
    { id:"TS-216G-4G",  brand:"QNAP",     bays:2, quote:29000,  minTax:27730,  raid:["RAID0","RAID1"], expandable:false },

    { id:"DS425+",      brand:"Synology", bays:4, quote:67000,  minTax:63720,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  },
    { id:"DS925+",      brand:"Synology", bays:4, quote:97000,  minTax:92630,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  },
    { id:"TS-433-4G",   brand:"QNAP",     bays:4, quote:45000,  minTax:42480,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false },
    { id:"TS-462-4G",   brand:"QNAP",     bays:4, quote:57000,  minTax:54280,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false },
    { id:"TS-464-8G",   brand:"QNAP",     bays:4, quote:69000,  minTax:66080,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false },

    { id:"TS-664-8G",   brand:"QNAP",     bays:6, quote:87000,  minTax:82600,  raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:false },

    { id:"DS1525+",     brand:"Synology", bays:8, quote:142000, minTax:135700, raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  },
    { id:"DS1825+",     brand:"Synology", bays:8, quote:180000, minTax:171100, raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  },
    { id:"TS-832PX-4G", brand:"QNAP",     bays:8, quote:108000, minTax:103250, raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  },
    { id:"TS-873A-8G",  brand:"QNAP",     bays:8, quote:130000, minTax:123900, raid:["RAID0","RAID1","RAID5","RAID6","RAID10"], expandable:true  }
  ],
  capacities: [2,4,6,8,10,12,16],
  // capacity (TB) -> drive line -> { quote, min }. Missing = not priced in the sheet.
  hddPricing: {
    2:  { "Exos":{quote:21000, min:20060}, "IronWolf":{quote:19000, min:18054} },
    4:  { "IronWolf":{quote:22000, min:21004} },
    6:  { "WD Ultrastar":{quote:35000, min:33040} },
    8:  { "Exos":{quote:45000, min:43070} },
    10: { "Exos":{quote:52000, min:49560}, "IronWolf":{quote:50000, min:47200}, "WD Ultrastar":{quote:50000, min:47790} },
    12: { "Exos":{quote:68000, min:64900}, "WD Ultrastar":{quote:65000, min:62540} },
    16: { "Exos":{quote:82000, min:78470}, "WD Ultrastar":{quote:82000, min:77880} }
  },
  install: { quote:5900, min:4130 },
  amcRate: { quote:0.10, min:0.07 }
};

const PRICING_URL = new URL("../data/pricing.json", import.meta.url);

/** Resolves the pricing to quote from.
 *  Returns { data, note, source, stale, warnings } — `note` is shown in the quote
 *  panel so the rep can always see which price list they are quoting from. */
export async function loadPricing(){
  const endpoint = resolveEndpoint();

  if(endpoint){
    try{
      const raw = await fetchJson(endpoint, FETCH_TIMEOUT_MS);
      if(raw && raw.error) throw new Error(raw.error);
      const data = normalise(raw);
      const problem = validate(data);
      if(problem) throw new Error(problem);

      writeCache(raw);
      return {
        data, source:"sheet", stale:false,
        warnings: raw.warnings || [],
        note: "Live from sheet · " + formatTime(new Date())
      };
    }catch(err){
      console.warn("[pricing] live sheet fetch failed:", err.message);
      const cached = readCache();
      if(cached){
        const data = normalise(cached.raw);
        if(!validate(data)){
          const stale = Date.now() - cached.fetchedAt > CACHE_STALE_AFTER_MS;
          return {
            data, source:"cache", stale,
            warnings: cached.raw.warnings || [],
            note: (stale ? "Stale cache · " : "Cached from sheet · ") + formatDate(cached.fetchedAt) +
                  " (sheet unreachable)"
          };
        }
      }
    }
  }

  try{
    const res = await fetch(PRICING_URL, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    const data = normalise(raw);
    const problem = validate(data);
    if(problem) throw new Error(problem);
    return {
      data, source:"file", stale:!endpoint ? false : true, warnings:[],
      note: (endpoint ? "Offline copy · " : "Price list · ") +
            (data.updatedAt ? formatDate(data.updatedAt) : "data/pricing.json")
    };
  }catch(err){
    console.warn("[pricing] data/pricing.json unavailable:", err.message);
  }

  return {
    data: FALLBACK, source:"snapshot", stale:true, warnings:[],
    note: "Built-in snapshot — prices may be out of date"
  };
}

/* ---------------- fetching ---------------- */

function resolveEndpoint(){
  let override = null;
  try{ override = localStorage.getItem(ENDPOINT_OVERRIDE_KEY); }catch(e){ /* storage blocked */ }
  return (override || SHEET_ENDPOINT || "").trim();
}

async function fetchJson(url, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    // Apps Script /exec redirects to googleusercontent; `redirect: follow` is the default and required.
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }finally{
    clearTimeout(timer);
  }
}

/* ---------------- cache ---------------- */

function writeCache(raw){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), raw }));
  }catch(e){ /* private mode / quota — cache is a convenience, not a requirement */ }
}

function readCache(){
  try{
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if(stored && stored.raw && stored.fetchedAt) return stored;
  }catch(e){ /* corrupt or blocked */ }
  return null;
}

/* ---------------- shaping & validation ---------------- */

/** Fills gaps from the snapshot and coerces sheet strings to the types the app expects. */
export function normalise(raw){
  const d = raw || {};
  const models = (Array.isArray(d.models) ? d.models : [])
    .map(m => ({
      id: String(m.id || "").trim(),
      brand: String(m.brand || "").trim(),
      bays: Number(m.bays),
      quote: Number(m.quote),
      minTax: Number(m.minTax ?? m.quote),
      raid: Array.isArray(m.raid) ? m.raid : [],
      expandable: !!m.expandable
    }))
    .filter(m => m.id && m.raid.length && Number.isFinite(m.bays) && Number.isFinite(m.quote));

  const hddPricing = {};
  const src = d.hddPricing || {};
  for(const cap of Object.keys(src)){
    const entry = {};
    for(const brand of Object.keys(src[cap] || {})){
      const q = Number(src[cap][brand]?.quote);
      const m = Number(src[cap][brand]?.min ?? q);
      if(Number.isFinite(q) && q > 0) entry[brand] = { quote:q, min: Number.isFinite(m) ? m : q };
    }
    if(Object.keys(entry).length) hddPricing[Number(cap)] = entry;
  }

  const capacities = (Array.isArray(d.capacities) && d.capacities.length
    ? d.capacities.map(Number)
    : Object.keys(hddPricing).map(Number)
  ).filter(c => Number.isFinite(c) && hddPricing[c]).sort((a,b) => a-b);

  return {
    models: models.length ? models : FALLBACK.models,
    hddPricing: capacities.length ? hddPricing : FALLBACK.hddPricing,
    capacities: capacities.length ? capacities : FALLBACK.capacities,
    install: numberPair(d.install, FALLBACK.install),
    // `rmaRate` is what this field was called before it was renamed to AMC;
    // still accepted so an older sheet export keeps working.
    amcRate: numberPair(d.amcRate ?? d.rmaRate, FALLBACK.amcRate),
    updatedAt: d.updatedAt || null
  };
}

function numberPair(v, fallback){
  const quote = Number(v?.quote);
  const min = Number(v?.min);
  if(!Number.isFinite(quote)) return fallback;
  return { quote, min: Number.isFinite(min) ? min : quote };
}

/** Returns a reason string when the payload isn't safe to quote from, else null. */
export function validate(data){
  if(!data.models.length) return "no usable models";
  if(!data.capacities.length) return "no drive capacities priced";
  if(!Number.isFinite(data.install.quote)) return "installation price missing";
  if(!(data.amcRate.quote >= 0 && data.amcRate.quote < 1)) return "AMC rate out of range";
  return null;
}

function formatDate(value){
  const d = new Date(value);
  if(isNaN(d)) return String(value);
  return d.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
}

function formatTime(d){
  return d.toLocaleString("en-IN", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
}
