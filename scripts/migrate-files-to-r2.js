#!/usr/bin/env node
// One-shot migration: walk the local dataDir for uploaded files and upload
// each to R2 under the same relative key. Idempotent — skips objects that
// already exist in R2 (use --force to overwrite).
//
// Usage (on Render Shell or anywhere DATA_DIR + R2_* env vars are set):
//   STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js
//   STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --dry-run
//   STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --force
//   STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --dir uploads,employee_docs
//
// Reports a summary at the end. Does NOT delete local files — that's a
// separate step you run after verification.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Force R2 backend regardless of how the var is set in the env.
process.env.STORAGE_BACKEND = 'r2';

const storage = require('../storage');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
storage.init({ dataDir: DATA_DIR });

if (!storage.isR2()) {
  console.error('❌ R2 backend not active. Check R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY env vars.');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force  = args.has('--force');
const dirArgIdx = process.argv.indexOf('--dir');
const customDirs = dirArgIdx >= 0 && process.argv[dirArgIdx + 1]
  ? process.argv[dirArgIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : null;

// All file subtrees we care about. Each must exist relative to DATA_DIR.
const DEFAULT_DIRS = [
  'uploads',
  'employee_docs',
  'punch_photos',
  'checkin_photos',
];
const DIRS = customDirs || DEFAULT_DIRS;

const SKIP_PATTERNS = [/\.DS_Store$/i, /Thumbs\.db$/i, /\.swp$/i];
// Best-effort content-type detection without an extra dep.
function mimeFor(ext) {
  ext = ext.toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.sql': 'application/sql',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function walk(root, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    const abs = path.join(root, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (SKIP_PATTERNS.some(re => re.test(ent.name))) continue;
    if (ent.isDirectory()) out.push(...walk(abs, rel));
    else if (ent.isFile()) out.push({ abs, rel });
  }
  return out;
}

async function main() {
  console.log(`📦 Migration target → bucket=${storage.R2_BUCKET}`);
  console.log(`📂 DATA_DIR=${DATA_DIR}`);
  console.log(`📁 Subtrees: ${DIRS.join(', ')}`);
  console.log(`⚙️  dryRun=${dryRun}, force=${force}`);
  console.log('');

  const summary = { total: 0, uploaded: 0, skipped: 0, failed: 0, bytes: 0 };
  const failures = [];

  for (const subdir of DIRS) {
    const root = path.join(DATA_DIR, subdir);
    if (!fs.existsSync(root)) {
      console.log(`  · skip ${subdir} (no such directory)`);
      continue;
    }
    const files = walk(root);
    console.log(`📁 ${subdir}: ${files.length} file(s)`);

    for (const f of files) {
      const key = `${subdir}/${f.rel}`;
      summary.total++;
      let size = 0;
      try { size = fs.statSync(f.abs).size; } catch {}

      if (!force) {
        try {
          if (await storage.exists(key)) {
            summary.skipped++;
            process.stdout.write(`    · ${key} (exists, skip)\n`);
            continue;
          }
        } catch (e) {
          // fall through to upload attempt
        }
      }

      if (dryRun) {
        process.stdout.write(`    + ${key} (${size} bytes) [dry-run]\n`);
        summary.uploaded++;
        summary.bytes += size;
        continue;
      }

      try {
        const body = fs.readFileSync(f.abs);
        const ext = path.extname(f.abs);
        await storage.putObject(key, body, { contentType: mimeFor(ext) });
        summary.uploaded++;
        summary.bytes += size;
        process.stdout.write(`    ✓ ${key} (${size} bytes)\n`);
      } catch (e) {
        summary.failed++;
        failures.push({ key, error: e.message });
        process.stdout.write(`    ✗ ${key} → ${e.message}\n`);
      }
    }
  }

  console.log('');
  console.log('─────────────────────────────');
  console.log(`Total scanned : ${summary.total}`);
  console.log(`Uploaded      : ${summary.uploaded}`);
  console.log(`Skipped       : ${summary.skipped}`);
  console.log(`Failed        : ${summary.failed}`);
  console.log(`Bytes pushed  : ${(summary.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('─────────────────────────────');

  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures.slice(0, 50)) console.log(`  - ${f.key}: ${f.error}`);
    if (failures.length > 50) console.log(`  ...and ${failures.length - 50} more`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
