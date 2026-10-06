/*
EV Charge Monitor - Google Apps Script backend

SET SCRIPT PROPERTIES:
SHEET_ID            = your Google Sheet ID
STATUS_MODE         = none | demo | wallbox   (none = session-only, no Wallbox needed)
DEMO_MODE           = true/false              (only used when STATUS_MODE is not set)
WALLBOX_BASE_URL    = supplied by your organization
WALLBOX_TOKEN       = supplied by your organization
WALLBOX_STATUS_PATH = e.g. /chargers/{chargerId}/status
WALLBOX_SESSIONS_PATH = e.g. /chargers/{chargerId}/sessions

IMPORTANT:
The exact Wallbox endpoint/JSON varies by API deployment. Keep all credentials here,
never in app.js or index.html.
*/

const SETTINGS = {
  SESSION_LIMIT_MIN: 180,
  GRACE_MIN: 30,
  PENALTY_PHP: 50,
  DEFAULT_CHARGER_ID: "958875",
  TIME_FORMAT: "yyyy-mm-dd hh:mm:ss",  // how startTime/endTime display in the Sessions sheet
  ALERT_MAX_MIN: 360,                  // do not email staff about sessions older than this (abandoned)
  KEEP_EMAIL_AFTER_END: false          // false = the user's email is erased from the sheet when they end their session
};

function doGet(e) {
  try {
    const action = (e.parameter.action || "charger").toString();
    const chargerId = (e.parameter.chargerId || SETTINGS.DEFAULT_CHARGER_ID).toString();

    let data;
    if (action === "charger") data = getChargerData(chargerId);
    else if (action === "chargers") data = listChargers();
    else if (action === "activity") data = getActivity();
    else if (action === "history") data = getHistory(chargerId);
    else if (action === "createSession") data = createSession_(chargerId, e.parameter.userId, e.parameter.vehicleId, e.parameter.email);
    else if (action === "endSession") data = endSession(chargerId, e.parameter.sessionId, e.parameter.token);
    else throw new Error("Unknown action: " + action);

    return json_({ok:true, data:data});
  } catch (err) {
    return json_({ok:false, error:err.message});
  }
}

function getChargerData(chargerId) {
  const charger = getCharger_(chargerId);
  const status = getWallboxStatus_(chargerId);
  const session = getActiveSession_(chargerId, status);
  // Session-only mode: there is no Wallbox data, so status comes from our own session record.
  const finalStatus = getStatusMode_() === "none" ? sessionOnlyStatus_(session) : status;
  return {charger:charger, status:finalStatus, session:session};
}

// ---- Charger list (for the charger picker on the page) ----

// Rows of the Chargers sheet that have an ID and are not disabled.
// "enabled" may be a checkbox or text; blank counts as enabled, FALSE / no / 0 as disabled.
function getEnabledChargers_() {
  const sheet = getSheet_("Chargers");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));
  return values.slice(1)
    .filter(r => String(r[ix.chargerId] ?? "").trim() !== "")
    .filter(r => {
      if (ix.enabled === undefined) return true;
      const v = String(r[ix.enabled]).trim().toLowerCase();
      return v !== "false" && v !== "no" && v !== "0";
    })
    .map(r => ({
      chargerId: String(r[ix.chargerId]).trim(),
      chargerName: String(r[ix.chargerName] || "EV Charger"),
      location: String(r[ix.location] || "")
    }));
}

// Chargers that currently have an ACTIVE session.
function busyChargerIds_() {
  const busy = new Set();
  const sheet = getSheet_("Sessions");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return busy;
  const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][ix.status]) === "ACTIVE") busy.add(String(values[r][ix.chargerId]).trim());
  }
  return busy;
}

function listChargers() {
  const busy = busyChargerIds_();
  return getEnabledChargers_().map(c => ({
    chargerId: c.chargerId, chargerName: c.chargerName, location: c.location, inUse: busy.has(c.chargerId)
  }));
}

// ---- Charging activity chart: how many chargers were in use in each 5-minute slot of the last hour ----
// Built from the Sessions sheet only (no Wallbox needed). Returns the 12 slots oldest -> newest.
function getActivity() {
  const SLOT_MS = 5 * 60000, SLOTS = 12;
  const now = Date.now();
  const maxMs = (SETTINGS.SESSION_LIMIT_MIN + SETTINGS.GRACE_MIN) * 60000;
  const windowStart = now - SLOTS * SLOT_MS;

  const values = getSheet_("Sessions").getDataRange().getValues();
  const intervals = [];
  if (values.length > 1) {
    const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));
    for (let r = 1; r < values.length; r++) {
      const start = new Date(values[r][ix.startTime]).getTime();
      if (isNaN(start)) continue;
      const status = String(values[r][ix.status]);
      let end = values[r][ix.endTime] ? new Date(values[r][ix.endTime]).getTime() : NaN;
      // No end time: an ACTIVE session within the limit is still running; otherwise count it up to 3h30m.
      if (isNaN(end)) end = (status === "ACTIVE" && now - start <= maxMs) ? now : start + maxMs;
      if (end <= windowStart || start >= now) continue;
      intervals.push({chargerId: String(values[r][ix.chargerId]).trim(), start: start, end: end});
    }
  }

  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const from = windowStart + i * SLOT_MS, to = from + SLOT_MS;
    const busy = new Set();
    intervals.forEach(s => { if (s.start < to && s.end > from) busy.add(s.chargerId); });
    slots.push({end: new Date(to).toISOString(), count: busy.size});
  }
  return {slots: slots, totalChargers: getEnabledChargers_().length, slotMinutes: 5};
}

function requireEnabledCharger_(chargerId) {
  const id = String(chargerId || "").trim();
  if (!getEnabledChargers_().some(c => c.chargerId === id)) throw new Error("This charger is not available.");
}

function getCharger_(chargerId) {
  const sheet = getSheet_("Chargers");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {chargerId, chargerName:"EV Charger", location:"Location not configured"};

  const headers = values[0];
  const rows = values.slice(1);
  const iId = headers.indexOf("chargerId"), iName = headers.indexOf("chargerName"), iLoc = headers.indexOf("location");
  const row = rows.find(r => String(r[iId]) === String(chargerId));
  if (!row) return {chargerId, chargerName:"EV Charger", location:"Location not configured"};
  return {chargerId:String(row[iId]), chargerName:String(row[iName]), location:String(row[iLoc])};
}

function getWallboxStatus_(chargerId) {
  const props = PropertiesService.getScriptProperties();
  const mode = getStatusMode_();
  if (mode === "demo") return demoWallboxStatus_();
  if (mode === "none") return sessionOnlyStatus_(null);

  const base = props.getProperty("WALLBOX_BASE_URL");
  const path = props.getProperty("WALLBOX_STATUS_PATH");
  const token = props.getProperty("WALLBOX_TOKEN");
  if (!base || !path || !token) throw new Error("Wallbox API settings are incomplete.");

  const url = base.replace(/\/$/,"") + path.replace("{chargerId}", encodeURIComponent(chargerId));
  const response = UrlFetchApp.fetch(url, {
    method:"get",
    headers:{Authorization:"Bearer " + token, Accept:"application/json"},
    muteHttpExceptions:true
  });

  if (response.getResponseCode() >= 400) throw new Error("Wallbox API returned HTTP " + response.getResponseCode());
  const raw = JSON.parse(response.getContentText());
  return normalizeWallbox_(raw);
}

function normalizeWallbox_(raw) {
  /*
    REPLACE THESE FIELD MAPPINGS AFTER YOUR ORGANIZATION PROVIDES
    THE ACTUAL WALLBOX API RESPONSE.

    Example expected normalized result:
    {
      online: true,
      status: "CHARGING",
      charging: true,
      powerKw: 7.2,
      energyKwh: 18.4,
      startTime: "2026-10-05T10:15:00+08:00"
    }
  */

  return {
    online: Boolean(raw.online ?? raw.isOnline ?? false),
    status: String(raw.status ?? "UNKNOWN").toUpperCase(),
    charging: Boolean(raw.charging ?? String(raw.status).toUpperCase() === "CHARGING"),
    powerKw: Number(raw.powerKw ?? raw.power ?? 0),
    energyKwh: Number(raw.energyKwh ?? raw.energy ?? 0),
    startTime: raw.startTime || null
  };
}

function getActiveSession_(chargerId, status) {
  const sheet = getSheet_("Sessions");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  const h = values[0], rows = values.slice(1);
  const ix = Object.fromEntries(h.map((x,i)=>[x,i]));
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (String(r[ix.chargerId]) === String(chargerId) && String(r[ix.status]) === "ACTIVE") {
      return {
        sessionId:String(r[ix.sessionId]),
        userId:String(r[ix.userId]),
        vehicleId:String(r[ix.vehicleId]),
        startTime:new Date(r[ix.startTime]).toISOString(),
        status:"ACTIVE",
        penaltyPhp:Number(r[ix.penaltyPhp] || 0)
      };
    }
  }

  // Optional automatic session creation:
  // If Wallbox reports charging but there is no application session,
  // you can call createSession_() after adding your preferred user identification flow.
  return null;
}

function endSession(chargerId, sessionId, token) {
  if (!sessionId) throw new Error("Missing session ID.");
  if (!token) throw new Error("Only the phone that started this session can end it.");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_("Sessions");
    ensureSessionColumns_(sheet);
    const values = sheet.getDataRange().getValues();
    const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));

    for (let r = 1; r < values.length; r++) {
      if (String(values[r][ix.sessionId]) !== String(sessionId)) continue;
      if (String(values[r][ix.chargerId]) !== String(chargerId)) throw new Error("Session not found.");
      if (String(values[r][ix.status]) !== "ACTIVE") throw new Error("This session has already ended.");
      if (String(values[r][ix.token] || "") !== String(token)) throw new Error("Only the phone that started this session can end it.");

      const start = new Date(values[r][ix.startTime]);
      const end = new Date();
      const durationMin = Math.max(0, Math.floor((end - start) / 60000));
      const penalty = durationMin > SETTINGS.SESSION_LIMIT_MIN + SETTINGS.GRACE_MIN ? SETTINGS.PENALTY_PHP : 0;

      sheet.getRange(r+1, ix.endTime+1).setValue(end).setNumberFormat(SETTINGS.TIME_FORMAT);
      sheet.getRange(r+1, ix.durationMin+1).setValue(durationMin);
      sheet.getRange(r+1, ix.status+1).setValue("COMPLETED");
      if (!SETTINGS.KEEP_EMAIL_AFTER_END) sheet.getRange(r+1, ix.email+1).clearContent();
      sheet.getRange(r+1, ix.penaltyPhp+1).setValue(penalty);

      return {sessionId, durationMin, penaltyPhp:penalty};
    }
    throw new Error("Session not found.");
  } finally {
    lock.releaseLock();
  }
}

function getHistory(chargerId) {
  const sheet = getSheet_("Sessions");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));

  return values.slice(1).filter(r => String(r[ix.chargerId]) === String(chargerId))
    .reverse().slice(0,10).map(r => ({
      sessionId:String(r[ix.sessionId]),
      startTime:new Date(r[ix.startTime]).toISOString(),
      durationMin:Number(r[ix.durationMin] || 0),
      energyKwh:Number(r[ix.energyKwh] || 0),
      status:String(r[ix.status]),
      penaltyPhp:Number(r[ix.penaltyPhp] || 0)
    }));
}

function createSession_(chargerId, userId, vehicleId, email) {
  userId = cleanId_(userId, "User ID");
  vehicleId = cleanId_(vehicleId, "Vehicle ID");
  email = cleanEmail_(email);
  requireEnabledCharger_(chargerId);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_("Sessions");
    ensureSessionColumns_(sheet);
    const values = sheet.getDataRange().getValues();
    const headers = values[0], ix = Object.fromEntries(headers.map((x,i)=>[x,i]));
    const now = new Date();
    const maxMin = SETTINGS.SESSION_LIMIT_MIN + SETTINGS.GRACE_MIN;

    // One active session per charger. A session that is already past
    // limit + grace and was never ended is closed as EXPIRED (penalty applies,
    // endTime/duration left blank for staff review) so the charger is not locked forever.
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][ix.chargerId]) !== String(chargerId)) continue;
      if (String(values[r][ix.status]) !== "ACTIVE") continue;
      const elapsedMin = Math.floor((now - new Date(values[r][ix.startTime])) / 60000);
      if (elapsedMin <= maxMin) throw new Error("This charger already has an active session.");
      sheet.getRange(r+1, ix.status+1).setValue("EXPIRED");
      sheet.getRange(r+1, ix.penaltyPhp+1).setValue(SETTINGS.PENALTY_PHP);
    }

    const sessionId = "SES-" + Utilities.getUuid().slice(0,8).toUpperCase();
    const token = Utilities.getUuid();
    const rec = {
      sessionId:sessionId, chargerId:String(chargerId), userId:userId, vehicleId:vehicleId,
      startTime:now, endTime:"", durationMin:"", energyKwh:0, status:"ACTIVE", penaltyPhp:0, token:token, email:email
    };
    sheet.appendRow(headers.map(h => rec[h] === undefined ? "" : rec[h]));
    sheet.getRange(sheet.getLastRow(), ix.startTime + 1).setNumberFormat(SETTINGS.TIME_FORMAT);
    return {sessionId:sessionId, token:token};
  } finally {
    lock.releaseLock();
  }
}

// IDs must start with a letter/digit, which also blocks spreadsheet formula injection (=, +, -, @).
function cleanId_(value, label) {
  const s = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,39}$/.test(s)) {
    throw new Error(label + " must be 2-40 characters: letters, numbers, space, dot, dash or underscore.");
  }
  return s;
}

// Adds any missing app-managed columns to an existing Sessions sheet.
function ensureSessionColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let col = lastCol;
  ["token", "email", "remind1", "remind2", "staffAlert"].forEach(name => {
    if (headers.indexOf(name) === -1) { col++; sheet.getRange(1, col).setValue(name); }
  });
}

// Where charger status comes from:
//   STATUS_MODE = none    -> session-only (no Wallbox; status derived from our own sessions)
//   STATUS_MODE = demo    -> fake data for testing
//   STATUS_MODE = wallbox -> real Wallbox API
// If STATUS_MODE is not set, the old DEMO_MODE property decides (true = demo, otherwise wallbox).
function getStatusMode_() {
  const props = PropertiesService.getScriptProperties();
  const explicit = String(props.getProperty("STATUS_MODE") || "").trim().toLowerCase();
  if (explicit === "demo" || explicit === "wallbox" || explicit === "none") return explicit;
  const demo = String(props.getProperty("DEMO_MODE") || "true").toLowerCase() === "true";
  return demo ? "demo" : "wallbox";
}

function sessionOnlyStatus_(session) {
  const inUse = !!session;
  return {
    online: true,
    status: inUse ? "IN USE" : "AVAILABLE",
    charging: inUse,
    powerKw: null,
    energyKwh: null,
    startTime: inUse ? session.startTime : null,
    source: "none"
  };
}

function demoWallboxStatus_() {
  const start = new Date(Date.now() - (1*60*60*1000 + 42*60*1000 + 35*1000));
  return {online:true,status:"CHARGING",charging:true,powerKw:7.2,energyKwh:18.4,startTime:start.toISOString()};
}

function setupSheets() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
  const definitions = {
    Chargers:["chargerId","chargerName","location","enabled"],
    Sessions:["sessionId","chargerId","userId","vehicleId","startTime","endTime","durationMin","energyKwh","status","penaltyPhp","token","email","remind1","remind2","staffAlert"],
    StatusLog:["timestamp","chargerId","online","status","chargingTimeMin","powerKw","energyKwh"]
  };

  Object.keys(definitions).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(definitions[name]);
  });

  formatSessionColumns_(ss.getSheetByName("Sessions"));

  const chargers = ss.getSheetByName("Chargers");
  if (chargers.getLastRow() === 1) chargers.appendRow(["958875","SMOA PulsarPlus","SM Mall of Asia · Indoor Parking · Level 3",true]);
}

// Show startTime/endTime as full date + time (the sheet may otherwise display only the date).
function formatSessionColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ["startTime", "endTime"].forEach(name => {
    const i = headers.indexOf(name);
    if (i === -1) return;
    sheet.getRange(2, i + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat(SETTINGS.TIME_FORMAT);
  });
}

// ---- Email address validation (same rule as the page). Must start with a letter/digit, which also blocks formula injection. ----
const EMAIL_RE_ = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function cleanEmail_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s.length > 100 || !EMAIL_RE_.test(s)) throw new Error("Enter a valid email address so we can send you reminders.");
  return s;
}

// ---- Email reminders ----
// Run installReminderTrigger() once. sendReminders() then runs every minute and emails:
//   - the user at 2h50m (10 min before the 3-hour limit) and at 3h20m (10 min before the penalty)
//   - the admin (ADMIN_EMAIL property) when a session passes 3h30m
// Each email is sent once; the time it was sent is written to remind1 / remind2 / staffAlert.
function sendReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;   // a previous run is still going
  try {
    const sheet = getSheet_("Sessions");
    ensureSessionColumns_(sheet);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return;
    const h = values[0], ix = Object.fromEntries(h.map((x,i)=>[x,i]));

    const props = PropertiesService.getScriptProperties();
    const adminEmail = String(props.getProperty("ADMIN_EMAIL") || "").trim();
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const R1 = SETTINGS.SESSION_LIMIT_MIN - 10;                       // 170 min
    const R2 = SETTINGS.SESSION_LIMIT_MIN + SETTINGS.GRACE_MIN - 10;  // 200 min
    const PEN = SETTINGS.SESSION_LIMIT_MIN + SETTINGS.GRACE_MIN;      // 210 min
    const fmt = d => Utilities.formatDate(d, tz, "h:mm a");

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (String(row[ix.status]) !== "ACTIVE") continue;
      const start = new Date(row[ix.startTime]);
      if (isNaN(start)) continue;

      const elapsed = (now - start) / 60000;
      const chargerId = String(row[ix.chargerId]).trim();
      const email = String(row[ix.email] || "").trim();
      const info = {
        name: getCharger_(chargerId).chargerName,
        start: fmt(start),
        limit: fmt(new Date(start.getTime() + SETTINGS.SESSION_LIMIT_MIN * 60000)),
        penalty: fmt(new Date(start.getTime() + PEN * 60000)),
        link: appLink_(chargerId)
      };
      const mark = col => sheet.getRange(r + 1, ix[col] + 1).setValue(new Date()).setNumberFormat(SETTINGS.TIME_FORMAT);

      // Windows keep a late run from sending an out-of-date reminder.
      if (email && !row[ix.remind1] && elapsed >= R1 && elapsed < R2) {
        if (sendMail_(email, "EV charging: 10 minutes left before the 3-hour limit", reminderBody_(1, info))) mark("remind1");
      }
      if (email && !row[ix.remind2] && elapsed >= R2 && elapsed < PEN) {
        if (sendMail_(email, "EV charging: 10 minutes before the \u20b1" + SETTINGS.PENALTY_PHP + " penalty", reminderBody_(2, info))) mark("remind2");
      }
      if (adminEmail && !row[ix.staffAlert] && elapsed >= PEN && elapsed < SETTINGS.ALERT_MAX_MIN) {
        const mins = Math.floor(elapsed);
        const body = "A charging session has passed the " + Math.floor(PEN / 60) + "h " + (PEN % 60) + "m limit.\n\n" +
          "Charger: " + info.name + " (" + chargerId + ")\n" +
          "User ID: " + row[ix.userId] + "\n" +
          "Vehicle / plate: " + row[ix.vehicleId] + "\n" +
          "User email: " + (email || "none") + "\n" +
          "Started: " + info.start + "\n" +
          "Elapsed: " + Math.floor(mins / 60) + "h " + (mins % 60) + "m\n\n" +
          "A \u20b1" + SETTINGS.PENALTY_PHP + " penalty applies when the session ends or expires." + info.link;
        if (sendMail_(adminEmail, "[EV Charge Monitor] " + info.name + ": session passed 3h30m", body)) mark("staffAlert");
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function reminderBody_(kind, i) {
  if (kind === 1) {
    return "Hi,\n\nYour EV charging session on " + i.name + " started at " + i.start + ".\n\n" +
      "About 10 minutes remain before the 3-hour limit (" + i.limit + "). A " + SETTINGS.GRACE_MIN + "-minute grace period follows, " +
      "and if the session is still running at " + i.penalty + ", a \u20b1" + SETTINGS.PENALTY_PHP + " penalty applies.\n\n" +
      "Please move your vehicle and tap End on the page (use the same phone you started with)." + i.link;
  }
  return "Hi,\n\nYour EV charging session on " + i.name + " (started at " + i.start + ") is in its grace period.\n\n" +
    "About 10 minutes remain before the \u20b1" + SETTINGS.PENALTY_PHP + " penalty applies at " + i.penalty + ". " +
    "Please move your vehicle and end the session now." + i.link;
}

function appLink_(chargerId) {
  const url = String(PropertiesService.getScriptProperties().getProperty("APP_URL") || "").trim();
  if (!url) return "";
  return "\n\nOpen the page: " + url + (url.indexOf("?") === -1 ? "?" : "&") + "charger=" + encodeURIComponent(chargerId);
}

function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: "EV Charge Monitor" });
    return true;
  } catch (err) {
    console.error("Email to " + to + " failed: " + err.message);   // will be retried on the next run
    return false;
  }
}

// Run once to start the every-minute reminder check (replaces any existing one).
function installReminderTrigger() {
  removeReminderTrigger();
  ScriptApp.newTrigger("sendReminders").timeBased().everyMinutes(1).create();
}

function removeReminderTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendReminders")
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// Run once to authorize email sending and confirm it works. Needs the ADMIN_EMAIL script property.
function testReminderEmail() {
  const to = String(PropertiesService.getScriptProperties().getProperty("ADMIN_EMAIL") || "").trim();
  if (!to) throw new Error("Set the ADMIN_EMAIL script property first.");
  MailApp.sendEmail({
    to: to,
    subject: "EV Charge Monitor: test email",
    body: "Email sending works. Remaining daily email quota: " + MailApp.getRemainingDailyQuota(),
    name: "EV Charge Monitor"
  });
}

function getSheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  if (!id) throw new Error("SHEET_ID is not configured.");
  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("Missing sheet: " + name + ". Run setupSheets() first.");
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}