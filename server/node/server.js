/**
 * 往来账 · 云端备份后端（Node 版）—— 单入口 HTTP 服务
 *
 * 所有请求：  https://你的域名/api/index.php?a=动作
 * （nginx 把 /api/ 反代到本服务即可；本服务不关心路径，只看 ?a=）
 *
 * 动作一览（★ 需要登录）：
 *   ping        探活 / 看云端状态（无需登录）
 *   setup       首次初始化：设置云端密码（仅当服务器还没设过密码时可用）
 *   login       登录，拿令牌
 *   pull    ★   拉取云端账本
 *   push    ★   上传账本（带 baseRev 做冲突检测）
 *   history ★   版本历史列表
 *   daily   ★   每日备份列表
 *   restore ★   把某个历史版本恢复成当前版本
 *   download★   下载某个版本（或当前）为可导入的备份文件
 *   changepw★   修改云端密码（旧令牌全部失效）
 *   revoke  ★   让所有已登录设备下线
 *
 * 另：直接访问 /api/setup.php（不带 ?a=）返回自检页。
 *
 * 启动：  node server.js
 * 环境变量：
 *   PORT              监听端口（默认 8787）
 *   HOST              监听地址（默认 127.0.0.1，只给本机 nginx 反代用）
 *   LEDGER_DATA_DIR   数据目录（默认本文件同级 data/）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib.js');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

const HANDLED = Symbol('handled');

/* ---------------- 响应 ---------------- */

function sendJson(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(html, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/** 统一补上 ok / api / serverTime（对应 PHP 的 ok()） */
function okBody(extra) {
  return Object.assign({ ok: true, api: lib.API_VERSION, serverTime: lib.nowIso() }, extra || {});
}

/* ---------------- 请求体 ---------------- */

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let len = 0;
    let over = false;
    req.on('data', function (c) {
      len += c.length;
      if (len > lib.MAX_BODY) { over = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(over ? '' : Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function () { resolve(''); });
  });
}

function parseBody(raw) {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) { return {}; }
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}

/* ---------------- 动作分发 ---------------- */

function route(action, ctx) {
  const req = ctx.req;
  const res = ctx.res;
  const url = ctx.url;
  const body = ctx.body || {};

  switch (action) {

    /* ---------------- 探活 ---------------- */
    case 'ping': {
      lib.ensureDirs();
      const cur = lib.ledgerRead();
      const writable = isWritable(lib.dataDir());
      return {
        body: {
          ready: writable,
          writable: writable,
          needsSetup: !lib.passwordExists(),
          hasLedger: !!cur,
          rev: cur ? (parseInt(cur.rev, 10) || 0) : 0,
          savedAt: cur ? cur.savedAt : null,
          device: cur ? cur.device : '',
          counts: cur ? lib.countsOf(cur.data) : { customers: 0, txs: 0, incomes: 0 },
          runtime: 'node',
          node: process.versions.node,
          loggedIn: lib.tokenCheck(lib.bearer(req, url))
        }
      };
    }

    /* ---------------- 首次初始化 ---------------- */
    case 'setup': {
      if (lib.passwordExists()) lib.fail('云端已经设置过密码了，请直接登录', 409, { needLogin: true });
      const pw = body.password !== undefined ? String(body.password) : '';
      const hint = body.hint !== undefined ? String(body.hint) : '';
      if (lib.byteLen(pw) < 4) lib.fail('密码至少 4 位');
      if (lib.byteLen(pw) > 64) lib.fail('密码太长（最多 64 位）');
      lib.withLock(function () {
        if (lib.passwordExists()) lib.fail('云端已经设置过密码了，请直接登录', 409, { needLogin: true });
        lib.passwordSet(pw, hint);
      });
      const t = lib.tokenMake();
      return { body: { token: t.token, expiresAt: t.expiresAt, created: true } };
    }

    /* ---------------- 登录 ---------------- */
    case 'login': {
      if (!lib.passwordExists()) lib.fail('云端还没初始化，请先设置密码', 409, { needsSetup: true });
      lib.throttleCheck(req);
      const pw = body.password !== undefined ? String(body.password) : '';
      if (!lib.passwordCheck(pw)) {
        lib.throttleBump(req);
        const a = lib.jread(lib.authFile());
        const extra = {};
        // 连着错 3 次才给提示，避免被人一上来就试出提示
        if (lib.throttleCount(req) >= 3 && a && a.hint) extra.hint = a.hint;
        lib.fail('密码不正确', 401, extra);
      }
      lib.throttleClear(req);
      const t = lib.tokenMake();
      const cur = lib.ledgerRead();
      return {
        body: {
          token: t.token,
          expiresAt: t.expiresAt,
          rev: cur ? (parseInt(cur.rev, 10) || 0) : 0,
          savedAt: cur ? cur.savedAt : null,
          counts: cur ? lib.countsOf(cur.data) : { customers: 0, txs: 0, incomes: 0 }
        }
      };
    }

    /* ---------------- 拉取 ---------------- */
    case 'pull': {
      lib.requireAuth(req, url);
      const cur = lib.ledgerRead();
      if (!cur) return { body: { empty: true, rev: 0, data: null } };
      return {
        body: {
          empty: false,
          rev: parseInt(cur.rev, 10) || 0,
          savedAt: cur.savedAt,
          device: cur.device,
          counts: lib.countsOf(cur.data),
          data: cur.data
        }
      };
    }

    /* ---------------- 上传 ---------------- */
    case 'push': {
      lib.requireAuth(req, url);
      if (body.data === undefined) lib.fail('缺少 data 字段');
      const data = lib.sanitizeData(body.data);
      const device = body.device !== undefined ? String(body.device) : '';
      let baseRev = body.baseRev !== undefined ? (parseInt(body.baseRev, 10) || 0) : -1;
      const force = !!body.force;
      if (force) baseRev = -1;

      const r = lib.ledgerCommit(data, device, baseRev);
      if (r.conflict) {
        // 冲突：409 + 云端当前版本信息，交给用户决定（绝不自动猜）
        return {
          code: 409,
          raw: true,
          body: {
            ok: false,
            error: '云端已有更新的版本',
            conflict: true,
            rev: r.rev,
            savedAt: r.savedAt,
            device: r.device,
            counts: r.counts
          }
        };
      }
      return {
        body: {
          rev: parseInt(r.rev, 10) || 0,
          savedAt: r.savedAt,
          bytes: r.bytes ? parseInt(r.bytes, 10) : 0,
          counts: lib.countsOf(data)
        }
      };
    }

    /* ---------------- 版本历史 ---------------- */
    case 'history': {
      lib.requireAuth(req, url);
      const c = lib.ledgerRead();
      return {
        body: {
          currentRev: c ? (parseInt(c.rev, 10) || 0) : 0,
          list: lib.historyList(),
          daily: lib.dailyList()
        }
      };
    }

    /* ---------------- 恢复某个版本 ---------------- */
    case 'restore': {
      lib.requireAuth(req, url);
      const rev = url.searchParams.get('rev');
      if (rev === null || rev === '') lib.fail('缺少 rev 参数');
      const e = lib.ledgerVersion(rev);
      if (!e) lib.fail('找不到这个版本（可能已被清理）', 404);
      const r = lib.ledgerCommit(lib.sanitizeData(e.data), '回滚自 v' + (parseInt(e.rev, 10) || 0), -1);
      return {
        body: {
          rev: parseInt(r.rev, 10) || 0,
          restoredFrom: parseInt(e.rev, 10) || 0,
          savedAt: r.savedAt,
          counts: lib.countsOf(e.data)
        }
      };
    }

    /* ---------------- 下载某版本（可导入的备份文件） ---------------- */
    case 'download': {
      lib.requireAuth(req, url);
      const rev = url.searchParams.get('rev') || 'current';
      const e = lib.ledgerVersion(rev);
      if (!e) lib.fail('找不到这个版本', 404);
      const doc = lib.exportDoc(e);
      const revNum = parseInt(e.rev, 10) || 0;
      const name = '往来账-云端备份-v' + revNum + '-' + localStamp(new Date()) + '.json';
      const json = JSON.stringify(doc, null, 4);
      const buf = Buffer.from(json, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + asciiName(name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
        'Cache-Control': 'no-store',
        'Content-Length': buf.length
      });
      res.end(buf);
      return HANDLED;
    }

    /* ---------------- 修改密码 ---------------- */
    case 'changepw': {
      lib.requireAuth(req, url);
      const oldPw = body.oldPassword !== undefined ? String(body.oldPassword) : '';
      const pw = body.password !== undefined ? String(body.password) : '';
      const hint = body.hint !== undefined ? String(body.hint) : '';
      if (!lib.passwordCheck(oldPw)) { lib.throttleBump(req); lib.fail('原密码不正确', 401); }
      if (lib.byteLen(pw) < 4) lib.fail('新密码至少 4 位');
      lib.withLock(function () { lib.passwordSet(pw, hint); });
      // 换密码 = 换签名密钥，所有旧令牌自然失效
      lib.withLock(function () {
        const c = lib.conf();
        c.secret = crypto.randomBytes(32).toString('hex');
        lib.jwrite(lib.confFile(), c);
      });
      const t = lib.tokenMake();
      return { body: { token: t.token, expiresAt: t.expiresAt, changed: true } };
    }

    /* ---------------- 全部设备下线 ---------------- */
    case 'revoke': {
      lib.requireAuth(req, url);
      lib.withLock(function () {
        const c = lib.conf();
        c.secret = crypto.randomBytes(32).toString('hex');
        lib.jwrite(lib.confFile(), c);
      });
      return { body: { revoked: true } };
    }

    default:
      lib.fail('未知动作：' + action, 404);
  }
}

/** 下载文件名：给老浏览器兜一个纯 ASCII 名 */
function asciiName(name) {
  const ext = name.slice(name.lastIndexOf('.'));
  return 'ledger-cloud-backup' + ext;
}

function localStamp(d) {
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ---------------- 接口入口 ---------------- */

async function handleApi(action, ctx) {
  const res = ctx.res;
  try {
    if (ctx.needBody) {
      ctx.body = parseBody(await readBody(ctx.req));
    }
    const out = route(action, ctx);
    if (out === HANDLED) return;
    // 成功响应统一补上 ok / api / serverTime；raw=true 的（如 push 冲突）本身就是完整响应
    sendJson(res, out.code || 200, out.raw ? out.body : okBody(out.body));
  } catch (e) {
    if (e instanceof lib.ApiError) {
      sendJson(res, e.code, Object.assign({ ok: false, error: e.message }, e.extra));
    } else {
      console.error('[ledger-api] 内部错误:', e && e.stack ? e.stack : e);
      sendJson(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message ? e.message : String(e)) });
    }
  }
}

/* ---------------- 自检页 ---------------- */

function h(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function row(label, state, detail) {
  const cls = state === true ? 'ok' : (state === false ? 'bad' : 'warn');
  const mark = state === true ? '✓' : (state === false ? '✗' : '!');
  return '<div class="row ' + cls + '"><span class="mk">' + mark + '</span>' +
    '<span class="lb">' + h(label) + '</span><span class="dt">' + detail + '</span></div>';
}

/** 实测：data 目录里的文件能不能被外网直接下载 */
function probeExposure(req) {
  return new Promise(function (resolve) {
    const host = req.headers.host;
    if (!host) return resolve({ state: null, msg: '无法判断访问地址，跳过自检' });

    const name = 'probe-' + crypto.randomBytes(6).toString('hex') + '.txt';
    const token = 'LEDGER_PROBE_' + crypto.randomBytes(8).toString('hex');
    const p = path.join(lib.dataDir(), name);
    try {
      fs.writeFileSync(p, token);
    } catch (e) {
      return resolve({ state: null, msg: '无法写入探测文件（目录不可写）' });
    }

    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      ((req.socket && req.socket.encrypted) ? 'https' : 'http');
    const target = proto + '://' + host + '/api/data/' + name;

    httpGet(target).then(function (body) {
      try { fs.unlinkSync(p); } catch (e) { /* 忽略 */ }
      if (body === null) {
        resolve({ state: false, msg: '请求探测文件失败（已被安全策略拦截，通常说明是安全的）' });
      } else if (body.indexOf(token) >= 0) {
        resolve({ state: true, msg: '探测文件可以被外网直接下载！' });
      } else {
        resolve({ state: false, msg: '未返回文件内容，视为已保护' });
      }
    });
  });
}

function httpGet(url) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      timeout: 6000,
      headers: { 'User-Agent': 'ledger-selfcheck' }
    };
    if (isHttps) opts.rejectUnauthorized = false;   // 自签证书也要能探
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    const r = mod.request(opts, function (resp) {
      const chunks = [];
      resp.on('data', function (c) { chunks.push(c); });
      resp.on('end', function () { finish(Buffer.concat(chunks).toString('utf8')); });
      resp.on('error', function () { finish(null); });
    });
    r.on('timeout', function () { r.destroy(); finish(null); });
    r.on('error', function () { finish(null); });
    r.end();
  });
}

async function setupPage(req, res) {
  lib.ensureDirs();

  const nodeOk = true;
  const dirOk = isWritable(lib.dataDir());
  const hasPw = lib.passwordExists();
  const cur = lib.ledgerRead();
  const counts = cur ? lib.countsOf(cur.data) : { customers: 0, txs: 0, incomes: 0 };
  const snaps = lib.snapshotCounts();
  const probe = await probeExposure(req);

  let exposureRow, exposureBox;
  if (probe.state === true) {
    exposureRow = row('能否被外网直接下载', false, h(probe.msg));
    exposureBox =
      '<div class="alert"><b>必须处理：</b>别人可以直接下载你的账本文件。<br>' +
      '说明 nginx 只反代了 <code>/api/index.php</code>，没有把整个 <code>/api/</code> 交给本服务。' +
      '请把反代规则改成下面这样，保存后刷新本页复查：' +
      '<pre>location ^~ /api/ {<br>    proxy_pass http://127.0.0.1:' + PORT + ';<br>' +
      '    proxy_set_header Host $host;<br>    proxy_set_header X-Real-IP $remote_addr;<br>' +
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;<br>' +
      '    proxy_set_header X-Forwarded-Proto $scheme;<br>}</pre></div>';
  } else if (probe.state === false) {
    exposureRow = row('能否被外网直接下载', true, h(probe.msg));
    exposureBox = '<div class="alert good"><b>✔ 安全。</b>账本文件无法被浏览器直接下载，只能通过接口读写。</div>';
  } else {
    exposureRow = row('能否被外网直接下载', 'warn', h(probe.msg));
    exposureBox = '<div class="alert amber">未能自动判断。建议确认 nginx 里 <code>/api/</code> 整段都反代给了本服务：' +
      '<pre>location ^~ /api/ { proxy_pass http://127.0.0.1:' + PORT + '; }</pre></div>';
  }

  const histRow = row('历史快照', true,
    '滚动版本 ' + snaps.history + ' 个 · 每日备份 ' + snaps.daily + ' 个');

  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>云端后端自检 · 往来账</title>\n<style>\n' +
    ':root{--ink:#1c2b25;--ink2:#5a6b64;--line:#e2e6e3;--bg:#f6f8f6;--card:#fff;--brand:#0F4C3A;--red:#c0392b;--amber:#b7791f;}\n' +
    '*{box-sizing:border-box}\n' +
    'body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}\n' +
    '.wrap{max-width:720px;margin:0 auto}\n' +
    'h1{font-size:20px;margin:0 0 4px}\n' +
    '.sub{color:var(--ink2);font-size:13px;margin-bottom:18px}\n' +
    '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 16px;margin-bottom:14px}\n' +
    '.card h2{font-size:14px;margin:14px 0 6px;color:var(--ink2);font-weight:600}\n' +
    '.row{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px dashed var(--line)}\n' +
    '.row:last-child{border-bottom:0}\n' +
    '.mk{width:18px;text-align:center;font-weight:700;flex:none}\n' +
    '.row.ok .mk{color:#1e8e5a}.row.bad .mk{color:var(--red)}.row.warn .mk{color:var(--amber)}\n' +
    '.lb{flex:none;width:150px;color:var(--ink)}\n' +
    '.dt{color:var(--ink2);font-size:13px;flex:1;word-break:break-all}\n' +
    'pre{background:#f2f5f2;border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto;font-size:13px;margin:8px 0}\n' +
    '.alert{border-left:4px solid var(--red);background:#fdf2f0;padding:12px 14px;border-radius:8px;margin:12px 0;font-size:14px}\n' +
    '.alert.good{border-color:#1e8e5a;background:#f0f8f4}\n' +
    '.alert.amber{border-color:var(--amber);background:#fdf8ee}\n' +
    'a.btn{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;margin-top:6px}\n' +
    'code{background:#eef2ef;padding:1px 5px;border-radius:4px;font-size:13px}\n' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '  <h1>云端后端自检</h1>\n' +
    '  <div class="sub">往来账 · 麻将馆记账 &nbsp;|&nbsp; 后端版本 ' + h(lib.API_VERSION) + ' · Node 版</div>\n' +
    '  <div class="card">\n    <h2>环境</h2>\n' +
    row('Node 版本', nodeOk, h(process.version) + '（可用）') +
    row('运行时', true, 'Node.js（无需 PHP）') +
    row('数据目录可写', dirOk, dirOk ? '可写' : '不可写！请把 data 目录权限设为 755、属主 www') +
    '  </div>\n' +
    '  <div class="card">\n    <h2>数据目录保护（重要）</h2>\n' +
    exposureRow + '\n' + exposureBox + '\n  </div>\n' +
    '  <div class="card">\n    <h2>账本状态</h2>\n' +
    row('是否已设云端密码', hasPw, hasPw ? '已设置' : '还没设置 —— 打开 App 会让你设') +
    row('云端版本号', cur ? true : 'warn', cur ? ('v' + (parseInt(cur.rev, 10) || 0) + ' · ' + h(cur.savedAt)) : '云端还没有数据') +
    row('云端内容', true, '客户 <b>' + counts.customers + '</b> 位 · 牌局 <b>' + counts.incomes + '</b> 场 · 流水 <b>' + counts.txs + '</b> 条') +
    histRow +
    '  </div>\n' +
    '  <div class="card">\n    <h2>下一步</h2>\n' +
    '    <div class="dt" style="padding:6px 0 12px">' +
    '回到 App 首页，第一次会让你设置「进入密码」——这个密码同时就是云端密码，设完账本会自动同步上来。' +
    '<br>另一台手机用<b>同一个密码</b>登录即可看到同一本账。</div>\n' +
    '    <a class="btn" href="../">打开往来账</a>\n  </div>\n' +
    '  <div class="sub" style="margin-top:16px">本页只是自检工具，可以随时停用（把 <code>?a=</code> 之外的访问关掉即可），不影响使用。</div>\n' +
    '</div>\n</body>\n</html>\n';

  sendHtml(res, 200, html);
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求地址不合法' });
  }

  // 接口：只要带 ?a= 就走动作分发（不关心路径，方便 nginx 任意反代写法）
  const action = url.searchParams.get('a');
  if (action) {
    const needBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    return handleApi(action, { req: req, res: res, url: url, needBody: needBody });
  }

  // 自检页：/api/setup.php 或 /api/setup
  if (/setup\.php$/i.test(url.pathname) || /\/setup\/?$/i.test(url.pathname)) {
    return setupPage(req, res).catch(function (e) {
      sendHtml(res, 500, '<h1>自检页出错</h1><pre>' + h(e && e.stack ? e.stack : e) + '</pre>');
    });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Allow': 'GET, POST, OPTIONS' });
    return res.end();
  }

  // 其它：给个说明，方便人肉排查
  sendJson(res, 200, {
    ok: true,
    api: lib.API_VERSION,
    service: '往来账云端后端（Node 版）',
    runtime: 'node',
    hint: '接口用法：?a=ping ；自检页：/api/setup.php'
  });
});

server.on('clientError', function (err, socket) {
  try { socket.destroy(); } catch (e) { /* 忽略 */ }
});

lib.ensureDirs();

server.listen(PORT, HOST, function () {
  console.log('[ledger-api] 往来账云端后端 v' + lib.API_VERSION + '（Node ' + process.version + '）');
  console.log('[ledger-api] 监听 http://' + HOST + ':' + PORT);
  console.log('[ledger-api] 数据目录 ' + lib.dataDir());
  if (!isWritable(lib.dataDir())) {
    console.error('[ledger-api] 警告：数据目录不可写，记账会失败！请检查权限。');
  }
});

function shutdown(sig) {
  console.log('[ledger-api] 收到 ' + sig + '，正在停止 ...');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000);
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
