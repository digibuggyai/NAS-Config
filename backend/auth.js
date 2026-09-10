/* Authentication: password hashing, session cookies, and role gates.
 *
 * Sessions are opaque random tokens. Only their SHA-256 hash is stored, so a
 * leaked database dump can't be used to log in as anyone.
 */

import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, nowIso } from "./db.js";

const scrypt = promisify(crypto.scrypt);

const COOKIE = "nas_session";
const SESSION_DAYS = 14;

/* ---------------- passwords ---------------- */

export async function hashPassword(plain){
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(plain, salt, 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(plain, stored){
  const [scheme, salt, hex] = String(stored || "").split("$");
  if(scheme !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(plain, salt, 64);
  const expected = Buffer.from(hex, "hex");
  // Constant-time: a length mismatch must not short-circuit either.
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

/* ---------------- sessions ---------------- */

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");

export async function createSession(userId){
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db().run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [hashToken(token), userId, nowIso(), expires]
  );
  return { token, expires };
}

export async function destroySession(token){
  if(token) await db().run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

export async function userForToken(token){
  if(!token) return null;
  const row = await db().get(
    `SELECT u.id, u.email, u.name, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [hashToken(token)]
  );
  if(!row) return null;
  if(new Date(row.expires_at) < new Date()){
    await destroySession(token);
    return null;
  }
  if(!(row.active === 1 || row.active === true)) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/** Clears expired rows. Called on login rather than on a timer — sessions are
 *  checked against their expiry anyway, so this is only housekeeping. */
export async function pruneSessions(){
  await db().run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
}

/* ---------------- cookies ---------------- */

export function readCookie(req, name = COOKIE){
  const header = req.headers.cookie || "";
  for(const part of header.split(";")){
    const [k, ...rest] = part.trim().split("=");
    if(k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function setSessionCookie(res, token, expires){
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${new Date(expires).toUTCString()}`);
}

export function clearSessionCookie(res){
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------------- middleware ---------------- */

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export async function attachUser(req, res, next){
  try{
    req.user = await userForToken(readCookie(req));
  }catch(e){
    req.user = null;
  }
  next();
}

/** Gate for any signed-in user, or for a specific role. */
export function requireRole(...roles){
  return (req, res, next) => {
    if(!req.user) return res.status(401).json({ error: "Not signed in" });
    if(roles.length && !roles.includes(req.user.role)){
      return res.status(403).json({ error: "Your account can't do that" });
    }
    next();
  };
}

export { COOKIE };
