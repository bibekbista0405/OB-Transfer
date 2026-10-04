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
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyCors, { origin: '*' });

  // Multipart for streaming uploads
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024 * 1024, // 10GB
    }
  });

  // --- Authentication / Sessions ---
  const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  const SESSION_COOKIE = 'ob_transfer_session';
  const sessions = new Map<string, { createdAt: number; lastSeenAt: number }>();
  const isProduction = process.env.NODE_ENV === 'production';
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
    cors: { origin: process.env.APP_URL || 'http://localhost:3000' }
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
    next();
  });

  io.on('connection', (socket) => {
    app.log.info({ socketId: socket.id }, 'Authenticated realtime client connected');
    socket.emit('status', { connected: true });
    socket.on('disconnect', () => app.log.info({ socketId: socket.id }, 'Realtime client disconnected'));
  });

  // Authentication hook. Protected API requests require a server-side session.
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api') || url === '/api/auth' || url === '/api/auth/session') return;
    const session = getSession(request);
    if (!session.authenticated) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  });

  // --- API ROUTES ---

  app.post('/api/auth', async (request, reply) => {
    if (!ACCESS_PASSWORD) return { success: true, authenticated: true };

    const { password } = (request.body || {}) as any;
    if (!passwordsMatch(password)) {
      return reply.code(401).send({ error: 'Access denied' });
    }

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
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);
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
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No data stream' });

    const originalName = data.filename;
    const timestamp = Date.now();
    const extension = path.extname(originalName);
    const nameWithoutExt = path.basename(originalName, extension).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    
    const storedName = `${timestamp}-${nameWithoutExt}-by-bibek${extension}`;
    const filePath = path.join(UPLOADS_DIR, storedName);
    const fileId = uuidv4();

    const outStream = fs.createWriteStream(filePath);
    
    try {
      await new Promise((resolve, reject) => {
        data.file.pipe(outStream);
        data.file.on('end', resolve);
        data.file.on('error', reject);
      });

      const stats = await fs.stat(filePath);
      const metadata = {
        id: fileId,
        originalName,
        storedName,
        fileSize: stats.size,
        mimeType: data.mimetype || mime.lookup(extension) || 'application/octet-stream',
        uploadDate: timestamp,
        extension: extension.toLowerCase(),
        lastModified: stats.mtimeMs,
      };

      await fs.writeJson(path.join(METADATA_DIR, `${fileId}.json`), metadata);
      io.emit('file:uploaded', metadata);
      return metadata;
    } catch (err) {
      await fs.remove(filePath);
      return reply.code(500).send({ error: 'Transfer corrupted' });
    }
  });

  app.get('/api/files/:id/download', async (request, reply) => {
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);
    const stats = await fs.stat(filePath);

    reply.headers({
      'Content-Length': stats.size,
      'Content-Type': metadata.mimeType,
      'Content-Disposition': `attachment; filename="${metadata.originalName}"`,
    });
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/api/files/:id/view', async (request, reply) => {
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);
    const stats = await fs.stat(filePath);
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
    const { id } = request.params as any;
    const metadataPath = path.join(METADATA_DIR, `${id}.json`);
    if (!await fs.pathExists(metadataPath)) return reply.code(404).send({ error: 'Missing' });

    const metadata = await fs.readJson(metadataPath);
    const filePath = path.join(UPLOADS_DIR, metadata.storedName);

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
    console.log(`Nebula Core online at http://0.0.0.0:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
