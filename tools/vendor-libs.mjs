/* Copies the browser builds of the PDF libraries into frontend/vendor so the
 * page loads them from its own origin.
 *
 *   npm run vendor
 *
 * Run after upgrading jspdf or jspdf-autotable.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "frontend", "vendor");
mkdirSync(dest, { recursive: true });

const files = [
  ["jspdf", "dist/jspdf.umd.min.js"],
  ["jspdf-autotable", "dist/jspdf.plugin.autotable.min.js"]
];

/* Read straight from node_modules rather than require.resolve: some packages
   (jspdf-autotable among them) don't export ./package.json, so resolving through
   the package entry point fails. */
const modules = join(root, "node_modules");

for(const [pkg, file] of files){
  const version = JSON.parse(readFileSync(join(modules, pkg, "package.json"), "utf8")).version;
  const name = file.split("/").pop();
  const to = join(dest, name);
  copyFileSync(join(modules, pkg, file), to);
  console.log(`${pkg}@${version} -> frontend/vendor/${name} (${(statSync(to).size / 1024).toFixed(0)} KB)`);
}
