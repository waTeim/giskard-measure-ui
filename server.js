'use strict';
/*
 * Giskard Monitor — static server + read-only reverse proxy.
 *
 * Serves the single-page UI from ./public and proxies the three documented
 * giskard-measure endpoints (/config, /metrics, /live/{product}) to the upstream
 * API named by GISKARD_API_BASE, so the browser talks to them same-origin (no CORS).
 *
 * Zero runtime dependencies — Node >= 18 (uses only core http/https/fs/url).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = (process.env.GISKARD_API_BASE || '').replace(/\/+$/, '');
const API_TIMEOUT_MS = parseInt(process.env.GISKARD_API_TIMEOUT_MS || '5000', 10);
const METRICS_POLL_MS = parseInt(process.env.METRICS_POLL_MS || '3000', 10);
const LIVE_POLL_MS = parseInt(process.env.LIVE_POLL_MS || '5000', 10);
const INSTANCE_LABEL = process.env.INSTANCE_LABEL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Only these path prefixes are proxied upstream. Everything is GET / read-only.
const PROXY_EXACT = new Set(['/config', '/metrics']);
const PROXY_PREFIX = ['/live/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

// ---------------------------------------------------------------- index html (+ runtime config injection)
function buildRuntimeConfigScript() {
  const cfg = {
    metrics_ms: METRICS_POLL_MS,
    live_ms: LIVE_POLL_MS
  };
  return (
    '<script>' +
    'window.__GISKARD_POLL__=' + JSON.stringify(cfg) + ';' +
    'window.__GISKARD_API_PREFIX__=' + JSON.stringify('') + ';' +
    'window.__GISKARD_INSTANCE__=' + JSON.stringify(INSTANCE_LABEL) + ';' +
    '</script>'
  );
}

let INDEX_HTML = null;
function loadIndex() {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const inject = buildRuntimeConfigScript();
  // Inject just after the opening <head> so the config exists before app scripts run.
  if (/<head[^>]*>/i.test(raw)) {
    INDEX_HTML = raw.replace(/(<head[^>]*>)/i, '$1' + inject);
  } else {
    INDEX_HTML = inject + raw;
  }
}

// ---------------------------------------------------------------- helpers
function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function isProxyPath(pathname) {
  if (PROXY_EXACT.has(pathname)) return true;
  return PROXY_PREFIX.some((p) => pathname.startsWith(p));
}

// ---------------------------------------------------------------- upstream proxy
function proxy(req, res, pathname, search) {
  if (!API_BASE) {
    return sendJSON(res, 502, { error: 'upstream_unconfigured', detail: 'GISKARD_API_BASE is not set' });
  }
  let target;
  try {
    target = new URL(API_BASE);
    target.pathname = (target.pathname.replace(/\/+$/, '')) + pathname;
    target.search = search || '';
  } catch (e) {
    return sendJSON(res, 500, { error: 'bad_target', detail: String(e && e.message || e) });
  }

  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.request(
    target,
    {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'giskard-measure-ui-proxy' },
      timeout: API_TIMEOUT_MS
    },
    (up) => {
      const ct = up.headers['content-type'] || 'application/json; charset=utf-8';
      res.writeHead(up.statusCode || 502, {
        'content-type': ct,
        'cache-control': 'no-store'
      });
      up.pipe(res);
    }
  );

  upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: 'upstream_unreachable', detail: String(err && err.message || err) });
    else res.end();
  });
  upstream.end();
}

// ---------------------------------------------------------------- readiness (deep) — checks upstream
function ready(res) {
  if (!API_BASE) return sendJSON(res, 503, { status: 'degraded', upstream: 'unconfigured' });
  let target;
  try {
    target = new URL(API_BASE);
    target.pathname = (target.pathname.replace(/\/+$/, '')) + '/config';
  } catch (e) {
    return sendJSON(res, 500, { status: 'error', detail: String(e) });
  }
  const lib = target.protocol === 'https:' ? https : http;
  const r = lib.request(target, { method: 'GET', timeout: API_TIMEOUT_MS }, (up) => {
    up.resume();
    sendJSON(res, up.statusCode && up.statusCode < 500 ? 200 : 503, {
      status: up.statusCode && up.statusCode < 500 ? 'ok' : 'degraded',
      upstream_status: up.statusCode
    });
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', (err) => sendJSON(res, 503, { status: 'degraded', detail: String(err && err.message || err) }));
  r.end();
}

// ---------------------------------------------------------------- static
function serveStatic(res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    const body = Buffer.from(INDEX_HTML);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': body.length });
    return res.end(body);
  }
  // Resolve safely under PUBLIC_DIR (no traversal).
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA: unknown non-API path falls back to the app shell.
      const body = Buffer.from(INDEX_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': body.length });
      return res.end(body);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- router
const server = http.createServer((req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400); return res.end('bad request'); }
  const pathname = parsed.pathname;

  if (pathname === '/healthz') return sendJSON(res, 200, { status: 'ok', instance: INSTANCE_LABEL || undefined });
  if (pathname === '/readyz') return ready(res);

  if (isProxyPath(pathname)) {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end('method not allowed'); }
    return proxy(req, res, pathname, parsed.search);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET' }); return res.end('method not allowed'); }
  return serveStatic(res, pathname);
});

loadIndex();
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: 'giskard-measure-ui listening',
    host: HOST, port: PORT,
    upstream: API_BASE || '(unset — UI runs in simulation fallback)',
    instance: INSTANCE_LABEL || undefined,
    poll: { metrics_ms: METRICS_POLL_MS, live_ms: LIVE_POLL_MS }
  }));
});
