import fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import middie from '@fastify/middie';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { randomBytes, timingSafeEqual } from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const METADATA_DIR = path.resolve(__dirname, 'metadata');

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_STORAGE = 50 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 1000;
const MAX_FILENAME_LENGTH = 255;
const MAX_EXTENSION_LENGTH = 32;
const MAX_CONCURRENT_UPLOADS = 4;

const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const normalizeDisplayFilename = (value: unknown) => {
  const input = typeof value === 'string' ? value.normalize('NFKC') : 'download';
  const withoutControls = Array.from(input).filter(char => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  }).join('');
  const basename = path.basename(withoutControls.replace(/\\/g, '/'));
  return basename.replace(/[\r\n"<>:|?*]/g, '_').trim().slice(0, MAX_FILENAME_LENGTH) || 'download';
};

const safeExtension = (filename: string) => {
  const ext = path.extname(filename).toLowerCase();
  if (!ext || ext.length > MAX_EXTENSION_LENGTH || !/^\.[a-z0-9][a-z0-9._-]*$/.test(ext)) return '';
  return ext;
};

const isPreviewableMime = (value: string) =>
  /^(image\/(?:png|jpeg|gif|webp|bmp|avif)|video\/(?:mp4|webm|ogg)|audio\/(?:mpeg|mp4|ogg|wav|webm|aac)|application\/pdf)$/i.test(value);


async function start() {
  // Ensure directories exist
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(METADATA_DIR);

  const app = fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  // Security & Middleware
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api')) {
      app.log.info(`API Request: ${request.method} ${request.url}`);
    }
  });

  await app.register(middie);
  const configuredAppUrl = process.env.APP_URL || 'http://localhost:3000';
  const configuredUrl = new URL(configuredAppUrl);
  const configuredOrigin = configuredUrl.origin;
  const websocketOrigin = `${configuredUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${configuredUrl.host}`;
  const allowedOrigins = new Set([configuredOrigin]);
  const isProduction = process.env.NODE_ENV === 'production';

  // Browser security policy. Keep the policy explicit because the UI currently
  // depends on Socket.IO, canvas-confetti, and Google Fonts from known CDNs.
  // No wildcard script/connect/font sources are permitted.
  const cspDirectives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'none'"],
    formAction: ["'self'"],
    scriptSrc: ["'self'", 'https://cdn.socket.io', 'https://cdn.jsdelivr.net'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:'],
    mediaSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", websocketOrigin],
    workerSrc: ["'self'", 'blob:'],
  };

  if (isProduction) {
    cspDirectives.upgradeInsecureRequests = [];
  }

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: isProduction ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: false,
    } : false,
  });

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Same-origin requests normally omit Origin. Cross-origin browser requests
      // must match the configured application origin exactly.
      if (!origin) return cb(null, true);
      const normalizedOrigin = origin.replace(/\/$/, '');
      if (allowedOrigins.has(normalizedOrigin)) return cb(null, true);
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400,
  });

  const MAX_FILE_SIZE = parsePositiveIntegerEnv('MAX_FILE_SIZE_BYTES', DEFAULT_MAX_FILE_SIZE);
  const MAX_STORAGE_BYTES = parsePositiveIntegerEnv('MAX_STORAGE_BYTES', DEFAULT_MAX_STORAGE);
  const MAX_FILES = parsePositiveIntegerEnv('MAX_FILES', DEFAULT_MAX_FILES);

  // Multipart limits are a first line of defense; the upload route also enforces
  // byte counts while streaming so the limits cannot be bypassed by malformed bodies.
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 4, parts: 5 }
  });

  let activeUploads = 0;
  let reservedUploadBytes = 0;

  const getStoredBytes = async () => {
    let total = 0;
    for (const name of await fs.readdir(UPLOADS_DIR)) {
      try {
        const stat = await fs.stat(path.join(UPLOADS_DIR, name));
        if (stat.isFile()) total += stat.size;
      } catch { /* file may disappear during inspection */ }
    }
    return total;
  };

  const getMetadataCount = async () =>
    (await fs.readdir(METADATA_DIR)).filter(name => name.endsWith('.json')).length;

  // --- Authentication / Sessions ---
  const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  const SESSION_COOKIE = 'ob_transfer_session';
  const sessions = new Map<string, { createdAt: number; lastSeenAt: number }>();

  // Authentication abuse protection. Keep this intentionally dependency-free so the
  // protection is available before a session exists. A client gets five failed
  // attempts per 15-minute window; repeated failures also incur a small delay.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 5;
  const loginFailures = new Map<string, { count: number; firstFailureAt: number; lastFailureAt: number }>();

  const getClientKey = (request: any) => {
    // Fastify's request.ip is the normalized peer address. Do not trust arbitrary
    // forwarding headers unless the server is explicitly configured with a trusted proxy.
    return String(request.ip || request.socket?.remoteAddress || 'unknown');
  };

  const pruneLoginFailures = () => {
    const now = Date.now();
    for (const [key, entry] of loginFailures) {
      if (now - entry.firstFailureAt >= LOGIN_WINDOW_MS) loginFailures.delete(key);
    }
  };

  const getLoginLimit = (clientKey: string) => {
    const entry = loginFailures.get(clientKey);
    if (!entry) return { blocked: false, retryAfterSeconds: 0, delayMs: 0 };
    const elapsed = Date.now() - entry.firstFailureAt;
    if (elapsed >= LOGIN_WINDOW_MS) {
      loginFailures.delete(clientKey);
      return { blocked: false, retryAfterSeconds: 0, delayMs: 0 };
    }
    const retryAfterSeconds = Math.ceil((LOGIN_WINDOW_MS - elapsed) / 1000);
    const blocked = entry.count >= LOGIN_MAX_FAILURES;
    // 250ms, 500ms, 1s, 2s delays after consecutive failures.
    const delayMs = Math.min(2000, 250 * (2 ** Math.max(0, entry.count - 1)));
    return { blocked, retryAfterSeconds, delayMs };
  };

  const recordLoginFailure = (clientKey: string) => {
    const now = Date.now();
    const existing = loginFailures.get(clientKey);
    if (!existing || now - existing.firstFailureAt >= LOGIN_WINDOW_MS) {
      loginFailures.set(clientKey, { count: 1, firstFailureAt: now, lastFailureAt: now });
      return;
    }
    existing.count += 1;
    existing.lastFailureAt = now;
  };

  const clearLoginFailures = (clientKey: string) => loginFailures.delete(clientKey);

  const loginFailureCleanupTimer = setInterval(pruneLoginFailures, 5 * 60 * 1000);
  loginFailureCleanupTimer.unref();

  const sessionCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(sessionId);
    }
  }, 15 * 60 * 1000);
  sessionCleanupTimer.unref();

  const parseCookies = (header?: string) => {
    const cookies: Record<string, string> = {};
    for (const part of (header || '').split(';')) {
      const [key, ...valueParts] = part.trim().split('=');
      if (!key) continue;
      cookies[key] = decodeURIComponent(valueParts.join('='));
    }
    return cookies;
  };

  const getSession = (request: any) => {
    if (!ACCESS_PASSWORD) return { authenticated: true, sessionId: null };
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!sessionId) return { authenticated: false, sessionId: null };

    const session = sessions.get(sessionId);
    if (!session || Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      return { authenticated: false, sessionId };
    }

    session.lastSeenAt = Date.now();
    return { authenticated: true, sessionId };
  };

  const setSessionCookie = (reply: any, sessionId: string) => {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const secure = isProduction ? '; Secure' : '';
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
  };

  const clearSessionCookie = (reply: any) => {
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`);
  };

  const passwordsMatch = (candidate: unknown) => {
    if (typeof candidate !== 'string' || typeof ACCESS_PASSWORD !== 'string') return false;
    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(ACCESS_PASSWORD);
    return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
  };

  // Socket.io
  const io = new Server(app.server, {
    cors: {
      origin: configuredOrigin,
      credentials: true,
    },
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      if (!origin) return callback('Origin required', false);
      if (allowedOrigins.has(origin.replace(/\/$/, ''))) return callback(null, true);
      return callback('Origin not allowed', false);
    },
  });

  io.use((socket, next) => {
    if (!ACCESS_PASSWORD) return next();
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
      if (sessionId) sessions.delete(sessionId);
      return next(new Error('Unauthorized'));
    }
    session.lastSeenAt = Date.now();
    socket.data.sessionId = sessionId;
    next();
  });

  io.on('connection', (socket) => {
    app.log.info({ socketId: socket.id }, 'Authenticated realtime client connected');
    socket.emit('status', { connected: true });
    socket.on('disconnect', () => app.log.info({ socketId: socket.id }, 'Realtime client disconnected'));
  });

  const socketSessionCleanupTimer = setInterval(() => {
    if (!ACCESS_PASSWORD) return;
    const now = Date.now();
    for (const socket of io.sockets.sockets.values()) {
      const sessionId = socket.data.sessionId as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || now - session.lastSeenAt > SESSION_TTL_MS) {
        socket.disconnect(true);
      }
    }
  }, 60 * 1000);
  socketSessionCleanupTimer.unref();

  // API authorization boundary. Only the authentication bootstrap endpoints are public;
  // every other /api route requires a valid server-side session. This deny-by-default
  // policy prevents newly-added API routes from accidentally becoming public.
  const PUBLIC_API_ROUTES = new Set(['/api/auth', '/api/auth/session']);

  const requireApiAuth = async (request: any, reply: any) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api') || PUBLIC_API_ROUTES.has(url)) return;

    const session = getSession(request);
    if (!session.authenticated) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    // Make the authorization result available to route handlers without exposing
    // the session identifier to application code or the client.
    request.authenticated = true;
  };

  app.addHook('preHandler', requireApiAuth);

  // Protected API responses contain private file metadata/content. Never allow
  // an intermediary/browser cache to retain them beyond the active request.
  app.addHook('onSend', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (url.startsWith('/api') && !PUBLIC_API_ROUTES.has(url)) {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
    }
  });

  const isValidFileId = (value: unknown) =>
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  const requireValidFileId = (request: any, reply: any) => {
    const { id } = request.params as { id?: unknown };
    if (!isValidFileId(id)) {
      reply.code(400).send({ error: 'INVALID_FILE_ID', message: 'Invalid file identifier' });
      return false;
    }
    return true;
  };

  // --- API ROUTES ---

  app.post('/api/auth', async (request, reply) => {
    if (!ACCESS_PASSWORD) return { success: true, authenticated: true };

    const clientKey = getClientKey(request);
    const limit = getLoginLimit(clientKey);
    if (limit.blocked) {
      reply.header('Retry-After', String(limit.retryAfterSeconds));
      app.log.warn({ clientKey }, 'Login rate limit exceeded');
      return reply.code(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many failed login attempts. Try again later.'
      });
    }

    const { password } = (request.body || {}) as any;
    if (typeof password !== 'string' || password.length > 1024 || !passwordsMatch(password)) {
      recordLoginFailure(clientKey);
      const nextLimit = getLoginLimit(clientKey);
      if (nextLimit.delayMs > 0) await new Promise(resolve => setTimeout(resolve, nextLimit.delayMs));
      app.log.warn({ clientKey, failures: loginFailures.get(clientKey)?.count || 1 }, 'Login authentication failed');
      if (nextLimit.blocked) reply.header('Retry-After', String(nextLimit.retryAfterSeconds));
      return reply.code(nextLimit.blocked ? 429 : 401).send({
        error: nextLimit.blocked ? 'RATE_LIMITED' : 'UNAUTHORIZED',
        message: nextLimit.blocked ? 'Too many failed login attempts. Try again later.' : 'Access denied'
      });
    }

    clearLoginFailures(clientKey);
    app.log.info({ clientKey }, 'Login authentication succeeded');
    const sessionId = randomBytes(32).toString('hex');
    const now = Date.now();
    sessions.set(sessionId, { createdAt: now, lastSeenAt: now });
    setSessionCookie(reply, sessionId);
    return { success: true, authenticated: true };
  });

  app.get('/api/auth/session', async (request, reply) => {
    const session = getSession(request);
    if (!session.authenticated) return reply.code(401).send({ authenticated: false });
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const session = getSession(request);
    const sessionId = session.sessionId;
    if (session.authenticated && sessionId) {
      sessions.delete(sessionId);
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionId === sessionId) socket.disconnect(true);
      }
    }
    clearSessionCookie(reply);
    return { success: true };
  });

  app.get('/api/files', async (request, reply) => {

    const metadataFiles = await fs.readdir(METADATA_DIR);
    const metadataList = await Promise.all(
      metadataFiles.filter(f => f.endsWith('.json')).map(async (f) => {
        try {
          return await fs.readJson(path.join(METADATA_DIR, f));
        } catch (e) {
          return null;
        }
      })
    );
    
    let validMetadata = metadataList.filter(m => m !== null);
    
    // Check UPLOADS_DIR for missing metadata
    const uploadFiles = await fs.readdir(UPLOADS_DIR);
    const processedStoredNames = new Set(validMetadata.map(m => m.storedName));
    
    for (const fileName of uploadFiles) {
      if (!processedStoredNames.has(fileName)) {
        try {
          const filePath = path.join(UPLOADS_DIR, fileName);
          const stats = await fs.stat(filePath);
          const fileId = uuidv4();
          const extension = path.extname(fileName);
          
          // Try to reconstruct original name if it follows the pattern
          let originalName = fileName;
          const match = fileName.match(/^\d+-(.*)-by-bibek/);
          if (match) {
            originalName = match[1] + extension;
          }

          const metadata = {
            id: fileId,
            originalName,
            storedName: fileName,
            fileSize: stats.size,
            mimeType: mime.lookup(extension) || 'application/octet-stream',
            uploadDate: stats.birthtimeMs || stats.mtimeMs,
            extension: extension.toLowerCase(),
            lastModified: stats.mtimeMs,
          };
          
          await fs.writeJson(path.join(METADATA_DIR, `${fileId}.json`), metadata);
          validMetadata.push(metadata);
        } catch (err) {
          app.log.error({ err, fileName }, 'Index failed');
        }
      }
    }

    return validMetadata.sort((a, b) => b.uploadDate - a.uploadDate);
  });

  app.post('/api/upload', async (request, reply) => {
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      return reply.code(429).send({ error: 'UPLOAD_BUSY', message: 'Too many uploads are active. Try again shortly.' });
    }

    const contentLength = Number(request.headers['content-length'] || 0);
    const knownBodySize = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    const currentStoredBytes = await getStoredBytes();
    const metadataCount = await getMetadataCount();

    if (metadataCount >= MAX_FILES) return reply.code(413).send({ error: 'FILE_COUNT_LIMIT', message: 'Storage file limit reached.' });
    if (knownBodySize > MAX_FILE_SIZE) return reply.code(413).send({ error: 'FILE_TOO_LARGE', message: 'File exceeds the maximum upload size.' });
    if (knownBodySize > 0 && currentStoredBytes + reservedUploadBytes + knownBodySize > MAX_STORAGE_BYTES) {
      return reply.code(413).send({ error: 'STORAGE_QUOTA_EXCEEDED', message: 'Storage quota exceeded.' });
    }

    activeUploads += 1;
    reservedUploadBytes += knownBodySize;
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      reservationReleased = true;
      activeUploads = Math.max(0, activeUploads - 1);
      reservedUploadBytes = Math.max(0, reservedUploadBytes - knownBodySize);
    };

    let filePath = '';
    let fileId = '';
    try {
      const data = await request.file();
      if (!data) {
        releaseReservation();
        return reply.code(400).send({ error: 'NO_FILE', message: 'No file was provided.' });
      }

      const originalName = normalizeDisplayFilename(data.filename);
      const extension = safeExtension(originalName);
      const trustedMimeType = mime.lookup(originalName) || 'application/octet-stream';
      fileId = uuidv4();

      // User filenames never become filesystem paths. Storage uses an opaque UUID.
      const storedName = `${fileId}${extension}`;
      filePath = path.join(UPLOADS_DIR, storedName);
      const outStream = fs.createWriteStream(filePath, { flags: 'wx' });
      let bytesWritten = 0;
      let limitError: Error | null = null;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          data.file.unpipe(outStream);
          outStream.destroy();
          reject(err);
        };
        data.file.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length;
          if (bytesWritten > MAX_FILE_SIZE || currentStoredBytes + (reservedUploadBytes - knownBodySize) + bytesWritten > MAX_STORAGE_BYTES) {
            limitError = new Error('Upload resource limit exceeded');
            data.file.destroy(limitError);
          }
        });
        data.file.on('error', fail);
        outStream.on('error', fail);
        outStream.on('finish', () => {
          if (!settled) { settled = true; resolve(); }
        });
        data.file.pipe(outStream);
      });

      if (bytesWritten <= 0) {
        await fs.remove(filePath);
        releaseReservation();
        return reply.code(400).send({ error: 'EMPTY_FILE', message: 'Empty files are not allowed.' });
      }
      if (limitError || bytesWritten > MAX_FILE_SIZE || currentStoredBytes + bytesWritten > MAX_STORAGE_BYTES) {
        await fs.remove(filePath);
        releaseReservation();
        return reply.code(413).send({ error: 'STORAGE_LIMIT', message: 'Upload exceeds the configured resource limit.' });
      }

      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size !== bytesWritten) throw new Error('Uploaded file size could not be verified');

      const metadata = {
        id: fileId,
        originalName,
        storedName,
        fileSize: stats.size,
        // Never trust the browser's multipart MIME value.
        mimeType: trustedMimeType,
        uploadDate: Date.now(),
        extension,
        lastModified: stats.mtimeMs,
      };

      await fs.writeJson(path.join(METADATA_DIR, `${fileId}.json`), metadata, { spaces: 2, flag: 'wx' });
      releaseReservation();
      io.emit('file:uploaded', metadata);
      return metadata;
    } catch (err: any) {
      if (filePath) await fs.remove(filePath).catch(() => undefined);
      if (fileId) await fs.remove(path.join(METADATA_DIR, `${fileId}.json`)).catch(() => undefined);
      releaseReservation();
      if (String(err?.message || '').includes('File too large') || String(err?.message || '').includes('resource limit')) {
        return reply.code(413).send({ error: 'UPLOAD_LIMIT', message: 'Upload exceeds the configured resource limit.' });
      }
      request.log.error({ err }, 'Upload failed and partial data was cleaned up');
      return reply.code(500).send({ error: 'TRANSFER_FAILED', message: 'Transfer could not be completed safely.' });
    }
  });

  app.get('/api/files/:id/download', async (request, reply) => {
    if (!requireValidFileId(request, reply)) return;
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    if (!metadata || typeof metadata.storedName !== 'string' || path.basename(metadata.storedName) !== metadata.storedName) {
      return reply.code(500).send({ error: 'INVALID_METADATA' });
    }
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);
    if (!filePath.startsWith(`${UPLOADS_DIR}${path.sep}`)) return reply.code(400).send({ error: 'INVALID_STORAGE_PATH' });
    const stats = await fs.stat(filePath);

    const safeDownloadName = String(metadata.originalName || 'download')
      .replace(/[\r\n\"]/g, '_')
      .slice(0, 180) || 'download';
    reply.headers({
      'Content-Length': stats.size,
      'Content-Type': metadata.mimeType,
      'Content-Disposition': `attachment; filename="${safeDownloadName}"`,
    });
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/api/files/:id/view', async (request, reply) => {
    if (!requireValidFileId(request, reply)) return;
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    if (!metadata || typeof metadata.storedName !== 'string' || path.basename(metadata.storedName) !== metadata.storedName) {
      return reply.code(500).send({ error: 'INVALID_METADATA' });
    }
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);
    if (!filePath.startsWith(`${UPLOADS_DIR}${path.sep}`)) return reply.code(400).send({ error: 'INVALID_STORAGE_PATH' });
    const stats = await fs.stat(filePath);
    const responseMime = typeof metadata.mimeType === 'string' ? metadata.mimeType : 'application/octet-stream';
    if (!isPreviewableMime(responseMime)) {
      return reply.code(415).send({ error: 'PREVIEW_NOT_SUPPORTED', message: 'This file type is download-only.' });
    }
    const range = request.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      
      reply.code(206).headers({
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': metadata.mimeType,
      });
      return reply.send(fs.createReadStream(filePath, { start, end }));
    } else {
      reply.headers({
        'Content-Length': stats.size,
        'Content-Type': metadata.mimeType,
      });
      return reply.send(fs.createReadStream(filePath));
    }
  });

  app.delete('/api/files/:id', async (request, reply) => {
    if (!requireValidFileId(request, reply)) return;
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    if (!metadata || typeof metadata.storedName !== 'string' || path.basename(metadata.storedName) !== metadata.storedName) {
      return reply.code(500).send({ error: 'INVALID_METADATA' });
    }
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);
    if (!filePath.startsWith(`${UPLOADS_DIR}${path.sep}`)) return reply.code(400).send({ error: 'INVALID_STORAGE_PATH' });

    await fs.remove(filePath);
    await fs.remove(metadataPath);
    io.emit('file:deleted', { id });
    return { success: true };
  });

  // --- VITE / STATIC SERVING ---

  let vite: any;
  if (process.env.NODE_ENV !== 'production') {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    // Still use middie for Vite's static asset serving
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    await app.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
      wildcard: false,
    });
  }

  // Catch-all route for SPA
  app.get('*', async (request, reply) => {
    const url = request.url;
    
    // Explicitly ignore API routes in catch-all
    if (url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Route not found' });
    }

    if (process.env.NODE_ENV !== 'production') {
      try {
        let template = await fs.readFile(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        return reply.type('text/html').send(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        return reply.code(500).send(e.stack);
      }
    } else {
      const distPath = path.resolve(__dirname, 'dist');
      return reply.sendFile('index.html', distPath);
    }
  });

  const PORT = 3000;
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`OB Transfer server running on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
