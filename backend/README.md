# Pricing backend

The catalogue, the prices, the quote history and the accounts that reach them.
Replaces the Google Sheet as the source of truth.

## Running it

```bash
npm install
npm run seed          # catalogue + opening prices (safe to re-run)
npm start             # http://localhost:3000
```

The first seed also creates an admin account when you give it one:

```bash
ADMIN_EMAIL=you@digibuggy.com ADMIN_PASSWORD='something long' npm run seed
```

| URL | What |
|---|---|
| `/` | the configurator reps use |
| `/admin/` | pricing admin — sign in required |
| `/api/pricing` | the price list the configurator reads (public) |
| `/healthz` | for the platform's health check |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_URL` | — | a Postgres URL. Set it and Postgres is used instead of SQLite. |
| `SQLITE_FILE` | `backend/data/nas.db` | ignored when `DATABASE_URL` is set |
| `NODE_ENV` | — | `production` adds `Secure` to the session cookie |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | read by the seed only, to create the first admin |

**On a managed platform, set `DATABASE_URL`.** Render, Railway and the like give
containers an ephemeral filesystem — a SQLite file there is wiped on every
redeploy. Either attach a persistent volume and point `SQLITE_FILE` at it, or
(simpler) provision their Postgres and let `DATABASE_URL` do the work. The schema
and every query run on both.

## How prices are modelled

Two numbers are entered by a person, one is worked out:

| | |
|---|---|
| **Base** | ex-GST, the sheet's `54000+` |
| **Quote** | the asking price, GST inclusive — the "Max" column |
| **Minimum** | **derived**: base × (1 + GST) — the "Min" column |

Every row of the September 2026 price list matches that identity exactly
(19000 × 1.18 = 22420, 3500 × 1.18 = 4130, and so on for all 29 products), so
storing the minimum separately would only let the two drift apart. The GST rate
lives in `settings` (`gst_rate`, default 0.18) rather than in code.

A percentage line like AMC is not a rupee amount, so GST is not applied to it:
its base is the floor percentage and its quote the asking percentage.

## Price history

`prices` is append-only. Changing a price writes a new row with its own
`effective_from`, who made it and an optional note; nothing is overwritten. The
price in force is the newest row whose date has passed, which means:

- an old quotation can always be explained
- a future increase can be entered today and takes effect on its date
- `GET /api/pricing?asOf=2026-04-01` re-prices at any past or future date

## API

Public:

```
GET    /api/pricing[?asOf=YYYY-MM-DD]
```

Signed in (rep or admin) — a rep sees only their own quotes:

```
GET    /api/quotes           POST /api/quotes          PATCH /api/quotes/:id
GET    /api/quotes/:id
GET    /api/auth/me          POST /api/auth/login      POST /api/auth/logout
```

Admin only:

```
GET    /api/products         POST /api/products
GET    /api/products/:id     PATCH /api/products/:id   DELETE /api/products/:id[?hard=1]
GET    /api/products/:id/prices                        POST /api/products/:id/prices
GET    /api/users            POST /api/users           PATCH /api/users/:id
```

`DELETE` deactivates by default — the product stops being quoted but keeps its
price history and any quotation that used it. `?hard=1` removes the row outright.

## Accounts

- **admin** — everything, including prices and other users
- **rep** — the configurator and their own quotations; the catalogue is closed to
  them, read and write

Passwords are scrypt-hashed with a per-user salt. Sessions are random tokens
stored only as a SHA-256 hash, in an HttpOnly, SameSite=Lax cookie, so a database
dump can't be replayed as a login. Changing a password or disabling an account
drops that user's sessions immediately. The last active admin can't demote or
disable themselves — recovering from that would need direct database access.

## Layout

```
index.js     app wiring and static serving
routes.js    the API
pricing.js   products + prices -> the configurator's payload
db.js        SQLite/Postgres adapter
auth.js      passwords, sessions, role gates
schema.sql   tables
seed.js      catalogue and opening prices
test/        the API driven over HTTP against a throwaway database
```

## Tests

```bash
npm test     # from the repo root, runs both workspaces
```

The backend suite starts the real server on an ephemeral port and drives it over
HTTP: role gates from both sides, product validation, the append-only history,
future-dated prices, and an assertion that the seeded catalogue reproduces the
supplied price sheet to the rupee.
