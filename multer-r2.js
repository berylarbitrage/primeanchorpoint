// Custom multer storage engine that routes uploads through ./storage.js.
// Mimics multer.diskStorage's output shape so existing route handlers
// continue to work:
//   req.file.filename — basename (e.g. "doc-1734567890-ab12cd.pdf")
//   req.file.path     — "/${subdir}/${filename}" (what we store in DB)
//   req.file.key      — same as path but without leading slash (R2 key)
//   req.file.size     — bytes
// Switching STORAGE_BACKEND between 'local' and 'r2' requires no code
// changes — the underlying storage module handles both.

const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

function defaultFilename(file, prefix) {
  const ext = (path.extname(file.originalname || '') || '.bin').toLowerCase();
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

function createStorage(opts = {}) {
  const subdir = String(opts.subdir || 'uploads').replace(/^\/+|\/+$/g, '');
  const filename = typeof opts.filename === 'function' ? opts.filename : null;
  const prefix = opts.prefix || subdir.replace(/.*\//, '');

  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let size = 0;
      file.stream.on('data', c => { chunks.push(c); size += c.length; });
      file.stream.on('error', cb);
      file.stream.on('end', () => {
        const finish = (err, name) => {
          if (err) return cb(err);
          const baseName = name || defaultFilename(file, prefix);
          const key = `${subdir}/${baseName}`;
          const body = Buffer.concat(chunks);
          storage.putObject(key, body, { contentType: file.mimetype })
            .then(() => {
              // Preserve diskStorage's semantic for req.file.path under
              // local backend: an absolute on-disk path that existing
              // handlers can pass to fs.createReadStream / fs.unlink etc.
              // Under R2, return the path-style key (no longer a real
              // file path; those handlers must be converted to storage.*).
              const pathValue = storage.isR2()
                ? `/${key}`
                : (storage.localAbsPath(key) || `/${key}`);
              cb(null, {
                filename: baseName,
                path: pathValue,
                key,
                size: body.length,
              });
            })
            .catch(cb);
        };
        if (filename) filename(req, file, finish);
        else finish(null, null);
      });
    },
    _removeFile(req, file, cb) {
      if (!file.key) return cb(null);
      storage.deleteObject(file.key).then(() => cb(null)).catch(cb);
    },
  };
}

module.exports = { createStorage };
