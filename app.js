// app.js — HomeCloud: Auth, Firestore realtime, Gallery, Admin, Chunked Upload
import { auth, db, googleProvider, API_BASE_URL, STORAGE_LIMIT_BYTES, CHUNK_SIZE } from "./firebase-config.js";
import { onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================ Helpers ============================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const icons = () => window.lucide && window.lucide.createIcons();
const esc = (s = "") => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function fmtBytes(b = 0) {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(sec = 0) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}h ${h}j ${m}m` : h ? `${h}j ${m}m` : `${m}m`;
}
const toDate = ts => ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
function dayLabel(d) {
  if (!d) return "Tanggal tidak diketahui";
  const now = new Date(); const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return "Hari ini";
  if (diff === 1) return "Kemarin";
  return d.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/* ============================ Toast ============================ */
function toast(message, type = "info", ms = 4500) {
  const ic = { success: "check-circle-2", error: "alert-octagon", warn: "alert-triangle", info: "info" }[type] || "info";
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<i data-lucide="${ic}"></i><span>${esc(message)}</span>`;
  $("#toasts").appendChild(el); icons();
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 300); };
  el.addEventListener("click", close); setTimeout(close, ms);
}

/* ============================ Confirm modal ============================ */
function confirmModal(title, desc, okLabel = "Ya, lanjutkan", danger = false) {
  return new Promise(resolve => {
    const m = $("#modal"); const ok = $("#modal-ok"), cancel = $("#modal-cancel");
    $("#modal-title").textContent = title; $("#modal-desc").textContent = desc;
    ok.textContent = okLabel; ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    m.classList.remove("hidden");
    const done = v => { m.classList.add("hidden"); ok.onclick = cancel.onclick = m.onclick = null; document.removeEventListener("keydown", esc_); resolve(v); };
    const esc_ = e => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", esc_);
    ok.onclick = () => done(true); cancel.onclick = () => done(false);
    m.onclick = e => { if (e.target === m) done(false); };
  });
}

/* ============================ API (Cloudflare Tunnel) ============================ */
async function getToken(force = false) {
  if (!auth.currentUser) throw new Error("Belum login");
  return auth.currentUser.getIdToken(force);
}

async function apiFetch(path, options = {}, retryAuth = true) {
  const token = await getToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (err) {
    throw new ApiError("Tidak dapat terhubung ke home server (Cloudflare Tunnel). Periksa koneksi atau status server.", 0, true);
  }
  if (res.status === 401 && retryAuth) { await getToken(true); return apiFetch(path, options, false); }
  if (!res.ok) {
    let msg = `Server mengembalikan error ${res.status}`;
    try { const j = await res.clone().json(); msg = j.message || j.error || msg; } catch {}
    throw new ApiError(msg, res.status);
  }
  return res;
}
class ApiError extends Error {
  constructor(message, status = 0, network = false) { super(message); this.status = status; this.network = network; }
}
const apiJson = async (path, method = "GET", body) => {
  const res = await apiFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return res.status === 204 ? {} : res.json().catch(() => ({}));
};

/* ============================ State ============================ */
const state = {
  user: null, profile: null, tab: "monitor",
  unsubs: [], media: [], lbIndex: -1,
  adminUsers: [], adminFilter: "all",
  uploadQueue: [], uploading: false, reservedBytes: 0
};
const TITLES = { monitor: "Server Monitoring", gallery: "Cloud Gallery", admin: "Admin Panel" };

function showView(id) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === id));
  icons();
}
function clearSubs() { state.unsubs.forEach(u => u()); state.unsubs = []; }

/* ============================ Auth flow ============================ */
$("#btn-google").addEventListener("click", async () => {
  try { await signInWithPopup(auth, googleProvider); }
  catch (e) {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
      toast(`Login gagal: ${e.message}`, "error");
  }
});
$$(".btn-logout").forEach(b => b.addEventListener("click", () => signOut(auth)));

onAuthStateChanged(auth, async user => {
  clearSubs(); stopTelemetry(); appStarted = false; startedUid = null; state.user = user; state.profile = null;
  if (!user) { showView("view-login"); return; }
  showView("view-loading");
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        email: user.email || "", displayName: user.displayName || "", photoURL: user.photoURL || "",
        role: "user", status: "pending",
        storageLimit: STORAGE_LIMIT_BYTES, storageUsed: 0, createdAt: serverTimestamp()
      });
    }
    // Realtime: perubahan status/kuota langsung terlihat tanpa reload
    state.unsubs.push(onSnapshot(ref, s => { if (s.exists()) { state.profile = s.data(); renderByProfile(); } },
      err => toast(`Gagal membaca profil: ${err.message}`, "error")));
  } catch (e) {
    toast(`Gagal memuat akun: ${e.message}`, "error");
    showView("view-login");
  }
});

let appStarted = false, startedUid = null;
function renderByProfile() {
  const p = state.profile, u = state.user;
  if (!p || !u) return;
  if (p.status !== "approved") {
    if (appStarted) { stopApp(); }
    const rejected = p.status === "rejected";
    $("#pending-title").textContent = rejected ? "Pendaftaran Ditolak" : "Menunggu Persetujuan Admin";
    $("#pending-desc").textContent = rejected
      ? "Maaf, permintaan akses akun Anda ditolak oleh admin. Hubungi admin bila ini sebuah kesalahan."
      : "Akun Anda sudah terdaftar. Admin perlu menyetujui sebelum Anda dapat mengakses dashboard dan mengunggah file.";
    $("#pending-icon").className = `status-icon ${rejected ? "rejected" : "pending"}`;
    $("#pending-icon").innerHTML = `<i data-lucide="${rejected ? "ban" : "hourglass"}"></i>`;
    $("#pending-photo").src = p.photoURL || u.photoURL || "";
    $("#pending-name").textContent = p.displayName || "-";
    $("#pending-email").textContent = p.email || "-";
    const b = $("#pending-badge"); b.textContent = p.status; b.className = `badge badge-${rejected ? "rejected" : "pending"}`;
    showView("view-pending"); return;
  }
  // Approved
  $("#user-photo").src = p.photoURL || u.photoURL || "";
  $("#user-name").textContent = p.displayName || "-";
  $("#user-email").textContent = p.email || "-";
  const isAdmin = p.role === "admin";
  $$(".admin-only").forEach(e => e.classList.toggle("hidden", !isAdmin));
  if (!appStarted || startedUid !== u.uid) startApp(isAdmin);
  renderQuota();
  showView("view-app");
}

function startApp(isAdmin) {
  appStarted = true; startedUid = state.user.uid;
  listenMedia();
  if (isAdmin) listenAdmin();
  switchTab(state.tab === "admin" && !isAdmin ? "monitor" : state.tab); // juga menjalankan syncTelemetry()
}
function stopApp() {
  appStarted = false; startedUid = null;
  stopTelemetry();
  // Pertahankan listener profil (index 0), hentikan sisanya
  state.unsubs.slice(1).forEach(u => u()); state.unsubs = state.unsubs.slice(0, 1);
  state.media = []; state.adminUsers = [];
  closeLightbox();
}

/* ============================ Tabs / Sidebar ============================ */
function switchTab(tab) {
  if (tab === "admin" && state.profile?.role !== "admin") tab = "monitor";
  state.tab = tab;
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.tab === tab));
  $$(".tab").forEach(t => t.classList.toggle("active", t.id === `tab-${tab}`));
  $("#page-title").textContent = TITLES[tab];
  closeSidebar();
  if (tab === "gallery") observeThumbs();
  if (tab === "admin") loadAdminLogs();
  syncTelemetry();
}
$$(".nav-item").forEach(n => n.addEventListener("click", () => switchTab(n.dataset.tab)));
const openSidebar = () => { $("#sidebar").classList.add("open"); $("#sidebar-backdrop").classList.add("show"); };
const closeSidebar = () => { $("#sidebar").classList.remove("open"); $("#sidebar-backdrop").classList.remove("show"); };
$("#btn-menu").addEventListener("click", openSidebar);
$("#sidebar-backdrop").addEventListener("click", closeSidebar);

/* ============================ Tab 1: Server Monitoring ============================ */
/* Telemetry langsung dari backend (0 Firestore write). Payload GET /api/metrics & SSE:
   cpuUsage, cpuModel, cpuTemp, cpuTempAvailable, ramUsedGB, ramTotalGB, diskUsedGB, diskTotalGB,
   diskHealth ("good"|"warning"|"critical"), networkUptimeSec, networkOnline, updatedAt (ISO string) */
const TELEMETRY = {
  POLL_MS: 3500,          // interval polling fallback
  SSE_RETRY_MS: 60000,    // selama polling, coba SSE lagi tiap 60 dtk
  STALE_MS: 15000,        // tanpa data baru selama ini -> Offline
  WATCHDOG_MS: 3000,
  MAX_SSE_FAILURES: 3     // gagal beruntun sebelum pindah ke polling
};
const tm = {
  running: false, gen: 0, mode: null, abort: null,
  pollTimer: null, sseRetryTimer: null, sseRetryDelay: null, watchdog: null,
  sseFailures: 0, startedAt: 0, lastDataAt: 0, lastMetrics: null, forceRefreshToken: false
};

function setMetric(id, { value, pct, sub, level }) {
  const card = $(`#${id}`);
  const vEl = $('[data-v="value"]', card), bar = $('[data-v="bar"]', card), subEl = $('[data-v="sub"]', card);
  if (vEl.textContent !== String(value)) { vEl.textContent = value; card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash"); }
  bar.style.width = `${clamp(pct, 0, 100)}%`;
  bar.className = level || "";
  subEl.textContent = sub || "\u00A0";
}
const lvl = (v, w, b) => v >= b ? "bad" : v >= w ? "warn" : "";
function setConn(cls, text) { $("#conn-status").className = `conn ${cls}`; $("#conn-text").textContent = text; }

function renderMetrics(m) {
  const cpu = +m.cpuUsage || 0, ramU = +m.ramUsedGB || 0, ramT = +m.ramTotalGB || 0, temp = +m.cpuTemp || 0;
  const dU = +m.diskUsedGB || 0, dT = +m.diskTotalGB || 0;
  setMetric("m-cpu", { value: cpu.toFixed(1), pct: cpu, level: lvl(cpu, 70, 90), sub: m.cpuModel || "" });
  setMetric("m-ram", { value: `${ramU.toFixed(1)} / ${ramT.toFixed(1)}`, pct: ramT ? ramU / ramT * 100 : 0, level: lvl(ramT ? ramU / ramT * 100 : 0, 75, 90), sub: ramT ? `${(ramU / ramT * 100).toFixed(0)}% terpakai` : "" });
  if (m.cpuTempAvailable === false) setMetric("m-temp", { value: "N/A", pct: 0, sub: "Sensor suhu tidak tersedia (butuh hak Administrator)" });
  else setMetric("m-temp", { value: temp.toFixed(0), pct: temp, level: lvl(temp, 65, 80), sub: temp >= 80 ? "Terlalu panas!" : temp >= 65 ? "Hangat" : "Normal" });
  const health = { good: "Sehat", warning: "Perlu perhatian", critical: "Kritis" }[m.diskHealth] || "—";
  setMetric("m-disk", { value: `${dU.toFixed(0)} / ${dT.toFixed(0)}`, pct: dT ? dU / dT * 100 : 0, level: m.diskHealth === "critical" ? "bad" : m.diskHealth === "warning" ? "warn" : lvl(dT ? dU / dT * 100 : 0, 80, 92), sub: `Kesehatan disk: ${health}` });
  setMetric("m-net", { value: fmtDuration(m.networkUptimeSec), pct: m.networkOnline === false ? 0 : 100, level: m.networkOnline === false ? "bad" : "", sub: m.networkOnline === false ? "Jaringan server offline" : "Online" });
}

function onMetrics(m, gen) {
  if (gen !== tm.gen) return; // data usang dari koneksi lama
  tm.lastDataAt = Date.now(); tm.lastMetrics = m;
  renderMetrics(m);
  const label = tm.mode === "sse" ? "SSE" : "Polling";
  const t = new Date(m.updatedAt || Date.now());
  $("#metrics-updated").textContent = `Terakhir diperbarui: ${t.toLocaleTimeString("id-ID")} • mode ${label}`;
  setConn("online", `Server online (${label})`);
}

/* ---- Mode utama: Authenticated SSE via fetch + ReadableStream ---- */
async function startSSE(gen) {
  if (gen !== tm.gen) return;
  tm.mode = "sse";
  const ctrl = new AbortController(); tm.abort = ctrl;
  let gotData = false;
  try {
    if (!window.ReadableStream || !window.TextDecoder) throw Object.assign(new Error("SSE tidak didukung"), { fatal: true });
    const token = await getToken(tm.forceRefreshToken); tm.forceRefreshToken = false;
    const res = await fetch(`${API_BASE_URL}/api/metrics/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      cache: "no-store", signal: ctrl.signal
    });
    if (res.status === 401) { tm.forceRefreshToken = true; throw new Error("Token ditolak"); }
    if (res.status === 403 || res.status === 404 || res.status === 405) throw Object.assign(new Error(`SSE tidak tersedia (${res.status})`), { fatal: true });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (/^event:\s*error/m.test(block)) continue;
        const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!data) continue; // komentar / heartbeat
        try { const m = JSON.parse(data); gotData = true; tm.sseFailures = 0; onMetrics(m, gen); } catch { /* abaikan baris rusak */ }
      }
    }
    throw new Error("Stream ditutup server");
  } catch (err) {
    if (gen !== tm.gen) return; // dihentikan sengaja (pindah tab / hidden / logout)
    tm.sseFailures = gotData ? 1 : tm.sseFailures + 1;
    if (err.fatal || tm.sseFailures >= TELEMETRY.MAX_SSE_FAILURES) return startPolling(gen);
    setConn("offline", "Menyambung ulang…");
    const wait = Math.min(1000 * tm.sseFailures, 5000);
    tm.pollTimer = setTimeout(() => startSSE(gen), wait); // dipakai ulang sebagai timer retry
  }
}

/* ---- Mode cadangan: HTTP polling ---- */
function startPolling(gen) {
  if (gen !== tm.gen) return;
  tm.mode = "poll"; tm.abort?.abort(); tm.abort = null;
  clearTimeout(tm.pollTimer);
  const tick = async () => {
    if (gen !== tm.gen) return;
    try {
      const ctrl = new AbortController(); tm.abort = ctrl;
      const res = await apiFetch("/api/metrics", { cache: "no-store", signal: ctrl.signal });
      onMetrics(await res.json(), gen);
    } catch (e) {
      if (gen !== tm.gen) return;
      if (e.name !== "AbortError") setConn("offline", e.network ? "Server tidak terjangkau" : "Error telemetry");
    }
    if (gen === tm.gen && tm.mode === "poll") tm.pollTimer = setTimeout(tick, TELEMETRY.POLL_MS);
  };
  tick();
  // Coba kembali ke SSE secara berkala
  clearTimeout(tm.sseRetryTimer);
  tm.sseRetryTimer = setTimeout(() => {
    if (gen !== tm.gen || tm.mode !== "poll") return;
    clearTimeout(tm.pollTimer); tm.abort?.abort();
    tm.sseFailures = TELEMETRY.MAX_SSE_FAILURES - 1; // sekali gagal -> langsung kembali ke polling
    startSSE(gen);
  }, TELEMETRY.SSE_RETRY_MS);
}

function startTelemetry() {
  if (tm.running) return;
  tm.running = true; tm.gen++; tm.sseFailures = 0; tm.startedAt = Date.now();
  tm.mode = null;
  setConn("offline", "Menghubungkan…");
  const gen = tm.gen;
  startSSE(gen);
  clearInterval(tm.watchdog);
  tm.watchdog = setInterval(() => {
    if (gen !== tm.gen) return;
    const last = Math.max(tm.lastDataAt, tm.startedAt);
    if (Date.now() - last > TELEMETRY.STALE_MS) {
      setConn("offline", "Server offline");
      if (tm.mode === "sse" && tm.abort) tm.abort.abort(); // paksa reconnect bila stream macet
    }
  }, TELEMETRY.WATCHDOG_MS);
}

function stopTelemetry(label = "Monitoring dijeda") {
  const was = tm.running;
  tm.running = false; tm.gen++; tm.mode = null;
  tm.abort?.abort(); tm.abort = null;
  clearTimeout(tm.pollTimer); clearTimeout(tm.sseRetryTimer); clearInterval(tm.watchdog);
  tm.pollTimer = tm.sseRetryTimer = tm.watchdog = null;
  if (was && state.user) setConn("", label);
}

// Monitoring hanya aktif jika: sudah login & approved, tab Monitoring terbuka, DAN browser tab terlihat.
function syncTelemetry() {
  const should = appStarted && state.tab === "monitor" && document.visibilityState === "visible";
  should ? startTelemetry() : stopTelemetry();
}
document.addEventListener("visibilitychange", syncTelemetry);


// Quick actions
$$(".action").forEach(btn => btn.addEventListener("click", async () => {
  const { action, title, desc } = btn.dataset;
  if (!await confirmModal(title, desc, "Jalankan")) return;
  btn.disabled = true;
  try {
    const r = await apiJson(`/api/actions/${action}`, "POST", { requestedAt: new Date().toISOString() });
    toast(r.message || `${title} berhasil dijalankan.`, "success");
  } catch (e) { toast(e.message, "error"); }
  finally { btn.disabled = false; }
}));

/* ============================ Tab 2: Gallery ============================ */
function renderQuota() {
  const p = state.profile; if (!p) return;
  const limit = p.storageLimit || STORAGE_LIMIT_BYTES, used = p.storageUsed || 0;
  const pct = clamp(used / limit * 100, 0, 100);
  $("#quota-text").textContent = `${fmtBytes(used)} / ${fmtBytes(limit)} digunakan`;
  $("#quota-pct").textContent = `${pct.toFixed(1)}%`;
  const bar = $("#quota-bar"); bar.style.width = `${pct}%`; bar.className = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
}

function listenMedia() {
  const q = query(collection(db, "media"), where("ownerUid", "==", state.user.uid), orderBy("createdAt", "desc"));
  state.unsubs.push(onSnapshot(q, snap => {
    state.media = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGallery();
  }, err => toast(`Gagal memuat galeri: ${err.message}`, "error")));
}

/* media doc: { ownerUid, name, mimeType, type:"image"|"video", size, width?, height?, createdAt } */
function renderGallery() {
  const wrap = $("#gallery-groups"); wrap.innerHTML = "";
  $("#gallery-empty").classList.toggle("hidden", state.media.length > 0);
  const groups = new Map();
  state.media.forEach((m, idx) => {
    const key = dayLabel(toDate(m.createdAt));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ m, idx });
  });
  for (const [label, items] of groups) {
    const h = document.createElement("h4"); h.className = "group-title"; h.textContent = label;
    const grid = document.createElement("div"); grid.className = "grid";
    items.forEach(({ m, idx }) => {
      const t = document.createElement("button");
      const wide = m.width && m.height && m.width / m.height > 1.6;
      t.className = `tile${wide ? " wide" : ""}`; t.dataset.id = m.id; t.title = m.name;
      t.innerHTML = `<div class="ph"><i data-lucide="${m.type === "video" ? "film" : "image"}"></i></div>` +
        (m.type === "video" ? `<span class="vbadge"><i data-lucide="play"></i>Video</span>` : "");
      t.addEventListener("click", () => openLightbox(idx));
      grid.append(t);
    });
    wrap.append(h, grid);
  }
  icons(); observeThumbs();
}

// Thumbnail lazy-load (butuh header Authorization -> fetch sebagai blob)
const thumbCache = new Map();
const io = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); loadThumb(en.target); } });
}, { rootMargin: "300px" });
function observeThumbs() { $$("#gallery-groups .tile").forEach(t => { if (!t.dataset.loaded) io.observe(t); }); }
async function loadThumb(tile) {
  const id = tile.dataset.id;
  try {
    let url = thumbCache.get(id);
    if (!url) {
      const res = await apiFetch(`/api/media/${encodeURIComponent(id)}/thumbnail`);
      url = URL.createObjectURL(await res.blob()); thumbCache.set(id, url);
    }
    const img = new Image(); img.alt = ""; img.src = url;
    img.onload = () => img.classList.add("loaded");
    tile.prepend(img); tile.dataset.loaded = "1";
    $(".ph", tile)?.remove();
  } catch (e) {
    if (e.network && !loadThumb.warned) { loadThumb.warned = true; toast(e.message, "error"); setTimeout(() => loadThumb.warned = false, 15000); }
  }
}

// Signed URL (untuk <video>, full image & download, karena <video src> tak bisa kirim header)
async function getSignedUrl(id, download = false) {
  const r = await apiJson(`/api/media/${encodeURIComponent(id)}/url${download ? "?download=1" : ""}`);
  if (!r.url) throw new ApiError("Server tidak mengembalikan URL file.");
  return r.url.startsWith("http") ? r.url : `${API_BASE_URL}${r.url}`;
}

/* ---- Lightbox ---- */
async function openLightbox(i) {
  const m = state.media[i]; if (!m) return;
  state.lbIndex = i;
  $("#lightbox").classList.remove("hidden"); document.body.style.overflow = "hidden";
  $("#lb-name").textContent = m.name;
  $("#lb-meta").textContent = `${fmtBytes(m.size)} • ${toDate(m.createdAt)?.toLocaleString("id-ID") || ""}`;
  $("#lb-prev").style.visibility = i > 0 ? "visible" : "hidden";
  $("#lb-next").style.visibility = i < state.media.length - 1 ? "visible" : "hidden";

  const stage = $("#lb-stage");
  stage.innerHTML = `<div class="spinner"></div>`;

  const token = ++openLightbox.t;
  try {
    const url = await getSignedUrl(m.id);
    if (token !== openLightbox.t) return;
    const el = document.createElement(m.type === "video" ? "video" : "img");
    if (m.type === "video") {
      const cachedThumb = thumbCache.get(m.id);
      el.controls = true; el.autoplay = true; el.playsInline = true; el.preload = "metadata";
      if (cachedThumb) el.poster = cachedThumb;
      el.src = url;
      el.onerror = () => toast("Gagal memuat video dari server.", "error");
      stage.innerHTML = "";
      stage.append(el);
    } else {
      el.onload = () => { if (token === openLightbox.t) { stage.innerHTML = ""; stage.append(el); } };
      el.onerror = () => toast("Gagal memuat foto dari server.", "error");
      el.src = url;
    }

    // Preload foto berikutnya & sebelumnya di background biar geser-geser instan
    [i + 1, i - 1].forEach(adj => {
      const nextItem = state.media[adj];
      if (nextItem && nextItem.type === "image") {
        getSignedUrl(nextItem.id).then(u => { const pre = new Image(); pre.src = u; }).catch(() => {});
      }
    });
  } catch (e) { if (token === openLightbox.t) { stage.innerHTML = ""; toast(e.message, "error"); } }
}
openLightbox.t = 0;

function closeLightbox() {
  openLightbox.t++; state.lbIndex = -1;
  const vid = $("#lb-stage video");
  if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); } // lepas kunci file di Windows
  $("#lightbox").classList.add("hidden"); $("#lb-stage").innerHTML = ""; document.body.style.overflow = "";
}
$("#lb-close").addEventListener("click", closeLightbox);
$("#lb-prev").addEventListener("click", () => openLightbox(state.lbIndex - 1));
$("#lb-next").addEventListener("click", () => openLightbox(state.lbIndex + 1));
$("#lightbox").addEventListener("click", e => { if (e.target.id === "lb-stage") closeLightbox(); });
document.addEventListener("keydown", e => {
  if ($("#lightbox").classList.contains("hidden") || !$("#modal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft" && state.lbIndex > 0) openLightbox(state.lbIndex - 1);
  if (e.key === "ArrowRight" && state.lbIndex < state.media.length - 1) openLightbox(state.lbIndex + 1);
});
$("#lb-download").addEventListener("click", async () => {
  const m = state.media[state.lbIndex]; if (!m) return;
  try {
    const url = await getSignedUrl(m.id, true);
    const a = document.createElement("a"); a.href = url; a.download = m.name; document.body.appendChild(a); a.click(); a.remove();
    toast("Download dimulai.", "success", 2500);
  } catch (e) { toast(e.message, "error"); }
});
$("#lb-delete").addEventListener("click", async () => {
  const m = state.media[state.lbIndex]; if (!m) return;
  if (!await confirmModal("Hapus file?", `"${m.name}" akan dihapus permanen dari server.`, "Hapus", true)) return;
  const vid = $("#lb-stage video");
  if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
  try {
    await apiJson(`/api/media/${encodeURIComponent(m.id)}`, "DELETE");
    toast("File berhasil dihapus.", "success");
    const u = thumbCache.get(m.id); if (u) { URL.revokeObjectURL(u); thumbCache.delete(m.id); }
    closeLightbox();
  } catch (e) { toast(e.message, "error"); }
});

/* ---- Chunked uploader ---- */
const dz = $("#dropzone"), fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", e => handleFiles(e.dataTransfer.files));
fileInput.addEventListener("change", () => { handleFiles(fileInput.files); fileInput.value = ""; });

function handleFiles(fileList) {
  const p = state.profile; if (!p || p.status !== "approved") return;
  const limit = p.storageLimit || STORAGE_LIMIT_BYTES;
  for (const file of fileList) {
    if (!/^(image|video)\//.test(file.type)) { toast(`"${file.name}" dilewati: hanya foto & video yang didukung.`, "warn"); continue; }
    if (file.size === 0) { toast(`"${file.name}" kosong.`, "warn"); continue; }
    const remaining = limit - (p.storageUsed || 0) - state.reservedBytes;
    if (file.size > remaining) {
      toast(`Kuota penuh: "${file.name}" (${fmtBytes(file.size)}) melebihi sisa ${fmtBytes(Math.max(remaining, 0))}.`, "error", 6500);
      continue;
    }
    state.reservedBytes += file.size;
    const item = createUploadItem(file);
    state.uploadQueue.push({ file, ...item });
  }
  processQueue();
}

function createUploadItem(file) {
  const el = document.createElement("div"); el.className = "glass up-item";
  el.innerHTML = `<div class="up-row"><span>${esc(file.name)}</span><span class="muted up-pct">Menunggu…</span></div>
    <div class="bar"><i></i></div><div class="muted small up-info">${fmtBytes(file.size)}</div>`;
  $("#upload-list").prepend(el);
  return {
    el,
    set(pct, info) {
      $(".bar i", el).style.width = `${pct}%`;
      $(".up-pct", el).textContent = `${Math.floor(pct)}%`;
      if (info) $(".up-info", el).textContent = info;
    }
  };
}

async function processQueue() {
  if (state.uploading) return;
  state.uploading = true;
  while (state.uploadQueue.length) {
    const job = state.uploadQueue.shift();
    try {
      await uploadFileChunked(job.file, job.set);
      job.el.classList.add("done"); job.set(100, `${fmtBytes(job.file.size)} • selesai`);
      toast(`"${job.file.name}" berhasil diunggah.`, "success");
      setTimeout(() => { job.el.style.opacity = 0; setTimeout(() => job.el.remove(), 400); }, 4000);
    } catch (e) {
      job.el.classList.add("error"); $(".up-pct", job.el).textContent = "Gagal"; $(".up-info", job.el).textContent = e.message;
      toast(`Upload "${job.file.name}" gagal: ${e.message}`, "error", 7000);
    } finally { state.reservedBytes = Math.max(0, state.reservedBytes - job.file.size); }
  }
  state.uploading = false;
}

// Upload satu chunk via XHR agar ada progress byte-level; retry 3x
function sendChunk(form, onProgress) {
  return new Promise(async (resolve, reject) => {
    let token; try { token = await getToken(); } catch (e) { return reject(e); }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/upload/chunk`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `HTTP ${xhr.status}`; try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
      reject(new ApiError(msg, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Koneksi ke tunnel terputus.", 0, true));
    xhr.ontimeout = () => reject(new ApiError("Timeout saat mengirim chunk.", 0, true));
    xhr.timeout = 120000;
    xhr.send(form);
  });
}

async function uploadFileChunked(file, setProgress) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  setProgress(0, "Menyiapkan upload…");
  const { uploadId } = await apiJson("/api/upload/init", "POST", {
    fileName: file.name, fileSize: file.size, mimeType: file.type, totalChunks, chunkSize: CHUNK_SIZE, lastModified: file.lastModified
  });
  if (!uploadId) throw new Error("Server tidak mengembalikan uploadId.");

  let sent = 0;
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE, end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("uploadId", uploadId); form.append("chunkIndex", i); form.append("totalChunks", totalChunks);
      form.append("fileName", file.name); form.append("chunk", blob, `${file.name}.part${i}`);
      try {
        await sendChunk(form, loaded => {
          setProgress(clamp((sent + loaded) / file.size * 100, 0, 99), `Chunk ${i + 1}/${totalChunks} • ${fmtBytes(sent + loaded)} / ${fmtBytes(file.size)}`);
        });
        break;
      } catch (e) {
        if (e.status === 413 || e.status === 507 || e.status === 403) throw e; // tidak bisa di-retry
        if (attempt >= 3) throw e;
        setProgress(clamp(sent / file.size * 100, 0, 99), `Mengulang chunk ${i + 1} (percobaan ${attempt + 1}/3)…`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    sent += end - start;
  }
  setProgress(99, "Menyusun file di server…");
  const dims = await getDimensions(file);
  await apiJson("/api/upload/complete", "POST", { uploadId, fileName: file.name, fileSize: file.size, mimeType: file.type, totalChunks, ...dims });
}

// Dimensi opsional untuk layout grid
function getDimensions(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file); const done = d => { URL.revokeObjectURL(url); resolve(d); };
    if (file.type.startsWith("image/")) {
      const i = new Image(); i.onload = () => done({ width: i.naturalWidth, height: i.naturalHeight }); i.onerror = () => done({}); i.src = url;
    } else {
      const v = document.createElement("video"); v.preload = "metadata";
      v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }); v.onerror = () => done({}); v.src = url;
    }
    setTimeout(() => done({}), 4000);
  });
}

/* ============================ Admin Panel ============================ */
function listenAdmin() {
  state.unsubs.push(onSnapshot(collection(db, "users"), snap => {
    state.adminUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
    renderAdmin();
  }, err => toast(`Gagal memuat daftar user: ${err.message}`, "error")));
}
function renderAdmin() {
  const pending = state.adminUsers.filter(u => u.status === "pending").length;
  const pill = $("#admin-pending-count"); pill.textContent = pending; pill.classList.toggle("hidden", !pending);
  const rows = state.adminUsers.filter(u => state.adminFilter === "all" || u.status === state.adminFilter);
  const body = $("#admin-body");
  if (!rows.length) { body.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">Tidak ada pengguna.</td></tr>`; return; }
  body.innerHTML = rows.map(u => {
    const limit = u.storageLimit || STORAGE_LIMIT_BYTES, used = u.storageUsed || 0, pct = clamp(used / limit * 100, 0, 100);
    const self = u.uid === state.user.uid;
    return `<tr>
      <td><div class="u"><img class="avatar" src="${esc(u.photoURL || "")}" alt="" referrerpolicy="no-referrer"/>
        <div><strong>${esc(u.displayName || "-")}${u.role === "admin" ? " 👑" : ""}</strong><span class="muted small">${esc(u.email || "")}</span></div></div></td>
      <td><span class="badge badge-${esc(u.status)}">${esc(u.status)}</span></td>
      <td>${fmtBytes(used)} / ${fmtBytes(limit)}<div class="bar"><i style="width:${pct}%" class="${pct >= 95 ? "bad" : pct >= 80 ? "warn" : ""}"></i></div></td>
      <td class="muted">${toDate(u.createdAt)?.toLocaleDateString("id-ID") || "-"}</td>
      <td><div class="row-actions">${self ? `<span class="muted small">Anda</span>` : `
        ${u.status !== "approved" ? `<button class="btn btn-sm btn-primary" data-act="approved" data-uid="${esc(u.uid)}">Approve</button>` : ""}
        ${u.status !== "rejected" ? `<button class="btn btn-sm btn-danger" data-act="rejected" data-uid="${esc(u.uid)}">Reject</button>` : ""}`}
      </div></td></tr>`;
  }).join("");
}
$("#admin-body").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const { act, uid } = btn.dataset; const u = state.adminUsers.find(x => x.uid === uid); if (!u) return;
  const approve = act === "approved";
  if (!await confirmModal(approve ? "Setujui pengguna?" : "Tolak pengguna?", `${u.displayName || u.email} akan ${approve ? "mendapat akses penuh" : "ditolak dan tidak bisa mengakses dashboard"}.`, approve ? "Approve" : "Reject", !approve)) return;
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "users", uid), { status: act });
    toast(`${u.displayName || u.email} → ${act}.`, "success");
  } catch (err) { toast(`Gagal memperbarui status: ${err.message}`, "error"); btn.disabled = false; }
});
$("#admin-filter").addEventListener("click", e => {
  const b = e.target.closest("button[data-f]"); if (!b) return;
  state.adminFilter = b.dataset.f;
  $$("#admin-filter button").forEach(x => x.classList.toggle("active", x === b));
  renderAdmin();
});

// Catat perubahan status user ke log server saat admin klik Approve/Reject
// (Di dalam handler #admin-body setelah await updateDoc(...)):
// apiJson("/api/actions/audit", "POST", { action: "USER_STATUS", target: u.email || u.displayName, detail: `Status diubah menjadi ${act}` }).catch(() => {});

state.adminLogs = [];
state.logFilter = "all";

async function loadAdminLogs() {
  if (state.profile?.role !== "admin") return;
  const body = $("#logs-body");
  try {
    const r = await apiJson("/api/actions/logs?limit=100");
    state.adminLogs = r.logs || [];
    renderAdminLogs();
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">Gagal memuat log: ${esc(e.message)}</td></tr>`;
  }
}

function renderAdminLogs() {
  const body = $("#logs-body"); if (!body) return;
  const rows = state.adminLogs.filter(l => {
    if (state.logFilter === "all") return true;
    if (state.logFilter === "SYSTEM") return !["UPLOAD", "DELETE"].includes(l.action);
    return l.action === state.logFilter;
  });
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">Belum ada catatan aktivitas.</td></tr>`;
    return;
  }
  const badgeCls = a => a === "UPLOAD" ? "badge-approved" : a === "DELETE" ? "badge-rejected" : "badge-pending";
  body.innerHTML = rows.map(l => {
    const t = l.time ? new Date(l.time).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
    return `<tr>
      <td class="muted small" style="white-space:nowrap">${esc(t)}</td>
      <td><span class="badge ${badgeCls(l.action)}" style="margin-top:0">${esc(l.action || "-")}</span></td>
      <td class="small">${esc(l.email || l.uid || "system")}</td>
      <td class="small"><strong>${esc(l.target || "-")}</strong></td>
      <td class="muted small">${esc(l.detail || "-")}</td>
    </tr>`;
  }).join("");
}

$("#btn-refresh-logs")?.addEventListener("click", loadAdminLogs);
$("#log-filter")?.addEventListener("click", e => {
  const b = e.target.closest("button[data-lf]"); if (!b) return;
  state.logFilter = b.dataset.lf;
  $$("#log-filter button").forEach(x => x.classList.toggle("active", x === b));
  renderAdminLogs();
});
icons();
