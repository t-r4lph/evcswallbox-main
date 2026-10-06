# EV Charge Monitor

A QR-accessible web app for monitoring and timing EV charging sessions across several chargers.

- **Frontend:** HTML / CSS / JavaScript (static, hosted anywhere public, e.g. GitHub Pages)
- **Backend:** Google Apps Script web app
- **Database:** Google Sheets
- **Wallbox API adapter:** optional, for live power / energy data (not required to run)

**Charging rules**

| Elapsed time | Result |
|---|---|
| 0:00 – 3:00 | Normal, no penalty |
| 3:00 – 3:30 | Grace period, warning shown, no penalty |
| after 3:30 | ₱50 penalty |

---

## 1. How it works

```
QR code → hosted page (index.html + app.js) → Apps Script web app (Code.gs) → Google Sheet
                                                          ↓ (optional, later)
                                                     Wallbox API
```

1. The user scans one QR code that opens the hosted page.
2. The page lists the enabled chargers with **AVAILABLE / IN USE**. The user picks the charger they are using.
3. The user enters a **User ID** and **vehicle / plate no.** and taps **Start session**.
4. The page shows the 3-hour timer, grace period and penalty status.
5. The user taps **End** when finished. The session is saved with its duration and any penalty.

A session's secret token is stored only on the phone that started it, so only that phone can end the session.

---

## 2. Files

| File | Where it lives | Purpose |
|---|---|---|
| `index.html` | Frontend host | Page structure |
| `style.css` | Frontend host | Styling (SM blue theme) |
| `app.js` | Frontend host | Page logic, charger picker, start-session panel |
| `Code.gs` | Apps Script | Backend API and Wallbox adapter |
| `README.md` | Repository | This guide |

The theme color is one variable at the top of `style.css`: `--sm-blue: #22459D`. That value is approximated from SM's logo, not an official brand value. Replace it if you have the official one.

---

## 3. Google Sheet

Create a Google Sheet and copy its ID from the URL, the part between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit
```

`setupSheets()` creates these tabs:

**Chargers**

| chargerId | chargerName | location | enabled |
|---|---|---|---|
| 958875 | SMOA PulsarPlus | SM Mall of Asia · Indoor Parking · Level 3 | TRUE |

**Sessions** (created by the app, do not edit by hand except to resolve problems)

`sessionId, chargerId, userId, vehicleId, startTime, endTime, durationMin, energyKwh, status, penaltyPhp, token`

- `status` is `ACTIVE`, `COMPLETED` or `EXPIRED`.
- `token` is the secret that lets the starting phone end its session. Do not share this column.
- `startTime` / `endTime` display as `yyyy-mm-dd hh:mm:ss`. Change `TIME_FORMAT` in `Code.gs` to alter this.

**StatusLog**

Created but not used yet. It is reserved for logging Wallbox status readings once API access exists.

### Adding or removing chargers

Add or edit rows in the **Chargers** tab by hand. No code change or redeploy is needed.

- `enabled` can be a checkbox or text. Blank or `TRUE` means enabled. `FALSE`, `no` or `0` hides the charger and blocks new sessions on it.
- Do not leave blank rows between chargers or rename the header row. The code finds columns by header name.

---

## 4. Backend setup (Apps Script)

1. Open the Sheet, then **Extensions → Apps Script**.
2. Replace the default code with `Code.gs`.
3. Open **Project Settings → Script Properties** and add:

| Property | Value |
|---|---|
| `SHEET_ID` | Your Sheet ID |
| `STATUS_MODE` | `none`, `demo` or `wallbox` (see below) |

4. Select `setupSheets` in the function dropdown and click **Run**. Authorize the script when prompted (**Advanced → Go to project (unsafe)** is normal for your own script). It is safe to run again; it only fills in what is missing and reapplies date formats.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the Web app URL (it ends in `/exec`).

**After any change to `Code.gs`:** Deploy → Manage deployments → pencil icon → **New version** → Deploy. Apps Script keeps serving the old code until you do this, and the URL stays the same.

### Status modes (`STATUS_MODE`)

| Value | Behavior |
|---|---|
| `none` | **Session-only.** No Wallbox needed. Status is derived from the app's own sessions (AVAILABLE / IN USE). Power and energy show "—". Recommended until Wallbox access exists. |
| `demo` | Fake data (7.2 kW, 18.4 kWh, always charging) for testing only. |
| `wallbox` | Real Wallbox API (see section 7). |

If `STATUS_MODE` is not set, the older `DEMO_MODE` property is used (`true` = demo, otherwise wallbox).

---

## 5. Frontend setup

1. In `app.js`, set the backend URL:

```js
const CONFIG = {
  BACKEND_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  REFRESH_MS: 15000,
  TIMER_MS: 1000
};
```

2. Host `index.html`, `style.css` and `app.js` together on a public static host, for example GitHub Pages.
3. Test by opening the hosted page. The charger list should appear.

> Do **not** put the Apps Script `/exec` URL in the QR code. That URL only returns JSON. The QR code must point to the hosted page.

### The QR code

Create **one** QR code for the hosted page URL, for example:

```
https://YOUR-USERNAME.github.io/evcswallbox/
```

Users choose their charger on the page. A link such as `.../?charger=918937` still preselects a charger if you ever want a charger-specific code. A phone also remembers the last charger it chose.

---

## 6. Using the app

**Starting a session**
- The charger must be shown as available. The Start panel asks for **User ID** and **vehicle / plate no.** (2–40 letters, numbers, spaces, `.`, `_`, `-`). Both are remembered on that phone for next time.
- Only one active session is allowed per charger.
- The timer starts when the user taps **Start session**, not when the car is plugged in.

**Ending a session**
- Only the phone that started the session can end it, using its stored token. If someone clears browser data or switches phones, staff can end the session by setting `status` to `COMPLETED` in the Sessions tab.
- The penalty is calculated from the time between start and end.

**Sessions that are never ended**
- If a session is still `ACTIVE` after 3h30m and the next person starts a session on that charger, the old one is closed as `EXPIRED` with the ₱50 penalty. The end time and duration are left blank so staff can review it.
- To change this, edit the `setValue(SETTINGS.PENALTY_PHP)` line in `createSession_()`.

**Charging Activity chart**
- Shows, for the last 60 minutes in 5-minute slots, how many chargers were in use (bar height = chargers in use out of all enabled chargers; hover a bar for the exact count). It is built from recorded sessions, so it reflects who tapped Start and End, not actual power draw. Real power (kW) needs Wallbox data.

**History table**
- Shows the last 10 sessions for the selected charger with status **Active**, **Complete**, **Penalty** or **Expired**.

---

## 7. Wallbox integration (optional, later)

The app runs fully without Wallbox access. To add live power / energy data:

1. Obtain from your organization or Wallbox: the API base URL, authentication details, and the endpoint that returns a charger's status, with its documentation. At the time of writing there is no public official token-request process that was found, so ask Wallbox support or your account representative. Community projects use an unofficial consumer API that requires a login and may change without notice.
2. Make one real call and save a sample JSON response (remove tokens).
3. Add Script Properties:

| Property | Example |
|---|---|
| `STATUS_MODE` | `wallbox` |
| `WALLBOX_BASE_URL` | your organization's API base URL |
| `WALLBOX_TOKEN` | your token |
| `WALLBOX_STATUS_PATH` | `/chargers/{chargerId}/status` (example only) |

4. Edit **only** `normalizeWallbox_()` in `Code.gs` so the real response fields map to:

```json
{
  "online": true,
  "status": "CHARGING",
  "charging": true,
  "powerKw": 7.2,
  "energyKwh": 18.4,
  "startTime": "2026-10-05T10:15:00+08:00"
}
```

5. Deploy a new version and check `YOUR_EXEC_URL?action=charger&chargerId=958875`.

Never put the Wallbox token in `app.js`. The Wallbox charger IDs may differ from the serial numbers used in the Chargers tab. If so, add a mapping column. Consider caching Wallbox responses in Apps Script, since every open page refreshes every 15 seconds and the API may rate-limit requests.

---

## 8. Backend API

All requests are `GET` to the web app URL. Responses use `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`.

| Action | Parameters | Returns |
|---|---|---|
| `charger` (default) | `chargerId` | `{ charger, status, session }` |
| `chargers` | none | `[{ chargerId, chargerName, location, inUse }]` for enabled chargers |
| `history` | `chargerId` | Last 10 sessions for the charger |
| `activity` | none | Chargers in use per 5-minute slot for the last hour: `{ slots, totalChargers, slotMinutes }` |
| `createSession` | `chargerId`, `userId`, `vehicleId` | `{ sessionId, token }` |
| `endSession` | `chargerId`, `sessionId`, `token` | `{ sessionId, durationMin, penaltyPhp }` |

Quick check in a private browser window:

```
YOUR_EXEC_URL?action=chargers
```

---

## 9. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| `Backend returned HTTP 404` | The deployment is missing, archived, or not set to **Anyone**. Redo section 4, step 5, then copy the current `/exec` URL into `BACKEND_URL`. A work or school account may be blocked by admin policy from using "Anyone". |
| `Illegal spreadsheet id or key` | `SHEET_ID` still holds the placeholder or has a typo. Paste only the ID between `/d/` and `/edit`, no quotes or spaces. |
| "Authorization required" | Normal on first run. Click **Review permissions**, then **Advanced → Go to project (unsafe)**, then **Allow**. |
| Chargers are not listed | The page is probably still using an older backend. Deploy a new version. Also check that rows are in the **Chargers** tab of the spreadsheet whose ID is in `SHEET_ID`, with no stray spaces in `chargerId`. |
| End time shows only a date | Run `setupSheets()` once to reapply the date-time format. Also set the project and spreadsheet time zone to **Asia/Manila**. |
| "Only the phone that started this session can end it" | The token isn't on this device. Staff can close the session in the sheet. |
| "This charger is not available" | The charger ID isn't in the Chargers tab or is disabled. |
| Page shows "Choose a charger" | No charger selected yet. Tap one in the list. |

---

## 10. Security notes

- The `/exec` URL is public by design and holds no secrets. Never place the Wallbox token, or any other secret, in `app.js` or `index.html`.
- User IDs and plate numbers are sent as URL parameters, so they can appear in request logs. Do not collect sensitive personal data.
- IDs must start with a letter or digit, which also blocks spreadsheet formula injection.
- Sessions can only be ended with their token. The token column should not be shared or published.
- Start and End are plain GET requests with no login. This suits a trusted site such as a company or mall parking facility. A stronger identity check (SSO, or RFID / OCPP identification from the charger) is a later option.

---

## 11. Known limitations and roadmap

**Known limitations**
- In `none` mode the app can't tell whether a car is actually charging. It relies on users tapping Start and End.
- Overdue sessions are only closed when the next person starts a session on that charger. A time-driven trigger could close them on a schedule.
- `StatusLog` is not written to yet.

**Planned: waiting queue**

If every charger is in use, a user can register in a queue that is saved to the database. When a charger frees up, the first person in line is offered it and has 10 minutes to respond.

- If they respond, their session starts and they leave the queue.
- If they do not, they move **back one place**, swapping with the next person, who is then offered the charger. This repeats.
- Example: queue 1, 2, 3, 4, 5. Customer 1 doesn't respond, so the order becomes 2, 1, 3, 4, 5, and customer 2 gets the next 10 minutes.
- A cap on missed offers (for example 2 or 3 misses, then removal) is needed so two absent customers don't swap forever. A contact method for the offer (SMS, email or on-page) and a one-minute time-driven trigger to expire offers are also required.

**Later**
- Live Wallbox data, including linking sessions to actual charging state.
- Moving sessions from Sheets to a database for many chargers or heavy use, while keeping Sheets for reporting and export.