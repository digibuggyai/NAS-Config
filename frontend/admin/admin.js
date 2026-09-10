/* Pricing admin.
 *
 * Everything here talks to /api. The session is an HttpOnly cookie, so there is
 * no token to store or leak into localStorage.
 */

const $ = id => document.getElementById(id);

const state = { user: null, products: [], quotes: [], users: [], gstRate: 0.18, editing: null };

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

  const filter = $("categoryFilter");
  if(filter.options.length <= 1){
    for(const c of CATEGORIES) filter.add(new Option(c, c));
  }
  renderProducts();
}

function renderProducts(){
  const term = $("productSearch").value.trim().toLowerCase();
  const cat = $("categoryFilter").value;
  const showInactive = $("showInactive").checked;

  const rows = state.products.filter(p =>
    (showInactive || p.active) &&
    (!cat || p.category === cat) &&
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
      <td class="num">${esc(spec)}</td>
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
    (unpriced ? ` · ${unpriced} without a price, so not quotable` : "") +
    ` · minimum = base + ${Math.round(state.gstRate * 100)}% GST`;
}

const fmt = (n, isPercent) => isPercent ? `${n}%` : inr(n);

["productSearch","categoryFilter","showInactive"].forEach(id =>
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
  if(!sel.options.length) for(const c of CATEGORIES) sel.add(new Option(c, c));

  $("productDialogTitle").textContent = product ? product.name : "New product";
  $("productError").textContent = "";
  $("deactivateBtn").hidden = !product || !product.active;
  $("historyBlock").hidden = !product;

  if(product){
    f.sku.value = product.sku;
    f.category.value = product.category;
    f.name.value = product.name;
    f.brand.value = product.brand;
    f.spec.value = product.spec;
    f.bays.value = product.bays ?? "";
    f.capacityTb.value = product.capacityTb ?? "";
    f.unit.value = product.unit;
    f.active.value = product.active ? "1" : "0";
    f.expandable.value = product.expandable ? "1" : "0";
    f.querySelectorAll('input[name="raid"]').forEach(cb => { cb.checked = product.raid.includes(cb.value); });
    if(product.price){
      f.priceBase.value = product.price.base;
      f.priceQuote.value = product.price.quote;
    }
    loadHistory(product.id);
  } else {
    f.category.value = "NAS";
  }

  f.priceEffectiveFrom.value = new Date().toISOString().slice(0,10);
  syncCategoryFields();
  updateComputedMin();
  $("productDialog").showModal();
}

function syncCategoryFields(){
  const f = $("productForm");
  const cat = f.category.value;
  $("nasFields").hidden = cat !== "NAS";
  $("driveFields").hidden = !(cat === "HDD" || cat === "SSD");

  // Sensible default for how this category is charged.
  if(!state.editing){
    f.unit.value = cat === "NAS" ? "per_unit"
      : (cat === "HDD" || cat === "SSD") ? "per_drive"
      : f.unit.value;
  }
  updateComputedMin();
}

function updateComputedMin(){
  const f = $("productForm");
  const pct = f.unit.value === "percent_of_hardware";
  const base = Number(f.priceBase.value);
  const gst = Math.round(state.gstRate * 100);

  $("priceHint").textContent = pct
    ? "Percentages, not rupees: base is the floor the rep can discount to, quote is the asking rate."
    : `Enter the ex-GST base and the asking price. The quotation's minimum is worked out as base + ${gst}% GST.`;

  if(!Number.isFinite(base) || !f.priceBase.value){
    $("computedMin").textContent = "";
    return;
  }
  $("computedMin").innerHTML = pct
    ? `Floor <b>${base}%</b> · asking <b>${Number(f.priceQuote.value) || base}%</b>`
    : `Minimum shown on the quote: <b>${inr(base * (1 + state.gstRate))}</b> (${inr(base)} + ${gst}% GST)`;
}

$("productCategory").addEventListener("change", syncCategoryFields);
$("productForm").unit.addEventListener("change", updateComputedMin);
["priceBase","priceQuote"].forEach(n =>
  $("productForm")[n].addEventListener("input", updateComputedMin));

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
    sku: f.sku.value.trim(),
    category: f.category.value,
    name: f.name.value.trim(),
    brand: f.brand.value.trim(),
    spec: f.spec.value.trim(),
    bays: f.bays.value === "" ? null : Number(f.bays.value),
    capacityTb: f.capacityTb.value === "" ? null : Number(f.capacityTb.value),
    raid: [...f.querySelectorAll('input[name="raid"]:checked')].map(cb => cb.value),
    expandable: f.expandable.value === "1",
    unit: f.unit.value,
    active: f.active.value === "1"
  };

  // A price is only sent when something about it changed, so simply reopening a
  // product and saving doesn't add a no-op row to its history.
  const base = f.priceBase.value === "" ? null : Number(f.priceBase.value);
  const quote = f.priceQuote.value === "" ? null : Number(f.priceQuote.value);
  const current = state.editing?.price;
  if(base != null && (!current || current.base !== base || current.quote !== quote)){
    body.price = {
      base, quote: quote ?? base,
      effectiveFrom: f.priceEffectiveFrom.value || undefined,
      note: f.priceNote.value.trim()
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
  f.email.disabled = !!user;                     // the email is the identity; changing it makes a new account
  if(user){
    f.name.value = user.name || "";
    f.email.value = user.email;
    f.role.value = user.role;
    f.active.value = user.active ? "1" : "0";
    f.password.placeholder = "Leave blank to keep the current password";
  } else {
    f.password.placeholder = "At least 8 characters";
  }
  $("userDialog").showModal();
}

$("saveUserBtn").addEventListener("click", async () => {
  const f = $("userForm");
  $("userError").textContent = "";
  $("saveUserBtn").disabled = true;
  try{
    if(state.editingUser){
      const body = { name: f.name.value.trim(), role: f.role.value, active: f.active.value === "1" };
      if(f.password.value) body.password = f.password.value;
      await api(`/users/${state.editingUser.id}`, { method:"PATCH", body });
    } else {
      await api("/users", {
        method:"POST",
        body: { name: f.name.value.trim(), email: f.email.value.trim(),
                role: f.role.value, password: f.password.value }
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

document.addEventListener("click", e => {
  const close = e.target.closest("[data-close]");
  if(close) close.closest("dialog")?.close();
});

/* ---------------- start ---------------- */

api("/pricing").then(p => { state.gstRate = p.gstRate ?? 0.18; }).catch(() => {});
boot().catch(err => {
  document.body.innerHTML = `<p class="empty">Couldn't reach the server: ${esc(err.message)}</p>`;
});
