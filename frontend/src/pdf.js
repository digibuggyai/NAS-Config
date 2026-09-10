/* Quotation PDF, built with jsPDF + autotable (loaded as globals from the CDN). */

export function buildPdf(q){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 52;

  doc.setFont("helvetica","bold"); doc.setFontSize(18); doc.setTextColor(11,44,50);
  doc.text("DigiBuggy", margin, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(90,100,110);
  doc.text("NAS Solution Quotation", margin, y+15);

  doc.setFontSize(9);
  doc.text("Ref: " + q.ref, pageW-margin, y-6, {align:"right"});
  doc.text("Date: " + formatDate(new Date()), pageW-margin, y+8, {align:"right"});
  doc.text("Valid for: " + q.cust.validity, pageW-margin, y+22, {align:"right"});

  y += 40;
  doc.setDrawColor(220,225,230); doc.line(margin, y, pageW-margin, y);
  y += 22;

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(20,25,35);
  doc.text("Prepared for", margin, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(60,70,80);
  doc.text(q.cust.name || "—", margin, y+15);
  doc.text(q.cust.location || "—", margin, y+29);

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(20,25,35);
  doc.text("Prepared by", margin+260, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(60,70,80);
  doc.text(q.cust.rep || "—", margin+260, y+15);
  doc.text("DigiBuggy (DGB India)", margin+260, y+29);

  y += 52;

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(20,25,35);
  doc.text("Configuration summary", margin, y);
  y += 16;

  const summaryLines = [
    "Target usable storage: " + q.targetTB + " TB",
    "RAID level: " + q.raid + " — " + q.raidLabel,
    "Chassis: " + (q.model ? `${q.model.bays}-bay, ${q.drivesPerUnit} bays used` : "—"),
    "Network requirement: " + q.speed,
    "Recommended unit: " + (q.model
      ? `${q.model.id} (${q.model.brand}, ${q.model.bays}-bay)` + (q.units > 1 ? ` × ${q.units} units` : "")
      : "—"),
    "Drives: " + q.totalDrives + " × " + q.driveCap + "TB " + q.driveBrand,
    "Usable capacity delivered: " + q.usableDelivered + " TB",
    "Expansion room requested: " + (q.expandable ? "Yes" : "No")
  ];
  doc.setFont("helvetica","normal"); doc.setFontSize(9.5); doc.setTextColor(60,70,80);
  summaryLines.forEach(line => { doc.text(line, margin, y); y += 14; });

  if(q.exceeded){
    y += 4;
    doc.setTextColor(180,110,10);
    doc.text(
      `Note: target exceeds a single chassis at this drive size — quote scaled to ${q.units} units.`,
      margin, y, { maxWidth: pageW - margin*2 }
    );
    y += 16;
    doc.setTextColor(60,70,80);
  }

  y += 12;

  doc.autoTable({
    startY: y,
    margin: { left:margin, right:margin },
    head: [["Item","Max (list quote)","Min (with tax)"]],
    body: q.rows.map(r => [r[0], rupees(r[1]), rupees(r[2])]),
    foot: [["Total", rupees(q.grandQuote), rupees(q.grandMin)]],
    theme: "plain",
    styles:{ font:"helvetica", fontSize:9.5, textColor:[30,38,48], cellPadding:{top:6,bottom:6,left:0,right:0} },
    headStyles:{ fontStyle:"bold", textColor:[90,100,110], fontSize:8, lineColor:[220,225,230], lineWidth:{bottom:1} },
    footStyles:{ fontStyle:"bold", fontSize:11, textColor:[11,44,50], lineColor:[20,25,35], lineWidth:{top:1.2} },
    columnStyles:{ 0:{ cellWidth: pageW-margin*2-190 }, 1:{ halign:"right", cellWidth:95 }, 2:{ halign:"right", cellWidth:95 } }
  });

  const finalY = doc.lastAutoTable.finalY + 26;
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(140,150,160);
  const disclaimer = "Prices are indicative from the current DigiBuggy price list; taxes/logistics as applicable and subject to confirmation at order time. Network-speed and expandability notes are general guidance — confirm the current spec sheet with the DigiBuggy technical team before finalizing an order.";
  doc.text(disclaimer, margin, finalY, { maxWidth: pageW - margin*2, lineHeightFactor:1.4 });

  return doc;
}

export function quoteRef(){
  return "DGB-NAS-" + Date.now().toString(36).toUpperCase();
}

export function quoteFilename(customerName){
  const slug = customerName ? customerName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") : "";
  return "DigiBuggy-NAS-Quote-" + (slug || "draft") + ".pdf";
}

// jsPDF's built-in helvetica is WinAnsi-encoded and has no rupee glyph, so the
// PDF spells the currency out. The on-screen panel still uses the ₹ symbol.
function rupees(n){ return "Rs. " + Math.round(n).toLocaleString("en-IN"); }
function formatDate(d){ return d.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" }); }
