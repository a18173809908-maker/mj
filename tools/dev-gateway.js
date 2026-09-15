/**
 * 本地测试网关 —— 扮演 nginx 的角色
 *
 * 作用：一个端口上同时提供「静态前端」和「/api 后端」，让浏览器端到端测试
 * 跑在与生产**完全相同**的路径结构下（前端 origin 下就有 /api/）。
 *
 * 规则（与生产 nginx 配置一一对应）：
 *   /api/...   → 原样反代给 Node 后端（对应 location ^~ /api/ { proxy_pass ...; }）
 *   其它       → 从静态目录取文件（对应 root ...; try_files ...）
 *
 * 仅用于本地测试，不参与生产部署。
 *
 * 用法：node tools/dev-gateway.js <静态目录> <监听端口> <后端端口>
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC = path.resolve(process.argv[2] || '.');
const PORT = parseInt(process.argv[3] || '8080', 10);
const API_PORT = parseInt(process.argv[4] || '8787', 10);
const API_HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function sendText(res, code, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function serveFile(full, res) {
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { return sendText(res, 404, 'Not Found'); }
  const ext = path.extname(full).toLowerCase();
  const base = path.basename(full);
  const head = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length
  };
  // Service Worker 必须每次校验，否则前端更新拿不到新版
  if (base === 'sw.js' || base === 'index.html') head['Cache-Control'] = 'no-cache';
  else head['Cache-Control'] = 'public, max-age=300';
  res.writeHead(200, head);
  res.end(buf);
}

const server = http.createServer(function (req, res) {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname);
  } catch (e) {
    pathname = '/';
  }

  // ---- /api 反代（含 /api/setup.php 自检页）----
  if (pathname === '/api' || pathname.indexOf('/api/') === 0) {
    const headers = Object.assign({}, req.headers);
    headers.host = '127.0.0.1:' + API_PORT;
    const pr = http.request({
      host: API_HOST, port: API_PORT, method: req.method, path: req.url, headers: headers
    }, function (pres) {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    });
    pr.on('error', function () {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end('{"ok":false,"error":"API 服务不可达"}');
    });
    req.pipe(pr);
    return;
  }

  // ---- 静态文件 ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  let full = path.resolve(STATIC, '.' + rel);
  const root = STATIC.endsWith(path.sep) ? STATIC : STATIC + path.sep;
  if (full !== STATIC && full.indexOf(root) !== 0) return sendText(res, 403, 'Forbidden');

  let st = null;
  try { st = fs.statSync(full); } catch (e) { st = null; }
  if (st && st.isDirectory()) {
    const idx = path.join(full, 'index.html');
    try { st = fs.statSync(idx); full = idx; } catch (e) { st = null; }
  }
  if (!st) return sendText(res, 404, 'Not Found');
  serveFile(full, res);
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('[dev-gateway] 静态目录 ' + STATIC);
  console.log('[dev-gateway] 监听 http://127.0.0.1:' + PORT + '  →  /api 反代到 127.0.0.1:' + API_PORT);
});

process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
