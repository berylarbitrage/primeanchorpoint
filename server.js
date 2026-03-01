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
db.pragma('wal_autocheckpoint = 100');

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
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_days TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_start TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN schedule_end TEXT DEFAULT ''`); } catch(e) {}
// Job status & closure tracking
try { db.exec(`ALTER TABLE jobs ADD COLUMN job_status TEXT DEFAULT 'open'`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN close_reason TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN close_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN headcount INTEGER DEFAULT 1`); } catch(e) {}
// Backfill job_status from active flag for existing rows
try { db.exec(`UPDATE jobs SET job_status='open' WHERE active=1 AND (job_status IS NULL OR job_status='')`); } catch(e) {}
try { db.exec(`UPDATE jobs SET job_status='closed' WHERE active=0 AND (job_status IS NULL OR job_status='')`); } catch(e) {}

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
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN client_paid INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN labor_paid INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN verified_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN client_paid_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN labor_paid_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE timesheet_sheets ADD COLUMN staff_note TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE employee_doc_requests ADD COLUMN lang TEXT DEFAULT 'zh'`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN extra_phones TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE employees ADD COLUMN extra_emails TEXT DEFAULT '[]'`); } catch(e) {}
try { db.exec(`ALTER TABLE inquiries ADD COLUMN job_id INTEGER DEFAULT NULL`); } catch(e) {}

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
  req.assignedPartnerIds = session.assigned_partner_ids || '';
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
  req.workerId = s.workerId;
  req.workerEmployeeId = s.employeeId;
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
  req.customerId = s.customerId;
  req.customerPartnerId = s.partnerId;
  next();
}

// ─── PUBLIC API ───

// GET /api/jobs - public job listings
app.get('/api/jobs', (req, res) => {
  const lang = req.query.lang;
  const base = `SELECT j.*, p.name as partner_name FROM jobs j LEFT JOIN partners p ON j.partner_id=p.id WHERE j.active=1`;
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
app.post('/api/jobs/:id/apply', (req, res) => {
  try {
    const job = db.prepare('SELECT id, title FROM jobs WHERE id=? AND active=1').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name required' });
    if (!d.phone) return res.status(400).json({ error: 'Phone required' });
    const result = db.prepare(`INSERT INTO inquiries (name, email, phone, type, positions, experience, comments, job_id) VALUES (?, ?, ?, 'Job Seeker', ?, ?, ?, ?)`).run(
      d.name, d.email || '', d.phone, job.title, d.experience || '', d.comments || '', job.id
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
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid username or password' });
  if (user && verifyPassword(password, user.salt, user.password_hash)) {
    const token = createSession(user);
    res.json({ success: true, token, user_id: user.id, role: user.role || 'staff', username: user.username, display_name: user.display_name || '' });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
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

// ─── Account Management (admin only) ───
app.get('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id, username, role, display_name, active, assigned_partner_ids, created_at FROM admin_users ORDER BY id').all());
});

app.post('/api/admin/accounts', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, assigned_partner_ids } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, salt, role, display_name, assigned_partner_ids) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, hash, salt, role, display_name || '', assigned_partner_ids || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  const { username, password, role, display_name, active, assigned_partner_ids } = req.body;
  if (role && !['admin', 'staff', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    db.prepare('UPDATE admin_users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, req.params.id);
  }
  db.prepare('UPDATE admin_users SET username=?, role=?, display_name=?, active=?, assigned_partner_ids=? WHERE id=?')
    .run(username || user.username, role || user.role, display_name !== undefined ? display_name : user.display_name, active !== undefined ? active : user.active, assigned_partner_ids !== undefined ? assigned_partner_ids : (user.assigned_partner_ids || ''), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Worker Accounts (admin manages) ───
app.get('/api/admin/worker-accounts', requireAdmin, requireRole('admin', 'staff'), (req, res) => {
  res.json(db.prepare(`
    SELECT w.*, e.first_name, e.last_name, e.employee_id as emp_code
    FROM worker_accounts w LEFT JOIN employees e ON w.employee_id=e.id ORDER BY w.id DESC
  `).all());
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
  const { password, employee_id, active } = req.body;
  const w = db.prepare('SELECT * FROM worker_accounts WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE worker_accounts SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, req.params.id);
  }
  db.prepare('UPDATE worker_accounts SET employee_id=?, active=? WHERE id=?')
    .run(employee_id !== undefined ? employee_id : w.employee_id, active !== undefined ? active : w.active, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/worker-accounts/:id', requireAdmin, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM worker_accounts WHERE id=?').run(req.params.id);
  res.json({ success: true });
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
  db.prepare('DELETE FROM customer_accounts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Job Applications (admin view) ───
app.get('/api/admin/job-applications', requireAdmin, blockManager, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, j.title as job_title, j.location as job_location,
      w.username, e.first_name, e.last_name
    FROM job_applications a
    LEFT JOIN jobs j ON a.job_id=j.id
    LEFT JOIN worker_accounts w ON a.worker_account_id=w.id
    LEFT JOIN employees e ON w.employee_id=e.id
    ORDER BY a.created_at DESC
  `).all());
});

app.put('/api/admin/job-applications/:id', requireAdmin, blockManager, (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE job_applications SET status=?, notes=? WHERE id=?').run(status, notes||'', req.params.id);
  res.json({ success: true });
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
    (partner_id, title, type, location, pay, lang, lang_name, description, urgent,
     work_auth, benefits, schedule, company_id, company_name, employment_type,
     work_days, work_start, work_end, schedule_days, schedule_start, schedule_end,
     job_status, active, close_reason, close_note, headcount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const r = stmt.run(
    d.partner_id||null, d.title, d.type||'', d.location||'', d.pay||'', d.lang||'en', d.lang_name||'English',
    d.description||'', d.urgent?1:0, d.work_auth||'', d.benefits||'', d.schedule||'',
    d.company_id||null, d.company_name||'', d.employment_type||'',
    d.work_days||'', d.work_start||'', d.work_end||'',
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
  db.prepare(`UPDATE jobs SET partner_id=?, title=?, type=?, location=?, pay=?, lang=?, lang_name=?,
    description=?, urgent=?, active=?, work_auth=?, benefits=?, schedule=?,
    company_id=?, company_name=?, employment_type=?, work_days=?, work_start=?, work_end=?,
    schedule_days=?, schedule_start=?, schedule_end=?,
    job_status=?, close_reason=?, close_note=?, headcount=? WHERE id=?`)
    .run(
      d.partner_id||null, d.title, d.type||'', d.location||'', d.pay||'', d.lang||'en', d.lang_name||'English',
      d.description||'', d.urgent?1:0, jobStatus==='open'?1:0,
      d.work_auth||'', d.benefits||'', d.schedule||'',
      d.company_id||null, d.company_name||'', d.employment_type||'',
      d.work_days||'', d.work_start||'', d.work_end||'',
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
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  logJobAudit.run(req.params.id, 'deleted', JSON.stringify(old || {}), req.userName);
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
  const { inquiry_id, job_id, notes, pay_rate, pay_type, contract_type, benefits, start_date } = req.body;
  if (!inquiry_id || !job_id) return res.status(400).json({ error: 'inquiry_id and job_id required' });
  const r = db.prepare(`INSERT INTO assignments
    (inquiry_id, job_id, notes, pay_rate, pay_type, contract_type, benefits, start_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(inquiry_id, job_id, notes || '', pay_rate || '', pay_type || 'hourly', contract_type || 'W2', benefits || '', start_date || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/assignments/:id', requireAdmin, blockManager, staffGuard('update', 'assignments'), (req, res) => {
  const { status, notes, pay_rate, pay_type, contract_type, benefits, start_date } = req.body;
  db.prepare(`UPDATE assignments SET status=?, notes=?, pay_rate=?, pay_type=?, contract_type=?, benefits=?, start_date=? WHERE id=?`)
    .run(status || 'assigned', notes || '', pay_rate || '', pay_type || 'hourly', contract_type || 'W2', benefits || '', start_date || '', req.params.id);
  res.json({ success: true });
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

// ─── Employee Doc Requests (私密材料链接) ───

// Admin: create / get link for an employee
app.post('/api/admin/employees/:id/doc-request', requireAdmin, (req, res) => {
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const existing = db.prepare('SELECT * FROM employee_doc_requests WHERE employee_id=? AND status="pending"').get(emp.id);
    if (existing) return res.json({ token: existing.token, status: 'pending', already_exists: true });
    const token = crypto.randomBytes(28).toString('hex');
    const { admin_note, requested_docs, lang } = req.body;
    // Ensure positions column exists (idempotent)
    try { db.exec("ALTER TABLE employee_doc_requests ADD COLUMN positions TEXT DEFAULT '[]'"); } catch {}
    db.prepare('INSERT INTO employee_doc_requests (token, employee_id, admin_note, requested_docs, lang, positions) VALUES (?,?,?,?,?,?)')
      .run(token, emp.id, admin_note || '', JSON.stringify(requested_docs || ['gov_id','ssn','work_card']),
          lang || 'zh', '[]');
    res.json({ token, status: 'pending' });
  } catch(e) {
    console.error('doc-request error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/employees/:id/doc-requests', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM employee_doc_requests WHERE employee_id=? ORDER BY created_at DESC').all(req.params.id));
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
  { name: 'work_card', maxCount: 1 }
]), (req, res) => {
  const row = db.prepare('SELECT * FROM employee_doc_requests WHERE token=?').get(req.params.token);
  if (!row) return res.status(404).json({ error: '链接无效或已过期' });
  if (row.status === 'completed') return res.status(400).json({ error: '已提交，无法重复提交' });
  const files = req.files || {};
  if (!Object.keys(files).length) return res.status(400).json({ error: '请至少上传一份文件' });
  const DOC_LABEL = { gov_id: '政府身份证件', ssn: '社安卡', work_card: '工卡 / 工作许可证' };
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
      (SELECT COUNT(*) FROM background_checks b WHERE b.employee_id = e.id) as bg_count
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
  const ssn_full = emp.ssn_encrypted && emp.ssn_iv ? decryptSSN(emp.ssn_encrypted, emp.ssn_iv) : null;
  res.json({ ...safeEmp(emp), ssn_full, documents: docs, background_checks: bgChecks, recent_time: recentTime, job_history: jobHistory });
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
    employee_id=?,first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,dob=?,
    emergency_name=?,emergency_phone=?,emergency_relation=?,hire_date=?,position=?,department=?,
    pay_rate=?,pay_type=?,status=?,pin_hash=?,pin_salt=?,ssn_encrypted=?,ssn_iv=?,ssn_last4=?,notes=?,
    extra_phones=?,extra_emails=?
    WHERE id=?`).run(
    d.employee_id||emp.employee_id,d.first_name,d.last_name,d.email||'',d.phone||'',d.address||'',
    d.city||'',d.state||'',d.zip||'',d.dob||'',
    d.emergency_name||'',d.emergency_phone||'',d.emergency_relation||'',
    d.hire_date||'',d.position||'',d.department||'',
    parseFloat(d.pay_rate)||0,d.pay_type||'hourly',d.status||'active',
    pin_hash,pin_salt,ssn_encrypted,ssn_iv,ssn_last4,d.notes||'',
    JSON.stringify(d.extra_phones || JSON.parse(emp.extra_phones || '[]')),
    JSON.stringify(d.extra_emails || JSON.parse(emp.extra_emails || '[]')),
    req.params.id);
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
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a job assignment from employee
app.delete('/api/admin/employees/:id/assign-job/:jobId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM employee_jobs WHERE employee_id=? AND job_id=?').run(req.params.id, req.params.jobId);
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

// ─── Worker Portal API ───
app.post('/api/worker/login', (req, res) => {
  const { login, username, password } = req.body;
  const identifier = (login || username || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  // Try matching by email, phone, or username
  const w = db.prepare('SELECT * FROM worker_accounts WHERE email=? OR phone=? OR username=?').get(identifier, identifier, identifier);
  if (!w || !verifyPassword(password, w.salt, w.password_hash))
    return res.status(401).json({ error: '邮箱/手机号或密码错误 / Invalid email/phone or password' });
  if (!w.active)
    return res.status(403).json({ error: '账号尚未验证，请先完成手机和邮箱验证 / Account not verified. Please complete phone and email verification first.' });
  const token = crypto.randomBytes(32).toString('hex');
  workerSessions.set(token, { created: Date.now(), workerId: w.id, employeeId: w.employee_id });
  res.json({ token, employee_id: w.employee_id });
});

app.get('/api/worker/me', requireWorker, (req, res) => {
  const w = db.prepare('SELECT id, username, employee_id, active, created_at FROM worker_accounts WHERE id=?').get(req.workerId);
  const emp = req.workerEmployeeId ? db.prepare('SELECT id, first_name, last_name, employee_id, position, department, pay_rate, pay_type, status FROM employees WHERE id=?').get(req.workerEmployeeId) : null;
  res.json({ account: w, employee: emp });
});

app.get('/api/worker/jobs', requireWorker, (req, res) => {
  const jobs = db.prepare('SELECT id, title, type, location, pay, work_auth, benefits, work_days, work_start, work_end, employment_type, company_name, description, urgent FROM jobs WHERE active=1 ORDER BY created_at DESC').all();
  const applied = db.prepare('SELECT job_id FROM job_applications WHERE worker_account_id=?').all(req.workerId).map(r => r.job_id);
  res.json(jobs.map(j => ({ ...j, applied: applied.includes(j.id) })));
});

app.post('/api/worker/apply/:jobId', requireWorker, (req, res) => {
  const job = db.prepare('SELECT id FROM jobs WHERE id=? AND active=1').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or no longer active' });
  try {
    db.prepare('INSERT INTO job_applications (job_id, worker_account_id, notes) VALUES (?,?,?)').run(req.params.jobId, req.workerId, req.body.notes || '');
    res.json({ success: true });
  } catch { res.status(400).json({ error: 'Already applied to this job' }); }
});

app.get('/api/worker/timeclock', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json([]);
  const entries = db.prepare('SELECT * FROM time_entries WHERE employee_id=? ORDER BY clock_in DESC LIMIT 60').all(req.workerEmployeeId);
  res.json(entries);
});

app.post('/api/worker/punch', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.status(400).json({ error: '账号未关联员工档案，请联系HR' });
  const { latitude, longitude } = req.body;
  const now = new Date().toISOString();
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.workerEmployeeId);
  if (open) {
    const hrs = calcHours(open.clock_in, now, open.break_minutes || 0);
    db.prepare("UPDATE time_entries SET clock_out=?,total_hours=?,regular_hours=?,overtime_hours=?,status='closed' WHERE id=?")
      .run(now, hrs.total, hrs.regular, hrs.overtime, open.id);
    res.json({ action: 'out', clock_in: open.clock_in, clock_out: now, ...hrs });
  } else {
    const r = db.prepare("INSERT INTO time_entries (employee_id,clock_in,status,latitude,longitude) VALUES(?,?,'open',?,?)")
      .run(req.workerEmployeeId, now, latitude || null, longitude || null);
    res.json({ action: 'in', clock_in: now, entry_id: r.lastInsertRowid });
  }
});

app.get('/api/worker/punch/status', requireWorker, (req, res) => {
  if (!req.workerEmployeeId) return res.json({ clocked_in: false });
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id=? AND status='open' ORDER BY clock_in DESC LIMIT 1").get(req.workerEmployeeId);
  res.json({ clocked_in: !!open, open_entry: open || null });
});

app.get('/api/worker/assignments', requireWorker, (req, res) => {
  const apps = db.prepare(`
    SELECT a.*, j.title, j.location, j.pay, j.company_name
    FROM job_applications a LEFT JOIN jobs j ON a.job_id=j.id
    WHERE a.worker_account_id=? ORDER BY a.created_at DESC
  `).all(req.workerId);
  res.json(apps);
});

// ─── Worker Forgot / Reset Password ───
app.post('/api/worker/forgot-password', (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: '请输入邮箱或手机号' });
  const w = db.prepare('SELECT id, email, phone FROM worker_accounts WHERE email=? OR phone=? OR username=?').get(login, login, login);
  if (!w) return res.status(404).json({ error: '未找到该账号 / Account not found' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set('worker:' + login, { code, expires: Date.now() + 10 * 60 * 1000, accountId: w.id });
  console.log(`[Reset Code] Worker account ${login}: ${code}`);
  res.json({ success: true, message: '验证码已发送 / Code sent' });
});

app.post('/api/worker/reset-password', (req, res) => {
  const { login, code, new_password } = req.body;
  if (!login || !code || !new_password) return res.status(400).json({ error: '请填写完整信息' });
  if (new_password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const entry = resetCodes.get('worker:' + login);
  if (!entry || entry.code !== code) return res.status(400).json({ error: '验证码错误 / Invalid code' });
  if (Date.now() > entry.expires) { resetCodes.delete('worker:' + login); return res.status(400).json({ error: '验证码已过期 / Code expired' }); }
  const { hash, salt } = hashPassword(new_password);
  db.prepare('UPDATE worker_accounts SET password_hash=?, salt=? WHERE id=?').run(hash, salt, entry.accountId);
  resetCodes.delete('worker:' + login);
  res.json({ success: true });
});

// ─── Customer Portal API ───
app.post('/api/customer/login', (req, res) => {
  const { login, email, password } = req.body;
  const identifier = (login || email || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Please provide email/phone and password' });
  // Try matching by email or phone
  const cAny = db.prepare('SELECT * FROM customer_accounts WHERE email=? OR phone=?').get(identifier, identifier);
  if (cAny && cAny.approval_status === 'pending')
    return res.status(403).json({ error: '您的企业账号正在审核中，请等待管理员批准 / Your account is pending admin approval' });
  if (cAny && cAny.approval_status === 'rejected')
    return res.status(403).json({ error: '您的企业注册已被拒绝，请联系管理员 / Your registration was rejected. Please contact admin' });
  const c = db.prepare('SELECT * FROM customer_accounts WHERE (email=? OR phone=?) AND active=1').get(identifier, identifier);
  if (!c || !verifyPassword(password, c.salt, c.password_hash))
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
app.post('/api/register/worker', (req, res) => {
  const { name, phone, email, dob, work_status, position_interests, password } = req.body;
  if (!name || !phone || !email || !password)
    return res.status(400).json({ error: 'Name, phone, email, and password are required' });
  // Check phone or email uniqueness
  const existing = db.prepare('SELECT id FROM worker_accounts WHERE phone=? OR email=? OR username=?').get(phone, email, phone);
  if (existing) return res.status(400).json({ error: 'An account with this phone or email already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const r = db.prepare(`INSERT INTO worker_accounts (username, password_hash, salt, name, phone, email, dob, work_status, position_interests, active)
    VALUES (?,?,?,?,?,?,?,?,?,0)`)
    .run(phone, hash, salt, name, phone, email, dob || '', work_status || '', JSON.stringify(position_interests || []));
  const accountId = r.lastInsertRowid;
  // Generate 6-digit verification codes
  const phoneCode = String(Math.floor(100000 + Math.random() * 900000));
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(accountId);
  db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId, 'phone', phoneCode, expires);
  db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(accountId, 'email', emailCode, expires);
  console.log(`[Verify] Worker #${accountId} phone code: ${phoneCode}, email code: ${emailCode}`);
  res.json({ success: true, account_id: accountId, needs_verification: true, message: 'Verification codes sent' });
});

// Resend verification code
app.post('/api/register/resend-code', (req, res) => {
  const { account_id, type } = req.body;
  if (!account_id || !['phone', 'email'].includes(type))
    return res.status(400).json({ error: 'account_id and type (phone/email) required' });
  const acc = db.prepare('SELECT id, active FROM worker_accounts WHERE id=?').get(account_id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.active) return res.status(400).json({ error: 'Account already verified' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=? AND type=?').run(account_id, type);
  db.prepare('INSERT INTO verification_codes (worker_account_id, type, code, expires_at) VALUES (?,?,?,?)').run(account_id, type, code, expires);
  console.log(`[Verify] Resend ${type} code for Worker #${account_id}: ${code}`);
  res.json({ success: true });
});

// Verify codes and activate account
app.post('/api/register/verify', (req, res) => {
  const { account_id, phone_code, email_code } = req.body;
  if (!account_id || !phone_code || !email_code)
    return res.status(400).json({ error: 'account_id, phone_code, and email_code required' });
  const acc = db.prepare('SELECT id, active, employee_id FROM worker_accounts WHERE id=?').get(account_id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.active) return res.status(400).json({ error: 'Account already verified' });
  const now = new Date().toISOString();
  const pv = db.prepare('SELECT * FROM verification_codes WHERE worker_account_id=? AND type=? AND code=? AND expires_at>?').get(account_id, 'phone', phone_code, now);
  if (!pv) return res.status(400).json({ error: '手机验证码错误或已过期 / Invalid or expired phone code' });
  const ev = db.prepare('SELECT * FROM verification_codes WHERE worker_account_id=? AND type=? AND code=? AND expires_at>?').get(account_id, 'email', email_code, now);
  if (!ev) return res.status(400).json({ error: '邮箱验证码错误或已过期 / Invalid or expired email code' });
  // Activate account
  db.prepare('UPDATE worker_accounts SET active=1 WHERE id=?').run(account_id);
  db.prepare('DELETE FROM verification_codes WHERE worker_account_id=?').run(account_id);
  // Auto-login
  const token = crypto.randomBytes(32).toString('hex');
  workerSessions.set(token, { created: Date.now(), workerId: acc.id, employeeId: acc.employee_id });
  res.json({ success: true, token, message: 'Verification successful' });
});

app.post('/api/register/enterprise', (req, res) => {
  const { company_name, contact_name, email, phone, ein, staffing_needs, password } = req.body;
  if (!company_name || !contact_name || !email || !password)
    return res.status(400).json({ error: 'Company name, contact name, email, and password are required' });
  const existing = db.prepare('SELECT id FROM customer_accounts WHERE email=?').get(email);
  if (existing) return res.status(400).json({ error: 'An account with this email already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  db.prepare(`INSERT INTO customer_accounts (company_name, contact_name, email, phone, password_hash, salt, ein, staffing_needs, active, approval_status)
    VALUES (?,?,?,?,?,?,?,?,0,'pending')`)
    .run(company_name, contact_name, email, phone || '', hash, salt, ein || '', staffing_needs || '');
  res.json({ success: true, message: 'Registration submitted. Your account will be activated after admin approval.' });
});

// Admin: pending enterprise approvals
app.get('/api/admin/pending-enterprises', requireAdmin, (req, res) => {
  const list = db.prepare("SELECT id, company_name, contact_name, email, phone, ein, staffing_needs, created_at FROM customer_accounts WHERE approval_status='pending' ORDER BY created_at DESC").all();
  res.json(list);
});

app.put('/api/admin/approve-enterprise/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE customer_accounts SET active=1, approval_status='approved' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.put('/api/admin/reject-enterprise/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE customer_accounts SET active=0, approval_status='rejected' WHERE id=?").run(req.params.id);
  res.json({ success: true });
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

// ─── Start ───
// Periodic WAL checkpoint every 5 minutes
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) { console.error('[WAL] checkpoint error:', e.message); }
}, 5 * 60 * 1000);

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
});
