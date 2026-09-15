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
  var VERSION = '1.3.0';

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
    { id: 'income', name: '营收', icon: 'wallet' },
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

  $('#fab').addEventListener('click', function () { openTxSheet({}); });

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
      pageTitle('往来账', '账目只存在这台手机上') +

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

      '<div class="section"><div class="card">';

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
    var demo = $('#loadDemoBtn');
    if (demo) demo.addEventListener('click', loadDemo);
  }

  function emptyHtml(kw) {
    if (kw) {
      return '<div class="empty"><div class="big">🔍</div><h3>没找到“' + esc(state.custKeyword.trim()) + '”</h3><p>换个关键词试试，或者点右下角 + 新建客户</p></div>';
    }
    if (!Store.hasAnyData()) {
      return '<div class="empty"><div class="big">🀄</div><h3>还没有账目</h3>' +
        '<p>点右下角的 <b>＋</b> 记客户往来<br>「营收」页记每场收入<br>「我的」里可以看示例数据</p>' +
        '<button id="loadDemoBtn" class="chip" type="button" style="margin-top:14px">先看看示例数据</button></div>';
    }
    return '<div class="empty"><div class="big">🀄</div><h3>没有匹配的客户</h3><p>点右下角 <b>＋</b> 新建一位客户</p></div>';
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
        '<span class="tx-badge ' + (isOwe ? 'owe' : 'paid') + (cat === 'cig' ? ' cig' : '') + '">' + (cat === 'cig' ? '烟' : (isOwe ? '欠' : '收')) + '</span>' +
        '<span class="tx-main">' +
        '<span class="tx-title">' + (opts.showName !== false && c ? esc(c.name) : (isOwe ? '记欠款' : '收回欠款')) + '</span>' +
        '<span class="tx-note">' + (t.incomeId ? '<i class="tag-inc">营收挂账</i>' : '') + esc(noteTxt) + '</span>' +
        '</span>' +
        '<span class="tx-side">' +
        '<span class="tx-amt num ' + (isOwe ? 'owe' : 'paid') + '">' + (isOwe ? '+' : '−') + esc(money(t.amount)) + '</span>' +
        (tm ? '<span class="tx-time num">' + tm + '</span>' : '') +
        '</span>' +
        '</button>';
    });
    return out;
  }

  /* ================= 页面：营业收入 ================= */

  function renderIncome() {
    var ov = Store.overview();
    var list = Store.listIncomes({});
    var total = Store.incomeStats(null, null);
    var todayStr = today(new Date());
    var tInc = Store.incomeStats(todayStr, todayStr);
    var mInc = Store.incomeStats(todayStr.slice(0, 7) + '-01', null);

    // 按日期分组（顺手算出当天收了多少现金、挂了多少账）
    var groups = [], map = {};
    list.forEach(function (it) {
      if (!map[it.date]) { map[it.date] = { date: it.date, total: 0, cash: 0, credit: 0, items: [] }; groups.push(map[it.date]); }
      var g = map[it.date];
      var cs = Store.creditSumOf(it.id);
      var amt = Number(it.amount || 0);
      g.total += amt;
      g.cash += amt - cs.fee;
      g.credit += cs.fee + cs.cig;
      g.items.push(it);
    });

    var html =
      pageTitle('营业收入', '每场每人收费，随手记一笔') +

      '<div class="hero">' +
      '  <div class="hero-label">今日营业额</div>' +
      '  <div class="hero-amount num"><span class="cur">¥</span>' + esc(money(tInc.total)) + '</div>' +
      '  <div class="hero-meta">' +
      '    <div>今日收现<b class="num paid">¥' + esc(money(tInc.cash)) + '</b></div>' +
      '    <div>今日场次<b class="num">' + ov.todayGames + ' 场</b></div>' +
      '    <div>本月营业额<b class="num">¥' + esc(money(mInc.total)) + '</b></div>' +
      '  </div>' +
      '</div>' +

      '<div class="section" style="margin-bottom:14px">' +
      '  <button class="btn btn-primary" id="addIncome" type="button">' + icon('plus', 20) + '记一场营收</button>' +
      '</div>' +

      '<div class="section"><div class="section-head"><h2>营收明细</h2>' +
      '<span class="muted num">累计 ' + total.games + ' 场 · ¥' + esc(money(total.total)) +
      (Store.util.round2(total.creditFee + total.creditCig) > 0
        ? '（挂账 ¥' + esc(money(Store.util.round2(total.creditFee + total.creditCig))) + '）' : '') +
      '</span></div>' +
      '<div class="card">';

    if (!list.length) {
      html += '<div class="empty"><div class="big">💰</div><h3>还没有营收记录</h3><p>点上面「记一场营收」<br>填人数和每人收费就行</p></div>';
    } else {
      groups.forEach(function (g) {
        html += '<div class="day-head"><span>' + humanDate(g.date) + '</span>' +
          '<b>¥' + esc(money(g.total)) +
          (g.credit > 0 ? '<span class="dh-sub">收现 ¥' + esc(money(g.cash)) + '</span>' : '') +
          '</b></div>';
        html += g.items.map(function (it) {
          var meta = it.players + ' 人 × ' + esc(money(it.unitPrice)) + ' 元';
          if (it.note) meta += ' · ' + esc(it.note);
          if (Number(it.unitPrice) * Number(it.players) !== Number(it.amount)) meta += '（手改）';
          var cs = Store.creditSumOf(it.id);
          var hasCredit = cs.fee > 0 || cs.cig > 0;
          var sub;
          if (!hasCredit) {
            sub = '当场收清 ¥' + esc(money(it.amount));
          } else {
            var who = Store.creditsInputOf(it.id).map(function (r) {
              var cc = Store.getCustomer(r.customerId);
              return cc ? cc.name : '';
            }).filter(Boolean).join('、');
            sub = '收现 ¥' + esc(money(Store.util.round2(Number(it.amount) - cs.fee))) +
              ' · 挂账 ¥' + esc(money(Store.util.round2(cs.fee + cs.cig)));
            if (who) sub += '（' + esc(who) + '）';
          }
          return '<button class="tx" data-income="' + it.id + '" type="button">' +
            '<span class="tx-badge ' + (hasCredit ? 'credit' : 'inc') + '">' + (hasCredit ? '挂' : '场') + '</span>' +
            '<span class="tx-main"><span class="tx-title num">' + meta + '</span>' +
            '<span class="tx-note">' + sub + '</span></span>' +
            '<span class="tx-amt num inc">+¥' + esc(money(it.amount)) + '</span>' +
            '</button>';
        }).join('');
      });
    }
    html += '</div></div>';
    view.innerHTML = html;

    $('#addIncome').addEventListener('click', function () { openIncomeSheet({}); });
    view.querySelectorAll('[data-income]').forEach(function (b) {
      b.addEventListener('click', function () { openIncomeSheet({ incomeId: b.getAttribute('data-income') }); });
    });
  }

  /** 记一场营收；「有人先记着」的台费/烟钱会自动挂到客户账上 */
  function openIncomeSheet(opts) {
    var editing = opts.incomeId ? Store.getIncome(opts.incomeId) : null;
    var PLAYER_CHIPS = [1, 2, 3, 4, 5, 6];
    var PRICE_CHIPS = [10, 20, 30, 50];

    var allCusts = Store.listCustomers().slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    var cigList = Store.listCigs();

    // 挂账草稿：[{customerId, fee, cig, cigName}]
    var credits = editing ? Store.creditsInputOf(editing.id) : [];
    var payMode = credits.length ? 'credit' : 'cash';

    var sheet = openSheet(
      sheetHead(editing ? '修改这场营收' : '记一场营收') +
      '<div class="sheet-body">' +

      '  <div class="field"><label>本场人数</label>' +
      '    <div class="chips" id="playerChips" style="margin-bottom:9px">' + PLAYER_CHIPS.map(function (n) {
        return '<button class="chip" data-players="' + n + '" type="button">' + n + ' 人</button>';
      }).join('') + '</div>' +
      '    <input class="input num" id="playersInput" type="text" inputmode="numeric" placeholder="人数" value="' + (editing ? editing.players : 4) + '">' +
      '  </div>' +

      '  <div class="field"><label>每人收费（元）</label>' +
      '    <div class="chips" id="priceChips" style="margin-bottom:9px">' + PRICE_CHIPS.map(function (n) {
        return '<button class="chip" data-price="' + n + '" type="button">' + n + ' 元</button>';
      }).join('') + '</div>' +
      '    <input class="input num" id="priceInput" type="text" inputmode="decimal" placeholder="每人多少" value="' + (editing ? editing.unitPrice : 20) + '">' +
      '  </div>' +

      '  <div class="field"><label>本场营业额（元）<span class="muted" style="font-weight:400"> — 自动算，可手改</span></label>' +
      '    <div class="amount-row"><span class="cur">¥</span>' +
      '      <input id="incomeAmount" type="text" inputmode="decimal" placeholder="0" value="' + (editing ? editing.amount : '') + '"></div>' +
      '  </div>' +

      '  <div class="field"><label>这场钱收了吗</label>' +
      '    <div class="seg" id="paySeg">' +
      '      <button type="button" data-pay="cash">当场付清</button>' +
      '      <button type="button" data-pay="credit">有人先记着</button>' +
      '    </div>' +
      '  </div>' +

      '  <div class="field" id="creditBox">' +
      '    <label>记在谁名下<span class="muted" style="font-weight:400"> — 自动进他的欠款，不用再记一遍</span></label>' +
      '    <div id="creditRows"></div>' +
      '    <button class="chip" id="addCredit" type="button">' + icon('plus', 14) + ' 添一位</button>' +
      '  </div>' +

      '  <div class="pay-sum" id="paySum"></div>' +

      '  <div class="field"><label>日期</label>' +
      '    <input class="input" id="incomeDate" type="date" value="' + (editing ? editing.date : today(new Date())) + '"></div>' +

      '  <div class="field"><label>备注（可选）</label>' +
      '    <input class="input" id="incomeNote" type="text" maxlength="60" placeholder="比如：包场、老张那桌" value="' + esc(editing ? editing.note : '') + '"></div>' +

      '  <p class="hint" id="incomePreview" style="margin:0 0 8px"></p>' +
      '</div>' +
      '<div class="sheet-foot">' +
      (editing ? '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-danger" id="delIncome" type="button">' + icon('trash', 18) + '删除这场</button></div>' : '') +
      '  <button class="btn btn-primary" id="saveIncome" type="button">保存</button>' +
      '</div>'
    );

    var amountTouched = !!editing;
    var playersEl = $('#playersInput', sheet), priceEl = $('#priceInput', sheet),
        amtEl = $('#incomeAmount', sheet);
    var creditBox = $('#creditBox', sheet), rowsEl = $('#creditRows', sheet);

    function unitPrice() { return parseFloat(priceEl.value) || 0; }

    function custOpts(selId) {
      return allCusts.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === selId ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('');
    }

    function cigOpts(selName) {
      var out = '<option value="">不记烟</option>';
      cigList.forEach(function (cg) {
        out += '<option value="' + esc(cg.name) + '"' + (cg.name === selName ? ' selected' : '') + '>' +
          esc(cg.name) + ' ¥' + esc(money(cg.price)) + '</option>';
      });
      return out;
    }

    function creditRowHtml(r, i) {
      return '<div class="cc" data-i="' + i + '">' +
        '<div class="cc-top">' +
        '  <select class="input cc-cust">' + custOpts(r.customerId) + '</select>' +
        '  <button class="icon-btn cc-del" type="button" aria-label="移除">' + icon('close', 18) + '</button>' +
        '</div>' +
        '<div class="cc-bot">' +
        '  <span class="cc-fee-wrap"><span class="cc-lb">台费 ¥</span>' +
        '    <input class="input num cc-fee" type="text" inputmode="decimal" placeholder="0" value="' + (r.fee ? r.fee : '') + '"></span>' +
        '  <select class="input cc-cig">' + cigOpts(r.cigName) + '</select>' +
        '</div>' +
        '</div>';
    }

    function feeSumOf() {
      var s = 0;
      credits.forEach(function (r) { s += Number(r.fee) || 0; });
      return Store.util.round2(s);
    }
    function cigSumOf() {
      var s = 0;
      credits.forEach(function (r) { s += Number(r.cig) || 0; });
      return Store.util.round2(s);
    }

    function renderSum() {
      var el = $('#paySum', sheet);
      var amt = parseFloat(amtEl.value) || 0;
      if (payMode !== 'credit') {
        el.innerHTML = '这场当场收清，实收现金 <b class="paid">¥' + esc(money(amt)) + '</b>';
        return;
      }
      var fs = feeSumOf(), cs = cigSumOf();
      if (fs <= 0 && cs <= 0) { el.innerHTML = '<span class="muted">还没填挂账金额</span>'; return; }
      var cash = Store.util.round2(amt - fs);
      var out = '实收现金 <b class="paid">¥' + esc(money(Math.max(0, cash))) + '</b>' +
        ' · 挂账台费 <b class="owe">¥' + esc(money(fs)) + '</b>';
      if (cs > 0) out += ' · 挂账烟钱 <b class="owe">¥' + esc(money(cs)) + '</b>';
      if (cash < -0.004) {
        out += '<br><span class="warn">' + icon('alert', 14) + ' 挂账台费超过了本场营业额，核对一下</span>';
      }
      el.innerHTML = out;
    }

    function renderCredits() {
      creditBox.style.display = (payMode === 'credit') ? '' : 'none';
      if (payMode !== 'credit') { renderSum(); return; }
      if (!allCusts.length) {
        rowsEl.innerHTML = '<p class="hint">还没有客户档案。先去「客户」页添加一位，或用「记一笔」直接记到他名下。</p>';
        $('#addCredit', sheet).style.display = 'none';
        renderSum();
        return;
      }
      $('#addCredit', sheet).style.display = '';
      rowsEl.innerHTML = credits.map(creditRowHtml).join('');
      rowsEl.querySelectorAll('.cc').forEach(function (row) {
        var i = Number(row.getAttribute('data-i'));
        $('.cc-cust', row).addEventListener('change', function () { credits[i].customerId = this.value; });
        $('.cc-fee', row).addEventListener('input', function () {
          var v = this.value.replace(/[^\d.]/g, '');
          var k = v.indexOf('.');
          if (k >= 0) v = v.slice(0, k + 1) + v.slice(k + 1).replace(/\./g, '');
          if (v !== this.value) this.value = v;
          credits[i].fee = parseFloat(v) || 0;
          renderSum();
        });
        $('.cc-cig', row).addEventListener('change', function () {
          var nm = this.value, cg = null;
          for (var k = 0; k < cigList.length; k++) { if (cigList[k].name === nm) cg = cigList[k]; }
          credits[i].cigName = nm;
          credits[i].cig = cg ? Number(cg.price) : 0;
          renderSum();
        });
        $('.cc-del', row).addEventListener('click', function () {
          credits.splice(i, 1);
          renderCredits();
        });
      });
      renderSum();
    }

    function calc() {
      if (!amountTouched) {
        var n = parseInt(playersEl.value, 10) || 0;
        var p = parseFloat(priceEl.value) || 0;
        var v = Store.util.round2(n * p);
        amtEl.value = v > 0 ? String(v) : '';
      }
      updatePreview();
      renderSum();
    }

    function updatePreview() {
      var n = parseInt(playersEl.value, 10) || 0;
      var p = parseFloat(priceEl.value) || 0;
      var a = parseFloat(amtEl.value) || 0;
      var el = $('#incomePreview', sheet);
      var parts = [];
      if (n > 0 && p > 0) parts.push(n + ' 人 × ' + money(p) + ' 元 = ¥' + money(Store.util.round2(n * p)));
      if (n > 0 && p > 0 && a > 0 && Store.util.round2(n * p) !== a) parts.push('手改成 ¥' + money(a));
      el.textContent = parts.join('，');
      // chips 选中态
      sheet.querySelectorAll('[data-players]').forEach(function (b) {
        b.classList.toggle('on', Number(b.getAttribute('data-players')) === n);
      });
      sheet.querySelectorAll('[data-price]').forEach(function (b) {
        b.classList.toggle('on', Number(b.getAttribute('data-price')) === p);
      });
    }

    /** 数字清洗 */
    function clean(el, decimal) {
      var v = el.value.replace(decimal ? /[^\d.]/g : /[^\d]/g, '');
      if (decimal) {
        var i = v.indexOf('.');
        if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
      }
      if (v !== el.value) el.value = v;
      return v;
    }

    function setPayMode(mode) {
      payMode = mode;
      $('#paySeg', sheet).querySelectorAll('button').forEach(function (x) {
        var on = x.getAttribute('data-pay') === mode;
        x.className = on ? ('on ' + (mode === 'cash' ? 'paid' : 'owe')) : '';
      });
      // 切到「有人先记着」且还没明细时，先给一行，省得再点一次
      if (mode === 'credit' && !credits.length && allCusts.length) {
        credits.push({ customerId: allCusts[0].id, fee: unitPrice(), cig: 0, cigName: '' });
      }
      renderCredits();
    }

    $('#paySeg', sheet).querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { setPayMode(b.getAttribute('data-pay')); });
    });

    $('#addCredit', sheet).addEventListener('click', function () {
      if (!allCusts.length) { toast('先去「客户」页添加一位客户'); return; }
      var used = {};
      credits.forEach(function (r) { used[r.customerId] = 1; });
      var next = allCusts[0];
      for (var i = 0; i < allCusts.length; i++) {
        if (!used[allCusts[i].id]) { next = allCusts[i]; break; }
      }
      credits.push({ customerId: next.id, fee: unitPrice(), cig: 0, cigName: '' });
      renderCredits();
    });

    // 人数 / 每人单价：改动后重新自动算总额
    [playersEl, priceEl].forEach(function (el) {
      el.addEventListener('input', function () {
        clean(el, el === priceEl);
        amountTouched = false;
        calc();
      });
    });
    // 本场营业额：手改即生效，不再被覆盖
    amtEl.addEventListener('input', function () {
      clean(amtEl, true);
      amountTouched = true;
      updatePreview();
      renderSum();
    });

    sheet.querySelectorAll('[data-players]').forEach(function (b) {
      b.addEventListener('click', function () {
        playersEl.value = b.getAttribute('data-players');
        amountTouched = false; calc();
      });
    });
    sheet.querySelectorAll('[data-price]').forEach(function (b) {
      b.addEventListener('click', function () {
        priceEl.value = b.getAttribute('data-price');
        amountTouched = false; calc();
      });
    });

    if (!editing) { amountTouched = false; }
    calc();
    setPayMode(payMode);

    var delBtn = $('#delIncome', sheet);
    if (delBtn) delBtn.addEventListener('click', function () {
      var linked = Store.linkedTxCount(opts.incomeId);
      confirmDlg({
        title: '删除这场营收？',
        html: linked
          ? '这场在客户账上挂了 <b>' + linked + '</b> 笔欠款，会一并撤销，相关客户的余额跟着变。<br>删除后无法恢复。'
          : '删除后今日 / 本月营收会相应减少，且无法恢复。',
        okText: '删除', danger: true
      }).then(function (yes) {
        if (!yes) return;
        Store.deleteIncome(opts.incomeId);
        closeSheet();
        toast('已删除' + (linked ? '（同时撤销 ' + linked + ' 笔挂账）' : ''), 'ok');
        render();
      });
    });

    $('#saveIncome', sheet).addEventListener('click', function () {
      var n = parseInt(playersEl.value, 10) || 0;
      var p = parseFloat(priceEl.value) || 0;
      var a = parseFloat(amtEl.value);
      if (!(n > 0)) { toast('先填本场人数', 'err'); playersEl.focus(); return; }
      if (!(a > 0) && !(p > 0)) { toast('填每人收费或本场营业额', 'err'); priceEl.focus(); return; }
      if (!(a > 0)) a = Store.util.round2(n * p);

      // 收集挂账明细（同一位客户合并成一条）
      var useCredits = [], idx = {};
      if (payMode === 'credit') {
        credits.forEach(function (r) {
          if (!r.customerId) return;
          var fee = Store.util.round2(Number(r.fee) || 0);
          var cig = Store.util.round2(Number(r.cig) || 0);
          if (fee <= 0 && cig <= 0) return;
          if (idx[r.customerId] === undefined) {
            idx[r.customerId] = useCredits.length;
            useCredits.push({ customerId: r.customerId, fee: fee, cig: cig, cigName: r.cigName || '' });
          } else {
            var t = useCredits[idx[r.customerId]];
            t.fee = Store.util.round2(t.fee + fee);
            t.cig = Store.util.round2(t.cig + cig);
            if (!t.cigName) t.cigName = r.cigName || '';
          }
        });
      }
      var feeSum = 0, cigSum = 0;
      useCredits.forEach(function (r) { feeSum += r.fee; cigSum += r.cig; });
      feeSum = Store.util.round2(feeSum);
      cigSum = Store.util.round2(cigSum);
      if (feeSum > a + 0.004) {
        toast('挂账台费 ¥' + money(feeSum) + ' 超过了本场营业额 ¥' + money(a), 'err', 2600);
        return;
      }

      var info = {
        date: $('#incomeDate', sheet).value || today(new Date()),
        players: n, unitPrice: p, amount: a,
        note: $('#incomeNote', sheet).value.trim(),
        credits: useCredits
      };

      if (editing) {
        var hadLinked = Store.linkedTxCount(editing.id);
        Store.updateIncome(editing.id, info);
        if (!useCredits.length && hadLinked) toast('已更新，原先 ' + hadLinked + ' 笔挂账已撤销', 'ok', 2400);
        else toast('已更新' + (useCredits.length ? '，' + useCredits.length + ' 位客户的挂账已同步' : ''), 'ok', 2400);
      } else {
        Store.addIncome(info);
        var msg = '已记 ' + n + ' 人 × ' + money(p) + ' 元 = ¥' + money(a);
        if (feeSum > 0 || cigSum > 0) {
          msg += '，其中 ¥' + money(Store.util.round2(feeSum + cigSum)) + ' 挂到 ' + useCredits.length + ' 位客户账上';
        }
        toast(msg, 'ok', 2600);
      }
      closeSheet();
      render();
    });

    if (!editing) setTimeout(function () { playersEl.focus(); }, 320);
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
    var locked = global.Lock && Lock.isSet();

    var html =
      pageTitle('我的', null) +

      '<div class="section"><div class="section-head"><h2>安全</h2></div><div class="card">' +
      (locked
        ? '  <button class="list-item" id="changePin" type="button"><span class="li-ico">' + icon('lock', 21) + '</span>' +
          '    <span class="li-txt">修改密码<span class="li-desc">已开启密码锁，打开应用需输数字密码</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
          '  <button class="list-item" id="lockNow" type="button"><span class="li-ico">' + icon('moon', 21) + '</span>' +
          '    <span class="li-txt">立即锁定<span class="li-desc">锁屏，下次打开要重新输密码</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
          '  <button class="list-item" id="offPin" type="button"><span class="li-ico">' + icon('unlock', 21) + '</span>' +
          '    <span class="li-txt">关闭密码锁</span></button>'
        : '  <button class="list-item" id="setPin" type="button"><span class="li-ico">' + icon('lock', 21) + '</span>' +
          '    <span class="li-txt">开启密码锁<span class="li-desc">设 4-6 位数字密码，别人拿到网址也看不了账</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>') +
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

      '<div class="section"><div class="section-head"><h2>客户名单</h2></div><div class="card">' +
      '  <button class="list-item" id="impNames" type="button"><span class="li-ico">' + icon('usersAdd', 21) + '</span>' +
      '    <span class="li-txt">批量导入客户<span class="li-desc">粘贴名单，一行一个：姓名,电话,备注</span></span><span class="li-arrow">' + icon('chev', 18) + '</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>危险操作</h2></div><div class="card">' +
      '  <button class="list-item danger" id="clearAll" type="button"><span class="li-ico">' + icon('broom', 21) + '</span>' +
      '    <span class="li-txt">清空全部数据</span></button>' +
      '</div></div>' +

      '<div class="section"><div class="section-head"><h2>关于</h2></div><div class="card">' +
      '  <div class="list-item" style="cursor:default"><span class="li-ico">' + icon('info', 21) + '</span>' +
      '    <span class="li-txt">往来账 v' + VERSION + '<span class="li-desc">所有数据仅保存在本机浏览器中，不会上传到任何服务器。建议定期用「导出备份」存档。</span></span></div>' +
      '</div></div>';

    view.innerHTML = html;

    /* --- 密码锁 --- */
    var setPinBtn = $('#setPin');
    if (setPinBtn) setPinBtn.addEventListener('click', function () {
      Lock.openSetup({ mode: 'set', onDone: function (msg) { toast(msg, 'ok'); render(); } });
    });
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
    var offPinBtn = $('#offPin');
    if (offPinBtn) offPinBtn.addEventListener('click', function () {
      Lock.openSetup({
        mode: 'off',
        onDone: function (msg) { toast(msg, 'ok'); render(); }
      });
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
    $('#clearAll').addEventListener('click', function () {
      confirmDlg({
        title: '清空全部数据？',
        text: '所有客户、流水、营收都会被删除且无法恢复。建议先「导出备份」。',
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
    var sheet = openSheet(
      sheetHead(c ? '编辑客户' : '新建客户') +
      '<div class="sheet-body">' +
      '  <div class="field"><label>姓名 / 外号 *</label>' +
      '    <input class="input" id="cName" maxlength="20" placeholder="怎么顺口怎么叫" value="' + esc(c ? c.name : '') + '"></div>' +
      '  <div class="field"><label>电话（可不填）</label>' +
      '    <input class="input" id="cPhone" type="tel" inputmode="tel" maxlength="20" placeholder="催款用" value="' + esc(c ? c.phone : '') + '"></div>' +
      '  <div class="field"><label>备注（可不填）</label>' +
      '    <input class="input" id="cNote" maxlength="60" placeholder="比如：熟客，每周三来" value="' + esc(c ? c.note : '') + '"></div>' +
      '</div>' +
      '<div class="sheet-foot">' +
      (c ? '<div class="btn-row" style="margin-bottom:10px"><button class="btn btn-danger" id="delCust" type="button">' + icon('trash', 18) + '删除客户</button></div>' : '') +
      '  <button class="btn btn-primary" id="saveCust" type="button">保存</button>' +
      '</div>'
    );

    setTimeout(function () { $('#cName', sheet).focus(); }, 320);

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

    $('#saveCust', sheet).addEventListener('click', function () {
      var name = $('#cName', sheet).value.trim();
      if (!name) { toast('姓名总得有一个', 'err'); $('#cName', sheet).focus(); return; }
      var dup = Store.findCustomerByName(name);
      if (dup && (!c || dup.id !== c.id)) { toast('已经有这位客户了', 'err'); return; }
      var info = { name: name, phone: $('#cPhone', sheet).value.trim(), note: $('#cNote', sheet).value.trim() };
      if (c) Store.updateCustomer(c.id, info);
      else Store.addCustomer(info);
      closeSheet();
      toast('已保存', 'ok');
      render();
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

    // PWA：https / localhost 下注册离线缓存
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW 注册失败（不影响使用）', e); });
    }
  }

  if (global.Lock && Lock.isSet() && !Lock.isUnlocked()) {
    // 设了密码锁且本机未记住：先上锁，解锁后再启动
    document.body.classList.add('locked');
    Lock.showLockScreen(bootApp);
  } else {
    bootApp();
  }

})(window);
