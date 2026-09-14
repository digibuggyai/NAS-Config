/* The customer-facing quotation.
 *
 * White sheet, black text, one blue used for structure — the header band, the
 * table head, the total. The customer sees ONE price: the quote price. The
 * minimum is an internal floor for the rep to negotiate against and never
 * appears on a document that leaves the building.
 *
 * Built with jsPDF + autotable, served from this origin (frontend/vendor).
 */

import { COMPANY, contactLine, registrationLine } from "./company.js";

/* DigiBuggy blue. One constant so the whole document moves together — swap it
 * for the brand hex and every rule, band and heading follows. */
const BLUE       = [11, 61, 145];     // #0B3D91
const BLUE_LIGHT = [232, 238, 250];   // row banding and soft fills
const BLACK      = [17, 17, 17];
const GREY       = [110, 118, 128];
const RULE       = [214, 220, 230];

/* The white mark on a transparent ground, so it sits on the blue band without a
 * black square behind it. Generated from the supplied artwork by
 * tools/make-logo-variants.mjs; the JPEG is the last-resort fallback. */
const LOGO_SOURCES = ["/assets/logo-white.png", "/assets/logo.jpeg"];

const MARGIN = 42;
const BAND_H = 76;

/* ---------------- logo ---------------- */

let logoCache;   // undefined = not tried, null = absent

/** Loads the logo once per session. A missing file is not an error: the header
 *  falls back to the wordmark, so a quotation can always be produced. */
async function loadLogo(){
  if(logoCache !== undefined) return logoCache;
  for(const url of LOGO_SOURCES){
    try{
      const res = await fetch(url, { cache: "force-cache" });
      if(!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = url.endsWith(".png") ? "image/png" : "image/jpeg";
      logoCache = `data:${mime};base64,${base64(bytes)}`;
      return logoCache;
    }catch{ /* try the next source */ }
  }
  logoCache = null;
  return logoCache;
}

/* Straight bytes to base64. FileReader would also do this, but it behaves
   differently across environments and failed silently — producing a quotation
   with no logo rather than an error. */
function base64(bytes){
  let binary = "";
  const CHUNK = 0x8000;                       // apply() has an argument limit
  for(let i = 0; i < bytes.length; i += CHUNK){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ---------------- document ---------------- */

export async function buildPdf(q){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const logo = await loadLogo();

  header(doc, q, pageW, logo);
  let y = BAND_H + 34;

  y = parties(doc, q, pageW, y);
  y = configuration(doc, q, pageW, y);
  y = lineItems(doc, q, pageW, y);
  y = terms(doc, q, pageW, y);
  signature(doc, q, pageW, pageH, y);
  footer(doc, pageW, pageH);

  return doc;
}

/* ---------------- header band ---------------- */

function header(doc, q, pageW, logo){
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, pageW, BAND_H, "F");

  let x = MARGIN;
  if(logo){
    // square mark, sized to the band with room to breathe
    const size = 40;
    const format = logo.startsWith("data:image/png") ? "PNG" : "JPEG";
    doc.addImage(logo, format, x, (BAND_H - size) / 2, size, size);
    x += size + 14;
  }

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text(COMPANY.name, x, BAND_H / 2 - 2);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(206, 219, 245);
  doc.text(COMPANY.tagline, x, BAND_H / 2 + 12);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text("QUOTATION", pageW - MARGIN, BAND_H / 2 - 4, { align: "right" });

  doc.setFont("courier", "normal");
  doc.setFontSize(9);
  doc.setTextColor(206, 219, 245);
  doc.text(q.ref, pageW - MARGIN, BAND_H / 2 + 12, { align: "right" });
}

/* ---------------- who it is for ---------------- */

function parties(doc, q, pageW, y){
  const colW = (pageW - MARGIN * 2) / 3;

  const block = (x, label, lines) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...BLUE);
    doc.text(label.toUpperCase(), x, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...BLACK);
    lines.filter(Boolean).forEach((line, i) => doc.text(String(line), x, y + 15 + i * 12.5));
  };

  block(MARGIN, "Prepared for", [q.cust.name || "—", q.cust.location]);
  block(MARGIN + colW, "Prepared by", [q.cust.rep || "—", COMPANY.legalName]);
  block(MARGIN + colW * 2, "Date", [
    formatDate(new Date()),
    q.cust.validity ? `Valid for ${q.cust.validity}` : null
  ]);

  return y + 52;
}

/* ---------------- what is being quoted ---------------- */

function configuration(doc, q, pageW, y){
  y = sectionHeading(doc, "Configuration", pageW, y);

  const rows = [
    ["NAS unit", q.model ? `${q.model.id} · ${q.model.brand} · ${q.model.bays}-bay` : "—"],
    ["Drives", `${q.totalDrives} × ${q.driveCap} TB ${q.driveBrand}`],
    ["RAID level", `${q.raid} — ${q.raidLabel.replace(/^RAID\s?\d+\s—\s/, "")}`],
    ["Usable capacity", `${q.usableDelivered} TB`],
    ["Network", q.speed],
    ["Expansion", q.expandable ? "Expandable unit requested" : "Not requested"]
  ];
  if(q.units > 1) rows.splice(1, 0, ["Quantity", `${q.units} units`]);

  const labelW = 108;
  doc.setFontSize(9.5);
  for(const [label, value] of rows){
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...GREY);
    doc.text(label, MARGIN, y);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BLACK);
    doc.text(String(value), MARGIN + labelW, y, { maxWidth: pageW - MARGIN * 2 - labelW });
    y += 14;
  }
  return y + 12;
}

/* ---------------- the money ---------------- */

function lineItems(doc, q, pageW, y){
  y = sectionHeading(doc, "Quotation", pageW, y);

  doc.autoTable({
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head: [["Description", "Qty", "Rate", "Amount"]],
    body: q.lines.map(l => [
      l.detail ? `${l.description}\n${l.detail}` : l.description,
      l.qty == null ? "" : String(l.qty),
      l.rate == null ? "" : rupees(l.rate),
      rupees(l.amount)
    ]),
    foot: [["Total", "", "", rupees(q.grandQuote)]],
    theme: "plain",
    styles: {
      font: "helvetica", fontSize: 9.5, textColor: BLACK,
      cellPadding: { top: 8, bottom: 8, left: 8, right: 8 },
      lineColor: RULE, lineWidth: { bottom: 0.5 }
    },
    headStyles: {
      fillColor: BLUE, textColor: [255, 255, 255], fontStyle: "bold",
      fontSize: 8.5, cellPadding: { top: 7, bottom: 7, left: 8, right: 8 }, lineWidth: 0
    },
    footStyles: {
      fillColor: BLUE_LIGHT, textColor: BLUE, fontStyle: "bold", fontSize: 12,
      cellPadding: { top: 9, bottom: 9, left: 8, right: 8 }, lineWidth: 0
    },
    columnStyles: {
      0: { cellWidth: pageW - MARGIN * 2 - 230 },
      1: { cellWidth: 46,  halign: "center" },
      2: { cellWidth: 84,  halign: "right" },
      3: { cellWidth: 100, halign: "right", fontStyle: "bold" }
    },
    didParseCell(data){
      // the second line of a description is a quieter sub-label
      if(data.section === "body" && data.column.index === 0 && data.cell.raw.includes("\n")){
        data.cell.styles.minCellHeight = 30;
      }
    }
  });

  return doc.lastAutoTable.finalY + 8;
}

/* ---------------- terms ---------------- */

function terms(doc, q, pageW, y){
  const notes = [];
  if(q.units > 1){
    notes.push(`This configuration is delivered as ${q.units} units; installation is quoted per unit.`);
  }
  notes.push("Prices are inclusive of GST unless stated otherwise, and are valid for the period shown above.");
  notes.push("Delivery and installation scheduled on confirmation of order. Warranty as per manufacturer terms.");
  notes.push("Network speed reflects the ports supplied with the unit. Add-in cards are not included unless listed.");

  y = sectionHeading(doc, "Terms", pageW, y + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...GREY);
  for(const note of notes){
    const wrapped = doc.splitTextToSize("•  " + note, pageW - MARGIN * 2);
    doc.text(wrapped, MARGIN, y);
    y += wrapped.length * 11 + 2;
  }
  return y;
}

/* ---------------- sign-off ---------------- */

function signature(doc, q, pageW, pageH, y){
  // keep the block off the footer even on a long quotation
  const top = Math.min(y + 26, pageH - 120);

  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.5);
  doc.line(pageW - MARGIN - 170, top + 34, pageW - MARGIN, top + 34);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...GREY);
  doc.text(`For ${COMPANY.legalName}`, pageW - MARGIN, top + 46, { align: "right" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...BLACK);
  doc.text(q.cust.rep || "Authorised signatory", pageW - MARGIN, top + 58, { align: "right" });
}

/* The letterhead. A quotation gets filed and acted on weeks later, so the
   address, phone and email have to be on the page itself. */
function footer(doc, pageW, pageH){
  const registration = registrationLine();
  const lines = [
    COMPANY.address.join(", "),
    contactLine(),
    registration
  ].filter(Boolean);

  const blockH = lines.length * 10 + 12;
  const top = pageH - blockH - 10;

  doc.setDrawColor(...BLUE);
  doc.setLineWidth(2);
  doc.line(MARGIN, top, pageW - MARGIN, top);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...BLUE);
  doc.text(COMPANY.legalName.toUpperCase(), MARGIN, top + 13);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(...GREY);
  lines.forEach((line, i) => {
    doc.text(line, pageW - MARGIN, top + 13 + i * 10, { align: "right" });
  });
}

/* ---------------- helpers ---------------- */

function sectionHeading(doc, label, pageW, y){
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...BLUE);
  doc.text(label.toUpperCase(), MARGIN, y);

  doc.setDrawColor(...BLUE);
  doc.setLineWidth(1);
  doc.line(MARGIN, y + 5, pageW - MARGIN, y + 5);

  return y + 22;
}

export function quoteRef(){
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `DGB-NAS-${stamp}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

export function quoteFilename(customerName){
  const slug = customerName ? customerName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") : "";
  return "DigiBuggy-NAS-Quotation-" + (slug || "draft") + ".pdf";
}

/* jsPDF's built-in Helvetica is WinAnsi-encoded and has no rupee glyph, so the
   currency is spelled out. The on-screen panel still uses ₹. */
function rupees(n){ return "Rs. " + Math.round(n).toLocaleString("en-IN"); }
function formatDate(d){ return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
