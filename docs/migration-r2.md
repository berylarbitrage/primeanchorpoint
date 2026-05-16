# Phase 1 — File storage migration to Cloudflare R2

This document covers moving all user-uploaded files from the local
`./data/` tree on the Render disk to a Cloudflare R2 bucket.

It is **Phase 1 of the migration plan**. SQLite stays put for now; only
files move. Behavior under `STORAGE_BACKEND=local` is unchanged from
before this PR — the storage abstraction defaults to local FS so this
foundation PR is safe to ship without flipping anything.

## Environment variables

All of these go in **Render → Environment**. None should ever be
committed to git.

| Var | Required when | Example |
|---|---|---|
| `STORAGE_BACKEND` | always (defaults to `local`) | `r2` once you're ready to flip |
| `R2_ENDPOINT` | `STORAGE_BACKEND=r2` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | `STORAGE_BACKEND=r2` | (from Cloudflare R2 token) |
| `R2_SECRET_ACCESS_KEY` | `STORAGE_BACKEND=r2` | (from Cloudflare R2 token) |
| `R2_BUCKET` | `STORAGE_BACKEND=r2` | `prime-anchor-files` |
| `R2_ACCOUNT_ID` | optional, informational | — |
| `R2_PUBLIC_BASE_URL` | optional | `https://files.primeanchorpoint.com` |
| `R2_PRESIGN_TTL_SEC` | optional, defaults `900` (15min) | — |

If `R2_PUBLIC_BASE_URL` is set, file URLs use that domain directly
(unsigned). Leave it empty if your bucket is private — the app will
generate short-lived **presigned URLs** instead. Keep R2 private for
sensitive files (SSN cards, I-9, etc.).

## How the storage abstraction works

`storage.js` exposes one API for both backends:

```js
const storage = require('./storage');
storage.init({ dataDir });

await storage.putObject(key, buffer, { contentType });
await storage.getBuffer(key);             // → Buffer
await storage.getStream(key);             // → Node Readable
await storage.exists(key);                // → bool
await storage.deleteObject(key);
await storage.getDownloadUrl(key, { filename }); // → URL (presigned or public)
```

`key` is a path-style string like `uploads/abc.jpg` (no leading slash).
DB rows that still hold legacy `/uploads/abc.jpg` paths are tolerated —
`normalizeKey()` strips leading slashes before R2 calls.

In `local` mode the abstraction reads/writes `dataDir/<key>`, so the
existing on-disk layout (`./data/uploads/...`,
`./data/employee_docs/...`) is preserved.

## One-shot migration

Once R2 is set up and `STORAGE_BACKEND=r2` is configured in Render, run
the migration in the Render Shell (or anywhere the env vars are set):

```bash
# Dry run first to see what will happen
STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --dry-run

# Real run
STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js

# Only one subtree
STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --dir employee_docs

# Re-upload everything (overwriting existing R2 objects)
STORAGE_BACKEND=r2 node scripts/migrate-files-to-r2.js --force
```

The script walks `DATA_DIR/{uploads,employee_docs,punch_photos,checkin_photos}`
and uploads each file to R2 under the same relative key. It's
**idempotent**: by default it skips files that already exist on R2 (use
`--force` to overwrite).

It does **not** delete local files. After verifying that the app reads
correctly from R2 for a couple days, you can manually delete the local
trees to reclaim disk.

## Going live

1. Ship this PR with `STORAGE_BACKEND` unset (defaults to `local`) →
   no behavior change. ✓
2. Ship the follow-up PR that rewires the 11 multer instances + file
   read/delete sites to use `storage.*`. Still safe with
   `STORAGE_BACKEND=local`.
3. Set the four `R2_*` env vars in Render.
4. Set `STORAGE_BACKEND=r2` (you can leave it off briefly to test
   manually with `STORAGE_BACKEND=r2 node -e ...`).
5. Run `npm run migrate:files-to-r2 -- --dry-run`, then for real.
6. Redeploy with `STORAGE_BACKEND=r2`. All new uploads land in R2.
7. After a few days of stability, delete the local file trees.

## Rollback

If something breaks after step 6:

1. Unset `STORAGE_BACKEND` in Render (defaults back to `local`).
2. Redeploy. New files will go to local disk again.
3. Files uploaded to R2 during the broken window will not be reachable
   from local mode — you can re-pull them with the reverse direction
   of the migration script if needed. Plan accordingly.

## What's NOT in this PR

- Multer instances still write to local disk. Conversion is the next PR.
- File serving (`/uploads/:filename`, etc.) still reads local disk.
- DB still holds `/uploads/xxx.jpg` style paths.
- SQLite → Postgres migration is **Phase 3**, not started.
