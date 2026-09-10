-- NAS Configurator — application schema.
--
-- Written to run on both SQLite (local dev) and Postgres (managed hosting);
-- see server/db.js, which rewrites the few dialect-specific bits.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'rep',      -- 'admin' | 'rep'
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                    -- the raw token never touches the database
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per component the company sells, whatever its category.
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT NOT NULL UNIQUE,               -- model number / stable identifier
  category    TEXT NOT NULL,                      -- NAS | HDD | SSD | RAM | NIC | SERVICE | ...
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL DEFAULT '',           -- free text shown under the name
  bays        INTEGER,                            -- NAS only
  capacity_tb REAL,                               -- drives only
  raid        TEXT NOT NULL DEFAULT '[]',         -- JSON array, NAS only
  expandable  INTEGER NOT NULL DEFAULT 0,
  network     TEXT NOT NULL DEFAULT '',           -- NAS only: the ports it ships with, e.g. "2.5GbE x2"
  network_upgrade TEXT NOT NULL DEFAULT '',       -- NAS only: what a card/module can add, e.g. "10GbE via PCIe"
  unit        TEXT NOT NULL DEFAULT 'per_unit',   -- per_unit | per_drive | percent_of_hardware | flat
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category, active);

-- Prices are append-only: changing a price writes a new row rather than
-- overwriting, so an old quotation can always be explained. The price in force
-- is the newest row whose effective_from has passed.
--
-- Two numbers are stored, both as entered by a person:
--   base_price  — ex-GST, what the sheet writes as "19000+"
--   quote_price — the asking price the rep quotes, GST inclusive ("Max")
-- The floor shown as "Min" is DERIVED: base_price x (1 + gst_rate). Every row
-- in the September 2026 price sheet matches that to the rupee, so storing the
-- minimum separately would only let the two drift apart.
CREATE TABLE IF NOT EXISTS prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  base_price     REAL NOT NULL,                   -- ex-GST
  quote_price    REAL NOT NULL,                   -- asking price, GST inclusive
  effective_from TEXT NOT NULL,                   -- ISO date
  note           TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id, effective_from);

-- Quotations are stored whole: the configuration, the priced lines and the
-- totals as they stood, so a re-opened quote shows what the customer was sent
-- even after prices move.
CREATE TABLE IF NOT EXISTS quotes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ref               TEXT NOT NULL UNIQUE,
  customer_name     TEXT NOT NULL DEFAULT '',
  customer_location TEXT NOT NULL DEFAULT '',
  rep_name          TEXT NOT NULL DEFAULT '',
  user_id           INTEGER REFERENCES users(id),
  validity          TEXT NOT NULL DEFAULT '',
  config            TEXT NOT NULL DEFAULT '{}',   -- JSON: the answers behind the quote
  lines             TEXT NOT NULL DEFAULT '[]',   -- JSON: the priced line items
  total_max         REAL NOT NULL DEFAULT 0,
  total_min         REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft',-- draft | sent | won | lost
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_user ON quotes(user_id);

-- Company-wide values the quotation needs that aren't per-product.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
