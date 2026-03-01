const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database Setup ───
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Employee docs stored separately (never served as static files)
const docsDir = path.join(dataDir, 'employee_docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

const db = new Database(path.join(dataDir, 'prime.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_auth TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN benefits TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN company_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN company_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN employment_type TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_days TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_start TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN work_end TEXT DEFAULT ''`); } catch(e) {}

try { db.exec("ALTER TABLE inquiries ADD COLUMN employer_id TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN processed INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN proc_status TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN proc_note TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE inquiries ADD COLUMN processed_at DATETIME DEFAULT NULL"); } catch(e) {}

// Migrate admin_users table (add role, display_name, active, created_at columns if missing)
['role TEXT DEFAULT \'staff\'', 'display_name TEXT DEFAULT \'\'', 'active INTEGER DEFAULT 1', 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'].forEach(col => {
  try { db.exec(`ALTER TABLE admin_users ADD COLUMN ${col}`); } catch {}
});

// Migrate partners table (add new columns if missing)
const partnerMigrations = ['contacts','addresses','social_media','links'];
partnerMigrations.forEach(col => {
  try { db.exec(`ALTER TABLE partners ADD COLUMN ${col} TEXT DEFAULT '${col.includes('s')&&!col.includes('_')?'[]':'{}'}'`); } catch {}
});

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

// ─── Middleware ───
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
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

// Seed default admin into admin_users table if empty
{
  const count = db.prepare('SELECT COUNT(*) as n FROM admin_users').get().n;
  if (count === 0) {
    const defaultUser = process.env.ADMIN_USER || 'admin';
    const defaultPass = process.env.ADMIN_PASS || 'prime2026';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(defaultPass, salt);
    db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name) VALUES (?, ?, ?, ?, ?)').run(defaultUser, hash, salt, 'admin', 'Administrator');
    console.log(`[Auth] Seeded default admin user: ${defaultUser}`);
  }
  // Ensure the first user (original seeded admin) has admin role
  try { db.prepare("UPDATE admin_users SET role='admin' WHERE id=1 AND (role IS NULL OR role='staff')").run(); } catch {}
}

// In-memory session store (tokens expire in 24h)
const sessions = new Map();
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now(), userId: user.id, username: user.username, role: user.role || 'staff' });
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.created > 24 * 60 * 60 * 1000) { sessions.delete(token); return null; }
  return s;
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

// ─── PUBLIC API ───

// GET /api/jobs - public job listings
app.get('/api/jobs', (req, res) => {
  const lang = req.query.lang;
  let jobs;
  if (lang && lang !== 'all') {
    jobs = db.prepare('SELECT * FROM jobs WHERE active=1 AND lang=? ORDER BY created_at DESC').all(lang);
  } else {
    jobs = db.prepare('SELECT * FROM jobs WHERE active=1 ORDER BY created_at DESC').all();
  }
  res.json(jobs.map(j => ({
    id: j.id, title: j.title, type: j.type, location: j.location,
    pay: j.pay, lang: j.lang, lang_name: j.lang_name,
    desc: j.description, urgent: !!j.urgent, work_auth: j.work_auth || '',
    benefits: j.benefits || '', schedule: j.schedule || '',
    company_name: j.company_name || '', employment_type: j.employment_type || '',
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
    const stmt = db.prepare(`INSERT INTO inquiries (name, email, phone, company, type, employer_id, positions, workers, location, start_date, experience, languages, comments, resume_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(
      d.name, d.email || '', d.phone || '', d.company || '', d.type || '',
      employerId,
      d.positions || '', d.workers || '', d.location || '', d.start_date || '',
      d.experience || '', d.languages || '', d.comments || '',
      req.file ? req.file.filename : ''
    );
    res.json({ success: true, id: result.lastInsertRowid, employer_id: employerId || undefined });
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
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid username or password' });
  if (user && verifyPassword(password, user.salt, user.password_hash)) {
    const token = createSession(user);
    res.json({ success: true, token, role: user.role || 'staff', username: user.username, display_name: user.display_name || '' });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// Get current user info
app.get('/api/admin/me', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, username, role, display_name FROM admin_users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ─── Account Management (admin only) ───
app.get('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id, username, role, display_name, active, created_at FROM admin_users ORDER BY id').all());
});

app.post('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, salt, role, display_name || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, active } = req.body;
  if (role && !['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare('UPDATE admin_users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, req.params.id);
  }
  db.prepare('UPDATE admin_users SET username=?, role=?, display_name=?, active=? WHERE id=?')
    .run(username || user.username, role || user.role, display_name !== undefined ? display_name : user.display_name, active !== undefined ? active : user.active, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
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

// Jobs CRUD
app.get('/api/admin/jobs', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all());
});

app.post('/api/admin/jobs', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  const stmt = db.prepare('INSERT INTO jobs (title, type, location, pay, lang, lang_name, description, urgent, work_auth, benefits, schedule, company_id, company_name, employment_type, work_days, work_start, work_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const r = stmt.run(d.title, d.type || '', d.location || '', d.pay || '', d.lang || 'en', d.lang_name || 'English', d.description || '', d.urgent ? 1 : 0, d.work_auth || '', d.benefits || '', d.schedule || '', d.company_id || null, d.company_name || '', d.employment_type || '', d.work_days || '', d.work_start || '', d.work_end || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/jobs/:id', requireAdmin, blockManager, staffGuard('update', 'jobs'), (req, res) => {
  const d = req.body;
  db.prepare('UPDATE jobs SET title=?, type=?, location=?, pay=?, lang=?, lang_name=?, description=?, urgent=?, active=?, work_auth=?, benefits=?, schedule=?, company_id=?, company_name=?, employment_type=?, work_days=?, work_start=?, work_end=? WHERE id=?')
    .run(d.title, d.type || '', d.location || '', d.pay || '', d.lang || 'en', d.lang_name || 'English', d.description || '', d.urgent ? 1 : 0, d.active !== false ? 1 : 0, d.work_auth || '', d.benefits || '', d.schedule || '', d.company_id || null, d.company_name || '', d.employment_type || '', d.work_days || '', d.work_start || '', d.work_end || '', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/jobs/:id', requireAdmin, blockManager, staffGuard('delete', 'jobs'), (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Inquiries
app.get('/api/admin/inquiries', requireAdmin, blockManager, (req, res) => {
  const history = req.query.history === '1';
  const rows = db.prepare(
    `SELECT * FROM inquiries WHERE processed=? ORDER BY created_at DESC`
  ).all(history ? 1 : 0);
  res.json(rows);
});

app.put('/api/admin/inquiries/:id/process', requireAdmin, blockManager, (req, res) => {
  const { status, note, undo } = req.body;
  if (undo) {
    db.prepare('UPDATE inquiries SET processed=0, proc_status=\'\', proc_note=\'\', processed_at=NULL WHERE id=?').run(req.params.id);
  } else {
    const valid = ['cooperated','rejected','unreachable'];
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
  const { inquiry_id, job_id, notes } = req.body;
  if (!inquiry_id || !job_id) return res.status(400).json({ error: 'inquiry_id and job_id required' });
  const r = db.prepare('INSERT INTO assignments (inquiry_id, job_id, notes) VALUES (?, ?, ?)').run(inquiry_id, job_id, notes || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/assignments/:id', requireAdmin, blockManager, staffGuard('update', 'assignments'), (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE assignments SET status=?, notes=? WHERE id=?').run(status || 'assigned', notes || '', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/assignments/:id', requireAdmin, blockManager, staffGuard('delete', 'assignments'), (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
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
  const rows = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM time_entries t WHERE t.employee_id = e.id) as time_count,
      (SELECT COUNT(*) FROM employee_documents d WHERE d.employee_id = e.id) as doc_count,
      (SELECT COUNT(*) FROM background_checks b WHERE b.employee_id = e.id) as bg_count
    FROM employees e ORDER BY e.last_name, e.first_name
  `).all();
  res.json(rows.map(safeEmp));
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
  const ssn_full = emp.ssn_encrypted && emp.ssn_iv ? decryptSSN(emp.ssn_encrypted, emp.ssn_iv) : null;
  res.json({ ...safeEmp(emp), ssn_full, documents: docs, background_checks: bgChecks, recent_time: recentTime });
});

app.post('/api/admin/employees', requireAdmin, blockManager, (req, res) => {
  const d = req.body;
  if (!d.first_name || !d.last_name) return res.status(400).json({ error: '请填写姓名' });
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
      (employee_id,first_name,last_name,email,phone,address,city,state,zip,dob,
       emergency_name,emergency_phone,emergency_relation,hire_date,position,department,
       pay_rate,pay_type,status,pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      empId,d.first_name,d.last_name,d.email||'',d.phone||'',d.address||'',
      d.city||'',d.state||'',d.zip||'',d.dob||'',
      d.emergency_name||'',d.emergency_phone||'',d.emergency_relation||'',
      d.hire_date||'',d.position||'',d.department||'',
      parseFloat(d.pay_rate)||0,d.pay_type||'hourly',d.status||'active',
      pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,d.notes||'');
    res.json({ success: true, id: r.lastInsertRowid, employee_id: empId });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '员工编号已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/employees/:id', requireAdmin, blockManager, staffGuard('update', 'employees'), (req, res) => {
  const d = req.body;
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
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
    employee_id=?,first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,dob=?,
    emergency_name=?,emergency_phone=?,emergency_relation=?,hire_date=?,position=?,department=?,
    pay_rate=?,pay_type=?,status=?,pin_hash=?,pin_salt=?,ssn_encrypted=?,ssn_iv=?,ssn_last4=?,notes=?
    WHERE id=?`).run(
    d.employee_id||emp.employee_id,d.first_name,d.last_name,d.email||'',d.phone||'',d.address||'',
    d.city||'',d.state||'',d.zip||'',d.dob||'',
    d.emergency_name||'',d.emergency_phone||'',d.emergency_relation||'',
    d.hire_date||'',d.position||'',d.department||'',
    parseFloat(d.pay_rate)||0,d.pay_type||'hourly',d.status||'active',
    pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,d.notes||'',req.params.id);
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
  const rows = db.prepare(`
    SELECT ts.*, e.first_name, e.last_name, e.employee_id as emp_code, e.email, e.phone
    FROM timesheet_sheets ts LEFT JOIN employees e ON ts.employee_id=e.id
    ORDER BY ts.created_at DESC LIMIT 300`).all();
  res.json(rows);
});

// ─── PUBLIC TIMESHEET CONFIRMATION ───

// Get sheet data (no auth — token is the secret)
app.get('/api/ts/:token', (req, res) => {
  const sheet = db.prepare(`
    SELECT ts.*, e.first_name, e.last_name, e.employee_id as emp_code, e.email, e.phone
    FROM timesheet_sheets ts LEFT JOIN employees e ON ts.employee_id=e.id
    WHERE ts.confirm_token=?`).get(req.params.token);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const entries = db.prepare(
    `SELECT * FROM time_entries WHERE sheet_id=? ORDER BY clock_in`).all(sheet.id);
  res.json({ sheet, entries });
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
    res.json({ action: 'out', clock_in: open.clock_in, clock_out: now, ...hrs });
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
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`Prime Anchorpoint running on port ${PORT}`);
});
