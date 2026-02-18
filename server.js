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
`);

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

// ─── ADMIN AUTH (simple password) ───
const ADMIN_PASS = process.env.ADMIN_PASS || 'prime2026';

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${ADMIN_PASS}`) return next();
  // Check cookie
  if (req.headers.cookie && req.headers.cookie.includes(`pa_auth=${ADMIN_PASS}`)) return next();
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
  if (req.body.password === ADMIN_PASS) {
    res.json({ success: true, token: ADMIN_PASS });
  } else {
    res.status(401).json({ error: 'Wrong password' });
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

// CSV Export
app.get('/api/admin/inquiries/export', requireAdmin, (req, res) => {
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
