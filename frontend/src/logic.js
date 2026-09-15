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

/* ============================================================
   Buildability and automatic suggestion
   ============================================================ */

/* Drives are sold in whole terabytes and arrays are built from whole drives, so
   a target is expressed on a 2 TB grid. 157 TB is not a thing anyone can build. */
export const STORAGE_STEP = 2;
export const STORAGE_MIN = 2;
export const STORAGE_MAX = 200;

/** Why this target can't be built, or null when it can.
 *  `capacities` are the drive sizes actually priced. */
export function buildabilityError(targetTB, { raid, capacities = [], maxUnits = MAX_UNITS } = {}){
  if(!Number.isFinite(targetTB)) return "Enter the storage the customer needs.";
  if(targetTB % STORAGE_STEP !== 0){
    const near = Math.round(targetTB / STORAGE_STEP) * STORAGE_STEP;
    return `${targetTB} TB can't be built — storage goes in ${STORAGE_STEP} TB steps. Try ${near} TB.`;
  }
  if(targetTB < STORAGE_MIN) return `The smallest system is ${STORAGE_MIN} TB.`;
  if(targetTB > STORAGE_MAX) return `${targetTB} TB is past what this tool sizes (${STORAGE_MAX} TB).`;

  if(raid && capacities.length){
    const biggest = Math.max(...capacities);
    const perUnit = usableForN(raid, raid === "RAID1" ? 2 : MAX_BAYS, biggest);
    if(perUnit * maxUnits < targetTB){
      return `${targetTB} TB can't be built at ${raid}: even ${maxUnits} units of ` +
             `${MAX_BAYS} × ${biggest} TB reach only ${perUnit * maxUnits} TB.`;
    }
  }
  return null;
}

/** How many chassis the tool is willing to gang together before calling it
 *  unbuildable. Beyond this it stops being a desktop NAS proposal. */
export const MAX_UNITS = 4;

/**
 * Every way of hitting the target, cheapest first.
 *
 * A build is a whole proposal — drive size, drive line, how many drives, which
 * chassis and how many of them — because those choices are not independent:
 * bigger drives need fewer bays, which allows a cheaper chassis, which can beat
 * the cheaper drives outright.
 *
 * A model qualifies when it has AT LEAST the bays the array needs, so a 6-bay
 * unit is a legitimate home for a 4-drive array — with expansion room, which is
 * exactly what a customer who ticked "room to expand" is paying for.
 */
export function suggestBuilds({
  targetTB, raid, models, hddPricing, capacities,
  brand = "any", bays = null, expandableOnly = false, maxUnits = MAX_UNITS
}){
  const builds = [];

  for(const model of models){
    if(!model.raid.includes(raid)) continue;
    if(brand !== "any" && model.brand.toLowerCase() !== brand.toLowerCase()) continue;
    if(bays != null && model.bays !== Number(bays)) continue;
    if(expandableOnly && !model.expandable) continue;

    for(const cap of capacities){
      const lines = hddPricing[cap] || {};
      for(const line of Object.keys(lines)){
        const drive = lines[line];
        const calc = computeDrives(raid, cap, targetTB, model.bays);
        if(calc.units > maxUnits) continue;

        const drives = calc.drivesPerUnit * calc.units;
        builds.push({
          model, driveCap: cap, driveLine: line,
          drivesPerUnit: calc.drivesPerUnit, units: calc.units,
          bayNeed: calc.bayNeed, calc,
          totalUsable: calc.totalUsable,
          spareBays: (model.bays - calc.drivesPerUnit) * calc.units,
          totalQuote: model.quote * calc.units + drive.quote * drives,
          totalMin: model.minTax * calc.units + drive.min * drives
        });
      }
    }
  }

  // Cheapest first; then fewer boxes; then less over-delivery, so two builds at
  // the same price don't sell the customer capacity they didn't ask for.
  builds.sort((a, b) =>
    a.totalQuote - b.totalQuote ||
    a.units - b.units ||
    a.totalUsable - b.totalUsable
  );
  return builds;
}

/** The cheapest build per model, so the list offers real alternatives rather
 *  than the same unit five times with different drives. */
export function bestBuildPerModel(builds){
  const seen = new Map();
  for(const b of builds){
    if(!seen.has(b.model.id)) seen.set(b.model.id, b);
  }
  return [...seen.values()];
}

/* ============================================================
   Network speed
   ============================================================ */

/** The highest speed named in a ports string, in Gb/s. "2.5GbE ×1 + 1GbE ×1"
 *  is a 2.5 Gb link at best, whatever else is in the box. */
export function topSpeed(spec){
  const hits = String(spec || "").match(/(\d+(?:\.\d+)?)\s*GbE/gi);
  if(!hits) return 0;
  return Math.max(...hits.map(h => parseFloat(h)));
}

/** What the chosen unit can actually do on the network.
 *  `builtIn` is what ships in the box and is what gets quoted; `upgrade` needs a
 *  card that isn't in this price list, so it is reported as a note only. */
export function networkFor(model){
  if(!model) return null;
  const builtIn = (model.network || "").trim();
  const upgrade = (model.networkUpgrade || "").trim();
  if(!builtIn && !upgrade) return null;
  return {
    builtIn: builtIn || null,
    upgrade: upgrade || null,
    topGb: topSpeed(builtIn),
    /** The speed tile to preselect: the fastest link the unit has out of the box. */
    quotable: builtIn ? labelForSpeed(topSpeed(builtIn)) : null
  };
}

/** Rounds a raw Gb figure onto the speeds a quotation talks in. */
export function labelForSpeed(gb){
  if(gb >= 10) return "10GbE";
  if(gb >= 2.5) return "2.5GbE";
  if(gb >= 1) return "1GbE";
  return null;
}

/** The best network the current shortlist could reach, so a rep can see that a
 *  faster link is on the table before they settle on a unit. */
export function bestNetworkAmong(builds){
  let best = null;
  for(const b of builds){
    const net = networkFor(b.model);
    if(net && (!best || net.topGb > best.topGb)) best = { ...net, model: b.model };
  }
  return best;
}

/**
 * The usable capacities that can actually be built, exactly, with the drives and
 * chassis on the price list — no rounding up, no over-delivery.
 *
 * A NAS delivers whole drives at a RAID level, so usable capacity lands on a set
 * of discrete values (RAID 5 with 10 TB drives gives 20, 30, 40 … ; with 8 TB it
 * gives 16, 24, 32 …). Offering those directly beats letting someone type a
 * figure that no combination produces.
 */
export function buildableSizes({
  raid, models, capacities, hddPricing,
  brand = "any", bays = null, expandableOnly = false,
  maxUnits = MAX_UNITS, max = STORAGE_MAX, min = STORAGE_MIN
}){
  const info = RAID_INFO[raid];
  if(!info) return [];

  const sizes = new Set();

  for(const model of models){
    if(!model.raid.includes(raid)) continue;
    if(brand !== "any" && model.brand.toLowerCase() !== brand.toLowerCase()) continue;
    if(bays != null && model.bays !== Number(bays)) continue;
    if(expandableOnly && !model.expandable) continue;

    for(const cap of capacities){
      if(!Object.keys(hddPricing?.[cap] || {}).length) continue;   // not priced, not offerable

      // RAID 1 is always a single mirrored pair, whatever the chassis holds.
      const counts = raid === "RAID1"
        ? [2]
        : range(info.minDrives, model.bays, info.step);

      for(const n of counts){
        const perUnit = usableForN(raid, n, cap);
        for(let units = 1; units <= maxUnits; units++){
          const total = perUnit * units;
          if(total >= min && total <= max && Number.isInteger(total)) sizes.add(total);
        }
      }
    }
  }
  return [...sizes].sort((a, b) => a - b);
}

function range(from, to, step){
  const out = [];
  for(let n = from; n <= to; n += step) out.push(n);
  return out;
}

/** The offered size closest to what was asked for, preferring not to under-deliver. */
export function nearestBuildable(targetTB, sizes){
  if(!sizes.length) return null;
  const atOrAbove = sizes.find(s => s >= targetTB);
  if(atOrAbove == null) return sizes[sizes.length - 1];
  const below = [...sizes].reverse().find(s => s < targetTB);
  if(below == null) return atOrAbove;
  return (atOrAbove - targetTB) <= (targetTB - below) ? atOrAbove : below;
}

/* ============================================================
   Sizing by budget
   ============================================================ */

/** Most to least redundant, used only to break a tie in usable capacity — see
 *  suggestBudgetPlan. Not a ranking of which RAID level is "better" in general. */
export const RAID_REDUNDANCY_ORDER = ["RAID6", "RAID10", "RAID5", "RAID1", "RAID0"];

/**
 * Every build at a fixed RAID level that fits inside a budget, most usable
 * capacity first.
 *
 * Unlike suggestBuilds() (smallest/cheapest build that reaches a target), this
 * runs the search the other way: for a fixed amount of money, what is the most
 * storage it buys. A build is model + drive size + drive line + drive count +
 * unit count, priced as a whole, exactly as suggestBuilds() treats it — the same
 * reasoning applies for why they can't be chosen independently.
 */
export function suggestBuildsForBudget({
  budget, raid, models, hddPricing, capacities,
  brand = "any", bays = null, expandableOnly = false, maxUnits = MAX_UNITS
}){
  const info = RAID_INFO[raid];
  if(!info || !(budget > 0)) return [];

  const builds = [];

  for(const model of models){
    if(!model.raid.includes(raid)) continue;
    if(brand !== "any" && model.brand.toLowerCase() !== brand.toLowerCase()) continue;
    if(bays != null && model.bays !== Number(bays)) continue;
    if(expandableOnly && !model.expandable) continue;

    for(const cap of capacities){
      const lines = hddPricing[cap] || {};
      for(const line of Object.keys(lines)){
        const drive = lines[line];
        const counts = raid === "RAID1" ? [2] : range(info.minDrives, model.bays, info.step);

        for(const n of counts){
          const perUnitUsable = usableForN(raid, n, cap);
          if(!(perUnitUsable > 0)) continue;
          const perUnitQuote = model.quote * 1 + drive.quote * n;
          const perUnitMin = model.minTax + drive.min * n;

          // Each added unit only ever costs more, so once one exceeds the
          // budget every larger unit count will too.
          for(let units = 1; units <= maxUnits; units++){
            const totalQuote = perUnitQuote * units;
            if(totalQuote > budget) break;
            builds.push({
              model, driveCap: cap, driveLine: line,
              drivesPerUnit: n, units,
              bayNeed: n, raid,
              totalUsable: perUnitUsable * units,
              spareBays: (model.bays - n) * units,
              totalQuote, totalMin: perUnitMin * units
            });
          }
        }
      }
    }
  }

  // Most storage for the money first; then cheaper; then fewer boxes.
  builds.sort((a, b) =>
    b.totalUsable - a.totalUsable ||
    a.totalQuote - b.totalQuote ||
    a.units - b.units
  );
  return builds;
}

/**
 * The RAID level to default a budget-driven quote to, and the ranked builds at
 * that level.
 *
 * This answers "does the budget need to sacrifice redundancy, or not" — which
 * is a judgment about risk, not just arithmetic. Maximising raw usable
 * terabytes across every RAID level doesn't work as "the best solution": RAID 0
 * always yields more capacity per drive than any redundant level, so a pure
 * capacity-maximiser would default every quote to zero fault tolerance, however
 * generous the budget. Instead, redundancy is kept unless the budget genuinely
 * can't afford it: RAID levels are tried most-protective first, and the first
 * one with ANY build that fits the budget at all is used, ranked internally by
 * usable capacity. RAID 0 only comes up when nothing more protective fits —
 * "redundancy isn't required" because the money can't stretch to it, not
 * because a spreadsheet found a few extra terabytes elsewhere.
 */
export function suggestBudgetPlan({
  budget, models, hddPricing, capacities,
  brand = "any", bays = null, expandableOnly = false, maxUnits = MAX_UNITS,
  raidPool = RAID_REDUNDANCY_ORDER
}){
  for(const raid of raidPool){
    const builds = suggestBuildsForBudget({
      budget, raid, models, hddPricing, capacities, brand, bays, expandableOnly, maxUnits
    });
    if(builds.length) return { raid, builds };   // ranked best-first already
  }
  return null;
}
