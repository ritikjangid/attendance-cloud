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
