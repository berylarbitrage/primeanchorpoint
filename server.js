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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    company TEXT DEFAULT '',
    type TEXT DEFAULT '',
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    salt TEXT NOT NULL
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
`);

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

// ─── Auto-generate employee ID ───
function nextEmployeeId() {
  const last = db.prepare("SELECT employee_id FROM employees WHERE employee_id LIKE 'EMP%' ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'EMP001';
  const num = parseInt(last.employee_id.replace('EMP', ''), 10) + 1;
  return 'EMP' + String(num).padStart(3, '0');
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
    db.prepare('INSERT INTO admin_users (username, password_hash, salt) VALUES (?, ?, ?)').run(defaultUser, hash, salt);
    console.log(`[Auth] Seeded default admin user: ${defaultUser}`);
  }
}

// In-memory session store (tokens expire in 24h)
const sessions = new Map();
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  return token;
}
function validSession(token) {
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.created > 24 * 60 * 60 * 1000) { sessions.delete(token); return false; }
  return true;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && validSession(auth.slice(7))) return next();
  // Check cookie
  const cookieMatch = (req.headers.cookie || '').match(/pa_token=([^;]+)/);
  if (cookieMatch && validSession(cookieMatch[1])) return next();
  res.status(401).json({ error: 'Unauthorized' });
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
    desc: j.description, urgent: !!j.urgent
  })));
});

// POST /api/inquiry - submit contact form
app.post('/api/inquiry', upload.single('resume'), (req, res) => {
  try {
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name required' });
    const stmt = db.prepare(`INSERT INTO inquiries (name, email, phone, company, type, positions, workers, location, start_date, experience, languages, comments, resume_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(
      d.name, d.email || '', d.phone || '', d.company || '', d.type || '',
      d.positions || '', d.workers || '', d.location || '', d.start_date || '',
      d.experience || '', d.languages || '', d.comments || '',
      req.file ? req.file.filename : ''
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
  if (user && verifyPassword(password, user.salt, user.password_hash)) {
    const token = createSession();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// Jobs CRUD
app.get('/api/admin/jobs', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all());
});

app.post('/api/admin/jobs', requireAdmin, (req, res) => {
  const d = req.body;
  const stmt = db.prepare('INSERT INTO jobs (title, type, location, pay, lang, lang_name, description, urgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const r = stmt.run(d.title, d.type || '', d.location || '', d.pay || '', d.lang || 'en', d.lang_name || 'English', d.description || '', d.urgent ? 1 : 0);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const d = req.body;
  db.prepare('UPDATE jobs SET title=?, type=?, location=?, pay=?, lang=?, lang_name=?, description=?, urgent=?, active=? WHERE id=?')
    .run(d.title, d.type || '', d.location || '', d.pay || '', d.lang || 'en', d.lang_name || 'English', d.description || '', d.urgent ? 1 : 0, d.active !== false ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Inquiries
app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all());
});

app.delete('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM inquiries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Quotes
app.get('/api/admin/quotes', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all());
});

app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Partners CRUD
app.get('/api/admin/partners', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM partners ORDER BY created_at DESC').all());
});

app.post('/api/admin/partners', requireAdmin, (req, res) => {
  const d = req.body;
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  const stmt = db.prepare('INSERT INTO partners (name, contact_person, phone, email, address, industry, services, notes, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const r = stmt.run(d.name, d.contact_person || '', d.phone || '', d.email || '', d.address || '', d.industry || '', d.services || '', d.notes || '', d.active !== false ? 1 : 0);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/partners/:id', requireAdmin, (req, res) => {
  const d = req.body;
  db.prepare('UPDATE partners SET name=?, contact_person=?, phone=?, email=?, address=?, industry=?, services=?, notes=?, active=? WHERE id=?')
    .run(d.name, d.contact_person || '', d.phone || '', d.email || '', d.address || '', d.industry || '', d.services || '', d.notes || '', d.active !== false ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/partners/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Assignments CRUD
app.get('/api/admin/assignments', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, i.name AS inquiry_name, i.phone AS inquiry_phone, i.email AS inquiry_email, i.type AS inquiry_type,
           j.title AS job_title, j.location AS job_location, j.pay AS job_pay
    FROM assignments a
    LEFT JOIN inquiries i ON a.inquiry_id = i.id
    LEFT JOIN jobs j ON a.job_id = j.id
    ORDER BY a.assigned_at DESC
  `).all());
});

app.post('/api/admin/assignments', requireAdmin, (req, res) => {
  const { inquiry_id, job_id, notes } = req.body;
  if (!inquiry_id || !job_id) return res.status(400).json({ error: 'inquiry_id and job_id required' });
  const r = db.prepare('INSERT INTO assignments (inquiry_id, job_id, notes) VALUES (?, ?, ?)').run(inquiry_id, job_id, notes || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/assignments/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE assignments SET status=?, notes=? WHERE id=?').run(status || 'assigned', notes || '', req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/assignments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Backup management
app.get('/api/admin/backups', requireAdmin, (req, res) => {
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

app.post('/api/admin/backups/run', requireAdmin, (req, res) => {
  const result = runBackup('手动备份');
  res.json({ success: true, result });
});

// CSV Export (also accept token via query param for download links)
app.get('/api/admin/inquiries/export', (req, res, next) => {
  if (req.query.token && validSession(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const rows = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  const headers = ['Date', 'Name', 'Email', 'Phone', 'Company', 'Type', 'Positions', 'Workers', 'Location', 'Start Date', 'Experience', 'Languages', 'Comments'];
  let csv = headers.join(',') + '\n';
  rows.forEach(r => {
    csv += [r.created_at, r.name, r.email, r.phone, r.company, r.type, r.positions, r.workers, r.location, r.start_date, r.experience, r.languages, r.comments]
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

app.get('/api/admin/employees/:id', requireAdmin, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC').all(req.params.id);
  const bgChecks = db.prepare('SELECT * FROM background_checks WHERE employee_id=? ORDER BY created_at DESC').all(req.params.id);
  const recentTime = db.prepare('SELECT * FROM time_entries WHERE employee_id=? ORDER BY clock_in DESC LIMIT 20').all(req.params.id);
  const ssn_full = emp.ssn_encrypted && emp.ssn_iv ? decryptSSN(emp.ssn_encrypted, emp.ssn_iv) : null;
  res.json({ ...safeEmp(emp), ssn_full, documents: docs, background_checks: bgChecks, recent_time: recentTime });
});

app.post('/api/admin/employees', requireAdmin, (req, res) => {
  const d = req.body;
  if (!d.first_name || !d.last_name) return res.status(400).json({ error: '请填写姓名' });
  const empId = (d.employee_id || '').trim() || nextEmployeeId();
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

app.put('/api/admin/employees/:id', requireAdmin, (req, res) => {
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

app.delete('/api/admin/employees/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE employees SET status='terminated' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ─── DOCUMENT ROUTES ───

app.get('/api/admin/employees/:id/documents', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC').all(req.params.id));
});

app.post('/api/admin/employees/:id/documents', requireAdmin, docUpload.single('file'), (req, res) => {
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

app.delete('/api/admin/documents/:id', requireAdmin, (req, res) => {
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

app.post('/api/admin/time-entries', requireAdmin, (req, res) => {
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

app.put('/api/admin/time-entries/:id', requireAdmin, (req, res) => {
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

app.delete('/api/admin/time-entries/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── BACKGROUND CHECK ROUTES ───

app.get('/api/admin/background-checks', requireAdmin, (req, res) => {
  const { employee_id, status } = req.query;
  let q = `SELECT b.*, e.first_name, e.last_name, e.employee_id as emp_code
    FROM background_checks b LEFT JOIN employees e ON b.employee_id=e.id WHERE 1=1`;
  const p = [];
  if (employee_id) { q += ' AND b.employee_id=?'; p.push(employee_id); }
  if (status)      { q += ' AND b.status=?'; p.push(status); }
  q += ' ORDER BY b.created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/admin/background-checks', requireAdmin, docUpload.single('file'), (req, res) => {
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

app.put('/api/admin/background-checks/:id', requireAdmin, docUpload.single('file'), (req, res) => {
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

app.delete('/api/admin/background-checks/:id', requireAdmin, (req, res) => {
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

// ─── Admin Panel Page ───
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`Prime Anchorpoint running on port ${PORT}`);
});
