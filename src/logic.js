/* Pure configuration + pricing logic. No DOM, no data imports — everything
 * comes in as arguments so this file can be unit-tested with `node --test`. */

export const RAID_INFO = {
  RAID0:  { minDrives:1, step:1, label:"RAID 0 — striping (full capacity, zero redundancy)" },
  RAID1:  { minDrives:2, step:1, fixed:true, label:"RAID 1 — mirroring (50% usable, survives 1 drive failure)" },
  RAID5:  { minDrives:3, step:1, label:"RAID 5 — parity (survives 1 drive failure)" },
  RAID6:  { minDrives:4, step:1, label:"RAID 6 — dual parity (survives 2 drive failures)" },
  RAID10: { minDrives:4, step:2, label:"RAID 10 — mirror + stripe (50% usable, fastest rebuild)" }
};

/* Defaults only — industry heuristics, not sheet data. Fully overridable in the UI. */
export const USE_CASE_INFO = {
  general:        { raid:"RAID1",  speed:"1GbE",   note:"1GbE is generally sufficient for everyday file access." },
  media:          { raid:"RAID5",  speed:"2.5GbE", note:"2.5GbE or 10GbE recommended for smooth multi-stream editing." },
  surveillance:   { raid:"RAID6",  speed:"1GbE",   note:"Size to camera count and retention — confirm stream bitrate." },
  virtualization: { raid:"RAID10", speed:"10GbE",  note:"10GbE recommended to avoid I/O bottlenecks under load." },
  archival:       { raid:"RAID6",  speed:"1GbE",   note:"Prioritise capacity and dual-fault tolerance over speed." },
  database:       { raid:"RAID10", speed:"10GbE",  note:"10GbE and RAID 10 recommended for low-latency writes." }
};

export const BAY_TIERS = [2,4,6,8];
export const MAX_BAYS = 8;

export function inr(n){
  if(n === null || n === undefined || isNaN(n)) return "—";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

/** Usable TB for `n` drives of `driveTB` each at the given RAID level. */
export function usableForN(raid, n, driveTB){
  switch(raid){
    case "RAID0":  return n * driveTB;
    case "RAID1":  return driveTB;
    case "RAID5":  return (n - 1) * driveTB;
    case "RAID6":  return (n - 2) * driveTB;
    case "RAID10": return (n / 2) * driveTB;
    default:       return 0;
  }
}

/** Smallest drive count (and chassis count) that reaches targetTB usable.
 *  If a single MAX_BAYS chassis can't get there at this drive size, spreads
 *  the target across whole units and sets `exceeded`. */
export function computeDrives(raid, driveTB, targetTB){
  const info = RAID_INFO[raid];
  if(!info) throw new Error("Unknown RAID level: " + raid);

  if(raid === "RAID1"){
    const usable = usableForN(raid, 2, driveTB);
    const units = Math.max(1, Math.ceil(targetTB / usable));
    return {
      drivesPerUnit:2, units, usablePerUnit:usable,
      totalUsable: usable * units, bayNeed:2, exceeded: units > 1
    };
  }

  for(let n = info.minDrives; n <= MAX_BAYS; n += info.step){
    const usable = usableForN(raid, n, driveTB);
    if(usable >= targetTB){
      return { drivesPerUnit:n, units:1, usablePerUnit:usable, totalUsable:usable, bayNeed:n, exceeded:false };
    }
  }

  const usableMax = usableForN(raid, MAX_BAYS, driveTB);
  const units = Math.ceil(targetTB / usableMax);
  return {
    drivesPerUnit:MAX_BAYS, units, usablePerUnit:usableMax,
    totalUsable: usableMax * units, bayNeed:MAX_BAYS, exceeded:true
  };
}

/** Smallest bay tier that fits `n` drives. */
export function bayTierFor(n){
  return BAY_TIERS.find(t => t >= n) ?? MAX_BAYS;
}

export function validBrandsForCapacity(hddPricing, cap){
  return Object.keys(hddPricing[cap] || {});
}

export function validCapacitiesForBrand(hddPricing, capacities, brand){
  return capacities.filter(c => hddPricing[c] && hddPricing[c][brand]);
}

/** Models matching the bay tier and RAID level, cheapest first.
 *  With `preferExpandable`, expandable units float to the top of each price order. */
export function candidateModels(models, tier, raid, preferExpandable){
  const list = models
    .filter(m => m.bays === tier && m.raid.includes(raid))
    .sort((a,b) => a.quote - b.quote);
  if(preferExpandable){
    list.sort((a,b) => (Number(b.expandable) - Number(a.expandable)) || (a.quote - b.quote));
  }
  return list;
}

/** Total = (NAS × units) + (drive × drives/unit × units) + install + RMA%.
 *  Matches the sheet's own example calculator. */
export function priceQuote({ model, calc, drivePrice, install, rmaRate, includeInstall, includeRMA }){
  const totalDrives = calc.drivesPerUnit * calc.units;

  const nasQuote = model ? model.quote  * calc.units : 0;
  const nasMin   = model ? model.minTax * calc.units : 0;
  const hddQuote = (drivePrice?.quote ?? 0) * totalDrives;
  const hddMin   = (drivePrice?.min   ?? 0) * totalDrives;

  const installQuote = includeInstall ? install.quote * calc.units : 0;
  const installMin   = includeInstall ? install.min   * calc.units : 0;

  const hwQuote = nasQuote + hddQuote;
  const hwMin   = nasMin + hddMin;

  const rmaQuote = includeRMA ? hwQuote * rmaRate.quote : 0;
  const rmaMin   = includeRMA ? hwMin   * rmaRate.min   : 0;

  return {
    totalDrives,
    nasQuote, nasMin, hddQuote, hddMin,
    installQuote, installMin, rmaQuote, rmaMin,
    hwQuote, hwMin,
    grandQuote: hwQuote + installQuote + rmaQuote,
    grandMin:   hwMin   + installMin   + rmaMin
  };
}
