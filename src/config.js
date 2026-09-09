/* Deployment config.
 *
 * SHEET_ENDPOINT is the Apps Script web-app URL that serves the Pricing tab as
 * JSON (see apps-script/README.md). Paste the /exec URL here once and every rep
 * gets live prices on page load.
 *
 * Leave it empty and the app falls back to data/pricing.json, then to the
 * built-in snapshot — so an unconfigured checkout still runs.
 */
export const SHEET_ENDPOINT = "";

/* Give up on the sheet after this long and quote from cache instead, rather than
 * leaving a rep staring at a blank panel in front of a customer. */
export const FETCH_TIMEOUT_MS = 8000;

/* A tab left open all day would otherwise keep quoting the prices it loaded with,
 * so the sheet is re-fetched in the background on this interval, and again
 * whenever the rep returns to a tab that has been in the background longer than
 * that. Set to 0 to fetch only on load and on the Refresh button. */
export const AUTO_REFRESH_MS = 10 * 60 * 1000;

/* A cached copy of the last good sheet response is kept in localStorage so the
 * tool still opens with recent prices when the network or the sheet is down.
 * Past this age the cache is still used, but the panel says it is stale. */
export const CACHE_KEY = "nasconfig.pricing.v1";
export const CACHE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/* Per-machine override, so a rep can point at a test deployment without a rebuild:
 *   localStorage.setItem("nasconfig.endpoint", "https://script.google.com/.../exec")
 */
export const ENDPOINT_OVERRIDE_KEY = "nasconfig.endpoint";
