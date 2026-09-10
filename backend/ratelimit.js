/* A ceiling on sign-in attempts.
 *
 * Lives in its own module so routes.js can clear a counter without importing the
 * server, which would be a cycle.
 */

/* The sign-in endpoint is the one thing on the internet worth guessing at, so
 * it gets a ceiling. In-memory is the right size for a single small instance;
 * more than one instance would want this in the database. */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginRateLimit(req, res, next){
  if(req.method !== "POST") return next();

  const key = req.ip || "unknown";
  const now = Date.now();
  const seen = (attempts.get(key) || []).filter(t => now - t < WINDOW_MS);

  if(seen.length >= MAX_ATTEMPTS){
    const retryIn = Math.ceil((WINDOW_MS - (now - seen[0])) / 1000);
    res.set("Retry-After", String(retryIn));
    return res.status(429).json({
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryIn / 60)} minute(s).`
    });
  }

  seen.push(now);
  attempts.set(key, seen);

  // Keep the map from growing without bound on a long-running process.
  if(attempts.size > 5000){
    for(const [k, times] of attempts){
      if(!times.some(t => now - t < WINDOW_MS)) attempts.delete(k);
    }
  }
  next();
}

/** A successful sign-in clears the counter, so a rep who mistyped twice then got
 *  it right isn't still carrying strikes. */
export function clearLoginAttempts(ip){
  attempts.delete(ip || "unknown");
}
