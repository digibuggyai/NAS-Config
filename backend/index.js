/* NAS Configurator server: the API, the admin UI and the configurator itself. */

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";
import { initDb, closeDb } from "./db.js";
import { attachUser } from "./auth.js";
import { router } from "./routes.js";
import { loginRateLimit } from "./ratelimit.js";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..", "frontend");

export function createApp(){
  const app = express();

  app.disable("x-powered-by");

  /* Behind a platform's TLS terminator, the app only sees plain HTTP. Trusting
     the proxy is what lets it know the original request was HTTPS. */
  app.set("trust proxy", 1);

  app.use(securityHeaders);
  app.use(express.json({ limit: "256kb" }));
  app.use(attachUser);

  app.use("/api/auth/login", loginRateLimit);
  app.use("/api", router);

  // The admin UI is a private page; the configurator is the sales tool. Both are
  // static files served from the frontend folder — there is no build step.
  app.use("/admin", express.static(join(frontend, "admin"), { maxAge: "5m" }));
  app.use(express.static(frontend, { index: "index.html", maxAge: "5m" }));

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Anything thrown in a handler lands here rather than hanging the request.
  app.use((err, req, res, next) => {
    console.error("[server]", err);
    res.status(500).json({ error: "Something went wrong on our side" });
  });

  return app;
}

/* ---------------- hardening ---------------- */

function securityHeaders(req, res, next){
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",          // this is an internal tool, not an embed
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin"
  });
  // HSTS only makes sense once the platform is actually serving HTTPS.
  if(process.env.NODE_ENV === "production"){
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

/* ---------------- entry point ---------------- */

if(process.argv[1] && process.argv[1].endsWith(join("backend", "index.js"))){
  loadEnv();
  await initDb();

  const port = Number(process.env.PORT) || 3000;
  const server = createApp().listen(port, () => {
    console.log(`NAS Configurator listening on :${port}`);
    if(process.env.NODE_ENV !== "production"){
      console.log(`  configurator  http://localhost:${port}/`);
      console.log(`  admin         http://localhost:${port}/admin/`);
    }
  });

  /* Platforms stop a container with SIGTERM and kill it shortly after. Closing
     the listener and the database pool in between means in-flight requests
     finish and connections are released rather than dropped. */
  for(const signal of ["SIGTERM", "SIGINT"]){
    process.on(signal, () => {
      console.log(`[server] ${signal} — shutting down`);
      server.close(async () => {
        await closeDb().catch(() => {});
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 10000).unref();   // don't hang forever
    });
  }
}
