/* Renders a sample quotation so the template can be looked at without clicking
 * through the app.
 *
 *   node tools/render-sample-quote.mjs [out.pdf]
 *
 * Uses the real pdf.js, so what comes out is what a rep would send.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || join(root, "sample-quotation.pdf");

/* pdf.js expects a browser: a jsPDF global, fetch for the logo, and FileReader
   to turn it into a data URL. */
const dom = new JSDOM("", { url: "http://localhost/" });
global.window = dom.window;
global.FileReader = dom.window.FileReader;
global.Blob = dom.window.Blob;
applyPlugin(jsPDF);            // attaches doc.autoTable, as the CDN build does
window.jspdf = { jsPDF };

const assets = join(root, "frontend", "assets");
global.fetch = async (url) => {
  const name = String(url).split("/").pop();
  try{
    const bytes = readFileSync(join(assets, name));
    // pdf.js reads the logo as an ArrayBuffer, so serve it the same shape
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }catch{
    return { ok: false };
  }
};

const { buildPdf, quoteRef } = await import(new URL("../frontend/src/pdf.js", import.meta.url).href);

const quote = {
  ref: quoteRef(),
  targetTB: 20,
  raid: "RAID5",
  raidLabel: "RAID 5 — parity (survives 1 drive failure)",
  speed: "2.5GbE",
  model: { id: "TS-433-4G", brand: "QNAP", bays: 4, network: "2.5GbE ×1 + 1GbE ×1" },
  units: 1,
  drivesPerUnit: 3,
  totalDrives: 3,
  driveCap: 10,
  driveBrand: "IronWolf",
  usableDelivered: 20,
  expandable: false,
  lines: [
    { description: "TS-433-4G — QNAP 4-bay NAS", detail: "Network: 2.5GbE ×1 + 1GbE ×1",
      qty: 1, rate: 45000, amount: 45000 },
    { description: "10 TB IronWolf NAS hard drive", detail: "3 per unit, configured as RAID5",
      qty: 3, rate: 50000, amount: 150000 },
    { description: "On-site installation & setup", detail: "Racking, RAID configuration, network setup",
      qty: 1, rate: 5900, amount: 5900 }
  ],
  grandQuote: 200900,
  cust: { name: "Aarav Enterprises", location: "Pune", rep: "Shreyanshu Gupta", validity: "15 days" }
};

const doc = await buildPdf(quote);
writeFileSync(out, Buffer.from(doc.output("arraybuffer")));
console.log("wrote", out);

/* The logo is the difference between a template and a plain page: if it silently
   failed to embed, say so rather than shipping a blank header. */
const raw = Buffer.from(doc.output("arraybuffer")).toString("latin1");
const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
console.log(images ? `logo embedded (${images} image objects, alpha ${raw.includes("/SMask") ? "kept" : "none"})`
                   : "WARNING: no logo in the document");

/* A customer-facing document must never carry the internal floor price. */
const text = doc.output();
for(const leak of ["188210", "1,88,210", "Min", "minimum"]){
  if(text.includes(leak)) console.error(`LEAK: the document contains "${leak}"`);
}
console.log("checked: no minimum price in the output");
