/* Pure configuration + pricing logic. No DOM, no data imports — everything
 * comes in as arguments so this file can be unit-tested with `node --test`. */

export const RAID_INFO = {
  RAID0:  { minDrives:1, step:1, label:"RAID 0 — striping (full capacity, zero redundancy)" },
  RAID1:  { minDrives:2, step:1, fixed:true, label:"RAID 1 — mirroring (50% usable, survives 1 drive failure)" },
  RAID5:  { minDrives:3, step:1, label:"RAID 5 — parity (survives 1 drive failure)" },
  RAID6:  { minDrives:4, step:1, label:"RAID 6 — dual parity (survives 2 drive failures)" },
  RAID10: { minDrives:4, step:2, label:"RAID 10 — mirror + stripe (50% usable, fastest rebuild)" }
};

/* Chassis sizes are whatever the price list stocks — a 5-bay DS1525+ is as real
 * as a 4-bay, so nothing here assumes a fixed 2/4/6/8 ladder. */
export const DEFAULT_BAY_TIERS = [2,4,5,6,8];
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
 *  `maxBays` is the largest chassis to fill before adding a second unit — the
 *  8-bay ceiling by default, or the size the rep picked. If one chassis can't
 *  get there at this drive size, the target spreads across whole units and
 *  `exceeded` is set. */
export function computeDrives(raid, driveTB, targetTB, maxBays = MAX_BAYS){
  const info = RAID_INFO[raid];
  if(!info) throw new Error("Unknown RAID level: " + raid);
  if(!(maxBays >= 2)) throw new Error("maxBays must be at least 2");

  if(raid === "RAID1"){
    const usable = usableForN(raid, 2, driveTB);
    const units = Math.max(1, Math.ceil(targetTB / usable));
    return {
      drivesPerUnit:2, units, usablePerUnit:usable,
      totalUsable: usable * units, bayNeed:2, exceeded: units > 1
    };
  }

  for(let n = info.minDrives; n <= maxBays; n += info.step){
    const usable = usableForN(raid, n, driveTB);
    if(usable >= targetTB){
      return { drivesPerUnit:n, units:1, usablePerUnit:usable, totalUsable:usable, bayNeed:n, exceeded:false };
    }
  }

  // The chassis can't reach the target on its own: fill it and add more units.
  // RAID 10 fills in pairs, so an odd bay count leaves the last bay empty.
  const fullest = info.step === 2 ? maxBays - (maxBays % 2) : maxBays;
  const usableMax = usableForN(raid, fullest, driveTB);
  const units = Math.ceil(targetTB / usableMax);
  return {
    drivesPerUnit:fullest, units, usablePerUnit:usableMax,
    totalUsable: usableMax * units, bayNeed:fullest, exceeded:true
  };
}

/** Smallest chassis size that fits `n` drives, out of the sizes actually sold. */
export function bayTierFor(n, tiers = DEFAULT_BAY_TIERS){
  const sorted = [...tiers].sort((a,b) => a - b);
  return sorted.find(t => t >= n) ?? sorted[sorted.length - 1] ?? MAX_BAYS;
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

/** Total = (NAS × units) + (drive × drives/unit × units) + install + AMC%.
 *  Matches the sheet's own example calculator. */
export function priceQuote({ model, calc, drivePrice, install, amcRate, includeInstall, includeAMC }){
  const totalDrives = calc.drivesPerUnit * calc.units;

  const nasQuote = model ? model.quote  * calc.units : 0;
  const nasMin   = model ? model.minTax * calc.units : 0;
  const hddQuote = (drivePrice?.quote ?? 0) * totalDrives;
  const hddMin   = (drivePrice?.min   ?? 0) * totalDrives;

  const installQuote = includeInstall ? install.quote * calc.units : 0;
  const installMin   = includeInstall ? install.min   * calc.units : 0;

  const hwQuote = nasQuote + hddQuote;
  const hwMin   = nasMin + hddMin;

  const amcQuote = includeAMC ? hwQuote * amcRate.quote : 0;
  const amcMin   = includeAMC ? hwMin   * amcRate.min   : 0;

  return {
    totalDrives,
    nasQuote, nasMin, hddQuote, hddMin,
    installQuote, installMin, amcQuote, amcMin,
    hwQuote, hwMin,
    grandQuote: hwQuote + installQuote + amcQuote,
    grandMin:   hwMin   + installMin   + amcMin
  };
}
