# NAS Config — Project Overview & Theory

This document exists to let someone build a **second, parallel project** that is
functionally identical to this one, with exactly one behavioural difference:
**the minimum/floor price is never shown or sent to the browser, anywhere.**
Everything else — inputs, combinations, admin panel, PDF, auth, deployment —
is meant to be copied as-is.

The one place this difference should live is already built and proven in
*this* codebase (see §8). Do not remove min from this project's own page or
`/api/pricing` — this project keeps showing both Max and Min. The clone is a
separate app that reuses the same mechanism the other way round.

---

## 1. What this is

An internal sales tool for DigiBuggy (a NAS/storage reseller). A sales rep
picks a customer's requirement (either "I need X TB" or "I have ₹X budget"),
the tool works out a buildable NAS configuration (chassis + drives + RAID +
optional RAM/NIC + install/AMC), prices it from a live database, and produces
a branded PDF quotation. There's also an admin panel for managing the product
catalogue, prices (with full history), quotations, and user accounts.

Two roles:
- **admin** — full access: catalogue, prices, users, all quotes.
- **rep** — configurator + their own quotes only.

## 2. Architecture

Single Node.js/Express service serves both the API and the static frontend
(one deployable unit, not two separate apps). ES modules throughout
(`"type": "module"`).

```
frontend/           static site (vanilla JS, no framework, no build step)
  index.html         the configurator page (11 sections, single scrolling page)
  src/app.js          state + rendering + event wiring
  src/logic.js         pure sizing/pricing math (no DOM) — unit tested
  src/pricing.js        fetches/normalises /api/pricing into a stable shape
  src/pdf.js             builds the customer PDF (jsPDF + autotable, vendored)
  src/company.js          letterhead constants (name/address/logo bytes)
  src/config.js            endpoint URLs, cache/refresh timing constants
  admin/              separate admin SPA (products/prices, quotes, users)
  vendor/             vendored jspdf + jspdf-autotable (not loaded from a CDN)

backend/
  index.js           Express app, static file serving, session middleware
  routes.js          all API routes
  db.js              SQLite (dev) / Postgres (prod) dialect-adapter
  schema.sql         table definitions (see §4)
  pricing.js         turns products+prices tables into the payload the UI reads
  auth.js            scrypt password hashing, session token verify
  ratelimit.js       in-memory per-IP login throttle

docs/, apps-script/  historical: this tool started as a Google Sheet; apps-script/
                     is kept only for importing old sheet data, no longer the
                     source of truth.
```

No build step for the frontend — it's plain ES module `<script type="module">`
files loaded directly by the browser.

## 3. Data flow, top to bottom

1. Admin edits a product's price in `/admin` → new row in `prices` (append-only).
2. Browser (configurator) calls `GET /api/pricing` on load.
3. `backend/pricing.js` reads `products` joined to the *currently effective*
   row in `prices` (see §4), derives the minimum, and shapes a JSON payload.
4. `frontend/src/pricing.js` normalises that payload into the shape
   `frontend/src/logic.js` and `app.js` expect, with `localStorage` caching
   and a periodic background refresh.
5. `app.js` holds one `answers` object representing every input the rep has
   set. Every change calls `derive()`, which recomputes the whole
   configuration from `answers` + the pricing payload, and re-renders.
6. When the rep is happy, the PDF button builds a quote from `ui.lastQuote`
   (Max prices only — see §7) and downloads a PDF client-side. Nothing is
   currently POSTed back to the `quotes` table from this button (a known,
   pre-existing gap, not part of the min/max feature).

## 4. Data model

SQLite locally (`@libsql/client`), Postgres (Neon) in production, through a
single hand-written adapter (`backend/db.js`) so the rest of the code writes
one SQL dialect (`?` placeholders) that gets translated for Postgres.

Tables (`backend/schema.sql`):

- **users** — `email, name, password_hash, role('admin'|'rep'), active`.
- **sessions** — `token_hash` (raw token never stored, only its SHA-256),
  `user_id`, `expires_at`.
- **products** — one row per sellable thing, any category:
  `sku, category('NAS'|'HDD'|'SSD'|'RAM'|'NIC'|'SERVICE'), name, brand, spec,
  bays, capacity_tb, raid(JSON array), expandable, network, network_upgrade,
  unit('per_unit'|'per_drive'|'percent_of_hardware'|'flat'), active, sort_order`.
  `network`/`network_upgrade` are free text like `"2.5GbE x2"` — speed is
  *parsed* out of this text at render time (see §6), not stored as a number.
- **prices** — **append-only**. Every price change is a new row:
  `product_id, base_price(ex-GST), quote_price(GST-inclusive "Max"),
  effective_from(date), note, created_by`. The price "in force" for any date
  is the newest row whose `effective_from` is on or before that date — this
  is what lets an old quote be re-priced at the numbers that applied on its
  own date, and gives the admin panel a full price history per product.
- **quotes** — stores a whole quotation (`config` JSON, `lines` JSON,
  `total_max`, `total_min`, `status`) so a reopened quote shows exactly what
  was sent even after catalogue prices move. Exists and is API-tested; the
  configurator doesn't write to it yet (pre-existing gap).
- **settings** — key/value; currently holds `gst_rate` (default 0.18), so a
  GST change is an admin edit, not a deploy.

## 5. The pricing formula (the part that actually matters for the clone)

For any priced product:
```
base   = ex-GST cost, entered by the admin
quote  = the asking ("Max") price, entered by the admin, GST-inclusive
min    = base × (1 + gstRate)          — DERIVED, never entered directly
```
Exception: `unit === "percent_of_hardware"` (the AMC line) — there `min` and
`quote` are both raw percentages, no GST math applied (`backend/pricing.js`,
`minFor()`).

A full build's totals (`frontend/src/logic.js`, `priceQuote()`):
```
nasQuote  = model.quote  × units          nasMin  = model.minTax × units
hddQuote  = drive.quote × totalDrives     hddMin  = drive.min  × totalDrives
installQuote = install.quote × units (if included)   ... same for Min
hwQuote = nasQuote + hddQuote                          hwMin = nasMin + hddMin
amcQuote = hwQuote × amcRate.quote (if included)       amcMin = hwMin × amcRate.min
grandQuote = hwQuote + installQuote + amcQuote
grandMin   = hwMin   + installMin   + amcMin
```
RAM/NIC upgrade lines (per-chassis, `unitPrice.quote/min × build.units`) add
into the same totals when selected.

**Every place Min ever reaches the browser today, in this project** (so the
clone knows exactly what to omit):
- `/api/pricing` payload: `models[].minTax`, `hddPricing[cap][line].min`,
  `upgrades[].min`, `install.min`, `amcRate.min`.
- Model/drive-line tiles and RAM/NIC tiles in the configurator UI (they show
  a Max/Min pair or a range).
- The price table rows and the two "Totals" rows (`grandMax`/`grandMin`
  elements in `renderQuote()`).
- Add-on (install/AMC) price display.
- The admin panel's product editor (live-computed minimum preview) and price
  history — this is an *internal* admin surface and should stay in the clone
  too; only the **customer/configurator-facing** side must drop min.

The PDF (`frontend/src/pdf.js`) already never includes min — `ui.lastQuote`
in `app.js` is built without a min field on purpose, well before this
distinction existed. No change needed there for the clone.

## 6. The configurator: all 11 sections and inputs

State lives in one object, `answers` (`frontend/src/app.js`):

```js
{
  storageMode: "capacity" | "budget",
  targetTB: 20,             // capacity mode target
  budget: 200000,           // budget mode target, ₹
  brand: "any",
  bays: null,               // pinned chassis size, or null = auto
  raid: "RAID5",
  raidAuto: true,           // budget mode only: true = auto-pick RAID (see below)
  expandable: false,        // "must have expansion room" filter
  modelId: null,            // pinned NAS model, or null = auto-pick cheapest
  driveCap: null,           // pinned drive size (TB), or null = auto
  driveLine: null,          // pinned drive brand/line, or null = auto
  autoPick: true,           // false once rep manually pins a model
  speed: null,              // informational network-speed selection
  ramSku: null,             // selected RAM upgrade product, or null
  nicSku: null,             // selected NIC upgrade product, or null
  includeInstall: true,
  includeAMC: false,
  custName: "", custLocation: "", repName: "", validity: "15 days"
}
```

Every change re-runs `derive()`, which recomputes everything downstream and
re-renders all sections (`renderAll()`), except the Quotation-details text
inputs, which are never destroyed/rebuilt (to preserve cursor position);
after any re-render, focus is restored by matching `name`+`value`.

1. **Storage** — a mode toggle (Capacity / Budget), then either:
   - *Capacity mode*: numeric TB target (2 TB steps, 2–200 TB range,
     validated by `buildabilityError()`).
   - *Budget mode*: a ₹ numeric input (min 1000, step 1000) + quick preset
     chips `[100000, 150000, 200000, 300000, 500000]` (₹1L/1.5L/2L/3L/5L).
     Entering budget mode defaults `raidAuto = true` and seeds
     `budget = 200000` if unset.
2. **Brand** — "any" or a specific brand, filters candidate models.
3. **Bays** — pin a chassis size, or leave auto.
4. **RAID** — pick a level, or (budget mode only) leave it on
   "chosen automatically" with a **Reset to automatic** control once the rep
   has overridden it. Auto-RAID logic: see below.
5. **Expandability** — "must be expandable" checkbox; only true for chassis
   whose `expandable` flag is set in the catalogue (this is a per-product
   fact from the price sheet, not derived from bay count or brand).
6. **Suggested NAS model** — auto-picks cheapest qualifying model, or the
   rep pins one (`modelId`, sets `autoPick=false`), with a **Reset to
   automatic** control.
7. **Network speed** — informational: shows the fastest link the chosen
   model supports out of the box (parsed from its `network` spec string via
   `topSpeed()`/`labelForSpeed()`), and factors in a selected NIC upgrade's
   own parsed speed ("Supported with the network card added").
8. **Drives** — pin drive capacity and/or drive line (brand/model), or leave
   auto; only combinations that are actually priced are offered.
9. **RAM & network upgrade** — optional per-chassis add-ons. Any product in
   the RAM or NIC catalogue category is offered as a plain choice for every
   build (there is deliberately no per-model compatibility table — fit is a
   human judgement call, not enforced by the app). Shows "Nothing priced
   yet" if the catalogue has none.
10. **Add-ons** — Installation (checkbox, on by default) and AMC (checkbox,
    off by default, computed as a percentage of hardware cost).
11. **Quotation details** — free text: customer name, location, rep name,
    validity string. Rendered once, never re-rendered, so typing doesn't
    lose focus.

### The sizing/recommendation engine (`frontend/src/logic.js`, pure functions)

- `computeDrives(raid, driveTB, targetTB, maxBays)` — smallest drive count
  that reaches a TB target inside one chassis; spreads across multiple whole
  chassis if it can't, and flags `exceeded`.
- `buildableSizes(...)` — every usable TB value actually achievable with
  what's in the catalogue (populates the capacity dropdown so a rep can't
  type a number nothing can build).
- `suggestBuilds(targetTB, raid, ...)` — every way to hit a capacity target,
  cheapest first (a "build" = model + drive size/line + drive count + chassis
  count, treated as one indivisible unit because these choices interact).
- `suggestBuildsForBudget(budget, raid, ...)` — the dual: every build at a
  fixed RAID level that fits under a budget, **most usable TB first**, then
  cheapest, then fewest chassis.
- `suggestBudgetPlan(budget, ...)` — **the auto-RAID "best solution" picker**.
  Tries RAID levels in `RAID_REDUNDANCY_ORDER = [RAID6, RAID10, RAID5, RAID1,
  RAID0]` and returns the **first** level with *any* build fitting the
  budget at all. This is deliberate: maximizing raw TB across all RAID levels
  always degenerates to RAID0 (zero fault tolerance) for any budget, which is
  a bad default to sell silently. So the policy is "keep redundancy unless
  the budget genuinely can't afford it," not "maximize capacity."
- `bestBuildPerModel(...)` — collapses a build list to one (the best) per
  model, so the model list offers real alternatives.
- `topSpeed(spec)` / `labelForSpeed(gb)` / `networkFor(model)` /
  `bestNetworkAmong(builds)` — extract "10GbE"-style link speed out of
  free-text spec strings.

`app.js`'s `derive()` dispatches to `deriveByCapacity()` or
`deriveByBudget()`, both funneling through a shared `finishDerive()` that
narrows by any pinned choices and computes the final price.

## 7. PDF quotation

`frontend/src/pdf.js` + `frontend/src/company.js`, built with jsPDF +
jspdf-autotable, **vendored locally** in `frontend/vendor/` (a pinned CDN URL
404'd in production once — never rely on an external CDN for this). Contains
a company letterhead, customer/rep/validity details, a line-item table
(NAS, drives, RAM/NIC if selected, install, AMC), and a total. **Only ever
prints the Max/quote price** — `ui.lastQuote` in `app.js` is built without a
min field on purpose. This is already exactly the behaviour the clone needs;
no changes required.

## 8. The "no minimum" mechanism — copy this pattern

This project proves out the pattern without touching its own default
behaviour, via a single parameter (`backend/pricing.js`):

```js
export async function buildPricingPayload({ asOf, includeMin = true } = {}){
  ...
  const price = (quote, min) => includeMin ? { quote, min } : { quote };
  // every quote/min pair in the payload (models[].minTax, hddPricing[...].min,
  // upgrades[].min, install.min, amcRate.min) is built through this or gated
  // with `...(includeMin ? { minTax: ... } : {})`
}
```

and two routes (`backend/routes.js`):

```js
router.get("/pricing", wrap(async (req, res) => {
  res.json(await buildPricingPayload({ asOf: req.query.asOf, includeMin: true }));
}));
router.get("/pricing/public", wrap(async (req, res) => {
  res.json(await buildPricingPayload({ asOf: req.query.asOf, includeMin: false }));
}));
```

**Why this matters for the clone**: hiding min in HTML/CSS is not enough —
anyone can open the Network tab and read the raw JSON response. The minimum
must never be *computed into the response* for the customer-facing surface.
For a clone project where min should **never** exist anywhere, the simplest
approach is to make this the *only* mode: call `buildPricingPayload({
includeMin: false })` unconditionally (or don't even build the `min`/`minTax`
fields into the payload function at all), and mirror the same omission in
every frontend render path listed in §5's bullet list (model/drive tiles, RAM/
NIC tiles, price table, the two Totals rows). The admin panel is internal —
it's fine (arguably necessary, so someone can still see cost/margin) for the
clone's `/admin` to keep showing min; only the public/rep-facing configurator
surface needs to drop it everywhere.

## 9. Admin panel (`frontend/admin/`)

- **Products/Prices tab** — a cascading category → brand/line filter menu
  (this replaced a broken hover-based filter that used to merge unrelated
  brands together), a product list, and an editor dialog per product that
  shows a live-computed minimum preview as the admin types a price, plus the
  full price history for that product (every row ever inserted into
  `prices`, since it's append-only).
- **Quotations tab** — read-only list of the `quotes` table.
- **Users tab** — create/edit rep and admin accounts; refuses to
  deactivate/demote the last remaining active admin.

## 10. Auth & security

- Session-based auth, scrypt password hashing (`backend/auth.js`).
- Session tokens are random bytes; only their SHA-256 hash is stored
  server-side (`sessions.token_hash`) — a stolen database dump can't be used
  to forge a session.
- Cookie: `HttpOnly; SameSite=Lax; Secure` (Secure only in production, since
  local dev isn't HTTPS).
- Roles: `admin` (everything) vs `rep` (configurator + their own quotes).
- Login rate limiting (`backend/ratelimit.js`): 10 attempts / 10 minutes per
  IP, in-memory, cleared on a successful login. Kept as its own module
  specifically to avoid a circular import between `routes.js` and `index.js`.

## 11. API surface

- `GET /api/pricing` — full payload, min included (internal tool).
- `GET /api/pricing/public` — same payload, min omitted entirely (see §8).
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- Admin CRUD routes for products, prices, users, and read access to quotes
  (see `backend/routes.js` for exact paths — same shape as the tables in §4).

## 12. Deployment

Docker (non-root user, healthcheck), deployed on Render (`render.yaml`,
Singapore region, free tier; also has a `railway.json` for that alternative).
`.dockerignore` excludes `backend/.env`, `backend/data`, and any generated
admin-password file. Auto-deploys on push to `main`. Database: SQLite file
locally, Postgres via Neon in production (`backend/db.js` handles both
dialects transparently — see §2). Neon-specific hardening worth carrying
over if the clone also uses Neon: raise the connect timeout (cold start can
take 15s+), strip `sslmode`/`channel_binding` query params before handing
the connection string to `pg` (it isn't libpq and will warn on them), and
retry transient errors (`ECONNRESET`, "terminating connection") on startup
migrations since a waking Neon compute can drop the first connection.

## 13. What's deliberately NOT solved (known gaps, same in both projects)

- The configurator's PDF/quote button doesn't POST to the `quotes` table
  yet — `quotes` exists and is API-tested, just not wired up from the UI.
- No compatibility matrix for RAM/NIC vs. chassis — by design, a human
  judgement call, not a gap to fix.
- If the clone needs the recommendation engine driven from a *different*
  backend (e.g. embedded into another company site's own server), the
  portable unit is all of `frontend/src/logic.js` — it has zero DOM/browser
  dependencies and is already unit-tested standalone; it can be copied
  as-is into any Node backend without dragging along `app.js` or the DOM
  rendering layer.
