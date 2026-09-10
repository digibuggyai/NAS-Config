/* Reads backend/.env (or the path in ENV_FILE) into process.env, so a connection
 * string can live in a gitignored file rather than in a shell history.
 *
 * Deliberately tiny and dependency-free: KEY=value, # comments, optional quotes.
 * Anything already set in the real environment wins, so a platform's own
 * variables are never overwritten by a stray local file.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = process.env.ENV_FILE || join(here, ".env")){
  if(!existsSync(file)) return { loaded: false, file, count: 0 };

  let count = 0;
  for(const raw of readFileSync(file, "utf8").split(/\r?\n/)){
    const line = raw.trim();
    if(!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if(eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // strip one layer of matching quotes, which connection strings often carry
    if((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    if(key && process.env[key] === undefined){
      process.env[key] = value;
      count++;
    }
  }
  return { loaded: true, file, count };
}
