# Pricing sheet layout (recommended)

For the permanent pricing sheet that will hold every category of component.

The configurator reads the sheet through [apps-script/Code.gs](../apps-script/Code.gs).
Building the sheet in the shape below means the script needs no per-category code:
a new category, component, or price is a row someone types, and the tool picks it up
within ten minutes.

## The core idea: one row per component

Not a block per category. A single flat table, with the category as a column:

| Category | Component | Brand | Spec | Bays | Capacity TB | RAID | Expandable | Quote Price | With Tax | Unit | Active |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NAS | DS425+ | Synology | 4-bay desktop | 4 | | RAID 0/1/5/6/10 | Yes | 67000 | 63720 | per unit | Yes |
| NAS | TS-433-4G | QNAP | 4-bay desktop | 4 | | RAID 0/1/5/6/10 | No | 45000 | 42480 | per unit | Yes |
| HDD | Exos X18 | Seagate | 7200rpm SATA | | 8 | | | 45000 | 43070 | per drive | Yes |
| HDD | IronWolf | Seagate | NAS 5400rpm | | 4 | | | 22000 | 21004 | per drive | Yes |
| SSD | 870 EVO | Samsung | SATA cache | | 1 | | | 9000 | 8500 | per drive | Yes |
| RAM | 8GB DDR4 SODIMM | Crucial | | | | | | 4500 | 4200 | per unit | Yes |
| NIC | 10GbE PCIe card | QNAP | QXG-10G1T | | | | | 14000 | 13200 | per unit | No |
| SERVICE | On-site installation | | Racking, RAID, network | | | | | 5900 | 4130 | per unit | Yes |
| SERVICE | Extended RMA | | % of hardware subtotal | | | | | 10% | 7% | percent of hardware | Yes |

Why this shape:

- **One header row for the whole sheet.** The script finds columns by name, so
  columns can be reordered or added without a code change.
- **Rows are cheap.** A new drive capacity, a new NAS model, a new RAM option — all
  are rows. Nobody has to build a new block or tell an engineer.
- **Categories stay open-ended.** The script groups by the Category value; an
  unfamiliar category is carried through rather than dropped.

## Column notes

| Column | Notes |
|---|---|
| **Category** | Keep the vocabulary small and stable: `NAS`, `HDD`, `SSD`, `RAM`, `NIC`, `EXPANSION`, `SERVICE`, `ACCESSORY`. This is the one column worth being strict about — it decides where a row shows up in the tool. |
| **Component** | The name the rep and the customer see, and what prints on the quotation. Must be unique within a category. |
| **Brand** | Optional; shown as a badge. Inferred from the model prefix for NAS rows if blank. |
| **Spec** | Free text, shown as the sub-line under the component. Not parsed. |
| **Bays** | **NAS rows: please fill this in.** It decides which chassis tier a model competes in. Without it the script falls back to a hardcoded map and a genuinely new model gets skipped. |
| **Capacity TB** | Drive rows. A plain number; `8`, `8 TB` and `8TB` all read the same. |
| **RAID** | NAS rows. Any notation works — `RAID 0/1/5/6/10`, `0,1,5,6,10`, `RAID 5, RAID 6`. Blank means "all levels the bay count allows". |
| **Expandable** | NAS rows, Yes/No. Fill it in and the tool stops guessing from the product line. |
| **Quote Price** | The **Max** column in the tool — list quote price. |
| **With Tax** | The **Min** column — best price. Blank falls back to Quote Price. |
| **Unit** | How the price multiplies: `per unit`, `per drive`, `percent of hardware`, `flat`. This is what lets a new category be priced correctly without code. |
| **Active** | `No` hides a row without deleting it — for discontinued models you want the history of. |

## Things to avoid

- **Merged cells.** They read as one value plus blanks and will drop data.
- **Prices as text with notes** — `45000 (till Mar)`. Put the note in Spec.
- **A blank row inside a table.** Two consecutive blanks end the table. One is fine.
- **Two tables side by side** on the same rows.
- **Renaming a Category** once reps are quoting from it.

Formatting, currency symbols, commas and colours are all fine — the script strips
them.

## What still needs a code change

Parsing is automatic; **how a component is offered to the rep is not.** A new
category needs a decision about its place in the sales flow before it can appear:

- Is it a choice the rep makes, or added automatically?
- Is it required or optional?
- Does it multiply per NAS unit, per drive, or once per quote?
- Does it constrain anything else? (a 10GbE NIC needing a free PCIe slot, RAM
  limited by model)

Send the finished sheet and those answers together and the flow can be extended to
match it. Until then, unrecognised categories are read and reported but not quoted.

## Before switching over

1. Build the sheet in a **copy** first, so live quoting keeps working.
2. Run `preview` in the Apps Script editor and read the logged JSON — check the
   counts per category and an empty `warnings` array.
3. Point `SHEET_NAME` in `Code.gs` at the new tab, redeploy as a **new version** of
   the existing deployment (same URL), and reload the tool.
4. Confirm the panel says **Live from sheet** with today's timestamp.
