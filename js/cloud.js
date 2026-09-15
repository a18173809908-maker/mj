/**
 * 往来账 · 云端同步客户端（v2.0）
 *
 * 设计原则：
 *  1) 完全可选、可降级 —— 后端不存在/断网时，一切静默失败，App 与纯本地模式毫无差别
 *  2) 本地永远优先 —— localStorage 是日常读写路径，云端只做备份与多设备同步
 *  3) 冲突不自动猜 —— 本机与云端都有改动时交给用户选，且服务器保留全部历史版本可回滚
 *
 * 依赖：window.Store（数据层）、可选 window.Lock（本地门禁）
 */
(function (global) {
  'use strict';

  var K_CFG  = 'ledger_mahjong_cloud';      // {base, rev, lastSyncAt, enabled, label, devId}
  var K_TOK  = 'ledger_mahjong_token';      // {token, expiresAt}
  var K_BAK  = 'ledger_mahjong_v1.precloud'; // 被云端覆盖前的本机快照（一次性）

  var TIMEOUT = 12000;
  var PING_TTL = 30000;
  var DEBOUNCE = 4000;

  function jget(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function jdel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function hostOf() {
    try { return location.origin || (location.protocol + '//' + location.host); } catch (e) { return ''; }
  }

  function guessLabel() {
    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (e) {}
    var dev = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? '手机' : '电脑';
    if (/iPad/i.test(ua)) dev = '平板';
    var br = '浏览器';
    if (/MicroMessenger/i.test(ua)) br = '微信';
    else if (/EdgA?\//i.test(ua)) br = 'Edge';
    else if (/Chrome\//i.test(ua)) br = 'Chrome';
    else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) br = 'Safari';
    else if (/Firefox\//i.test(ua)) br = 'Firefox';
    return dev + '·' + br;
  }

  var CFG = jget(K_CFG) || {};
  if (!CFG.base) CFG.base = 'api/index.php';
  if (typeof CFG.rev !== 'number') CFG.rev = 0;
  if (typeof CFG.lastSyncAt !== 'number') CFG.lastSyncAt = 0;
  if (typeof CFG.enabled !== 'boolean') CFG.enabled = true;
  if (!CFG.label) CFG.label = guessLabel();
  if (!CFG.devId) CFG.devId = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  var TOK = jget(K_TOK) || null;

  var state = {
    available: null,     // null 未知 / true 后端在 / false 后端不在
    lastPing: 0,
    busy: false,
    dirty: false,        // 本机有未上传的改动
    applying: false,     // 正在把云端数据写入本机（这段时间不标 dirty）
    lastError: '',
    info: null,          // 最近一次 ping 的信息
    timer: null,
    onchange: null
  };

  function saveCfg() { jset(K_CFG, CFG); }
  function saveTok() { if (TOK) jset(K_TOK, TOK); else jdel(K_TOK); }

  function notify() {
    if (typeof state.onchange === 'function') {
      try { state.onchange(Cloud.status()); } catch (e) {}
    }
  }

  function tokenValue() {
    if (!TOK || !TOK.token) return '';
    if (TOK.expiresAt && TOK.expiresAt * 1000 < Date.now()) return '';
    return TOK.token;
  }

  /* ---------------- 底层请求 ---------------- */

  function buildUrl(action, extra) {
    var url = CFG.base + (CFG.base.indexOf('?') >= 0 ? '&' : '?') + 'a=' + encodeURIComponent(action);
    if (extra) {
      for (var k in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
        var v = extra[k];
        if (v === undefined || v === null) continue;
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
      }
    }
    return url;
  }

  function rawFetch(url, opts, cb) {
    if (typeof global.fetch === 'function') {
      var ctl = null, timer = null;
      try { ctl = new AbortController(); } catch (e) { ctl = null; }
      var o = { method: opts.method || 'GET', headers: opts.headers || {}, cache: 'no-store' };
      if (opts.body) o.body = opts.body;
      if (ctl) o.signal = ctl.signal;
      if (ctl) timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, TIMEOUT);
      global.fetch(url, o).then(function (r) {
        return r.text().then(function (t) { return { status: r.status, text: t, headers: r.headers }; });
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        cb(null, res);
      })['catch'](function (err) {
        if (timer) clearTimeout(timer);
        cb(err || new Error('network'));
      });
      return;
    }
    // 老浏览器兜底：XMLHttpRequest
    try {
      var x = new XMLHttpRequest();
      x.open(opts.method || 'GET', url, true);
      x.timeout = TIMEOUT;
      if (opts.headers) for (var h in opts.headers) { if (Object.prototype.hasOwnProperty.call(opts.headers, h)) x.setRequestHeader(h, opts.headers[h]); }
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        cb(null, { status: x.status, text: x.responseText, headers: null });
      };
      x.ontimeout = function () { cb(new Error('timeout')); };
      x.onerror = function () { cb(new Error('network')); };
      x.send(opts.body || null);
    } catch (e) {
      cb(e);
    }
  }

  function parse(res) {
    if (!res || typeof res.text !== 'string') return null;
    var t = res.text.replace(/^\uFEFF/, '').trim();
    if (!t) return null;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return null;   // 多半是静态服务器返回的 404 HTML
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /**
   * 调用接口。cb(err, data, meta)
   * err: {offline:true} 后端不可达 | {needLogin:true} 未登录 | {error:'...'} 业务错误
   */
  function api(action, opts, cb) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var tok = opts.noAuth ? '' : tokenValue();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;

    var url = buildUrl(action, opts.query);
    var body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    rawFetch(url, { method: body !== undefined ? 'POST' : 'GET', headers: headers, body: body }, function (err, res) {
      var data = res ? parse(res) : null;

      // 后端根本不存在（静态托管 / 目录不存在）
      if (err) {
        if (action === 'ping') {
          // 失败的探测不做缓存：下次调用立刻重试，避免把"连不上"记成长期结论
          state.available = false; state.lastPing = 0; state.info = null;
        }
        return cb({ offline: true, reason: String(err && err.message || err) }, null);
      }
      if (!data) {
        if (action === 'ping') { state.available = false; state.lastPing = 0; state.info = null; }
        return cb({ notAvailable: true, status: res.status }, null);
      }

      // Authorization 头被环境吃掉的情况：用查询参数重试一次
      if (res.status === 401 && data.needLogin && tok && !opts.noAuth && !opts._retried) {
        var q = {};
        for (var k in (opts.query || {})) { if (Object.prototype.hasOwnProperty.call(opts.query, k)) q[k] = opts.query[k]; }
        q.t = tok;
        return api(action, { method: opts.method, body: opts.body, query: q, noAuth: true, _retried: true }, cb);
      }

      if (action === 'ping') {
        state.available = true; state.lastPing = Date.now(); state.info = data;
      }
      if (data.ok) return cb(null, data, res.status);
      if (res.status === 401) {
        TOK = null; saveTok();
        return cb({ needLogin: true, error: data.error || '登录已过期' }, data);
      }
      cb({ error: data.error || ('HTTP ' + res.status), data: data, status: res.status }, data);
    });
  }

  /* ---------------- 对外状态 ---------------- */

  var Cloud = {
    get cfg() { return CFG; },
    rawState: state,

    base: function () { return CFG.base; },
    setBase: function (b) { CFG.base = b || 'api/index.php'; saveCfg(); state.available = null; state.lastPing = 0; },

    enabled: function () { return !!CFG.enabled; },
    setEnabled: function (v) { CFG.enabled = !!v; saveCfg(); notify(); },

    loggedIn: function () { return !!tokenValue(); },
    tokenExpiresAt: function () { return TOK ? TOK.expiresAt : 0; },

    available: function () { return state.available; },
    error: function () { return state.lastError; },

    /** 云端状态变化时回调（「我的」页那块靠它实时刷新）。
     *  注意必须落到 state.onchange —— notify() 读的是 state，写 Cloud.onchange 是接不上的。 */
    get onchange() { return state.onchange; },
    set onchange(fn) { state.onchange = fn; },

    /** 结构性探测：后端在不在、要不要初始化、云端现在什么状态。force=true 跳过 30 秒缓存 */
    ping: function (cb, force) {
      cb = cb || function () {};
      if (!CFG.enabled) { state.available = false; return cb(null, { enabled: false }); }
      if (!force && state.available !== null && state.info && Date.now() - state.lastPing < PING_TTL) {
        return cb(null, state.info);
      }
      api('ping', { noAuth: true }, function (err, data) {
        if (err) { state.lastError = err.offline ? '连不上云端' : '云端不可用'; notify(); return cb(err); }
        state.lastError = '';
        notify();
        cb(null, data);
      });
    },

    /* ---------------- 账号 ---------------- */

    setup: function (pw, hint, cb) {
      cb = cb || function () {};
      api('setup', { noAuth: true, body: { password: pw, hint: hint || '' } }, function (err, data) {
        if (err) { state.lastError = err.error || '云端初始化失败'; notify(); return cb(err); }
        TOK = { token: data.token, expiresAt: data.expiresAt };
        saveTok();
        CFG.enabled = true;
        state.available = true;
        state.lastError = '';
        saveCfg();
        notify();
        cb(null, data);
      });
    },

    login: function (pw, cb) {
      cb = cb || function () {};
      api('login', { noAuth: true, body: { password: pw } }, function (err, data) {
        if (err) { state.lastError = err.error || '登录失败'; notify(); return cb(err); }
        TOK = { token: data.token, expiresAt: data.expiresAt };
        saveTok();
        CFG.enabled = true;
        state.available = true;
        state.lastError = '';
        saveCfg();
        notify();
        cb(null, data);
      });
    },

    logout: function () {
      TOK = null;
      saveTok();
      notify();
    },

    changepw: function (oldPw, newPw, hint, cb) {
      cb = cb || function () {};
      api('changepw', { body: { oldPassword: oldPw, password: newPw, hint: hint || '' } }, function (err, data) {
        if (err) return cb(err);
        TOK = { token: data.token, expiresAt: data.expiresAt };
        saveTok();
        notify();
        cb(null, data);
      });
    },

    /** 让所有设备下线（含自己） */
    revoke: function (cb) {
      cb = cb || function () {};
      api('revoke', {}, function (err) {
        TOK = null; saveTok(); notify();
        cb(err);
      });
    },

    /* ---------------- 数据 ---------------- */

    history: function (cb) {
      api('history', {}, function (err, data) {
        if (err) return cb(err);
        cb(null, data);
      });
    },

    downloadUrl: function (rev) {
      var tok = tokenValue();
      return buildUrl('download', rev ? { rev: rev, t: tok } : { t: tok });
    },

    restore: function (rev, cb) {
      api('restore', { query: { rev: rev } }, function (err, data) {
        if (err) return cb(err);
        CFG.rev = data.rev;
        CFG.lastSyncAt = Date.now();
        state.dirty = false;
        saveCfg();
        // 回滚后本机也要跟着回滚
        Cloud.pull(true, function () { notify(); cb(null, data); });
      });
    },

    /** 拉云端并写入本机（force=true 时即使本机有改动也覆盖，覆盖前留一份本机快照） */
    pull: function (force, cb) {
      cb = cb || function () {};
      api('pull', {}, function (err, data) {
        if (err) return cb(err);
        if (data.empty) {
          CFG.rev = 0; saveCfg();
          return cb(null, { empty: true });
        }
        var risky = state.dirty && !force;
        if (risky) return cb({ conflict: true, rev: data.rev, remote: data });
        if (state.dirty && force) {
          try { localStorage.setItem(K_BAK, JSON.stringify({ at: Date.now(), data: Store.data })); } catch (e) {}
        }
        state.applying = true;
        try {
          Store.applyRemote(data.data);
        } finally {
          state.applying = false;
        }
        CFG.rev = data.rev;
        CFG.lastSyncAt = Date.now();
        state.dirty = false;
        state.lastError = '';
        saveCfg();
        notify();
        cb(null, { rev: data.rev, savedAt: data.savedAt, counts: data.counts, data: data.data });
      });
    },

    /** 上传本机账本 */
    push: function (opts, cb) {
      opts = opts || {};
      cb = cb || function () {};
      var force = !!opts.force;
      var body = { data: Store.data, device: CFG.label, baseRev: force ? -1 : CFG.rev, force: force };
      api('push', { body: body }, function (err, data) {
        if (err && err.data && err.data.conflict) {
          return cb({ conflict: true, rev: err.data.rev, savedAt: err.data.savedAt, device: err.data.device, counts: err.data.counts });
        }
        if (err) {
          state.lastError = err.offline ? '连不上云端，稍后自动重试' : (err.error || '上传失败');
          notify();
          return cb(err);
        }
        CFG.rev = data.rev;
        CFG.lastSyncAt = Date.now();
        state.dirty = false;
        state.lastError = '';
        saveCfg();
        notify();
        cb(null, data);
      });
    },
  };

  /* ---------------- 同步编排 ---------------- */

  /**
   * 一次完整同步。cb(err, result)
   * result.state: 'off' | 'needSetup' | 'needLogin' | 'empty' | 'same' | 'pulled' | 'pushed' | 'conflict'
   */
  Cloud.sync = function (opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    cb = cb || function () {};

    if (!CFG.enabled) return cb(null, { state: 'off' });
    if (state.busy) return cb(null, { state: 'busy' });

    // 同步决策必须基于最新状态，不能吃 30 秒缓存（否则会拿旧版本号做判断）
    Cloud.ping(function (perr, info) {
      if (perr || !info || !info.ok) return cb(null, { state: 'offline' });
      if (info.needsSetup) {
        return cb(null, { state: 'needSetup' });
      }
      if (!tokenValue()) {
        return cb(null, { state: 'needLogin' });
      }

      state.busy = true;
      var done = function (r) { state.busy = false; if (r && r.state) notify(); cb(r && r.err ? r.err : null, r); };

      var srvRev = Number(info.rev) || 0;

      // 本机有改动 → 优先上传
      if (state.dirty) {
        return Cloud.push({ force: opts.forcePush }, function (err, data) {
          if (err && err.conflict) return done({ state: 'conflict', rev: err.rev, savedAt: err.savedAt, device: err.device });
          if (err) return done({ state: 'error', err: err });
          done({ state: 'pushed', rev: data.rev });
        });
      }

      // 本机没改动
      if (srvRev > CFG.rev) {
        return Cloud.pull(false, function (err, data) {
          if (err && err.conflict) return done({ state: 'conflict', rev: err.rev, remote: err.remote });
          if (err) return done({ state: 'error', err: err });
          if (data && data.empty) return done({ state: 'same' });
          done({ state: 'pulled', rev: data.rev });
        });
      }

      // 本机比云端新（云端被回滚过）→ 推上去
      if (srvRev < CFG.rev) {
        return Cloud.push({ force: true }, function (err, data) {
          if (err) return done({ state: 'error', err: err });
          done({ state: 'pushed', rev: data.rev });
        });
      }

      // 完全一致；云端还没有账本而本机有数据 → 首次上传
      if (srvRev === 0 && Store.data.customers.length + Store.data.txs.length + Store.data.incomes.length > 0) {
        return Cloud.push({}, function (err, data) {
          if (err) return done({ state: 'error', err: err });
          done({ state: 'pushed', rev: data.rev });
        });
      }

      CFG.lastSyncAt = Date.now();
      saveCfg();
      done({ state: 'same', rev: srvRev });
    }, true);
  };

  /** 本地数据变更时调用（store.save 里触发）：防抖后自动上传 */
  Cloud.onLocalChange = function () {
    if (state.applying) return;
    state.dirty = true;
    notify();
    if (!CFG.enabled) return;
    if (!tokenValue()) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = null;
      Cloud.sync({}, function () {});
    }, DEBOUNCE);
  };

  /** 立即同步（用户点按钮） */
  Cloud.syncNow = function (cb) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    Cloud.ping(function () {
      Cloud.sync({}, function (err, r) { cb && cb(err, r); });
    }, true);
  };

  Cloud.markDirty = function () { state.dirty = true; notify(); };

  /** 给 UI 用的一句话状态 */
  Cloud.status = function () {
    var res = {
      enabled: CFG.enabled,
      available: state.available,
      availableRaw: state.available,
      loggedIn: !!tokenValue(),
      rev: CFG.rev,
      lastSyncAt: CFG.lastSyncAt,
      dirty: state.dirty,
      busy: state.busy,
      error: state.lastError,
      info: state.info,
      label: CFG.label
    };
    if (!CFG.enabled) { res.text = '已关闭'; res.tone = 'off'; return res; }
    if (state.available === false) {
      // 已登录说明以前连上过：这只是暂时连不上，别说成「云端未连接」吓人
      res.text = tokenValue() ? '暂时连不上云端' : '云端未连接';
      res.tone = 'warn';
      return res;
    }
    if (state.available === null) { res.text = '检查中…'; res.tone = 'off'; return res; }
    if (state.info && state.info.needsSetup) { res.text = '待初始化'; res.tone = 'warn'; return res; }
    if (!tokenValue()) { res.text = '未登录', res.tone = 'warn'; return res; }
    if (state.dirty) { res.text = '有改动待上传'; res.tone = 'warn'; return res; }
    if (state.lastError) { res.text = state.lastError; res.tone = 'warn'; return res; }
    if (!CFG.lastSyncAt) { res.text = '已连接'; res.tone = 'ok'; return res; }
    res.text = '已同步';
    res.tone = 'ok';
    return res;
  };

  Cloud.hostOf = hostOf;
  Cloud.localBackup = function () { return jget(K_BAK); };
  Cloud.clearLocalBackup = function () { jdel(K_BAK); };

  global.Cloud = Cloud;
})(window);
