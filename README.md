# OB Transfer

OB Transfer is a self-hosted file transfer and media streaming application built for private, authenticated file sharing. It provides a browser-based interface for uploading, browsing, previewing, downloading, and deleting files while enforcing server-side authentication, storage limits, safe file handling, protected realtime events, and browser security controls.

> **Project status:** Security hardening and architecture work are being completed incrementally. This repository is currently at **Phase 21 frontend UX refinement** in the project hardening roadmap.

## Features

- Password-protected access with server-side sessions
- HttpOnly, SameSite session cookies
- Authenticated REST API and Socket.IO realtime events
- Login abuse protection and rate limiting
- Secure UUID-based file storage names
- Filename normalization and path traversal protection
- Server-side upload size, file-count, storage, and concurrency limits
- Authenticated downloads and media previews
- Single-range HTTP streaming with bounded range sizes
- Crash-safe SQLite metadata storage
- Startup storage reconciliation and safe orphan recovery
- Content Security Policy and hardened browser security headers
- Restricted CORS and Socket.IO origins
- Vanilla JavaScript frontend with separated application modules
- Runtime upload/database data excluded from Git

## Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22.5+ |
| Backend | Fastify 5 |
| Realtime | Socket.IO 4 |
| Uploads | `@fastify/multipart` |
| Static files | `@fastify/static` |
| Metadata | Built-in Node SQLite (`node:sqlite`) |
| Frontend | Vanilla JavaScript |
| Styling/build | Tailwind CSS + Vite |
| Language | TypeScript + JavaScript |

## Requirements

- **Node.js 22.5 or newer**
- npm
- A modern browser

Node 22.5+ is required because OB Transfer uses Node's built-in `node:sqlite` API.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the environment

A local `.env` file is included for development and is intentionally ignored by Git. Before using the application, replace the placeholder `ACCESS_PASSWORD` with a strong private password.

For a fresh clone, create the file from the template:

```bash
copy .env.example .env
```

On macOS/Linux:

```bash
cp .env.example .env
```

Then edit `.env`.

### 3. Start development mode

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### 4. Production build

```bash
npm run build
npm start
```

Set `NODE_ENV=production` and use an HTTPS `APP_URL` when deploying behind TLS.

## Environment configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_PASSWORD` | Yes for protected access | — | Private password used for initial authentication. Never commit the real value. |
| `APP_URL` | Recommended | `http://localhost:3000` | Exact browser origin permitted by CORS and Socket.IO. |
| `NODE_ENV` | No | `development` | Use `production` for production deployment. |
| `MAX_FILE_SIZE_BYTES` | No | `10737418240` | Maximum size of one upload. Default: 10 GiB. |
| `MAX_STORAGE_BYTES` | No | `53687091200` | Maximum total runtime storage. Default: 50 GiB. |
| `MAX_FILES` | No | `1000` | Maximum number of stored file records. |
| `DISABLE_HMR` | No | `false` | Disables Vite HMR/watch behavior when required by a restricted development environment. |
| `PORT` | No | `3000` | HTTP port used by the application server. |
| `HOST` | No | `0.0.0.0` | Network interface used by the application server. |
| `LOG_LEVEL` | No | `info` | Fastify/Pino log level. |

## Production hardening
## Final security audit

Phase 20 completes the cumulative security review. The final audit re-checks authentication and session handling, API authorization, Socket.IO origin/authentication, CSP and security headers, CORS, XSS-sensitive DOM paths, upload and filesystem validation, storage quotas and concurrency, range streaming, SQLite metadata integrity, login abuse protection, environment/secrets handling, runtime Git exclusions, production startup/shutdown, project identity, and regression coverage.

The final regression suite is available through `npm test` and includes a startup regression check preventing duplicate `isProduction` declarations in `start()`.


Production startup fails closed when critical configuration is unsafe. With `NODE_ENV=production`, OB Transfer requires:

- an absolute HTTPS `APP_URL`
- an `ACCESS_PASSWORD` that is at least 16 characters and is not the example placeholder
- runtime storage limits appropriate for the host

Additional operational protections include:

- bounded request bodies
- redaction of cookies, authorization headers, and response `Set-Cookie` values from structured logs
- configurable host, port, and log level
- graceful shutdown on `SIGINT` and `SIGTERM`
- cleanup of realtime sockets, Vite, Fastify, and SQLite resources during shutdown
- a minimal unauthenticated `GET /healthz` endpoint for service health checks

For production deployments, terminate TLS at a trusted reverse proxy or load balancer and set `APP_URL` to the public HTTPS origin. Keep `.env`, the SQLite database, and uploaded files outside version control and back them up using your deployment's secure storage process.

### Password guidance

Use a long, unique password. Do not put production credentials in source code, screenshots, documentation, commits, or issue reports.

The repository intentionally ignores `.env` files. Only `.env.example` is intended to be committed.

## Architecture

```text
OB Transfer
├── server.ts                  # Fastify server, auth, APIs, uploads, streaming, SQLite
├── index.html                 # Application shell
├── src/
│   ├── app.js                # UI orchestration and realtime behavior
│   ├── style.css             # Application styling
│   └── modules/
│       ├── api.js            # Authenticated API helpers
│       ├── constants.js       # Shared frontend constants
│       ├── dom.js             # DOM bindings/helpers
│       └── state.js           # Application state
├── data/
│   └── ob-transfer.sqlite3   # Runtime SQLite database (ignored)
├── uploads/                  # Runtime uploaded files (ignored)
├── metadata/                # Legacy migration/runtime metadata area
├── .env.example              # Safe configuration template
├── package.json              # Scripts and dependencies
├── tsconfig.json             # TypeScript configuration
└── vite.config.ts            # Frontend development/build configuration
```

The current architecture deliberately keeps the existing UI and API contracts intact while separating frontend responsibilities into small modules.

## Authentication and authorization

OB Transfer does not send the access password through API query parameters or store it in browser local storage.

The authentication flow is:

```text
Password
   │
   ▼
POST /api/auth
   │
   ▼
Server-side session
   │
   ▼
HttpOnly + SameSite cookie
   │
   ├──► REST API authorization
   └──► Socket.IO authorization
```

Sessions use randomly generated identifiers and expire after the configured server-side session lifetime. Logout revokes the session and disconnects realtime sockets associated with it.

## HTTP API overview

The main authenticated endpoints include:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth` | Authenticate and create a session |
| `GET` | `/api/auth/session` | Check the current authentication session |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/files` | List stored files |
| `POST` | `/api/upload` | Upload a file |
| `GET` | `/api/files/:id/download` | Download a file |
| `GET` | `/api/files/:id/view` | Preview/stream a supported file |
| `DELETE` | `/api/files/:id` | Delete a file |

All file APIs require an authenticated session. File IDs are validated as UUIDs before filesystem access.

## Upload and storage security

Uploads are not stored using user-controlled filenames. The server generates opaque UUID-based storage names and keeps the original filename only as metadata.

The upload pipeline enforces:

- filename normalization
- control-character and unsafe-character filtering
- extension validation
- multipart size limits
- streaming size enforcement
- total storage quota enforcement
- maximum file-count enforcement
- concurrent-upload limits
- partial-upload cleanup
- post-write file-size verification
- metadata creation only after successful storage

Client-provided MIME types are not trusted. The server derives MIME information from the normalized filename and treats unsupported/unsafe preview types as download-only.

## Streaming and range requests

Downloads and supported media previews accept authenticated single-range requests for seeking and resumable transfers.

The server rejects malformed, multi-range, reversed, out-of-bounds, and oversized ranges. Individual range responses are bounded to 64 MiB to reduce resource abuse.

## SQLite metadata

The authoritative metadata store is:

```text
data/ob-transfer.sqlite3
```

The database contains file metadata such as IDs, original names, storage names, sizes, MIME types, upload timestamps, extensions, and modification times.

Metadata writes are transactional. On startup, OB Transfer reconciles database records against physical files, removes stale records, and can recover safe UUID-named orphan files.

Older JSON metadata can be imported during migration from earlier project versions. SQLite is then the authoritative store.

## Browser security

The server applies browser security controls including:

- Content Security Policy
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- strict referrer policy
- same-origin cross-origin resource policy
- production HSTS
- restricted `frame-src` and `object-src`
- production HTTPS upgrade policy
- restricted CORS origins
- exact Socket.IO origin validation

User-controlled filenames and messages are rendered without unsafe HTML interpolation.

## Runtime data and Git

Runtime data must stay out of source control.

Ignored paths include:

```text
.env
uploads/*
metadata/*.json
data/*.sqlite*
dist/
```

The repository keeps placeholder files such as `uploads/.gitkeep` and `data/.gitkeep` so required directories survive a fresh clone.

**Never commit:**

- real passwords
- `.env` files containing secrets
- uploaded files
- SQLite runtime databases
- private metadata
- generated production artifacts unless the deployment process explicitly requires them

## Development commands

```bash
npm install       # install dependencies
npm run dev       # start development server
npm run build     # build frontend and production server bundle
npm start         # run production bundle
npm run lint      # run TypeScript checking
npm run clean     # remove the build output
```

## Verification

The hardening process uses source-level and archive-level checks for areas such as:

- authentication credential leakage
- unsafe DOM interpolation
- project identity consistency
- runtime Git exclusions
- UUID/file-storage validation
- ZIP integrity
- frontend JavaScript syntax

A full dependency install/build may still depend on the local npm cache and network availability. Do not treat a source-level verification pass as equivalent to a successful production build.

## Security roadmap

OB Transfer is being hardened through the following roadmap:

1. Baseline and secret handling
2. Secure authentication
3. API authorization
4. Socket.IO security
5. XSS elimination
6. CSP and browser security
7. CORS/origin security
8. Login abuse protection
9. Upload security
10. Storage quotas and resource protection
11. Range/streaming hardening
12. Metadata reliability
13. SQLite migration
14. Frontend architecture cleanup
15. Dependency cleanup
16. Project identity cleanup
17. Documentation
18. Automated testing
19. Production hardening
20. Final security audit

## Troubleshooting

### The server reports a missing package

Run:

```bash
npm install
```

If npm is operating offline, make sure the required package tarballs are already available in the local npm cache.

### SQLite reports an unsupported API

Verify the Node version:

```bash
node --version
```

Use Node.js 22.5 or newer.

### The browser cannot connect

Check that:

1. OB Transfer is running on port `3000`.
2. `APP_URL` exactly matches the browser origin.
3. The browser is not using an unapproved hostname.
4. A reverse proxy is preserving the expected HTTPS origin in production.

### Login is rejected or rate limited

Confirm that `ACCESS_PASSWORD` in the local `.env` is the password you intended to use. Repeated failed attempts are intentionally rate limited.

## Deployment notes

For production deployments:

- use HTTPS
- set `NODE_ENV=production`
- set an exact HTTPS `APP_URL`
- use a strong private `ACCESS_PASSWORD`
- place the application behind an appropriate reverse proxy/firewall
- back up the SQLite database and uploaded data securely
- restrict filesystem permissions for runtime data
- monitor storage usage and server logs
- keep Node.js and npm dependencies patched
- never expose runtime database files or upload directories directly unless the application requires it

## Security reporting

Please do not publish undisclosed security vulnerabilities in a public issue. Use the private security-reporting process configured for the repository or contact the project maintainer directly.

See [`SECURITY.md`](SECURITY.md) for the project's security-reporting policy.

## License

No open-source license is declared in this repository yet. Until a license is added, assume the code is not licensed for unrestricted redistribution or commercial use.


## Phase 21 — Frontend UX refinement

The frontend received a usability-focused pass without changing the authenticated API contract. Improvements include responsive explorer cards, file search, storage/file summary, refresh feedback, clearer authentication controls, keyboard-accessible file previews, reduced-motion support, cleaner branding, and a fix for duplicate upload dispatch in the queue processor.

For local development, the included `.env` uses `ACCESS_PASSWORD=bibekbista` as requested. Production configuration still requires a strong password and HTTPS.
