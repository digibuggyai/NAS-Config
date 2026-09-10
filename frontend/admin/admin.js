/* Pricing admin.
 *
 * Everything here talks to /api. The session is an HttpOnly cookie, so there is
 * no token to store or leak into localStorage.
 */

const $ = id => document.getElementById(id);

const state = {
  user: null, products: [], quotes: [], users: [], gstRate: 0.18, editing: null,
  filterCategory: "",     // "" = all
  filterLine: ""          // brand for NAS, drive line for HDD/SSD
};

const CATEGORIES = ["NAS","HDD","SSD","RAM","NIC","EXPANSION","SERVICE","ACCESSORY"];

const inr = n => (n == null || isNaN(n)) ? "—" : "₹" + Math.round(n).toLocaleString("en-IN");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

/* ---------------- API ---------------- */

async function api(path, { method = "GET", body } = {}){
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, bad = false){
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (bad ? " bad" : "");
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------------- sign in ---------------- */

async function boot(){
  const { user } = await api("/auth/me");
  if(user) showAdmin(user); else showLogin();
}

function showLogin(){
  $("loginScreen").hidden = false;
  $("adminScreen").hidden = true;
  $("loginEmail").focus();
}

async function showAdmin(user){
  state.user = user;
  $("loginScreen").hidden = true;
  $("adminScreen").hidden = false;
  $("whoami").textContent = `${user.name || user.email} · ${user.role === "admin" ? "Administrator" : "Sales rep"}`;

  // A rep can see their own quotes but nothing else.
  const isAdmin = user.role === "admin";
  document.querySelectorAll("[data-admin-only]").forEach(el => { el.hidden = !isAdmin; });
  document.querySelector('.tab[data-tab="products"]').hidden = !isAdmin;
  if(!isAdmin) selectTab("quotes");
  else await loadProducts();

  await loadQuotes();
  if(isAdmin) await loadUsers();
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginError").textContent = "";
  $("loginBtn").disabled = true;
  try{
    const { user } = await api("/auth/login", {
      method: "POST",
      body: { email: $("loginEmail").value, password: $("loginPassword").value }
    });
    $("loginPassword").value = "";
    await showAdmin(user);
  }catch(err){
    $("loginError").textContent = err.message;
  }finally{
    $("loginBtn").disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  location.reload();
});

/* ---------------- tabs ---------------- */

function selectTab(name){
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== name; });
}
$("tabs").addEventListener("click", e => {
  const tab = e.target.closest(".tab");
  if(tab) selectTab(tab.dataset.tab);
});

/* ---------------- products ---------------- */

async function loadProducts(){
  const { products } = await api("/products");
  state.products = products;
  renderCategoryMenu();
  renderProducts();
}

/* A category's "line" is the thing a person would actually filter by: the make
 * for a NAS, the drive family for a disk. */
const lineOf = p => (p.category === "NAS" ? p.brand : p.name) || "";

function linesIn(category){
  const seen = new Map();
  for(const p of state.products){
    if(p.category !== category) continue;
    const line = lineOf(p);
    if(!line) continue;
    seen.set(line, (seen.get(line) || 0) + 1);
  }
  return [...seen.entries()].sort((a,b) => a[0].localeCompare(b[0]));
}

function renderCategoryMenu(){
  const present = CATEGORIES.filter(c => state.products.some(p => p.category === c));

  $("categoryMenu").innerHTML =
    `<button type="button" class="menu-item${state.filterCategory ? "" : " on"}" data-cat="">
       <span>All categories</span><span class="menu-count">${state.products.length}</span>
     </button>
     <div class="menu-sep"></div>` +
    present.map(cat => {
      const count = state.products.filter(p => p.category === cat).length;
      const lines = linesIn(cat);
      const on = state.filterCategory === cat;
      return `<div class="menu-row" data-row="${cat}">
        <button type="button" class="menu-item${on ? " on" : ""}" data-cat="${cat}">
          <span>${esc(cat)}</span>
          <span class="menu-count">${count}${lines.length > 1 ? " ›" : ""}</span>
        </button>
        ${lines.length > 1 ? `<div class="submenu" data-sub="${cat}" hidden>
          <div class="submenu-head">${esc(cat)} by ${cat === "NAS" ? "brand" : "line"}</div>
          <button type="button" class="menu-item${on && !state.filterLine ? " on" : ""}" data-cat="${cat}" data-line="">
            <span>All ${esc(cat)}</span><span class="menu-count">${count}</span>
          </button>
          ${lines.map(([line, n]) => `
            <button type="button" class="menu-item${on && state.filterLine === line ? " on" : ""}"
                    data-cat="${cat}" data-line="${esc(line)}">
              <span>${esc(line)}</span><span class="menu-count">${n}</span>
            </button>`).join("")}
        </div>` : ""}
      </div>`;
    }).join("");

  $("categoryLabel").textContent = state.filterCategory
    ? state.filterCategory + (state.filterLine ? ` · ${state.filterLine}` : "")
    : "All categories";
}

/* ---------------- menu behaviour ---------------- */

function openCategoryMenu(open){
  $("categoryMenu").hidden = !open;
  $("categoryTrigger").setAttribute("aria-expanded", String(open));
  if(!open) closeSubmenus();
}
function closeSubmenus(){
  document.querySelectorAll("#categoryMenu .submenu").forEach(el => { el.hidden = true; });
  document.querySelectorAll("#categoryMenu .menu-item.open").forEach(el => el.classList.remove("open"));
}

$("categoryTrigger").addEventListener("click", () => {
  openCategoryMenu($("categoryMenu").hidden);
});

/* Hovering a category opens its lines; the whole row is the hover target so the
   pointer can travel into the flyout without it closing underneath. */
$("categoryMenu").addEventListener("mouseover", e => {
  const row = e.target.closest(".menu-row");
  if(!row) return;
  closeSubmenus();
  const sub = row.querySelector(".submenu");
  if(sub){
    sub.hidden = false;
    row.querySelector(".menu-item")?.classList.add("open");
  }
});

// Touch and keyboard get the same thing without a hover: focus opens it.
$("categoryMenu").addEventListener("focusin", e => {
  const row = e.target.closest(".menu-row");
  if(!row || row.querySelector(".submenu:not([hidden])")) return;
  closeSubmenus();
  const sub = row.querySelector(".submenu");
  if(sub) sub.hidden = false;
});

$("categoryMenu").addEventListener("click", e => {
  const item = e.target.closest(".menu-item");
  if(!item) return;

  // A category with lines is a gateway on hover, but clicking it still filters.
  state.filterCategory = item.dataset.cat || "";
  state.filterLine = item.dataset.line || "";
  openCategoryMenu(false);
  renderCategoryMenu();
  renderProducts();
});

document.addEventListener("click", e => {
  if(!e.target.closest("#categoryFilter")) openCategoryMenu(false);
});
document.addEventListener("keydown", e => {
  if(e.key === "Escape" && !$("categoryMenu").hidden){
    openCategoryMenu(false);
    $("categoryTrigger").focus();
  }
});

function renderProducts(){
  const term = $("productSearch").value.trim().toLowerCase();
  const showInactive = $("showInactive").checked;

  const rows = state.products.filter(p =>
    (showInactive || p.active) &&
    (!state.filterCategory || p.category === state.filterCategory) &&
    (!state.filterLine || lineOf(p) === state.filterLine) &&
    (!term || `${p.sku} ${p.name} ${p.brand}`.toLowerCase().includes(term))
  );

  const body = $("productRows");
  if(!rows.length){
    body.innerHTML = `<tr><td colspan="8" class="empty">No products match.</td></tr>`;
    $("productNote").textContent = "";
    return;
  }

  let html = "", lastCat = null;
  for(const p of rows){
    if(p.category !== lastCat){
      html += `<tr class="cat-row"><td colspan="8">${esc(p.category)}</td></tr>`;
      lastCat = p.category;
    }
    const pct = p.unit === "percent_of_hardware";
    const spec = p.bays ? `${p.bays}-bay` : p.capacityTb ? `${p.capacityTb} TB` : (p.spec || "—");
    html += `<tr class="${p.active ? "" : "inactive"}" data-id="${p.id}">
      <td><span class="name">${esc(p.name)}</span>
          <span class="sub">${esc(p.sku)}${p.brand ? " · " + esc(p.brand) : ""}${p.active ? "" : " · inactive"}</span></td>
      <td>${esc(p.category)}</td>
      <td class="num">${esc(spec)}${p.network ? `<span class="sub">${esc(p.network)}</span>` : ""}</td>
      <td class="num">${p.price ? fmt(p.price.base, pct) : `<span class="unpriced">not priced</span>`}</td>
      <td class="num">${p.price ? fmt(p.price.quote, pct) : "—"}</td>
      <td class="num">${p.price ? fmt(p.price.min, pct) : "—"}</td>
      <td class="num">${p.price ? esc(p.price.effectiveFrom) : "—"}</td>
      <td class="num"><button type="button" class="row-action" data-edit="${p.id}">Edit</button></td>
    </tr>`;
  }
  body.innerHTML = html;

  const unpriced = rows.filter(p => !p.price).length;
  $("productNote").textContent =
    `${rows.length} product${rows.length === 1 ? "" : "s"}` +
    (state.filterLine ? ` in ${state.filterCategory} · ${state.filterLine}` : "") +
    (unpriced ? ` · ${unpriced} without a price, so not quotable` : "") +
    ` · minimum = base + ${Math.round(state.gstRate * 100)}% GST`;
}

const fmt = (n, isPercent) => isPercent ? `${n}%` : inr(n);

["productSearch","showInactive"].forEach(id =>
  $(id).addEventListener("input", renderProducts));

$("productRows").addEventListener("click", e => {
  const btn = e.target.closest("[data-edit]");
  if(btn) openProduct(state.products.find(p => p.id === Number(btn.dataset.edit)));
});

$("newProductBtn").addEventListener("click", () => openProduct(null));

/* ---------------- product editor ---------------- */

function openProduct(product){
  state.editing = product;
  const f = $("productForm");
  f.reset();

  const sel = $("productCategory");
  if(!sel.options.length){
    for(const c of CATEGORIES){
      const opt = document.createElement("option");
      opt.value = opt.textContent = c;
      sel.add(opt);
    }
  }

  $("productDialogTitle").textContent = product ? product.name : "New product";
  $("productError").textContent = "";
  $("deactivateBtn").hidden = !product || !product.active;
  $("historyBlock").hidden = !product;

  if(product){
    f.elements.sku.value = product.sku;
    f.elements.category.value = product.category;
    f.elements.name.value = product.name;
    f.elements.brand.value = product.brand;
    f.elements.spec.value = product.spec;
    f.elements.bays.value = product.bays ?? "";
    f.elements.capacityTb.value = product.capacityTb ?? "";
    f.elements.unit.value = product.unit;
    f.elements.network.value = product.network || "";
    f.elements.networkUpgrade.value = product.networkUpgrade || "";
    f.elements.active.value = product.active ? "1" : "0";
    f.elements.expandable.value = product.expandable ? "1" : "0";
    f.querySelectorAll('input[name="raid"]').forEach(cb => { cb.checked = product.raid.includes(cb.value); });
    if(product.price){
      f.elements.priceBase.value = product.price.base;
      f.elements.priceQuote.value = product.price.quote;
    }
    loadHistory(product.id);
  } else {
    f.elements.category.value = "NAS";
  }

  f.elements.priceEffectiveFrom.value = new Date().toISOString().slice(0,10);
  syncCategoryFields();
  updateComputedMin();
  showDialog($("productDialog"));
}

function syncCategoryFields(){
  const f = $("productForm");
  const cat = f.elements.category.value;
  $("nasFields").hidden = cat !== "NAS";
  $("driveFields").hidden = !(cat === "HDD" || cat === "SSD");

  // Sensible default for how this category is charged.
  if(!state.editing){
    f.elements.unit.value = cat === "NAS" ? "per_unit"
      : (cat === "HDD" || cat === "SSD") ? "per_drive"
      : f.elements.unit.value;
  }
  updateComputedMin();
}

function updateComputedMin(){
  const f = $("productForm");
  const pct = f.elements.unit.value === "percent_of_hardware";
  const base = Number(f.elements.priceBase.value);
  const gst = Math.round(state.gstRate * 100);

  $("priceHint").textContent = pct
    ? "Percentages, not rupees: base is the floor the rep can discount to, quote is the asking rate."
    : `Enter the ex-GST base and the asking price. The quotation's minimum is worked out as base + ${gst}% GST.`;

  if(!Number.isFinite(base) || !f.elements.priceBase.value){
    $("computedMin").textContent = "";
    return;
  }
  $("computedMin").innerHTML = pct
    ? `Floor <b>${base}%</b> · asking <b>${Number(f.elements.priceQuote.value) || base}%</b>`
    : `Minimum shown on the quote: <b>${inr(base * (1 + state.gstRate))}</b> (${inr(base)} + ${gst}% GST)`;
}

$("productCategory").addEventListener("change", syncCategoryFields);
$("productForm").elements.unit.addEventListener("change", updateComputedMin);
["priceBase","priceQuote"].forEach(n =>
  $("productForm").elements[n].addEventListener("input", updateComputedMin));

async function loadHistory(productId){
  const rows = $("historyRows");
  rows.innerHTML = `<p class="hint">Loading…</p>`;
  try{
    const { prices } = await api(`/products/${productId}/prices`);
    rows.innerHTML = prices.length ? prices.map(p => `
      <div class="hist-row">
        <span>
          <span class="hist-when">${esc(p.effectiveFrom)}</span>
          ${p.note ? `<span class="hist-note"> — ${esc(p.note)}</span>` : ""}
          ${p.createdBy ? `<span class="hist-note"> · ${esc(p.createdBy)}</span>` : ""}
        </span>
        <span class="hist-amounts">${inr(p.base)} → ${inr(p.quote)} / ${inr(p.min)} min</span>
      </div>`).join("") : `<p class="hint">No price recorded yet.</p>`;
  }catch(err){
    rows.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

$("saveProductBtn").addEventListener("click", async () => {
  const f = $("productForm");
  const body = {
    sku: f.elements.sku.value.trim(),
    category: f.elements.category.value,
    name: f.elements.name.value.trim(),
    brand: f.elements.brand.value.trim(),
    spec: f.elements.spec.value.trim(),
    bays: f.elements.bays.value === "" ? null : Number(f.elements.bays.value),
    capacityTb: f.elements.capacityTb.value === "" ? null : Number(f.elements.capacityTb.value),
    raid: [...f.querySelectorAll('input[name="raid"]:checked')].map(cb => cb.value),
    expandable: f.elements.expandable.value === "1",
    network: f.elements.network.value.trim(),
    networkUpgrade: f.elements.networkUpgrade.value.trim(),
    unit: f.elements.unit.value,
    active: f.elements.active.value === "1"
  };

  // A price is only sent when something about it changed, so simply reopening a
  // product and saving doesn't add a no-op row to its history.
  const base = f.elements.priceBase.value === "" ? null : Number(f.elements.priceBase.value);
  const quote = f.elements.priceQuote.value === "" ? null : Number(f.elements.priceQuote.value);
  const current = state.editing?.price;
  if(base != null && (!current || current.base !== base || current.quote !== quote)){
    body.price = {
      base, quote: quote ?? base,
      effectiveFrom: f.elements.priceEffectiveFrom.value || undefined,
      note: f.elements.priceNote.value.trim()
    };
  }

  $("productError").textContent = "";
  $("saveProductBtn").disabled = true;
  try{
    if(state.editing) await api(`/products/${state.editing.id}`, { method:"PATCH", body });
    else await api("/products", { method:"POST", body });
    $("productDialog").close();
    await loadProducts();
    toast(state.editing ? "Saved" : "Product added");
  }catch(err){
    $("productError").textContent = err.message;
  }finally{
    $("saveProductBtn").disabled = false;
  }
});

$("deactivateBtn").addEventListener("click", async () => {
  if(!state.editing) return;
  if(!confirm(`Hide "${state.editing.name}" from the configurator?\n\nIts price history and any quote that used it are kept.`)) return;
  try{
    await api(`/products/${state.editing.id}`, { method:"DELETE" });
    $("productDialog").close();
    await loadProducts();
    toast("Product deactivated");
  }catch(err){
    $("productError").textContent = err.message;
  }
});

/* ---------------- quotations ---------------- */

async function loadQuotes(){
  const { quotes } = await api("/quotes");
  state.quotes = quotes;
  renderQuotes();
}

function renderQuotes(){
  const term = $("quoteSearch").value.trim().toLowerCase();
  const rows = state.quotes.filter(q =>
    !term || `${q.ref} ${q.customerName} ${q.repName}`.toLowerCase().includes(term));

  $("quoteRows").innerHTML = rows.length ? rows.map(q => `
    <tr>
      <td><span class="name">${esc(q.ref)}</span></td>
      <td>${esc(q.customerName || "—")}<span class="sub">${esc(q.customerLocation || "")}</span></td>
      <td>${esc(q.repName || "—")}</td>
      <td class="num">${inr(q.totalMax)}</td>
      <td class="num">${inr(q.totalMin)}</td>
      <td><span class="pill ${q.status === "won" ? "pill-on" : "pill-off"}">${esc(q.status)}</span></td>
      <td class="num">${new Date(q.createdAt).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">No quotations saved yet.</td></tr>`;

  $("quoteNote").textContent = rows.length
    ? `${rows.length} quotation${rows.length === 1 ? "" : "s"}`
    : "";
}
$("quoteSearch").addEventListener("input", renderQuotes);

/* ---------------- users ---------------- */

async function loadUsers(){
  const { users } = await api("/users");
  state.users = users;
  $("userRows").innerHTML = users.map(u => `
    <tr>
      <td><span class="name">${esc(u.name || "—")}</span></td>
      <td>${esc(u.email)}</td>
      <td><span class="pill ${u.role === "admin" ? "pill-admin" : "pill-off"}">${esc(u.role)}</span></td>
      <td><span class="pill ${u.active ? "pill-on" : "pill-off"}">${u.active ? "active" : "disabled"}</span></td>
      <td class="num"><button type="button" class="row-action" data-user="${u.id}">Edit</button></td>
    </tr>`).join("");
}

$("userRows").addEventListener("click", e => {
  const btn = e.target.closest("[data-user]");
  if(btn) openUser(state.users.find(u => u.id === Number(btn.dataset.user)));
});
$("newUserBtn").addEventListener("click", () => openUser(null));

function openUser(user){
  state.editingUser = user;
  const f = $("userForm");
  f.reset();
  $("userDialogTitle").textContent = user ? user.email : "New user";
  $("userError").textContent = "";
  f.elements.email.disabled = !!user;                     // the email is the identity; changing it makes a new account
  if(user){
    f.elements.name.value = user.name || "";
    f.elements.email.value = user.email;
    f.elements.role.value = user.role;
    f.elements.active.value = user.active ? "1" : "0";
    f.elements.password.placeholder = "Leave blank to keep the current password";
  } else {
    f.elements.password.placeholder = "At least 8 characters";
  }
  showDialog($("userDialog"));
}

$("saveUserBtn").addEventListener("click", async () => {
  const f = $("userForm");
  $("userError").textContent = "";
  $("saveUserBtn").disabled = true;
  try{
    if(state.editingUser){
      const body = { name: f.elements.name.value.trim(), role: f.elements.role.value, active: f.elements.active.value === "1" };
      if(f.elements.password.value) body.password = f.elements.password.value;
      await api(`/users/${state.editingUser.id}`, { method:"PATCH", body });
    } else {
      await api("/users", {
        method:"POST",
        body: { name: f.elements.name.value.trim(), email: f.elements.email.value.trim(),
                role: f.elements.role.value, password: f.elements.password.value }
      });
    }
    $("userDialog").close();
    await loadUsers();
    toast("Saved");
  }catch(err){
    $("userError").textContent = err.message;
  }finally{
    $("saveUserBtn").disabled = false;
  }
});

/* ---------------- dialogs ---------------- */

/** `showModal` gives the backdrop and focus trap in a browser; falling back to
 *  the open attribute keeps the dialog usable where it isn't implemented. */
function showDialog(dlg){
  if(typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

document.addEventListener("click", e => {
  const close = e.target.closest("[data-close]");
  if(close) close.closest("dialog")?.close();
});

/* ---------------- start ---------------- */

api("/pricing").then(p => { state.gstRate = p.gstRate ?? 0.18; }).catch(() => {});
boot().catch(err => {
  document.body.innerHTML = `<p class="empty">Couldn't reach the server: ${esc(err.message)}</p>`;
});
