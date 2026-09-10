# Pricing endpoint (Google Apps Script)

`Code.gs` turns the **Pricing** tab of the "NAS COLD MESSAGE" sheet into the JSON
the configurator loads. Prices are edited in the sheet as they always were; the
configurator picks them up on the next page load.

## One-time setup

1. Open the sheet → **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` and paste in the contents of this folder's `Code.gs`.
3. Run **`preview`** once from the editor toolbar. Google asks for authorization
   (it's your own sheet — approve it), then **View → Logs** shows the JSON it produced.
   Check the `warnings` array and the model/price counts before going further.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then copy the **Web app URL** (ends in `/exec`).
5. Paste that URL into [`src/config.js`](../src/config.js) as `SHEET_ENDPOINT`.

"Anyone" access is what lets the configurator fetch the URL from a browser without
credentials. It exposes **only** the JSON this script returns — the derived price
list — not the spreadsheet, and it is read-only: `doGet` never writes. Anyone with
the URL can read prices, so treat the URL itself as internal.

After editing `Code.gs` later, use **Deploy → Manage deployments → Edit → Version:
New version** so the same `/exec` URL serves the update. A brand-new deployment
gets a new URL and `config.js` would need changing again.

## Checking it

- `…/exec` — the JSON the app consumes.
- `…/exec?debug=1` — the same, pretty-printed with the grid dimensions it read.

The response always carries a `warnings` array. The configurator shows those
warnings to the rep in the quote panel, so a model skipped for a missing price is
visible rather than silently absent.

## How the parsing works

Nothing is addressed by cell position. Tables are found by matching header **text**
against the synonym lists in `HEADERS` at the top of `Code.gs`, so rows and columns
can be moved, and drive lines or NAS models can be added, without touching code:

- **Models** — the first row carrying both a "model"-ish and a "quote"-ish header.
  Reads brand, bays, quote, with-tax, and RAID from that row's columns; rows are
  consumed until two consecutive blanks.
- **Drives** — the first row carrying a "capacity"-ish header. Every other non-empty
  header on that row is treated as a drive line, paired with the column to its right
  when that one reads "minimum"/"with tax". A blank price cell means "not priced".
- **Installation / AMC** — found as labelled rows anywhere on the tab; the first two
  numbers to the right of the label are the Max and Min. Percentages are normalised
  (`10%` → `0.10`).

Two things the sheet doesn't carry are filled from hint maps in the script, and are
overridden by a sheet column whenever one exists:

- `BAY_HINTS` — bay counts, if the sheet has no bays column.
- `EXPANDABLE_HINTS` — expandability, which is product-line knowledge rather than
  sheet data. See "Known gaps" in the main README.

If the sheet's headers are worded differently from the synonyms, add the wording to
the relevant `HEADERS` list — that's the only edit this file should need.

The parser is unit-tested against synthetic grids in
[`test/appsscript.test.mjs`](../test/appsscript.test.mjs); run `npm test` after
editing `Code.gs`.

## Refresh cadence

The configurator fetches on every page load and caches the last good response in the
browser, so a rep who loses connectivity mid-call keeps quoting recent prices (the
panel says the prices are cached). There is also a **Refresh** button next to the
price-list line for pulling a mid-session sheet edit.
