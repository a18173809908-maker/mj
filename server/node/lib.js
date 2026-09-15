/**
 * 往来账 · 云端备份后端（Node 版）—— 公共库
 *
 * 与 PHP 版（server/api/lib.php）**接口行为逐个字段对齐**，前端一行都不用改。
 *
 * 设计要点：
 *  - 零依赖：只用 Node 内置模块（http / fs / path / crypto），无需 npm install
 *  - 零数据库：账本以 JSON 文件存放在 data/，原子写（临时文件 + rename）
 *  - 并发安全：单线程 + 同步 IO 天然串行；另有跨进程锁文件兜底（万一被开了多实例）
 *  - 密码：PBKDF2-SHA256，2 万轮，随机盐，只存哈希
 *  - 令牌：无状态 HMAC-SHA256 签名（不落盘、不依赖 session），默认 90 天有效
 *  - 版本历史：每次上传留一份快照，可回滚；另有每日首个版本长期保留
 *
 * 要求 Node >= 16（用到 fs.rmSync / URL / crypto.timingSafeEqual）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_VERSION = '1.0.0';
const MAX_HISTORY = 60;      // 滚动保留最近 N 个版本
const MAX_DAILY = 90;        // 每日首个版本保留 N 天
const PW_ITER = 20000;
const TOKEN_DAYS = 90;
const MAX_FAIL = 8;          // 连续错 N 次
const FAIL_WAIT = 600;       // 锁 N 秒
const LOCK_WAIT_MS = 6000;   // 等锁上限
const LOCK_STALE_MS = 15000; // 锁文件超过这个时长视为残留，强行接管
const MAX_BODY = 8 * 1024 * 1024; // 单次请求体上限 8MB

/* ---------------- 业务错误 ---------------- */

/** 对应 PHP 的 fail() + exit */
class ApiError extends Error {
  constructor(msg, code, extra) {
    super(msg);
    this.name = 'ApiError';
    this.code = code || 400;
    this.extra = extra || {};
  }
}

function fail(msg, code, extra) { throw new ApiError(msg, code, extra); }

/* ---------------- 路径 ---------------- */

// 数据目录：可用环境变量 LEDGER_DATA_DIR 指到别处（默认在服务程序同级 data/）
const DATA_DIR = process.env.LEDGER_DATA_DIR
  ? path.resolve(process.env.LEDGER_DATA_DIR)
  : path.join(__dirname, 'data');

function dataDir() { return DATA_DIR; }
function ledgerFile() { return path.join(DATA_DIR, 'ledger.json'); }
function authFile() { return path.join(DATA_DIR, 'auth.json'); }
function confFile() { return path.join(DATA_DIR, 'conf.json'); }
function failFile() { return path.join(DATA_DIR, 'fail.json'); }
function lockFile() { return path.join(DATA_DIR, '.lock'); }
function histDir() { return path.join(DATA_DIR, 'history'); }
function dailyDir() { return path.join(DATA_DIR, 'daily'); }

function ensureDirs() {
  for (const d of [DATA_DIR, histDir(), dailyDir()]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 */ }
  }
  // 双保险：万一有人把 data 放到了网站根目录下，这两个文件能让 Apache/静态服务器拒绝列目录与直接读取
  const ht = path.join(DATA_DIR, '.htaccess');
  if (!fs.existsSync(ht)) {
    try {
      fs.writeFileSync(ht,
        'Require all denied\nDeny from all\n' +
        '<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule .* - [F,L]\n</IfModule>\n');
    } catch (e) { /* 忽略 */ }
  }
  const idx = path.join(DATA_DIR, 'index.html');
  if (!fs.existsSync(idx)) {
    try { fs.writeFileSync(idx, ''); } catch (e) { /* 忽略 */ }
  }
}

/* ---------------- 时间 ---------------- */

/** ISO8601（UTC，秒精度）—— 前端用 Date.parse 解析后按本机时区显示，不会错位 */
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/** 服务器本地日期 YYYY-MM-DD（每日快照文件名用，跟 PHP date('Y-m-d') 一致） */
function localDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function nowSec() { return Math.floor(Date.now() / 1000); }

/* ---------------- 加锁（原子写的重要前提） ---------------- */

let lockDepth = 0;   // 同进程重入计数：已经拿着锁了就直接执行，避免自己把自己锁死

/**
 * 在排他锁内执行 fn。同步执行，fn 抛错也会正确释放锁。
 * 单进程内可重入；跨进程用 data/.lock 文件互斥。
 */
function withLock(fn) {
  ensureDirs();
  if (lockDepth > 0) {
    lockDepth++;
    try { return fn(); } finally { lockDepth--; }
  }

  const lf = lockFile();
  const t0 = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lf, 'wx');   // 独占创建：拿不到就说明别人持有
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        fail('服务器数据目录不可写，请检查 data 目录权限', 500);
      }
      // 残留锁（进程被杀等）超过一定时长，强行接管
      try {
        const st = fs.statSync(lf);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lf);
          continue;
        }
      } catch (e2) { /* 锁刚好被别人放了，下一轮即可拿到 */ }
      if (Date.now() - t0 > LOCK_WAIT_MS) {
        fail('获取文件锁失败，请稍后重试', 500);
      }
      sleep(12);
    }
  }

  try {
    fs.writeSync(fd, String(process.pid) + ' ' + nowSec() + '\n');
  } catch (e) { /* 写不进去不影响加锁语义 */ }

  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    try { fs.closeSync(fd); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(lf); } catch (e) { /* 忽略 */ }
  }
}

/** 同步等待（不占事件循环，因为整个请求处理链是同步的） */
function sleep(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/* ---------------- JSON 读写 ---------------- */

function jread(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return (d && typeof d === 'object') ? d : null;
  } catch (e) { return null; }
}

/** 原子写：先写临时文件，再 rename 覆盖（同目录 rename 是原子操作） */
function jwrite(p, data) {
  const tmp = p + '.tmp.' + process.pid;
  let raw;
  try {
    raw = JSON.stringify(data);
  } catch (e) {
    fail('数据序列化失败', 500);
  }
  if (raw === undefined) { fail('数据序列化失败', 500); }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o644 });
  } catch (e) {
    fail('写入失败，请检查 data 目录权限', 500);
  }
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    fail('落盘失败，请检查 data 目录权限', 500);
  }
  return Buffer.byteLength(raw, 'utf8');
}

/* ---------------- 站点配置（签名密钥） ---------------- */

function conf() {
  let c = jread(confFile());
  if (c && c.secret) return c;
  return withLock(function () {
    c = jread(confFile());
    if (c && c.secret) return c;
    c = { secret: crypto.randomBytes(32).toString('hex'), createdAt: nowIso(), site: '往来账' };
    jwrite(confFile(), c);
    return c;
  });
}

/* ---------------- 令牌 ---------------- */

function b64u(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ud(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64').toString('utf8');
}

function tokenMake(days) {
  if (days === undefined || days === null) days = TOKEN_DAYS;
  const c = conf();
  const now = nowSec();
  const payload = { v: 1, iat: now, exp: now + days * 86400, jti: crypto.randomBytes(8).toString('hex') };
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', c.secret).update(p, 'utf8').digest());
  return { token: p + '.' + sig, expiresAt: payload.exp };
}

function tokenCheck(tok) {
  if (!tok || String(tok).indexOf('.') < 0) return false;
  const i = String(tok).indexOf('.');
  const p = String(tok).slice(0, i);
  const sig = String(tok).slice(i + 1);
  const c = conf();
  const want = b64u(crypto.createHmac('sha256', c.secret).update(p, 'utf8').digest());
  if (!safeEqual(want, sig)) return false;
  let d;
  try { d = JSON.parse(b64ud(p)); } catch (e) { return false; }
  if (!d || typeof d !== 'object' || !d.exp || Number(d.exp) < nowSec()) return false;
  return true;
}

/** 定长比较，长度不同直接 false（timingSafeEqual 长度不等会抛错） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 取请求里的令牌。
 * 优先 Authorization: Bearer xxx；部分环境（CDN / 某些反代）会吃掉这个头，
 * 所以兜底允许 ?t=xxx —— 与 PHP 版一致。
 */
function bearer(req, url) {
  let h = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (Array.isArray(h)) h = h[0] || '';
  if (typeof h === 'string' && h.toLowerCase().indexOf('bearer ') === 0) {
    return h.slice(7).trim();
  }
  if (url) {
    const t = url.searchParams.get('t');
    if (t) return t;
  }
  return null;
}

function requireAuth(req, url) {
  if (!tokenCheck(bearer(req, url))) {
    fail('未登录或登录状态已过期', 401, { needLogin: true });
  }
}

/* ---------------- 密码 ---------------- */

function passwordSet(pw, hint) {
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = {
    v: 1,
    alg: 'pbkdf2-sha256',
    iter: PW_ITER,
    salt: salt,
    hash: crypto.pbkdf2Sync(pw, salt, PW_ITER, 32, 'sha256').toString('hex'),
    hint: utf8Cut(hint, 60),
    createdAt: nowIso(),
    changedAt: nowIso()
  };
  jwrite(authFile(), rec);
  return rec;
}

function passwordCheck(pw) {
  const a = jread(authFile());
  if (!a || !a.hash || !a.salt) return false;
  const iter = a.iter ? (parseInt(a.iter, 10) || PW_ITER) : PW_ITER;
  const calc = crypto.pbkdf2Sync(pw, a.salt, iter, 32, 'sha256').toString('hex');
  return safeEqual(a.hash, calc);
}

function passwordExists() {
  const a = jread(authFile());
  return !!(a && a.hash);
}

/** 按 Unicode 码点安全截断（不用 Buffer 切，避免切出半个汉字） */
function utf8Cut(s, maxChars) {
  s = s === undefined || s === null ? '' : String(s);
  if (!s) return '';
  const arr = Array.from(s);
  return arr.length <= maxChars ? s : arr.slice(0, maxChars).join('');
}

/** 字节长度（与 PHP 的 strlen 语义一致，中文一字算 3 字节） */
function byteLen(s) { return Buffer.byteLength(String(s === undefined || s === null ? '' : s), 'utf8'); }

/* ---------------- 防爆破 ---------------- */

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const xri = req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.trim()) return xri.trim();
  const sock = (req.socket && req.socket.remoteAddress) || '';
  return sock || '0.0.0.0';
}

function throttleCheck(req) {
  const f = jread(failFile());
  if (!f) return;
  const k = clientIp(req);
  const rec = f[k];
  if (rec && rec.until && Number(rec.until) > nowSec()) {
    const left = Number(rec.until) - nowSec();
    const min = Math.ceil(left / 60);
    fail('密码错误次数过多，请 ' + min + ' 分钟后再试', 429, { retryAfter: left });
  }
}

function throttleBump(req) {
  return withLock(function () {
    let f = jread(failFile());
    if (!f || typeof f !== 'object') f = {};
    const k = clientIp(req);
    const n = (f[k] && f[k].n ? parseInt(f[k].n, 10) : 0) + 1;
    let until = 0;
    if (n >= MAX_FAIL) until = nowSec() + FAIL_WAIT;
    f[k] = { n: n, until: until, at: nowIso() };
    const now = nowSec();
    for (const kk of Object.keys(f)) {
      if (kk === k) continue;
      const vv = f[kk] || {};
      if (!vv.until && vv.at) {
        const ts = Date.parse(vv.at);
        if (isFinite(ts) && ts / 1000 < now - 86400) delete f[kk];
      }
    }
    jwrite(failFile(), f);
    return n;
  });
}

/** 错了多少次（还没到锁定的计数） */
function throttleCount(req) {
  const f = jread(failFile());
  if (!f) return 0;
  const rec = f[clientIp(req)];
  return rec && rec.n ? parseInt(rec.n, 10) : 0;
}

function throttleClear(req) {
  withLock(function () {
    const f = jread(failFile());
    if (!f) return;
    delete f[clientIp(req)];
    jwrite(failFile(), f);
  });
}

/* ---------------- 账本 ---------------- */

function countsOf(data) {
  return {
    customers: data && Array.isArray(data.customers) ? data.customers.length : 0,
    txs: data && Array.isArray(data.txs) ? data.txs.length : 0,
    incomes: data && Array.isArray(data.incomes) ? data.incomes.length : 0
  };
}

function entryPublic(e) {
  const d = (e && e.data) || {};
  return {
    rev: parseInt(e.rev, 10) || 0,
    savedAt: e.savedAt || '',
    ts: e.ts ? parseInt(e.ts, 10) : 0,
    device: e.device || '',
    counts: countsOf(d),
    bytes: e.bytes ? parseInt(e.bytes, 10) : 0
  };
}

function snapshotWrite(entry) {
  ensureDirs();
  const p = path.join(histDir(), 'r' + String(parseInt(entry.rev, 10) || 0).padStart(6, '0') + '.json');
  jwrite(p, entry);
}

function dailyWrite(entry) {
  ensureDirs();
  const p = path.join(dailyDir(), localDate() + '.json');
  if (!fs.existsSync(p)) jwrite(p, entry);
}

function lsJson(dir, prefix) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.json')) continue;
    if (prefix && !n.startsWith(prefix)) continue;
    out.push(path.join(dir, n));
  }
  return out;
}

function snapshotPrune() {
  let files = lsJson(histDir(), 'r');
  if (files.length > MAX_HISTORY) {
    files.sort();                                    // 文件名含递增 rev，字典序即版本序
    for (const f of files.slice(0, files.length - MAX_HISTORY)) {
      try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
    }
  }
  let dfiles = lsJson(dailyDir());
  if (dfiles.length > MAX_DAILY) {
    dfiles.sort();
    for (const f of dfiles.slice(0, dfiles.length - MAX_DAILY)) {
      try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
    }
  }
}

function ledgerRead() {
  const e = jread(ledgerFile());
  if (!e || e.data === undefined) return null;
  return e;
}

/**
 * 提交新版本。
 * baseRev = -1 表示不做冲突校验（强制覆盖）。
 * 返回 {conflict:true,...} 或新的 entry。
 */
function ledgerCommit(data, device, baseRev) {
  return withLock(function () {
    const cur = ledgerRead();
    const rev = cur ? (parseInt(cur.rev, 10) || 0) : 0;
    if (baseRev >= 0 && baseRev !== rev) {
      return {
        conflict: true,
        rev: rev,
        savedAt: cur ? cur.savedAt : null,
        device: cur ? cur.device : '',
        counts: cur ? countsOf(cur.data) : { customers: 0, txs: 0, incomes: 0 }
      };
    }
    const entry = {
      rev: rev + 1,
      savedAt: nowIso(),
      ts: nowSec(),
      device: utf8Cut(device, 40),
      counts: countsOf(data),
      data: data
    };
    // 注意：先落盘再补 bytes —— bytes 只出现在历史快照里，与 PHP 版保持一致
    const bytes = jwrite(ledgerFile(), entry);
    entry.bytes = bytes;
    snapshotWrite(entry);
    dailyWrite(entry);
    snapshotPrune();
    return entry;
  });
}

/** 取某个历史版本的 entry（rev 为空 / current 则取当前；也支持传日期取当日备份） */
function ledgerVersion(rev) {
  if (rev === null || rev === undefined || rev === '' || rev === 'current') return ledgerRead();
  const r = parseInt(rev, 10) || 0;
  let e = jread(path.join(histDir(), 'r' + String(r).padStart(6, '0') + '.json'));
  if (e && e.data !== undefined) return e;
  e = jread(path.join(dailyDir(), String(rev) + '.json'));
  if (e && e.data !== undefined) return e;
  return null;
}

function historyList() {
  const out = [];
  const cur = ledgerRead();
  if (cur) out.push(entryPublic(cur));
  const files = lsJson(histDir(), 'r');
  files.sort();
  files.reverse();
  for (const f of files) {
    const e = jread(f);
    if (!e || e.data === undefined) continue;
    const pub = entryPublic(e);
    if (cur && pub.rev === (parseInt(cur.rev, 10) || 0)) continue;
    out.push(pub);
  }
  return out;
}

function dailyList() {
  const out = [];
  const files = lsJson(dailyDir());
  files.sort();
  files.reverse();
  for (const f of files) {
    const e = jread(f);
    if (!e || e.data === undefined) continue;
    const pub = entryPublic(e);
    pub.date = path.basename(f, '.json');
    out.push(pub);
  }
  return out;
}

/** 转成 App「导入备份」能直接吃的扁平格式 */
function exportDoc(entry) {
  const d = entry.data || {};
  return {
    app: '麻将馆往来账',
    version: d.version !== undefined ? d.version : 2,
    exportedAt: nowIso(),
    cloudRev: parseInt(entry.rev, 10) || 0,
    cloudSavedAt: entry.savedAt || '',
    customers: d.customers !== undefined ? d.customers : [],
    txs: d.txs !== undefined ? d.txs : [],
    incomes: d.incomes !== undefined ? d.incomes : [],
    settings: d.settings !== undefined ? d.settings : {}
  };
}

/**
 * 校验并规整客户端上传的账本数据。
 * 只接受 4 个已知字段，避免脏数据撑爆存储。
 */
function sanitizeData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail('数据格式不正确');
  const v = d.version !== undefined ? (parseInt(d.version, 10) || 0) : 2;
  const out = { version: v, customers: [], txs: [], incomes: [], settings: {} };
  for (const k of ['customers', 'txs', 'incomes']) {
    if (d[k] === undefined) continue;
    if (!Array.isArray(d[k])) fail('字段 ' + k + ' 格式不正确');
    out[k] = d[k].slice();
  }
  if (d.settings !== undefined && d.settings !== null && typeof d.settings === 'object' && !Array.isArray(d.settings)) {
    out.settings = d.settings;
  }
  return out;
}

/** 一个历史版本里有多少个快照（自检页用） */
function snapshotCounts() {
  const h = lsJson(histDir(), 'r').length;
  const d = lsJson(dailyDir()).length;
  return { history: h, daily: d };
}

module.exports = {
  API_VERSION, MAX_HISTORY, MAX_DAILY, PW_ITER, TOKEN_DAYS, MAX_FAIL, FAIL_WAIT, MAX_BODY,
  ApiError, fail,
  dataDir, ledgerFile, authFile, confFile, failFile, histDir, dailyDir,
  ensureDirs, withLock,
  nowIso, localDate, nowSec,
  jread, jwrite,
  conf, b64u, b64ud, tokenMake, tokenCheck, bearer, requireAuth,
  passwordSet, passwordCheck, passwordExists, utf8Cut, byteLen,
  clientIp, throttleCheck, throttleBump, throttleCount, throttleClear,
  countsOf, entryPublic, ledgerRead, ledgerCommit, ledgerVersion,
  historyList, dailyList, exportDoc, sanitizeData, snapshotCounts
};
