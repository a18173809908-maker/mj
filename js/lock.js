/* ==========================================================================
   lock.js — 数字密码锁
   --------------------------------------------------------------------------
   说明：这是「开屏门禁」，不是账号系统——本站点是纯静态托管，没有服务端可校验。
   它挡的是"别人拿到网址随手打开就看到账目"，密码校验在本地完成。
   密码经过 SHA-256 加盐迭代后存储（HTTP 下浏览器不提供 crypto.subtle，
   所以自带了一个纯 JS 实现），不存明文。
   ========================================================================== */
(function (global) {
  'use strict';

  var KEY = 'ledger_mahjong_lock';        // { salt, hash, len, iter, hint, createdAt }
  var UNLOCK_KEY = 'ledger_mahjong_unlock'; // { exp } 本机记住解锁（localStorage）
  var ITER = 3000;                        // 哈希迭代次数
  var MAX_TRY = 5;                        // 连续错误次数上限
  var COOL_MS = 30000;                    // 超限后冷却时间
  var REMEMBER_DAYS = 7;

  /* ---------- 极简 SHA-256（ASCII 输入足够），来源为公开的紧凑实现 ---------- */
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mp = Math.pow, maxWord = mp(2, 32), i, j, result = '';
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = sha256.h = sha256.h || [], k = sha256.k = sha256.k || [], primeCounter = k.length;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mp(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mp(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
            w[i - 16]
            + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function randSalt() {
    var s = '', chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    if (global.crypto && crypto.getRandomValues) {
      var buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) s += chars.charAt(buf[i] % chars.length);
    } else {
      for (var j = 0; j < 16; j++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  /** 加盐 + 多轮迭代，避免明文存储 */
  function hashPin(pin, salt) {
    var h = sha256(salt + '|' + pin);
    for (var i = 0; i < ITER; i++) h = sha256(h + i);
    return h;
  }

  function readJSON(k) {
    try { return JSON.parse(global.localStorage.getItem(k) || 'null'); }
    catch (e) { return null; }
  }
  function writeJSON(k, v) {
    try { global.localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  }

  var sessionUnlocked = false;   // 本次页面会话已解锁（不落盘）
  var cooldownUntil = 0;
  var tries = 0;

  var Lock = {
    /** 是否已设置密码 */
    isSet: function () {
      var m = readJSON(KEY);
      return !!(m && m.hash && m.salt);
    },

    /** 当前是否已解锁（可直接进入系统） */
    isUnlocked: function () {
      if (!Lock.isSet()) return false;  // 还没设密码：必须先设置才能进（强制门禁）
      if (sessionUnlocked) return true;
      var u = readJSON(UNLOCK_KEY);
      if (u && u.exp && u.exp > Date.now()) return true;
      if (u && u.exp && u.exp <= Date.now()) { try { localStorage.removeItem(UNLOCK_KEY); } catch (e) {} }
      return false;
    },

    /** 记住本机解锁 N 天 */
    remember: function (days) {
      sessionUnlocked = true;
      writeJSON(UNLOCK_KEY, { exp: Date.now() + (days || REMEMBER_DAYS) * 86400000 });
    },

    /** 立刻上锁（下次打开要输密码） */
    lockNow: function () {
      sessionUnlocked = false;
      try { global.localStorage.removeItem(UNLOCK_KEY); } catch (e) {}
    },

    /** 校验密码 */
    verify: function (pin) {
      var m = readJSON(KEY);
      if (!m) return true;
      return hashPin(String(pin), m.salt) === m.hash;
    },

    hint: function () {
      var m = readJSON(KEY);
      return m && m.hint ? m.hint : '';
    },

    /** 设置 / 修改密码 */
    setPin: function (pin, hint) {
      var salt = randSalt();
      writeJSON(KEY, {
        salt: salt, hash: hashPin(String(pin), salt),
        len: String(pin).length, iter: ITER,
        hint: String(hint || '').trim(), createdAt: Date.now()
      });
      sessionUnlocked = true;
    },

    /** 关闭密码锁 */
    removePin: function () {
      try { global.localStorage.removeItem(KEY); } catch (e) {}
      try { global.localStorage.removeItem(UNLOCK_KEY); } catch (e) {}
      sessionUnlocked = true;
    },

    /** 忘记密码：清空本机账目并解锁（数据不可找回，需二次确认） */
    resetByWipe: function () {
      try { if (global.Store) global.Store.clearAll(); } catch (e) {}
      Lock.removePin();
    },

    showLockScreen: showLockScreen,
    openSetup: openSetup,
    sha256: sha256,          // 仅供自测使用

    /**
     * 取走刚验证通过（或刚设置）的密码明文，取一次即清空。
     * 用途：把「进入密码」同步给云端当登录口令，用户只需记住一个密码。
     * 只在内存里短暂存在，不落盘。
     */
    _lastPin: '',
    takePin: function () {
      var p = Lock._lastPin || '';
      Lock._lastPin = '';
      return p;
    }
  };

  /* ======================= 界面 ======================= */

  function root() {
    var r = document.getElementById('lock-root');
    if (!r) {
      r = document.createElement('div');
      r.id = 'lock-root';
      document.body.appendChild(r);
    }
    return r;
  }

  function iconHtml() {
    return '<img class="lock-icon" src="assets/icon-192.png" alt="往来账">';
  }

  function dotsHtml(len, filled) {
    var html = '';
    for (var i = 0; i < len; i++) html += '<i class="' + (i < filled ? 'on' : '') + '"></i>';
    return html;
  }

  function keypadHtml() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
    return '<div class="keypad" id="lockPad">' + keys.map(function (k) {
      if (k === 'clear') return '<button type="button" class="ghost" data-key="clear">清空</button>';
      if (k === 'back') return '<button type="button" class="ghost" data-key="back">⌫</button>';
      return '<button type="button" data-key="' + k + '">' + k + '</button>';
    }).join('') + '</div>';
  }

  function paint(state) {
    var r = root();
    var sub = state.sub || '';
    var err = state.err || '';
    var body;

    if (state.inputMode) {
      // 「密码提示」步骤：文字输入
      body =
        '<input class="lock-input" id="lockHint" maxlength="30" placeholder="比如：店里常用的那串" value="' + (state.hint || '') + '">' +
        '<button class="lock-ok on" id="lockHintOk" type="button">' + (state.hintOkText || '保存') + '</button>' +
        '<button class="lock-forgot" id="lockHintSkip" type="button">不设提示，直接进入</button>';
    } else {
      body =
        (state.note ? '<p class="lock-note">' + state.note + '</p>' : '') +
        '<div class="lock-dots' + (state.shake ? ' shake' : '') + '">' + dotsHtml(state.pinLen || 6, state.buf.length) + '</div>' +
        '<div class="lock-err">' + err + '</div>' +
        (state.showRemember
          ? '<label class="lock-remember"><input type="checkbox" id="lockRemember"' + (state.remember ? ' checked' : '') + '>本机记住 ' + REMEMBER_DAYS + ' 天，不重复输</label>'
          : '<div class="lock-remember"></div>') +
        keypadHtml() +
        '<button class="lock-ok" id="lockOk" type="button"' + (state.buf.length >= 4 ? '' : ' disabled') + '>' + (state.okText || '确定') + '</button>' +
        (state.forgot ? '<button class="lock-forgot" id="lockForgot" type="button">忘记密码？</button>' : '');
    }

    r.innerHTML =
      '<div class="lock-screen">' +
      '  <div class="lock-head">' + iconHtml() +
      '    <div class="lock-title">' + (state.title || '往来账') + '</div>' +
      '    <div class="lock-sub">' + (sub || '请输入密码') + '</div>' +
      '  </div>' +
      '  <div class="lock-body">' + body + '</div>' +
      '</div>';

    bind(state);
  }

  function bind(state) {
    var r = root();
    var pad = document.getElementById('lockPad');
    if (pad) {
      pad.addEventListener('click', function (e) {
        var b = e.target.closest('[data-key]');
        if (!b) return;
        if (state.busy) return;
        var k = b.getAttribute('data-key');
        onKey(state, k);
      });
    }
    var ok = document.getElementById('lockOk');
    if (ok) ok.addEventListener('click', function () { submit(state); });
    var hintOk = document.getElementById('lockHintOk');
    if (hintOk) hintOk.addEventListener('click', function () {
      var v = document.getElementById('lockHint');
      state.onHint(String(v ? v.value : '').trim());
    });
    var skip = document.getElementById('lockHintSkip');
    if (skip) skip.addEventListener('click', function () { state.onHint(''); });
    var cb = document.getElementById('lockRemember');
    if (cb) cb.addEventListener('change', function () { state.remember = cb.checked; });
    var fg = document.getElementById('lockForgot');
    if (fg) fg.addEventListener('click', function () { forgotFlow(state); });
  }

  function onKey(state, k) {
    if (k === 'clear') state.buf = '';
    else if (k === 'back') state.buf = state.buf.slice(0, -1);
    else if (state.buf.length < (state.pinLen || 6)) state.buf += k;
    state.err = ''; state.shake = false;

    // 达到设置的长度就自动提交（解锁时体验更顺）
    if (state.autoSubmit && state.buf.length === (state.pinLen || 6)) {
      state.busy = true;
      paint(state);
      setTimeout(function () { state.busy = false; submit(state); }, 120);
      return;
    }
    paint(state);
  }

  function submit(state) {
    if (state.buf.length < 4) { state.err = '密码至少 4 位'; paint(state); return; }
    state.onSubmit(state.buf);
  }

  /** 冷却倒计时 */
  function startCooldown(state) {
    cooldownUntil = Date.now() + COOL_MS;
    var tick = function () {
      var left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (left > 0) {
        state.err = '密码错误次数过多，' + left + ' 秒后可再试';
        state.buf = '';
        paint(state);
        setTimeout(tick, 500);
      } else {
        tries = 0;
        state.err = '';
        paint(state);
      }
    };
    tick();
  }

  /** 忘记密码流程 */
  function forgotFlow(state) {
    var r = root();
    r.innerHTML =
      '<div class="lock-screen">' +
      '  <div class="lock-head">' + iconHtml() +
      '    <div class="lock-title">忘记密码</div>' +
      '    <div class="lock-sub">密码只存在这台设备上，无法找回</div>' +
      '  </div>' +
      '  <div class="lock-body">' +
      '    <p class="lock-note">唯一办法是清空本机账目数据后重设密码。<br>如果之前导出过备份文件，重置后可在「我的 → 导入备份」恢复。</p>' +
      '    <button class="lock-ok danger" id="lockWipe" type="button">清空数据并重置密码</button>' +
      '    <button class="lock-forgot" id="lockBack" type="button">返回，再想想</button>' +
      '  </div>' +
      '</div>';
    document.getElementById('lockBack').addEventListener('click', function () { paint(state); });
    document.getElementById('lockWipe').addEventListener('click', function () {
      this.disabled = true;
      this.textContent = '已清空，正在重置…';
      Lock.resetByWipe();
      setTimeout(function () { location.reload(); }, 400);
    });
  }

  /** 显示解锁界面，解锁成功后回调 */
  function showLockScreen(onOk) {
    document.body.classList.add('locked');
    var state = {
      buf: '', err: '', title: '往来账', sub: '输入密码后才能进入',
      pinLen: 6, autoSubmit: true, showRemember: true, remember: false,
      forgot: true, okText: '进入', busy: false
    };

    // 密码位数已知，用来控制自动提交和圆点数
    var meta = readJSON(KEY);
    state.pinLen = (meta && meta.len) ? meta.len : 6;

    state.onSubmit = function (pin) {
      if (Date.now() < cooldownUntil) return;
      if (Lock.verify(pin)) {
        tries = 0;
        Lock._lastPin = pin;   // 供云同步复用：刚输的密码拿去登录云端
        if (state.remember) Lock.remember(REMEMBER_DAYS); else sessionUnlocked = true;
        var r = root();
        r.innerHTML = '<div class="lock-screen unlock-away"><div class="lock-head">' + iconHtml() +
          '<div class="lock-title">欢迎回来</div></div></div>';
        setTimeout(function () {
          r.innerHTML = '';
          document.body.classList.remove('locked');
          if (onOk) onOk();
        }, 260);
      } else {
        tries++;
        state.buf = '';
        state.shake = true;
        if (tries >= MAX_TRY) { startCooldown(state); return; }
        state.err = '密码不对，还能试 ' + (MAX_TRY - tries) + ' 次' +
          (tries >= 3 && Lock.hint() ? '（提示：' + Lock.hint() + '）' : '');
        paint(state);
      }
    };
    paint(state);
  }

  /**
   * 设置 / 修改 / 关闭密码锁
   * opts.mode: 'set' | 'change' | 'off'
   * opts.gate: true 表示首次使用的强制门禁（没有退出，不设完进不去）
   * opts.warnData: true 表示本机已有账目，引导页加一句提醒
   * opts.onDone(): 成功回调
   */
  function openSetup(opts) {
    opts = opts || {};
    var mode = opts.mode || 'set';
    var gate = !!opts.gate;
    var warnData = !!opts.warnData;
    var onDone = opts.onDone || function () {};
    document.body.classList.add('locked');

    var st = {
      buf: '', err: '', pinLen: 6, autoSubmit: false, showRemember: false,
      forgot: false, first: '', step: (mode === 'set' ? 'new' : 'verify')
    };

    // 关闭密码锁时先验证身份
    if (mode !== 'set') {
      st.title = '验证身份'; st.sub = '请输入当前密码'; st.okText = '下一步';
      var meta0 = readJSON(KEY);
      st.pinLen = (meta0 && meta0.len) ? meta0.len : 6;
      st.autoSubmit = true;
      st.onSubmit = function (pin) {
        if (!Lock.verify(pin)) {
          st.buf = ''; st.shake = true; st.err = '密码不对';
          paint(st); return;
        }
        if (mode === 'off') { Lock.removePin(); done('密码锁已关闭'); return; }
        askNew();
      };
      paint(st);
      return;
    }
    askNew();

    function askNew() {
      st.title = gate ? '设置进入密码' : (mode === 'set' ? '设置密码锁' : '修改密码');
      st.sub = gate ? '必须输密码才能打开，先设一个' : '设置 4-6 位数字密码';
      st.okText = '下一步';
      st.note = gate
        ? (warnData
          ? '这台设备上已经有账目数据。密码只存在本机、无法找回，忘了就只能清空数据重来——请设一个记得住的。'
          : '4-6 位数字。密码只存在这台设备上，忘了就只能清空数据重来。')
        : '';
      st.autoSubmit = false; st.buf = ''; st.err = ''; st.step = 'new';
      st.onSubmit = function (pin) { st.first = pin; askConfirm(); };
      paint(st);
    }

    function askConfirm() {
      st.title = '再输一次'; st.sub = '确认刚才的密码'; st.note = '';
      st.buf = ''; st.err = ''; st.step = 'confirm';
      st.onSubmit = function (pin) {
        if (pin !== st.first) {
          st.err = '两次输入不一致，重新设置'; st.buf = ''; st.shake = true;
          paint(st);
          setTimeout(askNew, 700);
          return;
        }
        askHint();
      };
      paint(st);
    }

    function askHint() {
      st.title = '密码提示'; st.sub = '选填，连续输错 3 次会显示出来';
      st.buf = ''; st.err = ''; st.note = ''; st.inputMode = true; st.hint = (readJSON(KEY) || {}).hint || '';
      st.hintOkText = gate ? '保存并进入' : '保存并启用';
      st.onHint = function (hint) {
        Lock.setPin(st.first, hint);
        Lock._lastPin = st.first;   // 供云同步复用：刚设的密码拿去初始化云端
        done(mode === 'set' ? (gate ? '密码已设置，以后打开要输它' : '密码锁已开启') : '密码已修改');
      };
      paint(st);
    }

    function done(msg) {
      var r = root();
      r.innerHTML = '';
      document.body.classList.remove('locked');
      onDone(msg);
    }
  }

  global.Lock = Lock;
})(window);
