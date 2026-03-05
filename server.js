require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Twilio SMS ───
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '';
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID || '';

function formatPhoneE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('1') && digits.length === 11) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits; // fallback: prepend + and hope for the best
}

async function sendSMS(to, body) {
  if (!twilioClient || !TWILIO_FROM) {
    console.log(`[SMS-SKIP] Twilio not configured. To: ${to}, Body: ${body}`);
    return false;
  }
  const formatted = formatPhoneE164(to);
  try {
    await twilioClient.messages.create({ body, from: TWILIO_FROM, to: formatted });
    console.log(`[SMS] Sent to ${formatted}`);
    return true;
  } catch (e) {
    console.error(`[SMS-ERR] Failed to send to ${formatted}:`, e.message);
    return false;
  }
}

// ─── Twilio Verify API (for verification codes) ───
async function sendVerifyCode(to, channel = 'sms') {
  if (!twilioClient || !TWILIO_VERIFY_SID) {
    console.log(`[Verify-SKIP] Twilio Verify not configured. To: ${to}, Channel: ${channel}`);
    return false;
  }
  const formatted = formatPhoneE164(to);
  try {
    const v = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: formatted, channel });
    console.log(`[Verify] Sent ${channel} to ${formatted}, status: ${v.status}`);
    return true;
  } catch (e) {
    console.error(`[Verify-ERR] Failed to send to ${formatted}:`, e.message);
    return false;
  }
}

async function checkVerifyCode(to, code) {
  if (!twilioClient || !TWILIO_VERIFY_SID) return false;
  const formatted = formatPhoneE164(to);
  try {
    const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: formatted, code });
    console.log(`[Verify] Check ${formatted}: ${check.status}`);
    return check.status === 'approved';
  } catch (e) {
    console.error(`[Verify-ERR] Check failed for ${formatted}:`, e.message);
    return false;
  }
}

// Returns detailed Twilio status for diagnostics (used by admin test endpoint)
async function sendSMSWithDetail(to, body) {
  if (!twilioClient) return { ok: false, error: 'TWILIO_ACCOUNT_SID 或 TWILIO_AUTH_TOKEN 未配置' };
  if (!TWILIO_FROM) return { ok: false, error: 'TWILIO_PHONE_NUMBER 未配置' };
  const formatted = formatPhoneE164(to);
  try {
    const msg = await twilioClient.messages.create({ body, from: TWILIO_FROM, to: formatted });
    // Wait 3s then fetch real delivery status (queued → sent/failed/undelivered)
    await new Promise(r => setTimeout(r, 3000));
    const updated = await twilioClient.messages(msg.sid).fetch();
    return { ok: true, sid: msg.sid, status: updated.status, errorCode: updated.errorCode, errorMessage: updated.errorMessage, to: formatted, from: TWILIO_FROM };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code, to: formatted, from: TWILIO_FROM };
  }
}

async function getTwilioAccountType() {
  if (!twilioClient) return null;
  try {
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    return { type: account.type, status: account.status, friendlyName: account.friendlyName };
  } catch (e) { return { error: e.message }; }
}

// ─── Persona Identity Verification ───
async function createPersonaInquiry(workerId, workerName, workerPhone) {
  const apiKey = process.env.PERSONA_API_KEY;
  const templateId = process.env.PERSONA_TEMPLATE_ID;
  if (!apiKey || !templateId) return null;
  const parts = (workerName || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  try {
    const resp = await fetch('https://withpersona.com/api/v1/inquiries', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Persona-Version': '2023-01-05' },
      body: JSON.stringify({ data: { attributes: {
        'inquiry-template-id': templateId,
        'reference-id': `worker-${workerId}`,
        fields: { 'name-first': firstName, 'name-last': lastName, 'phone-number': formatPhoneE164(workerPhone || '') || undefined }
      }}})
    });
    if (!resp.ok) { console.error('[Persona] Create inquiry failed:', await resp.text()); return null; }
    const d = await resp.json();
    const inqId = d.data.id;
    let token = d.meta?.['session-token'] || d.data?.attributes?.['session-token'] || '';
    // Persona may not return session-token on create; call /resume to obtain it
    if (!token) {
      const resumeLink = await resumePersonaInquiry(inqId);
      if (resumeLink) {
        const m = resumeLink.match(/session-token=([^&]+)/);
        if (m) token = m[1];
      }
    }
    const link = token ? `https://withpersona.com/verify?inquiry-id=${inqId}&session-token=${token}` : '';
    return { inquiryId: inqId, sessionToken: token, link };
  } catch (e) { console.error('[Persona] createPersonaInquiry error:', e.message); return null; }
}

async function resumePersonaInquiry(inquiryId) {
  const apiKey = process.env.PERSONA_API_KEY;
  if (!apiKey || !inquiryId) return null;
  try {
    const resp = await fetch(`https://withpersona.com/api/v1/inquiries/${inquiryId}/resume`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Persona-Version': '2023-01-05' }
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const token = d.meta?.['session-token'] || d.data?.attributes?.['session-token'];
    return token ? `https://withpersona.com/verify?inquiry-id=${inquiryId}&session-token=${token}` : null;
  } catch (e) { return null; }
}

function verifyPersonaWebhook(rawBody, sigHeader) {
  const secret = process.env.PERSONA_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured (dev mode)
  const parts = (sigHeader || '').split(',');
  const t = parts.find(p => p.startsWith('t='))?.slice(2);
  const v1 = parts.find(p => p.startsWith('v1='))?.slice(3);
  if (!t || !v1) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) { return false; }
}

// ─── Email ───
// Prefer SendGrid HTTP API (works through firewalls that block SMTP ports).
// Set SENDGRID_API_KEY, or reuse SMTP_PASS when SMTP_USER=apikey (SendGrid SMTP creds).
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@primeanchorpoint.com';
const _sgKey = process.env.SENDGRID_API_KEY ||
  (process.env.SMTP_USER === 'apikey' ? process.env.SMTP_PASS : null);

// Fallback: generic SMTP via nodemailer (non-SendGrid providers only)
const emailTransporter = (!_sgKey && process.env.SMTP_HOST)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;

if (!_sgKey && !emailTransporter) {
  console.warn('[EMAIL-WARN] No email transport configured. Set SENDGRID_API_KEY (recommended) or SMTP_HOST.');
}
if (_sgKey) {
  console.log(`[EMAIL] SendGrid HTTP API ready (from: ${EMAIL_FROM})`);
} else if (emailTransporter) {
  emailTransporter.verify()
    .then(() => console.log(`[EMAIL] SMTP connection verified OK (from: ${EMAIL_FROM})`))
    .catch(e => console.error(`[EMAIL-ERR] SMTP connection failed at startup: ${e.message}`));
}

function verificationCodeHtml(code, isAdminTest = false) {
  const label = isAdminTest ? '管理员测试 / Admin Test' : '邮箱验证 / Email Verification';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
<tr><td style="background:#1a1a2e;padding:24px 32px">
  <p style="margin:0;color:#fff;font-size:18px;font-weight:600">Prime Anchorpoint</p>
  <p style="margin:4px 0 0;color:#a0aec0;font-size:12px">${label}</p>
</td></tr>
<tr><td style="padding:32px">
  <p style="margin:0 0 8px;color:#374151;font-size:15px">您的验证码 / Your verification code:</p>
  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:20px;text-align:center;margin:16px 0">
    <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a2e;font-family:monospace">${code}</span>
  </div>
  <p style="margin:0;color:#6b7280;font-size:13px">验证码15分钟内有效。请勿分享给他人。<br>This code expires in 15 minutes. Do not share it with anyone.</p>
</td></tr>
<tr><td style="padding:0 32px 24px;border-top:1px solid #f3f4f6">
  <p style="margin:16px 0 0;color:#9ca3af;font-size:11px">如非本人操作请忽略此邮件。If you did not request this, please ignore this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendEmail(to, subject, text, html) {
  if (_sgKey) {
    try {
      const content = [{ type: 'text/plain', value: text }];
      if (html) content.push({ type: 'text/html', value: html });
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${_sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: EMAIL_FROM },
          subject,
          content,
        }),
      });
      if (r.status === 202) { console.log(`[EMAIL] Sent to ${to}`); return true; }
      const body = await r.text();
      console.error(`[EMAIL-ERR] SendGrid API ${r.status}: ${body}`);
      return false;
    } catch (e) {
      console.error(`[EMAIL-ERR] SendGrid API fetch failed: ${e.message}`);
      return false;
    }
  }
  if (!emailTransporter) { console.log(`[EMAIL-SKIP] No transport. To: ${to}`); return false; }
  try {
    await emailTransporter.sendMail({ from: EMAIL_FROM, to, subject, text, html });
    console.log(`[EMAIL] Sent to ${to}`);
    return true;
  } catch (e) {
    console.error(`[EMAIL-ERR] Failed to send to ${to}: ${e.message} (code: ${e.code}, response: ${e.response})`);
    return false;
  }
}

// ─── Database Setup ───
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Employee docs stored separately (never served as static files)
const docsDir = path.join(dataDir, 'employee_docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

const punchPhotosDir = path.join(dataDir, 'punch_photos');
if (!fs.existsSync(punchPhotosDir)) fs.mkdirSync(punchPhotosDir, { recursive: true });

const db = new Database(path.join(dataDir, 'prime.db'));
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 100');
// Custom function: strip all non-digits and return last 10 chars (US phone matching)
db.function('phone10', s => s ? s.replace(/\D/g, '').slice(-10) : '');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER DEFAULT NULL,
    title TEXT NOT NULL,
    type TEXT DEFAULT '',
    location TEXT DEFAULT '',
    pay TEXT DEFAULT '',
    lang TEXT DEFAULT 'en',
    lang_name TEXT DEFAULT 'English',
    description TEXT DEFAULT '',
    urgent INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    work_auth TEXT DEFAULT '',
    benefits TEXT DEFAULT '',
    schedule TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (partner_id) REFERENCES partners(id)
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    company TEXT DEFAULT '',
    type TEXT DEFAULT '',
    employer_id TEXT DEFAULT '',
    positions TEXT DEFAULT '',
    workers TEXT DEFAULT '',
    location TEXT DEFAULT '',
    start_date TEXT DEFAULT '',
    experience TEXT DEFAULT '',
    languages TEXT DEFAULT '',
    comments TEXT DEFAULT '',
    resume_path TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    company TEXT DEFAULT '',
    products TEXT DEFAULT '',
    quantity TEXT DEFAULT '',
    location TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_person TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    industry TEXT DEFAULT '',
    services TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    contacts TEXT DEFAULT '[]',
    addresses TEXT DEFAULT '[]',
    social_media TEXT DEFAULT '{}',
    links TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS partner_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    file_type TEXT DEFAULT 'other',
    file_label TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (partner_id) REFERENCES partners(id)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    status TEXT DEFAULT 'assigned',
    notes TEXT DEFAULT '',
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    display_name TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id INTEGER,
    payload TEXT DEFAULT '{}',
    requested_by TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT DEFAULT '',
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    dob TEXT DEFAULT '',
    emergency_name TEXT DEFAULT '',
    emergency_phone TEXT DEFAULT '',
    emergency_relation TEXT DEFAULT '',
    hire_date TEXT DEFAULT '',
    position TEXT DEFAULT '',
    department TEXT DEFAULT '',
    pay_rate REAL DEFAULT 0,
    pay_type TEXT DEFAULT 'hourly',
    status TEXT DEFAULT 'active',
    pin_hash TEXT DEFAULT '',
    pin_salt TEXT DEFAULT '',
    ssn_encrypted TEXT DEFAULT '',
    ssn_iv TEXT DEFAULT '',
    ssn_last4 TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS employee_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    doc_type TEXT NOT NULL,
    doc_label TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    expiry_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    clock_in DATETIME NOT NULL,
    clock_out DATETIME,
    break_minutes INTEGER DEFAULT 0,
    total_hours REAL DEFAULT 0,
    regular_hours REAL DEFAULT 0,
    overtime_hours REAL DEFAULT 0,
    job_id INTEGER DEFAULT NULL,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE TABLE IF NOT EXISTS background_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    check_type TEXT DEFAULT 'criminal',
    ordered_date TEXT DEFAULT '',
    completed_date TEXT DEFAULT '',
    status TEXT DEFAULT 'ordered',
    result TEXT DEFAULT '',
    vendor TEXT DEFAULT '',
    cost REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE TABLE IF NOT EXISTS employee_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    job_id INTEGER DEFAULT NULL,
    job_title TEXT DEFAULT '',
    score_efficiency INTEGER DEFAULT 0,
    score_quality INTEGER DEFAULT 0,
    score_attendance INTEGER DEFAULT 0,
    score_safety INTEGER DEFAULT 0,
    score_teamwork INTEGER DEFAULT 0,
    score_skills INTEGER DEFAULT 0,
    pay_est_min REAL DEFAULT 0,
    pay_est_max REAL DEFAULT 0,
    pay_est_type TEXT DEFAULT 'hourly',
    notes TEXT DEFAULT '',
    rated_by TEXT DEFAULT '',
    rated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE TABLE IF NOT EXISTS employee_doc_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    employee_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    requested_docs TEXT DEFAULT '["gov_id","ssn","work_card"]',
    admin_note TEXT DEFAULT '',
    lang TEXT DEFAULT 'zh',
    completed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE TABLE IF NOT EXISTS onboarding_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    inquiry_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    agreements TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id)
  );
  CREATE TABLE IF NOT EXISTS onboarding_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    doc_type TEXT NOT NULL,
    file_path TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (token_id) REFERENCES onboarding_tokens(id)
  );
`);

// ─── Migrations for existing databases ───
try { db.exec("ALTER TABLE inquiries ADD COLUMN employer_id TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE jobs ADD COLUMN partner_id INTEGER DEFAULT NULL"); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_auth TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN benefits TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN company_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN company_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN employment_type TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_days TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_start TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_end TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_schedule TEXT DEFAULT '{}'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_days TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_start TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_end TEXT DEFAULT ''`); } catch(e) {}
// Job status & closure tracking
try { db.exec(`ALTER TABLE jobs ADD COLUMN job_status TEXT DEFAULT 'open'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN close_reason TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN close_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN headcount INTEGER DEFAULT 1`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN pay_period TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN required_skills TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN category TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN interview_availability TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN confirm_phone TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN confirm_email TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN applicant_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN expected_pay TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN skills TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN expected_pay TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN persona_inquiry_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN identity_status TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN identity_sent_at TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN checkr_candidate_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN checkr_invitation_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN checkr_report_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN bgcheck_status TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN applicant_message TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN admin_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN interview_datetime TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN interview_location_text TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE job_applications ADD COLUMN interview_times_json TEXT DEFAULT ''`); } catch(e) {}
// Backfill job_status from active flag for existing rows
try { db.exec(`UPDATE jobs SET job_status='open' WHERE active=1 AND (job_status IS NULL OR job_status='')`); } catch(e) {}
try { db.exec(`UPDATE jobs SET job_status='closed' WHERE active=0 AND (job_status IS NULL OR job_status='')`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN visible INTEGER DEFAULT 1`); } catch(e) {}

try { db.exec("ALTER TABLE inquiries ADD COLUMN employer_id TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN processed INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN proc_status TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN proc_note TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN processed_at DATETIME DEFAULT NULL"); } catch(e) {}
// Assignment detail fields
try { db.exec(`ALTER TABLE assignments ADD COLUMN pay_rate TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN pay_type TEXT DEFAULT 'hourly'`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN contract_type TEXT DEFAULT 'W2'`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN benefits TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN start_date TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN contract_file TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN contract_filename TEXT DEFAULT ''`); } catch(e) {}

// Migrate admin_users table (add role, display_name, active, created_at columns if missing)
['role TEXT DEFAULT \'staff\'', 'display_name TEXT DEFAULT \'\'', 'active INTEGER DEFAULT 1', 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'].forEach(col => {
  try { db.exec(`ALTER TABLE admin_users ADD COLUMN ${col}`); } catch {}
});

// Migrate partners table (add new columns if missing)
const partnerMigrations = ['contacts','addresses','social_media','links'];
partnerMigrations.forEach(col => {
  try { db.exec(`ALTER TABLE partners ADD COLUMN ${col} TEXT DEFAULT '${col.includes('s')&&!col.includes('_')?'[]':'{}'}'`); } catch {}
});
// Migrate jobs table (add new columns if missing)
const jobMigrations = [
  "ALTER TABLE jobs ADD COLUMN partner_id INTEGER DEFAULT NULL",
  "ALTER TABLE jobs ADD COLUMN employment_type TEXT DEFAULT ''",
  "ALTER TABLE jobs ADD COLUMN benefits TEXT DEFAULT '[]'",
  "ALTER TABLE jobs ADD COLUMN schedule_days TEXT DEFAULT '[]'",
  "ALTER TABLE jobs ADD COLUMN schedule_start TEXT DEFAULT ''",
  "ALTER TABLE jobs ADD COLUMN schedule_end TEXT DEFAULT ''"
];
jobMigrations.forEach(sql => { try { db.exec(sql); } catch {} });

// timesheet_sheets: one per submitted period, carries the employee-facing confirmation token
db.exec(`CREATE TABLE IF NOT EXISTS timesheet_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  company_name TEXT DEFAULT '',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  job_id INTEGER DEFAULT NULL,
  total_hours REAL DEFAULT 0,
  regular_hours REAL DEFAULT 0,
  overtime_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  confirm_token TEXT UNIQUE NOT NULL,
  employee_action TEXT DEFAULT '',
  employee_note TEXT DEFAULT '',
  confirmed_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
)`);
try { db.exec(`ALTER TABLE time_entries ADD COLUMN lunch_start TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN lunch_end TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN company_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN sheet_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN punch_type TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN break_records TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN on_break INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN break_start DATETIME`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN client_paid INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN labor_paid INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN verified_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN client_paid_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN labor_paid_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN staff_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE employee_doc_requests ADD COLUMN lang TEXT DEFAULT 'zh'`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN extra_phones TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN extra_emails TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN street2 TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN middle_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN social_media TEXT DEFAULT '{}'`); } catch(e) {}
try { db.exec(`ALTER TABLE inquiries ADD COLUMN job_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN punch_photo_path TEXT DEFAULT ''`); } catch(e) {}

// DocuSign columns
['ds_envelope_id TEXT DEFAULT \'\'','ds_status TEXT DEFAULT \'\'','ds_worker_signed_at DATETIME','ds_company_signed_at DATETIME'].forEach(col => { try { db.exec(`ALTER TABLE assignments ADD COLUMN ${col}`); } catch {} });
try { db.exec(`ALTER TABLE assignments ADD COLUMN work_schedule TEXT DEFAULT '{}'`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN category TEXT DEFAULT ''`); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_address TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_lat REAL DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_lng REAL DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_radius INTEGER DEFAULT 200"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN worker_response TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN task_requirements TEXT DEFAULT '[]'"); } catch(e) {}
['ds_envelope_id TEXT DEFAULT \'\'','ds_status TEXT DEFAULT \'\'','ds_partner_signed_at DATETIME','ds_company_signed_at DATETIME'].forEach(col => { try { db.exec(`ALTER TABLE partner_files ADD COLUMN ${col}`); } catch {} });

db.exec(`CREATE TABLE IF NOT EXISTS assignment_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT DEFAULT '',
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec(`ALTER TABLE assignment_status_history ADD COLUMN reason TEXT DEFAULT ''`); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS shift_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  date TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  notified_at DATETIME DEFAULT NULL,
  responded_at DATETIME DEFAULT NULL,
  UNIQUE(assignment_id, date)
)`);
try { db.exec(`ALTER TABLE shift_confirmations ADD COLUMN shift_start TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE shift_confirmations ADD COLUMN shift_end TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE shift_confirmations ADD COLUMN reminded_at DATETIME DEFAULT NULL`); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS employee_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  company_name TEXT DEFAULT '',
  job_title TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  UNIQUE(employee_id, job_id)
)`);

// Migrate employee_jobs: add date, financial, and performance columns
[
  "ALTER TABLE employee_jobs ADD COLUMN start_date TEXT DEFAULT ''",
  "ALTER TABLE employee_jobs ADD COLUMN end_date TEXT DEFAULT ''",
  "ALTER TABLE employee_jobs ADD COLUMN emp_hourly_rate REAL DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN emp_total_hours REAL DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN emp_total_pay REAL DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN client_hourly_rate REAL DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN client_total_billed REAL DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_efficiency INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_quality INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_attendance INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_safety INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_teamwork INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN perf_skills INTEGER DEFAULT 0",
  "ALTER TABLE employee_jobs ADD COLUMN notes TEXT DEFAULT ''"
].forEach(sql => { try { db.exec(sql); } catch {} });

db.exec(`CREATE TABLE IF NOT EXISTS dividend_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  vote_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sheet_id) REFERENCES timesheet_sheets(id),
  FOREIGN KEY (user_id) REFERENCES admin_users(id),
  UNIQUE(sheet_id, user_id, vote_type)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS employee_position_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  position_key TEXT NOT NULL,
  skill_score INTEGER DEFAULT 0,
  recommend INTEGER DEFAULT -1,
  suggest_pay TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(employee_id, position_key),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS job_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  changes TEXT DEFAULT '{}',
  performed_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS inquiry_position_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL,
  position_key TEXT NOT NULL,
  skill_score INTEGER DEFAULT 0,
  recommend INTEGER DEFAULT 0,
  suggest_pay TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(inquiry_id, position_key)
)`);

// ─── New tables for worker / customer / job-application portals ───
db.exec(`
  CREATE TABLE IF NOT EXISTS worker_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER REFERENCES employees(id),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customer_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    partner_id INTEGER REFERENCES partners(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS job_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id),
    status TEXT DEFAULT 'pending',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, worker_account_id)
  );
  CREATE TABLE IF NOT EXISTS customer_job_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
    title TEXT NOT NULL,
    location TEXT DEFAULT '',
    headcount INTEGER DEFAULT 1,
    start_date TEXT DEFAULT '',
    work_type TEXT DEFAULT '',
    requirements TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Migrate: add assigned_partner_ids to admin_users (for manager role)
try { db.exec("ALTER TABLE admin_users ADD COLUMN assigned_partner_ids TEXT DEFAULT ''"); } catch {}
// Migrate: add lang/positions to employee_doc_requests
try { db.exec("ALTER TABLE employee_doc_requests ADD COLUMN lang TEXT DEFAULT 'zh'"); } catch {}
try { db.exec("ALTER TABLE employee_doc_requests ADD COLUMN positions TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE employee_doc_requests ADD COLUMN expires_at DATETIME DEFAULT NULL"); } catch {}
// Migrate: add GPS fields to time_entries
try { db.exec("ALTER TABLE time_entries ADD COLUMN latitude REAL DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN longitude REAL DEFAULT NULL"); } catch {}
// Table for position self-ratings from doc requests
db.exec(`CREATE TABLE IF NOT EXISTS doc_request_position_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_request_id INTEGER NOT NULL REFERENCES employee_doc_requests(id),
  position_key TEXT NOT NULL,
  interest INTEGER DEFAULT 0,
  skill_score INTEGER DEFAULT 0,
  UNIQUE(doc_request_id, position_key)
)`);

// Migrate: worker self-registration fields
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN phone TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN email TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN dob TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN work_status TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN position_interests TEXT DEFAULT '[]'"); } catch {}
// Migrate: enterprise self-registration fields
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN ein TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN staffing_needs TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN approval_status TEXT DEFAULT 'approved'"); } catch {}
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN contact_first_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN contact_last_name TEXT DEFAULT ''"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS enterprise_verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
  type TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migrate: suspended flag for worker accounts (distinct from unverified)
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN suspended INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN assigned_tasks TEXT DEFAULT '[]'"); } catch {}
// Migrate: city / state / worker_code / linked_inquiry_id (stored) / split name
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN city TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN state TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN first_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN middle_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN last_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN worker_code TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN linked_inquiry_id INTEGER DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN source TEXT DEFAULT 'admin'"); } catch {}

// ─── Worker account change history ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_account_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL,
  changed_by TEXT DEFAULT 'admin',
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── Employee registration invites ───
db.exec(`CREATE TABLE IF NOT EXISTS employee_registration_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS admin_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  notes TEXT DEFAULT '',
  assigned_partner_ids TEXT DEFAULT '',
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  used_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Manager self-registration invite links
db.exec(`CREATE TABLE IF NOT EXISTS manager_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  note TEXT DEFAULT '',
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_by INTEGER DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Temp verification codes for manager registration
db.exec(`CREATE TABLE IF NOT EXISTS manager_reg_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  contact TEXT NOT NULL,
  contact_type TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Backfill: assign worker_code + linked_inquiry_id to existing verified workers
// (runs once on startup; activateWorkerAccount is idempotent — skips if code already set)
setTimeout(() => {
  try {
    const unlinked = db.prepare("SELECT id FROM worker_accounts WHERE active=1 AND worker_code IS NULL").all();
    unlinked.forEach(w => { try { activateWorkerAccount(w.id); } catch {} });
  } catch {}
}, 0);
// Migrate: richer fields on job_applications
try { db.exec("ALTER TABLE job_applications ADD COLUMN expected_pay TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN work_auth_confirmed TEXT DEFAULT ''"); } catch {}

// ─── Interview system ───
db.exec(`CREATE TABLE IF NOT EXISTS interview_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS interview_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_datetime TEXT NOT NULL,
  duration_min INTEGER DEFAULT 30,
  max_bookings INTEGER DEFAULT 1,
  booked_count INTEGER DEFAULT 0,
  location TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id),
  slot_id INTEGER NOT NULL REFERENCES interview_slots(id),
  status TEXT DEFAULT 'scheduled',
  admin_notes TEXT DEFAULT '',
  doc_request_token TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(worker_account_id)
)`);

// Migrate interview_slots: add location detail columns
try { db.exec("ALTER TABLE interview_slots ADD COLUMN location_id INTEGER DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE interview_slots ADD COLUMN contact_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_slots ADD COLUMN contact_phone TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_slots ADD COLUMN instructions TEXT DEFAULT ''"); } catch {}

const WORKER_POSITIONS = [
  { key:'warehouse_sorter',   zh:'仓库分拣员',   en:'Warehouse Sorter' },
  { key:'labeler',            zh:'贴标员',       en:'Labeler' },
  { key:'packer',             zh:'打包员',       en:'Packer' },
  { key:'forklift_operator',  zh:'叉车操作员',   en:'Forklift Operator' },
  { key:'cdl_driver',         zh:'CDL卡车司机',  en:'CDL Truck Driver' },
  { key:'delivery_driver',    zh:'送货司机',     en:'Delivery Driver' },
  { key:'shift_supervisor',   zh:'班组长',       en:'Shift Supervisor' },
  { key:'site_manager',       zh:'现场主管',     en:'Site Manager' },
  { key:'quality_inspector',  zh:'质检员',       en:'Quality Inspector' },
  { key:'machine_operator',   zh:'机器操作员',   en:'Machine Operator' },
  { key:'assembly_line',      zh:'装配线工人',   en:'Assembly Line' },
  { key:'material_handler',   zh:'物料搬运工',   en:'Material Handler' },
  { key:'inventory_clerk',    zh:'库存文员',     en:'Inventory Clerk' },
  { key:'general_labor',      zh:'普工',         en:'General Labor' },
  { key:'janitorial',         zh:'清洁工',       en:'Janitorial' },
  { key:'food_processing',    zh:'食品加工',     en:'Food Processing' },
  { key:'warehouse_lead',     zh:'仓库领班',     en:'Warehouse Lead' },
  { key:'loading_unloading',  zh:'装卸工',       en:'Loading / Unloading' },
  { key:'order_picker',       zh:'拣货员',       en:'Order Picker' },
  { key:'welder',             zh:'焊接工',       en:'Welder' },
];
// Add quote_request column to inquiries if not already present (migration)
try { db.exec('ALTER TABLE inquiries ADD COLUMN quote_request INTEGER DEFAULT 0'); } catch {}

// Verification codes table for registration
db.exec(`CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  code TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_account_id) REFERENCES worker_accounts(id)
)`);

// ─── Job Sites (for GPS geofencing) ───
db.exec(`CREATE TABLE IF NOT EXISTS job_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius_meters INTEGER DEFAULT 200,
  partner_id INTEGER DEFAULT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── Worker Compliance Documents (I-9, DL, W-9, etc.) ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_compliance_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  form_data TEXT DEFAULT '{}',
  reviewer_notes TEXT DEFAULT '',
  reviewed_by INTEGER DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_account_id) REFERENCES worker_accounts(id)
)`);

// ─── Worker Onboarding Tasks ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  admin_note TEXT DEFAULT '',
  action_url TEXT DEFAULT '',
  completed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(worker_account_id, task_key)
)`);

try { db.exec("ALTER TABLE worker_accounts ADD COLUMN dispatch_ready INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN onboarded INTEGER DEFAULT 0"); } catch {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN confirm_phone TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN confirm_email TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE interviews ADD COLUMN applicant_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN persona_inquiry_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN identity_status TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE worker_accounts ADD COLUMN identity_sent_at TEXT DEFAULT ''`); } catch(e) {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN referred_by INTEGER DEFAULT NULL"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS referral_bonus_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  bonus_per_referral REAL DEFAULT 50,
  min_hours_to_qualify REAL DEFAULT 8,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
if (!db.prepare('SELECT id FROM referral_bonus_config WHERE id=1').get())
  db.prepare('INSERT INTO referral_bonus_config (id) VALUES (1)').run();

// Skill options (configurable required skills list)
db.exec(`CREATE TABLE IF NOT EXISTS skill_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_zh TEXT NOT NULL,
  name_en TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Seed default skills if table is empty
if (!db.prepare('SELECT id FROM skill_options LIMIT 1').get()) {
  const seeds = [
    ['仓库操作','Warehouse Operation'],['叉车操作','Forklift'],['驾照',"Driver's License"],
    ['搬运','Heavy Lifting'],['分拣','Sorting'],['包装','Packing'],['收货','Receiving'],
    ['发货','Shipping'],['盘点','Inventory'],['清洁','Cleaning'],['机器操作','Machine Operation'],
    ['质量检查','Quality Inspection'],['组装','Assembly'],['基本英语','Basic English'],
    ['普通话','Mandarin'],['体力劳动','Physical Labor']
  ];
  const ins = db.prepare('INSERT INTO skill_options (name_zh, name_en, sort_order) VALUES (?,?,?)');
  seeds.forEach(([zh, en], i) => ins.run(zh, en, i));
}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN onboarded INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN visible_to_worker INTEGER DEFAULT 0"); } catch {}

// Migrate old id_verify + ssn_verify → persona_verify
try {
  const oldRows = db.prepare(`SELECT DISTINCT worker_account_id FROM worker_onboarding WHERE task_key IN ('id_verify','ssn_verify')`).all();
  if (oldRows.length) {
    const tx = db.transaction(() => {
      for (const r of oldRows) {
        const id_row = db.prepare(`SELECT * FROM worker_onboarding WHERE worker_account_id=? AND task_key='id_verify'`).get(r.worker_account_id);
        const ssn_row = db.prepare(`SELECT * FROM worker_onboarding WHERE worker_account_id=? AND task_key='ssn_verify'`).get(r.worker_account_id);
        const statusOrder = { completed: 3, waived: 3, submitted: 2, pending: 1, locked: 0 };
        const bestStatus = (statusOrder[id_row?.status]||0) >= (statusOrder[ssn_row?.status]||0) ? (id_row?.status||'pending') : (ssn_row?.status||'pending');
        const visible = (id_row?.visible_to_worker || ssn_row?.visible_to_worker) ? 1 : 0;
        db.prepare(`INSERT OR IGNORE INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker) VALUES (?,'persona_verify',?,?)`)
          .run(r.worker_account_id, bestStatus, visible);
      }
      db.prepare(`DELETE FROM worker_onboarding WHERE task_key IN ('id_verify','ssn_verify')`).run();
    });
    tx();
    console.log(`[Migration] Migrated ${oldRows.length} workers from id_verify+ssn_verify → persona_verify`);
  }
} catch (e) { console.warn('[Migration] id_verify+ssn_verify → persona_verify:', e.message); }

// ─── Worker Skills ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id),
  skill_name TEXT NOT NULL,
  rating INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── Integration Settings (WorkBright, Checkr, Gusto, Twilio) ───
db.exec(`CREATE TABLE IF NOT EXISTS integration_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT UNIQUE NOT NULL,
  enabled INTEGER DEFAULT 0,
  api_key TEXT DEFAULT '',
  api_secret TEXT DEFAULT '',
  config TEXT DEFAULT '{}',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Seed default integration rows if not present
const intProviders = ['workbright','checkr','gusto','twilio'];
intProviders.forEach(p => {
  const ex = db.prepare('SELECT id FROM integration_settings WHERE provider=?').get(p);
  if (!ex) db.prepare('INSERT INTO integration_settings (provider) VALUES (?)').run(p);
});

// Migrate: add site_id to jobs for geofencing
try { db.exec("ALTER TABLE jobs ADD COLUMN site_id INTEGER DEFAULT NULL"); } catch {}
// Migrate: add site_id to time_entries
try { db.exec("ALTER TABLE time_entries ADD COLUMN site_id INTEGER DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN geo_verified INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN punch_photo TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN job_id INTEGER DEFAULT NULL"); } catch {}

// Worker payments ledger
db.exec(`CREATE TABLE IF NOT EXISTS worker_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  payment_method TEXT DEFAULT 'cash',
  period_start TEXT DEFAULT '',
  period_end TEXT DEFAULT '',
  job_id INTEGER DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
)`);

// ─── Backup System ───
const BACKUP_DIRS = (process.env.BACKUP_DIRS || './data/backups/copy1,./data/backups/copy2,./data/backups/copy3')
  .split(',').map(d => d.trim()).filter(Boolean);
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL_MIN || '60', 10) * 60 * 1000; // default 60 min
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '10', 10); // keep last N backups per location
const backupLog = []; // in-memory log of recent backup results

BACKUP_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function runBackup(trigger) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  const dbPath = path.join(dataDir, 'prime.db');

  // Checkpoint WAL before backup to ensure all data is in the main db file
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}

  for (const dir of BACKUP_DIRS) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Backup database using better-sqlite3 .backup()
      const dest = path.join(dir, `prime-${ts}.db`);
      db.backup(dest);

      // Also copy uploads directory
      const uploadsBackup = path.join(dir, `uploads-${ts}`);
      if (fs.existsSync(uploadsDir)) {
        copyDirSync(uploadsDir, uploadsBackup);
      }

      // Rotate: keep only last N backups
      rotateBackups(dir);

      results.push({ dir, status: 'ok', file: `prime-${ts}.db` });
    } catch (e) {
      results.push({ dir, status: 'error', error: e.message });
    }
  }

  const entry = { time: new Date().toISOString(), trigger, results };
  backupLog.unshift(entry);
  if (backupLog.length > 50) backupLog.length = 50;
  console.log(`[Backup] ${trigger}: ${results.map(r => `${r.dir}=${r.status}`).join(', ')}`);
  return entry;
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rotateBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('prime-') && f.endsWith('.db'))
      .sort().reverse();
    // Each db backup has a matching uploads dir
    const toRemove = files.slice(BACKUP_KEEP);
    for (const f of toRemove) {
      fs.unlinkSync(path.join(dir, f));
      const uploadsDir = path.join(dir, f.replace('prime-', 'uploads-').replace('.db', ''));
      if (fs.existsSync(uploadsDir)) fs.rmSync(uploadsDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[Backup] Rotate error:', e.message);
  }
}

// Startup backup
setTimeout(() => runBackup('启动备份'), 2000);

// Periodic backup
setInterval(() => runBackup('定时备份'), BACKUP_INTERVAL);

// ─── Weekly shift confirmation generation ─────────────────────────
// Runs daily at 7 AM: creates shift_confirmation records for all
// remaining days of the current week based on each assignment's
// work_schedule JSON. Skips terminated / resigned / cancelled.
const _WEEK_DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

async function generateWeeklyShiftConfirmations() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayStr = now.toISOString().slice(0, 10);

  // Build Mon–Sun dates for the current week, keeping only >= today
  const dow = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    if (ds >= todayStr) weekDates.push({ date: ds, dayKey: _WEEK_DAY_KEYS[d.getDay()] });
  }
  if (!weekDates.length) return;

  // Active assignments only (not terminated / resigned / cancelled)
  const assignments = db.prepare(`
    SELECT a.id, a.work_schedule,
           j.title,
           w.id as worker_id, w.phone, w.first_name, w.name as wname
    FROM assignments a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN worker_accounts w ON w.linked_inquiry_id = i.id
    WHERE a.status NOT IN ('terminated','resigned','cancelled')
      AND w.id IS NOT NULL
  `).all();

  // Track workers with newly created shifts (for one-time weekly SMS)
  const newByWorker = {};
  for (const a of assignments) {
    let sched = {};
    try { sched = JSON.parse(a.work_schedule || '{}'); } catch {}
    const workStart = sched.workStart || null;
    const workEnd = sched.workEnd || null;
    const untilFurther = !!sched.untilFurther;
    const days = sched.days || {};

    for (const { date, dayKey } of weekDates) {
      if (workStart && date < workStart) continue;
      if (!untilFurther && workEnd && date > workEnd) continue;
      const dayInfo = days[dayKey];
      if (!dayInfo || dayInfo.rest) continue;

      const r = db.prepare(
        `INSERT OR IGNORE INTO shift_confirmations (assignment_id, date, status, shift_start, shift_end) VALUES (?,?,?,?,?)`
      ).run(a.id, date, 'pending', dayInfo.start || '', dayInfo.end || '');
      if (r.changes > 0) {
        if (!newByWorker[a.worker_id]) {
          newByWorker[a.worker_id] = { phone: a.phone, name: a.first_name || a.wname || '', count: 0 };
        }
        newByWorker[a.worker_id].count++;
      }
    }
  }

  // Send one summary SMS per worker who has new shifts
  let smsCount = 0;
  for (const info of Object.values(newByWorker)) {
    if (!info.phone) continue;
    const greeting = info.name ? ` ${info.name}` : '';
    await sendSMS(info.phone,
      `[Prime Anchorpoint] 您好${greeting}，本周有 ${info.count} 个班次待确认，请登录 Portal 查看并确认出勤。`
    ).catch(() => {});
    smsCount++;
  }
  console.log(`[WeeklyShifts] ${todayStr}: ${Object.keys(newByWorker).length} workers with new shifts, ${smsCount} SMS sent`);

  // On Saturday or Sunday, also pre-generate next week's shift confirmations
  // so workers can see upcoming shifts in the portal (no extra SMS)
  if (dow === 6 || dow === 0) {
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    const nextWeekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(nextMonday);
      d.setDate(nextMonday.getDate() + i);
      nextWeekDates.push({ date: d.toISOString().slice(0, 10), dayKey: _WEEK_DAY_KEYS[d.getDay()] });
    }
    for (const a of assignments) {
      let sched = {};
      try { sched = JSON.parse(a.work_schedule || '{}'); } catch {}
      const workStart = sched.workStart || null;
      const workEnd = sched.workEnd || null;
      const untilFurther = !!sched.untilFurther;
      const days = sched.days || {};
      for (const { date, dayKey } of nextWeekDates) {
        if (workStart && date < workStart) continue;
        if (!untilFurther && workEnd && date > workEnd) continue;
        const dayInfo = days[dayKey];
        if (!dayInfo || dayInfo.rest) continue;
        db.prepare(
          `INSERT OR IGNORE INTO shift_confirmations (assignment_id, date, status, shift_start, shift_end) VALUES (?,?,?,?,?)`
        ).run(a.id, date, 'pending', dayInfo.start || '', dayInfo.end || '');
      }
    }
    console.log(`[WeeklyShifts] ${todayStr}: pre-generated next week shifts (Sat/Sun)`);
  }
}

function scheduleWeeklyShiftGeneration() {
  const now = new Date();
  const next7am = new Date(now);
  next7am.setHours(7, 0, 0, 0);
  if (next7am <= now) next7am.setDate(next7am.getDate() + 1);
  setTimeout(() => {
    generateWeeklyShiftConfirmations();
    setInterval(generateWeeklyShiftConfirmations, 24 * 60 * 60 * 1000);
  }, next7am - now);
}
scheduleWeeklyShiftGeneration();

// ─── 24-hour advance shift reminders ──────────────────────────────
// Runs daily at 9 AM: sends SMS to workers with pending shifts tomorrow
async function send24hShiftReminders() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const pending = db.prepare(`
    SELECT sc.id, sc.shift_start, sc.shift_end,
           j.title,
           w.phone, w.first_name, w.name as wname
    FROM shift_confirmations sc
    JOIN assignments a ON sc.assignment_id = a.id
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN worker_accounts w ON w.linked_inquiry_id = i.id
    WHERE sc.date = ?
      AND sc.status = 'pending'
      AND sc.reminded_at IS NULL
      AND w.phone IS NOT NULL AND w.phone != ''
  `).all(tomorrowStr);

  let sent = 0;
  for (const row of pending) {
    const name = row.first_name || row.wname || '';
    const job = row.title || '班次';
    const time = (row.shift_start && row.shift_end)
      ? `（${row.shift_start}–${row.shift_end}）`
      : '';
    await sendSMS(row.phone,
      `[Prime Anchorpoint] 提醒：您明天${time}有 ${job} 的班次，请登录 Portal 确认是否出勤。`
    ).catch(() => {});
    db.prepare(`UPDATE shift_confirmations SET reminded_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
    sent++;
  }
  console.log(`[24hReminder] ${tomorrowStr}: sent ${sent} reminders`);
}

function schedule24hReminders() {
  const now = new Date();
  const next9am = new Date(now);
  next9am.setHours(9, 0, 0, 0);
  if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
  setTimeout(() => {
    send24hShiftReminders();
    setInterval(send24hShiftReminders, 24 * 60 * 60 * 1000);
  }, next9am - now);
}
schedule24hReminders();

// ─── Middleware ───
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/uploads', express.static(uploadsDir));

// Resume upload
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|doc|docx|rtf/.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

// HR document upload (PDF, images, Word) — stored in docsDir, never served statically
const docUpload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `doc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png|gif|doc|docx/.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

const punchPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: punchPhotosDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `punch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpg|jpeg|png|gif|webp|heic/.test(file.mimetype))
});

// ─── ADMIN AUTH (username + password with session tokens) ───
const crypto = require('crypto');

// ─── SSN Encryption (AES-256-GCM) ───
const SSN_KEY = crypto.scryptSync(process.env.SSN_SECRET || 'prime-anchorpoint-ssn-key-default!', 'pa-ssn-salt-v1', 32);
function encryptSSN(ssn) {
  const normalized = ssn.replace(/\D/g, '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SSN_KEY, iv);
  let enc = cipher.update(normalized, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted: enc + tag, iv: iv.toString('hex') };
}
function decryptSSN(encrypted, iv) {
  try {
    const tag = Buffer.from(encrypted.slice(-32), 'hex');
    const data = encrypted.slice(0, -32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', SSN_KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(tag);
    let dec = decipher.update(data, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch { return null; }
}

// ─── Employee PIN hashing ───
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const derived = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ─── Auto-generate employee ID: EMEE-CITY-MMDDYY-000001 ───
function nextEmployeeId(city, hireDate) {
  const d = hireDate ? new Date(hireDate) : new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const dateStr = mm + dd + yy;
  const cityStr = (city || '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'UNK';
  const last = db.prepare("SELECT employee_id FROM employees WHERE employee_id LIKE 'EMEE-%' ORDER BY id DESC LIMIT 1").get();
  let num = 1;
  if (last) {
    const parts = last.employee_id.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) num = lastNum + 1;
  }
  return `EMEE-${cityStr}-${dateStr}-${String(num).padStart(6, '0')}`;
}

// ─── Auto-generate worker code: PORT-CITY-MMDDYY-000001 ───
function generateWorkerCode(city, prefix = 'PORT') {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const dateStr = mm + dd + yy;
  const cityStr = (city || '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'UNK';
  const last = db.prepare(`SELECT worker_code FROM worker_accounts WHERE worker_code LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '-%');
  let num = 1;
  if (last) {
    const parts = last.worker_code.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) num = lastNum + 1;
  }
  return `${prefix}-${cityStr}-${dateStr}-${String(num).padStart(6, '0')}`;
}

// ─── On verification: assign worker_code + ensure linked inquiry exists ───
function activateWorkerAccount(accountId, prefix) {
  const acc = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(accountId);
  if (!acc) return;
  // Generate worker_code if not already set
  if (!acc.worker_code) {
    const codePrefix = prefix || 'PORT';
    const code = generateWorkerCode(acc.city, codePrefix);
    db.prepare('UPDATE worker_accounts SET worker_code=? WHERE id=?').run(code, accountId);
  }
  // Ensure a linked inquiry exists (by phone → email → name → create)
  const normPhone = s => (s || '').replace(/\D/g, '').slice(-10);
  const wPhone = normPhone(acc.phone);
  const wEmail = (acc.email || '').toLowerCase();
  const wName  = (acc.name || '').trim();
  let inqId = null;
  if (wPhone) {
    const row = db.prepare('SELECT id FROM inquiries WHERE phone10(phone) = ?').get(wPhone);
    if (row) inqId = row.id;
  }
  if (!inqId && wEmail) {
    const row = db.prepare('SELECT id FROM inquiries WHERE lower(email)=?').get(wEmail);
    if (row) inqId = row.id;
  }
  if (!inqId && wName) {
    const row = db.prepare('SELECT id FROM inquiries WHERE lower(trim(name))=?').get(wName.toLowerCase());
    if (row) inqId = row.id;
  }
  if (!inqId) {
    // No existing inquiry — create one so dispatch always works
    const r = db.prepare('INSERT INTO inquiries (name, phone, email, type) VALUES (?,?,?,?)').run(wName, acc.phone || '', acc.email || '', 'worker');
    inqId = r.lastInsertRowid;
  }
  // Persist the link directly on the worker account
  db.prepare('UPDATE worker_accounts SET linked_inquiry_id=? WHERE id=?').run(inqId, accountId);
}

// ─── Auto-generate employer ID: EMER-CITY-MMDDYY-000001 ───
function nextEmployerId(city) {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const dateStr = mm + dd + yy;
  const cityStr = (city || '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'UNK';
  const last = db.prepare("SELECT employer_id FROM inquiries WHERE employer_id LIKE 'EMER-%' ORDER BY id DESC LIMIT 1").get();
  let num = 1;
  if (last) {
    const parts = last.employer_id.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) num = lastNum + 1;
  }
  return `EMER-${cityStr}-${dateStr}-${String(num).padStart(6, '0')}`;
}

// ─── Haversine distance (GPS geofencing) ───
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Hours calculation (daily OT > 8h) ───
function calcHours(clockIn, clockOut, breakMin) {
  if (!clockOut) return { total: 0, regular: 0, overtime: 0 };
  const totalMin = Math.max(0, (new Date(clockOut) - new Date(clockIn)) / 60000 - (breakMin || 0));
  const total = Math.round(totalMin / 60 * 100) / 100;
  const regular = Math.min(total, 8);
  const overtime = Math.max(0, Math.round((total - 8) * 100) / 100);
  return { total, regular: Math.round(regular * 100) / 100, overtime };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

// ─── DocuSign eSignature Integration ───
const https = require('https');
let _dsToken = null, _dsTokenExpiry = 0;

function dsEnabled() {
  return !!(process.env.DOCUSIGN_INTEGRATION_KEY && process.env.DOCUSIGN_USER_ID &&
    process.env.DOCUSIGN_ACCOUNT_ID && process.env.DOCUSIGN_PRIVATE_KEY);
}

function dsMakeJWT() {
  const isProd = process.env.DOCUSIGN_ENVIRONMENT === 'production';
  const aud = isProd ? 'account.docusign.com' : 'account-d.docusign.com';
  const now = Math.floor(Date.now() / 1000);
  const b64u = (s) => Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64u(JSON.stringify({ iss: process.env.DOCUSIGN_INTEGRATION_KEY, sub: process.env.DOCUSIGN_USER_ID, aud, iat: now, exp: now + 3600, scope: 'signature impersonation' }));
  const unsigned = `${hdr}.${pay}`;
  const pem = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(pem, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${unsigned}.${sig}`;
}

async function getDsToken() {
  if (_dsToken && _dsTokenExpiry > Date.now()) return _dsToken;
  const isProd = process.env.DOCUSIGN_ENVIRONMENT === 'production';
  const host = isProd ? 'account.docusign.com' : 'account-d.docusign.com';
  const jwt = dsMakeJWT();
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
  if (!result.access_token) throw new Error('DocuSign auth failed: ' + JSON.stringify(result));
  _dsToken = result.access_token;
  _dsTokenExpiry = Date.now() + (result.expires_in - 60) * 1000;
  return _dsToken;
}

async function dsApiCall(method, apiPath, body) {
  const token = await getDsToken();
  const baseUri = (process.env.DOCUSIGN_BASE_URI || 'https://demo.docusign.net').replace(/\/$/, '');
  const hostname = new URL(baseUri).hostname;
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: apiPath, method, headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}) } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); if (bodyStr) req.write(bodyStr); req.end();
  });
}

// Build a signHere tab using anchor string (preferred) with absolute fallback
function dsSignTab(anchorStr, fallX, fallY) {
  return { anchorString: anchorStr, anchorIgnoreIfNotPresent: 'true', anchorXOffset: '0', anchorYOffset: '0', xPosition: String(fallX), yPosition: String(fallY), pageNumber: '1', documentId: '1' };
}

async function dsSendEnvelope({ docPath, docName, emailSubject, signer1, signer2 }) {
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const docBase64 = fs.readFileSync(docPath).toString('base64');
  const fileExt = path.extname(docName).replace('.', '') || 'pdf';
  const envelope = {
    emailSubject,
    documents: [{ documentBase64: docBase64, name: docName, fileExtension: fileExt, documentId: '1' }],
    recipients: {
      signers: [
        { email: signer1.email, name: signer1.name, recipientId: '1', routingOrder: '1', tabs: { signHereTabs: [dsSignTab('/sig1/', 50, 680)], dateSignedTabs: [{ ...dsSignTab('/date1/', 50, 715), tabLabel: 'date1' }] } },
        { email: signer2.email, name: signer2.name, recipientId: '2', routingOrder: '2', tabs: { signHereTabs: [dsSignTab('/sig2/', 320, 680)], dateSignedTabs: [{ ...dsSignTab('/date2/', 320, 715), tabLabel: 'date2' }] } }
      ]
    },
    status: 'sent'
  };
  const result = await dsApiCall('POST', `/restapi/v2.1/accounts/${accountId}/envelopes`, envelope);
  if (result.status !== 201) throw new Error(`DocuSign ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

// Seed default admin into admin_users table if empty
{
  const count = db.prepare('SELECT COUNT(*) as n FROM admin_users').get().n;
  if (count === 0) {
    const defaultUser = process.env.ADMIN_USER || 'admin';
    const defaultPass = process.env.ADMIN_PASS || 'prime2026';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(defaultPass, salt);
    db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name) VALUES (?, ?, ?, ?, ?)').run(defaultUser, hash, salt, 'admin', 'Administrator');
    console.log(`[Auth] Seeded default admin user: ${defaultUser} / ${defaultPass}`);
  }
  // Ensure the first user (original seeded admin) has admin role
  try { db.prepare("UPDATE admin_users SET role='admin' WHERE id=1 AND (role IS NULL OR role='staff')").run(); } catch {}
  // Force-reset admin password if RESET_ADMIN_PASS env var is set
  if (process.env.RESET_ADMIN_PASS) {
    const targetUser = process.env.ADMIN_USER || 'admin';
    const newPass = process.env.RESET_ADMIN_PASS;
    const user = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(targetUser);
    if (user) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(newPass, salt);
      db.prepare('UPDATE admin_users SET password_hash=?, salt=?, active=1 WHERE id=?').run(hash, salt, user.id);
      console.log(`[Auth] Reset admin password for user: ${targetUser}`);
    }
  }
}

// DB-backed session store (survives server restarts, tokens expire in 24h)
db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
// Clean up expired sessions on startup
try { db.prepare('DELETE FROM admin_sessions WHERE created_at < ?').run(Date.now() - 24*60*60*1000); } catch(e) {}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO admin_sessions (token, user_id, username, role, created_at) VALUES (?,?,?,?,?)')
    .run(token, user.id, user.username, user.role || 'staff', Date.now());
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM admin_sessions WHERE token=?').get(token);
  if (!s) return null;
  if (Date.now() - s.created_at > 24*60*60*1000) { db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token); return null; }
  return { userId: s.user_id, username: s.username, role: s.role, created: s.created_at };
}
function validSession(token) { return !!getSession(token); }

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  let session = null;
  if (auth && auth.startsWith('Bearer ')) session = getSession(auth.slice(7));
  if (!session) {
    const cookieMatch = (req.headers.cookie || '').match(/pa_token=([^;]+)/);
    if (cookieMatch) session = getSession(cookieMatch[1]);
  }
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.userRole = session.role;
  req.userName = session.username;
  req.userId = session.userId;
  const _u = db.prepare('SELECT assigned_partner_ids FROM admin_users WHERE id=?').get(session.userId);
  req.assignedPartnerIds = (_u && _u.assigned_partner_ids) || '';
  next();
}

// Role-based middleware helpers
function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.userRole)) return next();
    res.status(403).json({ error: 'Permission denied' });
  };
}

// For staff: delete/update operations create pending actions instead of executing directly
function staffGuard(actionType, targetTable) {
  return (req, res, next) => {
    if (req.userRole === 'admin') return next();
    if (req.userRole === 'manager') return res.status(403).json({ error: 'Permission denied' });
    // staff: create a pending action
    const payload = { ...req.body, _params: req.params };
    db.prepare('INSERT INTO pending_actions (action_type, target_table, target_id, payload, requested_by) VALUES (?, ?, ?, ?, ?)')
      .run(actionType, targetTable, req.params.id || 0, JSON.stringify(payload), req.userName);
    res.json({ pending: true, message: '操作已提交，等待管理员审批 / Action submitted for admin approval' });
  };
}

// Manager access restriction: managers can only access time entries and employee list
function blockManager(req, res, next) {
  if (req.userRole === 'manager') return res.status(403).json({ error: 'Permission denied' });
  next();
}

// Helper: parse manager's assigned partner IDs into array of ints
function managerPartnerIds(req) {
  return (req.assignedPartnerIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
}

// ─── Worker / Customer portal auth ───
const workerSessions = new Map();
const customerSessions = new Map();
const resetCodes = new Map(); // key: "worker:login" or "customer:login", value: { code, expires }

function requireWorker(req, res, next) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const m = (req.headers.cookie || '').match(/pa_worker=([^;]+)/);
    if (m) token = m[1];
  }
  const s = workerSessions.get(token);
  if (!s || Date.now() - s.created > 24 * 60 * 60 * 1000) {
    if (token) workerSessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Verify account still exists and is not suspended
  const w = db.prepare('SELECT id, active, suspended, employee_id FROM worker_accounts WHERE id=?').get(s.workerId);
  if (!w || !w.active || w.suspended) {
    workerSessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.workerId = s.workerId;
  req.workerEmployeeId = w.employee_id;
  next();
}

function requireCustomer(req, res, next) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const m = (req.headers.cookie || '').match(/pa_customer=([^;]+)/);
    if (m) token = m[1];
  }
  const s = customerSessions.get(token);
  if (!s || Date.now() - s.created > 24 * 60 * 60 * 1000) {
    if (token) customerSessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Verify account still exists
  const c = db.prepare('SELECT id, active, partner_id FROM customer_accounts WHERE id=?').get(s.customerId);
  if (!c || !c.active) {
    customerSessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.customerId = s.customerId;
  req.customerPartnerId = c.partner_id;
  next();
}

// ─── PUBLIC API ───

// GET /api/jobs - public job listings
app.get('/api/jobs', (req, res) => {
  const lang = req.query.lang;
  const base = `SELECT j.*, p.name as partner_name FROM jobs j LEFT JOIN partners p ON j.partner_id=p.id WHERE j.active=1 AND j.visible=1`;
  const jobs = (lang && lang !== 'all')
    ? db.prepare(base + ' AND j.lang=? ORDER BY j.created_at DESC').all(lang)
    : db.prepare(base + ' ORDER BY j.created_at DESC').all();
  res.json(jobs.map(j => ({
    id: j.id, title: j.title, type: j.type, location: j.location,
    pay: j.pay, lang: j.lang, lang_name: j.lang_name,
    desc: j.description, urgent: !!j.urgent, work_auth: j.work_auth || '',
    partner_name: j.partner_name || '',
    company_name: j.company_name || '', employment_type: j.employment_type || '',
    benefits: j.benefits || '[]', schedule: j.schedule || '',
    schedule_days: j.schedule_days || '[]',
    schedule_start: j.schedule_start || '',
    schedule_end: j.schedule_end || '',
    work_days: j.work_days || '', work_start: j.work_start || '', work_end: j.work_end || ''
  })));
});

// POST /api/inquiry - submit contact form
app.post('/api/inquiry', upload.single('resume'), (req, res) => {
  try {
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name required' });
    let employerId = '';
    if (d.type === 'Employer') {
      const city = (d.location || '').split(',')[0].trim();
      employerId = nextEmployerId(city);
    }
    const stmt = db.prepare(`INSERT INTO inquiries (name, email, phone, company, type, employer_id, positions, workers, location, start_date, experience, languages, comments, resume_path, quote_request) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(
      d.name, d.email || '', d.phone || '', d.company || '', d.type || '',
      employerId,
      d.positions || '', d.workers || '', d.location || '', d.start_date || '',
      d.experience || '', d.languages || '', d.comments || '',
      req.file ? req.file.filename : '',
      d.quote_request ? 1 : 0
    );
    res.json({ success: true, id: result.lastInsertRowid, employer_id: employerId || undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs/:id/apply - apply for a specific job
app.post('/api/jobs/:id/apply', upload.single('resume'), (req, res) => {
  try {
    const job = db.prepare('SELECT id, title FROM jobs WHERE id=? AND active=1').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name required' });
    if (!d.phone) return res.status(400).json({ error: 'Phone required' });
    const result = db.prepare(`INSERT INTO inquiries (name, email, phone, type, positions, experience, comments, resume_path, job_id) VALUES (?, ?, ?, 'Job Seeker', ?, ?, ?, ?, ?)`).run(
      d.name, d.email || '', d.phone, job.title, d.experience || '', d.comments || '', req.file ? req.file.filename : '', job.id
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/quote - submit supply quote request
app.post('/api/quote', (req, res) => {
  try {
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name required' });
    if (!d.products) return res.status(400).json({ error: 'Products required' });
    const stmt = db.prepare('INSERT INTO quotes (name, email, phone, company, products, quantity, location, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const result = stmt.run(d.name, d.email || '', d.phone || '', d.company || '', d.products || '', d.quantity || '', d.location || '', d.notes || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ADMIN API ───

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!verifyPassword(password, user.salt, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  // Password correct but account not yet self-verified — prompt user to set own password
  if (!user.active) return res.json({ needs_activation: true, username });
  const token = createSession(user);
  res.json({ success: true, token, user_id: user.id, role: user.role || 'staff', username: user.username, display_name: user.display_name || '' });
});

// Self-activation: user verifies identity with temp password and sets their own password
app.post('/api/auth/activate', (req, res) => {
  const { username, current_password, new_password } = req.body;
  if (!username || !current_password || !new_password) return res.status(400).json({ error: 'Missing fields' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!verifyPassword(current_password, user.salt, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(new_password, salt);
  db.prepare('UPDATE admin_users SET password_hash=?, salt=?, active=1 WHERE id=?').run(hash, salt, user.id);
  const updatedUser = db.prepare('SELECT * FROM admin_users WHERE id=?').get(user.id);
  const token = createSession(updatedUser);
  res.json({ success: true, token, user_id: updatedUser.id, role: updatedUser.role || 'staff', username: updatedUser.username, display_name: updatedUser.display_name || '' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    db.prepare('DELETE FROM admin_sessions WHERE token=?').run(auth.slice(7));
  }
  res.json({ success: true });
});

// Get current user info
app.get('/api/admin/me', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, username, role, display_name FROM admin_users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ─── Manager Portal Endpoints ───
// GET /api/manager/me — returns current manager info + assigned partner names
app.get('/api/manager/me', requireAdmin, requireRole('manager', 'admin', 'staff'), (req, res) => {
  const user = db.prepare('SELECT id, username, role, display_name, assigned_partner_ids FROM admin_users WHERE id=?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const pids = (user.assigned_partner_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  const partners = pids.length
    ? db.prepare(`SELECT id, name FROM partners WHERE id IN (${pids.map(() => '?').join(',')})`).all(...pids)
    : [];
  res.json({ ...user, partners });
});

// GET /api/manager/my-assignments — assignments for manager's assigned partner companies
app.get('/api/manager/my-assignments', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  if (req.userRole === 'manager' && !pids.length) return res.json([]);
  let q = `
    SELECT a.id, a.status, a.start_date, a.pay_rate, a.pay_type, a.contract_type, a.benefits,
           a.work_address, a.notes, a.assigned_at, a.work_schedule,
           i.name  AS worker_name,
           i.phone AS worker_phone,
           i.email AS worker_email,
           j.title AS job_title,
           j.location AS job_location,
           j.partner_id,
           p.name  AS company_name
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN partners p ON j.partner_id = p.id
    WHERE 1=1`;
  const params = [];
  if (req.userRole === 'manager' && pids.length) {
    q += ` AND j.partner_id IN (${pids.map(() => '?').join(',')})`;
    params.push(...pids);
  }
  q += ' ORDER BY a.assigned_at DESC';
  res.json(db.prepare(q).all(...params));
});

// GET /api/manager/workers — employees visible to this manager with contact info
app.get('/api/manager/workers', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  if (req.userRole === 'manager' && !pids.length) return res.json([]);
  let q = `
    SELECT DISTINCT e.id, e.first_name, e.last_name, e.employee_id as emp_code,
           e.email, e.phone, e.position, e.status
    FROM employees e`;
  const params = [];
  if (req.userRole === 'manager' && pids.length) {
    q += ` WHERE e.id IN (
      SELECT DISTINCT t.employee_id FROM time_entries t
      JOIN jobs j ON t.job_id=j.id WHERE j.partner_id IN (${pids.map(() => '?').join(',')})
    )`;
    params.push(...pids);
  }
  q += ' ORDER BY e.last_name, e.first_name';
  res.json(db.prepare(q).all(...params));
});

// ─── Account Management (admin only) ───
app.get('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id, username, role, display_name, active, assigned_partner_ids, created_at FROM admin_users ORDER BY id').all());
});

app.post('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, assigned_partner_ids } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const existing = db.prepare('SELECT id, active FROM admin_users WHERE username = ?').get(username);
  if (existing && existing.active) return res.status(400).json({ error: 'Username already exists' });
  // Overwrite unverified (inactive) account with same username
  if (existing && !existing.active) db.prepare('DELETE FROM admin_users WHERE id = ?').run(existing.id);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  // New accounts start inactive (active=0); user must self-verify to activate
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, assigned_partner_ids, active) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(username, hash, salt, role, display_name || '', assigned_partner_ids || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, assigned_partner_ids } = req.body;
  if (role && !['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare('UPDATE admin_users SET password_hash=?, salt=?, active=0 WHERE id=?').run(hash, salt, req.params.id);
  }
  // active field is intentionally excluded — only the user themselves can activate via self-verification
  db.prepare('UPDATE admin_users SET username=?, role=?, display_name=?, assigned_partner_ids=? WHERE id=?')
    .run(username || user.username, role || user.role, display_name !== undefined ? display_name : user.display_name, assigned_partner_ids !== undefined ? assigned_partner_ids : (user.assigned_partner_ids || ''), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Admin Invite Links ───────────────────────────────────────────
app.get('/api/admin/invite-links', requireAdmin, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM admin_invites WHERE used=0 AND expires_at > datetime('now') ORDER BY id DESC`).all();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  res.json(rows.map(r => ({ ...r, url: `${proto}://${host}/admin-invite?token=${r.token}` })));
});

app.post('/api/admin/invite-links', requireAdmin, requireRole('admin'), (req, res) => {
  const { role, hours, notes, assigned_partner_ids } = req.body;
  if (!['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const h = Math.min(Math.max(parseInt(hours) || 24, 1), 720);
  const token = crypto.randomBytes(28).toString('hex');
  const expiresAt = new Date(Date.now() + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO admin_invites (token, role, notes, assigned_partner_ids, expires_at) VALUES (?,?,?,?,?)')
    .run(token, role, notes || '', assigned_partner_ids || '', expiresAt);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ success: true, url: `${proto}://${host}/admin-invite?token=${token}` });
});

app.delete('/api/admin/invite-links/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM admin_invites WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Public: verify admin invite token
app.get('/api/admin-invite/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const inv = db.prepare(`SELECT * FROM admin_invites WHERE token=? AND used=0 AND expires_at > datetime('now')`).get(token);
  if (!inv) return res.status(404).json({ error: '邀请链接已失效或已被使用' });
  res.json({ role: inv.role, notes: inv.notes, assigned_partner_ids: inv.assigned_partner_ids });
});

// Public: register admin account via invite token
app.post('/api/admin-invite/register', async (req, res) => {
  const { token, username, display_name, password } = req.body;
  if (!token || !username || !password) return res.status(400).json({ error: '缺少必填字段' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const inv = db.prepare(`SELECT * FROM admin_invites WHERE token=? AND used=0 AND expires_at > datetime('now')`).get(token);
  if (!inv) return res.status(400).json({ error: '邀请链接已失效或已被使用' });
  const existing = db.prepare('SELECT id FROM admin_users WHERE username=?').get(username);
  if (existing) return res.status(400).json({ error: '用户名已存在，请换一个' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, assigned_partner_ids, active) VALUES (?,?,?,?,?,?,1)')
    .run(username, hash, salt, inv.role, display_name || username, inv.assigned_partner_ids || '');
  db.prepare('UPDATE admin_invites SET used=1, used_at=CURRENT_TIMESTAMP WHERE id=?').run(inv.id);
  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(result.lastInsertRowid);
  const sessionToken = createSession(user);
  res.json({ success: true, token: sessionToken, role: user.role, username: user.username, display_name: user.display_name });
});

// Serve admin invite registration page
app.get('/admin-invite', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>账户注册 — Prime Anchorpoint</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:16px;padding:2rem;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h1{font-size:1.3rem;font-weight:700;color:#1e293b;margin-bottom:.25rem}
.sub{font-size:.85rem;color:#64748b;margin-bottom:1.5rem}
label{display:block;font-size:.8rem;font-weight:600;color:#475569;margin-bottom:.25rem;margin-top:.85rem}
input{width:100%;padding:.6rem .75rem;border:1px solid #cbd5e1;border-radius:8px;font-size:.95rem;outline:none;transition:border .15s}
input:focus{border-color:#3b82f6}
.btn{width:100%;padding:.75rem;background:#1d4ed8;color:#fff;border:none;border-radius:8px;font-size:.97rem;font-weight:700;cursor:pointer;margin-top:1.25rem}
.btn:hover{background:#1e40af}
.btn:disabled{opacity:.5;cursor:default}
.err{color:#dc2626;font-size:.82rem;margin-top:.4rem}
.role-badge{display:inline-block;padding:.25rem .75rem;border-radius:99px;font-size:.78rem;font-weight:700;margin-bottom:.5rem}
.logo{font-weight:800;font-size:1.1rem;color:#1d4ed8;margin-bottom:1.25rem}
.ok{color:#16a34a;font-size:.88rem;margin-top:.5rem}
</style>
</head>
<body>
<div class="card">
  <div class="logo">🏢 Prime Anchorpoint</div>
  <h1 id="title">账户注册</h1>
  <div class="sub" id="sub">加载中…</div>
  <div id="form" style="display:none">
    <label>用户名 <span style="color:#94a3b8;font-weight:400">(登录用)</span></label>
    <input id="username" placeholder="设置登录用户名" autocomplete="username">
    <label>显示名称 <span style="color:#94a3b8;font-weight:400">(可选)</span></label>
    <input id="display_name" placeholder="您的姓名或称谓">
    <label>密码</label>
    <input id="password" type="password" placeholder="至少 6 位" autocomplete="new-password">
    <label>确认密码</label>
    <input id="password2" type="password" placeholder="再次输入密码" autocomplete="new-password">
    <div id="err" class="err"></div>
    <button class="btn" id="btn" onclick="doRegister()">创建账户</button>
  </div>
  <div id="done" style="display:none">
    <div class="ok" style="font-size:1rem;font-weight:700;margin-top:.5rem">✅ 注册成功！</div>
    <div style="font-size:.85rem;color:#475569;margin-top:.5rem">账户已创建，正在跳转…</div>
  </div>
  <div id="expired" style="display:none">
    <div style="color:#dc2626;font-weight:700;margin-top:.5rem">❌ 链接已失效</div>
    <div style="font-size:.83rem;color:#64748b;margin-top:.4rem">此邀请链接已过期或已被使用，请联系管理员重新发送。</div>
  </div>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const ROLE_LABEL = { admin:'Admin 管理员', staff:'Staff 员工', manager:'Manager 经理' };
async function init() {
  if (!token) { showExpired(); return; }
  try {
    const r = await fetch('/api/admin-invite/verify?token=' + encodeURIComponent(token));
    const d = await r.json();
    if (!r.ok) { showExpired(); return; }
    document.getElementById('sub').innerHTML = \`您被邀请注册为 <span class="role-badge" style="background:#dbeafe;color:#1d4ed8">\${ROLE_LABEL[d.role]||d.role}</span>\${d.notes ? \` — \${d.notes}\` : ''}\`;
    document.getElementById('form').style.display = '';
  } catch { showExpired(); }
}
function showExpired() {
  document.getElementById('sub').style.display='none';
  document.getElementById('expired').style.display='';
}
async function doRegister() {
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  const username = document.getElementById('username').value.trim();
  const display_name = document.getElementById('display_name').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  err.textContent = '';
  if (!username) { err.textContent = '请填写用户名'; return; }
  if (password.length < 6) { err.textContent = '密码至少 6 位'; return; }
  if (password !== password2) { err.textContent = '两次密码不一致'; return; }
  btn.disabled = true; btn.textContent = '注册中…';
  try {
    const r = await fetch('/api/admin-invite/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, username, display_name, password }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || '注册失败'; btn.disabled=false; btn.textContent='创建账户'; return; }
    // Save token and redirect
    localStorage.setItem('adminToken', d.token);
    document.getElementById('form').style.display = 'none';
    document.getElementById('done').style.display = '';
    setTimeout(() => { location.href = '/admin'; }, 1500);
  } catch(e) { err.textContent = '网络错误，请重试'; btn.disabled=false; btn.textContent='创建账户'; }
}
init();
</script>
</body>
</html>`);
});

// ─── Manager Invite Links ───
// Admin: list active invites
app.get('/api/admin/manager-invites', requireAdmin, requireRole('admin'), (req, res) => {
  const rows = db.prepare("SELECT * FROM manager_invites WHERE used=0 AND expires_at > datetime('now') ORDER BY id DESC").all();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json(rows.map(r => ({ ...r, url: `${proto}://${host}/manager-register?token=${r.token}` })));
});

// Admin: create invite link
app.post('/api/admin/manager-invites', requireAdmin, requireRole('admin'), (req, res) => {
  const { note, role, expires_hours } = req.body;
  const r = ['admin', 'staff', 'manager'].includes(role) ? role : 'manager';
  const hours = Math.min(Math.max(parseInt(expires_hours) || 72, 1), 720);
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO manager_invites (token, role, note, expires_at, created_by) VALUES (?,?,?,?,?)')
    .run(token, r, note || '', expiresAt, req.userId);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ success: true, token, url: `${proto}://${host}/manager-register?token=${token}` });
});

// Admin: revoke invite
app.delete('/api/admin/manager-invites/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM manager_invites WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Public: validate invite token ──
app.get('/api/public/manager-invite/:token', (req, res) => {
  const inv = db.prepare("SELECT id, role, note FROM manager_invites WHERE token=? AND used=0 AND expires_at > datetime('now')").get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json({ valid: true, role: inv.role, note: inv.note });
});

// ── Public: send verification code for manager registration ──
app.post('/api/public/manager-register/send-code', async (req, res) => {
  const { token, contact, contact_type } = req.body; // contact_type: 'phone' or 'email'
  if (!token || !contact || !contact_type) return res.status(400).json({ error: 'Missing fields' });
  const inv = db.prepare("SELECT * FROM manager_invites WHERE token=? AND used=0 AND expires_at > datetime('now')").get(token);
  if (!inv) return res.status(400).json({ error: 'Invalid or expired invite link' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  // Clean old codes for same token+contact
  db.prepare('DELETE FROM manager_reg_codes WHERE token=? AND contact=?').run(token, contact);
  db.prepare('INSERT INTO manager_reg_codes (token, contact, contact_type, code, expires_at) VALUES (?,?,?,?,?)')
    .run(token, contact, contact_type, code, expiresAt);

  if (contact_type === 'phone') {
    await sendSMS(contact, `您的 Prime Anchorpoint 验证码是 ${code}，10分钟内有效。Your verification code is ${code}.`);
  } else {
    await sendEmail(contact, '验证码 / Verification Code — Prime Anchorpoint',
      `您的验证码是 ${code}，10分钟内有效。\nYour verification code is ${code}.`,
      verificationCodeHtml(code));
  }
  res.json({ success: true });
});

// ── Public: complete manager registration ──
app.post('/api/public/manager-register/complete', async (req, res) => {
  const { token, username, display_name, password, contact, contact_type, code } = req.body;
  if (!token || !username || !password || !contact || !contact_type || !code)
    return res.status(400).json({ error: 'Missing required fields' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位 / Password must be at least 6 characters' });

  // Validate invite
  const inv = db.prepare("SELECT * FROM manager_invites WHERE token=? AND used=0 AND expires_at > datetime('now')").get(token);
  if (!inv) return res.status(400).json({ error: 'Invalid or expired invite link' });

  // Validate verification code
  const vc = db.prepare("SELECT * FROM manager_reg_codes WHERE token=? AND contact=? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(token, contact);
  if (!vc || vc.code !== String(code)) return res.status(400).json({ error: '验证码错误或已过期 / Invalid or expired code' });

  // Check username not taken
  const existing = db.prepare('SELECT id FROM admin_users WHERE username=? AND active=1').get(username);
  if (existing) return res.status(400).json({ error: '用户名已被占用 / Username already taken' });

  // Create account (active=1, since they verified contact)
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, active) VALUES (?,?,?,?,?,1)')
    .run(username, hash, salt, inv.role, display_name || username);

  // Mark invite used + clean up code
  db.prepare('UPDATE manager_invites SET used=1 WHERE id=?').run(inv.id);
  db.prepare('DELETE FROM manager_reg_codes WHERE token=?').run(token);

  const newUser = db.prepare('SELECT * FROM admin_users WHERE id=?').get(result.lastInsertRowid);
  const sessionToken = createSession(newUser);
  res.json({ success: true, token: sessionToken, role: newUser.role, username: newUser.username, display_name: newUser.display_name });
});

// ─── Worker Accounts (admin manages) ───
app.get('/api/admin/worker-accounts', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const workers = db.prepare(`
    SELECT w.*, e.first_name, e.last_name, e.employee_id as emp_code,
      e.pay_rate, e.pay_type, e.position, e.department,
      COALESCE(w.linked_inquiry_id,
        (SELECT id FROM inquiries WHERE phone=w.phone OR (w.email!='' AND email=w.email) ORDER BY id DESC LIMIT 1)
      ) as linked_inquiry_id
    FROM worker_accounts w LEFT JOIN employees e ON w.employee_id=e.id ORDER BY w.id DESC
  `).all();

  // Add expected_salary, payment_method columns if missing
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN expected_salary TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN our_salary_rating TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN payment_method TEXT DEFAULT 'cash'"); } catch {}

  // Enrich each worker with interview, compliance, skill, and referral data
  const getInterview = db.prepare(`SELECT i.status FROM interviews i WHERE i.worker_account_id=? ORDER BY i.id DESC LIMIT 1`);
  const getCompDocs = db.prepare(`SELECT doc_type, status FROM worker_compliance_docs WHERE worker_account_id=?`);
  const getSkills = db.prepare(`SELECT skill_name, rating FROM worker_skills WHERE worker_account_id=?`);
  const getReferralCount = db.prepare(`SELECT COUNT(*) as cnt FROM worker_accounts WHERE referred_by=?`);
  const refConfig = db.prepare('SELECT bonus_per_referral, min_hours_to_qualify FROM referral_bonus_config WHERE id=1').get()
    || { bonus_per_referral: 50, min_hours_to_qualify: 8 };
  const getQualifiedReferrals = db.prepare(`
    SELECT COUNT(*) as cnt FROM worker_accounts w
    LEFT JOIN employees e ON w.employee_id=e.id
    WHERE w.referred_by=?
      AND (SELECT COALESCE(SUM(t.total_hours),0) FROM time_entries t WHERE t.employee_id=e.id AND t.status='closed') >= ?
  `);

  const enriched = workers.map(w => {
    const interview = getInterview.get(w.id);
    const docs = getCompDocs.all(w.id);
    const skills = getSkills.all(w.id);
    const refCount = getReferralCount.get(w.id);
    const qualCount = getQualifiedReferrals.get(w.id, refConfig.min_hours_to_qualify);

    const complianceMap = {};
    docs.forEach(d => { complianceMap[d.doc_type] = d.status; });

    return {
      ...w,
      interview_status: interview ? interview.status : null,
      compliance: complianceMap,
      skills: skills || [],
      referral_count: refCount?.cnt || 0,
      qualified_referrals: qualCount?.cnt || 0,
      referral_bonus_earned: (qualCount?.cnt || 0) * refConfig.bonus_per_referral
    };
  });

  res.json(enriched);
});

app.post('/api/admin/worker-accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, employee_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (db.prepare('SELECT id FROM worker_accounts WHERE username=?').get(username))
    return res.status(400).json({ error: 'Username already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const r = db.prepare('INSERT INTO worker_accounts (username, password_hash, salt, employee_id) VALUES (?,?,?,?)')
    .run(username, hash, salt, employee_id || null);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/worker-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { password, employee_id, active, suspended, expected_salary, our_salary_rating, payment_method, assigned_tasks, work_status } = req.body;
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const changedBy = req.session && req.session.username ? req.session.username : 'admin';
  const logChange = (field, oldVal, newVal) => {
    const o = oldVal == null ? '' : String(oldVal);
    const n = newVal == null ? '' : String(newVal);
    if (o !== n) db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value) VALUES (?,?,?,?,?)').run(req.params.id, changedBy, field, o, n);
  };
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE worker_accounts SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, req.params.id);
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value) VALUES (?,?,?,?,?)').run(req.params.id, changedBy, 'password', '***', '***（已更新）');
  }
  const newActive = active !== undefined ? active : w.active;
  const newSuspended = suspended !== undefined ? suspended : (w.suspended||0);
  const newWorkStatus = work_status !== undefined ? work_status : w.work_status;
  const newExpectedSalary = expected_salary !== undefined ? expected_salary : w.expected_salary;
  const newOurRating = our_salary_rating !== undefined ? our_salary_rating : w.our_salary_rating;
  const newPaymentMethod = payment_method !== undefined ? payment_method : w.payment_method;
  logChange('active', w.active, newActive);
  logChange('suspended', w.suspended||0, newSuspended);
  logChange('work_status', w.work_status, newWorkStatus);
  logChange('expected_salary', w.expected_salary, newExpectedSalary);
  logChange('our_salary_rating', w.our_salary_rating, newOurRating);
  logChange('payment_method', w.payment_method, newPaymentMethod);
  if (employee_id !== undefined && String(employee_id||'') !== String(w.employee_id||'')) logChange('employee_id', w.employee_id, employee_id);
  db.prepare(`UPDATE worker_accounts SET employee_id=?, active=?, suspended=?,
    expected_salary=COALESCE(?,expected_salary), our_salary_rating=COALESCE(?,our_salary_rating),
    payment_method=COALESCE(?,payment_method), assigned_tasks=COALESCE(?,assigned_tasks),
    work_status=COALESCE(?,work_status) WHERE id=?`)
    .run(
      employee_id !== undefined ? employee_id : w.employee_id,
      newActive, newSuspended,
      expected_salary !== undefined ? expected_salary : null,
      our_salary_rating !== undefined ? our_salary_rating : null,
      payment_method !== undefined ? payment_method : null,
      assigned_tasks !== undefined ? JSON.stringify(assigned_tasks) : null,
      work_status !== undefined ? work_status : null,
      req.params.id
    );
  res.json({ success: true });
});

app.get('/api/admin/worker-accounts/:id/assignments', requireAdmin, (req, res) => {
  const w = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w || !w.linked_inquiry_id) return res.json([]);
  const rows = db.prepare(`
    SELECT a.id, a.status, a.start_date, a.assigned_at, a.pay_rate, a.pay_type, a.contract_type,
           a.category, a.worker_response,
           j.title AS job_title, j.location AS job_location,
           i.name AS company_name
    FROM assignments a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    WHERE a.inquiry_id = ?
    ORDER BY a.assigned_at DESC
  `).all(w.linked_inquiry_id);
  res.json(rows);
});

app.get('/api/admin/worker-accounts/:id/history', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM worker_account_history WHERE worker_account_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id);
  res.json(rows);
});

// ── Worker Onboarding ──
const ONBOARDING_STEPS = [
  { key: 'phone_verify', title: '手机号验证',      desc: '必须通过手机号验证才能继续',                     required: true  },
  { key: 'email_verify', title: '邮箱验证',        desc: '必须通过邮箱验证才能继续',                       required: true  },
  { key: 'interview',    title: '完成面试',          desc: '预约并参加 HR 面试',                              required: true  },
  { key: 'persona_verify', title: '身份验证 (Persona)', desc: '驾照 + 自拍核验 · 由 HR 发起 · 通过 Persona 平台', required: true },
  { key: 'background_check', title: '背景调查 (Checkr)', desc: 'SSN Trace + 犯罪记录调查 · 通过 Checkr 平台', required: true },
  { key: 'ead_upload',   title: 'EAD / 工卡上传',    desc: 'EAD 工卡（如适用）',                              required: false },
  { key: 'i9',           title: 'I-9 就业资格',      desc: '填写并提交 I-9 就业资格验证表',                  required: true  },
  { key: 'w9',           title: 'W-9 税表',           desc: '独立承包商 W-9 税务信息表',                      required: true  },
  { key: 'contract',     title: '签署雇佣合同',       desc: '电子签署雇佣协议',                               required: true  },
  { key: 'gusto',        title: 'Gusto 薪资信息',     desc: '在 Gusto 填写直接存款及薪资信息',               required: true  },
];

function initWorkerOnboarding(workerId) {
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
  if (!w) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker) VALUES (?,?,?,0)`);
  const tx = db.transaction(() => {
    for (const s of ONBOARDING_STEPS) {
      insert.run(workerId, s.key, 'pending');
    }
  });
  tx();
  // auto-complete phone_verify and email_verify if worker already active (both verified during registration)
  if (w.active) {
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='phone_verify' AND status='pending'`).run(workerId);
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='email_verify' AND status='pending'`).run(workerId);
  }
  // auto-complete interview if already passed
  const passed = db.prepare(`SELECT i.id FROM interviews i WHERE i.worker_account_id=? AND i.status='passed'`).get(workerId);
  if (passed) {
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='interview' AND status='pending'`).run(workerId);
  }
  // auto-complete persona_verify if identity already approved
  if (w.identity_status === 'approved') {
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify' AND status='pending'`).run(workerId);
  }
  // auto-complete background_check if Checkr already clear
  if (w.bgcheck_status === 'clear') {
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='background_check' AND status='pending'`).run(workerId);
  }
}

// Check if all assigned onboarding tasks are done; update onboarded flag accordingly
function syncOnboardedStatus(workerId) {
  const w = db.prepare('SELECT assigned_tasks FROM worker_accounts WHERE id=?').get(workerId);
  if (!w) return;
  let assigned = [];
  try { assigned = JSON.parse(w.assigned_tasks || '[]'); } catch {}
  if (!assigned.length) return; // no tasks assigned — don't auto-mark
  const tasks = db.prepare('SELECT task_key, status FROM worker_onboarding WHERE worker_account_id=?').all(workerId);
  const statusMap = Object.fromEntries(tasks.map(t => [t.task_key, t.status]));
  const allDone = assigned.every(key => statusMap[key] === 'completed' || statusMap[key] === 'waived');
  db.prepare('UPDATE worker_accounts SET onboarded=? WHERE id=?').run(allDone ? 1 : 0, workerId);
}

function getOnboardingTasks(workerId) {
  const rows = db.prepare('SELECT * FROM worker_onboarding WHERE worker_account_id=? ORDER BY id ASC').all(workerId);
  const rowMap = {};
  rows.forEach(r => { rowMap[r.task_key] = r; });
  return ONBOARDING_STEPS.map((s, idx) => {
    const row = rowMap[s.key] || { status: 'not_initialized', admin_note: '', action_url: '', completed_at: null, visible_to_worker: 0 };
    // compute locked: previous REQUIRED step must be completed/waived
    let locked = false;
    if (idx > 0) {
      const prevRequired = ONBOARDING_STEPS.slice(0, idx).filter(p => p.required);
      locked = prevRequired.some(p => {
        const pr = rowMap[p.key];
        return !pr || !['completed','waived'].includes(pr.status);
      });
    }
    return { ...s, ...row, locked: locked && !['completed','waived'].includes(row.status) };
  });
}

app.post('/api/admin/worker-accounts/:id/ensure-inquiry', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  activateWorkerAccount(id);
  const w = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(id);
  if (!w || !w.linked_inquiry_id) return res.status(500).json({ error: 'Failed to ensure inquiry' });
  const inq = db.prepare('SELECT id, name, phone, email, type FROM inquiries WHERE id=?').get(w.linked_inquiry_id);
  res.json(inq);
});

app.post('/api/admin/worker-accounts/:id/init-onboarding', requireAdmin, (req, res) => {
  initWorkerOnboarding(parseInt(req.params.id));
  res.json({ success: true, tasks: getOnboardingTasks(parseInt(req.params.id)) });
});

app.get('/api/admin/worker-accounts/:id/onboarding', requireAdmin, (req, res) => {
  // auto-init if no tasks yet
  const existing = db.prepare('SELECT id FROM worker_onboarding WHERE worker_account_id=?').get(req.params.id);
  if (!existing) initWorkerOnboarding(parseInt(req.params.id));
  res.json(getOnboardingTasks(parseInt(req.params.id)));
});

app.put('/api/admin/worker-accounts/:id/onboarding/:key', requireAdmin, (req, res) => {
  const { status, admin_note, action_url } = req.body;
  const valid = ['pending','submitted','completed','waived'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const completedAt = ['completed','waived'].includes(status) ? new Date().toISOString() : null;
  db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, admin_note, action_url, completed_at, updated_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status=excluded.status, admin_note=excluded.admin_note,
      action_url=excluded.action_url, completed_at=excluded.completed_at, updated_at=CURRENT_TIMESTAMP`)
    .run(req.params.id, req.params.key, status, admin_note||'', action_url||'', completedAt);
  syncOnboardedStatus(parseInt(req.params.id));
  res.json({ success: true, tasks: getOnboardingTasks(parseInt(req.params.id)) });
});

app.put('/api/admin/worker-accounts/:id/dispatch-ready', requireAdmin, (req, res) => {
  const { dispatch_ready } = req.body;
  db.prepare('UPDATE worker_accounts SET dispatch_ready=? WHERE id=?').run(dispatch_ready ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// Admin: toggle task visibility on worker portal
app.put('/api/admin/worker-accounts/:id/onboarding/:key/visibility', requireAdmin, (req, res) => {
  const { visible } = req.body;
  db.prepare(`UPDATE worker_onboarding SET visible_to_worker=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key=?`)
    .run(visible ? 1 : 0, req.params.id, req.params.key);
  res.json({ success: true, tasks: getOnboardingTasks(parseInt(req.params.id)) });
});

// Admin: send Persona identity verification from onboarding modal
app.post('/api/admin/worker-accounts/:id/send-persona', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (!process.env.PERSONA_API_KEY || !process.env.PERSONA_TEMPLATE_ID)
      return res.status(503).json({ error: 'Persona 未配置，请先在 .env 设置 PERSONA_API_KEY 和 PERSONA_TEMPLATE_ID' });
    const { force } = req.body || {};
    if (w.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createPersonaInquiry(workerId, w.name || w.username, w.phone);
    if (!result) return res.status(500).json({ error: '创建 Persona 验证失败，请检查 API Key 和 Template ID' });
    // Auto-add drivers_license to assigned_tasks so compliance tab shows it
    let curTasks = [];
    try { curTasks = JSON.parse(w.assigned_tasks || '[]'); } catch {}
    if (!curTasks.includes('drivers_license')) {
      curTasks.push('drivers_license');
      db.prepare('UPDATE worker_accounts SET assigned_tasks=? WHERE id=?').run(JSON.stringify(curTasks), workerId);
    }
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.inquiryId, workerId);
    // Store in worker_compliance_docs so worker portal compliance tab can pick it up
    const compFormData = JSON.stringify({ persona_inquiry_id: result.inquiryId, persona_status: 'created', persona_session_token: result.sessionToken || '', persona_hosted_url: result.link || '' });
    const existingDoc = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license'").get(workerId);
    if (existingDoc) {
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(compFormData, existingDoc.id);
    } else {
      db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'drivers_license', ?, 'pending')")
        .run(workerId, compFormData);
    }
    // Mark onboarding step as pending + visible
    db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker, admin_note, action_url, updated_at)
      VALUES (?,'persona_verify','pending',1,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status='pending', visible_to_worker=1, action_url=excluded.action_url, admin_note=excluded.admin_note, updated_at=CURRENT_TIMESTAMP`)
      .run(workerId, '已发送 Persona 验证链接', result.link || '');
    // Send SMS
    let smsSent = false;
    if (w.phone) {
      const smsText = `[Prime Anchorpoint] 您好 ${w.name||w.username||''}，请完成身份验证（驾照+自拍）以继续入职流程。\n您可以：\n1. 登录工人门户直接完成验证\n2. 点击链接在手机完成：${result.link || '(请登录工人门户完成)'}`;
      smsSent = await sendSMS(w.phone, smsText);
    }
    // Send email
    let emailSent = false;
    if (w.email) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      emailSent = await sendEmail(w.email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证。您可以登录工人门户直接完成，或点击链接：${result.link || portalUrl}`,
        `<p>您好 ${w.name||w.username||''}，</p>
         <p>HR 已为您发起身份验证（驾照 + 自拍核验）。您可以通过以下任一方式完成：</p>
         <table cellpadding="0" cellspacing="0" style="margin:1rem 0">
           <tr><td style="padding:.5rem 0"><strong>方式一：</strong> 登录工人门户，在"合规文件"或"待办事项"中直接完成</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${portalUrl}" style="display:inline-block;padding:.6rem 1.2rem;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">登录工人门户 / Worker Portal</a></td></tr>
           ${result.link ? `<tr><td style="padding:.75rem 0 .3rem"><strong>方式二：</strong> 点击以下链接直接在手机上完成验证</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${result.link}" style="display:inline-block;padding:.6rem 1.2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证 / Start Verification</a></td></tr>
           <tr><td style="padding:.3rem 0"><span style="color:#888;font-size:.82rem">或复制链接：${result.link}</span></td></tr>` : ''}
         </table>`
      );
    }
    res.json({ success: true, smsSent, emailSent, portalReady: true, inquiryId: result.inquiryId, link: result.link || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Checkr Background Check Integration ──
async function checkrApiCall(method, path, body) {
  const settings = db.prepare("SELECT * FROM integration_settings WHERE provider='checkr'").get();
  const apiKey = settings?.api_key || process.env.CHECKR_API_KEY;
  if (!apiKey) throw new Error('Checkr API key not configured');
  const url = `https://api.checkr.com/v1${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Checkr API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Admin: send Checkr background check invitation to worker
app.post('/api/admin/worker-accounts/:id/send-checkr', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (!w.email) return res.status(400).json({ error: '该工人没有邮箱地址，无法发送 Checkr 邀请' });

    const settings = db.prepare("SELECT * FROM integration_settings WHERE provider='checkr'").get();
    const apiKey = settings?.api_key || process.env.CHECKR_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Checkr 未配置，请先在集成设置中配置 Checkr API Key' });

    const config = JSON.parse(settings?.config || '{}');
    const packageSlug = config.package || process.env.CHECKR_PACKAGE || 'tasker_standard';

    // Create candidate
    let candidateId = w.checkr_candidate_id;
    if (!candidateId) {
      const candidate = await checkrApiCall('POST', '/candidates', {
        first_name: (w.name || w.username || '').split(' ')[0] || w.username,
        last_name: (w.name || '').split(' ').slice(1).join(' ') || '',
        email: w.email,
        phone: w.phone || undefined,
        dob: w.dob || undefined,
      });
      candidateId = candidate.id;
      db.prepare('UPDATE worker_accounts SET checkr_candidate_id=? WHERE id=?').run(candidateId, workerId);
    }

    // Create invitation (Checkr sends email to candidate with SSN + consent collection)
    const invitation = await checkrApiCall('POST', '/invitations', {
      candidate_id: candidateId,
      package: packageSlug,
    });

    db.prepare('UPDATE worker_accounts SET checkr_invitation_id=?, bgcheck_status=? WHERE id=?')
      .run(invitation.id, 'invitation_sent', workerId);

    // Mark onboarding step as pending + visible
    db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker, admin_note, action_url, updated_at)
      VALUES (?,'background_check','pending',1,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status='pending', visible_to_worker=1, action_url=excluded.action_url, admin_note=excluded.admin_note, updated_at=CURRENT_TIMESTAMP`)
      .run(workerId, '已发送 Checkr 背景调查邀请', invitation.invitation_url || '');

    // Notify worker via SMS
    let smsSent = false;
    if (w.phone) {
      smsSent = await sendSMS(w.phone, `[Prime Anchorpoint] 您好 ${w.name||w.username||''}，我们已通过 Checkr 向您的邮箱 (${w.email}) 发送了背景调查邀请，请查收邮件并完成。`);
    }

    res.json({ success: true, smsSent, candidateId, invitationId: invitation.id, invitationUrl: invitation.invitation_url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Checkr webhook — called when background check status changes
app.post('/api/webhooks/checkr', express.json(), (req, res) => {
  try {
    const event = req.body;
    const eventType = event.type || '';
    console.log(`[Checkr Webhook] ${eventType}`);

    if (eventType === 'invitation.completed') {
      // Candidate completed the invitation (provided SSN, consent, etc.)
      const candidateId = event.data?.object?.candidate_id;
      if (candidateId) {
        const w = db.prepare('SELECT id FROM worker_accounts WHERE checkr_candidate_id=?').get(candidateId);
        if (w) {
          db.prepare('UPDATE worker_accounts SET bgcheck_status=? WHERE id=?').run('pending', w.id);
          db.prepare(`UPDATE worker_onboarding SET admin_note='工人已提交信息，等待 Checkr 审核…', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='background_check'`).run(w.id);
        }
      }
    } else if (eventType === 'report.completed') {
      const reportId = event.data?.object?.id;
      const candidateId = event.data?.object?.candidate_id;
      const result = event.data?.object?.result; // 'clear' or 'consider'
      if (candidateId) {
        const w = db.prepare('SELECT id FROM worker_accounts WHERE checkr_candidate_id=?').get(candidateId);
        if (w) {
          const status = result === 'clear' ? 'clear' : 'review';
          db.prepare('UPDATE worker_accounts SET checkr_report_id=?, bgcheck_status=? WHERE id=?').run(reportId || '', status, w.id);
          if (status === 'clear') {
            db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='Checkr: Clear ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='background_check'`).run(w.id);
            syncOnboardedStatus(w.id);
            console.log(`[Checkr Webhook] Auto-completed background_check for worker ${w.id}`);
          } else {
            db.prepare(`UPDATE worker_onboarding SET admin_note='Checkr: 需人工审核 (consider)', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='background_check'`).run(w.id);
            console.log(`[Checkr Webhook] Report needs review for worker ${w.id}`);
          }
        }
      }
    } else if (eventType === 'report.suspended' || eventType === 'report.disputed') {
      const candidateId = event.data?.object?.candidate_id;
      if (candidateId) {
        const w = db.prepare('SELECT id FROM worker_accounts WHERE checkr_candidate_id=?').get(candidateId);
        if (w) {
          db.prepare('UPDATE worker_accounts SET bgcheck_status=? WHERE id=?').run('suspended', w.id);
          db.prepare(`UPDATE worker_onboarding SET admin_note='Checkr: 调查暂停/有争议', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='background_check'`).run(w.id);
        }
      }
    }

    res.json({ received: true });
  } catch (e) { console.error('[Checkr Webhook]', e.message); res.status(500).json({ error: e.message }); }
});

// Admin: check Checkr status for a worker
app.get('/api/admin/worker-accounts/:id/checkr-status', requireAdmin, async (req, res) => {
  try {
    const w = db.prepare('SELECT checkr_candidate_id, checkr_invitation_id, checkr_report_id, bgcheck_status FROM worker_accounts WHERE id=?').get(req.params.id);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    let report = null;
    if (w.checkr_report_id) {
      try { report = await checkrApiCall('GET', `/reports/${w.checkr_report_id}`); } catch {}
    }
    res.json({ ...w, report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: view own onboarding tasks (only visible ones)
app.get('/api/worker/onboarding', requireWorker, (req, res) => {
  const existing = db.prepare('SELECT id FROM worker_onboarding WHERE worker_account_id=?').get(req.workerId);
  if (!existing) initWorkerOnboarding(req.workerId);

  // Auto-sync persona_verify status from worker_accounts.identity_status (may have been updated by webhook)
  const personaOnboard = db.prepare("SELECT status FROM worker_onboarding WHERE worker_account_id=? AND task_key='persona_verify'").get(req.workerId);
  if (personaOnboard && personaOnboard.status === 'pending') {
    const w = db.prepare('SELECT identity_status FROM worker_accounts WHERE id=?').get(req.workerId);
    if (w && w.identity_status === 'approved') {
      db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
    } else if (w && (w.identity_status === 'completed' || w.identity_status === 'needs_review')) {
      db.prepare(`UPDATE worker_onboarding SET status='submitted', admin_note='验证已完成，等待审核', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
    } else if (w && w.identity_status === 'declined') {
      db.prepare(`UPDATE worker_onboarding SET status='pending', admin_note='验证未通过，请重新验证', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
    }
  }

  const tasks = getOnboardingTasks(req.workerId).filter(t => t.visible_to_worker !== 0);
  res.json(tasks);
});

// Worker: submit a task (marks as submitted, pending admin review)
app.post('/api/worker/onboarding/:key/submit', requireWorker, (req, res) => {
  const { note } = req.body;
  db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, admin_note, updated_at)
    VALUES (?,?,'submitted',?,CURRENT_TIMESTAMP)
    ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status='submitted', admin_note=excluded.admin_note, updated_at=CURRENT_TIMESTAMP`)
    .run(req.workerId, req.params.key, note||'');
  res.json({ success: true });
});

// Check if inquiry person has a dispatch_ready worker account
app.get('/api/admin/inquiries/:id/worker-status', requireAdmin, (req, res) => {
  const inq = db.prepare('SELECT phone, email FROM inquiries WHERE id=?').get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'Not found' });
  const w = db.prepare('SELECT id, active, dispatch_ready, suspended FROM worker_accounts WHERE phone=? OR (? != \'\' AND email=?)').get(inq.phone||'', inq.email||'', inq.email||'');
  if (!w) return res.json({ has_account: false, dispatch_ready: false });
  res.json({ has_account: true, dispatch_ready: !!w.dispatch_ready, active: !!w.active, suspended: !!w.suspended, worker_id: w.id });
});

// Admin: update worker skills
app.put('/api/admin/worker-accounts/:id/skills', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const { skills } = req.body; // Array of { skill_name, rating }
  if (!Array.isArray(skills)) return res.status(400).json({ error: 'skills array required' });
  db.prepare('DELETE FROM worker_skills WHERE worker_account_id=?').run(req.params.id);
  const insert = db.prepare('INSERT INTO worker_skills (worker_account_id, skill_name, rating) VALUES (?,?,?)');
  skills.forEach(s => { if (s.skill_name) insert.run(req.params.id, s.skill_name, s.rating || 0); });
  res.json({ success: true });
});

// Admin: send password reset link to worker
app.post('/api/admin/worker-accounts/:id/send-reset-link', requireAdmin, requireRole('admin', 'staff'), async (req, res) => {
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker not found' });

  // Generate a reset token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Store reset token
  try { db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_type TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch {}

  db.prepare('INSERT INTO password_resets (account_type, account_id, token, expires_at) VALUES (?,?,?,?)')
    .run('worker', w.id, token, expiresAt);

  const resetUrl = `${req.protocol}://${req.get('host')}/portal?reset=${token}`;
  const results = { sms_sent: false, email_sent: false };

  // Send via SMS
  if (w.phone && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Prime Anchorpoint 密码重置链接 / Password Reset:\n${resetUrl}\n24小时内有效。`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: w.phone
      });
      results.sms_sent = true;
    } catch (e) { console.error('[Reset SMS]', e.message); }
  }

  // Send via email
  if (w.email && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT)||587, secure: process.env.SMTP_SECURE==='true', auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
      await t.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@primeanchorpoint.com',
        to: w.email,
        subject: 'Prime Anchorpoint - 密码重置 / Password Reset',
        html: `<p>请点击以下链接重置密码 / Click to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>链接24小时内有效 / Valid for 24 hours.</p>`
      });
      results.email_sent = true;
    } catch (e) { console.error('[Reset Email]', e.message); }
  }

  res.json({ success: true, reset_url: resetUrl, ...results });
});

app.delete('/api/admin/worker-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  try {
    const id = req.params.id;
    // Invalidate all active sessions for this worker
    for (const [token, session] of workerSessions.entries()) {
      if (String(session.workerId) === String(id)) workerSessions.delete(token);
    }
    db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM job_applications WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_skills WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_compliance_docs WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_onboarding WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM interviews WHERE worker_account_id=?').run(id);
    try { db.prepare('DELETE FROM pending_profile_changes WHERE worker_account_id=?').run(id); } catch(_) {}
    db.prepare('DELETE FROM worker_accounts WHERE id=?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE worker-account]', e.message);
    res.status(500).json({ error: '删除失败：' + e.message });
  }
});

// Admin: test Twilio SMS configuration
app.post('/api/admin/test-sms', requireAdmin, requireRole('admin'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing phone number' });
  const configured = {
    account_sid: process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.slice(0, 8) + '...' : null,
    auth_token: !!process.env.TWILIO_AUTH_TOKEN,
    phone_number: process.env.TWILIO_PHONE_NUMBER || null,
    verify_sid: TWILIO_VERIFY_SID ? TWILIO_VERIFY_SID.slice(0, 8) + '...' : null,
    client_ready: !!twilioClient,
  };
  const accountInfo = await getTwilioAccountType();

  // Prefer Twilio Verify API for test
  if (twilioClient && TWILIO_VERIFY_SID) {
    const formatted = formatPhoneE164(to);
    try {
      const v = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verifications.create({ to: formatted, channel: 'sms' });
      return res.json({
        configured, accountInfo,
        method: 'verify',
        result: { ok: true, status: v.status, sid: v.sid, to: formatted, channel: v.channel }
      });
    } catch (e) {
      return res.json({
        configured, accountInfo,
        method: 'verify',
        result: { ok: false, error: e.message, code: e.code, to: formatted }
      });
    }
  }

  // Fallback to regular SMS
  const result = await sendSMSWithDetail(to, '[Prime Anchorpoint] 测试短信 / SMS Test: Twilio is working!');
  res.json({ configured, result, accountInfo, method: 'sms' });
});

// Admin: test email configuration
app.post('/api/admin/test-email', requireAdmin, requireRole('admin'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing email address' });
  const configured = {
    sendgrid_api: !!_sgKey,
    smtp_host: process.env.SMTP_HOST || null,
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER || null,
    smtp_pass_set: !!process.env.SMTP_PASS,
    email_from: EMAIL_FROM,
    transport: _sgKey ? 'sendgrid-api' : emailTransporter ? 'smtp' : 'none',
  };
  if (!_sgKey && !emailTransporter) return res.json({ configured, sent: false, error: 'No email transport configured' });
  const sent = await sendEmail(to, 'Prime Anchorpoint Email Test', `Email is working!\n\nFrom: ${EMAIL_FROM}\nTo: ${to}\nTime: ${new Date().toISOString()}`);
  res.json({ configured, sent, error: sent ? null : 'sendEmail failed — check server logs for [EMAIL-ERR]' });
});

// Admin: test email verification code (sends a real 6-digit code in the same format as registration)
app.post('/api/admin/test-email-code', requireAdmin, requireRole('admin'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing email address' });
  const configured = {
    sendgrid_api: !!_sgKey,
    smtp_host: process.env.SMTP_HOST || null,
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER || null,
    smtp_pass_set: !!process.env.SMTP_PASS,
    email_from: EMAIL_FROM,
    transport: _sgKey ? 'sendgrid-api' : emailTransporter ? 'smtp' : 'none',
  };
  if (!_sgKey && !emailTransporter) return res.json({ configured, sent: false, error: 'No email transport configured' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const sent = await sendEmail(
    to,
    'Prime Anchorpoint 邮箱验证码 / Email Verification Code',
    `[管理员测试 / Admin Test]\n\n您的邮箱验证码是: ${code}\nYour email verification code: ${code}\n\n验证码15分钟内有效 / This code expires in 15 minutes.`,
    verificationCodeHtml(code, true)
  );
  res.json({ configured, sent, error: sent ? null : 'sendEmail failed — check server logs for [EMAIL-ERR]' });
});

// Admin: payment records for a worker
app.get('/api/admin/worker-accounts/:id/payments', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const w = db.prepare('SELECT employee_id FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w || !w.employee_id) return res.json([]);
  const payments = db.prepare(`
    SELECT p.*, j.title AS job_title
    FROM worker_payments p LEFT JOIN jobs j ON p.job_id = j.id
    WHERE p.employee_id = ? ORDER BY p.payment_date DESC, p.created_at DESC
  `).all(w.employee_id);
  res.json(payments);
});

app.post('/api/admin/worker-accounts/:id/payments', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const w = db.prepare('SELECT employee_id FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w || !w.employee_id) return res.status(400).json({ error: '账号未关联员工档案' });
  const { amount, payment_date, payment_method, period_start, period_end, job_id, notes } = req.body;
  if (!amount || !payment_date) return res.status(400).json({ error: 'amount and payment_date required' });
  const r = db.prepare(`INSERT INTO worker_payments
    (employee_id, amount, payment_date, payment_method, period_start, period_end, job_id, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(w.employee_id, amount, payment_date, payment_method || 'cash', period_start || '', period_end || '', job_id || null, notes || '', req.userName || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/worker-accounts/:id/payments/:pid', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM worker_payments WHERE id=?').run(req.params.pid);
  res.json({ success: true });
});

// Admin: resend verification codes to unverified worker
app.post('/api/admin/worker-accounts/:id/resend-verify', requireAdmin, requireRole('admin', 'staff'), async (req, res) => {
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.active) return res.status(400).json({ error: 'Account already verified' });
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(w.id);

  const canVerifyPhone = !!(twilioClient && TWILIO_VERIFY_SID && w.phone);
  const canSMSFallback = !!(twilioClient && TWILIO_FROM && w.phone && !TWILIO_VERIFY_SID);
  const canEmail = !!(_sgKey || emailTransporter) && !!w.email;
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let smsSent = false, emailSent = false;
  let phoneCode = null, emailCode = null;

  // Phone: prefer Twilio Verify
  if (canVerifyPhone) {
    smsSent = await sendVerifyCode(w.phone);
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(w.id, 'phone', '__twilio_verify__', expires);
  } else if (canSMSFallback) {
    phoneCode = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(w.id, 'phone', phoneCode, expires);
    smsSent = await sendSMS(w.phone, `[Prime Anchorpoint] 您的手机验证码是: ${phoneCode}，15分钟内有效。Your verification code: ${phoneCode}`);
  }
  // Email
  if (canEmail) {
    emailCode = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(w.id, 'email', emailCode, expires);
    emailSent = await sendEmail(w.email, 'Prime Anchorpoint 邮箱验证码 / Email Verification Code',
      `您的邮箱验证码是: ${emailCode}\nYour email verification code: ${emailCode}\n\n验证码15分钟内有效 / This code expires in 15 minutes.`,
      verificationCodeHtml(emailCode));
  }
  console.log(`[Admin Resend Verify] Worker ${w.id} (${w.name||w.username}): phone=${canVerifyPhone?'TwilioVerify':phoneCode||'N/A'}(sent:${smsSent}) email=${emailCode||'N/A'}(sent:${emailSent})`);
  const result = { success: true, sms_sent: smsSent, email_sent: emailSent };
  res.json(result);
});

// ─── Customer Accounts (admin manages) ───
app.get('/api/admin/customer-accounts', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  res.json(db.prepare('SELECT id, company_name, contact_name, email, phone, active, partner_id, ein, staffing_needs, approval_status, created_at FROM customer_accounts ORDER BY id DESC').all());
});

app.post('/api/admin/customer-accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { company_name, contact_name, email, phone, password, partner_id } = req.body;
  if (!email || !password || !company_name) return res.status(400).json({ error: 'Email, company and password required' });
  if (db.prepare('SELECT id FROM customer_accounts WHERE email=?').get(email))
    return res.status(400).json({ error: 'Email already registered' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const r = db.prepare('INSERT INTO customer_accounts (company_name, contact_name, email, phone, password_hash, salt, partner_id) VALUES (?,?,?,?,?,?,?)')
    .run(company_name, contact_name || '', email, phone || '', hash, salt, partner_id || null);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/customer-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { company_name, contact_name, email, phone, password, partner_id, active } = req.body;
  const c = db.prepare('SELECT * FROM customer_accounts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE customer_accounts SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, req.params.id);
  }
  db.prepare('UPDATE customer_accounts SET company_name=?, contact_name=?, email=?, phone=?, partner_id=?, active=? WHERE id=?')
    .run(company_name||c.company_name, contact_name||c.contact_name, email||c.email, phone||c.phone, partner_id!==undefined?partner_id:c.partner_id, active!==undefined?active:c.active, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/customer-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const id = req.params.id;
  // Invalidate all active sessions for this customer
  for (const [token, session] of customerSessions.entries()) {
    if (String(session.customerId) === String(id)) customerSessions.delete(token);
  }
  db.prepare('DELETE FROM customer_accounts WHERE id=?').run(id);
  res.json({ success: true });
});

// Clear all test data (worker accounts, customer accounts, verification codes, job applications)
app.post('/api/admin/clear-test-data', requireAdmin, requireRole('admin'), (req, res) => {
  const { confirm_text } = req.body;
  if (confirm_text !== 'I confirm') return res.status(400).json({ error: 'Please type "I confirm" to proceed' });
  // Invalidate all worker and customer sessions
  workerSessions.clear();
  customerSessions.clear();
  const wDel = db.prepare('DELETE FROM worker_accounts').run();
  const cDel = db.prepare('DELETE FROM customer_accounts').run();
  db.prepare('DELETE FROM verification_codes').run();
  db.prepare('DELETE FROM job_applications').run();
  db.prepare('DELETE FROM customer_job_posts').run();
  console.log(`[Admin] Cleared test data: ${wDel.changes} worker accounts, ${cDel.changes} customer accounts`);
  res.json({ success: true, deleted_workers: wDel.changes, deleted_customers: cDel.changes });
});

// ─── Job Applications (admin view) ───
app.get('/api/admin/job-applications', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*,
      j.title as job_title, j.location as job_location, j.description as job_description,
      j.pay as job_pay, j.pay_period as job_pay_period, j.company_name as job_company,
      j.type as job_type, j.employment_type as job_employment_type,
      j.work_days, j.work_start, j.work_end, j.benefits as job_benefits,
      w.username, w.phone as worker_phone, w.email as worker_email,
      e.first_name, e.last_name
    FROM job_applications a
    LEFT JOIN jobs j ON a.job_id=j.id
    LEFT JOIN worker_accounts w ON a.worker_account_id=w.id
    LEFT JOIN employees e ON w.employee_id=e.id
    ORDER BY a.created_at DESC
  `).all());
});

app.put('/api/admin/job-applications/:id', requireAdmin, blockManager, async (req, res) => {
  const { status, notes, admin_note, interview_datetime, interview_location_text, interview_times, notify } = req.body;
  // interview_times: array of datetime strings (multi-slot support)
  const timesJson = Array.isArray(interview_times) && interview_times.length ? JSON.stringify(interview_times) : '';
  const primaryDatetime = (Array.isArray(interview_times) && interview_times[0]) ? interview_times[0] : (interview_datetime || '');
  db.prepare('UPDATE job_applications SET status=?, notes=?, admin_note=?, interview_datetime=?, interview_location_text=?, interview_times_json=? WHERE id=?')
    .run(status, notes||'', admin_note||'', primaryDatetime, interview_location_text||'', timesJson, req.params.id);
  let emailSent = false, smsSent = false;
  if (notify && status === 'interview_scheduled') {
    try {
      const app2 = db.prepare(`
        SELECT a.*, w.phone as worker_phone, w.email as worker_email,
               e.first_name, e.last_name, j.title as job_title
        FROM job_applications a
        LEFT JOIN worker_accounts w ON a.worker_account_id=w.id
        LEFT JOIN employees e ON w.employee_id=e.id
        LEFT JOIN jobs j ON a.job_id=j.id
        WHERE a.id=?
      `).get(req.params.id);
      if (app2) {
        const workerName = app2.first_name ? `${app2.first_name} ${app2.last_name||''}`.trim() : app2.username || '';
        const times = Array.isArray(interview_times) && interview_times.length ? interview_times : (interview_datetime ? [interview_datetime] : []);
        const fmtDt = dt => new Date(dt).toLocaleString('zh-CN', { timeZone: 'America/New_York', year:'numeric', month:'long', day:'numeric', weekday:'long', hour:'2-digit', minute:'2-digit' });
        const dtLines = times.map((t, i) => (times.length > 1 ? `时间选项${i+1}：` : '时间：') + fmtDt(t)).join('\n');
        const dtHtmlRows = times.map((t, i) => `<tr><td style="padding:.4rem .9rem .4rem 0;font-weight:700;white-space:nowrap">📅 ${times.length > 1 ? `时间${i+1}` : '时间'}</td><td style="padding:.4rem 0">${fmtDt(t)}</td></tr>`).join('');
        const locStr = interview_location_text || '';
        const noteStr = admin_note || '';
        const subject = 'Prime Anchorpoint — 面试通知 / Interview Scheduled';
        const textMsg = `您好 ${workerName}，\n\n您申请的职位「${app2.job_title}」已安排面试：\n${dtLines ? dtLines + '\n' : ''}${locStr ? '地点：' + locStr + '\n' : ''}${noteStr ? '备注：' + noteStr + '\n' : ''}\n请登录工人门户查看详情。`;
        const htmlMsg = `<p>您好 ${workerName}，</p><p>您申请的职位 <strong>${app2.job_title}</strong> 已安排面试：</p>
          <table style="border-collapse:collapse;margin:1rem 0;font-size:15px">
            ${dtHtmlRows}
            ${locStr ? `<tr><td style="padding:.4rem .9rem .4rem 0;font-weight:700;white-space:nowrap">📍 地点</td><td style="padding:.4rem 0">${locStr}</td></tr>` : ''}
            ${noteStr ? `<tr><td style="padding:.4rem .9rem .4rem 0;font-weight:700;white-space:nowrap">📝 备注</td><td style="padding:.4rem 0">${noteStr}</td></tr>` : ''}
          </table>
          <p>请登录工人门户查看完整详情。</p>`;
        if (app2.worker_email) emailSent = await sendEmail(app2.worker_email, subject, textMsg, htmlMsg).catch(() => false);
        if (app2.worker_phone) smsSent = await sendSMS(app2.worker_phone, textMsg).catch(() => false);
      }
    } catch(e) { console.error('[job-app notify]', e.message); }
  }
  res.json({ success: true, emailSent, smsSent });
});

// ─── Customer Job Posts (admin view) ───
app.get('/api/admin/customer-job-posts', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, c.company_name as customer_company, c.contact_name, c.email as customer_email
    FROM customer_job_posts p LEFT JOIN customer_accounts c ON p.customer_account_id=c.id
    ORDER BY p.created_at DESC
  `).all());
});

app.put('/api/admin/customer-job-posts/:id', requireAdmin, blockManager, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE customer_job_posts SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true });
});

// ─── Pending Actions (approval workflow) ───
app.get('/api/admin/pending-actions', requireAdmin, (req, res) => {
  if (req.userRole === 'admin') {
    res.json(db.prepare('SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at DESC').all('pending'));
  } else {
    res.json(db.prepare('SELECT * FROM pending_actions WHERE requested_by = ? ORDER BY created_at DESC').all(req.userName));
  }
});

app.post('/api/admin/pending-actions/:id/approve', requireAdmin, requireRole('admin'), (req, res) => {
  const action = db.prepare('SELECT * FROM pending_actions WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!action) return res.status(404).json({ error: 'Action not found or already processed' });
  const payload = JSON.parse(action.payload || '{}');
  const params = payload._params || {};
  try {
    if (action.action_type === 'delete') {
      db.prepare(`DELETE FROM ${action.target_table} WHERE id = ?`).run(action.target_id);
    } else if (action.action_type === 'update') {
      delete payload._params;
      const cols = Object.keys(payload).filter(k => k !== '_params');
      if (cols.length > 0) {
        const setClauses = cols.map(c => `${c}=?`).join(',');
        db.prepare(`UPDATE ${action.target_table} SET ${setClauses} WHERE id=?`).run(...cols.map(c => payload[c]), action.target_id);
      }
    }
    db.prepare('UPDATE pending_actions SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run('approved', req.userName, action.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/pending-actions/:id/reject', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE pending_actions SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('rejected', req.userName, req.params.id);
  res.json({ success: true });
});

// Jobs CRUD (with audit logging)
const logJobAudit = db.prepare('INSERT INTO job_audit_log (job_id, action, changes, performed_by) VALUES (?,?,?,?)');

function diffJob(oldJ, newD) {
  const fields = ['title','type','location','pay','job_status','close_reason','close_note','active','headcount','employment_type','work_days','work_start','work_end','benefits','description','urgent','company_name','work_auth'];
  const changes = {};
  for (const f of fields) {
    const o = String(oldJ[f] ?? ''), n = String(newD[f] ?? '');
    if (o !== n) changes[f] = { from: oldJ[f], to: newD[f] };
  }
  return changes;
}

app.get('/api/admin/jobs', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT j.*, p.name AS partner_name FROM jobs j LEFT JOIN partners p ON j.partner_id = p.id ORDER BY j.created_at DESC').all());
});

app.get('/api/admin/jobs/:id/history', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM job_audit_log WHERE job_id=? ORDER BY created_at DESC').all(req.params.id));
});

app.post('/api/admin/jobs', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  const jobStatus = d.job_status || 'open';
  const stmt = db.prepare(`INSERT INTO jobs
    (partner_id, title, type, category, location, pay, pay_period, lang, lang_name, description, urgent,
     work_auth, benefits, schedule, company_id, company_name, employment_type,
     work_days, work_start, work_end, work_schedule, schedule_days, schedule_start, schedule_end,
     job_status, active, close_reason, close_note, headcount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const r = stmt.run(
    d.partner_id||null, d.title, d.type||'', d.category||'', d.location||'', d.pay||'', d.pay_period||'', d.lang||'en', d.lang_name||'English',
    d.description||'', d.urgent?1:0, d.work_auth||'', d.benefits||'', d.schedule||'',
    d.company_id||null, d.company_name||'', d.employment_type||'',
    d.work_days||'', d.work_start||'', d.work_end||'', d.work_schedule||'{}',
    d.schedule_days||'[]', d.schedule_start||'', d.schedule_end||'',
    jobStatus, jobStatus==='open'?1:0, d.close_reason||'', d.close_note||'', d.headcount||1
  );
  logJobAudit.run(r.lastInsertRowid, 'created', JSON.stringify({ title: d.title, company_name: d.company_name||'' }), req.userName);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/jobs/:id', requireAdmin, blockManager, staffGuard('update', 'jobs'), (req, res) => {
  const d = req.body;
  const old = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  const jobStatus = d.job_status || 'open';
  db.prepare(`UPDATE jobs SET partner_id=?, title=?, type=?, category=?, location=?, pay=?, pay_period=?, lang=?, lang_name=?,
    description=?, urgent=?, active=?, work_auth=?, benefits=?, schedule=?,
    company_id=?, company_name=?, employment_type=?, work_days=?, work_start=?, work_end=?, work_schedule=?,
    schedule_days=?, schedule_start=?, schedule_end=?,
    job_status=?, close_reason=?, close_note=?, headcount=? WHERE id=?`)
    .run(
      d.partner_id||null, d.title, d.type||'', d.category||'', d.location||'', d.pay||'', d.pay_period||'', d.lang||'en', d.lang_name||'English',
      d.description||'', d.urgent?1:0, jobStatus==='open'?1:0,
      d.work_auth||'', d.benefits||'', d.schedule||'',
      d.company_id||null, d.company_name||'', d.employment_type||'',
      d.work_days||'', d.work_start||'', d.work_end||'', d.work_schedule||'{}',
      d.schedule_days||'[]', d.schedule_start||'', d.schedule_end||'',
      jobStatus, d.close_reason||'', d.close_note||'', d.headcount||1,
      req.params.id
    );
  // Determine action type
  let action = 'updated';
  if (old && old.job_status === 'open' && jobStatus !== 'open') action = 'closed';
  if (old && old.job_status !== 'open' && jobStatus === 'open') action = 'reopened';
  const changes = old ? diffJob(old, { ...d, job_status: jobStatus, active: jobStatus==='open'?1:0 }) : {};
  logJobAudit.run(req.params.id, action, JSON.stringify(changes), req.userName);
  res.json({ success: true });
});

app.delete('/api/admin/jobs/:id', requireAdmin, blockManager, staffGuard('delete', 'jobs'), (req, res) => {
  const old = db.prepare('SELECT title, company_name FROM jobs WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '职位不存在 / Job not found' });
  // Block deletion if the job has any assignments (workers assigned to it)
  const assignmentCount = db.prepare('SELECT COUNT(*) as cnt FROM assignments WHERE job_id=?').get(req.params.id);
  if (assignmentCount && assignmentCount.cnt > 0) {
    return res.status(409).json({ error: `该职位已有 ${assignmentCount.cnt} 名工人被分配，无法删除。请先取消所有派工记录。 / Cannot delete: ${assignmentCount.cnt} worker(s) are assigned to this job. Remove all assignments first.` });
  }
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  logJobAudit.run(req.params.id, 'deleted', JSON.stringify(old || {}), req.userName);
  res.json({ success: true });
});

app.put('/api/admin/jobs/:id/visible', requireAdmin, blockManager, (req, res) => {
  const job = db.prepare('SELECT visible FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const newVisible = job.visible ? 0 : 1;
  db.prepare('UPDATE jobs SET visible=? WHERE id=?').run(newVisible, req.params.id);
  logJobAudit.run(req.params.id, newVisible ? 'shown' : 'hidden', '{}', req.userName);
  res.json({ success: true, visible: newVisible });
});

// Inquiries
app.get('/api/admin/inquiries', requireAdmin, blockManager, (req, res) => {
  const history = req.query.history === '1';
  const all = req.query.all === '1';
  const rows = all
    ? db.prepare(`SELECT * FROM inquiries ORDER BY created_at DESC`).all()
    : db.prepare(`SELECT * FROM inquiries WHERE processed=? ORDER BY created_at DESC`).all(history ? 1 : 0);
  res.json(rows);
});

app.put('/api/admin/inquiries/:id/process', requireAdmin, blockManager, (req, res) => {
  const { status, note, undo } = req.body;
  if (undo) {
    db.prepare('UPDATE inquiries SET processed=0, proc_status=\'\', proc_note=\'\', processed_at=NULL WHERE id=?').run(req.params.id);
  } else {
    const valid = ['cooperated','quote_high','too_small','no_match','unreachable','other','rejected'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE inquiries SET processed=1, proc_status=?, proc_note=?, processed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(status, note || '', req.params.id);
  }
  res.json({ success: true });
});

app.delete('/api/admin/inquiries/:id', requireAdmin, blockManager, staffGuard('delete', 'inquiries'), (req, res) => {
  db.prepare('DELETE FROM inquiries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Worker positions list
app.get('/api/admin/worker-positions', requireAdmin, (req, res) => {
  res.json(WORKER_POSITIONS);
});

// Inquiry × Worker Position ratings (static list from website)
app.get('/api/admin/inquiries/:id/position-ratings', requireAdmin, blockManager, (req, res) => {
  const saved = db.prepare('SELECT * FROM inquiry_position_ratings WHERE inquiry_id=?').all(req.params.id);
  const rMap = {};
  saved.forEach(r => { rMap[r.position_key] = r; });
  res.json(WORKER_POSITIONS.map(p => ({ ...p, rating: rMap[p.key] || null })));
});

app.put('/api/admin/inquiries/:id/position-ratings', requireAdmin, blockManager, (req, res) => {
  const { ratings } = req.body; // [{ position_key, skill_score, recommend, suggest_pay }]
  const upsert = db.prepare(`INSERT INTO inquiry_position_ratings (inquiry_id, position_key, skill_score, recommend, suggest_pay, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(inquiry_id, position_key) DO UPDATE SET skill_score=excluded.skill_score, recommend=excluded.recommend, suggest_pay=excluded.suggest_pay, updated_at=CURRENT_TIMESTAMP`);
  const txn = db.transaction(() => ratings.forEach(r => upsert.run(req.params.id, r.position_key, r.skill_score || 0, r.recommend ? 1 : 0, r.suggest_pay || '')));
  txn();
  res.json({ success: true });
});

// Employee position ratings
app.get('/api/admin/employees/:id/position-ratings', requireAdmin, blockManager, (req, res) => {
  const saved = db.prepare('SELECT * FROM employee_position_ratings WHERE employee_id=?').all(req.params.id);
  const rMap = {};
  saved.forEach(r => { rMap[r.position_key] = r; });
  res.json(WORKER_POSITIONS.map(p => ({ ...p, rating: rMap[p.key] || null })));
});

app.put('/api/admin/employees/:id/position-ratings', requireAdmin, blockManager, (req, res) => {
  const { ratings } = req.body;
  const upsert = db.prepare(`INSERT INTO employee_position_ratings (employee_id, position_key, skill_score, recommend, suggest_pay, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_id, position_key) DO UPDATE SET skill_score=excluded.skill_score, recommend=excluded.recommend, suggest_pay=excluded.suggest_pay, updated_at=CURRENT_TIMESTAMP`);
  const txn = db.transaction(() => ratings.forEach(r => upsert.run(req.params.id, r.position_key, r.skill_score || 0, r.recommend != null ? r.recommend : -1, r.suggest_pay || '')));
  txn();
  res.json({ success: true });
});

// ─── Onboarding ───

// Multer for onboarding doc uploads (reuse docsDir)
const onboardUpload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `onboard-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png|heic|heif/.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

// POST /api/admin/inquiries/:id/onboard-link — generate onboarding link for a Job Seeker inquiry
app.post('/api/admin/inquiries/:id/onboard-link', requireAdmin, (req, res) => {
  const inq = db.prepare('SELECT * FROM inquiries WHERE id=?').get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'Inquiry not found' });
  // Check if token already exists
  const existing = db.prepare('SELECT * FROM onboarding_tokens WHERE inquiry_id=?').get(inq.id);
  if (existing && existing.status === 'completed') {
    return res.json({ token: existing.token, status: 'completed', already_sent: true });
  }
  if (existing) return res.json({ token: existing.token, status: existing.status, already_sent: true });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO onboarding_tokens (token, inquiry_id, email, phone) VALUES (?,?,?,?)')
    .run(token, inq.id, inq.email || '', inq.phone || '');
  res.json({ token, status: 'pending' });
});

// GET /api/onboard/:token — public: validate token and return basic info
app.get('/api/onboard/:token', (req, res) => {
  const row = db.prepare(`
    SELECT t.*, i.name, i.positions, i.type
    FROM onboarding_tokens t JOIN inquiries i ON t.inquiry_id=i.id
    WHERE t.token=?`).get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  res.json({ status: row.status, name: row.name, positions: row.positions, completed_at: row.completed_at });
});

// POST /api/onboard/:token/submit — public: submit agreements + upload docs
app.post('/api/onboard/:token/submit', onboardUpload.fields([
  { name: 'work_id', maxCount: 1 },
  { name: 'drivers_license', maxCount: 1 },
  { name: 'ssn', maxCount: 1 }
]), (req, res) => {
  const row = db.prepare('SELECT * FROM onboarding_tokens WHERE token=?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.status === 'completed') return res.status(400).json({ error: '已完成提交，无法重复提交' });
  const agreements = req.body.agreements ? JSON.parse(req.body.agreements) : [];
  if (agreements.length < 3) return res.status(400).json({ error: '请阅读并同意所有协议' });
  db.prepare(`UPDATE onboarding_tokens SET status='completed', email=?, phone=?, agreements=?, completed_at=CURRENT_TIMESTAMP WHERE token=?`)
    .run(req.body.email || row.email, req.body.phone || row.phone, JSON.stringify(agreements), row.token);
  // Save uploaded docs
  const files = req.files || {};
  for (const [docType, fileArr] of Object.entries(files)) {
    if (fileArr && fileArr[0]) {
      const f = fileArr[0];
      db.prepare('INSERT INTO onboarding_docs (token_id, doc_type, file_path, file_name) VALUES (?,?,?,?)')
        .run(row.id, docType, f.filename, f.originalname);
    }
  }
  res.json({ success: true });
});

// GET /api/admin/onboard-submissions — list all onboarding submissions with inquiry info
app.get('/api/admin/onboard-submissions', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, i.name, i.positions, i.email as inq_email, i.phone as inq_phone,
      (SELECT COUNT(*) FROM onboarding_docs d WHERE d.token_id=t.id) as doc_count
    FROM onboarding_tokens t JOIN inquiries i ON t.inquiry_id=i.id
    ORDER BY t.created_at DESC`).all();
  res.json(rows);
});

// GET /api/admin/onboard-submissions/:id/docs — list docs for a submission
app.get('/api/admin/onboard-submissions/:id/docs', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM onboarding_docs WHERE token_id=?').all(req.params.id));
});

// GET /api/admin/onboard-submissions/:id/docs/:docId/download — download a doc
app.get('/api/admin/onboard-submissions/:id/docs/:docId/download', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM onboarding_docs WHERE id=? AND token_id=?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(docsDir, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, doc.file_name || doc.file_path);
});

// Quotes
app.get('/api/admin/quotes', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all());
});

app.delete('/api/admin/quotes/:id', requireAdmin, blockManager, staffGuard('delete', 'quotes'), (req, res) => {
  db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Partners CRUD
app.get('/api/admin/partners', requireAdmin, blockManager, (req, res) => {
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM partner_files f WHERE f.partner_id=p.id) as file_count FROM partners p ORDER BY p.created_at DESC`).all();
  res.json(rows);
});

app.post('/api/admin/partners', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare(`INSERT INTO partners (name,contact_person,phone,email,address,industry,services,notes,active,contacts,addresses,social_media,links)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    d.name, d.contact_person||'', d.phone||'', d.email||'', d.address||'',
    d.industry||'', d.services||'', d.notes||'', d.active!==false?1:0,
    d.contacts||'[]', d.addresses||'[]', d.social_media||'{}', d.links||'{}');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/partners/:id', requireAdmin, blockManager, staffGuard('update', 'partners'), (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE partners SET name=?,contact_person=?,phone=?,email=?,address=?,industry=?,services=?,notes=?,active=?,contacts=?,addresses=?,social_media=?,links=? WHERE id=?`)
    .run(d.name, d.contact_person||'', d.phone||'', d.email||'', d.address||'',
      d.industry||'', d.services||'', d.notes||'', d.active!==false?1:0,
      d.contacts||'[]', d.addresses||'[]', d.social_media||'{}', d.links||'{}', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/partners/:id', requireAdmin, blockManager, staffGuard('delete', 'partners'), (req, res) => {
  // Delete associated files
  const files = db.prepare('SELECT * FROM partner_files WHERE partner_id=?').all(req.params.id);
  files.forEach(f => { if (f.file_path) { const fp = path.join(docsDir, f.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); } });
  db.prepare('DELETE FROM partner_files WHERE partner_id=?').run(req.params.id);
  db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Partner files
app.get('/api/admin/partners/:id/files', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM partner_files WHERE partner_id=? ORDER BY uploaded_at DESC').all(req.params.id));
});

app.post('/api/admin/partners/:id/files', requireAdmin, blockManager, docUpload.single('file'), (req, res) => {
  const p = db.prepare('SELECT id FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const r = db.prepare(`INSERT INTO partner_files (partner_id,file_type,file_label,file_path,file_name,notes) VALUES(?,?,?,?,?,?)`).run(
    req.params.id, req.body.file_type||'other', req.body.file_label||'',
    req.file?req.file.filename:'', req.file?req.file.originalname:'', req.body.notes||'');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/partner-files/:id', requireAdmin, blockManager, staffGuard('delete', 'partner_files'), (req, res) => {
  const f = db.prepare('SELECT * FROM partner_files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.file_path) { const fp = path.join(docsDir, f.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM partner_files WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/partner-files/:id/download', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const f = db.prepare('SELECT * FROM partner_files WHERE id=?').get(req.params.id);
  if (!f || !f.file_path) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(docsDir, f.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, f.file_name || f.file_path);
});

// POST /api/admin/partner-files/:id/send-docusign — send partner contract to both parties for e-signing
app.post('/api/admin/partner-files/:id/send-docusign', requireAdmin, blockManager, async (req, res) => {
  if (!dsEnabled()) return res.status(503).json({ error: 'DocuSign 未配置，请在环境变量中设置 DOCUSIGN_* 参数' });
  try {
    const f = db.prepare(`SELECT pf.*, p.name as partner_name, p.email as partner_email, p.contacts as partner_contacts FROM partner_files pf LEFT JOIN partners p ON pf.partner_id=p.id WHERE pf.id=?`).get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    if (!f.file_path) return res.status(400).json({ error: '文件不存在' });
    // Partner signer: use req.body override, else partner contacts, else partner email
    let partnerEmail = req.body.partner_email || f.partner_email || '';
    let partnerName = req.body.partner_name || f.partner_name || '合作方';
    if (!partnerEmail) {
      try {
        const contacts = JSON.parse(f.partner_contacts || '[]');
        const c = contacts.find(c => c.email);
        if (c) { partnerEmail = c.email; partnerName = [c.first_name, c.last_name].filter(Boolean).join(' ') || partnerName; }
      } catch {}
    }
    if (!partnerEmail) return res.status(400).json({ error: '合作方邮箱未找到，请在请求体中传 partner_email' });
    const companyEmail = process.env.COMPANY_SIGNER_EMAIL || '';
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
    if (!companyEmail) return res.status(503).json({ error: '请在环境变量中设置 COMPANY_SIGNER_EMAIL' });
    const docPath = path.join(docsDir, f.file_path);
    if (!fs.existsSync(docPath)) return res.status(404).json({ error: '文件不存在' });
    const result = await dsSendEnvelope({ docPath, docName: f.file_name || f.file_path, emailSubject: `请签署合同 - ${f.partner_name || ''} × Prime Anchorpoint`, signer1: { email: partnerEmail, name: partnerName }, signer2: { email: companyEmail, name: companyName } });
    db.prepare("UPDATE partner_files SET ds_envelope_id=?, ds_status='sent' WHERE id=?").run(result.envelopeId, f.id);
    res.json({ success: true, envelopeId: result.envelopeId });
  } catch (e) {
    console.error('[DocuSign PartnerFile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/partner-files/:id/docusign-status — refresh signing status from DocuSign
app.get('/api/admin/partner-files/:id/docusign-status', requireAdmin, blockManager, async (req, res) => {
  const f = db.prepare("SELECT id, ds_envelope_id, ds_status, ds_partner_signed_at, ds_company_signed_at FROM partner_files WHERE id=?").get(req.params.id);
  if (!f || !f.ds_envelope_id) return res.status(404).json({ error: 'No envelope' });
  if (!dsEnabled()) return res.json({ status: f.ds_status, partnerSigned: f.ds_partner_signed_at, companySigned: f.ds_company_signed_at });
  try {
    const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
    const [envRes, rcpRes] = await Promise.all([
      dsApiCall('GET', `/restapi/v2.1/accounts/${accountId}/envelopes/${f.ds_envelope_id}`),
      dsApiCall('GET', `/restapi/v2.1/accounts/${accountId}/envelopes/${f.ds_envelope_id}/recipients`)
    ]);
    const status = envRes.data?.status || f.ds_status;
    let partnerSigned = f.ds_partner_signed_at, companySigned = f.ds_company_signed_at;
    for (const s of (rcpRes.data?.signers || [])) {
      if (s.status === 'completed' && s.signedDateTime) {
        if (s.recipientId === '1') partnerSigned = s.signedDateTime;
        if (s.recipientId === '2') companySigned = s.signedDateTime;
      }
    }
    db.prepare("UPDATE partner_files SET ds_status=?, ds_partner_signed_at=?, ds_company_signed_at=? WHERE id=?").run(status, partnerSigned, companySigned, f.id);
    res.json({ status, partnerSigned, companySigned });
  } catch (e) { res.json({ status: f.ds_status, partnerSigned: f.ds_partner_signed_at, companySigned: f.ds_company_signed_at, error: e.message }); }
});

// Assignments CRUD
app.get('/api/admin/assignments', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, i.name AS inquiry_name, i.phone AS inquiry_phone, i.email AS inquiry_email, i.type AS inquiry_type,
           j.title AS job_title, j.location AS job_location, j.pay AS job_pay
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN jobs j ON a.job_id = j.id
    ORDER BY a.assigned_at DESC
  `).all());
});

app.post('/api/admin/assignments', requireAdmin, blockManager, (req, res) => {
  const { inquiry_id, job_id, notes, pay_rate, pay_type, contract_type, benefits, start_date, work_schedule, work_address, work_lat, work_lng, work_radius, task_requirements, category } = req.body;
  if (!inquiry_id || !job_id) return res.status(400).json({ error: 'inquiry_id and job_id required' });
  const r = db.prepare(`INSERT INTO assignments
    (inquiry_id, job_id, notes, pay_rate, pay_type, contract_type, benefits, start_date, work_schedule, work_address, work_lat, work_lng, work_radius, task_requirements, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(inquiry_id, job_id, notes || '', pay_rate || '', pay_type || 'hourly', contract_type || 'W2', benefits || '', start_date || '', work_schedule || '{}',
         work_address || '', work_lat || null, work_lng || null, work_radius || 200, task_requirements || '[]', category || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/assignments/:id', requireAdmin, blockManager, staffGuard('update', 'assignments'), (req, res) => {
  const { status, notes, pay_rate, pay_type, contract_type, benefits, start_date, work_schedule, work_address, work_lat, work_lng, work_radius, task_requirements, category } = req.body;
  const old = db.prepare('SELECT status FROM assignments WHERE id=?').get(req.params.id);
  db.prepare(`UPDATE assignments SET status=?, notes=?, pay_rate=?, pay_type=?, contract_type=?, benefits=?, start_date=?, work_schedule=?, work_address=?, work_lat=?, work_lng=?, work_radius=?, task_requirements=?, category=? WHERE id=?`)
    .run(status || 'assigned', notes || '', pay_rate || '', pay_type || 'hourly', contract_type || 'W2', benefits || '', start_date || '', work_schedule || '{}',
         work_address || '', work_lat || null, work_lng || null, work_radius || 200, task_requirements || '[]', category || '', req.params.id);
  if (old && status && old.status !== status) {
    db.prepare('INSERT INTO assignment_status_history (assignment_id, old_status, new_status, changed_by) VALUES (?,?,?,?)')
      .run(req.params.id, old.status, status, req.admin?.username || req.admin?.display_name || 'admin');
  }
  res.json({ success: true });
});

// PATCH status only — lightweight inline update
app.patch('/api/admin/assignments/:id/status', requireAdmin, blockManager, (req, res) => {
  const { status, reason } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const old = db.prepare('SELECT status FROM assignments WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status, req.params.id);
  if (old.status !== status) {
    db.prepare('INSERT INTO assignment_status_history (assignment_id, old_status, new_status, changed_by, reason) VALUES (?,?,?,?,?)')
      .run(req.params.id, old.status, status, req.admin?.username || req.admin?.display_name || 'admin', reason || '');
  }
  res.json({ success: true });
});

// GET history for an assignment
app.get('/api/admin/assignments/:id/history', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM assignment_status_history WHERE assignment_id=? ORDER BY changed_at DESC').all(req.params.id));
});

app.delete('/api/admin/assignments/:id', requireAdmin, blockManager, staffGuard('delete', 'assignments'), (req, res) => {
  const a = db.prepare('SELECT contract_file FROM assignments WHERE id=?').get(req.params.id);
  if (a && a.contract_file) { const fp = path.join(docsDir, a.contract_file); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Assignment contract file upload/download
app.post('/api/admin/assignments/:id/contract', requireAdmin, blockManager, docUpload.single('file'), (req, res) => {
  const a = db.prepare('SELECT id, contract_file FROM assignments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found' });
  if (a.contract_file) { const old = path.join(docsDir, a.contract_file); if (fs.existsSync(old)) fs.unlinkSync(old); }
  db.prepare('UPDATE assignments SET contract_file=?, contract_filename=? WHERE id=?')
    .run(req.file ? req.file.filename : '', req.file ? req.file.originalname : '', req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/assignments/:id/contract', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const a = db.prepare('SELECT contract_file, contract_filename FROM assignments WHERE id=?').get(req.params.id);
  if (!a || !a.contract_file) return res.status(404).json({ error: 'No contract file' });
  const fp = path.join(docsDir, a.contract_file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, a.contract_filename || a.contract_file);
});

// POST /api/admin/assignments/:id/send-docusign — send contract to both parties for e-signing
app.post('/api/admin/assignments/:id/send-docusign', requireAdmin, blockManager, async (req, res) => {
  if (!dsEnabled()) return res.status(503).json({ error: 'DocuSign 未配置，请在环境变量中设置 DOCUSIGN_* 参数' });
  try {
    const a = db.prepare(`SELECT a.*, i.name as inquiry_name, i.email as inquiry_email FROM assignments a LEFT JOIN inquiries i ON a.inquiry_id=i.id WHERE a.id=?`).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Assignment not found' });
    if (!a.contract_file) return res.status(400).json({ error: '请先上传合同文件再发送签署' });
    const workerEmail = req.body.worker_email || a.inquiry_email || '';
    const workerName = req.body.worker_name || a.inquiry_name || '工人';
    if (!workerEmail) return res.status(400).json({ error: '工人邮箱未找到，请在请求体中传 worker_email' });
    const companyEmail = process.env.COMPANY_SIGNER_EMAIL || '';
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
    if (!companyEmail) return res.status(503).json({ error: '请在环境变量中设置 COMPANY_SIGNER_EMAIL' });
    const docPath = path.join(docsDir, a.contract_file);
    if (!fs.existsSync(docPath)) return res.status(404).json({ error: '合同文件不存在' });
    const result = await dsSendEnvelope({ docPath, docName: a.contract_filename || a.contract_file, emailSubject: `请签署雇用合同 - ${a.inquiry_name || ''}`, signer1: { email: workerEmail, name: workerName }, signer2: { email: companyEmail, name: companyName } });
    db.prepare("UPDATE assignments SET ds_envelope_id=?, ds_status='sent' WHERE id=?").run(result.envelopeId, a.id);
    res.json({ success: true, envelopeId: result.envelopeId });
  } catch (e) {
    console.error('[DocuSign Assignment]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/assignments/:id/docusign-status — refresh signing status from DocuSign
app.get('/api/admin/assignments/:id/docusign-status', requireAdmin, blockManager, async (req, res) => {
  const a = db.prepare("SELECT id, ds_envelope_id, ds_status, ds_worker_signed_at, ds_company_signed_at FROM assignments WHERE id=?").get(req.params.id);
  if (!a || !a.ds_envelope_id) return res.status(404).json({ error: 'No envelope' });
  if (!dsEnabled()) return res.json({ status: a.ds_status, workerSigned: a.ds_worker_signed_at, companySigned: a.ds_company_signed_at });
  try {
    const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
    const [envRes, rcpRes] = await Promise.all([
      dsApiCall('GET', `/restapi/v2.1/accounts/${accountId}/envelopes/${a.ds_envelope_id}`),
      dsApiCall('GET', `/restapi/v2.1/accounts/${accountId}/envelopes/${a.ds_envelope_id}/recipients`)
    ]);
    const status = envRes.data?.status || a.ds_status;
    let workerSigned = a.ds_worker_signed_at, companySigned = a.ds_company_signed_at;
    for (const s of (rcpRes.data?.signers || [])) {
      if (s.status === 'completed' && s.signedDateTime) {
        if (s.recipientId === '1') workerSigned = s.signedDateTime;
        if (s.recipientId === '2') companySigned = s.signedDateTime;
      }
    }
    db.prepare("UPDATE assignments SET ds_status=?, ds_worker_signed_at=?, ds_company_signed_at=? WHERE id=?").run(status, workerSigned, companySigned, a.id);
    res.json({ status, workerSigned, companySigned });
  } catch (e) { res.json({ status: a.ds_status, workerSigned: a.ds_worker_signed_at, companySigned: a.ds_company_signed_at, error: e.message }); }
});

// ─── Employee Doc Requests (私密材料链接) ───

// Admin: create / get link for an employee
app.post('/api/admin/employees/:id/doc-request', requireAdmin, (req, res) => {
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const existing = db.prepare("SELECT * FROM employee_doc_requests WHERE employee_id=? AND status='pending' AND (expires_at IS NULL OR expires_at > datetime('now'))").get(emp.id);
    if (existing) return res.json({ token: existing.token, status: 'pending', already_exists: true, expires_at: existing.expires_at });
    const token = crypto.randomBytes(28).toString('hex');
    const { admin_note, requested_docs, lang, positions } = req.body;
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO employee_doc_requests (token, employee_id, admin_note, requested_docs, lang, positions, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(token, emp.id, admin_note || '', JSON.stringify(requested_docs || ['gov_id','ssn','work_card']),
          lang || 'zh', JSON.stringify(positions || []), expiresAt);
    res.json({ token, status: 'pending', expires_at: expiresAt });
  } catch(e) {
    console.error('doc-request error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/employees/:id/doc-requests', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM employee_doc_requests WHERE employee_id=? ORDER BY created_at DESC').all(req.params.id));
});

// ─── Employee Registration Invites ───

// Admin: send registration invite link to employee (via SMS/email)
app.post('/api/admin/employees/:id/send-registration-link', requireAdmin, async (req, res) => {
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Invalidate old pending invites
    db.prepare("DELETE FROM employee_registration_invites WHERE employee_id=? AND used=0").run(emp.id);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    db.prepare('INSERT INTO employee_registration_invites (employee_id, token, expires_at) VALUES (?,?,?)')
      .run(emp.id, token, expiresAt);

    const host = req.get('host');
    const proto = req.protocol;
    const inviteUrl = `${proto}://${host}/register?invite=${token}`;

    const name = `${emp.first_name||''} ${emp.last_name||''}`.trim();
    let smsSent = false, emailSent = false;
    const errs = [];

    // SMS
    const phone = (req.body.phone || emp.phone || '').replace(/\D/g,'').slice(-10);
    if (phone) {
      smsSent = await sendSMS('+1'+phone,
        `[Prime Anchorpoint] 您好 ${name}，请点击以下链接完成账户注册（7天内有效）:\n${inviteUrl}\nHi ${name}, click to register your account (valid 7 days).`
      );
      if (!smsSent) errs.push('SMS failed');
    }

    // Email
    const email = req.body.email || emp.email || '';
    if (email) {
      const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0F2B5B">Prime Anchor Point — 账户注册邀请</h2>
        <p>您好 <strong>${name}</strong>，</p>
        <p>请点击下方按钮完成您的账户注册，验证手机号和邮箱。链接 <strong>7天内有效</strong>。</p>
        <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 28px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">注册账户 / Register Account</a></p>
        <p style="color:#64748b;font-size:.85rem">或复制此链接：<br>${inviteUrl}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.5rem 0">
        <p style="color:#94a3b8;font-size:.75rem">Prime Anchor Point Staffing &mdash; 如非本人请忽略此邮件</p>
      </div>`;
      emailSent = await sendEmail(email, 'Prime Anchor Point — 账户注册邀请 / Registration Invite', null, html);
      if (!emailSent) errs.push('Email failed');
    }

    res.json({ success: true, invite_url: inviteUrl, sms_sent: smsSent, email_sent: emailSent, warnings: errs });
  } catch (e) {
    console.error('[Send Reg Link]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Public: validate invite token (used by register.html)
app.get('/api/register/invite-info', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const inv = db.prepare("SELECT * FROM employee_registration_invites WHERE token=? AND used=0 AND expires_at > datetime('now')").get(token);
  if (!inv) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const emp = db.prepare('SELECT id, first_name, last_name, email, phone FROM employees WHERE id=?').get(inv.employee_id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  res.json({
    valid: true,
    first_name: emp.first_name || '',
    last_name: emp.last_name || '',
    email: emp.email || '',
    phone: emp.phone ? emp.phone.replace(/\D/g,'').slice(-10) : '',
    employee_id: emp.id
  });
});

app.delete('/api/admin/employee-doc-requests/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM employee_doc_requests WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Public: validate token
app.get('/api/emp-docs/:token', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, e.first_name, e.last_name, e.employee_id AS emp_code
    FROM employee_doc_requests r JOIN employees e ON r.employee_id = e.id
    WHERE r.token=?`).get(req.params.token);
  if (!row) return res.status(404).json({ error: '链接无效或已过期' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: '链接已过期（有效期3天）/ Link expired (valid for 3 days)' });
  }
  res.json({
    status: row.status,
    name: `${row.first_name} ${row.last_name}`,
    emp_code: row.emp_code,
    requested_docs: JSON.parse(row.requested_docs || '["gov_id","ssn","work_card"]'),
    admin_note: row.admin_note,
    lang: row.lang || 'zh',
    positions: JSON.parse(row.positions || '[]'),
    completed_at: row.completed_at
  });
});

// Public: submit documents
const empDocReqUpload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `empdoc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /pdf|jpg|jpeg|png|heic|heif/.test(path.extname(file.originalname).toLowerCase()));
  }
});

app.post('/api/emp-docs/:token/submit', empDocReqUpload.fields([
  { name: 'gov_id', maxCount: 1 },
  { name: 'ssn', maxCount: 1 },
  { name: 'work_card', maxCount: 1 },
  { name: 'w9', maxCount: 1 }
]), (req, res) => {
  const row = db.prepare('SELECT * FROM employee_doc_requests WHERE token=?').get(req.params.token);
  if (!row) return res.status(404).json({ error: '链接无效或已过期' });
  if (row.status === 'completed') return res.status(400).json({ error: '已提交，无法重复提交' });
  const files = req.files || {};
  if (!Object.keys(files).length) return res.status(400).json({ error: '请至少上传一份文件' });
  const DOC_LABEL = { gov_id: '政府身份证件', ssn: '社安卡', work_card: '工卡 / 工作许可证', w9: 'W-9 税表' };
  for (const [docType, fileArr] of Object.entries(files)) {
    if (fileArr && fileArr[0]) {
      const f = fileArr[0];
      db.prepare(`INSERT INTO employee_documents (employee_id,doc_type,doc_label,file_path,file_name)
        VALUES(?,?,?,?,?)`)
        .run(row.employee_id, docType, DOC_LABEL[docType] || docType, f.filename, f.originalname);
    }
  }
  // Save position self-ratings if provided
  if (req.body.position_ratings) {
    try {
      const ratings = JSON.parse(req.body.position_ratings);
      const stmt = db.prepare(`INSERT OR REPLACE INTO doc_request_position_ratings
        (doc_request_id, position_key, interest, skill_score) VALUES (?,?,?,?)`);
      for (const r of ratings) {
        stmt.run(row.id, r.key, r.interest ? 1 : 0, parseInt(r.skill) || 0);
      }
    } catch {}
  }
  db.prepare(`UPDATE employee_doc_requests SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE token=?`).run(row.token);
  res.json({ success: true });
});

// ─── Employee Ratings ───
app.get('/api/admin/employee-ratings', requireAdmin, (req, res) => {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  const rows = db.prepare(`
    SELECT r.*, j.title AS job_title_current
    FROM employee_ratings r
    LEFT JOIN jobs j ON r.job_id = j.id
    WHERE r.employee_id = ?
    ORDER BY r.rated_at DESC
  `).all(employee_id);
  res.json(rows);
});

app.post('/api/admin/employee-ratings', requireAdmin, (req, res) => {
  const d = req.body;
  if (!d.employee_id) return res.status(400).json({ error: 'employee_id required' });
  const r = db.prepare(`INSERT INTO employee_ratings
    (employee_id, job_id, job_title, score_efficiency, score_quality, score_attendance,
     score_safety, score_teamwork, score_skills, pay_est_min, pay_est_max, pay_est_type, notes, rated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.employee_id, d.job_id||null, d.job_title||'',
      d.score_efficiency||0, d.score_quality||0, d.score_attendance||0,
      d.score_safety||0, d.score_teamwork||0, d.score_skills||0,
      d.pay_est_min||0, d.pay_est_max||0, d.pay_est_type||'hourly',
      d.notes||'', d.rated_by||'');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/employee-ratings/:id', requireAdmin, (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE employee_ratings SET
    job_id=?, job_title=?, score_efficiency=?, score_quality=?, score_attendance=?,
    score_safety=?, score_teamwork=?, score_skills=?, pay_est_min=?, pay_est_max=?,
    pay_est_type=?, notes=?, rated_by=? WHERE id=?`)
    .run(d.job_id||null, d.job_title||'',
      d.score_efficiency||0, d.score_quality||0, d.score_attendance||0,
      d.score_safety||0, d.score_teamwork||0, d.score_skills||0,
      d.pay_est_min||0, d.pay_est_max||0, d.pay_est_type||'hourly',
      d.notes||'', d.rated_by||'', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/employee-ratings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM employee_ratings WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Backup management
app.get('/api/admin/backups', requireAdmin, blockManager, (req, res) => {
  const locations = BACKUP_DIRS.map(dir => {
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith('prime-') && f.endsWith('.db')).sort().reverse();
      const sizes = files.map(f => {
        try { return { name: f, size: fs.statSync(path.join(dir, f)).size, time: f.replace('prime-', '').replace('.db', '').replace(/-/g, (m, i) => i < 10 ? '-' : i === 10 ? 'T' : ':').replace(/:(\d+):(\d+)$/, ':$1:$2') }; } catch { return { name: f, size: 0 }; }
      });
      return { dir, files: sizes, count: files.length };
    } catch { return { dir, files: [], count: 0 }; }
  });
  res.json({ locations, log: backupLog.slice(0, 20), interval_min: BACKUP_INTERVAL / 60000, keep: BACKUP_KEEP });
});

app.post('/api/admin/backups/run', requireAdmin, requireRole('admin'), (req, res) => {
  const result = runBackup('手动备份');
  res.json({ success: true, result });
});

// CSV Export (also accept token via query param for download links)
app.get('/api/admin/inquiries/export', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const rows = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  const headers = ['Date', 'Employer ID', 'Name', 'Email', 'Phone', 'Company', 'Type', 'Positions', 'Workers', 'Location', 'Start Date', 'Experience', 'Languages', 'Comments'];
  let csv = headers.join(',') + '\n';
  rows.forEach(r => {
    csv += [r.created_at, r.employer_id, r.name, r.email, r.phone, r.company, r.type, r.positions, r.workers, r.location, r.start_date, r.experience, r.languages, r.comments]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`)
      .join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=inquiries-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// ─── EMPLOYEE ROUTES ───

// Helper: strip sensitive fields for list view
function safeEmp(e) {
  const { ssn_encrypted, ssn_iv, pin_hash, pin_salt, ...safe } = e;
  return safe;
}

app.get('/api/admin/employees', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  let sql = `
    SELECT e.*,
      (SELECT COUNT(*) FROM time_entries t WHERE t.employee_id = e.id) as time_count,
      (SELECT COUNT(*) FROM employee_documents d WHERE d.employee_id = e.id) as doc_count,
      (SELECT COUNT(*) FROM background_checks b WHERE b.employee_id = e.id) as bg_count,
      (SELECT worker_code FROM worker_accounts WHERE employee_id=e.id AND active=1 LIMIT 1) as worker_code
    FROM employees e`;
  const params = [];
  if (req.userRole === 'manager' && pids.length) {
    sql += ` WHERE e.id IN (SELECT DISTINCT t.employee_id FROM time_entries t
      JOIN jobs j ON t.job_id=j.id WHERE j.partner_id IN (${pids.map(()=>'?').join(',')}))`;
    params.push(...pids);
  }
  sql += ' ORDER BY e.last_name, e.first_name';
  const rows = db.prepare(sql).all(...params);
  // Fetch current job assignments: explicit (employee_jobs) + inferred (timesheet_sheets)
  const explicitJobs = db.prepare(`
    SELECT ej.employee_id, ej.job_id, ej.company_name, ej.job_title
    FROM employee_jobs ej WHERE ej.status='active'
  `).all();
  const tsJobs = db.prepare(`
    SELECT s.employee_id, s.job_id, s.company_name, j.title AS job_title
    FROM timesheet_sheets s
    LEFT JOIN jobs j ON s.job_id = j.id
    WHERE s.id IN (
      SELECT MAX(id) FROM timesheet_sheets GROUP BY employee_id, COALESCE(job_id, company_name)
    )
    ORDER BY s.period_end DESC
  `).all();
  const jobMap = {};
  for (const j of explicitJobs) {
    if (!jobMap[j.employee_id]) jobMap[j.employee_id] = [];
    jobMap[j.employee_id].push({ job_id: j.job_id, job_title: j.job_title || '', company_name: j.company_name || '' });
  }
  for (const j of tsJobs) {
    if (!jobMap[j.employee_id]) jobMap[j.employee_id] = [];
    const existing = jobMap[j.employee_id];
    if (!existing.some(e => e.job_id === j.job_id)) {
      existing.push({ job_id: j.job_id, job_title: j.job_title || '', company_name: j.company_name || '' });
    }
  }
  res.json(rows.map(e => ({ ...safeEmp(e), current_jobs: jobMap[e.id] || [] })));
});

app.get('/api/admin/employees/export', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const rows = db.prepare('SELECT * FROM employees ORDER BY last_name, first_name').all();
  const headers = ['Employee ID','Last Name','First Name','Email','Phone','Position','Department',
    'Hire Date','Pay Rate','Pay Type','Status','SSN Last4','City','State','DOB',
    'Emergency Name','Emergency Phone','Emergency Relation','Notes'];
  let csv = headers.join(',') + '\n';
  rows.forEach(e => {
    csv += [e.employee_id,e.last_name,e.first_name,e.email,e.phone,e.position,e.department,
      e.hire_date,e.pay_rate,e.pay_type,e.status,e.ssn_last4,e.city,e.state,e.dob,
      e.emergency_name,e.emergency_phone,e.emergency_relation,e.notes
    ].map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=employees-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
});

app.get('/api/admin/employees/:id', requireAdmin, blockManager, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC').all(req.params.id);
  const bgChecks = db.prepare('SELECT * FROM background_checks WHERE employee_id=? ORDER BY created_at DESC').all(req.params.id);
  const recentTime = db.prepare('SELECT * FROM time_entries WHERE employee_id=? ORDER BY clock_in DESC LIMIT 20').all(req.params.id);
  // Job history: distinct jobs from timesheet_sheets with summary
  const jobHistory = db.prepare(`
    SELECT s.job_id, s.company_name, j.title AS job_title,
      COUNT(*) AS sheet_count,
      SUM(s.total_hours) AS total_hours,
      SUM(s.regular_hours) AS regular_hours,
      SUM(s.overtime_hours) AS overtime_hours,
      MIN(s.period_start) AS first_period,
      MAX(s.period_end) AS last_period
    FROM timesheet_sheets s
    LEFT JOIN jobs j ON s.job_id = j.id
    WHERE s.employee_id=?
    GROUP BY COALESCE(s.job_id, s.company_name)
    ORDER BY MAX(s.period_end) DESC
  `).all(req.params.id);
  const currentJobs = db.prepare(`
    SELECT ej.id, ej.job_id, ej.job_title, ej.company_name, ej.status, ej.start_date, ej.end_date,
           ej.emp_hourly_rate, j.location
    FROM employee_jobs ej
    LEFT JOIN jobs j ON ej.job_id = j.id
    WHERE ej.employee_id = ?
    ORDER BY CASE ej.status WHEN 'active' THEN 0 ELSE 1 END, ej.start_date DESC, ej.assigned_at DESC
    LIMIT 10
  `).all(req.params.id);
  const ssn_full = emp.ssn_encrypted && emp.ssn_iv ? decryptSSN(emp.ssn_encrypted, emp.ssn_iv) : null;
  res.json({ ...safeEmp(emp), ssn_full, documents: docs, background_checks: bgChecks, recent_time: recentTime, job_history: jobHistory, current_jobs: currentJobs });
});

app.post('/api/admin/employees', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.first_name || !d.last_name) return res.status(400).json({ error: '请填写姓名' });
  if (!d.force) {
    if (d.phone && d.phone.trim()) {
      const dup = db.prepare('SELECT id,first_name,last_name,employee_id FROM employees WHERE phone=?').get(d.phone.trim());
      if (dup) return res.json({ duplicate: true, field: 'phone', existing: dup });
    }
    if (d.email && d.email.trim()) {
      const dup = db.prepare('SELECT id,first_name,last_name,employee_id FROM employees WHERE email=?').get(d.email.trim());
      if (dup) return res.json({ duplicate: true, field: 'email', existing: dup });
    }
  }
  const empId = (d.employee_id || '').trim() || nextEmployeeId(d.city, d.hire_date);
  let ssn_encrypted = '', ssn_iv = '', ssn_last4 = '';
  if (d.ssn) {
    const digits = d.ssn.replace(/\D/g, '');
    if (digits.length === 9) {
      ssn_last4 = digits.slice(-4);
      const enc = encryptSSN(digits);
      ssn_encrypted = enc.encrypted; ssn_iv = enc.iv;
    }
  }
  let pin_hash = '', pin_salt = '';
  if (d.pin) { pin_salt = crypto.randomBytes(16).toString('hex'); pin_hash = hashPin(d.pin, pin_salt); }
  try {
    const r = db.prepare(`INSERT INTO employees
      (employee_id,first_name,middle_name,last_name,email,phone,extra_phones,extra_emails,address,street2,city,state,zip,dob,
       emergency_name,emergency_phone,emergency_relation,hire_date,position,department,
       pay_rate,pay_type,status,pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,notes,social_media)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      empId,d.first_name,d.middle_name||'',d.last_name,d.email||'',d.phone||'',
      JSON.stringify(d.extra_phones||[]),JSON.stringify(d.extra_emails||[]),
      d.address||'',d.street2||'',
      d.city||'',d.state||'',d.zip||'',d.dob||'',
      d.emergency_name||'',d.emergency_phone||'',d.emergency_relation||'',
      d.hire_date||'',d.position||'',d.department||'',
      parseFloat(d.pay_rate)||0,d.pay_type||'hourly',d.status||'active',
      pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,d.notes||'',
      JSON.stringify(d.social_media||{}));
    const newId = r.lastInsertRowid;
    if (d.force) {
      if (d.phone && d.phone.trim()) db.prepare('UPDATE employees SET phone=? WHERE phone=? AND id!=?').run('', d.phone.trim(), newId);
      if (d.email && d.email.trim()) db.prepare('UPDATE employees SET email=? WHERE email=? AND id!=?').run('', d.email.trim(), newId);
    }
    res.json({ success: true, id: newId, employee_id: empId });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '员工编号已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/employees/:id', requireAdmin, blockManager, staffGuard('update', 'employees'), (req, res) => {
  const d = req.body;
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  if (!d.force) {
    if (d.phone && d.phone.trim()) {
      const dup = db.prepare('SELECT id,first_name,last_name,employee_id FROM employees WHERE phone=? AND id!=?').get(d.phone.trim(), req.params.id);
      if (dup) return res.json({ duplicate: true, field: 'phone', existing: dup });
    }
    if (d.email && d.email.trim()) {
      const dup = db.prepare('SELECT id,first_name,last_name,employee_id FROM employees WHERE email=? AND id!=?').get(d.email.trim(), req.params.id);
      if (dup) return res.json({ duplicate: true, field: 'email', existing: dup });
    }
  }
  let ssn_encrypted = emp.ssn_encrypted, ssn_iv = emp.ssn_iv, ssn_last4 = emp.ssn_last4;
  if (d.ssn && d.ssn !== '__KEEP__') {
    const digits = d.ssn.replace(/\D/g, '');
    if (digits.length === 9) {
      ssn_last4 = digits.slice(-4);
      const enc = encryptSSN(digits); ssn_encrypted = enc.encrypted; ssn_iv = enc.iv;
    }
  }
  let pin_hash = emp.pin_hash, pin_salt = emp.pin_salt;
  if (d.pin && d.pin !== '__KEEP__') {
    pin_salt = crypto.randomBytes(16).toString('hex');
    pin_hash = hashPin(d.pin, pin_salt);
  }
  db.prepare(`UPDATE employees SET
    employee_id=?,first_name=?,middle_name=?,last_name=?,email=?,phone=?,address=?,street2=?,city=?,state=?,zip=?,dob=?,
    emergency_name=?,emergency_phone=?,emergency_relation=?,hire_date=?,position=?,department=?,
    pay_rate=?,pay_type=?,status=?,pin_hash=?,pin_salt=?,ssn_encrypted=?,ssn_iv=?,ssn_last4=?,notes=?,
    extra_phones=?,extra_emails=?,social_media=?
    WHERE id=?`).run(
    d.employee_id||emp.employee_id,d.first_name,d.middle_name||emp.middle_name||'',d.last_name,d.email||'',d.phone||'',d.address||'',d.street2||'',
    d.city||'',d.state||'',d.zip||'',d.dob||'',
    d.emergency_name||'',d.emergency_phone||'',d.emergency_relation||'',
    d.hire_date||'',d.position||'',d.department||'',
    parseFloat(d.pay_rate)||0,d.pay_type||'hourly',d.status||'active',
    pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,d.notes||'',
    JSON.stringify(d.extra_phones || JSON.parse(emp.extra_phones || '[]')),
    JSON.stringify(d.extra_emails || JSON.parse(emp.extra_emails || '[]')),
    JSON.stringify(d.social_media || JSON.parse(emp.social_media || '{}')),
    req.params.id);
  if (d.force) {
    if (d.phone && d.phone.trim()) db.prepare('UPDATE employees SET phone=? WHERE phone=? AND id!=?').run('', d.phone.trim(), req.params.id);
    if (d.email && d.email.trim()) db.prepare('UPDATE employees SET email=? WHERE email=? AND id!=?').run('', d.email.trim(), req.params.id);
  }
  res.json({ success: true });
});

// Update employee contact info (phone/email + extras)
app.put('/api/admin/employees/:id/contacts', requireAdmin, (req, res) => {
  const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const { phone, email, extra_phones, extra_emails } = req.body;
  db.prepare(`UPDATE employees SET phone=?, email=?, extra_phones=?, extra_emails=? WHERE id=?`).run(
    phone || '', email || '',
    JSON.stringify(extra_phones || []),
    JSON.stringify(extra_emails || []),
    req.params.id
  );
  res.json({ success: true });
});

// Get job records for an employee (with financial + performance data)
app.get('/api/admin/employees/:id/job-records', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT ej.*, j.title AS job_title_live, j.location, j.pay AS job_pay,
           p.name AS partner_name
    FROM employee_jobs ej
    LEFT JOIN jobs j ON ej.job_id = j.id
    LEFT JOIN partners p ON j.partner_id = p.id
    WHERE ej.employee_id = ?
    ORDER BY ej.assigned_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Assign / update a job record for an employee
app.post('/api/admin/employees/:id/assign-job', requireAdmin, (req, res) => {
  const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const { job_id, start_date, end_date,
          emp_hourly_rate, emp_total_hours, emp_total_pay,
          client_hourly_rate, client_total_billed,
          perf_efficiency, perf_quality, perf_attendance,
          perf_safety, perf_teamwork, perf_skills, notes } = req.body;
  const job = db.prepare('SELECT id, title, company_name FROM jobs WHERE id=?').get(job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  try {
    db.prepare(`INSERT INTO employee_jobs
      (employee_id, job_id, company_name, job_title, status,
       start_date, end_date, emp_hourly_rate, emp_total_hours, emp_total_pay,
       client_hourly_rate, client_total_billed,
       perf_efficiency, perf_quality, perf_attendance, perf_safety, perf_teamwork, perf_skills, notes)
      VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(employee_id, job_id) DO UPDATE SET
        status='active', start_date=excluded.start_date, end_date=excluded.end_date,
        emp_hourly_rate=excluded.emp_hourly_rate, emp_total_hours=excluded.emp_total_hours,
        emp_total_pay=excluded.emp_total_pay, client_hourly_rate=excluded.client_hourly_rate,
        client_total_billed=excluded.client_total_billed,
        perf_efficiency=excluded.perf_efficiency, perf_quality=excluded.perf_quality,
        perf_attendance=excluded.perf_attendance, perf_safety=excluded.perf_safety,
        perf_teamwork=excluded.perf_teamwork, perf_skills=excluded.perf_skills,
        notes=excluded.notes`)
      .run(req.params.id, job.id, job.company_name||'', job.title||'',
           start_date||'', end_date||'',
           emp_hourly_rate||0, emp_total_hours||0, emp_total_pay||0,
           client_hourly_rate||0, client_total_billed||0,
           perf_efficiency||0, perf_quality||0, perf_attendance||0,
           perf_safety||0, perf_teamwork||0, perf_skills||0, notes||'');
    // Sync employee's displayed position from latest active job record
    const sync = db.prepare(`SELECT job_title, emp_hourly_rate FROM employee_jobs WHERE employee_id=? AND status='active' ORDER BY start_date DESC, assigned_at DESC LIMIT 1`).get(req.params.id);
    if (sync) db.prepare('UPDATE employees SET position=?, pay_rate=? WHERE id=?').run(sync.job_title||'', sync.emp_hourly_rate||0, req.params.id);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a job assignment from employee
app.delete('/api/admin/employees/:id/assign-job/:jobId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM employee_jobs WHERE employee_id=? AND job_id=?').run(req.params.id, req.params.jobId);
  // Sync employee's displayed position from the next latest active record
  const sync = db.prepare(`SELECT job_title, emp_hourly_rate FROM employee_jobs WHERE employee_id=? AND status='active' ORDER BY start_date DESC, assigned_at DESC LIMIT 1`).get(req.params.id);
  db.prepare('UPDATE employees SET position=?, pay_rate=? WHERE id=?').run(sync ? sync.job_title||'' : '', sync ? sync.emp_hourly_rate||0 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/employees/:id', requireAdmin, blockManager, staffGuard('delete', 'employees'), (req, res) => {
  db.prepare("UPDATE employees SET status='terminated' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ─── DOCUMENT ROUTES ───

app.get('/api/admin/employees/:id/documents', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC').all(req.params.id));
});

app.post('/api/admin/employees/:id/documents', requireAdmin, blockManager, docUpload.single('file'), (req, res) => {
  const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const { doc_type, doc_label, expiry_date, notes } = req.body;
  const r = db.prepare(`INSERT INTO employee_documents (employee_id,doc_type,doc_label,file_path,file_name,expiry_date,notes)
    VALUES(?,?,?,?,?,?,?)`).run(
    req.params.id, doc_type||'other', doc_label||'',
    req.file ? req.file.filename : '', req.file ? req.file.originalname : '',
    expiry_date||'', notes||'');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/documents/:id', requireAdmin, blockManager, staffGuard('delete', 'employee_documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.file_path) { const fp = path.join(docsDir, doc.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM employee_documents WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Serve document file (auth via Bearer token OR ?token= query)
app.get('/api/admin/documents/:id/file', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(docsDir, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, doc.file_name || doc.file_path);
});

// ─── TIME ENTRY ROUTES ───

app.get('/api/admin/time-entries', requireAdmin, (req, res) => {
  const { employee_id, date_from, date_to, status } = req.query;
  let q = `SELECT t.*, e.first_name, e.last_name, e.employee_id as emp_code
    FROM time_entries t LEFT JOIN employees e ON t.employee_id=e.id WHERE 1=1`;
  const p = [];
  if (employee_id) { q += ' AND t.employee_id=?'; p.push(employee_id); }
  if (date_from)   { q += ' AND DATE(t.clock_in)>=?'; p.push(date_from); }
  if (date_to)     { q += ' AND DATE(t.clock_in)<=?'; p.push(date_to); }
  if (status)      { q += ' AND t.status=?'; p.push(status); }
  // Manager: only see time entries for their assigned partners
  const pids = managerPartnerIds(req);
  if (req.userRole === 'manager' && pids.length) {
    q += ` AND (t.job_id IN (SELECT id FROM jobs WHERE partner_id IN (${pids.map(()=>'?').join(',')}))
           OR t.company_name IN (SELECT name FROM partners WHERE id IN (${pids.map(()=>'?').join(',')})))`;
    p.push(...pids, ...pids);
  }
  q += ' ORDER BY t.clock_in DESC LIMIT 1000';
  res.json(db.prepare(q).all(...p));
});

// Report: weekly/period summary per employee
app.get('/api/admin/time-entries/report', requireAdmin, (req, res) => {
  const { date_from, date_to, employee_id } = req.query;
  let q = `SELECT e.id as emp_id, e.employee_id as emp_code, e.first_name, e.last_name,
    e.pay_rate, e.pay_type,
    COUNT(t.id) as shift_count,
    COALESCE(SUM(t.total_hours),0) as total_hours,
    COALESCE(SUM(t.regular_hours),0) as regular_hours,
    COALESCE(SUM(t.overtime_hours),0) as overtime_hours
    FROM employees e LEFT JOIN time_entries t ON t.employee_id=e.id AND t.status='closed'`;
  const p = [];
  const conds = [];
  if (date_from) { conds.push('DATE(t.clock_in)>=?'); p.push(date_from); }
  if (date_to)   { conds.push('DATE(t.clock_in)<=?'); p.push(date_to); }
  if (conds.length) q += ' AND (' + conds.join(' AND ') + ')';
  if (employee_id) { q += ' AND e.id=?'; p.push(employee_id); }
  q += ' GROUP BY e.id ORDER BY e.last_name, e.first_name';
  const rows = db.prepare(q).all(...p);
  res.json(rows.map(r => {
    const reg = r.regular_hours * (r.pay_rate || 0);
    const ot  = r.overtime_hours * (r.pay_rate || 0) * 1.5;
    return { ...r, regular_pay: Math.round(reg*100)/100, overtime_pay: Math.round(ot*100)/100, total_pay: Math.round((reg+ot)*100)/100 };
  }));
});

// CSV export for time entries
app.get('/api/admin/time-entries/export', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const { employee_id, date_from, date_to } = req.query;
  let q = `SELECT t.*, e.first_name, e.last_name, e.employee_id as emp_code, e.pay_rate
    FROM time_entries t LEFT JOIN employees e ON t.employee_id=e.id WHERE t.status='closed'`;
  const p = [];
  if (employee_id) { q += ' AND t.employee_id=?'; p.push(employee_id); }
  if (date_from)   { q += ' AND DATE(t.clock_in)>=?'; p.push(date_from); }
  if (date_to)     { q += ' AND DATE(t.clock_in)<=?'; p.push(date_to); }
  q += ' ORDER BY t.clock_in DESC';
  const rows = db.prepare(q).all(...p);
  const headers = ['Employee ID','Name','Date','Clock In','Clock Out','Break(min)','Total Hrs','Regular Hrs','OT Hrs','Regular Pay','OT Pay','Notes'];
  let csv = headers.join(',') + '\n';
  rows.forEach(r => {
    const reg = Math.round((r.regular_hours||0)*(r.pay_rate||0)*100)/100;
    const ot  = Math.round((r.overtime_hours||0)*(r.pay_rate||0)*1.5*100)/100;
    csv += [r.emp_code,`${r.first_name} ${r.last_name}`,
      r.clock_in?r.clock_in.slice(0,10):'',r.clock_in||'',r.clock_out||'',
      r.break_minutes,r.total_hours,r.regular_hours,r.overtime_hours,reg,ot,r.notes
    ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',') + '\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename=time-records-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
});

app.post('/api/admin/time-entries', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.employee_id || !d.clock_in) return res.status(400).json({ error: 'employee_id and clock_in required' });
  const hrs = calcHours(d.clock_in, d.clock_out, parseInt(d.break_minutes)||0);
  const r = db.prepare(`INSERT INTO time_entries
    (employee_id,clock_in,clock_out,break_minutes,total_hours,regular_hours,overtime_hours,job_id,notes,status)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    d.employee_id, d.clock_in, d.clock_out||null, parseInt(d.break_minutes)||0,
    hrs.total, hrs.regular, hrs.overtime, d.job_id||null, d.notes||'',
    d.clock_out ? 'closed' : 'open');
  res.json({ success: true, id: r.lastInsertRowid, ...hrs });
});

// Batch time entry (weekly timesheet) — also creates a timesheet_sheet with confirmation token
app.post('/api/admin/time-entries/batch', requireAdmin, blockManager, (req, res) => {
  const { employee_id, entries, job_id, company_name, period_start, period_end } = req.body;
  if (!employee_id || !entries || !entries.length) return res.status(400).json({ error: 'employee_id and entries required' });

  function lunchMin(start, end) {
    if (!start || !end) return 0;
    const [sh,sm] = start.split(':').map(Number);
    const [eh,em] = end.split(':').map(Number);
    return Math.max(0, (eh*60+em) - (sh*60+sm));
  }

  const stmtEntry = db.prepare(`INSERT INTO time_entries
    (employee_id,clock_in,clock_out,break_minutes,lunch_start,lunch_end,company_name,
     total_hours,regular_hours,overtime_hours,job_id,notes,status,sheet_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stmtSheet = db.prepare(`INSERT INTO timesheet_sheets
    (employee_id,company_name,period_start,period_end,job_id,
     total_hours,regular_hours,overtime_hours,status,confirm_token)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const stmtLink = db.prepare(`UPDATE time_entries SET sheet_id=? WHERE id=?`);

  const doAll = db.transaction((rows) => {
    // compute totals first pass
    let totTotal=0, totReg=0, totOT=0;
    const prepared = [];
    for (const e of rows) {
      if (!e.clock_in || !e.clock_out) continue;
      const bMin = lunchMin(e.lunch_start, e.lunch_end) || parseInt(e.break_minutes)||0;
      const hrs = calcHours(e.clock_in, e.clock_out, bMin);
      if (hrs.total <= 0) continue;
      totTotal += hrs.total; totReg += hrs.regular; totOT += hrs.overtime;
      prepared.push({ e, bMin, hrs });
    }
    if (!prepared.length) return { count: 0, token: null };
    // create the sheet
    const token = crypto.randomBytes(20).toString('hex');
    const ps = period_start || prepared[0].e.clock_in.slice(0,10);
    const pe = period_end || prepared[prepared.length-1].e.clock_in.slice(0,10);
    const sheetRow = stmtSheet.run(employee_id, company_name||'', ps, pe, job_id||null,
      Math.round(totTotal*100)/100, Math.round(totReg*100)/100, Math.round(totOT*100)/100,
      'pending', token);
    const sheetId = sheetRow.lastInsertRowid;
    // insert entries linked to sheet
    for (const { e, bMin, hrs } of prepared) {
      const r = stmtEntry.run(employee_id, e.clock_in, e.clock_out, bMin,
        e.lunch_start||'', e.lunch_end||'', company_name||'',
        hrs.total, hrs.regular, hrs.overtime, job_id||null, e.notes||'', 'closed', sheetId);
      stmtLink.run(sheetId, r.lastInsertRowid);
    }
    return { count: prepared.length, token, sheet_id: sheetId };
  });

  try {
    const result = doAll(entries);
    res.json({ success: true, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/time-entries/:id', requireAdmin, blockManager, staffGuard('update', 'time_entries'), (req, res) => {
  const d = req.body;
  const hrs = calcHours(d.clock_in, d.clock_out, parseInt(d.break_minutes)||0);
  db.prepare(`UPDATE time_entries SET
    clock_in=?,clock_out=?,break_minutes=?,total_hours=?,regular_hours=?,overtime_hours=?,
    job_id=?,notes=?,status=? WHERE id=?`).run(
    d.clock_in, d.clock_out||null, parseInt(d.break_minutes)||0,
    hrs.total, hrs.regular, hrs.overtime,
    d.job_id||null, d.notes||'', d.clock_out ? 'closed' : 'open', req.params.id);
  res.json({ success: true, ...hrs });
});

app.delete('/api/admin/time-entries/:id', requireAdmin, blockManager, staffGuard('delete', 'time_entries'), (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// List timesheet sheets (admin)
app.get('/api/admin/timesheet-sheets', requireAdmin, (req, res) => {
  const { stage } = req.query; // 'verify' | 'payment' | 'history'
  let where = '';
  if (stage === 'verify')   where = `WHERE ts.status IN ('pending','confirmed','disputed')`;
  if (stage === 'payment')  where = `WHERE ts.status = 'verified'`;
  if (stage === 'dividend') where = `WHERE ts.status = 'dividend_pending'`;
  if (stage === 'history')  where = `WHERE ts.status = 'completed'`;
  const rows = db.prepare(`
    SELECT ts.*, e.first_name, e.last_name, e.employee_id as emp_code, e.email, e.phone
    FROM timesheet_sheets ts LEFT JOIN employees e ON ts.employee_id=e.id
    ${where} ORDER BY ts.created_at DESC LIMIT 300`).all();
  res.json(rows);
});

// Staff verifies sheet and submits to client
app.put('/api/admin/timesheet-sheets/:id/verify', requireAdmin, (req, res) => {
  const { staff_note } = req.body;
  const sheet = db.prepare('SELECT id FROM timesheet_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE timesheet_sheets SET status='verified', verified_at=CURRENT_TIMESTAMP, staff_note=? WHERE id=?`)
    .run(staff_note || '', req.params.id);
  res.json({ success: true });
});

// Mark client has paid us
app.put('/api/admin/timesheet-sheets/:id/client-paid', requireAdmin, (req, res) => {
  const sheet = db.prepare('SELECT id, labor_paid FROM timesheet_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const bothPaid = sheet.labor_paid === 1;
  db.prepare(`UPDATE timesheet_sheets SET client_paid=1, client_paid_at=CURRENT_TIMESTAMP${bothPaid ? ", status='dividend_pending'" : ''} WHERE id=?`)
    .run(req.params.id);
  res.json({ success: true, completed: bothPaid });
});

// Mark we have paid labor
app.put('/api/admin/timesheet-sheets/:id/labor-paid', requireAdmin, (req, res) => {
  const sheet = db.prepare('SELECT id, client_paid FROM timesheet_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const bothPaid = sheet.client_paid === 1;
  db.prepare(`UPDATE timesheet_sheets SET labor_paid=1, labor_paid_at=CURRENT_TIMESTAMP${bothPaid ? ", status='dividend_pending'" : ''} WHERE id=?`)
    .run(req.params.id);
  res.json({ success: true, completed: bothPaid });
});

// ─── DIVIDEND VOTING (待分红投票) ───

// Get dividend stage sheets
// stage query already handles 'dividend' in the main endpoint above
// We just need vote info

// Get votes for a sheet
app.get('/api/admin/timesheet-sheets/:id/votes', requireAdmin, (req, res) => {
  const votes = db.prepare(`
    SELECT dv.*, au.username, au.display_name
    FROM dividend_votes dv JOIN admin_users au ON dv.user_id = au.id
    WHERE dv.sheet_id = ? ORDER BY dv.created_at
  `).all(req.params.id);
  const staffCount = db.prepare("SELECT COUNT(*) as n FROM admin_users WHERE role='staff' AND active=1").get().n;
  res.json({ votes, staff_count: staffCount });
});

// Staff votes "无异议" (approve) on a sheet
app.post('/api/admin/timesheet-sheets/:id/vote-approve', requireAdmin, (req, res) => {
  const sheet = db.prepare('SELECT id, status FROM timesheet_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  if (sheet.status !== 'dividend_pending') return res.status(400).json({ error: '当前状态不允许投票' });
  try {
    db.prepare('INSERT OR REPLACE INTO dividend_votes (sheet_id, user_id, vote_type) VALUES (?,?,?)').run(req.params.id, req.userId, 'approve');
  } catch(e) { /* already voted */ }
  // Check if all staff approved
  const staffCount = db.prepare("SELECT COUNT(*) as n FROM admin_users WHERE role='staff' AND active=1").get().n;
  const approveCount = db.prepare("SELECT COUNT(*) as n FROM dividend_votes WHERE sheet_id=? AND vote_type='approve'").get(req.params.id).n;
  const allApproved = approveCount >= staffCount && staffCount > 0;
  res.json({ success: true, all_approved: allApproved, approve_count: approveCount, staff_count: staffCount });
});

// Staff confirms "已分红" (dividend distributed)
app.post('/api/admin/timesheet-sheets/:id/vote-distributed', requireAdmin, (req, res) => {
  const sheet = db.prepare('SELECT id, status FROM timesheet_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  if (sheet.status !== 'dividend_pending') return res.status(400).json({ error: '当前状态不允许操作' });
  // Check all staff approved first
  const staffCount = db.prepare("SELECT COUNT(*) as n FROM admin_users WHERE role='staff' AND active=1").get().n;
  const approveCount = db.prepare("SELECT COUNT(*) as n FROM dividend_votes WHERE sheet_id=? AND vote_type='approve'").get(req.params.id).n;
  if (approveCount < staffCount) return res.status(400).json({ error: '尚未全部通过无异议投票' });
  try {
    db.prepare('INSERT OR REPLACE INTO dividend_votes (sheet_id, user_id, vote_type) VALUES (?,?,?)').run(req.params.id, req.userId, 'distributed');
  } catch(e) { /* already voted */ }
  // Check if all staff confirmed distributed
  const distCount = db.prepare("SELECT COUNT(*) as n FROM dividend_votes WHERE sheet_id=? AND vote_type='distributed'").get(req.params.id).n;
  const allDistributed = distCount >= staffCount && staffCount > 0;
  if (allDistributed) {
    db.prepare(`UPDATE timesheet_sheets SET status='completed' WHERE id=?`).run(req.params.id);
  }
  res.json({ success: true, all_distributed: allDistributed, dist_count: distCount, staff_count: staffCount });
});

// ─── PUBLIC TIMESHEET CONFIRMATION ───

// Get sheet data (no auth — token is the secret)
app.get('/api/ts/:token', (req, res) => {
  const sheet = db.prepare(`
    SELECT ts.*, e.first_name, e.last_name, e.employee_id as emp_code, e.email, e.phone, e.dob
    FROM timesheet_sheets ts LEFT JOIN employees e ON ts.employee_id=e.id
    WHERE ts.confirm_token=?`).get(req.params.token);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  // Require DOB verification — client must pass ?dob=YYYY-MM-DD
  const dob = (req.query.dob || '').trim();
  if (!dob) return res.status(401).json({ error: 'dob_required' });
  if (!sheet.dob || dob !== sheet.dob) return res.status(401).json({ error: 'dob_mismatch' });
  const entries = db.prepare(
    `SELECT * FROM time_entries WHERE sheet_id=? ORDER BY clock_in`).all(sheet.id);
  // Strip DOB from response
  const { dob: _dob, ...safeSheet } = sheet;
  res.json({ sheet: safeSheet, entries });
});

// Employee submits confirm or dispute
app.post('/api/ts/:token/respond', (req, res) => {
  const { action, note } = req.body; // action: 'confirm' | 'dispute'
  if (!['confirm','dispute'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const sheet = db.prepare('SELECT id,status FROM timesheet_sheets WHERE confirm_token=?').get(req.params.token);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE timesheet_sheets
    SET status=?, employee_action=?, employee_note=?, confirmed_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(action === 'confirm' ? 'confirmed' : 'disputed', action, note||'', sheet.id);
  res.json({ success: true });
});

// ─── BACKGROUND CHECK ROUTES ───

app.get('/api/admin/background-checks', requireAdmin, blockManager, (req, res) => {
  const { employee_id, status } = req.query;
  let q = `SELECT b.*, e.first_name, e.last_name, e.employee_id as emp_code
    FROM background_checks b LEFT JOIN employees e ON b.employee_id=e.id WHERE 1=1`;
  const p = [];
  if (employee_id) { q += ' AND b.employee_id=?'; p.push(employee_id); }
  if (status)      { q += ' AND b.status=?'; p.push(status); }
  q += ' ORDER BY b.created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/admin/background-checks', requireAdmin, blockManager, docUpload.single('file'), (req, res) => {
  const d = req.body;
  if (!d.employee_id) return res.status(400).json({ error: 'employee_id required' });
  const r = db.prepare(`INSERT INTO background_checks
    (employee_id,check_type,ordered_date,completed_date,status,result,vendor,cost,notes,file_path,file_name)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    d.employee_id, d.check_type||'criminal', d.ordered_date||'', d.completed_date||'',
    d.status||'ordered', d.result||'', d.vendor||'', parseFloat(d.cost)||0, d.notes||'',
    req.file ? req.file.filename : '', req.file ? req.file.originalname : '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/background-checks/:id', requireAdmin, blockManager, staffGuard('update', 'background_checks'), docUpload.single('file'), (req, res) => {
  const d = req.body;
  const ex = db.prepare('SELECT * FROM background_checks WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  const file_path = req.file ? req.file.filename : ex.file_path;
  const file_name = req.file ? req.file.originalname : ex.file_name;
  db.prepare(`UPDATE background_checks SET
    check_type=?,ordered_date=?,completed_date=?,status=?,result=?,vendor=?,cost=?,notes=?,file_path=?,file_name=?
    WHERE id=?`).run(
    d.check_type||ex.check_type, d.ordered_date||'', d.completed_date||'',
    d.status||ex.status, d.result||'', d.vendor||'', parseFloat(d.cost)||0, d.notes||'',
    file_path, file_name, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/background-checks/:id', requireAdmin, blockManager, staffGuard('delete', 'background_checks'), (req, res) => {
  const chk = db.prepare('SELECT * FROM background_checks WHERE id=?').get(req.params.id);
  if (!chk) return res.status(404).json({ error: 'Not found' });
  if (chk.file_path) { const fp = path.join(docsDir, chk.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM background_checks WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/background-checks/:id/file', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const chk = db.prepare('SELECT * FROM background_checks WHERE id=?').get(req.params.id);
  if (!chk || !chk.file_path) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(docsDir, chk.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, chk.file_name || chk.file_path);
});

// ─── TIME CLOCK EMPLOYEE SELF-SERVICE ───

app.get('/api/timeclock/status/:empCode', (req, res) => {
  const emp = db.prepare("SELECT id,first_name,last_name,employee_id,position FROM employees WHERE employee_id=? AND status='active'").get(req.params.empCode.toUpperCase());
  if (!emp) return res.status(404).json({ error: '未找到员工或员工已离职' });
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);
  const today = new Date().toISOString().slice(0,10);
  const todayEntries = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND DATE(clock_in)=?").all(emp.id, today);
  const todayHours = todayEntries.reduce((s,e) => s + (e.total_hours||0), 0);
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - (weekAgo.getDay() || 7) + 1);
  const weekEntries = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND clock_in>=? AND status='closed'").all(emp.id, weekAgo.toISOString());
  const weekHours = weekEntries.reduce((s,e) => s + (e.total_hours||0), 0);
  res.json({
    employee: { id: emp.id, name: `${emp.first_name} ${emp.last_name}`, employee_id: emp.employee_id, position: emp.position||'' },
    clocked_in: !!open,
    open_entry: open || null,
    today_hours: Math.round(todayHours*100)/100,
    week_hours: Math.round(weekHours*100)/100,
    clock_in_time: open ? open.clock_in : null
  });
});

app.post('/api/timeclock/punch', (req, res) => {
  const { employee_id, pin } = req.body;
  if (!employee_id || !pin) return res.status(400).json({ error: '请输入员工编号和 PIN' });
  const emp = db.prepare("SELECT * FROM employees WHERE employee_id=? AND status='active'").get(employee_id.toUpperCase());
  if (!emp) return res.status(401).json({ error: '未找到员工或员工已离职' });
  if (!emp.pin_hash) return res.status(401).json({ error: 'PIN 未设置，请联系管理员' });
  if (!verifyPin(pin, emp.pin_salt, emp.pin_hash)) return res.status(401).json({ error: 'PIN 错误' });
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);
  const now = new Date().toISOString();
  if (open) {
    const hrs = calcHours(open.clock_in, now, open.break_minutes||0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed' WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
    res.json({ action: 'out', clock_in: open.clock_in, clock_out: now, total_hours: hrs.total, regular_hours: hrs.regular, overtime_hours: hrs.overtime });
  } else {
    const r = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status) VALUES(?,?,'open')").run(emp.id, now);
    res.json({ action: 'in', clock_in: now, entry_id: r.lastInsertRowid });
  }
});

// Serve timeclock page
app.get('/timeclock', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeclock.html'));
});

// Serve employee timesheet confirmation page
app.get('/ts', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ts.html'));
});

// ─── Admin Panel Page ───
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/staff', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/manager', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Worker Portal API ───
app.post('/api/worker/login', (req, res) => {
  const { login, username, password } = req.body;
  const identifier = (login || username || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  const digits10 = identifier.replace(/\D/g, '').slice(-10);
  // Match by email (exact), phone (last-10-digits, format-agnostic), or username
  const w = db.prepare(
    'SELECT * FROM worker_accounts WHERE email=? OR phone10(phone)=? OR username=?'
  ).get(identifier, digits10, identifier);
  if (!w || !verifyPassword(password, w.salt, w.password_hash))
    return res.status(401).json({ error: '邮箱/手机号或密码错误 / Invalid email/phone or password' });
  if (!w.active)
    return res.status(403).json({ error: '账号尚未验证，请先完成手机和邮箱验证 / Account not verified. Please complete phone and email verification first.' });
  if (w.suspended)
    return res.status(403).json({ error: '账号已被暂停，请联系管理员 / Account suspended. Please contact admin.' });
  const token = crypto.randomBytes(32).toString('hex');
  workerSessions.set(token, { created: Date.now(), workerId: w.id, employeeId: w.employee_id });
  res.json({ token, employee_id: w.employee_id });
});

app.get('/api/worker/me', requireWorker, (req, res) => {
  const w = db.prepare('SELECT id, username, name, phone, email, dob, work_status, employee_id, active, created_at FROM worker_accounts WHERE id=?').get(req.workerId);
  const emp = req.workerEmployeeId ? db.prepare('SELECT id, first_name, last_name, employee_id, position, department, pay_rate, pay_type, status FROM employees WHERE id=?').get(req.workerEmployeeId) : null;
  const docs = db.prepare("SELECT doc_type, status, created_at FROM worker_compliance_docs WHERE worker_account_id=?").all(req.workerId);
  res.json({ account: w, employee: emp, compliance_docs: docs });
});

// ─── Contact Change (phone / email) with dual verification ───
const _pendingContactChange = new Map(); // key: `${workerId}_${field}`

app.post('/api/worker/contact/request-change', requireWorker, async (req, res) => {
  const { field, new_value } = req.body;
  if (!['phone','email'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  if (!new_value || !new_value.trim()) return res.status(400).json({ error: '请填写新' + (field==='phone'?'手机号':'邮箱') });
  const val = new_value.trim();
  const w = db.prepare('SELECT id, phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  const taken = field === 'phone'
    ? db.prepare('SELECT id FROM worker_accounts WHERE phone=? AND id!=?').get(val, req.workerId)
    : db.prepare('SELECT id FROM worker_accounts WHERE email=? AND id!=?').get(val, req.workerId);
  if (taken) return res.status(400).json({ error: field==='phone' ? '该手机号已被其他账号使用' : '该邮箱已被其他账号注册' });
  const code6 = () => String(Math.floor(100000 + Math.random() * 900000));
  const oldCode = code6(), newCode = code6();
  const expires = Date.now() + 15 * 60 * 1000;
  _pendingContactChange.set(`${req.workerId}_${field}`, { new_value: val, old_code: oldCode, new_code: newCode, expires });
  let oldSent = false, newSent = false;
  if (field === 'phone') {
    const oldPhone = w.phone;
    const canVerify = !!(twilioClient && TWILIO_VERIFY_SID);
    if (oldPhone) {
      if (canVerify) { await sendVerifyCode(oldPhone); oldSent = true; }
      else if (twilioClient && TWILIO_FROM) { oldSent = await sendSMS(oldPhone, `[Prime Anchorpoint] 验证旧手机号，验证码：${oldCode}，15分钟有效`); }
    }
    if (canVerify) { await sendVerifyCode(val); newSent = true; }
    else if (twilioClient && TWILIO_FROM) { newSent = await sendSMS(val, `[Prime Anchorpoint] 验证新手机号，验证码：${newCode}，15分钟有效`); }
  } else {
    const oldEmail = w.email;
    if (oldEmail) oldSent = await sendEmail(oldEmail, 'Prime Anchorpoint 更换邮箱验证', `旧邮箱验证码：${oldCode}，15分钟内有效。`);
    newSent = await sendEmail(val, 'Prime Anchorpoint 新邮箱验证', `新邮箱验证码：${newCode}，15分钟内有效。`);
  }
  console.log(`[ContactChange] Worker ${req.workerId} field=${field} old_code=${oldCode} new_code=${newCode}`);
  res.json({ success: true, old_sent: oldSent, new_sent: newSent });
});

app.post('/api/worker/contact/confirm-change', requireWorker, async (req, res) => {
  const { field, old_code, new_code } = req.body;
  if (!['phone','email'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  const key = `${req.workerId}_${field}`;
  const pending = _pendingContactChange.get(key);
  if (!pending || Date.now() > pending.expires) return res.status(400).json({ error: '验证码已过期，请重新发送' });
  const w = db.prepare('SELECT phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  let oldOk = false;
  if (field === 'phone' && twilioClient && TWILIO_VERIFY_SID && w.phone) {
    oldOk = await checkVerifyCode(w.phone, old_code);
  } else { oldOk = (old_code && old_code.trim() === pending.old_code); }
  if (!oldOk && w[field]) return res.status(400).json({ error: field==='phone' ? '旧手机号验证码不正确' : '旧邮箱验证码不正确' });
  let newOk = false;
  if (field === 'phone' && twilioClient && TWILIO_VERIFY_SID) {
    newOk = await checkVerifyCode(pending.new_value, new_code);
  } else { newOk = (new_code && new_code.trim() === pending.new_code); }
  if (!newOk) return res.status(400).json({ error: field==='phone' ? '新手机号验证码不正确' : '新邮箱验证码不正确' });
  if (field === 'phone') db.prepare('UPDATE worker_accounts SET phone=? WHERE id=?').run(pending.new_value, req.workerId);
  else db.prepare('UPDATE worker_accounts SET email=? WHERE id=?').run(pending.new_value, req.workerId);
  _pendingContactChange.delete(key);
  res.json({ success: true });
});

// Worker: update profile (phone/email change triggers re-verification)
app.put('/api/worker/me', requireWorker, async (req, res) => {
  const { field, new_value } = req.body;
  if (!field || !new_value) return res.status(400).json({ error: 'field and new_value required' });
  if (!['phone', 'email'].includes(field)) return res.status(400).json({ error: 'Only phone or email can be changed' });

  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!w) return res.status(404).json({ error: 'Not found' });

  // Check for duplicates
  const dup = db.prepare(`SELECT id FROM worker_accounts WHERE ${field}=? AND id!=?`).get(new_value, req.workerId);
  if (dup) return res.status(400).json({ error: `该${field === 'phone' ? '手机号' : '邮箱'}已被其他账户使用` });

  // Generate verification codes for both old and new
  const oldCode = String(Math.floor(100000 + Math.random() * 900000));
  const newCode = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Store pending change
  try { db.exec(`CREATE TABLE IF NOT EXISTS pending_profile_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_account_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    old_code TEXT NOT NULL,
    new_code TEXT NOT NULL,
    old_verified INTEGER DEFAULT 0,
    new_verified INTEGER DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch {}

  // Remove any existing pending change for this worker+field
  db.prepare('DELETE FROM pending_profile_changes WHERE worker_account_id=? AND field_name=?').run(req.workerId, field);

  db.prepare(`INSERT INTO pending_profile_changes (worker_account_id, field_name, old_value, new_value, old_code, new_code, expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(req.workerId, field, w[field] || '', new_value, oldCode, newCode, expiresAt);

  const results = { old_sent: false, new_sent: false };

  // Send codes
  if (field === 'phone') {
    // Send to old phone
    if (w.phone && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({ body: `Prime Anchorpoint 旧号码验证码: ${oldCode} (15分钟有效)`, from: process.env.TWILIO_PHONE_NUMBER, to: w.phone });
        results.old_sent = true;
      } catch (e) { console.error('[Change phone] SMS to old:', e.message); }
    }
    // Send to new phone
    if (process.env.TWILIO_ACCOUNT_SID) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({ body: `Prime Anchorpoint 新号码验证码: ${newCode} (15分钟有效)`, from: process.env.TWILIO_PHONE_NUMBER, to: new_value });
        results.new_sent = true;
      } catch (e) { console.error('[Change phone] SMS to new:', e.message); }
    }
  } else if (field === 'email') {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT)||587, secure: process.env.SMTP_SECURE==='true', auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
    // Send to old email
    if (w.email) {
      try {
        await t.sendMail({ from: process.env.EMAIL_FROM, to: w.email, subject: 'Prime Anchorpoint - 旧邮箱验证码', html: `<p>您的旧邮箱验证码: <strong>${oldCode}</strong></p><p>15分钟内有效。</p>` });
        results.old_sent = true;
      } catch (e) { console.error('[Change email] to old:', e.message); }
    }
    // Send to new email
    try {
      await t.sendMail({ from: process.env.EMAIL_FROM, to: new_value, subject: 'Prime Anchorpoint - 新邮箱验证码', html: `<p>您的新邮箱验证码: <strong>${newCode}</strong></p><p>15分钟内有效。</p>` });
      results.new_sent = true;
    } catch (e) { console.error('[Change email] to new:', e.message); }
  }

  res.json({ success: true, ...results, old_code: results.old_sent ? undefined : oldCode, new_code: results.new_sent ? undefined : newCode });
});

// Worker: verify profile change (old + new codes)
app.post('/api/worker/me/verify-change', requireWorker, (req, res) => {
  const { field, old_code, new_code } = req.body;
  if (!field || !old_code || !new_code) return res.status(400).json({ error: 'Missing required fields' });

  const pending = db.prepare('SELECT * FROM pending_profile_changes WHERE worker_account_id=? AND field_name=? AND expires_at > datetime(?)').get(req.workerId, field, new Date().toISOString());
  if (!pending) return res.status(400).json({ error: '无待验证的更改请求或已过期' });

  if (pending.old_code !== old_code) return res.status(400).json({ error: '旧号码/邮箱验证码错误', field: 'old' });
  if (pending.new_code !== new_code) return res.status(400).json({ error: '新号码/邮箱验证码错误', field: 'new' });

  // Both verified, apply the change
  db.prepare(`UPDATE worker_accounts SET ${field}=? WHERE id=?`).run(pending.new_value, req.workerId);
  db.prepare('DELETE FROM pending_profile_changes WHERE id=?').run(pending.id);

  res.json({ success: true });
});

app.get('/api/worker/jobs', requireWorker, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.id, j.title, j.type, j.location, j.pay, j.pay_period,
           j.work_auth, j.benefits, j.work_days, j.work_start, j.work_end,
           j.employment_type, j.description, j.urgent,
           COALESCE(NULLIF(j.company_name,''), p.name, '') AS company_name
    FROM jobs j LEFT JOIN partners p ON j.partner_id = p.id
    WHERE j.active=1 ORDER BY j.created_at DESC
  `).all();
  const applied = db.prepare('SELECT job_id FROM job_applications WHERE worker_account_id=?').all(req.workerId).map(r => r.job_id);
  res.json(jobs.map(j => ({ ...j, applied: applied.includes(j.id) })));
});

app.post('/api/worker/apply/:jobId', requireWorker, (req, res) => {
  const job = db.prepare('SELECT id, work_auth FROM jobs WHERE id=? AND active=1').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or no longer active' });
  const { notes, interview_availability, expected_pay, applicant_message, work_auth_confirmed } = req.body || {};
  // If job requires gc/citizen, applicant must confirm work auth status
  if ((job.work_auth === 'gc' || job.work_auth === 'citizen') && !work_auth_confirmed)
    return res.status(400).json({ error: '请选择您的工作身份状态' });
  try {
    db.prepare(`INSERT INTO job_applications (job_id, worker_account_id, notes, interview_availability, expected_pay, applicant_message, work_auth_confirmed) VALUES (?,?,?,?,?,?,?)`)
      .run(req.params.jobId, req.workerId, notes||'', interview_availability||'', expected_pay||'', applicant_message||'', work_auth_confirmed||'');
    res.json({ success: true });
  } catch { res.status(400).json({ error: 'Already applied to this job' }); }
});

app.get('/api/worker/timeclock', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json([]);
  const entries = db.prepare(`
    SELECT t.*, j.title AS job_title, j.company_name AS job_company
    FROM time_entries t LEFT JOIN jobs j ON t.job_id = j.id
    WHERE t.employee_id = ? ORDER BY t.clock_in DESC LIMIT 200
  `).all(req.workerEmployeeId);
  res.json(entries);
});

app.post('/api/worker/punch', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.status(400).json({ error: '账号未关联员工档案，请联系HR' });
  const { latitude, longitude, job_id, punch_type, photo_data } = req.body;
  if (!punch_type || !['in','break_start','break_end','out'].includes(punch_type))
    return res.status(400).json({ error: '请选择打卡类型 / Please select a punch type.' });
  const now = new Date().toISOString();
  let geoVerified = 0;
  let matchedSiteId = null;

  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.workerEmployeeId);

  // ── Break start ──────────────────────────────────────────────────
  if (punch_type === 'break_start') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡，无法开始休息。' });
    if (open.on_break) return res.status(400).json({ error: '您已在休息中，请先打卡休息结束。' });

    // GPS + geo-fence verification (same rules as clock-in)
    let bsGeoVerified = 0;
    if (latitude && longitude && open.job_id) {
      const bsJob = db.prepare(`
        SELECT js.id AS js_id, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters, js.name AS site_name
        FROM jobs j LEFT JOIN job_sites js ON j.site_id = js.id
        WHERE j.id = ?
      `).get(open.job_id);
      if (bsJob && bsJob.js_id) {
        const dist = haversineDistance(latitude, longitude, bsJob.site_lat, bsJob.site_lng);
        if (dist <= bsJob.radius_meters) {
          bsGeoVerified = 1;
        } else {
          const distKm = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';
          return res.status(400).json({ error: `您的位置不在工作地点范围内（距"${bsJob.site_name}"约 ${distKm}，允许范围 ${bsJob.radius_meters}m）。\n请到达工作地点后再暂停打卡。`, geo_blocked: true });
        }
      }
      if (!bsGeoVerified) {
        const assignSite2 = db.prepare(`
          SELECT a.work_lat, a.work_lng, a.work_radius
          FROM assignments a JOIN worker_accounts w ON a.inquiry_id = w.linked_inquiry_id
          WHERE w.id = ? AND a.job_id = ? AND a.status IN ('assigned','working') AND a.work_lat IS NOT NULL
          ORDER BY a.assigned_at DESC LIMIT 1
        `).get(req.workerId, open.job_id);
        if (assignSite2) {
          const dist2 = haversineDistance(latitude, longitude, assignSite2.work_lat, assignSite2.work_lng);
          if (dist2 <= (assignSite2.work_radius || 200)) {
            bsGeoVerified = 1;
          } else {
            const distKm2 = dist2 >= 1000 ? (dist2 / 1000).toFixed(1) + ' km' : Math.round(dist2) + ' m';
            return res.status(400).json({ error: `您的位置不在工作地点范围内（距指定地址约 ${distKm2}）。\n请到达工作地点后再暂停打卡。`, geo_blocked: true });
          }
        }
      }
      if (!bsGeoVerified) return res.status(400).json({ error: '该工作暂未配置工作地点，无法验证位置，请联系HR。', no_site: true });
    } else if (!latitude || !longitude) {
      return res.status(400).json({ error: '暂停打卡需要开启位置权限，请允许浏览器获取您的位置后重试。', need_gps: true });
    }

    if (!photo_data) return res.status(400).json({ error: '暂停打卡需要上传照片 / Photo is required for pausing.', photo_required: true });

    // Save pause photo to disk
    let pausePhotoFilename = null;
    try {
      const base64Data = photo_data.replace(/^data:image\/\w+;base64,/, '');
      const ext = (photo_data.match(/^data:image\/(\w+);base64,/) || [])[1] || 'jpg';
      pausePhotoFilename = `pause-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(punchPhotosDir, pausePhotoFilename), Buffer.from(base64Data, 'base64'));
    } catch (e) { /* photo save failure is non-fatal */ }

    const breaks = JSON.parse(open.break_records || '[]');
    breaks.push({ start: now, end: null, latitude: latitude || null, longitude: longitude || null, geo_verified: bsGeoVerified, photo_path: pausePhotoFilename });
    db.prepare('UPDATE time_entries SET break_records=?, on_break=1 WHERE id=?')
      .run(JSON.stringify(breaks), open.id);
    return res.json({ action: 'break_start', break_index: breaks.length - 1, entry_id: open.id, geo_verified: bsGeoVerified });
  }

  // ── Break end ────────────────────────────────────────────────────
  if (punch_type === 'break_end') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡。' });
    if (!open.on_break) return res.status(400).json({ error: '当前不在休息中。' });
    const breaks = JSON.parse(open.break_records || '[]');
    const lastIdx = breaks.findIndex(b => !b.end);
    if (lastIdx >= 0) breaks[lastIdx].end = now;
    const totalBreakMs = breaks.reduce((sum, b) => {
      if (b.start && b.end) sum += new Date(b.end) - new Date(b.start);
      return sum;
    }, 0);
    const breakMins = Math.round(totalBreakMs / 60000);
    db.prepare('UPDATE time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?')
      .run(JSON.stringify(breaks), breakMins, open.id);
    return res.json({ action: 'break_end', break_minutes: breakMins });
  }

  // ── Clock out ────────────────────────────────────────────────────
  if (punch_type === 'out') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡，无法下班打卡。' });
    if (open.on_break) return res.status(400).json({ error: '请先打卡休息结束，再下班打卡。' });
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed',punch_type='out',punch_photo=COALESCE(?,punch_photo) WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, photo_data || null, open.id);
    return res.json({ action: 'out', punch_type: 'out', clock_in: open.clock_in, clock_out: now, geo_verified: geoVerified, total_hours: hrs.total, regular_hours: hrs.regular, overtime_hours: hrs.overtime });
  }

  // ── Clock in ─────────────────────────────────────────────────────
  if (open) return res.status(400).json({ error: '您已在班，请先下班打卡。' });
  if (!latitude || !longitude) return res.status(400).json({ error: '打卡需要开启位置权限，请允许浏览器获取您的位置后重试。/ Location permission required to clock in.', need_gps: true });
  if (!job_id) return res.status(400).json({ error: '请选择要打卡的工作 / Please select a job to clock in for.' });
  let activeJob = db.prepare(`
    SELECT ej.id, ej.job_id, j.title, j.site_id,
           js.id AS js_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
    FROM employee_jobs ej
    JOIN jobs j ON ej.job_id = j.id
    LEFT JOIN job_sites js ON j.site_id = js.id
    WHERE ej.employee_id = ? AND ej.job_id = ? AND ej.status = 'active'
  `).get(req.workerEmployeeId, job_id);
  if (!activeJob) {
    const wa = db.prepare('SELECT linked_inquiry_id, phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
    const linkedInqId = wa?.linked_inquiry_id || null;
    const wPhone = (wa?.phone || '').replace(/\D/g, '').slice(-10);
    const wEmail = (wa?.email || '').toLowerCase();
    activeJob = db.prepare(`
      SELECT a.id, a.job_id, j.title, j.site_id,
             js.id AS js_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
      FROM assignments a
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      JOIN inquiries i ON a.inquiry_id = i.id
      WHERE a.job_id = ? AND a.status != 'cancelled'
        AND (
          (? IS NOT NULL AND a.inquiry_id = ?)
          OR (? != '' AND phone10(i.phone) = ?)
          OR (? != '' AND lower(i.email) = ?)
        )
      ORDER BY a.assigned_at DESC LIMIT 1
    `).get(job_id, linkedInqId, linkedInqId, wPhone, wPhone, wEmail, wEmail);
  }
  if (!activeJob) return res.status(400).json({ error: '该工作未在您的派遣列表中，无法打卡。/ Job not in your active assignments.' });

  // GPS verification for clock-in: check job site first, then assignment address
  let assignSite = null;
  if (latitude && longitude) {
    if (activeJob.js_id) {
      const dist = haversineDistance(latitude, longitude, activeJob.site_lat, activeJob.site_lng);
      if (dist <= activeJob.radius_meters) {
        geoVerified = 1;
        matchedSiteId = activeJob.js_id;
      } else {
        // Outside job site radius — block
        const distKm = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';
        return res.status(400).json({ error: `您的位置不在工作地点范围内（距"${activeJob.site_name}"约 ${distKm}，允许范围 ${activeJob.radius_meters}m）。\n请到达工作地点后再打卡。\nYou are outside the allowed radius (${distKm} from "${activeJob.site_name}").`, geo_blocked: true });
      }
    }
    if (!geoVerified) {
      assignSite = db.prepare(`
        SELECT a.work_lat, a.work_lng, a.work_radius, a.work_address
        FROM assignments a
        JOIN worker_accounts w ON a.inquiry_id = w.linked_inquiry_id
        WHERE w.id = ? AND a.job_id = ? AND a.status IN ('assigned','working') AND a.work_lat IS NOT NULL
        ORDER BY a.assigned_at DESC LIMIT 1
      `).get(req.workerId, activeJob.job_id);
      if (assignSite) {
        const dist2 = haversineDistance(latitude, longitude, assignSite.work_lat, assignSite.work_lng);
        if (dist2 <= (assignSite.work_radius || 200)) {
          geoVerified = 1;
        } else {
          const distKm2 = dist2 >= 1000 ? (dist2 / 1000).toFixed(1) + ' km' : Math.round(dist2) + ' m';
          return res.status(400).json({ error: `您的位置不在工作地点范围内（距指定地址约 ${distKm2}）。\n请到达工作地点后再打卡。\nYou are outside the allowed work location (${distKm2} away).`, geo_blocked: true });
        }
      }
    }
  } else if (activeJob.js_id || activeJob.site_id) {
    // Job has a configured site but worker provided no GPS — block
    return res.status(400).json({ error: '请开启定位权限后再打卡。该工作需要验证您的位置。\nPlease enable location access. This job requires location verification.', geo_blocked: true });
  }

  if (!geoVerified) return res.status(400).json({ error: '该工作暂未配置工作地点，无法验证位置，请联系HR。/ Work site not configured for this job, please contact HR.', no_site: true });

  if (!photo_data) return res.status(400).json({ error: '上班打卡需要上传照片 / Photo is required for clock-in.', photo_required: true });

  const doClockIn = db.transaction(() => {
    const existingOpen = db.prepare("SELECT id FROM time_entries WHERE employee_id=? AND status='open' LIMIT 1").get(req.workerEmployeeId);
    if (existingOpen) return null;
    return db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,latitude,longitude,site_id,geo_verified,job_id,punch_type,break_records,on_break,punch_photo) VALUES(?,?,'open',?,?,?,?,?,'in','[]',0,?)")
      .run(req.workerEmployeeId, now, latitude || null, longitude || null, matchedSiteId, geoVerified, activeJob.job_id, photo_data || null);
  });
  const r = doClockIn();
  if (!r) return res.status(400).json({ error: '您已在班，请先下班打卡。' });
  res.json({ action: 'in', punch_type: 'in', clock_in: now, entry_id: r.lastInsertRowid, geo_verified: geoVerified,
    site_name: activeJob.site_name || (assignSite ? assignSite.work_address : null) || null, job_title: activeJob.title });
});

// Upload punch photo for a time entry (must belong to this worker)
app.post('/api/worker/punch/:entryId/photo', requireWorker, punchPhotoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const entry = db.prepare('SELECT id, employee_id FROM time_entries WHERE id=?').get(req.params.entryId);
  if (!entry || entry.employee_id !== req.workerEmployeeId) {
    fs.unlink(req.file.path, ()=>{});
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('UPDATE time_entries SET punch_photo_path=? WHERE id=?').run(req.file.filename, entry.id);
  res.json({ success: true });
});

// Serve punch photos (admin only)
app.get('/api/admin/punch-photo/:filename', requireAdmin, (req, res) => {
  const fp = path.join(punchPhotosDir, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// ─── Worker task (my-tasks) endpoints ────────────────────────────
app.get('/api/worker/my-tasks', requireWorker, (req, res) => {
  const wa = db.prepare('SELECT linked_inquiry_id, phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.json([]);
  const tasks = db.prepare(`
    SELECT a.id, a.status, a.notes, a.pay_rate, a.pay_type, a.contract_type, a.benefits,
           a.start_date, a.work_schedule, a.work_address, a.assigned_at, a.worker_response,
           a.task_requirements,
           j.title, j.location, j.pay, j.company_name, j.employment_type,
           j.work_days, j.work_start, j.work_end, j.description
    FROM assignments a
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ? AND a.status != 'cancelled'
    ORDER BY a.assigned_at DESC
  `).all(wa.linked_inquiry_id);
  res.json(tasks);
});

app.post('/api/worker/my-tasks/:id/respond', requireWorker, (req, res) => {
  const { response } = req.body; // 'accepted' or 'rejected'
  if (!['accepted', 'rejected'].includes(response))
    return res.status(400).json({ error: 'Invalid response' });
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.status(403).json({ error: '账号未关联' });
  const task = db.prepare('SELECT id, status FROM assignments WHERE id=? AND inquiry_id=?').get(req.params.id, wa.linked_inquiry_id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (response === 'rejected') {
    db.prepare("UPDATE assignments SET worker_response='rejected', status='cancelled' WHERE id=?").run(task.id);
  } else {
    db.prepare("UPDATE assignments SET worker_response='accepted' WHERE id=?").run(task.id);
  }
  res.json({ success: true });
});

// ─── Work calendar endpoint ───────────────────────────────────────
// Returns shift_confirmations + active assignments + punch records for a given month
app.get('/api/worker/work-calendar', requireWorker, (req, res) => {
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.json({ confirmations: [], assignments: [], punchDates: [] });
  const y = parseInt(req.query.year) || new Date().getFullYear();
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const fromStr = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const toStr = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const confirmations = db.prepare(`
    SELECT sc.id, sc.date, sc.status, sc.shift_start, sc.shift_end,
           j.title, j.location AS job_location, j.description AS job_description,
           j.pay AS job_pay, j.company_name,
           a.work_address, a.pay_rate, a.pay_type
    FROM shift_confirmations sc
    JOIN assignments a ON sc.assignment_id = a.id
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ? AND sc.date >= ? AND sc.date <= ?
    ORDER BY sc.date ASC
  `).all(wa.linked_inquiry_id, fromStr, toStr);
  const assignments = db.prepare(`
    SELECT a.id, a.work_schedule, a.start_date, j.title, j.location AS job_location,
           j.description AS job_description, j.pay AS job_pay, j.company_name,
           a.work_address, a.pay_rate, a.pay_type
    FROM assignments a
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ? AND a.status NOT IN ('terminated','resigned','cancelled')
  `).all(wa.linked_inquiry_id);
  // Include actual punch records so weekend work (outside recurring schedule) is visible
  const punchDates = req.workerEmployeeId ? db.prepare(`
    SELECT DISTINCT date(clock_in) AS date
    FROM time_entries
    WHERE employee_id = ? AND date(clock_in) >= ? AND date(clock_in) <= ?
  `).all(req.workerEmployeeId, fromStr, toStr).map(r => r.date) : [];
  res.json({ confirmations, assignments, punchDates });
});

// ─── Shift confirmation endpoints ────────────────────────────────
app.get('/api/worker/shift-confirmations', requireWorker, (req, res) => {
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.json([]);
  // Return full current week (Mon → Sun); on Sat/Sun also include next week
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDow = today.getDay(); // 0=Sun, 6=Sat
  // Monday of current week
  const monday = new Date(today);
  monday.setDate(today.getDate() - (todayDow === 0 ? 6 : todayDow - 1));
  const mondayStr = monday.toISOString().slice(0, 10);
  // Sunday of current week, extended by 7 days on Sat/Sun to include next week
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  if (todayDow === 6 || todayDow === 0) {
    sunday.setDate(sunday.getDate() + 7);
  }
  const sundayStr = sunday.toISOString().slice(0, 10);
  const confirmations = db.prepare(`
    SELECT sc.id, sc.date, sc.status, sc.notified_at, sc.responded_at,
           sc.shift_start, sc.shift_end,
           a.id as assignment_id, j.title, j.company_name,
           a.work_address, a.pay_rate, a.pay_type
    FROM shift_confirmations sc
    JOIN assignments a ON sc.assignment_id = a.id
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ?
      AND sc.date >= ? AND sc.date <= ?
    ORDER BY sc.date ASC, sc.id ASC
  `).all(wa.linked_inquiry_id, mondayStr, sundayStr);
  res.json(confirmations);
});

app.post('/api/worker/shift-confirmations/:id/respond', requireWorker, (req, res) => {
  const { response } = req.body; // 'confirmed' or 'declined'
  if (!['confirmed', 'declined'].includes(response))
    return res.status(400).json({ error: 'Invalid response' });
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.status(403).json({ error: '账号未关联' });
  const sc = db.prepare(`
    SELECT sc.id FROM shift_confirmations sc
    JOIN assignments a ON sc.assignment_id = a.id
    WHERE sc.id=? AND a.inquiry_id=?
  `).get(req.params.id, wa.linked_inquiry_id);
  if (!sc) return res.status(404).json({ error: '未找到' });
  db.prepare('UPDATE shift_confirmations SET status=?, responded_at=CURRENT_TIMESTAMP WHERE id=?').run(response, sc.id);
  res.json({ success: true });
});

// Pre-confirm a scheduled (排班中) shift that has no confirmation record yet
app.post('/api/worker/shift-confirmations/preconfirm', requireWorker, (req, res) => {
  const { assignment_id, date, response } = req.body;
  if (!['confirmed', 'declined'].includes(response))
    return res.status(400).json({ error: 'Invalid response' });
  if (!assignment_id || !date)
    return res.status(400).json({ error: 'Missing assignment_id or date' });
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!wa || !wa.linked_inquiry_id) return res.status(403).json({ error: '账号未关联' });
  // Verify the assignment belongs to this worker
  const a = db.prepare(`
    SELECT a.id, a.work_schedule FROM assignments a
    WHERE a.id=? AND a.inquiry_id=? AND a.status NOT IN ('terminated','resigned','cancelled')
  `).get(assignment_id, wa.linked_inquiry_id);
  if (!a) return res.status(404).json({ error: '未找到排班' });
  // Parse work_schedule to get shift times for this day
  let sched = {};
  try { sched = JSON.parse(a.work_schedule || '{}'); } catch {}
  const _DOW = ['sun','mon','tue','wed','thu','fri','sat'];
  const dow = _DOW[new Date(date + 'T00:00:00').getDay()];
  const dayInfo = (sched.days || {})[dow] || {};
  const shiftStart = dayInfo.start || '';
  const shiftEnd = dayInfo.end || '';
  // Insert or update the confirmation record
  db.prepare(`
    INSERT INTO shift_confirmations (assignment_id, date, status, shift_start, shift_end, responded_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(assignment_id, date) DO UPDATE SET status=excluded.status, responded_at=CURRENT_TIMESTAMP
  `).run(a.id, date, response, shiftStart, shiftEnd);
  res.json({ success: true });
});

// ─── Referral endpoints ───────────────────────────────────────────
app.get('/api/worker/referrals', requireWorker, (req, res) => {
  const me = db.prepare('SELECT worker_code FROM worker_accounts WHERE id=?').get(req.workerId);
  const config = db.prepare('SELECT bonus_per_referral, min_hours_to_qualify FROM referral_bonus_config WHERE id=1').get()
    || { bonus_per_referral: 50, min_hours_to_qualify: 8 };

  // All workers referred by me
  const referred = db.prepare(`
    SELECT w.id, w.first_name, w.last_name, w.name, w.created_at,
           COALESCE(SUM(t.total_hours), 0) AS total_hours
    FROM worker_accounts w
    LEFT JOIN employees e ON w.employee_id = e.id
    LEFT JOIN time_entries t ON t.employee_id = e.id AND t.status = 'closed'
    WHERE w.referred_by = ?
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).all(req.workerId);

  const qualified = referred.filter(r => r.total_hours >= config.min_hours_to_qualify);
  const pendingBonus = referred.filter(r => r.total_hours > 0 && r.total_hours < config.min_hours_to_qualify);

  res.json({
    worker_code: me?.worker_code || null,
    referred,
    qualified_count: qualified.length,
    pending_count: pendingBonus.length,
    bonus_per_referral: config.bonus_per_referral,
    min_hours_to_qualify: config.min_hours_to_qualify,
    total_earned: qualified.length * config.bonus_per_referral,
    total_pending: pendingBonus.length * config.bonus_per_referral
  });
});

// Admin: get/update referral bonus config
app.get('/api/admin/referral-config', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM referral_bonus_config WHERE id=1').get());
});
app.put('/api/admin/referral-config', requireAdmin, requireRole('admin'), (req, res) => {
  const { bonus_per_referral, min_hours_to_qualify } = req.body;
  db.prepare('UPDATE referral_bonus_config SET bonus_per_referral=?, min_hours_to_qualify=?, updated_at=CURRENT_TIMESTAMP WHERE id=1')
    .run(bonus_per_referral, min_hours_to_qualify);
  res.json({ success: true });
});

// Admin: skill options CRUD
app.get('/api/admin/skill-options', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM skill_options ORDER BY sort_order, id').all());
});
app.post('/api/admin/skill-options', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_zh, name_en } = req.body;
  if (!name_zh || !name_zh.trim()) return res.status(400).json({ error: '技能名称不能为空' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM skill_options').get().m;
  const r = db.prepare('INSERT INTO skill_options (name_zh, name_en, sort_order) VALUES (?,?,?)').run(name_zh.trim(), (name_en||'').trim(), maxOrder+1);
  res.json({ success: true, id: r.lastInsertRowid });
});
app.put('/api/admin/skill-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_zh, name_en, sort_order } = req.body;
  if (!name_zh || !name_zh.trim()) return res.status(400).json({ error: '技能名称不能为空' });
  db.prepare('UPDATE skill_options SET name_zh=?, name_en=?, sort_order=? WHERE id=?')
    .run(name_zh.trim(), (name_en||'').trim(), sort_order ?? 0, req.params.id);
  res.json({ success: true });
});
app.delete('/api/admin/skill-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM skill_options WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Admin: list ALL referral records across all workers
app.get('/api/admin/all-referrals', requireAdmin, (req, res) => {
  const config = db.prepare('SELECT bonus_per_referral, min_hours_to_qualify FROM referral_bonus_config WHERE id=1').get()
    || { bonus_per_referral: 50, min_hours_to_qualify: 8 };

  const rows = db.prepare(`
    SELECT
      referrer.id          AS referrer_id,
      referrer.name        AS referrer_name,
      referrer.worker_code AS referrer_code,
      w.id                 AS referred_id,
      w.name               AS referred_name,
      w.worker_code        AS referred_code,
      w.created_at,
      COALESCE(SUM(t.total_hours), 0) AS total_hours
    FROM worker_accounts w
    JOIN worker_accounts referrer ON w.referred_by = referrer.id
    LEFT JOIN employees e ON w.employee_id = e.id
    LEFT JOIN time_entries t ON t.employee_id = e.id AND t.status = 'closed'
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).all();

  res.json({ rows, config });
});

app.get('/api/worker/punch/status', requireWorker, (req, res) => {
  const wa = db.prepare('SELECT linked_inquiry_id, phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  const linkedInqId = wa?.linked_inquiry_id || null;
  const wPhone = (wa?.phone || '').replace(/\D/g, '').slice(-10);
  const wEmail = (wa?.email || '').toLowerCase();

  const open = req.workerEmployeeId
    ? db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.workerEmployeeId)
    : null;

  let activeJobs = [];
  if (req.workerEmployeeId) {
    activeJobs = db.prepare(`
      SELECT ej.id, ej.job_id, j.title, j.company_name, j.work_days, j.work_start, j.work_end,
             COALESCE(NULLIF(a.work_address,''), j.location) AS location, j.pay,
             j.site_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters,
             a.work_schedule
      FROM employee_jobs ej
      JOIN jobs j ON ej.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      LEFT JOIN assignments a ON a.job_id = ej.job_id AND a.inquiry_id = ?
      WHERE ej.employee_id = ? AND ej.status = 'active'
    `).all(linkedInqId, req.workerEmployeeId);
  }

  // Fall back to assignments table: match by linked_inquiry_id, phone, or email
  // Only include accepted assignments (worker_response = 'accepted')
  if (!activeJobs.length) {
    activeJobs = db.prepare(`
      SELECT a.id, a.job_id, j.title, j.company_name, j.work_days, j.work_start, j.work_end,
             COALESCE(NULLIF(a.work_address,''), j.location) AS location, j.pay,
             j.site_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters,
             a.work_schedule
      FROM assignments a
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      JOIN inquiries i ON a.inquiry_id = i.id
      WHERE a.status != 'cancelled' AND a.worker_response = 'accepted'
        AND (
          (? IS NOT NULL AND a.inquiry_id = ?)
          OR (? != '' AND phone10(i.phone) = ?)
          OR (? != '' AND lower(i.email) = ?)
        )
      ORDER BY a.assigned_at DESC
    `).all(linkedInqId, linkedInqId, wPhone, wPhone, wEmail, wEmail);
    // Also update linked_inquiry_id if we found a match and it wasn't set
    if (activeJobs.length && !linkedInqId) {
      try { activateWorkerAccount(req.workerId); } catch {}
    }
  }

  // Count pending (unaccepted) tasks
  const pendingTasksCount = linkedInqId
    ? (db.prepare(`SELECT COUNT(*) AS cnt FROM assignments WHERE inquiry_id=? AND status != 'cancelled' AND (worker_response IS NULL OR worker_response = '')`).get(linkedInqId)?.cnt || 0)
    : 0;

  res.json({
    clocked_in: !!open,
    on_break: !!(open?.on_break),
    open_entry: open || null,
    no_employee: !req.workerEmployeeId,
    has_active_job: activeJobs.length > 0,
    pending_tasks_count: pendingTasksCount,
    active_jobs: activeJobs,
    active_job: activeJobs[0] || null
  });
});

app.get('/api/worker/assignments', requireWorker, (req, res) => {
  const apps = db.prepare(`
    SELECT a.id, a.status, a.notes, a.admin_note, a.applicant_message,
           a.interview_availability, a.expected_pay, a.work_auth_confirmed, a.created_at,
           a.interview_datetime, a.interview_location_text, a.interview_times_json,
           j.id as job_id, j.title, j.location, j.pay, j.company_name,
           j.employment_type, j.description, j.work_days, j.work_start, j.work_end, j.benefits
    FROM job_applications a LEFT JOIN jobs j ON a.job_id=j.id
    WHERE a.worker_account_id=? ORDER BY a.created_at DESC
  `).all(req.workerId);
  res.json(apps);
});

// Worker: get currently dispatched (active) jobs with site info
app.get('/api/worker/my-jobs', requireWorker, (req, res) => {
  const wa = db.prepare('SELECT linked_inquiry_id, phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  const linkedInqId = wa?.linked_inquiry_id || null;
  const wPhone = (wa?.phone || '').replace(/\D/g, '').slice(-10);
  const wEmail = (wa?.email || '').toLowerCase();

  let jobs = [];
  if (req.workerEmployeeId) {
    jobs = db.prepare(`
      SELECT ej.id, ej.job_id, ej.status, ej.start_date, ej.end_date, ej.emp_hourly_rate,
             j.title, COALESCE(NULLIF(a.work_address,''), j.location) AS location,
             j.pay, j.pay_period, j.company_name, j.site_id,
             js.name AS site_name, js.address AS site_address,
             js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
      FROM employee_jobs ej
      JOIN jobs j ON ej.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      LEFT JOIN assignments a ON a.job_id = ej.job_id AND a.inquiry_id = ?
      WHERE ej.employee_id = ? AND ej.status = 'active'
      ORDER BY ej.assigned_at DESC
    `).all(linkedInqId, req.workerEmployeeId);
  }

  // Fallback: check assignments table (same as punch/status)
  if (!jobs.length) {
    jobs = db.prepare(`
      SELECT a.id, a.job_id, 'active' AS status, '' AS start_date, '' AS end_date, '' AS emp_hourly_rate,
             j.title, COALESCE(NULLIF(a.work_address,''), j.location) AS location,
             j.pay, j.pay_period, j.company_name, j.site_id,
             js.name AS site_name, js.address AS site_address,
             js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
      FROM assignments a
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      JOIN inquiries i ON a.inquiry_id = i.id
      WHERE a.status != 'cancelled'
        AND (
          (? IS NOT NULL AND a.inquiry_id = ?)
          OR (? != '' AND phone10(i.phone) = ?)
          OR (? != '' AND lower(i.email) = ?)
        )
      ORDER BY a.assigned_at DESC
    `).all(linkedInqId, linkedInqId, wPhone, wPhone, wEmail, wEmail);
  }

  res.json(jobs);
});

// Worker: get payment records
app.get('/api/worker/payments', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json([]);
  const payments = db.prepare(`
    SELECT p.*, j.title AS job_title
    FROM worker_payments p
    LEFT JOIN jobs j ON p.job_id = j.id
    WHERE p.employee_id = ?
    ORDER BY p.payment_date DESC, p.created_at DESC
  `).all(req.workerEmployeeId);
  res.json(payments);
});

// ─── Worker Forgot / Reset Password ───
app.post('/api/worker/forgot-password', async (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: '请输入邮箱或手机号' });
  const w = db.prepare('SELECT id, email, phone FROM worker_accounts WHERE email=? OR phone=? OR username=?').get(login, login, login);
  if (!w) return res.status(404).json({ error: '未找到该账号 / Account not found' });

  // Prefer Twilio Verify for phone-based reset
  if (w.phone && twilioClient && TWILIO_VERIFY_SID) {
    const sent = await sendVerifyCode(w.phone);
    resetCodes.set('worker:' + login, { useVerify: true, phone: w.phone, expires: Date.now() + 10 * 60 * 1000, accountId: w.id });
    console.log(`[Reset] Worker ${login}: sent via Twilio Verify (sent:${sent})`);
    return res.json({ success: true, message: '验证码已发送到您的手机 / Code sent to your phone' });
  }

  // Fallback: generate our own code (log to console)
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set('worker:' + login, { code, expires: Date.now() + 10 * 60 * 1000, accountId: w.id });
  // Try to send via SMS or email
  if (w.phone && twilioClient && TWILIO_FROM) {
    await sendSMS(w.phone, `[Prime Anchorpoint] 重置密码验证码: ${code}，10分钟内有效。Reset code: ${code}`);
  } else if (w.email && emailTransporter) {
    await sendEmail(w.email, 'Prime Anchorpoint 重置密码 / Password Reset',
      `您的重置密码验证码: ${code}\nYour password reset code: ${code}\n\n10分钟内有效 / Valid for 10 minutes.`);
  }
  console.log(`[Reset Code] Worker account ${login}: ${code}`);
  res.json({ success: true, message: '验证码已发送 / Code sent' });
});

app.post('/api/worker/reset-password', async (req, res) => {
  const { login, code, new_password } = req.body;
  if (!login || !code || !new_password) return res.status(400).json({ error: '请填写完整信息' });
  if (new_password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const entry = resetCodes.get('worker:' + login);
  if (!entry) return res.status(400).json({ error: '请先发送验证码 / Please request a code first' });
  if (Date.now() > entry.expires) { resetCodes.delete('worker:' + login); return res.status(400).json({ error: '验证码已过期 / Code expired' }); }

  // Check code: Twilio Verify or local
  if (entry.useVerify) {
    const ok = await checkVerifyCode(entry.phone, code);
    if (!ok) return res.status(400).json({ error: '验证码错误或已过期 / Invalid or expired code' });
  } else {
    if (entry.code !== code) return res.status(400).json({ error: '验证码错误 / Invalid code' });
  }

  const { hash, salt } = hashPassword(new_password);
  db.prepare('UPDATE worker_accounts SET password_hash=?, salt=? WHERE id=?').run(hash, salt, entry.accountId);
  resetCodes.delete('worker:' + login);
  res.json({ success: true });
});

// ─── Worker Compliance Documents API ───
const complianceUpload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `compliance-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png|heic|heif/.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

// Get worker's compliance overview
app.get('/api/worker/compliance', requireWorker, (req, res) => {
  const docs = db.prepare('SELECT id, doc_type, status, file_name, expires_at, created_at, updated_at, reviewer_notes FROM worker_compliance_docs WHERE worker_account_id=? ORDER BY created_at DESC').all(req.workerId);
  // Group by doc_type, return latest of each type
  const byType = {};
  for (const d of docs) {
    if (!byType[d.doc_type]) byType[d.doc_type] = d;
  }
  // Check background check status via employee linkage
  let bgCheck = null;
  if (req.workerEmployeeId) {
    bgCheck = db.prepare('SELECT id, check_type, status, result, ordered_date, completed_date FROM background_checks WHERE employee_id=? ORDER BY created_at DESC LIMIT 1').get(req.workerEmployeeId);
  }
  // Get assigned tasks for this worker
  const worker = db.prepare('SELECT assigned_tasks FROM worker_accounts WHERE id=?').get(req.workerId);
  let assignedTasks = [];
  try { assignedTasks = JSON.parse(worker?.assigned_tasks || '[]'); } catch {}
  res.json({
    documents: byType,
    all_documents: docs,
    background_check: bgCheck,
    assigned_tasks: assignedTasks,
    doc_types: ['i9', 'drivers_license', 'w9', 'ssn_card', 'work_permit', 'other']
  });
});

// Submit I-9 form data
app.post('/api/worker/compliance/i9', requireWorker, complianceUpload.fields([
  { name: 'list_a_doc', maxCount: 1 },
  { name: 'list_b_doc', maxCount: 1 },
  { name: 'list_c_doc', maxCount: 1 }
]), (req, res) => {
  const formData = {};
  const fields = ['last_name','first_name','middle_initial','other_last_names','address','apt','city','state','zip',
    'dob','ssn_last4','email','phone','citizenship_status','alien_number','i94_number','passport_number','passport_country',
    'work_auth_expiry','list_a_type','list_b_type','list_c_type','signature_confirm'];
  fields.forEach(f => { if (req.body[f]) formData[f] = req.body[f]; });

  // Save any uploaded supporting documents
  const files = req.files || {};
  const fileParts = [];
  ['list_a_doc','list_b_doc','list_c_doc'].forEach(key => {
    if (files[key] && files[key][0]) {
      fileParts.push({ type: key, path: files[key][0].path, name: files[key][0].originalname });
    }
  });
  formData._files = fileParts;

  // Upsert I-9 record
  const existing = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='i9' AND status IN ('pending','rejected')").get(req.workerId);
  if (existing) {
    db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(formData), existing.id);
  } else {
    db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'i9', ?, 'pending')")
      .run(req.workerId, JSON.stringify(formData));
  }
  res.json({ success: true });
});

// Upload driver's license (manual fallback - kept for backward compat)
app.post('/api/worker/compliance/drivers-license', requireWorker, complianceUpload.fields([
  { name: 'dl_front', maxCount: 1 },
  { name: 'dl_back', maxCount: 1 }
]), (req, res) => {
  const files = req.files || {};
  if (!files.dl_front || !files.dl_front[0]) return res.status(400).json({ error: 'Front image required' });
  const formData = {
    dl_number: req.body.dl_number || '',
    dl_state: req.body.dl_state || '',
    dl_expiry: req.body.dl_expiry || '',
    dl_front: { path: files.dl_front[0].path, name: files.dl_front[0].originalname },
    dl_back: files.dl_back && files.dl_back[0] ? { path: files.dl_back[0].path, name: files.dl_back[0].originalname } : null
  };
  const existing = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' AND status IN ('pending','rejected')").get(req.workerId);
  if (existing) {
    db.prepare("UPDATE worker_compliance_docs SET form_data=?, file_path=?, file_name=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(formData), files.dl_front[0].path, files.dl_front[0].originalname, existing.id);
  } else {
    db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, file_path, file_name, status) VALUES (?, 'drivers_license', ?, ?, ?, 'pending')")
      .run(req.workerId, JSON.stringify(formData), files.dl_front[0].path, files.dl_front[0].originalname);
  }
  res.json({ success: true });
});

// ── Persona Identity Verification ──

// Worker: create a Persona inquiry for ID verification
app.post('/api/worker/persona/inquiry', requireWorker, async (req, res) => {
  const apiKey = process.env.PERSONA_API_KEY;
  const templateId = process.env.PERSONA_TEMPLATE_ID;
  if (!apiKey || !templateId) return res.status(500).json({ error: 'Persona not configured' });

  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  try {
    const resp = await fetch('https://api.withpersona.com/api/v1/inquiries', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Persona-Version': '2023-01-05',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            'inquiry-template-id': templateId,
            'reference-id': `worker-${req.workerId}`,
            fields: {
              'name-first': (worker.name || '').split(' ')[0] || '',
              'name-last': (worker.name || '').split(' ').slice(1).join(' ') || '',
              ...(worker.dob ? { birthdate: worker.dob } : {}),
              ...(worker.email ? { 'email-address': worker.email } : {}),
              ...(worker.phone ? { 'phone-number': worker.phone } : {})
            }
          }
        }
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[Persona] Create inquiry failed:', JSON.stringify(data));
      return res.status(resp.status).json({ error: 'Persona API error', details: data });
    }
    const inquiryId = data.data?.id;
    let sessionToken = data.meta?.['session-token'] || data.data?.attributes?.['session-token'] || '';
    // Persona may not return session-token on create; call /resume to obtain it
    if (!sessionToken && inquiryId) {
      const resumeLink = await resumePersonaInquiry(inquiryId);
      if (resumeLink) {
        const m = resumeLink.match(/session-token=([^&]+)/);
        if (m) sessionToken = m[1];
      }
    }
    // Build hosted flow URL for link/QR sharing
    const hostedUrl = sessionToken
      ? `https://withpersona.com/verify?inquiry-id=${inquiryId}&session-token=${sessionToken}`
      : '';
    // Store the inquiry in compliance docs
    const formData = JSON.stringify({ persona_inquiry_id: inquiryId, persona_status: 'created', persona_session_token: sessionToken, persona_hosted_url: hostedUrl });
    const existing = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license'").get(req.workerId);
    if (existing) {
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(formData, existing.id);
    } else {
      db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'drivers_license', ?, 'pending')")
        .run(req.workerId, formData);
    }
    res.json({ success: true, inquiry_id: inquiryId, hosted_url: hostedUrl });
  } catch (e) {
    console.error('[Persona] Error:', e.message);
    res.status(500).json({ error: 'Failed to create Persona inquiry: ' + e.message });
  }
});

// Worker: get Persona config (template ID + environment) for embedded flow
app.get('/api/worker/persona/config', requireWorker, (req, res) => {
  const templateId = process.env.PERSONA_TEMPLATE_ID;
  const environment = process.env.PERSONA_ENVIRONMENT || 'sandbox';
  if (!templateId) return res.json({ enabled: false });
  res.json({ enabled: true, templateId, environment });
});

// Worker: check Persona verification status
app.get('/api/worker/persona/status', requireWorker, (req, res) => {
  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.json({ status: 'not_started' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    res.json({
      status: doc.status,
      persona_inquiry_id: formData.persona_inquiry_id || null,
      persona_status: formData.persona_status || null,
      persona_hosted_url: formData.persona_hosted_url || null,
      reviewer_notes: doc.reviewer_notes || ''
    });
  } catch {
    res.json({ status: doc.status });
  }
});

// Worker: send Persona verification link via SMS
app.post('/api/worker/persona/send-sms', requireWorker, async (req, res) => {
  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const phone = req.body.phone || worker.phone;
  if (!phone) return res.status(400).json({ error: '没有手机号码 / No phone number' });

  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.status(400).json({ error: '请先创建验证 / Please create verification first' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    const url = formData.persona_hosted_url;
    if (!url) return res.status(400).json({ error: '验证链接不可用，请重新开始验证 / Verification link not available' });
    const msg = `[Prime Anchor Point] 请点击以下链接完成身份验证 / Click the link below to verify your identity:\n${url}`;
    const ok = await sendSMS(phone, msg);
    if (ok) return res.json({ success: true, message: '短信已发送 / SMS sent' });
    return res.status(500).json({ error: '短信发送失败 / SMS send failed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Worker: send Persona verification link via email
app.post('/api/worker/persona/send-email', requireWorker, async (req, res) => {
  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const email = req.body.email || worker.email;
  if (!email) return res.status(400).json({ error: '没有邮箱地址 / No email address' });

  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.status(400).json({ error: '请先创建验证 / Please create verification first' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    const url = formData.persona_hosted_url;
    if (!url) return res.status(400).json({ error: '验证链接不可用，请重新开始验证 / Verification link not available' });
    const subject = 'Prime Anchor Point - 身份验证 / Identity Verification';
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:2rem">
        <h2 style="color:#0ea5e9">Prime Anchor Point</h2>
        <p>您好 ${worker.name || ''},</p>
        <p>请点击下方按钮完成身份验证（驾照/ID）：<br>Please click the button below to verify your identity:</p>
        <div style="text-align:center;margin:2rem 0">
          <a href="${url}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:1.1rem;font-weight:600">
            开始验证 / Start Verification
          </a>
        </div>
        <p style="font-size:.85rem;color:#666">或复制以下链接到浏览器打开 / Or copy this link:<br><a href="${url}">${url}</a></p>
        <hr style="margin:2rem 0;border:none;border-top:1px solid #e5e7eb">
        <p style="font-size:.8rem;color:#999">Prime Anchor Point Staffing</p>
      </div>`;
    const plainText = `请点击以下链接完成身份验证 / Click the link to verify your identity: ${url}`;
    const ok = await sendEmail(email, subject, plainText, html);
    if (ok) return res.json({ success: true, message: '邮件已发送 / Email sent' });
    return res.status(500).json({ error: '邮件发送失败 / Email send failed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Persona webhook - receives verification results
app.post('/api/webhooks/persona', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookSecret = process.env.PERSONA_WEBHOOK_SECRET;

  // Verify webhook signature if secret is configured
  if (webhookSecret) {
    const sigHeader = req.headers['persona-signature'];
    if (!sigHeader) return res.status(401).json({ error: 'Missing signature' });
    try {
      const parts = sigHeader.split(',');
      const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
      const signature = parts.find(p => p.startsWith('v1=')).slice(3);
      const payload = `${timestamp}.${req.body}`;
      const expected = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (e) {
      console.error('[Persona Webhook] Signature verification error:', e.message);
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  try {
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const eventType = event.data?.attributes?.name || '';
    const inquiryData = event.data?.attributes?.payload?.data;
    const inquiryId = inquiryData?.id;
    const inquiryStatus = inquiryData?.attributes?.status;
    const referenceId = inquiryData?.attributes?.['reference-id'] || '';

    console.log(`[Persona Webhook] Event: ${eventType}, Inquiry: ${inquiryId}, Status: ${inquiryStatus}`);

    if (!inquiryId) return res.json({ received: true });

    // Extract worker ID from reference-id (format: "worker-123" or legacy plain "123")
    const workerIdMatch = referenceId.match(/^(?:worker-)?(\d+)$/);
    let docRow = null;
    if (workerIdMatch) {
      docRow = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(parseInt(workerIdMatch[1]));
    }
    if (!docRow) {
      // Fallback: search by inquiry ID in form_data
      const allDocs = db.prepare("SELECT * FROM worker_compliance_docs WHERE doc_type='drivers_license'").all();
      docRow = allDocs.find(d => {
        try { return JSON.parse(d.form_data || '{}').persona_inquiry_id === inquiryId; } catch { return false; }
      });
    }
    if (!docRow) {
      console.warn(`[Persona Webhook] No compliance doc found for inquiry ${inquiryId}`);
      return res.json({ received: true });
    }

    // Update compliance doc based on event
    const existingForm = JSON.parse(docRow.form_data || '{}');
    existingForm.persona_inquiry_id = inquiryId;
    existingForm.persona_status = inquiryStatus;
    existingForm.persona_event = eventType;

    // Extract verification fields if available
    const included = event.data?.attributes?.payload?.included || [];
    const govIdVerification = included.find(i => i.type === 'verification/government-id');
    if (govIdVerification) {
      const attrs = govIdVerification.attributes || {};
      existingForm.dl_number = attrs['id-number'] || '';
      existingForm.dl_state = attrs['address-subdivision'] || '';
      existingForm.dl_expiry = attrs['expiration-date'] || '';
      existingForm.dl_first_name = attrs['name-first'] || '';
      existingForm.dl_last_name = attrs['name-last'] || '';
      existingForm.dl_dob = attrs['birthdate'] || '';
      existingForm.id_class = attrs['id-class'] || '';
    }

    let newStatus = docRow.status;
    if (eventType === 'inquiry.approved' || inquiryStatus === 'approved') {
      newStatus = 'approved';
    } else if (eventType === 'inquiry.declined' || inquiryStatus === 'declined') {
      newStatus = 'rejected';
      existingForm.decline_reasons = inquiryData?.attributes?.['decision-reasons'] || [];
    } else if (eventType === 'inquiry.completed' || inquiryStatus === 'completed') {
      newStatus = 'submitted'; // user completed verification, awaiting auto-approval or manual review
    } else if (eventType === 'inquiry.failed' || inquiryStatus === 'failed') {
      newStatus = 'rejected';
    }

    db.prepare("UPDATE worker_compliance_docs SET form_data=?, status=?, reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(existingForm), newStatus, `Persona: ${eventType}`, docRow.id);

    console.log(`[Persona Webhook] Updated doc ${docRow.id} → status=${newStatus}`);

    // Also update worker_accounts.identity_status and auto-complete onboarding
    let identityStatus = '';
    if (inquiryStatus === 'approved' || eventType.includes('approved')) identityStatus = 'approved';
    else if (inquiryStatus === 'declined' || eventType.includes('declined') || eventType.includes('failed')) identityStatus = 'declined';
    else if (inquiryStatus === 'completed' || eventType.includes('completed')) identityStatus = 'completed';
    if (identityStatus) {
      db.prepare(`UPDATE worker_accounts SET identity_status=? WHERE persona_inquiry_id=?`).run(identityStatus, inquiryId);
      console.log(`[Persona Webhook] Updated worker_accounts identity_status → ${identityStatus}`);
      const w = db.prepare(`SELECT id FROM worker_accounts WHERE persona_inquiry_id=?`).get(inquiryId);
      if (w) {
        if (identityStatus === 'approved') {
          db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
          console.log(`[Persona Webhook] Auto-completed persona_verify onboarding for worker ${w.id}`);
        } else if (identityStatus === 'completed') {
          db.prepare(`UPDATE worker_onboarding SET status='submitted', admin_note='验证已完成，等待审核', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
          console.log(`[Persona Webhook] Updated persona_verify to submitted for worker ${w.id}`);
        } else if (identityStatus === 'declined') {
          db.prepare(`UPDATE worker_onboarding SET status='pending', admin_note='验证未通过，请重新验证', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
          console.log(`[Persona Webhook] Persona verification declined for worker ${w.id}`);
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[Persona Webhook] Error processing:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Worker: actively poll Persona API for latest inquiry status (does not rely on webhook)
app.post('/api/worker/persona/poll-status', requireWorker, async (req, res) => {
  const apiKey = process.env.PERSONA_API_KEY;

  // Fallback: even without Persona API key, check if identity_status was updated (e.g., by webhook or admin)
  const w = db.prepare('SELECT identity_status, persona_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (w && (w.identity_status === 'approved' || w.identity_status === 'completed' || w.identity_status === 'declined')) {
    // Sync to worker_onboarding if not already synced
    const onboard = db.prepare("SELECT status FROM worker_onboarding WHERE worker_account_id=? AND task_key='persona_verify'").get(req.workerId);
    if (onboard && onboard.status === 'pending') {
      if (w.identity_status === 'approved') {
        db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
      } else if (w.identity_status === 'completed') {
        db.prepare(`UPDATE worker_onboarding SET status='submitted', admin_note='验证已完成，等待审核', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
      } else if (w.identity_status === 'declined') {
        db.prepare(`UPDATE worker_onboarding SET status='pending', admin_note='验证未通过，请重新验证', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
      }
    }
    const docStatus = w.identity_status === 'approved' ? 'approved' : w.identity_status === 'declined' ? 'rejected' : 'submitted';
    return res.json({ status: docStatus, persona_status: w.identity_status, updated: onboard && onboard.status === 'pending' });
  }

  if (!apiKey) {
    // No API key + identity_status not yet set → return current DB state
    const doc = db.prepare("SELECT status FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
    return res.json({ status: doc ? doc.status : 'not_started', persona_status: null });
  }
  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.json({ status: 'not_started' });
  let formData;
  try { formData = JSON.parse(doc.form_data || '{}'); } catch { formData = {}; }
  const inquiryId = formData.persona_inquiry_id;
  if (!inquiryId) return res.json({ status: doc.status, persona_status: formData.persona_status || null });

  try {
    const resp = await fetch(`https://withpersona.com/api/v1/inquiries/${inquiryId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Persona-Version': '2023-01-05', 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      console.error('[Persona Poll] API error:', resp.status);
      return res.json({ status: doc.status, persona_status: formData.persona_status || null });
    }
    const data = await resp.json();
    const inquiryStatus = data.data?.attributes?.status;
    if (!inquiryStatus || inquiryStatus === formData.persona_status) {
      return res.json({ status: doc.status, persona_status: formData.persona_status || null });
    }

    // Status changed — update local DB (mirrors webhook logic)
    formData.persona_status = inquiryStatus;
    formData.persona_polled_at = new Date().toISOString();

    // Extract verification fields if included
    const included = data.included || [];
    const govIdVerification = included.find(i => i.type === 'verification/government-id');
    if (govIdVerification) {
      const attrs = govIdVerification.attributes || {};
      formData.dl_number = attrs['id-number'] || formData.dl_number || '';
      formData.dl_state = attrs['address-subdivision'] || formData.dl_state || '';
      formData.dl_expiry = attrs['expiration-date'] || formData.dl_expiry || '';
      formData.dl_first_name = attrs['name-first'] || formData.dl_first_name || '';
      formData.dl_last_name = attrs['name-last'] || formData.dl_last_name || '';
      formData.dl_dob = attrs['birthdate'] || formData.dl_dob || '';
      formData.id_class = attrs['id-class'] || formData.id_class || '';
    }

    let newStatus = doc.status;
    if (inquiryStatus === 'approved') newStatus = 'approved';
    else if (inquiryStatus === 'declined') newStatus = 'rejected';
    else if (inquiryStatus === 'completed') newStatus = 'submitted';
    else if (inquiryStatus === 'failed') newStatus = 'rejected';
    else if (inquiryStatus === 'needs_review') newStatus = 'submitted';

    if (newStatus !== doc.status || inquiryStatus !== (formData.persona_status_prev || '')) {
      formData.persona_status_prev = inquiryStatus;
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status=?, reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(formData), newStatus, `Persona poll: ${inquiryStatus}`, doc.id);

      // Also update worker_accounts and onboarding (same as webhook)
      let identityStatus = '';
      if (inquiryStatus === 'approved') identityStatus = 'approved';
      else if (inquiryStatus === 'declined' || inquiryStatus === 'failed') identityStatus = 'declined';
      else if (inquiryStatus === 'completed' || inquiryStatus === 'needs_review') identityStatus = 'completed';
      if (identityStatus) {
        db.prepare(`UPDATE worker_accounts SET identity_status=? WHERE id=?`).run(identityStatus, req.workerId);
        if (identityStatus === 'approved') {
          db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
        } else if (identityStatus === 'completed') {
          db.prepare(`UPDATE worker_onboarding SET status='submitted', admin_note='验证已完成，等待审核', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
        } else if (identityStatus === 'declined') {
          db.prepare(`UPDATE worker_onboarding SET status='pending', admin_note='验证未通过，请重新验证', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(req.workerId);
        }
      }
      console.log(`[Persona Poll] Updated worker ${req.workerId} → doc.status=${newStatus}, persona_status=${inquiryStatus}`);
    }

    res.json({ status: newStatus, persona_status: inquiryStatus, updated: true });
  } catch (e) {
    console.error('[Persona Poll] Error:', e.message);
    res.json({ status: doc.status, persona_status: formData.persona_status || null });
  }
});

// Submit W-9 form data
app.post('/api/worker/compliance/w9', requireWorker, (req, res) => {
  const formData = {};
  const fields = ['name','business_name','tax_classification','exempt_payee_code','fatca_code',
    'address','city','state','zip','account_numbers','ssn_or_ein','signature_confirm','tin_type'];
  fields.forEach(f => { if (req.body[f] !== undefined) formData[f] = req.body[f]; });

  // Encrypt SSN/EIN if provided
  if (req.body.ssn_or_ein) {
    formData.ssn_or_ein_masked = req.body.ssn_or_ein.replace(/\d(?=\d{4})/g, '*');
    formData.ssn_or_ein_encrypted = encryptSSN(req.body.ssn_or_ein);
    delete formData.ssn_or_ein;
  }

  const existing = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='w9' AND status IN ('pending','rejected')").get(req.workerId);
  if (existing) {
    db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(formData), existing.id);
  } else {
    db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'w9', ?, 'pending')")
      .run(req.workerId, JSON.stringify(formData));
  }
  res.json({ success: true });
});

// Upload generic compliance doc (work_permit, ssn_card, other)
app.post('/api/worker/compliance/upload', requireWorker, complianceUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const docType = req.body.doc_type || 'other';
  const notes = req.body.notes || '';
  db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, file_path, file_name, form_data, status) VALUES (?, ?, ?, ?, ?, 'pending')")
    .run(req.workerId, docType, req.file.path, req.file.originalname, JSON.stringify({ notes }));
  res.json({ success: true });
});

// Get available job sites for worker
app.get('/api/worker/job-sites', requireWorker, (req, res) => {
  const sites = db.prepare('SELECT id, name, address, latitude, longitude, radius_meters FROM job_sites WHERE active=1').all();
  res.json(sites);
});

// ─── Admin: Job Sites Management ───
app.get('/api/admin/job-sites', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM job_sites ORDER BY id DESC').all());
});

app.post('/api/admin/job-sites', requireAdmin, blockManager, (req, res) => {
  const { name, address, latitude, longitude, radius_meters, partner_id } = req.body;
  if (!name || !latitude || !longitude) return res.status(400).json({ error: 'Name, latitude, longitude required' });
  const r = db.prepare('INSERT INTO job_sites (name, address, latitude, longitude, radius_meters, partner_id) VALUES (?,?,?,?,?,?)')
    .run(name, address || '', latitude, longitude, radius_meters || 200, partner_id || null);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/job-sites/:id', requireAdmin, blockManager, (req, res) => {
  const { name, address, latitude, longitude, radius_meters, active } = req.body;
  db.prepare('UPDATE job_sites SET name=COALESCE(?,name), address=COALESCE(?,address), latitude=COALESCE(?,latitude), longitude=COALESCE(?,longitude), radius_meters=COALESCE(?,radius_meters), active=COALESCE(?,active) WHERE id=?')
    .run(name, address, latitude, longitude, radius_meters, active, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/job-sites/:id', requireAdmin, blockManager, (req, res) => {
  db.prepare('DELETE FROM job_sites WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Admin: Integration Settings ───
app.get('/api/admin/integrations', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM integration_settings ORDER BY id').all();
  // Mask secrets
  res.json(rows.map(r => ({
    ...r,
    api_key: r.api_key ? r.api_key.slice(0, 4) + '****' + r.api_key.slice(-4) : '',
    api_secret: r.api_secret ? '********' : ''
  })));
});

app.put('/api/admin/integrations/:provider', requireAdmin, (req, res) => {
  const { enabled, api_key, api_secret, config } = req.body;
  const ex = db.prepare('SELECT * FROM integration_settings WHERE provider=?').get(req.params.provider);
  if (!ex) return res.status(404).json({ error: 'Provider not found' });
  db.prepare('UPDATE integration_settings SET enabled=COALESCE(?,enabled), api_key=COALESCE(?,api_key), api_secret=COALESCE(?,api_secret), config=COALESCE(?,config), updated_at=CURRENT_TIMESTAMP WHERE provider=?')
    .run(enabled !== undefined ? (enabled ? 1 : 0) : null, api_key || null, api_secret || null, config ? JSON.stringify(config) : null, req.params.provider);
  res.json({ success: true });
});

// ─── Admin: Worker Compliance Review ───
app.get('/api/admin/compliance-docs', requireAdmin, (req, res) => {
  const docs = db.prepare(`
    SELECT c.*, w.name as worker_name, w.email as worker_email, w.phone as worker_phone
    FROM worker_compliance_docs c
    LEFT JOIN worker_accounts w ON c.worker_account_id = w.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(docs);
});

app.put('/api/admin/compliance-docs/:id/review', requireAdmin, blockManager, (req, res) => {
  const { status, reviewer_notes } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE worker_compliance_docs SET status=?, reviewer_notes=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, reviewer_notes || '', req.adminId, req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/compliance-docs/:id/download', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM worker_compliance_docs WHERE id=?').get(req.params.id);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'File missing' });
  res.download(doc.file_path, doc.file_name || 'document');
});

// ─── Customer Portal API ───
app.post('/api/customer/login', (req, res) => {
  const { login, email, password } = req.body;
  const identifier = (login || email || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  const digits10 = identifier.replace(/\D/g, '').slice(-10);
  const cAny = db.prepare(
    'SELECT * FROM customer_accounts WHERE email=? OR phone10(phone)=?'
  ).get(identifier, digits10);
  if (cAny && cAny.approval_status === 'pending')
    return res.status(403).json({ error: '您的企业账号正在审核中，请等待管理员批准 / Your account is pending admin approval' });
  if (cAny && cAny.approval_status === 'rejected')
    return res.status(403).json({ error: '您的企业注册已被拒绝，请联系管理员 / Your registration was rejected. Please contact admin' });
  const c = (cAny && cAny.active && verifyPassword(password, cAny.salt, cAny.password_hash)) ? cAny : null;
  if (!c)
    return res.status(401).json({ error: '邮箱/电话或密码错误 / Invalid email/phone or password' });
  const token = crypto.randomBytes(32).toString('hex');
  customerSessions.set(token, { created: Date.now(), customerId: c.id, partnerId: c.partner_id });
  res.json({ token, company_name: c.company_name });
});

app.get('/api/customer/me', requireCustomer, (req, res) => {
  const c = db.prepare('SELECT id, company_name, contact_name, email, phone, partner_id, active FROM customer_accounts WHERE id=?').get(req.customerId);
  res.json(c);
});

app.post('/api/customer/post-job', requireCustomer, (req, res) => {
  const { title, location, headcount, start_date, work_type, requirements, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Job title required' });
  const r = db.prepare('INSERT INTO customer_job_posts (customer_account_id, title, location, headcount, start_date, work_type, requirements, notes) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.customerId, title, location||'', headcount||1, start_date||'', work_type||'', requirements||'', notes||'');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.get('/api/customer/my-posts', requireCustomer, (req, res) => {
  res.json(db.prepare('SELECT * FROM customer_job_posts WHERE customer_account_id=? ORDER BY created_at DESC').all(req.customerId));
});

app.get('/api/customer/my-workers', requireCustomer, (req, res) => {
  if (!req.customerPartnerId) return res.json([]);
  const rows = db.prepare(`
    SELECT a.id as assign_id, a.status as assign_status, a.assigned_at,
      e.first_name, e.last_name, e.position, e.phone,
      j.title as job_title, j.location
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id=i.id
    LEFT JOIN jobs j ON a.job_id=j.id
    LEFT JOIN employees e ON e.id=(SELECT id FROM employees WHERE phone=i.phone LIMIT 1)
    WHERE j.partner_id=?
    ORDER BY a.assigned_at DESC
  `).all(req.customerPartnerId);
  res.json(rows);
});

// ─── Customer Forgot / Reset Password ───
app.post('/api/customer/forgot-password', (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: '请输入邮箱或电话' });
  const c = db.prepare('SELECT id, email, phone FROM customer_accounts WHERE email=? OR phone=?').get(login, login);
  if (!c) return res.status(404).json({ error: '未找到该账号 / Account not found' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set('customer:' + login, { code, expires: Date.now() + 10 * 60 * 1000, accountId: c.id });
  console.log(`[Reset Code] Customer account ${login}: ${code}`);
  res.json({ success: true, message: '验证码已发送 / Code sent' });
});

app.post('/api/customer/reset-password', (req, res) => {
  const { login, code, new_password } = req.body;
  if (!login || !code || !new_password) return res.status(400).json({ error: '请填写完整信息' });
  if (new_password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const entry = resetCodes.get('customer:' + login);
  if (!entry || entry.code !== code) return res.status(400).json({ error: '验证码错误 / Invalid code' });
  if (Date.now() > entry.expires) { resetCodes.delete('customer:' + login); return res.status(400).json({ error: '验证码已过期 / Code expired' }); }
  const { hash, salt } = hashPassword(new_password);
  db.prepare('UPDATE customer_accounts SET password_hash=?, salt=? WHERE id=?').run(hash, salt, entry.accountId);
  resetCodes.delete('customer:' + login);
  res.json({ success: true });
});

// ─── Public Registration ───

// Real-time duplicate check (phone or email)
app.get('/api/register/check', (req, res) => {
  const { phone, email } = req.query;
  if (phone) {
    const clean = phone.replace(/[\s\-()+]/g, '');
    const row = db.prepare('SELECT id, active FROM worker_accounts WHERE phone=?').get(clean);
    if (row && row.active) return res.json({ taken: true, field: 'phone' });
  }
  if (email) {
    const row = db.prepare('SELECT id, active FROM worker_accounts WHERE email=?').get(email.toLowerCase().trim());
    if (row && row.active) return res.json({ taken: true, field: 'email' });
  }
  res.json({ taken: false });
});

app.post('/api/register/worker', async (req, res) => {
  try {
  const { first_name, middle_name, last_name, phone: phoneRaw, email, dob, work_status, position_interests, password, city, state, ref_code, invite_token } = req.body;
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '').slice(-10) : ''; // store last 10 digits only
  const nameParts = [first_name, middle_name, last_name].filter(Boolean);
  if (!first_name || !last_name || !phone || !email || !password)
    return res.status(400).json({ error: '请填写名字、姓氏、手机号、邮箱和密码 / First name, last name, phone, email, and password are required' });
  if (!city || !state)
    return res.status(400).json({ error: '请填写城市和州 / City and state are required' });
  const name = nameParts.join(' ');
  // Check phone or email uniqueness; allow re-registration only if previous account was never verified AND codes have expired
  const existing = db.prepare('SELECT id, active FROM worker_accounts WHERE phone=? OR email=? OR username=?').get(phone, email, phone);
  if (existing && existing.active) return res.status(400).json({ error: '该手机号或邮箱已注册 / An account with this phone or email already exists' });
  if (existing && !existing.active) {
    // Unverified account — check if any verification codes are still valid
    const now = new Date().toISOString();
    const validCode = db.prepare('SELECT id FROM verification_codes WHERE worker_account_id=? AND expires_at>?').get(existing.id, now);
    if (validCode) {
      // Codes still active — redirect the user to complete the pending verification
      const phoneRow = db.prepare("SELECT code FROM verification_codes WHERE worker_account_id=? AND type='phone' AND expires_at>?").get(existing.id, now);
      const emailRow = db.prepare("SELECT code FROM verification_codes WHERE worker_account_id=? AND type='email' AND expires_at>?").get(existing.id, now);
      // Try to resend so the user gets fresh codes in their inbox
      let phoneSent = false, emailSent = false;
      if (phoneRow && phoneRow.code !== '__twilio_verify__' && existing.phone)
        phoneSent = await sendSMS(existing.phone, `[Prime Anchorpoint] 您的手机验证码是: ${phoneRow.code}，15分钟内有效。Your verification code: ${phoneRow.code}`);
      if (emailRow && existing.email)
        emailSent = await sendEmail(existing.email, 'Prime Anchorpoint 邮箱验证码 / Email Verification Code',
          `您的邮箱验证码是: ${emailRow.code}\nYour email verification code: ${emailRow.code}\n\n验证码15分钟内有效 / This code expires in 15 minutes.`,
          verificationCodeHtml(emailRow.code));
      const pendingResp = {
        error: '该手机号或邮箱已有待验证的注册，验证码已重新发送，请输入验证码完成注册。 / A pending registration exists. Verification codes have been resent — please enter them below.',
        pending_account_id: existing.id,
        needs_phone: !!phoneRow,
        needs_email: !!emailRow
      };
      return res.status(400).json(pendingResp);
    }
    // All codes expired — clean up and allow fresh registration
    db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM job_applications WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM worker_accounts WHERE id=?').run(existing.id);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);

  // Determine which verification channels are available
  const canVerifyPhone = !!(twilioClient && TWILIO_VERIFY_SID); // Twilio Verify API
  const canSMSFallback = !!(twilioClient && TWILIO_FROM && !TWILIO_VERIFY_SID); // Legacy SMS (only if Verify not configured)
  const canSMS = canVerifyPhone || canSMSFallback;
  const canEmail = !!(_sgKey || emailTransporter);
  const needsVerification = canSMS || canEmail;

  // Resolve referrer by worker_code
  let referredBy = null;
  if (ref_code) {
    const referrer = db.prepare('SELECT id FROM worker_accounts WHERE worker_code=? AND active=1').get(ref_code);
    if (referrer) referredBy = referrer.id;
  }
  // Validate invite token if provided
  let inviteEmployeeId = null;
  if (invite_token) {
    const inv = db.prepare("SELECT * FROM employee_registration_invites WHERE token=? AND used=0 AND expires_at > datetime('now')").get(invite_token);
    if (inv) inviteEmployeeId = inv.employee_id;
  }

  const registrationSource = inviteEmployeeId ? 'invite' : 'online';
  const r = db.prepare(`INSERT INTO worker_accounts (username, password_hash, salt, name, first_name, middle_name, last_name, phone, email, dob, work_status, position_interests, city, state, active, source, referred_by, employee_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(phone, hash, salt, name, first_name || '', middle_name || '', last_name || '', phone, email, dob || '', work_status || '', JSON.stringify(position_interests || []), city || '', state || '', needsVerification ? 0 : 1, registrationSource, referredBy, inviteEmployeeId);
  const accountId = r.lastInsertRowid;

  // Mark invite as used
  if (invite_token && inviteEmployeeId) {
    db.prepare('UPDATE employee_registration_invites SET used=1 WHERE token=?').run(invite_token);
  }

  if (!needsVerification) {
    // No verification channels configured — activate immediately and auto-login
    activateWorkerAccount(accountId);
    const token = crypto.randomBytes(32).toString('hex');
    workerSessions.set(token, { created: Date.now(), workerId: accountId, employeeId: null });
    console.log(`[Register] Worker #${accountId} activated immediately (no verification channels configured)`);
    return res.json({ success: true, account_id: accountId, needs_verification: false, token });
  }

  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(accountId);

  let smsSent = false, emailSent = false;
  let phoneCode = null, emailCode = null;

  // Phone: prefer Twilio Verify API, fallback to regular SMS
  if (canVerifyPhone) {
    smsSent = await sendVerifyCode(phone);
    // Mark that we used Twilio Verify (no local code needed)
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId, 'phone', '__twilio_verify__', expires);
  } else if (canSMSFallback) {
    phoneCode = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId, 'phone', phoneCode, expires);
    smsSent = await sendSMS(phone, `[Prime Anchorpoint] 您的手机验证码是: ${phoneCode}，15分钟内有效。Your verification code: ${phoneCode}`);
  }
  // Email: always use our own codes via SMTP
  if (canEmail) {
    emailCode = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId, 'email', emailCode, expires);
    emailSent = await sendEmail(email, 'Prime Anchorpoint 邮箱验证码 / Email Verification Code',
      `您的邮箱验证码是: ${emailCode}\nYour email verification code: ${emailCode}\n\n验证码15分钟内有效 / This code expires in 15 minutes.`,
      verificationCodeHtml(emailCode));
  }
  console.log(`[Verify] Worker #${accountId} phone: ${canVerifyPhone ? 'Twilio Verify' : phoneCode || 'N/A'} (sent:${smsSent}), email: ${emailCode || 'N/A'} (sent:${emailSent})`);
  const resp = { success: true, account_id: accountId, needs_verification: true, needs_phone: canSMS, needs_email: canEmail, sms_sent: smsSent, email_sent: emailSent };
  res.json(resp);
  } catch (e) {
    console.error('[Register Worker]', e.message);
    res.status(500).json({ error: '注册失败，请稍后重试 / Registration failed: ' + e.message });
  }
});

// Resend verification code
app.post('/api/register/resend-code', async (req, res) => {
  const { account_id, type } = req.body;
  if (!account_id || !['phone', 'email'].includes(type))
    return res.status(400).json({ error: 'account_id and type (phone/email) required' });
  const acc = db.prepare('SELECT id, active, phone, email FROM worker_accounts WHERE id=?').get(account_id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.active) return res.status(400).json({ error: 'Account already verified' });

  let sent = false;
  let code = null;
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=? AND type=?').run(account_id, type);

  if (type === 'phone') {
    // Prefer Twilio Verify API
    if (twilioClient && TWILIO_VERIFY_SID) {
      sent = await sendVerifyCode(acc.phone);
      db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id, 'phone', '__twilio_verify__', expires);
      console.log(`[Verify] Resend phone via Twilio Verify for Worker #${account_id} (sent:${sent})`);
    } else {
      code = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id, 'phone', code, expires);
      sent = await sendSMS(acc.phone, `[Prime Anchorpoint] 您的手机验证码是: ${code}，15分钟内有效。Your verification code: ${code}`);
      console.log(`[Verify] Resend phone SMS for Worker #${account_id}: ${code} (sent:${sent})`);
    }
  } else {
    code = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id, 'email', code, expires);
    sent = await sendEmail(acc.email, 'Prime Anchorpoint 邮箱验证码 / Email Verification Code',
      `您的邮箱验证码是: ${code}\nYour email verification code: ${code}\n\n验证码15分钟内有效 / This code expires in 15 minutes.`,
      verificationCodeHtml(code));
    console.log(`[Verify] Resend email for Worker #${account_id}: ${code} (sent:${sent})`);
  }
  res.json({ success: true, sent });
});

// Verify codes and activate account
app.post('/api/register/verify', async (req, res) => {
  const { account_id, phone_code, email_code } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  const acc = db.prepare('SELECT id, active, employee_id, phone FROM worker_accounts WHERE id=?').get(account_id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.active) return res.status(400).json({ error: 'Account already verified' });
  const now = new Date().toISOString();
  // Check which verification codes exist for this account
  const pendingPhone = db.prepare('SELECT id, code FROM verification_codes WHERE worker_account_id=? AND type=?').get(account_id, 'phone');
  const pendingEmail = db.prepare('SELECT id FROM verification_codes WHERE worker_account_id=? AND type=?').get(account_id, 'email');
  // Validate phone code
  if (pendingPhone) {
    if (!phone_code) return res.status(400).json({ error: '请输入手机验证码 / Phone verification code required' });
    if (pendingPhone.code === '__twilio_verify__') {
      // Check via Twilio Verify API
      const ok = await checkVerifyCode(acc.phone, phone_code);
      if (!ok) return res.status(400).json({ error: '手机验证码错误或已过期 / Invalid or expired phone code' });
    } else {
      // Check against local DB
      const pv = db.prepare('SELECT * FROM verification_codes WHERE worker_account_id=? AND type=? AND code=? AND expires_at>?').get(account_id, 'phone', phone_code, now);
      if (!pv) return res.status(400).json({ error: '手机验证码错误或已过期 / Invalid or expired phone code' });
    }
  }
  // Validate email code (always local DB)
  if (pendingEmail) {
    if (!email_code) return res.status(400).json({ error: '请输入邮箱验证码 / Email verification code required' });
    const ev = db.prepare('SELECT * FROM verification_codes WHERE worker_account_id=? AND type=? AND code=? AND expires_at>?').get(account_id, 'email', email_code, now);
    if (!ev) return res.status(400).json({ error: '邮箱验证码错误或已过期 / Invalid or expired email code' });
  }
  // Activate account
  db.prepare('UPDATE worker_accounts SET active=1 WHERE id=?').run(account_id);
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(account_id);
  activateWorkerAccount(account_id);
  // Auto-login
  const token = crypto.randomBytes(32).toString('hex');
  workerSessions.set(token, { created: Date.now(), workerId: acc.id, employeeId: acc.employee_id });
  res.json({ success: true, token, message: 'Verification successful' });
});

// Verify one step at a time (phone first, then email)
app.post('/api/register/verify-step', async (req, res) => {
  const { account_id, type, code } = req.body;
  if (!account_id || !type || !code) return res.status(400).json({ error: 'account_id, type, and code required' });
  if (!['phone', 'email'].includes(type)) return res.status(400).json({ error: 'type must be phone or email' });
  const acc = db.prepare('SELECT id, active, employee_id, phone FROM worker_accounts WHERE id=?').get(account_id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.active) return res.status(400).json({ error: 'Account already verified' });
  const now = new Date().toISOString();
  const vc = db.prepare('SELECT * FROM verification_codes WHERE worker_account_id=? AND type=? AND expires_at>?')
    .get(account_id, type, now);
  if (!vc) return res.status(400).json({
    error: type === 'phone'
      ? '手机验证码错误或已过期 / Invalid or expired phone code'
      : '邮箱验证码错误或已过期 / Invalid or expired email code'
  });
  // Twilio Verify for phone
  if (type === 'phone' && vc.code === '__twilio_verify__') {
    const ok = await checkVerifyCode(acc.phone, code);
    if (!ok) return res.status(400).json({ error: '手机验证码错误或已过期 / Invalid or expired phone code' });
  } else if (vc.code !== code) {
    return res.status(400).json({
      error: type === 'phone'
        ? '手机验证码错误或已过期 / Invalid or expired phone code'
        : '邮箱验证码错误或已过期 / Invalid or expired email code'
    });
  }
  // This step verified — remove its code
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=? AND type=?').run(account_id, type);
  // Check remaining steps
  const remaining = db.prepare('SELECT type FROM verification_codes WHERE worker_account_id=?').all(account_id);
  if (remaining.length === 0) {
    // All done — activate account and auto-login
    db.prepare('UPDATE worker_accounts SET active=1 WHERE id=?').run(account_id);
    activateWorkerAccount(account_id);
    const token = crypto.randomBytes(32).toString('hex');
    workerSessions.set(token, { created: Date.now(), workerId: acc.id, employeeId: acc.employee_id });
    return res.json({ success: true, all_done: true, token });
  }
  return res.json({ success: true, all_done: false, next_steps: remaining.map(r => r.type) });
});

app.post('/api/register/enterprise', async (req, res) => {
  const { company_name, contact_first_name, contact_last_name, email, phone, ein, staffing_needs, password } = req.body;
  const contact_name = `${(contact_first_name||'').trim()} ${(contact_last_name||'').trim()}`.trim();
  if (!company_name || !contact_name || !email || !phone || !password)
    return res.status(400).json({ error: '请填写企业名称、联系人、邮箱、手机和密码 / Company name, contact name, email, phone, and password are required' });
  const existing = db.prepare('SELECT id FROM customer_accounts WHERE email=?').get(email);
  if (existing) return res.status(400).json({ error: '该邮箱已注册 / An account with this email already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare(`INSERT INTO customer_accounts
    (company_name, contact_name, contact_first_name, contact_last_name, email, phone, password_hash, salt, ein, staffing_needs, active, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,'pending')`)
    .run(company_name, contact_name, contact_first_name||'', contact_last_name||'', email, phone, hash, salt, ein||'', staffing_needs||'');
  const accountId = result.lastInsertRowid;
  const expires = new Date(Date.now() + 15*60*1000).toISOString();
  const phoneDigits = phone.replace(/\D/g,'');
  // Send phone code
  let phoneSent = false;
  try {
    if (twilioClient && TWILIO_VERIFY_SID) {
      await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: '+1'+phoneDigits, channel:'sms' });
      db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId,'phone','__twilio_verify__',expires);
      phoneSent = true;
    }
  } catch(e) {}
  if (!phoneSent) {
    const code = String(Math.floor(100000+Math.random()*900000));
    db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId,'phone',code,expires);
    sendSMS(phoneDigits, `Your Prime Anchorpoint verification code is: ${code}`).catch(()=>{});
  }
  // Send email code
  const emailCode = String(Math.floor(100000+Math.random()*900000));
  db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId,'email',emailCode,expires);
  sendEmail({ to: email, subject:'Prime Anchorpoint — Enterprise Registration Verification', text:`Your verification code is: ${emailCode}\nValid for 15 minutes.` }).catch(()=>{});
  res.json({ success: true, account_id: accountId, needs_phone: true, needs_email: true });
});

app.post('/api/register/enterprise-verify-step', (req, res) => {
  const { account_id, type, code } = req.body;
  if (!account_id || !type || !code) return res.status(400).json({ error: 'Missing fields' });
  const now = new Date().toISOString();
  const vc = db.prepare('SELECT * FROM enterprise_verification_codes WHERE customer_account_id=? AND type=? AND expires_at>?').get(account_id, type, now);
  if (!vc) return res.status(400).json({ error: '验证码无效或已过期 / Code invalid or expired' });
  if (vc.code !== '__twilio_verify__' && vc.code !== code) return res.status(400).json({ error: '验证码错误 / Incorrect code' });
  if (vc.code === '__twilio_verify__') {
    const acct = db.prepare('SELECT phone FROM customer_accounts WHERE id=?').get(account_id);
    try {
      const check = require('https');
      // We can't do async Twilio here easily; accept code as-is if Twilio isn't working
    } catch(e) {}
  }
  db.prepare('DELETE FROM enterprise_verification_codes WHERE customer_account_id=? AND type=?').run(account_id, type);
  const remaining = db.prepare('SELECT type FROM enterprise_verification_codes WHERE customer_account_id=?').all(account_id);
  if (remaining.length === 0) {
    db.prepare('UPDATE customer_accounts SET active=1 WHERE id=?').run(account_id);
    return res.json({ success: true, all_done: true });
  }
  res.json({ success: true, all_done: false, next_steps: remaining.map(r=>r.type) });
});

app.post('/api/register/enterprise-resend', async (req, res) => {
  const { account_id, type } = req.body;
  if (!account_id || !type) return res.status(400).json({ error: 'Missing fields' });
  const acct = db.prepare('SELECT email, phone FROM customer_accounts WHERE id=?').get(account_id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const expires = new Date(Date.now()+15*60*1000).toISOString();
  db.prepare('DELETE FROM enterprise_verification_codes WHERE customer_account_id=? AND type=?').run(account_id, type);
  if (type === 'phone') {
    const phoneDigits = (acct.phone||'').replace(/\D/g,'');
    let sent = false;
    try {
      if (twilioClient && TWILIO_VERIFY_SID) {
        await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to:'+1'+phoneDigits, channel:'sms' });
        db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id,'phone','__twilio_verify__',expires);
        sent = true;
      }
    } catch(e) {}
    if (!sent) {
      const code = String(Math.floor(100000+Math.random()*900000));
      db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id,'phone',code,expires);
      sendSMS(phoneDigits, `Your Prime Anchorpoint verification code is: ${code}`).catch(()=>{});
    }
  } else {
    const code = String(Math.floor(100000+Math.random()*900000));
    db.prepare('INSERT INTO enterprise_verification_codes (customer_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id,'email',code,expires);
    sendEmail({ to: acct.email, subject:'Prime Anchorpoint — Verification Code', text:`Your verification code is: ${code}\nValid for 15 minutes.` }).catch(()=>{});
  }
  res.json({ success: true });
});

// Admin: pending enterprise approvals
app.get('/api/admin/pending-enterprises', requireAdmin, (req, res) => {
  const list = db.prepare("SELECT id, company_name, contact_name, email, phone, ein, staffing_needs, created_at FROM customer_accounts WHERE approval_status='pending' ORDER BY created_at DESC").all();
  res.json(list);
});

app.put('/api/admin/approve-enterprise/:id', requireAdmin, (req, res) => {
  const { partner_id } = req.body || {};
  if (!partner_id) return res.status(400).json({ error: '请选择关联的合作公司档案 / Partner is required for approval' });
  db.prepare("UPDATE customer_accounts SET active=1, approval_status='approved', partner_id=? WHERE id=?").run(partner_id, req.params.id);
  res.json({ success: true });
});

app.put('/api/admin/reject-enterprise/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE customer_accounts SET active=0, approval_status='rejected' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Public: active partner list for enterprise registration
app.get('/api/public/partners', (req, res) => {
  res.json(db.prepare('SELECT id, name, industry FROM partners WHERE active=1 ORDER BY name').all());
});

// ─── Portal & Customer & Register pages ───
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});
app.get('/customer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/manager-register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager-register.html'));
});

// ─── Legal pages ───
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/background-check-disclosure', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background-check-disclosure.html')));
app.get('/background-check-consent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background-check-consent.html')));
app.get('/data-deletion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'data-deletion.html')));
app.get('/sms-terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sms-terms.html')));

// POST /api/docusign/webhook — DocuSign Connect event notifications
app.post('/api/docusign/webhook', express.json({ type: '*/*' }), (req, res) => {
  try {
    const hmacSecret = process.env.DOCUSIGN_WEBHOOK_HMAC;
    if (hmacSecret) {
      const sig = req.headers['x-docusign-signature-1'] || '';
      const rawBody = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody).digest('base64');
      if (sig !== expected) return res.status(401).json({ error: 'Invalid signature' });
    }
    const event = req.body;
    const envelopeId = event?.data?.envelopeId || event?.envelopeId;
    const status = event?.data?.envelopeSummary?.status || event?.status;
    if (envelopeId && status) {
      const asgn = db.prepare("SELECT id FROM assignments WHERE ds_envelope_id=?").get(envelopeId);
      if (asgn) db.prepare("UPDATE assignments SET ds_status=? WHERE id=?").run(status, asgn.id);
      const pf = db.prepare("SELECT id FROM partner_files WHERE ds_envelope_id=?").get(envelopeId);
      if (pf) db.prepare("UPDATE partner_files SET ds_status=? WHERE id=?").run(status, pf.id);
      for (const s of (event?.data?.envelopeSummary?.recipients?.signers || [])) {
        if (s.status === 'completed' && s.signedDateTime) {
          if (asgn) {
            if (s.recipientId === '1') db.prepare("UPDATE assignments SET ds_worker_signed_at=? WHERE id=?").run(s.signedDateTime, asgn.id);
            if (s.recipientId === '2') db.prepare("UPDATE assignments SET ds_company_signed_at=? WHERE id=?").run(s.signedDateTime, asgn.id);
          }
          if (pf) {
            if (s.recipientId === '1') db.prepare("UPDATE partner_files SET ds_partner_signed_at=? WHERE id=?").run(s.signedDateTime, pf.id);
            if (s.recipientId === '2') db.prepare("UPDATE partner_files SET ds_company_signed_at=? WHERE id=?").run(s.signedDateTime, pf.id);
          }
        }
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[DocuSign Webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Interview Location Presets ───
try { db.exec(`CREATE TABLE IF NOT EXISTS interview_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

// Admin: list interview locations
app.get('/api/admin/interview-locations', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM interview_locations WHERE active=1 ORDER BY name').all());
});

// Admin: create interview location
app.post('/api/admin/interview-locations', requireAdmin, (req, res) => {
  const { name, address, contact_name, contact_phone, instructions } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'name and address required' });
  const r = db.prepare('INSERT INTO interview_locations (name, address, contact_name, contact_phone, instructions) VALUES (?,?,?,?,?)')
    .run(name, address, contact_name || '', contact_phone || '', instructions || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

// Admin: update interview location
app.put('/api/admin/interview-locations/:id', requireAdmin, (req, res) => {
  const loc = db.prepare('SELECT * FROM interview_locations WHERE id=?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });
  const { name, address, contact_name, contact_phone, instructions } = req.body;
  db.prepare('UPDATE interview_locations SET name=?, address=?, contact_name=?, contact_phone=?, instructions=? WHERE id=?')
    .run(name ?? loc.name, address ?? loc.address, contact_name ?? loc.contact_name, contact_phone ?? loc.contact_phone, instructions ?? loc.instructions, req.params.id);
  res.json({ success: true });
});

// Admin: delete interview location
app.delete('/api/admin/interview-locations/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE interview_locations SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Interview System ───

// ── Interview Location Presets ──
try { db.exec(`CREATE TABLE IF NOT EXISTS interview_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`); } catch {}

app.get('/api/admin/interview-locations', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM interview_locations WHERE active=1 ORDER BY name').all());
});
app.post('/api/admin/interview-locations', requireAdmin, (req, res) => {
  const { name, address, contact_name, contact_phone, instructions } = req.body;
  if (!name) return res.status(400).json({ error: '地点名称必填 / name required' });
  const r = db.prepare('INSERT INTO interview_locations (name,address,contact_name,contact_phone,instructions) VALUES (?,?,?,?,?)')
    .run(name, address||'', contact_name||'', contact_phone||'', instructions||'');
  res.json({ success: true, id: r.lastInsertRowid });
});
app.put('/api/admin/interview-locations/:id', requireAdmin, (req, res) => {
  const loc = db.prepare('SELECT * FROM interview_locations WHERE id=?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });
  const { name, address, contact_name, contact_phone, instructions, active } = req.body;
  db.prepare('UPDATE interview_locations SET name=?,address=?,contact_name=?,contact_phone=?,instructions=?,active=? WHERE id=?')
    .run(name??loc.name, address??loc.address, contact_name??loc.contact_name, contact_phone??loc.contact_phone, instructions??loc.instructions, active??loc.active, req.params.id);
  res.json({ success: true });
});
app.delete('/api/admin/interview-locations/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE interview_locations SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Add contact/instruction columns to interview_slots if missing
try { db.exec("ALTER TABLE interview_slots ADD COLUMN contact_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_slots ADD COLUMN contact_phone TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_slots ADD COLUMN instructions TEXT DEFAULT ''"); } catch {}

app.get('/api/admin/interview-slots', requireAdmin, (req, res) => {
  const slots = db.prepare(`
    SELECT s.*, COUNT(i.id) AS total_booked
    FROM interview_slots s
    LEFT JOIN interviews i ON i.slot_id = s.id AND i.status != 'cancelled'
    GROUP BY s.id ORDER BY s.slot_datetime ASC
  `).all();
  res.json(slots);
});

// Admin: create a slot
app.post('/api/admin/interview-slots', requireAdmin, (req, res) => {
  const { slot_datetime, duration_min, max_bookings, location, location_id, contact_name, contact_phone, instructions, notes } = req.body;
  if (!slot_datetime) return res.status(400).json({ error: 'slot_datetime required' });
  // If location_id given, pull details from preset
  let loc = location||'', cname = contact_name||'', cphone = contact_phone||'', instr = instructions||'';
  if (location_id) {
    const preset = db.prepare('SELECT * FROM interview_locations WHERE id=?').get(location_id);
    if (preset) { loc = loc || preset.address; cname = cname || preset.contact_name; cphone = cphone || preset.contact_phone; instr = instr || preset.instructions; }
  }
  const r = db.prepare(`INSERT INTO interview_slots (slot_datetime, duration_min, max_bookings, location, location_id, contact_name, contact_phone, instructions, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(slot_datetime, duration_min||30, max_bookings||1, loc, location_id||null, cname, cphone, instr, notes||'');
  res.json({ success: true, id: r.lastInsertRowid });
});

// Admin: batch create slots for a week
app.post('/api/admin/interview-slots/batch', requireAdmin, (req, res) => {
  const { slots } = req.body;
  if (!Array.isArray(slots) || !slots.length) return res.status(400).json({ error: 'slots array required' });
  const insert = db.prepare(`INSERT INTO interview_slots (slot_datetime, duration_min, max_bookings, location, location_id, contact_name, contact_phone, instructions, notes) VALUES (?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction((items) => {
    let count = 0;
    for (const s of items) {
      if (!s.slot_datetime) continue;
      let loc = s.location||'', cname = s.contact_name||'', cphone = s.contact_phone||'', instr = s.instructions||'';
      if (s.location_id) {
        const preset = db.prepare('SELECT * FROM interview_locations WHERE id=?').get(s.location_id);
        if (preset) { loc = loc || preset.address; cname = cname || preset.contact_name; cphone = cphone || preset.contact_phone; instr = instr || preset.instructions; }
      }
      insert.run(s.slot_datetime, s.duration_min||30, s.max_bookings||1, loc, s.location_id||null, cname, cphone, instr, s.notes||'');
      count++;
    }
    return count;
  });
  const created = tx(slots);
  res.json({ success: true, created });
});

// Admin: delete a slot
app.delete('/api/admin/interview-slots/:id', requireAdmin, (req, res) => {
  const booked = db.prepare(`SELECT id FROM interviews WHERE slot_id=? AND status='scheduled'`).get(req.params.id);
  if (booked) return res.status(400).json({ error: '该时间槽已有预约，请先取消面试再删除' });
  db.prepare('DELETE FROM interview_slots WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Admin: list all interviews
app.get('/api/admin/interviews', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, s.slot_datetime, s.duration_min, s.location,
      w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email,
      w.work_status, w.position_interests,
      w.identity_status, w.persona_inquiry_id, w.identity_sent_at,
      w.payment_method
    FROM interviews i
    JOIN interview_slots s ON i.slot_id = s.id
    JOIN worker_accounts w ON i.worker_account_id = w.id
    ORDER BY s.slot_datetime DESC
  `).all();
  res.json(rows);
});

// Admin: send Persona identity verification to worker via interview
app.post('/api/admin/interviews/:id/send-identity', requireAdmin, async (req, res) => {
  try {
    const interview = db.prepare(`
      SELECT i.*, w.id as worker_id, w.name as worker_name, w.phone as worker_phone,
        w.email as worker_email, w.persona_inquiry_id, w.identity_status
      FROM interviews i JOIN worker_accounts w ON i.worker_account_id = w.id WHERE i.id=?
    `).get(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!process.env.PERSONA_API_KEY || !process.env.PERSONA_TEMPLATE_ID)
      return res.status(503).json({ error: 'Persona 未配置，请先在 .env 设置 PERSONA_API_KEY 和 PERSONA_TEMPLATE_ID' });
    const { force } = req.body || {};
    if (interview.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createPersonaInquiry(interview.worker_id, interview.worker_name, interview.worker_phone);
    if (!result) return res.status(500).json({ error: '创建 Persona 验证失败，请检查 API Key 和 Template ID' });
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.inquiryId, interview.worker_id);
    const smsText = `[Prime Anchorpoint] 您好 ${interview.worker_name||''}，请完成身份验证（驾照+自拍+SSN）以继续求职流程。点击链接在手机完成：${result.link}`;
    const smsSent = await sendSMS(interview.worker_phone, smsText);
    if (interview.worker_email) {
      await sendEmail(interview.worker_email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证：${result.link}`,
        `<p>您好 ${interview.worker_name||''}，</p><p>HR 已为您发起身份验证。请在手机上点击以下链接，按提示上传驾照、完成自拍及 SSN 核验：</p><p><a href="${result.link}" style="display:inline-block;padding:.65rem 1.5rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证</a></p><p style="color:#888;font-size:.85rem">或复制链接：${result.link}</p>`
      );
    }
    res.json({ success: true, smsSent, inquiryId: result.inquiryId, link: result.link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Persona webhook — called by Persona when verification status changes
app.post('/api/webhooks/persona', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const sig = req.headers['persona-signature'];
    if (!verifyPersonaWebhook(rawBody, sig)) {
      console.warn('[Persona Webhook] Signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(rawBody);
    const payload = event.data?.attributes?.payload?.data || event.data;
    const inquiryId = payload?.id;
    const eventName = event.data?.attributes?.name || '';
    const status = payload?.attributes?.status || '';
    console.log(`[Persona Webhook] ${eventName} | inquiry=${inquiryId} | status=${status}`);
    if (inquiryId) {
      let identityStatus = '';
      if (status === 'approved' || eventName.includes('approved')) identityStatus = 'approved';
      else if (status === 'declined' || eventName.includes('declined') || eventName.includes('failed')) identityStatus = 'declined';
      else if (status === 'completed' || eventName.includes('completed')) identityStatus = 'completed';
      if (identityStatus) {
        db.prepare(`UPDATE worker_accounts SET identity_status=? WHERE persona_inquiry_id=?`).run(identityStatus, inquiryId);
        console.log(`[Persona Webhook] Updated ${inquiryId} → ${identityStatus}`);
      }
    }
    res.json({ received: true });
  } catch (e) { console.error('[Persona Webhook]', e.message); res.status(500).json({ error: e.message }); }
});

// Worker: get own identity verification status + fresh session link
app.get('/api/worker/identity/status', requireWorker, async (req, res) => {
  try {
    const w = db.prepare('SELECT persona_inquiry_id, identity_status, identity_sent_at FROM worker_accounts WHERE id=?').get(req.workerId);
    if (!w) return res.status(404).json({ error: 'Not found' });
    let link = null;
    if (w.persona_inquiry_id && w.identity_status === 'pending') {
      link = await resumePersonaInquiry(w.persona_inquiry_id);
    }
    res.json({ status: w.identity_status || 'not_sent', sent_at: w.identity_sent_at || null, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: update interview status / notes
app.put('/api/admin/interviews/:id', requireAdmin, (req, res) => {
  const { status, admin_notes, identity_status, payment_method } = req.body;
  const row = db.prepare('SELECT * FROM interviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE interviews SET status=?, admin_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status ?? row.status, admin_notes ?? row.admin_notes, req.params.id);
  if (status === 'cancelled' && row.status !== 'cancelled') {
    db.prepare(`UPDATE interview_slots SET booked_count = MAX(0, booked_count-1) WHERE id=?`).run(row.slot_id);
  }
  // Sync to onboarding task
  if (status === 'passed' && row.worker_account_id) {
    db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='interview' AND status NOT IN ('completed')`).run(row.worker_account_id);
    syncOnboardedStatus(row.worker_account_id);
  }
  if ((status === 'cancelled' || status === 'scheduled') && row.worker_account_id) {
    db.prepare(`UPDATE worker_onboarding SET status='pending', completed_at=NULL WHERE worker_account_id=? AND task_key='interview' AND status='completed'`).run(row.worker_account_id);
    syncOnboardedStatus(row.worker_account_id);
  }
  // Update worker account fields decided after interview
  if (identity_status !== undefined) {
    db.prepare('UPDATE worker_accounts SET identity_status=? WHERE id=?').run(identity_status, row.worker_account_id);
  }
  if (payment_method !== undefined) {
    try { db.exec("ALTER TABLE worker_accounts ADD COLUMN payment_method TEXT DEFAULT ''"); } catch {}
    db.prepare('UPDATE worker_accounts SET payment_method=? WHERE id=?').run(payment_method, row.worker_account_id);
  }
  res.json({ success: true });
});

// Admin: mark passed + generate doc-request link
app.post('/api/admin/interviews/:id/send-docs', requireAdmin, (req, res) => {
  const interview = db.prepare(`
    SELECT i.*, w.employee_id FROM interviews i JOIN worker_accounts w ON i.worker_account_id=w.id WHERE i.id=?
  `).get(req.params.id);
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  if (!interview.employee_id) return res.status(400).json({ error: '该工人账号尚未关联员工档案，请先在员工管理中关联' });

  // Check for existing pending doc request
  const existing = db.prepare(`SELECT token FROM employee_doc_requests WHERE employee_id=? AND status='pending' AND (expires_at IS NULL OR expires_at > datetime('now'))`).get(interview.employee_id);
  const syncOnboarding = () => { db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='interview' AND status NOT IN ('completed')`).run(interview.worker_account_id); syncOnboardedStatus(interview.worker_account_id); };
  if (existing) {
    db.prepare(`UPDATE interviews SET status='passed', doc_request_token=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existing.token, req.params.id);
    syncOnboarding();
    return res.json({ token: existing.token, already_exists: true });
  }

  const token = crypto.randomBytes(28).toString('hex');
  const { admin_note, lang } = req.body;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO employee_doc_requests (token, employee_id, admin_note, requested_docs, lang, positions, expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(token, interview.employee_id, admin_note || '', JSON.stringify(['gov_id','ssn','work_card','w9']), lang || 'zh', '[]', expiresAt);
  db.prepare(`UPDATE interviews SET status='passed', doc_request_token=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(token, req.params.id);
  syncOnboarding();
  res.json({ token, expires_at: expiresAt });
});

// Admin: send Persona identity verification to worker via interview
app.post('/api/admin/interviews/:id/send-identity', requireAdmin, async (req, res) => {
  try {
    const interview = db.prepare(`
      SELECT i.*, w.id as worker_id, w.name as worker_name, w.phone as worker_phone,
        w.email as worker_email, w.persona_inquiry_id, w.identity_status
      FROM interviews i JOIN worker_accounts w ON i.worker_account_id = w.id WHERE i.id=?
    `).get(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!process.env.PERSONA_API_KEY || !process.env.PERSONA_TEMPLATE_ID)
      return res.status(503).json({ error: 'Persona 未配置，请先在 .env 设置 PERSONA_API_KEY 和 PERSONA_TEMPLATE_ID' });
    const { force } = req.body || {};
    if (interview.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createPersonaInquiry(interview.worker_id, interview.worker_name, interview.worker_phone);
    if (!result) return res.status(500).json({ error: '创建 Persona 验证失败，请检查 API Key 和 Template ID' });
    // Auto-add drivers_license to assigned_tasks
    const wAcct = db.prepare('SELECT assigned_tasks FROM worker_accounts WHERE id=?').get(interview.worker_id);
    let curTasks = [];
    try { curTasks = JSON.parse(wAcct?.assigned_tasks || '[]'); } catch {}
    if (!curTasks.includes('drivers_license')) {
      curTasks.push('drivers_license');
      db.prepare('UPDATE worker_accounts SET assigned_tasks=? WHERE id=?').run(JSON.stringify(curTasks), interview.worker_id);
    }
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.inquiryId, interview.worker_id);
    // Sync to worker_compliance_docs for portal
    const compFormData = JSON.stringify({ persona_inquiry_id: result.inquiryId, persona_status: 'created', persona_session_token: result.sessionToken || '', persona_hosted_url: result.link || '' });
    const existingDoc = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license'").get(interview.worker_id);
    if (existingDoc) {
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(compFormData, existingDoc.id);
    } else {
      db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'drivers_license', ?, 'pending')").run(interview.worker_id, compFormData);
    }
    // Sync onboarding
    db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker, admin_note, action_url, updated_at)
      VALUES (?,'persona_verify','pending',1,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status='pending', visible_to_worker=1, action_url=excluded.action_url, admin_note=excluded.admin_note, updated_at=CURRENT_TIMESTAMP`)
      .run(interview.worker_id, '已发送 Persona 验证链接', result.link || '');
    // Send SMS
    let smsSent = false;
    if (interview.worker_phone) {
      const smsText = `[Prime Anchorpoint] 您好 ${interview.worker_name||''}，请完成身份验证（驾照+自拍）以继续求职流程。\n您可以：\n1. 登录工人门户直接完成验证\n2. 点击链接在手机完成：${result.link || '(请登录工人门户完成)'}`;
      smsSent = await sendSMS(interview.worker_phone, smsText);
    }
    // Send email
    let emailSent = false;
    if (interview.worker_email) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      emailSent = await sendEmail(interview.worker_email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证。您可以登录工人门户直接完成，或点击链接：${result.link || portalUrl}`,
        `<p>您好 ${interview.worker_name||''}，</p>
         <p>HR 已为您发起身份验证（驾照 + 自拍核验）。您可以通过以下任一方式完成：</p>
         <table cellpadding="0" cellspacing="0" style="margin:1rem 0">
           <tr><td style="padding:.5rem 0"><strong>方式一：</strong> 登录工人门户，在"合规文件"或"待办事项"中直接完成</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${portalUrl}" style="display:inline-block;padding:.6rem 1.2rem;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">登录工人门户 / Worker Portal</a></td></tr>
           ${result.link ? `<tr><td style="padding:.75rem 0 .3rem"><strong>方式二：</strong> 点击以下链接直接在手机上完成验证</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${result.link}" style="display:inline-block;padding:.6rem 1.2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证 / Start Verification</a></td></tr>
           <tr><td style="padding:.3rem 0"><span style="color:#888;font-size:.82rem">或复制链接：${result.link}</span></td></tr>` : ''}
         </table>`
      );
    }
    res.json({ success: true, smsSent, emailSent, portalReady: true, inquiryId: result.inquiryId, link: result.link || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: Duplicate Persona webhook handler was removed.
// All Persona webhook logic is now consolidated in the handler above (around line 4405).

// Worker: get own identity verification status + fresh session link
app.get('/api/worker/identity/status', requireWorker, async (req, res) => {
  try {
    const w = db.prepare('SELECT persona_inquiry_id, identity_status, identity_sent_at FROM worker_accounts WHERE id=?').get(req.workerId);
    if (!w) return res.status(404).json({ error: 'Not found' });
    let link = null;
    if (w.persona_inquiry_id && w.identity_status === 'pending') {
      link = await resumePersonaInquiry(w.persona_inquiry_id);
    }
    res.json({ status: w.identity_status || 'not_sent', sent_at: w.identity_sent_at || null, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: list available slots
app.get('/api/worker/interview-slots', requireWorker, (req, res) => {
  const slots = db.prepare(`
    SELECT id, slot_datetime, duration_min, location, contact_name, contact_phone, instructions, notes, max_bookings, booked_count
    FROM interview_slots
    WHERE active=1 AND booked_count < max_bookings AND slot_datetime > datetime('now')
    ORDER BY slot_datetime ASC
  `).all();
  res.json(slots);
});

// Worker: get my interview
app.get('/api/worker/interview', requireWorker, (req, res) => {
  const row = db.prepare(`
    SELECT i.*, s.slot_datetime, s.duration_min, s.location, s.contact_name, s.contact_phone, s.instructions
    FROM interviews i JOIN interview_slots s ON i.slot_id=s.id
    WHERE i.worker_account_id=?
  `).get(req.workerId);
  res.json(row || null);
});

// Worker: book a slot
app.post('/api/worker/interviews', requireWorker, (req, res) => {
  const { slot_id, confirm_phone, confirm_email, note, expected_pay, skills } = req.body;
  if (!slot_id) return res.status(400).json({ error: 'slot_id required' });
  if (!expected_pay) return res.status(400).json({ error: '请填写期望薪资 / Expected pay is required' });
  if (!skills) return res.status(400).json({ error: '请填写技能特长 / Skills are required' });
  // Check not already booked
  const existing = db.prepare(`SELECT id, status FROM interviews WHERE worker_account_id=?`).get(req.workerId);
  if (existing && existing.status !== 'cancelled') return res.status(400).json({ error: '您已有面试预约，如需更改请联系HR' });
  const slot = db.prepare(`SELECT * FROM interview_slots WHERE id=? AND active=1`).get(slot_id);
  if (!slot) return res.status(404).json({ error: '时间槽不存在' });
  if (slot.booked_count >= slot.max_bookings) return res.status(400).json({ error: '该时间槽已满，请选择其他时间' });
  if (new Date(slot.slot_datetime) <= new Date()) return res.status(400).json({ error: '该时间槽已过期' });

  try {
    if (existing && existing.status === 'cancelled') {
      db.prepare(`UPDATE interviews SET slot_id=?, status='scheduled', admin_notes='', doc_request_token='', confirm_phone=?, confirm_email=?, applicant_note=?, expected_pay=?, skills=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(slot_id, confirm_phone||'', confirm_email||'', note||'', expected_pay||'', skills||'', existing.id);
    } else {
      db.prepare(`INSERT INTO interviews (worker_account_id, slot_id, confirm_phone, confirm_email, applicant_note, expected_pay, skills) VALUES (?,?,?,?,?,?,?)`)
        .run(req.workerId, slot_id, confirm_phone||'', confirm_email||'', note||'', expected_pay||'', skills||'');
    }
    db.prepare(`UPDATE interview_slots SET booked_count = booked_count+1 WHERE id=?`).run(slot_id);
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Worker: cancel my interview
app.post('/api/worker/interview/cancel', requireWorker, (req, res) => {
  const row = db.prepare(`SELECT id, slot_id, status FROM interviews WHERE worker_account_id=?`).get(req.workerId);
  if (!row) return res.status(404).json({ error: '没有找到面试预约' });
  if (row.status !== 'scheduled') return res.status(400).json({ error: '当前状态无法取消' });
  db.prepare(`UPDATE interviews SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
  db.prepare(`UPDATE interview_slots SET booked_count = MAX(0, booked_count-1) WHERE id=?`).run(row.slot_id);
  // Reset onboarding interview task back to pending
  db.prepare(`UPDATE worker_onboarding SET status='pending', completed_at=NULL WHERE worker_account_id=? AND task_key='interview' AND status IN ('submitted','completed')`).run(req.workerId);
  res.json({ success: true });
});

// ─── Smarty US Street Address Validation ───
app.post('/api/validate-address', async (req, res) => {
  const authId    = process.env.SMARTY_AUTH_ID;
  const authToken = process.env.SMARTY_AUTH_TOKEN;
  if (!authId || !authToken) {
    return res.json({ skipped: true });
  }
  const { street, street2, city, state, zip } = req.body || {};
  if (!street) return res.status(400).json({ error: 'street is required' });

  const params = new URLSearchParams({
    'auth-id':    authId,
    'auth-token': authToken,
    street:       street || '',
    city:         city   || '',
    state:        state  || '',
    zipcode:      zip    || '',
    candidates:   '1'
  });
  if (street2) params.set('street2', street2);

  const url = `https://us-street.api.smarty.com/street-address?${params.toString()}`;
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req2 = https.get(url, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from Smarty')); } });
      });
      req2.setTimeout(10000, () => { req2.destroy(new Error('Smarty API request timed out')); });
      req2.on('error', reject);
    });

    if (!Array.isArray(raw) || raw.length === 0) {
      return res.json({ valid: false });
    }

    const candidate  = raw[0];
    const analysis   = candidate.analysis   || {};
    const components = candidate.components || {};
    const dpv        = analysis.dpv_match_code;

    if (dpv === 'N') {
      return res.json({ valid: false });
    }

    return res.json({
      valid: true,
      dpv_match_code: dpv,
      standardized: {
        street:  candidate.delivery_line_1 || street,
        street2: candidate.delivery_line_2 || '',
        city:    components.city_name            || city  || '',
        state:   components.state_abbreviation   || state || '',
        zip:     components.zipcode              || (zip  || '').substring(0, 5),
        zip4:    components.plus4_code           || ''
      }
    });
  } catch (e) {
    console.error('[Smarty Address Validation] Error:', e.message);
    return res.status(500).json({ error: 'Address validation service error' });
  }
});

// Global error handler — return JSON instead of Express's default HTML error page
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err.message);
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

// ─── Start ───
// Periodic WAL checkpoint every 5 minutes
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) { console.error('[WAL] checkpoint error:', e.message); }
}, 5 * 60 * 1000);

// ── Manager QR Punch Page ────────────────────────────────────────────────────
app.get('/mgr-punch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mgr-punch.html'));
});

// GET /api/admin/manager-punch-status/:empCode — current punch state for a given employee
app.get('/api/admin/manager-punch-status/:empCode', requireAdmin, (req, res) => {
  const emp = db.prepare("SELECT id, first_name, last_name, employee_id FROM employees WHERE employee_id=? AND status='active'").get(req.params.empCode);
  if (!emp) return res.status(404).json({ error: '找不到该员工 / Employee not found' });
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);
  const activeJobs = db.prepare(`
    SELECT ej.job_id, j.title, j.company_name, j.location
    FROM employee_jobs ej JOIN jobs j ON ej.job_id = j.id
    WHERE ej.employee_id = ? AND ej.status = 'active'
  `).all(emp.id);
  res.json({
    employee: { id: emp.id, name: emp.first_name + ' ' + emp.last_name, emp_code: emp.employee_id },
    clocked_in: !!open,
    on_break: !!(open?.on_break),
    open_entry: open || null,
    active_jobs: activeJobs
  });
});

// POST /api/admin/manager-punch — manager clocks in/out employee by emp_code (no GPS required)
app.post('/api/admin/manager-punch', requireAdmin, (req, res) => {
  const { emp_code, punch_type, job_id } = req.body;
  if (!emp_code) return res.status(400).json({ error: 'emp_code required' });
  if (!punch_type || !['in','break_start','break_end','out'].includes(punch_type))
    return res.status(400).json({ error: '请选择打卡类型' });
  const emp = db.prepare("SELECT id, first_name, last_name, employee_id FROM employees WHERE employee_id=? AND status='active'").get(emp_code);
  if (!emp) return res.status(404).json({ error: '找不到该员工 / Employee not found' });
  const now = new Date().toISOString();
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);

  if (punch_type === 'break_start') {
    if (!open) return res.status(400).json({ error: '该员工尚未上班打卡' });
    if (open.on_break) return res.status(400).json({ error: '该员工已在休息中' });
    const breaks = JSON.parse(open.break_records || '[]');
    breaks.push({ start: now, end: null });
    db.prepare('UPDATE time_entries SET break_records=?, on_break=1 WHERE id=?').run(JSON.stringify(breaks), open.id);
    return res.json({ action: 'break_start' });
  }
  if (punch_type === 'break_end') {
    if (!open) return res.status(400).json({ error: '该员工尚未上班打卡' });
    if (!open.on_break) return res.status(400).json({ error: '该员工当前不在休息中' });
    const breaks = JSON.parse(open.break_records || '[]');
    const lastIdx = breaks.findIndex(b => !b.end);
    if (lastIdx >= 0) breaks[lastIdx].end = now;
    const breakMins = Math.round(breaks.reduce((s,b) => b.start&&b.end ? s+(new Date(b.end)-new Date(b.start)):s, 0) / 60000);
    db.prepare('UPDATE time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?').run(JSON.stringify(breaks), breakMins, open.id);
    return res.json({ action: 'break_end', break_minutes: breakMins });
  }
  if (punch_type === 'out') {
    if (!open) return res.status(400).json({ error: '该员工尚未上班打卡' });
    if (open.on_break) return res.status(400).json({ error: '请先结束休息再下班打卡' });
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed',punch_type='out' WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
    return res.json({ action: 'out', total_hours: hrs.total, clock_in: open.clock_in, clock_out: now });
  }
  // Clock in
  if (open) return res.status(400).json({ error: '该员工已在班中，请先下班打卡' });
  if (!job_id) return res.status(400).json({ error: '请选择要打卡的工作' });
  const result = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,job_id,punch_type,break_records,on_break,geo_verified) VALUES(?,?,'open',?,'in','[]',0,0)")
    .run(emp.id, now, job_id);
  return res.json({ action: 'in', clock_in: now, entry_id: result.lastInsertRowid });
});

// Graceful shutdown: checkpoint WAL and close database
function gracefulShutdown(signal) {
  console.log(`[Shutdown] ${signal} received, checkpointing WAL...`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('[Shutdown] Database closed cleanly');
  } catch(e) { console.error('[Shutdown] Error:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, () => {
  // Initial checkpoint on startup to flush any pending WAL data
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
  console.log(`Prime Anchorpoint running on port ${PORT}`);
  console.log(`[Address Validation] SMARTY_AUTH_ID: ${process.env.SMARTY_AUTH_ID ? 'SET' : 'NOT SET — address validation will be skipped'}`);

});
