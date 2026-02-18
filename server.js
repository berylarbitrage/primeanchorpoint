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

// ─── ADMIN AUTH (username + password with session tokens) ───
const crypto = require('crypto');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'prime2026';

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

// ─── ADMIN API ───

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
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

// ─── Admin Panel Page ───
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`Prime Anchorpoint running on port ${PORT}`);
});
