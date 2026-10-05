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
