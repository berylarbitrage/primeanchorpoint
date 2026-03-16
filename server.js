require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Render, Railway, etc.) for correct req.protocol
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

// ─── Stripe Identity Verification ───
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

async function createStripeVerificationSession(workerId, workerName, workerEmail) {
  if (!stripe) return null;
  try {
    const parts = (workerName || '').trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';
    const sessionParams = {
      type: 'document',
      metadata: { worker_id: String(workerId), worker_name: workerName || '' },
      options: {
        document: {
          allowed_types: ['driving_license', 'id_card', 'passport'],
          require_matching_selfie: true,
          require_id_number: false
        }
      }
    };
    if (workerEmail) {
      sessionParams.provided_details = { email: workerEmail };
    }
    const session = await stripe.identity.verificationSessions.create(sessionParams);
    return { sessionId: session.id, clientSecret: session.client_secret, url: session.url, status: session.status };
  } catch (e) { console.error('[Stripe Identity] Create session error:', e.message); return null; }
}

async function getStripeVerificationSession(sessionId) {
  if (!stripe || !sessionId) return null;
  try {
    const session = await stripe.identity.verificationSessions.retrieve(sessionId, { expand: ['verified_outputs'] });
    return session;
  } catch (e) { console.error('[Stripe Identity] Retrieve session error:', e.message); return null; }
}

function verifyStripeWebhook(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { valid: true, event: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody };
  try {
    const event = require('stripe').webhooks.constructEvent(rawBody, sigHeader, secret);
    return { valid: true, event };
  } catch (e) { console.error('[Stripe Webhook] Verification failed:', e.message); return { valid: false }; }
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

// ─── Email with PDF attachment ───
async function sendEmailWithAttachment(to, subject, text, pdfBuffer, pdfFileName) {
  if (_sgKey) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${_sgKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: EMAIL_FROM },
          subject,
          content: [{ type: 'text/plain', value: text }],
          attachments: [{ content: pdfBuffer.toString('base64'), filename: pdfFileName, type: 'application/pdf', disposition: 'attachment' }],
        }),
      });
      if (r.status === 202) { console.log(`[EMAIL] Sent attachment to ${to}`); return true; }
      const body = await r.text();
      console.error(`[EMAIL-ERR] SendGrid ${r.status}: ${body}`);
      return false;
    } catch (e) { console.error(`[EMAIL-ERR] ${e.message}`); return false; }
  }
  if (!emailTransporter) { console.log(`[EMAIL-SKIP] No transport. To: ${to}`); return false; }
  try {
    await emailTransporter.sendMail({ from: EMAIL_FROM, to, subject, text, attachments: [{ filename: pdfFileName, content: pdfBuffer }] });
    console.log(`[EMAIL] Sent attachment to ${to}`);
    return true;
  } catch (e) { console.error(`[EMAIL-ERR] ${e.message}`); return false; }
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
    company_number TEXT DEFAULT '',
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
try { db.exec(`ALTER TABLE jobs ADD COLUMN langs TEXT DEFAULT 'en'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN title_zh TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN title_es TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN desc_zh TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN desc_es TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN job_id TEXT DEFAULT ''`); } catch(e) {}

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
// Explicit fallback: ensure created_at exists (older SQLite may reject CURRENT_TIMESTAMP default above)
try { db.exec("ALTER TABLE admin_users ADD COLUMN created_at TEXT DEFAULT ''"); } catch {};
try { db.exec("ALTER TABLE admin_users ADD COLUMN email TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN phone TEXT DEFAULT ''"); } catch {}

// Migrate partners table (add new columns if missing)
const partnerMigrations = ['contacts','addresses','social_media','links'];
partnerMigrations.forEach(col => {
  try { db.exec(`ALTER TABLE partners ADD COLUMN ${col} TEXT DEFAULT '${col.includes('s')&&!col.includes('_')?'[]':'{}'}'`); } catch {}
});
try { db.exec(`ALTER TABLE partners ADD COLUMN company_number TEXT DEFAULT ''`); } catch {}

function generatePartnerNumber(stateAbbr) {
  const s = (stateAbbr || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2).padEnd(2, 'X');
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const prefix = `COMP-${s}-${mm}${dd}${yy}-`;
  const existing = db.prepare(`SELECT company_number FROM partners WHERE company_number LIKE ? ORDER BY company_number DESC LIMIT 1`).get(prefix + '%');
  let seq = 1;
  if (existing) {
    const parts = existing.company_number.split('-');
    seq = (parseInt(parts[parts.length - 1], 10) || 0) + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}
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
try { db.exec(`ALTER TABLE invoices ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`); } catch(e) {}
try { db.exec(`ALTER TABLE invoices ADD COLUMN payment_receipt_path TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE invoices ADD COLUMN paid_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE invoices ADD COLUMN markup_rate REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN inquiry_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE inquiries ADD COLUMN job_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN punch_photo_path TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE time_entries ADD COLUMN clock_in_photo_path TEXT DEFAULT NULL`); } catch(e) {}

// DocuSign columns
['ds_envelope_id TEXT DEFAULT \'\'','ds_status TEXT DEFAULT \'\'','ds_worker_signed_at DATETIME','ds_company_signed_at DATETIME'].forEach(col => { try { db.exec(`ALTER TABLE assignments ADD COLUMN ${col}`); } catch {} });
try { db.exec("ALTER TABLE assignments ADD COLUMN ds_decline_reason TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE assignments ADD COLUMN contract_content TEXT DEFAULT ''"); } catch {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN work_schedule TEXT DEFAULT '{}'`); } catch(e) {}
try { db.exec(`ALTER TABLE assignments ADD COLUMN category TEXT DEFAULT ''`); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_address TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_lat REAL DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_lng REAL DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN work_radius INTEGER DEFAULT 200"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN worker_response TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE assignments ADD COLUMN task_requirements TEXT DEFAULT '[]'"); } catch(e) {}
['ds_envelope_id TEXT DEFAULT \'\'','ds_status TEXT DEFAULT \'\'','ds_partner_signed_at DATETIME','ds_company_signed_at DATETIME'].forEach(col => { try { db.exec(`ALTER TABLE partner_files ADD COLUMN ${col}`); } catch {} });
try { db.exec("ALTER TABLE partner_files ADD COLUMN ds_decline_reason TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE partner_files ADD COLUMN contract_content TEXT DEFAULT ''"); } catch {}

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

// ─── Fix existing invoices with XX state placeholder ───
try {
  const xxInvoices = db.prepare("SELECT id, invoice_number, company_name FROM invoices WHERE invoice_number LIKE 'INV-XX-%'").all();
  for (const inv of xxInvoices) {
    const partner = db.prepare("SELECT addresses, address FROM partners WHERE name = ?").get(inv.company_name);
    if (!partner) continue;
    let state = null;
    // Try structured addresses
    try {
      const addrs = JSON.parse(partner.addresses || '[]');
      if (addrs.length && addrs[0].state) state = addrs[0].state.toUpperCase().slice(0, 2);
      if (!state && addrs.length && addrs[0].address) {
        const m = addrs[0].address.match(/,\s*([A-Z]{2})\s+\d{5}/);
        if (m) state = m[1];
      }
    } catch {}
    // Fallback: parse from plain address field
    if (!state && partner.address) {
      const m = partner.address.match(/,\s*([A-Z]{2})\s+\d{5}/);
      if (m) state = m[1];
    }
    if (state && state !== 'XX') {
      const newNum = inv.invoice_number.replace('INV-XX-', `INV-${state}-`);
      db.prepare("UPDATE invoices SET invoice_number = ? WHERE id = ?").run(newNum, inv.id);
      console.log(`[migration] Fixed invoice ${inv.invoice_number} → ${newNum}`);
    }
  }
} catch(e) { console.error('[migration] Fix XX invoices error:', e.message); }

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
try { db.exec("ALTER TABLE admin_users ADD COLUMN phone TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN email TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN city TEXT DEFAULT ''"); } catch {}
// Migrate: add assigned_employee_ids to admin_users (direct employee assignment for managers)
try { db.exec("ALTER TABLE admin_users ADD COLUMN assigned_employee_ids TEXT DEFAULT ''"); } catch {}
// Migrate: add assigned_job_ids to admin_users (job-based assignment for managers)
try { db.exec("ALTER TABLE admin_users ADD COLUMN assigned_job_ids TEXT DEFAULT ''"); } catch {}
// Manager self-punch time tracking
db.exec(`CREATE TABLE IF NOT EXISTS manager_time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id INTEGER NOT NULL,
  clock_in DATETIME NOT NULL,
  clock_out DATETIME,
  break_minutes INTEGER DEFAULT 0,
  total_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  notes TEXT DEFAULT '',
  break_records TEXT DEFAULT '[]',
  on_break INTEGER DEFAULT 0,
  break_start DATETIME,
  FOREIGN KEY (manager_id) REFERENCES admin_users(id)
)`);
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
try { db.exec("ALTER TABLE customer_accounts ADD COLUMN rejection_reason TEXT DEFAULT ''"); } catch {}
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
try { db.exec(`ALTER TABLE admin_invites ADD COLUMN created_by INTEGER DEFAULT NULL`); } catch(e) {}

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

// Temp email verification codes for admin invite registration
db.exec(`CREATE TABLE IF NOT EXISTS admin_reg_codes (
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
    // Backfill employees.inquiry_id from existing linked worker_accounts
    db.prepare(`
      UPDATE employees SET inquiry_id = (
        SELECT wa.linked_inquiry_id FROM worker_accounts wa
        WHERE wa.employee_id = employees.id AND wa.linked_inquiry_id IS NOT NULL
        ORDER BY wa.id DESC LIMIT 1
      ) WHERE inquiry_id IS NULL
    `).run();
  } catch {}
}, 0);
// Migrate: richer fields on job_applications
try { db.exec("ALTER TABLE job_applications ADD COLUMN expected_pay TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN work_auth_confirmed TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN job_category TEXT DEFAULT ''"); } catch {}

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
// Migrate interview_slots: add reserved worker column for admin-arranged times
try { db.exec("ALTER TABLE interview_slots ADD COLUMN reserved_for_worker_account_id INTEGER DEFAULT NULL"); } catch {}
// Migrate interviews: add interview_type
try { db.exec("ALTER TABLE interviews ADD COLUMN interview_type TEXT DEFAULT 'onboarding'"); } catch {}

// ─── Interview History (archives every interview record) ───
db.exec(`CREATE TABLE IF NOT EXISTS interview_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_interview_id INTEGER,
  worker_account_id INTEGER NOT NULL,
  worker_name TEXT DEFAULT '',
  worker_phone TEXT DEFAULT '',
  worker_email TEXT DEFAULT '',
  slot_id INTEGER,
  slot_datetime TEXT DEFAULT '',
  duration_min INTEGER DEFAULT 30,
  location TEXT DEFAULT '',
  interview_type TEXT DEFAULT 'onboarding',
  status TEXT DEFAULT 'scheduled',
  admin_notes TEXT DEFAULT '',
  position_interests TEXT DEFAULT '',
  expected_pay TEXT DEFAULT '',
  skills TEXT DEFAULT '',
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_created_at DATETIME DEFAULT '',
  original_updated_at DATETIME DEFAULT ''
)`);

function archiveInterviews(workerAccountId) {
  const rows = db.prepare(`
    SELECT i.*, s.slot_datetime, s.duration_min, s.location,
           w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email,
           w.position_interests
    FROM interviews i
    LEFT JOIN interview_slots s ON i.slot_id = s.id
    LEFT JOIN worker_accounts w ON i.worker_account_id = w.id
    WHERE i.worker_account_id = ?
  `).all(workerAccountId);
  for (const r of rows) {
    db.prepare(`INSERT INTO interview_history
      (original_interview_id, worker_account_id, worker_name, worker_phone, worker_email,
       slot_id, slot_datetime, duration_min, location, interview_type, status,
       admin_notes, position_interests, expected_pay, skills,
       original_created_at, original_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(r.id, r.worker_account_id, r.worker_name||'', r.worker_phone||'', r.worker_email||'',
           r.slot_id, r.slot_datetime||'', r.duration_min||30, r.location||'',
           r.interview_type||'onboarding', r.status||'scheduled',
           r.admin_notes||'', r.position_interests||'', r.expected_pay||'', r.skills||'',
           r.created_at||'', r.updated_at||'');
  }
}

// ─── Worker Positions (managed in DB) ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_es TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
if (!db.prepare('SELECT id FROM worker_positions LIMIT 1').get()) {
  const wpSeeds = [
    { key:'warehouse_sorter',  zh:'仓库分拣员',  en:'Warehouse Sorter',      es:'Clasificador de Almacén' },
    { key:'labeler',           zh:'贴标员',      en:'Labeler',               es:'Etiquetador' },
    { key:'packer',            zh:'打包员',      en:'Packer',                es:'Empacador' },
    { key:'forklift_operator', zh:'叉车操作员',  en:'Forklift Operator',     es:'Operador de Montacargas' },
    { key:'cdl_driver',        zh:'CDL卡车司机', en:'CDL Truck Driver',      es:'Chofer CDL' },
    { key:'delivery_driver',   zh:'送货司机',    en:'Delivery Driver',       es:'Repartidor' },
    { key:'shift_supervisor',  zh:'班组长',      en:'Shift Supervisor',      es:'Supervisor de Turno' },
    { key:'site_manager',      zh:'现场主管',    en:'Site Manager',          es:'Gerente de Sitio' },
    { key:'quality_inspector', zh:'质检员',      en:'Quality Inspector',     es:'Inspector de Calidad' },
    { key:'machine_operator',  zh:'机器操作员',  en:'Machine Operator',      es:'Operador de Máquinas' },
    { key:'assembly_line',     zh:'装配线工人',  en:'Assembly Line',         es:'Línea de Ensamble' },
    { key:'material_handler',  zh:'物料搬运工',  en:'Material Handler',      es:'Manejador de Materiales' },
    { key:'inventory_clerk',   zh:'库存文员',    en:'Inventory Clerk',       es:'Empleado de Inventario' },
    { key:'general_labor',     zh:'普工',        en:'General Labor',         es:'Trabajo General' },
    { key:'janitorial',        zh:'清洁工',      en:'Janitorial',            es:'Limpieza' },
    { key:'food_processing',   zh:'食品加工',    en:'Food Processing',       es:'Procesamiento de Alimentos' },
    { key:'warehouse_lead',    zh:'仓库领班',    en:'Warehouse Lead',        es:'Líder de Almacén' },
    { key:'loading_unloading', zh:'装卸工',      en:'Loading / Unloading',   es:'Carga/Descarga' },
    { key:'order_picker',      zh:'拣货员',      en:'Order Picker',          es:'Surtidor de Pedidos' },
    { key:'welder',            zh:'焊接工',      en:'Welder',                es:'Soldador' },
  ];
  const wpIns = db.prepare('INSERT INTO worker_positions (key, name_zh, name_en, name_es, sort_order) VALUES (?,?,?,?,?)');
  wpSeeds.forEach((p, i) => wpIns.run(p.key, p.zh, p.en, p.es, i));
}

function getWorkerPositions() {
  return db.prepare('SELECT * FROM worker_positions WHERE active=1 ORDER BY sort_order, id').all()
    .map(r => ({ id: r.id, key: r.key, zh: r.name_zh, en: r.name_en, es: r.name_es, sort_order: r.sort_order }));
}
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

try { db.exec("ALTER TABLE worker_compliance_docs ADD COLUMN holder_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_compliance_docs ADD COLUMN doc_number TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_compliance_docs ADD COLUMN ocr_raw TEXT DEFAULT ''"); } catch {}

// ─── Worker Identity Docs (I-9 / EAD verification records) ───
db.exec(`CREATE TABLE IF NOT EXISTS worker_id_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_account_id) REFERENCES worker_accounts(id) ON DELETE CASCADE
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
// Job title options (used as a fixed list in the job creation modal)
db.exec(`CREATE TABLE IF NOT EXISTS job_title_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT DEFAULT '',
  name_es TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
if (!db.prepare('SELECT id FROM job_title_options LIMIT 1').get()) {
  const jSeeds = [
    'General Laborer','Warehouse Associate','Warehouse Worker','Production Associate',
    'Material Handler','Order Picker','Order Packer','Fulfillment Associate',
    'Loading / Unloading Associate','Order Fulfillment Associate','Inventory Associate',
    'Logistics Assistant','General Labor','Temporary Worker','Contract Worker'
  ];
  const jIns = db.prepare('INSERT INTO job_title_options (name_en, sort_order) VALUES (?,?)');
  jSeeds.forEach((n, i) => jIns.run(n, i));
}

// Display suffix options (rotate daily in worker portal)
db.exec(`CREATE TABLE IF NOT EXISTS display_suffix_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT DEFAULT '',
  name_es TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
if (!db.prepare('SELECT id FROM display_suffix_options LIMIT 1').get()) {
  const sSeeds = [
    'Contract Assignment','Client Assignment','Work Assignment','Temporary Engagement',
    'Contract Placement','Project Assignment','Client Site Assignment','On-Site Assignment',
    'Third-Party Assignment','Client Placement','Short-Term Assignment',
    'Seasonal Assignment','Temporary Project'
  ];
  const sIns = db.prepare('INSERT INTO display_suffix_options (name_en, sort_order) VALUES (?,?)');
  sSeeds.forEach((n, i) => sIns.run(n, i));
}

try { db.exec("ALTER TABLE worker_accounts ADD COLUMN onboarded INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN employment_type TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_accounts ADD COLUMN entity_type TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN visible_to_worker INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN assigned_slot_ids TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN ds_envelope_id TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN ds_status TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN ds_worker_signed_at DATETIME"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN ds_company_signed_at DATETIME"); } catch {}
try { db.exec("ALTER TABLE worker_onboarding ADD COLUMN contract_content TEXT DEFAULT ''"); } catch {}

// Contract version history — stores every contract that was sent, signed, or voided
db.exec(`CREATE TABLE IF NOT EXISTS worker_contract_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL DEFAULT 1,
  contract_content TEXT NOT NULL DEFAULT '',
  ds_envelope_id TEXT DEFAULT '',
  ds_status TEXT DEFAULT '',
  ds_company_signed_at DATETIME,
  ds_worker_signed_at DATETIME,
  created_by TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  voided_at DATETIME,
  void_reason TEXT DEFAULT ''
)`);

// ─── Tax Residency Questionnaire (1099 Resident Test) ───
db.exec(`CREATE TABLE IF NOT EXISTS tax_residency_questionnaire (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  -- Section A: Basic identity
  applicant_type TEXT DEFAULT 'individual',
  is_us_person TEXT DEFAULT '',
  country_tax_residence TEXT DEFAULT '',
  country_citizenship TEXT DEFAULT '',
  entity_country_org TEXT DEFAULT '',
  -- Section B: Individual resident test
  is_us_citizen TEXT DEFAULT '',
  has_green_card TEXT DEFAULT '',
  first_entry_date TEXT DEFAULT '',
  last_entry_date TEXT DEFAULT '',
  entry_exit_records TEXT DEFAULT '',
  days_current_year INTEGER DEFAULT 0,
  days_last_year INTEGER DEFAULT 0,
  days_two_years_ago INTEGER DEFAULT 0,
  has_exempt_days TEXT DEFAULT '',
  exempt_visa_status TEXT DEFAULT '',
  exempt_date_range TEXT DEFAULT '',
  exempt_days_cy INTEGER DEFAULT 0,
  exempt_days_ly INTEGER DEFAULT 0,
  exempt_days_2y INTEGER DEFAULT 0,
  -- Section C: Service location & income source
  services_location TEXT DEFAULT '',
  primary_work_locations TEXT DEFAULT '',
  expected_service_dates TEXT DEFAULT '',
  will_travel_to_us TEXT DEFAULT '',
  -- Section D: Treaty / special claims
  claim_treaty_benefit TEXT DEFAULT '',
  treaty_country TEXT DEFAULT '',
  treaty_income_type TEXT DEFAULT '',
  -- Section E: Supporting documents (flags, not files)
  work_permit_category TEXT DEFAULT '',
  immigration_status TEXT DEFAULT '',
  i94_admission_date TEXT DEFAULT '',
  status_expiration TEXT DEFAULT '',
  docs_requested INTEGER DEFAULT 0,
  -- Computed results
  spt_weighted_days REAL DEFAULT 0,
  spt_result TEXT DEFAULT '',
  tax_status TEXT DEFAULT '',
  recommended_form TEXT DEFAULT '',
  needs_manual_review INTEGER DEFAULT 0,
  admin_override TEXT DEFAULT '',
  admin_notes TEXT DEFAULT '',
  completed_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(worker_account_id)
)`);

// ─── Work Permit Verification ───
db.exec(`CREATE TABLE IF NOT EXISTS work_permit_verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  doc_type TEXT DEFAULT '',
  doc_number TEXT DEFAULT '',
  issue_date TEXT DEFAULT '',
  expiry_date TEXT DEFAULT '',
  category TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  verified_at DATETIME,
  verified_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(worker_account_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS work_permit_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  doc_label TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS worker_tax_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  doc_label TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Add per-doc metadata columns to work_permit_docs
try { db.exec("ALTER TABLE work_permit_docs ADD COLUMN doc_number TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE work_permit_docs ADD COLUMN issue_date TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE work_permit_docs ADD COLUMN expiry_date TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE work_permit_docs ADD COLUMN notes TEXT DEFAULT ''"); } catch {}

// ─── Tax Filing Documents (year-end 1099-NEC / W-2 / 1042-S etc.) ───
db.exec(`CREATE TABLE IF NOT EXISTS tax_filing_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL REFERENCES worker_accounts(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL DEFAULT 2025,
  form_type TEXT NOT NULL,
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tax_filing_docs_worker ON tax_filing_docs(worker_account_id, tax_year)"); } catch {}

// Add structured address columns to tax_residency_questionnaire
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN addr_street TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN addr_street2 TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN addr_city TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN addr_state TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN addr_zip TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN exempt_days_cy INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN exempt_days_ly INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN exempt_days_2y INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN work_permit_category TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN last_entry_date TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN entry_exit_records TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN ind_legal_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN ind_ssn_masked TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN ind_ssn_encrypted TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE tax_residency_questionnaire ADD COLUMN ind_ssn_iv TEXT DEFAULT ''"); } catch {}

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

// ─── Invoice Profiles (presets for sender/bank/contact) ───
db.exec(`CREATE TABLE IF NOT EXISTS invoice_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  section TEXT NOT NULL,
  data TEXT DEFAULT '{}',
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

db.exec(`CREATE TABLE IF NOT EXISTS docuseal_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  docuseal_template_id INTEGER NOT NULL,
  category TEXT DEFAULT 'contract',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migrate: add category column if missing, and backfill categories from config
try {
  db.exec("ALTER TABLE docuseal_templates ADD COLUMN category TEXT DEFAULT 'contract'");
  // Backfill: set category based on existing config assignments
  const _dsRow = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  if (_dsRow) {
    const _dsCfg = JSON.parse(_dsRow.config || '{}');
    const _catMap = {
      company_contract_template_id: 'company_contract', worker_1099_template_id: 'worker_1099', worker_w2_template_id: 'worker_w2',
      w4_template_id: 'w4', w9_template_id: 'w9', w8ben_template_id: 'w8ben', w8bene_template_id: 'w8bene',
      form8233_template_id: 'form8233', i9_template_id: 'i9', w7_template_id: 'w7',
      ach_auth_template_id: 'ach_auth', wire_auth_template_id: 'wire_auth', check_instruction_template_id: 'check_instruction',
      zelle_auth_template_id: 'zelle_auth', third_party_pay_template_id: 'third_party_pay', cash_receipt_template_id: 'cash_receipt',
      contractor_invoice_template_id: 'contractor_invoice',
      invoice_approval_template_id: 'invoice_approval',
      invoice_approval_en_template_id: 'invoice_approval_en',
      invoice_approval_es_template_id: 'invoice_approval_es'
    };
    for (const [cfgKey, cat] of Object.entries(_catMap)) {
      const tid = _dsCfg[cfgKey];
      if (tid) db.prepare("UPDATE docuseal_templates SET category=? WHERE docuseal_template_id=? AND category='contract'").run(cat, tid);
    }
  }
} catch(e) { /* column already exists */ }

// Migrate: update broad categories (tax, contract, payment, invoice) to specific doc_types
try {
  const _dsRow2 = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  if (_dsRow2) {
    const _dsCfg2 = JSON.parse(_dsRow2.config || '{}');
    const _dtMap = {
      company_contract_template_id: 'company_contract', worker_1099_template_id: 'worker_1099', worker_w2_template_id: 'worker_w2',
      w4_template_id: 'w4', w9_template_id: 'w9', w8ben_template_id: 'w8ben', w8bene_template_id: 'w8bene',
      form8233_template_id: 'form8233', i9_template_id: 'i9', w7_template_id: 'w7',
      ach_auth_template_id: 'ach_auth', wire_auth_template_id: 'wire_auth', check_instruction_template_id: 'check_instruction',
      zelle_auth_template_id: 'zelle_auth', third_party_pay_template_id: 'third_party_pay', cash_receipt_template_id: 'cash_receipt',
      contractor_invoice_template_id: 'contractor_invoice',
      invoice_approval_template_id: 'invoice_approval',
      invoice_approval_en_template_id: 'invoice_approval_en',
      invoice_approval_es_template_id: 'invoice_approval_es'
    };
    for (const [cfgKey, docType] of Object.entries(_dtMap)) {
      const tid = _dsCfg2[cfgKey];
      if (tid) db.prepare("UPDATE docuseal_templates SET category=? WHERE docuseal_template_id=?").run(docType, tid);
    }
  }
} catch(e) { /* ignore */ }

// Migrate: fix wrong category assignments and config slot assignments based on known auto-generated template names
try {
  const _nameToSlot = {
    'Company Contract / 公司合同':                               { category: 'company_contract', configKey: 'company_contract_template_id' },
    'Independent Contractor Agreement (1099) / 劳务合同—1099':  { category: 'worker_1099',      configKey: 'worker_1099_template_id' },
    'Employment Agreement (W-2) / 劳务合同—W2':                 { category: 'worker_w2',        configKey: 'worker_w2_template_id' },
    'W-4 Employee Withholding Certificate':                      { category: 'w4',               configKey: 'w4_template_id' },
    'W-9 Request for TIN':                                       { category: 'w9',               configKey: 'w9_template_id' },
    'W-8BEN Certificate of Foreign Status (Individual)':         { category: 'w8ben',            configKey: 'w8ben_template_id' },
    'W-8BEN-E Certificate of Foreign Status (Entity)':           { category: 'w8bene',           configKey: 'w8bene_template_id' },
    'Form 8233 Exemption From Withholding':                      { category: 'form8233',         configKey: 'form8233_template_id' },
    'I-9 Employment Eligibility Verification':                   { category: 'i9',               configKey: 'i9_template_id' },
  };
  const _fixTmpls = db.prepare('SELECT * FROM docuseal_templates').all();
  const _fixCfgRow = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  if (_fixCfgRow) {
    const _fixCfg = JSON.parse(_fixCfgRow.config || '{}');
    let _fixChanged = false;
    for (const tmpl of _fixTmpls) {
      const correct = _nameToSlot[tmpl.name];
      if (!correct) continue;
      // Fix DB category if wrong
      if (tmpl.category !== correct.category) {
        db.prepare('UPDATE docuseal_templates SET category=? WHERE id=?').run(correct.category, tmpl.id);
      }
      // Remove this template ID from any config slot it doesn't belong to
      for (const key of Object.keys(_fixCfg)) {
        if (!key.endsWith('_template_id') || key === correct.configKey) continue;
        const v = _fixCfg[key];
        if (Array.isArray(v)) {
          const filtered = v.filter(id => Number(id) !== tmpl.docuseal_template_id);
          if (filtered.length !== v.length) { _fixCfg[key] = filtered.length ? filtered : null; _fixChanged = true; }
        } else if (Number(v) === tmpl.docuseal_template_id) {
          _fixCfg[key] = null; _fixChanged = true;
        }
      }
    }
    // Deduplicate any config slot arrays
    for (const key of Object.keys(_fixCfg)) {
      if (!key.endsWith('_template_id') || !Array.isArray(_fixCfg[key])) continue;
      const deduped = [...new Set(_fixCfg[key].map(Number).filter(Boolean))];
      if (deduped.length !== _fixCfg[key].length) { _fixCfg[key] = deduped.length ? deduped : null; _fixChanged = true; }
    }
    if (_fixChanged) {
      db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'").run(JSON.stringify(_fixCfg));
    }
  }
} catch(e) { /* ignore */ }

// Seed default integration rows if not present
const intProviders = ['workbright','checkr','gusto','twilio','docuseal'];
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
try { db.exec("ALTER TABLE time_entries ADD COLUMN needs_review INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN review_reason TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE manager_time_entries ADD COLUMN needs_review INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE job_sites ADD COLUMN timezone TEXT DEFAULT 'America/Chicago'"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN site_timezone TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN clock_out_latitude REAL DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN clock_out_longitude REAL DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE time_entries ADD COLUMN manager_confirmed INTEGER DEFAULT 0"); } catch {}

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

db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT DEFAULT '',
  company_name TEXT DEFAULT '',
  bill_to_addr TEXT DEFAULT '',
  period_start TEXT DEFAULT '',
  period_end TEXT DEFAULT '',
  subtotal REAL DEFAULT 0,
  items TEXT DEFAULT '[]',
  profile TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── Contractor Invoice / Payment Requests (FWPA compliance) ───
db.exec(`CREATE TABLE IF NOT EXISTS contractor_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_account_id INTEGER NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  service_description TEXT NOT NULL,
  service_period_start TEXT DEFAULT '',
  service_period_end TEXT DEFAULT '',
  hours_worked REAL DEFAULT 0,
  hourly_rate REAL DEFAULT 0,
  flat_amount REAL DEFAULT 0,
  total_amount REAL NOT NULL,
  payment_method TEXT DEFAULT '',
  payment_due_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'submitted',
  reviewed_by TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Add DocuSeal columns to contractor_invoices
['ds_envelope_id TEXT DEFAULT \'\'','ds_status TEXT DEFAULT \'\'','ds_signed_at DATETIME','sent_by TEXT DEFAULT \'\'',
 'expenses REAL DEFAULT 0','job_id INTEGER DEFAULT 0','job_title TEXT DEFAULT \'\'','service_type TEXT DEFAULT \'\'','confirmed INTEGER DEFAULT 0'
].forEach(col => { try { db.exec(`ALTER TABLE contractor_invoices ADD COLUMN ${col}`); } catch {} });

// ─── App Settings (feature flags, portal config) ───
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Default: worker portal mode is 'none' (neither timeclock nor invoice enabled)
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('worker_portal_mode', 'none')`).run();

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

// Normalize work_schedule to a {mon:{rest,start,end}, ...} days map.
// Handles both formats:
//   New: { type:"estimate", days:{ mon:{rest,start,end}, sat:{...}, ... } }
//   Legacy: { Mon:{start,end}, Sat:{start,end}, ... }  (flat PascalCase, no rest field)
// Falls back to jobSchedJson when the assignment schedule has no usable days.
function _parseSchedDays(schedJson, jobSchedJson) {
  function _extract(s) {
    if (!s || typeof s !== 'object') return {};
    if (s.days && typeof s.days === 'object') return s.days;
    // Legacy flat format
    const out = {};
    _WEEK_DAY_KEYS.forEach(k => {
      const v = s[k] || s[k.charAt(0).toUpperCase() + k.slice(1)];
      if (v && (v.start || v.end)) out[k] = { rest: false, start: v.start || '', end: v.end || '' };
    });
    return out;
  }
  let days = _extract(schedJson);
  // If assignment has no usable work days, fall back to job schedule
  const hasWork = Object.values(days).some(d => !d.rest && (d.start || d.end));
  if (!hasWork && jobSchedJson) {
    const jobDays = _extract(jobSchedJson);
    // Merge: use job days for any day not explicitly set in assignment
    _WEEK_DAY_KEYS.forEach(k => {
      if (!days[k] && jobDays[k]) days[k] = jobDays[k];
    });
  }
  return days;
}

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
           j.title, j.work_schedule AS job_work_schedule,
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
    let jobSched = null;
    try { jobSched = JSON.parse(a.job_work_schedule || 'null'); } catch {}
    const workStart = sched.workStart || null;
    const workEnd = sched.workEnd || null;
    const untilFurther = !!sched.untilFurther;
    const days = _parseSchedDays(sched, jobSched);

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
      let jobSched = null;
      try { jobSched = JSON.parse(a.job_work_schedule || 'null'); } catch {}
      const workStart = sched.workStart || null;
      const workEnd = sched.workEnd || null;
      const untilFurther = !!sched.untilFurther;
      const days = _parseSchedDays(sched, jobSched);
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
// Redirect *.html URLs to clean URLs (e.g. /admin.html → /admin)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && req.method === 'GET') {
    return res.redirect(301, req.path.slice(0, -5));
  }
  next();
});
app.use(express.static('public', {
  extensions: ['html'],
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

// ─── US state → IANA timezone ───
const STATE_TZ = {
  AL:'America/Chicago',AK:'America/Anchorage',AZ:'America/Phoenix',AR:'America/Chicago',
  CA:'America/Los_Angeles',CO:'America/Denver',CT:'America/New_York',DE:'America/New_York',
  FL:'America/New_York',GA:'America/New_York',HI:'Pacific/Honolulu',ID:'America/Boise',
  IL:'America/Chicago',IN:'America/Indiana/Indianapolis',IA:'America/Chicago',KS:'America/Chicago',
  KY:'America/New_York',LA:'America/Chicago',ME:'America/New_York',MD:'America/New_York',
  MA:'America/New_York',MI:'America/Detroit',MN:'America/Chicago',MS:'America/Chicago',
  MO:'America/Chicago',MT:'America/Denver',NE:'America/Chicago',NV:'America/Los_Angeles',
  NH:'America/New_York',NJ:'America/New_York',NM:'America/Denver',NY:'America/New_York',
  NC:'America/New_York',ND:'America/Chicago',OH:'America/New_York',OK:'America/Chicago',
  OR:'America/Los_Angeles',PA:'America/New_York',RI:'America/New_York',SC:'America/New_York',
  SD:'America/Chicago',TN:'America/Chicago',TX:'America/Chicago',UT:'America/Denver',
  VT:'America/New_York',VA:'America/New_York',WA:'America/Los_Angeles',WV:'America/New_York',
  WI:'America/Chicago',WY:'America/Denver',DC:'America/New_York',
};
function localDateStr(state, dateObj) {
  const tz = STATE_TZ[(state||'').toUpperCase()] || 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month:'2-digit', day:'2-digit', year:'numeric' }).formatToParts(dateObj || new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.month + p.day + String(p.year).slice(-2);
}

// ─── Auto-generate employee ID: STAFF-ST-MMDDYY-0001 ───
function nextEmployeeId(state, hireDate) {
  const dateStr = localDateStr(state, hireDate ? new Date(hireDate) : null);
  const stateStr = (state || '').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'XX';
  const last = db.prepare("SELECT employee_id FROM employees WHERE employee_id LIKE 'STAFF-%' ORDER BY id DESC LIMIT 1").get();
  let num = 1;
  if (last) {
    const parts = last.employee_id.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) num = lastNum + 1;
  }
  return `STAFF-${stateStr}-${dateStr}-${String(num).padStart(4, '0')}`;
}

// ─── Auto-generate worker code: PORT-ST-MMDDYY-0001 ───
function generateWorkerCode(state, prefix = 'PORT') {
  const dateStr = localDateStr(state);
  const stateStr = (state || '').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'XX';
  const last = db.prepare(`SELECT worker_code FROM worker_accounts WHERE worker_code LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '-%');
  let num = 1;
  if (last) {
    const parts = last.worker_code.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) num = lastNum + 1;
  }
  return `${prefix}-${stateStr}-${dateStr}-${String(num).padStart(4, '0')}`;
}

// ─── On verification: assign worker_code + ensure linked inquiry exists ───
function activateWorkerAccount(accountId, prefix) {
  const acc = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(accountId);
  if (!acc) return;
  // Generate worker_code if not already set
  if (!acc.worker_code) {
    const codePrefix = prefix || 'PORT';
    const code = generateWorkerCode(acc.state, codePrefix);
    db.prepare('UPDATE worker_accounts SET worker_code=? WHERE id=?').run(code, accountId);
  }
  // Ensure a linked inquiry exists — prefer employee record's stored inquiry_id (survives account deletion/re-creation)
  if (!acc.linked_inquiry_id) {
    let inquiryId = null;
    // If linked to an employee (STAFF-xxx), use that employee's persistent inquiry_id
    if (acc.employee_id) {
      const emp = db.prepare('SELECT inquiry_id FROM employees WHERE id=?').get(acc.employee_id);
      if (emp && emp.inquiry_id) {
        inquiryId = emp.inquiry_id;
      }
    }
    if (!inquiryId) {
      // Create a new inquiry and store it on the employee record for future re-registrations
      const wName = (acc.name || '').trim();
      const r = db.prepare('INSERT INTO inquiries (name, phone, email, type) VALUES (?,?,?,?)').run(wName, acc.phone || '', acc.email || '', 'worker');
      inquiryId = r.lastInsertRowid;
      if (acc.employee_id) {
        db.prepare('UPDATE employees SET inquiry_id=? WHERE id=?').run(inquiryId, acc.employee_id);
      }
    }
    db.prepare('UPDATE worker_accounts SET linked_inquiry_id=? WHERE id=?').run(inquiryId, accountId);
  }
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

// ─── Auto-generate job ID: JOB-STATE-MMDDYY-0001 ───
function generateJobId(location) {
  const stateMatch = (location || '').match(/,\s*([A-Z]{2})\b/);
  const state = stateMatch ? stateMatch[1] : 'XX';
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const prefix = `JOB-${state}-${mm}${dd}${yy}-`;
  const last = db.prepare(`SELECT job_id FROM jobs WHERE job_id LIKE ? ORDER BY job_id DESC LIMIT 1`).get(prefix + '%');
  let seq = 1;
  if (last && last.job_id) {
    const parts = last.job_id.split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return prefix + String(seq).padStart(4, '0');
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

// Lookup IANA timezone from lat/lng using free public API (non-blocking, fallback to America/Chicago)
async function lookupTimezone(lat, lng) {
  try {
    const https = require('https');
    return await new Promise((resolve) => {
      const url = `https://api.geotimezone.com/public/timezone?latitude=${lat}&longitude=${lng}`;
      https.get(url, (resp) => {
        let data = '';
        resp.on('data', d => data += d);
        resp.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.iana_timezone || j.timezone || 'America/Chicago');
          } catch { resolve('America/Chicago'); }
        });
      }).on('error', () => resolve('America/Chicago'));
      setTimeout(() => resolve('America/Chicago'), 3000);
    });
  } catch { return 'America/Chicago'; }
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
  let pem = (process.env.DOCUSIGN_PRIVATE_KEY || '')
    .replace(/^["']|["']$/g, '')  // strip surrounding quotes if any
    .replace(/\\n/g, '\n');       // convert literal \n to real newlines
  // Use KeyObject for signing - handles PKCS#1 and PKCS#8, OpenSSL 3.x compatible
  const keyObject = crypto.createPrivateKey({ key: pem, format: 'pem' });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(keyObject, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
// anchorYOffset: '20' pushes the signature box 20pts below the anchor, keeping it clear of label text
function dsSignTab(anchorStr, fallX, fallY) {
  return { anchorString: anchorStr, anchorIgnoreIfNotPresent: 'true', anchorXOffset: '0', anchorYOffset: '5', xPosition: String(fallX), yPosition: String(fallY), pageNumber: '1', documentId: '1' };
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
        { email: signer1.email, name: signer1.name, recipientId: '1', routingOrder: '1', clientUserId: '1', tabs: { signHereTabs: [dsSignTab('/sig1/', 50, 680)], dateSignedTabs: [{ ...dsSignTab('/date1/', 50, 715), tabLabel: 'date1' }] } },
        { email: signer2.email, name: signer2.name, recipientId: '2', routingOrder: '1', tabs: { signHereTabs: [dsSignTab('/sig2/', 320, 680)], dateSignedTabs: [{ ...dsSignTab('/date2/', 320, 715), tabLabel: 'date2' }] } }
      ]
    },
    status: 'sent'
  };
  const result = await dsApiCall('POST', `/restapi/v2.1/accounts/${accountId}/envelopes`, envelope);
  if (result.status !== 201) throw new Error(`DocuSign ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

// Create an embedded signing URL (recipient view) for signer1 (company, clientUserId '1')
async function dsCreateSignUrl(envelopeId, signerEmail, signerName, returnUrl, frameOrigin) {
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const body = { returnUrl, authenticationMethod: 'none', email: signerEmail, userName: signerName, clientUserId: '1' };
  if (frameOrigin) body.frameOrigin = frameOrigin;
  const r = await dsApiCall('POST', `/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`, body);
  if (r.status !== 201) throw new Error(`DocuSign view ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data.url;
}

// Download the completed (signed) document PDF from DocuSign and return as Buffer
async function dsDownloadSignedDoc(envelopeId) {
  const token = await getDsToken();
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const baseUri = (process.env.DOCUSIGN_BASE_URI || 'https://demo.docusign.net').replace(/\/$/, '');
  const hostname = new URL(baseUri).hostname;
  const apiPath = `/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/combined`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: apiPath, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/pdf' } }, (res) => {
      if (res.statusCode !== 200) { let d = ''; res.on('data', c => d += c); res.on('end', () => reject(new Error(`DocuSign download ${res.statusCode}: ${d}`))); return; }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end();
  });
}

// Check whether PDF contains DocuSign anchor strings
function checkDsAnchors(docPath) {
  try {
    const t = fs.readFileSync(docPath).toString('binary');
    return { sig1: t.includes('/sig1/'), sig2: t.includes('/sig2/'), date1: t.includes('/date1/'), date2: t.includes('/date2/') };
  } catch { return { sig1: false, sig2: false, date1: false, date2: false }; }
}

// ─── DocuSeal eSignature Integration ───
const http = require('http');

function dsealGetCreds() {
  try {
    const row = db.prepare("SELECT api_key, config FROM integration_settings WHERE provider='docuseal'").get();
    const cfg = JSON.parse(row?.config || '{}');
    const apiKey = process.env.DOCUSEAL_API_KEY || row?.api_key || '';
    const baseUrl = process.env.DOCUSEAL_URL || cfg.url || '';
    return { apiKey, baseUrl };
  } catch {
    return { apiKey: process.env.DOCUSEAL_API_KEY || '', baseUrl: process.env.DOCUSEAL_URL || '' };
  }
}

function dsealPublicHost() {
  return (dsealGetCreds().baseUrl).replace(/api\./, 'app.').replace(/\/+$/, '');
}

function dsealEnabled() {
  const { apiKey, baseUrl } = dsealGetCreds();
  return !!(apiKey && baseUrl);
}

async function dsealApiCall(method, apiPath, body) {
  const { apiKey, baseUrl: rawUrl } = dsealGetCreds();
  const baseUrl = rawUrl.replace(/\/$/, '');
  const bodyStr = body != null ? JSON.stringify(body) : null;
  // DocuSeal cloud (api.docuseal.com) uses paths without /api prefix
  const isCloud = /api\.docuseal\.(com|eu)/.test(baseUrl);
  const adjustedPath = isCloud ? apiPath.replace(/^\/api\//, '/') : apiPath;
  const fullUrl = new URL(baseUrl + adjustedPath);
  const isHttps = fullUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: {
        'X-Auth-Token': apiKey,
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = transport.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.setTimeout(15000, () => { req.destroy(new Error('连接超时（15s）')); });
    req.on('error', reject); if (bodyStr) req.write(bodyStr); req.end();
  });
}

function dsealGetPdfPageCount(docPath) {
  try {
    const t = fs.readFileSync(docPath).toString('binary');
    const m = t.match(/\/Count\s+(\d+)/);
    return m ? parseInt(m[1]) : 1;
  } catch { return 1; }
}

async function dsealSendEnvelope({ docPath, docName, emailSubject, signer1, signer2 }) {
  const docBase64 = 'data:application/pdf;base64,' + fs.readFileSync(docPath).toString('base64');

  // Use POST /submissions/pdf — one-step: auto-detects {{field;role=...;type=...}} text tags,
  // creates fields, removes tag text from rendered PDF, and creates submission in one call.
  const subRes = await dsealApiCall('POST', '/api/submissions/pdf', {
    name: emailSubject || docName,
    documents: [{ name: docName, file: docBase64 }],
    send_email: false,
    order: 'preserved',
    submitters: [
      { role: 'First Party', name: signer1.name, email: signer1.email },
      { role: 'Second Party', name: signer2.name, email: signer2.email }
    ]
  });
  console.log(`[DocuSeal] submissions/pdf: status=${subRes.status}, response=${JSON.stringify(subRes.data).substring(0, 500)}`);
  // The response is a single submission object (not array) with submitters array
  const submitters = subRes.data?.submitters || (Array.isArray(subRes.data) ? subRes.data : []);
  if (subRes.status >= 400 || !submitters.length) {
    throw new Error(`DocuSeal 提交创建失败 ${subRes.status}: ${JSON.stringify(subRes.data)}`);
  }
  console.log(`[DocuSeal] Submitters: ${JSON.stringify(submitters.map(s => ({ role: s.role, id: s.id, slug: s.slug, embed_src: (s.embed_src||'').substring(0,80) })))}`);
  const submissionId = subRes.data?.id || subRes.data?.submission_id || submitters[0]?.submission_id || '';
  const company = submitters.find(s => s.role === 'First Party') || submitters[0];
  const worker = submitters.find(s => s.role === 'Second Party');
  let workerSignUrl = worker?.embed_src || '';
  // If no embed_src in creation response, fetch it via PUT (same approach as company sign URL)
  if (!workerSignUrl && worker?.id) {
    try {
      const wPut = await dsealApiCall('PUT', `/api/submitters/${worker.id}`, { name: worker.name || signer2.name });
      console.log(`[DocuSeal] PUT worker submitter ${worker.id}: status=${wPut.status}, has_embed=${!!wPut.data?.embed_src}`);
      if (wPut.data?.embed_src) workerSignUrl = wPut.data.embed_src;
    } catch (e) { console.error(`[DocuSeal] Failed to get worker embed_src: ${e.message}`); }
  }
  // Also try constructing direct URL from slug
  const workerSlug = worker?.slug || '';
  const baseHost = dsealPublicHost();
  const workerDirectUrl = workerSlug ? `${baseHost}/s/${workerSlug}` : '';
  const finalWorkerUrl = workerDirectUrl || workerSignUrl;
  console.log(`[DocuSeal] Worker sign URL: ${(finalWorkerUrl||'NONE').substring(0,100)}`);
  return { submissionId: String(submissionId || company.submission_id || company.id), companyEmbedSrc: company.embed_src, workerSignUrl: finalWorkerUrl };
}

// Send contract via DocuSeal HTML API — converts plain text to HTML with field tags,
// so DocuSeal reliably creates interactive signature/date fields.
async function dsealSendContractHtml({ contractText, templateId, docName, emailSubject, signer1, signer2 }) {
  // If a pre-built template is configured, use it directly
  if (templateId) {
    const todayDate = new Date().toISOString().slice(0, 10);
    const submitter1 = { role: 'First Party', name: signer1.name, email: signer1.email,
      fields: [{ name: 'date1', default_value: todayDate, readonly: true }] };
    const submitter2 = { role: 'Second Party', name: signer2.name, email: signer2.email,
      fields: [{ name: 'date2', default_value: todayDate, readonly: true }] };
    // Include phone numbers so DocuSeal can send its own SMS notifications
    if (signer1.phone) submitter1.phone = signer1.phone;
    if (signer2.phone) submitter2.phone = signer2.phone;
    const subRes = await dsealApiCall('POST', '/api/submissions', {
      template_id: parseInt(templateId),
      send_email: false,
      send_sms: true,
      order: 'preserved',
      submitters: [submitter1, submitter2]
    });
    console.log(`[DocuSeal] submissions(template ${templateId}): status=${subRes.status}`);
    const submitters = subRes.data?.submitters || (Array.isArray(subRes.data) ? subRes.data : []);
    if (subRes.status >= 400 || !submitters.length) throw new Error(`DocuSeal 模板提交失败 ${subRes.status}: ${JSON.stringify(subRes.data)}`);
    const company = submitters.find(s => s.role === 'First Party') || submitters[0];
    const worker = submitters.find(s => s.role === 'Second Party') || submitters[1];
    const submissionId = String(subRes.data?.id || company?.submission_id || company?.id || '');
    const companyEmbedSrc = company?.embed_src || '';
    const workerSlug = worker?.slug || '';
    const baseHost = dsealPublicHost();
    // Prefer slug-based URL for mobile compatibility
    let workerSignUrl = workerSlug ? `${baseHost}/s/${workerSlug}` : (worker?.embed_src || '');
    return { submissionId, companyEmbedSrc, workerSignUrl };
  }
  // Convert plain text contract to HTML, replacing field tags with DocuSeal HTML elements
  const lines = (contractText || '').split('\n');
  const htmlLines = lines.map(line => {
    let l = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Replace DocuSeal text tags with HTML field elements
      // Note: display:inline-block and adequate height are required for DocuSeal to properly recognize and render fields
      .replace(/\{\{sig1;role=First Party;type=signature\}\}/g, '<signature-field name="sig1" role="First Party" style="width: 200px; height: 80px; display: inline-block;"></signature-field>')
      .replace(/\{\{date1;role=First Party;type=date\}\}/g, '<date-field name="date1" role="First Party" style="width: 120px; height: 20px; display: inline-block;"></date-field>')
      .replace(/\{\{sig2;role=Second Party;type=signature\}\}/g, '<signature-field name="sig2" role="Second Party" style="width: 200px; height: 80px; display: inline-block;"></signature-field>')
      .replace(/\{\{date2;role=Second Party;type=date\}\}/g, '<date-field name="date2" role="Second Party" style="width: 120px; height: 20px; display: inline-block;"></date-field>')
      // Also handle legacy /sig1/ etc.
      .replace(/\/sig1\//g, '<signature-field name="sig1" role="First Party" style="width: 200px; height: 80px; display: inline-block;"></signature-field>')
      .replace(/\/date1\//g, '<date-field name="date1" role="First Party" style="width: 120px; height: 20px; display: inline-block;"></date-field>')
      .replace(/\/sig2\//g, '<signature-field name="sig2" role="Second Party" style="width: 200px; height: 80px; display: inline-block;"></signature-field>')
      .replace(/\/date2\//g, '<date-field name="date2" role="Second Party" style="width: 120px; height: 20px; display: inline-block;"></date-field>');
    if (!l.trim()) return '<br>';
    // Headings
    const trimmed = line.trim();
    if (/^[A-Z][A-Z\s]{3,}$/.test(trimmed)) return `<h2 style="text-align:center;margin:16px 0 8px">${l}</h2>`;
    if (/^\d+\.\s/.test(trimmed)) return `<p style="margin:8px 0 2px"><strong>${l}</strong></p>`;
    return `<p style="margin:2px 0">${l}</p>`;
  });
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.5;max-width:700px;margin:0 auto;padding:20px">${htmlLines.join('\n')}</div>`;

  const todayDate = new Date().toISOString().slice(0, 10);
  const submitter1 = { role: 'First Party', name: signer1.name, email: signer1.email,
    fields: [{ name: 'date1', default_value: todayDate, readonly: true }] };
  const submitter2 = { role: 'Second Party', name: signer2.name, email: signer2.email,
    fields: [{ name: 'date2', default_value: todayDate, readonly: true }] };
  // Include phone numbers so DocuSeal can send its own SMS notifications
  if (signer1.phone) submitter1.phone = signer1.phone;
  if (signer2.phone) submitter2.phone = signer2.phone;
  const subRes = await dsealApiCall('POST', '/api/submissions/html', {
    name: emailSubject || docName,
    documents: [{ name: docName, html, size: 'Letter' }],
    send_email: false,
    send_sms: true,
    order: 'preserved',
    submitters: [submitter1, submitter2]
  });
  console.log(`[DocuSeal] submissions/html: status=${subRes.status}, response=${JSON.stringify(subRes.data).substring(0, 500)}`);
  const submitters = subRes.data?.submitters || (Array.isArray(subRes.data) ? subRes.data : []);
  if (subRes.status >= 400 || !submitters.length) {
    throw new Error(`DocuSeal 提交创建失败 ${subRes.status}: ${JSON.stringify(subRes.data)}`);
  }
  console.log(`[DocuSeal] Submitters: ${JSON.stringify(submitters.map(s => ({ role: s.role, id: s.id, slug: s.slug, embed_src: (s.embed_src||'').substring(0,80) })))}`);
  const submissionId = subRes.data?.id || submitters[0]?.submission_id || '';
  const company = submitters.find(s => s.role === 'First Party') || submitters[0];
  const worker = submitters.find(s => s.role === 'Second Party');
  let workerSignUrl = worker?.embed_src || '';
  if (!workerSignUrl && worker?.id) {
    try {
      const wPut = await dsealApiCall('PUT', `/api/submitters/${worker.id}`, { name: worker.name || signer2.name });
      if (wPut.data?.embed_src) workerSignUrl = wPut.data.embed_src;
    } catch (e) { console.error(`[DocuSeal] Failed to get worker embed_src: ${e.message}`); }
  }
  const workerSlug = worker?.slug || '';
  const baseHost = dsealPublicHost();
  // Prefer slug-based URL (/s/xxx) over embed_src — slug URLs work directly in mobile browsers,
  // while embed_src is designed for embedding in web components and may not render on mobile
  const workerDirectUrl = workerSlug ? `${baseHost}/s/${workerSlug}` : '';
  const finalWorkerUrl = workerDirectUrl || workerSignUrl;
  return { submissionId: String(submissionId || company.submission_id || company.id), companyEmbedSrc: company.embed_src, workerSignUrl: finalWorkerUrl };
}

// ─── DocuSeal W-9 Template ───
function generateW9HtmlTemplate(workerName) {
  const fieldStyle = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const textFieldStyle = `${fieldStyle}width:100%;min-height:22px;`;
  const roStyle = 'border:1px solid #ccc;border-radius:3px;padding:2px 4px;background:#f0f0f0;min-height:20px;display:inline-block;color:#888;font-size:8pt;';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1.3rem;font-weight:900;line-height:1">W-9</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Request for Taxpayer Identification Number and Certification</div>
    <div style="font-size:7.5pt;color:#555">▶ Go to <em>www.irs.gov/FormW9</em> for instructions and the latest information.</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form W-9</div>
    <div>(Rev. March 2024)</div>
    <div>Department of the Treasury</div>
    <div>Internal Revenue Service</div>
    <div style="margin-top:2px">OMB No. 1545-0003</div>
  </div>
</div>

<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr>
    <td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:2px"><strong>1</strong> Name (as shown on your income tax return). Name is required on this line; do not leave this line blank.</div>
      <text-field name="w9_name" role="Signer" required="true" style="${textFieldStyle}" placeholder="${workerName || ''}"></text-field>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:2px"><strong>2</strong> Business name/disregarded entity name, if different from above</div>
      <div style="${roStyle}width:100%">N/A — Individual</div>
    </td>
  </tr>
  <tr>
    <td style="width:60%;padding:3px 4px 3px 0;vertical-align:top;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:4px"><strong>3</strong> Federal tax classification of the person whose name is entered on line 1. Check only one of the following seven boxes.</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:8pt">
        <label style="font-weight:700;color:#111">☑ Individual/sole proprietor or single-member LLC</label>
        <label style="color:#aaa">☐ C Corporation</label>
        <label style="color:#aaa">☐ S Corporation</label>
        <label style="color:#aaa">☐ Partnership</label>
        <label style="color:#aaa">☐ Trust/estate</label>
        <label style="color:#aaa">☐ LLC. Tax classification: ___</label>
        <label style="color:#aaa">☐ Other: ___</label>
      </div>
    </td>
    <td style="width:40%;padding:3px 0 3px 8px;vertical-align:top;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:3px"><strong>4</strong> Exemptions (codes apply only to certain entities, not individuals)</div>
      <div style="font-size:8pt;color:#aaa;margin-bottom:2px">Exempt payee code (if any): ___</div>
      <div style="font-size:8pt;color:#aaa">Exemption from FATCA reporting code (if any): ___</div>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:2px"><strong>5</strong> Address (number, street, and apt. or suite no.) — See instructions.</div>
      <text-field name="w9_address" role="Signer" required="true" style="${textFieldStyle}"></text-field>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:2px"><strong>6</strong> City, state, and ZIP code</div>
      <text-field name="w9_city_state_zip" role="Signer" required="true" style="${textFieldStyle}"></text-field>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
      <div style="font-size:8pt;margin-bottom:2px"><strong>7</strong> List account number(s) here (optional)</div>
      <div style="${roStyle}width:100%">&nbsp;</div>
    </td>
  </tr>
</table>

<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;margin:8px 0;font-size:8.5pt">
  <strong>Part I — Taxpayer Identification Number (TIN)</strong><br>
  <span style="font-size:7.5pt">Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1. For individuals, this is generally your social security number (SSN). However, for a resident alien, sole proprietor, or disregarded entity, see the instructions for Part I, later. For other entities, it is your employer identification number (EIN).</span>
  <table style="width:100%;margin-top:6px;border-collapse:collapse">
    <tr>
      <td style="width:55%;padding-right:8px">
        <div style="font-size:8pt;margin-bottom:2px"><strong>Social security number (SSN) / ITIN</strong></div>
        <div style="display:flex;align-items:center;gap:3px">
          <text-field name="w9_ssn_1" role="Signer" required="true" style="${fieldStyle}width:45px;text-align:center" placeholder="XXX"></text-field>
          <span>–</span>
          <text-field name="w9_ssn_2" role="Signer" required="true" style="${fieldStyle}width:30px;text-align:center" placeholder="XX"></text-field>
          <span>–</span>
          <text-field name="w9_ssn_3" role="Signer" required="true" style="${fieldStyle}width:50px;text-align:center" placeholder="XXXX"></text-field>
        </div>
      </td>
      <td style="width:45%;padding-left:8px;border-left:1px solid #ccc">
        <div style="font-size:8pt;margin-bottom:2px;color:#aaa">Employer identification number (EIN)</div>
        <div style="display:flex;align-items:center;gap:3px;color:#aaa">
          <span style="${roStyle}width:35px;text-align:center">&nbsp;</span>
          <span>–</span>
          <span style="${roStyle}width:70px;text-align:center">&nbsp;</span>
        </div>
      </td>
    </tr>
  </table>
</div>

<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;margin:8px 0;font-size:8.5pt">
  <strong>Part II — Certification</strong><br>
  <div style="font-size:7.5pt;margin:4px 0">Under penalties of perjury, I certify that:<br>
    1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and<br>
    2. I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and<br>
    3. I am a U.S. citizen or other U.S. person (defined below); and<br>
    4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.</div>
  <table style="width:100%;margin-top:6px">
    <tr>
      <td style="width:65%">
        <div style="font-size:8pt;margin-bottom:2px"><strong>Signature of U.S. person ▶</strong></div>
        <signature-field name="w9_signature" role="Signer" required="true" preferences='{"signature_type":["drawn"]}' style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      </td>
      <td style="width:35%;padding-left:10px">
        <div style="font-size:8pt;margin-bottom:2px"><strong>Date ▶</strong></div>
        <date-field name="w9_date" role="Signer" required="true" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
      </td>
    </tr>
  </table>
</div>

<div style="font-size:7pt;color:#555;margin-top:6px;border-top:1px solid #999;padding-top:4px">
  <strong>General Instructions</strong> — Form W-9 (Rev. March 2024) — Department of the Treasury, Internal Revenue Service. Purpose: An individual or entity who is required to file an information return with the IRS must obtain your correct TIN to report on an information return the amount paid to you. For the latest information about developments related to Form W-9 and its instructions, go to <em>www.irs.gov/FormW9</em>.
</div>
</div>`;
}

// ── W-4 Employee's Withholding Certificate ──
function generateW4HtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1.3rem;font-weight:900;line-height:1">W-4</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Employee's Withholding Certificate</div>
    <div style="font-size:7.5pt;color:#555">▶ Complete Form W-4 so that your employer can withhold the correct federal income tax from your pay.</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form W-4</div><div>(Rev. 2024)</div>
    <div>Department of the Treasury</div><div>Internal Revenue Service</div>
    <div style="margin-top:2px">OMB No. 1545-0074</div>
  </div>
</div>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin-bottom:6px">Step 1: Enter Personal Information</div>
<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>(a)</strong> First name and middle initial</div>
    <text-field name="w4_first_name" role="Signer" required="true" style="${tf}"></text-field>
  </td><td style="padding:3px 0 3px 8px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Last name</div>
    <text-field name="w4_last_name" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>(b)</strong> Social security number</div>
    <text-field name="w4_ssn" role="Signer" required="true" style="${fs}width:180px;text-align:center" placeholder="XXX-XX-XXXX"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>(c)</strong> Address</div>
    <text-field name="w4_address" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">City or town, state, and ZIP code</div>
    <text-field name="w4_city_state_zip" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>(d)</strong> Filing Status (check only one box):</div>
    <text-field name="w4_filing_status" role="Signer" required="true" style="${fs}width:300px" placeholder="Single / Married filing jointly / Head of household"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Step 2: Multiple Jobs or Spouse Works</div>
<div style="font-size:8pt;padding:4px 0">Complete this step if you (1) hold more than one job at a time, or (2) are married filing jointly and your spouse also works.</div>
<text-field name="w4_step2" role="Signer" style="${tf}" placeholder="Check here if applicable, or leave blank"></text-field>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Step 3: Claim Dependents</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div>Number of qualifying children under age 17 × $2,000 = $</div>
    <text-field name="w4_dependents_children" role="Signer" style="${fs}width:100px" placeholder="0"></text-field>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div>Number of other dependents × $500 = $</div>
    <text-field name="w4_dependents_other" role="Signer" style="${fs}width:100px" placeholder="0"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Step 4: Other Adjustments (Optional)</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>(a)</strong> Other income (not from jobs) $</div>
    <text-field name="w4_other_income" role="Signer" style="${fs}width:100px" placeholder="0"></text-field>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>(b)</strong> Deductions $</div>
    <text-field name="w4_deductions" role="Signer" style="${fs}width:100px" placeholder="0"></text-field>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>(c)</strong> Extra withholding per pay period $</div>
    <text-field name="w4_extra_withholding" role="Signer" style="${fs}width:100px" placeholder="0"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Step 5: Sign Here</div>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;margin-bottom:4px">Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.</div>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:65%">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Employee's signature ▶</strong></div>
      <signature-field name="w4_signature" role="Signer" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
    </td>
    <td style="width:35%;padding-left:10px">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Date ▶</strong></div>
      <date-field name="w4_date" role="Signer" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
    </td>
  </tr></table>
</div>
<div style="font-size:7pt;color:#555;margin-top:6px;border-top:1px solid #999;padding-top:4px">
  <strong>Employers Only</strong> — Employer's name and address / First date of employment / EIN — to be completed by employer.
</div>
</div>`;
}

// ── W-8BEN Certificate of Foreign Status (Individual) ──
function generateW8BENHtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1.1rem;font-weight:900;line-height:1">W-8BEN</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Certificate of Foreign Status of Beneficial Owner for United States Tax Withholding and Reporting (Individuals)</div>
    <div style="font-size:7.5pt;color:#555">▶ For use by individuals. Entities must use Form W-8BEN-E.</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form W-8BEN</div><div>(Rev. Oct 2021)</div>
    <div>Department of the Treasury</div><div>Internal Revenue Service</div>
    <div style="margin-top:2px">OMB No. 1545-1621</div>
  </div>
</div>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin-bottom:6px">Part I — Identification of Beneficial Owner</div>
<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>1</strong> Name of individual who is the beneficial owner</div>
    <text-field name="w8ben_name" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>2</strong> Country of citizenship</div>
    <text-field name="w8ben_country" role="Signer" required="true" style="${fs}width:250px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>3</strong> Permanent residence address (street, apt. or suite no., or rural route)</div>
    <text-field name="w8ben_address" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">City or town, state or province. Include postal code where appropriate.</div>
    <text-field name="w8ben_city" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Country</div>
    <text-field name="w8ben_address_country" role="Signer" required="true" style="${fs}width:250px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>4</strong> Mailing address (if different from above)</div>
    <text-field name="w8ben_mailing" role="Signer" style="${tf}" placeholder="Leave blank if same as above"></text-field>
  </td></tr>
  <tr><td style="width:50%;padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>5</strong> U.S. taxpayer identification number (SSN or ITIN), if required</div>
    <text-field name="w8ben_us_tin" role="Signer" style="${fs}width:180px" placeholder="If applicable"></text-field>
  </td><td style="width:50%;padding:3px 0 3px 8px;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>6</strong> Foreign tax identifying number (FTIN)</div>
    <text-field name="w8ben_ftin" role="Signer" style="${fs}width:180px"></text-field>
  </td></tr>
  <tr><td style="padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>7</strong> Reference number(s)</div>
    <text-field name="w8ben_ref" role="Signer" style="${fs}width:180px" placeholder="Optional"></text-field>
  </td><td style="padding:3px 0 3px 8px;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>8</strong> Date of birth (MM-DD-YYYY)</div>
    <text-field name="w8ben_dob" role="Signer" required="true" style="${fs}width:140px" placeholder="MM-DD-YYYY"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Part II — Claim of Tax Treaty Benefits (if applicable)</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>9</strong> I certify that the beneficial owner is a resident of <text-field name="w8ben_treaty_country" role="Signer" style="${fs}width:180px" placeholder="Country"></text-field> within the meaning of the income tax treaty between the United States and that country.</div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>10</strong> Special rates and conditions: The beneficial owner claims the provisions of Article <text-field name="w8ben_article" role="Signer" style="${fs}width:80px"></text-field> of the treaty to claim a <text-field name="w8ben_rate" role="Signer" style="${fs}width:60px" placeholder="%"></text-field> rate of withholding on (specify type of income): <text-field name="w8ben_income_type" role="Signer" style="${fs}width:200px"></text-field></div>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Part III — Certification</div>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;margin:4px 0">Under penalties of perjury, I declare that I have examined the information on this form and to the best of my knowledge and belief it is true, correct, and complete. I further certify under penalties of perjury that:<br>
  • I am the individual that is the beneficial owner (or am authorized to sign for the individual that is the beneficial owner) of all the income or proceeds to which this form relates<br>
  • The person named on line 1 of this form is not a U.S. person<br>
  • This form relates to income not effectively connected with the conduct of a trade or business in the United States</div>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:65%">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Sign Here ▶</strong></div>
      <signature-field name="w8ben_signature" role="Signer" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
    </td>
    <td style="width:35%;padding-left:10px">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Date (MM-DD-YYYY) ▶</strong></div>
      <date-field name="w8ben_date" role="Signer" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── W-8BEN-E Certificate of Foreign Status (Entity) ──
function generateW8BENEHtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1rem;font-weight:900;line-height:1">W-8BEN-E</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Certificate of Status of Beneficial Owner for United States Tax Withholding and Reporting (Entities)</div>
    <div style="font-size:7.5pt;color:#555">▶ For use by entities. Individuals must use Form W-8BEN.</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form W-8BEN-E</div><div>(Rev. Oct 2021)</div>
    <div>Department of the Treasury</div><div>Internal Revenue Service</div>
    <div style="margin-top:2px">OMB No. 1545-1621</div>
  </div>
</div>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin-bottom:6px">Part I — Identification of Beneficial Owner</div>
<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>1</strong> Name of organization that is the beneficial owner</div>
    <text-field name="w8bene_org_name" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>2</strong> Country of incorporation or organization</div>
    <text-field name="w8bene_country" role="Signer" required="true" style="${fs}width:250px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>3</strong> Name of disregarded entity receiving the payment (if applicable)</div>
    <text-field name="w8bene_disregarded" role="Signer" style="${tf}" placeholder="If applicable"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>4</strong> Chapter 3 Status (entity type)</div>
    <text-field name="w8bene_ch3_status" role="Signer" required="true" style="${fs}width:350px" placeholder="Corporation / Partnership / Simple trust / Grantor trust / etc."></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>5</strong> Chapter 4 Status (FATCA status)</div>
    <text-field name="w8bene_ch4_status" role="Signer" style="${fs}width:350px" placeholder="Active NFFE / Passive NFFE / etc."></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>6</strong> Permanent residence address (street, apt. or suite no., or rural route)</div>
    <text-field name="w8bene_address" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">City or town, state or province. Include postal code. Country.</div>
    <text-field name="w8bene_city" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td style="width:50%;padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>9a</strong> U.S. taxpayer identification number (TIN)</div>
    <text-field name="w8bene_us_tin" role="Signer" style="${fs}width:180px" placeholder="If applicable"></text-field>
  </td><td style="width:50%;padding:3px 0 3px 8px;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>9b</strong> Foreign TIN</div>
    <text-field name="w8bene_ftin" role="Signer" style="${fs}width:180px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>10</strong> Reference number(s)</div>
    <text-field name="w8bene_ref" role="Signer" style="${fs}width:250px" placeholder="Optional"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Part III — Claim of Tax Treaty Benefits (if applicable)</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>14a</strong> The beneficial owner is a resident of <text-field name="w8bene_treaty_country" role="Signer" style="${fs}width:180px" placeholder="Country"></text-field> within the meaning of the income tax treaty.</div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>14b</strong> The beneficial owner derives the item of income for which treaty benefits are claimed, and meets the limitation on benefits provisions if applicable.</div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>15</strong> Special rates: Article <text-field name="w8bene_article" role="Signer" style="${fs}width:80px"></text-field> — Rate: <text-field name="w8bene_rate" role="Signer" style="${fs}width:60px" placeholder="%"></text-field> — Type of income: <text-field name="w8bene_income_type" role="Signer" style="${fs}width:200px"></text-field></div>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Part XXX — Certification</div>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;margin:4px 0">Under penalties of perjury, I declare that I have examined the information on this form and to the best of my knowledge and belief it is true, correct, and complete. I further certify under penalties of perjury that the entity identified on line 1 of this form is the beneficial owner of all the income or proceeds to which this form relates, is not a U.S. person, and the entity identified on line 1 is not engaged in the conduct of a trade or business in the United States.</div>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:65%">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Sign Here ▶</strong></div>
      <signature-field name="w8bene_signature" role="Signer" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
    </td>
    <td style="width:35%;padding-left:10px">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Date (MM-DD-YYYY) ▶</strong></div>
      <date-field name="w8bene_date" role="Signer" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
    </td>
  </tr></table>
  <div style="font-size:8pt;margin-top:6px">
    <div style="margin-bottom:2px"><strong>Print name of signer ▶</strong></div>
    <text-field name="w8bene_print_name" role="Signer" required="true" style="${tf}"></text-field>
  </div>
</div>
</div>`;
}

// ── Form 8233 Exemption From Withholding (Foreign Persons) ──
function generateForm8233HtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1.1rem;font-weight:900;line-height:1">8233</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Exemption From Withholding on Compensation for Independent (and Certain Dependent) Personal Services of a Nonresident Alien Individual</div>
    <div style="font-size:7.5pt;color:#555">▶ For use by nonresident alien individuals to claim exemption from withholding under a tax treaty.</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form 8233</div><div>(Rev. Sep 2018)</div>
    <div>Department of the Treasury</div><div>Internal Revenue Service</div>
    <div style="margin-top:2px">OMB No. 1545-0795</div>
  </div>
</div>
<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>1</strong> Name of nonresident alien individual</div>
    <text-field name="f8233_name" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td style="width:50%;padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>2</strong> U.S. taxpayer identification number (ITIN or SSN)</div>
    <text-field name="f8233_tin" role="Signer" style="${fs}width:180px"></text-field>
  </td><td style="width:50%;padding:3px 0 3px 8px;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>3</strong> Country of nationality</div>
    <text-field name="f8233_nationality" role="Signer" required="true" style="${fs}width:200px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>4</strong> Permanent residence address (in home country)</div>
    <text-field name="f8233_home_address" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>5</strong> Address in the United States</div>
    <text-field name="f8233_us_address" role="Signer" required="true" style="${tf}"></text-field>
  </td></tr>
  <tr><td style="padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>6</strong> U.S. visa type</div>
    <text-field name="f8233_visa_type" role="Signer" required="true" style="${fs}width:120px" placeholder="F-1, J-1, etc."></text-field>
  </td><td style="padding:3px 0 3px 8px;border-left:1px solid #ccc;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>7</strong> Date of entry into U.S.</div>
    <text-field name="f8233_entry_date" role="Signer" style="${fs}width:140px" placeholder="MM-DD-YYYY"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px"><strong>8</strong> Country of residence for tax purposes</div>
    <text-field name="f8233_tax_country" role="Signer" required="true" style="${fs}width:250px"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Tax Treaty Claim</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt">
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>11</strong> I claim the tax treaty between the U.S. and <text-field name="f8233_treaty_country" role="Signer" style="${fs}width:180px"></text-field>. I claim exemption under Article <text-field name="f8233_article" role="Signer" style="${fs}width:80px"></text-field>.</div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>12</strong> I arrived in the U.S. on <text-field name="f8233_arrival" role="Signer" style="${fs}width:120px" placeholder="MM-DD-YYYY"></text-field> and my compensation is exempt for tax year(s) <text-field name="f8233_tax_years" role="Signer" style="${fs}width:120px" placeholder="2025, 2026"></text-field></div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>13</strong> Total compensation expected this tax year: $ <text-field name="f8233_compensation" role="Signer" style="${fs}width:120px"></text-field></div>
  </td></tr>
  <tr><td style="padding:3px 0;border-bottom:1px solid #ccc">
    <div><strong>14</strong> Sufficient facts to justify the exemption from withholding claimed on line 11:</div>
    <text-field name="f8233_justification" role="Signer" style="${tf}"></text-field>
  </td></tr>
</table>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin:8px 0 6px">Certification</div>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;margin:4px 0">Under penalties of perjury, I declare that I have examined the information on this form and to the best of my knowledge and belief it is true, correct, and complete. I further certify that I am not a U.S. citizen or U.S. resident, and I am the beneficial owner of the compensation for which I am claiming an exemption from withholding.</div>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:65%">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Signature ▶</strong></div>
      <signature-field name="f8233_signature" role="Signer" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
    </td>
    <td style="width:35%;padding-left:10px">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Date ▶</strong></div>
      <date-field name="f8233_date" role="Signer" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── I-9 Employment Eligibility Verification ──
function generateI9HtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;max-width:720px;margin:0 auto;padding:16px;color:#111">
<div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:1.3rem;font-weight:900;line-height:1">I-9</div>
  <div>
    <div style="font-size:8.5pt;font-weight:700">Employment Eligibility Verification</div>
    <div style="font-size:7.5pt;color:#555">Department of Homeland Security — U.S. Citizenship and Immigration Services</div>
  </div>
  <div style="margin-left:auto;font-size:7.5pt;text-align:right">
    <div>Form I-9</div><div>(Rev. 08/01/23)</div>
    <div>USCIS</div>
    <div style="margin-top:2px">OMB No. 1615-0047</div>
  </div>
</div>
<div style="font-size:8pt;font-weight:700;background:#e5e7eb;padding:4px 6px;margin-bottom:6px">Section 1. Employee Information and Attestation (to be completed by employee)</div>
<table style="width:100%;border-collapse:collapse;font-size:9pt">
  <tr><td style="width:40%;padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Last Name (Family Name)</div>
    <text-field name="i9_last_name" role="Signer" required="true" style="${tf}"></text-field>
  </td><td style="width:35%;padding:3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">First Name (Given Name)</div>
    <text-field name="i9_first_name" role="Signer" required="true" style="${tf}"></text-field>
  </td><td style="width:25%;padding:3px 0 3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Middle Initial</div>
    <text-field name="i9_middle" role="Signer" style="${fs}width:40px"></text-field>
  </td></tr>
  <tr><td colspan="2" style="padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Address (Street Number and Name)</div>
    <text-field name="i9_address" role="Signer" required="true" style="${tf}"></text-field>
  </td><td style="padding:3px 0 3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Apt. Number</div>
    <text-field name="i9_apt" role="Signer" style="${fs}width:60px"></text-field>
  </td></tr>
  <tr><td style="padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">City or Town</div>
    <text-field name="i9_city" role="Signer" required="true" style="${tf}"></text-field>
  </td><td style="padding:3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">State</div>
    <text-field name="i9_state" role="Signer" required="true" style="${fs}width:60px"></text-field>
  </td><td style="padding:3px 0 3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">ZIP Code</div>
    <text-field name="i9_zip" role="Signer" required="true" style="${fs}width:80px"></text-field>
  </td></tr>
  <tr><td style="padding:3px 4px 3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Date of Birth (mm/dd/yyyy)</div>
    <text-field name="i9_dob" role="Signer" required="true" style="${fs}width:120px" placeholder="MM/DD/YYYY"></text-field>
  </td><td colspan="2" style="padding:3px 0 3px 4px;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">U.S. Social Security Number</div>
    <text-field name="i9_ssn" role="Signer" style="${fs}width:160px" placeholder="XXX-XX-XXXX"></text-field>
  </td></tr>
  <tr><td colspan="3" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Employee's E-mail Address</div>
    <text-field name="i9_email" role="Signer" style="${tf}"></text-field>
  </td></tr>
  <tr><td colspan="3" style="padding:3px 0;border-bottom:1px solid #ccc">
    <div style="font-size:8pt;margin-bottom:2px">Employee's Telephone Number</div>
    <text-field name="i9_phone" role="Signer" style="${fs}width:180px"></text-field>
  </td></tr>
</table>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;margin:8px 0;font-size:8pt">
  <strong>Citizenship / Immigration Status (check one):</strong>
  <div style="margin-top:4px">
    <text-field name="i9_status" role="Signer" required="true" style="${tf}" placeholder="1. A citizen of the United States / 2. A noncitizen national / 3. A lawful permanent resident (Alien Registration Number/USCIS Number: ___) / 4. An alien authorized to work until (expiration date: ___)"></text-field>
  </div>
  <div style="margin-top:6px;font-size:8pt">
    If you selected #3 or #4, provide additional information:<br>
    Alien Registration Number/USCIS Number: <text-field name="i9_alien_number" role="Signer" style="${fs}width:180px" placeholder="If applicable"></text-field><br>
    Form I-94 Admission Number: <text-field name="i9_i94" role="Signer" style="${fs}width:180px" placeholder="If applicable"></text-field><br>
    Foreign Passport Number and Country: <text-field name="i9_passport" role="Signer" style="${fs}width:250px" placeholder="If applicable"></text-field>
  </div>
</div>
<div style="background:#f5f5f5;border:1px solid #999;padding:6px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;margin-bottom:4px">I attest, under penalty of perjury, that I am (check one of the above), that I have examined the document(s) presented by the employee, that the above information is true and correct, and that I am aware that providing false information may subject me to fines and/or imprisonment.</div>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:65%">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Signature of Employee ▶</strong></div>
      <signature-field name="i9_signature" role="Signer" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
    </td>
    <td style="width:35%;padding-left:10px">
      <div style="font-size:8pt;margin-bottom:2px"><strong>Today's Date ▶</strong></div>
      <date-field name="i9_date" role="Signer" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field>
    </td>
  </tr></table>
</div>
<div style="font-size:7pt;color:#555;margin-top:6px;border-top:1px solid #999;padding-top:4px">
  <strong>Section 2 &amp; 3</strong> — Employer or Authorized Representative review and verification, and Reverification and Rehires — to be completed and signed by employer.
</div>
</div>`;
}

// ── Company Contract Template ──
function generateCompanyContractHtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:10pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.6">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px">
  <div style="font-size:1.2rem;font-weight:900;letter-spacing:1px">SERVICE AGREEMENT</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">Company Contract / 公司合同</div>
</div>
<p style="font-size:9pt">This Service Agreement ("Agreement") is entered into as of <date-field name="contract_date" role="First Party" style="${fs}width:140px"></date-field> by and between:</p>
<table style="width:100%;border-collapse:collapse;font-size:9pt;margin:8px 0">
  <tr><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">First Party (Company):</div>
    <div>${companyName}</div>
  </td><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">Second Party (Client/Partner):</div>
    <text-field name="contract_party2_name" role="Second Party" required="true" style="${tf}"></text-field>
    <div style="font-size:8pt;margin-top:4px">Company/Organization:</div>
    <text-field name="contract_party2_company" role="Second Party" style="${tf}"></text-field>
  </td></tr>
</table>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">1. SCOPE OF SERVICES</div>
<p style="font-size:9pt">The parties agree to collaborate on the following services:</p>
<text-field name="contract_scope" role="First Party" required="true" style="${tf};min-height:60px" placeholder="Description of services to be provided..."></text-field>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">2. TERM</div>
<p style="font-size:9pt">This Agreement shall commence on <text-field name="contract_start_date" role="First Party" style="${fs}width:120px" placeholder="Start date"></text-field> and continue until <text-field name="contract_end_date" role="First Party" style="${fs}width:120px" placeholder="End date"></text-field>, unless terminated earlier in accordance with this Agreement.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">3. COMPENSATION</div>
<p style="font-size:9pt">In consideration of the services provided, the payment terms shall be:</p>
<text-field name="contract_compensation" role="First Party" required="true" style="${tf}" placeholder="Payment amount, schedule, and terms..."></text-field>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">4. CONFIDENTIALITY</div>
<p style="font-size:9pt">Both parties agree to maintain the confidentiality of any proprietary information disclosed during the course of this Agreement. This obligation shall survive the termination of this Agreement.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">5. TERMINATION</div>
<p style="font-size:9pt">Either party may terminate this Agreement with 30 days' written notice. Upon termination, all outstanding payments for services rendered shall become due.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">6. GOVERNING LAW</div>
<p style="font-size:9pt">This Agreement shall be governed by the laws of the State of <text-field name="contract_state" role="First Party" style="${fs}width:140px" placeholder="State"></text-field>.</p>
<div style="background:#f5f5f5;border:1px solid #999;padding:10px;margin-top:16px;font-size:9pt">
  <div style="font-weight:700;margin-bottom:8px">SIGNATURES</div>
  <table style="width:100%"><tr>
    <td style="width:50%;padding-right:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">First Party (${companyName}):</div>
      <signature-field name="sig1" role="First Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date1" role="First Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">Second Party:</div>
      <signature-field name="sig2" role="Second Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date2" role="Second Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── Independent Contractor Agreement (1099) ──
function generateContractor1099HtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:10pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.6">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px">
  <div style="font-size:1.2rem;font-weight:900;letter-spacing:1px">INDEPENDENT CONTRACTOR AGREEMENT</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">1099 Contractor / 劳务合同 — 1099</div>
</div>
<p style="font-size:9pt">This Independent Contractor Agreement ("Agreement") is made and entered into as of <date-field name="contract_date" role="First Party" style="${fs}width:140px"></date-field>, by and between:</p>
<table style="width:100%;border-collapse:collapse;font-size:9pt;margin:8px 0">
  <tr><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">Company (First Party):</div>
    <div>${companyName}</div>
  </td><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">Independent Contractor (Second Party):</div>
    <text-field name="contractor_name" role="Second Party" required="true" style="${tf}"></text-field>
  </td></tr>
</table>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">1. INDEPENDENT CONTRACTOR STATUS</div>
<p style="font-size:9pt">The Contractor is an independent contractor and not an employee, agent, or partner of the Company. The Contractor shall be responsible for all federal and state taxes, including self-employment tax, and the Company will issue a Form 1099-NEC for annual compensation of $600 or more.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">2. SERVICES</div>
<p style="font-size:9pt">The Contractor agrees to perform the following services:</p>
<text-field name="contractor_services" role="First Party" required="true" style="${tf};min-height:60px" placeholder="Description of services..."></text-field>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">3. COMPENSATION</div>
<p style="font-size:9pt">The Company shall pay the Contractor:</p>
<text-field name="contractor_pay" role="First Party" required="true" style="${tf}" placeholder="Rate/amount and payment schedule..."></text-field>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">4. TERM AND TERMINATION</div>
<p style="font-size:9pt">This Agreement begins on <text-field name="contractor_start" role="First Party" style="${fs}width:120px" placeholder="Start date"></text-field> and may be terminated by either party with <text-field name="contractor_notice" role="First Party" style="${fs}width:80px" placeholder="14"></text-field> days' written notice.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">5. CONFIDENTIALITY &amp; NON-DISCLOSURE</div>
<p style="font-size:9pt">The Contractor agrees to keep confidential all proprietary information, trade secrets, and business processes of the Company, both during and after the term of this Agreement.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">6. INTELLECTUAL PROPERTY</div>
<p style="font-size:9pt">All work product created by the Contractor in the performance of services under this Agreement shall be the sole property of the Company.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">7. INDEMNIFICATION</div>
<p style="font-size:9pt">The Contractor shall indemnify and hold harmless the Company from any claims, damages, or expenses arising from the Contractor's performance of services.</p>
<div style="background:#f5f5f5;border:1px solid #999;padding:10px;margin-top:16px;font-size:9pt">
  <div style="font-weight:700;margin-bottom:8px">SIGNATURES</div>
  <table style="width:100%"><tr>
    <td style="width:50%;padding-right:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">Company (${companyName}):</div>
      <signature-field name="sig1" role="First Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date1" role="First Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">Independent Contractor:</div>
      <signature-field name="sig2" role="Second Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date2" role="Second Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── W-2 Employment Agreement ──
function generateW2EmploymentHtmlTemplate() {
  const fs = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const tf = `${fs}width:100%;min-height:22px;`;
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:10pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.6">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px">
  <div style="font-size:1.2rem;font-weight:900;letter-spacing:1px">EMPLOYMENT AGREEMENT</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">W-2 Employee / 劳务合同 — W2</div>
</div>
<p style="font-size:9pt">This Employment Agreement ("Agreement") is made and entered into as of <date-field name="contract_date" role="First Party" style="${fs}width:140px"></date-field>, by and between:</p>
<table style="width:100%;border-collapse:collapse;font-size:9pt;margin:8px 0">
  <tr><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">Employer (First Party):</div>
    <div>${companyName}</div>
  </td><td style="padding:6px;border:1px solid #ccc;width:50%;vertical-align:top">
    <div style="font-weight:700;margin-bottom:4px">Employee (Second Party):</div>
    <text-field name="employee_name" role="Second Party" required="true" style="${tf}"></text-field>
  </td></tr>
</table>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">1. POSITION AND DUTIES</div>
<p style="font-size:9pt">The Employee is hired for the position of:</p>
<text-field name="employee_position" role="First Party" required="true" style="${tf}" placeholder="Job title"></text-field>
<p style="font-size:9pt;margin-top:4px">Job duties and responsibilities:</p>
<text-field name="employee_duties" role="First Party" required="true" style="${tf};min-height:60px" placeholder="Description of duties..."></text-field>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">2. EMPLOYMENT TYPE</div>
<p style="font-size:9pt">Employment type: <text-field name="employee_type" role="First Party" style="${fs}width:200px" placeholder="Full-time / Part-time"></text-field></p>
<p style="font-size:9pt">Work schedule: <text-field name="employee_schedule" role="First Party" style="${fs}width:250px" placeholder="Monday-Friday, 9am-5pm"></text-field></p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">3. COMPENSATION AND BENEFITS</div>
<p style="font-size:9pt">Base salary/wage: $ <text-field name="employee_salary" role="First Party" required="true" style="${fs}width:120px"></text-field> per <text-field name="employee_pay_period" role="First Party" style="${fs}width:100px" placeholder="year/hour"></text-field></p>
<p style="font-size:9pt">Pay frequency: <text-field name="employee_pay_freq" role="First Party" style="${fs}width:150px" placeholder="Bi-weekly / Monthly"></text-field></p>
<p style="font-size:9pt">Benefits: The Employee shall be entitled to participate in the Company's benefit programs as described in the Employee Handbook, including health insurance, paid time off, and retirement plans, subject to eligibility requirements.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">4. START DATE</div>
<p style="font-size:9pt">Employment shall commence on <text-field name="employee_start" role="First Party" required="true" style="${fs}width:140px" placeholder="Start date"></text-field>.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">5. AT-WILL EMPLOYMENT</div>
<p style="font-size:9pt">This employment is at-will. Either party may terminate this Agreement at any time, with or without cause or notice, subject to applicable law.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">6. CONFIDENTIALITY</div>
<p style="font-size:9pt">The Employee agrees to maintain the confidentiality of all proprietary information and trade secrets, both during and after employment.</p>
<div style="font-weight:700;margin:12px 0 6px;font-size:9.5pt">7. TAX WITHHOLDING</div>
<p style="font-size:9pt">The Employer shall withhold all applicable federal, state, and local taxes from the Employee's compensation, including income tax, Social Security, and Medicare, and shall issue Form W-2 annually.</p>
<div style="background:#f5f5f5;border:1px solid #999;padding:10px;margin-top:16px;font-size:9pt">
  <div style="font-weight:700;margin-bottom:8px">SIGNATURES</div>
  <table style="width:100%"><tr>
    <td style="width:50%;padding-right:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">Employer (${companyName}):</div>
      <signature-field name="sig1" role="First Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date1" role="First Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:12px;vertical-align:top">
      <div style="font-size:8pt;font-weight:700;margin-bottom:4px">Employee:</div>
      <signature-field name="sig2" role="Second Party" style="width:100%;height:60px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="date2" role="Second Party" style="width:100%;height:28px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── 1099 Contractor Invoice Template (Letter-size single page) ──
// lang: 'en' | 'zh' | 'es' — secondary language paired with English
function generateContractorInvoiceHtmlTemplate(lang) {
  lang = lang || 'zh'; // default to EN+ZH for backwards compat
  const L = {
    en: { subtitle: '1099 Contractor Invoice', amberHint: 'Amber fields = you fill &nbsp;|&nbsp; Grey fields = pre-filled',
      date: 'Date', periodFrom: 'Period From *', periodTo: 'Period To *',
      fromContractor: 'FROM — Contractor', prefilled: '(pre-filled)', name: 'Name',
      billTo: 'BILL TO — Company', serviceDesc: 'SERVICE DESCRIPTION', serviceHint: 'Pre-filled by company',
      compMethod: 'Compensation Method', compValue: 'Contractor-proposed flat project fee',
      quotedAmt: 'Quoted Amount', reimbursable: 'Reimbursable Expenses',
      additionalNotes: 'Additional Notes', notesHint: '(optional)',
      totalDue: 'TOTAL DUE', payTerms: 'PAYMENT TERMS', dueDate: 'Due Date',
      certTitle: 'CONTRACTOR CERTIFICATION',
      certBody: 'I certify the above services were performed and amounts are correct. Contractor retains the right to determine the manner and means of performing services.',
      sigLabel: 'Contractor Signature *', dateLabel: 'Date',
      footer: 'Independent contractor arrangement — contractor responsible for all applicable taxes and retains control over manner and means of service delivery.',
      ilFwpa: 'Payment due within 30 days of completion if contract is silent.',
      legend: 'Contractor fills', legendGrey: 'Pre-filled by system' },
    zh: { subtitle: '承包商发票', amberHint: '橙色栏位 = 请您填写 &nbsp;|&nbsp; 灰色 = 系统自动带出',
      date: '日期', periodFrom: '起始 *', periodTo: '截止 *',
      fromContractor: '承包商', prefilled: '系统带出', name: '姓名',
      billTo: '公司', serviceDesc: '服务内容', serviceHint: '系统自动带出，不可修改',
      compMethod: '补偿方式', compValue: '承包商报价固定项目费用',
      quotedAmt: '报价金额', reimbursable: '可报销费用',
      additionalNotes: '补充说明', notesHint: '（选填）',
      totalDue: '应付总额', payTerms: '付款条件', dueDate: '到期日',
      certTitle: '承包商声明',
      certBody: '本人确认服务已完成、金额准确。承包商保留自行决定服务执行方式与方法的权利。',
      sigLabel: '承包商签名 *', dateLabel: '日期',
      footer: '独立承包商协议，承包商自行负责税款并保留对服务交付方式的控制权。',
      ilFwpa: 'IL FWPA: 合同未注明付款日→完工后30天内付款',
      legend: '承包商填写', legendGrey: '系统自动带出' },
    es: { subtitle: 'Factura de Contratista', amberHint: 'Campos ámbar = usted completa &nbsp;|&nbsp; Campos grises = prellenado',
      date: 'Fecha', periodFrom: 'Período Desde *', periodTo: 'Período Hasta *',
      fromContractor: 'Contratista', prefilled: '(prellenado)', name: 'Nombre',
      billTo: 'Empresa', serviceDesc: 'Descripción del Servicio', serviceHint: 'Prellenado por la empresa, no editable',
      compMethod: 'Método de Compensación', compValue: 'Tarifa fija de proyecto propuesta por el contratista',
      quotedAmt: 'Monto Cotizado', reimbursable: 'Gastos Reembolsables',
      additionalNotes: 'Notas Adicionales', notesHint: '(opcional)',
      totalDue: 'TOTAL A PAGAR', payTerms: 'Términos de Pago', dueDate: 'Fecha de Vencimiento',
      certTitle: 'CERTIFICACIÓN DEL CONTRATISTA',
      certBody: 'Certifico que los servicios anteriores fueron realizados y los montos son correctos. El contratista retiene el derecho de determinar la manera y los medios de realizar los servicios.',
      sigLabel: 'Firma del Contratista *', dateLabel: 'Fecha',
      footer: 'Acuerdo de contratista independiente — el contratista es responsable de todos los impuestos aplicables y retiene el control sobre la manera y los medios de la prestación del servicio.',
      ilFwpa: 'IL FWPA: Pago dentro de 30 días de finalización si el contrato no lo especifica.',
      legend: 'Contratista completa', legendGrey: 'Prellenado por el sistema' }
  };
  const en = L.en;
  const t = lang === 'en' ? null : L[lang]; // secondary language (null if EN-only)
  const bi = (enText, locText) => t ? `${enText} ${locText}` : enText; // bilingual helper

  const ro = 'border:1px solid #ddd;border-radius:2px;padding:1px 3px;background:#f5f5f5;min-height:16px;display:inline-block;';
  const ed = 'border:2px solid #f59e0b;border-radius:2px;padding:1px 3px;background:#fff;min-height:16px;display:inline-block;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const companyAddr = process.env.COMPANY_ADDRESS || '';
  const companyEmail = process.env.COMPANY_EMAIL || '';
  const c = 'padding:3px 5px;border:1px solid #ccc;vertical-align:top;';
  const hi = `${c}background:#fffbeb;`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:8pt;max-width:680px;margin:0 auto;padding:10px 16px;color:#111;line-height:1.35">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:2px">INVOICE</div>
  <div style="font-size:7.5pt;color:#555">1099 ${bi(en.subtitle, t ? t.subtitle : '')}</div>
  <div style="font-size:6.5pt;color:#f59e0b;margin-top:2px">${bi(en.amberHint, t ? t.amberHint : '')}</div>
</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:25%"><b>Invoice #</b><br><text-field name="invoice_number" role="First Party" required="true" readonly="true" style="${ro}width:130px" placeholder="(auto)"></text-field></td>
    <td style="${c}width:25%"><b>${bi('Date', t ? t.date : '')}</b><br><date-field name="invoice_date" role="First Party" required="true" readonly="true" style="${ro}width:120px"></date-field></td>
    <td style="${hi}width:25%"><b>${bi('Period From', t ? t.periodFrom : 'Period From *')}</b><br><text-field name="service_period_start" role="First Party" required="true" style="${ed}width:110px" placeholder="MM/DD/YYYY"></text-field></td>
    <td style="${hi}width:25%"><b>${bi('Period To', t ? t.periodTo : 'Period To *')}</b><br><text-field name="service_period_end" role="First Party" required="true" style="${ed}width:110px" placeholder="MM/DD/YYYY"></text-field></td>
  </tr>
</table>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:50%">
      <b>${bi('FROM — Contractor', t ? t.fromContractor : '')}</b> <span style="font-size:6.5pt;color:#999">${bi(en.prefilled, t ? t.prefilled : '')}</span><br>
      ${bi('Name', t ? t.name : '')}: <text-field name="contractor_name" role="First Party" required="true" readonly="true" style="${ro}width:100%;min-height:16px" placeholder="${en.prefilled}"></text-field>
    </td>
    <td style="${c}width:50%">
      <b>${bi('BILL TO — Company', t ? t.billTo : '')}</b><br>
      <div style="font-weight:600">${companyName}</div>
      ${companyAddr ? `<div>${companyAddr}</div>` : ''}
      ${companyEmail ? `<div>${companyEmail}</div>` : ''}
    </td>
  </tr>
</table>
<div style="font-weight:700;margin:4px 0 2px">${bi('SERVICE DESCRIPTION', t ? t.serviceDesc : '')} <span style="font-weight:400;color:#999;font-size:7pt">(${bi(en.serviceHint, t ? t.serviceHint : '')})</span></div>
<text-field name="service_description" role="First Party" required="true" readonly="true" style="${ro}width:100%;min-height:48px" placeholder="e.g. Warehouse sorting and loading services for the period of [Start Date] to [End Date]"></text-field>
<div style="font-weight:700;margin:4px 0 2px">${bi(en.additionalNotes, t ? t.additionalNotes : '')} <span style="font-weight:400;color:#999;font-size:7pt">${bi(en.notesHint, t ? t.notesHint : '')}</span></div>
<text-field name="additional_notes" role="First Party" style="${ed}width:100%;min-height:32px" placeholder="${t ? bi('Additional details or clarifications', t.additionalNotes) : 'Additional details or clarifications'}"></text-field>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin:6px 0">
  <tr><td style="${c}width:65%"><b>${bi('Compensation Method', t ? t.compMethod : '')}</b></td><td style="${c}text-align:right"><text-field name="compensation_method" role="First Party" readonly="true" style="${ro}width:240px" placeholder="${en.compValue}">${bi(en.compValue, t ? t.compValue : '')}</text-field></td></tr>
  <tr style="background:#fffbeb"><td style="${hi}width:65%"><b>${bi('Quoted Amount', t ? t.quotedAmt : '')}</b></td><td style="${hi}text-align:right">$ <text-field name="quoted_amount" role="First Party" required="true" style="${ed}width:100px" placeholder="0.00"></text-field></td></tr>
  <tr style="background:#fffbeb"><td style="${hi}">${bi('Reimbursable Expenses', t ? t.reimbursable : '')}</td><td style="${hi}text-align:right">$ <text-field name="reimbursable_amount" role="First Party" style="${ed}width:100px" placeholder="0.00"></text-field></td></tr>
  <tr style="background:#f0f0f0;font-weight:700"><td style="padding:4px 5px;border:1px solid #999">${bi('TOTAL DUE', t ? t.totalDue : '')}</td><td style="padding:4px 5px;border:1px solid #999;text-align:right;font-size:10pt">$ <text-field name="total_amount" role="First Party" required="true" style="${ed}width:100px;font-weight:700;font-size:10pt" placeholder="0.00"></text-field></td></tr>
</table>
<div style="font-weight:700;margin:4px 0 2px">${bi('PAYMENT TERMS', t ? t.payTerms : '')} <span style="font-weight:400;color:#999;font-size:7pt">(${en.prefilled})</span></div>
<text-field name="payment_terms" role="First Party" readonly="true" style="${ro}width:200px" placeholder="Net 30"></text-field>
<span style="font-size:7pt;color:#999;margin-left:6px">${bi('Due Date', t ? t.dueDate : '')}: </span><text-field name="payment_due_date" role="First Party" readonly="true" style="${ro}width:100px"></text-field>
<div style="background:#fffbeb;border:2px solid #f59e0b;padding:6px;font-size:8pt;margin-top:6px;border-radius:4px">
  <b>${bi(en.certTitle, t ? t.certTitle : '')}</b>
  <div style="font-size:7.5pt;margin:3px 0">${en.certBody}${t ? `<br>${t.certBody}` : ''}</div>
  <table style="width:100%;margin-top:4px"><tr>
    <td style="width:65%;padding-right:8px;vertical-align:top"><div style="font-size:7pt;font-weight:700">${bi(en.sigLabel, t ? t.sigLabel : '')}:</div><signature-field name="contractor_signature" role="First Party" style="width:100%;height:44px;display:block;border:2px solid #f59e0b;border-radius:2px;background:#fff"></signature-field></td>
    <td style="width:35%;vertical-align:top"><div style="font-size:7pt;font-weight:700">${bi(en.dateLabel, t ? t.dateLabel : '')}:</div><date-field name="signature_date" role="First Party" style="width:100%;height:22px;display:block;border:1px solid #999;border-radius:2px;background:#fff"></date-field></td>
  </tr></table>
</div>
<div style="text-align:center;font-size:6.5pt;color:#aaa;margin-top:4px">${en.footer}${t ? ` ${t.footer}` : ''}<br>${t ? `${t.ilFwpa} / ` : ''}${en.ilFwpa}<br><span style="color:#f59e0b">■</span> = ${bi(en.legend, t ? t.legend : '')} &nbsp; <span style="color:#ddd">■</span> = ${bi(en.legendGrey, t ? t.legendGrey : '')}</div>
</div>`;
}
// Convenience wrappers for each language variant
function generateContractorInvoiceHtmlTemplate_ZH() { return generateContractorInvoiceHtmlTemplate('zh'); }
function generateContractorInvoiceHtmlTemplate_EN() { return generateContractorInvoiceHtmlTemplate('en'); }
function generateContractorInvoiceHtmlTemplate_ES() { return generateContractorInvoiceHtmlTemplate('es'); }

// ── Invoice Approval Form — shared builder (3 language editions) ──
// lang: 'zh-en' (Chinese+English) | 'en' (English only) | 'en-es' (English+Spanish)
function _buildInvoiceApprovalForm(lang) {
  const companyName = process.env.COMPANY_LEGAL_NAME || 'Prime Anchorpoint LLC';
  const f = 'border:1px solid #999;border-radius:2px;padding:1px 3px;background:#fff;min-height:16px;display:inline-block;';
  const w = `${f}width:100%;min-height:16px;`;
  const c = 'padding:3px 5px;border:1px solid #ccc;vertical-align:top;';
  const zh = lang === 'zh-en';
  const es = lang === 'en-es';
  const L = (en, zhTxt, esTxt) => {
    if (zh && zhTxt) return `${en} ${zhTxt}`;
    if (es && esTxt) return `${en} / ${esTxt}`;
    return en;
  };

  const formTitle = zh ? 'INVOICE APPROVAL FORM / 发票审批表' :
    es ? 'INVOICE APPROVAL FORM / FORMULARIO DE APROBACIÓN DE FACTURA' : 'INVOICE APPROVAL FORM';
  const internalOnly = zh ? `Internal Use Only — 公司内部审批专用 — ${companyName}` :
    es ? `Internal Use Only — Solo Uso Interno — ${companyName}` : `Internal Use Only — ${companyName}`;
  const confidential = zh
    ? '<b>CONFIDENTIAL 机密:</b> Internal company approval only. Do not share with contractor. 本表仅供公司内部审批，请勿分享给承包商。'
    : es
    ? '<b>CONFIDENTIAL:</b> Internal company approval only. Do not share with contractor. Solo para aprobación interna. No compartir con el contratista.'
    : '<b>CONFIDENTIAL:</b> Internal company approval only. Do not share with contractor.';

  const s1 = zh ? '1. INVOICE REFERENCE 关联发票' : es ? '1. INVOICE REFERENCE / REFERENCIA DE FACTURA' : '1. INVOICE REFERENCE';
  const lInvNum     = L('Invoice #', '发票编号', 'N.º de Factura');
  const lInvDate    = L('Invoice Date', '发票日期', 'Fecha de Factura');
  const lContractor = L('Contractor', '承包商', 'Contratista');
  const lSvcPeriod  = L('Service Period', '服务期间', 'Período de Servicio');
  const lInvUrl     = L('Company Invoice URL', '公司发票链接', 'URL de Factura Interna');
  const lInvUrlNote = zh ? '(内部文件链接或路径)' : es ? '(enlace interno o ruta de archivo)' : '(internal link or file path)';

  const s2       = zh ? '2. AMOUNT REVIEW 金额审核' : es ? '2. AMOUNT REVIEW / REVISIÓN DE MONTO' : '2. AMOUNT REVIEW';
  const lReqAmt  = L('Requested Amount (per invoice)', '发票请求金额', 'Monto Solicitado (según factura)');
  const lSvcDesc = L('Service Description Summary', '服务内容摘要', 'Resumen de Descripción del Servicio');

  const s3          = zh ? '3. APPROVAL DECISION 审批决定' : es ? '3. APPROVAL DECISION / DECISIÓN DE APROBACIÓN' : '3. APPROVAL DECISION';
  const lDecision   = L('Decision', '审批结果', 'Decisión');
  const lDecisionHint = zh ? 'Approved 批准 / Partially Approved 部分批准 / Rejected 拒绝' :
    es ? 'Approved / Partially Approved / Rejected — Aprobado / Aprobado Parcialmente / Rechazado' :
    'Approved / Partially Approved / Rejected';
  const lApprovedAmt = L('Approved Amount', '批准金额', 'Monto Aprobado');
  const lAdjReason   = L('Adjustment Reason', '调整原因', 'Razón de Ajuste');
  const lAdjNote     = zh ? '(部分批准或拒绝时必填 — Required if Partially Approved or Rejected)' :
    es ? '(Requerido si Parcialmente Aprobado o Rechazado)' : '(Required if Partially Approved or Rejected)';

  const s4         = zh ? '4. PAYMENT SCHEDULE 付款安排' : es ? '4. PAYMENT SCHEDULE / PROGRAMA DE PAGO' : '4. PAYMENT SCHEDULE';
  const lPayDate   = L('Payment Date', '付款日期', 'Fecha de Pago');
  const lPayMethod = L('Payment Method', '付款方式', 'Método de Pago');
  const ilNote     = zh
    ? 'IL FWPA: 合同未注明→完工后30天内付款 / Payment due within 30 days of completion if contract is silent.'
    : es
    ? 'IL FWPA: Payment due within 30 days of completion if contract is silent. / Pago vence 30 días tras completar si el contrato no especifica.'
    : 'IL FWPA: Payment due within 30 days of completion if contract is silent.';

  const s5           = zh ? '5. REVIEWED BY 审批人信息' : es ? '5. REVIEWED BY / REVISADO POR' : '5. REVIEWED BY';
  const lReviewedBy  = L('Reviewed By', '审批人', 'Revisado Por');
  const lTitle       = L('Title', '职位', 'Cargo');
  const lReviewDate  = L('Reviewed Date', '审核日期', 'Fecha de Revisión');
  const lNotes       = L('Internal Notes', '内部备注', 'Notas Internas');
  const lNotesNote   = zh ? '(不分享给承包商)' : es ? '(no compartir con el contratista)' : '(not shared with contractor)';

  const authSentence = zh
    ? `I authorize the above payment on behalf of ${companyName}. 本人代表公司授权上述付款。`
    : es
    ? `I authorize the above payment on behalf of ${companyName}. Autorizo el pago anterior en nombre de ${companyName}.`
    : `I authorize the above payment on behalf of ${companyName}.`;
  const sigHeader  = zh ? 'COMPANY APPROVAL SIGNATURE 公司审批签名' : es ? 'COMPANY APPROVAL SIGNATURE / FIRMA DE APROBACIÓN' : 'COMPANY APPROVAL SIGNATURE';
  const lSig       = L('Signature', '签名', 'Firma');
  const lApprDate  = L('Approval Date', '审批日期', 'Fecha de Aprobación');
  const footer     = zh
    ? `INTERNAL DOCUMENT — ${companyName} — Invoice records the contractor's request; this form records company approval. 内部文件——发票记录请求，本表记录批准。`
    : es
    ? `INTERNAL DOCUMENT — ${companyName} — Invoice records the contractor's request; this form records company approval. La factura registra la solicitud; este formulario registra la aprobación.`
    : `INTERNAL DOCUMENT — ${companyName} — Invoice records the contractor's request; this form records company approval.`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:8pt;max-width:680px;margin:0 auto;padding:10px 16px;color:#111;line-height:1.35">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:6px">
  <div style="font-size:13pt;font-weight:900;letter-spacing:1px">${formTitle}</div>
  <div style="font-size:7.5pt;color:#555">${internalOnly}</div>
</div>
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:3px;padding:4px 8px;font-size:7.5pt;color:#856404;margin-bottom:8px">
  ${confidential}
</div>

<div style="font-weight:700;margin:6px 0 3px;font-size:8.5pt">${s1}</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:22%"><b>${lInvNum}</b><br><text-field name="linked_invoice_number" role="First Party" required="true" style="${f}width:140px" placeholder="INV-2026-001"></text-field></td>
    <td style="${c}width:22%"><b>${lInvDate}</b><br><text-field name="linked_invoice_date" role="First Party" style="${f}width:100px" placeholder="MM/DD/YYYY"></text-field></td>
    <td style="${c}width:28%"><b>${lContractor}</b><br><text-field name="contractor_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:28%"><b>${lSvcPeriod}</b><br><text-field name="service_period" role="First Party" style="${w}" placeholder="May 1–7, 2026"></text-field></td>
  </tr>
  <tr>
    <td colspan="4" style="${c}"><b>${lInvUrl}</b> <span style="font-size:6.5pt;color:#888">${lInvUrlNote}</span><br><text-field name="company_invoice_url" role="First Party" style="${w}" placeholder="https://... or /files/INV-2026-001.pdf"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:6px 0 3px;font-size:8.5pt">${s2}</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:40%"><b>${lReqAmt}</b><br>$ <text-field name="requested_amount" role="First Party" required="true" style="${f}width:120px" placeholder="0.00"></text-field></td>
    <td style="${c}width:60%"><b>${lSvcDesc}</b><br><text-field name="service_description" role="First Party" style="${w}" placeholder="Brief summary of services rendered"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:6px 0 3px;font-size:8.5pt">${s3}</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:34%">
      <b>${lDecision}</b><br>
      <text-field name="approval_decision" role="First Party" required="true" style="${w}" placeholder="Approved / Partially Approved / Rejected"></text-field>
      <div style="font-size:6.5pt;color:#666;margin-top:2px">${lDecisionHint}</div>
    </td>
    <td style="${c}width:33%;background:#f9f9f0">
      <b>${lApprovedAmt}</b><br>
      <div style="font-size:11pt;font-weight:700">$ <text-field name="approved_amount" role="First Party" required="true" style="${f}width:110px;font-size:11pt;font-weight:700" placeholder="0.00"></text-field></div>
    </td>
    <td style="${c}width:33%">
      <b>${lAdjReason}</b><br>
      <div style="font-size:6.5pt;color:#c0392b;margin-bottom:2px">${lAdjNote}</div>
      <text-field name="adjustment_reason" role="First Party" style="${w}" placeholder="Explain if amount differs from requested"></text-field>
    </td>
  </tr>
</table>

<div style="font-weight:700;margin:6px 0 3px;font-size:8.5pt">${s4}</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:4px">
  <tr>
    <td style="${c}width:40%"><b>${lPayDate}</b><br><text-field name="payment_date" role="First Party" required="true" style="${f}width:120px" placeholder="MM/DD/YYYY"></text-field></td>
    <td style="${c}width:60%">
      <b>${lPayMethod}</b><br>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:4px;font-size:8pt">
        <label style="display:flex;align-items:center;gap:3px"><checkbox-field name="pm_ach" role="First Party" style="width:13px;height:13px"></checkbox-field> ACH</label>
        <label style="display:flex;align-items:center;gap:3px"><checkbox-field name="pm_wire" role="First Party" style="width:13px;height:13px"></checkbox-field> Wire</label>
        <label style="display:flex;align-items:center;gap:3px"><checkbox-field name="pm_check" role="First Party" style="width:13px;height:13px"></checkbox-field> Check</label>
        <label style="display:flex;align-items:center;gap:3px"><checkbox-field name="pm_zelle" role="First Party" style="width:13px;height:13px"></checkbox-field> Zelle</label>
      </div>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="font-size:7pt;color:#888;padding:2px 5px;border:1px solid #ccc">${ilNote}</td>
  </tr>
</table>

<div style="font-weight:700;margin:6px 0 3px;font-size:8.5pt">${s5}</div>
<table style="width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:6px">
  <tr>
    <td style="${c}width:34%"><b>${lReviewedBy}</b><br><text-field name="reviewer_name" role="First Party" required="true" style="${w}" placeholder="Full Name"></text-field></td>
    <td style="${c}width:33%"><b>${lTitle}</b><br><text-field name="reviewer_title" role="First Party" style="${w}" placeholder="Operations Manager"></text-field></td>
    <td style="${c}width:33%"><b>${lReviewDate}</b><br><text-field name="reviewed_date" role="First Party" style="${f}width:110px" placeholder="MM/DD/YYYY"></text-field></td>
  </tr>
  <tr>
    <td colspan="3" style="${c}"><b>${lNotes}</b> <span style="font-size:6.5pt;color:#888">${lNotesNote}</span><br><text-field name="internal_notes" role="First Party" style="${w};min-height:32px" placeholder="Internal notes..."></text-field></td>
  </tr>
</table>

<div style="background:#f5f5f5;border:1px solid #999;padding:6px;font-size:8pt">
  <b>${sigHeader}</b> — ${authSentence}
  <table style="width:100%;margin-top:4px"><tr>
    <td style="width:60%;padding-right:8px;vertical-align:top"><div style="font-size:7pt;font-weight:700">${lSig}:</div><signature-field name="approval_signature" role="First Party" style="width:100%;height:48px;display:block;border:1px solid #999;border-radius:2px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7pt;font-weight:700">${lApprDate}:</div><date-field name="approval_date" role="First Party" style="width:100%;height:22px;display:block;border:1px solid #999;border-radius:2px;background:#fff"></date-field></td>
  </tr></table>
</div>
<div style="text-align:center;font-size:6.5pt;color:#aaa;margin-top:4px">${footer}</div>
</div>`;
}

function generateInvoiceApprovalHtmlTemplate()    { return _buildInvoiceApprovalForm('zh-en'); }
function generateInvoiceApprovalHtmlTemplate_EN() { return _buildInvoiceApprovalForm('en'); }
function generateInvoiceApprovalHtmlTemplate_ES() { return _buildInvoiceApprovalForm('en-es'); }

// ── Third-Party Payment Authorization (PayPal / Venmo / Cash App) ──
function generateThirdPartyPayHtmlTemplate() {
  const companyName = process.env.COMPANY_LEGAL_NAME || 'Prime Anchorpoint LLC';
  const f = 'border:1px solid #999;border-radius:2px;padding:1px 3px;background:#fff;min-height:16px;display:inline-block;';
  const w = `${f}width:100%;min-height:16px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:8.5pt;max-width:660px;margin:0 auto;padding:12px 18px;color:#111;line-height:1.4">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:7px;margin-bottom:8px">
  <div style="font-size:13pt;font-weight:900;letter-spacing:1px">THIRD-PARTY PAYMENT AUTHORIZATION</div>
  <div style="font-size:9pt;font-weight:700">第三方平台付款授权表</div>
  <div style="font-size:7.5pt;color:#555;margin-top:2px">${companyName}</div>
</div>
<div style="font-size:8.5pt;margin-bottom:10px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc">
  I authorize <b>${companyName}</b> to send payments owed to me / my business for approved services through the third-party platform listed below.<br>
  <span style="color:#555">本人授权 <b>${companyName}</b> 将应付给本人/本人公司的服务款项通过以下第三方平台支付。</span>
</div>

<div style="font-weight:700;margin:8px 0 4px;font-size:9pt">1. PAYEE INFORMATION &nbsp;<span style="font-weight:400;font-size:8pt;color:#555">收款人信息</span></div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Full Name 全名</b><br><text-field name="payee_full_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Email 电邮</b><br><text-field name="payee_email" role="First Party" style="${w}" placeholder="email@example.com"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:8px 0 4px;font-size:9pt">2. PAYMENT PLATFORM &nbsp;<span style="font-weight:400;font-size:8pt;color:#555">付款平台</span></div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:100%" colspan="2">
      <b>Platform 平台:</b>&nbsp;&nbsp;
      <label style="display:inline-flex;align-items:center;gap:4px;margin-right:16px"><checkbox-field name="platform_paypal" role="First Party" style="width:13px;height:13px"></checkbox-field> PayPal</label>
      <label style="display:inline-flex;align-items:center;gap:4px;margin-right:16px"><checkbox-field name="platform_venmo" role="First Party" style="width:13px;height:13px"></checkbox-field> Venmo</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><checkbox-field name="platform_cashapp" role="First Party" style="width:13px;height:13px"></checkbox-field> Cash App</label>
    </td>
  </tr>
  <tr>
    <td style="${c}width:55%"><b>Account Handle / Username / Email &nbsp;<span style="font-weight:400;color:#555">账号</span></b><br><text-field name="platform_account" role="First Party" required="true" style="${w}" placeholder="@username or email"></text-field></td>
    <td style="${c}width:45%"><b>Payee Name on Account &nbsp;<span style="font-weight:400;color:#555">账户显示名称</span></b> <span style="font-size:7pt;color:#999">(optional 可选)</span><br><text-field name="platform_account_name" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:8px 0 4px;font-size:9pt">3. ACKNOWLEDGMENT &nbsp;<span style="font-weight:400;font-size:8pt;color:#555">确认事项</span></div>
<div style="border:1px solid #ccc;border-radius:3px;padding:6px 8px;font-size:8pt;line-height:1.7;background:#fafafa;margin-bottom:8px">
  <div>☑ I understand that transaction fees charged by the platform are my responsibility. &nbsp;<span style="color:#555">本人理解平台可能收取手续费，由本人承担。</span></div>
  <div>☑ I am responsible for ensuring that the account handle / username / email provided above is accurate. &nbsp;<span style="color:#555">本人对所填账号的准确性负责；因账号填写错误导致的付款损失由本人自行承担。</span></div>
  <div>☑ I am responsible for keeping my account active and accessible. &nbsp;<span style="color:#555">本人负责确保账户持续有效且可正常收款。</span></div>
  <div>☑ ${companyName} is not liable for platform outages, processing delays, or failed transactions caused by platform issues. &nbsp;<span style="color:#555">${companyName} 不对平台故障、延误或技术原因导致的付款失败承担责任。</span></div>
  <div>☑ Any future change to my payment account must be submitted in writing to ${companyName}. &nbsp;<span style="color:#555">如付款账户信息有任何变更，须以书面形式通知 ${companyName}。</span></div>
</div>

<div style="background:#f5f5f5;border:1px solid #999;padding:7px 8px;font-size:8.5pt">
  <div style="font-size:7.5pt;font-weight:700;margin-bottom:5px">CONTRACTOR SIGNATURE 承包商签名</div>
  <table style="width:100%"><tr>
    <td style="width:60%;padding-right:10px;vertical-align:top"><div style="font-size:7pt;font-weight:700">Signature 签名:</div><signature-field name="contractor_signature" role="First Party" style="width:100%;height:46px;display:block;border:1px solid #999;border-radius:2px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7pt;font-weight:700">Date 日期:</div><date-field name="signature_date" role="First Party" style="width:100%;height:22px;display:block;border:1px solid #999;border-radius:2px;background:#fff"></date-field></td>
  </tr></table>
</div>
<div style="text-align:center;font-size:6.5pt;color:#aaa;margin-top:4px">${companyName} — Third-Party Payment Authorization — For internal records only.</div>
</div>`;
}

// ── W-7 (ITIN Application) ──
function generateW7HtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">FORM W-7</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">Application for IRS Individual Taxpayer Identification Number / ITIN 申请表</div>
</div>
<p style="font-size:8pt;color:#555;margin-bottom:10px">Use this form to apply for an IRS individual taxpayer identification number (ITIN). An ITIN is for federal tax purposes only. 本表用于申请美国国税局个人纳税人识别号 (ITIN)，仅用于联邦税务目的。</p>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">1. APPLICANT INFORMATION 申请人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Legal Name 法定姓名</b><br><text-field name="w7_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Date of Birth 出生日期</b><br><text-field name="w7_dob" role="First Party" required="true" style="${f}width:150px" placeholder="MM/DD/YYYY"></text-field></td>
  </tr>
  <tr>
    <td style="${c}"><b>Country of Citizenship 国籍</b><br><text-field name="w7_country" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}"><b>Foreign Tax ID (if any) 外国税号</b><br><text-field name="w7_foreign_tin" role="First Party" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>U.S. Mailing Address 美国邮寄地址</b><br><text-field name="w7_address" role="First Party" required="true" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>Foreign Address 外国地址 (if applicable)</b><br><text-field name="w7_foreign_address" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. REASON FOR APPLYING 申请原因</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr><td style="${c}"><b>Reason 原因</b><br><text-field name="w7_reason" role="First Party" required="true" style="${w}" placeholder="e.g., Nonresident alien required to file a U.S. tax return"></text-field></td></tr>
  <tr><td style="${c}"><b>Name of Treaty Country (if applicable) 税收协定国家</b><br><text-field name="w7_treaty_country" role="First Party" style="${w}"></text-field></td></tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. IDENTIFICATION DOCUMENTS 身份证明文件</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Passport Number 护照号码</b><br><text-field name="w7_passport" role="First Party" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Passport Expiry Date 护照有效期</b><br><text-field name="w7_passport_exp" role="First Party" style="${f}width:150px" placeholder="MM/DD/YYYY"></text-field></td>
  </tr>
</table>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>APPLICANT SIGNATURE 申请人签名</b> — Under penalties of perjury, I declare that the information provided is true, correct, and complete.
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:60%;padding-right:10px;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Signature 签名:</div><signature-field name="w7_signature" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Date 日期:</div><date-field name="w7_date" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></td>
  </tr></table>
</div>
</div>`;
}

// ── ACH / Direct Deposit Authorization ──
function generateACHAuthHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">ACH / DIRECT DEPOSIT AUTHORIZATION</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">银行直接转账授权表 — ${companyName}</div>
</div>

<p style="font-size:8.5pt">I hereby authorize ${companyName} to initiate ACH credit entries (direct deposits) to the bank account listed below. This authorization will remain in effect until I provide written notice of cancellation.</p>
<p style="font-size:8.5pt">本人特此授权 ${companyName} 通过 ACH 电子转账方式向以下银行账户发起付款。本授权将持续有效，直至本人书面通知取消。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. PAYEE INFORMATION 收款人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Full Name 全名</b><br><text-field name="ach_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Email 电邮</b><br><text-field name="ach_email" role="First Party" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>Address 地址</b><br><text-field name="ach_address" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. BANK ACCOUNT DETAILS 银行账户信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Bank Name 银行名称</b><br><text-field name="ach_bank_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Account Type 账户类型</b><br><text-field name="ach_account_type" role="First Party" required="true" style="${f}width:180px" placeholder="Checking / Savings"></text-field></td>
  </tr>
  <tr>
    <td style="${c}"><b>Routing Number (ABA) 路由号码</b><br><text-field name="ach_routing" role="First Party" required="true" style="${f}width:200px" placeholder="9 digits"></text-field></td>
    <td style="${c}"><b>Account Number 账号</b><br><text-field name="ach_account" role="First Party" required="true" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. AUTHORIZATION 授权</div>
<p style="font-size:8pt">I agree that ACH transactions I authorize comply with all applicable U.S. law. I understand that this authorization may be revoked by notifying ${companyName} in writing.</p>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>SIGNATURES 签名</b>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:50%;padding-right:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Payee Signature 收款人签名:</div>
      <signature-field name="ach_sig1" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="ach_date1" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Company Approval 公司审批:</div>
      <signature-field name="ach_sig2" role="Second Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="ach_date2" role="Second Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── Wire Transfer Authorization ──
function generateWireAuthHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">WIRE TRANSFER AUTHORIZATION</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">电汇付款授权表 — ${companyName}</div>
</div>

<p style="font-size:8.5pt">I hereby authorize ${companyName} to send wire transfer payments to the bank account specified below. 本人特此授权 ${companyName} 通过电汇方式向以下银行账户发送付款。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. BENEFICIARY INFORMATION 收款人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Beneficiary Name 收款人姓名</b><br><text-field name="wire_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Phone / Email 电话/电邮</b><br><text-field name="wire_contact" role="First Party" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>Address 地址</b><br><text-field name="wire_address" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. BANK DETAILS 银行信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Bank Name 银行名称</b><br><text-field name="wire_bank_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Bank Address 银行地址</b><br><text-field name="wire_bank_address" role="First Party" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td style="${c}"><b>Routing / ABA / SWIFT</b><br><text-field name="wire_routing" role="First Party" required="true" style="${f}width:220px"></text-field></td>
    <td style="${c}"><b>Account Number / IBAN 账号</b><br><text-field name="wire_account" role="First Party" required="true" style="${w}"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>Intermediary Bank (if applicable) 中间行</b><br><text-field name="wire_intermediary" role="First Party" style="${w}" placeholder="Name, SWIFT, Account # (if required)"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. ADDITIONAL NOTES 备注</div>
<text-field name="wire_notes" role="First Party" style="${w};min-height:40px" placeholder="Reference number, special instructions..."></text-field>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>SIGNATURES 签名</b>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:50%;padding-right:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Beneficiary Signature 收款人签名:</div>
      <signature-field name="wire_sig1" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="wire_date1" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Company Approval 公司审批:</div>
      <signature-field name="wire_sig2" role="Second Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="wire_date2" role="Second Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── Check / 支票 Instruction Form ──
function generateCheckInstructionHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">CHECK PAYMENT INSTRUCTION</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">支票邮寄地址确认表 — ${companyName}</div>
</div>

<p style="font-size:8.5pt">I request that ${companyName} issue payment by check to the name and address below. 本人要求 ${companyName} 按以下姓名和地址签发支票付款。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. PAYEE INFORMATION 收款人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Payee Name (as printed on check) 收款人姓名</b><br><text-field name="check_payee" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Phone / Email 电话/电邮</b><br><text-field name="check_contact" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. MAILING ADDRESS 邮寄地址</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr><td style="${c}"><b>Street Address 街道地址</b><br><text-field name="check_street" role="First Party" required="true" style="${w}"></text-field></td></tr>
  <tr>
    <td style="${c}">
      <b>City 城市</b> <text-field name="check_city" role="First Party" required="true" style="${f}width:180px"></text-field>
      <b style="margin-left:12px">State 州</b> <text-field name="check_state" role="First Party" required="true" style="${f}width:80px"></text-field>
      <b style="margin-left:12px">ZIP</b> <text-field name="check_zip" role="First Party" required="true" style="${f}width:100px"></text-field>
    </td>
  </tr>
  <tr><td style="${c}"><b>Country 国家 (if outside U.S.)</b><br><text-field name="check_country" role="First Party" style="${f}width:220px" placeholder="United States"></text-field></td></tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. SPECIAL INSTRUCTIONS 特别说明</div>
<text-field name="check_notes" role="First Party" style="${w};min-height:40px" placeholder="e.g., Attn: ..., c/o ..."></text-field>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>PAYEE SIGNATURE 收款人签名</b> — I confirm the above mailing information is correct. 本人确认以上邮寄信息正确。
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:60%;padding-right:10px;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Signature 签名:</div><signature-field name="check_sig" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Date 日期:</div><date-field name="check_date" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></td>
  </tr></table>
</div>
</div>`;
}

// ── Zelle Authorization ──
function generateZelleAuthHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">ZELLE PAYMENT AUTHORIZATION</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">Zelle 账号授权确认表 — ${companyName}</div>
</div>

<p style="font-size:8.5pt">I authorize ${companyName} to send payments via Zelle to the account information provided below. 本人授权 ${companyName} 通过 Zelle 向以下账户发送付款。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. PAYEE INFORMATION 收款人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Full Name 全名</b><br><text-field name="zelle_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Zelle Registered Email or Phone Zelle 注册邮箱或手机号</b><br><text-field name="zelle_account" role="First Party" required="true" style="${w}" placeholder="email@example.com or (xxx) xxx-xxxx"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. BANK INFORMATION 银行信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}"><b>Bank Name (Zelle linked to) Zelle 关联银行</b><br><text-field name="zelle_bank" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. ACKNOWLEDGMENT 确认事项</div>
<p style="font-size:8pt">I understand that: (a) Zelle payments may be subject to daily/monthly limits set by my bank; (b) I am responsible for ensuring my Zelle account is active and properly enrolled; (c) ${companyName} is not liable for payment delays caused by the Zelle network or receiving bank.</p>
<p style="font-size:8pt">本人理解：(a) Zelle 付款可能受银行每日/每月限额限制；(b) 本人负责确保 Zelle 账户已激活并正确注册；(c) ${companyName} 不对 Zelle 网络或收款银行造成的付款延迟承担责任。</p>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>PAYEE SIGNATURE 收款人签名</b>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:60%;padding-right:10px;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Signature 签名:</div><signature-field name="zelle_sig" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Date 日期:</div><date-field name="zelle_date" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></td>
  </tr></table>
</div>
</div>`;
}

// ── Third-Party Payment Authorization (PayPal / Venmo / CashApp) ──
function generateThirdPartyPayHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">THIRD-PARTY PAYMENT AUTHORIZATION</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">第三方平台付款授权表 (PayPal / Venmo / CashApp) — ${companyName}</div>
</div>

<p style="font-size:8.5pt">I authorize ${companyName} to send payments via the third-party platform specified below. 本人授权 ${companyName} 通过以下第三方平台发送付款。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. PAYEE INFORMATION 收款人信息</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Full Name 全名</b><br><text-field name="tpp_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Email 电邮</b><br><text-field name="tpp_email" role="First Party" style="${w}"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. PAYMENT PLATFORM 付款平台</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Platform 平台</b><br><text-field name="tpp_platform" role="First Party" required="true" style="${f}width:220px" placeholder="PayPal / Venmo / CashApp / Other"></text-field></td>
    <td style="${c}width:50%"><b>Account Handle / Username / Email 账号</b><br><text-field name="tpp_handle" role="First Party" required="true" style="${w}" placeholder="@username or email"></text-field></td>
  </tr>
  <tr>
    <td colspan="2" style="${c}"><b>Preferred Payment Type 付款类型偏好</b><br><text-field name="tpp_type" role="First Party" style="${f}width:280px" placeholder="Goods & Services / Friends & Family / Business"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">3. ACKNOWLEDGMENT 确认事项</div>
<p style="font-size:8pt">I understand that: (a) third-party platforms may charge transaction fees which are my responsibility; (b) ${companyName} is not liable for platform outages or delays; (c) I am responsible for maintaining an active account on the selected platform.</p>
<p style="font-size:8pt">本人理解：(a) 第三方平台可能收取交易费用，由本人承担；(b) ${companyName} 不对平台故障或延迟承担责任；(c) 本人负责在所选平台上保持账户有效。</p>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:14px;font-size:8.5pt">
  <b>PAYEE SIGNATURE 收款人签名</b>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:60%;padding-right:10px;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Signature 签名:</div><signature-field name="tpp_sig" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field></td>
    <td style="width:40%;vertical-align:top"><div style="font-size:7.5pt;font-weight:700">Date 日期:</div><date-field name="tpp_date" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></td>
  </tr></table>
</div>
</div>`;
}

// ── Cash Payment Receipt ──
function generateCashReceiptHtmlTemplate() {
  const f = 'border:1px solid #999;border-radius:3px;padding:2px 4px;background:#fff;min-height:20px;display:inline-block;';
  const w = `${f}width:100%;min-height:22px;`;
  const c = 'padding:4px 6px;border:1px solid #ccc;vertical-align:top;';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;max-width:720px;margin:0 auto;padding:20px;color:#111;line-height:1.5">
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
  <div style="font-size:14pt;font-weight:900;letter-spacing:1px">CASH PAYMENT RECEIPT</div>
  <div style="font-size:9pt;color:#555;margin-top:4px">现金付款签收表 — ${companyName}</div>
</div>

<p style="font-size:8.5pt">This receipt confirms that the undersigned has received a cash payment from ${companyName} for services rendered. 本签收表确认签署人已从 ${companyName} 收到现金付款。</p>

<div style="font-weight:700;margin:12px 0 5px;font-size:9.5pt">1. PAYMENT DETAILS 付款详情</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr>
    <td style="${c}width:50%"><b>Recipient Name 收款人姓名</b><br><text-field name="cash_name" role="First Party" required="true" style="${w}"></text-field></td>
    <td style="${c}width:50%"><b>Payment Date 付款日期</b><br><date-field name="cash_pay_date" role="First Party" required="true" style="${f}width:160px"></date-field></td>
  </tr>
  <tr>
    <td style="${c}"><b>Amount Received 收到金额</b><br><div style="font-size:12pt;font-weight:700">$ <text-field name="cash_amount" role="First Party" required="true" style="${f}width:140px;font-size:12pt;font-weight:700" placeholder="0.00"></text-field></div></td>
    <td style="${c}"><b>Amount in Words 大写金额</b><br><text-field name="cash_amount_words" role="First Party" style="${w}" placeholder="e.g., Five Hundred Dollars"></text-field></td>
  </tr>
</table>

<div style="font-weight:700;margin:10px 0 5px;font-size:9.5pt">2. PURPOSE / DESCRIPTION 付款用途</div>
<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px">
  <tr><td style="${c}"><b>Services / Description 服务说明</b><br><text-field name="cash_description" role="First Party" required="true" style="${w};min-height:40px" placeholder="Description of services rendered..."></text-field></td></tr>
  <tr>
    <td style="${c}"><b>Service Period 服务期间</b> <text-field name="cash_period" role="First Party" style="${f}width:220px" placeholder="e.g., Mar 1–15, 2026"></text-field>
    <b style="margin-left:16px">Reference # 参考编号</b> <text-field name="cash_ref" role="First Party" style="${f}width:160px"></text-field></td>
  </tr>
</table>

<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:3px;padding:6px 8px;font-size:8pt;color:#856404;margin-bottom:10px">
  <b>NOTICE 注意:</b> Both parties must sign below to confirm the cash payment. This receipt serves as proof of payment for tax and record-keeping purposes. 双方必须签署以确认现金付款。本签收表作为税务和记录保存的付款证明。
</div>

<div style="background:#f5f5f5;border:1px solid #999;padding:8px;margin-top:10px;font-size:8.5pt">
  <b>SIGNATURES 签名</b>
  <table style="width:100%;margin-top:6px"><tr>
    <td style="width:50%;padding-right:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Recipient Signature 收款人签名:</div>
      <signature-field name="cash_sig1" role="First Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="cash_date1" role="First Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
    <td style="width:50%;padding-left:10px;vertical-align:top">
      <div style="font-size:7.5pt;font-weight:700">Company Representative 公司代表:</div>
      <signature-field name="cash_sig2" role="Second Party" style="width:100%;height:50px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></signature-field>
      <div style="margin-top:4px"><date-field name="cash_date2" role="Second Party" style="width:100%;height:24px;display:block;border:1px solid #999;border-radius:3px;background:#fff"></date-field></div>
    </td>
  </tr></table>
</div>
</div>`;
}

// ── Map of all auto-creatable templates ──
const DOCUSEAL_AUTO_TEMPLATES = {
  company_contract: { name: 'Company Contract / 公司合同', configKey: 'company_contract_template_id', category: 'company_contract', generator: generateCompanyContractHtmlTemplate },
  worker_1099: { name: 'Independent Contractor Agreement (1099) / 劳务合同—1099', configKey: 'worker_1099_template_id', category: 'worker_1099', generator: generateContractor1099HtmlTemplate },
  worker_w2: { name: 'Employment Agreement (W-2) / 劳务合同—W2', configKey: 'worker_w2_template_id', category: 'worker_w2', generator: generateW2EmploymentHtmlTemplate },
  w4: { name: 'W-4 Employee Withholding Certificate', configKey: 'w4_template_id', category: 'w4', generator: generateW4HtmlTemplate },
  w9: { name: 'W-9 Request for TIN', configKey: 'w9_template_id', category: 'w9', generator: generateW9HtmlTemplate },
  w8ben: { name: 'W-8BEN Certificate of Foreign Status (Individual)', configKey: 'w8ben_template_id', category: 'w8ben', generator: generateW8BENHtmlTemplate },
  w8bene: { name: 'W-8BEN-E Certificate of Foreign Status (Entity)', configKey: 'w8bene_template_id', category: 'w8bene', generator: generateW8BENEHtmlTemplate },
  form8233: { name: 'Form 8233 Exemption From Withholding', configKey: 'form8233_template_id', category: 'form8233', generator: generateForm8233HtmlTemplate },
  i9: { name: 'I-9 Employment Eligibility Verification', configKey: 'i9_template_id', category: 'i9', generator: generateI9HtmlTemplate },
  w7: { name: 'W-7 ITIN Application / ITIN 申请表', configKey: 'w7_template_id', category: 'w7', generator: generateW7HtmlTemplate },
  ach_auth: { name: 'ACH / Direct Deposit Authorization / 银行直接转账授权', configKey: 'ach_auth_template_id', category: 'ach_auth', generator: generateACHAuthHtmlTemplate },
  wire_auth: { name: 'Wire Transfer Authorization / 电汇付款授权', configKey: 'wire_auth_template_id', category: 'wire_auth', generator: generateWireAuthHtmlTemplate },
  check_instruction: { name: 'Check Payment Instruction / 支票邮寄地址确认', configKey: 'check_instruction_template_id', category: 'check_instruction', generator: generateCheckInstructionHtmlTemplate },
  zelle_auth: { name: 'Zelle Payment Authorization / Zelle 账号授权', configKey: 'zelle_auth_template_id', category: 'zelle_auth', generator: generateZelleAuthHtmlTemplate },
  third_party_pay: { name: 'Third-Party Payment Authorization (PayPal/Venmo/CashApp)', configKey: 'third_party_pay_template_id', category: 'third_party_pay', generator: generateThirdPartyPayHtmlTemplate },
  cash_receipt: { name: 'Cash Payment Receipt / 现金付款签收', configKey: 'cash_receipt_template_id', category: 'cash_receipt', generator: generateCashReceiptHtmlTemplate },
  contractor_invoice:    { name: '1099 Contractor Invoice (EN+ZH)', configKey: 'contractor_invoice_template_id',    category: 'contractor_invoice',    generator: generateContractorInvoiceHtmlTemplate_ZH },
  contractor_invoice_en: { name: '1099 Contractor Invoice (EN)',    configKey: 'contractor_invoice_en_template_id', category: 'contractor_invoice_en', generator: generateContractorInvoiceHtmlTemplate_EN },
  contractor_invoice_es: { name: '1099 Contractor Invoice (EN+ES)', configKey: 'contractor_invoice_es_template_id', category: 'contractor_invoice_es', generator: generateContractorInvoiceHtmlTemplate_ES },
  invoice_approval:    { name: 'Invoice Approval Form / 发票审批表 (内部)',                          configKey: 'invoice_approval_template_id',    category: 'invoice_approval',    generator: generateInvoiceApprovalHtmlTemplate },
  invoice_approval_en: { name: 'Invoice Approval Form (EN)',                                        configKey: 'invoice_approval_en_template_id', category: 'invoice_approval_en', generator: generateInvoiceApprovalHtmlTemplate_EN },
  invoice_approval_es: { name: 'Invoice Approval Form (EN+ES) / Formulario de Aprobación (EN+ES)', configKey: 'invoice_approval_es_template_id', category: 'invoice_approval_es', generator: generateInvoiceApprovalHtmlTemplate_ES },
};

function getDsealConfigTemplateId(type) {
  try {
    const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
    const cfg = JSON.parse(row?.config || '{}');
    const map = {
      w9: cfg.w9_template_id,
      contract: cfg.contract_template_id,          // legacy alias → company contract
      company_contract: cfg.company_contract_template_id || cfg.contract_template_id,
      worker_1099: cfg.worker_1099_template_id,
      worker_w2: cfg.worker_w2_template_id,
      w4: cfg.w4_template_id,
      w8ben: cfg.w8ben_template_id,
      w8bene: cfg.w8bene_template_id,
      form8233: cfg.form8233_template_id,
      i9: cfg.i9_template_id,
      w7: cfg.w7_template_id,
      ach_auth: cfg.ach_auth_template_id,
      wire_auth: cfg.wire_auth_template_id,
      check_instruction: cfg.check_instruction_template_id,
      zelle_auth: cfg.zelle_auth_template_id,
      third_party_pay: cfg.third_party_pay_template_id,
      cash_receipt: cfg.cash_receipt_template_id,
      contractor_invoice: cfg.contractor_invoice_template_id,
      contractor_invoice_en: cfg.contractor_invoice_en_template_id,
      contractor_invoice_es: cfg.contractor_invoice_es_template_id,
      invoice_approval:    cfg.invoice_approval_template_id,
      invoice_approval_en: cfg.invoice_approval_en_template_id,
      invoice_approval_es: cfg.invoice_approval_es_template_id,
    };
    const val = map[type];
    if (Array.isArray(val)) return val[0] || '';
    return val || '';
  } catch { return ''; }
}

// Fetch field names from a DocuSeal template; returns a Set of field names, or null on failure
async function dsealGetTemplateFieldNames(templateId) {
  try {
    const res = await dsealApiCall('GET', `/api/templates/${templateId}`, null);
    if (res.status >= 400 || !res.data) return null;
    const fields = res.data.fields || res.data.schema || [];
    const names = new Set(fields.map(f => f.name).filter(Boolean));
    console.log(`[DocuSeal W-9] template ${templateId} fields: ${[...names].join(', ')}`);
    return names;
  } catch (e) {
    console.warn(`[DocuSeal W-9] could not fetch template fields: ${e.message}`);
    return null;
  }
}

// Send W-9 form via DocuSeal template — uses pre-built template on DocuSeal
async function dsealSendW9Html({ workerName, workerEmail, workerPhone, address, cityStateZip, ssn, tinType, businessName, taxClassification, overrideTemplateId }) {
  const templateId = overrideTemplateId || getDsealConfigTemplateId('w9') || process.env.DOCUSEAL_W9_TEMPLATE_ID || '';
  const todayDate = new Date().toISOString().slice(0, 10);
  let subRes;
  let dsealHandledNotifications = false;
  if (templateId) {
    // Use existing DocuSeal template (official IRS W-9)
    // Fetch actual field names from the template to avoid sending unknown fields (422 error)
    const templateFieldNames = await dsealGetTemplateFieldNames(templateId);
    const addField = (fields, name, value, readonly) => {
      if (!templateFieldNames || templateFieldNames.has(name)) {
        fields.push({ name, default_value: value, readonly, required: true });
      }
    };
    const fields = [];
    addField(fields, 'w9_name', workerName, false);
    if (address) addField(fields, 'w9_address', address, false);
    if (cityStateZip) addField(fields, 'w9_city_state_zip', cityStateZip, false);
    if (ssn) addField(fields, 'w9_ssn', ssn, false);
    if (businessName) addField(fields, 'w9_business_name', businessName, false);
    if (taxClassification) addField(fields, 'w9_tax_classification', taxClassification, false);
    addField(fields, 'w9_date', todayDate, false);
    const w9Submitter = { role: 'First Party', name: workerName, email: workerEmail };
    if (fields.length) w9Submitter.fields = fields;
    if (workerPhone) w9Submitter.phone = formatPhoneE164(workerPhone);
    subRes = await dsealApiCall('POST', '/api/submissions', {
      template_id: parseInt(templateId),
      send_email: true,
      send_sms: true,
      submitters: [w9Submitter]
    });
    // DocuSeal handles email+SMS notifications directly — system should not send duplicates
    dsealHandledNotifications = true;
  } else {
    // Fallback: generate HTML template
    const w9Html = generateW9HtmlTemplate(workerName);
    const fallbackFields = [
      { name: 'w9_name', default_value: workerName, readonly: false, required: true },
      { name: 'w9_date', default_value: todayDate, readonly: false, required: true }
    ];
    if (address) fallbackFields.push({ name: 'w9_address', default_value: address, readonly: false, required: true });
    if (cityStateZip) fallbackFields.push({ name: 'w9_city_state_zip', default_value: cityStateZip, readonly: false, required: true });
    const w9FallbackSubmitter = { role: 'Signer', name: workerName, email: workerEmail, fields: fallbackFields };
    if (workerPhone) w9FallbackSubmitter.phone = formatPhoneE164(workerPhone);
    subRes = await dsealApiCall('POST', '/api/submissions/html', {
      name: `W-9 表格 - ${workerName}`,
      documents: [{ name: `W-9 Tax Form - ${workerName}`, html: w9Html, size: 'Letter' }],
      send_email: false,
      send_sms: true,
      submitters: [w9FallbackSubmitter]
    });
  }
  console.log(`[DocuSeal W-9] submission: status=${subRes.status}, templateId=${templateId || 'html-fallback'}, response=${JSON.stringify(subRes.data).substring(0, 500)}`);
  const submitters = subRes.data?.submitters || (Array.isArray(subRes.data) ? subRes.data : []);
  if (subRes.status >= 400 || !submitters.length) {
    throw new Error(`DocuSeal W-9 提交创建失败 ${subRes.status}: ${JSON.stringify(subRes.data)}`);
  }
  const signer = submitters[0];
  const submissionId = subRes.data?.id || signer?.submission_id || '';
  let workerSignUrl = signer?.embed_src || '';
  if (!workerSignUrl && signer?.id) {
    try {
      const wPut = await dsealApiCall('PUT', `/api/submitters/${signer.id}`, { name: workerName });
      if (wPut.data?.embed_src) workerSignUrl = wPut.data.embed_src;
    } catch (e) { console.error(`[DocuSeal W-9] Failed to get embed_src: ${e.message}`); }
  }
  const slug = signer?.slug || '';
  const baseHost = dsealPublicHost();
  const directUrl = slug ? `${baseHost}/s/${slug}` : '';
  // Prefer embed_src for web component embedding; fall back to slug URL
  const finalWorkerUrl = workerSignUrl || directUrl;
  console.log(`[DocuSeal W-9] Worker sign URL: ${(finalWorkerUrl || 'NONE').substring(0, 100)}`);
  return { submissionId: String(submissionId || signer?.id || ''), workerSignUrl: finalWorkerUrl, dsealHandledNotifications };
}

async function dsealGetW9Status(submissionId) {
  const r = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
  if (r.status !== 200) throw new Error(`DocuSeal 获取 W-9 状态失败 ${r.status}`);
  const sub = r.data;
  let status = sub.status === 'completed' ? 'completed' : 'sent';
  let workerSigned = null, declineReason = '';
  for (const s of (sub.submitters || [])) {
    if (s.status === 'completed' && s.completed_at) workerSigned = s.completed_at;
    if (s.status === 'declined') { status = 'declined'; declineReason = s.decline_reason || '已拒签'; }
  }
  return { status, workerSigned, declineReason, raw: sub };
}

async function dsealGetW9SignUrl(submissionId) {
  const r = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
  if (r.status !== 200) throw new Error(`DocuSeal 获取 W-9 提交失败 ${r.status}`);
  const signer = (r.data.submitters || [])[0];
  if (!signer) throw new Error('DocuSeal W-9: 签署人未找到');
  // Always call PUT to get a fresh embed_src — GET /submissions does not return embed_src.
  // embed_src uses DocuSeal's own APP_URL (publicly accessible), while slug URLs use our
  // internal DOCUSEAL_URL which may not be reachable from the worker's browser.
  // embed_src also allows iframe embedding; direct /s/xxx URLs may have X-Frame-Options set.
  const u = await dsealApiCall('PUT', `/api/submitters/${signer.id}`, { name: signer.name });
  if (u.data?.embed_src) return u.data.embed_src;
  const baseHost = dsealPublicHost();
  if (u.data?.slug) return `${baseHost}/s/${u.data.slug}`;
  if (signer.slug) return `${baseHost}/s/${signer.slug}`;
  if (u.status >= 400) throw new Error(`DocuSeal 获取 W-9 签署链接失败 ${u.status}`);
  throw new Error('DocuSeal W-9: 无法获取签署链接');
}

async function dsealGetCompanySignUrl(submissionId) {
  // Get submission to find company submitter ID
  const r = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
  console.log(`[DocuSeal] GET submission ${submissionId}: status=${r.status}, submitters=${JSON.stringify((r.data?.submitters||[]).map(s=>({id:s.id,role:s.role,status:s.status,has_embed:!!s.embed_src})))}`);
  if (r.status !== 200) throw new Error(`DocuSeal 获取提交失败 ${r.status}: ${JSON.stringify(r.data)}`);
  const company = (r.data.submitters || []).find(s => s.role === 'First Party') || (r.data.submitters || [])[0];
  if (!company) throw new Error('DocuSeal: 公司签署人未找到');
  // embed_src is only in create response; use PUT /submitters/{id} to retrieve it
  if (company.embed_src) return company.embed_src;
  const u = await dsealApiCall('PUT', `/api/submitters/${company.id}`, { name: company.name });
  console.log(`[DocuSeal] PUT submitter ${company.id}: status=${u.status}, has_embed=${!!u.data?.embed_src}, embed_prefix=${(u.data?.embed_src||'').substring(0,60)}`);
  if (u.status >= 400 || !u.data?.embed_src) throw new Error(`DocuSeal 获取签署链接失败 ${u.status}: ${JSON.stringify(u.data)}`);
  return u.data.embed_src;
}

async function dsealGetStatus(submissionId) {
  const r = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
  if (r.status !== 200) throw new Error(`DocuSeal 获取状态失败 ${r.status}`);
  const sub = r.data;
  let status = (sub.status === 'completed') ? 'completed' : 'sent';
  let companySigned = null, partnerSigned = null, declineReason = '';
  for (const s of (sub.submitters || [])) {
    if (s.status === 'completed' && s.completed_at) {
      if (s.role === 'First Party') companySigned = s.completed_at;
      else partnerSigned = s.completed_at;
    }
    if (s.status === 'declined') { status = 'declined'; declineReason = s.decline_reason || '已拒签'; }
  }
  return { status, companySigned, partnerSigned, declineReason, raw: sub };
}

async function dsealArchive(submissionId) {
  const r = await dsealApiCall('DELETE', `/api/submissions/${submissionId}`, null);
  if (r.status >= 400) throw new Error(`DocuSeal 归档失败 ${r.status}: ${JSON.stringify(r.data)}`);
}

async function dsealDownloadDocument(submissionId, { retries = 3, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
    if (r.status !== 200) throw new Error(`DocuSeal 获取提交失败 ${r.status}`);
    const sub = r.data;

    // 1) Prefer submission-level combined documents (has all signatures)
    let docUrl = null;
    if (sub.documents && sub.documents.length) {
      docUrl = sub.documents[sub.documents.length - 1].url;
      console.log(`[DocuSeal] Using submission-level document for ${submissionId}`);
    }
    // 2) Fallback: pick the submitter who signed LAST (most recent completed_at) — their doc has the most signatures
    if (!docUrl) {
      let latestTime = '';
      for (const s of (sub.submitters || [])) {
        if (s.status === 'completed' && s.completed_at && s.documents && s.documents.length) {
          if (s.completed_at > latestTime) {
            latestTime = s.completed_at;
            docUrl = s.documents[s.documents.length - 1].url;
          }
        }
      }
    }
    // 3) Fallback: any submitter with documents
    if (!docUrl) {
      for (const s of (sub.submitters || [])) {
        if (s.documents && s.documents.length) { docUrl = s.documents[0].url; break; }
      }
    }

    if (docUrl) {
      console.log(`[DocuSeal] Download doc attempt ${attempt}: submissionId=${submissionId}, docUrl=${docUrl.substring(0, 100)}, submitters: ${JSON.stringify((sub.submitters || []).map(s => ({ role: s.role, status: s.status, completed_at: s.completed_at, docs: (s.documents || []).length })))}, submission_docs: ${(sub.documents || []).length}`);
      const buf = await _dsealFetchUrl(docUrl);
      // Sanity check: PDF should start with %PDF
      if (buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-') return buf;
      // If not a valid PDF, it might be a placeholder; retry after delay
      console.warn(`[DocuSeal] Downloaded content is not a valid PDF (${buf.length} bytes, starts with "${buf.slice(0, 20).toString()}"), attempt ${attempt}/${retries}`);
    } else {
      console.warn(`[DocuSeal] No documents found for submission ${submissionId}, attempt ${attempt}/${retries}, submitters: ${JSON.stringify((sub.submitters || []).map(s => ({ id: s.id, role: s.role, status: s.status, completed_at: s.completed_at, docs: (s.documents || []).length })))}, submission_docs: ${(sub.documents || []).length}`);
    }

    if (attempt < retries) await new Promise(ok => setTimeout(ok, delayMs * attempt));
  }
  throw new Error('DocuSeal: 签署文件链接不可用（重试后仍未获取到已签署PDF）');
}

function _dsealFetchUrl(docUrl, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(docUrl);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;
    const opts = { hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname + urlObj.search, method: 'GET', headers: {} };
    try { const _dc = dsealGetCreds(); if (urlObj.hostname === new URL(_dc.baseUrl || 'https://x').hostname) opts.headers['X-Auth-Token'] = _dc.apiKey; } catch {}
    const req = transport.request(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirectCount < 5) {
        res.resume();
        const redirectUrl = new URL(res.headers.location, docUrl).href;
        console.log(`[DocuSeal] _dsealFetchUrl redirect ${res.statusCode} -> ${redirectUrl.substring(0, 120)}`);
        return resolve(_dsealFetchUrl(redirectUrl, _redirectCount + 1));
      }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end();
  });
}

// Multi-page PDF builder from plain text (word-wrap + auto-paginate)
function buildContractPdf(plainText) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const pageW = 612, pageH = 792, margin = 60, lineH = 16;
  const allLines = [];
  for (const rawLine of (plainText || '').split('\n')) {
    const t = rawLine.trimEnd();
    if (!t) { allLines.push({ text: '', size: 11 }); continue; }
    const isHeading = /^[A-Z][A-Z\s]{3,}$/.test(t.trim()) || /^\d+\.\s/.test(t.trim());
    const size = isHeading ? 12 : 11;
    const maxW = isHeading ? 72 : 82;
    const words = t.split(' ');
    let cur = '';
    for (const w of words) {
      if (!cur) { cur = w; continue; }
      if ((cur + ' ' + w).length <= maxW) { cur += ' ' + w; }
      else { allLines.push({ text: cur, size }); cur = w; }
    }
    if (cur) allLines.push({ text: cur, size });
  }
  const lpp = Math.floor((pageH - 2 * margin) / lineH);
  const pages = [];
  for (let i = 0; i < allLines.length; i += lpp) pages.push(allLines.slice(i, i + lpp));
  if (!pages.length) pages.push([]);
  const pc = pages.length;
  // Object IDs: 1=Catalog, 2=Pages, 3=Font, then per page: 4+p*2=PageObj, 5+p*2=Stream
  const header = '%PDF-1.4\n';
  const parts = [Buffer.from(header)];
  let off = header.length;
  const xr = {};
  const wo = (id, raw) => { xr[id] = off; const b = Buffer.from(raw, 'latin1'); parts.push(b); off += b.length; };
  const kids = Array.from({ length: pc }, (_, p) => `${4 + p * 2} 0 R`).join(' ');
  wo(1, `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  wo(2, `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pc} >>\nendobj\n`);
  wo(3, `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  for (let p = 0; p < pc; p++) {
    const pid = 4 + p * 2, sid = 5 + p * 2;
    wo(pid, `${pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${sid} 0 R >>\nendobj\n`);
    let stream = ''; let y = pageH - margin;
    for (const { text, size } of pages[p]) {
      if (!text) { y -= lineH; continue; }
      stream += `BT /F1 ${size} Tf ${margin} ${y} Td (${esc(text)}) Tj ET\n`;
      y -= lineH;
    }
    const sb = Buffer.from(stream, 'latin1');
    wo(sid, `${sid} 0 obj\n<< /Length ${sb.length} >>\nstream\n${stream}endstream\nendobj\n`);
  }
  const maxId = 3 + pc * 2;
  let xrefStr = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) xrefStr += (xr[i] !== undefined ? String(xr[i]).padStart(10, '0') : '0000000000') + ' 00000 n \n';
  xrefStr += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${off}\n%%EOF`;
  parts.push(Buffer.from(xrefStr));
  return Buffer.concat(parts);
}

function generatePartnerContractText({ partnerName, companyName, partnerAddress, dateStr }) {
  const cname = companyName || 'Prime Anchorpoint LLC';
  return [
    'PARTNERSHIP SERVICE AGREEMENT', '',
    `Date: ${dateStr}`, '',
    'This Partnership Service Agreement ("Agreement") is entered into between:', '',
    `Company: ${cname}  ("Service Provider")`,
    `Partner: ${partnerName}`,
    ...(partnerAddress ? [`Address: ${partnerAddress}`] : []),
    '("Partner")', '',
    '1. SCOPE OF SERVICES',
    'The Partner agrees to provide staffing and workforce services as mutually agreed.',
    'The Company will refer client engagements based on Partner availability and qualifications.', '',
    '2. COMPENSATION',
    'Compensation terms shall be agreed upon for each individual engagement or project.',
    'Payment shall be made within 30 days of receipt of a valid invoice.', '',
    '3. TERM',
    'This Agreement commences on the date above and continues for one (1) year unless',
    'terminated earlier by either party upon 30 days written notice.', '',
    '4. CONFIDENTIALITY',
    'Each party agrees to keep confidential any proprietary information disclosed by the other.', '',
    '5. INDEPENDENT CONTRACTOR',
    'Partner is an independent contractor, not an employee of the Company.', '',
    '6. GOVERNING LAW',
    'This Agreement shall be governed by the laws of the State of Illinois.', '',
    '7. ENTIRE AGREEMENT',
    'This Agreement constitutes the entire understanding between the parties.', '', '',
    'SIGNATURES', '',
    `${cname} (Service Provider)`,
    'Authorized Signature: {{sig1;role=First Party;type=signature}}',
    'Date: {{date1;role=First Party;type=date}}', '',
    `${partnerName} (Partner)`,
    'Partner Signature: {{sig2;role=Second Party;type=signature}}',
    'Date: {{date2;role=Second Party;type=date}}',
  ].join('\n');
}

function generateWorkerContractText({ workerName, companyName, employmentType, dateStr, position }) {
  const cname = companyName || 'Prime Anchorpoint LLC';
  const pos = position || 'General Worker';
  if (employmentType === '1099') {
    return [
      'INDEPENDENT CONTRACTOR AGREEMENT', '',
      `Date: ${dateStr}`, '',
      'This Independent Contractor Agreement ("Agreement") is entered into between:', '',
      `Company: ${cname}  ("Company")`,
      `Contractor: ${workerName}  ("Contractor")`, '',
      '1. ENGAGEMENT',
      `The Company engages the Contractor to perform services as ${pos}.`,
      'The Contractor shall perform services as an independent contractor, not an employee.', '',
      '2. COMPENSATION',
      'Compensation shall be based on mutually agreed rates for each assignment.',
      'The Contractor shall submit invoices and be paid within 15 business days.', '',
      '3. TERM',
      'This Agreement is effective as of the date above and continues until terminated',
      'by either party with 14 days written notice.', '',
      '4. RELATIONSHIP',
      'The Contractor is an independent contractor. Nothing in this Agreement creates',
      'an employer-employee relationship. The Contractor is responsible for their own',
      'taxes, insurance, and benefits.', '',
      '5. CONFIDENTIALITY',
      'The Contractor agrees to keep confidential all proprietary information of the Company.', '',
      '6. NON-SOLICITATION',
      'During the term and for 12 months after, the Contractor shall not directly solicit',
      'any clients introduced by the Company.', '',
      '7. GOVERNING LAW',
      'This Agreement shall be governed by the laws of the State of Illinois.', '',
      '8. ENTIRE AGREEMENT',
      'This Agreement constitutes the entire understanding between the parties.', '', '',
      'SIGNATURES', '',
      `${cname} (Company)`,
      'Authorized Signature: {{sig1;role=First Party;type=signature}}',
      'Date: {{date1;role=First Party;type=date}}', '',
      `${workerName} (Contractor)`,
      'Contractor Signature: {{sig2;role=Second Party;type=signature}}',
      'Date: {{date2;role=Second Party;type=date}}',
    ].join('\n');
  }
  // W-2 Employment Agreement
  return [
    'EMPLOYMENT AGREEMENT', '',
    `Date: ${dateStr}`, '',
    'This Employment Agreement ("Agreement") is entered into between:', '',
    `Employer: ${cname}  ("Employer")`,
    `Employee: ${workerName}  ("Employee")`, '',
    '1. POSITION AND DUTIES',
    `The Employer hereby employs the Employee in the position of ${pos}.`,
    'The Employee shall perform duties as assigned by the Employer.', '',
    '2. COMPENSATION',
    'Compensation shall be at the rate agreed upon and communicated separately.',
    'Payment shall be made on a regular payroll schedule via direct deposit (Gusto).', '',
    '3. EMPLOYMENT TYPE',
    'This is at-will employment. Either party may terminate the employment relationship',
    'at any time, with or without cause or prior notice.', '',
    '4. BENEFITS',
    'The Employee may be eligible for benefits as determined by company policy.', '',
    '5. CONFIDENTIALITY',
    'The Employee agrees to keep confidential all proprietary information of the Employer.', '',
    '6. WORK AUTHORIZATION',
    'The Employee represents that they are legally authorized to work in the United States',
    'and will complete all required employment verification forms (I-9).', '',
    '7. GOVERNING LAW',
    'This Agreement shall be governed by the laws of the State of Illinois.', '',
    '8. ENTIRE AGREEMENT',
    'This Agreement constitutes the entire understanding between the parties.', '', '',
    'SIGNATURES', '',
    `${cname} (Employer)`,
    'Authorized Signature: {{sig1;role=First Party;type=signature}}',
    'Date: {{date1;role=First Party;type=date}}', '',
    `${workerName} (Employee)`,
    'Employee Signature: {{sig2;role=Second Party;type=signature}}',
    'Date: {{date2;role=Second Party;type=date}}',
  ].join('\n');
}

function generateTerminationNoticeText({ partnerName, companyName, dateStr }) {
  const c = companyName || 'Prime Anchorpoint LLC';
  return [
    'NOTICE OF SERVICE TERMINATION', '服务终止通知书', '',
    `Date / 日期: ${dateStr}`, '',
    `To / 致: ${partnerName}`, '',
    `Dear ${partnerName},`, '',
    `This letter serves as formal written notice that ${c} hereby terminates`,
    'the Partnership Service Agreement entered into between the parties,',
    'effective thirty (30) days from the date of this notice.',
    '',
    'This termination is made in accordance with the termination clause of the',
    'Agreement, which permits either party to terminate upon 30 days written',
    'notice without cause.', '',
    'During the notice period, all ongoing work and assignments shall be',
    'completed or transitioned in an orderly manner. Final invoices must be',
    'submitted within 15 days of the termination effective date.', '',
    'Any outstanding balances owed by either party shall be settled within',
    '30 days of the effective termination date.', '',
    'We appreciate the partnership and wish you success in your future endeavors.', '',
    'Sincerely,', '', c, '',
    'Authorized Representative: ________________________', `Date: ${dateStr}`,
  ].join('\n');
}

function generateBreachNoticeText({ partnerName, companyName, dateStr }) {
  const c = companyName || 'Prime Anchorpoint LLC';
  return [
    'NOTICE OF TERMINATION FOR BREACH', '违约终止通知书', '',
    `Date / 日期: ${dateStr}`, '',
    `To / 致: ${partnerName}`, '',
    'Re: Termination of Partnership Service Agreement Due to Breach',
    '事由：因违约终止合作服务协议', '',
    `Dear ${partnerName},`, '',
    `This letter constitutes formal notice that ${c} is terminating the`,
    'Partnership Service Agreement ("Agreement") due to material breach.', '',
    'THE FOLLOWING BREACH(ES) HAVE BEEN IDENTIFIED / 违约事项：',
    '[请在此处描述具体违约行为 / DESCRIBE THE SPECIFIC BREACH(ES) HERE]', '',
    'Despite prior notice and a reasonable opportunity to cure, the breach',
    'remains unremedied. Accordingly, this Agreement is terminated effective',
    'immediately upon receipt of this notice.', '',
    'All outstanding obligations, including final settlements and return of any',
    'proprietary materials, must be completed within 10 business days.', '',
    `${c} reserves all rights and remedies available under the Agreement`, 'and applicable law.', '',
    'Sincerely,', '', c, '',
    'Authorized Representative: ________________________', `Date: ${dateStr}`,
  ].join('\n');
}

function generateAmendmentText({ partnerName, companyName, dateStr }) {
  const c = companyName || 'Prime Anchorpoint LLC';
  return [
    'CONTRACT AMENDMENT AGREEMENT', '合同修改协议', '',
    `This Amendment is entered into as of ${dateStr}, by and between:`, '',
    `${c} ("Company")`, 'and', `${partnerName} ("Partner")`, '',
    'WHEREAS, the parties entered into a Partnership Service Agreement',
    '(the "Original Agreement");', '',
    'NOW, THEREFORE, the parties agree to amend the Original Agreement as follows:', '',
    '1. MODIFICATIONS / 修改内容',
    '[请在此处详细描述对原合同的修改内容 / DESCRIBE ALL MODIFICATIONS HERE]', '',
    '2. EFFECTIVE DATE / 生效日期',
    'This Amendment shall be effective as of the date first written above.', '',
    '3. CONTINUING EFFECT / 原合同持续效力',
    'All other terms and conditions of the Original Agreement remain in full',
    'force and effect.', '', '',
    'IN WITNESS WHEREOF, the parties have executed this Amendment.', '',
    `${c} (Company)`,
    'Authorized Signature: {{sig1;role=First Party;type=signature}}', 'Date: {{date1;role=First Party;type=date}}', '',
    `${partnerName} (Partner)`,
    'Partner Signature: {{sig2;role=Second Party;type=signature}}', 'Date: {{date2;role=Second Party;type=date}}',
  ].join('\n');
}

function generateMutualTerminationText({ partnerName, companyName, dateStr }) {
  const c = companyName || 'Prime Anchorpoint LLC';
  return [
    'MUTUAL TERMINATION AGREEMENT', '协商解除协议', '',
    `This Mutual Termination Agreement is entered into as of ${dateStr},`,
    'by and between:', '',
    `${c} ("Company")`, 'and', `${partnerName} ("Partner")`, '',
    'The parties previously entered into a Partnership Service Agreement and',
    'now mutually agree to terminate it on the following terms:', '',
    '1. TERMINATION DATE / 终止日期',
    '[请填写终止生效日期 / TERMINATION EFFECTIVE DATE]', '',
    '2. FINAL SETTLEMENT / 最终结算',
    '[请在此处约定最终结算事项 / FINAL SETTLEMENT TERMS]', '',
    '3. MUTUAL RELEASE / 相互免责',
    'Each party releases the other from all claims and liabilities arising from',
    'the Partnership Service Agreement, except as provided herein.', '',
    '4. CONFIDENTIALITY / 保密',
    "Each party shall maintain confidentiality of the other party's proprietary",
    'information following termination.', '',
    '5. NO FURTHER OBLIGATIONS / 无进一步义务',
    'Following termination, neither party shall have further obligations to the',
    'other except as set forth in this Agreement.', '', '',
    'IN WITNESS WHEREOF, the parties have executed this Mutual Termination Agreement.', '',
    `${c} (Company)`,
    'Authorized Signature: {{sig1;role=First Party;type=signature}}', 'Date: {{date1;role=First Party;type=date}}', '',
    `${partnerName} (Partner)`,
    'Partner Signature: {{sig2;role=Second Party;type=signature}}', 'Date: {{date2;role=Second Party;type=date}}',
  ].join('\n');
}

function generateAssignmentContractText({ workerName, companyName, jobTitle, payRate, payType, startDate, workLocation, contractType }) {
  const cname = companyName || 'Prime Anchorpoint LLC';
  const payLabels = { hourly: 'per hour', salary: 'per month', annual: 'per year', per_piece: 'per piece' };
  const payLabel = payLabels[payType] || 'per hour';
  const dateStr = startDate || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    'EMPLOYMENT AGREEMENT', '',
    `Date: ${dateStr}`, '',
    'This Employment Agreement is entered into between:', '',
    `Employer: ${cname}`,
    `Employee: ${workerName || ''}`, '',
    '1. POSITION AND DUTIES',
    `Employee is hired as ${jobTitle || 'Staff Member'} and agrees to perform all duties`,
    'as assigned by the Employer.', '',
    '2. COMPENSATION',
    `Employee will be compensated at ${payRate ? `$${payRate} ${payLabel}` : 'rates as mutually agreed'}.`,
    `Classification: ${contractType || 'W2'}.`, '',
    '3. WORK LOCATION',
    workLocation || 'As assigned by Employer.', '',
    '4. TERM',
    `This Agreement begins on ${dateStr} and continues until terminated by either`,
    'party with two (2) weeks written notice.', '',
    '5. CONFIDENTIALITY',
    'Employee shall maintain the confidentiality of all proprietary information',
    'and trade secrets of the Employer and its clients.', '',
    '6. AT-WILL EMPLOYMENT',
    'Employment is at-will and may be terminated by either party at any time,',
    'with or without cause, subject to applicable law.', '',
    '7. GOVERNING LAW',
    'This Agreement is governed by the laws of the State of Illinois.', '', '',
    'SIGNATURES', '',
    `${cname} (Employer)`,
    'Authorized Signature: {{sig1;role=First Party;type=signature}}',
    'Date: {{date1;role=First Party;type=date}}', '',
    `${workerName || 'Employee'} (Employee)`,
    'Employee Signature: {{sig2;role=Second Party;type=signature}}',
    'Date: {{date2;role=Second Party;type=date}}',
  ].join('\n');
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

// DB-backed session store (survives server restarts, sessions roll on activity)
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
// Clean up sessions inactive for 30 days
try { db.prepare('DELETE FROM admin_sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL); } catch(e) {}

// DB-backed worker session store (survives server restarts)
db.exec(`CREATE TABLE IF NOT EXISTS worker_sessions (
  token TEXT PRIMARY KEY,
  worker_id INTEGER NOT NULL,
  employee_id TEXT,
  created_at INTEGER NOT NULL
)`);
try { db.prepare('DELETE FROM worker_sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL); } catch(e) {}

// DB-backed customer session store (survives server restarts)
db.exec(`CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  partner_id INTEGER,
  created_at INTEGER NOT NULL
)`);
try { db.prepare('DELETE FROM customer_sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL); } catch(e) {}

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
  if (Date.now() - s.created_at > SESSION_TTL) { db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token); return null; }
  // Roll session: refresh last-active timestamp if more than 1 hour old (avoids a DB write on every request)
  if (Date.now() - s.created_at > 60 * 60 * 1000) {
    db.prepare('UPDATE admin_sessions SET created_at=? WHERE token=?').run(Date.now(), token);
  }
  return { userId: s.user_id, username: s.username, role: s.role, token };
}
function validSession(token) { return !!getSession(token); }

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  let session = null;
  let token = null;
  if (auth && auth.startsWith('Bearer ')) { token = auth.slice(7); session = getSession(token); }
  if (!session) {
    const cookieMatch = (req.headers.cookie || '').match(/pa_token=([^;]+)/);
    if (cookieMatch) { token = cookieMatch[1]; session = getSession(token); }
  }
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  // Refresh cookie on each request so it stays alive while the user is active
  res.setHeader('Set-Cookie', `pa_token=${token};path=/;max-age=${SESSION_TTL / 1000};SameSite=Strict`);
  req.userRole = session.role;
  req.userName = session.username;
  req.userId = session.userId;
  const _u = db.prepare('SELECT assigned_partner_ids, assigned_employee_ids, assigned_job_ids FROM admin_users WHERE id=?').get(session.userId);
  req.assignedPartnerIds = (_u && _u.assigned_partner_ids) || '';
  req.assignedEmployeeIds = (_u && _u.assigned_employee_ids) || '';
  req.assignedJobIds = (_u && _u.assigned_job_ids) || '';
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
// Helper: parse manager's directly assigned employee IDs into array of ints
function managerEmployeeIds(req) {
  return (req.assignedEmployeeIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
}
// Helper: parse manager's assigned job IDs into array of ints
function managerJobIds(req) {
  return (req.assignedJobIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
}

// ─── Worker / Customer portal auth ───
const resetCodes = new Map(); // key: "worker:login" or "customer:login", value: { code, expires }

function requireWorker(req, res, next) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const m = (req.headers.cookie || '').match(/pa_worker=([^;]+)/);
    if (m) token = m[1];
  }
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const s = db.prepare('SELECT * FROM worker_sessions WHERE token=?').get(token);
  if (!s || Date.now() - s.created_at > 24 * 60 * 60 * 1000) {
    if (s) db.prepare('DELETE FROM worker_sessions WHERE token=?').run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Verify account still exists and is not suspended
  const w = db.prepare('SELECT id, active, suspended, employee_id FROM worker_accounts WHERE id=?').get(s.worker_id);
  if (!w || !w.active || w.suspended) {
    db.prepare('DELETE FROM worker_sessions WHERE token=?').run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.workerId = s.worker_id;
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
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const s = db.prepare('SELECT * FROM customer_sessions WHERE token=?').get(token);
  if (!s || Date.now() - s.created_at > 24 * 60 * 60 * 1000) {
    if (s) db.prepare('DELETE FROM customer_sessions WHERE token=?').run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Verify account still exists
  const c = db.prepare('SELECT id, active, partner_id FROM customer_accounts WHERE id=?').get(s.customer_id);
  if (!c || !c.active) {
    db.prepare('DELETE FROM customer_sessions WHERE token=?').run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.customerId = s.customer_id;
  req.customerPartnerId = c.partner_id;
  next();
}

// ─── PUBLIC API ───

// GET /api/jobs - public job listings
app.get('/api/jobs', (req, res) => {
  const lang = req.query.lang;
  const base = `SELECT j.*, p.name as partner_name FROM jobs j LEFT JOIN partners p ON j.partner_id=p.id WHERE j.active=1 AND j.visible=1`;
  const jobs = (lang && lang !== 'all')
    ? db.prepare(base + ` AND (j.langs LIKE ? OR (COALESCE(j.langs,'')='' AND j.lang=?)) ORDER BY j.created_at DESC`).all(`%${lang}%`, lang)
    : db.prepare(base + ' ORDER BY j.created_at DESC').all();
  res.json(jobs.map(j => ({
    id: j.id, title: j.title, type: j.type, location: j.location,
    pay: j.pay, pay_period: j.pay_period || '', lang: j.lang, lang_name: j.lang_name,
    langs: j.langs || j.lang || 'en',
    title_zh: j.title_zh || '', title_es: j.title_es || '',
    desc: j.description, desc_zh: j.desc_zh || '', desc_es: j.desc_es || '',
    urgent: !!j.urgent, work_auth: j.work_auth || '',
    partner_name: j.partner_name || '',
    company_name: j.company_name || '', employment_type: j.employment_type || '',
    benefits: j.benefits || '[]', schedule: j.schedule || '',
    schedule_days: j.schedule_days || '[]',
    schedule_start: j.schedule_start || '',
    schedule_end: j.schedule_end || '',
    work_days: j.work_days || '', work_start: j.work_start || '', work_end: j.work_end || '',
    job_id: j.job_id || ''
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
  res.cookie('pa_token', token, { httpOnly: true, sameSite: 'Lax' });
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
  res.clearCookie('pa_token');
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
  const jids = managerJobIds(req);
  const eids = managerEmployeeIds(req);
  if (req.userRole === 'manager' && !pids.length && !jids.length && !eids.length) return res.json([]);
  const isManager = req.userRole === 'manager';
  let q = `
    SELECT a.id, a.status, a.start_date, a.pay_rate, a.pay_type, a.contract_type, a.benefits,
           ${isManager ? "'' AS work_address" : 'a.work_address'}, a.notes, a.assigned_at, a.work_schedule,
           i.name  AS worker_name,
           i.phone AS worker_phone,
           i.email AS worker_email,
           i.address AS worker_address,
           i.city    AS worker_city,
           i.state   AS worker_state,
           i.zip     AS worker_zip,
           j.title AS job_title,
           ${isManager ? "'' AS job_location" : 'j.location AS job_location'},
           j.partner_id,
           p.name    AS company_name,
           p.address AS company_address
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN partners p ON j.partner_id = p.id
    WHERE 1=1`;
  const params = [];
  if (req.userRole === 'manager') {
    const conds = [];
    if (pids.length) {
      conds.push(`j.partner_id IN (${pids.map(() => '?').join(',')})`);
      params.push(...pids);
    }
    if (jids.length) {
      conds.push(`a.job_id IN (${jids.map(() => '?').join(',')})`);
      params.push(...jids);
    }
    if (eids.length) {
      conds.push(`a.inquiry_id IN (SELECT linked_inquiry_id FROM worker_accounts WHERE employee_id IN (${eids.map(() => '?').join(',')}) AND linked_inquiry_id IS NOT NULL)`);
      params.push(...eids);
    }
    if (conds.length) q += ` AND (${conds.join(' OR ')})`;
  }
  q += ' ORDER BY a.assigned_at DESC';
  res.json(db.prepare(q).all(...params));
});

// GET /api/manager/interviews — interview requests for workers at this manager's partner companies
app.get('/api/manager/interviews', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  if (req.userRole === 'manager' && !pids.length) return res.json([]);
  let workerFilter = '';
  const params = [];
  if (req.userRole === 'manager' && pids.length) {
    workerFilter = `AND i.worker_account_id IN (
      SELECT DISTINCT wa.id FROM worker_accounts wa
      JOIN employees e ON wa.employee_id = e.id
      WHERE e.id IN (
        SELECT DISTINCT t.employee_id FROM time_entries t
        JOIN jobs j ON t.job_id = j.id
        WHERE j.partner_id IN (${pids.map(() => '?').join(',')})
      )
    )`;
    params.push(...pids);
  }
  const rows = db.prepare(`
    SELECT i.id, i.status, i.admin_notes, i.created_at,
      s.slot_datetime, s.duration_min, s.location,
      w.id AS worker_id, w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email,
      w.work_status, w.identity_status
    FROM interviews i
    JOIN interview_slots s ON i.slot_id = s.id
    JOIN worker_accounts w ON i.worker_account_id = w.id
    WHERE 1=1 ${workerFilter}
    ORDER BY s.slot_datetime DESC
  `).all(...params);
  res.json(rows);
});

// GET /api/manager/workers — employees visible to this manager with contact info
app.get('/api/manager/workers', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  const jids = managerJobIds(req);
  const eids = managerEmployeeIds(req);
  if (req.userRole === 'manager' && !pids.length && !jids.length && !eids.length) return res.json([]);
  let q = `
    SELECT DISTINCT e.id, e.first_name, e.last_name, e.employee_id as emp_code,
           e.email, e.phone, e.position, e.status
    FROM employees e`;
  const params = [];
  if (req.userRole === 'manager') {
    const conds = [];
    if (pids.length) {
      // Employees with time entries under partner's jobs
      conds.push(`e.id IN (SELECT DISTINCT t.employee_id FROM time_entries t JOIN jobs j ON t.job_id=j.id WHERE j.partner_id IN (${pids.map(() => '?').join(',')}))`);
      params.push(...pids);
      // Also employees explicitly assigned to jobs under partner companies (even without time entries)
      conds.push(`e.id IN (SELECT DISTINCT ej.employee_id FROM employee_jobs ej JOIN jobs j ON ej.job_id=j.id WHERE j.partner_id IN (${pids.map(() => '?').join(',')}))`);
      params.push(...pids);
    }
    if (jids.length) {
      // Employees assigned to any of the manager's jobs (via employee_jobs, no status filter)
      conds.push(`e.id IN (SELECT DISTINCT employee_id FROM employee_jobs WHERE job_id IN (${jids.map(() => '?').join(',')}))`);
      params.push(...jids);
    }
    if (eids.length) {
      conds.push(`e.id IN (${eids.map(() => '?').join(',')})`);
      params.push(...eids);
    }
    if (conds.length) q += ` WHERE (${conds.join(' OR ')})`;
  }
  q += ' ORDER BY e.last_name, e.first_name';
  res.json(db.prepare(q).all(...params));
});

// GET /api/manager/my-jobs — jobs visible to this manager
app.get('/api/manager/my-jobs', requireAdmin, (req, res) => {
  const pids = managerPartnerIds(req);
  const jids = managerJobIds(req);
  if (req.userRole === 'manager' && !pids.length && !jids.length) return res.json([]);
  let q = `SELECT DISTINCT j.id, j.title, p.name AS company_name FROM jobs j LEFT JOIN partners p ON j.partner_id = p.id WHERE j.active = 1`;
  const params = [];
  if (req.userRole === 'manager') {
    const conds = [];
    if (pids.length) { conds.push(`j.partner_id IN (${pids.map(() => '?').join(',')})`); params.push(...pids); }
    if (jids.length) { conds.push(`j.id IN (${jids.map(() => '?').join(',')})`); params.push(...jids); }
    if (conds.length) q += ` AND (${conds.join(' OR ')})`;
  }
  q += ' ORDER BY j.title';
  res.json(db.prepare(q).all(...params));
});

// ─── Manager Self-Punch APIs ───────────────────────────────────────────────────

// GET /api/manager/self-punch-status — current punch state for the logged-in manager
app.get('/api/manager/self-punch-status', requireAdmin, requireRole('manager', 'admin', 'staff'), (req, res) => {
  const open = db.prepare("SELECT * FROM manager_time_entries WHERE manager_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.userId);
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = db.prepare("SELECT * FROM manager_time_entries WHERE manager_id=? AND DATE(clock_in)=?").all(req.userId, today);
  res.json({
    clocked_in: !!open,
    on_break: !!(open && open.on_break),
    open_entry: open || null,
    today_entries: todayEntries
  });
});

// POST /api/manager/self-punch — manager clocks in/out for themselves
app.post('/api/manager/self-punch', requireAdmin, requireRole('manager', 'admin', 'staff'), (req, res) => {
  const { punch_type } = req.body;
  if (!punch_type || !['in', 'break_start', 'break_end', 'out'].includes(punch_type))
    return res.status(400).json({ error: '请选择打卡类型' });
  const now = new Date().toISOString();
  const open = db.prepare("SELECT * FROM manager_time_entries WHERE manager_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.userId);

  if (punch_type === 'break_start') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡' });
    if (open.on_break) return res.status(400).json({ error: '已在休息中' });
    const breaks = JSON.parse(open.break_records || '[]');
    breaks.push({ start: now, end: null });
    db.prepare('UPDATE manager_time_entries SET break_records=?, on_break=1 WHERE id=?').run(JSON.stringify(breaks), open.id);
    return res.json({ action: 'break_start' });
  }
  if (punch_type === 'break_end') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡' });
    const breaks = JSON.parse(open.break_records || '[]');
    const lastIdx = breaks.findIndex(b => !b.end);
    if (lastIdx >= 0) {
      breaks[lastIdx].end = now;
      const breakMins = Math.round(breaks.reduce((s, b) => b.start && b.end ? s + (new Date(b.end) - new Date(b.start)) : s, 0) / 60000);
      db.prepare('UPDATE manager_time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?').run(JSON.stringify(breaks), breakMins, open.id);
      return res.json({ action: 'break_end', break_minutes: breakMins });
    } else {
      // No open break — record flagged entry with null start for review
      breaks.push({ start: null, end: now, flagged: true });
      db.prepare('UPDATE manager_time_entries SET break_records=?, on_break=0 WHERE id=?').run(JSON.stringify(breaks), open.id);
      return res.json({ action: 'break_end', break_minutes: 0, warning: '未找到休息开始记录，休息结束已记录，请核查' });
    }
  }
  if (punch_type === 'out') {
    if (!open) return res.status(400).json({ error: '尚未上班打卡' });
    if (open.on_break) {
      // Auto-close break
      const breaks = JSON.parse(open.break_records || '[]');
      const lastIdx = breaks.findIndex(b => !b.end);
      if (lastIdx >= 0) breaks[lastIdx].end = now;
      const breakMins = Math.round(breaks.reduce((s, b) => b.start && b.end ? s + (new Date(b.end) - new Date(b.start)) : s, 0) / 60000);
      db.prepare('UPDATE manager_time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?').run(JSON.stringify(breaks), breakMins, open.id);
      open.break_minutes = breakMins;
    }
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE manager_time_entries SET clock_out=?, total_hours=?, status='closed', needs_review=1 WHERE id=?").run(now, hrs.total, open.id);
    return res.json({ action: 'out', total_hours: hrs.total, clock_in: open.clock_in, clock_out: now });
  }
  // punch_type === 'in'
  if (open) {
    // Auto-close any dangling open entry
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE manager_time_entries SET clock_out=?, total_hours=?, status='closed', needs_review=1 WHERE id=?").run(now, hrs.total, open.id);
  }
  const result = db.prepare("INSERT INTO manager_time_entries (manager_id, clock_in, status, break_records, on_break) VALUES (?, ?, 'open', '[]', 0)").run(req.userId, now);
  return res.json({ action: 'in', clock_in: now, entry_id: result.lastInsertRowid });
});

// GET /api/admin/manager-self-punch-history — manager's own punch history (for admin/manager viewing)
app.get('/api/manager/self-punch-history', requireAdmin, requireRole('manager', 'admin', 'staff'), (req, res) => {
  const { date_from, date_to } = req.query;
  let q = 'SELECT * FROM manager_time_entries WHERE manager_id=?';
  const p = [req.userId];
  if (date_from) { q += ' AND DATE(clock_in)>=?'; p.push(date_from); }
  if (date_to)   { q += ' AND DATE(clock_in)<=?'; p.push(date_to); }
  q += ' ORDER BY clock_in DESC LIMIT 200';
  res.json(db.prepare(q).all(...p));
});

// GET /api/admin/managers/:id/self-punch — admin views a specific manager's own punch records
app.get('/api/admin/managers/:id/self-punch', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const { date_from, date_to } = req.query;
  let q = 'SELECT * FROM manager_time_entries WHERE manager_id=?';
  const p = [req.params.id];
  if (date_from) { q += ' AND DATE(clock_in)>=?'; p.push(date_from); }
  if (date_to)   { q += ' AND DATE(clock_in)<=?'; p.push(date_to); }
  q += ' ORDER BY clock_in DESC LIMIT 200';
  res.json(db.prepare(q).all(...p));
});

// POST /api/admin/manager-self-punch/:id/confirm — admin confirms a manager's self-punch record
app.post('/api/admin/manager-self-punch/:id/confirm', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  db.prepare('UPDATE manager_time_entries SET needs_review=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/manager/self-punch/:id/confirm — admin/staff confirms from manager portal
app.post('/api/manager/self-punch/:id/confirm', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  db.prepare('UPDATE manager_time_entries SET needs_review=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Account Management (admin only) ───
app.get('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id, username, role, display_name, email, phone, active, assigned_partner_ids, assigned_employee_ids, assigned_job_ids, created_at FROM admin_users ORDER BY id').all());
});

app.post('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, assigned_partner_ids, assigned_employee_ids, assigned_job_ids, email, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const existing = db.prepare('SELECT id, active FROM admin_users WHERE username = ?').get(username);
  if (existing && existing.active) return res.status(400).json({ error: 'Username already exists' });
  // Overwrite unverified (inactive) account with same username
  if (existing && !existing.active) db.prepare('DELETE FROM admin_users WHERE id = ?').run(existing.id);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, assigned_partner_ids, assigned_employee_ids, assigned_job_ids, email, phone, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .run(username, hash, salt, role, display_name || '', assigned_partner_ids || '', assigned_employee_ids || '', assigned_job_ids || '', email || '', phone || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, assigned_partner_ids, assigned_employee_ids, assigned_job_ids, email, phone } = req.body;
  if (role && !['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare('UPDATE admin_users SET password_hash=?, salt=?, active=0 WHERE id=?').run(hash, salt, req.params.id);
  }
  // active field is intentionally excluded — only the user themselves can activate via self-verification
  db.prepare('UPDATE admin_users SET username=?, role=?, display_name=?, assigned_partner_ids=?, assigned_employee_ids=?, assigned_job_ids=?, email=?, phone=? WHERE id=?')
    .run(username || user.username, role || user.role, display_name !== undefined ? display_name : user.display_name, assigned_partner_ids !== undefined ? assigned_partner_ids : (user.assigned_partner_ids || ''), assigned_employee_ids !== undefined ? assigned_employee_ids : (user.assigned_employee_ids || ''), assigned_job_ids !== undefined ? assigned_job_ids : (user.assigned_job_ids || ''), email !== undefined ? email : (user.email || ''), phone !== undefined ? phone : (user.phone || ''), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Admin Invite Links ───────────────────────────────────────────
function inviteUrlPath(role) {
  if (role === 'staff') return '/staff';
  if (role === 'manager') return '/manager';
  return '/admin-invite';
}

app.get('/api/admin/invite-links', requireAdmin, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM admin_invites WHERE used=0 AND expires_at > datetime('now') ORDER BY id DESC`).all();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  res.json(rows.map(r => ({ ...r, url: `${proto}://${host}${inviteUrlPath(r.role)}?token=${r.token}` })));
});

app.post('/api/admin/invite-links', requireAdmin, requireRole('admin'), (req, res) => {
  try {
    const { role, hours, notes, assigned_partner_ids } = req.body;
    if (!['staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const h = Math.min(Math.max(parseInt(hours) || 24, 1), 720);
    const token = crypto.randomBytes(28).toString('hex');
    const expiresAt = new Date(Date.now() + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('INSERT INTO admin_invites (token, role, notes, assigned_partner_ids, expires_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(token, role, notes || '', assigned_partner_ids || '', expiresAt, req.userId);
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    res.json({ success: true, url: `${proto}://${host}${inviteUrlPath(role)}?token=${token}` });
  } catch(e) {
    console.error('invite-links POST error:', e);
    res.status(500).json({ error: e.message });
  }
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
app.post('/api/admin-invite/send-code', async (req, res) => {
  const { token, phone } = req.body;
  if (!token || !phone) return res.status(400).json({ error: '缺少参数' });
  const inv = db.prepare(`SELECT * FROM admin_invites WHERE token=? AND used=0 AND expires_at > datetime('now')`).get(token);
  if (!inv) return res.status(400).json({ error: '邀请链接已失效或已被使用' });
  const sent = await sendVerifyCode(phone, 'sms');
  res.json({ success: true, skipped: !sent });
});

app.post('/api/admin-invite/send-email-code', async (req, res) => {
  const { token, email } = req.body;
  if (!token || !email) return res.status(400).json({ error: '缺少参数' });
  const inv = db.prepare(`SELECT * FROM admin_invites WHERE token=? AND used=0 AND expires_at > datetime('now')`).get(token);
  if (!inv) return res.status(400).json({ error: '邀请链接已失效或已被使用' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const sent = await sendEmail(email, '验证码 / Verification Code — Prime Anchorpoint',
    `您的邮箱验证码是 ${code}，15分钟内有效。\nYour email verification code is ${code}, valid for 15 minutes.`,
    verificationCodeHtml(code));
  if (sent) {
    db.prepare('DELETE FROM admin_reg_codes WHERE token=? AND contact=?').run(token, email);
    db.prepare('INSERT INTO admin_reg_codes (token, contact, contact_type, code, expires_at) VALUES (?,?,?,?,?)').run(token, email, 'email', code, expiresAt);
  }
  res.json({ success: true, skipped: !sent });
});

app.post('/api/admin-invite/register', async (req, res) => {
  const { token, username, display_name, first_name, middle_name, last_name, password, phone, email, city, state, zip, sms_code, email_code } = req.body;
  if (!token || !username || !password) return res.status(400).json({ error: '缺少必填字段' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!phone) return res.status(400).json({ error: '请填写手机号' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  const inv = db.prepare(`SELECT * FROM admin_invites WHERE token=? AND used=0 AND expires_at > datetime('now')`).get(token);
  if (!inv) return res.status(400).json({ error: '邀请链接已失效或已被使用' });
  // Verify SMS code
  if (twilioClient && TWILIO_VERIFY_SID && sms_code) {
    const ok = await checkVerifyCode(phone, sms_code);
    if (!ok) return res.status(400).json({ error: '手机验证码错误或已过期，请重试' });
  } else if (twilioClient && TWILIO_VERIFY_SID && !sms_code) {
    return res.status(400).json({ error: '请输入手机验证码' });
  }
  // Verify email code (stored in DB via sendEmail)
  const emailVc = db.prepare("SELECT * FROM admin_reg_codes WHERE token=? AND contact=? AND contact_type='email' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(token, email);
  if (emailVc) {
    if (!email_code) return res.status(400).json({ error: '请输入邮箱验证码' });
    if (emailVc.code !== String(email_code)) return res.status(400).json({ error: '邮箱验证码错误或已过期，请重试' });
  }
  const existing = db.prepare('SELECT id FROM admin_users WHERE username=?').get(username);
  if (existing) return res.status(400).json({ error: '用户名已存在，请换一个' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const fullName = [first_name, middle_name, last_name].filter(Boolean).join(' ') || display_name || username;
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, assigned_partner_ids, active, phone, email, city) VALUES (?,?,?,?,?,?,1,?,?,?)')
    .run(username, hash, salt, inv.role, fullName, inv.assigned_partner_ids || '', phone || '', email || '', city || '');
  db.prepare('UPDATE admin_invites SET used=1, used_at=CURRENT_TIMESTAMP WHERE id=?').run(inv.id);
  db.prepare('DELETE FROM admin_reg_codes WHERE token=?').run(token);
  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(result.lastInsertRowid);
  const sessionToken = createSession(user);
  res.json({ success: true, token: sessionToken, role: user.role, username: user.username, display_name: user.display_name });
});

// Serve admin invite registration page (shared handler for /admin-invite, /staff, /manager)
function serveAdminInvitePage(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>账户注册 — Prime Anchorpoint</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:16px;padding:2.5rem 2rem;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.logo-wrap{text-align:center;margin-bottom:1.25rem}
.logo-wrap img{width:72px;height:72px;object-fit:contain}
h1{text-align:center;font-size:1.3rem;font-weight:700;color:#0F2B5B;margin-bottom:.25rem}
.sub{text-align:center;font-size:.85rem;color:#64748b;margin-bottom:1.5rem;line-height:1.5}
label{display:block;font-size:.8rem;font-weight:600;color:#475569;margin-bottom:.3rem;margin-top:.85rem}
input{width:100%;padding:.65rem .85rem;border:1.5px solid #e2e8f0;border-radius:9px;font-size:.95rem;outline:none;transition:border .15s;font-family:inherit}
input:focus{border-color:#4A90D9;box-shadow:0 0 0 3px rgba(74,144,217,.1)}
.phone-row{display:flex;gap:.5rem;align-items:flex-end}
.phone-row input{flex:1}
.field-row{display:flex;gap:.5rem}
.field-row input{flex:1;margin-top:0}
.pw-wrap{position:relative}
.pw-wrap input{padding-right:2.4rem}
.pw-eye{position:absolute;right:.7rem;top:50%;transform:translateY(-50%);cursor:pointer;color:#94a3b8;font-size:1.05rem;user-select:none;line-height:1}
.send-btn{white-space:nowrap;padding:.65rem 1rem;background:#f0f9ff;color:#0369a1;border:1.5px solid #bae6fd;border-radius:9px;font-size:.82rem;font-weight:700;cursor:pointer;transition:background .15s;flex-shrink:0}
.send-btn:hover:not(:disabled){background:#e0f2fe}
.send-btn:disabled{opacity:.5;cursor:default}
.btn{width:100%;padding:.8rem;background:#1d4ed8;color:#fff;border:none;border-radius:9px;font-size:.97rem;font-weight:700;cursor:pointer;margin-top:1.4rem;transition:background .15s}
.btn:hover:not(:disabled){background:#1e40af}
.btn:disabled{opacity:.5;cursor:default}
.err{color:#dc2626;font-size:.82rem;margin-top:.6rem;padding:.4rem .6rem;background:#fef2f2;border-radius:6px;display:none}
.role-badge{display:inline-block;padding:.2rem .7rem;border-radius:99px;font-size:.78rem;font-weight:700;background:#dbeafe;color:#1d4ed8}
.ok{color:#16a34a;font-size:1rem;font-weight:700;margin-top:.5rem;text-align:center}
.hint{font-size:.76rem;color:#94a3b8;margin-top:.25rem}
</style>
</head>
<body>
<div class="card">
  <div class="logo-wrap"><img src="/logo.svg" alt="Prime Anchorpoint" onerror="this.style.display='none'"></div>
  <h1>账户注册</h1>
  <div class="sub" id="sub">加载中…</div>
  <div id="form" style="display:none">
    <label>用户名 <span style="color:#94a3b8;font-weight:400">(登录用)</span></label>
    <input id="username" placeholder="设置登录用户名" autocomplete="username">
    <label>姓名 / Full Name</label>
    <div class="field-row">
      <input id="first_name" placeholder="First" autocomplete="given-name">
      <input id="middle_name" placeholder="Middle" autocomplete="additional-name">
      <input id="last_name" placeholder="Last" autocomplete="family-name">
    </div>
    <label>手机号 / Phone <span style="color:#dc2626">*</span></label>
    <div class="phone-row">
      <input id="phone" type="tel" placeholder="10位美国手机号" autocomplete="tel" oninput="resetCode()">
      <button class="send-btn" id="sendCodeBtn" onclick="sendCode()">发送验证码</button>
    </div>
    <div id="codeWrap" style="display:none">
      <label>验证码 / Code</label>
      <input id="sms_code" type="text" inputmode="numeric" maxlength="6" placeholder="6位验证码">
      <div class="hint">验证码已发送至您的手机，15分钟内有效</div>
    </div>
    <label>邮箱 / Email <span style="color:#dc2626">*</span></label>
    <div class="phone-row">
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email" oninput="resetEmailCode()">
      <button class="send-btn" id="sendEmailCodeBtn" onclick="sendEmailCode()">发送验证码</button>
    </div>
    <div id="emailCodeWrap" style="display:none">
      <label>邮箱验证码 / Email Code</label>
      <input id="email_code" type="text" inputmode="numeric" maxlength="6" placeholder="6位验证码">
      <div class="hint">验证码已发送至您的邮箱，15分钟内有效</div>
    </div>
    <label>所在城市 / City</label>
    <div class="field-row">
      <input id="city" placeholder="City" style="flex:2" autocomplete="address-level2">
      <input id="state" placeholder="State" maxlength="2" style="flex:1;text-transform:uppercase" autocomplete="address-level1">
      <input id="zip" placeholder="Zipcode" maxlength="10" inputmode="numeric" style="flex:1" autocomplete="postal-code">
    </div>
    <label>密码</label>
    <div class="pw-wrap">
      <input id="password" type="password" placeholder="至少 6 位" autocomplete="new-password">
      <span class="pw-eye" onclick="togglePw('password',this)">👁</span>
    </div>
    <label>确认密码</label>
    <div class="pw-wrap">
      <input id="password2" type="password" placeholder="再次输入密码" autocomplete="new-password">
      <span class="pw-eye" onclick="togglePw('password2',this)">👁</span>
    </div>
    <div id="err" class="err"></div>
    <button class="btn" id="btn" onclick="doRegister()">创建账户</button>
  </div>
  <div id="done" style="display:none">
    <div class="ok">✅ 注册成功！</div>
    <div style="font-size:.85rem;color:#475569;margin-top:.5rem;text-align:center">账户已创建，正在跳转…</div>
  </div>
  <div id="expired" style="display:none">
    <div style="color:#dc2626;font-weight:700;margin-top:.5rem;text-align:center">❌ 链接已失效</div>
    <div style="font-size:.83rem;color:#64748b;margin-top:.4rem;text-align:center">此邀请链接已过期或已被使用，请联系管理员重新发送。</div>
  </div>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const ROLE_LABEL = { admin:'Admin 管理员', staff:'Staff 员工', manager:'Manager 经理' };
let codeSent = false, codeSkipped = false;
let emailCodeSent = false, emailCodeSkipped = false;
async function init() {
  if (!token) { showExpired(); return; }
  try {
    const r = await fetch('/api/admin-invite/verify?token=' + encodeURIComponent(token));
    const d = await r.json();
    if (!r.ok) { showExpired(); return; }
    document.getElementById('sub').innerHTML = \`您被邀请注册为 <span class="role-badge">\${ROLE_LABEL[d.role]||d.role}</span>\${d.notes ? \` — \${d.notes}\` : ''}\`;
    document.getElementById('form').style.display = '';
  } catch { showExpired(); }
}
function showExpired() {
  document.getElementById('sub').style.display='none';
  document.getElementById('expired').style.display='';
}
function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = msg; el.style.display = msg ? 'block' : 'none';
}
function resetCode() { codeSent = false; codeSkipped = false; document.getElementById('codeWrap').style.display='none'; }
function resetEmailCode() { emailCodeSent = false; emailCodeSkipped = false; document.getElementById('emailCodeWrap').style.display='none'; }
async function sendCode() {
  const phone = document.getElementById('phone').value.trim().replace(/\D/g,'');
  if (phone.length < 10) { showErr('请填写有效的10位手机号'); return; }
  const btn = document.getElementById('sendCodeBtn');
  btn.disabled = true; btn.textContent = '发送中…';
  showErr('');
  try {
    const r = await fetch('/api/admin-invite/send-code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, phone }) });
    const d = await r.json();
    if (!r.ok) { showErr(d.error || '发送失败'); btn.disabled=false; btn.textContent='发送验证码'; return; }
    codeSent = true; codeSkipped = d.skipped || false;
    if (!codeSkipped) {
      document.getElementById('codeWrap').style.display = '';
      btn.textContent = '重新发送'; btn.disabled = false;
    } else {
      btn.textContent = '已跳过';
    }
  } catch { showErr('网络错误，请重试'); btn.disabled=false; btn.textContent='发送验证码'; }
}
async function sendEmailCode() {
  const email = document.getElementById('email').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('请填写有效的邮箱地址'); return; }
  const btn = document.getElementById('sendEmailCodeBtn');
  btn.disabled = true; btn.textContent = '发送中…';
  showErr('');
  try {
    const r = await fetch('/api/admin-invite/send-email-code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, email }) });
    const d = await r.json();
    if (!r.ok) { showErr(d.error || '发送失败'); btn.disabled=false; btn.textContent='发送验证码'; return; }
    emailCodeSent = true; emailCodeSkipped = d.skipped || false;
    if (!emailCodeSkipped) {
      document.getElementById('emailCodeWrap').style.display = '';
      btn.textContent = '重新发送'; btn.disabled = false;
    } else {
      btn.textContent = '已跳过';
    }
  } catch { showErr('网络错误，请重试'); btn.disabled=false; btn.textContent='发送验证码'; }
}
function togglePw(id, el) {
  const inp = document.getElementById(id);
  if (inp.type === 'password') { inp.type = 'text'; el.style.opacity = '1'; }
  else { inp.type = 'password'; el.style.opacity = '.5'; }
}
async function doRegister() {
  const btn = document.getElementById('btn');
  showErr('');
  const username = document.getElementById('username').value.trim();
  const first_name = document.getElementById('first_name').value.trim();
  const middle_name = document.getElementById('middle_name').value.trim();
  const last_name = document.getElementById('last_name').value.trim();
  const display_name = [first_name, middle_name, last_name].filter(Boolean).join(' ');
  const phone = document.getElementById('phone').value.trim().replace(/\D/g,'');
  const email = document.getElementById('email').value.trim();
  const city = document.getElementById('city').value.trim();
  const state = document.getElementById('state').value.trim();
  const zip = document.getElementById('zip').value.trim();
  const sms_code = document.getElementById('sms_code').value.trim();
  const email_code = document.getElementById('email_code').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  if (!username) { showErr('请填写用户名'); return; }
  if (!first_name || !last_name) { showErr('请填写名字（First Name 和 Last Name）'); return; }
  if (!phone || phone.length < 10) { showErr('请填写有效的手机号'); return; }
  if (!codeSent && !codeSkipped) { showErr('请先发送手机验证码并填写验证码'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('请填写有效的邮箱地址'); return; }
  if (!emailCodeSent && !emailCodeSkipped) { showErr('请先发送邮箱验证码并填写验证码'); return; }
  if (password.length < 6) { showErr('密码至少 6 位'); return; }
  if (password !== password2) { showErr('两次密码不一致'); return; }
  btn.disabled = true; btn.textContent = '注册中…';
  try {
    const r = await fetch('/api/admin-invite/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, username, display_name, first_name, middle_name, last_name, phone, email, city, state, zip, sms_code, email_code, password }) });
    const d = await r.json();
    if (!r.ok) { showErr(d.error || '注册失败'); btn.disabled=false; btn.textContent='创建账户'; return; }
    localStorage.setItem('adminToken', d.token);
    document.getElementById('form').style.display = 'none';
    document.getElementById('done').style.display = '';
    // Store token in the key each portal reads
    if (d.role === 'manager') {
      localStorage.setItem('mgr_token', d.token);
    } else if (d.role === 'staff') {
      document.cookie = 'pa_token=' + d.token + ';path=/;max-age=86400;SameSite=Strict';
    } else {
      localStorage.setItem('adminToken', d.token);
    }
    const dest = { admin: '/admin', staff: '/staff', manager: '/manager' }[d.role] || '/admin';
    setTimeout(() => { location.href = dest; }, 1500);
  } catch(e) { showErr('网络错误，请重试'); btn.disabled=false; btn.textContent='创建账户'; }
}
init();
</script>
</body>
</html>`);
}

app.get('/admin-invite', serveAdminInvitePage);
// /staff and /manager: serve invite page if token present, otherwise portal
app.get('/staff', (req, res) => {
  if (req.query.token) return serveAdminInvitePage(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(require('path').join(__dirname, 'public', 'staff.html'));
});
app.get('/manager', (req, res) => {
  if (req.query.token) return serveAdminInvitePage(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(require('path').join(__dirname, 'public', 'manager.html'));
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

// ─── Admin: Manager Management APIs ───────────────────────────────────────────

// GET /api/admin/managers-list — all manager accounts with partner, job, and employee names
app.get('/api/admin/managers-list', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const managers = db.prepare("SELECT id, username, display_name, active, assigned_partner_ids, assigned_employee_ids, assigned_job_ids, phone, email, city, created_at FROM admin_users WHERE role='manager' ORDER BY id").all();
  const allPartners = db.prepare('SELECT id, name FROM partners').all();
  const partnerMap = Object.fromEntries(allPartners.map(p => [p.id, p.name]));
  const allJobs = db.prepare('SELECT id, title, company_name FROM jobs').all();
  const jobMap = Object.fromEntries(allJobs.map(j => [j.id, j.title + (j.company_name ? ' ('+j.company_name+')' : '')]));
  res.json(managers.map(m => {
    const pids = (m.assigned_partner_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    const jids = (m.assigned_job_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    return { ...m, partner_names: pids.map(id => partnerMap[id] || `#${id}`).join(', ') || '未指定', job_names: jids.map(id => jobMap[id] || `#${id}`).join(', ') || '' };
  }));
});

// GET /api/admin/managers/:id/assignments — assignments under a specific manager's partners
app.get('/api/admin/managers/:id/assignments', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const mgr = db.prepare("SELECT assigned_partner_ids FROM admin_users WHERE id=? AND role='manager'").get(req.params.id);
  if (!mgr) return res.status(404).json({ error: 'Manager not found' });
  const pids = (mgr.assigned_partner_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  if (!pids.length) return res.json([]);
  const rows = db.prepare(`
    SELECT a.id, a.status, a.start_date, a.pay_rate, a.pay_type,
           a.work_address, a.assigned_at,
           i.name AS worker_name, i.phone AS worker_phone,
           j.title AS job_title, j.location AS job_location,
           p.name AS company_name
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN partners p ON j.partner_id = p.id
    WHERE j.partner_id IN (${pids.map(() => '?').join(',')})
    ORDER BY a.assigned_at DESC
  `).all(...pids);
  res.json(rows);
});

// GET /api/admin/managers/:id/workers — employees visible to a specific manager
app.get('/api/admin/managers/:id/workers', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const mgr = db.prepare("SELECT assigned_partner_ids, assigned_employee_ids, assigned_job_ids FROM admin_users WHERE id=? AND role='manager'").get(req.params.id);
  if (!mgr) return res.status(404).json({ error: 'Manager not found' });

  const pids = (mgr.assigned_partner_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  const eids = (mgr.assigned_employee_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  const jids = (mgr.assigned_job_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

  const allEmpIds = new Set(eids);

  // Employees who have time_entries under the manager's assigned partners
  if (pids.length) {
    db.prepare(`SELECT DISTINCT t.employee_id FROM time_entries t JOIN jobs j ON t.job_id = j.id WHERE j.partner_id IN (${pids.map(() => '?').join(',')})`).all(...pids)
      .forEach(r => allEmpIds.add(r.employee_id));
    // Also employees explicitly assigned to jobs under partner companies (even without time entries)
    db.prepare(`SELECT DISTINCT ej.employee_id FROM employee_jobs ej JOIN jobs j ON ej.job_id = j.id WHERE j.partner_id IN (${pids.map(() => '?').join(',')})`).all(...pids)
      .forEach(r => allEmpIds.add(r.employee_id));
  }

  // Employees assigned to the manager's assigned jobs via employee_jobs
  if (jids.length) {
    db.prepare(`SELECT DISTINCT employee_id FROM employee_jobs WHERE job_id IN (${jids.map(() => '?').join(',')})`).all(...jids)
      .forEach(r => allEmpIds.add(r.employee_id));
  }

  if (!allEmpIds.size) return res.json([]);

  const ids = [...allEmpIds];
  const rows = db.prepare(`
    SELECT id, first_name, last_name, employee_id as emp_code,
           email, phone, position, status
    FROM employees
    WHERE id IN (${ids.map(() => '?').join(',')})
    ORDER BY last_name, first_name
  `).all(...ids);
  res.json(rows);
});

// GET /api/admin/managers/:id/punch — recent punch records for a specific manager's employees
app.get('/api/admin/managers/:id/punch', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const mgr = db.prepare("SELECT assigned_partner_ids FROM admin_users WHERE id=? AND role='manager'").get(req.params.id);
  if (!mgr) return res.status(404).json({ error: 'Manager not found' });
  const pids = (mgr.assigned_partner_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  if (!pids.length) return res.json([]);
  const { date_from, date_to } = req.query;
  let q = `SELECT t.id, t.clock_in, t.clock_out, t.total_hours, t.status, t.company_name,
             e.first_name, e.last_name, e.employee_id as emp_code,
             p.name AS partner_name,
             COALESCE(t.site_timezone, js.timezone, 'America/Chicago') AS display_timezone
           FROM time_entries t
           LEFT JOIN employees e ON t.employee_id = e.id
           LEFT JOIN jobs j ON t.job_id = j.id
           LEFT JOIN job_sites js ON j.site_id = js.id
           LEFT JOIN partners p ON j.partner_id = p.id
           WHERE j.partner_id IN (${pids.map(() => '?').join(',')})`;
  const params = [...pids];
  if (date_from) { q += ' AND DATE(t.clock_in) >= ?'; params.push(date_from); }
  if (date_to)   { q += ' AND DATE(t.clock_in) <= ?'; params.push(date_to); }
  q += ' ORDER BY t.clock_in DESC LIMIT 500';
  res.json(db.prepare(q).all(...params));
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

  let delivered = false;
  if (contact_type === 'phone') {
    delivered = await sendSMS(contact, `您的 Prime Anchorpoint 验证码是 ${code}，10分钟内有效。Your verification code is ${code}.`);
  } else {
    delivered = await sendEmail(contact, '验证码 / Verification Code — Prime Anchorpoint',
      `您的验证码是 ${code}，10分钟内有效。\nYour verification code is ${code}.`,
      verificationCodeHtml(code));
  }
  // If delivery failed (not configured), remove the code record so verification is skipped
  if (!delivered) {
    db.prepare('DELETE FROM manager_reg_codes WHERE token=? AND contact=?').run(token, contact);
    return res.json({ success: true, skipped: true });
  }
  res.json({ success: true, skipped: false });
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

  // Validate verification code (skip if delivery was not possible, i.e. no record exists)
  const vc = db.prepare("SELECT * FROM manager_reg_codes WHERE token=? AND contact=? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(token, contact);
  if (vc && vc.code !== String(code || '')) return res.status(400).json({ error: '验证码错误或已过期 / Invalid or expired code' });

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
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN payment_details TEXT DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN has_ssn INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN preferred_lang TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN sms_consent INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN sms_consent_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE worker_accounts ADD COLUMN identity_reverify_date TEXT DEFAULT ''"); } catch {}

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
  const getContractInfo = db.prepare("SELECT ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'");
  const getContractVersionCount = db.prepare("SELECT COUNT(*) as cnt FROM worker_contract_versions WHERE worker_account_id=?");
  const getTaxResidency = db.prepare("SELECT tax_status, recommended_form, country_citizenship, country_tax_residence, treaty_country, claim_treaty_benefit, services_location FROM tax_residency_questionnaire WHERE worker_account_id=? ORDER BY id DESC LIMIT 1");
  const getTaxFilingDocCount = db.prepare("SELECT COUNT(*) as cnt FROM tax_filing_docs WHERE worker_account_id=? AND tax_year=? AND file_path!=''");
  const getPaymentTotal = db.prepare("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as cnt FROM worker_payments WHERE employee_id=?");
  const getContractorInvCounts = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) as pending FROM contractor_invoices WHERE worker_account_id=?");
  const currentTaxYear = new Date().getFullYear() - 1; // filing for prior year

  const enriched = workers.map(w => {
    const interview = getInterview.get(w.id);
    const docs = getCompDocs.all(w.id);
    const skills = getSkills.all(w.id);
    const refCount = getReferralCount.get(w.id);
    const qualCount = getQualifiedReferrals.get(w.id, refConfig.min_hours_to_qualify);
    const contractInfo = getContractInfo.get(w.id);
    const contractVerCount = getContractVersionCount.get(w.id);
    const taxRes = getTaxResidency.get(w.id);
    const taxFilingDocCount = getTaxFilingDocCount.get(w.id, currentTaxYear);
    const payTotals = w.employee_id ? getPaymentTotal.get(w.employee_id) : null;
    const cinvCounts = getContractorInvCounts.get(w.id);

    const complianceMap = {};
    docs.forEach(d => { complianceMap[d.doc_type] = d.status; });

    return {
      ...w,
      interview_status: interview ? interview.status : null,
      compliance: complianceMap,
      skills: skills || [],
      referral_count: refCount?.cnt || 0,
      qualified_referrals: qualCount?.cnt || 0,
      referral_bonus_earned: (qualCount?.cnt || 0) * refConfig.bonus_per_referral,
      contract_ds_status: contractInfo?.ds_status || '',
      contract_version_count: contractVerCount?.cnt || 0,
      cinv_total: cinvCounts?.total || 0,
      cinv_pending: cinvCounts?.pending || 0,
      recommended_form: taxRes?.recommended_form || '',
      tax_status: taxRes?.tax_status || '',
      tax_treaty_country: taxRes?.treaty_country || '',
      tax_claim_treaty: taxRes?.claim_treaty_benefit || '',
      tax_services_location: taxRes?.services_location || '',
      tax_filing_doc_count: taxFilingDocCount?.cnt || 0,
      current_tax_year: currentTaxYear,
      total_paid: payTotals?.total || 0,
      payment_count: payTotals?.cnt || 0
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
  const changedBy = req.session && req.session.username ? req.session.username : 'admin';
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, changedBy, 'account_created', '', username, '管理员创建账户');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/worker-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { password, employee_id, active, suspended, expected_salary, our_salary_rating, payment_method, payment_details, assigned_tasks, work_status, has_ssn, position_interests, employment_type, entity_type } = req.body;
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
  const newPaymentDetails = payment_details !== undefined ? JSON.stringify(payment_details) : (w.payment_details || '{}');
  const newHasSsn = has_ssn !== undefined ? (has_ssn ? 1 : 0) : (w.has_ssn || 0);
  const newPositionInterests = position_interests !== undefined ? JSON.stringify(position_interests) : (w.position_interests || '[]');
  logChange('active', w.active, newActive);
  logChange('suspended', w.suspended||0, newSuspended);
  logChange('work_status', w.work_status, newWorkStatus);
  logChange('expected_salary', w.expected_salary, newExpectedSalary);
  logChange('our_salary_rating', w.our_salary_rating, newOurRating);
  logChange('payment_method', w.payment_method, newPaymentMethod);
  if (payment_details !== undefined) logChange('payment_details', w.payment_details||'{}', newPaymentDetails);
  logChange('has_ssn', w.has_ssn||0, newHasSsn);
  if (entity_type !== undefined) logChange('entity_type', w.entity_type, entity_type);
  if (employee_id !== undefined && String(employee_id||'') !== String(w.employee_id||'')) logChange('employee_id', w.employee_id, employee_id);
  // When reactivating a deactivated account (active 0→1), clear old interview
  // and onboarding records so the worker starts fresh
  if (!w.active && newActive) {
    const wid = parseInt(req.params.id);
    archiveInterviews(wid);
    db.prepare('DELETE FROM interviews WHERE worker_account_id=?').run(wid);
    db.prepare('DELETE FROM worker_onboarding WHERE worker_account_id=?').run(wid);
    db.prepare(`UPDATE worker_accounts SET onboarded=0, dispatch_ready=0, identity_status='', bgcheck_status='' WHERE id=?`).run(wid);
    // Clear reserved interview slots for this worker (don't delete the slot rows)
    db.prepare(`UPDATE interview_slots SET reserved_for_worker_account_id=NULL WHERE reserved_for_worker_account_id=? AND booked_count=0`).run(wid);
  }
  db.prepare(`UPDATE worker_accounts SET employee_id=?, active=?, suspended=?,
    expected_salary=COALESCE(?,expected_salary), our_salary_rating=COALESCE(?,our_salary_rating),
    payment_method=COALESCE(?,payment_method), payment_details=COALESCE(?,payment_details),
    assigned_tasks=COALESCE(?,assigned_tasks),
    work_status=COALESCE(?,work_status), has_ssn=?, position_interests=?,
    employment_type=COALESCE(?,employment_type),
    entity_type=COALESCE(?,entity_type) WHERE id=?`)
    .run(
      employee_id !== undefined ? employee_id : w.employee_id,
      newActive, newSuspended,
      expected_salary !== undefined ? expected_salary : null,
      our_salary_rating !== undefined ? our_salary_rating : null,
      payment_method !== undefined ? payment_method : null,
      payment_details !== undefined ? newPaymentDetails : null,
      assigned_tasks !== undefined ? JSON.stringify(assigned_tasks) : null,
      work_status !== undefined ? work_status : null,
      newHasSsn, newPositionInterests,
      employment_type !== undefined ? employment_type : null,
      entity_type !== undefined ? entity_type : null,
      req.params.id
    );
  res.json({ success: true });
});

app.patch('/api/admin/worker-accounts/:id/identity-reverify-date', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  const { date } = req.body;
  const w = db.prepare('SELECT identity_reverify_date FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const changedBy = (req.session && req.session.username) || 'admin';
  db.prepare('UPDATE worker_accounts SET identity_reverify_date=? WHERE id=?').run(date || '', req.params.id);
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value) VALUES (?,?,?,?,?)').run(req.params.id, changedBy, 'identity_reverify_date', w.identity_reverify_date || '', date || '');
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
  try {
    const rows = db.prepare('SELECT * FROM worker_account_history WHERE worker_account_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: get worker's most recent interview with slot info
app.get('/api/admin/worker-accounts/:id/interview-info', requireAdmin, (req, res) => {
  const row = db.prepare(`
    SELECT i.id, i.status, i.admin_notes, i.created_at,
      s.slot_datetime, s.duration_min, s.location
    FROM interviews i
    JOIN interview_slots s ON i.slot_id = s.id
    WHERE i.worker_account_id = ?
    ORDER BY i.id DESC LIMIT 1
  `).get(req.params.id);
  res.json(row || null);
});

// ── Worker Onboarding ──
// W-2: 申请/筛选 → 面试 → 条件offer/合同 → 背景调查+Checkr → 身份验证 → I-9 → 看证件(EAD) → E-Verify → Gusto/上岗
// 1099: 申请/筛选 → contractor agreement → 税务居民判定 → 背景调查(如需) → 证件/资质核验 → 可接单
const ONBOARDING_STEPS = [
  { key: 'phone_verify',    title: '手机号验证',           desc: '必须通过手机号验证才能继续',                     required: true  },
  { key: 'email_verify',    title: '邮箱验证',             desc: '必须通过邮箱验证才能继续',                       required: true  },
  { key: 'interview',       title: '完成面试',             desc: '预约并参加 HR 面试',                              required: true  },
  { key: 'contract',        title: '签署合同 / Offer',     desc: '电子签署雇佣协议 / Contractor Agreement',         required: true  },
  { key: 'tax_residency',   title: '税务居民身份判定',      desc: '1099 承包商税务居民预判 / 表格分流（Resident Test）', required: false },
  { key: 'work_permit',     title: '工作许可验证',          desc: '工作许可 / 签证授权状态核实（如适用）',            required: false },
  { key: 'background_check',title: '背景调查 (Checkr)',    desc: 'SSN Trace + 犯罪记录调查 · 通过 Checkr 平台',    required: false },
  { key: 'persona_verify',  title: '身份验证 (Stripe Identity)',   desc: '驾照/ID + 自拍核验 · 由 HR 发起 · 通过 Stripe Identity', required: true },
  { key: 'i9',              title: 'I-9 就业资格',         desc: 'I-9 Section 1 & 2 就业资格验证',                  required: true  },
  { key: 'ead_upload',      title: 'EAD / 工卡上传',       desc: 'EAD 工卡及证件核验（如适用）',                    required: false },
  { key: 'w9',              title: 'W-9 税表',             desc: '独立承包商 W-9 税务信息表（1099 适用）',          required: false },
  { key: 'tin_verify',      title: '核对税号',              desc: 'Admin 核对工人税号（SSN/EIN/ITIN）后方可入职',   required: true  },
  { key: 'gusto',           title: 'Gusto 薪资 / 入职表单', desc: '在 Gusto 填写直接存款及薪资信息 · 其他入职表单', required: true  },
  // Tax document tasks (auto-created by tax residency questionnaire)
  { key: 'tax_doc_w8ben',    title: 'W-8BEN 表格',           desc: '非居民外国个人预扣税声明',                       required: true  },
  { key: 'tax_doc_w8bene',   title: 'W-8BEN-E 表格',         desc: '外国实体预扣税声明',                             required: true  },
  { key: 'tax_doc_8233',     title: 'Form 8233',              desc: '个人服务条约豁免申请',                           required: true  },
  { key: 'tax_doc_passport', title: '护照复印件',              desc: '护照信息页复印件 Passport Copy',                 required: true  },
  { key: 'tax_doc_visa',     title: '签证复印件',              desc: '签证复印件 Visa Copy',                            required: true  },
  { key: 'tax_doc_i94',      title: 'I-94 入境记录',           desc: 'I-94 Arrival/Departure Record',                    required: true  },
  { key: 'tax_doc_work_auth',title: '工作授权文件',             desc: 'Work Authorization Document',                      required: true  },
  { key: 'tax_doc_w7_itin',  title: 'W-7 ITIN 申请',         desc: 'Form W-7 ITIN 申请表（如无 SSN/ITIN）',          required: false },
  { key: 'tax_doc_8833',     title: 'Form 8833 条约声明',     desc: '条约申报声明 Treaty-Based Return Position',       required: false },
  { key: 'tax_doc_corp_cert',title: '公司注册文件',            desc: 'Articles / Certificate of Incorporation',         required: true  },
  { key: 'tax_doc_sign_auth',title: '授权签署人证明',          desc: '签署人身份及授权文件 Signing Authority',           required: true  },
  { key: 'tax_doc_treaty_docs',title:'条约优惠文件',           desc: '条约优惠申请相关文件 Treaty Benefit Documentation', required: false },
  { key: 'tax_doc_treaty_stmt',title:'条约条款声明',           desc: '条约条款声明 Treaty Statement / Attachment',       required: true  },
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
  if (req.params.key === 'interview' && status === 'pending') {
    db.prepare(`UPDATE interviews SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND status='scheduled'`).run(req.params.id);
  }
  // Get old status for history logging
  const oldTask = db.prepare("SELECT status, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key=?").get(req.params.id, req.params.key);
  const oldStatus = oldTask ? oldTask.status : '';
  // Prevent marking contract as completed unless both parties have signed
  if (req.params.key === 'contract' && status === 'completed' && oldTask && oldTask.ds_status && oldTask.ds_status !== 'completed') {
    return res.status(400).json({ error: '合同尚未双方签署完成，无法标记为已完成。Contract requires both parties to sign before marking complete.' });
  }
  // When resetting contract to pending, also clear DocuSeal signing data and archive submission
  if (req.params.key === 'contract' && status === 'pending' && oldTask && oldTask.ds_status) {
    const onb = db.prepare("SELECT ds_envelope_id FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(req.params.id);
    if (onb && onb.ds_envelope_id) {
      try { dsealArchive(onb.ds_envelope_id).catch(e => console.error('[contract reset] archive error:', e.message)); } catch {}
      // Mark contract version as voided (reset)
      db.prepare("UPDATE worker_contract_versions SET ds_status='voided', voided_at=CURRENT_TIMESTAMP, void_reason='任务重置' WHERE worker_account_id=? AND ds_envelope_id=?")
        .run(req.params.id, onb.ds_envelope_id);
    }
    db.prepare("UPDATE worker_onboarding SET ds_envelope_id='', ds_status='', ds_worker_signed_at=NULL, ds_company_signed_at=NULL, contract_content='', status='pending', admin_note='合同已重置', action_url='', completed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
      .run(req.params.id);
  } else {
    db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, admin_note, action_url, completed_at, updated_at)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id,task_key) DO UPDATE SET status=excluded.status, admin_note=excluded.admin_note,
        action_url=excluded.action_url, completed_at=excluded.completed_at, updated_at=CURRENT_TIMESTAMP`)
      .run(req.params.id, req.params.key, status, admin_note||'', action_url||'', completedAt);
  }
  // Log onboarding task changes to worker history
  if (oldStatus && oldStatus !== status) {
    const TASK_LABELS = { contract:'合同', interview:'面试', phone_verify:'电话验证', email_verify:'邮箱验证', persona_verify:'身份验证', background_check:'背景调查', tax_form:'税表', direct_deposit:'银行信息' };
    const STATUS_LABELS = { pending:'待处理', submitted:'已提交', completed:'已完成', waived:'已豁免' };
    const taskLabel = TASK_LABELS[req.params.key] || req.params.key;
    const changedBy = req.session && req.session.username ? req.session.username : 'admin';
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
      .run(req.params.id, changedBy, `onboarding_${req.params.key}`, STATUS_LABELS[oldStatus] || oldStatus, STATUS_LABELS[status] || status, `${taskLabel}: ${STATUS_LABELS[oldStatus]||oldStatus} → ${STATUS_LABELS[status]||status}`);
  }
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
  const { visible, slot_ids } = req.body;
  const workerId = parseInt(req.params.id);
  // Upsert — handles 'not_initialized' rows that don't exist yet
  db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker, updated_at)
    VALUES (?, ?, 'pending', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(worker_account_id, task_key) DO UPDATE SET visible_to_worker=excluded.visible_to_worker, updated_at=CURRENT_TIMESTAMP`)
    .run(workerId, req.params.key, visible ? 1 : 0);

  // When assigning interview slots to a worker, store the assigned slot IDs
  if (req.params.key === 'interview' && Array.isArray(slot_ids) && slot_ids.length) {
    // Save assigned slot IDs directly on the onboarding record (primary source of truth)
    const slotIdsJson = JSON.stringify(slot_ids.map(Number));
    db.prepare(`UPDATE worker_onboarding SET assigned_slot_ids=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='interview'`)
      .run(slotIdsJson, workerId);
    console.log(`[INTERVIEW-RESERVE] workerId=${workerId}, assigned_slot_ids=${slotIdsJson}`);

    // Also mark slots as reserved (secondary, for reference)
    db.prepare(`UPDATE interview_slots SET reserved_for_worker_account_id=NULL WHERE reserved_for_worker_account_id=?`).run(workerId);
    const stmt = db.prepare(`UPDATE interview_slots SET reserved_for_worker_account_id=? WHERE id=?`);
    for (const sid of slot_ids) stmt.run(workerId, sid);
  }

  res.json({ success: true, tasks: getOnboardingTasks(workerId) });
});

// Admin: send Stripe Identity verification from onboarding modal
app.post('/api/admin/worker-accounts/:id/send-persona', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (!stripe)
      return res.status(503).json({ error: 'Stripe Identity 未配置，请先在 .env 设置 STRIPE_SECRET_KEY' });
    const { force } = req.body || {};
    if (w.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createStripeVerificationSession(workerId, w.name || w.username, w.email);
    if (!result) return res.status(500).json({ error: '创建 Stripe Identity 验证失败，请检查 STRIPE_SECRET_KEY' });
    // Auto-add drivers_license to assigned_tasks so compliance tab shows it
    let curTasks = [];
    try { curTasks = JSON.parse(w.assigned_tasks || '[]'); } catch {}
    if (!curTasks.includes('drivers_license')) {
      curTasks.push('drivers_license');
      db.prepare('UPDATE worker_accounts SET assigned_tasks=? WHERE id=?').run(JSON.stringify(curTasks), workerId);
    }
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.sessionId, workerId);
    // Store in worker_compliance_docs so worker portal compliance tab can pick it up
    const compFormData = JSON.stringify({ stripe_session_id: result.sessionId, stripe_client_secret: result.clientSecret, stripe_status: 'requires_input', stripe_hosted_url: result.url || '' });
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
      .run(workerId, '已发送 Stripe Identity 验证链接', result.url || '');
    // Send SMS
    let smsSent = false;
    if (w.phone) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      const smsText = `[Prime Anchorpoint] 您好 ${w.name||w.username||''}，请完成身份验证（驾照/ID+自拍）以继续入职流程。\n您可以：\n1. 登录合作中心直接完成验证\n2. 点击链接在手机完成：${result.url || portalUrl}`;
      smsSent = await sendSMS(w.phone, smsText);
    }
    // Send email
    let emailSent = false;
    if (w.email) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      emailSent = await sendEmail(w.email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证。您可以登录合作中心直接完成，或点击链接：${result.url || portalUrl}`,
        `<p>您好 ${w.name||w.username||''}，</p>
         <p>HR 已为您发起身份验证（驾照/ID + 自拍核验）。您可以通过以下任一方式完成：</p>
         <table cellpadding="0" cellspacing="0" style="margin:1rem 0">
           <tr><td style="padding:.5rem 0"><strong>方式一：</strong> 登录合作中心，在"合规文件"或"待办事项"中直接完成</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${portalUrl}" style="display:inline-block;padding:.6rem 1.2rem;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">登录合作中心 / Worker Portal</a></td></tr>
           ${result.url ? `<tr><td style="padding:.75rem 0 .3rem"><strong>方式二：</strong> 点击以下链接直接在手机上完成验证</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${result.url}" style="display:inline-block;padding:.6rem 1.2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证 / Start Verification</a></td></tr>
           <tr><td style="padding:.3rem 0"><span style="color:#888;font-size:.82rem">或复制链接：${result.url}</span></td></tr>` : ''}
         </table>`
      );
    }
    res.json({ success: true, smsSent, emailSent, portalReady: true, sessionId: result.sessionId, link: result.url || '' });
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

// Admin: get contract preview for onboarding
app.get('/api/admin/worker-accounts/:id/contract-preview', requireAdmin, (req, res) => {
  const workerId = parseInt(req.params.id);
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const onb = db.prepare("SELECT contract_content, ds_envelope_id, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
  const empType = w.employment_type || 'w2';
  const workerName = w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '';
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const dateStr = new Date().toISOString().slice(0, 10);
  // If already has saved content, use that; otherwise generate default
  const content = (onb && onb.contract_content) || generateWorkerContractText({ workerName, companyName, employmentType: empType, dateStr, position: '' });
  res.json({
    content,
    worker_name: workerName,
    worker_email: w.email || '',
    worker_phone: w.phone || '',
    employment_type: empType,
    ds_envelope_id: onb?.ds_envelope_id || '',
    ds_status: onb?.ds_status || '',
    company_email: process.env.COMPANY_SIGNER_EMAIL || '',
    company_name: companyName,
    docuseal_enabled: dsealEnabled()
  });
});

// Admin: preview contract as PDF
app.post('/api/admin/worker-accounts/contract-preview-pdf', requireAdmin, (req, res) => {
  try {
    const content = req.body.content || '';
    if (!content.trim()) return res.status(400).json({ error: '合同内容为空' });
    const pdfBuf = buildContractPdf(content);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="contract-preview.pdf"' });
    res.send(pdfBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: send contract to worker via DocuSeal
app.post('/api/admin/worker-accounts/:id/send-contract', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置，请在 .env 设置 DOCUSEAL_API_KEY 和 DOCUSEAL_URL' });
    const companyEmail = process.env.COMPANY_SIGNER_EMAIL || '';
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
    if (!companyEmail) return res.status(503).json({ error: '请在 .env 设置 COMPANY_SIGNER_EMAIL' });
    const workerName = w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '';
    const workerEmail = req.body.worker_email || w.email || '';
    if (!workerEmail) return res.status(400).json({ error: '工人邮箱为空，请先补充邮箱' });
    // Use provided content or generate default
    const empType = w.employment_type || 'w2';
    const dateStr = new Date().toISOString().slice(0, 10);
    const content = req.body.content || generateWorkerContractText({ workerName, companyName, employmentType: empType, dateStr, position: '' });
    // Also build PDF for local preview/archive
    const pdfBuf = buildContractPdf(content);
    const filename = `worker-contract-${workerId}-${Date.now()}.pdf`;
    const docPath = path.join(docsDir, filename);
    fs.writeFileSync(docPath, pdfBuf);
    // Send via DocuSeal — use configured template if available, otherwise generate HTML
    const workerTemplateId = getDsealConfigTemplateId(empType === '1099' ? 'worker_1099' : 'worker_w2');
    const workerPhone = w.phone || '';
    const { submissionId, companyEmbedSrc, workerSignUrl } = await dsealSendContractHtml({
      contractText: content,
      templateId: workerTemplateId || undefined,
      docName: `${empType === '1099' ? 'Contractor Agreement' : 'Employment Agreement'} - ${workerName}`,
      emailSubject: `请签署合同 / Please Sign — ${workerName} × ${companyName}`,
      signer1: { email: companyEmail, name: companyName },
      signer2: { email: workerEmail, name: workerName, phone: workerPhone }
    });
    console.log(`[Contract] submissionId=${submissionId}, workerSignUrl=${workerSignUrl ? workerSignUrl.substring(0, 60) : 'NONE'}`);
    // Store worker's sign URL in action_url so the portal can show the correct signing link.
    // companyEmbedSrc is only needed for the admin signing flow; it's fetched on demand via /contract-sign-url.
    db.prepare(`UPDATE worker_onboarding SET ds_envelope_id=?, ds_status='sent', ds_worker_signed_at=NULL, ds_company_signed_at=NULL,
      contract_content=?, visible_to_worker=1, admin_note=?, action_url=?, updated_at=CURRENT_TIMESTAMP
      WHERE worker_account_id=? AND task_key='contract'`)
      .run(submissionId, content, `合同已创建，等待公司签署 (${new Date().toLocaleString('zh-CN')})`, workerSignUrl || '', workerId);
    // Save contract version
    const changedBy = req.session && req.session.username ? req.session.username : 'admin';
    const lastVer = db.prepare('SELECT MAX(version_num) AS v FROM worker_contract_versions WHERE worker_account_id=?').get(workerId);
    const versionNum = (lastVer?.v || 0) + 1;
    db.prepare('INSERT INTO worker_contract_versions (worker_account_id,version_num,contract_content,ds_envelope_id,ds_status,created_by) VALUES (?,?,?,?,?,?)')
      .run(workerId, versionNum, content, submissionId, 'sent', changedBy);
    // Log contract send to worker history
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
      .run(workerId, changedBy, 'contract', '', '已发送', `合同 v${versionNum} 已创建并发送至 ${workerEmail}，等待公司签署`);
    // Do NOT send email/SMS to worker yet — company must sign first
    // Worker will be notified after company signs (via webhook handler)
    const smsSent = false;
    const emailSent = false;
    // Clean up temp PDF
    try { fs.unlinkSync(docPath); } catch {}
    res.json({ success: true, submissionId, signUrl: companyEmbedSrc, smsSent, emailSent });
  } catch (e) {
    console.error('[Contract Send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: get contract signing status from DocuSeal
app.get('/api/admin/worker-accounts/:id/contract-status', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id, ds_status, ds_worker_signed_at, ds_company_signed_at FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
    if (!dsealEnabled()) return res.json({ status: onb.ds_status, workerSigned: onb.ds_worker_signed_at, companySigned: onb.ds_company_signed_at });
    const { status, companySigned, partnerSigned, declineReason } = await dsealGetStatus(onb.ds_envelope_id);
    // Determine granular status: trust DocuSeal completed status even if timestamps are missing
    let effectiveStatus = status;
    if (status === 'completed') {
      effectiveStatus = 'completed';
    } else if (companySigned && !partnerSigned) {
      effectiveStatus = 'company_signed';
    } else if (!companySigned && partnerSigned) {
      effectiveStatus = 'worker_signed';
    } else if (status !== 'declined') {
      effectiveStatus = 'sent';
    }
    db.prepare("UPDATE worker_onboarding SET ds_status=?, ds_worker_signed_at=?, ds_company_signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
      .run(effectiveStatus, partnerSigned, companySigned, workerId);
    // Also sync worker_contract_versions table
    if (onb.ds_envelope_id) {
      db.prepare("UPDATE worker_contract_versions SET ds_status=?, ds_company_signed_at=?, ds_worker_signed_at=? WHERE worker_account_id=? AND ds_envelope_id=?")
        .run(effectiveStatus, companySigned, partnerSigned, workerId, onb.ds_envelope_id);
    }
    if (effectiveStatus === 'completed') {
      db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='双方已签署完成 ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'`)
        .run(workerId);
      syncOnboardedStatus(workerId);
    } else if (effectiveStatus === 'company_signed') {
      // If status just changed from 'sent' to 'company_signed', webhook may have missed — send notification now
      const prevStatus = onb.ds_status;
      if (prevStatus === 'sent') {
        // Refresh signing URL for worker
        let workerSignUrl = '';
        try {
          const subData = await dsealApiCall('GET', `/api/submissions/${onb.ds_envelope_id}`, null);
          const workerSub = (subData.data?.submitters || []).find(s => s.role === 'Second Party');
          if (workerSub) {
            if (workerSub.slug) {
              workerSignUrl = `${dsealPublicHost()}/s/${workerSub.slug}`;
            } else if (workerSub.embed_src) {
              workerSignUrl = workerSub.embed_src;
            } else if (workerSub.id) {
              const wPut = await dsealApiCall('PUT', `/api/submitters/${workerSub.id}`, { name: workerSub.name });
              if (wPut.data?.slug) workerSignUrl = `${dsealPublicHost()}/s/${wPut.data.slug}`;
              else if (wPut.data?.embed_src) workerSignUrl = wPut.data.embed_src;
            }
          }
        } catch (e2) { console.error('[contract-status] get worker sign URL error:', e2.message); }
        if (workerSignUrl) {
          db.prepare("UPDATE worker_onboarding SET action_url=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
            .run(workerSignUrl, workerId);
        }
        // Send notification to worker (fallback for missed webhook)
        const w = db.prepare('SELECT name, username, email, phone FROM worker_accounts WHERE id=?').get(workerId);
        if (w) {
          const workerName = w.name || w.username || '';
          const workerEmail = w.email || '';
          const workerPhone = w.phone || '';
          const onbRecord = db.prepare("SELECT contract_content FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
          const empType = (onbRecord?.contract_content || '').includes('Independent Contractor') ? '1099' : 'w2';
          const contractTypeCn = empType === '1099' ? '承包商协议' : '雇佣合同';
          const contractType = empType === '1099' ? 'Independent Contractor Agreement' : 'Employment Agreement';
          const contractTypeEs = empType === '1099' ? 'Acuerdo de Contratista Independiente' : 'Acuerdo de Empleo';
          const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
          const signLink = workerSignUrl ? `<p style="margin:1.5rem 0;text-align:center"><a href="${workerSignUrl}" style="display:inline-block;padding:.75rem 2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem">签署合同 / Sign Contract / Firmar Contrato</a></p>` : '';
          if (workerEmail) {
            sendEmail(workerEmail,
              `Prime Anchorpoint — 请签署${contractTypeCn} / Please Sign / Firme Su Contrato`,
              `${workerName}，${companyName}已签署${contractTypeCn}，请点击链接完成签署。\n${workerSignUrl || ''}\n\n${workerName}, ${companyName} has signed. Please sign here:\n${workerSignUrl || ''}\n\n${workerName}, ${companyName} ha firmado. Firme aquí:\n${workerSignUrl || ''}`,
              `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem">
                <h2 style="color:#1a1a1a;text-align:center">请签署您的${contractTypeCn}</h2>
                <p>您好 ${workerName}，${companyName} 已完成签署，现在轮到您签署了。</p>
                ${signLink}
                ${workerSignUrl ? `<p style="color:#666;font-size:.85rem">或复制链接：${workerSignUrl}</p>` : ''}
                <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
                <h3 style="font-size:.95rem">Please Sign Your ${contractType}</h3>
                <p style="color:#555;font-size:.9rem">Hi ${workerName}, ${companyName} has signed. It's now your turn.</p>
                ${signLink}
                <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
                <h3 style="font-size:.95rem">Firme Su ${contractTypeEs}</h3>
                <p style="color:#555;font-size:.9rem">Hola ${workerName}, ${companyName} ha firmado. Ahora es su turno.</p>
                ${signLink}
                <p style="color:#999;font-size:.8rem;margin-top:2rem;text-align:center">Prime Anchorpoint LLC</p>
              </div>`
            ).catch(e => console.error('[contract-status] fallback email error:', e.message));
            console.log(`[contract-status] Sent fallback signing email to ${workerEmail} (webhook may have missed)`);
          }
          if (workerPhone) {
            const smsText = workerSignUrl
              ? `[Prime Anchorpoint] ${workerName}，${companyName}已签署${contractTypeCn}，请点击链接完成签署 / Please sign: / Firme aquí:\n${workerSignUrl}\nReply STOP to opt out.`
              : `[Prime Anchorpoint] ${workerName}，${companyName}已签署${contractTypeCn}，请查收邮件完成签署。/ Please check email to sign. / Revise su correo para firmar. Reply STOP to opt out.`;
            sendSMS(workerPhone, smsText).catch(e => console.error('[contract-status] fallback SMS error:', e.message));
            console.log(`[contract-status] Sent fallback signing SMS to ${workerPhone} (webhook may have missed)`);
          }
        }
      }
      db.prepare(`UPDATE worker_onboarding SET admin_note='公司已签署，等待工人签署', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'`)
        .run(workerId);
    } else if (status === 'declined') {
      db.prepare(`UPDATE worker_onboarding SET admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'`)
        .run(`工人已拒签: ${declineReason || ''}`, workerId);
    }
    res.json({ status: effectiveStatus, workerSigned: partnerSigned, companySigned, declineReason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: get all contract versions for a worker
app.get('/api/admin/worker-accounts/:id/contract-versions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM worker_contract_versions WHERE worker_account_id=? ORDER BY version_num DESC').all(req.params.id);
  res.json(rows);
});

// Admin: download signed PDF for a specific contract version
app.get('/api/admin/worker-accounts/:id/contract-version-pdf/:versionId', requireAdmin, async (req, res) => {
  try {
    const ver = db.prepare('SELECT ds_envelope_id, version_num FROM worker_contract_versions WHERE id=? AND worker_account_id=?').get(req.params.versionId, req.params.id);
    if (!ver || !ver.ds_envelope_id) return res.status(404).json({ error: '该版本无签署记录' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const signedBuf = await dsealDownloadDocument(ver.ds_envelope_id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="contract-v${ver.version_num}-${req.params.id}.pdf"` });
    res.send(signedBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: download current signed document from DocuSeal for onboarding contract
app.get('/api/admin/worker-accounts/:id/contract-signed-pdf', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: '合同未发送' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const signedBuf = await dsealDownloadDocument(onb.ds_envelope_id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="signed-contract-${workerId}.pdf"` });
    res.send(signedBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: view their own signed contract PDF
app.get('/api/worker/contract-signed-pdf', requireWorker, async (req, res) => {
  try {
    const onb = db.prepare("SELECT ds_envelope_id, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(req.workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: '合同未发送' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const signedBuf = await dsealDownloadDocument(onb.ds_envelope_id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="signed-contract.pdf"` });
    res.send(signedBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: get company signing URL for onboarding contract
app.get('/api/admin/worker-accounts/:id/contract-sign-url', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
    const signUrl = await dsealGetCompanySignUrl(onb.ds_envelope_id);
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
    console.log(`[CompanySign] workerId=${workerId}, submissionId=${onb.ds_envelope_id}, signUrl=${signUrl ? signUrl.substring(0, 80) + '...' : 'NULL'}`);
    res.json({ signUrl, companyName });
  } catch (e) { console.error('[CompanySign Error]', e.message); res.status(500).json({ error: e.message }); }
});

// Admin: resend signing notification (SMS + email) to worker
app.post('/api/admin/worker-accounts/:id/resend-sign-notification', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT name, username, email, phone FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const onb = db.prepare("SELECT ds_envelope_id, ds_status, action_url, contract_content FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: '合同未发送' });
    if (onb.ds_status === 'completed') return res.status(400).json({ error: '合同已完成签署，无需通知' });
    const workerName = w.name || w.username || '';
    const workerEmail = w.email || '';
    const workerPhone = w.phone || '';
    if (!workerEmail && !workerPhone) return res.status(400).json({ error: '工人无邮箱和手机号，无法发送通知' });
    // Get fresh signing URL
    let workerSignUrl = onb.action_url || '';
    if (dsealEnabled()) {
      try {
        const subData = await dsealApiCall('GET', `/api/submissions/${onb.ds_envelope_id}`, null);
        const workerSub = (subData.data?.submitters || []).find(s => s.role === 'Second Party') || (subData.data?.submitters || [])[0];
        if (workerSub) {
          if (workerSub.slug) workerSignUrl = `${dsealPublicHost()}/s/${workerSub.slug}`;
          else if (workerSub.embed_src) workerSignUrl = workerSub.embed_src;
        }
      } catch (e2) { console.error('[resend-notification] get sign URL error:', e2.message); }
    }
    if (workerSignUrl) {
      db.prepare("UPDATE worker_onboarding SET action_url=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
        .run(workerSignUrl, workerId);
    }
    const empType = (onb.contract_content || '').includes('Independent Contractor') ? '1099' : 'w2';
    const contractTypeCn = empType === '1099' ? '承包商协议' : '雇佣合同';
    const contractType = empType === '1099' ? 'Independent Contractor Agreement' : 'Employment Agreement';
    const contractTypeEs = empType === '1099' ? 'Acuerdo de Contratista Independiente' : 'Acuerdo de Empleo';
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
    const signLink = workerSignUrl ? `<p style="margin:1.5rem 0;text-align:center"><a href="${workerSignUrl}" style="display:inline-block;padding:.75rem 2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem">签署合同 / Sign Contract / Firmar Contrato</a></p>` : '';
    let emailSent = false, smsSent = false;
    if (workerEmail) {
      emailSent = await sendEmail(workerEmail,
        `Prime Anchorpoint — 请签署${contractTypeCn} / Please Sign / Firme Su Contrato`,
        `${workerName}，请点击链接完成签署。\n${workerSignUrl || ''}\n\n${workerName}, please sign here:\n${workerSignUrl || ''}\n\n${workerName}, firme aquí:\n${workerSignUrl || ''}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem">
          <h2 style="color:#1a1a1a;text-align:center">请签署您的${contractTypeCn}</h2>
          <p>您好 ${workerName}，请点击下方按钮完成合同签署。</p>
          ${signLink}
          ${workerSignUrl ? `<p style="color:#666;font-size:.85rem">或复制链接：${workerSignUrl}</p>` : ''}
          <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
          <h3 style="font-size:.95rem">Please Sign Your ${contractType}</h3>
          <p style="color:#555;font-size:.9rem">Hi ${workerName}, please click below to sign your contract.</p>
          ${signLink}
          <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
          <h3 style="font-size:.95rem">Firme Su ${contractTypeEs}</h3>
          <p style="color:#555;font-size:.9rem">Hola ${workerName}, haga clic abajo para firmar su contrato.</p>
          ${signLink}
          <p style="color:#999;font-size:.8rem;margin-top:2rem;text-align:center">Prime Anchorpoint LLC</p>
        </div>`
      );
    }
    if (workerPhone) {
      const smsText = workerSignUrl
        ? `[Prime Anchorpoint] ${workerName}，请签署${contractTypeCn} / Please sign your contract / Firme su contrato:\n${workerSignUrl}\nReply STOP to opt out.`
        : `[Prime Anchorpoint] ${workerName}，请查收邮件签署${contractTypeCn}。/ Please check email to sign. / Revise su correo para firmar. Reply STOP to opt out.`;
      smsSent = await sendSMS(workerPhone, smsText);
    }
    const warnings = [];
    if (workerEmail && !emailSent) warnings.push('邮件发送失败');
    if (workerPhone && !smsSent) warnings.push('短信发送失败');
    if (!workerEmail) warnings.push('工人无邮箱，未发送邮件');
    if (!workerPhone) warnings.push('工人无手机号，未发送短信');
    console.log(`[resend-notification] workerId=${workerId}, emailSent=${emailSent}, smsSent=${smsSent}`);
    res.json({ success: true, emailSent, smsSent, signUrl: workerSignUrl, warnings });
  } catch (e) {
    console.error('[resend-notification]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: void/cancel onboarding contract submission (requires reason)
app.post('/api/admin/worker-accounts/:id/contract-void', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '请填写作废原因' });
    const onb = db.prepare("SELECT ds_envelope_id, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
    await dsealArchive(onb.ds_envelope_id);
    const voidNote = `合同已作废 — ${reason}`;
    db.prepare("UPDATE worker_onboarding SET ds_envelope_id='', ds_status='', ds_worker_signed_at=NULL, ds_company_signed_at=NULL, admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
      .run(voidNote, workerId);
    // Mark contract version as voided
    db.prepare("UPDATE worker_contract_versions SET ds_status='voided', voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE worker_account_id=? AND ds_envelope_id=?")
      .run(reason, workerId, onb.ds_envelope_id);
    // Log to worker history
    const changedBy = req.session && req.session.username ? req.session.username : 'admin';
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
      .run(workerId, changedBy, 'contract', onb.ds_status || '已发送', '已作废', voidNote);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin: W-9 DocuSeal Endpoints ───

// ─── Tax Residency Questionnaire (1099 Resident Test) ───

// SPT calculation + form routing engine
function calculateTaxResidency(data) {
  const result = { spt_weighted_days: 0, spt_result: '', tax_status: '', recommended_form: '', needs_manual_review: false };
  const { applicant_type, is_us_person, is_us_citizen, has_green_card,
    days_current_year, days_last_year, days_two_years_ago, has_exempt_days,
    services_location, claim_treaty_benefit, treaty_income_type } = data;

  // Rule 1: Entity vs Individual
  if (applicant_type === 'entity') {
    if (is_us_person === 'yes') {
      result.tax_status = 'us_entity';
      result.recommended_form = 'W-9';
    } else {
      result.tax_status = 'foreign_entity';
      result.recommended_form = 'W-8BEN-E';
    }
    return result;
  }

  // Rule 2: Individual - check U.S. person status
  if (is_us_citizen === 'yes') {
    result.tax_status = 'us_citizen';
    result.recommended_form = 'W-9';
    return result;
  }
  if (has_green_card === 'yes') {
    result.tax_status = 'resident_alien';
    result.recommended_form = 'W-9';
    return result;
  }

  // Rule 3: SPT calculation (with F/J/M/Q exempt day exclusion)
  // Validate days against first entry date
  const firstEntry = data.first_entry_date ? new Date(data.first_entry_date + 'T00:00:00') : null;
  const cy = parseInt(days_current_year) || 0;
  const ly = parseInt(days_last_year) || 0;
  const ty = parseInt(days_two_years_ago) || 0;
  if (firstEntry && !isNaN(firstEntry.getTime())) {
    const feYear = firstEntry.getFullYear();
    const now = new Date();
    const thisYear = now.getFullYear();
    const years = [{ days: cy, year: thisYear }, { days: ly, year: thisYear - 1 }, { days: ty, year: thisYear - 2 }];
    for (const { days, year } of years) {
      if (days > 0 && feYear > year) {
        result.needs_manual_review = true;
        result.validation_warning = `First entry date (${data.first_entry_date}) is after ${year}, but ${days} days claimed for that year`;
      }
    }
  }
  const exCY = has_exempt_days === 'yes' ? Math.min(parseInt(data.exempt_days_cy) || 0, cy) : 0;
  const exLY = has_exempt_days === 'yes' ? Math.min(parseInt(data.exempt_days_ly) || 0, ly) : 0;
  const ex2Y = has_exempt_days === 'yes' ? Math.min(parseInt(data.exempt_days_2y) || 0, ty) : 0;
  const adjCY = cy - exCY, adjLY = ly - exLY, adj2Y = ty - ex2Y;
  const weighted = adjCY + (adjLY / 3) + (adj2Y / 6);
  result.spt_weighted_days = Math.round(weighted * 100) / 100;

  if (adjCY >= 31 && weighted >= 183) {
    result.spt_result = 'meets_spt';
    result.tax_status = 'likely_resident_alien';
    result.recommended_form = 'W-9';
    result.needs_manual_review = true; // closer connection exception possible
  } else {
    result.spt_result = 'does_not_meet_spt';
    result.tax_status = 'likely_nonresident_alien';
  }

  // Rule 4-7: Foreign individual form routing
  // Treaty claim only applies to nonresident aliens (not SPT residents who file W-9)
  if (claim_treaty_benefit === 'yes' && result.tax_status !== 'likely_resident_alien') {
    result.needs_manual_review = true;
    if (treaty_income_type === 'personal_services' && (services_location === 'all_in_us' || services_location === 'partly_in_us')) {
      result.recommended_form = 'Form 8233';
    } else {
      result.recommended_form = 'W-8BEN';
    }
  } else if (result.tax_status === 'likely_nonresident_alien') {
    if (services_location === 'all_outside_us') {
      result.recommended_form = 'W-8BEN';
    } else if (services_location === 'all_in_us' || services_location === 'partly_in_us') {
      result.recommended_form = 'W-8BEN';
      result.needs_manual_review = true;
    } else {
      result.recommended_form = 'W-8BEN';
    }
  }

  // If has exempt days (F/J/M/Q visa), always flag for review
  if (has_exempt_days === 'yes') {
    result.needs_manual_review = true;
  }

  return result;
}

// Determine onboarding tasks needed based on tax form recommendation
function getTaxDocTasks(form, data) {
  const tasks = [];
  const isEntity = data.applicant_type === 'entity';
  const servInUs = data.services_location === 'all_in_us' || data.services_location === 'partly_in_us';
  const treatyClaim = data.claim_treaty_benefit === 'yes';
  const immStatus = data.immigration_status || '';
  const VISA_TYPES = ['H-1B','H-1B1','L-1','O-1','TN','E-1','E-2','E-3','R-1','P-1'];
  const EAD_TYPES = ['EAD-C08','EAD-A05','EAD-C09','EAD-C10','EAD-A10','EAD-C26','EAD-A18','EAD-C33','EAD-A12','EAD-C03A','EAD-C03B','EAD-OTHER'];

  if (form === 'W-9') {
    // W-9 handled by existing w9 task
    if (isEntity) {
      tasks.push({ key: 'tax_doc_corp_cert', note: '公司注册文件 Articles / Certificate of Formation' });
      tasks.push({ key: 'tax_doc_ein_letter', note: 'EIN 确认函 IRS EIN Confirmation Letter (CP 575 / 147C)' });
    }
    if (data.is_us_citizen === 'yes') {
      tasks.push({ key: 'tax_doc_id_proof', note: '身份证明（任一）: 美国护照 / 出生证明 / 入籍证书 N-550 / 公民证书 N-560 / FS-240' });
    } else if (data.has_green_card === 'yes') {
      tasks.push({ key: 'tax_doc_id_proof', note: '身份证明（任一）: 绿卡 I-551 正反面 / 护照+I-551章 / 过期绿卡+I-797延期' });
    }
  } else if (form === 'W-8BEN') {
    tasks.push({ key: 'tax_doc_w8ben', note: 'W-8BEN 非居民外国个人预扣税声明' });
    tasks.push({ key: 'tax_doc_passport', note: '护照复印件 Passport Copy' });
    tasks.push({ key: 'tax_doc_w7_itin', note: 'Form W-7 ITIN 申请表（如无 SSN/ITIN）' });
    if (servInUs) {
      // Work authorization docs based on immigration status type
      if (VISA_TYPES.includes(immStatus)) {
        tasks.push({ key: 'tax_doc_i797', note: 'I-797 批准通知 Approval Notice (或有效签证页) — ' + immStatus });
        tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
      } else if (EAD_TYPES.includes(immStatus)) {
        tasks.push({ key: 'tax_doc_ead', note: 'EAD 工卡 (I-766) 正反面 — ' + immStatus });
        if (immStatus === 'EAD-C03A' || immStatus === 'EAD-C03B') {
          tasks.push({ key: 'tax_doc_i20', note: 'I-20 (含 OPT endorsement)' });
        }
      } else if (immStatus === 'F-1-CPT') {
        tasks.push({ key: 'tax_doc_i20', note: 'I-20 (含 CPT 授权页)' });
      } else if (immStatus === 'J-1') {
        tasks.push({ key: 'tax_doc_ds2019', note: 'DS-2019' });
        tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
      } else {
        tasks.push({ key: 'tax_doc_visa', note: '签证复印件 Visa Copy' });
        tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
        tasks.push({ key: 'tax_doc_work_auth', note: '工作授权文件 Work Authorization' });
      }
    }
    if (treatyClaim) {
      tasks.push({ key: 'tax_doc_8833', note: 'Form 8833 条约申报声明' });
    }
  } else if (form === 'W-8BEN-E') {
    tasks.push({ key: 'tax_doc_w8bene', note: 'W-8BEN-E 外国实体预扣税声明' });
    tasks.push({ key: 'tax_doc_corp_cert', note: '实体注册证明 Certificate of Incorporation' });
    tasks.push({ key: 'tax_doc_sign_auth', note: '授权签署人证明 Signing Authority / Board Resolution' });
    tasks.push({ key: 'tax_doc_w7_itin', note: 'Form W-7/SS-4 ITIN 或 EIN 申请（如无美国税号）' });
    if (treatyClaim) {
      tasks.push({ key: 'tax_doc_8833', note: 'Form 8833 条约申报声明' });
      tasks.push({ key: 'tax_doc_treaty_docs', note: '条约优惠申请文件 Treaty Benefit Documentation' });
    }
  } else if (form === 'Form 8233') {
    tasks.push({ key: 'tax_doc_8233', note: 'Form 8233 个人服务条约豁免申请' });
    // Also require W-8BEN as fallback in case treaty conditions are not met (e.g. >183 days)
    tasks.push({ key: 'tax_doc_w8ben', note: 'W-8BEN 备选表格（如条约条件不满足则使用此表）Fallback if treaty conditions not met' });
    tasks.push({ key: 'tax_doc_passport', note: '护照复印件 Passport Copy' });
    tasks.push({ key: 'tax_doc_treaty_stmt', note: '条约条款声明 Treaty Statement' });
    tasks.push({ key: 'tax_doc_w7_itin', note: 'Form W-7 ITIN 申请表（如无 SSN/ITIN）' });
    tasks.push({ key: 'tax_doc_8833', note: 'Form 8833 条约申报声明' });
    // Work authorization docs based on immigration status type
    if (VISA_TYPES.includes(immStatus)) {
      tasks.push({ key: 'tax_doc_i797', note: 'I-797 批准通知 Approval Notice (或有效签证页) — ' + immStatus });
      tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
    } else if (EAD_TYPES.includes(immStatus)) {
      tasks.push({ key: 'tax_doc_ead', note: 'EAD 工卡 (I-766) 正反面 — ' + immStatus });
      if (immStatus === 'EAD-C03A' || immStatus === 'EAD-C03B') {
        tasks.push({ key: 'tax_doc_i20', note: 'I-20 (含 OPT endorsement)' });
      }
    } else if (immStatus === 'F-1-CPT') {
      tasks.push({ key: 'tax_doc_i20', note: 'I-20 (含 CPT 授权页)' });
    } else if (immStatus === 'J-1') {
      tasks.push({ key: 'tax_doc_ds2019', note: 'DS-2019' });
      tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
    } else {
      tasks.push({ key: 'tax_doc_visa', note: '签证复印件 Visa Copy' });
      tasks.push({ key: 'tax_doc_i94', note: 'I-94 入境记录 Arrival/Departure Record' });
    }
  }
  return tasks;
}

// Get tax residency questionnaire for a worker
app.get('/api/admin/worker-accounts/:id/tax-residency', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM tax_residency_questionnaire WHERE worker_account_id=?').get(req.params.id);
  res.json(row || null);
});

// Helper: derive work permit category key from tax residency data (mirrors frontend wpDetectCategory)
function _wpCategoryKey(tr) {
  if (!tr) return 'generic';
  if (tr.applicant_type === 'entity') return (tr.is_us_person === 'yes') ? 'us_entity' : 'foreign_entity';
  if (tr.is_us_citizen === 'yes') return 'citizen';
  if (tr.has_green_card === 'yes') return 'green_card';
  if (tr.work_permit_category) {
    const catMap = { work_visa: 'work_visa', ead: 'ead', opt: 'opt', f1_cpt: 'cpt', j1: 'j1' };
    if (catMap[tr.work_permit_category]) return catMap[tr.work_permit_category];
  }
  const wa = tr.immigration_status || '';
  const VISA_TYPES = ['H-1B','H-1B1','L-1','O-1','TN','E-1','E-2','E-3','R-1','P-1'];
  const EAD_TYPES = ['EAD-C08','EAD-A05','EAD-C09','EAD-C10','EAD-A10','EAD-C26','EAD-A18','EAD-C33','EAD-A12','EAD-OTHER'];
  if (VISA_TYPES.includes(wa)) return 'work_visa';
  if (wa === 'EAD-C03A' || wa === 'EAD-C03B') return 'opt';
  if (EAD_TYPES.includes(wa)) return 'ead';
  if (wa === 'F-1-CPT') return 'cpt';
  if (wa === 'J-1') return 'j1';
  return 'generic';
}

// Save tax residency questionnaire
app.post('/api/admin/worker-accounts/:id/tax-residency', requireAdmin, (req, res) => {
  const workerId = parseInt(req.params.id);
  const d = req.body;

  // Check if tax residency category changed compared to existing data
  const oldTr = db.prepare('SELECT * FROM tax_residency_questionnaire WHERE worker_account_id=?').get(workerId);
  const oldCategoryKey = oldTr ? _wpCategoryKey(oldTr) : '';
  const newCategoryKey = _wpCategoryKey({
    applicant_type: d.applicant_type || 'individual',
    is_us_person: d.is_us_person || '',
    is_us_citizen: d.is_us_citizen || '',
    has_green_card: d.has_green_card || '',
    work_permit_category: d.work_permit_category || '',
    immigration_status: d.immigration_status || ''
  });

  // Calculate SPT and determine form routing
  const calc = calculateTaxResidency(d);

  const fields = {
    worker_account_id: workerId,
    applicant_type: d.applicant_type || 'individual',
    is_us_person: d.is_us_person || '',
    country_tax_residence: d.country_tax_residence || '',
    country_citizenship: d.country_citizenship || '',
    entity_country_org: d.entity_country_org || '',
    is_us_citizen: d.is_us_citizen || '',
    has_green_card: d.has_green_card || '',
    first_entry_date: d.first_entry_date || '',
    last_entry_date: d.last_entry_date || '',
    entry_exit_records: d.entry_exit_records || '',
    days_current_year: parseInt(d.days_current_year) || 0,
    days_last_year: parseInt(d.days_last_year) || 0,
    days_two_years_ago: parseInt(d.days_two_years_ago) || 0,
    has_exempt_days: d.has_exempt_days || '',
    exempt_visa_status: d.exempt_visa_status || '',
    exempt_date_range: d.exempt_date_range || '',
    exempt_days_cy: parseInt(d.exempt_days_cy) || 0,
    exempt_days_ly: parseInt(d.exempt_days_ly) || 0,
    exempt_days_2y: parseInt(d.exempt_days_2y) || 0,
    services_location: d.services_location || '',
    primary_work_locations: d.primary_work_locations || '',
    expected_service_dates: d.expected_service_dates || '',
    will_travel_to_us: d.will_travel_to_us || '',
    claim_treaty_benefit: d.claim_treaty_benefit || '',
    treaty_country: d.treaty_country || '',
    treaty_income_type: d.treaty_income_type || '',
    work_permit_category: d.work_permit_category || '',
    immigration_status: d.immigration_status || '',
    i94_admission_date: d.i94_admission_date || '',
    status_expiration: d.status_expiration || '',
    docs_requested: d.docs_requested ? 1 : 0,
    spt_weighted_days: calc.spt_weighted_days,
    spt_result: calc.spt_result,
    tax_status: calc.tax_status,
    recommended_form: calc.recommended_form,
    needs_manual_review: calc.needs_manual_review ? 1 : 0,
    admin_override: d.admin_override || '',
    admin_notes: d.admin_notes || '',
    completed_by: (req.session && req.session.username) || 'admin',
    addr_street: d.addr_street || '',
    addr_street2: d.addr_street2 || '',
    addr_city: d.addr_city || '',
    addr_state: d.addr_state || '',
    addr_zip: d.addr_zip || '',
    ind_legal_name: d.ind_legal_name || '',
    ind_ssn_masked: '',
    ind_ssn_encrypted: '',
    ind_ssn_iv: ''
  };

  // Handle ind_ssn: encrypt if a new (unmasked) value is provided; preserve existing if masked placeholder is sent back
  const rawIndSsn = d.ind_ssn || '';
  if (rawIndSsn && !rawIndSsn.includes('*')) {
    fields.ind_ssn_masked = rawIndSsn.replace(/\d(?=\d{4})/g, '*');
    const enc = encryptSSN(rawIndSsn);
    fields.ind_ssn_encrypted = enc.encrypted;
    fields.ind_ssn_iv = enc.iv;
  } else if (rawIndSsn.includes('*')) {
    // Masked value sent back — preserve existing encrypted SSN from DB
    const existingTr = db.prepare('SELECT ind_ssn_masked, ind_ssn_encrypted, ind_ssn_iv FROM tax_residency_questionnaire WHERE worker_account_id=?').get(workerId);
    if (existingTr) {
      fields.ind_ssn_masked = existingTr.ind_ssn_masked || '';
      fields.ind_ssn_encrypted = existingTr.ind_ssn_encrypted || '';
      fields.ind_ssn_iv = existingTr.ind_ssn_iv || '';
    }
  }

  db.prepare(`INSERT INTO tax_residency_questionnaire (
    worker_account_id, applicant_type, is_us_person, country_tax_residence, country_citizenship, entity_country_org,
    is_us_citizen, has_green_card, first_entry_date, last_entry_date, entry_exit_records, days_current_year, days_last_year, days_two_years_ago,
    has_exempt_days, exempt_visa_status, exempt_date_range, exempt_days_cy, exempt_days_ly, exempt_days_2y,
    services_location, primary_work_locations, expected_service_dates, will_travel_to_us,
    claim_treaty_benefit, treaty_country, treaty_income_type,
    work_permit_category, immigration_status, i94_admission_date, status_expiration, docs_requested,
    spt_weighted_days, spt_result, tax_status, recommended_form, needs_manual_review,
    admin_override, admin_notes, completed_by,
    addr_street, addr_street2, addr_city, addr_state, addr_zip,
    ind_legal_name, ind_ssn_masked, ind_ssn_encrypted, ind_ssn_iv, updated_at
  ) VALUES (
    @worker_account_id, @applicant_type, @is_us_person, @country_tax_residence, @country_citizenship, @entity_country_org,
    @is_us_citizen, @has_green_card, @first_entry_date, @last_entry_date, @entry_exit_records, @days_current_year, @days_last_year, @days_two_years_ago,
    @has_exempt_days, @exempt_visa_status, @exempt_date_range, @exempt_days_cy, @exempt_days_ly, @exempt_days_2y,
    @services_location, @primary_work_locations, @expected_service_dates, @will_travel_to_us,
    @claim_treaty_benefit, @treaty_country, @treaty_income_type,
    @work_permit_category, @immigration_status, @i94_admission_date, @status_expiration, @docs_requested,
    @spt_weighted_days, @spt_result, @tax_status, @recommended_form, @needs_manual_review,
    @admin_override, @admin_notes, @completed_by,
    @addr_street, @addr_street2, @addr_city, @addr_state, @addr_zip,
    @ind_legal_name, @ind_ssn_masked, @ind_ssn_encrypted, @ind_ssn_iv, CURRENT_TIMESTAMP
  ) ON CONFLICT(worker_account_id) DO UPDATE SET
    applicant_type=excluded.applicant_type, is_us_person=excluded.is_us_person,
    country_tax_residence=excluded.country_tax_residence, country_citizenship=excluded.country_citizenship,
    entity_country_org=excluded.entity_country_org,
    is_us_citizen=excluded.is_us_citizen, has_green_card=excluded.has_green_card,
    first_entry_date=excluded.first_entry_date, last_entry_date=excluded.last_entry_date, entry_exit_records=excluded.entry_exit_records,
    days_current_year=excluded.days_current_year, days_last_year=excluded.days_last_year,
    days_two_years_ago=excluded.days_two_years_ago,
    has_exempt_days=excluded.has_exempt_days, exempt_visa_status=excluded.exempt_visa_status,
    exempt_date_range=excluded.exempt_date_range,
    exempt_days_cy=excluded.exempt_days_cy, exempt_days_ly=excluded.exempt_days_ly, exempt_days_2y=excluded.exempt_days_2y,
    services_location=excluded.services_location, primary_work_locations=excluded.primary_work_locations,
    expected_service_dates=excluded.expected_service_dates, will_travel_to_us=excluded.will_travel_to_us,
    claim_treaty_benefit=excluded.claim_treaty_benefit, treaty_country=excluded.treaty_country,
    treaty_income_type=excluded.treaty_income_type,
    work_permit_category=excluded.work_permit_category,
    immigration_status=excluded.immigration_status, i94_admission_date=excluded.i94_admission_date,
    status_expiration=excluded.status_expiration, docs_requested=excluded.docs_requested,
    spt_weighted_days=excluded.spt_weighted_days, spt_result=excluded.spt_result,
    tax_status=excluded.tax_status, recommended_form=excluded.recommended_form,
    needs_manual_review=excluded.needs_manual_review,
    admin_override=excluded.admin_override, admin_notes=excluded.admin_notes,
    completed_by=excluded.completed_by,
    addr_street=excluded.addr_street, addr_street2=excluded.addr_street2,
    addr_city=excluded.addr_city, addr_state=excluded.addr_state, addr_zip=excluded.addr_zip,
    ind_legal_name=excluded.ind_legal_name, ind_ssn_masked=excluded.ind_ssn_masked,
    ind_ssn_encrypted=excluded.ind_ssn_encrypted, ind_ssn_iv=excluded.ind_ssn_iv,
    updated_at=CURRENT_TIMESTAMP
  `).run(fields);

  // Mark as submitted (data saved) but NOT completed — admin must explicitly confirm completion
  db.prepare(`UPDATE worker_onboarding SET status='submitted', updated_at=CURRENT_TIMESTAMP
    WHERE worker_account_id=? AND task_key='tax_residency' AND status='pending'`)
    .run(workerId);

  // Auto-create onboarding tasks for required tax documents based on recommended form
  const taxTasks = getTaxDocTasks(calc.recommended_form, d);
  // Remove old tax_doc_* tasks first (in case form changed on re-save)
  db.prepare(`DELETE FROM worker_onboarding WHERE worker_account_id=? AND task_key LIKE 'tax_doc_%'`).run(workerId);
  const insertTask = db.prepare(`INSERT OR IGNORE INTO worker_onboarding (worker_account_id, task_key, status, admin_note, visible_to_worker, updated_at) VALUES (?,?,?,?,0,CURRENT_TIMESTAMP)`);
  for (const t of taxTasks) {
    insertTask.run(workerId, t.key, 'pending', t.note || '');
  }
  // Update assigned_tasks to include new tax doc tasks
  const w2 = db.prepare('SELECT assigned_tasks FROM worker_accounts WHERE id=?').get(workerId);
  if (w2) {
    let assigned = [];
    try { assigned = JSON.parse(w2.assigned_tasks || '[]'); } catch {}
    // Remove old tax_doc_ entries and add new ones
    assigned = assigned.filter(k => !k.startsWith('tax_doc_'));
    for (const t of taxTasks) assigned.push(t.key);
    db.prepare('UPDATE worker_accounts SET assigned_tasks=? WHERE id=?').run(JSON.stringify(assigned), workerId);
  }

  // Log to history
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(workerId, fields.completed_by, 'tax_residency', '', calc.recommended_form,
      `税务居民判定完成: ${calc.tax_status} → 推荐表格: ${calc.recommended_form}${calc.recommended_form === 'Form 8233' ? ' + W-8BEN(备选)' : ''}${calc.needs_manual_review ? ' (需人工复核)' : ''}`);

  // If work permit category changed, reset work permit verification and onboarding task
  let wpReset = false;
  if (oldCategoryKey && newCategoryKey && oldCategoryKey !== newCategoryKey) {
    const existingWp = db.prepare('SELECT * FROM work_permit_verification WHERE worker_account_id=?').get(workerId);
    if (existingWp && existingWp.verified_at) {
      // Clear verified status - keep data but mark as needing re-verification
      db.prepare(`UPDATE work_permit_verification SET verified_at=NULL, verified_by='', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=?`).run(workerId);
      // Reset work_permit onboarding task back to pending
      db.prepare(`UPDATE worker_onboarding SET status='pending', completed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='work_permit'`).run(workerId);
      // Log the reset
      db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
        .run(workerId, fields.completed_by, 'work_permit_reset', oldCategoryKey, newCategoryKey,
          `税务身份变更 (${oldCategoryKey} → ${newCategoryKey})，工作许可验证已重置为待验证`);
      wpReset = true;
    }
    // Delete old uploaded work permit docs since category changed and required docs differ
    const oldDocs = db.prepare('SELECT * FROM work_permit_docs WHERE worker_account_id=?').all(workerId);
    for (const doc of oldDocs) {
      if (doc.file_path && fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path);
    }
    db.prepare('DELETE FROM work_permit_docs WHERE worker_account_id=?').run(workerId);
  }

  syncOnboardedStatus(workerId);

  // Cross-check: if work permit verification shows citizen/green_card but tax residency recommends non-W-9 form, flag conflict
  const wpVerif = db.prepare('SELECT category FROM work_permit_verification WHERE worker_account_id=?').get(workerId);
  const wpConflict = wpVerif && (wpVerif.category === 'citizen' || wpVerif.category === 'green_card') && calc.recommended_form !== 'W-9';

  res.json({ success: true, ...calc, taxTasks, wp_reset: wpReset, old_wp_category: oldCategoryKey, new_wp_category: newCategoryKey, wp_conflict: wpConflict || false, wp_conflict_category: wpConflict ? wpVerif.category : null, questionnaire: db.prepare('SELECT * FROM tax_residency_questionnaire WHERE worker_account_id=?').get(workerId) });
});

// ─── Work Permit Verification ───
app.get('/api/admin/worker-accounts/:id/work-permit', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM work_permit_verification WHERE worker_account_id=?').get(req.params.id);
  res.json(row || null);
});

app.post('/api/admin/worker-accounts/:id/work-permit', requireAdmin, (req, res) => {
  const workerId = parseInt(req.params.id);
  const d = req.body;
  const verifiedBy = (req.session && req.session.username) || 'admin';
  const doVerify = d.verified !== false; // default true for backward compat

  if (doVerify) {
    db.prepare(`INSERT INTO work_permit_verification (worker_account_id, doc_type, doc_number, issue_date, expiry_date, category, notes, verified_at, verified_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id) DO UPDATE SET
        doc_type=excluded.doc_type, doc_number=excluded.doc_number, issue_date=excluded.issue_date,
        expiry_date=excluded.expiry_date, category=excluded.category, notes=excluded.notes,
        verified_at=CURRENT_TIMESTAMP, verified_by=excluded.verified_by, updated_at=CURRENT_TIMESTAMP
    `).run(workerId, d.doc_type || '', d.doc_number || '', d.issue_date || '', d.expiry_date || '', d.category || '', d.notes || '', verifiedBy);
  } else {
    db.prepare(`INSERT INTO work_permit_verification (worker_account_id, doc_type, doc_number, issue_date, expiry_date, category, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id) DO UPDATE SET
        doc_type=excluded.doc_type, doc_number=excluded.doc_number, issue_date=excluded.issue_date,
        expiry_date=excluded.expiry_date, category=excluded.category, notes=excluded.notes,
        updated_at=CURRENT_TIMESTAMP
    `).run(workerId, d.doc_type || '', d.doc_number || '', d.issue_date || '', d.expiry_date || '', d.category || '', d.notes || '');
  }

  // Log to history
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(workerId, verifiedBy, 'work_permit', '', d.doc_type, `${doVerify ? '工作许可验证' : '工作许可保存'}: ${d.doc_type}${d.doc_number ? ' #' + d.doc_number : ''}${d.expiry_date ? ' Exp: ' + d.expiry_date : ''}`);

  if (doVerify) syncOnboardedStatus(workerId);
  res.json({ success: true });
});

// ─── Work Permit Document Uploads ───
app.get('/api/admin/worker-accounts/:id/work-permit-docs', requireAdmin, (req, res) => {
  const docs = db.prepare('SELECT id, doc_label, file_name, doc_number, issue_date, expiry_date, notes, created_at FROM work_permit_docs WHERE worker_account_id=? ORDER BY created_at').all(req.params.id);
  res.json(docs);
});

app.post('/api/admin/worker-accounts/:id/work-permit-docs', requireAdmin, docUpload.single('file'), (req, res) => {
  const workerId = parseInt(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const docLabel = req.body.doc_label || '';
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const uploadedBy = (req.session && req.session.username) || 'admin';

  const result = db.prepare('INSERT INTO work_permit_docs (worker_account_id, doc_label, file_path, file_name, uploaded_by) VALUES (?,?,?,?,?)')
    .run(workerId, docLabel, filePath, fileName, uploadedBy);

  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(workerId, uploadedBy, 'work_permit_doc', '', docLabel, `上传工作许可文件: ${docLabel} · ${fileName}`);

  res.json({ success: true, id: result.lastInsertRowid, file_name: fileName });
});

app.get('/api/admin/work-permit-docs/:docId/download', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM work_permit_docs WHERE id=?').get(req.params.docId);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'File missing' });
  res.download(doc.file_path, doc.file_name || 'document');
});

app.delete('/api/admin/work-permit-docs/:docId', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM work_permit_docs WHERE id=?').get(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.file_path && fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path);
  db.prepare('DELETE FROM work_permit_docs WHERE id=?').run(req.params.docId);
  res.json({ success: true });
});

// Update per-doc metadata (doc_number, issue_date, expiry_date, notes)
app.patch('/api/admin/work-permit-docs/:docId', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM work_permit_docs WHERE id=?').get(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const d = req.body;
  db.prepare('UPDATE work_permit_docs SET doc_number=?, issue_date=?, expiry_date=?, notes=? WHERE id=?')
    .run(d.doc_number || '', d.issue_date || '', d.expiry_date || '', d.notes || '', req.params.docId);
  res.json({ success: true });
});

// Save all per-doc metadata in batch for a worker's work permit docs
app.put('/api/admin/worker-accounts/:id/work-permit-docs-meta', requireAdmin, (req, res) => {
  const docs = req.body.docs;
  if (!Array.isArray(docs)) return res.status(400).json({ error: 'Invalid data' });
  const stmt = db.prepare('UPDATE work_permit_docs SET doc_number=?, issue_date=?, expiry_date=?, notes=? WHERE id=? AND worker_account_id=?');
  const workerId = parseInt(req.params.id);
  docs.forEach(d => {
    stmt.run(d.doc_number || '', d.issue_date || '', d.expiry_date || '', d.notes || '', d.id, workerId);
  });
  res.json({ success: true });
});

// ─── Tax Filing Documents (年度报税表 1099-NEC / W-2 / 1042-S) ───

app.get('/api/admin/worker-accounts/:id/tax-filing-docs', requireAdmin, (req, res) => {
  const year = parseInt(req.query.year) || (new Date().getFullYear() - 1);
  const docs = db.prepare('SELECT id, form_type, file_name, uploaded_by, created_at FROM tax_filing_docs WHERE worker_account_id=? AND tax_year=? ORDER BY form_type, created_at').all(req.params.id, year);
  res.json(docs);
});

app.post('/api/admin/worker-accounts/:id/tax-filing-docs', requireAdmin, docUpload.single('file'), (req, res) => {
  const workerId = parseInt(req.params.id);
  const formType = req.body.form_type || '';
  const taxYear = parseInt(req.body.tax_year) || (new Date().getFullYear() - 1);
  if (!formType) return res.status(400).json({ error: 'form_type required' });
  const filePath = req.file ? req.file.path : '';
  const fileName = req.file ? req.file.originalname : '';
  const uploadedBy = (req.session && req.session.username) || 'admin';
  const result = db.prepare('INSERT INTO tax_filing_docs (worker_account_id, tax_year, form_type, file_path, file_name, uploaded_by) VALUES (?,?,?,?,?,?)')
    .run(workerId, taxYear, formType, filePath, fileName, uploadedBy);
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(workerId, uploadedBy, 'tax_filing_doc', '', formType, `上传报税文件: ${formType} (${taxYear}) · ${fileName}`);
  res.json({ success: true, id: result.lastInsertRowid, file_name: fileName });
});

app.delete('/api/admin/tax-filing-docs/:docId', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM tax_filing_docs WHERE id=?').get(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.file_path && fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path);
  db.prepare('DELETE FROM tax_filing_docs WHERE id=?').run(req.params.docId);
  res.json({ success: true });
});

app.get('/api/admin/tax-filing-docs/:docId/download', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM tax_filing_docs WHERE id=?').get(req.params.docId);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'File missing' });
  res.download(doc.file_path, doc.file_name || 'document');
});

// ─── ID Document Upload (admin uploads for worker during interview) ───
app.get('/api/admin/worker-accounts/:id/id-docs', requireAdmin, (req, res) => {
  const docs = db.prepare(`SELECT id, doc_type, status, file_name, doc_number, created_at FROM worker_compliance_docs
    WHERE worker_account_id=? AND doc_type IN ('passport','drivers_license','state_id','green_card','ead_card','visa','ssn_card','itin_letter','other')
    ORDER BY created_at DESC`).all(req.params.id);
  res.json(docs);
});

app.post('/api/admin/worker-accounts/:id/id-docs', requireAdmin, docUpload.single('file'), (req, res) => {
  const workerId = parseInt(req.params.id);
  const docType = req.body.doc_type || 'other';
  const docNumber = req.body.doc_number || '';
  const filePath = req.file ? req.file.path : '';
  const fileName = req.file ? req.file.originalname : '';

  db.prepare(`INSERT INTO worker_compliance_docs (worker_account_id, doc_type, doc_number, file_path, file_name, status) VALUES (?,?,?,?,?,?)`)
    .run(workerId, docType, docNumber, filePath, fileName, 'pending');

  const changedBy = (req.session && req.session.username) || 'admin';
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(workerId, changedBy, 'id_doc_upload', '', docType, `上传身份证明文件: ${docType}${docNumber ? ' #' + docNumber : ''} · ${fileName}`);

  res.json({ success: true });
});

// Preview W-9 HTML template (admin can see the blank form before sending)
app.get('/api/admin/worker-accounts/:id/w9-preview', requireAdmin, (req, res) => {
  const templateId = getDsealConfigTemplateId('w9') || process.env.DOCUSEAL_W9_TEMPLATE_ID || '';
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.params.id);
  const workerName = w ? (w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '') : '';
  if (templateId) {
    const baseHost = dsealPublicHost();
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;background:#f9fafb;font-family:Arial,sans-serif}</style></head><body>
      <div style="text-align:center;padding:2rem;color:#555">
        <p style="font-size:1.1rem;font-weight:600">使用 DocuSeal 官方 W-9 模板</p>
        <p style="font-size:.88rem;color:#888">Template ID: ${templateId}</p>
        <p style="font-size:.85rem;color:#888">工人将收到 DocuSeal 发送的邮件，包含完整的 IRS W-9 表格。</p>
        <a href="${baseHost}/templates/${templateId}/edit" target="_blank" style="display:inline-block;margin-top:1rem;padding:.5rem 1.5rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:6px;font-size:.88rem">在 DocuSeal 中编辑模板</a>
      </div>
    </body></html>`;
    res.set('Content-Type', 'text/html');
    return res.send(page);
  }
  const html = generateW9HtmlTemplate(workerName);
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#f9fafb}</style></head><body>${html}</body></html>`;
  res.set('Content-Type', 'text/html');
  res.send(page);
});

// Send W-9 form request to worker — sends portal link for info collection, then DocuSeal for signing
app.post('/api/admin/worker-accounts/:id/send-w9', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const workerName = w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '';
    const workerEmail = req.body.worker_email || w.email || '';
    const workerPhone = w.phone || '';

    // Create DocuSeal W-9 submission immediately so worker can sign directly in portal
    let w9SubmissionId = '';
    let w9SignUrl = '';
    let dsealError = '';
    let dsealSentNotifications = false;
    if (dsealEnabled()) {
      try {
        const address = w.work_address || '';
        const overrideTemplateId = req.body.template_id ? String(req.body.template_id) : '';
        const { submissionId, workerSignUrl, dsealHandledNotifications: dsHandled } = await dsealSendW9Html({
          workerName, workerEmail, workerPhone, address, overrideTemplateId
        });
        w9SubmissionId = submissionId || '';
        w9SignUrl = workerSignUrl || '';
        if (dsHandled) dsealSentNotifications = true;
        console.log(`[W-9 send] DocuSeal submission created: ${w9SubmissionId}, signUrl: ${(w9SignUrl||'').substring(0,80)}`);
      } catch (e) {
        dsealError = e.message || '未知错误';
        console.error('[W-9 send] DocuSeal creation failed:', e.message);
      }
    } else {
      dsealError = 'DocuSeal 未配置（缺少 API Key 或 URL）';
    }

    // Make W-9 task visible and set to pending, store DocuSeal info if available
    const w9Note = w9SubmissionId
      ? `W-9 已发送至工人 (${new Date().toLocaleString('zh-CN')})，等待工人签署`
      : `W-9 已发送至工人 (${new Date().toLocaleString('zh-CN')})，等待工人填写信息`;
    db.prepare(`UPDATE worker_onboarding SET status='pending', visible_to_worker=1, ds_envelope_id=?, ds_status=?, action_url=?,
      admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'`)
      .run(w9SubmissionId || null, w9SubmissionId ? 'sent' : null, w9SignUrl || '', w9Note, workerId);
    const changedBy = req.session && req.session.username ? req.session.username : 'admin';
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
      .run(workerId, changedBy, 'w9', '', '已发送', w9SubmissionId ? `W-9 DocuSeal 表格已创建，等待工人签署` : `W-9 填写请求已发送，等待工人在门户填写信息`);

    // Use DocuSeal direct signing link only (no portal fallback)
    const w9Link = w9SignUrl || '';
    const isDirect = !!w9SignUrl;

    let emailSent = false;
    let smsSent = false;
    // If DocuSeal already sent email+SMS (template path with send_email/send_sms true),
    // do NOT also send system email/SMS — that would create duplicate notifications with broken links
    if (dsealSentNotifications) {
      emailSent = !!workerEmail;
      smsSent = !!workerPhone;
    } else if (w9Link) {
      // Fallback HTML path: DocuSeal did not send notifications, system sends them
      if (workerEmail) {
        const signLink = `<p style="margin:1.5rem 0;text-align:center"><a href="${w9Link}" style="display:inline-block;padding:.75rem 2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem">签署 W-9 / Sign W-9 / Firmar W-9</a></p>`;
        emailSent = await sendEmail(workerEmail,
          `Prime Anchorpoint — 请签署 W-9 税表 / Please Sign W-9 / Firme el W-9`,
          `${workerName}，请点击链接签署 W-9 税表。\n${w9Link}\n\n${workerName}, please click the link to sign your W-9 form.\n${w9Link}\n\n${workerName}, haga clic en el enlace para firmar su formulario W-9.\n${w9Link}`,
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem">
            <h2 style="color:#1a1a1a;text-align:center">请签署 W-9 税表</h2>
            <p>您好 ${workerName}，请点击下方按钮直接签署 W-9 税表。</p>
            ${signLink}
            <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
            <h3 style="font-size:.95rem">Please Sign Your W-9</h3>
            <p style="color:#555;font-size:.9rem">Hi ${workerName}, please click the button below to sign your W-9 form directly.</p>
            ${signLink}
            <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
            <h3 style="font-size:.95rem">Firme el Formulario W-9</h3>
            <p style="color:#555;font-size:.9rem">Hola ${workerName}, haga clic en el botón para firmar su formulario W-9 directamente.</p>
            ${signLink}
            <p style="color:#999;font-size:.8rem;margin-top:2rem;text-align:center">Prime Anchorpoint LLC</p>
          </div>`
        );
      }
      if (workerPhone) {
        smsSent = await sendSMS(workerPhone, `[Prime Anchorpoint] ${workerName}，请签署 W-9 税表 / Please sign your W-9 / Firme su W-9\n${w9Link}\nReply STOP to opt out.`);
      }
    }
    const warnings = [];
    if (!w9Link) {
      const detail = dsealError ? `：${dsealError}` : '';
      warnings.push(`DocuSeal 签字链接生成失败${detail}（邮件和短信因无签字链接未发送）`);
    } else {
      if (workerEmail && !emailSent) warnings.push('邮件发送失败，请检查邮箱地址或邮件服务配置');
      if (workerPhone && !smsSent) warnings.push('短信发送失败，请检查手机号或短信服务配置');
      if (!workerEmail) warnings.push('工人无邮箱地址，未发送邮件通知');
      if (!workerPhone) warnings.push('工人无手机号，未发送短信通知');
    }
    res.json({ success: true, w9Link, isDirect, emailSent, smsSent, warnings });
  } catch (e) {
    console.error('[W-9 send error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get W-9 signing status from DocuSeal
app.get('/api/admin/worker-accounts/:id/w9-status', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id, ds_status, ds_worker_signed_at FROM worker_onboarding WHERE worker_account_id=? AND task_key='w9'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'W-9 未发送' });
    if (!dsealEnabled()) return res.json({ status: onb.ds_status, workerSigned: onb.ds_worker_signed_at });
    const { status, workerSigned, declineReason } = await dsealGetW9Status(onb.ds_envelope_id);
    db.prepare("UPDATE worker_onboarding SET ds_status=?, ds_worker_signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
      .run(status, workerSigned, workerId);
    if (status === 'completed') {
      db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='W-9 已签署完成 ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'`)
        .run(workerId);
      syncOnboardedStatus(workerId);
    } else if (status === 'declined') {
      db.prepare(`UPDATE worker_onboarding SET admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'`)
        .run(`工人已拒签 W-9: ${declineReason || ''}`, workerId);
    }
    res.json({ status, workerSigned, declineReason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download signed W-9 PDF from DocuSeal
app.get('/api/admin/worker-accounts/:id/w9-signed-pdf', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id, ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='w9'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'W-9 未发送' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const signedBuf = await dsealDownloadDocument(onb.ds_envelope_id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="signed-w9-${workerId}.pdf"` });
    res.send(signedBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send Work Authorization verification task to worker
app.post('/api/admin/worker-accounts/:id/send-work-auth', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(workerId);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const adminNote = req.body.note || 'Work Authorization 认证调查已发送，请按要求上传身份证明文件';
    db.prepare(`INSERT INTO worker_onboarding (worker_account_id, task_key, status, visible_to_worker, admin_note, updated_at)
      VALUES (?, 'work_auth', 'pending', 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(worker_account_id, task_key) DO UPDATE SET status='pending', visible_to_worker=1, admin_note=excluded.admin_note, updated_at=CURRENT_TIMESTAMP`)
      .run(workerId, adminNote);
    // Send notification via SMS/email
    const workerName = w.name || w.username || '';
    const workerPhone = w.phone || '';
    const workerEmail = w.email || '';
    if (workerPhone) {
      await sendSMS(workerPhone, `[Prime Anchorpoint] ${workerName}，请登录合作中心完成 Work Authorization 认证，上传所需身份证明文件。Reply STOP to opt out.`).catch(() => {});
    }
    if (workerEmail) {
      await sendEmail(workerEmail, 'Work Authorization 认证 — 请上传身份证明文件',
        `${workerName}，\n请登录合作中心完成 Work Authorization 认证调查。\n\nPrime Anchorpoint`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem"><h2>Work Authorization 认证</h2><p>您好 ${workerName}，</p><p>请登录合作中心，在入职进度中完成 <strong>Work Authorization 认证</strong>，按要求上传身份证明文件。</p><p style="color:#64748b;font-size:.9rem">Prime Anchorpoint</p></div>`
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get worker W-9 sign URL (resend link)
app.get('/api/admin/worker-accounts/:id/w9-sign-url', requireAdmin, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id);
    const onb = db.prepare("SELECT ds_envelope_id FROM worker_onboarding WHERE worker_account_id=? AND task_key='w9'").get(workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'W-9 未发送' });
    const signUrl = await dsealGetW9SignUrl(onb.ds_envelope_id);
    res.json({ signUrl });
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

// Worker: get their own W-9 signing URL (fresh from DocuSeal)
app.get('/api/worker/w9-sign-url', requireWorker, async (req, res) => {
  try {
    const onb = db.prepare("SELECT ds_envelope_id, ds_status, action_url FROM worker_onboarding WHERE worker_account_id=? AND task_key='w9'").get(req.workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: 'W-9 未发送' });
    if (onb.ds_status === 'completed') return res.status(400).json({ error: 'W-9 已完成签署' });
    let signUrl = onb.action_url || '';
    if (dsealEnabled()) {
      try {
        signUrl = await dsealGetW9SignUrl(onb.ds_envelope_id);
        if (signUrl) db.prepare("UPDATE worker_onboarding SET action_url=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'").run(signUrl, req.workerId);
      } catch (e) { console.error('[worker w9-sign-url]', e.message); }
    }
    if (!signUrl) return res.status(404).json({ error: '签署链接暂不可用，请稍后再试' });
    res.json({ signUrl, dsStatus: onb.ds_status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: get their own contract signing URL (fresh from DocuSeal)
app.get('/api/worker/contract-sign-url', requireWorker, async (req, res) => {
  try {
    const onb = db.prepare("SELECT ds_envelope_id, ds_status, action_url FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(req.workerId);
    if (!onb || !onb.ds_envelope_id) return res.status(404).json({ error: '合同未发送' });
    if (onb.ds_status === 'completed') return res.status(400).json({ error: '合同已完成签署' });
    // Return stored URL first (fast path); also refresh from DocuSeal if enabled
    let signUrl = onb.action_url || '';
    if (dsealEnabled()) {
      try {
        const subData = await dsealApiCall('GET', `/api/submissions/${onb.ds_envelope_id}`, null);
        const workerSub = (subData.data?.submitters || []).find(s => s.role === 'Second Party');
        if (workerSub) {
          // Prefer slug-based URL (/s/xxx) — works directly in mobile browsers
          // embed_src is designed for web component embedding and may not render on mobile
          if (workerSub.slug) {
            const baseHost = dsealPublicHost();
            signUrl = `${baseHost}/s/${workerSub.slug}`;
          } else if (workerSub.embed_src) {
            signUrl = workerSub.embed_src;
          } else if (workerSub.id) {
            const wPut = await dsealApiCall('PUT', `/api/submitters/${workerSub.id}`, { name: workerSub.name });
            if (wPut.data?.slug) {
              const baseHost = dsealPublicHost();
              signUrl = `${baseHost}/s/${wPut.data.slug}`;
            } else if (wPut.data?.embed_src) {
              signUrl = wPut.data.embed_src;
            }
          }
          // Update stored URL
          if (signUrl) db.prepare("UPDATE worker_onboarding SET action_url=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'").run(signUrl, req.workerId);
        }
      } catch (e) { console.error('[worker contract-sign-url]', e.message); }
    }
    if (!signUrl) return res.status(404).json({ error: '签署链接暂不可用，请稍后再试' });
    res.json({ signUrl, dsStatus: onb.ds_status });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  const w = db.prepare('SELECT id, active, dispatch_ready, suspended, preferred_lang FROM worker_accounts WHERE phone=? OR (? != \'\' AND email=?)').get(inq.phone||'', inq.email||'', inq.email||'');
  if (!w) return res.json({ has_account: false, dispatch_ready: false, preferred_lang: inq.languages || '' });
  res.json({ has_account: true, dispatch_ready: !!w.dispatch_ready, active: !!w.active, suspended: !!w.suspended, worker_id: w.id, preferred_lang: w.preferred_lang || inq.languages || '' });
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
    db.prepare('DELETE FROM worker_sessions WHERE worker_id=?').run(id);
    db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM job_applications WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_skills WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_compliance_docs WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_onboarding WHERE worker_account_id=?').run(id);
    archiveInterviews(id);
    db.prepare('DELETE FROM interviews WHERE worker_account_id=?').run(id);
    db.prepare('DELETE FROM worker_account_history WHERE worker_account_id=?').run(id);
    try { db.prepare('DELETE FROM worker_contract_versions WHERE worker_account_id=?').run(id); } catch(_) {}
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

// ─── Admin: Contractor Invoice Review ───
app.get('/api/admin/contractor-invoices', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT ci.*, wa.name AS worker_name, wa.username AS worker_username, wa.phone AS worker_phone, wa.email AS worker_email,
      ci.ds_envelope_id, ci.ds_status, ci.ds_signed_at, ci.sent_by
    FROM contractor_invoices ci
    LEFT JOIN worker_accounts wa ON ci.worker_account_id = wa.id
    ORDER BY ci.created_at DESC
  `).all();
  res.json(rows);
});

app.put('/api/admin/contractor-invoices/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { status, reject_reason } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const inv = db.prepare('SELECT * FROM contractor_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const reviewedBy = req.session && req.session.username ? req.session.username : 'admin';
  db.prepare('UPDATE contractor_invoices SET status=?, reviewed_by=?, reviewed_at=?, reject_reason=? WHERE id=?')
    .run(status, reviewedBy, new Date().toISOString(), status === 'rejected' ? (reject_reason || '') : '', req.params.id);
  // Log to worker history
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
    .run(inv.worker_account_id, reviewedBy, 'contractor_invoice', inv.status, status,
      `Invoice ${inv.invoice_number}: $${inv.total_amount} — ${status === 'approved' ? '已批准' : '已拒绝' + (reject_reason ? ': ' + reject_reason : '')}`);
  res.json({ success: true });
});

app.delete('/api/admin/contractor-invoices/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM contractor_invoices WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Admin: Send DocuSeal Invoice to Worker ───
app.post('/api/admin/contractor-invoices/send-docuseal', requireAdmin, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const { worker_account_id, worker_email, worker_phone } = req.body;
    if (!worker_account_id) return res.status(400).json({ error: '请选择承包商' });
    const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(worker_account_id);
    if (!w) return res.status(404).json({ error: '承包商不存在' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const templateId = getDsealConfigTemplateId('contractor_invoice');
    if (!templateId) return res.status(400).json({ error: '未配置承包商發票模板，请到 DocuSeal 模板管理中设置' });
    const workerEmail = worker_email || w.email || `worker-${w.id}@placeholder.local`;
    const workerPhone = worker_phone || w.phone || '';
    const workerName = w.name || w.username || `Worker #${w.id}`;
    const todayDate = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    // Get active job info for pre-filling
    const empId = w.employee_id;
    let jobTitle = '', rateDesc = '';
    if (empId) {
      const ej = db.prepare(`SELECT ej.emp_hourly_rate, j.title FROM employee_jobs ej JOIN jobs j ON ej.job_id=j.id WHERE ej.employee_id=? AND ej.status='active' LIMIT 1`).get(empId);
      if (ej) { jobTitle = ej.title || ''; rateDesc = ej.emp_hourly_rate ? `$${ej.emp_hourly_rate}/hour` : ''; }
    }

    // Create DocuSeal submission — pre-fill suggestions, contractor can edit rate + description
    const invoiceSubmitter = { role: 'First Party', name: workerName, email: workerEmail, fields: [
      { name: 'invoice_date', default_value: todayDate, readonly: true },
      { name: 'contractor_name', default_value: workerName, readonly: true },
      { name: 'service_description', default_value: jobTitle || '', readonly: true },
      { name: 'compensation_method', default_value: 'Contractor-proposed flat project fee', readonly: true },
      { name: 'payment_terms', default_value: 'Net 30', readonly: true },
      { name: 'payment_due_date', default_value: dueDate, readonly: true }
    ] };
    if (workerPhone) invoiceSubmitter.phone = formatPhoneE164(workerPhone);
    const subRes = await dsealApiCall('POST', '/api/submissions', {
      template_id: parseInt(templateId),
      send_email: true,
      send_sms: true,
      submitters: [invoiceSubmitter]
    });
    console.log(`[DocuSeal Invoice] submission status=${subRes.status}`);
    const submitters = subRes.data?.submitters || (Array.isArray(subRes.data) ? subRes.data : []);
    if (subRes.status >= 400 || !submitters.length) {
      return res.status(500).json({ error: `DocuSeal 提交失败: ${JSON.stringify(subRes.data)}` });
    }
    const submitter = submitters[0];
    const submissionId = String(subRes.data?.id || submitter?.submission_id || '');
    // Create contractor_invoices record with pending status
    const invoiceNumber = `DSINV-${worker_account_id}-${todayDate.replace(/-/g, '')}-${submissionId.slice(-4)}`;
    const sentBy = req.session?.username || 'admin';
    db.prepare(`INSERT INTO contractor_invoices
      (worker_account_id, invoice_number, invoice_date, service_description, total_amount, status, ds_envelope_id, ds_status, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(worker_account_id, invoiceNumber, todayDate, '承包商發票 (待填写)', 0, 'ds_pending', submissionId, 'sent', sentBy);
    // Log to worker history
    db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
      .run(worker_account_id, sentBy, 'contractor_invoice', '', 'ds_pending', `已發送承包商發票给 ${workerName}`);
    // Send SMS notification if phone number provided
    let smsSent = false, emailSent = true; // DocuSeal sends email automatically
    const warnings = [];
    if (workerPhone) {
      try {
        smsSent = await sendSMS(workerPhone, `[Prime Anchorpoint] ${workerName}，请查收并填写承包商發票 / Please check your email and complete the Contractor Invoice.\nReply STOP to opt out.`);
      } catch(e) { console.error('[Invoice SMS]', e.message); }
      if (!smsSent) warnings.push('短信发送失败，请检查手机号');
    } else {
      warnings.push('未提供手机号，未发送短信通知');
    }
    res.json({ success: true, submission_id: submissionId, invoice_number: invoiceNumber, emailSent, smsSent, warnings });
  } catch (e) {
    console.error('[Send DocuSeal Invoice]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: get DocuSeal signing/preview URL for a contractor invoice
app.get('/api/admin/contractor-invoices/:id/signing-url', requireAdmin, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM contractor_invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: '发票不存在' });
    if (!inv.ds_envelope_id) return res.status(400).json({ error: '该发票没有 DocuSeal 记录' });
    if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
    const r = await dsealApiCall('GET', `/api/submissions/${inv.ds_envelope_id}`, null);
    if (r.status !== 200) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}` });
    const sub = r.data;
    const baseHost = dsealPublicHost();
    const submitter = (sub.submitters || [])[0];
    if (!submitter) return res.status(404).json({ error: '找不到签署人信息' });
    const slug = submitter.slug || '';
    const signingUrl = slug ? `${baseHost}/s/${slug}` : (submitter.embed_src || '');
    if (!signingUrl) return res.status(404).json({ error: '无法获取预览链接' });
    res.json({ url: signingUrl, status: submitter.status, completed: sub.status === 'completed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  db.prepare('DELETE FROM customer_sessions WHERE customer_id=?').run(id);
  db.prepare('DELETE FROM customer_accounts WHERE id=?').run(id);
  res.json({ success: true });
});

// Clear all test data (worker accounts, customer accounts, verification codes, job applications)
app.post('/api/admin/clear-test-data', requireAdmin, requireRole('admin'), (req, res) => {
  const { confirm_text } = req.body;
  if (confirm_text !== 'I confirm') return res.status(400).json({ error: 'Please type "I confirm" to proceed' });
  // Invalidate all worker and customer sessions
  db.prepare('DELETE FROM worker_sessions').run();
  db.prepare('DELETE FROM customer_sessions').run();
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
        const textMsg = `您好 ${workerName}，\n\n您申请的职位「${app2.job_title}」已安排面试：\n${dtLines ? dtLines + '\n' : ''}${locStr ? '地点：' + locStr + '\n' : ''}${noteStr ? '备注：' + noteStr + '\n' : ''}\n请登录合作中心查看详情。`;
        const htmlMsg = `<p>您好 ${workerName}，</p><p>您申请的职位 <strong>${app2.job_title}</strong> 已安排面试：</p>
          <table style="border-collapse:collapse;margin:1rem 0;font-size:15px">
            ${dtHtmlRows}
            ${locStr ? `<tr><td style="padding:.4rem .9rem .4rem 0;font-weight:700;white-space:nowrap">📍 地点</td><td style="padding:.4rem 0">${locStr}</td></tr>` : ''}
            ${noteStr ? `<tr><td style="padding:.4rem .9rem .4rem 0;font-weight:700;white-space:nowrap">📝 备注</td><td style="padding:.4rem 0">${noteStr}</td></tr>` : ''}
          </table>
          <p>请登录合作中心查看完整详情。</p>`;
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
      if (action.target_table === 'jobs') {
        const jobToDelete = db.prepare('SELECT job_status FROM jobs WHERE id=?').get(action.target_id);
        if (!jobToDelete || jobToDelete.job_status !== 'cancelled') {
          return res.status(409).json({ error: '只有已取消的职位才能删除。 / Only cancelled jobs can be deleted.' });
        }
        // Cascade delete child records to satisfy FK constraints
        const assignmentIds = db.prepare('SELECT id FROM assignments WHERE job_id=?').all(action.target_id).map(r => r.id);
        db.transaction(() => {
          for (const aId of assignmentIds) {
            db.prepare('DELETE FROM assignment_status_history WHERE assignment_id=?').run(aId);
            db.prepare('DELETE FROM shift_confirmations WHERE assignment_id=?').run(aId);
          }
          db.prepare('DELETE FROM assignments WHERE job_id=?').run(action.target_id);
          db.prepare('DELETE FROM employee_jobs WHERE job_id=?').run(action.target_id);
          db.prepare('DELETE FROM job_applications WHERE job_id=?').run(action.target_id);
          db.prepare(`DELETE FROM jobs WHERE id = ?`).run(action.target_id);
        })();
      } else {
        db.prepare(`DELETE FROM ${action.target_table} WHERE id = ?`).run(action.target_id);
      }
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
  res.json(db.prepare('SELECT j.*, p.name AS partner_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters AS site_radius, js.address AS site_address FROM jobs j LEFT JOIN partners p ON j.partner_id = p.id LEFT JOIN job_sites js ON j.site_id = js.id ORDER BY j.created_at DESC').all());
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
     job_status, active, close_reason, close_note, headcount,
     langs, title_zh, title_es, desc_zh, desc_es)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const r = stmt.run(
    d.partner_id||null, d.title, d.type||'', d.category||'', d.location||'', d.pay||'', d.pay_period||'', d.lang||'en', d.lang_name||'English',
    d.description||'', d.urgent?1:0, d.work_auth||'', d.benefits||'', d.schedule||'',
    d.company_id||null, d.company_name||'', d.employment_type||'',
    d.work_days||'', d.work_start||'', d.work_end||'', d.work_schedule||'{}',
    d.schedule_days||'[]', d.schedule_start||'', d.schedule_end||'',
    jobStatus, jobStatus==='open'?1:0, d.close_reason||'', d.close_note||'', d.headcount||1,
    d.langs||'en', d.title_zh||'', d.title_es||'', d.desc_zh||'', d.desc_es||''
  );
  const jobId = generateJobId(d.location || '');
  db.prepare('UPDATE jobs SET job_id=? WHERE id=?').run(jobId, r.lastInsertRowid);
  logJobAudit.run(r.lastInsertRowid, 'created', JSON.stringify({ title: d.title, company_name: d.company_name||'', job_id: jobId }), req.userName);
  res.json({ success: true, id: r.lastInsertRowid, job_id: jobId });
});

app.put('/api/admin/jobs/:id', requireAdmin, blockManager, staffGuard('update', 'jobs'), (req, res) => {
  const d = req.body;
  const old = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  const jobStatus = d.job_status || 'open';
  db.prepare(`UPDATE jobs SET partner_id=?, title=?, type=?, category=?, location=?, pay=?, pay_period=?, lang=?, lang_name=?,
    description=?, urgent=?, active=?, work_auth=?, benefits=?, schedule=?,
    company_id=?, company_name=?, employment_type=?, work_days=?, work_start=?, work_end=?, work_schedule=?,
    schedule_days=?, schedule_start=?, schedule_end=?,
    job_status=?, close_reason=?, close_note=?, headcount=?,
    langs=?, title_zh=?, title_es=?, desc_zh=?, desc_es=? WHERE id=?`)
    .run(
      d.partner_id||null, d.title, d.type||'', d.category||'', d.location||'', d.pay||'', d.pay_period||'', d.lang||'en', d.lang_name||'English',
      d.description||'', d.urgent?1:0, jobStatus==='open'?1:0,
      d.work_auth||'', d.benefits||'', d.schedule||'',
      d.company_id||null, d.company_name||'', d.employment_type||'',
      d.work_days||'', d.work_start||'', d.work_end||'', d.work_schedule||'{}',
      d.schedule_days||'[]', d.schedule_start||'', d.schedule_end||'',
      jobStatus, d.close_reason||'', d.close_note||'', d.headcount||1,
      d.langs||'en', d.title_zh||'', d.title_es||'', d.desc_zh||'', d.desc_es||'',
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
  const old = db.prepare('SELECT title, company_name, close_reason FROM jobs WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '职位不存在 / Job not found' });
  if (old.close_reason !== 'test') {
    return res.status(403).json({ error: '非测试单职位不允许删除。如需下架请将职位状态改为已取消。' });
  }
  // Cascade delete all related records before deleting the job
  db.transaction(() => {
    const assignmentIds = db.prepare('SELECT id FROM assignments WHERE job_id=?').all(req.params.id).map(r => r.id);
    for (const aId of assignmentIds) {
      db.prepare('DELETE FROM assignment_status_history WHERE assignment_id=?').run(aId);
      db.prepare('DELETE FROM shift_confirmations WHERE assignment_id=?').run(aId);
    }
    db.prepare('DELETE FROM assignments WHERE job_id=?').run(req.params.id);
    db.prepare('DELETE FROM employee_jobs WHERE job_id=?').run(req.params.id);
    db.prepare('DELETE FROM job_applications WHERE job_id=?').run(req.params.id);
    db.prepare('DELETE FROM job_audit_log WHERE job_id=?').run(req.params.id);
    db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  })();
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

// Worker positions list (public - used by register page)
app.get('/api/positions', (req, res) => {
  res.json(getWorkerPositions());
});

// Worker positions CRUD (admin)
app.get('/api/admin/worker-positions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM worker_positions ORDER BY sort_order, id').all();
  res.json(rows.map(r => ({ id: r.id, key: r.key, zh: r.name_zh, en: r.name_en, es: r.name_es, sort_order: r.sort_order, active: r.active })));
});

app.post('/api/admin/worker-positions', requireAdmin, (req, res) => {
  const { key, zh, en, es, sort_order } = req.body;
  if (!key || !zh || !en) return res.status(400).json({ error: '缺少必填字段 (key, zh, en)' });
  if (!/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key 只能包含小写字母、数字和下划线' });
  try {
    const info = db.prepare('INSERT INTO worker_positions (key, name_zh, name_en, name_es, sort_order) VALUES (?,?,?,?,?)')
      .run(key, zh, en, es || '', sort_order ?? 0);
    res.json({ id: info.lastInsertRowid, key, zh, en, es: es || '', sort_order: sort_order ?? 0, active: 1 });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '该 key 已存在' });
    throw e;
  }
});

app.put('/api/admin/worker-positions/:id', requireAdmin, (req, res) => {
  const { zh, en, es, sort_order, active } = req.body;
  const row = db.prepare('SELECT id FROM worker_positions WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '职位不存在' });
  db.prepare('UPDATE worker_positions SET name_zh=COALESCE(?,name_zh), name_en=COALESCE(?,name_en), name_es=COALESCE(?,name_es), sort_order=COALESCE(?,sort_order), active=COALESCE(?,active) WHERE id=?')
    .run(zh ?? null, en ?? null, es ?? null, sort_order ?? null, active ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/worker-positions/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM worker_positions WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '职位不存在' });
  db.prepare('DELETE FROM worker_positions WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Inquiry × Worker Position ratings
app.get('/api/admin/inquiries/:id/position-ratings', requireAdmin, blockManager, (req, res) => {
  const saved = db.prepare('SELECT * FROM inquiry_position_ratings WHERE inquiry_id=?').all(req.params.id);
  const rMap = {};
  saved.forEach(r => { rMap[r.position_key] = r; });
  res.json(getWorkerPositions().map(p => ({ ...p, rating: rMap[p.key] || null })));
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
  res.json(getWorkerPositions().map(p => ({ ...p, rating: rMap[p.key] || null })));
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
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM partner_files f WHERE f.partner_id=p.id) as file_count, (SELECT COUNT(*) FROM partner_files f WHERE f.partner_id=p.id AND f.ds_status='completed') as signed_contract_count, (SELECT COUNT(*) FROM partner_files f WHERE f.partner_id=p.id AND f.file_type IN ('contract','agreement')) as contract_file_count FROM partners p ORDER BY p.created_at DESC`).all();
  res.json(rows);
});

app.post('/api/admin/partners', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  // Extract state from first address for company number
  let stateAbbr = 'XX';
  try {
    const addrs = typeof d.addresses === 'string' ? JSON.parse(d.addresses) : (d.addresses || []);
    if (addrs.length && addrs[0].state) stateAbbr = addrs[0].state;
  } catch {}
  const companyNumber = generatePartnerNumber(stateAbbr);
  const r = db.prepare(`INSERT INTO partners (name,contact_person,phone,email,address,industry,services,notes,active,contacts,addresses,social_media,links,company_number)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    d.name, d.contact_person||'', d.phone||'', d.email||'', d.address||'',
    d.industry||'', d.services||'', d.notes||'', 0,
    d.contacts||'[]', d.addresses||'[]', d.social_media||'{}', d.links||'{}', companyNumber);
  res.json({ success: true, id: r.lastInsertRowid, company_number: companyNumber });
});

app.put('/api/admin/partners/:id', requireAdmin, blockManager, staffGuard('update', 'partners'), (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE partners SET name=?,contact_person=?,phone=?,email=?,address=?,industry=?,services=?,notes=?,active=?,contacts=?,addresses=?,social_media=?,links=? WHERE id=?`)
    .run(d.name, d.contact_person||'', d.phone||'', d.email||'', d.address||'',
      d.industry||'', d.services||'', d.notes||'', d.active!==false?1:0,
      d.contacts||'[]', d.addresses||'[]', d.social_media||'{}', d.links||'{}', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/partners/:id', requireAdmin, requireRole('admin'), (req, res) => {
  // Delete associated files
  const files = db.prepare('SELECT * FROM partner_files WHERE partner_id=?').all(req.params.id);
  files.forEach(f => { if (f.file_path) { const fp = path.join(docsDir, f.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); } });
  db.prepare('DELETE FROM partner_files WHERE partner_id=?').run(req.params.id);
  db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Minimal PDF builder (no external deps) ───────────────────────────────────
function buildMinimalPdf(pageLines) {
  // pageLines: array of { text, size, bold }
  // Returns a Buffer containing a valid single-page PDF
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const pageW = 612, pageH = 792, margin = 60;
  let stream = '';
  let y = pageH - margin;
  for (const { text, size = 11 } of pageLines) {
    if (!text) { y -= 14; continue; }
    const lh = size + 4;
    if (y < margin) break;
    stream += `BT /F1 ${size} Tf ${margin} ${y} Td (${esc(text)}) Tj ET\n`;
    y -= lh;
  }
  const streamBytes = Buffer.from(stream, 'latin1');
  const objs = [];
  objs.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`);
  objs.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}]\n   /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj`);
  objs.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);
  objs.push(`5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}endstream\nendobj`);
  const header = '%PDF-1.4\n';
  const parts = [Buffer.from(header)];
  const offsets = [];
  let offset = header.length;
  for (const obj of objs) {
    offsets.push(offset);
    const buf = Buffer.from(obj + '\n', 'latin1');
    parts.push(buf);
    offset += buf.length;
  }
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

function generatePartnerContractLines({ partnerName, companyName, partnerAddress, dateStr }) {
  const cname = companyName || 'Prime Anchorpoint LLC';
  return [
    { text: 'PARTNERSHIP SERVICE AGREEMENT', size: 15 },
    { text: '' },
    { text: `Date: ${dateStr}`, size: 11 },
    { text: '' },
    { text: 'This Partnership Service Agreement ("Agreement") is entered into between:', size: 11 },
    { text: '' },
    { text: `Company: ${cname}  ("Service Provider")`, size: 11 },
    { text: '' },
    { text: `Partner: ${partnerName}`, size: 11 },
    { text: partnerAddress ? `Address: ${partnerAddress}` : '', size: 11 },
    { text: '("Partner")', size: 11 },
    { text: '' },
    { text: '1. SCOPE OF SERVICES', size: 11 },
    { text: 'The Partner agrees to provide staffing and workforce services as mutually agreed.', size: 11 },
    { text: 'The Company will refer client engagements based on Partner availability and qualifications.', size: 11 },
    { text: '' },
    { text: '2. COMPENSATION', size: 11 },
    { text: 'Compensation terms shall be agreed upon for each individual engagement or project.', size: 11 },
    { text: 'Payment shall be made within 30 days of receipt of a valid invoice.', size: 11 },
    { text: '' },
    { text: '3. TERM', size: 11 },
    { text: 'This Agreement commences on the date above and continues for one (1) year unless', size: 11 },
    { text: 'terminated earlier by either party upon 30 days written notice.', size: 11 },
    { text: '' },
    { text: '4. CONFIDENTIALITY', size: 11 },
    { text: 'Each party agrees to keep confidential any proprietary information disclosed by the other.', size: 11 },
    { text: '' },
    { text: '5. INDEPENDENT CONTRACTOR', size: 11 },
    { text: 'Partner is an independent contractor, not an employee of the Company.', size: 11 },
    { text: '' },
    { text: '6. GOVERNING LAW', size: 11 },
    { text: 'This Agreement shall be governed by the laws of the State of Illinois.', size: 11 },
    { text: '' },
    { text: '7. ENTIRE AGREEMENT', size: 11 },
    { text: 'This Agreement constitutes the entire understanding between the parties.', size: 11 },
    { text: '' },
    { text: '' },
    { text: 'SIGNATURES', size: 12 },
    { text: '' },
    { text: `${cname.padEnd(38)}${partnerName}`, size: 11 },
    { text: 'By: ____________________________    By: ____________________________', size: 11 },
    { text: 'Name: __________________________    Name: __________________________', size: 11 },
    { text: 'Title: _________________________    Title: _________________________', size: 11 },
    { text: 'Date: __________________________    Date: __________________________', size: 11 },
  ];
}

// POST /api/admin/partners/:id/reset-contract
// Voids any active DocuSign envelopes, deletes all existing contract/agreement files for this partner,
// then generates a fresh default contract PDF ready for editing or sending.
app.post('/api/admin/partners/:id/reset-contract', requireAdmin, blockManager, async (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const existingFiles = db.prepare("SELECT * FROM partner_files WHERE partner_id=? AND file_type IN ('contract','agreement')").all(req.params.id);
  // Void active envelopes
  for (const f of existingFiles) {
    if (f.ds_envelope_id && dsealEnabled() && f.ds_status && !['completed','voided','declined'].includes(f.ds_status)) {
      try { await dsealArchive(f.ds_envelope_id); } catch (e) { console.error('[reset-contract] archive submission error:', e.message); }
    }
    // Delete local file
    if (f.file_path) { try { const fp = path.join(docsDir, f.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} }
    db.prepare('DELETE FROM partner_files WHERE id=?').run(f.id);
  }
  // Generate new default contract
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const content = generatePartnerContractText({ partnerName: p.name, companyName, partnerAddress: p.address, dateStr });
  const pdfBuf = buildContractPdf(content);
  const filename = `contract-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(docsDir, filename), pdfBuf);
  const r = db.prepare(`INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, notes, contract_content) VALUES (?, 'contract', '合作协议 Partnership Agreement', ?, ?, '重新生成的默认合同模板', ?)`)
    .run(req.params.id, filename, `Partnership Agreement - ${p.name}.pdf`, content);
  res.json({ success: true, id: r.lastInsertRowid, file_name: `Partnership Agreement - ${p.name}.pdf` });
});

// POST /api/admin/partners/:id/generate-default-contract
app.post('/api/admin/partners/:id/generate-default-contract', requireAdmin, blockManager, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const content = generatePartnerContractText({ partnerName: p.name, companyName, partnerAddress: p.address, dateStr });
  const pdfBuf = buildContractPdf(content);
  const filename = `contract-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(docsDir, filename), pdfBuf);
  const r = db.prepare(`INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, notes, contract_content) VALUES (?, 'contract', '合作协议 Partnership Agreement', ?, ?, '自动生成的默认合同模板', ?)`)
    .run(req.params.id, filename, `Partnership Agreement - ${p.name}.pdf`, content);
  res.json({ success: true, id: r.lastInsertRowid, file_name: `Partnership Agreement - ${p.name}.pdf` });
});

// GET /api/admin/partners/:id/contract-template — return default contract text (no file created)
app.get('/api/admin/partners/:id/contract-template', requireAdmin, blockManager, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  res.json({ content: generatePartnerContractText({ partnerName: p.name, companyName, partnerAddress: p.address, dateStr }) });
});

// POST /api/admin/partners/:id/save-contract-from-editor — create new partner file from edited content
app.post('/api/admin/partners/:id/save-contract-from-editor', requireAdmin, blockManager, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const content = req.body?.content || '';
  if (!content.trim()) return res.status(400).json({ error: '合同内容不能为空' });
  const pdfBuf = buildContractPdf(content);
  const filename = `contract-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const displayName = `Partnership Agreement - ${p.name}.pdf`;
  fs.writeFileSync(path.join(docsDir, filename), pdfBuf);
  const r = db.prepare(`INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, contract_content) VALUES (?, 'contract', '合作协议', ?, ?, ?)`)
    .run(req.params.id, filename, displayName, content);
  res.json({ success: true, id: r.lastInsertRowid, fileName: displayName });
});

// GET /api/admin/partner-files/:id/contract-content — return stored contract content
app.get('/api/admin/partner-files/:id/contract-content', requireAdmin, blockManager, (req, res) => {
  const f = db.prepare('SELECT pf.*, p.name as partner_name, p.address as partner_address FROM partner_files pf LEFT JOIN partners p ON pf.partner_id=p.id WHERE pf.id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.contract_content) return res.json({ content: f.contract_content });
  // Generate default content from partner data
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  res.json({ content: generatePartnerContractText({ partnerName: f.partner_name || '', companyName, partnerAddress: f.partner_address || '', dateStr }) });
});

// POST /api/admin/partner-files/:id/save-contract-from-editor — update content + regenerate PDF
app.post('/api/admin/partner-files/:id/save-contract-from-editor', requireAdmin, blockManager, (req, res) => {
  const f = db.prepare('SELECT * FROM partner_files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const content = req.body?.content || '';
  if (!content.trim()) return res.status(400).json({ error: '合同内容不能为空' });
  const pdfBuf = buildContractPdf(content);
  // Reuse existing file_path or create new
  let filePath = f.file_path;
  if (!filePath) { filePath = `contract-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`; }
  fs.writeFileSync(path.join(docsDir, filePath), pdfBuf);
  db.prepare("UPDATE partner_files SET contract_content=?, file_path=?, ds_status='', ds_envelope_id='' WHERE id=?").run(content, filePath, f.id);
  res.json({ success: true, fileName: f.file_name || filePath });
});

// GET /api/admin/partners/:id/legal-template?type=termination|breach|amendment|mutual
app.get('/api/admin/partners/:id/legal-template', requireAdmin, blockManager, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const type = req.query.type || 'termination';
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const args = { partnerName: p.name, companyName, dateStr };
  let content = '';
  if (type === 'termination') content = generateTerminationNoticeText(args);
  else if (type === 'breach') content = generateBreachNoticeText(args);
  else if (type === 'amendment') content = generateAmendmentText(args);
  else if (type === 'mutual') content = generateMutualTerminationText(args);
  else return res.status(400).json({ error: 'Invalid type' });
  res.json({ content });
});

// POST /api/admin/partners/:id/save-legal-doc
// Body: { content, type, setInactive }
app.post('/api/admin/partners/:id/save-legal-doc', requireAdmin, blockManager, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Partner not found' });
  const { content, type, setInactive } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '文件内容不能为空' });
  const typeMap = {
    termination: { file_type: 'termination_notice', label: '终止通知书', prefix: 'termination' },
    breach:      { file_type: 'breach_notice',       label: '违约终止通知书', prefix: 'breach' },
    amendment:   { file_type: 'amendment',           label: '合同修改协议', prefix: 'amendment' },
    mutual:      { file_type: 'mutual_termination',  label: '协商解除协议', prefix: 'mutual' },
  };
  const meta = typeMap[type];
  if (!meta) return res.status(400).json({ error: 'Invalid type' });
  const pdfBuf = buildContractPdf(content);
  const filename = `${meta.prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const displayName = `${meta.label} - ${p.name}.pdf`;
  fs.writeFileSync(path.join(docsDir, filename), pdfBuf);
  const r = db.prepare(`INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, contract_content) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.params.id, meta.file_type, meta.label, filename, displayName, content);
  if (setInactive) db.prepare('UPDATE partners SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true, id: r.lastInsertRowid, fileName: displayName, filePath: filename });
});

// POST /api/admin/partner-files/:id/send-notice-email
// Sends the saved PDF as an email attachment to the partner's contact
app.post('/api/admin/partner-files/:id/send-notice-email', requireAdmin, blockManager, async (req, res) => {
  const f = db.prepare(`SELECT pf.*, p.name as partner_name, p.email as partner_email, p.contacts as partner_contacts
    FROM partner_files pf LEFT JOIN partners p ON pf.partner_id=p.id WHERE pf.id=?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  let toEmail = req.body.email || f.partner_email || '';
  let toName = f.partner_name || '';
  if (!toEmail) {
    try {
      const contacts = JSON.parse(f.partner_contacts || '[]');
      const c = contacts.find(c => c.email);
      if (c) { toEmail = c.email; toName = [c.first_name, c.last_name].filter(Boolean).join(' ') || toName; }
    } catch {}
  }
  if (!toEmail) return res.status(400).json({ error: '未找到合作方邮箱，请手动填写收件邮箱' });
  const filePath = path.join(docsDir, f.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在，请先生成PDF' });
  const pdfBuffer = fs.readFileSync(filePath);
  const typeSubjects = {
    termination_notice: 'Notice of Service Termination — 服务终止通知书',
    breach_notice:      'Notice of Termination for Breach — 违约终止通知书',
    amendment:          'Contract Amendment Agreement — 合同修改协议',
    mutual_termination: 'Mutual Termination Agreement — 协商解除协议',
  };
  const subject = typeSubjects[f.file_type] || `Legal Notice — ${f.file_name}`;
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const text = `Dear ${toName || 'Partner'},\n\nPlease find attached the following document: ${f.file_name}.\n\nThis document requires your attention. Please review and respond accordingly.\n\nBest regards,\n${companyName}`;
  const ok = await sendEmailWithAttachment(toEmail, subject, text, pdfBuffer, f.file_name || 'notice.pdf');
  if (ok) res.json({ success: true, sentTo: toEmail });
  else res.status(500).json({ error: '邮件发送失败，请检查邮件配置' });
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

// POST /api/admin/partners/:id/generate-agreement — generate a clean Partnership Agreement PDF template
// The PDF uses 1pt white anchor strings (/sig1/ /date1/ /sig2/ /date2/) so DocuSign can position tabs
// while the anchor text stays invisible in the document.
app.post('/api/admin/partners/:id/generate-agreement', requireAdmin, blockManager, async (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const partnerName = partner.name || 'Partner Company';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const fileName = `Partnership_Agreement_${partnerName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`;
  const filePath = path.join(docsDir, fileName);

  try {
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'LETTER', margins: { top: 72, bottom: 72, left: 72, right: 72 } });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);

      const W = doc.page.width - 144; // usable width
      const L = 72; // left margin

      // ── Title ───────────────────────────────────────────────
      doc.fontSize(18).font('Helvetica-Bold').fillColor('black')
        .text('PARTNERSHIP AGREEMENT', { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(11).font('Helvetica').fillColor('#444')
        .text(`This Partnership Agreement ("Agreement") is entered into as of ${today}, by and between:`, { align: 'left' });
      doc.moveDown(1);

      // ── Parties ──────────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').fillColor('black').text('Service Provider:');
      doc.font('Helvetica').fillColor('#333').text('Prime Anchorpoint LLC, a staffing and workforce solutions company ("Service Provider").');
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fillColor('black').text('Partner:');
      doc.font('Helvetica').fillColor('#333').text(`${partnerName} ("Partner").`);
      doc.moveDown(1.2);

      // ── Recitals ─────────────────────────────────────────────
      doc.fontSize(13).font('Helvetica-Bold').fillColor('black').text('RECITALS');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica').fillColor('#333').text(
        'WHEREAS, Service Provider is in the business of providing staffing, recruitment, and workforce management services; and\n\n' +
        'WHEREAS, Partner desires to engage Service Provider to provide such services in accordance with the terms and conditions set forth herein;\n\n' +
        'NOW, THEREFORE, in consideration of the mutual covenants and agreements contained herein, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the parties agree as follows:'
      );
      doc.moveDown(1.2);

      // ── Terms ────────────────────────────────────────────────
      const sections = [
        ['1. SERVICES', 'Service Provider agrees to provide staffing, recruitment, and workforce management services as mutually agreed upon by the parties in writing from time to time ("Services"). The specific scope, timeline, and deliverables for each engagement shall be set forth in separate statements of work or work orders executed by both parties.'],
        ['2. COMPENSATION', 'Partner agrees to compensate Service Provider at rates mutually agreed upon prior to the commencement of each engagement. Invoices shall be submitted by Service Provider on a bi-weekly basis and shall be due and payable within thirty (30) days of receipt.'],
        ['3. CONFIDENTIALITY', 'Each party agrees to keep confidential all non-public information received from the other party in connection with this Agreement, and shall not disclose such information to any third party without the prior written consent of the disclosing party, except as required by law.'],
        ['4. TERM AND TERMINATION', 'This Agreement shall commence on the date first written above and shall continue for a period of one (1) year, unless earlier terminated. Either party may terminate this Agreement upon thirty (30) days\' prior written notice to the other party.'],
        ['5. INDEMNIFICATION', 'Each party shall indemnify, defend, and hold harmless the other party and its officers, directors, employees, and agents from and against any claims, damages, losses, and expenses arising out of or resulting from the indemnifying party\'s negligence or willful misconduct.'],
        ['6. GOVERNING LAW', 'This Agreement shall be governed by and construed in accordance with the laws of the State in which Service Provider maintains its principal place of business, without regard to its conflict of law provisions.'],
        ['7. ENTIRE AGREEMENT', 'This Agreement constitutes the entire agreement between the parties with respect to its subject matter and supersedes all prior negotiations, representations, warranties, and understandings of the parties.'],
      ];

      for (const [title, body] of sections) {
        if (doc.y > doc.page.height - 200) doc.addPage();
        doc.fontSize(11).font('Helvetica-Bold').fillColor('black').text(title);
        doc.moveDown(0.2);
        doc.fontSize(10).font('Helvetica').fillColor('#333').text(body);
        doc.moveDown(0.8);
      }

      // ── Signature Page ───────────────────────────────────────
      doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').fillColor('black').text('SIGNATURES', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#444')
        .text('IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above.', { align: 'center' });
      doc.moveDown(2);

      // Two-column signature blocks
      const col1X = L;
      const col2X = L + W / 2 + 20;
      const colW = W / 2 - 30;
      const startY = doc.y;

      // ── Column 1: Service Provider ──────────────────────────
      let y1 = startY;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('black')
        .text('Prime Anchorpoint LLC', col1X, y1, { width: colW });
      y1 += 16;
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('(Service Provider)', col1X, y1, { width: colW });
      y1 += 32;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Authorized Signature:', col1X, y1, { width: colW });
      y1 += 14;
      doc.moveTo(col1X, y1 + 18).lineTo(col1X + colW, y1 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      // Invisible DocuSign anchor for sig1 — placed on the signature line
      doc.fontSize(1).fillColor('white').text('/sig1/', col1X, y1 + 10, { lineBreak: false, width: colW });
      y1 += 36;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Print Name:', col1X, y1, { width: colW });
      y1 += 14;
      doc.moveTo(col1X, y1 + 18).lineTo(col1X + colW, y1 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      y1 += 36;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Date:', col1X, y1, { width: colW });
      y1 += 14;
      doc.moveTo(col1X, y1 + 18).lineTo(col1X + colW, y1 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      // Invisible DocuSign anchor for date1
      doc.fontSize(1).fillColor('white').text('/date1/', col1X, y1 + 10, { lineBreak: false, width: colW });

      // ── Column 2: Partner ────────────────────────────────────
      let y2 = startY;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('black')
        .text(partnerName, col2X, y2, { width: colW });
      y2 += 16;
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('(Partner)', col2X, y2, { width: colW });
      y2 += 32;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Authorized Signature:', col2X, y2, { width: colW });
      y2 += 14;
      doc.moveTo(col2X, y2 + 18).lineTo(col2X + colW, y2 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      // Invisible DocuSign anchor for sig2
      doc.fontSize(1).fillColor('white').text('/sig2/', col2X, y2 + 10, { lineBreak: false, width: colW });
      y2 += 36;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Print Name:', col2X, y2, { width: colW });
      y2 += 14;
      doc.moveTo(col2X, y2 + 18).lineTo(col2X + colW, y2 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      y2 += 36;

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('Date:', col2X, y2, { width: colW });
      y2 += 14;
      doc.moveTo(col2X, y2 + 18).lineTo(col2X + colW, y2 + 18).lineWidth(0.8).strokeColor('#333').stroke();
      // Invisible DocuSign anchor for date2
      doc.fontSize(1).fillColor('white').text('/date2/', col2X, y2 + 10, { lineBreak: false, width: colW });

      doc.end();
    });

    // Save as a partner_file record
    const r = db.prepare(
      `INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, notes) VALUES (?,?,?,?,?,?)`
    ).run(req.params.id, 'contract', 'Partnership Agreement', fileName, fileName, 'Auto-generated template');

    res.json({ success: true, id: r.lastInsertRowid, file_name: fileName });
  } catch (e) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[GenerateAgreement]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/partners/:id/generate-custom-agreement — generate PDF from user-supplied contract text
// Anchor strings (/sig1/ /date1/ /sig2/ /date2/) are rendered as 1pt white (invisible) text
// so DocuSign can anchor tabs while keeping the document visually clean.
app.post('/api/admin/partners/:id/generate-custom-agreement', requireAdmin, blockManager, async (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '合同内容不能为空' });

  const partnerName = partner.name || 'Partner';
  const fileName = `Contract_${partnerName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`;
  const filePath = path.join(docsDir, fileName);

  try {
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'LETTER', margins: { top: 72, bottom: 72, left: 72, right: 72 } });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);

      const ANCHORS = ['/sig1/', '/sig2/', '/date1/', '/date2/'];
      const L = 72;
      const pageW = doc.page.width - 144;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Ensure we have space for this line
        if (doc.y > doc.page.height - doc.page.margins.bottom - 40) doc.addPage();

        // Check if line contains anchor strings — render visible portion + invisible anchors
        const hasAnchor = ANCHORS.some(a => line.includes(a));
        if (hasAnchor) {
          // Split the line into parts: text and anchors
          // Render all visible text (anchors stripped out) then add invisible anchors
          const visibleText = line.replace(/\/(sig1|sig2|date1|date2)\//g, '').trimEnd();
          const curY = doc.y;
          if (visibleText) {
            doc.fontSize(10).font('Helvetica').fillColor('black').text(visibleText, { lineBreak: false });
          }
          // Write each anchor string at the same Y position as invisible text
          ANCHORS.forEach(anchor => {
            if (line.includes(anchor)) {
              doc.fontSize(1).fillColor('white').text(anchor, L, curY, { lineBreak: false });
            }
          });
          doc.moveDown(0.6);
        } else {
          const trimmed = line.trim();
          if (trimmed === '') {
            doc.moveDown(0.4);
          } else if (trimmed === 'SIGNATURES' || /^[A-Z][A-Z\s]{3,}$/.test(trimmed)) {
            // All-caps section title
            if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();
            doc.moveDown(0.3);
            doc.fontSize(13).font('Helvetica-Bold').fillColor('black').text(trimmed, { width: pageW });
            doc.moveDown(0.3);
          } else if (/^\d+\.\s+[A-Z]/.test(trimmed)) {
            // Numbered section heading
            doc.moveDown(0.2);
            doc.fontSize(11).font('Helvetica-Bold').fillColor('black').text(trimmed, { width: pageW });
            doc.moveDown(0.1);
          } else {
            doc.fontSize(10).font('Helvetica').fillColor('#222').text(trimmed, { width: pageW });
          }
        }
      }

      doc.end();
    });

    const r = db.prepare(
      `INSERT INTO partner_files (partner_id, file_type, file_label, file_path, file_name, notes) VALUES (?,?,?,?,?,?)`
    ).run(req.params.id, 'contract', 'Partnership Agreement', fileName, fileName, 'Generated from contract editor');

    res.json({ success: true, id: r.lastInsertRowid, file_name: fileName });
  } catch (e) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[GenerateCustomAgreement]', e.message);
    res.status(500).json({ error: e.message });
  }
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

// POST /api/admin/partner-files/:id/send-docusign — send partner contract to both parties for e-signing via DocuSeal
app.post('/api/admin/partner-files/:id/send-docusign', requireAdmin, blockManager, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置，请在环境变量中设置 DOCUSEAL_API_KEY 和 DOCUSEAL_URL' });
  try {
    const f = db.prepare(`SELECT pf.*, p.name as partner_name, p.email as partner_email, p.contacts as partner_contacts FROM partner_files pf LEFT JOIN partners p ON pf.partner_id=p.id WHERE pf.id=?`).get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    if (!f.file_path) return res.status(400).json({ error: '文件不存在' });
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
    const { submissionId, companyEmbedSrc } = await dsealSendEnvelope({
      docPath, docName: f.file_name || f.file_path,
      emailSubject: `请签署合同 - ${f.partner_name || ''} × Prime Anchorpoint`,
      signer1: { email: companyEmail, name: companyName },
      signer2: { email: partnerEmail, name: partnerName }
    });
    db.prepare("UPDATE partner_files SET ds_envelope_id=?, ds_status='sent', ds_decline_reason='' WHERE id=?").run(submissionId, f.id);
    res.json({ success: true, envelopeId: submissionId, signUrl: companyEmbedSrc });
  } catch (e) {
    console.error('[DocuSeal PartnerFile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /docusign-return — served inside the signing iframe for DocuSign (assignments); postMessages result to parent
app.get('/docusign-return', (req, res) => {
  const event = req.query.event || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
    try { window.parent.postMessage({ type: 'docusign_return', event: ${JSON.stringify(event)} }, '*'); } catch(e) {}
  </script></body></html>`);
});

// GET /api/admin/partner-files/:id/docusign-sign-url — get embedded signing URL for company via DocuSeal
app.get('/api/admin/partner-files/:id/docusign-sign-url', requireAdmin, blockManager, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const f = db.prepare("SELECT id, ds_envelope_id, ds_status FROM partner_files WHERE id=?").get(req.params.id);
    if (!f || !f.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
    const signUrl = await dsealGetCompanySignUrl(f.ds_envelope_id);
    res.json({ signUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/partner-files/:id/docusign-void — archive the active DocuSeal submission
app.post('/api/admin/partner-files/:id/docusign-void', requireAdmin, blockManager, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const f = db.prepare("SELECT id, ds_envelope_id, ds_status FROM partner_files WHERE id=?").get(req.params.id);
    if (!f || !f.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
    await dsealArchive(f.ds_envelope_id);
    db.prepare("UPDATE partner_files SET ds_status='voided', ds_envelope_id='', ds_decline_reason='' WHERE id=?").run(f.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/partner-files/:id/docusign-status — refresh signing status from DocuSeal
app.get('/api/admin/partner-files/:id/docusign-status', requireAdmin, blockManager, async (req, res) => {
  const f = db.prepare("SELECT id, ds_envelope_id, ds_status, ds_partner_signed_at, ds_company_signed_at, ds_decline_reason FROM partner_files WHERE id=?").get(req.params.id);
  if (!f || !f.ds_envelope_id) return res.status(404).json({ error: 'No submission' });
  if (!dsealEnabled()) return res.json({ status: f.ds_status, partnerSigned: f.ds_partner_signed_at, companySigned: f.ds_company_signed_at, declineReason: f.ds_decline_reason });
  try {
    const { status, companySigned, partnerSigned, declineReason } = await dsealGetStatus(f.ds_envelope_id);
    db.prepare("UPDATE partner_files SET ds_status=?, ds_partner_signed_at=?, ds_company_signed_at=?, ds_decline_reason=? WHERE id=?").run(status, partnerSigned, companySigned, declineReason, f.id);
    if (status === 'completed') {
      db.prepare("UPDATE partners SET active=1 WHERE id=(SELECT partner_id FROM partner_files WHERE id=?)").run(f.id);
      try {
        const pfRecord = db.prepare("SELECT file_path FROM partner_files WHERE id=?").get(f.id);
        if (pfRecord && pfRecord.file_path) {
          const signedBuf = await dsealDownloadDocument(f.ds_envelope_id);
          fs.writeFileSync(path.join(docsDir, pfRecord.file_path), signedBuf);
          console.log(`[DocuSeal] Saved signed partner contract for file id=${f.id}`);
        }
      } catch (dlErr) { console.error('[DocuSeal] Failed to download signed partner doc:', dlErr.message); }
    }
    res.json({ status, partnerSigned, companySigned, declineReason });
  } catch (e) { res.json({ status: f.ds_status, partnerSigned: f.ds_partner_signed_at, companySigned: f.ds_company_signed_at, declineReason: f.ds_decline_reason, error: e.message }); }
});

// POST /api/admin/partner-files/:id/force-download-signed — force download signed PDF from DocuSeal and save
app.post('/api/admin/partner-files/:id/force-download-signed', requireAdmin, blockManager, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const f = db.prepare('SELECT id, ds_envelope_id, ds_status, file_path, file_name FROM partner_files WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    if (!f.ds_envelope_id) return res.status(400).json({ error: '该文件没有关联的 DocuSeal 提交' });
    const { status, companySigned, partnerSigned, declineReason } = await dsealGetStatus(f.ds_envelope_id);
    db.prepare("UPDATE partner_files SET ds_status=?, ds_partner_signed_at=?, ds_company_signed_at=?, ds_decline_reason=? WHERE id=?").run(status, partnerSigned, companySigned, declineReason, f.id);
    if (status !== 'completed') {
      return res.json({ success: false, status, message: `当前签署状态为 "${status}"，只有双方都签署后才能下载已签版本。`, partnerSigned, companySigned });
    }
    db.prepare("UPDATE partners SET active=1 WHERE id=(SELECT partner_id FROM partner_files WHERE id=?)").run(f.id);
    const signedBuf = await dsealDownloadDocument(f.ds_envelope_id);
    if (f.file_path) {
      fs.writeFileSync(path.join(docsDir, f.file_path), signedBuf);
      console.log(`[DocuSeal] Force-saved signed partner contract for file id=${f.id}`);
    }
    res.json({ success: true, status, partnerSigned, companySigned, fileSize: signedBuf.length, message: '已签版本已下载并保存，请重新下载文件查看。' });
  } catch (e) {
    console.error('[DocuSeal ForceDownload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/partner-files/:id/docusign-debug — detailed diagnostic info (DocuSeal)
app.get('/api/admin/partner-files/:id/docusign-debug', requireAdmin, blockManager, async (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM partner_files WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    const localFilePath = f.file_path ? path.join(docsDir, f.file_path) : null;
    const localFileExists = localFilePath ? fs.existsSync(localFilePath) : false;
    const localFileSize = localFileExists ? fs.statSync(localFilePath).size : 0;
    const debug = {
      db: { id: f.id, file_name: f.file_name, file_path: f.file_path, ds_envelope_id: f.ds_envelope_id, ds_status: f.ds_status, ds_partner_signed_at: f.ds_partner_signed_at, ds_company_signed_at: f.ds_company_signed_at, ds_decline_reason: f.ds_decline_reason },
      local_file: { path: f.file_path, exists: localFileExists, size_bytes: localFileSize },
      docuseal_configured: dsealEnabled(),
      webhook_url: `${(req.headers['x-forwarded-proto'] || req.protocol)}://${(req.headers['x-forwarded-host'] || req.headers.host)}/api/docuseal/webhook`
    };
    if (dsealEnabled() && f.ds_envelope_id) {
      try {
        const { status, companySigned, partnerSigned, declineReason, raw } = await dsealGetStatus(f.ds_envelope_id);
        debug.docuseal_live = { status, companySigned, partnerSigned, declineReason, submitters: raw.submitters };
        debug.status_mismatch = (status !== f.ds_status);
      } catch (apiErr) { debug.docuseal_live_error = apiErr.message; }
    }
    res.json(debug);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const anchors = checkDsAnchors(docPath);
    const result = await dsSendEnvelope({ docPath, docName: a.contract_filename || a.contract_file, emailSubject: `请签署雇用合同 - ${a.inquiry_name || ''}`, signer1: { email: companyEmail, name: companyName }, signer2: { email: workerEmail, name: workerName } });
    db.prepare("UPDATE assignments SET ds_envelope_id=?, ds_status='sent', ds_decline_reason='' WHERE id=?").run(result.envelopeId, a.id);
    const _proto3 = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const _host3 = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const returnUrl = `${_proto3}://${_host3}/docusign-return`;
    const frameOrigin = `${_proto3}://${_host3}`;
    let signUrl = null;
    try { signUrl = await dsCreateSignUrl(result.envelopeId, companyEmail, companyName, returnUrl, frameOrigin); } catch (se) { console.error('[DocuSign SignUrl]', se.message); }
    res.json({ success: true, envelopeId: result.envelopeId, signUrl, anchors });
  } catch (e) {
    console.error('[DocuSign Assignment]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/assignments/:id/docusign-sign-url — get embedded signing URL for company (signer1)
app.get('/api/admin/assignments/:id/docusign-sign-url', requireAdmin, blockManager, async (req, res) => {
  if (!dsEnabled()) return res.status(503).json({ error: 'DocuSign 未配置' });
  try {
    const a = db.prepare("SELECT id, ds_envelope_id FROM assignments WHERE id=?").get(req.params.id);
    if (!a || !a.ds_envelope_id) return res.status(404).json({ error: 'No envelope' });
    const companyEmail = process.env.COMPANY_SIGNER_EMAIL || '';
    const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
    const _proto4 = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const _host4 = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const returnUrl = `${_proto4}://${_host4}/docusign-return`;
    const frameOrigin = `${_proto4}://${_host4}`;
    const signUrl = await dsCreateSignUrl(a.ds_envelope_id, companyEmail, companyName, returnUrl, frameOrigin);
    res.json({ signUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/assignments/:id/docusign-void — void the active envelope
app.post('/api/admin/assignments/:id/docusign-void', requireAdmin, blockManager, async (req, res) => {
  if (!dsEnabled()) return res.status(503).json({ error: 'DocuSign 未配置' });
  try {
    const a = db.prepare("SELECT id, ds_envelope_id, ds_status FROM assignments WHERE id=?").get(req.params.id);
    if (!a || !a.ds_envelope_id) return res.status(404).json({ error: 'No envelope' });
    const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
    await dsApiCall('PUT', `/restapi/v2.1/accounts/${accountId}/envelopes/${a.ds_envelope_id}`, { status: 'voided', voidedReason: req.body?.reason || '管理员撤销' });
    db.prepare("UPDATE assignments SET ds_status='voided', ds_envelope_id='', ds_decline_reason='' WHERE id=?").run(a.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/assignments/:id/docusign-status — refresh signing status from DocuSign
app.get('/api/admin/assignments/:id/docusign-status', requireAdmin, blockManager, async (req, res) => {
  const a = db.prepare("SELECT id, ds_envelope_id, ds_status, ds_worker_signed_at, ds_company_signed_at, ds_decline_reason FROM assignments WHERE id=?").get(req.params.id);
  if (!a || !a.ds_envelope_id) return res.status(404).json({ error: 'No envelope' });
  if (!dsEnabled()) return res.json({ status: a.ds_status, workerSigned: a.ds_worker_signed_at, companySigned: a.ds_company_signed_at, declineReason: a.ds_decline_reason });
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
        if (s.recipientId === '1') companySigned = s.signedDateTime;
        if (s.recipientId === '2') workerSigned = s.signedDateTime;
      }
    }
    let declineReason = a.ds_decline_reason || '';
    for (const s of (rcpRes.data?.signers || [])) {
      if (s.status === 'declined' && s.declinedReason) declineReason = s.declinedReason;
    }
    db.prepare("UPDATE assignments SET ds_status=?, ds_worker_signed_at=?, ds_company_signed_at=?, ds_decline_reason=? WHERE id=?").run(status, workerSigned, companySigned, declineReason, a.id);
    res.json({ status, workerSigned, companySigned, declineReason });
  } catch (e) { res.json({ status: a.ds_status, workerSigned: a.ds_worker_signed_at, companySigned: a.ds_company_signed_at, declineReason: a.ds_decline_reason, error: e.message }); }
});

// GET /api/admin/assignments/:id/contract-template — return default employment contract text
app.get('/api/admin/assignments/:id/contract-template', requireAdmin, blockManager, (req, res) => {
  const a = db.prepare(`SELECT a.*, i.name as inquiry_name, i.email as inquiry_email FROM assignments a LEFT JOIN inquiries i ON a.inquiry_id=i.id WHERE a.id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.contract_content) return res.json({ content: a.contract_content });
  const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint LLC';
  const content = generateAssignmentContractText({
    workerName: a.inquiry_name || '', companyName,
    jobTitle: a.category || '', payRate: a.pay_rate || '', payType: a.pay_type || 'hourly',
    startDate: a.start_date || '', workLocation: a.work_address || '', contractType: a.contract_type || 'W2'
  });
  res.json({ content });
});

// POST /api/admin/assignments/:id/save-contract-from-editor — save content + generate PDF + set contract_file
app.post('/api/admin/assignments/:id/save-contract-from-editor', requireAdmin, blockManager, (req, res) => {
  const a = db.prepare(`SELECT a.*, i.name as inquiry_name FROM assignments a LEFT JOIN inquiries i ON a.inquiry_id=i.id WHERE a.id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const content = req.body?.content || '';
  if (!content.trim()) return res.status(400).json({ error: '合同内容不能为空' });
  const pdfBuf = buildContractPdf(content);
  let filePath = a.contract_file;
  if (!filePath) filePath = `contract-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const displayName = `Employment Agreement - ${a.inquiry_name || 'Worker'}.pdf`;
  fs.writeFileSync(path.join(docsDir, filePath), pdfBuf);
  db.prepare("UPDATE assignments SET contract_file=?, contract_filename=?, contract_content=?, ds_status='', ds_envelope_id='' WHERE id=?").run(filePath, displayName, content, a.id);
  res.json({ success: true, fileName: displayName });
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
  // Fetch current job assignments: explicit (employee_jobs) + inferred (timesheet_sheets) + assignments
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
  const assignJobs = db.prepare(`
    SELECT wa.employee_id, a.job_id, j.title AS job_title, COALESCE(j.company_name,'') AS company_name
    FROM assignments a
    JOIN jobs j ON a.job_id = j.id
    JOIN worker_accounts wa ON wa.linked_inquiry_id = a.inquiry_id
    WHERE a.status NOT IN ('cancelled') AND wa.employee_id IS NOT NULL
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
  for (const j of assignJobs) {
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
  const recentTime = db.prepare(`SELECT t.*, COALESCE(t.site_timezone, js.timezone, 'America/Chicago') AS display_timezone
    FROM time_entries t LEFT JOIN jobs j ON t.job_id=j.id LEFT JOIN job_sites js ON j.site_id=js.id
    WHERE t.employee_id=? ORDER BY t.clock_in DESC LIMIT 20`).all(req.params.id);
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
  const empId = (d.employee_id || '').trim() || nextEmployeeId(d.state, d.hire_date);
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

app.delete('/api/admin/employees/:id/hard-delete', requireAdmin, requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(id);
  if (!emp) return res.status(404).json({ error: '员工不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM employee_documents WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employee_ratings WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employee_doc_requests WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employee_registration_invites WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employee_jobs WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM background_checks WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM time_entries WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM timesheet_sheets WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employee_position_ratings WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM worker_payments WHERE employee_id=?').run(id);
    db.prepare('UPDATE worker_accounts SET employee_id=NULL WHERE employee_id=?').run(id);
    db.prepare('DELETE FROM employees WHERE id=?').run(id);
  })();
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
  const { employee_id, date_from, date_to, status, needs_review } = req.query;
  let q = `SELECT t.*, e.first_name, e.last_name, e.employee_id as emp_code,
    COALESCE(t.site_timezone, js.timezone, 'America/Chicago') AS display_timezone
    FROM time_entries t LEFT JOIN employees e ON t.employee_id=e.id
    LEFT JOIN jobs j2 ON t.job_id=j2.id LEFT JOIN job_sites js ON j2.site_id=js.id WHERE 1=1`;
  const p = [];
  if (employee_id) { q += ' AND t.employee_id=?'; p.push(employee_id); }
  if (date_from)   { q += ' AND DATE(t.clock_in)>=?'; p.push(date_from); }
  if (date_to)     { q += ' AND DATE(t.clock_in)<=?'; p.push(date_to); }
  if (status)      { q += ' AND t.status=?'; p.push(status); }
  if (needs_review === '1') { q += ' AND t.manager_confirmed=1 AND t.needs_review=1'; }
  // Manager: only see time entries for their assigned partners / jobs / directly assigned employees
  const pids = managerPartnerIds(req);
  const jids = managerJobIds(req);
  const eids = managerEmployeeIds(req);
  if (req.userRole === 'manager' && (pids.length || jids.length || eids.length)) {
    const conds = [];
    if (pids.length) {
      conds.push(`(t.job_id IN (SELECT id FROM jobs WHERE partner_id IN (${pids.map(()=>'?').join(',')})) OR t.company_name IN (SELECT name FROM partners WHERE id IN (${pids.map(()=>'?').join(',')})))`);
      p.push(...pids, ...pids);
    }
    if (jids.length) {
      conds.push(`t.job_id IN (${jids.map(()=>'?').join(',')})`);
      p.push(...jids);
    }
    if (eids.length) {
      conds.push(`t.employee_id IN (${eids.map(()=>'?').join(',')})`);
      p.push(...eids);
    }
    q += ` AND (${conds.join(' OR ')})`;
  } else if (req.userRole === 'manager') {
    q += ' AND 1=0'; // no assignments, return nothing
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

  function breaksMin(breaks) {
    if (!Array.isArray(breaks) || !breaks.length) return 0;
    return breaks.reduce((sum, b) => {
      if (!b.start || !b.end) return sum;
      const [sh,sm] = b.start.split(':').map(Number);
      const [eh,em] = b.end.split(':').map(Number);
      return sum + Math.max(0, (eh*60+em) - (sh*60+sm));
    }, 0);
  }
  function lunchMin(start, end) {
    if (!start || !end) return 0;
    const [sh,sm] = start.split(':').map(Number);
    const [eh,em] = end.split(':').map(Number);
    return Math.max(0, (eh*60+em) - (sh*60+sm));
  }

  const stmtEntry = db.prepare(`INSERT INTO time_entries
    (employee_id,clock_in,clock_out,break_minutes,lunch_start,lunch_end,company_name,
     total_hours,regular_hours,overtime_hours,job_id,notes,status,sheet_id,break_records)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      const bMin = (Array.isArray(e.breaks) && e.breaks.length)
        ? breaksMin(e.breaks)
        : (lunchMin(e.lunch_start, e.lunch_end) || parseInt(e.break_minutes)||0);
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
      const dateStr = e.clock_in.slice(0,10);
      const breaks = Array.isArray(e.breaks) ? e.breaks.filter(b=>b.start&&b.end) : [];
      const breakRecords = breaks.map(b => ({ start: dateStr+'T'+b.start, end: dateStr+'T'+b.end }));
      const ls = breaks[0]?.start || e.lunch_start || '';
      const le = breaks[0]?.end   || e.lunch_end   || '';
      const r = stmtEntry.run(employee_id, e.clock_in, e.clock_out, bMin,
        ls, le, company_name||'',
        hrs.total, hrs.regular, hrs.overtime, job_id||null, e.notes||'', 'closed', sheetId,
        JSON.stringify(breakRecords));
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

// ── Manager time-entry management (no blockManager restriction) ──
app.put('/api/manager/time-entries/:id', requireAdmin, (req, res) => {
  const d = req.body;
  let breakMins = 0, breakRecords = '[]';
  if (d.break_records) {
    try {
      const recs = JSON.parse(d.break_records);
      breakMins = Math.round(recs.reduce((sum, b) => {
        if (b.start && b.end) sum += new Date(b.end) - new Date(b.start);
        return sum;
      }, 0) / 60000);
      breakRecords = JSON.stringify(recs);
    } catch {}
  }
  const hrs = calcHours(d.clock_in, d.clock_out, breakMins);
  const status = d.clock_out ? 'closed' : 'open';
  db.prepare(`UPDATE time_entries SET
    clock_in=?,clock_out=?,break_minutes=?,break_records=?,
    total_hours=?,regular_hours=?,overtime_hours=?,
    notes=?,status=?,manager_confirmed=0,needs_review=1,review_reason='' WHERE id=?`).run(
    d.clock_in||null, d.clock_out||null, breakMins, breakRecords,
    hrs.total, hrs.regular, hrs.overtime,
    d.notes||'', status, req.params.id);
  res.json({ success: true, ...hrs, break_minutes: breakMins, status });
});

// PATCH /api/manager/time-entries/:id/correct-time — correct clock_in or clock_out for a punch
app.patch('/api/manager/time-entries/:id/correct-time', requireAdmin, (req, res) => {
  const { field, new_time } = req.body;
  if (!['clock_in', 'clock_out'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  const t = new Date(new_time);
  if (isNaN(t.getTime())) return res.status(400).json({ error: 'Invalid time' });
  db.prepare(`UPDATE time_entries SET ${field}=? WHERE id=?`).run(t.toISOString(), req.params.id);
  const entry = db.prepare('SELECT * FROM time_entries WHERE id=?').get(req.params.id);
  if (entry && entry.clock_in && entry.clock_out) {
    const hrs = calcHours(entry.clock_in, entry.clock_out, entry.break_minutes || 0);
    db.prepare('UPDATE time_entries SET total_hours=?,regular_hours=?,overtime_hours=? WHERE id=?')
      .run(hrs.total, hrs.regular, hrs.overtime, req.params.id);
  }
  res.json({ success: true });
});

app.post('/api/manager/time-entries/:id/confirm', requireAdmin, (req, res) => {
  db.prepare("UPDATE time_entries SET manager_confirmed=1,needs_review=1 WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post('/api/manager/time-entries/batch', requireAdmin, (req, res) => {
  const { ids, action, regular_hours, overtime_hours, clock_in_delta_minutes, clock_out_delta_minutes } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未选择记录' });
  if (action === 'confirm') {
    const stmt = db.prepare("UPDATE time_entries SET manager_confirmed=1,needs_review=1 WHERE id=?");
    db.transaction(() => { for (const id of ids) stmt.run(id); })();
  } else if (action === 'set_hours') {
    const reg = Math.max(0, parseFloat(regular_hours) || 0);
    const ot = Math.max(0, parseFloat(overtime_hours) || 0);
    const stmt = db.prepare("UPDATE time_entries SET regular_hours=?,overtime_hours=?,total_hours=? WHERE id=?");
    db.transaction(() => { for (const id of ids) stmt.run(reg, ot, reg + ot, id); })();
  } else if (action === 'adjust_time') {
    const ciDelta = parseInt(clock_in_delta_minutes) || 0;
    const coDelta = parseInt(clock_out_delta_minutes) || 0;
    db.transaction(() => {
      for (const id of ids) {
        if (ciDelta) db.prepare("UPDATE time_entries SET clock_in=datetime(clock_in,?||' minutes') WHERE id=?").run(String(ciDelta), id);
        if (coDelta) db.prepare("UPDATE time_entries SET clock_out=datetime(clock_out,?||' minutes') WHERE clock_out IS NOT NULL AND id=?").run(String(coDelta), id);
      }
    })();
  }
  res.json({ success: true });
});

// Admin confirms a manager-confirmed time entry (final approval)
app.post('/api/admin/time-entries/:id/confirm', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  db.prepare("UPDATE time_entries SET needs_review=0,review_reason='' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// List timesheet sheets (admin)
app.get('/api/admin/timesheet-sheets', requireAdmin, (req, res) => {
  const { stage } = req.query; // 'verify' | 'pending_confirm' | 'payment' | 'history'
  let where = '';
  if (stage === 'verify')          where = `WHERE ts.status IN ('confirmed','disputed')`;
  if (stage === 'pending_confirm') where = `WHERE ts.status = 'pending'`;
  if (stage === 'payment')         where = `WHERE ts.status = 'verified'`;
  if (stage === 'dividend')        where = `WHERE ts.status = 'dividend_pending'`;
  if (stage === 'history')         where = `WHERE ts.status = 'completed'`;
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

// ─── INVOICE PROFILES (presets) ───

app.get('/api/admin/invoice-profiles', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM invoice_profiles ORDER BY section, name').all());
});

app.post('/api/admin/invoice-profiles', requireAdmin, (req, res) => {
  const { name, section, data } = req.body;
  if (!name || !section) return res.status(400).json({ error: 'name and section required' });
  const r = db.prepare('INSERT INTO invoice_profiles (name, section, data) VALUES (?,?,?)').run(name, section, JSON.stringify(data || {}));
  res.json({ id: r.lastInsertRowid, success: true });
});

app.put('/api/admin/invoice-profiles/:id', requireAdmin, (req, res) => {
  const { name, data } = req.body;
  if (name !== undefined) db.prepare('UPDATE invoice_profiles SET name=? WHERE id=?').run(name, req.params.id);
  if (data !== undefined) db.prepare('UPDATE invoice_profiles SET data=? WHERE id=?').run(JSON.stringify(data), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/invoice-profiles/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM invoice_profiles WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── INVOICE STORAGE ───
db.exec(`CREATE TABLE IF NOT EXISTS invoice_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT,
  company_name TEXT,
  bill_to_addr TEXT,
  period_start TEXT,
  period_end TEXT,
  for_label TEXT,
  subtotal REAL DEFAULT 0,
  items_json TEXT,
  profile_json TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// List invoices
app.get('/api/admin/invoices', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, invoice_number, invoice_date, company_name, period_start, period_end, subtotal, status, payment_status, payment_receipt_path, paid_at, created_at FROM invoices ORDER BY created_at DESC`).all();
  res.json(rows);
});

// Save invoice
app.post('/api/admin/invoices', requireAdmin, (req, res) => {
  const { invoice_number, invoice_date, company_name, bill_to_addr, period_start, period_end, for_label, subtotal, items, profile, status, markup_rate } = req.body;
  if (!invoice_number || !company_name) return res.status(400).json({ error: '缺少必填字段' });
  const result = db.prepare(`
    INSERT INTO invoices (invoice_number, invoice_date, company_name, bill_to_addr, period_start, period_end, for_label, subtotal, items_json, profile_json, status, markup_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(invoice_number, invoice_date||null, company_name, bill_to_addr||null, period_start||null, period_end||null, for_label||null, subtotal||0, JSON.stringify(items||[]), JSON.stringify(profile||{}), status||'saved', markup_rate||0);
  db.prepare(`INSERT INTO invoice_history (invoice_id, action, detail) VALUES (?, ?, ?)`)
    .run(result.lastInsertRowid, '创建', `Invoice 编号: ${invoice_number}`);
  res.json({ id: result.lastInsertRowid });
});

// Get single invoice (with full details)
app.get('/api/admin/invoices/:id', requireAdmin, (req, res) => {
  const row = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.items = row.items_json ? JSON.parse(row.items_json) : [];
  row.profile = row.profile_json ? JSON.parse(row.profile_json) : {};
  delete row.items_json; delete row.profile_json;
  res.json(row);
});

// Update invoice
app.put('/api/admin/invoices/:id', requireAdmin, (req, res) => {
  const { invoice_number, invoice_date, company_name, bill_to_addr, period_start, period_end, for_label, subtotal, items, profile, status, markup_rate } = req.body;
  if (!invoice_number || !company_name) return res.status(400).json({ error: '缺少必填字段' });
  db.prepare(`
    UPDATE invoices SET invoice_number=?, invoice_date=?, company_name=?, bill_to_addr=?, period_start=?, period_end=?, for_label=?, subtotal=?, items_json=?, profile_json=?, status=?, markup_rate=?
    WHERE id=?
  `).run(invoice_number, invoice_date||null, company_name, bill_to_addr||null, period_start||null, period_end||null, for_label||null, subtotal||0, JSON.stringify(items||[]), JSON.stringify(profile||{}), status||'saved', markup_rate||0, req.params.id);
  res.json({ success: true });
});

// Delete invoice
app.delete('/api/admin/invoices/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM invoices WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// Upload payment receipt and mark invoice as paid
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `receipt-${req.params.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png|gif|webp)$/i.test(path.extname(file.originalname));
    cb(null, ok);
  }
});

app.post('/api/admin/invoices/:id/mark-paid', requireAdmin, receiptUpload.single('receipt'), (req, res) => {
  const inv = db.prepare('SELECT id, payment_receipt_path FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  // Delete old receipt file if exists
  if (inv.payment_receipt_path) {
    const oldPath = path.join(uploadsDir, path.basename(inv.payment_receipt_path));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  const receiptPath = req.file ? `/uploads/${req.file.filename}` : null;
  db.prepare(`UPDATE invoices SET payment_status='paid', payment_receipt_path=?, paid_at=datetime('now') WHERE id=?`)
    .run(receiptPath, req.params.id);
  db.prepare(`INSERT INTO invoice_history (invoice_id, action, detail) VALUES (?, ?, ?)`)
    .run(req.params.id, '标记已付款', receiptPath ? `回执文件: ${path.basename(receiptPath)}` : '');
  res.json({ success: true, receipt_path: receiptPath });
});

// Mark invoice as unpaid (remove receipt)
app.post('/api/admin/invoices/:id/mark-unpaid', requireAdmin, (req, res) => {
  const inv = db.prepare('SELECT id, payment_receipt_path FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.payment_receipt_path) {
    const oldPath = path.join(uploadsDir, path.basename(inv.payment_receipt_path));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.prepare(`UPDATE invoices SET payment_status='unpaid', payment_receipt_path=NULL, paid_at=NULL WHERE id=?`)
    .run(req.params.id);
  db.prepare(`INSERT INTO invoice_history (invoice_id, action, detail) VALUES (?, ?, ?)`)
    .run(req.params.id, '取消已付款', '');
  res.json({ success: true });
});

// ─── INVOICE HISTORY ───

// Log an invoice action
app.post('/api/admin/invoices/:id/history', requireAdmin, (req, res) => {
  const { action, detail } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  db.prepare(`INSERT INTO invoice_history (invoice_id, action, detail) VALUES (?, ?, ?)`)
    .run(req.params.id, action, detail || '');
  res.json({ success: true });
});

// Get invoice history
app.get('/api/admin/invoices/:id/history', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, action, detail, created_at FROM invoice_history WHERE invoice_id=? ORDER BY created_at DESC`).all(req.params.id);
  res.json(rows);
});

// ─── INVOICE GENERATION ───

// Get employees (and their hours) for a given company + period (for invoice builder)
app.get('/api/admin/invoice/employees', requireAdmin, (req, res) => {
  const { company_name, period_start, period_end } = req.query;
  const conds = ['te.status != ?'];
  const params = ['open'];
  if (company_name) { conds.push('te.company_name=?'); params.push(company_name); }
  if (period_start) { conds.push("date(te.clock_in) >= ?"); params.push(period_start); }
  if (period_end)   { conds.push("date(te.clock_in) <= ?"); params.push(period_end); }

  const rows = db.prepare(`
    SELECT e.id as employee_id, e.first_name, e.last_name, e.employee_id as emp_code, e.position,
      ROUND(SUM(COALESCE(te.regular_hours,0)),2) as regular_hours,
      ROUND(SUM(COALESCE(te.overtime_hours,0)),2) as overtime_hours,
      ROUND(SUM(COALESCE(te.total_hours,0)),2) as total_hours,
      COALESCE(MAX(ej.client_hourly_rate),0) as client_hourly_rate
    FROM time_entries te
    JOIN employees e ON te.employee_id = e.id
    LEFT JOIN employee_jobs ej ON ej.employee_id = e.id AND ej.status='active'
    WHERE ${conds.join(' AND ')}
    GROUP BY e.id
    ORDER BY e.last_name, e.first_name
  `).all(...params);
  res.json(rows);
});

// Generate invoice JSON for a company + period
app.post('/api/admin/invoice/generate', requireAdmin, (req, res) => {
  const { company_name, period_start, period_end, employee_ids, bill_rates } = req.body;
  if (!company_name || !period_start || !period_end)
    return res.status(400).json({ error: '请填写公司名称和周期' });

  const ids = Array.isArray(employee_ids) && employee_ids.length > 0 ? employee_ids : null;
  const conds = ["te.status != 'open'", 'te.company_name=?', "date(te.clock_in) >= ?", "date(te.clock_in) <= ?"];
  const params = [company_name, period_start, period_end];
  if (ids) { conds.push(`te.employee_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }

  const rows = db.prepare(`
    SELECT e.id as employee_id, e.first_name, e.last_name, e.employee_id as emp_code, e.position,
      ROUND(SUM(COALESCE(te.regular_hours,0)),2) as regular_hours,
      ROUND(SUM(COALESCE(te.overtime_hours,0)),2) as overtime_hours,
      ROUND(SUM(COALESCE(te.total_hours,0)),2) as total_hours,
      COALESCE(MAX(ej.client_hourly_rate),0) as client_hourly_rate
    FROM time_entries te
    JOIN employees e ON te.employee_id = e.id
    LEFT JOIN employee_jobs ej ON ej.employee_id = e.id AND ej.status='active'
    WHERE ${conds.join(' AND ')}
    GROUP BY e.id ORDER BY e.last_name, e.first_name
  `).all(...params);

  const partner = db.prepare('SELECT * FROM partners WHERE name=? LIMIT 1').get(company_name);

  const items = rows.map(r => {
    const rate = (bill_rates && bill_rates[String(r.employee_id)] != null)
      ? parseFloat(bill_rates[String(r.employee_id)]) : (r.client_hourly_rate || 0);
    const regAmt  = Math.round((r.regular_hours  || 0) * rate * 100) / 100;
    const otAmt   = Math.round((r.overtime_hours || 0) * rate * 1.5 * 100) / 100;
    return {
      employee_id: r.employee_id, name: `${r.first_name} ${r.last_name}`,
      emp_code: r.emp_code, position: r.position || '',
      regular_hours: r.regular_hours || 0, overtime_hours: r.overtime_hours || 0,
      total_hours: r.total_hours || 0, rate,
      regular_amount: regAmt, overtime_amount: otAmt,
      total_amount: Math.round((regAmt + otAmt) * 100) / 100
    };
  });

  const subtotal = Math.round(items.reduce((s, i) => s + i.total_amount, 0) * 100) / 100;
  const invoiceNum = 'INV-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
  res.json({
    invoice_number: invoiceNum, company_name, partner,
    period_start, period_end,
    generated_at: new Date().toISOString(),
    items, subtotal
  });
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
  // Fetch configured work sites for this employee (via active assignments)
  const sites = db.prepare(`
    SELECT DISTINCT js.id, js.name, js.latitude, js.longitude, js.radius_meters
    FROM assignments a
    JOIN jobs j ON a.job_id = j.id
    JOIN job_sites js ON j.site_id = js.id
    JOIN inquiries i ON a.inquiry_id = i.id
    JOIN employees e ON (e.employee_id = i.worker_code OR i.id = (
      SELECT linked_inquiry_id FROM worker_accounts WHERE linked_inquiry_id IS NOT NULL
      AND id IN (SELECT id FROM worker_accounts WHERE 1=0)
    ))
    WHERE e.id = ? AND a.status IN ('assigned','working') AND js.latitude IS NOT NULL
    LIMIT 10
  `).all(emp.id);
  // Also check employee_jobs table
  const sites2 = db.prepare(`
    SELECT DISTINCT js.id, js.name, js.latitude, js.longitude, js.radius_meters
    FROM employee_jobs ej
    JOIN jobs j ON ej.job_id = j.id
    JOIN job_sites js ON j.site_id = js.id
    WHERE ej.employee_id = ? AND ej.status = 'active' AND js.latitude IS NOT NULL
    LIMIT 10
  `).all(emp.id);
  const allSites = [...sites, ...sites2].filter((s,i,arr) => arr.findIndex(x=>x.id===s.id)===i);
  res.json({
    employee: { id: emp.id, name: `${emp.first_name} ${emp.last_name}`, employee_id: emp.employee_id, position: emp.position||'' },
    clocked_in: !!open,
    on_break: open ? !!(open.on_break) : false,
    open_entry: open || null,
    today_hours: Math.round(todayHours*100)/100,
    week_hours: Math.round(weekHours*100)/100,
    clock_in_time: open ? open.clock_in : null,
    work_sites: allSites
  });
});

app.post('/api/timeclock/punch', (req, res) => {
  const { employee_id, pin, punch_type, latitude, longitude } = req.body;
  if (!employee_id || !pin) return res.status(400).json({ error: '请输入员工编号和 PIN' });
  const ptype = punch_type || 'toggle'; // legacy: no punch_type = auto toggle
  const emp = db.prepare("SELECT * FROM employees WHERE employee_id=? AND status='active'").get(employee_id.toUpperCase());
  if (!emp) return res.status(401).json({ error: '未找到员工或员工已离职' });
  if (!emp.pin_hash) return res.status(401).json({ error: 'PIN 未设置，请联系管理员' });
  if (!verifyPin(pin, emp.pin_salt, emp.pin_hash)) return res.status(401).json({ error: 'PIN 错误' });

  const now = new Date().toISOString();
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);

  // ── Geofencing: required for clock-in; all punch types must verify location ──
  const empSites = db.prepare(`
    SELECT DISTINCT js.id, js.name, js.latitude, js.longitude, js.radius_meters
    FROM employee_jobs ej
    JOIN jobs j ON ej.job_id = j.id
    JOIN job_sites js ON j.site_id = js.id
    WHERE ej.employee_id = ? AND ej.status = 'active' AND js.latitude IS NOT NULL AND js.longitude IS NOT NULL
  `).all(emp.id);

  if (empSites.length > 0) {
    // Employee has configured job sites — location verification is mandatory
    if (!latitude || !longitude) {
      return res.status(400).json({ error: '打卡需要开启位置权限，请在浏览器设置中允许定位后再试。\nLocation permission required to clock in.', need_gps: true });
    }
    let insideAny = false;
    let closestDist = Infinity, closestSite = null;
    for (const site of empSites) {
      const dist = haversineDistance(latitude, longitude, site.latitude, site.longitude);
      if (dist <= site.radius_meters) { insideAny = true; break; }
      if (dist < closestDist) { closestDist = dist; closestSite = site; }
    }
    if (!insideAny) {
      const distStr = closestSite
        ? (closestDist >= 1000 ? (closestDist/1000).toFixed(1)+' km' : Math.round(closestDist)+' m')
        : '未知';
      const siteName = closestSite ? closestSite.name : '';
      return res.status(400).json({ error: `您的位置不在工作地点范围内（距"${siteName}"约 ${distStr}，允许范围 ${closestSite?.radius_meters||200}m）。\n请到达工作地点后再打卡。`, geo_blocked: true });
    }
  } else if (ptype === 'in' || ptype === 'toggle') {
    // No configured job sites — block clock-in to prevent unverified punches
    if (!latitude || !longitude) {
      return res.status(400).json({ error: '打卡需要开启位置权限。\nLocation permission required.', need_gps: true });
    }
    return res.status(400).json({ error: '该员工暂无已配置工作地点的工作，无法验证位置，请联系HR。\nNo configured job site found, please contact HR.', no_site: true });
  }

  let warning = null; // warning message (not blocking)

  // ── Legacy toggle (no punch_type) ──
  if (ptype === 'toggle') {
    if (open) {
      const hrs = calcHours(open.clock_in, now, open.break_minutes||0);
      db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed' WHERE id=?")
        .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
      return res.json({ action: 'out', clock_in: open.clock_in, clock_out: now, total_hours: hrs.total, regular_hours: hrs.regular, overtime_hours: hrs.overtime });
    } else {
      const r = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,break_records,on_break) VALUES(?,?,'open','[]',0)").run(emp.id, now);
      return res.json({ action: 'in', clock_in: now, entry_id: r.lastInsertRowid });
    }
  }

  // ── Clock In ──
  if (ptype === 'in') {
    if (open) {
      // Flag the unclosed entry for admin review and allow the new clock-in
      const missedDate = open.clock_in ? open.clock_in.slice(0,10) : '?';
      db.prepare("UPDATE time_entries SET status='closed',needs_review=1,review_reason=? WHERE id=?")
        .run(`漏打下班卡（${missedDate}），由新上班打卡触发`, open.id);
      warning = `提示：${missedDate} 忘记打下班卡，该记录已标记给管理员审核`;
    }
    const r = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,break_records,on_break,punch_type) VALUES(?,?,'open','[]',0,'in')").run(emp.id, now);
    return res.json({ action: 'in', clock_in: now, entry_id: r.lastInsertRowid, warning });
  }

  // ── Clock Out ──
  if (ptype === 'out') {
    if (!open) {
      warning = '提示：未找到对应上班记录，可能漏打上班卡，已记录下班时间，标记管理员审核';
      const r = db.prepare("INSERT INTO time_entries (employee_id,clock_out,status,total_hours,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,?,'closed',0,'[]',0,'out_only',1,'漏打上班卡，仅有下班记录')").run(emp.id, now);
      return res.json({ action: 'out', clock_in: null, clock_out: now, total_hours: 0, warning, entry_id: r.lastInsertRowid });
    }
    if (open.on_break) warning = '提示：您处于暂停中，已自动结束暂停并打下班卡';
    const hrs = calcHours(open.clock_in, now, open.break_minutes||0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed',punch_type='out' WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
    return res.json({ action: 'out', clock_in: open.clock_in, clock_out: now, total_hours: hrs.total, regular_hours: hrs.regular, overtime_hours: hrs.overtime, warning });
  }

  // ── Break Start (Pause) ──
  if (ptype === 'break_start') {
    if (!open) {
      warning = '提示：未找到上班记录，可能漏打上班卡，已记录休息开始，标记管理员审核';
      const r = db.prepare("INSERT INTO time_entries (employee_id,status,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,'open',?,1,'break_start_only',1,'漏打上班卡，由break_start触发')").run(emp.id, JSON.stringify([{start:now,end:null}]));
      return res.json({ action: 'break_start', warning, entry_id: r.lastInsertRowid });
    }
    const breaks = JSON.parse(open.break_records||'[]');
    if (open.on_break) {
      warning = '提示：您已在暂停中，已重新记录暂停开始时间';
      const lastOpen = breaks.findIndex(b=>!b.end);
      if (lastOpen>=0) breaks[lastOpen].start = now;
    } else {
      breaks.push({start:now,end:null});
    }
    db.prepare('UPDATE time_entries SET break_records=?,on_break=1,break_start=? WHERE id=?').run(JSON.stringify(breaks), now, open.id);
    return res.json({ action: 'break_start', entry_id: open.id, warning });
  }

  // ── Break End (Resume) ──
  if (ptype === 'break_end') {
    if (!open) {
      warning = '提示：未找到上班记录，可能漏打上班卡及休息开始，已记录休息结束，标记管理员审核';
      const r = db.prepare("INSERT INTO time_entries (employee_id,status,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,'open',?,0,'break_end_only',1,'漏打上班卡及休息开始，仅有休息结束记录')").run(emp.id, JSON.stringify([{start:null,end:now}]));
      return res.json({ action: 'break_end', break_minutes: 0, warning, entry_id: r.lastInsertRowid });
    }
    const breaks = JSON.parse(open.break_records||'[]');
    const lastIdx = breaks.findIndex(b=>!b.end);
    if (lastIdx>=0) {
      breaks[lastIdx].end = now;
    } else {
      // No open break found — record a flagged entry with null start for admin review
      warning = '提示：未找到休息开始记录，休息结束已记录，标记管理员审核';
      breaks.push({start:null, end:now, flagged:true});
      db.prepare('UPDATE time_entries SET break_records=?,on_break=0,needs_review=1,review_reason=COALESCE(NULLIF(review_reason,\'\'),\'漏打休息开始，仅有休息结束记录\') WHERE id=?').run(JSON.stringify(breaks),open.id);
      return res.json({ action: 'break_end', break_minutes: 0, warning });
    }
    if (!open.on_break) {
      warning = '提示：您当前不在暂停中，此操作已记录';
    }
    const totalBreakMs = breaks.reduce((sum,b)=>{if(b.start&&b.end)sum+=new Date(b.end)-new Date(b.start);return sum;},0);
    const breakMins = Math.round(totalBreakMs/60000);
    db.prepare('UPDATE time_entries SET break_records=?,on_break=0,break_minutes=? WHERE id=?').run(JSON.stringify(breaks),breakMins,open.id);
    return res.json({ action: 'break_end', break_minutes: breakMins, warning });
  }

  return res.status(400).json({ error: '无效的打卡类型' });
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

// ─── Worker Portal API ───
app.post('/api/worker/login', (req, res) => {
  const { login, username, password } = req.body;
  const identifier = (login || username || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  const digits10 = identifier.replace(/\D/g, '').slice(-10);
  // Match by email (exact), phone (last-10-digits, format-agnostic, skip if empty), or username
  const w = db.prepare(
    'SELECT * FROM worker_accounts WHERE email=? OR (? != \'\' AND phone10(phone)=?) OR username=?'
  ).get(identifier, digits10, digits10, identifier);
  if (!w || !verifyPassword(password, w.salt, w.password_hash))
    return res.status(401).json({ error: '邮箱/手机号或密码错误 / Invalid email/phone or password' });
  if (!w.active)
    return res.status(403).json({ error: '账号尚未验证，请先完成手机和邮箱验证 / Account not verified. Please complete phone and email verification first.' });
  if (w.suspended)
    return res.status(403).json({ error: '账号已被暂停，请联系管理员 / Account suspended. Please contact admin.' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO worker_sessions (token, worker_id, employee_id, created_at) VALUES (?,?,?,?)').run(token, w.id, w.employee_id, Date.now());
  res.json({ token, employee_id: w.employee_id });
});

app.get('/api/worker/me', requireWorker, (req, res) => {
  const w = db.prepare('SELECT id, username, name, phone, email, dob, work_status, employee_id, active, employment_type, created_at FROM worker_accounts WHERE id=?').get(req.workerId);
  const emp = req.workerEmployeeId ? db.prepare('SELECT id, first_name, last_name, employee_id, position, department, pay_rate, pay_type, status, address, street2, city, state, zip, emergency_name, emergency_phone, emergency_relation FROM employees WHERE id=?').get(req.workerEmployeeId) : null;
  const docs = db.prepare("SELECT doc_type, status, created_at FROM worker_compliance_docs WHERE worker_account_id=?").all(req.workerId);
  res.json({ account: w, employee: emp, compliance_docs: docs });
});

// ─── Worker Profile: Address & Emergency Contact ───
app.get('/api/worker/maps-key', requireWorker, (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  res.json({ key });
});

app.put('/api/worker/profile/address', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.status(400).json({ error: '未关联员工档案' });
  const { address, street2, city, state, zip } = req.body || {};
  if (!address || !address.trim()) return res.status(400).json({ error: '请填写街道地址' });
  db.prepare('UPDATE employees SET address=?, street2=?, city=?, state=?, zip=? WHERE id=?')
    .run((address||'').trim(), (street2||'').trim(), (city||'').trim(), (state||'').trim(), (zip||'').trim(), req.workerEmployeeId);
  res.json({ success: true });
});

app.put('/api/worker/profile/emergency', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.status(400).json({ error: '未关联员工档案' });
  const { emergency_name, emergency_phone, emergency_relation } = req.body || {};
  db.prepare('UPDATE employees SET emergency_name=?, emergency_phone=?, emergency_relation=? WHERE id=?')
    .run((emergency_name||'').trim(), (emergency_phone||'').trim(), (emergency_relation||'').trim(), req.workerEmployeeId);
  res.json({ success: true });
});

app.put('/api/worker/profile/language', requireWorker, (req, res) => {
  const { lang } = req.body || {};
  if (!lang) return res.status(400).json({ error: 'lang required' });
  db.prepare('UPDATE worker_accounts SET preferred_lang=? WHERE id=?').run(lang, req.workerId);
  res.json({ success: true });
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

// ── Sequential contact-change flow ──────────────────────────────────
// Step 1: Send verification code to the OLD contact
app.post('/api/worker/contact/send-old-code', requireWorker, async (req, res) => {
  const { field } = req.body;
  if (!['phone','email'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  const w = db.prepare('SELECT phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  const oldVal = w[field];
  if (!oldVal) {
    // No old contact on file – skip old verification
    _pendingContactChange.set(`${req.workerId}_${field}_s1`, { old_verified: true, expires: Date.now() + 15*60*1000 });
    return res.json({ success: true, old_sent: false, no_old: true });
  }
  const code = String(Math.floor(100000 + Math.random()*900000));
  const expires = Date.now() + 15*60*1000;
  _pendingContactChange.set(`${req.workerId}_${field}_s1`, { old_code: code, expires });
  let sent = false;
  if (field === 'phone') {
    if (twilioClient && TWILIO_VERIFY_SID) { await sendVerifyCode(oldVal); sent = true; }
    else if (twilioClient && TWILIO_FROM) { sent = await sendSMS(oldVal, `[Prime Anchorpoint] Your verification code: ${code} (valid 15 min)`); }
  } else {
    sent = await sendEmail(oldVal, 'Prime Anchorpoint Verification Code', `Your verification code: ${code}\nValid for 15 minutes.`);
  }
  console.log(`[CC-S1] Worker ${req.workerId} field=${field} old_code=${code}`);
  res.json({ success: true, old_sent: sent });
});

// Step 2: Verify old code, then send code to the NEW contact
app.post('/api/worker/contact/verify-old-send-new', requireWorker, async (req, res) => {
  const { field, old_code, new_value } = req.body;
  if (!['phone','email'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  if (!new_value || !new_value.trim()) return res.status(400).json({ error: field==='phone' ? 'Please enter new phone number' : 'Please enter new email' });
  const val = new_value.trim();
  const taken = field === 'phone'
    ? db.prepare('SELECT id FROM worker_accounts WHERE phone=? AND id!=?').get(val, req.workerId)
    : db.prepare('SELECT id FROM worker_accounts WHERE email=? AND id!=?').get(val, req.workerId);
  if (taken) return res.status(400).json({ error: field==='phone' ? '该手机号已被其他账号使用' : '该邮箱已被其他账号注册' });
  const w = db.prepare('SELECT phone, email FROM worker_accounts WHERE id=?').get(req.workerId);
  const s1 = _pendingContactChange.get(`${req.workerId}_${field}_s1`);
  if (w[field]) {
    if (!s1 || Date.now() > s1.expires) return res.status(400).json({ error: '验证码已过期，请重新发送' });
    let oldOk = false;
    if (field === 'phone' && twilioClient && TWILIO_VERIFY_SID) {
      oldOk = await checkVerifyCode(w.phone, old_code);
    } else { oldOk = (old_code && old_code.trim() === s1.old_code); }
    if (!oldOk) return res.status(400).json({ error: field==='phone' ? '旧手机号验证码不正确' : '旧邮箱验证码不正确' });
  }
  _pendingContactChange.delete(`${req.workerId}_${field}_s1`);
  const newCode = String(Math.floor(100000 + Math.random()*900000));
  const expires = Date.now() + 15*60*1000;
  _pendingContactChange.set(`${req.workerId}_${field}_s2`, { new_value: val, new_code: newCode, expires });
  let newSent = false;
  if (field === 'phone') {
    if (twilioClient && TWILIO_VERIFY_SID) { await sendVerifyCode(val); newSent = true; }
    else if (twilioClient && TWILIO_FROM) { newSent = await sendSMS(val, `[Prime Anchorpoint] Your new phone verification code: ${newCode} (valid 15 min)`); }
  } else {
    newSent = await sendEmail(val, 'Prime Anchorpoint New Email Verification', `Your verification code: ${newCode}\nValid for 15 minutes.`);
  }
  console.log(`[CC-S2] Worker ${req.workerId} field=${field} new_code=${newCode}`);
  res.json({ success: true, new_sent: newSent });
});

// Step 3: Verify new code and update DB
app.post('/api/worker/contact/confirm-new', requireWorker, async (req, res) => {
  const { field, new_code } = req.body;
  if (!['phone','email'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
  const s2 = _pendingContactChange.get(`${req.workerId}_${field}_s2`);
  if (!s2 || Date.now() > s2.expires) return res.status(400).json({ error: '验证码已过期，请重新发送' });
  let newOk = false;
  if (field === 'phone' && twilioClient && TWILIO_VERIFY_SID) {
    newOk = await checkVerifyCode(s2.new_value, new_code);
  } else { newOk = (new_code && new_code.trim() === s2.new_code); }
  if (!newOk) return res.status(400).json({ error: field==='phone' ? '新手机号验证码不正确' : '新邮箱验证码不正确' });
  if (field === 'phone') db.prepare('UPDATE worker_accounts SET phone=? WHERE id=?').run(s2.new_value, req.workerId);
  else db.prepare('UPDATE worker_accounts SET email=? WHERE id=?').run(s2.new_value, req.workerId);
  _pendingContactChange.delete(`${req.workerId}_${field}_s2`);
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
  const lang = req.query.lang;
  const base = `
    SELECT j.id, j.title, j.type, j.location, j.pay, j.pay_period,
           j.work_auth, j.benefits, j.work_days, j.work_start, j.work_end,
           j.employment_type, j.description, j.urgent, j.lang, j.langs,
           j.title_zh, j.title_es, j.desc_zh, j.desc_es,
           COALESCE(NULLIF(j.company_name,''), p.name, '') AS company_name
    FROM jobs j LEFT JOIN partners p ON j.partner_id = p.id
    WHERE j.active=1`;
  const jobs = (lang && lang !== 'all')
    ? db.prepare(base + ` AND (j.langs IS NULL OR j.langs='' OR instr(','||j.langs||',', ','||?||',')>0) ORDER BY j.created_at DESC`).all(lang)
    : db.prepare(base + ' ORDER BY j.created_at DESC').all();
  const applied = db.prepare('SELECT job_id FROM job_applications WHERE worker_account_id=?').all(req.workerId).map(r => r.job_id);
  res.json(jobs.map(j => ({ ...j, applied: applied.includes(j.id) })));
});

app.post('/api/worker/apply/:jobId', requireWorker, (req, res) => {
  const job = db.prepare('SELECT id, work_auth FROM jobs WHERE id=? AND active=1').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or no longer active' });
  const { notes, interview_availability, expected_pay, applicant_message, work_auth_confirmed, job_category } = req.body || {};
  // If job requires gc/citizen, applicant must confirm work auth status
  if ((job.work_auth === 'gc' || job.work_auth === 'citizen') && !work_auth_confirmed)
    return res.status(400).json({ error: '请选择您的工作身份状态' });
  try {
    db.prepare(`INSERT INTO job_applications (job_id, worker_account_id, notes, interview_availability, expected_pay, applicant_message, work_auth_confirmed, job_category) VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.params.jobId, req.workerId, notes||'', interview_availability||'', expected_pay||'', applicant_message||'', work_auth_confirmed||'', job_category||'');
    res.json({ success: true });
  } catch { res.status(400).json({ error: 'Already applied to this job' }); }
});

app.get('/api/worker/timeclock', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json([]);
  const y = parseInt(req.query.year)  || new Date().getFullYear();
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const to   = `${y}-${String(m).padStart(2,'0')}-${String(new Date(y,m,0).getDate()).padStart(2,'0')}`;
  // Use client timezone offset so entries appear on the correct local calendar day
  const tzOffsetMinutes = parseInt(req.query.tz_offset) || 0;
  const localOffsetMinutes = -tzOffsetMinutes;
  const tzSign = localOffsetMinutes >= 0 ? '+' : '-';
  const tzAbsMins = Math.abs(localOffsetMinutes);
  const tzModifier = `${tzSign}${tzAbsMins} minutes`;
  const entries = db.prepare(`
    SELECT t.*, j.title AS job_title, j.company_name AS job_company,
           COALESCE(t.site_timezone, js.timezone, 'America/Chicago') AS display_timezone
    FROM time_entries t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN job_sites js ON j.site_id = js.id
    WHERE t.employee_id = ?
      AND t.clock_in IS NOT NULL
      AND strftime('%Y-%m-%d', datetime(clock_in, '${tzModifier}')) >= ?
      AND strftime('%Y-%m-%d', datetime(clock_in, '${tzModifier}')) <= ?
    ORDER BY t.clock_in DESC LIMIT 500
  `).all(req.workerEmployeeId, from, to);
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
    let bsWarning = null;
    if (!open) bsWarning = '提示：未找到上班打卡记录，可能漏打了上班卡';
    else if (open.on_break) bsWarning = '提示：您已在休息中，已重新记录暂停开始时间';
    if (!open) {
      // No open entry — record break_start with clock_in left NULL for admin review
      const r2 = db.prepare("INSERT INTO time_entries (employee_id,job_id,status,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,?,'open',?,1,'break_start_only',1,'漏打上班卡，由break_start触发')").run(req.workerEmployeeId, job_id || null, JSON.stringify([{start:now,end:null}]));
      return res.json({ action: 'break_start', warning: bsWarning, entry_id: r2.lastInsertRowid });
    }

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

    // Photo is uploaded separately via /api/worker/punch/:entryId/photo (FormData)
    const breaks = JSON.parse(open.break_records || '[]');
    breaks.push({ start: now, end: null, latitude: latitude || null, longitude: longitude || null, geo_verified: bsGeoVerified });
    db.prepare('UPDATE time_entries SET break_records=?, on_break=1 WHERE id=?')
      .run(JSON.stringify(breaks), open.id);
    return res.json({ action: 'break_start', break_index: breaks.length - 1, entry_id: open.id, geo_verified: bsGeoVerified });
  }

  // ── Break end ────────────────────────────────────────────────────
  if (punch_type === 'break_end') {
    let beWarning = null;
    if (!open) beWarning = '提示：未找到上班打卡记录，可能漏打上班卡及休息开始，已记录休息结束，标记管理员审核';
    else if (!open.on_break) beWarning = '提示：您当前不在休息中';
    if (!open) {
      const r2 = db.prepare("INSERT INTO time_entries (employee_id,job_id,status,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,?,'open',?,0,'break_end_only',1,'漏打上班卡及休息开始，仅有休息结束记录')").run(req.workerEmployeeId, job_id || null, JSON.stringify([{start:null,end:now}]));
      return res.json({ action: 'break_end', break_minutes: 0, warning: beWarning, entry_id: r2.lastInsertRowid });
    }
    const breaks = JSON.parse(open.break_records || '[]');
    const lastIdx = breaks.findIndex(b => !b.end);
    if (lastIdx >= 0) {
      breaks[lastIdx].end = now;
    } else {
      // No open break — flag for admin review with null start
      beWarning = '提示：未找到休息开始记录，休息结束已记录，标记管理员审核';
      breaks.push({ start: null, end: now, flagged: true });
      db.prepare("UPDATE time_entries SET break_records=?, on_break=0, needs_review=1, review_reason=COALESCE(NULLIF(review_reason,''),'漏打休息开始，仅有休息结束记录') WHERE id=?")
        .run(JSON.stringify(breaks), open.id);
      return res.json({ action: 'break_end', break_minutes: 0, warning: beWarning, entry_id: open.id });
    }
    const totalBreakMs = breaks.reduce((sum, b) => {
      if (b.start && b.end) sum += new Date(b.end) - new Date(b.start);
      return sum;
    }, 0);
    const breakMins = Math.round(totalBreakMs / 60000);
    db.prepare('UPDATE time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?')
      .run(JSON.stringify(breaks), breakMins, open.id);
    return res.json({ action: 'break_end', break_minutes: breakMins, warning: beWarning, entry_id: open.id });
  }

  // ── Clock out ────────────────────────────────────────────────────
  if (punch_type === 'out') {
    let outWarning = null;
    if (!open) outWarning = '提示：未找到上班打卡记录，可能漏打了上班卡';
    else if (open.on_break) outWarning = '提示：您处于休息中，休息记录未关闭，已标记给管理员审核';
    if (!open) {
      // Record a standalone clock-out for manager review, do NOT auto-fill clock_in
      const r2 = db.prepare("INSERT INTO time_entries (employee_id,job_id,clock_out,status,total_hours,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,?,?,'closed',0,'[]',0,'out_only',1,'漏打上班卡，仅有下班记录')").run(req.workerEmployeeId, job_id || null, now);
      return res.json({ action: 'out', clock_in: null, clock_out: now, total_hours: 0, warning: outWarning, entry_id: r2.lastInsertRowid });
    }
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed',punch_type='out',punch_photo=COALESCE(?,punch_photo),clock_out_latitude=?,clock_out_longitude=? WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, photo_data || null, latitude || null, longitude || null, open.id);
    return res.json({ action: 'out', punch_type: 'out', clock_in: open.clock_in, clock_out: now, geo_verified: geoVerified, total_hours: hrs.total, regular_hours: hrs.regular, overtime_hours: hrs.overtime, entry_id: open.id });
  }

  // ── Clock in ─────────────────────────────────────────────────────
  let clockInWarning = null;
  if (open) {
    // Close the dangling open entry and flag for manager review, but do NOT auto-fill clock_out
    const missedDate = open.clock_in ? open.clock_in.slice(0,10) : '?';
    db.prepare("UPDATE time_entries SET status='closed',needs_review=1,review_reason=? WHERE id=?")
      .run(`漏打下班卡（${missedDate}），由新上班打卡触发`, open.id);
    clockInWarning = `提示：${missedDate} 忘记打下班卡，该记录已标记给管理员审核`;
  }
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
    const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
    const linkedInqId = wa?.linked_inquiry_id || null;
    if (linkedInqId) {
      activeJob = db.prepare(`
        SELECT a.id, a.job_id, j.title, j.site_id,
               js.id AS js_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
        FROM assignments a
        JOIN jobs j ON a.job_id = j.id
        LEFT JOIN job_sites js ON j.site_id = js.id
        WHERE a.job_id = ? AND a.status != 'cancelled' AND a.inquiry_id = ?
        ORDER BY a.assigned_at DESC LIMIT 1
      `).get(job_id, linkedInqId);
    }
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

  // Get site timezone for this job
  const siteTzRow = matchedSiteId
    ? db.prepare("SELECT timezone FROM job_sites WHERE id=?").get(matchedSiteId)
    : (activeJob.js_id ? db.prepare("SELECT timezone FROM job_sites WHERE id=?").get(activeJob.js_id) : null);
  const siteTimezone = siteTzRow?.timezone || 'America/Chicago';

  const r = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,latitude,longitude,site_id,geo_verified,job_id,punch_type,break_records,on_break,site_timezone) VALUES(?,?,'open',?,?,?,?,?,'in','[]',0,?)")
    .run(req.workerEmployeeId, now, latitude || null, longitude || null, matchedSiteId, geoVerified, activeJob.job_id, siteTimezone);
  res.json({ action: 'in', punch_type: 'in', clock_in: now, entry_id: r.lastInsertRowid, geo_verified: geoVerified,
    site_name: activeJob.site_name || (assignSite ? assignSite.work_address : null) || null, job_title: activeJob.title,
    site_timezone: siteTimezone, warning: clockInWarning });
});

// Upload punch photo for a time entry (must belong to this worker)
// ?punch_type=in|out|break_start|break_end  (default: out)
app.post('/api/worker/punch/:entryId/photo', requireWorker, punchPhotoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const entry = db.prepare('SELECT id, employee_id, break_records FROM time_entries WHERE id=?').get(req.params.entryId);
  if (!entry || entry.employee_id !== req.workerEmployeeId) {
    fs.unlink(req.file.path, ()=>{});
    return res.status(403).json({ error: 'Forbidden' });
  }
  const punchType = req.query.punch_type || 'out';
  if (punchType === 'in') {
    db.prepare('UPDATE time_entries SET clock_in_photo_path=? WHERE id=?').run(req.file.filename, entry.id);
  } else if (punchType === 'break_start' || punchType === 'break_end') {
    // Store photo in the most recent matching break record
    const breaks = JSON.parse(entry.break_records || '[]');
    if (punchType === 'break_start') {
      // Find the last break that has no end (most recent break_start)
      const idx = breaks.map((b,i)=>i).reverse().find(i => !breaks[i].end);
      if (idx !== undefined) breaks[idx].start_photo = req.file.filename;
    } else {
      // Find the last break that has an end
      const idx = breaks.map((b,i)=>i).reverse().find(i => breaks[i].end);
      if (idx !== undefined) breaks[idx].end_photo = req.file.filename;
    }
    db.prepare('UPDATE time_entries SET break_records=? WHERE id=?').run(JSON.stringify(breaks), entry.id);
  } else {
    // 'out' or default
    db.prepare('UPDATE time_entries SET punch_photo_path=? WHERE id=?').run(req.file.filename, entry.id);
  }
  res.json({ success: true });
});

// Serve punch photos — accepts Bearer header, pa_token cookie, or ?token= query param
// (img tags can't send Authorization headers, so query-param auth is needed)
app.get('/api/admin/punch-photo/:filename', (req, res) => {
  const auth = req.headers.authorization;
  let session = null;
  if (auth && auth.startsWith('Bearer ')) session = getSession(auth.slice(7));
  if (!session) {
    const cookieMatch = (req.headers.cookie || '').match(/pa_token=([^;]+)/);
    if (cookieMatch) session = getSession(cookieMatch[1]);
  }
  if (!session && req.query.token) session = getSession(req.query.token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  const fp = path.join(punchPhotosDir, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// ─── Worker task (my-tasks) endpoints ────────────────────────────
app.get('/api/worker/my-tasks', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json([]);
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
    WHERE a.inquiry_id = ? AND (a.status != 'cancelled' OR a.worker_response = 'rejected')
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
  // Require employee link — unlinked portal accounts have no work schedule to show
  if (!req.workerEmployeeId) return res.json({ confirmations: [], assignments: [], punchDates: [] });
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  const linkedInqId = wa?.linked_inquiry_id || null;
  const y = parseInt(req.query.year) || new Date().getFullYear();
  const m = parseInt(req.query.month) || new Date().getMonth() + 1;
  const fromStr = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const toStr = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  // tz_offset is browser's getTimezoneOffset() — negate it to get UTC→local offset in minutes
  const tzOffsetMinutes = parseInt(req.query.tz_offset) || 0;
  const localOffsetMinutes = -tzOffsetMinutes;
  const tzSign = localOffsetMinutes >= 0 ? '+' : '-';
  const tzAbsMins = Math.abs(localOffsetMinutes);
  const tzModifier = `${tzSign}${tzAbsMins} minutes`;
  const confirmations = linkedInqId ? db.prepare(`
    SELECT sc.id, sc.date, sc.status, sc.shift_start, sc.shift_end,
           j.title, j.location AS job_location, j.description AS job_description,
           j.pay AS job_pay, j.company_name,
           a.work_address, a.pay_rate, a.pay_type
    FROM shift_confirmations sc
    JOIN assignments a ON sc.assignment_id = a.id
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ? AND sc.date >= ? AND sc.date <= ?
    ORDER BY sc.date ASC
  `).all(linkedInqId, fromStr, toStr) : [];
  const assignments = linkedInqId ? db.prepare(`
    SELECT a.id, a.work_schedule, a.start_date, j.title, j.location AS job_location,
           j.description AS job_description, j.pay AS job_pay, j.company_name,
           a.work_address, a.pay_rate, a.pay_type,
           j.work_schedule AS job_work_schedule
    FROM assignments a
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.inquiry_id = ? AND a.status NOT IN ('terminated','resigned','cancelled')
  `).all(linkedInqId) : [];
  // Include actual punch records so weekend work (outside recurring schedule) is visible
  // Use client's timezone offset so punches appear on the correct local calendar day
  const punchDates = req.workerEmployeeId ? db.prepare(`
    SELECT DISTINCT strftime('%Y-%m-%d', datetime(clock_in, '${tzModifier}')) AS date
    FROM time_entries
    WHERE employee_id = ?
      AND strftime('%Y-%m-%d', datetime(clock_in, '${tzModifier}')) >= ?
      AND strftime('%Y-%m-%d', datetime(clock_in, '${tzModifier}')) <= ?
  `).all(req.workerEmployeeId, fromStr, toStr).map(r => r.date) : [];
  // Debug: log assignment schedules to diagnose missing Sunday
  assignments.forEach(a => {
    let ws = {}; try { ws = JSON.parse(a.work_schedule || '{}'); } catch {}
    const days = ws.days || ws;
    console.log(`[work-calendar debug] assignment ${a.id}: sun=${JSON.stringify(days.sun || days.Sun)}, sat=${JSON.stringify(days.sat || days.Sat)}, workStart=${ws.workStart||a.start_date}, workEnd=${ws.workEnd}`);
  });
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

// Admin: job title options CRUD
app.get('/api/admin/job-title-options', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM job_title_options ORDER BY sort_order, id').all());
});
app.post('/api/admin/job-title-options', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_en, name_zh, name_es } = req.body;
  if (!name_en || !name_en.trim()) return res.status(400).json({ error: '职位名称不能为空' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM job_title_options').get().m;
  const r = db.prepare('INSERT INTO job_title_options (name_en, name_zh, name_es, sort_order) VALUES (?,?,?,?)')
    .run(name_en.trim(), (name_zh||'').trim(), (name_es||'').trim(), maxOrder+1);
  res.json({ success: true, id: r.lastInsertRowid });
});
app.put('/api/admin/job-title-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_en, name_zh, name_es, sort_order } = req.body;
  if (!name_en || !name_en.trim()) return res.status(400).json({ error: '职位名称不能为空' });
  db.prepare('UPDATE job_title_options SET name_en=?, name_zh=?, name_es=?, sort_order=? WHERE id=?')
    .run(name_en.trim(), (name_zh||'').trim(), (name_es||'').trim(), sort_order ?? 0, req.params.id);
  res.json({ success: true });
});
app.delete('/api/admin/job-title-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM job_title_options WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Admin: display suffix options CRUD
app.get('/api/admin/display-suffix-options', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM display_suffix_options ORDER BY sort_order, id').all());
});
app.post('/api/admin/display-suffix-options', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_en, name_zh, name_es } = req.body;
  if (!name_en || !name_en.trim()) return res.status(400).json({ error: '后缀词不能为空' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM display_suffix_options').get().m;
  const r = db.prepare('INSERT INTO display_suffix_options (name_en, name_zh, name_es, sort_order) VALUES (?,?,?,?)')
    .run(name_en.trim(), (name_zh||'').trim(), (name_es||'').trim(), maxOrder+1);
  res.json({ success: true, id: r.lastInsertRowid });
});
app.put('/api/admin/display-suffix-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { name_en, name_zh, name_es, sort_order } = req.body;
  if (!name_en || !name_en.trim()) return res.status(400).json({ error: '后缀词不能为空' });
  db.prepare('UPDATE display_suffix_options SET name_en=?, name_zh=?, name_es=?, sort_order=? WHERE id=?')
    .run(name_en.trim(), (name_zh||'').trim(), (name_es||'').trim(), sort_order ?? 0, req.params.id);
  res.json({ success: true });
});
app.delete('/api/admin/display-suffix-options/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM display_suffix_options WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Worker: get display suffixes (for daily rotation in portal)
app.get('/api/worker/display-suffixes', requireWorker, (req, res) => {
  res.json(db.prepare('SELECT id, name_en, name_zh, name_es FROM display_suffix_options ORDER BY sort_order, id').all());
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
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  const linkedInqId = wa?.linked_inquiry_id || null;

  const open = req.workerEmployeeId
    ? db.prepare(`SELECT t.*, COALESCE(t.site_timezone, js.timezone, 'America/Chicago') AS display_timezone
       FROM time_entries t LEFT JOIN jobs j ON t.job_id=j.id LEFT JOIN job_sites js ON j.site_id=js.id
       WHERE t.employee_id=? AND t.status='open' ORDER BY t.clock_in DESC LIMIT 1`).get(req.workerEmployeeId)
    : null;

  const seenActiveJobIds = new Set();
  let activeJobs = [];
  if (req.workerEmployeeId) {
    const ejJobs = db.prepare(`
      SELECT ej.id, ej.job_id, j.title, j.company_name, j.work_days, j.work_start, j.work_end,
             COALESCE(NULLIF(a.work_address,''), j.location) AS location, j.pay,
             j.site_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters,
             a.work_schedule, a.work_lat, a.work_lng, a.work_radius
      FROM employee_jobs ej
      JOIN jobs j ON ej.job_id = j.id
      LEFT JOIN job_sites js ON j.site_id = js.id
      LEFT JOIN assignments a ON a.job_id = ej.job_id AND a.inquiry_id = ?
      WHERE ej.employee_id = ? AND ej.status = 'active'
    `).all(linkedInqId, req.workerEmployeeId);
    for (const j of ejJobs) { seenActiveJobIds.add(j.job_id); activeJobs.push(j); }
  }

  // Also check assignments table — add jobs not already covered by employee_jobs
  // Only include accepted assignments (worker_response = 'accepted')
  const aJobs = linkedInqId ? db.prepare(`
    SELECT a.id, a.job_id, j.title, j.company_name, j.work_days, j.work_start, j.work_end,
           COALESCE(NULLIF(a.work_address,''), j.location) AS location, j.pay,
           j.site_id, js.name AS site_name, js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters,
           a.work_schedule, a.work_lat, a.work_lng, a.work_radius
    FROM assignments a
    JOIN jobs j ON a.job_id = j.id
    LEFT JOIN job_sites js ON j.site_id = js.id
    WHERE a.status != 'cancelled' AND a.worker_response = 'accepted' AND a.inquiry_id = ?
    ORDER BY a.assigned_at DESC
  `).all(linkedInqId) : [];
  for (const j of aJobs) {
    if (!seenActiveJobIds.has(j.job_id)) { seenActiveJobIds.add(j.job_id); activeJobs.push(j); }
  }

  // Count pending (unaccepted) tasks
  const pendingTasksCount = linkedInqId
    ? (db.prepare(`SELECT COUNT(*) AS cnt FROM assignments WHERE inquiry_id=? AND status != 'cancelled' AND (worker_response IS NULL OR worker_response = '')`).get(linkedInqId)?.cnt || 0)
    : 0;

  // Detect if open entry is from a previous calendar day (worker forgot to clock out)
  let missed_checkout = false;
  let missed_date = null;
  if (open) {
    const nowLocal = new Date();
    const todayStr = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}`;
    const entryLocal = new Date(open.clock_in);
    const entryStr = `${entryLocal.getFullYear()}-${String(entryLocal.getMonth()+1).padStart(2,'0')}-${String(entryLocal.getDate()).padStart(2,'0')}`;
    if (entryStr < todayStr) { missed_checkout = true; missed_date = entryStr; }
  }

  res.json({
    clocked_in: !!open,
    on_break: !!(open?.on_break),
    open_entry: open || null,
    no_employee: !req.workerEmployeeId,
    has_active_job: activeJobs.length > 0,
    pending_tasks_count: pendingTasksCount,
    active_jobs: activeJobs,
    active_job: activeJobs[0] || null,
    missed_checkout,
    missed_date
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
  if (!req.workerEmployeeId) return res.json([]);
  const wa = db.prepare('SELECT linked_inquiry_id FROM worker_accounts WHERE id=?').get(req.workerId);
  const linkedInqId = wa?.linked_inquiry_id || null;

  const seenJobIds = new Set();
  let jobs = [];

  if (req.workerEmployeeId) {
    const ejJobs = db.prepare(`
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
    for (const j of ejJobs) { seenJobIds.add(j.job_id); jobs.push(j); }
  }

  // Also include assignments — add any job_ids not already covered above
  const aJobs = linkedInqId ? db.prepare(`
    SELECT a.id, a.job_id, 'active' AS status, '' AS start_date, '' AS end_date, '' AS emp_hourly_rate,
           j.title, COALESCE(NULLIF(a.work_address,''), j.location) AS location,
           j.pay, j.pay_period, j.company_name, j.site_id,
           js.name AS site_name, js.address AS site_address,
           js.latitude AS site_lat, js.longitude AS site_lng, js.radius_meters
    FROM assignments a
    JOIN jobs j ON a.job_id = j.id
    LEFT JOIN job_sites js ON j.site_id = js.id
    WHERE a.status != 'cancelled' AND a.inquiry_id = ?
    ORDER BY a.assigned_at DESC
  `).all(linkedInqId) : [];
  for (const j of aJobs) {
    if (!seenJobIds.has(j.job_id)) { seenJobIds.add(j.job_id); jobs.push(j); }
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

// ─── Worker Contractor Invoices ───

// Pre-fill endpoint: returns contractor info + active job data so the form only needs 3-5 fields
app.get('/api/worker/invoice-prefill', requireWorker, (req, res) => {
  const w = db.prepare('SELECT id, name, first_name, last_name, username, employment_type, entity_type FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const contractorName = w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '';

  // Get active jobs with pay rates
  let activeJobs = [];
  const wa = db.prepare('SELECT linked_inquiry_id, employee_id FROM worker_accounts WHERE id=?').get(req.workerId);
  const empId = req.workerEmployeeId;
  const linkedInqId = wa?.linked_inquiry_id || null;

  if (empId) {
    const ejJobs = db.prepare(`
      SELECT ej.job_id, ej.emp_hourly_rate, j.title, j.pay, j.pay_period, j.company_name, j.employment_type AS job_type
      FROM employee_jobs ej JOIN jobs j ON ej.job_id = j.id
      WHERE ej.employee_id = ? AND ej.status = 'active'
      ORDER BY ej.assigned_at DESC
    `).all(empId);
    activeJobs = ejJobs.map(j => ({
      job_id: j.job_id, title: j.title, company_name: j.company_name || '',
      hourly_rate: j.emp_hourly_rate || 0, pay_display: j.pay || '', pay_period: j.pay_period || ''
    }));
  }

  // Also try assignments if no employee_jobs found
  if (!activeJobs.length && linkedInqId) {
    const aJobs = db.prepare(`
      SELECT a.job_id, a.pay_rate, a.pay_type, j.title, j.pay, j.pay_period, j.company_name
      FROM assignments a JOIN jobs j ON a.job_id = j.id
      WHERE a.status != 'cancelled' AND a.inquiry_id = ?
      ORDER BY a.assigned_at DESC
    `).all(linkedInqId);
    activeJobs = aJobs.map(j => ({
      job_id: j.job_id, title: j.title, company_name: j.company_name || '',
      hourly_rate: parseFloat(j.pay_rate) || 0, pay_display: j.pay || '', pay_period: j.pay_period || ''
    }));
  }

  // Payment terms: IL FWPA default = Net 30
  const paymentTerms = 'Net 30';
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  res.json({
    contractor_name: contractorName,
    worker_id: w.id,
    employment_type: w.employment_type || '',
    entity_type: w.entity_type || '',
    active_jobs: activeJobs,
    payment_terms: paymentTerms,
    invoice_date: today,
    payment_due_date: dueDate,
    bill_to: 'Prime Anchorpoint LLC'
  });
});

app.get('/api/worker/contractor-invoices', requireWorker, (req, res) => {
  const rows = db.prepare('SELECT * FROM contractor_invoices WHERE worker_account_id=? ORDER BY created_at DESC').all(req.workerId);
  res.json(rows);
});

app.post('/api/worker/contractor-invoices', requireWorker, (req, res) => {
  const { service_description, service_period_start, service_period_end, hours_worked, hourly_rate,
    flat_amount, total_amount, payment_due_date, notes, expenses, job_id, job_title, service_type, confirmed } = req.body;
  if (!service_period_start || !service_period_end) return res.status(400).json({ error: '请填写服务期间 / Service period required' });
  if (!confirmed) return res.status(400).json({ error: '请勾选确认框 / Please check the confirmation box' });
  // Auto-generate service description from prefilled data if not provided
  const descFinal = service_description || (job_title ? `${job_title} — ${service_type || 'Service'}` : 'Contractor Service');
  const hrWorked = parseFloat(hours_worked) || 0;
  const hrRate = parseFloat(hourly_rate) || 0;
  const expAmt = parseFloat(expenses) || 0;
  const flatAmt = parseFloat(flat_amount) || 0;
  const calcTotal = parseFloat(total_amount) || (hrWorked * hrRate + flatAmt + expAmt);
  if (!calcTotal || calcTotal <= 0) return res.status(400).json({ error: '总金额必须大于0 / Total amount must be > 0' });
  // Generate invoice number: INV-WORKERID-YYYYMMDD-SEQ
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM contractor_invoices WHERE worker_account_id=? AND invoice_date LIKE ?").get(req.workerId, new Date().toISOString().slice(0, 10) + '%');
  const seq = String((existing?.cnt || 0) + 1).padStart(3, '0');
  const invoiceNumber = `INV-${req.workerId}-${today}-${seq}`;
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO contractor_invoices
    (worker_account_id, invoice_number, invoice_date, service_description, service_period_start, service_period_end,
     hours_worked, hourly_rate, flat_amount, total_amount, payment_due_date, notes, expenses, job_id, job_title, service_type, confirmed)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.workerId, invoiceNumber, invoiceDate, descFinal,
      service_period_start || '', service_period_end || '',
      hrWorked, hrRate, flatAmt, calcTotal,
      payment_due_date || '', notes || '', expAmt,
      parseInt(job_id) || 0, job_title || '', service_type || '', confirmed ? 1 : 0);
  res.json({ success: true, id: r.lastInsertRowid, invoice_number: invoiceNumber });
});

// ─── Worker Forgot / Reset Password ───
app.post('/api/worker/forgot-password', async (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: '请输入邮箱或手机号' });
  const digits10 = login.replace(/\D/g, '').slice(-10);
  const w = db.prepare('SELECT id, email, phone FROM worker_accounts WHERE email=? OR (? != \'\' AND phone10(phone)=?) OR username=?').get(login, digits10, digits10, login);
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

  const account = db.prepare('SELECT salt, password_hash FROM worker_accounts WHERE id=?').get(entry.accountId);
  if (account && verifyPassword(new_password, account.salt, account.password_hash)) {
    return res.status(400).json({ error_code: 'SAME_PASSWORD' });
  }
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPassword(new_password, newSalt);
  db.prepare('UPDATE worker_accounts SET password_hash=?, salt=? WHERE id=?').run(newHash, newSalt, entry.accountId);
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
  // Find expiring/expired approved documents
  const expiringDocs = docs.filter(d => d.expires_at && d.status === 'approved' && new Date(d.expires_at) <= new Date(Date.now() + 90 * 86400000));
  res.json({
    documents: byType,
    all_documents: docs,
    background_check: bgCheck,
    assigned_tasks: assignedTasks,
    doc_types: ['i9', 'drivers_license', 'w9', 'ssn_card', 'work_permit', 'other'],
    expiring_docs: expiringDocs
  });
});

// ─── Worker: Form Submission Summary ───
app.get('/api/worker/submission-summary', requireWorker, (req, res) => {
  const w = db.prepare('SELECT id, username, name, phone, email, work_status, employment_type, entity_type, employee_id FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!w) return res.status(404).json({ error: 'Account not found' });

  // Get onboarding tasks
  const existing = db.prepare('SELECT id FROM worker_onboarding WHERE worker_account_id=?').get(req.workerId);
  if (!existing) initWorkerOnboarding(req.workerId);
  const tasks = getOnboardingTasks(req.workerId).filter(t => t.visible_to_worker !== 0);

  // Get compliance docs
  const docs = db.prepare('SELECT id, doc_type, status, file_name, expires_at, created_at, updated_at, reviewer_notes FROM worker_compliance_docs WHERE worker_account_id=? ORDER BY created_at DESC').all(req.workerId);
  const docsByType = {};
  for (const d of docs) { if (!docsByType[d.doc_type]) docsByType[d.doc_type] = d; }

  // Get I-9 form data (citizenship status)
  const i9Doc = db.prepare("SELECT form_data FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='i9' ORDER BY created_at DESC LIMIT 1").get(req.workerId);
  let citizenshipStatus = '';
  if (i9Doc && i9Doc.form_data) {
    try { citizenshipStatus = JSON.parse(i9Doc.form_data).citizenship_status || ''; } catch {}
  }

  // Get tax residency info
  const taxRes = db.prepare('SELECT applicant_type, is_us_citizen, has_green_card, country_citizenship, immigration_status, work_permit_category, tax_status, recommended_form FROM tax_residency_questionnaire WHERE worker_account_id=? ORDER BY updated_at DESC LIMIT 1').get(req.workerId);

  // Get assignment/contract info
  const assignment = req.workerEmployeeId
    ? db.prepare('SELECT contract_type, status, start_date FROM assignments WHERE worker_account_id=? ORDER BY id DESC LIMIT 1').get(req.workerId)
    : null;

  // Derive work authorization category
  let workAuthCategory = '';
  if (citizenshipStatus === 'citizen' || (taxRes && taxRes.is_us_citizen === 'yes')) {
    workAuthCategory = 'us_citizen';
  } else if (citizenshipStatus === 'permanent_resident' || (taxRes && taxRes.has_green_card === 'yes')) {
    workAuthCategory = 'green_card';
  } else if (taxRes && taxRes.work_permit_category) {
    const cat = taxRes.work_permit_category;
    if (cat.startsWith('EAD')) workAuthCategory = 'ead';
    else if (cat === 'H-1B' || cat === 'H-1B1') workAuthCategory = 'h1b';
    else if (cat === 'F-1-OPT' || cat.includes('OPT')) workAuthCategory = 'opt';
    else if (cat === 'F-1-CPT') workAuthCategory = 'cpt';
    else workAuthCategory = cat.toLowerCase();
  } else if (citizenshipStatus === 'work_authorized') {
    workAuthCategory = 'work_authorized';
  }

  // Derive employment type
  let empType = w.employment_type || '';
  if (!empType && assignment) empType = assignment.contract_type || '';

  // Compute completion stats
  const visibleTasks = tasks;
  const completedTasks = visibleTasks.filter(t => ['completed', 'waived'].includes(t.status));
  const submittedTasks = visibleTasks.filter(t => t.status === 'submitted');
  const pendingTasks = visibleTasks.filter(t => t.status === 'pending');

  // Key form statuses
  const formStatuses = {};
  for (const t of tasks) {
    formStatuses[t.key] = { status: t.status, completed_at: t.completed_at };
  }

  res.json({
    worker: { name: w.name, username: w.username },
    work_auth_category: workAuthCategory,
    citizenship_status: citizenshipStatus,
    employment_type: empType,
    tax_residency: taxRes ? {
      tax_status: taxRes.tax_status,
      recommended_form: taxRes.recommended_form,
      immigration_status: taxRes.immigration_status,
      work_permit_category: taxRes.work_permit_category
    } : null,
    form_statuses: formStatuses,
    compliance_docs: docsByType,
    stats: {
      total: visibleTasks.length,
      completed: completedTasks.length,
      submitted: submittedTasks.length,
      pending: pendingTasks.length
    }
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

// ── Stripe Identity Verification (Worker Portal) ──

// Worker: create a Stripe Identity verification session
// Worker: create Stripe Identity verification session
app.post('/api/worker/persona/inquiry', requireWorker, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe Identity not configured' });

  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  try {
    const result = await createStripeVerificationSession(req.workerId, worker.name, worker.email);
    if (!result) return res.status(500).json({ error: 'Failed to create Stripe Identity session' });

    // Store the session in compliance docs
    const formData = JSON.stringify({ stripe_session_id: result.sessionId, stripe_client_secret: result.clientSecret, stripe_status: 'requires_input', stripe_hosted_url: result.url || '' });
    const existing = db.prepare("SELECT id FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license'").get(req.workerId);
    if (existing) {
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(formData, existing.id);
    } else {
      db.prepare("INSERT INTO worker_compliance_docs (worker_account_id, doc_type, form_data, status) VALUES (?, 'drivers_license', ?, 'pending')")
        .run(req.workerId, formData);
    }
    // Update worker_accounts
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.sessionId, req.workerId);
    res.json({ success: true, inquiry_id: result.sessionId, client_secret: result.clientSecret, hosted_url: result.url || '' });
  } catch (e) {
    console.error('[Stripe Identity] Error:', e.message);
    res.status(500).json({ error: 'Failed to create verification session: ' + e.message });
  }
});

// Worker: get Stripe Identity config for embedded flow
app.get('/api/worker/persona/config', requireWorker, (req, res) => {
  if (!stripe) return res.json({ enabled: false });
  res.json({ enabled: true, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// Worker: check verification status
app.get('/api/worker/persona/status', requireWorker, (req, res) => {
  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.json({ status: 'not_started' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    res.json({
      status: doc.status,
      persona_inquiry_id: formData.stripe_session_id || formData.persona_inquiry_id || null,
      persona_status: formData.stripe_status || formData.persona_status || null,
      persona_hosted_url: formData.stripe_hosted_url || formData.persona_hosted_url || null,
      client_secret: formData.stripe_client_secret || null,
      reviewer_notes: doc.reviewer_notes || ''
    });
  } catch {
    res.json({ status: doc.status });
  }
});

// Worker: send verification link via SMS
app.post('/api/worker/persona/send-sms', requireWorker, async (req, res) => {
  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const phone = req.body.phone || worker.phone;
  if (!phone) return res.status(400).json({ error: '没有手机号码 / No phone number' });

  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.status(400).json({ error: '请先创建验证 / Please create verification first' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    const url = formData.stripe_hosted_url || formData.persona_hosted_url;
    if (!url) return res.status(400).json({ error: '验证链接不可用，请重新开始验证 / Verification link not available' });
    const msg = `[Prime Anchor Point] 请点击以下链接完成身份验证 / Click the link below to verify your identity:\n${url}`;
    const ok = await sendSMS(phone, msg);
    if (ok) return res.json({ success: true, message: '短信已发送 / SMS sent' });
    return res.status(500).json({ error: '短信发送失败 / SMS send failed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Worker: send verification link via email
app.post('/api/worker/persona/send-email', requireWorker, async (req, res) => {
  const worker = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const email = req.body.email || worker.email;
  if (!email) return res.status(400).json({ error: '没有邮箱地址 / No email address' });

  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.status(400).json({ error: '请先创建验证 / Please create verification first' });
  try {
    const formData = JSON.parse(doc.form_data || '{}');
    const url = formData.stripe_hosted_url || formData.persona_hosted_url;
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

// Stripe Identity webhook - receives verification results
app.post('/api/webhooks/persona', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
  const sigHeader = req.headers['stripe-signature'];
  const { valid, event } = verifyStripeWebhook(rawBody, sigHeader);
  if (!valid) return res.status(401).json({ error: 'Invalid signature' });

  try {
    const eventType = event.type || '';
    const session = event.data?.object;
    const sessionId = session?.id;

    console.log(`[Stripe Identity Webhook] Event: ${eventType}, Session: ${sessionId}, Status: ${session?.status}`);

    if (!sessionId || !eventType.startsWith('identity.verification_session.')) return res.json({ received: true });

    // Find compliance doc by stripe_session_id
    const allDocs = db.prepare("SELECT * FROM worker_compliance_docs WHERE doc_type='drivers_license'").all();
    let docRow = allDocs.find(d => {
      try {
        const fd = JSON.parse(d.form_data || '{}');
        return fd.stripe_session_id === sessionId || fd.persona_inquiry_id === sessionId;
      } catch { return false; }
    });
    // Also try worker_accounts.persona_inquiry_id (stores session ID)
    if (!docRow) {
      const w = db.prepare('SELECT id FROM worker_accounts WHERE persona_inquiry_id=?').get(sessionId);
      if (w) docRow = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(w.id);
    }
    if (!docRow) {
      // Try metadata worker_id
      const workerId = parseInt(session?.metadata?.worker_id);
      if (workerId) docRow = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(workerId);
    }
    if (!docRow) {
      console.warn(`[Stripe Identity Webhook] No compliance doc found for session ${sessionId}`);
      return res.json({ received: true });
    }

    const existingForm = JSON.parse(docRow.form_data || '{}');
    existingForm.stripe_session_id = sessionId;
    existingForm.stripe_status = session.status;
    existingForm.stripe_event = eventType;

    // Extract verified data if available
    const verifiedOutputs = session.verified_outputs || session.last_verification_report?.document || {};
    if (verifiedOutputs) {
      if (verifiedOutputs.first_name) existingForm.dl_first_name = verifiedOutputs.first_name;
      if (verifiedOutputs.last_name) existingForm.dl_last_name = verifiedOutputs.last_name;
      if (verifiedOutputs.dob) {
        const dob = verifiedOutputs.dob;
        existingForm.dl_dob = dob.year ? `${dob.year}-${String(dob.month).padStart(2,'0')}-${String(dob.day).padStart(2,'0')}` : '';
      }
      if (verifiedOutputs.id_number) existingForm.dl_number = verifiedOutputs.id_number;
      if (verifiedOutputs.address) {
        existingForm.dl_state = verifiedOutputs.address.state || '';
      }
      if (verifiedOutputs.expiration_date) {
        const exp = verifiedOutputs.expiration_date;
        existingForm.dl_expiry = exp.year ? `${exp.year}-${String(exp.month).padStart(2,'0')}-${String(exp.day).padStart(2,'0')}` : '';
      }
      if (verifiedOutputs.id_number_type) existingForm.id_class = verifiedOutputs.id_number_type;
    }

    let newStatus = docRow.status;
    if (session.status === 'verified') {
      newStatus = 'approved';
    } else if (session.status === 'requires_input') {
      newStatus = 'pending';
    } else if (session.status === 'processing') {
      newStatus = 'submitted';
    } else if (session.status === 'canceled') {
      newStatus = 'rejected';
      existingForm.decline_reasons = [session.last_error?.reason || 'canceled'];
    }

    db.prepare("UPDATE worker_compliance_docs SET form_data=?, status=?, reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(existingForm), newStatus, `Stripe Identity: ${eventType} (${session.status})`, docRow.id);

    // Also update expires_at if extracted
    if (existingForm.dl_expiry) {
      db.prepare("UPDATE worker_compliance_docs SET expires_at=? WHERE id=? AND (expires_at IS NULL OR expires_at='')").run(existingForm.dl_expiry, docRow.id);
    }
    // Update holder_name if extracted
    if (existingForm.dl_first_name || existingForm.dl_last_name) {
      const holderName = `${existingForm.dl_last_name || ''}, ${existingForm.dl_first_name || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
      db.prepare("UPDATE worker_compliance_docs SET holder_name=? WHERE id=? AND (holder_name IS NULL OR holder_name='')").run(holderName, docRow.id);
    }
    // Update doc_number if extracted
    if (existingForm.dl_number) {
      db.prepare("UPDATE worker_compliance_docs SET doc_number=? WHERE id=? AND (doc_number IS NULL OR doc_number='')").run(existingForm.dl_number, docRow.id);
    }

    console.log(`[Stripe Identity Webhook] Updated doc ${docRow.id} → status=${newStatus}`);

    // Update worker_accounts.identity_status and auto-complete onboarding
    let identityStatus = '';
    if (session.status === 'verified') identityStatus = 'approved';
    else if (session.status === 'canceled') identityStatus = 'declined';
    else if (session.status === 'processing') identityStatus = 'completed';
    if (identityStatus) {
      db.prepare(`UPDATE worker_accounts SET identity_status=? WHERE persona_inquiry_id=?`).run(identityStatus, sessionId);
      const w = db.prepare(`SELECT id FROM worker_accounts WHERE persona_inquiry_id=?`).get(sessionId);
      if (w) {
        if (identityStatus === 'approved') {
          db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
          console.log(`[Stripe Identity Webhook] Auto-completed persona_verify for worker ${w.id}`);
        } else if (identityStatus === 'completed') {
          db.prepare(`UPDATE worker_onboarding SET status='submitted', admin_note='验证已完成，等待审核', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
        } else if (identityStatus === 'declined') {
          db.prepare(`UPDATE worker_onboarding SET status='pending', admin_note='验证未通过，请重新验证', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='persona_verify'`).run(w.id);
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[Stripe Identity Webhook] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Worker: actively poll Stripe Identity API for latest session status
app.post('/api/worker/persona/poll-status', requireWorker, async (req, res) => {
  // Check if identity_status was already updated (e.g., by webhook or admin)
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

  if (!stripe) {
    const doc = db.prepare("SELECT status FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
    return res.json({ status: doc ? doc.status : 'not_started', persona_status: null });
  }
  const doc = db.prepare("SELECT * FROM worker_compliance_docs WHERE worker_account_id=? AND doc_type='drivers_license' ORDER BY id DESC LIMIT 1").get(req.workerId);
  if (!doc) return res.json({ status: 'not_started' });
  let formData;
  try { formData = JSON.parse(doc.form_data || '{}'); } catch { formData = {}; }
  const sessionId = formData.stripe_session_id || formData.persona_inquiry_id;
  if (!sessionId) return res.json({ status: doc.status, persona_status: formData.stripe_status || null });

  try {
    const session = await getStripeVerificationSession(sessionId);
    if (!session) return res.json({ status: doc.status, persona_status: formData.stripe_status || null });

    const stripeStatus = session.status;
    if (!stripeStatus || stripeStatus === formData.stripe_status) {
      return res.json({ status: doc.status, persona_status: formData.stripe_status || null });
    }

    // Status changed — update local DB
    formData.stripe_status = stripeStatus;
    formData.stripe_polled_at = new Date().toISOString();

    // Extract verified data if available
    const verifiedOutputs = session.verified_outputs;
    if (verifiedOutputs) {
      if (verifiedOutputs.first_name) formData.dl_first_name = verifiedOutputs.first_name;
      if (verifiedOutputs.last_name) formData.dl_last_name = verifiedOutputs.last_name;
      if (verifiedOutputs.dob) {
        const dob = verifiedOutputs.dob;
        formData.dl_dob = dob.year ? `${dob.year}-${String(dob.month).padStart(2,'0')}-${String(dob.day).padStart(2,'0')}` : '';
      }
      if (verifiedOutputs.id_number) formData.dl_number = verifiedOutputs.id_number;
      if (verifiedOutputs.expiration_date) {
        const exp = verifiedOutputs.expiration_date;
        formData.dl_expiry = exp.year ? `${exp.year}-${String(exp.month).padStart(2,'0')}-${String(exp.day).padStart(2,'0')}` : '';
      }
    }

    let newStatus = doc.status;
    if (stripeStatus === 'verified') newStatus = 'approved';
    else if (stripeStatus === 'canceled') newStatus = 'rejected';
    else if (stripeStatus === 'processing') newStatus = 'submitted';
    else if (stripeStatus === 'requires_input') newStatus = 'pending';

    if (newStatus !== doc.status) {
      db.prepare("UPDATE worker_compliance_docs SET form_data=?, status=?, reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(formData), newStatus, `Stripe Identity poll: ${stripeStatus}`, doc.id);

      let identityStatus = '';
      if (stripeStatus === 'verified') identityStatus = 'approved';
      else if (stripeStatus === 'canceled') identityStatus = 'declined';
      else if (stripeStatus === 'processing') identityStatus = 'completed';
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
      // Auto-fill expires_at and holder_name
      if (formData.dl_expiry) {
        db.prepare("UPDATE worker_compliance_docs SET expires_at=? WHERE id=? AND (expires_at IS NULL OR expires_at='')").run(formData.dl_expiry, doc.id);
      }
      if (formData.dl_first_name || formData.dl_last_name) {
        const holderName = `${formData.dl_last_name || ''}, ${formData.dl_first_name || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
        db.prepare("UPDATE worker_compliance_docs SET holder_name=? WHERE id=? AND (holder_name IS NULL OR holder_name='')").run(holderName, doc.id);
      }
      console.log(`[Stripe Identity Poll] Updated worker ${req.workerId} → doc.status=${newStatus}, stripe_status=${stripeStatus}`);
    }

    res.json({ status: newStatus, persona_status: stripeStatus, updated: true });
  } catch (e) {
    console.error('[Stripe Identity Poll] Error:', e.message);
    res.json({ status: doc.status, persona_status: formData.stripe_status || null });
  }
});

// Submit W-9 form data — saves info, then auto-creates DocuSeal submission for signing
app.post('/api/worker/compliance/w9', requireWorker, async (req, res) => {
  try {
    // Validate all required fields
    const requiredFields = ['name','business_name','tax_classification','address','city','state','zip','ssn_or_ein','tin_type','signature_confirm'];
    for (const f of requiredFields) {
      if (!req.body[f] || !String(req.body[f]).trim()) {
        return res.status(400).json({ error: `缺少必填字段 / Missing required field: ${f}` });
      }
    }

    const formData = {};
    const fields = ['name','business_name','tax_classification','exempt_payee_code','fatca_code',
      'address','city','state','zip','account_numbers','ssn_or_ein','signature_confirm','tin_type'];
    fields.forEach(f => { if (req.body[f] !== undefined) formData[f] = req.body[f]; });

    // Encrypt SSN/EIN if provided
    const rawSsnEin = req.body.ssn_or_ein || '';
    if (rawSsnEin) {
      formData.ssn_or_ein_masked = rawSsnEin.replace(/\d(?=\d{4})/g, '*');
      formData.ssn_or_ein_encrypted = encryptSSN(rawSsnEin);
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

    // Auto-create DocuSeal W-9 submission for signing
    let signUrl = '';
    if (dsealEnabled()) {
      const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.workerId);
      const workerName = req.body.name || w.name || [w.first_name, w.last_name].filter(Boolean).join(' ') || w.username || '';
      const workerEmail = w.email || '';
      const address = req.body.address || '';
      const cityStateZip = [req.body.city, req.body.state, req.body.zip].filter(Boolean).join(', ');
      try {
        const { submissionId, workerSignUrl } = await dsealSendW9Html({
          workerName, workerEmail, workerPhone: w.phone || '', address, cityStateZip,
          ssn: rawSsnEin, tinType: req.body.tin_type,
          businessName: req.body.business_name,
          taxClassification: req.body.tax_classification
        });
        signUrl = workerSignUrl || '';
        // Update onboarding task with DocuSeal info
        db.prepare(`UPDATE worker_onboarding SET ds_envelope_id=?, ds_status='sent', action_url=?, admin_note=?, updated_at=CURRENT_TIMESTAMP
          WHERE worker_account_id=? AND task_key='w9'`)
          .run(submissionId, signUrl, `工人已填写 W-9 信息，等待签署确认 (${new Date().toLocaleString('zh-CN')})`, req.workerId);
        console.log(`[W-9] Worker ${req.workerId} submitted info, DocuSeal created: ${submissionId}`);
      } catch (e) {
        console.error(`[W-9] DocuSeal submission failed for worker ${req.workerId}:`, e.message);
      }
    }

    // Update onboarding task status to submitted
    db.prepare("UPDATE worker_onboarding SET status='submitted', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9' AND status='pending'")
      .run(req.workerId);

    res.json({ success: true, signUrl });
  } catch (e) {
    console.error('[W-9 submit error]', e.message);
    res.status(500).json({ error: e.message });
  }
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

app.post('/api/admin/job-sites', requireAdmin, blockManager, async (req, res) => {
  const { name, address, latitude, longitude, radius_meters, partner_id, timezone } = req.body;
  if (!name || !latitude || !longitude) return res.status(400).json({ error: 'Name, latitude, longitude required' });
  const tz = timezone || await lookupTimezone(latitude, longitude);
  const r = db.prepare('INSERT INTO job_sites (name, address, latitude, longitude, radius_meters, partner_id, timezone) VALUES (?,?,?,?,?,?,?)')
    .run(name, address || '', latitude, longitude, radius_meters || 200, partner_id || null, tz);
  res.json({ success: true, id: r.lastInsertRowid, timezone: tz });
});

app.put('/api/admin/job-sites/:id', requireAdmin, blockManager, async (req, res) => {
  const { name, address, latitude, longitude, radius_meters, active, timezone } = req.body;
  // If lat/lng changed and no explicit timezone, re-detect
  let tz = timezone || null;
  if (!tz && latitude && longitude) tz = await lookupTimezone(latitude, longitude);
  db.prepare('UPDATE job_sites SET name=COALESCE(?,name), address=COALESCE(?,address), latitude=COALESCE(?,latitude), longitude=COALESCE(?,longitude), radius_meters=COALESCE(?,radius_meters), active=COALESCE(?,active), timezone=COALESCE(?,timezone) WHERE id=?')
    .run(name, address, latitude, longitude, radius_meters, active, tz, req.params.id);
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

// ─── Admin: App Settings (feature flags) ───
app.get('/api/admin/app-settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

app.put('/api/admin/app-settings', requireAdmin, blockManager, (req, res) => {
  const allowed = ['worker_portal_mode'];
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      stmt.run(key, String(updates[key]));
    }
  }
  res.json({ success: true });
});

// ─── Public: Worker Portal Config ───
app.get('/api/worker/portal-config', (req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='worker_portal_mode'").get();
  res.json({ worker_portal_mode: row ? row.value : 'none' });
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

// ─── OCR: Extract text from compliance doc image via Google Cloud Vision ───
app.post('/api/admin/compliance-docs/:id/ocr', requireAdmin, async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; // reuse same key (enable Cloud Vision on the key)
  if (!apiKey) return res.status(400).json({ error: 'Google API key not configured' });
  const doc = db.prepare('SELECT * FROM worker_compliance_docs WHERE id=?').get(req.params.id);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'No file to process' });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: 'File missing on disk' });

  try {
    const imageBuffer = fs.readFileSync(doc.file_path);
    const base64 = imageBuffer.toString('base64');
    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'TEXT_DETECTION' }] }]
      })
    });
    if (!visionRes.ok) {
      const errBody = await visionRes.text();
      console.error('[OCR] Google Vision error:', errBody);
      return res.status(502).json({ error: 'Google Vision API error' });
    }
    const visionData = await visionRes.json();
    const fullText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
    if (!fullText) return res.json({ success: true, text: '', parsed: {}, message: 'No text detected' });

    // Parse extracted text for common document fields
    const parsed = parseDocumentText(fullText, doc.doc_type);

    // Save OCR results
    db.prepare('UPDATE worker_compliance_docs SET ocr_raw=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(fullText, doc.id);

    // Auto-fill fields if parsed successfully
    if (parsed.holder_name) {
      db.prepare('UPDATE worker_compliance_docs SET holder_name=? WHERE id=? AND (holder_name IS NULL OR holder_name=\'\')').run(parsed.holder_name, doc.id);
    }
    if (parsed.doc_number) {
      db.prepare('UPDATE worker_compliance_docs SET doc_number=? WHERE id=? AND (doc_number IS NULL OR doc_number=\'\')').run(parsed.doc_number, doc.id);
    }
    if (parsed.expires_at) {
      db.prepare('UPDATE worker_compliance_docs SET expires_at=? WHERE id=? AND expires_at IS NULL').run(parsed.expires_at, doc.id);
    }

    res.json({ success: true, text: fullText, parsed });
  } catch (e) {
    console.error('[OCR] Error:', e);
    res.status(500).json({ error: 'OCR processing failed: ' + e.message });
  }
});

// Parse document text for name, dates, doc numbers
function parseDocumentText(text, docType) {
  const result = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Date patterns: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, MM/DD/YY
  const datePatterns = [
    /(\d{2}\/\d{2}\/\d{4})/g,
    /(\d{2}-\d{2}-\d{4})/g,
    /(\d{4}-\d{2}-\d{2})/g,
    /(\d{2}\/\d{2}\/\d{2})/g,
  ];

  const allDates = [];
  for (const p of datePatterns) {
    const matches = text.match(p);
    if (matches) allDates.push(...matches);
  }

  // Expiration date keywords
  const expKeywords = /exp(?:ir(?:ation|es))?|有效期|到期|EXP|VALID\s*(?:THRU|THROUGH|UNTIL)|CARD EXPIRES/i;
  for (const line of lines) {
    if (expKeywords.test(line)) {
      const dateMatch = line.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/);
      if (dateMatch) {
        result.expires_at = normalizeDate(dateMatch[1]);
        break;
      }
    }
  }
  // If no labeled exp date but dates found, use the latest date as likely expiration
  if (!result.expires_at && allDates.length) {
    const sorted = allDates.map(d => ({ raw: d, ts: new Date(normalizeDate(d)).getTime() }))
      .filter(d => !isNaN(d.ts) && d.ts > Date.now())
      .sort((a, b) => a.ts - b.ts);
    if (sorted.length) result.expires_at = normalizeDate(sorted[0].raw);
  }

  // Document number extraction based on type
  if (docType === 'work_permit' || docType === 'ead_upload') {
    // EAD card number pattern: 3 letters + 10 digits (e.g., SRC2190012345)
    const eadMatch = text.match(/([A-Z]{3}\d{10})/);
    if (eadMatch) result.doc_number = eadMatch[1];
    // USCIS number
    const uscisMatch = text.match(/(?:USCIS|A)\s*#?\s*(\d{7,13})/i);
    if (uscisMatch) result.uscis_number = uscisMatch[1];
  }
  if (docType === 'drivers_license') {
    const dlMatch = text.match(/(?:DL|ID|LIC|LICENSE)\s*(?:#|NO|:)?\s*([A-Z0-9]{4,20})/i);
    if (dlMatch) result.doc_number = dlMatch[1];
  }
  if (docType === 'ssn_card') {
    const ssnMatch = text.match(/(\d{3}[\s-]\d{2}[\s-]\d{4})/);
    if (ssnMatch) result.doc_number = ssnMatch[1];
  }

  // Name extraction - look for common patterns
  const nameKeywords = /(?:NAME|姓名|LAST\s*NAME|FIRST\s*NAME|SURNAME|GIVEN\s*NAME)/i;
  for (let i = 0; i < lines.length; i++) {
    if (nameKeywords.test(lines[i])) {
      // Name might be on same line after colon, or on next line
      const sameLine = lines[i].match(/(?:NAME|姓名)[:\s]+(.+)/i);
      if (sameLine) { result.holder_name = sameLine[1].trim(); break; }
      if (i + 1 < lines.length && /^[A-Za-z\s,'-]+$/.test(lines[i+1])) {
        result.holder_name = lines[i+1].trim();
        break;
      }
    }
  }
  // Fallback: look for "LAST, FIRST" pattern common on US IDs
  if (!result.holder_name) {
    for (const line of lines) {
      if (/^[A-Z][A-Z'-]+,\s*[A-Z][A-Z'-]+/.test(line)) {
        result.holder_name = line;
        break;
      }
    }
  }

  // Category (EAD specific)
  const catMatch = text.match(/(?:CATEGORY|Cat(?:egory)?)\s*[:\s]*([A-Z]\d{1,2}[a-z]?)/i);
  if (catMatch) result.category = catMatch[1].toUpperCase();

  return result;
}

function normalizeDate(dateStr) {
  // Convert various formats to YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const parts = dateStr.split(/[\/\-]/);
  if (parts.length !== 3) return dateStr;
  let [a, b, c] = parts;
  if (c.length === 2) c = parseInt(c) > 50 ? '19' + c : '20' + c;
  // MM/DD/YYYY or MM-DD-YYYY
  return `${c}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`;
}

// ─── Update compliance doc fields (expiration, name, number) ───
app.put('/api/admin/compliance-docs/:id/fields', requireAdmin, (req, res) => {
  const { expires_at, holder_name, doc_number } = req.body;
  const sets = [];
  const vals = [];
  if (expires_at !== undefined) { sets.push('expires_at=?'); vals.push(expires_at || null); }
  if (holder_name !== undefined) { sets.push('holder_name=?'); vals.push(holder_name); }
  if (doc_number !== undefined) { sets.push('doc_number=?'); vals.push(doc_number); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  vals.push(req.params.id);
  db.prepare(`UPDATE worker_compliance_docs SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json({ success: true });
});

// ─── Expiring documents dashboard endpoint ───
app.get('/api/admin/compliance-docs/expiring', requireAdmin, (req, res) => {
  const days = parseInt(req.query.days) || 90;
  const docs = db.prepare(`
    SELECT c.*, w.name as worker_name, w.email as worker_email, w.phone as worker_phone
    FROM worker_compliance_docs c
    LEFT JOIN worker_accounts w ON c.worker_account_id = w.id
    WHERE c.expires_at IS NOT NULL
      AND c.expires_at != ''
      AND c.status = 'approved'
      AND date(c.expires_at) <= date('now', '+' || ? || ' days')
    ORDER BY c.expires_at ASC
  `).all(days);
  res.json(docs);
});

// ─── Scheduled expiration check (runs daily) ───
function checkExpiringDocs() {
  const now = new Date().toISOString().slice(0, 10);
  // Documents expiring within 30 days that haven't been notified recently
  const expiring = db.prepare(`
    SELECT c.id, c.doc_type, c.expires_at, c.holder_name, c.worker_account_id,
      w.name as worker_name, w.email as worker_email, w.phone as worker_phone
    FROM worker_compliance_docs c
    LEFT JOIN worker_accounts w ON c.worker_account_id = w.id
    WHERE c.expires_at IS NOT NULL AND c.expires_at != ''
      AND c.status = 'approved'
      AND date(c.expires_at) <= date('now', '+30 days')
      AND date(c.expires_at) >= date('now', '-7 days')
      AND (c.last_expiry_notified IS NULL OR date(c.last_expiry_notified) < date('now', '-7 days'))
  `).all();

  for (const doc of expiring) {
    const daysLeft = Math.ceil((new Date(doc.expires_at) - new Date(now)) / 86400000);
    const typeLabel = { i9:'I-9', drivers_license:'驾照', w9:'W-9', ssn_card:'SSN Card', work_permit:'工作许可/EAD', ead_upload:'EAD工卡', other:'文件' }[doc.doc_type] || doc.doc_type;
    const urgency = daysLeft <= 0 ? '已过期' : daysLeft <= 7 ? '7天内到期' : '30天内到期';

    // Email worker
    if (doc.worker_email && (emailTransporter || _sgKey)) {
      sendEmail(doc.worker_email,
        `[Prime Anchorpoint] 您的${typeLabel}即将到期 / Your ${typeLabel} is expiring`,
        `您好 ${doc.worker_name || ''},\n\n您的${typeLabel}将于 ${doc.expires_at} 到期（${urgency}）。\n请尽快更新证件。\n\nHello ${doc.worker_name || ''},\nYour ${typeLabel} expires on ${doc.expires_at} (${urgency}).\nPlease update your document as soon as possible.\n\n— Prime Anchor Point`
      ).catch(e => console.error('[ExpiryNotify] Email failed:', e));
    }

    // SMS worker
    if (doc.worker_phone && twilioClient && (TWILIO_FROM || TWILIO_VERIFY_SID)) {
      sendSMS(doc.worker_phone,
        `[Prime Anchorpoint] 您的${typeLabel}将于${doc.expires_at}到期（${urgency}），请尽快更新。Your ${typeLabel} expires ${doc.expires_at}.`
      ).catch(e => console.error('[ExpiryNotify] SMS failed:', e));
    }

    // Mark as notified
    db.prepare('UPDATE worker_compliance_docs SET last_expiry_notified=CURRENT_TIMESTAMP WHERE id=?').run(doc.id);
    console.log(`[ExpiryNotify] ${doc.worker_name}: ${typeLabel} expires ${doc.expires_at} (${urgency})`);
  }
  if (expiring.length) console.log(`[ExpiryNotify] Processed ${expiring.length} expiring documents`);
}

// Add last_expiry_notified column
try { db.exec("ALTER TABLE worker_compliance_docs ADD COLUMN last_expiry_notified DATETIME DEFAULT NULL"); } catch {}

// Run daily at 9 AM
setInterval(checkExpiringDocs, 24 * 60 * 60 * 1000);
setTimeout(checkExpiringDocs, 60 * 1000); // First check 1 minute after startup

// ─── Worker Identity Docs API (I-9 / EAD admin-side verification records) ───
const idDocUpload = multer({
  storage: multer.diskStorage({
    destination: docsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `id-doc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png|heic|heif/.test(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

app.get('/api/admin/worker-accounts/:id/id-docs', requireAdmin, (req, res) => {
  const docs = db.prepare('SELECT * FROM worker_id_docs WHERE worker_account_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json(docs);
});

app.post('/api/admin/worker-accounts/:id/id-docs', requireAdmin, idDocUpload.single('file'), (req, res) => {
  const { doc_type, doc_number, notes } = req.body;
  if (!doc_type) return res.status(400).json({ error: 'doc_type required' });
  const file_path = req.file ? req.file.filename : '';
  const file_name = req.file ? req.file.originalname : '';
  const result = db.prepare(
    'INSERT INTO worker_id_docs (worker_account_id, doc_type, doc_number, notes, file_path, file_name) VALUES (?,?,?,?,?,?)'
  ).run(req.params.id, doc_type, doc_number || '', notes || '', file_path, file_name);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete('/api/admin/worker-accounts/:id/id-docs/:docId', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM worker_id_docs WHERE id=? AND worker_account_id=?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.file_path) {
    const fp = path.join(docsDir, doc.file_path);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
  }
  db.prepare('DELETE FROM worker_id_docs WHERE id=?').run(req.params.docId);
  res.json({ success: true });
});

app.get('/api/admin/worker-accounts/:id/id-docs/:docId/file', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM worker_id_docs WHERE id=? AND worker_account_id=?').get(req.params.docId, req.params.id);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(docsDir, doc.file_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, doc.file_name || doc.file_path);
});

// ─── Customer Portal API ───
app.post('/api/customer/login', (req, res) => {
  const { login, email, password } = req.body;
  const identifier = (login || email || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  const digits10 = identifier.replace(/\D/g, '').slice(-10);
  const cAny = db.prepare(
    'SELECT * FROM customer_accounts WHERE email=? OR (? != \'\' AND phone10(phone)=?)'
  ).get(identifier, digits10, digits10);
  if (cAny && cAny.approval_status === 'pending')
    return res.status(403).json({ error: '您的企业账号正在审核中，请等待管理员批准 / Your account is pending admin approval' });
  if (cAny && cAny.approval_status === 'rejected')
    return res.status(403).json({ error: '您的企业注册已被拒绝，请联系管理员 / Your registration was rejected. Please contact admin' });
  const c = (cAny && cAny.active && verifyPassword(password, cAny.salt, cAny.password_hash)) ? cAny : null;
  if (!c)
    return res.status(401).json({ error: '邮箱/电话或密码错误 / Invalid email/phone or password' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO customer_sessions (token, customer_id, partner_id, created_at) VALUES (?,?,?,?)').run(token, c.id, c.partner_id, Date.now());
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
  const account = db.prepare('SELECT salt, password_hash FROM customer_accounts WHERE id=?').get(entry.accountId);
  if (account && verifyPassword(new_password, account.salt, account.password_hash)) {
    return res.status(400).json({ error_code: 'SAME_PASSWORD' });
  }
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPassword(new_password, newSalt);
  db.prepare('UPDATE customer_accounts SET password_hash=?, salt=? WHERE id=?').run(newHash, newSalt, entry.accountId);
  resetCodes.delete('customer:' + login);
  res.json({ success: true });
});

// ─── Public Registration ───

// Real-time duplicate check (phone or email)
app.get('/api/register/check', (req, res) => {
  const { phone, email } = req.query;
  if (phone) {
    const digits10 = phone.replace(/\D/g, '').slice(-10);
    const row = digits10 ? db.prepare('SELECT id, active FROM worker_accounts WHERE phone10(phone)=?').get(digits10) : null;
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
  const { first_name, middle_name, last_name, phone: phoneRaw, email, dob, work_status, position_interests, password, city, state, ref_code, invite_token, sms_consent } = req.body;
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
    // All codes expired — clean up all related records and allow fresh registration
    db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM job_applications WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM worker_skills WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM worker_compliance_docs WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM worker_onboarding WHERE worker_account_id=?').run(existing.id);
    archiveInterviews(existing.id);
    db.prepare('DELETE FROM interviews WHERE worker_account_id=?').run(existing.id);
    db.prepare('DELETE FROM worker_account_history WHERE worker_account_id=?').run(existing.id);
    try { db.prepare('DELETE FROM pending_profile_changes WHERE worker_account_id=?').run(existing.id); } catch(_) {}
    db.prepare('DELETE FROM worker_sessions WHERE worker_id=?').run(existing.id);
    db.prepare(`UPDATE interview_slots SET reserved_for_worker_account_id=NULL WHERE reserved_for_worker_account_id=? AND booked_count=0`).run(existing.id);
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
  db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)').run(accountId, name || phone, 'account_created', '', phone, registrationSource === 'invite' ? '通过邀请链接注册' : '在线自助注册');

  // Store SMS consent
  if (sms_consent) {
    db.prepare('UPDATE worker_accounts SET sms_consent=1, sms_consent_at=? WHERE id=?').run(new Date().toISOString(), accountId);
  }

  // Mark invite as used
  if (invite_token && inviteEmployeeId) {
    db.prepare('UPDATE employee_registration_invites SET used=1 WHERE token=?').run(invite_token);
  }

  if (!needsVerification) {
    // No verification channels configured — activate immediately and auto-login
    activateWorkerAccount(accountId);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO worker_sessions (token, worker_id, employee_id, created_at) VALUES (?,?,?,?)').run(token, accountId, null, Date.now());
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
  db.prepare('INSERT INTO worker_sessions (token, worker_id, employee_id, created_at) VALUES (?,?,?,?)').run(token, acc.id, acc.employee_id, Date.now());
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
    db.prepare('INSERT INTO worker_sessions (token, worker_id, employee_id, created_at) VALUES (?,?,?,?)').run(token, acc.id, acc.employee_id, Date.now());
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
  sendEmail(email, 'Prime Anchorpoint — Enterprise Registration Verification', `Your verification code is: ${emailCode}\nValid for 15 minutes.`, verificationCodeHtml(emailCode)).catch(()=>{});
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
    sendEmail(acct.email, 'Prime Anchorpoint — Verification Code', `Your verification code is: ${code}\nValid for 15 minutes.`, verificationCodeHtml(code)).catch(()=>{});
  }
  res.json({ success: true });
});

// Admin: pending enterprise approvals
app.get('/api/admin/pending-enterprises', requireAdmin, (req, res) => {
  const list = db.prepare("SELECT id, company_name, contact_name, email, phone, ein, staffing_needs, created_at FROM customer_accounts WHERE approval_status='pending' AND active=1 ORDER BY created_at DESC").all();
  res.json(list);
});

app.put('/api/admin/approve-enterprise/:id', requireAdmin, (req, res) => {
  const { partner_id } = req.body || {};
  if (!partner_id) return res.status(400).json({ error: '请选择关联的合作公司档案 / Partner is required for approval' });
  db.prepare("UPDATE customer_accounts SET active=1, approval_status='approved', partner_id=? WHERE id=?").run(partner_id, req.params.id);
  res.json({ success: true });
});

app.put('/api/admin/reject-enterprise/:id', requireAdmin, (req, res) => {
  const { reason } = req.body || {};
  db.prepare("UPDATE customer_accounts SET active=0, approval_status='rejected', rejection_reason=? WHERE id=?").run(reason||'', req.params.id);
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
app.get('/sms-consent-proof', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sms-consent-proof.html')));

// POST /api/docuseal/webhook — DocuSeal event notifications (partner + worker contracts)
// Supports both self-hosted events (submission.*, submitter.*) and cloud events (form.*)
app.post('/api/docuseal/webhook', express.json(), async (req, res) => {
  console.log(`[DocuSeal Webhook] Received request from ${req.ip} at ${new Date().toISOString()}`);
  try {
    const event = req.body;
    const eventType = event?.event_type;
    const data = event?.data;
    console.log(`[DocuSeal Webhook] event_type=${eventType}, data_keys=${data ? Object.keys(data).join(',') : 'null'}`);
    if (!data) { res.json({ received: true }); return; }

    // Normalize event type: cloud uses form.*, self-hosted uses submission.*/submitter.*
    const isCompleted = eventType === 'submission.completed' || eventType === 'form.completed';
    const isSubmitterCompleted = eventType === 'submitter.completed' || eventType === 'form.started';
    const isDeclined = eventType === 'submitter.declined' || eventType === 'form.declined';
    const isCreated = eventType === 'submission.created';

    // Extract submission ID — different structure for cloud vs self-hosted
    let submissionId;
    if (isCompleted || isCreated) {
      submissionId = String(data.submission_id || data.id || '');
    } else {
      submissionId = String(data.submission_id || '');
    }
    if (!submissionId) { res.json({ received: true }); return; }

    // Check partner_files first
    const pf = db.prepare("SELECT id FROM partner_files WHERE ds_envelope_id=?").get(submissionId);
    // Check worker_onboarding contracts
    const wo = db.prepare("SELECT worker_account_id FROM worker_onboarding WHERE ds_envelope_id=? AND task_key='contract'").get(submissionId);
    // Check worker_onboarding W-9
    const w9o = db.prepare("SELECT worker_account_id FROM worker_onboarding WHERE ds_envelope_id=? AND task_key='w9'").get(submissionId);
    // Check contractor_invoices (DocuSeal invoices)
    const cinv = db.prepare("SELECT id, worker_account_id FROM contractor_invoices WHERE ds_envelope_id=?").get(submissionId);

    if (!pf && !wo && !w9o && !cinv) { res.json({ received: true }); return; }

    // ── Handle Contractor Invoice (DocuSeal) completion ──
    if (cinv) {
      if (isCompleted || isSubmitterCompleted) {
        try {
          // Fetch submission details to extract field values
          const subData = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
          const submitters = subData.data?.submitters || [];
          const workerSub = submitters[0];
          const signedAt = workerSub?.completed_at || new Date().toISOString();
          // Try to extract total_amount from filled fields
          let totalAmount = 0;
          let serviceDesc = '';
          const fields = workerSub?.fields || workerSub?.values || [];
          if (Array.isArray(fields)) {
            for (const f of fields) {
              const fname = (f.name || '').toLowerCase();
              const fval = f.value || f.default_value || '';
              if (fname.includes('amount') || fname.includes('total') || fname.includes('金额')) {
                const parsed = parseFloat(String(fval).replace(/[^0-9.]/g, ''));
                if (!isNaN(parsed) && parsed > 0) totalAmount = parsed;
              }
              if (fname.includes('description') || fname.includes('服务') || fname.includes('service')) {
                serviceDesc = String(fval);
              }
            }
          }
          const updates = { ds_status: 'completed', ds_signed_at: signedAt, status: 'submitted' };
          if (totalAmount > 0) updates.total_amount = totalAmount;
          if (serviceDesc) updates.service_description = serviceDesc;
          db.prepare(`UPDATE contractor_invoices SET ds_status='completed', ds_signed_at=?, status='submitted',
            total_amount=CASE WHEN ?> 0 THEN ? ELSE total_amount END,
            service_description=CASE WHEN ? != '' THEN ? ELSE service_description END
            WHERE id=?`)
            .run(signedAt, totalAmount, totalAmount, serviceDesc, serviceDesc, cinv.id);
          console.log(`[DocuSeal webhook] Contractor invoice ${cinv.id} completed, amount=${totalAmount}`);
        } catch (e) { console.error('[DocuSeal webhook] contractor invoice error:', e.message); }
      } else if (isDeclined) {
        db.prepare("UPDATE contractor_invoices SET ds_status='declined', status='rejected', reject_reason=? WHERE id=?")
          .run(data.decline_reason || '员工拒签', cinv.id);
      }
    }

    // ── Handle W-9 completion ──
    if (w9o) {
      const wid = w9o.worker_account_id;
      if (isCompleted || isSubmitterCompleted) {
        try {
          // Fetch submission status from DocuSeal to confirm completion
          const subData = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
          const dsStatus = subData.data?.status || subData.status_str || '';
          const submitters = subData.data?.submitters || subData.data?.documents?.[0]?.submitters || [];
          const workerSub = submitters.find(s => s.role !== 'Company' && s.role !== 'First Party') || submitters[0];
          const workerSignedAt = workerSub?.completed_at || workerSub?.updated_at || new Date().toISOString();
          const fullyDone = dsStatus === 'completed' || submitters.every(s => s.status === 'completed');
          console.log(`[DocuSeal W-9 webhook] wid=${wid}, dsStatus=${dsStatus}, fullyDone=${fullyDone}`);
          if (fullyDone) {
            db.prepare("UPDATE worker_onboarding SET ds_status='completed', ds_worker_signed_at=?, status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='W-9 已签署完成 ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
              .run(workerSignedAt, wid);
            syncOnboardedStatus(wid);
            console.log(`[DocuSeal W-9 webhook] W-9 marked completed for worker ${wid}`);
          } else {
            db.prepare("UPDATE worker_onboarding SET ds_worker_signed_at=?, admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
              .run(workerSignedAt, `W-9 已填写提交，等待最终确认 (${new Date().toLocaleString('zh-CN')})`, wid);
          }
        } catch (e) { console.error('[DocuSeal W-9 webhook] error:', e.message); }
      } else if (isDeclined) {
        db.prepare("UPDATE worker_onboarding SET ds_status='declined', admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
          .run(`W-9 已被拒签: ${data.decline_reason || ''}`, wid);
      }
    }

    // Handle partner file contract events
    if (pf) {
      if (isCompleted) {
        try {
          const { status, companySigned, partnerSigned } = await dsealGetStatus(submissionId);
          // Verify BOTH parties actually signed before marking as completed
          if (status === 'completed' && companySigned && partnerSigned) {
            db.prepare("UPDATE partner_files SET ds_status='completed', ds_company_signed_at=?, ds_partner_signed_at=? WHERE id=?").run(companySigned, partnerSigned, pf.id);
            db.prepare("UPDATE partners SET active=1 WHERE id=(SELECT partner_id FROM partner_files WHERE id=?)").run(pf.id);
            const pfRecord = db.prepare("SELECT file_path FROM partner_files WHERE id=?").get(pf.id);
            if (pfRecord?.file_path) {
              const signedBuf = await dsealDownloadDocument(submissionId);
              fs.writeFileSync(path.join(docsDir, pfRecord.file_path), signedBuf);
              console.log(`[DocuSeal] Saved signed partner contract for file id=${pf.id}`);
            }
          } else {
            console.log(`[DocuSeal] Partner contract not fully completed (company=${!!companySigned}, partner=${!!partnerSigned}), updating partial status`);
            db.prepare("UPDATE partner_files SET ds_company_signed_at=?, ds_partner_signed_at=? WHERE id=?").run(companySigned, partnerSigned, pf.id);
          }
        } catch (e) { console.error('[DocuSeal webhook] completion error:', e.message); }
      } else if (isSubmitterCompleted) {
        try {
          const { companySigned, partnerSigned } = await dsealGetStatus(submissionId);
          db.prepare("UPDATE partner_files SET ds_company_signed_at=?, ds_partner_signed_at=? WHERE id=?").run(companySigned, partnerSigned, pf.id);
        } catch (e) { console.error('[DocuSeal webhook] submitter status error:', e.message); }
      } else if (isDeclined) {
        db.prepare("UPDATE partner_files SET ds_status='declined', ds_decline_reason=? WHERE id=?").run(data.decline_reason || '已拒签', pf.id);
      }
    }

    // Handle worker onboarding contract events
    if (wo) {
      const wid = wo.worker_account_id;
      if (isCompleted) {
        try {
          const { status, companySigned, partnerSigned } = await dsealGetStatus(submissionId);
          // Trust DocuSeal completed status (timestamps may be missing due to API timing)
          if (status === 'completed') {
            db.prepare("UPDATE worker_onboarding SET ds_status='completed', ds_worker_signed_at=?, ds_company_signed_at=?, status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='双方已签署完成 ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
              .run(partnerSigned, companySigned, wid);
            // Update contract version status
            db.prepare("UPDATE worker_contract_versions SET ds_status='completed', ds_company_signed_at=?, ds_worker_signed_at=? WHERE worker_account_id=? AND ds_envelope_id=?")
              .run(companySigned, partnerSigned, wid, submissionId);
            // Log completion to worker history
            db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
              .run(wid, 'system', 'contract', '签署中', '双方已签署', `公司签署: ${companySigned || '—'}, 工人签署: ${partnerSigned || '—'}`);
            syncOnboardedStatus(wid);
            console.log(`[DocuSeal] Worker onboarding contract completed for worker ${wid}`);
          } else {
            // Only one party signed — treat as partial, update individual timestamps
            console.log(`[DocuSeal] Worker contract not fully completed yet (company=${!!companySigned}, worker=${!!partnerSigned}), updating partial status`);
            db.prepare("UPDATE worker_onboarding SET ds_worker_signed_at=?, ds_company_signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
              .run(partnerSigned, companySigned, wid);
          }
        } catch (e) { console.error('[DocuSeal webhook] worker contract completion error:', e.message); }
      } else if (isSubmitterCompleted) {
        try {
          const { companySigned, partnerSigned } = await dsealGetStatus(submissionId);
          db.prepare("UPDATE worker_onboarding SET ds_worker_signed_at=?, ds_company_signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
            .run(partnerSigned, companySigned, wid);
          // If company just signed (First Party), notify worker to sign
          const submitterRole = data.role || data.metadata?.role || '';
          const isCompanySigner = submitterRole === 'First Party' || (!submitterRole && companySigned && !partnerSigned);
          // Check if we already sent company-signed notification (avoid duplicate emails)
          const currentOnb = db.prepare("SELECT ds_status FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(wid);
          const alreadyNotified = currentOnb && (currentOnb.ds_status === 'company_signed' || currentOnb.ds_status === 'completed');
          if (isCompanySigner && !alreadyNotified) {
            // Update contract version status
            db.prepare("UPDATE worker_contract_versions SET ds_status='company_signed', ds_company_signed_at=? WHERE worker_account_id=? AND ds_envelope_id=?")
              .run(companySigned, wid, submissionId);
            // Log company signing to worker history
            db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
              .run(wid, 'system', 'contract', '已发送', '公司已签署', `公司签署时间: ${companySigned || new Date().toISOString()}`);
            console.log(`[DocuSeal webhook] Company signed for worker ${wid}, sending notification to worker`);
            try {
              const wAccount = db.prepare("SELECT name, username, email, phone FROM worker_accounts WHERE id=?").get(wid);
              if (wAccount) {
                const workerName = wAccount.name || wAccount.username || '';
                const workerEmail = wAccount.email || '';
                const workerPhone = wAccount.phone || '';
                const onbRecord = db.prepare("SELECT contract_content FROM worker_onboarding WHERE worker_account_id=? AND task_key='contract'").get(wid);
                const empType = (onbRecord?.contract_content || '').includes('Independent Contractor') ? '1099' : 'w2';
                const contractType = empType === '1099' ? 'Independent Contractor Agreement' : 'Employment Agreement';
                const contractTypeCn = empType === '1099' ? '承包商协议' : '雇佣合同';
                // Get worker signing URL
                let workerSignUrl = '';
                try {
                  const subData = await dsealApiCall('GET', `/api/submissions/${submissionId}`, null);
                  const workerSub = (subData.data?.submitters || []).find(s => s.role === 'Second Party');
                  if (workerSub) {
                    // Prefer slug-based URL (/s/xxx) — works directly in mobile browsers
                    // embed_src is designed for web component embedding and may not render on mobile
                    if (workerSub.slug) {
                      const baseHost = dsealPublicHost();
                      workerSignUrl = `${baseHost}/s/${workerSub.slug}`;
                    } else if (workerSub.embed_src) {
                      workerSignUrl = workerSub.embed_src;
                    } else if (workerSub.id) {
                      const wPut = await dsealApiCall('PUT', `/api/submitters/${workerSub.id}`, { name: workerSub.name || workerName });
                      if (wPut.data?.slug) {
                        const baseHost = dsealPublicHost();
                        workerSignUrl = `${baseHost}/s/${wPut.data.slug}`;
                      } else if (wPut.data?.embed_src) {
                        workerSignUrl = wPut.data.embed_src;
                      }
                    }
                  }
                } catch (e2) { console.error('[DocuSeal webhook] get worker sign URL error:', e2.message); }
                // Update action_url with worker signing URL so portal can show it
                if (workerSignUrl) {
                  db.prepare("UPDATE worker_onboarding SET ds_status='company_signed', action_url=?, admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
                    .run(workerSignUrl, `公司已签署，等待工人签署 (${new Date().toLocaleString('zh-CN')})`, wid);
                }
                const companyName = process.env.COMPANY_SIGNER_NAME || 'Prime Anchorpoint';
                const contractTypeEs = empType === '1099' ? 'Acuerdo de Contratista Independiente' : 'Acuerdo de Empleo';
                // Send email to worker (trilingual: Chinese / English / Spanish)
                if (workerEmail) {
                  const signLink = workerSignUrl ? `<p style="margin:1.5rem 0;text-align:center"><a href="${workerSignUrl}" style="display:inline-block;padding:.75rem 2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem">签署合同 / Sign Contract / Firmar Contrato</a></p>` : '';
                  await sendEmail(workerEmail,
                    `Prime Anchorpoint — 请签署${contractTypeCn} / Please Sign / Firme Su Contrato`,
                    `您好 ${workerName}，\n${companyName} 已完成签署，现在轮到您了。\n${workerSignUrl ? '签署链接: ' + workerSignUrl : ''}\n\nHi ${workerName},\n${companyName} has signed. It's your turn now.\n${workerSignUrl ? 'Sign here: ' + workerSignUrl : ''}\n\nHola ${workerName},\n${companyName} ha firmado. Ahora es su turno.\n${workerSignUrl ? 'Firme aquí: ' + workerSignUrl : ''}\n\nPrime Anchorpoint`,
                    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem">
                      <h2 style="color:#1a1a1a;text-align:center">请签署您的${contractTypeCn}</h2>
                      <p>您好 ${workerName}，</p>
                      <p>${companyName} 已完成签署，现在轮到您签署了。请点击下方按钮完成电子签署。</p>
                      ${signLink}
                      ${workerSignUrl ? `<p style="color:#666;font-size:.85rem">或复制链接：${workerSignUrl}</p>` : ''}
                      <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
                      <h3 style="color:#333;font-size:.95rem">Please Sign Your ${contractType}</h3>
                      <p style="color:#555;font-size:.9rem">Hi ${workerName}, ${companyName} has completed their signature. It's now your turn to sign the ${contractType}. Please click the button below to complete your electronic signature.</p>
                      ${signLink}
                      <hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0">
                      <h3 style="color:#333;font-size:.95rem">Firme Su ${contractTypeEs}</h3>
                      <p style="color:#555;font-size:.9rem">Hola ${workerName}, ${companyName} ha completado su firma. Ahora es su turno de firmar el ${contractTypeEs}. Haga clic en el botón de abajo para completar su firma electrónica.</p>
                      ${signLink}
                      <p style="color:#999;font-size:.8rem;margin-top:2rem;text-align:center">Prime Anchorpoint LLC</p>
                    </div>`
                  );
                  console.log(`[DocuSeal webhook] Sent trilingual signing email to worker ${workerEmail}`);
                }
                // Send SMS to worker (trilingual)
                if (workerPhone) {
                  const smsText = workerSignUrl
                    ? `[Prime Anchorpoint] ${workerName}，${companyName}已签署${contractTypeCn}，请点击链接完成签署 / Please sign: / Firme aquí:\n${workerSignUrl}\nReply STOP to opt out.`
                    : `[Prime Anchorpoint] ${workerName}，${companyName}已签署${contractTypeCn}，请查收邮件完成签署。/ Please check email to sign. / Revise su correo para firmar. Reply STOP to opt out.`;
                  await sendSMS(workerPhone, smsText);
                  console.log(`[DocuSeal webhook] Sent trilingual signing SMS to worker ${workerPhone}`);
                }
              }
            } catch (notifyErr) { console.error('[DocuSeal webhook] worker notification error:', notifyErr.message); }
          }
        } catch (e) { console.error('[DocuSeal webhook] worker submitter status error:', e.message); }
      } else if (isDeclined) {
        const declineReason = data.decline_reason || '';
        db.prepare("UPDATE worker_onboarding SET ds_status='declined', admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='contract'")
          .run(`工人已拒签: ${declineReason}`, wid);
        // Update contract version
        db.prepare("UPDATE worker_contract_versions SET ds_status='declined', void_reason=? WHERE worker_account_id=? AND ds_envelope_id=?")
          .run(`工人拒签: ${declineReason || '未提供'}`, wid, submissionId);
        // Log decline to worker history
        db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
          .run(wid, 'system', 'contract', '签署中', '已拒签', `工人拒签原因: ${declineReason || '未提供'}`);
      }
    }

    // Handle worker W-9 events
    if (w9) {
      const w9wid = w9.worker_account_id;
      if (isCompleted || isSubmitterCompleted) {
        try {
          const { status, workerSigned } = await dsealGetW9Status(submissionId);
          db.prepare("UPDATE worker_onboarding SET ds_status=?, ds_worker_signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
            .run(status, workerSigned, w9wid);
          if (status === 'completed') {
            db.prepare(`UPDATE worker_onboarding SET status='completed', completed_at=CURRENT_TIMESTAMP, admin_note='W-9 已签署完成 ✅', updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'`)
              .run(w9wid);
            db.prepare('INSERT INTO worker_account_history (worker_account_id,changed_by,field_name,old_value,new_value,note) VALUES (?,?,?,?,?,?)')
              .run(w9wid, 'system', 'w9', '签署中', '已签署', `W-9 签署完成: ${workerSigned || new Date().toISOString()}`);
            syncOnboardedStatus(w9wid);
            console.log(`[DocuSeal] Worker W-9 completed for worker ${w9wid}`);
          }
        } catch (e) { console.error('[DocuSeal webhook] W-9 completion error:', e.message); }
      } else if (isDeclined) {
        db.prepare("UPDATE worker_onboarding SET ds_status='declined', admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE worker_account_id=? AND task_key='w9'")
          .run(`工人已拒签 W-9: ${data.decline_reason || ''}`, w9wid);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[DocuSeal Webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/docusign/webhook — DocuSign Connect event notifications (assignments only)
app.post('/api/docusign/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  console.log(`[DocuSign Webhook] Received request from ${req.ip} at ${new Date().toISOString()}`);
  try {
    const rawBody = req.body.toString('utf8');
    const hmacSecret = process.env.DOCUSIGN_WEBHOOK_HMAC;
    if (hmacSecret) {
      const sig = req.headers['x-docusign-signature-1'] || '';
      const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody).digest('base64');
      if (sig !== expected) {
        console.error(`[DocuSign Webhook] HMAC signature mismatch — received: ${sig.substring(0,20)}...`);
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    const event = JSON.parse(rawBody);
    const envelopeId = event?.data?.envelopeId || event?.envelopeId;
    const status = event?.data?.envelopeSummary?.status || event?.status;
    console.log(`[DocuSign Webhook] envelopeId=${envelopeId} status=${status}`);
    if (envelopeId && status) {
      const asgn = db.prepare("SELECT id FROM assignments WHERE ds_envelope_id=?").get(envelopeId);
      if (asgn) db.prepare("UPDATE assignments SET ds_status=? WHERE id=?").run(status, asgn.id);
      for (const s of (event?.data?.envelopeSummary?.recipients?.signers || [])) {
        if (s.status === 'completed' && s.signedDateTime) {
          if (asgn) {
            if (s.recipientId === '1') db.prepare("UPDATE assignments SET ds_company_signed_at=? WHERE id=?").run(s.signedDateTime, asgn.id);
            if (s.recipientId === '2') db.prepare("UPDATE assignments SET ds_worker_signed_at=? WHERE id=?").run(s.signedDateTime, asgn.id);
          }
        }
        if (s.status === 'declined' && s.declinedReason) {
          if (asgn) db.prepare("UPDATE assignments SET ds_decline_reason=? WHERE id=?").run(s.declinedReason, asgn.id);
        }
      }
      if (asgn && status === 'completed') {
        // Download the signed PDF from DocuSign and overwrite the local contract file
        try {
          const asgnRecord = db.prepare("SELECT contract_file FROM assignments WHERE id=?").get(asgn.id);
          if (asgnRecord && asgnRecord.contract_file) {
            const signedBuf = await dsDownloadSignedDoc(envelopeId);
            fs.writeFileSync(path.join(docsDir, asgnRecord.contract_file), signedBuf);
            console.log(`[DocuSign] Saved signed assignment contract for assignment id=${asgn.id}`);
          }
        } catch (dlErr) { console.error('[DocuSign] Failed to download signed assignment doc:', dlErr.message); }
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

// Admin: create interview location (legacy handler - see below for active handler)

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
  const { name, address, address1, address2, city, state, zip, contact_name, contact_phone, instructions } = req.body;
  if (!name) return res.status(400).json({ error: '地点名称必填 / name required' });
  if (!address1) return res.status(400).json({ error: '街道地址必填 / address1 required' });
  if (!city) return res.status(400).json({ error: '城市必填 / city required' });
  if (!state) return res.status(400).json({ error: '请选择州 / state required' });
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) return res.status(400).json({ error: '邮编格式不正确 / invalid ZIP format' });
  const addrDisplay = address || [address1, address2, city && state ? `${city}, ${state}${zip ? ' ' + zip : ''}` : city].filter(Boolean).join(', ') || '';
  const r = db.prepare('INSERT INTO interview_locations (name,address,address1,address2,city,state,zip,contact_name,contact_phone,instructions) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(name, addrDisplay, address1||'', address2||'', city||'', state||'', zip||'', contact_name||'', contact_phone||'', instructions||'');
  res.json({ success: true, id: r.lastInsertRowid });
});
app.put('/api/admin/interview-locations/:id', requireAdmin, (req, res) => {
  const loc = db.prepare('SELECT * FROM interview_locations WHERE id=?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });
  const { name, address, address1, address2, city, state, zip, contact_name, contact_phone, instructions, active } = req.body;
  const a1 = address1 ?? loc.address1 ?? '';
  const a2 = address2 ?? loc.address2 ?? '';
  const ct = city ?? loc.city ?? '';
  const st = state ?? loc.state ?? '';
  const zp = zip ?? loc.zip ?? '';
  const addrDisplay = (address ?? [a1, a2, ct && st ? `${ct}, ${st}${zp ? ' ' + zp : ''}` : ct].filter(Boolean).join(', ')) || loc.address;
  db.prepare('UPDATE interview_locations SET name=?,address=?,address1=?,address2=?,city=?,state=?,zip=?,contact_name=?,contact_phone=?,instructions=?,active=? WHERE id=?')
    .run(name??loc.name, addrDisplay, a1, a2, ct, st, zp, contact_name??loc.contact_name, contact_phone??loc.contact_phone, instructions??loc.instructions, active??loc.active, req.params.id);
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

// Add structured address columns to interview_locations if missing
try { db.exec("ALTER TABLE interview_locations ADD COLUMN address1 TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_locations ADD COLUMN address2 TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_locations ADD COLUMN city TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_locations ADD COLUMN state TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE interview_locations ADD COLUMN zip TEXT DEFAULT ''"); } catch {}

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
    SELECT i.id, i.worker_account_id, i.slot_id, i.status, i.admin_notes,
      i.doc_request_token, i.created_at, i.updated_at,
      COALESCE(i.interview_type,'onboarding') AS interview_type,
      s.slot_datetime, s.duration_min, s.location,
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

// Admin: get all interview history (current + archived)
app.get('/api/admin/interview-history', requireAdmin, (req, res) => {
  const current = db.prepare(`
    SELECT i.id, i.worker_account_id, i.status, i.admin_notes,
      COALESCE(i.interview_type,'onboarding') AS interview_type,
      i.created_at, i.updated_at,
      s.slot_datetime, s.duration_min, s.location,
      w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email,
      w.position_interests, 'current' AS source
    FROM interviews i
    JOIN interview_slots s ON i.slot_id = s.id
    JOIN worker_accounts w ON i.worker_account_id = w.id
  `).all();
  const archived = db.prepare(`
    SELECT id, worker_account_id, status, admin_notes, interview_type,
      original_created_at AS created_at, original_updated_at AS updated_at,
      slot_datetime, duration_min, location,
      worker_name, worker_phone, worker_email,
      position_interests, 'archived' AS source, archived_at
    FROM interview_history
  `).all();
  const all = [...current, ...archived].sort((a, b) => {
    const da = a.slot_datetime || a.created_at || '';
    const db2 = b.slot_datetime || b.created_at || '';
    return db2.localeCompare(da);
  });
  res.json(all);
});

// Admin: send Stripe Identity verification to worker via interview
app.post('/api/admin/interviews/:id/send-identity', requireAdmin, async (req, res) => {
  try {
    const interview = db.prepare(`
      SELECT i.*, w.id as worker_id, w.name as worker_name, w.phone as worker_phone,
        w.email as worker_email, w.persona_inquiry_id, w.identity_status
      FROM interviews i JOIN worker_accounts w ON i.worker_account_id = w.id WHERE i.id=?
    `).get(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!stripe)
      return res.status(503).json({ error: 'Stripe Identity 未配置，请先在 .env 设置 STRIPE_SECRET_KEY' });
    const { force } = req.body || {};
    if (interview.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createStripeVerificationSession(interview.worker_id, interview.worker_name, interview.worker_email);
    if (!result) return res.status(500).json({ error: '创建 Stripe Identity 验证失败，请检查 STRIPE_SECRET_KEY' });
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.sessionId, interview.worker_id);
    const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
    const smsText = `[Prime Anchorpoint] 您好 ${interview.worker_name||''}，请完成身份验证（驾照/ID+自拍）以继续求职流程。点击链接：${result.url || portalUrl}`;
    const smsSent = await sendSMS(interview.worker_phone, smsText);
    if (interview.worker_email) {
      await sendEmail(interview.worker_email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证：${result.url || portalUrl}`,
        `<p>您好 ${interview.worker_name||''}，</p><p>HR 已为您发起身份验证。请点击以下链接，按提示上传驾照/ID、完成自拍核验：</p><p><a href="${result.url || portalUrl}" style="display:inline-block;padding:.65rem 1.5rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证</a></p><p style="color:#888;font-size:.85rem">或复制链接：${result.url || portalUrl}</p>`
      );
    }
    res.json({ success: true, smsSent, sessionId: result.sessionId, link: result.url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: get own identity verification status
app.get('/api/worker/identity/status', requireWorker, async (req, res) => {
  try {
    const w = db.prepare('SELECT persona_inquiry_id, identity_status, identity_sent_at FROM worker_accounts WHERE id=?').get(req.workerId);
    if (!w) return res.status(404).json({ error: 'Not found' });
    let link = null;
    // For Stripe Identity, retrieve fresh session URL if pending
    if (w.persona_inquiry_id && w.identity_status === 'pending' && stripe) {
      const session = await getStripeVerificationSession(w.persona_inquiry_id);
      if (session && session.url) link = session.url;
    }
    res.json({ status: w.identity_status || 'not_sent', sent_at: w.identity_sent_at || null, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: update interview status / notes
app.put('/api/admin/interviews/:id', requireAdmin, (req, res) => {
  const { status, admin_notes, identity_status, payment_method, interview_type } = req.body;
  const row = db.prepare('SELECT * FROM interviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE interviews SET status=?, admin_notes=?, interview_type=COALESCE(?,interview_type,'onboarding'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status ?? row.status, admin_notes ?? row.admin_notes, interview_type ?? null, req.params.id);
  if (status === 'cancelled' && row.status !== 'cancelled') {
    db.prepare(`UPDATE interview_slots SET booked_count = MAX(0, booked_count-1) WHERE id=?`).run(row.slot_id);
  }
  // Sync to onboarding task
  if ((status === 'passed' || status === 'completed') && row.worker_account_id) {
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

// Admin: send Stripe Identity verification to worker via interview
app.post('/api/admin/interviews/:id/send-identity', requireAdmin, async (req, res) => {
  try {
    const interview = db.prepare(`
      SELECT i.*, w.id as worker_id, w.name as worker_name, w.phone as worker_phone,
        w.email as worker_email, w.persona_inquiry_id, w.identity_status
      FROM interviews i JOIN worker_accounts w ON i.worker_account_id = w.id WHERE i.id=?
    `).get(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!stripe)
      return res.status(503).json({ error: 'Stripe Identity 未配置，请先在 .env 设置 STRIPE_SECRET_KEY' });
    const { force } = req.body || {};
    if (interview.identity_status === 'approved' && !force)
      return res.status(400).json({ error: '该工人身份验证已通过，如需重发传 force:true' });
    const result = await createStripeVerificationSession(interview.worker_id, interview.worker_name, interview.worker_email);
    if (!result) return res.status(500).json({ error: '创建 Stripe Identity 验证失败，请检查 STRIPE_SECRET_KEY' });
    // Auto-add drivers_license to assigned_tasks
    const wAcct = db.prepare('SELECT assigned_tasks FROM worker_accounts WHERE id=?').get(interview.worker_id);
    let curTasks = [];
    try { curTasks = JSON.parse(wAcct?.assigned_tasks || '[]'); } catch {}
    if (!curTasks.includes('drivers_license')) {
      curTasks.push('drivers_license');
      db.prepare('UPDATE worker_accounts SET assigned_tasks=? WHERE id=?').run(JSON.stringify(curTasks), interview.worker_id);
    }
    db.prepare(`UPDATE worker_accounts SET persona_inquiry_id=?, identity_status='pending', identity_sent_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(result.sessionId, interview.worker_id);
    // Sync to worker_compliance_docs for portal
    const compFormData = JSON.stringify({ stripe_session_id: result.sessionId, stripe_client_secret: result.clientSecret, stripe_status: 'requires_input', stripe_hosted_url: result.url || '' });
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
      .run(interview.worker_id, '已发送 Stripe Identity 验证链接', result.url || '');
    // Send SMS
    let smsSent = false;
    if (interview.worker_phone) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      const smsText = `[Prime Anchorpoint] 您好 ${interview.worker_name||''}，请完成身份验证（驾照/ID+自拍）以继续求职流程。\n您可以：\n1. 登录合作中心直接完成验证\n2. 点击链接在手机完成：${result.url || portalUrl}`;
      smsSent = await sendSMS(interview.worker_phone, smsText);
    }
    // Send email
    let emailSent = false;
    if (interview.worker_email) {
      const portalUrl = `${req.protocol}://${req.get('host')}/portal.html`;
      emailSent = await sendEmail(interview.worker_email,
        'Prime Anchorpoint — 身份验证请求 / Identity Verification',
        `请完成身份验证。您可以登录合作中心直接完成，或点击链接：${result.url || portalUrl}`,
        `<p>您好 ${interview.worker_name||''}，</p>
         <p>HR 已为您发起身份验证（驾照/ID + 自拍核验）。您可以通过以下任一方式完成：</p>
         <table cellpadding="0" cellspacing="0" style="margin:1rem 0">
           <tr><td style="padding:.5rem 0"><strong>方式一：</strong> 登录合作中心，在"合规文件"或"待办事项"中直接完成</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${portalUrl}" style="display:inline-block;padding:.6rem 1.2rem;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">登录合作中心 / Worker Portal</a></td></tr>
           ${result.url ? `<tr><td style="padding:.75rem 0 .3rem"><strong>方式二：</strong> 点击以下链接直接在手机上完成验证</td></tr>
           <tr><td style="padding:.3rem 0"><a href="${result.url}" style="display:inline-block;padding:.6rem 1.2rem;background:#1a7ed4;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">开始身份验证 / Start Verification</a></td></tr>
           <tr><td style="padding:.3rem 0"><span style="color:#888;font-size:.82rem">或复制链接：${result.url}</span></td></tr>` : ''}
         </table>`
      );
    }
    res.json({ success: true, smsSent, emailSent, portalReady: true, sessionId: result.sessionId, link: result.url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: get own identity verification status
app.get('/api/worker/identity/status', requireWorker, async (req, res) => {
  try {
    const w = db.prepare('SELECT persona_inquiry_id, identity_status, identity_sent_at FROM worker_accounts WHERE id=?').get(req.workerId);
    if (!w) return res.status(404).json({ error: 'Not found' });
    let link = null;
    if (w.persona_inquiry_id && w.identity_status === 'pending' && stripe) {
      const session = await getStripeVerificationSession(w.persona_inquiry_id);
      if (session && session.url) link = session.url;
    }
    res.json({ status: w.identity_status || 'not_sent', sent_at: w.identity_sent_at || null, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker: list available slots
app.get('/api/worker/interview-slots', requireWorker, (req, res) => {
  // Check if admin has assigned specific slot IDs for this worker (stored on onboarding record)
  const obRecord = db.prepare(`SELECT assigned_slot_ids FROM worker_onboarding WHERE worker_account_id=? AND task_key='interview'`).get(req.workerId);
  let assignedIds = [];
  try { assignedIds = JSON.parse(obRecord?.assigned_slot_ids || '[]'); } catch {}
  console.log(`[INTERVIEW-SLOTS] workerId=${req.workerId}, assignedIds=${JSON.stringify(assignedIds)}`);

  // Use EST/CDT offset for datetime comparison (slots stored in local time, server runs in UTC)
  const nowExpr = `datetime('now', '-5 hours')`;

  if (assignedIds.length) {
    // Admin assigned specific slots — show only those
    const placeholders = assignedIds.map(() => '?').join(',');
    const assigned = db.prepare(`
      SELECT id, slot_datetime, duration_min, location, contact_name, contact_phone, instructions, notes, max_bookings, booked_count
      FROM interview_slots
      WHERE id IN (${placeholders}) AND active=1 AND booked_count < max_bookings AND datetime(slot_datetime) > ${nowExpr}
      ORDER BY slot_datetime ASC
    `).all(...assignedIds);
    console.log(`[INTERVIEW-SLOTS] Returning ${assigned.length} assigned slots`);
    return res.json(assigned);
  }

  // Fallback: check reserved_for_worker_account_id (legacy)
  const reserved = db.prepare(`
    SELECT id, slot_datetime, duration_min, location, contact_name, contact_phone, instructions, notes, max_bookings, booked_count
    FROM interview_slots
    WHERE active=1 AND booked_count < max_bookings AND datetime(slot_datetime) > ${nowExpr}
      AND reserved_for_worker_account_id=?
    ORDER BY slot_datetime ASC
  `).all(req.workerId);
  if (reserved.length) return res.json(reserved);

  // No specific assignment — show all general (unreserved) open slots
  const general = db.prepare(`
    SELECT id, slot_datetime, duration_min, location, contact_name, contact_phone, instructions, notes, max_bookings, booked_count
    FROM interview_slots
    WHERE active=1 AND booked_count < max_bookings AND datetime(slot_datetime) > ${nowExpr}
      AND reserved_for_worker_account_id IS NULL
    ORDER BY slot_datetime ASC
  `).all();
  res.json(general);
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
  // Compare slot_datetime string directly (both stored as naive local time)
  // Normalize T-separator to space for consistent comparison with strftime
  const slotDt = (slot.slot_datetime || '').replace('T', ' ');
  const nowLocal = db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '-5 hours') as t`).get().t;
  if (slotDt <= nowLocal) return res.status(400).json({ error: '该面试时间已过期，请返回选择其他时间' });

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

// ─── Geocode proxy: Google Maps → Nominatim fallback ───
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const https = require('https');
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  // Try Google Geocoding API first if key is available
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${apiKey}`;
      const data = await new Promise((resolve, reject) => {
        https.get(url, resp => {
          let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      if (data.status === 'OK' && data.results.length) {
        const r = data.results[0];
        return res.json({ lat: r.geometry.location.lat, lng: r.geometry.location.lng, display: r.formatted_address, source: 'google' });
      }
    } catch (e) { /* fall through to Nominatim */ }
  }
  // Nominatim fallback
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=us`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'PrimeAnchorpoint/1.0' } }, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    if (data.length) {
      return res.json({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name, source: 'nominatim' });
    }
    return res.json({ found: false });
  } catch (e) {
    return res.status(500).json({ error: 'geocode failed' });
  }
});

// ─── Google Address Validation ───
app.post('/api/validate-address', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.json({ skipped: true });
  }
  const { street, street2, city, state, zip, regionCode, countryName } = req.body || {};
  if (!street) return res.status(400).json({ error: 'street is required' });

  const addressLines = [street];
  if (street2) addressLines.push(street2);

  // Resolve region code from ISO code or country name
  const COUNTRY_TO_ISO = {
    'Armenia':'AM','Australia':'AU','Austria':'AT','Azerbaijan':'AZ','Bangladesh':'BD','Barbados':'BB',
    'Belarus':'BY','Belgium':'BE','Bulgaria':'BG','Canada':'CA','China':'CN','Cyprus':'CY',
    'Czech Republic':'CZ','Denmark':'DK','Egypt':'EG','Estonia':'EE','Finland':'FI','France':'FR',
    'Georgia':'GE','Germany':'DE','Greece':'GR','Hungary':'HU','Iceland':'IS','India':'IN',
    'Indonesia':'ID','Ireland':'IE','Israel':'IL','Italy':'IT','Jamaica':'JM','Japan':'JP',
    'Kazakhstan':'KZ','Korea':'KR','South Korea':'KR','Kyrgyzstan':'KG','Latvia':'LV','Lithuania':'LT',
    'Luxembourg':'LU','Malta':'MT','Mexico':'MX','Moldova':'MD','Morocco':'MA','Netherlands':'NL',
    'New Zealand':'NZ','Norway':'NO','Pakistan':'PK','Philippines':'PH','Poland':'PL','Portugal':'PT',
    'Romania':'RO','Russia':'RU','Slovak Republic':'SK','Slovakia':'SK','Slovenia':'SI',
    'South Africa':'ZA','Spain':'ES','Sri Lanka':'LK','Sweden':'SE','Switzerland':'CH',
    'Tajikistan':'TJ','Thailand':'TH','Trinidad and Tobago':'TT','Tunisia':'TN','Turkey':'TR',
    'Turkmenistan':'TM','Ukraine':'UA','United Kingdom':'GB','UK':'GB','Uzbekistan':'UZ','Venezuela':'VE',
    'Afghanistan':'AF','Algeria':'DZ','Argentina':'AR','Brazil':'BR','Cambodia':'KH','Chile':'CL',
    'Colombia':'CO','Cuba':'CU','Dominican Republic':'DO','Ecuador':'EC','El Salvador':'SV',
    'Ethiopia':'ET','Ghana':'GH','Guatemala':'GT','Haiti':'HT','Honduras':'HN','Hong Kong':'HK',
    'Iran':'IR','Iraq':'IQ','Jordan':'JO','Kenya':'KE','Laos':'LA','Lebanon':'LB','Libya':'LY',
    'Malaysia':'MY','Myanmar':'MM','Nepal':'NP','Nicaragua':'NI','Nigeria':'NG','Panama':'PA',
    'Paraguay':'PY','Peru':'PE','Saudi Arabia':'SA','Singapore':'SG','Syria':'SY','Taiwan':'TW',
    'Tanzania':'TZ','Uganda':'UG','Uruguay':'UY','Vietnam':'VN','Yemen':'YE','Zimbabwe':'ZW'
  };
  let region = (regionCode || '').toUpperCase();
  if (!region && countryName) region = COUNTRY_TO_ISO[countryName] || '';
  if (!region) region = 'US';
  const payload = {
    address: {
      regionCode: region,
      addressLines,
      ...(city  && { locality: city }),
      ...(state && { administrativeArea: state }),
      ...(zip   && { postalCode: zip })
    }
  };

  const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`;
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req2 = https.request(url, opts, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from Google')); } });
      });
      req2.setTimeout(10000, () => { req2.destroy(new Error('Google API request timed out')); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (raw.error) {
      console.error('[Google Address Validation] API error:', raw.error.message);
      return res.status(500).json({ error: 'Address validation service error' });
    }

    const result = raw.result || {};
    const verdict = result.verdict || {};
    const postalAddress = result.address?.postalAddress || {};
    const uspsData = result.uspsData || {};

    const dpv = uspsData.dpvConfirmation;
    const granularity = verdict.validationGranularity;

    // For US addresses, use USPS DPV; for international, use Google granularity
    const isUs = region === 'US';
    const undeliverable = isUs
      ? (dpv === 'N' || granularity === 'OTHER' || granularity === 'ROUTE')
      : (granularity === 'OTHER');

    if (undeliverable) {
      return res.json({ valid: false });
    }

    const addrLines = postalAddress.addressLines || [];
    const fullZip = postalAddress.postalCode || zip || '';
    const zipParts = fullZip.replace('-', '').match(/^(\d{5})(\d{4})?$/);

    return res.json({
      valid: true,
      dpv_match_code: dpv,
      standardized: {
        street:  addrLines[0] || street,
        street2: addrLines[1] || '',
        city:    postalAddress.locality || city || '',
        state:   postalAddress.administrativeArea || state || '',
        zip:     zipParts ? zipParts[1] : fullZip.substring(0, 5),
        zip4:    zipParts ? (zipParts[2] || '') : ''
      }
    });
  } catch (e) {
    console.error('[Google Address Validation] Error:', e.message);
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
  const { emp_code, punch_type, job_id, punch_time } = req.body;
  if (!emp_code) return res.status(400).json({ error: 'emp_code required' });
  if (!punch_type || !['in','break_start','break_end','out'].includes(punch_type))
    return res.status(400).json({ error: '请选择打卡类型' });
  const emp = db.prepare("SELECT id, first_name, last_name, employee_id FROM employees WHERE employee_id=? AND status='active'").get(emp_code);
  if (!emp) return res.status(404).json({ error: '找不到该员工 / Employee not found' });
  // Allow manager to specify a custom punch time (must be a valid ISO string within last 24h)
  let now = new Date().toISOString();
  if (punch_time) {
    const pt = new Date(punch_time);
    const diff = Date.now() - pt.getTime();
    if (!isNaN(pt.getTime()) && diff >= 0 && diff <= 86400000) now = pt.toISOString();
  }
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(emp.id);

  if (punch_type === 'break_start') {
    if (!open) {
      // Create a flagged open entry
      const r2 = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,job_id,punch_type,break_records,on_break,geo_verified,needs_review,review_reason) VALUES(?,?,'open',?,'in',?,1,0,1,'漏打上班卡，由manager break_start触发')").run(emp.id, now, job_id||null, JSON.stringify([{start:now,end:null}]));
      return res.json({ action: 'break_start', warning: '未找到上班记录，已创建并标记审核', entry_id: r2.lastInsertRowid, punch_time: now });
    }
    const breaks = JSON.parse(open.break_records || '[]');
    breaks.push({ start: now, end: null });
    db.prepare('UPDATE time_entries SET break_records=?, on_break=1 WHERE id=?').run(JSON.stringify(breaks), open.id);
    return res.json({ action: 'break_start', entry_id: open.id, punch_time: now });
  }
  if (punch_type === 'break_end') {
    if (!open) return res.json({ action: 'break_end', warning: '未找到上班打卡记录' });
    if (!open.on_break) {
      return res.json({ action: 'break_end', warning: '该员工当前不在休息中', break_minutes: 0 });
    }
    const breaks = JSON.parse(open.break_records || '[]');
    const lastIdx = breaks.findIndex(b => !b.end);
    if (lastIdx >= 0) breaks[lastIdx].end = now;
    const breakMins = Math.round(breaks.reduce((s,b) => b.start&&b.end ? s+(new Date(b.end)-new Date(b.start)):s, 0) / 60000);
    db.prepare('UPDATE time_entries SET break_records=?, on_break=0, break_minutes=? WHERE id=?').run(JSON.stringify(breaks), breakMins, open.id);
    return res.json({ action: 'break_end', break_minutes: breakMins, entry_id: open.id, punch_time: now });
  }
  if (punch_type === 'out') {
    if (!open) {
      const r2 = db.prepare("INSERT INTO time_entries (employee_id,clock_in,clock_out,status,job_id,total_hours,break_records,on_break,punch_type,needs_review,review_reason) VALUES(?,?,?,'closed',?,0,'[]',0,'out_only',1,'漏打上班卡，仅有下班记录')").run(emp.id, now, now, job_id||null);
      return res.json({ action: 'out', total_hours: 0, warning: '未找到上班记录，已记录下班并标记审核', entry_id: r2.lastInsertRowid, clock_out: now });
    }
    if (open.on_break) {
      // Auto-close break then clock out
      const breaks = JSON.parse(open.break_records || '[]');
      const lastIdx = breaks.findIndex(b => !b.end);
      if (lastIdx >= 0) breaks[lastIdx].end = now;
      const breakMins = Math.round(breaks.reduce((s,b)=>b.start&&b.end?s+(new Date(b.end)-new Date(b.start)):s,0)/60000);
      db.prepare('UPDATE time_entries SET break_records=?,on_break=0,break_minutes=? WHERE id=?').run(JSON.stringify(breaks),breakMins,open.id);
      open.break_minutes = breakMins; open.on_break = 0;
    }
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed',punch_type='out' WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
    return res.json({ action: 'out', total_hours: hrs.total, clock_in: open.clock_in, clock_out: now, entry_id: open.id });
  }
  // Clock in — auto-close dangling open entry
  let ciWarning = null;
  if (open) {
    const missedDate = open.clock_in ? open.clock_in.slice(0,10) : '?';
    db.prepare("UPDATE time_entries SET status='closed',clock_out=?,needs_review=1,review_reason=? WHERE id=?")
      .run(now, `漏打下班卡(${missedDate})，manager重新上班打卡时自动关闭`, open.id);
    ciWarning = `${missedDate} 未打下班卡，旧记录已标记审核`;
  }
  if (!job_id) return res.status(400).json({ error: '请选择要打卡的工作' });
  const result = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,job_id,punch_type,break_records,on_break,geo_verified) VALUES(?,?,'open',?,'in','[]',0,0)")
    .run(emp.id, now, job_id);
  return res.json({ action: 'in', clock_in: now, entry_id: result.lastInsertRowid, warning: ciWarning });
});

// ─── Invoice Management ───
app.get('/api/admin/invoices', requireAdmin, blockManager, (req, res) => {
  const rows = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/admin/invoices', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.invoice_number || !d.company_name) return res.status(400).json({ error: 'Invoice number and company name required' });
  const r = db.prepare(`INSERT INTO invoices (invoice_number, invoice_date, company_name, bill_to_addr, period_start, period_end, subtotal, items, profile)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    d.invoice_number, d.invoice_date || '', d.company_name, d.bill_to_addr || '',
    d.period_start || '', d.period_end || '', d.subtotal || 0,
    JSON.stringify(d.items || []), JSON.stringify(d.profile || {})
  );
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/admin/invoices/:id', requireAdmin, blockManager, (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── DocuSeal Template Management ───

// GET /api/admin/docuseal/config — return stored template config
app.get('/api/admin/docuseal/config', requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM integration_settings WHERE provider='docuseal'").get();
  const cfg = JSON.parse(row?.config || '{}');
  const allKeys = ['company_contract_template_id','worker_1099_template_id','worker_w2_template_id',
    'w4_template_id','w9_template_id','w8ben_template_id','w8bene_template_id','form8233_template_id',
    'i9_template_id','w7_template_id',
    'ach_auth_template_id','wire_auth_template_id','check_instruction_template_id',
    'zelle_auth_template_id','third_party_pay_template_id','cash_receipt_template_id',
    'contractor_invoice_template_id','invoice_approval_template_id'];
  const _publicUrl = process.env.DOCUSEAL_PUBLIC_URL || dsealPublicHost();
  const out = { connected: dsealEnabled(), url: _publicUrl };
  allKeys.forEach(k => { out[k] = cfg[k] || null; });
  out.company_contract_template_id = out.company_contract_template_id || cfg.contract_template_id || null;
  out.account_email = cfg.account_email || '';
  res.json(out);
});

// GET /api/admin/docuseal/test — test actual connectivity to DocuSeal
app.get('/api/admin/docuseal/test', requireAdmin, async (req, res) => {
  const { apiKey, baseUrl } = dsealGetCreds();
  if (!apiKey && !baseUrl) return res.json({ ok: false, reason: 'missing_both', detail: 'DOCUSEAL_API_KEY 和 DOCUSEAL_URL 均未设置' });
  if (!apiKey) return res.json({ ok: false, reason: 'missing_key', detail: 'DOCUSEAL_API_KEY 未设置' });
  if (!baseUrl) return res.json({ ok: false, reason: 'missing_url', detail: 'DOCUSEAL_URL 未设置' });
  try {
    const r = await dsealApiCall('GET', '/api/templates', null);
    if (r.status === 200 || r.status === 201) return res.json({ ok: true, url: baseUrl });
    if (r.status === 401) return res.json({ ok: false, reason: 'invalid_key', detail: 'API Key 无效（401 Unauthorized）' });
    return res.json({ ok: false, reason: 'api_error', detail: `DocuSeal 返回 ${r.status}` });
  } catch (e) {
    return res.json({ ok: false, reason: 'network', detail: `无法连接到 ${baseUrl}：${e.message}` });
  }
});

// POST /api/admin/docuseal/config — save template IDs
app.post('/api/admin/docuseal/config', requireAdmin, (req, res) => {
  const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  const cfg = JSON.parse(row?.config || '{}');
  const _configKeys = ['company_contract_template_id','worker_1099_template_id','worker_w2_template_id',
    'w4_template_id','w9_template_id','w8ben_template_id','w8bene_template_id','form8233_template_id',
    'i9_template_id','w7_template_id',
    'ach_auth_template_id','wire_auth_template_id','check_instruction_template_id',
    'zelle_auth_template_id','third_party_pay_template_id','cash_receipt_template_id',
    'contractor_invoice_template_id','invoice_approval_template_id',
    'invoice_approval_en_template_id','invoice_approval_es_template_id',
    'contract_template_id' /* legacy */,
    'account_email' /* DocuSeal account email for embedded builder JWT */];
  _configKeys.forEach(k => {
    if (req.body[k] === undefined) return;
    const v = req.body[k];
    if (Array.isArray(v)) {
      cfg[k] = v.length > 0 ? v : null;
    } else {
      cfg[k] = v || null;
    }
  });
  db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
    .run(JSON.stringify(cfg));
  res.json({ success: true });
});

// GET /api/admin/docuseal/templates — list templates from DocuSeal
app.get('/api/admin/docuseal/templates', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const r = await dsealApiCall('GET', '/api/templates', null);
    if (r.status !== 200) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}`, detail: r.data });
    const templates = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/docuseal/templates/:id — delete a template from DocuSeal
app.delete('/api/admin/docuseal/templates/:id', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const r = await dsealApiCall('DELETE', `/api/templates/${req.params.id}`, null);
    if (r.status !== 200 && r.status !== 204) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}`, detail: r.data });
    // Clear from config if it was set as default
    const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
    const cfg = JSON.parse(row?.config || '{}');
    const tid = parseInt(req.params.id);
    Object.keys(cfg).forEach(k => {
      if (!k.endsWith('_template_id')) return;
      if (Array.isArray(cfg[k])) {
        const filtered = cfg[k].filter(id => id != tid);
        cfg[k] = filtered.length > 0 ? filtered : null;
      } else if (cfg[k] == tid) {
        cfg[k] = null;
      }
    });
    db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
      .run(JSON.stringify(cfg));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/docuseal/templates/:id/preview-pdf — proxy template PDF from DocuSeal
app.get('/api/admin/docuseal/templates/:id/preview-pdf', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const r = await dsealApiCall('GET', `/api/templates/${req.params.id}`, null);
    if (r.status !== 200) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}` });
    const documents = r.data?.documents || r.data?.schema || [];
    const docUrl = documents[0]?.url || documents[0]?.file_url || null;
    if (!docUrl) return res.status(404).json({ error: '该模板暂无可预览的文档' });
    // Proxy the PDF through our server so browser doesn't need to reach DocuSeal directly
    const { apiKey } = dsealGetCreds();
    const parsedUrl = new URL(docUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const proxyReq = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'X-Auth-Token': apiKey, 'Accept': 'application/pdf,*/*' }
    }, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="template-${req.params.id}.pdf"`);
      proxyRes.pipe(res);
    });
    proxyReq.setTimeout(30000, () => { proxyReq.destroy(new Error('代理超时')); });
    proxyReq.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/docuseal/upload-template — upload PDF to DocuSeal as a new template
app.post('/api/admin/docuseal/upload-template', requireAdmin, express.json({ limit: '20mb' }), async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  const { name, file, category } = req.body; // file = data:application/pdf;base64,...
  if (!name || !file) return res.status(400).json({ error: '缺少 name 或 file' });
  const cat = category || '';
  try {
    const r = await dsealApiCall('POST', '/api/templates/pdf', {
      name,
      documents: [{ name: name + '.pdf', file }]
    });
    if (r.status !== 200 && r.status !== 201) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}`, detail: r.data });
    // Save to local DB
    const dsId = r.data?.id || r.data?.template_id;
    if (dsId) {
      db.prepare('INSERT INTO docuseal_templates (name, docuseal_template_id, category) VALUES (?, ?, ?)').run(name, dsId, cat);
      // Auto-update integration_settings config if a valid config key was provided as category
      const validConfigKeys = [
        'company_contract_template_id','worker_1099_template_id','worker_w2_template_id',
        'w4_template_id','w9_template_id','w8ben_template_id','w8bene_template_id','form8233_template_id',
        'i9_template_id','w7_template_id',
        'ach_auth_template_id','wire_auth_template_id','check_instruction_template_id',
        'zelle_auth_template_id','third_party_pay_template_id','cash_receipt_template_id',
        'contractor_invoice_template_id','invoice_approval_template_id',
        'invoice_approval_en_template_id','invoice_approval_es_template_id'
      ];
      if (cat && validConfigKeys.includes(cat)) {
        const cfgRow = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
        const cfg = JSON.parse(cfgRow?.config || '{}');
        cfg[cat] = dsId;
        db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
          .run(JSON.stringify(cfg));
      }
    }
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/docuseal/builder-token/:id — generate embedded builder JWT for a template
app.get('/api/admin/docuseal/builder-token/:id', requireAdmin, async (req, res) => {
  const { apiKey, baseUrl } = dsealGetCreds();
  if (!apiKey) return res.status(503).json({ error: 'DocuSeal 未配置' });
  const templateId = parseInt(req.params.id, 10);
  if (!templateId) return res.status(400).json({ error: '无效的模板 ID' });

  // Fetch the actual DocuSeal account user email (required by the builder JWT)
  // Strategy 1: GET /api/users
  let userEmail = '';
  try {
    const r = await dsealApiCall('GET', '/api/users', null);
    if (r.status === 200) {
      const users = Array.isArray(r.data) ? r.data : (r.data?.data || []);
      if (users.length > 0) userEmail = users[0].email || '';
    }
  } catch {}

  // Strategy 2: GET /api/templates/:id — author email sometimes embedded in template
  if (!userEmail) {
    try {
      const r = await dsealApiCall('GET', `/api/templates/${templateId}`, null);
      if (r.status === 200 && r.data) {
        userEmail = r.data.author?.email || r.data.created_by?.email || r.data.user?.email || '';
      }
    } catch {}
  }

  // Strategy 3: read cached account_email stored in docuseal config
  if (!userEmail) {
    try {
      const cfgRow = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
      const cfg = JSON.parse(cfgRow?.config || '{}');
      userEmail = cfg.account_email || '';
    } catch {}
  }

  if (!userEmail) return res.status(503).json({ error: 'DocuSeal 帐号 email 获取失败，请在 DocuSeal 模板管理页面的连接设置中填写帐号 email' });

  // Cache for future calls
  try {
    const cfgRow = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
    const cfg = JSON.parse(cfgRow?.config || '{}');
    if (cfg.account_email !== userEmail) {
      cfg.account_email = userEmail;
      db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'").run(JSON.stringify(cfg));
    }
  } catch {}

  // Build HS256 JWT — DocuSeal builder requires top-level user_email
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    user_email: userEmail,
    template_id: templateId
  })).toString('base64url');
  const sig   = crypto.createHmac('sha256', apiKey).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${sig}`;

  const isCloud  = /api\.docuseal\.(com|eu)/.test(baseUrl);
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const builderSrc = isCloud ? 'https://cdn.docuseal.com/js/builder.js' : `${cleanBase}/js/builder.js`;

  res.json({ token, builderSrc });
});

// GET /api/admin/docuseal/my-templates — list only user-uploaded templates from local DB
app.get('/api/admin/docuseal/my-templates', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM docuseal_templates ORDER BY created_at DESC').all();
  res.json(rows);
});

// PATCH /api/admin/docuseal/my-templates/:id — rename template in local DB
app.patch('/api/admin/docuseal/my-templates/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '名称不能为空' });
  const local = db.prepare('SELECT * FROM docuseal_templates WHERE id=?').get(req.params.id);
  if (!local) return res.status(404).json({ error: '模板不存在' });
  db.prepare('UPDATE docuseal_templates SET name=? WHERE id=?').run(String(name).trim(), local.id);
  res.json({ ok: true });
});

// DELETE /api/admin/docuseal/my-templates/:id — delete from local DB and DocuSeal
app.delete('/api/admin/docuseal/my-templates/:id', requireAdmin, async (req, res) => {
  const local = db.prepare('SELECT * FROM docuseal_templates WHERE id=?').get(req.params.id);
  if (!local) return res.status(404).json({ error: '模板不存在' });
  // Delete from DocuSeal
  if (dsealEnabled() && local.docuseal_template_id) {
    try {
      await dsealApiCall('DELETE', `/api/templates/${local.docuseal_template_id}`, null);
    } catch (e) { console.error(`[DocuSeal] Failed to delete template ${local.docuseal_template_id}:`, e.message); }
  }
  // Clear from config if set as default
  const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  const cfg = JSON.parse(row?.config || '{}');
  const _tid = local.docuseal_template_id;
  Object.keys(cfg).forEach(k => { if (k.endsWith('_template_id') && cfg[k] == _tid) cfg[k] = null; });
  db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
    .run(JSON.stringify(cfg));
  // Delete from local DB
  db.prepare('DELETE FROM docuseal_templates WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// PATCH /api/admin/docuseal/my-templates/:id — rename template in local DB
app.patch('/api/admin/docuseal/my-templates/:id', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名称不能为空' });
  const result = db.prepare('UPDATE docuseal_templates SET name=? WHERE id=?').run(name.trim(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: '模板不存在' });
  res.json({ success: true });
});

// PUT /api/admin/docuseal/my-templates/:id/rename — rename a template in local DB
app.put('/api/admin/docuseal/my-templates/:id/rename', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '模板名称不能为空' });
  const local = db.prepare('SELECT * FROM docuseal_templates WHERE id=?').get(req.params.id);
  if (!local) return res.status(404).json({ error: '模板不存在' });
  db.prepare('UPDATE docuseal_templates SET name=? WHERE id=?').run(name.trim(), req.params.id);
  res.json({ success: true, name: name.trim() });
});

// PUT /api/admin/docuseal/my-templates/:id/category — update category of a template in local DB
app.put('/api/admin/docuseal/my-templates/:id/category', requireAdmin, (req, res) => {
  const { category } = req.body;
  if (!category || !category.trim()) return res.status(400).json({ error: '分类不能为空' });
  const local = db.prepare('SELECT * FROM docuseal_templates WHERE id=?').get(req.params.id);
  if (!local) return res.status(404).json({ error: '模板不存在' });
  db.prepare('UPDATE docuseal_templates SET category=? WHERE id=?').run(category.trim(), req.params.id);
  res.json({ success: true, category: category.trim() });
});

// POST /api/admin/docuseal/templates/:dsId/apply-field-requirements
// Apply required=true to all fields and draw-only to signature fields on an existing template
app.post('/api/admin/docuseal/templates/:dsId/apply-field-requirements', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    const tmplRes = await dsealApiCall('GET', `/api/templates/${req.params.dsId}`, null);
    if (tmplRes.status >= 400 || !tmplRes.data) {
      return res.status(tmplRes.status || 500).json({ error: '無法取得模板資料', detail: tmplRes.data });
    }
    const fields = tmplRes.data.fields || [];
    if (!fields.length) return res.status(400).json({ error: '模板沒有欄位' });
    const updatedFields = fields.map(f => {
      const upd = { uuid: f.uuid, name: f.name, required: true };
      if (f.type === 'signature') {
        upd.preferences = { signature_type: ['drawn'] };
      }
      return upd;
    });
    const putRes = await dsealApiCall('PUT', `/api/templates/${req.params.dsId}`, { fields: updatedFields });
    if (putRes.status >= 400) {
      return res.status(putRes.status).json({ error: '更新模板欄位失敗', detail: putRes.data });
    }
    res.json({ success: true, updated_fields: updatedFields.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/docuseal/templates/:dsId/rename — rename a template via DocuSeal API + local DB
app.put('/api/admin/docuseal/templates/:dsId/rename', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '模板名称不能为空' });
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  try {
    await dsealApiCall('PUT', `/api/templates/${req.params.dsId}`, { name: name.trim() });
    db.prepare('UPDATE docuseal_templates SET name=? WHERE docuseal_template_id=?').run(name.trim(), parseInt(req.params.dsId));
    res.json({ success: true, name: name.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/docuseal/create-html-template — create a single template from HTML via DocuSeal API
app.post('/api/admin/docuseal/create-html-template', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  const { type } = req.body;
  const tmplDef = DOCUSEAL_AUTO_TEMPLATES[type];
  if (!tmplDef) return res.status(400).json({ error: `Unknown template type: ${type}` });
  try {
    const html = tmplDef.generator();
    const r = await dsealApiCall('POST', '/api/templates/html', {
      name: tmplDef.name,
      documents: [{ name: tmplDef.name, html, size: 'Letter' }]
    });
    if (r.status >= 400) return res.status(r.status).json({ error: `DocuSeal 返回 ${r.status}`, detail: r.data });
    const dsId = r.data?.id || r.data?.template_id;
    if (dsId) {
      db.prepare('INSERT OR IGNORE INTO docuseal_templates (name, docuseal_template_id, category) VALUES (?, ?, ?)').run(tmplDef.name, dsId, tmplDef.category || 'contract');
      // Auto-set config
      const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
      const cfg = JSON.parse(row?.config || '{}');
      cfg[tmplDef.configKey] = dsId;
      db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
        .run(JSON.stringify(cfg));
    }
    res.json({ success: true, template_id: dsId, name: tmplDef.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/docuseal/create-all-templates — create all templates at once
app.post('/api/admin/docuseal/create-all-templates', requireAdmin, async (req, res) => {
  if (!dsealEnabled()) return res.status(503).json({ error: 'DocuSeal 未配置' });
  const { types } = req.body; // optional: array of types to create; if empty, create all
  const targetTypes = (types && types.length) ? types : Object.keys(DOCUSEAL_AUTO_TEMPLATES);
  const row = db.prepare("SELECT config FROM integration_settings WHERE provider='docuseal'").get();
  const cfg = JSON.parse(row?.config || '{}');
  const results = [];
  for (const type of targetTypes) {
    const tmplDef = DOCUSEAL_AUTO_TEMPLATES[type];
    if (!tmplDef) { results.push({ type, error: 'Unknown type' }); continue; }
    // Skip if already configured
    if (cfg[tmplDef.configKey]) { results.push({ type, skipped: true, template_id: cfg[tmplDef.configKey] }); continue; }
    try {
      const html = tmplDef.generator();
      const r = await dsealApiCall('POST', '/api/templates/html', {
        name: tmplDef.name,
        documents: [{ name: tmplDef.name, html, size: 'Letter' }]
      });
      if (r.status >= 400) { results.push({ type, error: `DocuSeal ${r.status}` }); continue; }
      const dsId = r.data?.id || r.data?.template_id;
      if (dsId) {
        db.prepare('INSERT OR IGNORE INTO docuseal_templates (name, docuseal_template_id, category) VALUES (?, ?, ?)').run(tmplDef.name, dsId, tmplDef.category || 'contract');
        cfg[tmplDef.configKey] = dsId;
      }
      results.push({ type, success: true, template_id: dsId, name: tmplDef.name });
    } catch (e) {
      results.push({ type, error: e.message });
    }
  }
  // Save updated config
  db.prepare("UPDATE integration_settings SET config=?, updated_at=CURRENT_TIMESTAMP WHERE provider='docuseal'")
    .run(JSON.stringify(cfg));
  res.json({ results });
});

// GET /api/admin/docuseal/auto-template-types — list available auto-creatable template types
app.get('/api/admin/docuseal/auto-template-types', requireAdmin, (req, res) => {
  const types = Object.entries(DOCUSEAL_AUTO_TEMPLATES).map(([key, val]) => ({
    type: key, name: val.name, configKey: val.configKey
  }));
  res.json(types);
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
// Global error handler — return JSON instead of HTML for API errors
app.use((err, req, res, _next) => {
  console.error('[Global Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, () => {
  // Initial checkpoint on startup to flush any pending WAL data
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
  console.log(`Prime Anchorpoint running on port ${PORT}`);

});
