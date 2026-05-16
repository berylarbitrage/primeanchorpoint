// Storage abstraction. Backed by Cloudflare R2 (S3-compatible) when
// STORAGE_BACKEND=r2 and the R2_* env vars are set, otherwise falls back to
// the local filesystem under `dataDir`. Both backends expose the same API
// so business code does not need to know which is active.
//
// File "keys" are forward-slash-separated paths *without* a leading slash,
// e.g. "uploads/abc.jpg", "employee_docs/2026/ssn-xyz.pdf". The DB stores
// keys in this normalized form. Older records that used "/uploads/abc.jpg"
// are tolerated via `normalizeKey`.

const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
const isR2 = BACKEND === 'r2';

let s3Client = null;
let GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand;
let getSignedUrl;
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PRESIGN_TTL = parseInt(process.env.R2_PRESIGN_TTL_SEC || '900', 10); // 15min default

if (isR2) {
  const requiredEnv = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[storage] STORAGE_BACKEND=r2 but missing env: ${missing.join(', ')}. Falling back to local.`);
  } else {
    const s3 = require('@aws-sdk/client-s3');
    const signer = require('@aws-sdk/s3-request-presigner');
    GetObjectCommand = s3.GetObjectCommand;
    PutObjectCommand = s3.PutObjectCommand;
    DeleteObjectCommand = s3.DeleteObjectCommand;
    HeadObjectCommand = s3.HeadObjectCommand;
    getSignedUrl = signer.getSignedUrl;
    s3Client = new s3.S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
    console.log(`[storage] R2 backend active · bucket=${R2_BUCKET}`);
  }
}

// dataDir is set by server.js at startup. We accept it lazily via init().
let _dataDir = null;
function init({ dataDir }) {
  _dataDir = dataDir;
  if (!isR2) console.log(`[storage] Local backend active · dataDir=${dataDir}`);
}

function normalizeKey(keyOrPath) {
  if (!keyOrPath) return '';
  let k = String(keyOrPath).replace(/\\/g, '/').trim();
  // Strip leading slashes
  while (k.startsWith('/')) k = k.slice(1);
  return k;
}

// Convert a DB-stored file_path into a canonical R2 key.
// Examples:
//   keyFrom('/uploads/foo.jpg',  'uploads')         -> 'uploads/foo.jpg'
//   keyFrom('doc-xyz.pdf',       'employee_docs')   -> 'employee_docs/doc-xyz.pdf'
//   keyFrom('uploads/foo.jpg',   'uploads')         -> 'uploads/foo.jpg'
//   keyFrom('employee_docs/xy',  'employee_docs')   -> 'employee_docs/xy'
function keyFrom(filePath, defaultSubdir) {
  if (!filePath) return '';
  const subdir = String(defaultSubdir || '').replace(/^\/+|\/+$/g, '');
  let k = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!k) return '';
  if (!subdir) return k;
  // If already starts with the subdir, keep as-is
  if (k === subdir || k.startsWith(subdir + '/')) return k;
  // If contains any subdir prefix it's already a full key
  if (k.includes('/')) return k;
  return `${subdir}/${k}`;
}

function localPathForKey(key) {
  if (!_dataDir) throw new Error('storage.init({dataDir}) was not called');
  // Keys live under the same dataDir layout that already exists on disk.
  // First segment maps directly: uploads/..., employee_docs/..., etc.
  return path.join(_dataDir, key);
}

// Public: build an absolute on-disk path for a key (local mode only).
// Returns null when running in R2 mode or before init().
function localAbsPath(key) {
  if (!_dataDir) return null;
  return path.join(_dataDir, normalizeKey(key));
}

// ─── Put a Buffer / Readable as an object ───
async function putObject(key, body, { contentType, contentDisposition } = {}) {
  const k = normalizeKey(key);
  if (s3Client) {
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: k,
      Body: body,
      ContentType: contentType || undefined,
      ContentDisposition: contentDisposition || undefined,
    }));
    return k;
  }
  // Local
  const fp = localPathForKey(k);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    fs.writeFileSync(fp, body);
  } else if (body && typeof body.pipe === 'function') {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(fp);
      body.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
  } else {
    throw new Error('putObject body must be Buffer, string, or Readable');
  }
  return k;
}

// ─── Read object as Buffer ───
async function getBuffer(key) {
  const k = normalizeKey(key);
  if (s3Client) {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: k }));
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return fs.readFileSync(localPathForKey(k));
}

// ─── Read object as Node Readable stream ───
async function getStream(key) {
  const k = normalizeKey(key);
  if (s3Client) {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: k }));
    // R2 returns a web stream in some runtimes; coerce to Node Readable
    return resp.Body && typeof resp.Body.pipe === 'function'
      ? resp.Body
      : Readable.fromWeb(resp.Body);
  }
  return fs.createReadStream(localPathForKey(k));
}

async function exists(key) {
  const k = normalizeKey(key);
  if (s3Client) {
    try { await s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: k })); return true; }
    catch (e) { if (e.$metadata && e.$metadata.httpStatusCode === 404) return false; throw e; }
  }
  return fs.existsSync(localPathForKey(k));
}

async function deleteObject(key) {
  const k = normalizeKey(key);
  if (s3Client) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: k }));
    return;
  }
  try { fs.unlinkSync(localPathForKey(k)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// ─── Get a URL the browser can fetch the file from ───
// If R2_PUBLIC_BASE_URL is configured (custom domain on the bucket), return
// `${base}/${key}`. Otherwise return a presigned URL valid for PRESIGN_TTL.
// In local mode, return `/data-file/${key}` which is served by server.js.
async function getDownloadUrl(key, { filename, expiresSec } = {}) {
  const k = normalizeKey(key);
  if (s3Client) {
    if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeURI(k)}`;
    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: k,
      ResponseContentDisposition: filename
        ? `attachment; filename="${filename.replace(/"/g, '')}"`
        : undefined,
    });
    return getSignedUrl(s3Client, cmd, { expiresIn: expiresSec || PRESIGN_TTL });
  }
  return `/data-file/${encodeURI(k)}`;
}

function backendName() { return s3Client ? 'r2' : 'local'; }

module.exports = {
  init,
  putObject,
  getBuffer,
  getStream,
  exists,
  deleteObject,
  getDownloadUrl,
  normalizeKey,
  keyFrom,
  localAbsPath,
  backendName,
  R2_BUCKET,
  isR2: () => !!s3Client,
};
