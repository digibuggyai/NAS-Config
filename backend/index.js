/* NAS Configurator server: the API, the admin UI and the configurator itself. */

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";
import { initDb } from "./db.js";
import { attachUser } from "./auth.js";
import { router } from "./routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..", "frontend");

export function createApp(){
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(attachUser);

  app.use("/api", router);

  // The admin UI is a private page; the configurator is the sales tool. Both are
  // static files served from the frontend folder — there is no build step.
  app.use("/admin", express.static(join(frontend, "admin")));
  app.use(express.static(frontend, { index: "index.html" }));

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Anything thrown in a handler lands here rather than hanging the request.
  app.use((err, req, res, next) => {
    console.error("[server]", err);
    res.status(500).json({ error: "Something went wrong on our side" });
  });

  return app;
}

/* Run directly: node server/index.js */
if(process.argv[1] && process.argv[1].endsWith(join("backend", "index.js"))){
  loadEnv();
  await initDb();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`NAS Configurator on http://localhost:${port}`);
    console.log(`Admin at        http://localhost:${port}/admin/`);
  });
}
