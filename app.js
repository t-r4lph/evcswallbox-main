/*
 EV Charge Monitor - frontend
 The browser talks only to Google Apps Script.
 Never place Wallbox secrets/tokens in this file.
*/
const CONFIG = {
  BACKEND_URL: "https://script.google.com/macros/s/AKfycbwwmjL_LLcvx3NhYi3VrF86tHEVocsRv4nQI3tdFuIGKmHssbbo59LxsLZbwp9T6dauRQ/exec",
  REFRESH_MS: 15000,
  TIMER_MS: 1000
};

const state = {
  chargerId: null,
  chargers: [],
  loading: false,
  charger: null,
  status: null,
  session: null,
  history: [],
  timerHandle: null,
  refreshHandle: null
};

const MAX_MS = (180 + 30) * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,39}$/;
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const $ = id => document.getElementById(id);

function getChargerId() {
  const id = new URLSearchParams(location.search).get("charger");
  if (id) return id;
  try { return localStorage.getItem("evcm:lastCharger"); } catch (e) { return null; }
}

function apiUrl(action, extra = {}) {
  const params = new URLSearchParams({ action, chargerId: state.chargerId || "", ...extra });
  return `${CONFIG.BACKEND_URL}?${params.toString()}`;
}

async function api(action, extra = {}) {
  if (CONFIG.BACKEND_URL.includes("PASTE_YOUR")) {
    return demoApi(action);
  }
  const response = await fetch(apiUrl(action, extra), { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || "Backend request failed.");
  return json.data;
}

function demoApi(action) {
  const now = new Date();
  const start = new Date(now.getTime() - (1 * 60 * 60 * 1000 + 42 * 60 * 1000 + 35 * 1000));
  if (action === "charger") return Promise.resolve({
    charger: { chargerId: state.chargerId, chargerName: "SMOA PulsarPlus", location: "SM Mall of Asia · Indoor Parking · Level 3" },
    status: { online: true, status: "CHARGING", charging: true, powerKw: 7.2, energyKwh: 18.4, startTime: start.toISOString() },
    session: { sessionId: "DEMO-10482", userId: "DEMO-USER", vehicleId: "EV-0241", startTime: start.toISOString(), status: "ACTIVE", penaltyPhp: 0 }
  });
  if (action === "chargers") return Promise.resolve([
    { chargerId: "958875", chargerName: "SMOA PulsarPlus", location: "SM Mall of Asia · Indoor Parking · Level 3", inUse: true },
    { chargerId: "918937", chargerName: "PulsarPlus 918937", location: "Demo location", inUse: false },
    { chargerId: "281023", chargerName: "PulsarPlus 281023", location: "Demo location", inUse: false }
  ]);
  if (action === "activity") return Promise.resolve({
    totalChargers: 3, slotMinutes: 5,
    slots: [0,1,1,1,2,2,1,2,3,2,2,1].map((count, i) => ({ count, end: new Date(now.getTime() - (11 - i) * 300000).toISOString() }))
  });
  if (action === "history") return Promise.resolve([
    {sessionId:"DEMO-10481",startTime:new Date(now-7200000).toISOString(),durationMin:111,energyKwh:21.7,status:"COMPLETED",penaltyPhp:0},
    {sessionId:"DEMO-10480",startTime:new Date(now-14400000).toISOString(),durationMin:221,energyKwh:31.2,status:"COMPLETED",penaltyPhp:50},
    {sessionId:"DEMO-10479",startTime:new Date(now-21600000).toISOString(),durationMin:128,energyKwh:24.8,status:"COMPLETED",penaltyPhp:0}
  ]);
  return Promise.resolve({});
}

async function loadChargers() {
  try {
    const list = await api("chargers");
    state.chargers = Array.isArray(list) ? list : [];
  } catch (e) {
    state.chargers = [];   // picker is optional; the rest of the page still works
  }
  renderChargerPicker();
}

async function load() {
  try {
    await Promise.all([loadChargers(), loadActivity()]);
    if (!state.chargerId && state.chargers.length === 1) {
      selectCharger(state.chargers[0].chargerId);   // only one charger exists: no need to ask
      return;
    }
    const id = state.chargerId;
    if (!id) { render(); renderHistory(); hideError(); return; }

    const data = await api("charger");
    if (id !== state.chargerId) return;              // user switched charger while this was loading
    state.charger = data.charger;
    state.status = data.status;
    state.session = data.session;
    state.loading = false;
    render();
    const history = await api("history");
    if (id !== state.chargerId) return;
    state.history = history || [];
    renderHistory();
    hideError();
  } catch (err) {
    state.loading = false;
    showError(err.message);
  }
}

function render() {
  const c = state.charger, s = state.status, session = state.session;

  if (!state.chargerId || state.loading) {
    const picking = !state.chargerId;
    $("chargerIdLabel").textContent = picking ? "NO CHARGER SELECTED" : `CHARGER #${state.chargerId}`;
    $("chargerName").textContent = picking ? "Choose a charger" : (c?.chargerName || "Loading…");
    $("chargerLocation").textContent = picking ? "Pick one from the list above" : (c?.location || "");
    $("chargerStatus").textContent = "—";
    $("statusDetail").textContent = picking ? "Select a charger to see its status" : "Loading charger status…";
    $("statusDot").style.background = "#9aa8d1";
    $("systemBadge").textContent = picking ? "● Select a charger" : "● Loading…";
    ["power", "power2", "energy", "energy2", "sessionId", "userId", "vehicleId", "sessionStart"].forEach(id => { $(id).textContent = "—"; });
    $("startLabel").textContent = "Started —";
    $("endButton").disabled = true;
    updateStartPanel();
    updateTimer();
    setBadge("NO SESSION", "");
    return;
  }
  $("chargerIdLabel").textContent = `CHARGER #${c?.chargerId || state.chargerId}`;
  $("chargerName").textContent = c?.chargerName || "Unknown charger";
  $("chargerLocation").textContent = c?.location || "Location unavailable";

  const online = !!s?.online;
  const sessionOnly = s?.source === "none";
  $("chargerStatus").textContent = online ? (s?.status || "ONLINE") : "OFFLINE";
  $("statusDetail").textContent = !online ? "Charger is not reachable"
    : sessionOnly ? (s?.charging ? "Charging session in progress" : "Ready for charging")
    : (s?.charging ? "Currently delivering power to an EV" : "Ready for charging");
  $("statusDot").style.background = online ? "#67e48f" : "#d94242";
  $("systemBadge").textContent = online ? "● System Online" : "● Charger Offline";

  $("power").textContent = number(s?.powerKw);
  $("power2").textContent = withUnit(s?.powerKw, "kW");
  $("energy").textContent = number(s?.energyKwh);
  $("energy2").textContent = withUnit(s?.energyKwh, "kWh");

  const active = session && session.status === "ACTIVE";
  $("endButton").disabled = !(active && getToken(session.sessionId));

  $("sessionId").textContent = session?.sessionId || "—";
  $("userId").textContent = session?.userId || "—";
  $("vehicleId").textContent = session?.vehicleId || "—";
  $("sessionStart").textContent = session?.startTime ? formatTime(session.startTime) : "—";
  $("startLabel").textContent = session?.startTime ? `Started ${formatTime(session.startTime)}` : "Started —";

  updateStartPanel();
  updateTimer();
  updateBadge();
}

function updateTimer() {
  const session = state.session;
  if (!session?.startTime || session.status !== "ACTIVE") {
    $("timer").textContent = "00:00:00";
    $("timerState").textContent = "WAITING";
    $("remainingText").textContent = "No active charging session.";
    $("progressFill").style.width = "0%";
    $("limitNotice").classList.add("hidden");
    $("penalty").textContent = "₱0";
    return;
  }

  const elapsed = Math.max(0, Date.now() - new Date(session.startTime).getTime());
  const normalMs = 3 * 60 * 60 * 1000;
  const graceMs = 30 * 60 * 1000;
  const totalMs = normalMs + graceMs;
  const minutes = Math.floor(elapsed / 60000);
  const penalty = elapsed > totalMs ? 50 : 0;

  $("timer").textContent = hhmmss(elapsed);
  $("progressFill").style.width = `${Math.min(elapsed / totalMs * 100, 100)}%`;
  $("penalty").textContent = `₱${penalty}`;

  const notice = $("limitNotice");
  notice.classList.remove("hidden", "penalty");

  if (elapsed < normalMs) {
    const remaining = normalMs - elapsed;
    $("timerState").textContent = "CHARGING";
    $("remainingText").textContent = `${hhmmss(remaining)} remaining before the 3-hour limit`;
    notice.textContent = `You have ${hhmmss(remaining)} before the 3-hour charging limit. A 30-minute grace period follows.`;
    setBadge("CHARGING", "charging");
  } else if (elapsed <= totalMs) {
    const remaining = totalMs - elapsed;
    $("timerState").textContent = "GRACE PERIOD";
    $("remainingText").textContent = `${hhmmss(remaining)} remaining before the ₱50 penalty`;
    notice.textContent = `Grace period active. ${hhmmss(remaining)} remaining before the ₱50 penalty applies.`;
    setBadge("GRACE", "grace");
  } else {
    $("timerState").textContent = "PENALTY APPLIED";
    $("remainingText").textContent = "The 3h 30m allowance has been exceeded.";
    notice.classList.add("penalty");
    notice.textContent = "₱50 penalty applied because the charging session exceeded the 3-hour limit plus the 30-minute grace period.";
    setBadge("₱50 PENALTY", "penalty");
  }
}

function updateBadge() {
  const active = state.session?.status === "ACTIVE";
  if (!active) setBadge("NO SESSION", "");
}

function setBadge(text, cls) {
  $("sessionBadge").textContent = text;
  $("sessionBadge").className = `badge ${cls || ""}`;
}

async function endSession() {
  const id = state.session?.sessionId;
  if (!id) return;
  $("endButton").disabled = true;
  try {
    await api("endSession", { sessionId: id, token: getToken(id) || "" });
    clearToken(id);
    await load();
  } catch (err) {
    showError(err.message);
    $("endButton").disabled = false;
  }
}

function historyStatus(s) {
  const st = String(s.status || "").toUpperCase();
  if (st === "ACTIVE") return { label: "Active", cls: "status-active" };
  if (st === "EXPIRED") return { label: "Expired", cls: "status-penalty" };
  if (s.penaltyPhp > 0) return { label: "Penalty", cls: "status-penalty" };
  return { label: "Complete", cls: "status-complete" };
}

function renderHistory() {
  const body = $("historyBody");
  if (!state.history.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No sessions recorded.</td></tr>`;
    return;
  }
  body.innerHTML = state.history.slice(0,10).map(s => {
    const st = historyStatus(s);
    const active = st.label === "Active";
    return `
    <tr>
      <td>${escapeHtml(s.sessionId)}</td>
      <td>${formatTime(s.startTime)}</td>
      <td>${active ? "In progress" : duration(s.durationMin)}</td>
      <td>${state.status?.source === "none" ? "—" : number(s.energyKwh) + " kWh"}</td>
      <td class="${st.cls}">${st.label}</td>
      <td>${active ? "—" : "₱" + number(s.penaltyPhp || 0)}</td>
    </tr>`;
  }).join("");
}

// ---- Charging activity: chargers in use per 5-minute slot, last 60 minutes (from recorded sessions) ----
async function loadActivity() {
  try {
    renderActivity(await api("activity"));
  } catch (e) {
    renderActivity(null);   // never show made-up data; draw empty bars instead
  }
}

function renderActivity(data) {
  const chart = $("activityChart");
  if (!chart) return;
  const total = data?.totalChargers || 0;
  const slots = data?.slots?.length ? data.slots : Array.from({ length: 12 }, () => ({ count: 0, end: null }));
  chart.innerHTML = slots.map(s => {
    const pct = total ? Math.min(s.count / total, 1) * 100 : 0;
    const tip = s.end ? `Until ${formatTime(s.end)}: ${s.count} of ${total} chargers in use` : "No data";
    return `<div class="chart-bar" title="${escapeHtml(tip)}" style="height:${pct}%"></div>`;
  }).join("");

  if (!$("activityNote") && chart.parentElement) {
    const note = document.createElement("p");
    note.id = "activityNote";
    note.className = "muted";
    note.style.margin = "10px 0 0";
    note.textContent = "Bars show how many chargers were in use in each 5-minute period, from recorded sessions.";
    chart.parentElement.appendChild(note);
  }
}

// ---- Session ownership token (kept only on the phone that started the session) ----
function isDemo() { return CONFIG.BACKEND_URL.includes("PASTE_YOUR"); }
function getToken(id) {
  if (!id) return null;
  if (isDemo()) return "demo";
  try { return localStorage.getItem(`evcm:token:${id}`); } catch (e) { return null; }
}
function saveToken(id, token) { try { localStorage.setItem(`evcm:token:${id}`, token); } catch (e) {} }
function clearToken(id) { try { localStorage.removeItem(`evcm:token:${id}`); } catch (e) {} }
function loadProfile() { try { return JSON.parse(localStorage.getItem("evcm:profile") || "{}"); } catch (e) { return {}; } }
function saveProfile(u, v, e) { try { localStorage.setItem("evcm:profile", JSON.stringify({ u, v, e })); } catch (err) {} }

// ---- "Start charging session" panel (built once, only shown/hidden afterwards) ----
function buildStartPanel() {
  const css = document.createElement("style");
  css.textContent = `
    #startPanel{margin:16px 0;padding:16px;border:1px solid var(--line,rgba(127,127,127,.35));border-radius:16px;background:var(--card,#fff);color:var(--text,inherit)}
    #startPanel[hidden],#startPanel [hidden]{display:none!important}
    #startPanel h3{margin:0 0 4px;font-size:1rem}
    #startPanel p{margin:0 0 8px;opacity:.8;font-size:.875rem}
    #startPanel label{display:block;font-size:.8rem;margin:10px 0 4px;opacity:.85}
    #startPanel input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:8px;border:1px solid var(--line,rgba(127,127,127,.5));background:#fff;color:var(--text,inherit)}
    #startPanel button{margin-top:14px;width:100%;padding:12px;font-size:1rem;font-weight:600;border:0;border-radius:8px;cursor:pointer;background:var(--primary,#22459D);color:#fff}
    #startPanel button:disabled{opacity:.6;cursor:default}
    #startMsg{margin-top:10px;font-size:.85rem;color:var(--red,#d94242)}`;
  document.head.appendChild(css);

  const profile = loadProfile();
  const panel = document.createElement("div");
  panel.id = "startPanel";
  panel.hidden = true;
  panel.innerHTML = `
    <h3 id="startTitle">Start charging session</h3>
    <p id="startBusy" hidden>A session is already active on this charger.</p>
    <form id="startForm" novalidate>
      <p>Enter your details once you have plugged in. Your timer starts when you tap Start.</p>
      <label for="startUser">User ID</label>
      <input id="startUser" autocomplete="username" maxlength="40">
      <label for="startVehicle">Vehicle / plate no.</label>
      <input id="startVehicle" autocomplete="off" autocapitalize="characters" maxlength="40">
      <label for="startEmail">Email (for reminders)</label>
      <input id="startEmail" type="email" inputmode="email" autocomplete="email" maxlength="100">
      <p style="margin:6px 0 0;font-size:.75rem">We email you at 2h50m and 3h20m so you can avoid the ₱50 penalty. Used only for reminders.</p>
      <button id="startButton" type="submit">Start session</button>
      <div id="startMsg" hidden></div>
    </form>`;

  const anchor = $("endButton");
  const row = anchor.parentElement;
  if (row && row.parentElement) row.parentElement.insertBefore(panel, row);
  else document.body.prepend(panel);

  $("startUser").value = profile.u || "";
  $("startVehicle").value = profile.v || "";
  $("startEmail").value = profile.e || "";
  $("startForm").addEventListener("submit", e => { e.preventDefault(); startSession(); });
}

function updateStartPanel() {
  const panel = $("startPanel");
  if (!panel) return;
  const s = state.session;
  const active = !!s && s.status === "ACTIVE";
  const mine = active && !!getToken(s.sessionId);
  const stale = active && (Date.now() - new Date(s.startTime).getTime() > MAX_MS);
  const online = !!state.status?.online;
  const canStart = online && (!active || (!mine && stale));

  panel.hidden = mine || !online;
  $("startForm").hidden = !canStart;
  $("startBusy").hidden = canStart;
  const title = $("startTitle");
  if (title) title.textContent = state.charger?.chargerName ? `Start session on ${state.charger.chargerName}` : "Start charging session";
}

async function startSession() {
  const userId = $("startUser").value.trim();
  const vehicleId = $("startVehicle").value.trim();
  const email = $("startEmail").value.trim().toLowerCase();
  const msg = $("startMsg");
  msg.hidden = true;

  if (!ID_RE.test(userId) || !ID_RE.test(vehicleId)) {
    msg.textContent = "Enter your User ID and vehicle/plate no. (2-40 letters, numbers, space, . _ -).";
    msg.hidden = false;
    return;
  }
  if (!EMAIL_RE.test(email)) {
    msg.textContent = "Enter a valid email address so we can send you reminders.";
    msg.hidden = false;
    return;
  }

  $("startButton").disabled = true;
  try {
    const res = await api("createSession", { userId, vehicleId, email });
    saveToken(res.sessionId, res.token);
    saveProfile(userId, vehicleId, email);
    await load();
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    $("startButton").disabled = false;
  }
}

// ---- Charger picker: users choose which charger they are using ----
function buildChargerPicker() {
  const panel = document.createElement("section");
  panel.id = "chargerPicker";
  panel.className = "charger-picker";
  panel.hidden = true;
  panel.innerHTML = `
    <h2>Choose your charger</h2>
    <p>Select the charger you are plugged into, or want to use.</p>
    <div class="charger-list" id="chargerList"></div>`;

  const anchor = document.querySelector(".hero") || document.querySelector(".dashboard-grid");
  if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(panel, anchor);
  else document.body.prepend(panel);

  $("chargerList").addEventListener("click", e => {
    const btn = e.target.closest(".charger-opt");
    if (btn) selectCharger(btn.dataset.id);
  });
}

function renderChargerPicker() {
  const panel = $("chargerPicker");
  if (!panel) return;
  const list = state.chargers;
  panel.hidden = list.length === 0;
  $("chargerList").innerHTML = list.map(c => {
    const selected = c.chargerId === state.chargerId;
    return `<button type="button" class="charger-opt${selected ? " selected" : ""}" data-id="${escapeHtml(c.chargerId)}" aria-pressed="${selected}">
      <strong>${escapeHtml(c.chargerName)}</strong>
      <small>${escapeHtml(c.location)}</small>
      <span class="pill ${c.inUse ? "busy" : "free"}">${c.inUse ? "IN USE" : "AVAILABLE"}</span>
    </button>`;
  }).join("");
}

function selectCharger(id) {
  if (!id || id === state.chargerId) return;
  const known = state.chargers.find(c => c.chargerId === id);
  state.chargerId = id;
  state.charger = known ? { chargerId: id, chargerName: known.chargerName, location: known.location } : null;
  state.status = null;
  state.session = null;
  state.history = [];
  state.loading = true;
  try { localStorage.setItem("evcm:lastCharger", id); } catch (e) {}
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("charger", id);
    window.history.replaceState(null, "", u);
  } catch (e) {}
  renderChargerPicker();
  hideError();
  render();            // blank out the previous charger's data immediately
  renderHistory();
  load();
}

function withUnit(v, unit) { return v == null || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(1)} ${unit}`; }
function number(v) { return v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(1); }
function duration(min) { const h=Math.floor((min||0)/60),m=(min||0)%60; return `${h}h ${m}m`; }
function hhmmss(ms) { let s=Math.floor(ms/1000); const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;return [h,m,s].map(x=>String(x).padStart(2,"0")).join(":"); }
function formatTime(v) { if(!v)return "—"; return new Date(v).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); }
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));}
function showError(msg){$("errorBox").textContent=msg;$("errorBox").classList.remove("hidden")}
function hideError(){$("errorBox").classList.add("hidden")}

state.chargerId = getChargerId();
buildChargerPicker();
buildStartPanel();
$("endButton").addEventListener("click", endSession);
renderActivity(null);
load();
state.timerHandle = setInterval(updateTimer, CONFIG.TIMER_MS);
state.refreshHandle = setInterval(load, CONFIG.REFRESH_MS);