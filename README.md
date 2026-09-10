# NAS Configurator

Internal sales tool for DigiBuggy (DGB India). A salesperson runs it live with a
customer: answer a few questions about storage needs, get a recommended NAS unit
plus drives, and download a PDF quotation.

A single configuration page with a live quotation alongside it, backed by a
pricing database an admin maintains. No build step on the front end.

## Running it

**There is one command, and it runs everything.** The front end has no server of
its own — it is static files that the backend serves, so starting the backend
starts the whole thing:

```bash
npm install
npm run seed          # catalogue + opening prices, safe to re-run
npm start             # http://localhost:3000
```

Then open **http://localhost:3000** — that *is* the front end.

| URL | What |
|---|---|
| `http://localhost:3000/` | the configurator a rep runs with a customer |
| `http://localhost:3000/admin/` | pricing admin — products, prices, quotations, users |
| `http://localhost:3000/api/pricing` | the price list the configurator reads |

`npm start` does the same thing from the repo root, from `frontend/` or from
`backend/` — all three run the one server.

Two things that will not work, and what they look like:

- **Opening `frontend/index.html` from the file manager** (a `file://` URL). The
  browser blocks ES modules from `file://`, so you get a blank page. Use the
  server.
- **Serving `frontend/` on its own** with Live Server, `serve`, or similar. The
  page loads, but there is no `/api/pricing` behind it, so it quietly falls back
  to the offline copy in `frontend/data/pricing.json` and the panel says so. Fine
  for styling work — `npm run dev:static` inside `frontend/` does exactly this on
  port 5173 — but the admin and saved quotes need the real server.

To create the first admin account, give the seed one:

```bash
ADMIN_EMAIL=you@digibuggy.com ADMIN_PASSWORD='something long' npm run seed
```

```bash
npm test              # both workspaces
```

## Layout

```
frontend/         the configurator and the admin UI — no build step
  index.html      the configurator page
  src/            sizing logic, pricing client, PDF, styles
  admin/          the pricing admin
  data/           offline copy of the price list
  test/           sizing maths + a jsdom pass over the page
backend/          pricing database, admin API, quote store
  README.md       environment, API and deployment notes
  routes.js       the API
  pricing.js      products + prices -> the configurator's payload
  seed.js         the catalogue and its opening prices
  test/           the API driven over HTTP
docs/             pricing sheet layout notes
apps-script/      legacy importer for the original Google Sheet
```

## Prices come from the admin

The catalogue lives in the backend's database and is edited at `/admin`: add or
retire products, change prices, and see the history of every change. The
configurator fetches `/api/pricing` on load, again every 10 minutes while open,
when a backgrounded tab is reopened, and on its Refresh button — so a price
changed in the admin is quoted by the next rep to open the tool.

Two numbers are entered, one is derived:

| | |
|---|---|
| **Base** | ex-GST, the price list's `54000+` |
| **Quote** | the asking price, GST inclusive — the "Max" column |
| **Minimum** | **derived**: base × (1 + GST) — the "Min" column |

Every row of the September 2026 price list matches that identity to the rupee, so
the minimum is never typed by hand and can't drift. The GST rate is a setting, not
a constant.

Prices are append-only: a change writes a new row with its own effective date,
author and note. That makes an old quotation explainable, and lets a rise be
entered today to take effect on its own date.

### If the server can't be reached

`frontend/src/pricing.js` falls back in order: the API → a `localStorage` cache of
the last good response → `frontend/data/pricing.json` → a snapshot built into the
module. The quote panel always names which one is in use, and every payload is
validated before it is quoted from, so a half-broken edit can't produce a ₹0
quotation.

| Line in the panel | Meaning |
|---|---|
| `Live prices · 10 Sep, 14:32` | fetched just now |
| `Cached prices · 10 Sep (server unreachable)` | quoting the last good copy |
| `Stale cache · 02 Sep (server unreachable)` | as above, over a day old — shown in amber |
| `Built-in snapshot — prices may be out of date` | last resort |

Anything the backend couldn't use — a product with no bay count, say — is reported
in the panel as a warning rather than silently dropped.

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
   so `n` rounds up to the next size stocked (2/4/5/6/8 today — the DS1525+ is a
   5-bay); choosing a size explicitly caps the bays per unit.
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

- The original sheet's **PreBuilds** and **Reference** tabs were never read. They
  may define ready-made configurations that should be offered directly rather than
  assembled from the sizing rules above.
- **No SSD, RAM or NIC products yet.** The database and admin handle those
  categories; nobody has entered any. Add them at `/admin` and SSDs appear
  alongside HDDs immediately — RAM and NICs need a decision about where they sit
  in the sales flow before they can be quoted.
- **Network speed** is captured as a customer requirement printed on the quote. It
  is not matched against real per-model NIC specs.
- **Expandability** flags came from product-line knowledge (Synology "+", QNAP
  PX/A tiers), not from a price list. They are editable per product in the admin —
  correct any that are wrong.
- **The quotation PDF is not yet built to your template.** It uses a layout I
  designed; the real format is still to come.
- jsPDF's built-in Helvetica has no rupee glyph, so the PDF prints `Rs.` where the
  on-screen panel prints `₹`. Embedding a Unicode font fixes it if the symbol
  matters on the customer-facing document.
- jsPDF and jspdf-autotable load from cdnjs. For an air-gapped deploy, vendor
  those two files locally.

## Deploying

See [backend/README.md](backend/README.md). The short version: set `DATABASE_URL`
to a Postgres URL on any managed platform — their disks are ephemeral and a SQLite
file there is wiped on every redeploy. The schema and every query run on both.
