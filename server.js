'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const STORAGE_ROOT = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : ROOT;
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');
const MANIFEST_FILE = path.join(DATA_DIR, 'clips.json');
const PORT = Number(process.env.PORT || 3000);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_ADMIN_USER_ID = process.env.DISCORD_ADMIN_USER_ID || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
const MAX_UPLOAD = 250 * 1024 * 1024;
const VALID_SLOTS = new Set(['clip1', 'clip2', 'clip3', 'featured']);
const sessions = new Map();
const oauthStates = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(MANIFEST_FILE)) fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ clips: {} }, null, 2));

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.ogv': 'video/ogg'
};
const videoExtensions = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v', 'video/ogg': '.ogv' };

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); }
  catch { return { clips: {} }; }
}

function saveManifest(manifest) {
  const temp = `${MANIFEST_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2));
  fs.renameSync(temp, MANIFEST_FILE);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function authenticated(req) {
  const token = cookies(req).friend_admin;
  const expiry = token && sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function removeStoredClip(clip) {
  if (!clip?.url?.startsWith('/uploads/')) return;
  const filename = path.basename(clip.url);
  const filePath = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return json(res, 404, { error: 'Not found.' });
    const type = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && type.startsWith('video/')) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
      if (start > end || start >= stats.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        return res.end();
      }
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stats.size}`, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stats.size, 'Accept-Ranges': type.startsWith('video/') ? 'bytes' : 'none' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleUpload(req, res, slot) {
  if (!authenticated(req)) return json(res, 401, { error: 'Please sign in as administrator.' });
  if (!VALID_SLOTS.has(slot)) return json(res, 400, { error: 'Invalid video slot.' });
  const declaredSize = Number(req.headers['content-length'] || 0);
  if (declaredSize > MAX_UPLOAD) return json(res, 413, { error: 'Video must be smaller than 250 MB.' });
  const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const extension = videoExtensions[type];
  if (!extension) return json(res, 415, { error: 'Use MP4, WebM, MOV, M4V, or OGV video.' });

  const filename = `${slot}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${extension}`;
  const finalPath = path.join(UPLOAD_DIR, filename);
  const tempPath = `${finalPath}.upload`;
  const output = fs.createWriteStream(tempPath, { flags: 'wx' });
  let received = 0;
  let failed = false;

  function fail(status, message) {
    if (failed) return;
    failed = true;
    req.unpipe(output);
    output.destroy();
    fs.rm(tempPath, { force: true }, () => json(res, status, { error: message }));
  }

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD) fail(413, 'Video must be smaller than 250 MB.');
  });
  req.on('aborted', () => fail(400, 'Upload was interrupted.'));
  output.on('error', () => fail(500, 'Could not save the video.'));
  output.on('finish', () => {
    if (failed) return;
    fs.renameSync(tempPath, finalPath);
    const manifest = readManifest();
    removeStoredClip(manifest.clips[slot]);
    const originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'video')).slice(0, 160);
    const clip = { url: `/uploads/${filename}`, name: originalName, uploadedAt: new Date().toISOString() };
    manifest.clips[slot] = clip;
    saveManifest(manifest);
    json(res, 201, { clip });
  });
  req.pipe(output);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/clips') return json(res, 200, readManifest());
  if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { authenticated: authenticated(req) });

  if (req.method === 'GET' && pathname === '/auth/discord') {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_ADMIN_USER_ID) {
      res.writeHead(302, { Location: '/?admin=setup' });
      return res.end();
    }
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const redirectUri = `${PUBLIC_URL}/auth/discord/callback`;
    const authorize = new URL('https://discord.com/oauth2/authorize');
    authorize.searchParams.set('client_id', DISCORD_CLIENT_ID);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', 'identify');
    authorize.searchParams.set('state', state);
    res.writeHead(302, { Location: authorize.toString(), 'Set-Cookie': `discord_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE_COOKIE}` });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/auth/discord/callback') {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const cookieState = cookies(req).discord_oauth_state || '';
    const expiry = oauthStates.get(state);
    oauthStates.delete(state);
    if (!code || state !== cookieState || !expiry || expiry < Date.now()) {
      res.writeHead(302, { Location: '/?admin=error' });
      return res.end();
    }

    const redirectUri = `${PUBLIC_URL}/auth/discord/callback`;
    return (async () => {
      try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri })
        });
        if (!tokenResponse.ok) throw new Error('Discord token exchange failed');
        const token = await tokenResponse.json();
        const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
        if (!userResponse.ok) throw new Error('Discord user lookup failed');
        const user = await userResponse.json();
        if (String(user.id) !== String(DISCORD_ADMIN_USER_ID)) {
          res.writeHead(302, { Location: '/?admin=denied', 'Set-Cookie': `discord_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE}` });
          return res.end();
        }
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, Date.now() + 12 * 60 * 60 * 1000);
        res.writeHead(302, { Location: '/?admin=ok', 'Set-Cookie': [`friend_admin=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE_COOKIE}`, `discord_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE}`] });
        return res.end();
      } catch {
        res.writeHead(302, { Location: '/?admin=error' });
        return res.end();
      }
    })();
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = cookies(req).friend_admin;
    if (token) sessions.delete(token);
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': `friend_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE_COOKIE}` });
  }

  const uploadMatch = pathname.match(/^\/api\/upload\/(clip1|clip2|clip3|featured)$/);
  if (req.method === 'POST' && uploadMatch) return handleUpload(req, res, uploadMatch[1]);

  const deleteMatch = pathname.match(/^\/api\/clips\/(clip1|clip2|clip3|featured)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!authenticated(req)) return json(res, 401, { error: 'Please sign in as administrator.' });
    const manifest = readManifest();
    removeStoredClip(manifest.clips[deleteMatch[1]]);
    delete manifest.clips[deleteMatch[1]];
    saveManifest(manifest);
    return json(res, 200, { removed: true });
  }

  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
  if (pathname.startsWith('/uploads/')) {
    const filename = path.basename(pathname);
    return serveFile(req, res, path.join(UPLOAD_DIR, filename));
  }

  const staticFiles = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/script.js': 'script.js', '/assets/founder-a.jpg': 'assets/founder-a.jpg', '/assets/founder-d.jpg': 'assets/founder-d.jpg' };
  const relative = staticFiles[pathname];
  if (!relative) return json(res, 404, { error: 'Not found.' });
  return serveFile(req, res, path.join(ROOT, relative));
});

server.listen(PORT, () => {
  console.log(`Friend is running at http://localhost:${PORT}`);
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_ADMIN_USER_ID) console.log('Discord admin sign-in is not configured yet. See README.md.');
});

module.exports = server;
