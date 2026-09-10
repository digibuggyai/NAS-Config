# NAS Configurator

Internal sales tool for DigiBuggy (DGB India). A salesperson runs it live with a
customer: answer a few questions about storage needs, get a recommended NAS unit
plus drives, and download a PDF quotation.

Standalone port of the original single-file Claude Artifact prototype: a single
configuration page with a live quotation alongside it. No build step.

## Running it

```bash
npm start          # serves the folder at http://localhost:5173
```

Any static server works — the app is plain HTML/CSS/ES modules. It can be dropped
onto any static host as-is.

Opening `index.html` straight off the disk (`file://`) will not work — browsers block
ES-module loading from `file://` — so use a server.

```bash
npm install        # jsdom, for the render tests only
npm test           # RAID maths, price-list handling, sheet parser, and a full
                   # jsdom pass over the configuration page
```

## Layout

```
index.html               markup + font/CDN links
apps-script/Code.gs      Apps Script web app: Pricing tab -> JSON
apps-script/README.md    how to deploy it
docs/sheet-schema.md     recommended layout for the permanent pricing sheet
src/config.js            the sheet endpoint URL and cache settings
src/pricing.js           fetch / cache / validate the price list
src/logic.js             RAID sizing, model filtering, quote maths (pure, tested)
src/pdf.js               jsPDF quotation layout
src/app.js               answer state, section rendering, quotation panel
src/styles.css           design tokens + all styling
data/pricing.json        offline copy of the price list
test/                    unit tests
```

## Pricing comes from the sheet

Prices are edited in the **Pricing** tab of the "NAS COLD MESSAGE" Google Sheet, as
before. An Apps Script web app serves that tab as JSON and the configurator fetches
it on every page load, so a price changed in the sheet is quoted by the next rep to
open the tool. No redeploy, no re-transcription.

**Setup is one-time and takes a few minutes** — see
[apps-script/README.md](apps-script/README.md). Paste the deployment URL into
`SHEET_ENDPOINT` in [src/config.js](src/config.js) and it's live.

Until that URL is set, the app runs off `data/pricing.json` and says so.

A permanent pricing sheet covering every component category is being built. The
layout that keeps this working with no code change per category is written up in
[docs/sheet-schema.md](docs/sheet-schema.md) — worth reading before that sheet is
built, not after.

Once the endpoint is set there is nothing to maintain by hand:

| In the sheet | In the tool |
|---|---|
| Change a price | quoted on the next load or background refresh |
| Add a model row | appears in the model list, filtered by its bay tier and RAID |
| Remove a model row | disappears |
| Add a drive line column | appears in the "Drive line" choices at that capacity |
| Add a capacity row | appears in the "Drive capacity" choices |
| Change the installation or AMC rate | flows into the add-on lines and totals |

The page fetches on load, again every 10 minutes while it's open
(`AUTO_REFRESH_MS` in `src/config.js`), when the rep returns to a tab that has been
in the background, and on the **Refresh** button. Background fetches keep the rep's
current answers and selected model.

The one case that needs a person: a model row whose **bay count** can't be
determined. If the Pricing tab has no bays column, the script falls back to the
`BAY_HINTS` map in `Code.gs`, and a genuinely new model won't be in it — the model
is skipped and named in a warning in the quote panel. Adding a **Bays** column to
the Pricing tab removes that failure mode entirely and is the recommended fix.

### What the rep sees

The quote panel always names the price list in use, with a **Refresh** button for
pulling a mid-call sheet edit:

| Line | Meaning |
|---|---|
| `Live from sheet · 09 Sep, 14:32` | fetched from the sheet just now |
| `Cached from sheet · 09 Sep` | sheet unreachable; quoting the last good copy |
| `Stale cache · 02 Sep (sheet unreachable)` | as above, but over a day old — shown in amber |
| `Offline copy · …` / `Price list · …` | quoting `data/pricing.json` |
| `Built-in snapshot — prices may be out of date` | last resort; nothing else loaded |

Anything the parser had to skip (a model with no price, a header row it couldn't
find) is reported in the panel as a warning rather than silently dropped.

### Fallback chain

`src/pricing.js` tries, in order: the sheet endpoint → a `localStorage` cache of the
last good response → `data/pricing.json` → a built-in snapshot in the module itself.
Every payload is normalised (sheet cells arrive as strings) and validated before it
is quoted from, so a half-broken sheet edit can't produce a ₹0 quotation — the app
falls through to the previous source instead.

`data/pricing.json` and the built-in snapshot are the September 2026 transcription.
They only matter when the sheet is unreachable; refresh them occasionally if you
care about the offline path being accurate.

## The page

Five sections on one scrolling page, with the quotation beside them:

1. **Storage need** — usable TB, typed directly or set with the slider/presets
   (2–200 TB; a typed figure outside that range is clamped when committed).
2. **Chassis, RAID & drives** — chassis size, RAID level, drive capacity, drive
   line, network speed, expandability.
3. **NAS unit** — the units matching the bay tier and RAID level, cheapest first.
4. **Add-ons** — installation and AMC (annual maintenance cost).
5. **Quotation details** — customer, location, rep, validity.

Nothing is auto-selected in section 3, and the quotation stays unpriced — totals
blank, PDF disabled — until the rep picks a unit. Everything else updates live as
answers change, so the sections can be filled in any order. All answers live in one
state object and each section renders from it.

On a laptop the quotation sits in a sticky sidebar; on a phone or tablet it
collapses to a pinned running total that opens the full quotation as a bottom sheet.

## How the recommendation works

1. **Usable capacity per RAID level** — RAID 0 `n×size`, RAID 1 `size` (2 drives),
   RAID 5 `(n−1)×size`, RAID 6 `(n−2)×size`, RAID 10 `(n/2)×size`.
2. **Drive count** is the smallest `n` that reaches the target within the chassis
   (RAID 10 steps in pairs). On **Auto** the chassis is the smallest tier that fits,
   so `n` rounds up to 2/4/6/8; choosing a size explicitly caps the bays per unit.
3. If the chassis can't reach the target at the chosen drive size, the quote scales
   to multiple whole units and the UI shows a warning banner. Picking a small
   chassis for a large target is a legitimate way to get there — three 2-bay boxes
   rather than one 8-bay — so the section says which it produced.
4. **Models** are filtered to that bay tier and RAID level, cheapest first. Ticking
   "room to expand later" floats expandable units to the top.
5. **Total** = `(NAS × units) + (drive × drives-per-unit × units) + installation + AMC%`,
   matching the price sheet's own example calculator. AMC is a percentage of the
   hardware subtotal only — installation is not marked up.

Every column shows two prices: **Max** (the sheet's list "Quote Price") and
**Min** (the sheet's "with tax" / best price).

## Known gaps

Carried over from the prototype — these are unresolved data questions, not bugs:

- The sheet's **PreBuilds** and **Reference** tabs were never read. They may define
  ready-made configurations that should be offered directly rather than assembled
  from the sizing rules below.
- No SSD pricing exists in the sheet yet — HDD only.
- **Network speed** is captured as a customer requirement printed on the quote. It is
  not matched against real per-model NIC specs; those weren't in the sheet.
- **Expandability** flags are inferred from product-line knowledge (Synology "+",
  QNAP PX/A tiers), not sheet data. Confirm before quoting.
- The parser reads only the **Pricing** tab. If bay counts or expandability ever get
  their own columns there, the script picks them up automatically and stops using its
  hint maps.

## Notes on the port

- The prototype's `window.claude.use("db")` pricing sync is replaced by the Apps
  Script endpoint; `window.claude.use("downloads")` is replaced by jsPDF's own
  `doc.save()`, which triggers a normal browser download.
- jsPDF's built-in Helvetica has no rupee glyph, so the PDF prints `Rs.` where the
  on-screen panel prints `₹`. Embedding a Unicode font would fix it if the symbol
  matters on the customer-facing document.
- jsPDF and jspdf-autotable load from cdnjs. For an air-gapped or offline-tolerant
  deploy, vendor those two files locally.
