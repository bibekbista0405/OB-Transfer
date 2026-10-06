# OB Transfer

OB Transfer is a self-hosted file transfer and media streaming application with authenticated access, protected realtime events, upload validation, storage limits, and browser security hardening.

## Run locally

Prerequisite: Node.js 20+

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set your local values.
3. Start development mode: `npm run dev`

## Security configuration

- `ACCESS_PASSWORD` — required access key. Never commit the real value.
- `APP_URL` — exact browser origin allowed for CORS and Socket.IO.
- `NODE_ENV` — use `production` for deployment.
- `MAX_FILE_SIZE_BYTES` — maximum single upload size; defaults to 10 GiB.
- `MAX_STORAGE_BYTES` — total runtime upload storage quota; defaults to 50 GiB.
- `MAX_FILES` — maximum number of stored file records; defaults to 1000.

## Runtime storage and Git

The `uploads/` directory is runtime storage and is intentionally excluded from Git. Uploaded file data must never be committed. Only `uploads/.gitkeep` is tracked so the directory exists after cloning.

## Security notes

Authentication uses server-side sessions in an HttpOnly cookie. API and Socket.IO access require an authenticated session. Uploads are stored under opaque UUID-based filenames, independent of user filenames, and are checked against size, storage, concurrency, and file-count limits. Client-provided MIME types are not trusted for metadata or previews. Unsafe/unknown types are download-only rather than rendered inline.

## Streaming and range protection

File downloads and previews support authenticated single-range requests for resumable transfers and media seeking. The server rejects malformed, multi-range, reversed, out-of-bounds, and oversized ranges with `416 Range Not Satisfiable` and never passes unvalidated offsets to the filesystem stream. Range responses are capped at 64 MiB per request to limit resource abuse.


## SQLite metadata storage

OB Transfer stores file metadata in the runtime SQLite database at `data/ob-transfer.sqlite3`. The database is intentionally excluded from Git because it contains private file metadata. The physical uploaded files remain under `uploads/`, which is also excluded from Git.

On first startup after upgrading from the JSON metadata implementation, valid legacy records in `metadata/*.json` are imported into SQLite and the legacy JSON records are removed. SQLite is then the single authoritative metadata store. If a database record and its physical file become inconsistent, startup reconciliation removes the stale record; safe UUID-named orphan files can be re-indexed.

**Runtime requirement:** Phase 13 uses Node's built-in `node:sqlite` API, so run OB Transfer with **Node.js 22.5+**.

## Frontend architecture

Phase 14 keeps the existing vanilla-JavaScript UI while separating shared frontend concerns into `src/modules/`:

- `constants.js` — frontend limits and shared constants
- `state.js` — application state container
- `dom.js` — centralized DOM element bindings
- `api.js` — authenticated API request helpers
- `app.js` — UI orchestration, rendering, socket events, upload queue, and previews

This is an internal architecture cleanup only; the existing UI and API contracts remain unchanged.
## Phase 15 — Dependency cleanup

The project dependency graph was audited and stale scaffold dependencies were removed. OB Transfer now keeps only packages required by the current Fastify/Socket.IO server, vanilla JavaScript frontend, Vite/Tailwind build, SQLite runtime, and supporting upload/storage features. The lockfile was pruned to match the manifest.

