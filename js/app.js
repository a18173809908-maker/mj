/* ==========================================================================
   app.js — 页面渲染与交互
   ========================================================================== */
(function (global) {
  'use strict';

  var Store = global.Store, UI = global.UI;
  var esc = UI.esc, icon = UI.icon, money = Store.util.money, humanDate = Store.util.humanDate, hmTime = Store.util.hmTime, today = Store.util.toDateStr;
  var CAT_LABEL = Store.util.CATEGORY_LABEL;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var view = $('#view');
  var VERSION = '2.1.0';

  var state = {
    route: 'home',
    customerId: null,
    custSort: 'balance',   // balance | recent | name
    txFilter: 'all',       // all | owe | paid
    txCat: 'all',          // all | fee | cig | other
    txKeyword: '',
    custKeyword: ''
  };

  /* ================= 通用：toast / 对话框 / 抽屉 ================= */

  function toast(msg, type, ms) {
    var root = $('#toast-root');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 1800);
  }

  /** 确认对话框，resolve(true/false) */
  function confirmDlg(opts) {
    return new Promise(function (resolve) {
      var root = $('#dialog-root');
      root.innerHTML =
        '<div class="dlg-mask">' +
        '  <div class="dlg" role="dialog" aria-modal="true">' +
        '    <h3>' + esc(opts.title || '确认') + '</h3>' +
        '    <p>' + (opts.html || esc(opts.text || '')) + '</p>' +
        '    <div class="btn-row">' +
        '      <button class="btn btn-ghost" data-act="no">' + esc(opts.cancelText || '取消') + '</button>' +
        '      <button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="yes">' + esc(opts.okText || '确定') + '</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';
      var mask = $('.dlg-mask', root);
      requestAnimationFrame(function () { requestAnimationFrame(function () { mask.classList.add('show'); }); });
      function done(val) {
        mask.classList.remove('show');
        setTimeout(function () { root.innerHTML = ''; }, 200);
        resolve(val);
      }
      mask.addEventListener('click', function (e) { if (e.target === mask) done(false); });
      $('[data-act="no"]', mask).addEventListener('click', function () { done(false); });
      $('[data-act="yes"]', mask).addEventListener('click', function () { done(true); });
    });
  }

  var sheetCloseCb = null;

  /** 打开底部抽屉，返回 sheet 元素 */
  function openSheet(html, onClose) {
    closeSheet(true);
    sheetCloseCb = onClose || null;
    var root = $('#sheet-root');
    root.innerHTML =
      '<div class="sheet-mask"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
    var mask = $('.sheet-mask', root), sheet = $('.sheet', root);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { mask.classList.add('show'); sheet.classList.add('show'); });
    });
    mask.addEventListener('click', function () { closeSheet(); });
    var closeBtn = $('[data-close]', sheet);
    if (closeBtn) closeBtn.addEventListener('click', function () { closeSheet(); });
    return sheet;
  }

  function closeSheet(instant) {
    var root = $('#sheet-root');
    var mask = $('.sheet-mask', root), sheet = $('.sheet', root);
    if (!sheet) { sheetCloseCb = null; return; }
    var cb = sheetCloseCb; sheetCloseCb = null;
    var finish = function () {
      root.innerHTML = '';
      if (cb) cb();
    };
    if (instant) { finish(); return; }
    mask.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(finish, 300);
  }

  function sheetHead(title) {
    return '<div class="sheet-head"><h3>' + title + '</h3>' +
      '<button class="close" data-close type="button" aria-label="关闭">' + icon('close', 18) + '</button></div>';
  }

  /* ================= 数据下载 / 上传 ================= */

  function downloadFile(name, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 400);
  }

  function stampName(ext) {
    var d = new Date();
    var p = Store.util.toDateStr(d).replace(/-/g, '');
    var t = ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
    return '往来账备份_' + p + '_' + t + '.' + ext;
  }

  /* ================= 底部导航 ================= */

  var TABS = [
    { id: 'home', name: '客户', icon: 'users' },
    { id: 'income', name: '牌局', icon: 'wallet' },
    { id: 'txs', name: '流水', icon: 'receipt' },
    { id: 'stats', name: '统计', icon: 'chart' },
    { id: 'me', name: '我的', icon: 'gear' }
  ];

  function renderTabbar() {
    var cur = TABS.some(function (t) { return t.id === state.route; }) ? state.route : 'home';
    $('#tabbar').innerHTML = TABS.map(function (t) {
      return '<button class="tab' + (t.id === cur ? ' on' : '') + '" data-tab="' + t.id + '" type="button">' +
        icon(t.icon, 22) + '<span>' + t.name + '</span></button>';
    }).join('');
  }

  $('#tabbar').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-tab]');
    if (!btn) return;
    go('#/' + btn.getAttribute('data-tab'));
  });

  $('#fab').addEventListener('click', function () {
    if (state.route === 'income') openOpenSheet({});
    else openTxSheet({});
  });

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function pageTitle(title, sub, withBack, actions, extraHtml) {
    var btns = '';
    if (withBack) btns += '<button class="back-btn" data-back type="button" aria-label="返回">' + icon('back', 22) + '</button>';
    (actions || []).forEach(function (a) {
      btns += '<button class="icon-btn" data-act="' + a.id + '" type="button" aria-label="' + (a.title || a.id) + '">' + icon(a.label, 20) + '</button>';
    });
    return '<header class="topbar"><div class="topbar-row">' + btns +
      '<div style="flex:1;min-width:0"><h1>' + title + '</h1>' +
      (sub ? '<p class="sub">' + sub + '</p>' : '') + '</div>' +
      '</div>' + (extraHtml || '') + '</header>';
  }

  /* ================= 页面：客户（首页） ================= */

  function renderHome() {
    var ov = Store.overview();
    var kw = state.custKeyword.trim().toLowerCase();

    var custs = Store.listCustomers().map(function (c) {
      return { c: c, bal: Store.balanceOf(c.id), sum: Store.summaryOf(c.id) };
    });

    if (kw) {
      custs = custs.filter(function (r) {
        return (r.c.name || '').toLowerCase().indexOf(kw) >= 0 ||
               (r.c.phone || '').indexOf(kw) >= 0;
      });
    }
    if (state.custSort === 'balance') {
      custs.sort(function (a, b) { return b.bal - a.bal || (b.sum.lastDate || '').localeCompare(a.sum.lastDate || ''); });
    } else if (state.custSort === 'recent') {
      custs.sort(function (a, b) { return (b.sum.lastDate || '').localeCompare(a.sum.lastDate || ''); });
    } else {
      custs.sort(function (a, b) { return (a.c.name || '').localeCompare(b.c.name || '', 'zh-Hans-CN'); });
    }

    var sorts = [
      { id: 'balance', label: '欠款多→少' },
      { id: 'recent', label: '最近有往来' },
      { id: 'name', label: '按姓名' }
    ];

    var html =
      pageTitle('往来账', '账目只存在这台手机上', false, [{ id: 'addCust', label: 'usersAdd', title: '新增客户' }]) +

      '<div class="hero">' +
      '  <div class="hero-label">当前应收总额（客户共欠）</div>' +
      '  <div class="hero-amount num"><span class="cur">¥</span>' + esc(money(ov.receivable)) + '</div>' +
      '  <div class="hero-meta">' +
      '    <div>欠款人数<b class="num">' + ov.debtors + ' 人</b></div>' +
      '    <div>我欠别人<b class="num">¥' + esc(money(ov.payable)) + '</b></div>' +
      '    <div>本月营收<b class="num">¥' + esc(money(ov.monthIncome)) + '</b></div>' +
      '  </div>' +
      '</div>' +

      '<div class="search">' + icon('search', 19) +
      '  <input id="custSearch" type="search" placeholder="搜姓名 / 电话" value="' + esc(state.custKeyword) + '">' +
      '</div>' +

      '<div class="chips" style="margin:0 16px 12px">' + sorts.map(function (s) {
        return '<button class="chip' + (state.custSort === s.id ? ' on' : '') + '" data-sort="' + s.id + '" type="button">' + s.label + '</button>';
      }).join('') + '</div>' +

      '<div class="section">' +
      '<div class="section-head"><h2>客户名单' + (custs.length ? ' · ' + custs.length + ' 位' : '') + '</h2>' +
      '<button class="link" id="addCustBtn" type="button">' + icon('plus', 14) + '新增客户</button></div>' +
      '<div class="card">';

    if (!custs.length) {
      html += emptyHtml(kw);
    } else {
      html += custs.map(function (r) {
        var sub = r.c.phone ? esc(r.c.phone) : '';
        if (r.sum.lastDate) sub += (sub ? ' · ' : '') + '最近 ' + r.sum.lastDate.slice(5).replace('-', '/');
        if (r.sum.oweCig > 0) sub += (sub ? ' · ' : '') + '含烟钱 ¥' + esc(money(r.sum.oweCig));
        return '<button class="cust" data-cust="' + r.c.id + '" type="button">' +
          UI.avatarHtml(r.c.name) +
          '<span class="cust-main"><span class="cust-name">' + esc(r.c.name) + '</span>' +
          '<span class="cust-sub">' + (sub || '暂无往来') + '</span></span>' +
          '<span class="cust-amt">' + UI.balanceHtml(r.bal) + '</span>' +
          '</button>';
      }).join('');
    }
    html += '</div></div>';
    view.innerHTML = html;

    var search = $('#custSearch');
    search.addEventListener('input', function () {
      state.custKeyword = search.value;
      var pos = search.selectionStart;
      renderHome();
      var s2 = $('#custSearch');
      s2.focus();
      try { s2.setSelectionRange(pos, pos); } catch (e) { }
    });
    view.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.custSort = b.getAttribute('data-sort');
        renderHome();
      });
    });
    view.querySelectorAll('[data-cust]').forEach(function (b) {
      b.addEventListener('click', function () { go('#/c/' + b.getAttribute('data-cust')); });
    });
    var addTop = view.querySelector('[data-act="addCust"]');
    if (addTop) addTop.addEventListener('click', function () { openCustomerSheet(null); });
    var addLink = $('#addCustBtn');
    if (addLink) addLink.addEventListener('click', function () { openCustomerSheet(null); });
    var demo = $('#loadDemoBtn');
    if (demo) demo.addEventListener('click', loadDemo);
  }

  function emptyHtml(kw) {
    if (kw) {
      return '<div class="empty"><div class="big">🔍</div><h3>没找到“' + esc(state.custKeyword.trim()) + '”</h3>' +
        '<p>换个关键词试试，或者点上面的「<b>＋ 新增客户</b>」建一位新客人</p></div>';
    }
    if (!Store.hasAnyData()) {
      return '<div class="empty"><div class="big">🀄</div><h3>还没有客户</h3>' +
        '<p>点上面的「<b>＋ 新增客户</b>」，先把常来的客人们录进来<br>' +
        '之后「牌局」页开台、「流水」页查账<br>客户详情里也能随时记欠款 / 收款</p>' +
        '<button id="loadDemoBtn" class="chip" type="button" style="margin-top:14px">先看看示例数据</button></div>';
    }
    return '<div class="empty"><div class="big">🀄</div><h3>没有匹配的客户</h3>' +
      '<p>搜不到就点上面的「<b>＋ 新增客户</b>」加一位</p></div>';
  }

  function loadDemo() {
    confirmDlg({
      title: '载入示例数据？',
      text: '会新增 3 位示例客户、几笔往来流水和几场营业收入，方便先熟悉功能。之后可以随时删除。',
      okText: '载入'
    }).then(function (yes) {
      if (!yes) return;
      Store.loadDemo();
      toast('示例数据已载入', 'ok');
      render();
    });
  }

  /* ================= 页面：客户详情 ================= */

  function renderDetail(id) {
    var c = Store.getCustomer(id);
    if (!c) { go('#/home'); return; }
    var s = Store.summaryOf(id);
    var bal = s.balance;
    var balText, stateText, cls;
    if (bal > 0.004) { cls = 'owe'; balText = '¥' + money(bal); stateText = '他还欠你这么多'; }
    else if (bal < -0.004) { cls = 'paid'; balText = '¥' + money(-bal); stateText = '你多收了他的，后面少收点'; }
    else { cls = 'zero'; balText = '¥0'; stateText = s.count ? '账已结清' : '还没有往来记录'; }

    var txs = Store.listTxs({ customerId: id });

    // 欠款构成
    var parts = [];
    if (s.oweLoan > 0) parts.push('借款 ¥' + esc(money(s.oweLoan)));
    if (s.oweFee > 0) parts.push('台费 ¥' + esc(money(s.oweFee)));
    if (s.oweCig > 0) parts.push('烟钱 ¥' + esc(money(s.oweCig)));
    if (s.oweOther > 0) parts.push('其他 ¥' + esc(money(s.oweOther)));

    var html =
      pageTitle(esc(c.name), '', true, [{ id: 'editCust', label: 'pencil', title: '编辑资料' }]) +

      '<div class="detail-hero">' +
      '  <div class="name">' + esc(c.name) + '</div>' +
      (c.phone ? '  <div class="phone"><a href="tel:' + esc(c.phone) + '" style="color:inherit">' + esc(c.phone) + '</a></div>' : '') +
      (c.note ? '  <div class="phone">' + esc(c.note) + '</div>' : '') +
      '  <div class="label">' + (cls === 'paid' ? '你应付' : '当前应收') + '</div>' +
      '  <div class="amt num ' + cls + '">' + balText + '</div>' +
      '  <div class="state">' + stateText + '</div>' +
      (parts.length ? '  <div class="breakdown">累计欠款构成：' + parts.join(' · ') + '</div>' : '') +
      '</div>' +

      '<div class="quick">' +
      '  <button class="q-owe" id="quickOwe" type="button">' + icon('plus', 18) + '记欠款</button>' +
      '  <button class="q-paid" id="quickPaid" type="button">' + icon('down', 18) + '收欠款</button>' +
      '</div>' +

      (c.phone ? '<div class="section" style="margin-bottom:12px">' +
        '<button class="btn btn-ghost" id="callBtn" type="button">' + icon('phone', 18) + '打电话催一下（' + esc(c.phone) + '）</button></div>' : '') +

      '<div class="section">' +
      '  <div class="section-head"><h2>往来记录</h2><span class="muted num">累计欠 ' + esc(money(s.owe)) + ' · 累计收 ' + esc(money(s.paid)) + '</span></div>' +
      '  <div class="card">';

    if (!txs.length) {
      html += '<div class="empty" style="padding:30px 20px"><p>还没有往来记录<br>点上方按钮记第一笔</p></div>';
    } else {
      html += txHtml(txs, { showName: false });
    }
    html += '</div></div>';
    view.innerHTML = html;

    $('#quickOwe').addEventListener('click', function () { openTxSheet({ customerId: id, type: 'owe' }); });
    $('#quickPaid').addEventListener('click', function () { openTxSheet({ customerId: id, type: 'paid' }); });
    var call = $('#callBtn');
    if (call) call.addEventListener('click', function () { location.href = 'tel:' + c.phone; });
    $('[data-act="editCust"]').addEventListener('click', function () { openCustomerSheet(id); });
    view.querySelectorAll('[data-tx]').forEach(function (b) {
      b.addEventListener('click', function () { openTxSheet({ txId: b.getAttribute('data-tx') }); });
    });
  }

  /** 流水行 HTML（日期分组可选） */
  function txHtml(txs, opts) {
    opts = opts || {};
    var out = '', lastDate = '';
    txs.forEach(function (t) {
      if (t.date !== lastDate) {
        lastDate = t.date;
        if (opts.group !== false) out += '<div class="day-head">' + humanDate(t.date) + '</div>';
      }
      var c = Store.getCustomer(t.customerId);
      var isOwe = t.type === 'owe';
      var cat = Store.util.normCategory(t.category);
      var noteTxt = t.note || (isOwe ? '新增欠款' : '还了一笔');
      if (cat !== 'fee') noteTxt = CAT_LABEL[cat] + ' · ' + noteTxt;
      var tm = hmTime(t.createdAt);
      out += '<button class="tx" data-tx="' + t.id + '" type="button">' +
        '<span class="tx-badge ' + (isOwe ? 'owe' : 'paid') + (cat === 'cig' ? ' cig' : '') + (cat === 'loan' ? ' loan' : '') + '">' +
        (cat === 'cig' ? '烟' : (cat === 'loan' ? (isOwe ? '借' : '还') : (isOwe ? '欠' : '收'))) + '</span>' +
        '<span class="tx-main">' +
        '<span class="tx-title">' + (opts.showName !== false && c ? esc(c.name) : (isOwe ? '记欠款' : '收回欠款')) + '</span>' +
        '<span class="tx-note">' + (t.incomeId ? '<i class="tag-inc">' + (cat === 'loan' ? '场中借还' : '牌局挂账') + '</i>' : '') + esc(noteTxt) + '</span>' +
        '</span>' +
        '<span class="tx-side">' +
        '<span class="tx-amt num ' + (isOwe ? 'owe' : 'paid') + '">' + (isOwe ? '+' : '−') + esc(money(t.amount)) + '</span>' +
        (tm ? '<span class="tx-time num">' + tm + '</span>' : '') +
        '</span>' +
        '</button>';
    });
    return out;
  }

  /* ================= 页面：牌局（开台 / 借还 / 收台） ================= */

  var DEF_STAKE = 500;                       // 开台默认借款
  var HEAD_CHIPS = [3, 4];                   // 一场牌只有 3 人或 4 人，没有别的选项
  var FEE_CHIPS = [10, 20, 30, 50];
  var LOAN_CHIPS = [100, 200, 300, 500, 1000];

  /** 上桌人数只认 3 / 4：3 人以下按 3，4 人以上按 4 */
  function fixHead(n) { return (Number(n) || 4) > 3 ? 4 : 3; }

  /** 时长描述 */
  function durText(ms) {
    if (!(ms > 0)) return '刚开台';
    var m = Math.floor(ms / 60000);
    if (m < 1) return '刚开台';
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' 小时' + (mm ? mm + ' 分' : '');
  }

  /** 这一台怎么称呼 */
  function tableName(s) {
    if (s.tableNo) return s.tableNo;
    if (s.note) return s.note;
    return '这台牌';
  }

  function renderIncome() {
    var ov = Store.overview();
    var openList = Store.openSessions();
    var closed = Store.listIncomes({ status: 'closed' });
    var total = Store.incomeStats(null, null);
    var todayStr = today(new Date());
    var tInc = Store.incomeStats(todayStr, todayStr);
    var mInc = Store.incomeStats(todayStr.slice(0, 7) + '-01', null);
    var mLoan = ov.monthLoan || { out: 0, back: 0, net: 0 };

    // 已收工的按日期分组
    var groups = [], map = {};
    closed.forEach(function (it) {
      if (!map[it.date]) { map[it.date] = { date: it.date, total: 0, items: [] }; groups.push(map[it.date]); }
      var g = map[it.date];
      g.total += Number(it.amount || 0);
      g.items.push(it);
    });

    var html =
      pageTitle('牌局', '开台 · 借还 · 收台，一场一场清') +

      '<div class="hero">' +
      '  <div class="hero-label">今日营业额（台费）</div>' +
      '  <div class="hero-amount num"><span class="cur">¥</span>' + esc(money(tInc.total)) + '</div>' +
      '  <div class="hero-meta">' +
      '    <div>今日收现<b class="num paid">¥' + esc(money(tInc.cash)) + '</b></div>' +
      '    <div>今日场次<b class="num">' + ov.todayGames + ' 场</b></div>' +
      '    <div>本月营业额<b class="num">¥' + esc(money(mInc.total)) + '</b></div>' +
      '  </div>' +
      '</div>';

    // 正在打的台
    if (openList.length) {
      html += '<div class="section"><div class="section-head"><h2>正在打的台</h2>' +
        '<span class="muted num">' + openList.length + ' 台在打</span></div>' +
        '<div class="card">' + openList.map(openTableRowHtml).join('') + '</div></div>';
    }

    html += '<div class="section" style="margin-bottom:14px">' +
      '<button class="btn btn-primary" id="openTable" type="button">' + icon('plus', 20) + '开一台</button></div>';

    if (mLoan.out > 0) {
      html += '<div class="section" style="margin-bottom:14px"><div class="card"><div class="stat-row">' +
        '<div><span class="k">本月借出</span><b class="num owe">¥' + esc(money(mLoan.out)) + '</b></div>' +
        '<div><span class="k">本月收回</span><b class="num paid">¥' + esc(money(mLoan.back)) + '</b></div>' +
        '<div><span class="k">净借出</span><b class="num">¥' + esc(money(mLoan.net)) + '</b></div>' +
        '</div></div></div>';
    }

    html += '<div class="section"><div class="section-head"><h2>已收工的台</h2>' +
      '<span class="muted num">累计 ' + total.games + ' 场 · ¥' + esc(money(total.total)) + '</span></div>' +
      '<div class="card">';

    if (!closed.length) {
      html += '<div class="empty"><div class="big">🀄</div><h3>还没有收工的台</h3><p>点上面「开一台」，<br>把上桌的人和开台借款记上</p></div>';
    } else {
      groups.forEach(function (g) {
        html += '<div class="day-head"><span>' + humanDate(g.date) + '</span>' +
          '<b>¥' + esc(money(g.total)) + '</b></div>';
        html += g.items.map(closedRowHtml).join('');
      });
    }
    html += '</div></div>';

    view.innerHTML = html;

    $('#openTable').addEventListener('click', function () { openOpenSheet({}); });
    view.querySelectorAll('[data-table]').forEach(function (b) {
      b.addEventListener('click', function () { openSessionSheet(b.getAttribute('data-table')); });
    });
    // 正在打的台：行内直接收台，不用先进台面
    view.querySelectorAll('[data-closetbl]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        openCloseSheet(b.getAttribute('data-closetbl'));
      });
    });
  }

  /** 正在打的台：一行 */
  function openTableRowHtml(s) {
    var ss = Store.sessionSummary(s);
    var bits = [];
    bits.push('开台 ' + (hmTime(s.openAt) || '--:--') + ' · 打了 ' + durText(Date.now() - (s.openAt || s.createdAt || Date.now())));
    if (s.players) bits.push(s.players + ' 人');
    if (ss.loanOut > 0) bits.push('借出 ¥' + money(ss.loanOut) + (ss.loanBack > 0 ? ' · 已还 ¥' + money(ss.loanBack) : ''));
    return '<div class="tx tx-openrow">' +
      '<button class="tx-hit" data-table="' + s.id + '" type="button">' +
      '<span class="tx-badge live">台</span>' +
      '<span class="tx-main">' +
      '<span class="tx-title">' + esc(tableName(s)) + ' · 台费 ¥' + esc(money(ss.fee)) + '</span>' +
      '<span class="tx-note">' + esc(bits.join(' · ')) + '</span>' +
      '</span>' +
      '<span class="tx-side">' +
      '<span class="tx-amt num owe">¥' + esc(money(ss.netLoan)) + '</span>' +
      '<span class="tx-time">牌面</span>' +
      '</span>' +
      '</button>' +
      '<button class="mini tx-quickclose" data-closetbl="' + s.id + '" type="button">收台</button>' +
      '</div>';
  }

  /** 已收工的台：一行 */
  function closedRowHtml(s) {
    var ss = Store.sessionSummary(s);
    var meta = s.players + ' 人 × ¥' + money(s.unitPrice);
    if (s.tableNo) meta = s.tableNo + ' · ' + meta;
    if (s.note) meta += ' · ' + s.note;
    var sub = [];
    sub.push('台费已收 ¥' + money(ss.feePaid));
    if (ss.creditFee > 0) sub.push('还没收到 ¥' + money(ss.creditFee));
    if (ss.creditCig > 0) sub.push('烟钱挂账 ¥' + money(ss.creditCig));
    if (ss.loanOut > 0) sub.push('借出 ¥' + money(ss.loanOut) + (ss.loanBack > 0 ? ' · 已还 ¥' + money(ss.loanBack) : ''));
    return '<button class="tx" data-table="' + s.id + '" type="button">' +
      '<span class="tx-badge ' + (ss.netLoan > 0.004 ? 'credit' : 'inc') + '">场</span>' +
      '<span class="tx-main">' +
      '<span class="tx-title num">' + esc(meta) + '</span>' +
      '<span class="tx-note">' + esc(sub.join(' · ')) + '</span>' +
      '</span>' +
      '<span class="tx-side">' +
      '<span class="tx-amt num inc">+¥' + esc(money(ss.fee)) + '</span>' +
      (hmTime(s.closeAt || s.createdAt) ? '<span class="tx-time num">' + hmTime(s.closeAt || s.createdAt) + '</span>' : '') +
      '</span>' +
      '</button>';
  }

  /* ---------- 开台 / 改台 ---------- */

  function openOpenSheet(opts) {
    opts = opts || {};
    var editing = opts.tableId ? Store.getSession(opts.tableId) : null;
    var R2 = Store.util.round2;

    var draft = {
      tableNo: editing ? (editing.tableNo || '') : '',
      date: editing ? editing.date : today(new Date()),
      players: editing ? fixHead(editing.players) : 4,
      playersTouched: !!editing,          // 人数被手动改过 → 不再跟着上桌的人走
      unitPrice: editing ? (Number(editing.unitPrice) || 20) : 20,
      amount: editing ? Number(editing.amount) || 0 : 0,
      amountTouched: !!editing,
      feeMode: editing ? (editing.feeMode || 'separate') : 'separate',
      note: editing ? (editing.note || '') : '',
      guests: [],
      kw: '',
      adv: false                          // 「更多选项」是否展开
    };
    if (!editing) draft.amount = R2(draft.players * draft.unitPrice);

    var sheet = openSheet(
      sheetHead(editing ? '改这一台' : '开一台') +
      '<div class="sheet-body" id="openBody"></div>' +
      '<div class="sheet-foot">' +
      (editing ? '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-danger" id="delTable" type="button">' + icon('trash', 18) + '删除这一台</button></div>' : '') +
      '  <button class="btn btn-primary" id="saveTable" type="button">' + (editing ? '保存' : '开台') + '</button>' +
      '</div>'
    );

    /* ---------- 上桌的人：搜索 + 最近上桌 + 已加列表 ---------- */

    function haveIds() {
      var o = {};
      draft.guests.forEach(function (g) { o[g.customerId] = 1; });
      return o;
    }

    function guestsHtml() {
      if (!draft.guests.length) {
        return '<p class="hint" style="padding:2px 0 4px">还没加人。加了谁，就能单独给他设台费和开台借款。</p>';
      }
      return '<div class="glist">' +
        '<div class="grow3 ghead"><span>姓名</span><span>台费</span><span>借款</span><span></span></div>' +
        draft.guests.map(function (g) {
          return '<div class="grow3">' +
            '<span class="grow-name">' + esc(g.name) + '</span>' +
            '<span class="gcell"><input class="gin num" type="text" inputmode="decimal" data-gfee="' + g.customerId + '" value="' + String(g.fee === undefined || g.fee === null ? '' : g.fee) + '" placeholder="0"></span>' +
            '<span class="gcell loan"><input class="gin num" type="text" inputmode="decimal" data-stake="' + g.customerId + '" value="' + (g.stake ? String(g.stake) : '') + '" placeholder="0"></span>' +
            '<button class="gx" type="button" data-delguest="' + g.customerId + '" aria-label="移除">' + icon('close', 15) + '</button>' +
            '</div>';
        }).join('') + '</div>';
    }

    /** 最近上过桌的常客，一点即加 */
    function recentHtml() {
      var have = haveIds();
      var list = Store.recentPlayers(8).filter(function (c) { return !have[c.id]; });
      if (!list.length) return '';
      return '<div class="recent-wrap"><span class="recent-label">最近上桌</span>' +
        '<div class="recent">' + list.map(function (c) {
          return '<button class="rchip" type="button" data-addcust="' + c.id + '">' + esc(c.name) + '</button>';
        }).join('') + '</div></div>';
    }

    /** 搜索候选：打字即时出，点一下即加，不用再点「好了」 */
    function candHtml() {
      if (!draft.kw) return '';
      var have = haveIds();
      var kw = draft.kw.toLowerCase();
      var list = Store.listCustomers().filter(function (c) {
        if (have[c.id]) return false;
        return c.name.toLowerCase().indexOf(kw) >= 0;
      }).slice(0, 6);
      var rows = list.map(function (c) {
        var bal = Store.balanceOf(c.id);
        return '<button class="pick" type="button" data-addcust="' + c.id + '">' +
          '<span class="pn">' + esc(c.name) + '</span>' +
          '<span class="pv">' + (bal > 0.004 ? '已欠 ¥' + esc(money(bal)) : '账已清') + '</span>' +
          '</button>';
      }).join('');
      if (!Store.findCustomerByName(draft.kw)) {
        rows += '<button class="pick pick-new" type="button" data-newcust="1">' +
          '<span class="pn">＋ 新建「' + esc(draft.kw) + '」</span>' +
          '<span class="pv">顺便加进这一台</span></button>';
      }
      return '<div class="picker" style="margin:9px 0 0">' + rows + '</div>';
    }

    function advBlock() {
      return '<button class="adv-head' + (draft.adv ? ' on' : '') + '" id="advToggle" type="button">' +
        '<span>更多选项：台号 / 日期 / 备注 / 台费怎么收</span>' + icon('chev', 16) + '</button>' +
        '<div class="adv-body" id="advBody"' + (draft.adv ? '' : ' hidden') + '>' +
        '  <div class="field"><label>台号 / 桌号</label>' +
        '    <input class="input" id="tbNo" type="text" maxlength="12" placeholder="比如：1号台" value="' + esc(draft.tableNo) + '"></div>' +
        '  <div class="field"><label>日期</label>' +
        '    <input class="input" id="tbDate" type="date" value="' + esc(draft.date) + '"></div>' +
        '  <div class="field"><label>台费怎么收<span class="muted" style="font-weight:400"> — 默认「单独收」，不管它就行</span></label>' +
        '    <div class="chips" style="margin-bottom:9px">' +
        '      <button class="chip" type="button" data-mode="separate">单独收</button>' +
        '      <button class="chip" type="button" data-mode="netting">从借款里扣</button>' +
        '    </div>' +
        '    <p class="hint" id="modeHint"></p></div>' +
        '  <div class="field"><label>备注</label>' +
        '    <input class="input" id="tbNote" type="text" maxlength="40" placeholder="比如：老张那桌" value="' + esc(draft.note) + '"></div>' +
        '</div>';
    }

    function bodyHtml() {
      return '' +
        '<div class="field">' +
        '  <label>上桌人数<span class="muted" style="font-weight:400"> — 就这两种，固定 3 人或 4 人</span></label>' +
        '  <div class="chips" style="margin-bottom:0">' +
        HEAD_CHIPS.map(function (n) { return '<button class="chip chip-head" type="button" data-head="' + n + '">' + n + ' 人</button>'; }).join('') +
        '  </div>' +
        '</div>' +

        '<div class="field">' +
        '  <div class="fld-row"><label>每人台费</label>' +
        '    <input class="input num fld-in" id="tbPrice" type="text" inputmode="decimal" value="' + draft.unitPrice + '"></div>' +
        '  <div class="chips" style="margin-bottom:0">' +
        FEE_CHIPS.map(function (n) { return '<button class="chip" type="button" data-fee="' + n + '">' + n + ' 元</button>'; }).join('') +
        '  </div>' +
        '</div>' +

        '<div class="field">' +
        '  <div class="fld-row"><label>台费合计<span class="muted" style="font-weight:400"> — 自动算</span></label>' +
        '    <div class="money-mini"><span class="cur">¥</span>' +
        '    <input id="tbAmount" type="text" inputmode="decimal" placeholder="0" value="' + (draft.amount ? String(draft.amount) : '') + '"></div></div>' +
        '  <p class="hint" id="feePreview"></p>' +
        '</div>' +

        (editing
          ? '<div class="field"><label>牌面（借款在台面里记）</label><div class="glist" id="editPlayers"></div></div>'
          : '<div class="field">' +
          '  <label>上桌的人<span class="muted" style="font-weight:400" id="guestCount"></span></label>' +
          '  <input class="input" id="addName" type="text" maxlength="20" placeholder="打名字搜客户，点一下加上桌" value="' + esc(draft.kw) + '">' +
          '  <div id="candBox">' + candHtml() + '</div>' +
          '  <div id="recentBox">' + recentHtml() + '</div>' +
          '  <div id="guestBox">' + guestsHtml() + '</div>' +
          '  <p class="hint">每位默认借 ¥' + DEF_STAKE + '，能单独改；自带现金不用借的，把金额清空（记 0）就行。' +
          '一场就 3 人 / 4 人，人数满 4 人后再加的人（替手）只记借款，台费默认 0。</p>' +
          '</div>') +

        advBlock();
    }

    /** 台费合计 = 各人单独设的台费之和 + 没记名字的人按默认价补 */
    function calcAmount() {
      var sum = 0;
      draft.guests.forEach(function (g) { sum += Number(g.fee) || 0; });
      var rest = Math.max(0, (Number(draft.players) || 0) - draft.guests.length);
      sum += rest * (Number(draft.unitPrice) || 0);
      return R2(sum);
    }

    function feePreviewText() {
      if (draft.amountTouched) return '已手改，按 ¥' + money(draft.amount) + ' 记';
      if (draft.guests.length) {
        var rest = Math.max(0, (Number(draft.players) || 0) - draft.guests.length);
        var t = '按上桌的人算，台费合计 ¥' + money(draft.amount);
        if (rest > 0) t += '（另 ' + rest + ' 人按默认 ¥' + money(draft.unitPrice) + '）';
        return t;
      }
      return draft.players + ' 人 × ¥' + money(draft.unitPrice) + ' = ¥' + money(draft.amount);
    }

    /** 默认台费改了：没被单独改过、且占着上桌名额的人跟着走 */
    function syncGuestFees() {
      draft.guests.forEach(function (g) {
        if (!g.feeTouched && !g.offHead) g.fee = R2(draft.unitPrice);
      });
      var box = $('#guestBox', sheet);
      if (box) box.innerHTML = guestsHtml();
    }

    /** 只刷新派生显示，不重建 DOM（避免输一半丢焦点） */
    function refresh() {
      var b = $('#openBody', sheet);
      if (!b) return;
      draft.players = fixHead(draft.players);       // 兜底：人数只可能是 3 / 4
      b.querySelectorAll('[data-head]').forEach(function (x) {
        x.classList.toggle('on', Number(x.getAttribute('data-head')) === Number(draft.players));
      });
      b.querySelectorAll('[data-fee]').forEach(function (x) {
        x.classList.toggle('on', Number(x.getAttribute('data-fee')) === Number(draft.unitPrice));
      });
      b.querySelectorAll('[data-mode]').forEach(function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === draft.feeMode);
      });
      if (!draft.amountTouched) {
        draft.amount = calcAmount();
        var ai = $('#tbAmount', b);
        if (ai) ai.value = draft.amount ? String(draft.amount) : '';
      }
      var pv = $('#feePreview', b);
      if (pv) pv.textContent = feePreviewText();
      var mh = $('#modeHint', b);
      if (mh) {
        mh.textContent = draft.feeMode === 'netting'
          ? '借 ¥' + money(DEF_STAKE) + ' 的客人实拿 ¥' + money(R2(DEF_STAKE - draft.unitPrice)) + '（台费直接在借款里扣）'
          : '台费单独收，跟借款分开算，互不影响';
      }
      var gc = $('#guestCount', b);
      if (gc) gc.textContent = draft.guests.length ? ' · 已加 ' + draft.guests.length + ' 人' : '';
    }

    function renderGuests() {
      var box = $('#guestBox', sheet);
      if (box) box.innerHTML = guestsHtml();
      var rb = $('#recentBox', sheet);
      if (rb) rb.innerHTML = recentHtml();
      var cb = $('#candBox', sheet);
      if (cb) cb.innerHTML = candHtml();
      refresh();
    }

    function renderCand() {
      var cb = $('#candBox', sheet);
      if (cb) cb.innerHTML = candHtml();
    }

    /** 名单变了以后让「上桌人数」跟上（只认 3 / 4；手动选过就锁住不动） */
    function syncHeadcount() {
      if (draft.playersTouched || !draft.guests.length) return;
      draft.players = fixHead(draft.guests.length);
      draft.amountTouched = false;
    }

    function addGuest(customerId) {
      var c = Store.getCustomer(customerId);
      if (!c) return;
      if (draft.guests.some(function (g) { return g.customerId === customerId; })) return;
      if (!draft.playersTouched) draft.players = fixHead(draft.guests.length + 1);
      // 只有还占着「上桌人数」名额的这位，才默认收台费；
      // 人数已经满（4 人）之后再加的人（替手 / 看牌的），只记借款，台费默认 0，要收自己填
      var onTable = draft.guests.length < draft.players;
      draft.guests.push({
        customerId: customerId, name: c.name, stake: DEF_STAKE,
        fee: onTable ? R2(draft.unitPrice) : 0, feeTouched: false, offHead: !onTable
      });
      draft.amountTouched = false;
      draft.kw = '';
      var kwEl = $('#addName', sheet);
      if (kwEl) kwEl.value = '';
      renderGuests();
    }

    // 初始化
    $('#openBody', sheet).innerHTML = bodyHtml();
    refresh();
    if (editing) {
      var ep = $('#editPlayers', sheet);
      if (ep) {
        var ps = Store.sessionPlayers(editing.id);
        ep.innerHTML = ps.length ? ps.map(function (p) {
          return '<div class="grow"><span class="grow-name">' + esc(p.name) + '</span>' +
            '<span class="grow-sum">台费 ¥' + esc(money(p.fee)) + ' · 借 ¥' + esc(money(p.loanOut)) +
            (p.loanBack > 0 ? ' · 还 ¥' + esc(money(p.loanBack)) : '') + '</span></div>';
        }).join('') : '<p class="hint">这场还没记借款。</p>';
      }
    }

    /* 事件：点击 */
    sheet.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-addcust]'))) { addGuest(t.getAttribute('data-addcust')); return; }
      if ((t = e.target.closest('[data-newcust]'))) {
        var nm = (draft.kw || '').trim();
        if (!nm) return;
        var nc = Store.findCustomerByName(nm) || Store.addCustomer({ name: nm });
        if (nc) addGuest(nc.id);
        return;
      }
      if ((t = e.target.closest('[data-delguest]'))) {
        var id = t.getAttribute('data-delguest');
        draft.guests = draft.guests.filter(function (g) { return g.customerId !== id; });
        syncHeadcount();
        renderGuests(); return;
      }
      if ((t = e.target.closest('#advToggle'))) {
        draft.adv = !draft.adv;
        var ab = $('#advBody', sheet);
        if (ab) ab.hidden = !draft.adv;
        t.classList.toggle('on', draft.adv);
        return;
      }
      if ((t = e.target.closest('[data-head]'))) {
        draft.players = fixHead(t.getAttribute('data-head'));
        draft.playersTouched = true;                 // 手动选过，之后加人不再自动改
        draft.amountTouched = false;
        refresh(); return;
      }
      if ((t = e.target.closest('[data-fee]'))) {
        draft.unitPrice = Number(t.getAttribute('data-fee'));
        draft.amountTouched = false;
        var xi = $('#tbPrice', sheet); if (xi) xi.value = String(draft.unitPrice);
        syncGuestFees();
        refresh(); return;
      }
      if ((t = e.target.closest('[data-mode]'))) {
        draft.feeMode = t.getAttribute('data-mode');
        refresh(); return;
      }
    });

    /* 事件：输入 */
    sheet.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'tbPrice') {
        draft.unitPrice = parseFloat(String(t.value).replace(/[^\d.]/g, '')) || 0;
        draft.amountTouched = false;
        syncGuestFees(); refresh(); return;
      }
      if (t.id === 'tbAmount') {
        draft.amount = parseFloat(String(t.value).replace(/[^\d.]/g, '')) || 0;
        draft.amountTouched = true; refresh(); return;
      }
      if (t.id === 'addName') {
        draft.kw = t.value;
        renderCand(); return;
      }
      if (t.hasAttribute('data-gfee')) {
        var fid = t.getAttribute('data-gfee');
        var fv = parseFloat(String(t.value).replace(/[^\d.]/g, '')) || 0;
        draft.guests.forEach(function (g) {
          if (g.customerId === fid) { g.fee = R2(fv); g.feeTouched = true; }
        });
        refresh(); return;
      }
      if (t.hasAttribute('data-stake')) {
        var cid = t.getAttribute('data-stake');
        var v = parseFloat(String(t.value).replace(/[^\d.]/g, '')) || 0;
        draft.guests.forEach(function (g) { if (g.customerId === cid) g.stake = R2(v); });
        return;
      }
    });

    /* 搜索框回车：只有一个候选就直接加 */
    sheet.addEventListener('keydown', function (e) {
      if (e.target.id !== 'addName' || e.key !== 'Enter') return;
      e.preventDefault();
      var have = haveIds();
      var kw = (draft.kw || '').trim().toLowerCase();
      if (!kw) return;
      var list = Store.listCustomers().filter(function (c) {
        if (have[c.id]) return false;
        return c.name.toLowerCase().indexOf(kw) >= 0;
      });
      if (list.length === 1) { addGuest(list[0].id); return; }
      var nc = Store.findCustomerByName(draft.kw);
      if (nc) addGuest(nc.id);
    });

    /* 删除这一台 */
    var delBtn = $('#delTable', sheet);
    if (delBtn) delBtn.addEventListener('click', function () {
      confirmDlg({
        title: '删除这一台？',
        text: '这场记的台费收入、以及挂在客人账上的借款流水都会一并删掉，无法恢复。',
        okText: '删除', danger: true
      }).then(function (yes) {
        if (!yes) return;
        Store.deleteIncome(editing.id);
        closeSheet(); toast('已删除这一台', 'ok'); render();
      });
    });

    /* 保存 */
    $('#saveTable', sheet).addEventListener('click', function () {
      draft.tableNo = $('#tbNo', sheet).value.trim();
      draft.note = $('#tbNote', sheet).value.trim();
      draft.date = $('#tbDate', sheet).value || today(new Date());

      var players = Math.max(1, Number(draft.players) || 1);
      var unitPrice = R2(draft.unitPrice || 0);
      var amount = R2(draft.amount || 0);
      if (!(amount > 0)) amount = R2(players * unitPrice);
      if (!(amount > 0)) { toast('先填台费', 'err'); return; }

      if (editing) {
        Store.updateIncome(editing.id, {
          date: draft.date, players: players, unitPrice: unitPrice,
          amount: amount, note: draft.note, tableNo: draft.tableNo, feeMode: draft.feeMode
        });
        closeSheet(); toast('已更新', 'ok'); render();
        return;
      }

      var members = draft.guests.map(function (g) { return { customerId: g.customerId, stake: g.stake, fee: g.fee }; });
      var s = Store.openSession({
        date: draft.date, players: players, unitPrice: unitPrice, amount: amount,
        feeMode: draft.feeMode, tableNo: draft.tableNo, note: draft.note, members: members
      });
      var nb = members.filter(function (m) { return m.stake > 0; }).length;
      toast('已开台：' + players + ' 人 · 台费 ¥' + money(amount) + (nb ? ' · ' + nb + ' 人借款' : ''), 'ok');
      if (s) openSessionSheet(s.id); else { closeSheet(); render(); }
    });
  }

  /* ---------- 台面：看这一场、局中借还、收台 ---------- */

  function openSessionSheet(id) {
    var s = Store.getSession(id);
    if (!s) return;
    // 关掉台面后退回牌局页要刷新，不然「正在打的台」还是旧数据
    var sheet = openSheet(
      sheetHead('台面') + '<div class="sheet-body" id="ssBody"></div>',
      function () { render(); }
    );

    function timelineHtml() {
      var list = Store.sessionTxs(s.id);
      if (!list.length) return '<p class="hint">这场还没有资金往来。</p>';
      return '<div class="tline">' + list.map(function (t) {
        var isOwe = t.type === 'owe';
        var label = t.category === 'loan' ? (isOwe ? '借出' : '还钱')
          : (t.category === 'cig' ? '代买烟' : (isOwe ? '挂台费' : '还台费'));
        return '<div class="tl-row">' +
          '<span class="tl-time num">' + (hmTime(t.createdAt) || '--:--') + '</span>' +
          '<span class="tl-dot ' + (isOwe ? 'owe' : 'paid') + '"></span>' +
          '<span class="tl-main"><b>' + esc(t.name) + '</b> ' + label +
          ' <i class="' + (isOwe ? 'owe' : 'paid') + '">' + (isOwe ? '+' : '−') + '¥' + esc(money(t.amount)) + '</i>' +
          (t.note ? '<span class="tl-note">' + esc(t.note) + '</span>' : '') +
          '</span></div>';
      }).join('') + '</div>';
    }

    function renderBody() {
      s = Store.getSession(id);
      var ss = Store.sessionSummary(s);
      var ps = Store.sessionPlayers(s.id);
      var isOpen = s.status === 'open';

      var html =
        '<div class="tbl-head">' +
        '  <div class="tbl-title">' + esc(tableName(s)) + (s.tableNo && s.note ? ' · ' + esc(s.note) : '') +
        '    <span class="pill ' + (isOpen ? 'live' : 'done') + '">' + (isOpen ? '开台中' : '已收台') + '</span></div>' +
        '  <div class="tbl-sub">' + humanDate(s.date) + ' ' + (hmTime(s.openAt) || '') + ' 开台 · ' +
        s.players + ' 人 · 每人台费 ¥' + esc(money(s.unitPrice)) + '</div>' +
        '</div>' +

        '<div class="money-grid">' +
        '  <div class="mg-cell"><span class="k">台费收入</span><b class="num inc">¥' + esc(money(ss.fee)) + '</b></div>' +
        '  <div class="mg-cell"><span class="k">借出去</span><b class="num owe">¥' + esc(money(ss.loanOut)) + '</b></div>' +
        '  <div class="mg-cell"><span class="k">已收回</span><b class="num paid">¥' + esc(money(ss.loanBack)) + '</b></div>' +
        '  <div class="mg-cell"><span class="k">牌面还欠</span><b class="num">¥' + esc(money(ss.netLoan)) + '</b></div>' +
        '</div>' +
        '<p class="hint" style="margin:-2px 0 12px">' +
        (ss.feeMode === 'netting'
          ? '台费从借款里扣：每位借款人实拿 ¥' + esc(money(Store.util.round2(s.unitPrice > 0 ? DEF_STAKE - s.unitPrice : 0))) + '（示意）'
          : '台费单独收' + (ss.creditFee > 0 ? '，其中 ¥' + esc(money(ss.creditFee)) + ' 还挂着账' : '')) +
        '</p>' +

        '<div class="field"><label>牌面</label><div id="plBox">' + playersHtml(ps, isOpen) + '</div></div>' +

        '<div class="field"><label>本场动态</label>' + timelineHtml() + '</div>';

      $('#ssBody', sheet).innerHTML = html;

      $('#ssFoot', sheet) && ($('#ssFoot', sheet).innerHTML = footHtml(isOpen));
      bindFoot(isOpen);
    }

    function playersHtml(ps, isOpen) {
      if (!ps.length) return '<p class="hint">这场还没记人。</p>';
      return '<div class="plist">' + ps.map(function (p) {
        var state, cls;
        if (p.net > 0.004) { cls = 'owe'; state = '欠 ¥' + money(p.net); }
        else if (p.net < -0.004) { cls = 'paid'; state = '多还 ¥' + money(-p.net); }
        else { cls = 'zero'; state = '已清'; }
        var sub = [];
        if (p.fee > 0) sub.push('台费 ¥' + money(p.fee));
        if (p.loanOut > 0) sub.push('借 ¥' + money(p.loanOut));
        if (p.loanBack > 0) sub.push('还 ¥' + money(p.loanBack));
        if (p.credit > 0) sub.push('挂账 ¥' + money(p.credit));
        return '<div class="prow">' +
          '<span class="prow-main">' +
          '<span class="prow-name">' + esc(p.name) + '</span>' +
          '<span class="prow-sub">' + (sub.join(' · ') || '还没有往来') + '</span>' +
          '</span>' +
          '<span class="prow-amt num ' + cls + '">' + esc(state) + '</span>' +
          (isOpen
            ? '<span class="prow-act">' +
            '<button class="mini" type="button" data-loan="' + p.customerId + '">借</button>' +
            '<button class="mini ghost" type="button" data-repay="' + p.customerId + '">还</button>' +
            '</span>'
            : '') +
          '</div>';
      }).join('') + '</div>';
    }

    function footHtml(isOpen) {
      if (isOpen) {
        return '<button class="btn btn-ghost" id="editTable" type="button">改台面</button>' +
          '<button class="btn btn-primary" id="closeTable" type="button">收台结算</button>';
      }
      return '<button class="btn btn-ghost" id="reopenTable" type="button">重新开台</button>' +
        '<button class="btn btn-ghost" id="feeTable" type="button">台费</button>' +
        '<button class="btn btn-primary" id="editTable2" type="button">改台面</button>';
    }

    function bindFoot(isOpen) {
      var f = $('#ssFoot', sheet);
      if (!f) return;
      var cb = $('#closeTable', f);
      if (cb) cb.addEventListener('click', function () { openCloseSheet(id); });
      var eb = $('#editTable', f) || $('#editTable2', f);
      if (eb) eb.addEventListener('click', function () { openOpenSheet({ tableId: id }); });
      var rb = $('#reopenTable', f);
      if (rb) rb.addEventListener('click', function () {
        Store.reopenSession(id);
        toast('已重新开台', 'ok');
        renderBody();
      });
      var fb = $('#feeTable', f);
      if (fb) fb.addEventListener('click', function () { openCloseSheet(id); });
    }

    // 底部按钮区容器（放进 sheet-body 之后）
    var foot = document.createElement('div');
    foot.className = 'sheet-foot';
    foot.id = 'ssFoot';
    sheet.appendChild(foot);

    sheet.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-loan]'))) {
        openLoanSheet({ sessionId: id, customerId: t.getAttribute('data-loan'), type: 'owe', onDone: renderBody });
        return;
      }
      if ((t = e.target.closest('[data-repay]'))) {
        openLoanSheet({ sessionId: id, customerId: t.getAttribute('data-repay'), type: 'paid', onDone: renderBody });
        return;
      }
    });

    renderBody();
  }

  /* ---------- 记一笔借 / 还（浮层，不顶掉台面） ---------- */

  function openLoanSheet(opts) {
    var s = Store.getSession(opts.sessionId);
    var c = Store.getCustomer(opts.customerId);
    if (!s || !c) return;
    var isPay = opts.type === 'paid';
    var R2 = Store.util.round2;
    var mine = null;
    Store.sessionPlayers(s.id).forEach(function (p) { if (p.customerId === c.id) mine = p; });
    var owed = mine && mine.net > 0 ? mine.net : 0;

    var root = $('#dialog-root');
    root.innerHTML =
      '<div class="dlg-mask">' +
      '  <div class="dlg" role="dialog" aria-modal="true">' +
      '    <h3>' + esc((isPay ? '收 ' : '借给 ') + c.name) + '</h3>' +
      '    <p>' + esc(tableName(s)) + ' · ' +
      (isPay
        ? (owed > 0 ? '他现在这场欠 ¥' + money(owed) : '他这场已经不欠了')
        : '开台已借 ¥' + money(mine ? mine.loanOut : 0)) +
      '</p>' +
      '    <div class="chips">' +
      LOAN_CHIPS.map(function (n) { return '<button class="chip" type="button" data-qamt="' + n + '">' + n + '</button>'; }).join('') +
      (isPay && owed > 0 ? '<button class="chip" type="button" data-qamt="' + R2(owed) + '">全还 ¥' + esc(money(owed)) + '</button>' : '') +
      '    </div>' +
      '    <div class="amount-row"><span class="cur">¥</span>' +
      '      <input id="loanAmt" type="text" inputmode="decimal" placeholder="0"></div>' +
      '    <input class="input" id="loanNote" type="text" maxlength="30" placeholder="' +
      (isPay ? '备注（可选）：赢了先还一部分' : '备注（可选）：输光了再借') + '">' +
      '    <div class="btn-row" style="margin-top:16px">' +
      '      <button class="btn btn-ghost" data-loan-cancel type="button">取消</button>' +
      '      <button class="btn ' + (isPay ? 'btn-paid' : 'btn-primary') + '" data-loan-yes type="button">' +
      (isPay ? '确认收款' : '确认借出') + '</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var mask = $('.dlg-mask', root);
    requestAnimationFrame(function () { requestAnimationFrame(function () { mask.classList.add('show'); }); });

    function close() {
      mask.classList.remove('show');
      setTimeout(function () { root.innerHTML = ''; }, 220);
    }

    var amtEl = $('#loanAmt', root);
    amtEl.addEventListener('input', function () {
      var v = String(amtEl.value).replace(/[^\d.]/g, '');
      var i = v.indexOf('.');
      if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
      if (v !== amtEl.value) amtEl.value = v;
    });
    root.querySelectorAll('[data-qamt]').forEach(function (b) {
      b.addEventListener('click', function () { amtEl.value = b.getAttribute('data-qamt'); });
    });
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    $('[data-loan-cancel]', root).addEventListener('click', close);

    $('[data-loan-yes]', root).addEventListener('click', function () {
      var v = R2(parseFloat(String(amtEl.value).replace(/[^\d.]/g, '')) || 0);
      if (!(v > 0)) { toast('先填个金额', 'err'); amtEl.focus(); return; }
      Store.addSessionTx(s.id, {
        customerId: c.id, type: isPay ? 'paid' : 'owe',
        amount: v, note: $('#loanNote', root).value.trim()
      });
      close();
      toast((isPay ? '收到 ' : '借给 ') + c.name + ' ¥' + money(v), 'ok');
      setTimeout(function () { if (opts.onDone) opts.onDone(); else render(); }, 60);
    });

    setTimeout(function () { amtEl.focus(); }, 260);
  }

  /* ---------- 收台结算 ---------- */

  function openCloseSheet(id) {
    var s0 = Store.getSession(id);
    if (!s0) return;
    var wasClosed = s0.status === 'closed';

    function bodyHtml() {
      var s = Store.getSession(id) || s0;
      var ss = Store.sessionSummary(s);
      var ps = Store.sessionPlayers(s.id);

      var cards = ps.map(function (p) {
        var cls = p.net > 0.004 ? 'owe' : (p.net < -0.004 ? 'paid' : 'zero');
        var txt = p.net > 0.004 ? '欠 ¥' + money(p.net) : (p.net < -0.004 ? '多还 ¥' + money(-p.net) : '已清');
        var sub = [];
        if (p.loanOut > 0) sub.push('借 ¥' + money(p.loanOut));
        if (p.loanBack > 0) sub.push('还 ¥' + money(p.loanBack));
        if (p.credit - p.cig > 0.004) sub.push('挂账 ¥' + money(p.credit - p.cig));
        if (p.cig > 0.004) sub.push('烟钱 ¥' + money(p.cig));

        var chip;
        if (p.fee > 0) {
          var st = Store.feeStateOf(s.id, p.customerId);
          var face = '台费 ¥' + esc(money(p.fee)) + ' · ';
          if (st === 'deduct') {
            chip = '<span class="pfee on" title="开台时已从借款里扣掉">' + face + '从借款扣</span>';
          } else if (st === 'credit') {
            chip = '<button class="pfee credit" type="button" data-feefix="' + p.customerId + '">' + face + '挂账</button>';
          } else {
            chip = '<button class="pfee ok" type="button" data-feefix="' + p.customerId + '">' + face + '已收</button>';
          }
        } else {
          chip = '<span class="pfee off">不用台费</span>';
        }

        return '<div class="fcard">' +
          '<div class="fcard-top">' +
          '<span class="prow-main"><span class="prow-name">' + esc(p.name) + '</span>' +
          '<span class="prow-sub">' + esc(sub.join(' · ') || '还没有往来') + '</span></span>' +
          '<span class="prow-amt num ' + cls + '">' + esc(txt) + '</span>' +
          '</div>' +
          '<div class="fcard-acts">' + chip + '<span class="fcard-sp"></span>' +
          (p.net > 0.004 ? '<button class="mini" type="button" data-settlepay="' + p.customerId + '">收款</button>' : '') +
          '</div>' +
          '</div>';
      }).join('');

      return '<div class="settle">' +
        '  <div class="st-row"><span>台费收入（营业额）</span><b class="num inc">¥' + esc(money(ss.fee)) + '</b></div>' +
        '  <div class="st-row st-sub"><span>台费已收到</span><b class="num paid">¥' + esc(money(ss.feePaid)) + '</b></div>' +
        (ss.cashFee > 0 ? '  <div class="st-row st-sub2"><span>其中收的现金</span><b class="num">¥' + esc(money(ss.cashFee)) + '</b></div>' : '') +
        (ss.deductFee > 0 ? '  <div class="st-row st-sub2"><span>其中从借款里扣</span><b class="num">¥' + esc(money(ss.deductFee)) + '</b></div>' : '') +
        (ss.creditFee > 0 ? '  <div class="st-row st-sub"><span>还没收到</span><b class="num owe">¥' + esc(money(ss.creditFee)) + '</b></div>' : '') +
        '  <div class="st-div"></div>' +
        '  <div class="st-row"><span>借出去</span><b class="num owe">¥' + esc(money(ss.loanOut)) + '</b></div>' +
        '  <div class="st-row"><span>已收回</span><b class="num paid">¥' + esc(money(ss.loanBack)) + '</b></div>' +
        '  <div class="st-row st-strong"><span>牌面还欠</span><b class="num">¥' + esc(money(ss.netLoan)) + '</b></div>' +
        '</div>' +

        '<div class="field"><label>台费收没收到</label>' +
        (ps.length ? '<div class="flist">' + cards + '</div>' : '<p class="hint">这场还没记人。</p>') +
        '</div>' +

        '<p class="hint">' +
        (ss.feeMode === 'netting'
          ? '这场开台时选了「从借款里扣」，台费已随借款扣下，不用再逐人标。'
          : '「已收」＝这人的台费收到了；点一下变「挂账」，就记到他账上。') +
        '<br>没收上来的钱继续挂在各自账上，之后在客户页或台面里随时能收。</p>';
    }

    function paint() {
      var sheet = $('#sheet-root .sheet');
      if (sheet) $('#csBody', sheet).innerHTML = bodyHtml();
    }

    openSheet(
      sheetHead((wasClosed ? '这场结算 · ' : '收台结算 · ') + esc(tableName(s0))) +
      '<div class="sheet-body" id="csBody"></div>' +
      '<div class="sheet-foot">' +
      '  <button class="btn btn-primary" id="confirmClose" type="button">' + (wasClosed ? '完成' : '确认收台') + '</button>' +
      '</div>',
      function () { render(); }
    );
    paint();

    var sheet = $('#sheet-root .sheet');
    sheet.addEventListener('click', function (e) {
      var fix = e.target.closest('[data-feefix]');
      if (fix) {
        var cid = fix.getAttribute('data-feefix');
        var now = Store.feeStateOf(id, cid);
        var on = now !== 'credit';
        Store.setFeeCredit(id, cid, on);
        toast(on ? '这台费先记他账上' : '这台费算收到了', on ? 'warn' : 'ok');
        paint();
        return;
      }
      var t = e.target.closest('[data-settlepay]');
      if (!t) return;
      openLoanSheet({
        sessionId: id, customerId: t.getAttribute('data-settlepay'), type: 'paid',
        onDone: function () { openCloseSheet(id); }
      });
    });

    $('#confirmClose', sheet).addEventListener('click', function () {
      if (!wasClosed) Store.closeSession(id);
      closeSheet();
      toast(wasClosed ? '已保存' : '已收台', 'ok');
      render();
    });
  }

  /* ================= 页面：流水 ================= */

  function renderTxs() {
    var now = new Date();
    var monthFrom = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-01';
    var ms = Store.rangeStats(monthFrom, null);

    var typeFilters = [
      { id: 'all', label: '全部' },
      { id: 'owe', label: '记欠款' },
      { id: 'paid', label: '收回' }
    ];
    var catFilters = [
      { id: 'all', label: '不限分类' },
      { id: 'fee', label: '台费' },
      { id: 'cig', label: '烟钱' },
      { id: 'other', label: '其他' }
    ];

    var list = Store.listTxs({
      type: state.txFilter === 'all' ? null : state.txFilter,
      category: state.txCat === 'all' ? null : state.txCat,
      keyword: state.txKeyword || null
    });

    var html =
      pageTitle('全部流水', null, false, null,
        '<div class="search" style="margin:0 0 0">' + icon('search', 19) +
        '<input id="txSearch" type="search" placeholder="搜客户 / 备注" value="' + esc(state.txKeyword) + '"></div>') +

      '<div class="chips" style="margin:0 16px 8px">' + typeFilters.map(function (f) {
        return '<button class="chip' + (state.txFilter === f.id ? ' on' : '') + '" data-txf="' + f.id + '" type="button">' + f.label + '</button>';
      }).join('') + '</div>' +

      '<div class="chips" style="margin:0 16px 8px">' + catFilters.map(function (f) {
        return '<button class="chip' + (state.txCat === f.id ? ' on' : '') + '" data-txc="' + f.id + '" type="button">' + f.label + '</button>';
      }).join('') + '</div>' +

      '<div class="chips" style="margin:0 16px 12px">' +
      '<span class="muted num">本月：记欠 <b class="owe">+' + esc(money(ms.owe)) + '</b> · 收回 <b class="paid">−' + esc(money(ms.paid)) + '</b>' +
      (ms.cigOwe > 0 ? ' · 其中烟钱 <b class="owe">' + esc(money(ms.cigOwe)) + '</b>' : '') + '</span>' +
      '</div>' +

      '<div class="section"><div class="card">';

    if (!list.length) {
      html += '<div class="empty"><div class="big">📄</div><h3>暂无记录</h3><p>点右下角 <b>＋</b> 记一笔</p></div>';
    } else {
      html += txHtml(list, { showName: true });
    }
    html += '</div></div>';
    view.innerHTML = html;

    var search = $('#txSearch');
    if (search) {
      search.addEventListener('input', function () {
        state.txKeyword = search.value;
        var pos = search.selectionStart;
        renderTxs();
        var s2 = $('#txSearch');
        s2.focus();
        try { s2.setSelectionRange(pos, pos); } catch (e) { }
      });
    }
    view.querySelectorAll('[data-txf]').forEach(function (b) {
      b.addEventListener('click', function () { state.txFilter = b.getAttribute('data-txf'); renderTxs(); });
    });
    view.querySelectorAll('[data-txc]').forEach(function (b) {
      b.addEventListener('click', function () { state.txCat = b.getAttribute('data-txc'); renderTxs(); });
    });
    view.querySelectorAll('[data-tx]').forEach(function (b) {
      b.addEventListener('click', function () { openTxSheet({ txId: b.getAttribute('data-tx') }); });
    });
  }

  /* ================= 页面：统计 ================= */

  function renderStats() {
    var ov = Store.overview();
    var todayStr = today(new Date());
    var now = new Date();
    var monthFrom = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-01';
    var ms = Store.rangeStats(monthFrom, null);
    var incToday = Store.incomeStats(todayStr, todayStr);
    var incMonth = Store.incomeStats(monthFrom, null);
    var incAll = Store.incomeStats(null, null);
    var monthly = Store.incomeMonthly(6);
    var tops = Store.topDebtors(5);
    var maxV = 1;
    monthly.forEach(function (b) { maxV = Math.max(maxV, b.total); });

    var html =
      pageTitle('统计', '营收 + 应收，一眼看清') +

      '<div class="stat-grid">' +
      '  <div class="stat-cell"><div class="k">本月营业额</div><div class="v num paid">¥' + esc(money(incMonth.total)) + '</div></div>' +
      '  <div class="stat-cell"><div class="k">本月收现</div><div class="v num paid">¥' + esc(money(incMonth.cash)) + '</div></div>' +
      '  <div class="stat-cell"><div class="k">本月挂账</div><div class="v num owe">¥' + esc(money(Store.util.round2(incMonth.creditFee + incMonth.creditCig))) + '</div></div>' +
      '  <div class="stat-cell"><div class="k">当前应收总额</div><div class="v num owe">¥' + esc(money(ov.receivable)) + '</div></div>' +
      '</div>' +

      '<div class="section"><div class="section-head"><h2>营收情况</h2><span class="muted num">累计 ' + incAll.games + ' 场</span></div>' +
      '  <div class="card"><div class="stat-row">' +
      '    <div><span class="k">本月场次</span><b class="num">' + incMonth.games + ' 场</b></div>' +
      '    <div><span class="k">场均收入</span><b class="num">¥' + esc(money(incMonth.avg)) + '</b></div>' +
      '    <div><span class="k">本月人均</span><b class="num">¥' + esc(money(incMonth.perHead)) + '</b></div>' +
      '  </div></div></div>' +

      '<div class="section"><div class="section-head"><h2>挂账情况</h2><span class="muted">当场没收到、记在客户账上的部分</span></div>' +
      '  <div class="card"><div class="stat-row">' +
      '    <div><span class="k">本月挂账台费</span><b class="num owe">¥' + esc(money(incMonth.creditFee)) + '</b></div>' +
      '    <div><span class="k">本月挂账烟钱</span><b class="num owe">¥' + esc(money(incMonth.creditCig)) + '</b></div>' +
      '    <div><span class="k">涉及场次</span><b class="num">' + Store.creditIncomeCount(monthFrom, null) + ' 场</b></div>' +
      '  </div></div></div>' +

      '<div class="section"><div class="section-head"><h2>借贷情况</h2><span class="muted">开台借出去、又收回来的钱</span></div>' +
      '  <div class="card"><div class="stat-row">' +
      '    <div><span class="k">本月借出</span><b class="num owe">¥' + esc(money(ov.monthLoan.out)) + '</b></div>' +
      '    <div><span class="k">本月收回</span><b class="num paid">¥' + esc(money(ov.monthLoan.back)) + '</b></div>' +
      '    <div><span class="k">净借出</span><b class="num">¥' + esc(money(ov.monthLoan.net)) + '</b></div>' +
      '  </div></div></div>' +

      '<div class="section"><div class="section-head"><h2>近 6 个月营收</h2>' +
      '<span class="muted">本月 ¥' + esc(money(incMonth.total)) + '</span></div>' +
      '  <div class="card"><div class="bars">' +
      monthly.map(function (b) {
        var h = Math.max(3, Math.round(b.total / maxV * 92));
        return '<div class="bar-col"><div class="bar-stack">' +
          '<div class="bar inc" style="height:' + h + 'px" title="' + b.label + ' ¥' + esc(money(b.total)) + '"></div>' +
          '</div><span class="bar-cap">' + b.label + '</span></div>';
      }).join('') +
      '  </div></div></div>' +

      '<div class="section"><div class="section-head"><h2>本月往来</h2><span class="muted num">' + ms.count + ' 笔</span></div>' +
      '  <div class="card"><div class="stat-row">' +
      '    <div><span class="k">记欠</span><b class="num owe">+¥' + esc(money(ms.owe)) + '</b></div>' +
      '    <div><span class="k">其中烟钱</span><b class="num owe">¥' + esc(money(ms.cigOwe)) + '</b></div>' +
      '    <div><span class="k">收回</span><b class="num paid">−¥' + esc(money(ms.paid)) + '</b></div>' +
      '  </div></div></div>' +

      '<div class="section"><div class="section-head"><h2>欠款排行 TOP' + Math.min(5, Math.max(tops.length, 1)) + '</h2></div>' +
      '  <div class="card">' +
      (tops.length ? tops.map(function (r, i) {
        return '<div class="rank">' +
          '<span class="idx' + (i === 0 ? ' top' : '') + ' num">' + (i + 1) + '</span>' +
          '<span class="nm">' + esc(r.customer.name) + '</span>' +
          '<span class="vl num owe">¥' + esc(money(r.balance)) + '</span>' +
          '</div>';
      }).join('') : '<div class="empty" style="padding:26px"><p>暂时没有人欠钱，舒服！</p></div>') +
      '  </div></div>';

    view.innerHTML = html;
  }

  /* ================= 页面：我的（设置） ================= */

  function renderMe() {
    var cigN = Store.listCigs().length;

    var html =
      pageTitle('我的', null) +

      '<div class="section"><div class="section-head"><h2>安全</h2></div><div class="card">' +
      '  <button class="list-item" id="changePin" type="button"><span class="li-ico">' + icon('lock', 21) + '</span>' +
      '    <span class="li-txt">修改密码<span class="li-desc">已强制开启，打开应用必须输密码</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '  <button class="list-item" id="lockNow" type="button"><span class="li-ico">' + icon('moon', 21) + '</span>' +
      '    <span class="li-txt">立即锁定<span class="li-desc">马上锁屏，再打开就要重新输密码</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>快捷设置</h2></div><div class="card">' +
      '  <button class="list-item" id="manageCigs" type="button"><span class="li-ico">' + icon('cig', 21) + '</span>' +
      '    <span class="li-txt">烟品价目<span class="li-desc">记烟钱时一键带出金额，当前 ' + cigN + ' 种</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>备份与导出</h2></div><div class="card">' +
      '  <button class="list-item" id="expJson" type="button"><span class="li-ico">' + icon('down', 21) + '</span>' +
      '    <span class="li-txt">导出备份文件<span class="li-desc">json 格式，换手机 / 保险存档用</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '  <button class="list-item" id="impJson" type="button"><span class="li-ico">' + icon('up', 21) + '</span>' +
      '    <span class="li-txt">导入备份<span class="li-desc">选择之前导出的 json 文件恢复</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '  <button class="list-item" id="expCsv" type="button"><span class="li-ico">' + icon('doc', 21) + '</span>' +
        '    <span class="li-txt">导出 Excel 表格<span class="li-desc">往来流水 + 余额汇总 + 营收明细</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '</div></div>' +

      cloudSectionHtml() +

      '<div class="section"><div class="section-head"><h2>客户名单</h2></div><div class="card">' +
      '  <button class="list-item" id="addOneCust" type="button"><span class="li-ico">' + icon('smile', 21) + '</span>' +
      '    <span class="li-txt">新增客户<span class="li-desc">单独录一位客人，不记账也能先建好档案</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '  <button class="list-item" id="impNames" type="button"><span class="li-ico">' + icon('usersAdd', 21) + '</span>' +
      '    <span class="li-txt">批量导入客户<span class="li-desc">粘贴名单，一行一个：姓名,电话,备注</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>危险操作</h2></div><div class="card">' +
      '  <button class="list-item danger" id="clearAll" type="button"><span class="li-ico">' + icon('broom', 21) + '</span>' +
      '    <span class="li-txt">清空全部数据</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>关于</h2></div><div class="card">' +
      '  <div class="list-item" style="cursor:default"><span class="li-ico">' + icon('info', 21) + '</span>' +
      '    <span class="li-txt">往来账 v' + VERSION + '<span class="li-desc">账目平时存在本机，同时自动备份到你自己服务器（见上方「云端备份」）。换手机用同一个密码登录即可。</span></span></div>' +
      '</div></div>';

    view.innerHTML = html;

    mountCloud();

    /* --- 密码锁（强制开启，不提供关闭入口） --- */
    var changePinBtn = $('#changePin');
    if (changePinBtn) changePinBtn.addEventListener('click', function () {
      Lock.openSetup({ mode: 'change', onDone: function (msg) { toast(msg, 'ok'); render(); } });
    });
    var lockNowBtn = $('#lockNow');
    if (lockNowBtn) lockNowBtn.addEventListener('click', function () {
      Lock.lockNow();
      document.body.classList.add('locked');
      Lock.showLockScreen(function () {});
    });

    $('#manageCigs').addEventListener('click', openCigsSheet);
    $('#expJson').addEventListener('click', function () {
      downloadFile(stampName('json'), Store.exportJSON(), 'application/json');
      toast('备份文件已开始下载', 'ok');
    });
    $('#expCsv').addEventListener('click', function () {
      if (!Store.data.txs.length && !Store.data.incomes.length) { toast('还没有数据可导出'); return; }
      downloadFile(stampName('csv'), Store.exportCSV(), 'text/csv');
      toast('Excel 表格已开始下载', 'ok');
    });
    $('#impJson').addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          confirmDlg({
            title: '选择导入方式',
            html: '覆盖导入：清空现有数据，完全用备份文件替换。<br>合并导入：保留现有数据，把备份里没有的加进来。',
            okText: '合并导入', cancelText: '覆盖导入'
          }).then(function (merge) {
            if (!merge) {
              confirmDlg({
                title: '⚠️ 将覆盖现有数据',
                text: '当前所有客户、流水和营收会被备份文件替换，且无法撤销。确定继续吗？',
                okText: '覆盖', danger: true
              }).then(function (go2) { if (go2) doImport(String(reader.result), 'replace'); });
            } else {
              doImport(String(reader.result), 'merge');
            }
          });
        };
        reader.readAsText(f, 'utf-8');
      };
      input.click();
    });

    function doImport(text, mode) {
      try {
        var r = Store.importJSON(text, mode);
        toast('导入成功：' + r.customers + ' 位客户 / ' + r.txs + ' 笔流水 / ' + r.incomes + ' 场营收', 'ok', 2400);
        render();
      } catch (e) {
        toast('导入失败：' + e.message, 'err', 2600);
      }
    }

    $('#impNames').addEventListener('click', openNamesSheet);
    $('#addOneCust').addEventListener('click', function () { openCustomerSheet(null); });
    $('#clearAll').addEventListener('click', function () {
      var cloudOn = !!(global.Cloud && Cloud.enabled() && Cloud.loggedIn() && Cloud.available() !== false);
      confirmDlg({
        title: '清空全部数据？',
        text: '所有客户、流水、营收都会被删除且无法恢复。建议先「导出备份」。' +
          (cloudOn ? '（云端备份也会一并清空，但云端的历史版本仍然留着，能翻回来）' : ''),
        okText: '清空', danger: true
      }).then(function (yes) {
        if (!yes) return;
        confirmDlg({ title: '再确认一次', text: '真的要清空吗？此操作不可恢复。', okText: '彻底清空', danger: true })
          .then(function (yes2) {
            if (!yes2) return;
            Store.clearAll();
            toast('已清空', 'ok');
            render();
          });
      });
    });
  }

  /** 烟品价目管理 */
  function openCigsSheet() {
    var list = Store.listCigs();

    function rowHtml(cg) {
      return '<div class="crow" data-row>' +
        '<input class="input crow-name" data-id="' + (cg ? cg.id : 'new') + '" placeholder="烟名，如 利群" value="' + esc(cg ? cg.name : '') + '">' +
        '<input class="input crow-price num" type="text" inputmode="decimal" placeholder="单价" value="' + (cg ? cg.price : '') + '">' +
        '<button class="icon-btn crow-del" type="button" aria-label="删除">' + icon('trash', 18) + '</button>' +
        '</div>';
    }

    var sheet = openSheet(
      sheetHead('烟品价目') +
      '<div class="sheet-body">' +
      '  <p class="hint" style="margin:0 0 10px">记「烟钱」时点一下就能带出金额。改成你店里常卖的名字和价钱即可。</p>' +
      '  <div id="cigRows">' + list.map(rowHtml).join('') + '</div>' +
      '  <button class="chip" id="addCigRow" type="button" style="margin-top:10px">' + icon('plus', 14) + ' 加一种烟</button>' +
      '</div>' +
      '<div class="sheet-foot"><button class="btn btn-primary" id="saveCigs" type="button">保存' +
      '</button></div>'
    );

    var rows = $('#cigRows', sheet);

    function bindRow(row) {
      $('.crow-del', row).addEventListener('click', function () { row.remove(); });
      var p = $('.crow-price', row);
      p.addEventListener('input', function () {
        var v = p.value.replace(/[^\d.]/g, '');
        var i = v.indexOf('.');
        if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
        if (v !== p.value) p.value = v;
      });
    }
    rows.querySelectorAll('[data-row]').forEach(bindRow);

    $('#addCigRow', sheet).addEventListener('click', function () {
      var div = document.createElement('div');
      div.innerHTML = rowHtml(null);
      var row = div.firstChild;
      rows.appendChild(row);
      bindRow(row);
      $('.crow-name', row).focus();
    });

    $('#saveCigs', sheet).addEventListener('click', function () {
      var out = [];
      rows.querySelectorAll('[data-row]').forEach(function (row) {
        var name = $('.crow-name', row).value.trim();
        var price = Store.util.round2(parseFloat($('.crow-price', row).value) || 0);
        if (name && price > 0) out.push({ id: $('.crow-name', row).getAttribute('data-id') || Store.util.uid('cg'), name: name, price: price });
      });
      out.forEach(function (c) { if (c.id === 'new') c.id = Store.util.uid('cg'); });
      Store.data.settings.cigs = out;
      Store.save();
      closeSheet();
      toast('烟品已保存（' + out.length + ' 种）', 'ok');
      render();
    });
  }

  function openNamesSheet() {
    var sheet = openSheet(
      sheetHead('批量导入客户') +
      '<div class="sheet-body">' +
      '  <div class="field"><label>客户名单（一行一位）</label>' +
      '  <textarea class="input" id="namesTxt" rows="7" placeholder="张三,13800001111,常客&#10;李四,13900002222,&#10;王老五"></textarea>' +
      '  <p class="hint">格式：姓名,电话,备注（后两项可省略）。已存在的姓名会自动跳过。</p></div>' +
      '</div>' +
      '<div class="sheet-foot"><button class="btn btn-primary" id="namesGo" type="button">导入</button></div>'
    );
    $('#namesGo', sheet).addEventListener('click', function () {
      var txt = $('#namesTxt', sheet).value;
      var r = Store.importCustomersText(txt);
      if (!r.added && !r.skipped) { toast('没有识别到客户，请检查格式'); return; }
      closeSheet();
      toast('已导入 ' + r.added + ' 位' + (r.skipped ? '，跳过 ' + r.skipped + ' 位（重名/为空）' : ''), 'ok', 2400);
      render();
    });
  }

  /* ================= 记一笔（客户往来） ================= */

  var AMOUNT_CHIPS = [10, 20, 50, 100, 200, 500];
  var NOTE_CHIPS = {
    fee: ['台费', '茶水', '夜场', '借现金', '餐费'],
    cig: null,   // 用烟品价目
    other: ['借现金', '餐费', '杂项']
  };
  var CATS = [
    { id: 'fee', label: '台费茶水' },
    { id: 'cig', label: '代买烟' },
    { id: 'other', label: '其他' }
  ];

  /** opts: {txId} 编辑 | {customerId, type} 新建 */
  function openTxSheet(opts) {
    var editing = opts.txId ? Store.getTx(opts.txId) : null;
    var preCust = opts.customerId || (editing && editing.customerId) || null;
    var preType = editing ? editing.type : (opts.type || 'owe');
    var preCat = editing ? Store.util.normCategory(editing.category) : (opts.category || 'fee');

    var custs = Store.listCustomers().map(function (c) {
      return { c: c, bal: Store.balanceOf(c.id), last: Store.summaryOf(c.id).lastDate || '' };
    });
    custs.sort(function (a, b) { return b.last.localeCompare(a.last) || (b.bal - a.bal); });

    var sheet = openSheet(
      sheetHead(editing ? '修改这笔账' : '记一笔') +
      '<div class="sheet-body">' +
      '  <div class="seg" id="typeSeg">' +
      '    <button type="button" data-t="owe"  class="' + (preType === 'owe' ? 'on owe' : '') + '">＋ 记欠款</button>' +
      '    <button type="button" data-t="paid" class="' + (preType === 'paid' ? 'on paid' : '') + '">－ 收欠款</button>' +
      '  </div>' +

      '  <div class="field"><label>选客户</label>' +
      '    <input class="input" id="pickSearch" type="search" placeholder="搜姓名，或从下面点选" style="margin-bottom:9px">' +
      '    <div class="picker" id="pickGrid"></div>' +
      '    <button class="chip" id="newCustBtn" type="button">' + icon('plus', 14) + ' 新客户</button>' +
      '    <div id="newCustBox" style="display:none;margin-top:10px">' +
      '      <input class="input" id="newName" placeholder="客户姓名（必填）" style="margin-bottom:9px">' +
      '      <input class="input" id="newPhone" type="tel" inputmode="tel" placeholder="电话（可不填）">' +
      '    </div>' +
      '  </div>' +

      '  <div class="field"><label>这笔是什么</label>' +
      '    <div class="chips" id="catChips" style="margin-bottom:0">' + CATS.map(function (c) {
        return '<button class="chip" data-cat="' + c.id + '" type="button">' + c.label + '</button>';
      }).join('') + '</div>' +
      '  </div>' +

      '  <div class="field"><label>金额（元）</label>' +
      '    <div class="amount-row"><span class="cur">¥</span>' +
      '      <input id="amtInput" type="text" inputmode="decimal" placeholder="0" autocomplete="off"></div>' +
      '    <div class="chips" style="margin-bottom:0">' + AMOUNT_CHIPS.map(function (v) {
        return '<button class="chip" data-amt="' + v + '" type="button">' + v + '</button>';
      }).join('') + '</div>' +
      '  </div>' +

      '  <div class="field"><label>日期</label>' +
      '    <input class="input" id="dateInput" type="date" value="' + (editing ? editing.date : today(new Date())) + '"></div>' +

      '  <div class="field"><label>备注（可选）</label>' +
      '    <input class="input" id="noteInput" type="text" maxlength="60" placeholder="比如：夜场台费" value="' + esc(editing ? editing.note : '') + '">' +
      '    <div class="chips" style="margin:9px 0 0" id="noteChips"></div>' +
      '  </div>' +

      '  <p class="hint" id="txPreview" style="margin:0 0 8px"></p>' +
      '</div>' +
      '<div class="sheet-foot">' +
      (editing ? '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-danger" id="delTx" type="button">' + icon('trash', 18) + '删除这笔</button></div>' : '') +
      '  <button class="btn btn-primary" id="saveTx" type="button">保存</button>' +
      '</div>'
    );

    var sel = {
      type: preType,
      category: preCat,
      customerId: preCust,
      newNameMode: false
    };

    var grid = $('#pickGrid', sheet);
    var pickSearch = $('#pickSearch', sheet);

    function renderGrid() {
      var kw = pickSearch.value.trim().toLowerCase();
      var list = kw ? custs.filter(function (r) { return r.c.name.toLowerCase().indexOf(kw) >= 0 || r.c.phone.indexOf(kw) >= 0; }) : custs;
      var html = list.slice(0, 8).map(function (r) {
        var on = sel.customerId === r.c.id;
        return '<button class="pick' + (on ? ' on' : '') + '" data-pick="' + r.c.id + '" type="button">' +
          '<span class="pn">' + esc(r.c.name) + '</span>' +
          '<span class="pv num">' + (r.bal > 0.004 ? '欠 ¥' + esc(money(r.bal)) : (r.bal < -0.004 ? '你付 ¥' + esc(money(-r.bal)) : '已结清')) + '</span>' +
          '</button>';
      }).join('');
      if (kw && !list.length) html = '<span class="muted" style="grid-column:1/-1;padding:6px 2px">没有这个名字，可用下方「新客户」</span>';
      grid.innerHTML = html;
      grid.querySelectorAll('[data-pick]').forEach(function (b) {
        b.addEventListener('click', function () {
          sel.customerId = b.getAttribute('data-pick');
          sel.newNameMode = false;
          $('#newCustBox', sheet).style.display = 'none';
          renderGrid(); updatePreview();
        });
      });
    }

    function renderCatChips() {
      sheet.querySelectorAll('#catChips [data-cat]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-cat') === sel.category);
      });
      var wrap = $('#noteChips', sheet);
      if (sel.category === 'cig') {
        var cigs = Store.listCigs();
        wrap.innerHTML = cigs.map(function (cg) {
          return '<button class="chip cig" data-cig="' + cg.id + '" type="button">' + esc(cg.name) + ' · ¥' + esc(money(cg.price)) + '</button>';
        }).join('') || '<button class="chip" id="goCigs" type="button">' + icon('plus', 14) + ' 先设置烟品价目</button>';
        wrap.querySelectorAll('[data-cig]').forEach(function (b) {
          b.addEventListener('click', function () {
            var cg = cigs.filter(function (x) { return x.id === b.getAttribute('data-cig'); })[0];
            if (!cg) return;
            $('#amtInput', sheet).value = String(cg.price);
            $('#noteInput', sheet).value = cg.name;
            wrap.querySelectorAll('[data-cig]').forEach(function (x) { x.classList.toggle('on', x === b); });
            updatePreview();
          });
        });
        var goCigs = $('#goCigs', wrap);
        if (goCigs) goCigs.addEventListener('click', function () { closeSheet(); setTimeout(openCigsSheet, 320); });
      } else {
        wrap.innerHTML = (NOTE_CHIPS[sel.category] || []).map(function (t) {
          return '<button class="chip" data-note="' + t + '" type="button">' + t + '</button>';
        }).join('');
        wrap.querySelectorAll('[data-note]').forEach(function (b) {
          b.addEventListener('click', function () { $('#noteInput', sheet).value = b.getAttribute('data-note'); });
        });
      }
    }

    function updatePreview() {
      var el = $('#txPreview', sheet);
      var amt = parseFloat($('#amtInput', sheet).value);
      var cust = null;
      if (sel.customerId) cust = Store.getCustomer(sel.customerId);
      var nameTxt = cust ? cust.name : ($('#newName', sheet) && $('#newName', sheet).value.trim()) || '新客户';
      if (!(amt > 0)) { el.textContent = ''; return; }
      var cur = cust ? Store.balanceOf(cust.id) : 0;
      var after = Store.util.round2(sel.type === 'owe' ? cur + amt : cur - amt);
      var dTxt = after > 0.004 ? '欠款将变为 ¥' + money(after)
        : (after < -0.004 ? '将变成你多收 ¥' + money(-after) : '这笔收完，账就清了');
      el.textContent = nameTxt + ' ' + (sel.type === 'owe' ? '记欠' : '收回') + ' ¥' + money(amt) +
        '（' + CAT_LABEL[sel.category] + '），' + dTxt;
    }

    // 事件
    $('#typeSeg', sheet).querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        sel.type = b.getAttribute('data-t');
        $('#typeSeg', sheet).querySelectorAll('button').forEach(function (x) {
          x.className = x === b ? ('on ' + sel.type) : '';
        });
        updatePreview();
      });
    });
    sheet.querySelectorAll('#catChips [data-cat]').forEach(function (b) {
      b.addEventListener('click', function () {
        sel.category = b.getAttribute('data-cat');
        renderCatChips(); updatePreview();
      });
    });
    pickSearch.addEventListener('input', renderGrid);
    $('#newCustBtn', sheet).addEventListener('click', function () {
      sel.newNameMode = !sel.newNameMode;
      sel.customerId = null;
      $('#newCustBox', sheet).style.display = sel.newNameMode ? 'block' : 'none';
      renderGrid(); updatePreview();
      if (sel.newNameMode) $('#newName', sheet).focus();
    });
    var amtInput = $('#amtInput', sheet);
    amtInput.value = editing ? String(editing.amount) : '';
    amtInput.addEventListener('input', function () {
      var v = amtInput.value.replace(/[^\d.]/g, '');
      var i = v.indexOf('.');
      if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
      if (v !== amtInput.value) amtInput.value = v;
      updatePreview();
    });
    sheet.querySelectorAll('[data-amt]').forEach(function (b) {
      b.addEventListener('click', function () {
        amtInput.value = b.getAttribute('data-amt');
        updatePreview();
      });
    });
    $('#noteInput', sheet).addEventListener('input', updatePreview);
    $('#newName', sheet).addEventListener('input', updatePreview);
    renderGrid(); renderCatChips(); updatePreview();

    // 删除
    var delBtn = $('#delTx', sheet);
    if (delBtn) delBtn.addEventListener('click', function () {
      confirmDlg({ title: '删除这笔账？', text: '删除后该客户余额会相应变化，且无法恢复。', okText: '删除', danger: true })
        .then(function (yes) {
          if (!yes) return;
          Store.deleteTx(opts.txId);
          closeSheet();
          toast('已删除', 'ok');
          render();
        });
    });

    // 保存
    $('#saveTx', sheet).addEventListener('click', function () {
      var amt = parseFloat(amtInput.value);
      if (!(amt > 0)) { toast('先填一个大于 0 的金额', 'err'); amtInput.focus(); return; }
      var dateVal = $('#dateInput', sheet).value || today(new Date());
      var note = $('#noteInput', sheet).value.trim();

      var custId = sel.customerId;
      if (!custId) {
        var name = $('#newName', sheet).value.trim();
        if (!name) { toast('选一个客户，或填新客户姓名', 'err'); $('#newName', sheet).focus(); return; }
        var exist = Store.findCustomerByName(name);
        custId = exist ? exist.id : (Store.addCustomer({ name: name, phone: $('#newPhone', sheet).value.trim() }) || {}).id;
        if (!custId) { toast('客户创建失败', 'err'); return; }
      }

      if (editing) {
        Store.updateTx(editing.id, { amount: amt, type: sel.type, category: sel.category, date: dateVal, note: note });
        toast('已更新', 'ok');
      } else {
        Store.addTx({ customerId: custId, type: sel.type, category: sel.category, amount: amt, date: dateVal, note: note });
        var c = Store.getCustomer(custId);
        toast((c ? c.name : '') + (sel.type === 'owe' ? ' 记欠 ' : ' 收款 ') + money(amt) + '，已保存', 'ok');
      }
      closeSheet();
      render();
    });

    if (!editing) setTimeout(function () { amtInput.focus(); }, 320);
  }

  /* ================= 客户编辑 ================= */

  function openCustomerSheet(custId) {
    var c = custId ? Store.getCustomer(custId) : null;
    var created = 0;              // 本次连续录入了几位
    var sheet = openSheet(
      sheetHead(c ? '编辑客户' : '新增客户') +
      '<div class="sheet-body">' +
      '  <div class="field"><label>姓名 / 外号 *</label>' +
      '    <input class="input" id="cName" maxlength="20" placeholder="怎么顺口怎么叫" value="' + esc(c ? c.name : '') + '"></div>' +
      '  <div class="field"><label>电话（可不填）</label>' +
      '    <input class="input" id="cPhone" type="tel" inputmode="tel" maxlength="20" placeholder="催款用" value="' + esc(c ? c.phone : '') + '"></div>' +
      '  <div class="field"><label>备注（可不填）</label>' +
      '    <input class="input" id="cNote" maxlength="60" placeholder="比如：熟客，每周三来" value="' + esc(c ? c.note : '') + '"></div>' +
      (c ? '' : '  <p class="hint" id="cTip">录完一位点「<b>存下再录一位</b>」，能一口气把常来的客人都建好。</p>') +
      '</div>' +
      '<div class="sheet-foot">' +
      (c
        ? '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-danger" id="delCust" type="button">' + icon('trash', 18) + '删除客户</button></div>'
        : '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-ghost" id="saveCustMore" type="button">存下再录一位</button></div>') +
      '  <button class="btn btn-primary" id="saveCust" type="button">' + (c ? '保存' : '保存并查看') + '</button>' +
      '</div>',
      function () { if (created) render(); }
    );

    var nameEl = $('#cName', sheet), phoneEl = $('#cPhone', sheet), noteEl = $('#cNote', sheet);
    setTimeout(function () { nameEl.focus(); }, 320);

    /** 校验姓名（唯一、非空），返回 info 或 null */
    function readForm() {
      var name = nameEl.value.trim();
      if (!name) { toast('姓名总得有一个', 'err'); nameEl.focus(); return null; }
      var dup = Store.findCustomerByName(name);
      if (dup && (!c || dup.id !== c.id)) { toast('已经有这位客户了', 'err'); nameEl.focus(); return null; }
      return { name: name, phone: phoneEl.value.trim(), note: noteEl.value.trim() };
    }

    var del = $('#delCust', sheet);
    if (del) del.addEventListener('click', function () {
      var s = Store.summaryOf(c.id);
      confirmDlg({
        title: '删除「' + c.name + '」？',
        html: '将同时删除 TA 的 <b>' + s.count + '</b> 笔往来记录，无法恢复。',
        okText: '删除', danger: true
      }).then(function (yes) {
        if (!yes) return;
        Store.deleteCustomer(c.id);
        closeSheet();
        toast('已删除', 'ok');
        go('#/home');
      });
    });

    // 存下再录一位：不关抽屉，清空接着录
    var more = $('#saveCustMore', sheet);
    if (more) more.addEventListener('click', function () {
      var info = readForm();
      if (!info) return;
      if (!Store.addCustomer(info)) { toast('保存失败', 'err'); return; }
      created++;
      nameEl.value = ''; phoneEl.value = ''; noteEl.value = '';
      var tip = $('#cTip', sheet);
      if (tip) tip.innerHTML = '已存下 <b>' + created + '</b> 位，接着录下一位。';
      toast('已存下「' + info.name + '」', 'ok', 1400);
      nameEl.focus();
    });

    $('#saveCust', sheet).addEventListener('click', function () {
      var info = readForm();
      if (!info) return;
      if (c) {
        Store.updateCustomer(c.id, info);
        closeSheet();
        toast('已保存', 'ok');
        render();
      } else {
        var nc = Store.addCustomer(info);
        if (!nc) { toast('保存失败', 'err'); return; }
        created = 0;                 // 下面 go() 会自己重绘，避免关闭回调再渲染一次
        closeSheet();
        toast('已存下「' + nc.name + '」，可以记账了', 'ok', 2000);
        go('#/c/' + nc.id);
      }
    });
  }

  /* ================= 云端备份（v2.0） ================= */

  function cloudWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts), n = new Date();
    var t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === n.toDateString()) return '今天 ' + t;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + t;
  }

  /** 「我的」页里那块云端状态 + 操作 */
  function cloudSectionHtml() {
    if (!global.Cloud) return '';
    var s = Cloud.status();
    var info = s.info || {};
    var sub = [];
    if (s.available && info.counts) {
      sub.push(info.counts.customers + ' 客户 · ' + info.counts.incomes + ' 场 · ' + info.counts.txs + ' 流水');
    }
    if (s.rev) sub.push('云端 v' + s.rev);
    if (s.lastSyncAt) sub.push('上次同步 ' + cloudWhen(s.lastSyncAt));
    if (!sub.length) {
      if (s.available === false) {
        sub.push(s.lastSyncAt
          ? '暂时连不上云端，账目都在本机；点「立即同步」重试'
          : '这台服务器上还没有云端程序，账目只存在本机');
      } else {
        sub.push('把账目存到服务器，换手机、清缓存都不怕');
      }
    }

    var rows = '';
    if (!s.loggedIn) {
      // 只有「还没登录上云端」才把入口收成「连接」。已经登录过的，网络抖一下不该
      // 把「立即同步」换掉——不然一时断网就没法手动重试了。
      var cdesc = (s.available === false)
        ? '点这里试试；若提示不可用，说明服务器还没装云端程序'
        : '输入你的进入密码即可连上';
      rows +=
        '  <button class="list-item" id="cloudConnect" type="button"><span class="li-ico">' + icon('cloud', 21) + '</span>' +
        '    <span class="li-txt">连接云端备份<span class="li-desc">' + cdesc + '</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>';
    } else {
      rows +=
        '  <button class="list-item" id="cloudNow" type="button"><span class="li-ico">' + icon('swap', 21) + '</span>' +
        '    <span class="li-txt">立即同步<span class="li-desc">把本机改动传上去，顺手拉回别处的改动</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
        '  <button class="list-item" id="cloudHistory" type="button"><span class="li-ico">' + icon('doc', 21) + '</span>' +
        '    <span class="li-txt">云端版本历史<span class="li-desc">每次同步都留一份，随时能翻回旧版本</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
        '  <button class="list-item" id="cloudDownload" type="button"><span class="li-ico">' + icon('down', 21) + '</span>' +
        '    <span class="li-txt">下载云端备份<span class="li-desc">存到手机里，换机或存档用</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
        '  <button class="list-item" id="cloudConnect" type="button"><span class="li-ico">' + icon('unlock', 21) + '</span>' +
        '    <span class="li-txt">重新连接<span class="li-desc">换了密码或掉线时，重新登录云端</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>';
    }

    return '<div class="section"><div class="section-head"><h2>云端备份</h2></div><div class="card" id="cloudBox">' +
      '  <div class="cloud-state"><span class="cloud-dot ' + (s.tone || 'off') + '"></span>' +
      '    <span class="cloud-txt">' + esc(s.text || '') + '</span></div>' +
      '  <div class="cloud-sub">' + esc(sub.join(' · ')) + '</div>' +
      rows + '</div></div>';
  }

  /** 连接 / 重新连接云端 */
  function openCloudConnectSheet() {
    var sheet = openSheet(
      sheetHead('连接云端备份') +
      '<div class="sheet-body">' +
      '  <p class="hint">输入你的「进入密码」——就是打开这个应用时输的那个，云端用同一个密码，不用记两个。</p>' +
      '  <div class="field"><label>进入密码</label>' +
      '    <input class="input" id="cloudPw" type="password" inputmode="numeric" autocomplete="current-password" placeholder="4-6 位数字"></div>' +
      '  <div class="field"><label>密码提示（选填）</label>' +
      '    <input class="input" id="cloudHint" type="text" maxlength="20" placeholder="忘了时给自己看的提示"></div>' +
      '  <p class="hint" id="cloudMsg"></p>' +
      '</div>' +
      '<div class="sheet-foot"><button class="btn btn-primary" id="cloudGo" type="button">连接</button></div>'
    );

    var msg = function (t, bad) {
      var el = $('#cloudMsg', sheet);
      if (el) { el.textContent = t || ''; el.style.color = bad ? 'var(--danger,#c0392b)' : ''; }
    };
    var busy = false;

    function submit() {
      if (busy) return;
      var pw = ($('#cloudPw', sheet) || {}).value || '';
      var hint = ($('#cloudHint', sheet) || {}).value || '';
      if (pw.length < 4) { msg('密码至少 4 位', true); return; }
      busy = true;
      var btn = $('#cloudGo', sheet);
      if (btn) { btn.disabled = true; btn.textContent = '连接中…'; }
      Cloud.ping(function (perr, info) {
        if (perr || !info) {
          busy = false;
          if (btn) { btn.disabled = false; btn.textContent = '连接'; }
          msg('连不上云端：这台服务器上可能还没装云端程序，或当前网络不通', true);
          return;
        }
        var next = function (e) {
          busy = false;
          if (e) {
            if (btn) { btn.disabled = false; btn.textContent = '连接'; }
            msg(e.error || '连接失败', true);
            return;
          }
          msg('连上了，正在同步…');
          Cloud.sync({}, function (e2, r) {
            closeSheet();
            if (e2 || !r) { toast('已连接云端', 'ok'); render(); return; }
            cloudHandleResult(r, true);
          });
        };
        if (info.needsSetup) Cloud.setup(pw, hint, next);
        else Cloud.login(pw, next);
      });
    }

    $('#cloudGo', sheet).addEventListener('click', submit);
    var inp = $('#cloudPw', sheet);
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    }
  }

  /** 云端版本历史（可回滚 / 下载） */
  function openCloudHistorySheet() {
    var sheet = openSheet(
      sheetHead('云端版本历史') +
      '<div class="sheet-body" id="chBody"><p class="hint">正在读取…</p></div>'
    );
    var body = $('#chBody', sheet);

    function paint(data) {
      var list = (data.list || []).slice(0, 40);
      var daily = (data.daily || []).slice(0, 10);
      var html = '<p class="hint">每同步一次就留一个版本，最多保留最近 60 个 + 每天首个（90 天）。选一个可以下载到手机，或者直接翻回那一天。</p>';
      if (!list.length) html += '<p class="hint">云端还没有版本。</p>';
      else {
        html += '<div class="glist">' + list.map(function (v) {
          var isCur = v.rev === data.currentRev;
          return '<div class="grow" style="align-items:center">' +
            '<span class="grow-name">v' + v.rev + (isCur ? ' · 当前' : '') +
            '<span class="cloud-sub" style="display:block">' + esc(cloudWhen(v.ts * 1000)) + ' · ' + v.counts.customers + '客户/' + v.counts.incomes + '场/' + v.counts.txs + '流水' +
            (v.device ? ' · ' + esc(v.device) : '') + '</span></span>' +
            '<span class="grow-sum">' +
            '<button class="mini" type="button" data-dl="' + v.rev + '">下载</button>' +
            (isCur ? '' : ' <button class="mini ghost" type="button" data-rs="' + v.rev + '">恢复</button>') +
            '</span></div>';
        }).join('') + '</div>';
      }
      if (daily.length) {
        html += '<p class="hint" style="margin-top:14px">每日备份（长期保留）</p><div class="glist">' + daily.map(function (v) {
          return '<div class="grow" style="align-items:center"><span class="grow-name">' + esc(v.date) +
            '<span class="cloud-sub" style="display:block">' + v.counts.customers + '客户/' + v.counts.incomes + '场/' + v.counts.txs + '流水</span></span>' +
            '<span class="grow-sum"><button class="mini" type="button" data-dl="' + esc(v.date) + '">下载</button>' +
            ' <button class="mini ghost" type="button" data-rs="' + esc(v.date) + '">恢复</button></span></div>';
        }).join('') + '</div>';
      }
      body.innerHTML = html;

      body.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          var rev = b.getAttribute('data-dl');
          window.open(Cloud.downloadUrl(rev), '_blank');
          toast('已开始下载，去浏览器「下载」里找', 'ok', 2200);
        });
      });
      body.querySelectorAll('[data-rs]').forEach(function (b) {
        b.addEventListener('click', function () {
          var rev = b.getAttribute('data-rs');
          confirmDlg({
            title: '恢复到 ' + rev,
            html: '把云端翻回这个版本，<b>然后同步到本机</b>。<br><br>' +
              '当前版本不会丢——它还在历史里，随时能再翻回来。',
            okText: '恢复',
            cancelText: '算了'
          }).then(function (yes) {
            if (!yes) return;
            Cloud.restore(rev, function (err) {
              if (err) { toast(err.error || '恢复失败', 'err'); return; }
              closeSheet(true);
              toast('已恢复到 ' + rev, 'ok');
              render();
            });
          });
        });
      });
    }

    Cloud.history(function (err, data) {
      if (err) {
        body.innerHTML = '<p class="hint">读不到云端历史：' + esc(err.error || '连不上云端') + '</p>';
        return;
      }
      paint(data);
    });
  }

  /** 三个选项的对话框（云端冲突时用） */
  function cloudChooseDlg(opts) {
    return new Promise(function (resolve) {
      var root = $('#dialog-root');
      root.innerHTML =
        '<div class="dlg-mask">' +
        '  <div class="dlg" role="dialog" aria-modal="true">' +
        '    <h3>' + esc(opts.title) + '</h3>' +
        '    <p>' + (opts.html || '') + '</p>' +
        '    <div class="btn-col">' +
        opts.options.map(function (o, i) {
          return '<button class="btn ' + (o.primary ? 'btn-primary' : 'btn-ghost') + '" data-opt="' + i + '">' + esc(o.label) + '</button>';
        }).join('') +
        '    </div>' +
        '  </div>' +
        '</div>';
      var mask = $('.dlg-mask', root);
      requestAnimationFrame(function () { requestAnimationFrame(function () { mask.classList.add('show'); }); });
      function done(i) {
        mask.classList.remove('show');
        setTimeout(function () { root.innerHTML = ''; }, 200);
        resolve(i);
      }
      root.querySelectorAll('[data-opt]').forEach(function (b) {
        b.addEventListener('click', function () { done(Number(b.getAttribute('data-opt'))); });
      });
      mask.addEventListener('click', function (e) { if (e.target === mask) done(-1); });
    });
  }

  /** 云端与本机都有改动：让用户选，绝不自动猜 */
  function cloudConflict(info) {
    var when = info.savedAt ? cloudWhen(Date.parse(info.savedAt)) : '';
    cloudChooseDlg({
      title: '云端和本机都有改动',
      html: '云端现在是 <b>v' + (info.rev || '?') + '</b>' + (when ? '（' + when + '）' : '') +
        (info.device ? '，来自「' + esc(info.device) + '」' : '') + '。<br><br>' +
        '两个都留着，你选一个：<br>· 用云端的 → 本机改成云端的版本<br>· 用本机的 → 把云端覆盖掉（云端当前版本仍会留在历史里）',
      options: [
        { label: '用云端的（本机改成云端）', primary: true },
        { label: '用本机的（覆盖云端）' },
        { label: '先不动，我自己看看' }
      ]
    }).then(function (i) {
      if (i === 0) {
        Cloud.pull(true, function (err) {
          if (err) { toast(err.error || '拉取失败', 'err'); return; }
          toast('已改成云端的版本', 'ok');
          render();
        });
      } else if (i === 1) {
        Cloud.push({ force: true }, function (err) {
          if (err) { toast(err.error || '上传失败', 'err'); return; }
          toast('已用本机覆盖云端', 'ok');
          renderMe();
        });
      }
    });
  }

  /** 处理一次同步结果 */
  function cloudHandleResult(r, quiet) {
    if (!r) return;
    if (r.state === 'pulled') {
      if (!quiet) toast('已从云端更新到 v' + r.rev, 'ok');
      render();
    } else if (r.state === 'pushed') {
      if (!quiet) toast('已备份到云端 v' + r.rev, 'ok');
      renderMe();
    } else if (r.state === 'conflict') {
      cloudConflict(r);
    } else if (r.state === 'needSetup' || r.state === 'needLogin') {
      if (state.route === 'me') renderMe();
    } else if (r.state === 'offline' || r.state === 'off') {
      if (!quiet && state.route === 'me') renderMe();
    }
  }

  /** 启动时接云端：后端不在就完全静默，App 照常当单机用 */
  function cloudBoot() {
    if (!global.Cloud) return;
    Cloud.onchange = function () {
      var box = $('#cloudBox');
      if (state.route === 'me' && box) {
        var wrap = document.createElement('div');
        wrap.innerHTML = cloudSectionHtml();
        var fresh = $('#cloudBox', wrap);
        if (fresh) { box.innerHTML = fresh.innerHTML; mountCloud(); }
      }
    };
    Cloud.ping(function (err, info) {
      if (err || !info) return;            // 没装后端 / 断网 → 静默
      var pin = (global.Lock && Lock.takePin) ? Lock.takePin() : '';
      var afterAuth = function () {
        Cloud.sync({}, function (e, r) {
          if (r && r.state === 'pulled') { toast('已从云端同步最新账目', 'ok'); render(); }
          else cloudHandleResult(r, true);
        });
      };
      if (info.needsSetup) {
        if (pin) Cloud.setup(pin, '', function (e) { if (!e) afterAuth(); });
        return;
      }
      if (!Cloud.loggedIn()) {
        if (pin) Cloud.login(pin, function (e) { if (!e) afterAuth(); });
        return;
      }
      afterAuth();
    });
  }

  function mountCloud() {
    var c = $('#cloudConnect');
    if (c) c.addEventListener('click', openCloudConnectSheet);
    var n = $('#cloudNow');
    if (n) n.addEventListener('click', function () {
      toast('正在同步…', 'ok', 1200);
      Cloud.syncNow(function (err, r) {
        if (err) toast(err.error || '同步失败', 'err');
        else cloudHandleResult(r);
      });
    });
    var h = $('#cloudHistory');
    if (h) h.addEventListener('click', openCloudHistorySheet);
    var d = $('#cloudDownload');
    if (d) d.addEventListener('click', function () {
      window.open(Cloud.downloadUrl(), '_blank');
      toast('已开始下载，去浏览器「下载」里找', 'ok', 2200);
    });
  }

  /* ================= 路由 ================= */

  function render() {
    var hash = location.hash || '#/home';
    var m = hash.match(/^#\/([^/]+)(?:\/(.+))?$/);
    state.route = m ? m[1] : 'home';
    state.customerId = m && m[2] ? decodeURIComponent(m[2]) : null;
    closeSheet(true);
    renderTabbar();
    $('#fab').style.display = 'flex';

    if (state.route === 'income') renderIncome();
    else if (state.route === 'txs') renderTxs();
    else if (state.route === 'stats') renderStats();
    else if (state.route === 'me') renderMe();
    else if (state.route === 'c' && state.customerId) renderDetail(state.customerId);
    else { state.route = 'home'; renderHome(); }

    window.scrollTo(0, 0);
  }

  document.addEventListener('click', function (e) {
    var back = e.target.closest('[data-back]');
    if (back) { go('#/home'); }
  });

  global.addEventListener('hashchange', render);

  /* ================= 启动 ================= */

  function bootApp() {
    Store.load();
    render();

    // 云端：有后端就自动连、自动同步；没有就静默当单机用
    cloudBoot();

    // 从后台切回前台时顺手同步一次（手机常见场景）
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && global.Cloud && Cloud.loggedIn()) {
        Cloud.sync({}, function (e, r) { cloudHandleResult(r, true); });
      }
    });

    // PWA：https / localhost 下注册离线缓存
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW 注册失败（不影响使用）', e); });
    }
  }

  /* 本机是否已经有账目数据（用于首次设密码时提醒） */
  function hasLocalData() {
    try {
      var raw = localStorage.getItem('ledger_mahjong_v1');
      if (!raw) return false;
      var d = JSON.parse(raw);
      return !!((d.customers && d.customers.length) || (d.txs && d.txs.length) || (d.incomes && d.incomes.length));
    } catch (e) { return false; }
  }

  /* 门禁：没设过密码 → 先设；设了但本机没过 → 解锁。两关都过才进系统。 */
  if (global.Lock && !Lock.isSet()) {
    document.body.classList.add('locked');
    Lock.openSetup({
      mode: 'set', gate: true, warnData: hasLocalData(),
      onDone: function () { bootApp(); }
    });
  } else if (global.Lock && !Lock.isUnlocked()) {
    // 已设密码但本机未授权：先上锁，解锁后再启动
    document.body.classList.add('locked');
    Lock.showLockScreen(bootApp);
  } else {
    bootApp();
  }

})(window);
