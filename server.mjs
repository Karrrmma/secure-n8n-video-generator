import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import crypto from 'node:crypto';
import { createVideoJob, getVideoJobStatus } from './website-backend/video-workflow-client.mjs';

const root = process.cwd();
const publicDir = join(root, 'public');

loadDotEnv(join(root, '.env'));

const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const rateLimits = new Map();

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

function getOrCreateUserId(req, res) {
  const existing = getCookie(req, 'vg_user');
  if (/^[0-9a-f-]{36}$/i.test(existing)) return existing.toLowerCase();

  const userId = crypto.randomUUID();
  res.setHeader('Set-Cookie', [
    `vg_user=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  ]);
  return userId;
}

function checkRateLimit(req, userId) {
  const now = Date.now();
  const key = userId || req.socket.remoteAddress || 'unknown';
  const windowMs = 60_000;
  const maxRequests = 20;
  const bucket = rateLimits.get(key) || [];
  const recent = bucket.filter((timestamp) => now - timestamp < windowMs);
  recent.push(now);
  rateLimits.set(key, recent);
  if (recent.length > maxRequests) {
    throw Object.assign(new Error('Too many requests. Please slow down.'), { status: 429 });
  }
}

async function handleApi(req, res, url) {
  const userId = getOrCreateUserId(req, res);
  checkRateLimit(req, userId);

  if (req.method === 'POST' && url.pathname === '/api/videos') {
    const input = await readJson(req);
    const result = await createVideoJob(userId, input);
    return json(res, 202, result);
  }

  const statusMatch = url.pathname.match(/^\/api\/videos\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && statusMatch) {
    const result = await getVideoJobStatus(userId, statusMatch[1]);
    return json(res, 200, result);
  }

  return json(res, 404, { error: 'API route not found.' });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return json(res, 404, { error: 'Not found.' });
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    json(res, status, {
      error: status >= 500 ? 'Something went wrong.' : error.message,
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Video generator app running at http://127.0.0.1:${port}`);
});
