/**
 * Cloud Attendance Server for Secureye S-FB3K / Realand M61 Biometric Terminals
 * Designed for 24/7 Free Cloud Deployment on Render (render.com)
 * 
 * Supports:
 * - FkWeb Mode (HTTP POST /ebkn)
 * - WebSocket Mode (RFC 6455 XML F500)
 * - Automatic TextBee SMS with Missed-Punch Bundling
 * - Realtime Server-Sent Events (SSE)
 * - Responsive Mobile Web Dashboard (PWA)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  // Optional if ws is not installed yet
}

// Built-in SQLite support (Node 22+) with safe JSON fallback
let DatabaseSync = null;
try {
  const sqliteModule = require('node:sqlite');
  DatabaseSync = sqliteModule.DatabaseSync;
} catch (e) {
  try {
    const sqlite3 = require('sqlite3').verbose();
    // fallback if external sqlite3 installed
  } catch (err) {}
}

const PORT = parseInt(process.env.PORT || '10000', 10);
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const DB_FILE = path.join(DATA_DIR, 'attendance.sqlite');
const CSV_FILE = path.join(DATA_DIR, 'punches.csv');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default Configuration
let config = {
  companyName: 'Machining Point',
  shiftStart: '09:00',
  shiftEnd: '18:00',
  marginMinutes: 30,
  sms: {
    enabled: true,
    apiKey: 'txb_7k1Yvp5lf8XWAJ6tybNmtr0EJUuDQ1aM',
    deviceId: '6ad0f12b74e21da91a4fb932'
  }
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) {}
}

// Initialize CSV header
if (!fs.existsSync(CSV_FILE)) {
  fs.writeFileSync(
    CSV_FILE,
    'ID,Punch_Date,Punch_Time,User_ID,Employee_Name,Punch_Type,IO_Mode,Verify_Mode,Device_ID,Protocol\n',
    'utf8'
  );
}

// Employee Cache
let employeesMap = new Map();
function loadEmployees() {
  if (fs.existsSync(EMPLOYEES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
      employeesMap = new Map(Object.entries(data));
    } catch (e) {}
  }
}
function saveEmployees() {
  const obj = Object.fromEntries(employeesMap);
  fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// =========================================================================
// EMBEDDED FRONTEND ASSETS & SEED DATA (Guarantees zero-404 on cloud)
// =========================================================================
const SEED_EMPLOYEES = {
  "1": {
    "user_id": "1",
    "name": "Vijay Aameriya",
    "department": "General",
    "designation": "Staff",
    "phone": "9256920569",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:38.983251"
  },
  "2": {
    "user_id": "2",
    "name": "Ritik",
    "department": "General",
    "designation": "Staff",
    "phone": "7665820702",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.132173"
  },
  "3": {
    "user_id": "3",
    "name": "param",
    "department": "General",
    "designation": "Staff",
    "phone": "",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.244088"
  },
  "4": {
    "user_id": "4",
    "name": "jmtwp",
    "department": "General",
    "designation": "Staff",
    "phone": "",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.373271"
  },
  "5": {
    "user_id": "5",
    "name": "kusbu",
    "department": "Machining",
    "designation": "Staff",
    "phone": "9256450569",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.486499"
  },
  "6": {
    "user_id": "6",
    "name": "nitu",
    "department": "General",
    "designation": "Staff",
    "phone": "7727857046",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.609726"
  },
  "7": {
    "user_id": "7",
    "name": "suresh",
    "department": "General",
    "designation": "Staff",
    "phone": "9314620569",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.721272"
  },
  "8": {
    "user_id": "8",
    "name": "anju",
    "department": "General",
    "designation": "Staff",
    "phone": "7726050390",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T23:36:39.870228"
  },
  "9": {
    "user_id": "9",
    "name": "ANJU",
    "department": "General",
    "designation": "Staff",
    "phone": "7726050390",
    "standard_in": "09:00",
    "standard_out": "18:00",
    "margin_minutes": 30,
    "updated_at": "2026-10-15T16:43:00.278Z"
  }
};
const EMBEDDED_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#2563eb\">\n  <meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n  <meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n  <title>Machining Point &bull; Cloud Attendance</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n  <link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220%22%3E<text y=%2226%22 font-size=%2226%22>⚡</text></svg>\">\n</head>\n<body>\n\n  <!-- Top Mobile Header -->\n  <header class=\"app-header\">\n    <div class=\"header-content\">\n      <div class=\"brand-info\">\n        <h1>Machining Point</h1>\n        <div class=\"live-pill\" id=\"livePill\">\n          <span class=\"pulse-dot\"></span>\n          <span id=\"liveStatusText\">Cloud Live</span>\n        </div>\n      </div>\n      <button class=\"sound-toggle-btn\" id=\"btnSoundToggle\" onclick=\"toggleSound()\" title=\"Toggle Sound\">\n        🔔 Sound ON\n      </button>\n    </div>\n  </header>\n\n  <!-- Main Container -->\n  <div class=\"app-container\">\n\n    <!-- Tab 1: Live Feed -->\n    <section class=\"tab-pane active\" id=\"pane-live\">\n      <div class=\"section-title-row\">\n        <h2>Live Punches</h2>\n        <span class=\"refresh-badge\" onclick=\"loadPunches()\">↻ Refresh</span>\n      </div>\n\n      <!-- Quick Metrics Ribbon -->\n      <div class=\"quick-metrics-grid\">\n        <div class=\"q-metric-card\" onclick=\"switchTab('daily')\">\n          <span class=\"q-num\" id=\"statPresent\">0</span>\n          <span class=\"q-label\">Present Today</span>\n        </div>\n        <div class=\"q-metric-card\" onclick=\"switchTab('daily')\">\n          <span class=\"q-num text-danger\" id=\"statLate\">0</span>\n          <span class=\"q-label\">Late Arrivals</span>\n        </div>\n        <div class=\"q-metric-card\" onclick=\"switchTab('daily')\">\n          <span class=\"q-num text-warning\" id=\"statEarlyOut\">0</span>\n          <span class=\"q-label\">Early Outs</span>\n        </div>\n        <div class=\"q-metric-card\">\n          <span class=\"q-num text-primary\" id=\"statHours\">0h</span>\n          <span class=\"q-label\">Total Hours</span>\n        </div>\n      </div>\n\n      <!-- Live Punch Feed -->\n      <div class=\"punch-stream\" id=\"punchStream\">\n        <div class=\"empty-state\" id=\"streamEmpty\">\n          <div class=\"empty-icon\">📱</div>\n          <p>Waiting for biometric punch from machine...</p>\n          <small>Make sure S-FB3K is connected to Wi-Fi</small>\n        </div>\n      </div>\n    </section>\n\n    <!-- Tab 2: Daily Attendance Summary -->\n    <section class=\"tab-pane\" id=\"pane-daily\">\n      <div class=\"section-title-row\">\n        <h2>Daily Attendance</h2>\n        <div class=\"date-picker-wrap\">\n          <input type=\"date\" id=\"dailyDateInput\" onchange=\"loadDailySummary()\">\n        </div>\n      </div>\n\n      <!-- Filter Buttons -->\n      <div class=\"filter-pills-row\">\n        <button class=\"pill-btn active\" data-filter=\"ALL\" onclick=\"setDailyFilter('ALL', this)\">All</button>\n        <button class=\"pill-btn\" data-filter=\"LATE\" onclick=\"setDailyFilter('LATE', this)\">Late In</button>\n        <button class=\"pill-btn\" data-filter=\"EARLY_OUT\" onclick=\"setDailyFilter('EARLY_OUT', this)\">Early Out</button>\n        <button class=\"pill-btn\" data-filter=\"MISSING\" onclick=\"setDailyFilter('MISSING', this)\">Single Punch</button>\n      </div>\n\n      <div class=\"daily-card-list\" id=\"dailyList\">\n        <div class=\"empty-state\">Loading attendance...</div>\n      </div>\n    </section>\n\n    <!-- Tab 3: Complete Punch Logs -->\n    <section class=\"tab-pane\" id=\"pane-punches\">\n      <div class=\"section-title-row\">\n        <h2>Punch Logs</h2>\n        <a href=\"/api/export-csv\" class=\"export-link\" download>📥 CSV</a>\n      </div>\n\n      <div class=\"search-box\">\n        <input type=\"text\" id=\"punchSearch\" placeholder=\"Search by name or ID...\" oninput=\"filterPunches()\">\n      </div>\n\n      <div class=\"punches-history-list\" id=\"punchesHistoryList\">\n        <div class=\"empty-state\">Loading punch records...</div>\n      </div>\n    </section>\n\n    <!-- Tab 4: Employee Directory -->\n    <section class=\"tab-pane\" id=\"pane-staff\">\n      <div class=\"section-title-row\">\n        <h2>Staff Directory</h2>\n        <button class=\"btn-add-staff\" onclick=\"openStaffModal()\">+ Add Staff</button>\n      </div>\n\n      <div class=\"staff-list\" id=\"staffList\">\n        <div class=\"empty-state\">Loading employee directory...</div>\n      </div>\n    </section>\n\n    <!-- Tab 5: Cloud Settings & Device Info -->\n    <section class=\"tab-pane\" id=\"pane-settings\">\n      <div class=\"section-title-row\">\n        <h2>Cloud Configuration</h2>\n      </div>\n\n      <div class=\"config-card\">\n        <h3>Biometric Machine Setup (S-FB3K)</h3>\n        <p class=\"config-desc\">On your machine keypad, go to <code>Menu → Comm → Cloud Server</code> and set:</p>\n        \n        <div class=\"param-row\">\n          <span class=\"param-name\">Server-Client Mode:</span>\n          <span class=\"param-val\">FkWeb (or WebSocket)</span>\n        </div>\n        <div class=\"param-row\">\n          <span class=\"param-name\">Web URL (FkWeb):</span>\n          <span class=\"param-val copyable\" id=\"dispFkWebUrl\" onclick=\"copyText(this)\">Loading...</span>\n        </div>\n        <div class=\"param-row\">\n          <span class=\"param-name\">Web URL (WebSocket):</span>\n          <span class=\"param-val copyable\" id=\"dispWsUrl\" onclick=\"copyText(this)\">Loading...</span>\n        </div>\n      </div>\n\n      <div class=\"config-card\">\n        <h3>TextBee SMS Gateway</h3>\n        <p class=\"config-desc\">Automated punch SMS alerts sent to employee mobile phones.</p>\n        <div class=\"param-row\">\n          <span class=\"param-name\">Gateway Status:</span>\n          <span class=\"param-val\" style=\"color:#10b981;\">✓ Connected</span>\n        </div>\n        <div class=\"param-row\">\n          <span class=\"param-name\">Device ID:</span>\n          <span class=\"param-val\">6ad0f12b...4fb932</span>\n        </div>\n      </div>\n\n      <div class=\"config-card danger-zone\">\n        <h3 style=\"color:#b91c1c;\">Reset Cloud Database</h3>\n        <p style=\"color:#7f1d1d;font-size:0.8rem;\">Clear all test punches from the cloud server and start fresh.</p>\n        <button class=\"btn-danger\" onclick=\"resetCloudData(false)\">🗑️ Clear All Punches</button>\n      </div>\n    </section>\n\n  </div>\n\n  <!-- Bottom App Navigation Bar -->\n  <nav class=\"bottom-nav\">\n    <button class=\"nav-item active\" onclick=\"switchTab('live')\">\n      <span class=\"nav-icon\">⚡</span>\n      <span class=\"nav-text\">Live</span>\n    </button>\n    <button class=\"nav-item\" onclick=\"switchTab('daily')\">\n      <span class=\"nav-icon\">📊</span>\n      <span class=\"nav-text\">Daily</span>\n    </button>\n    <button class=\"nav-item\" onclick=\"switchTab('punches')\">\n      <span class=\"nav-icon\">📋</span>\n      <span class=\"nav-text\">Logs</span>\n    </button>\n    <button class=\"nav-item\" onclick=\"switchTab('staff')\">\n      <span class=\"nav-icon\">👥</span>\n      <span class=\"nav-text\">Staff</span>\n    </button>\n    <button class=\"nav-item\" onclick=\"switchTab('settings')\">\n      <span class=\"nav-icon\">⚙️</span>\n      <span class=\"nav-text\">Config</span>\n    </button>\n  </nav>\n\n  <!-- Add / Edit Staff Modal -->\n  <div class=\"modal-overlay\" id=\"staffModal\" onclick=\"handleModalClick(event)\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <h3 id=\"staffModalTitle\">Add Staff Member</h3>\n        <button class=\"close-x\" onclick=\"closeStaffModal()\">&times;</button>\n      </div>\n      <form id=\"staffForm\" onsubmit=\"saveStaffSubmit(event)\">\n        <div class=\"form-field\">\n          <label>Machine User ID *</label>\n          <input type=\"text\" id=\"staffUserId\" placeholder=\"e.g. 1\" required>\n        </div>\n        <div class=\"form-field\">\n          <label>Full Name *</label>\n          <input type=\"text\" id=\"staffName\" placeholder=\"e.g. Rajesh Kumar\" required>\n        </div>\n        <div class=\"form-field\">\n          <label>Department</label>\n          <input type=\"text\" id=\"staffDept\" placeholder=\"e.g. Machining / General\">\n        </div>\n        <div class=\"form-field\">\n          <label>Mobile Number (For Punch SMS) 📱</label>\n          <div style=\"display:flex;gap:6px;\">\n            <input type=\"tel\" id=\"staffPhone\" placeholder=\"e.g. 9983699586\" style=\"flex:1;\">\n            <button type=\"button\" class=\"btn-mini\" onclick=\"testStaffSms()\">Test SMS</button>\n          </div>\n        </div>\n        <div class=\"form-row-2\">\n          <div class=\"form-field\">\n            <label>Check-IN</label>\n            <input type=\"time\" id=\"staffIn\" value=\"09:00\" required>\n          </div>\n          <div class=\"form-field\">\n            <label>Check-OUT</label>\n            <input type=\"time\" id=\"staffOut\" value=\"18:00\" required>\n          </div>\n        </div>\n        <div class=\"form-field\">\n          <label>Grace Margin (Minutes)</label>\n          <input type=\"number\" id=\"staffMargin\" value=\"30\" min=\"0\" max=\"180\">\n        </div>\n        <div class=\"modal-actions\">\n          <button type=\"button\" class=\"btn-cancel\" onclick=\"closeStaffModal()\">Cancel</button>\n          <button type=\"submit\" class=\"btn-save\">Save Employee</button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <script src=\"app.js\"></script>\n</body>\n</html>\n";
const EMBEDDED_CSS = ":root {\n  --primary: #2563eb;\n  --primary-dark: #1d4ed8;\n  --bg-main: #f8fafc;\n  --bg-card: #ffffff;\n  --text-main: #0f172a;\n  --text-muted: #64748b;\n  --border-color: #e2e8f0;\n  --success: #10b981;\n  --danger: #ef4444;\n  --warning: #f59e0b;\n  --font-sans: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;\n}\n\n* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  -webkit-tap-highlight-color: transparent;\n}\n\nbody {\n  font-family: var(--font-sans);\n  background-color: var(--bg-main);\n  color: var(--text-main);\n  padding-bottom: calc(75px + env(safe-area-inset-bottom));\n  -webkit-font-smoothing: antialiased;\n}\n\n/* App Header */\n.app-header {\n  position: sticky;\n  top: 0;\n  z-index: 100;\n  background-color: #ffffff;\n  border-bottom: 1px solid var(--border-color);\n  padding: 12px 16px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);\n}\n\n.header-content {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  max-width: 600px;\n  margin: 0 auto;\n}\n\n.brand-info h1 {\n  font-size: 1.15rem;\n  font-weight: 800;\n  color: var(--text-main);\n  letter-spacing: -0.3px;\n}\n\n.live-pill {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  font-size: 0.75rem;\n  font-weight: 600;\n  color: var(--success);\n  margin-top: 2px;\n}\n\n.pulse-dot {\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background-color: var(--success);\n  animation: pulse 1.5s infinite;\n}\n\n@keyframes pulse {\n  0% { transform: scale(0.95); opacity: 0.7; }\n  50% { transform: scale(1.3); opacity: 1; }\n  100% { transform: scale(0.95); opacity: 0.7; }\n}\n\n.sound-toggle-btn {\n  background: #f1f5f9;\n  border: 1px solid var(--border-color);\n  padding: 6px 12px;\n  border-radius: 20px;\n  font-size: 0.75rem;\n  font-weight: 600;\n  color: var(--text-main);\n  cursor: pointer;\n}\n\n/* App Container */\n.app-container {\n  max-width: 600px;\n  margin: 0 auto;\n  padding: 16px 14px;\n}\n\n/* Tab Panes */\n.tab-pane {\n  display: none;\n}\n.tab-pane.active {\n  display: block;\n}\n\n.section-title-row {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-bottom: 14px;\n}\n\n.section-title-row h2 {\n  font-size: 1.25rem;\n  font-weight: 800;\n  letter-spacing: -0.4px;\n}\n\n.refresh-badge {\n  font-size: 0.8rem;\n  font-weight: 600;\n  color: var(--primary);\n  background: #eff6ff;\n  padding: 4px 10px;\n  border-radius: 14px;\n  cursor: pointer;\n}\n\n/* Quick Metrics Grid */\n.quick-metrics-grid {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  gap: 8px;\n  margin-bottom: 18px;\n}\n\n.q-metric-card {\n  background: var(--bg-card);\n  border: 1px solid var(--border-color);\n  border-radius: 12px;\n  padding: 10px 6px;\n  text-align: center;\n  cursor: pointer;\n  transition: transform 0.1s ease;\n}\n.q-metric-card:active {\n  transform: scale(0.97);\n}\n\n.q-num {\n  display: block;\n  font-family: var(--font-mono);\n  font-weight: 800;\n  font-size: 1.25rem;\n  color: var(--text-main);\n}\n.q-num.text-danger { color: var(--danger); }\n.q-num.text-warning { color: var(--warning); }\n.q-num.text-primary { color: var(--primary); }\n\n.q-label {\n  font-size: 0.7rem;\n  font-weight: 600;\n  color: var(--text-muted);\n  white-space: nowrap;\n}\n\n/* Punch Stream Cards */\n.punch-stream {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.mobile-punch-card {\n  background: var(--bg-card);\n  border: 1px solid var(--border-color);\n  border-radius: 14px;\n  padding: 14px 16px;\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);\n  animation: slideIn 0.25s ease;\n}\n\n@keyframes slideIn {\n  from { opacity: 0; transform: translateY(-8px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n\n.punch-user-info {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n}\n\n.avatar-circle {\n  width: 44px;\n  height: 44px;\n  border-radius: 50%;\n  background: #eff6ff;\n  color: var(--primary);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-weight: 800;\n  font-size: 1rem;\n}\n\n.user-name-text {\n  font-weight: 700;\n  font-size: 0.95rem;\n  color: var(--text-main);\n}\n\n.user-sub-text {\n  font-size: 0.75rem;\n  color: var(--text-muted);\n  margin-top: 2px;\n}\n\n.punch-right-side {\n  text-align: right;\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n  gap: 4px;\n}\n\n.badge-in {\n  background: #ecfdf5;\n  color: #047857;\n  border: 1px solid #a7f3d0;\n  padding: 3px 8px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n  font-weight: 700;\n}\n.badge-out {\n  background: #fef2f2;\n  color: #b91c1c;\n  border: 1px solid #fca5a5;\n  padding: 3px 8px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n  font-weight: 700;\n}\n\n.punch-clock {\n  font-family: var(--font-mono);\n  font-weight: 700;\n  font-size: 1rem;\n  color: var(--text-main);\n}\n\n/* SMS Badges */\n.sms-tag {\n  display: inline-flex;\n  align-items: center;\n  gap: 3px;\n  font-size: 0.7rem;\n  font-weight: 600;\n  padding: 2px 6px;\n  border-radius: 4px;\n}\n.sms-sent { background: #ecfdf5; color: #047857; }\n.sms-failed { background: #fef2f2; color: #b91c1c; }\n.sms-pending { background: #eff6ff; color: #1d4ed8; }\n.sms-nophone { background: #f1f5f9; color: #64748b; }\n\n/* Filter Pills */\n.filter-pills-row {\n  display: flex;\n  gap: 8px;\n  overflow-x: auto;\n  padding-bottom: 8px;\n  margin-bottom: 12px;\n}\n\n.pill-btn {\n  background: #ffffff;\n  border: 1px solid var(--border-color);\n  padding: 6px 14px;\n  border-radius: 20px;\n  font-size: 0.8rem;\n  font-weight: 600;\n  color: var(--text-muted);\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pill-btn.active {\n  background: var(--primary);\n  color: #ffffff;\n  border-color: var(--primary);\n}\n\n/* Daily Cards */\n.daily-card-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.daily-card {\n  background: var(--bg-card);\n  border: 1px solid var(--border-color);\n  border-radius: 14px;\n  padding: 14px 16px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);\n}\n\n.daily-card-header {\n  display: flex;\n  justify-content: space-between;\n  align-items: flex-start;\n  margin-bottom: 10px;\n}\n\n.daily-emp-name {\n  font-weight: 700;\n  font-size: 1rem;\n}\n.daily-emp-sub {\n  font-size: 0.75rem;\n  color: var(--text-muted);\n}\n\n.daily-hours-pill {\n  background: #f1f5f9;\n  font-family: var(--font-mono);\n  font-weight: 700;\n  font-size: 0.85rem;\n  padding: 4px 8px;\n  border-radius: 6px;\n}\n\n.daily-grid-2 {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 8px;\n  background: #f8fafc;\n  padding: 8px 10px;\n  border-radius: 8px;\n  margin-bottom: 8px;\n}\n\n.time-slot label {\n  display: block;\n  font-size: 0.7rem;\n  color: var(--text-muted);\n}\n.time-slot strong {\n  font-family: var(--font-mono);\n  font-size: 0.95rem;\n}\n\n.daily-abn-tags {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.tag-badge {\n  font-size: 0.725rem;\n  font-weight: 700;\n  padding: 3px 8px;\n  border-radius: 6px;\n}\n.tag-late { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }\n.tag-early { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }\n.tag-ontime { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }\n\n/* Empty State */\n.empty-state {\n  text-align: center;\n  padding: 36px 16px;\n  color: var(--text-muted);\n}\n.empty-icon {\n  font-size: 2.5rem;\n  margin-bottom: 8px;\n}\n\n/* Config Cards */\n.config-card {\n  background: #ffffff;\n  border: 1px solid var(--border-color);\n  border-radius: 12px;\n  padding: 16px;\n  margin-bottom: 14px;\n}\n.config-card h3 {\n  font-size: 1rem;\n  font-weight: 700;\n  margin-bottom: 6px;\n}\n.config-desc {\n  font-size: 0.8rem;\n  color: var(--text-muted);\n  margin-bottom: 12px;\n}\n\n.param-row {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  padding: 8px 0;\n  border-bottom: 1px solid #f1f5f9;\n  font-size: 0.85rem;\n}\n.param-name {\n  color: var(--text-muted);\n}\n.param-val {\n  font-family: var(--font-mono);\n  font-weight: 700;\n  color: var(--primary);\n}\n.param-val.copyable {\n  background: #eff6ff;\n  padding: 3px 8px;\n  border-radius: 4px;\n  cursor: pointer;\n}\n\n.danger-zone {\n  border-color: #fca5a5;\n  background: #fff5f5;\n}\n.btn-danger {\n  background: #ef4444;\n  color: white;\n  border: none;\n  padding: 10px 16px;\n  border-radius: 8px;\n  font-weight: 700;\n  width: 100%;\n  margin-top: 10px;\n  cursor: pointer;\n}\n\n/* Bottom Navigation */\n.bottom-nav {\n  position: fixed;\n  bottom: 0;\n  left: 0;\n  right: 0;\n  height: 64px;\n  background: #ffffff;\n  border-top: 1px solid var(--border-color);\n  display: flex;\n  justify-content: space-around;\n  align-items: center;\n  z-index: 1000;\n  padding-bottom: env(safe-area-inset-bottom);\n}\n\n.nav-item {\n  background: none;\n  border: none;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 3px;\n  color: var(--text-muted);\n  cursor: pointer;\n  width: 20%;\n}\n.nav-item.active {\n  color: var(--primary);\n}\n.nav-icon {\n  font-size: 1.25rem;\n}\n.nav-text {\n  font-size: 0.7rem;\n  font-weight: 700;\n}\n\n/* Staff Modal */\n.modal-overlay {\n  display: none;\n  position: fixed;\n  inset: 0;\n  background: rgba(0, 0, 0, 0.5);\n  z-index: 2000;\n  align-items: center;\n  justify-content: center;\n  padding: 16px;\n}\n.modal-overlay.open {\n  display: flex;\n}\n\n.modal-card {\n  background: #ffffff;\n  border-radius: 16px;\n  width: 100%;\n  max-width: 450px;\n  padding: 20px;\n  max-height: 90vh;\n  overflow-y: auto;\n}\n\n.modal-header {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-bottom: 16px;\n}\n.close-x {\n  background: none;\n  border: none;\n  font-size: 1.5rem;\n  color: var(--text-muted);\n  cursor: pointer;\n}\n\n.form-field {\n  margin-bottom: 12px;\n}\n.form-field label {\n  display: block;\n  font-size: 0.8rem;\n  font-weight: 700;\n  color: var(--text-main);\n  margin-bottom: 4px;\n}\n.form-field input {\n  width: 100%;\n  padding: 10px 12px;\n  border: 1px solid var(--border-color);\n  border-radius: 8px;\n  font-size: 1rem;\n}\n\n.form-row-2 {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 10px;\n}\n\n.modal-actions {\n  display: flex;\n  gap: 10px;\n  margin-top: 16px;\n}\n.btn-save {\n  flex: 1;\n  background: var(--primary);\n  color: white;\n  border: none;\n  padding: 12px;\n  border-radius: 8px;\n  font-weight: 700;\n  cursor: pointer;\n}\n.btn-cancel {\n  background: #f1f5f9;\n  border: none;\n  padding: 12px 16px;\n  border-radius: 8px;\n  font-weight: 600;\n  color: var(--text-muted);\n  cursor: pointer;\n}\n.btn-mini {\n  background: #eff6ff;\n  border: 1px solid #bfdbfe;\n  color: var(--primary);\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 0.75rem;\n  font-weight: 700;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.btn-add-staff {\n  background: var(--primary);\n  color: white;\n  border: none;\n  padding: 6px 14px;\n  border-radius: 20px;\n  font-size: 0.8rem;\n  font-weight: 700;\n  cursor: pointer;\n}\n\n.btn-resend-mini {\n  background: #ffffff;\n  border: 1px solid var(--border-color);\n  padding: 3px 8px;\n  border-radius: 4px;\n  font-size: 0.7rem;\n  font-weight: 600;\n  cursor: pointer;\n  color: var(--text-main);\n}\n.btn-resend-mini:hover {\n  background: var(--primary);\n  color: white;\n}\n";
const EMBEDDED_JS = "/**\n * Mobile Cloud Attendance App\n * Optimized for smartphones and tablets\n */\n\nlet allPunches = [];\nlet dailyRecords = [];\nlet employeesList = [];\nlet activeDailyFilter = 'ALL';\nlet soundEnabled = true;\nlet lastSeenKey = '';\n\nconst todayStr = new Date().toISOString().split('T')[0];\nconst dailyDateInput = document.getElementById('dailyDateInput');\ndailyDateInput.value = todayStr;\n\n// Initialize Web Audio Chime\nlet audioCtx = null;\nfunction playPunchChime() {\n  if (!soundEnabled) return;\n  try {\n    if (!audioCtx) {\n      audioCtx = new (window.AudioContext || window.webkitAudioContext)();\n    }\n    if (audioCtx.state === 'suspended') {\n      audioCtx.resume();\n    }\n    const osc = audioCtx.createOscillator();\n    const gain = audioCtx.createGain();\n    osc.type = 'sine';\n    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5\n    osc.frequency.exponentialRampToValueAtTime(880.0, audioCtx.currentTime + 0.15); // A5\n    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);\n    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);\n    osc.connect(gain);\n    gain.connect(audioCtx.destination);\n    osc.start();\n    osc.stop(audioCtx.currentTime + 0.35);\n  } catch (e) {}\n}\n\nfunction toggleSound() {\n  soundEnabled = !soundEnabled;\n  const btn = document.getElementById('btnSoundToggle');\n  btn.textContent = soundEnabled ? '🔔 Sound ON' : '🔕 Sound OFF';\n  if (soundEnabled && !audioCtx) {\n    audioCtx = new (window.AudioContext || window.webkitAudioContext)();\n  }\n}\n\n// Bottom Tab Navigation\nfunction switchTab(tabId) {\n  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));\n  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));\n\n  const targetPane = document.getElementById(`pane-${tabId}`);\n  if (targetPane) targetPane.classList.add('active');\n\n  const navMap = { live: 0, daily: 1, punches: 2, staff: 3, settings: 4 };\n  const navBtns = document.querySelectorAll('.nav-item');\n  if (navBtns[navMap[tabId]]) {\n    navBtns[navMap[tabId]].classList.add('active');\n  }\n\n  if (tabId === 'daily') loadDailySummary();\n  if (tabId === 'punches') loadPunches();\n  if (tabId === 'staff') loadStaff();\n}\n\n// Helpers\nfunction escapeHtml(s) {\n  if (!s) return '';\n  return String(s).replace(/&/g, '&amp;').replace(/\"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n}\n\nfunction getSmsBadge(punch) {\n  const status = (punch.sms_status || '').toUpperCase();\n  const tip = punch.sms_details ? ` title=\"${escapeHtml(punch.sms_details)}\"` : '';\n  if (status === 'SENT') return `<span class=\"sms-tag sms-sent\"${tip}>✓ SMS Sent</span>`;\n  if (status === 'FAILED') return `<span class=\"sms-tag sms-failed\"${tip}>✕ SMS Failed</span>`;\n  if (status === 'PENDING') return `<span class=\"sms-tag sms-pending\"${tip}>⏳ Sending...</span>`;\n  if (status === 'NO_PHONE') return `<span class=\"sms-tag sms-nophone\">📵 No Phone</span>`;\n  return `<span class=\"sms-tag sms-nophone\">--</span>`;\n}\n\n// Render Live Punch Card\nfunction addLiveCard(punch, prepend = true) {\n  const stream = document.getElementById('punchStream');\n  const empty = document.getElementById('streamEmpty');\n  if (empty) empty.style.display = 'none';\n\n  const isCheckIn = punch.punch_type === 'Check-In';\n  const initials = (punch.user_name || 'U').split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase();\n\n  const card = document.createElement('div');\n  card.className = 'mobile-punch-card';\n  card.dataset.punchId = punch.id || '';\n\n  card.innerHTML = `\n    <div class=\"punch-user-info\">\n      <div class=\"avatar-circle\">${initials}</div>\n      <div>\n        <div class=\"user-name-text\">${escapeHtml(punch.user_name || 'Staff')}</div>\n        <div class=\"user-sub-text\">ID: #${punch.user_id} &bull; ${punch.device_id || 'S-FB3K'}</div>\n      </div>\n    </div>\n    <div class=\"punch-right-side\">\n      <div style=\"display:flex;align-items:center;gap:6px;\">\n        <span class=\"${isCheckIn ? 'badge-in' : 'badge-out'}\">${punch.punch_type}</span>\n        ${getSmsBadge(punch)}\n      </div>\n      <span class=\"punch-clock\">${punch.punch_hour || (punch.punch_time ? punch.punch_time.split(' ')[1] : '')}</span>\n    </div>\n  `;\n\n  if (prepend && stream.firstChild) {\n    stream.insertBefore(card, stream.firstChild);\n  } else {\n    stream.appendChild(card);\n  }\n}\n\n// Fetch All Punches\nasync function loadPunches() {\n  try {\n    const res = await fetch('/api/punches?limit=150');\n    allPunches = await res.json();\n\n    const stream = document.getElementById('punchStream');\n    stream.innerHTML = '';\n    if (allPunches.length === 0) {\n      stream.innerHTML = `\n        <div class=\"empty-state\" id=\"streamEmpty\">\n          <div class=\"empty-icon\">📱</div>\n          <p>No punches recorded yet.</p>\n          <small>Waiting for punches from biometric machine</small>\n        </div>\n      `;\n    } else {\n      allPunches.slice(0, 20).forEach((p) => addLiveCard(p, false));\n    }\n\n    renderPunchesHistory(allPunches);\n  } catch (e) {\n    console.error('Failed to load punches:', e);\n  }\n}\n\n// Render History Tab\nfunction renderPunchesHistory(list) {\n  const container = document.getElementById('punchesHistoryList');\n  if (list.length === 0) {\n    container.innerHTML = `<div class=\"empty-state\"><p>No logs found.</p></div>`;\n    return;\n  }\n\n  container.innerHTML = list\n    .map(\n      (p) => `\n    <div class=\"mobile-punch-card\" style=\"margin-bottom:8px;\">\n      <div>\n        <div style=\"font-weight:700;font-size:0.95rem;\">${escapeHtml(p.user_name || '--')}</div>\n        <div style=\"font-size:0.75rem;color:var(--text-muted);margin-top:2px;\">\n          #${p.user_id} &bull; ${p.punch_time}\n        </div>\n      </div>\n      <div class=\"punch-right-side\">\n        <div style=\"display:flex;gap:4px;align-items:center;\">\n          <span class=\"${p.punch_type === 'Check-In' ? 'badge-in' : 'badge-out'}\">${p.punch_type}</span>\n          ${getSmsBadge(p)}\n        </div>\n        ${\n          p.sms_status !== 'SENT' && p.id\n            ? `<button class=\"btn-resend-mini\" onclick=\"resendPunchSms(${p.id}, this)\">↻ Resend SMS</button>`\n            : ''\n        }\n      </div>\n    </div>\n  `\n    )\n    .join('');\n}\n\nfunction filterPunches() {\n  const q = document.getElementById('punchSearch').value.toLowerCase().trim();\n  const filtered = allPunches.filter(\n    (p) => p.user_id.toLowerCase().includes(q) || (p.user_name && p.user_name.toLowerCase().includes(q))\n  );\n  renderPunchesHistory(filtered);\n}\n\n// Fetch Daily Summary\nasync function loadDailySummary() {\n  const dateVal = dailyDateInput.value || todayStr;\n  try {\n    const res = await fetch(`/api/daily-summary?date=${dateVal}`);\n    const data = await res.json();\n    dailyRecords = data.records || [];\n    const metrics = data.metrics || {};\n\n    document.getElementById('statPresent').textContent = metrics.total_present || 0;\n    document.getElementById('statLate').textContent = metrics.late_in || 0;\n    document.getElementById('statEarlyOut').textContent = metrics.early_out || 0;\n    document.getElementById('statHours').textContent = `${metrics.total_work_hours || 0}h`;\n\n    renderDailyList();\n  } catch (e) {\n    console.error('Failed to load daily summary:', e);\n  }\n}\n\nfunction setDailyFilter(type, btn) {\n  activeDailyFilter = type;\n  document.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));\n  if (btn) btn.classList.add('active');\n  renderDailyList();\n}\n\nfunction renderDailyList() {\n  const container = document.getElementById('dailyList');\n  let filtered = dailyRecords;\n\n  if (activeDailyFilter === 'LATE') {\n    filtered = dailyRecords.filter((r) => r.arrival_status === 'LATE');\n  } else if (activeDailyFilter === 'EARLY_OUT') {\n    filtered = dailyRecords.filter((r) => r.departure_status === 'EARLY');\n  } else if (activeDailyFilter === 'MISSING') {\n    filtered = dailyRecords.filter((r) => r.departure_status === 'MISSING');\n  }\n\n  if (filtered.length === 0) {\n    container.innerHTML = `<div class=\"empty-state\"><p>No attendance records match filter.</p></div>`;\n    return;\n  }\n\n  container.innerHTML = filtered\n    .map(\n      (r) => `\n    <div class=\"daily-card\">\n      <div class=\"daily-card-header\">\n        <div>\n          <div class=\"daily-emp-name\">${escapeHtml(r.user_name)}</div>\n          <div class=\"daily-emp-sub\">ID: #${r.user_id} &bull; ${escapeHtml(r.department)} &bull; Shift: ${r.standard_in}-${r.standard_out}</div>\n        </div>\n        <span class=\"daily-hours-pill\">${r.work_duration}</span>\n      </div>\n\n      <div class=\"daily-grid-2\">\n        <div class=\"time-slot\">\n          <label>First IN (Arrival)</label>\n          <strong>${r.first_in || '--'}</strong>\n        </div>\n        <div class=\"time-slot\">\n          <label>Last OUT (Departure)</label>\n          <strong>${r.last_out || '--'}</strong>\n        </div>\n      </div>\n\n      <div class=\"daily-abn-tags\">\n        ${\n          r.arrival_status === 'LATE'\n            ? `<span class=\"tag-badge tag-late\">⚠️ ${r.arrival_badge}</span>`\n            : r.arrival_status === 'EARLY'\n            ? `<span class=\"tag-badge tag-early\">🕒 ${r.arrival_badge}</span>`\n            : `<span class=\"tag-badge tag-ontime\">✓ On Time Arrival</span>`\n        }\n        ${\n          r.departure_status === 'EARLY'\n            ? `<span class=\"tag-badge tag-early\">🚪 Early Departure</span>`\n            : r.departure_status === 'MISSING'\n            ? `<span class=\"tag-badge tag-late\">⚠️ Missing Check-Out</span>`\n            : ''\n        }\n      </div>\n    </div>\n  `\n    )\n    .join('');\n}\n\n// Staff Directory\nasync function loadStaff() {\n  try {\n    const res = await fetch('/api/employees');\n    employeesList = await res.json();\n    const container = document.getElementById('staffList');\n\n    if (employeesList.length === 0) {\n      container.innerHTML = `<div class=\"empty-state\"><p>No staff registered.</p></div>`;\n      return;\n    }\n\n    container.innerHTML = employeesList\n      .map(\n        (e) => `\n      <div class=\"mobile-punch-card\" style=\"margin-bottom:8px;\">\n        <div>\n          <div style=\"font-weight:700;font-size:0.95rem;\">${escapeHtml(e.name)}</div>\n          <div style=\"font-size:0.75rem;color:var(--text-muted);margin-top:2px;\">\n            ID: #${e.user_id} &bull; ${escapeHtml(e.phone || 'No Phone')}\n          </div>\n          <div style=\"font-size:0.75rem;color:var(--primary);margin-top:2px;\">\n            Shift: ${e.standard_in || '09:00'} - ${e.standard_out || '18:00'} (±${e.margin_minutes || 30}m)\n          </div>\n        </div>\n        <button class=\"btn-mini\" onclick=\"editStaff('${e.user_id}')\">Edit</button>\n      </div>\n    `\n      )\n      .join('');\n  } catch (e) {\n    console.error('Failed to load staff:', e);\n  }\n}\n\n// Staff Modal\nfunction openStaffModal() {\n  document.getElementById('staffModalTitle').textContent = 'Add Staff Member';\n  document.getElementById('staffUserId').value = '';\n  document.getElementById('staffUserId').readOnly = false;\n  document.getElementById('staffName').value = '';\n  document.getElementById('staffDept').value = 'General';\n  document.getElementById('staffPhone').value = '';\n  document.getElementById('staffIn').value = '09:00';\n  document.getElementById('staffOut').value = '18:00';\n  document.getElementById('staffMargin').value = '30';\n  document.getElementById('staffModal').classList.add('open');\n}\n\nfunction editStaff(uid) {\n  const e = employeesList.find((x) => String(x.user_id) === String(uid));\n  if (!e) return;\n  document.getElementById('staffModalTitle').textContent = `Edit Staff #${e.user_id}`;\n  document.getElementById('staffUserId').value = e.user_id;\n  document.getElementById('staffUserId').readOnly = true;\n  document.getElementById('staffName').value = e.name || '';\n  document.getElementById('staffDept').value = e.department || 'General';\n  document.getElementById('staffPhone').value = e.phone || '';\n  document.getElementById('staffIn').value = e.standard_in || '09:00';\n  document.getElementById('staffOut').value = e.standard_out || '18:00';\n  document.getElementById('staffMargin').value = e.margin_minutes !== undefined ? e.margin_minutes : 30;\n  document.getElementById('staffModal').classList.add('open');\n}\n\nfunction closeStaffModal() {\n  document.getElementById('staffModal').classList.remove('open');\n}\n\nfunction handleModalClick(e) {\n  if (e.target.id === 'staffModal') closeStaffModal();\n}\n\nasync function saveStaffSubmit(e) {\n  e.preventDefault();\n  const user_id = document.getElementById('staffUserId').value.trim();\n  const name = document.getElementById('staffName').value.trim();\n  const department = document.getElementById('staffDept').value.trim();\n  const phone = document.getElementById('staffPhone').value.trim();\n  const standard_in = document.getElementById('staffIn').value.trim();\n  const standard_out = document.getElementById('staffOut').value.trim();\n  const margin_minutes = parseInt(document.getElementById('staffMargin').value, 10) || 30;\n\n  try {\n    const res = await fetch('/api/employees', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ user_id, name, department, phone, standard_in, standard_out, margin_minutes })\n    });\n    const data = await res.json();\n    if (data.success) {\n      closeStaffModal();\n      await loadStaff();\n      await loadDailySummary();\n      alert('✓ Staff member saved successfully!');\n    }\n  } catch (err) {\n    alert('Error saving staff: ' + err.message);\n  }\n}\n\nasync function testStaffSms() {\n  const phone = document.getElementById('staffPhone').value.trim();\n  const name = document.getElementById('staffName').value.trim();\n  if (!phone) {\n    alert('Please enter a mobile phone number first.');\n    return;\n  }\n  try {\n    const res = await fetch('/api/test-sms', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ phone, name })\n    });\n    const data = await res.json();\n    if (data.success) {\n      alert(`✓ Test SMS sent via TextBee to ${data.recipient}! Check mobile phone.`);\n    } else {\n      alert('SMS Failed: ' + data.error);\n    }\n  } catch (err) {\n    alert('Network error: ' + err.message);\n  }\n}\n\n// Resend SMS\nasync function resendPunchSms(punchId, btn) {\n  if (!punchId) return;\n  if (btn) {\n    btn.disabled = true;\n    btn.textContent = '⏳ Sending...';\n  }\n  try {\n    const res = await fetch('/api/retry-sms', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ punch_id: punchId })\n    });\n    const data = await res.json();\n    if (data.success) {\n      if (btn) btn.textContent = '✓ Sent';\n      setTimeout(() => loadPunches(), 1500);\n    } else {\n      alert('SMS Failed: ' + data.error);\n      if (btn) {\n        btn.disabled = false;\n        btn.textContent = '↻ Retry';\n      }\n    }\n  } catch (err) {\n    alert('Error: ' + err.message);\n    if (btn) {\n      btn.disabled = false;\n      btn.textContent = '↻ Retry';\n    }\n  }\n}\n\n// Copy Text Helper\nfunction copyText(elem) {\n  navigator.clipboard.writeText(elem.textContent.trim());\n  const orig = elem.textContent;\n  elem.textContent = '✓ Copied!';\n  setTimeout(() => (elem.textContent = orig), 1500);\n}\n\n// Reset Cloud Data\nasync function resetCloudData() {\n  if (!confirm('⚠️ Are you sure you want to clear all punches from the cloud server? Staff names will be kept.')) return;\n  try {\n    const res = await fetch('/api/reset-data', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ clear_employees: false })\n    });\n    const data = await res.json();\n    if (data.success) {\n      alert('✓ Cloud database cleared!');\n      await loadPunches();\n      await loadDailySummary();\n    }\n  } catch (e) {\n    alert('Error: ' + e.message);\n  }\n}\n\n// Connect SSE\nfunction connectSSE() {\n  const evtSource = new EventSource('/api/events');\n\n  evtSource.addEventListener('punch', (e) => {\n    try {\n      const punch = JSON.parse(e.data);\n      const key = `${punch.user_id}_${punch.punch_time}`;\n      if (key !== lastSeenKey) {\n        lastSeenKey = key;\n        playPunchChime();\n        addLiveCard(punch, true);\n        loadDailySummary();\n      }\n    } catch (err) {}\n  });\n\n  evtSource.addEventListener('sms_status', (e) => {\n    try {\n      const data = JSON.parse(e.data);\n      const card = document.querySelector(`.mobile-punch-card[data-punch-id=\"${data.id}\"]`);\n      if (card) {\n        const badge = card.querySelector('.sms-tag');\n        if (badge) {\n          const temp = document.createElement('div');\n          temp.innerHTML = getSmsBadge(data);\n          badge.replaceWith(temp.firstChild);\n        }\n      }\n    } catch (err) {}\n  });\n\n  evtSource.onerror = () => {\n    try { evtSource.close(); } catch (e) {}\n    setTimeout(connectSSE, 3000);\n  };\n}\n\n// Update config URLs on page load\nfunction updateConfigUrls() {\n  const host = window.location.host;\n  const isHttps = window.location.protocol === 'https:';\n  const fkUrl = `http://${host}/ebkn`;\n  const wsUrl = `${isHttps ? 'wss' : 'ws'}://${host}/`;\n\n  const dispFk = document.getElementById('dispFkWebUrl');\n  if (dispFk) dispFk.textContent = fkUrl;\n  const dispWs = document.getElementById('dispWsUrl');\n  if (dispWs) dispWs.textContent = wsUrl;\n}\n\n// Init\nupdateConfigUrls();\nloadPunches();\nloadDailySummary();\nconnectSSE();\nsetInterval(loadDailySummary, 15000);\n";

// Auto-seed files on startup if missing
try {
  if (!fs.existsSync(EMPLOYEES_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(SEED_EMPLOYEES, null, 2), 'utf8');
  }
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
  const idxPath = path.join(PUBLIC_DIR, 'index.html');
  const cssPath = path.join(PUBLIC_DIR, 'style.css');
  const jsPath = path.join(PUBLIC_DIR, 'app.js');
  if (!fs.existsSync(idxPath)) fs.writeFileSync(idxPath, EMBEDDED_HTML, 'utf8');
  if (!fs.existsSync(cssPath)) fs.writeFileSync(cssPath, EMBEDDED_CSS, 'utf8');
  if (!fs.existsSync(jsPath)) fs.writeFileSync(jsPath, EMBEDDED_JS, 'utf8');
} catch (e) {
  console.warn('[SEED] Note on asset seeding:', e.message);
}

loadEmployees();

// SQLite Database Setup
let db = null;
let inMemoryPunches = [];
let highestKnownPunchId = 0;

if (DatabaseSync) {
  try {
    db = new DatabaseSync(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        raw_user_id TEXT,
        user_name TEXT,
        punch_time TEXT NOT NULL,
        punch_date TEXT NOT NULL,
        punch_hour TEXT NOT NULL,
        io_mode INTEGER,
        punch_type TEXT,
        verify_mode INTEGER,
        device_id TEXT,
        protocol TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL,
        sms_status TEXT DEFAULT 'PENDING',
        sms_time TEXT,
        sms_details TEXT,
        UNIQUE(user_id, punch_time)
      );

      CREATE TABLE IF NOT EXISTS devices (
        dev_id TEXT PRIMARY KEY,
        fk_name TEXT,
        firmware TEXT,
        ip_address TEXT,
        last_seen TEXT NOT NULL,
        status TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_punches_date ON punches(punch_date);
      CREATE INDEX IF NOT EXISTS idx_punches_user ON punches(user_id);
    `);

    // Migrations
    try { db.exec(`ALTER TABLE punches ADD COLUMN sms_status TEXT DEFAULT 'PENDING';`); } catch (e) {}
    try { db.exec(`ALTER TABLE punches ADD COLUMN sms_time TEXT;`); } catch (e) {}
    try { db.exec(`ALTER TABLE punches ADD COLUMN sms_details TEXT;`); } catch (e) {}

    const maxRow = db.prepare('SELECT MAX(id) as max_id FROM punches').get();
    if (maxRow && maxRow.max_id) highestKnownPunchId = Number(maxRow.max_id);

    console.log('[DB] SQLite initialized at', DB_FILE);
  } catch (err) {
    console.warn('[DB] SQLite init fallback:', err.message);
  }
}

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(100);

// Helper: Normalize User ID
function normalizeUserId(raw) {
  if (raw == null) return '0';
  const s = String(raw).trim();
  const n = parseInt(s, 10);
  return isNaN(n) ? s : String(n);
}

// Helper: Format Phone Number
function formatPhoneNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '+91' + digits.substring(1);
  return '+' + digits;
}

// Helper: Parse Date & Time
function parsePunchTime(str) {
  if (!str) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return { date: d, hour: t, full: `${d} ${t}` };
  }

  // Format: YYYYMMDDHHMMSS (14 digits)
  const clean = String(str).replace(/\D/g, '');
  if (clean.length === 14) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    const H = clean.substring(8, 10);
    const M = clean.substring(10, 12);
    const S = clean.substring(12, 14);
    return { date: `${y}-${m}-${d}`, hour: `${H}:${M}:${S}`, full: `${y}-${m}-${d} ${H}:${M}:${S}` };
  }

  // Format: YYYY-MM-DD HH:MM:SS
  const parts = String(str).trim().split(' ');
  if (parts.length === 2) {
    return { date: parts[0], hour: parts[1], full: `${parts[0]} ${parts[1]}` };
  }

  return { date: 'UNKNOWN', hour: 'UNKNOWN', full: str };
}

// In-memory set to prevent SMS spam for duplicates
const sentSmsPunches = new Set();

// Helper: Update SMS status in DB and broadcast via SSE
function updatePunchSmsStatus(punchId, status, smsTime = null, details = '') {
  if (!punchId) return;
  const timeVal = smsTime || (status === 'SENT' ? new Date().toISOString() : null);
  if (db) {
    try {
      db.prepare(`
        UPDATE punches 
        SET sms_status = ?, sms_time = ?, sms_details = ? 
        WHERE id = ?
      `).run(status, timeVal, details, punchId);
    } catch (e) {}
  }
  eventEmitter.emit('punch_sms_updated', {
    id: punchId,
    sms_status: status,
    sms_time: timeVal,
    sms_details: details
  });
}

// Send Instant SMS via TextBee API (with missed punch bundling)
async function sendPunchSms({ punchId, userId, userName, punchType, punchDate, punchHour, phone }) {
  const smsCfg = config.sms || {};
  if (smsCfg.enabled === false) {
    updatePunchSmsStatus(punchId, 'SKIPPED', null, 'SMS alerts disabled in config');
    return;
  }

  const apiKey = smsCfg.apiKey;
  const deviceId = smsCfg.deviceId;
  const recipient = formatPhoneNumber(phone);

  if (!recipient) {
    updatePunchSmsStatus(punchId, 'NO_PHONE', null, 'No mobile number configured');
    return;
  }

  // Detect earlier missed punches today for this user
  let missedPunches = [];
  let isMorningCheckInMissing = false;
  if (db) {
    try {
      missedPunches = db.prepare(`
        SELECT id, punch_type, punch_date, punch_hour, punch_time, sms_status
        FROM punches
        WHERE user_id = ?
          AND punch_date = ?
          AND id != ?
          AND (sms_status = 'FAILED' OR sms_status = 'PENDING' OR sms_status IS NULL)
        ORDER BY punch_time ASC
      `).all(userId, punchDate, punchId || 0);

      if (punchType === 'Check-Out') {
        const hasCheckIn = db.prepare(`
          SELECT id FROM punches 
          WHERE user_id = ? AND punch_date = ? AND punch_type = 'Check-In'
        `).get(userId, punchDate);
        if (!hasCheckIn) {
          isMorningCheckInMissing = true;
        }
      }
    } catch (err) {}
  }

  const company = config.companyName || 'Machining Point';
  let message = `Dear ${userName}, attendance [${punchType}] recorded on ${punchDate} at ${punchHour}.`;

  if (missedPunches.length > 0) {
    const listStr = missedPunches.map((m) => `${m.punch_type} at ${m.punch_hour}`).join(', ');
    message += ` (Includes missed alert: ${listStr}).`;
  } else if (isMorningCheckInMissing) {
    message += ` (Note: Morning Check-In was not recorded).`;
  }

  message += ` - ${company}`;

  const payload = JSON.stringify({
    recipients: [recipient],
    message: message
  });

  const url = `https://api.textbee.dev/api/v1/gateway/devices/${deviceId}/send-sms`;
  console.log(`[SMS QUEUE] Sending ${punchType} alert to ${recipient} (${userName})...`);
  updatePunchSmsStatus(punchId, 'PENDING', null, `Sending to ${recipient}...`);

  try {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        let respData = '';
        res.on('data', (c) => (respData += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[SMS SUCCESS] SMS dispatched to ${recipient}!`);
            const nowIso = new Date().toISOString();
            let batchId = '';
            try {
              const parsed = JSON.parse(respData);
              batchId = parsed?.data?.smsBatchId || '';
            } catch (e) {}

            const details = `Sent to ${recipient}${batchId ? ` (Batch: ${batchId})` : ''}`;
            updatePunchSmsStatus(punchId, 'SENT', nowIso, details);

            if (missedPunches.length > 0) {
              for (const mp of missedPunches) {
                updatePunchSmsStatus(mp.id, 'SENT', nowIso, `Delivered with ${punchType} at ${punchHour}`);
              }
            }
          } else {
            console.error(`[SMS FAILED] Status ${res.statusCode}:`, respData);
            let errMsg = `Gateway Error (${res.statusCode})`;
            try {
              const errObj = JSON.parse(respData);
              if (errObj.message) errMsg = errObj.message;
            } catch (e) {}
            updatePunchSmsStatus(punchId, 'FAILED', null, errMsg);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error('[SMS ERROR]', err.message);
      updatePunchSmsStatus(punchId, 'FAILED', null, err.message);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    updatePunchSmsStatus(punchId, 'FAILED', null, err.message);
  }
}

// Record Punch Record
function recordPunch({ rawUserId, ioTime, ioMode, verifyMode, deviceId, protocol, rawPayload = '' }) {
  const userId = normalizeUserId(rawUserId);
  const { date, hour, full } = parsePunchTime(ioTime);
  const emp = employeesMap.get(userId) || {};
  const userName = emp.name || `User #${userId}`;

  // Smart Check-In vs Check-Out determination
  let punchType = 'Check-In';
  if (ioMode === 0 || ioMode === 1) {
    punchType = ioMode === 0 ? 'Check-Out' : 'Check-In';
  } else if (db) {
    try {
      const prior = db.prepare('SELECT COUNT(*) as cnt FROM punches WHERE user_id = ? AND punch_date = ?').get(userId, date);
      punchType = prior && prior.cnt % 2 === 1 ? 'Check-Out' : 'Check-In';
    } catch (e) {}
  }

  const punchRecord = {
    user_id: userId,
    raw_user_id: String(rawUserId),
    user_name: userName,
    punch_time: full,
    punch_date: date,
    punch_hour: hour,
    io_mode: Number(ioMode) || 0,
    punch_type: punchType,
    verify_mode: Number(verifyMode) || 1,
    device_id: String(deviceId || 'S-FB3K'),
    protocol,
    sms_status: emp.phone ? 'PENDING' : 'NO_PHONE',
    sms_time: null,
    sms_details: emp.phone ? '' : 'No mobile number configured',
    created_at: new Date().toISOString()
  };

  if (db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO punches (
          user_id, raw_user_id, user_name, punch_time, punch_date, punch_hour,
          io_mode, punch_type, verify_mode, device_id, protocol, raw_payload, created_at,
          sms_status, sms_time, sms_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, punch_time) DO UPDATE SET
          punch_type = excluded.punch_type,
          user_name = COALESCE(excluded.user_name, punches.user_name)
      `);
      const runRes = stmt.run(
        punchRecord.user_id,
        punchRecord.raw_user_id,
        punchRecord.user_name,
        punchRecord.punch_time,
        punchRecord.punch_date,
        punchRecord.punch_hour,
        punchRecord.io_mode,
        punchRecord.punch_type,
        punchRecord.verify_mode,
        punchRecord.device_id,
        punchRecord.protocol,
        rawPayload,
        punchRecord.created_at,
        punchRecord.sms_status,
        punchRecord.sms_time,
        punchRecord.sms_details
      );
      if (runRes && runRes.lastInsertRowid) {
        punchRecord.id = Number(runRes.lastInsertRowid);
      }
    } catch (err) {
      console.error('[DB INSERT ERR]', err.message);
    }
  } else {
    punchRecord.id = Date.now();
    inMemoryPunches.push(punchRecord);
  }

  // Append to CSV
  const csvLine = `"${punchRecord.id || Date.now()}","${date}","${hour}","${userId}","${userName.replace(/"/g, '""')}","${punchType}","${punchRecord.io_mode}","${verifyMode}","${deviceId}","${protocol}"\n`;
  fs.appendFileSync(CSV_FILE, csvLine, 'utf8');

  console.log(`[PUNCH RECEIVED] #${userId} (${userName}) at ${full} [${punchType}] via ${protocol}`);

  // Broadcast to Live Dashboard via SSE
  eventEmitter.emit('punch', punchRecord);

  // Trigger Instant SMS
  const punchKey = `${userId}_${date}_${hour}`;
  if (!sentSmsPunches.has(punchKey)) {
    sentSmsPunches.add(punchKey);
    if (emp.phone) {
      sendPunchSms({
        punchId: punchRecord.id,
        userId,
        userName,
        punchType,
        punchDate: date,
        punchHour: hour,
        phone: emp.phone
      });
    } else {
      updatePunchSmsStatus(punchRecord.id, 'NO_PHONE', null, 'No mobile number configured');
    }
  }

  return punchRecord;
}

// Helper: JSON extractor for body
function extractJson(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(str.substring(start, i + 1));
        } catch { return null; }
      }
    }
  }
  return null;
}

// Convert HH:MM to minutes
function timeToMinutes(timeStr) {
  if (!timeStr || timeStr === '--') return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

// Format duration
function formatMinutesDuration(totalMinutes) {
  const m = Math.abs(Math.round(totalMinutes));
  const hrs = Math.floor(m / 60);
  const mins = m % 60;
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

// Analyze Day Attendance
function analyzeDayAttendance(userId, logs, emp, targetDate) {
  const stdIn = emp.standard_in || config.shiftStart || '09:00';
  const stdOut = emp.standard_out || config.shiftEnd || '18:00';
  const margin = Number(emp.margin_minutes !== undefined ? emp.margin_minutes : (config.marginMinutes || 30));

  const stdInMin = timeToMinutes(stdIn) ?? 540;
  const stdOutMin = timeToMinutes(stdOut) ?? 1080;

  const firstPunch = logs[0];
  const lastPunch = logs[logs.length - 1];

  const actInMin = timeToMinutes(firstPunch.punch_hour);
  let arrivalStatus = 'ON_TIME';
  let arrivalBadge = 'On Time';
  let arrivalDiffMin = 0;

  if (actInMin !== null) {
    arrivalDiffMin = actInMin - stdInMin;
    if (actInMin > stdInMin + margin) {
      arrivalStatus = 'LATE';
      arrivalBadge = `Late (+${formatMinutesDuration(arrivalDiffMin)})`;
    } else if (actInMin < stdInMin - margin) {
      arrivalStatus = 'EARLY';
      arrivalBadge = `Early (-${formatMinutesDuration(-arrivalDiffMin)})`;
    } else {
      arrivalStatus = 'ON_TIME';
      arrivalBadge = 'On Time';
    }
  }

  let departureStatus = 'ON_TIME';
  let departureBadge = 'On Time';
  let departureDiffMin = 0;
  let lastOutTime = '--';

  if (logs.length < 2) {
    departureStatus = 'MISSING';
    departureBadge = 'Missing Check-Out';
  } else {
    lastOutTime = lastPunch.punch_hour;
    const actOutMin = timeToMinutes(lastOutTime);
    if (actOutMin !== null) {
      departureDiffMin = actOutMin - stdOutMin;
      if (actOutMin < stdOutMin - margin) {
        departureStatus = 'EARLY';
        departureBadge = `Early (-${formatMinutesDuration(-departureDiffMin)})`;
      } else if (actOutMin > stdOutMin + margin) {
        departureStatus = 'LATE';
        departureBadge = `Late / OT (+${formatMinutesDuration(departureDiffMin)})`;
      } else {
        departureStatus = 'ON_TIME';
        departureBadge = 'On Time';
      }
    }
  }

  let workDurationStr = '--';
  let workDurationMin = 0;
  if (logs.length >= 2) {
    const startM = timeToMinutes(firstPunch.punch_hour);
    const endM = timeToMinutes(lastPunch.punch_hour);
    if (startM !== null && endM !== null && endM >= startM) {
      workDurationMin = endM - startM;
      workDurationStr = formatMinutesDuration(workDurationMin);
    }
  }

  const isAbnormal = arrivalStatus !== 'ON_TIME' || (departureStatus !== 'ON_TIME' && departureStatus !== 'MISSING');

  return {
    user_id: userId,
    user_name: emp.name || firstPunch.user_name || `User #${userId}`,
    department: emp.department || 'General',
    designation: emp.designation || 'Staff',
    punch_date: targetDate,
    standard_in: stdIn,
    standard_out: stdOut,
    margin_minutes: margin,
    first_in: firstPunch.punch_hour,
    last_out: lastOutTime,
    arrival_status: arrivalStatus,
    arrival_badge: arrivalBadge,
    arrival_diff_min: arrivalDiffMin,
    departure_status: departureStatus,
    departure_badge: departureBadge,
    departure_diff_min: departureDiffMin,
    total_punches: logs.length,
    work_duration: workDurationStr,
    work_duration_hours: Number((workDurationMin / 60).toFixed(1)),
    is_abnormal: isAbnormal
  };
}

// HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Case-insensitive header lookup helper
  const getHeader = (name) => {
    const target = name.toLowerCase();
    for (const k of Object.keys(req.headers)) {
      if (k.toLowerCase() === target) return req.headers[k];
    }
    return null;
  };

  const requestCode = getHeader('request_code');
  const transId = getHeader('trans_id');
  const devId = getHeader('dev_id') || 'S-FB3K';

  // =========================================================================
  // 1. BIOMETRIC HARDWARE HTTP ENDPOINT (FkWeb Mode / EBKN)
  // =========================================================================
  if (requestCode || pathname === '/ebkn' || pathname.startsWith('/ebkn')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawString = Buffer.concat(chunks).toString('latin1');
      const parsed = extractJson(rawString);

      // Reply headers required by Realand/Secureye M61 firmware
      const ackHeaders = {
        'Content-Type': 'application/octet-stream',
        'response_code': 'OK',
        'Connection': 'close'
      };
      if (transId) ackHeaders['trans_id'] = transId;

      switch (requestCode) {
        case 'realtime_glog': {
          if (parsed && parsed.user_id) {
            recordPunch({
              rawUserId: parsed.user_id,
              ioTime: parsed.io_time,
              ioMode: parsed.io_mode,
              verifyMode: parsed.verify_mode || 1,
              deviceId: devId,
              protocol: 'CLOUD_FKWEB',
              rawPayload: JSON.stringify(parsed)
            });
          }
          res.writeHead(200, ackHeaders);
          return res.end();
        }

        case 'realtime_enroll_data': {
          if (parsed && parsed.user_id && parsed.user_name) {
            const uid = normalizeUserId(parsed.user_id);
            const emp = employeesMap.get(uid) || {};
            emp.user_id = uid;
            emp.name = String(parsed.user_name).trim();
            employeesMap.set(uid, emp);
            saveEmployees();
          }
          res.writeHead(200, ackHeaders);
          return res.end();
        }

        case 'receive_cmd': {
          // Device polling every 3 seconds for commands
          // Responding keeps Render free container awake 24/7!
          res.writeHead(200, ackHeaders);
          return res.end();
        }

        default: {
          res.writeHead(200, ackHeaders);
          return res.end();
        }
      }
    });
    return;
  }

  // =========================================================================
  // 2. REST APIS FOR MOBILE DASHBOARD
  // =========================================================================

  // SSE Stream
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2500\n\n: connected\n\n');

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(keepAlive); }
    }, 15000);

    const onPunch = (p) => res.write(`event: punch\ndata: ${JSON.stringify(p)}\n\n`);
    const onSms = (s) => res.write(`event: sms_status\ndata: ${JSON.stringify(s)}\n\n`);

    eventEmitter.on('punch', onPunch);
    eventEmitter.on('punch_sms_updated', onSms);

    req.on('close', () => {
      clearInterval(keepAlive);
      eventEmitter.off('punch', onPunch);
      eventEmitter.off('punch_sms_updated', onSms);
    });
    return;
  }

  // Punches
  if (pathname === '/api/punches' && req.method === 'GET') {
    const limit = parseInt(urlObj.searchParams.get('limit') || '200', 10);
    let rows = [];
    if (db) {
      try {
        rows = db.prepare('SELECT * FROM punches ORDER BY punch_time DESC LIMIT ?').all(limit);
      } catch (e) {}
    } else {
      rows = inMemoryPunches.slice().reverse().slice(0, limit);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  // Daily Summary
  if (pathname === '/api/daily-summary' && req.method === 'GET') {
    const today = new Date().toISOString().split('T')[0];
    const targetDate = urlObj.searchParams.get('date') || today;
    let punches = [];
    if (db) {
      try {
        punches = db.prepare('SELECT * FROM punches WHERE punch_date = ? ORDER BY punch_time ASC').all(targetDate);
      } catch (e) {}
    } else {
      punches = inMemoryPunches.filter((p) => p.punch_date === targetDate);
    }

    const userGroups = new Map();
    for (const p of punches) {
      if (!userGroups.has(p.user_id)) userGroups.set(p.user_id, []);
      userGroups.get(p.user_id).push(p);
    }

    const records = [];
    for (const [uid, logs] of userGroups.entries()) {
      const emp = employeesMap.get(uid) || {};
      records.push(analyzeDayAttendance(uid, logs, emp, targetDate));
    }

    const metrics = {
      total_punches: punches.length,
      total_present: records.length,
      late_in: records.filter((r) => r.arrival_status === 'LATE').length,
      early_out: records.filter((r) => r.departure_status === 'EARLY').length,
      total_work_hours: Number(records.reduce((acc, r) => acc + (r.work_duration_hours || 0), 0).toFixed(1))
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ date: targetDate, metrics, records }));
  }

  // Employees
  if (pathname === '/api/employees') {
    if (req.method === 'GET') {
      const emps = Array.from(employeesMap.values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(emps));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { user_id, name, department, designation, phone, standard_in, standard_out, margin_minutes } = JSON.parse(body);
          const cleanId = normalizeUserId(user_id);
          const saved = {
            user_id: cleanId,
            name: name || `User #${cleanId}`,
            department: department || 'General',
            designation: designation || 'Staff',
            phone: phone || '',
            standard_in: standard_in || '09:00',
            standard_out: standard_out || '18:00',
            margin_minutes: parseInt(margin_minutes, 10) || 30,
            updated_at: new Date().toISOString()
          };
          employeesMap.set(cleanId, saved);
          saveEmployees();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, employee: saved }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // Retry SMS
  if (pathname === '/api/retry-sms' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { punch_id } = JSON.parse(body);
        let punch = null;
        if (db) {
          punch = db.prepare('SELECT * FROM punches WHERE id = ?').get(punch_id);
        } else {
          punch = inMemoryPunches.find((p) => p.id === punch_id);
        }
        if (!punch) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Punch not found' }));
        }
        const emp = employeesMap.get(punch.user_id) || {};
        if (!emp.phone) {
          updatePunchSmsStatus(punch.id, 'NO_PHONE', null, 'No phone registered');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'No phone number for employee' }));
        }
        sendPunchSms({
          punchId: punch.id,
          userId: punch.user_id,
          userName: punch.user_name || emp.name,
          punchType: punch.punch_type,
          punchDate: punch.punch_date,
          punchHour: punch.punch_hour,
          phone: emp.phone
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Test SMS
  if (pathname === '/api/test-sms' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { phone, name } = JSON.parse(body);
        const recipient = formatPhoneNumber(phone);
        if (!recipient) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Valid phone required' }));
        }
        const payload = JSON.stringify({
          recipients: [recipient],
          message: `Dear ${name || 'Staff'}, this is a test alert from ${config.companyName} cloud attendance system.`
        });
        const reqSms = https.request(
          `https://api.textbee.dev/api/v1/gateway/devices/${config.sms.deviceId}/send-sms`,
          {
            method: 'POST',
            headers: {
              'x-api-key': config.sms.apiKey,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          },
          (resSms) => {
            let data = '';
            resSms.on('data', (c) => (data += c));
            resSms.on('end', () => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: true, recipient }));
            });
          }
        );
        reqSms.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        });
        reqSms.write(payload);
        reqSms.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Safe Reset Data
  if (pathname === '/api/reset-data' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { clear_employees } = body ? JSON.parse(body) : {};
        if (db) {
          db.exec('DELETE FROM punches;');
          try { db.exec("DELETE FROM sqlite_sequence WHERE name='punches';"); } catch (e) {}
        }
        inMemoryPunches = [];
        sentSmsPunches.clear();
        if (clear_employees) {
          employeesMap.clear();
          saveEmployees();
        }
        fs.writeFileSync(
          CSV_FILE,
          'ID,Punch_Date,Punch_Time,User_ID,Employee_Name,Punch_Type,IO_Mode,Verify_Mode,Device_ID,Protocol\n',
          'utf8'
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // =========================================================================
  // 3. STATIC FILES (Mobile Dashboard)
  // =========================================================================
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // Memory fallback for cloud deploys without public folder
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(EMBEDDED_HTML);
      }
      if (pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end(EMBEDDED_CSS);
      }
      if (pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(EMBEDDED_JS);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  });
});

// =========================================================================
// 4. WEBSOCKET HANDLER (RFC 6455 XML F500 Mode)
// =========================================================================
if (WebSocket) {
  const wss = new WebSocket.WebSocketServer({ server });
  wss.on('connection', (ws) => {
    console.log('[WEBSOCKET] Biometric terminal connected via ws://');
    let sessionToken = '556883b7ce9949e8';

    ws.on('message', (message) => {
      const xml = message.toString();

      // Login Handshake
      if (xml.includes('<Request>Login</Request>')) {
        const serialMatch = xml.match(/<DeviceSerialNo>(.*?)<\/DeviceSerialNo>/);
        const serial = serialMatch ? serialMatch[1] : '102026030001980';
        const reply = `<?xml version="1.0"?>\n<Message>\n<Response>Login</Response>\n<DeviceSerialNo>${serial}</DeviceSerialNo>\n<Token>${sessionToken}</Token>\n<Result>OK</Result>\n</Message>`;
        ws.send(reply);
        return;
      }

      // TimeLog_v2 (Attendance Punches)
      if (xml.includes('<Event>TimeLog_v2</Event>') || xml.includes('<Event>TimeLog</Event>')) {
        const uidMatch = xml.match(/<UserID>(.*?)<\/UserID>/);
        const timeMatch = xml.match(/<Time>(.*?)<\/Time>/);
        const transMatch = xml.match(/<TransID>(.*?)<\/TransID>/);
        const logIdMatch = xml.match(/<LogID>(.*?)<\/LogID>/);
        const devMatch = xml.match(/<DeviceSerialNo>(.*?)<\/DeviceSerialNo>/);

        const uid = uidMatch ? uidMatch[1] : '1';
        const rawTime = timeMatch ? timeMatch[1] : '';
        const transId = transMatch ? transMatch[1] : '1';
        const logId = logIdMatch ? logIdMatch[1] : '1';
        const devSerial = devMatch ? devMatch[1] : 'S-FB3K';

        recordPunch({
          rawUserId: uid,
          ioTime: rawTime,
          ioMode: 1,
          verifyMode: 1,
          deviceId: devSerial,
          protocol: 'CLOUD_WS'
        });

        // Exact XML echo required by firmware
        const ack = `<?xml version="1.0"?>\n<Message>\n<Response>TimeLog_v2</Response>\n<DeviceSerialNo>${devSerial}</DeviceSerialNo>\n<TransID>${transId}</TransID>\n<LogID>${logId}</LogID>\n<Result>OK</Result>\n</Message>`;
        ws.send(ack);
        return;
      }

      // KeepAlive
      if (xml.includes('<Event>KeepAlive</Event>')) {
        ws.send(`<?xml version="1.0"?>\n<Message>\n<Response>KeepAlive</Response>\n<Result>OK</Result>\n</Message>`);
        return;
      }
    });
  });
}

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 CLOUD ATTENDANCE SERVER READY ON PORT ${PORT}`);
  console.log(`👉 Machine FkWeb URL: http://<your-render-url>/ebkn`);
  console.log(`👉 Machine WebSocket: ws://<your-render-url>/`);
  console.log(`👉 Mobile Dashboard:  https://<your-render-url>/`);
  console.log(`=======================================================`);
});
