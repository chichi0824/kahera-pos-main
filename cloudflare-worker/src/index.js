const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function b64url(bytes) {
  let binary = '';
  new Uint8Array(bytes).forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromB64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
async function makeToken(secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 })));
  return payload + '.' + b64url(await hmac(payload, secret));
}
async function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = await hmac(parts[0], secret);
  let actual;
  try { actual = fromB64url(parts[1]); } catch (_) { return false; }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return payload.role === 'admin' && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) { return false; }
}
function constantTimeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0;
}
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.APP_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : '';
}
function corsHeaders(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } : {};
}
function decodeGitHubContent(content) {
  const clean = content.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encodeGitHubContent(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function parseSample(source) {
  const match = source.match(/root\.KAHERA_SAMPLE\s*=\s*([\s\S]*?);\s*\}\)\(/);
  if (!match) throw new Error('menu-sample.js is not in the supported JSON-compatible format. Deploy the updated starter file first.');
  return JSON.parse(match[1]);
}
function renderSample(data) {
  return '/**\n * Kahera POS — menu-sample.js\n * Official shared menu. Updated by the authenticated Kahera admin API.\n * Prices are VAT-inclusive and stored in centavos.\n */\n(function (root) {\n  \'use strict\';\n  root.KAHERA_SAMPLE = ' + JSON.stringify(data, null, 2) + ';\n})(typeof self !== \'undefined\' ? self : this);\n';
}
function validateMenu(body) {
  if (!body || !body.settings || !Array.isArray(body.categories) || !Array.isArray(body.menu)) throw new Error('Menu payload is incomplete.');
  if (body.menu.length > 500 || body.categories.length > 30) throw new Error('Menu exceeds the allowed item or category limit.');
  const catIds = new Set();
  for (const cat of body.categories) {
    if (!cat || typeof cat.id !== 'string' || typeof cat.name !== 'string' || !cat.id || !cat.name.trim() || catIds.has(cat.id)) throw new Error('A menu category is invalid.');
    catIds.add(cat.id);
  }
  const itemIds = new Set();
  for (const item of body.menu) {
    if (!item || typeof item.id !== 'string' || !item.id || itemIds.has(item.id)) throw new Error('A menu item has a missing or duplicate ID.');
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 40) throw new Error('A menu item name is invalid.');
    if (!catIds.has(item.cat)) throw new Error('A menu item refers to an unknown category.');
    if (!Number.isSafeInteger(item.price) || item.price < 1 || item.price > 100000000) throw new Error('A menu item price is invalid.');
    if (typeof item.available !== 'boolean') throw new Error('A menu item availability value is invalid.');
    itemIds.add(item.id);
  }
  if (typeof body.settings.bizName !== 'string' || typeof body.settings.bizNote !== 'string' || typeof body.settings.vatRegistered !== 'boolean') throw new Error('Store settings are invalid.');
}
async function githubRequest(env, method, body) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/js/menu-sample.js`;
  const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Kahera-Menu-Worker' };
  return fetch(url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function getSample(env) {
  const response = await githubRequest(env, 'GET');
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}). Check the token's Contents: Read permission.`);
  const file = await response.json();
  return { data: parseSample(decodeGitHubContent(file.content)), sha: file.sha };
}
function bearer(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      if (!origin) return json({ error: 'Origin is not allowed.' }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.headers.has('Origin') && !origin) return json({ error: 'Origin is not allowed.' }, 403);
    const headers = corsHeaders(origin);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        if (typeof body.password !== 'string' || !env.ADMIN_PASSWORD || !constantTimeEqual(body.password, env.ADMIN_PASSWORD)) return json({ error: 'Incorrect administrator password.' }, 401, headers);
        return json({ token: await makeToken(env.SESSION_SECRET), expiresIn: 28800 }, 200, headers);
      }
      if (url.pathname === '/api/menu' && request.method === 'GET') {
        const { data } = await getSample(env);
        return json({ settings: data.settings, categories: data.categories, menu: data.menu }, 200, headers);
      }
      if (url.pathname === '/api/menu' && request.method === 'PUT') {
        if (!(await verifyToken(bearer(request), env.SESSION_SECRET))) return json({ error: 'Administrator session expired. Please log in again.' }, 401, headers);
        const body = await request.json();
        validateMenu(body);
        const current = await getSample(env);
        const next = { ...current.data, settings: body.settings, categories: body.categories, menu: body.menu };
        const content = renderSample(next);
        const response = await githubRequest(env, 'PUT', {
          message: 'Update Kahera shared menu', content: encodeGitHubContent(content), sha: current.sha,
          branch: env.GITHUB_BRANCH || 'main'
        });
        if (response.status === 409 || response.status === 422) return json({ error: 'The GitHub menu changed during this save. Refresh Kahera and try again.' }, 409, headers);
        if (!response.ok) return json({ error: `GitHub could not update menu-sample.js (${response.status}). Check Contents: Write permission.` }, 502, headers);
        const result = await response.json();
        return json({ ok: true, commit: result.commit && result.commit.sha, message: 'Shared menu committed to GitHub.' }, 200, headers);
      }
      return json({ error: 'Not found.' }, 404, headers);
    } catch (error) {
      return json({ error: error.message || 'Unexpected server error.' }, 500, headers);
    }
  }
};
