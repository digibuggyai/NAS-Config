/* Deployment config.
 *
 * Prices come from the pricing backend (backend/), which serves them at
 * /api/pricing. Because the backend also serves this page, a relative path is
 * all that's needed; point it at a full URL only if the two are deployed apart.
 *
 * The Google Sheet this tool started on is no longer the source of truth — the
 * catalogue lives in the database, edited through /admin. apps-script/ is kept
 * only for importing from the old sheet.
 */
export const PRICING_ENDPOINT = "/api/pricing";

/* The customer-facing page (customer.html) uses this instead. The server never
 * puts a minimum/floor price in this response at all — see backend/routes.js —
 * so there is nothing for a curious customer to find by opening dev tools. */
export const PRICING_ENDPOINT_PUBLIC = "/api/pricing/public";

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

/* Per-machine override, so a rep can point at a staging backend without a rebuild:
 *   localStorage.setItem("nasconfig.endpoint", "https://staging.example.com/api/pricing")
 */
export const ENDPOINT_OVERRIDE_KEY = "nasconfig.endpoint";
