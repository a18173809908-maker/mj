/* ==========================================================================
   store.js — 数据层
   所有数据保存在手机本机（localStorage），不上传任何服务器。
   数据模型：
     customer = { id, name, phone, note, createdAt, updatedAt }
     tx       = { id, customerId, type:'owe'|'paid', category:'fee'|'cig'|'loan'|'other',
                  amount, date:'YYYY-MM-DD', note, incomeId, createdAt }
       type = 'owe'  记欠款（他欠我的钱增加）
       type = 'paid' 收回（他欠我的钱减少）
       category: fee=台费茶水  cig=代买烟  loan=借款/还借款  other=其他
       incomeId: 属于哪一场牌（借款、挂账台费、代买烟都挂在产生它的那场下面）
     余额 = Σ owe − Σ paid    正数=他欠我；负数=我欠他

     session（历史上叫 income）= 一场牌，是有生命周期的作业单元
       { id, date, players, unitPrice, amount, feeMode, status,
         openAt, closeAt, tableNo, note, createdAt }
         status: 'open' 开台中（人还在打） | 'closed' 已收台
         feeMode: 'separate' 台费单独收 | 'netting' 台费从借款里扣（借 500 扣 20 实拿 480）
         players = 上桌人数，只认 3 或 4（一场牌就这两种，没有别的选项）；
        amount = 本场台费总额（默认按上桌的人各自台费相加，可手改）
       场里发生的借款/还款/挂账台费/代买烟，真相只有一份——全在流水 tx 里，
       用 incomeId 指回这场牌；不在场次上另存，从根上避免两边对不上。
       口径：amount = 本场台费收入（营业额，含赊账）；
             Σ category='loan' 的 owe/paid = 这场借出去/收回来的钱（往来款，不是收入）；
             Σ category='cig' = 代买烟赊账（老板垫付，不计入营业额）
     settings.cigs = [{ id, name, price }]   常用烟品价目（快捷记账用）
   ========================================================================== */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ledger_mahjong_v1';

  /* ---------- 工具 ---------- */

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** 本地日期 → 'YYYY-MM-DD' */
  function toDateStr(d) {
    d = d instanceof Date ? d : new Date(d || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 'YYYY-MM-DD' → Date（当地时间零点，避免时区偏移） */
  function parseDate(s) {
    if (!s) return new Date();
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /** 金额保留两位小数，规避浮点误差 */
  function round2(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

/** 上桌人数只认 3 / 4：3 人以下按 3 人，4 人以上按 4 人 */
function fixHead(n) {
  return (Number(n) || 4) > 3 ? 4 : 3;
}

/** 'YYYY-MM-DD' → '今天 · 周二' 之类的友好展示 */
function humanDate(s) {
    var d = parseDate(s);
    var w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    var today = toDateStr(new Date());
    var y = toDateStr(new Date(Date.now() - 86400000));
    if (s === today) return '今天 · ' + w;
    if (s === y) return '昨天 · ' + w;
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return (sameYear ? '' : d.getFullYear() + '年') + (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + w;
  }

  /** 时间戳/日期 → 'HH:MM'（无时间信息时返回空串） */
  function hmTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  /** 台号自动编号：日期 + 时间，比如「9月16日 17:20」——省得老板自己起名 */
  function autoTableNo(ts) {
    var d = new Date(Number(ts) || Date.now());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 金额格式化：1234.5 → '1,234.5'；整数不带小数点 */
  function money(n) {
    n = round2(n);
    var neg = n < 0;
    var abs = Math.abs(n);
    var s = abs.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  var CATEGORY_LABEL = { fee: '台费', cig: '烟钱', loan: '借款', other: '其他' };
  function normCategory(c) { return (c === 'cig' || c === 'other' || c === 'loan') ? c : 'fee'; }

  /** 开台借款的默认额（老板可在开台时单改） */
  var DEFAULT_STAKE = 500;

  /* 默认烟品价目（老板可在「我的」里改名改价） */
  function defaultCigs() {
    return [
      { id: uid('cg'), name: '10元烟', price: 10 },
      { id: uid('cg'), name: '13元烟', price: 13 },
      { id: uid('cg'), name: '20元烟', price: 20 },
      { id: uid('cg'), name: '23元烟', price: 23 },
      { id: uid('cg'), name: '45元烟', price: 45 }
    ];
  }

  /* ---------- Store ---------- */

  var Store = {
    data: { version: 2, customers: [], txs: [], incomes: [], transfers: [], settings: {} },

    /* ---------- 持久化 ---------- */

    load: function () {
      this._loading = true;
      try {
        return this._load();
      } finally {
        this._loading = false;
      }
    },

    _load: function () {
      var raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* 隐私模式 */ }
      if (raw) {
        try {
          var p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            this.data.customers = Array.isArray(p.customers) ? p.customers : [];
            this.data.txs = Array.isArray(p.txs) ? p.txs : [];
            this.data.incomes = Array.isArray(p.incomes) ? p.incomes : [];
            this.data.transfers = Array.isArray(p.transfers) ? p.transfers : [];
            this.data.settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
            this.data.version = p.version || 2;
          }
        } catch (e) {
          console.error('[store] 数据解析失败，已忽略损坏的存档', e);
        }
      }
      this.migrate();
      // 数据自愈：剔除指向不存在客户的流水
      var ids = {};
      this.data.customers.forEach(function (c) { ids[c.id] = 1; });
      var before = this.data.txs.length;
      this.data.txs = this.data.txs.filter(function (t) { return ids[t.customerId]; });
      if (this.data.txs.length !== before) this.save();
      return this.data;
    },

    /** 老数据补齐新字段 */
    migrate: function () {
      var changed = false;
      var self = this;
      if (!Array.isArray(this.data.transfers)) { this.data.transfers = []; changed = true; }
      // v2.2 的「老场次补确认」只做一次
      var needSeed = !(this.data.settings && this.data.settings.feeCheckedSeed === true);
      // v2.2 用得到：场次 → 这场出现过的人
      var bySession = {};
      this.data.txs.forEach(function (t) {
        if (!t.incomeId) return;
        (bySession[t.incomeId] || (bySession[t.incomeId] = {}))[t.customerId] = 1;
      });
      this.data.txs.forEach(function (t) {
        if (!t.category) { t.category = 'fee'; changed = true; }
      });
      this.data.incomes.forEach(function (i) {
        if (i.players === undefined) { i.players = 1; changed = true; }
        if (i.unitPrice === undefined) { i.unitPrice = round2(i.amount); changed = true; }
        // v1.4：一场牌有生命周期（开台中 / 已收台）+ 台费收法；老记录一律视为已收台
        if (i.status !== 'open' && i.status !== 'closed') { i.status = 'closed'; changed = true; }
        if (i.feeMode !== 'netting' && i.feeMode !== 'separate') { i.feeMode = 'separate'; changed = true; }
        if (i.openAt === undefined) { i.openAt = i.createdAt || Date.now(); changed = true; }
        if (i.closeAt === undefined) { i.closeAt = i.status === 'closed' ? (i.openAt || Date.now()) : null; changed = true; }
        if (i.tableNo === undefined) { i.tableNo = ''; changed = true; }
        // v2.2：台费默认从「已收」改成了「待确认」。**升级前就收过台的老场次**一律视为
        // 当时已经过过一遍，补进 feeChecked，免得翻开历史账看到满屏「待确认」。
        // 只补这一次（靠 settings.feeCheckedSeed 认门）——否则新版里万一有没收尾的场次，
        // 刷新一下就会被悄悄补成「已收」，等于又变回默认已收了。
        if (needSeed && i.status === 'closed') {
          if (!i.feeChecked || typeof i.feeChecked !== 'object') { i.feeChecked = {}; changed = true; }
          var seen = bySession[i.id] || {};
          Object.keys(seen).forEach(function (cid) {
            if (!i.feeChecked[cid]) { i.feeChecked[cid] = 1; changed = true; }
          });
          if (i.feeMap && typeof i.feeMap === 'object') {
            Object.keys(i.feeMap).forEach(function (cid) {
              if (!i.feeChecked[cid]) { i.feeChecked[cid] = 1; changed = true; }
            });
          }
        }
      });
      if (needSeed) { this.data.settings.feeCheckedSeed = true; changed = true; }
      // 老流水没有 incomeId 字段，补上以免被误判为营收生成
      this.data.txs.forEach(function (t) {
        if (t.incomeId === undefined) { t.incomeId = null; changed = true; }
      });
      if (!Array.isArray(this.data.settings.cigs) || !this.data.settings.cigs.length) {
        this.data.settings.cigs = defaultCigs();
        changed = true;
      }
      // v2.2.4：老版本「收的钱比欠的多」会记成「多还」（余额变负）。那其实不是多还，
      // 是客户赢了别的客户的钱、要现金/微信转给他。这些负余额一次性剥离成「待转账」条目，
      // 同时把多收的那一截从 paid 流水里削掉——余额从此不再出现负值。只做一次。
      if (!(this.data.settings && this.data.settings.transferSeed === true)) {
        var balMap = {};
        this.data.txs.forEach(function (t) {
          balMap[t.customerId] = round2((balMap[t.customerId] || 0) + (t.type === 'paid' ? -1 : 1) * Number(t.amount || 0));
        });
        Object.keys(balMap).forEach(function (cid) {
          var bal = balMap[cid];
          if (!(bal < -0.004)) return;
          var left = round2(-bal);                     // 要剥出来的总额
          var mine = self.data.txs.filter(function (t) { return t.customerId === cid && t.type === 'paid'; });
          mine.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          for (var i = 0; i < mine.length && left > 0.004; i++) {
            var t2 = mine[i];
            var cut = Math.min(round2(Number(t2.amount || 0)), left);
            if (!(cut > 0)) continue;
            t2.amount = round2(Number(t2.amount) - cut);
            if (!(t2.amount > 0)) t2.amount = 0;        // 削干净了，下面统一剔掉
            left = round2(left - cut);
            changed = true;
          }
          self.data.txs = self.data.txs.filter(function (t) { return !(t.type === 'paid' && !(Number(t.amount) > 0)); });
          var stripped = round2(-bal - left);
          if (stripped > 0.004) {
            self.data.transfers.push({
              id: uid('x'),
              customerId: cid,
              amount: stripped,
              date: toDateStr(new Date()),
              sessionId: null,
              note: '旧版「多还」转过来的',
              status: 'pending',
              method: '',
              doneAt: null,
              createdAt: Date.now()
            });
          }
        });
        this.data.settings.transferSeed = true;
        changed = true;
      }
      if (changed) this.save();
    },

    /** 载入/应用远端数据期间为 true：此时 save() 不算"用户改动"，不上传云端 */
    _loading: false,

    save: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        // 通知云同步：本机有改动（载入过程与云端覆盖过程除外）
        if (!this._loading && global.Cloud && typeof Cloud.onLocalChange === 'function') {
          try { Cloud.onLocalChange(); } catch (e) {}
        }
        return true;
      } catch (e) {
        console.error('[store] 保存失败', e);
        return false;
      }
    },

    /**
     * 用云端数据覆盖本机（同步拉取 / 版本回滚时调用）
     * 与 importJSON(replace) 的区别：不触发云端上传，且做了自愈清理
     */
    applyRemote: function (data) {
      if (!data || typeof data !== 'object') return false;
      this._loading = true;
      try {
        this.data.customers = Array.isArray(data.customers) ? data.customers : [];
        this.data.txs = Array.isArray(data.txs) ? data.txs : [];
        this.data.incomes = Array.isArray(data.incomes) ? data.incomes : [];
        this.data.settings = (data.settings && typeof data.settings === 'object') ? data.settings : {};
        this.data.version = data.version || 2;
        this.migrate();
        // 自愈：剔除指向不存在客户的流水
        var ids = {};
        this.data.customers.forEach(function (c) { ids[c.id] = 1; });
        this.data.txs = this.data.txs.filter(function (t) { return ids[t.customerId]; });
        this.save();
      } finally {
        this._loading = false;
      }
      return true;
    },

    /** 数据条数（云端状态展示用） */
    counts: function () {
      return {
        customers: this.data.customers.length,
        txs: this.data.txs.length,
        incomes: this.data.incomes.length
      };
    },

    /* ---------- 客户 ---------- */

    listCustomers: function () {
      return this.data.customers.slice();
    },

    getCustomer: function (id) {
      for (var i = 0; i < this.data.customers.length; i++) {
        if (this.data.customers[i].id === id) return this.data.customers[i];
      }
      return null;
    },

    findCustomerByName: function (name) {
      name = String(name || '').trim();
      if (!name) return null;
      for (var i = 0; i < this.data.customers.length; i++) {
        if (this.data.customers[i].name === name) return this.data.customers[i];
      }
      return null;
    },

    addCustomer: function (info) {
      var now = Date.now();
      var c = {
        id: uid('c'),
        name: String(info.name || '').trim(),
        phone: String(info.phone || '').trim(),
        note: String(info.note || '').trim(),
        createdAt: now,
        updatedAt: now
      };
      if (!c.name) return null;
      this.data.customers.push(c);
      this.save();
      return c;
    },

    updateCustomer: function (id, patch) {
      var c = this.getCustomer(id);
      if (!c) return null;
      ['name', 'phone', 'note'].forEach(function (k) {
        if (patch[k] !== undefined) c[k] = String(patch[k]).trim();
      });
      c.updatedAt = Date.now();
      this.save();
      return c;
    },

    /** 删除客户，同时删除其全部流水 */
    deleteCustomer: function (id) {
      var n = this.data.customers.length;
      this.data.customers = this.data.customers.filter(function (c) { return c.id !== id; });
      if (this.data.customers.length === n) return false;
      this.data.txs = this.data.txs.filter(function (t) { return t.customerId !== id; });
      this.save();
      return true;
    },

    /* ---------- 流水（客户往来） ---------- */

    listTxs: function (filter) {
      filter = filter || {};
      var out = this.data.txs.slice();
      if (filter.customerId) {
        out = out.filter(function (t) { return t.customerId === filter.customerId; });
      }
      if (filter.from) out = out.filter(function (t) { return t.date >= filter.from; });
      if (filter.to) out = out.filter(function (t) { return t.date <= filter.to; });
      if (filter.type) out = out.filter(function (t) { return t.type === filter.type; });
      if (filter.category) out = out.filter(function (t) { return normCategory(t.category) === filter.category; });
      if (filter.keyword) {
        var kw = String(filter.keyword).toLowerCase();
        out = out.filter(function (t) {
          var c = Store.getCustomer(t.customerId);
          var hay = ((c && c.name) || '') + ' ' + (t.note || '') + ' ' + CATEGORY_LABEL[normCategory(t.category)];
          return hay.toLowerCase().indexOf(kw) >= 0;
        });
      }
      // 业务日期倒序；同一天按录入时间倒序
      out.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return out;
    },

    getTx: function (id) {
      for (var i = 0; i < this.data.txs.length; i++) {
        if (this.data.txs[i].id === id) return this.data.txs[i];
      }
      return null;
    },

    addTx: function (info) {
      var amount = round2(info.amount);
      if (!(amount > 0)) return null;
      var t = {
        id: uid('t'),
        customerId: info.customerId,
        type: info.type === 'paid' ? 'paid' : 'owe',
        category: normCategory(info.category),
        amount: amount,
        date: info.date || toDateStr(new Date()),
        note: String(info.note || '').trim(),
        createdAt: Date.now()
      };
      if (!this.getCustomer(t.customerId)) return null;
      this.data.txs.push(t);
      this.save();
      return t;
    },

    updateTx: function (id, patch) {
      var t = this.getTx(id);
      if (!t) return null;
      if (patch.amount !== undefined) {
        var a = round2(patch.amount);
        if (a > 0) t.amount = a;
      }
      if (patch.type !== undefined) t.type = patch.type === 'paid' ? 'paid' : 'owe';
      if (patch.category !== undefined) t.category = normCategory(patch.category);
      if (patch.date !== undefined) t.date = patch.date;
      if (patch.note !== undefined) t.note = String(patch.note).trim();
      if (patch.customerId !== undefined && this.getCustomer(patch.customerId)) t.customerId = patch.customerId;
      this.save();
      return t;
    },

    deleteTx: function (id) {
      var n = this.data.txs.length;
      this.data.txs = this.data.txs.filter(function (t) { return t.id !== id; });
      if (this.data.txs.length === n) return false;
      this.save();
      return true;
    },

    /* ---------- 待转账（客户赢了别人的钱，要现金/微信转给他） ---------- */

    getTransfer: function (id) {
      var list = this.data.transfers || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    },

    /** 待转账清单：待转的在前，已转的沉到后面（各自按日期倒序） */
    listTransfers: function (status) {
      var out = (this.data.transfers || []).slice();
      if (status) out = out.filter(function (x) { return x.status === status; });
      out.sort(function (a, b) {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return out;
    },

    /** 某客户还有多少没转给他 */
    pendingTransferOf: function (customerId) {
      var s = 0;
      (this.data.transfers || []).forEach(function (x) {
        if (x.status === 'pending' && x.customerId === customerId) s += Number(x.amount || 0);
      });
      return round2(s);
    },

    /** 一共还欠着要转出去多少 */
    pendingTransferTotal: function () {
      var s = 0;
      (this.data.transfers || []).forEach(function (x) {
        if (x.status === 'pending') s += Number(x.amount || 0);
      });
      return round2(s);
    },

    pendingTransferCount: function () {
      return (this.data.transfers || []).filter(function (x) { return x.status === 'pending'; }).length;
    },

    /** 登记一笔「待转给客户」：他赢了别人的钱，现金/微信要转给他 */
    addTransfer: function (info) {
      var amount = round2(info.amount);
      if (!(amount > 0)) return null;
      if (!this.getCustomer(info.customerId)) return null;
      if (!Array.isArray(this.data.transfers)) this.data.transfers = [];
      var x = {
        id: uid('x'),
        customerId: info.customerId,
        amount: amount,
        date: info.date || toDateStr(new Date()),
        sessionId: info.sessionId || null,
        note: String(info.note || '').trim(),
        status: 'pending',
        method: '',
        doneAt: null,
        createdAt: Date.now()
      };
      this.data.transfers.push(x);
      this.save();
      return x;
    },

    /** 转给他了（现金 / 微信） */
    markTransferDone: function (id, method) {
      var x = this.getTransfer(id);
      if (!x) return null;
      x.status = 'done';
      x.method = (method === 'cash' || method === 'wechat') ? method : 'other';
      x.doneAt = Date.now();
      this.save();
      return x;
    },

    /** 点错了：撤回成「待转」 */
    undoTransferDone: function (id) {
      var x = this.getTransfer(id);
      if (!x) return null;
      x.status = 'pending';
      x.method = '';
      x.doneAt = null;
      this.save();
      return x;
    },

    deleteTransfer: function (id) {
      var n = (this.data.transfers || []).length;
      this.data.transfers = (this.data.transfers || []).filter(function (x) { return x.id !== id; });
      if (this.data.transfers.length === n) return false;
      this.save();
      return true;
    },

    /**
     * 收他的钱（收欠款 / 牌面收款）。**多的那截不算「多还」**——那是他赢了别的客户的钱，
     * 自动进「待转账」，回头现金/微信转给他。欠款最多收到 0，余额不再出现负值。
     * 返回 { paid, transfer }：这次多少抵了欠款、多少变成了要转给他的钱。
     */
    settlePay: function (info) {
      var amt = round2(info.amount);
      if (!(amt > 0)) return { paid: 0, transfer: 0 };
      var cust = this.getCustomer(info.customerId);
      if (!cust) return { paid: 0, transfer: 0 };
      // cap：这笔钱最多能抵掉多少欠款（牌面收款只抵这一场，客户页收款抵全部欠款）
      var bal = Math.max(0, this.balanceOf(cust.id));
      var cap = (info.cap === undefined || info.cap === null) ? bal : Math.max(0, Number(info.cap));
      var owed = Math.min(cap, bal);
      var paid = round2(Math.min(amt, owed));
      var extra = round2(amt - paid);
      if (paid > 0) {
        if (info.sessionId) {
          this.addSessionTx(info.sessionId, {
            customerId: cust.id, type: 'paid', category: info.category || 'loan',
            amount: paid, date: info.date, note: info.note
          });
        } else {
          this.addTx({
            customerId: cust.id, type: 'paid', category: info.category,
            amount: paid, date: info.date, note: info.note
          });
        }
      }
      var item = null;
      if (extra > 0.004) {
        item = this.addTransfer({
          customerId: cust.id, amount: extra, date: info.date,
          sessionId: info.sessionId || null, note: info.note
        });
      }
      return { paid: paid, transfer: extra, transferItem: item };
    },

    /* ---------- 营业收入 ---------- */

    listIncomes: function (filter) {
      filter = filter || {};
      var out = this.data.incomes.slice();
      if (filter.from) out = out.filter(function (i) { return i.date >= filter.from; });
      if (filter.to) out = out.filter(function (i) { return i.date <= filter.to; });
      if (filter.status) out = out.filter(function (i) { return (i.status || 'closed') === filter.status; });
      out.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return out;
    },

    /** 正在开的台（按开台时间正序：打得最久的排最前） */
    openSessions: function () {
      return this.data.incomes
        .filter(function (i) { return i.status === 'open'; })
        .sort(function (a, b) { return (a.openAt || a.createdAt || 0) - (b.openAt || b.createdAt || 0); });
    },

    getIncome: function (id) {
      for (var i = 0; i < this.data.incomes.length; i++) {
        if (this.data.incomes[i].id === id) return this.data.incomes[i];
      }
      return null;
    },

    /* ---------- 一场牌：开台 / 局中借还 / 收台 ---------- */

    /** 语义别名（"一场牌"） */
    getSession: function (id) { return this.getIncome(id); },
    listSessions: function (filter) { return this.listIncomes(filter); },

    /** 这场牌关联的全部流水（按发生时间正序） */
    sessionTxs: function (sessionId) {
      var self = this;
      return this.data.txs
        .filter(function (t) { return t.incomeId === sessionId; })
        .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
        .map(function (t) {
          var c = self.getCustomer(t.customerId);
          return {
            id: t.id, customerId: t.customerId, name: c ? c.name : '（已删除）',
            type: t.type === 'paid' ? 'paid' : 'owe', category: normCategory(t.category),
            amount: round2(t.amount || 0), note: t.note || '', createdAt: t.createdAt || 0
          };
        });
    },

    /** 这场牌每位玩家的借贷小计（谁借了多少、还了多少、这场给他留下多少欠款） */
    sessionPlayers: function (sessionId) {
      var self = this, m = {}, order = [];
      var s = this.getIncome(sessionId);
      var feeMap = (s && s.feeMap) || {};

      function ensure(cid) {
        if (m[cid]) return m[cid];
        var c = self.getCustomer(cid);
        m[cid] = {
          customerId: cid, name: c ? c.name : '（已删除）',
          phone: c ? (c.phone || '') : '',
          loanOut: 0, loanBack: 0, credit: 0, cig: 0
        };
        order.push(cid);
        return m[cid];
      }

      this.data.txs.forEach(function (t) {
        if (t.incomeId !== sessionId) return;
        var r = ensure(t.customerId);
        var cat = normCategory(t.category), amt = Number(t.amount || 0);
        if (t.type === 'paid') {
          r.loanBack += amt;                 // 还借款 / 还挂账，都算他还进来的钱
        } else if (cat === 'loan') {
          r.loanOut += amt;                  // 借出去的本金
        } else {
          r.credit += amt;                   // 挂在这场的台费 / 烟钱
          if (cat === 'cig') r.cig += amt;
        }
      });

      // 只上桌、既没借钱也没挂账的人，也要出现在名单里
      Object.keys(feeMap).forEach(function (cid) { ensure(cid); });

      return order.map(function (k) {
        var r = m[k];
        r.loanOut = round2(r.loanOut); r.loanBack = round2(r.loanBack);
        r.credit = round2(r.credit); r.cig = round2(r.cig);
        // 每人台费：开台时单独设过就用自己的，没设过就回退到整场的每人单价
        r.fee = feeMap[k] !== undefined ? round2(feeMap[k]) : round2(s ? s.unitPrice : 0);
        r.net = round2(r.loanOut + r.credit - r.loanBack);
        return r;
      }).sort(function (a, b) {
        if (b.net !== a.net) return b.net - a.net;
        return a.name.localeCompare(b.name, 'zh');
      });
    },

    /**
     * 最近上过桌的客人（按场次开台时间倒序去重），开台时用来一键加人。
     * 只认还存在于客户名单里的客户。
     */
    recentPlayers: function (limit) {
      limit = limit || 8;
      var self = this, seen = {}, out = [];
      this.data.incomes.slice().sort(function (a, b) {
        return (b.openAt || b.createdAt || 0) - (a.openAt || a.createdAt || 0);
      }).forEach(function (s) {
        if (out.length >= limit) return;
        self.data.txs.forEach(function (t) {
          if (out.length >= limit) return;
          if (t.incomeId !== s.id || seen[t.customerId]) return;
          var c = self.getCustomer(t.customerId);
          if (!c) return;
          seen[t.customerId] = 1;
          out.push(c);
        });
      });
      return out;
    },

    /**
     * 常客榜：按「上桌次数」从多到少排，次数一样看谁最近来过。
     * 开台页「常来的」用它——打得最多的人永远在最前面，一眼就能点到。
     */
    frequentPlayers: function (limit, excludeIds) {
      limit = limit || 14;
      var self = this;
      var skip = {};
      (excludeIds || []).forEach(function (id) { skip[id] = 1; });
      var stat = {};
      this.data.incomes.forEach(function (s) {
        var when = s.openAt || s.createdAt || 0;
        var seenInSession = {};
        self.data.txs.forEach(function (t) {
          if (t.incomeId !== s.id || seenInSession[t.customerId]) return;
          seenInSession[t.customerId] = 1;
          var r = stat[t.customerId] || (stat[t.customerId] = { count: 0, last: 0 });
          r.count++;
          if (when > r.last) r.last = when;
        });
      });
      var out = [];
      Object.keys(stat).forEach(function (id) {
        if (skip[id]) return;
        var c = self.getCustomer(id);
        if (!c) return;
        out.push({ c: c, count: stat[id].count, last: stat[id].last });
      });
      out.sort(function (a, b) {
        return (b.count - a.count) || (b.last - a.last);
      });
      return out.slice(0, limit).map(function (r) { return r.c; });
    },

    /** 这场牌的钱账汇总 */
    sessionSummary: function (sessionOrId) {
      var s = typeof sessionOrId === 'string' ? this.getIncome(sessionOrId) : sessionOrId;
      if (!s) return null;
      var loanOut = 0, loanBack = 0, creditFee = 0, creditCig = 0;
      this.data.txs.forEach(function (t) {
        if (t.incomeId !== s.id) return;
        var cat = normCategory(t.category), amt = Number(t.amount || 0);
        if (t.type === 'paid') { loanBack += amt; return; }
        if (cat === 'loan') { loanOut += amt; return; }
        creditFee += amt;
        if (cat === 'cig') creditCig += amt;
      });
      var feeMode = s.feeMode === 'netting' ? 'netting' : 'separate';
      var fee = round2(s.amount || 0);
      var creditFeeOnly = round2(creditFee - creditCig);

      // v2.2：台费默认不再是「已收」，而是「待确认」。
      // 老板还没过这个人之前，这笔钱既不当作收到、也不当作欠款——账面不许替他表态。
      var pending = this.feePendingFeeOf(s);

      return {
        fee: fee,
        feeMode: feeMode,
        creditFee: creditFeeOnly,                   // 赊掉的台费（还没收到的）
        creditCig: round2(creditCig),               // 赊掉的烟钱（代买垫付）
        credit: round2(creditFee),                  // 挂账合计
        feePending: pending,                        // 还没确认的台费（不知道收没收到）
        feePaid: round2(fee - creditFeeOnly - pending),  // 确认收到的台费（现金 + 从借款里扣）
        cashFee: feeMode === 'netting' ? 0 : round2(fee - creditFeeOnly - pending),
        deductFee: feeMode === 'netting' ? round2(fee) : 0,   // 开台时从借款里扣掉的台费
        loanOut: round2(loanOut),
        loanBack: round2(loanBack),
        netLoan: round2(loanOut - loanBack),
        // 这场老板净掏出去多少现金 = 借出 − 收回 − 从借款里抵扣的台费
        cashOut: round2(loanOut - loanBack - (feeMode === 'netting' ? fee : 0))
      };
    },

    /**
     * 某场还没确认的台费合计。
     * 「没确认」＝ 老板还没点过这个人，且这人也没挂账（挂账本身就等于表过态）。
     * 这笔钱不算已收、也不算欠款，只是悬着——避免账面替老板宣布「收到了」。
     */
    feePendingFeeOf: function (sessionOrId) {
      var s = typeof sessionOrId === 'string' ? this.getIncome(sessionOrId) : sessionOrId;
      if (!s) return 0;
      if (s.feeMode === 'netting') return 0;      // 开台时就从借款里扣了，不存在待确认
      var credited = {}, pending = 0;
      this.data.txs.forEach(function (t) {
        if (t.incomeId === s.id && t.type === 'owe' && normCategory(t.category) === 'fee') credited[t.customerId] = 1;
      });
      this.sessionPlayers(s.id).forEach(function (p) {
        if (!(p.fee > 0)) return;
        if (credited[p.customerId]) return;                            // 挂账＝已经过过了
        if (s.feeChecked && s.feeChecked[p.customerId]) return;        // 明确标过收到
        pending += p.fee;
      });
      return round2(pending);
    },

    /** 局中/收台时：给某位玩家记一笔借款（owe）或还款（paid） */
    addSessionTx: function (sessionId, info) {
      var s = this.getIncome(sessionId);
      if (!s) return null;
      var t = this.addTx({
        customerId: info.customerId,
        type: info.type === 'paid' ? 'paid' : 'owe',
        category: info.category || 'loan',
        amount: info.amount,
        date: info.date || s.date || toDateStr(new Date()),
        note: info.note || ''
      });
      if (!t) return null;
      t.incomeId = sessionId;
      this.save();
      return t;
    },

    /**
     * 收台时：把某位玩家的台费标成 'cash' 收到了 / 'credit' 记他账上 / 'pending' 还没定。
     * 金额真相永远只在流水里（挂账才写一笔 category='fee' 的欠款）；
     * 场次上的 feeChecked 只记「这个人我过过了」，不参与任何金额计算——
     * 所以真相始终只有一份，撤销挂账＝删掉那笔流水，人自然回到「已收」。
     */
    setFeeState: function (sessionId, customerId, state, amount) {
      var s = this.getIncome(sessionId);
      if (!s || !customerId) return false;
      if (state !== 'cash' && state !== 'credit' && state !== 'pending') return false;

      var amt;
      if (amount === undefined || amount === null) {
        var mine = null;
        this.sessionPlayers(sessionId).forEach(function (p) { if (p.customerId === customerId) mine = p; });
        amt = round2(mine ? mine.fee : 0);
      } else {
        amt = round2(amount);
      }

      // 先把这场这个人的台费挂账流水全撤掉，下面按需要重建
      var ids = {};
      this.data.txs.forEach(function (t) {
        if (t.incomeId === sessionId && t.customerId === customerId &&
          t.type === 'owe' && normCategory(t.category) === 'fee') ids[t.id] = 1;
      });
      if (Object.keys(ids).length) {
        this.data.txs = this.data.txs.filter(function (t) { return !ids[t.id]; });
      }

      if (!s.feeChecked || typeof s.feeChecked !== 'object') s.feeChecked = {};
      if (state === 'pending') delete s.feeChecked[customerId];
      else s.feeChecked[customerId] = 1;

      if (state === 'credit' && amt > 0) {
        this.data.txs.push({
          id: uid('t'), customerId: customerId, type: 'owe', category: 'fee',
          amount: amt, date: s.date, note: '台费 · 收台时记的',
          incomeId: sessionId, createdAt: Date.now()
        });
      }
      this.save();
      return true;
    },

    /** 兼容旧调用：on=true 记他账上，on=false 算收到 */
    setFeeCredit: function (sessionId, customerId, on, amount) {
      return this.setFeeState(sessionId, customerId, on ? 'credit' : 'cash', amount);
    },

    /**
     * 收台时改某位这场的台费金额（开台设错了、临时改价都在这改）。
     * 台费合计跟着重算 = 各人台费之和 + 没记名的人按单价补；
     * 已经挂账的，那笔欠款跟着校准。
     */
    setPlayerFee: function (sessionId, customerId, fee) {
      var s = this.getIncome(sessionId);
      if (!s || !customerId) return false;
      var v = round2(fee);
      if (!(v >= 0)) v = 0;
      if (!s.feeMap || typeof s.feeMap !== 'object') s.feeMap = {};
      s.feeMap[customerId] = v;

      var sum = 0, n = 0;
      Object.keys(s.feeMap).forEach(function (k) { sum += Number(s.feeMap[k]) || 0; n++; });
      var rest = Math.max(0, (Number(s.players) || 0) - n);
      s.amount = round2(sum + rest * round2(s.unitPrice));
      this.save();

      if (this.feeStateOf(sessionId, customerId) === 'credit') {
        this.setFeeState(sessionId, customerId, 'credit', v);   // 挂账金额跟着走
      }
      return true;
    },

    /** 场次上这位玩家的台费确认过没有（只看名单，不看钱） */
    feeCheckedOf: function (sessionId, customerId) {
      var s = this.getIncome(sessionId);
      if (!s || !s.feeChecked) return false;
      return !!s.feeChecked[customerId];
    },

    /**
     * 某位玩家这场台费的状态：
     *  'pending' 还没确认（老板还没过这个人）/ 'cash' 确认收到 /
     *  'deduct' 开台时就从借款里扣了 / 'credit' 记他账上
     */
    feeStateOf: function (sessionId, customerId) {
      var s = this.getIncome(sessionId);
      if (!s) return 'cash';
      var has = false;
      this.data.txs.forEach(function (t) {
        if (t.incomeId === sessionId && t.customerId === customerId &&
          t.type === 'owe' && normCategory(t.category) === 'fee') has = true;
      });
      if (has) return 'credit';
      if (s.feeMode === 'netting') return 'deduct';
      if (this.feeCheckedOf(sessionId, customerId)) return 'cash';
      return 'pending';
    },

    /** 这场台费还有几个人没确认（收台前必须清零） */
    feePendingCount: function (sessionId) {
      var self = this, n = 0, s = this.getIncome(sessionId);
      if (!s || s.feeMode === 'netting') return 0;
      this.sessionPlayers(sessionId).forEach(function (p) {
        if (p.fee > 0 && self.feeStateOf(sessionId, p.customerId) === 'pending') n++;
      });
      return n;
    },

    /** 一键「这场台费全都收到了」：把还没确认的人全部标成收到 */
    confirmAllFees: function (sessionId) {
      var self = this, s = this.getIncome(sessionId);
      if (!s) return 0;
      var list = [];
      this.sessionPlayers(sessionId).forEach(function (p) {
        if (p.fee > 0 && self.feeStateOf(sessionId, p.customerId) === 'pending') list.push(p.customerId);
      });
      if (s.feeMode === 'netting') return 0;
      list.forEach(function (cid) { self.setFeeState(sessionId, cid, 'cash'); });
      return list.length;
    },

    /**
     * 没记名的上桌者还剩几位、还差多少台费。
     * 台费合计 − 已记名各位的台费 = 没记名那几位的（不表态就按「收到」算）。
     */
    unnamedFeeOf: function (sessionOrId) {
      var s = typeof sessionOrId === 'string' ? this.getIncome(sessionOrId) : sessionOrId;
      if (!s) return { count: 0, fee: 0 };
      if (s.feeMode === 'netting') return { count: 0, fee: 0 };
      var ps = this.sessionPlayers(s.id);
      var count = Math.max(0, (Number(s.players) || 0) - ps.length);
      if (!(count > 0)) return { count: 0, fee: 0 };
      var namedFee = 0;
      ps.forEach(function (p) { if (p.fee > 0) namedFee += p.fee; });
      var fee = round2(Math.max(0, Number(s.amount || 0) - namedFee));
      return { count: count, fee: fee };
    },

    /**
     * 没记名的人台费欠着：补个名字，把他那份台费挂到他账上。
     * 一次补一位（一场可以补多次）；补完他就成了「记名的人」，不再算在没记名的里头。
     */
    creditUnnamedFee: function (sessionId, name) {
      name = String(name || '').trim();
      if (!name) return null;
      var s = this.getIncome(sessionId);
      if (!s) return null;
      var left = this.unnamedFeeOf(s.id);
      if (!(left.count > 0) || !(left.fee > 0)) return null;
      var each = round2(left.fee / left.count);        // 没记名的几位均摊（通常就是每人单价）
      var c = this.findCustomerByName(name) || this.addCustomer({ name: name });
      if (!c) return null;
      if (!s.feeMap || typeof s.feeMap !== 'object') s.feeMap = {};
      s.feeMap[c.id] = each;
      this.save();
      this.setFeeState(s.id, c.id, 'credit', each);     // 挂到他账上（真相在流水里）
      return { customerId: c.id, name: c.name, fee: each };
    },

    /**
     * 开台。members = [{ customerId, stake, credit, cig, cigName }]
     *  stake = 开台借款额（0 = 自带现金、不用借）；credit/cig = 顺手挂在这场的台费 / 烟钱
     */
    openSession: function (info) {
      var now = Date.now();
      var members = (info.members || []).filter(function (m) { return m && m.customerId; });
      var headcount = fixHead(Number(info.players) || members.length || 4);
      var unitPrice = round2(info.unitPrice || 0);
      var amount = round2(info.amount);
      if (!(amount > 0)) amount = round2(headcount * unitPrice);

      var s = {
        id: uid('s'),
        date: info.date || toDateStr(new Date()),
        players: headcount,
        unitPrice: unitPrice,
        amount: amount,
        feeMode: info.feeMode === 'netting' ? 'netting' : 'separate',
        status: 'open',
        openAt: now,
        closeAt: null,
        tableNo: String(info.tableNo || '').trim() || autoTableNo(now),
        note: String(info.note || '').trim(),
        feeMap: {},                  // { customerId: 这位的台费 } —— 每人台费可以不一样
        createdAt: now
      };
      this.data.incomes.push(s);

      var self = this, seq = 0;
      members.forEach(function (m) {
        if (m.fee !== undefined && m.fee !== null && m.fee !== '') {
          s.feeMap[m.customerId] = round2(m.fee);
        }
        var stake = round2(m.stake);
        if (stake > 0) {
          self.data.txs.push({
            id: uid('t'), customerId: m.customerId, type: 'owe', category: 'loan',
            amount: stake, date: s.date, note: '开台借款',
            incomeId: s.id, createdAt: now + (seq++)
          });
        }
        if (round2(m.credit) > 0) {
          self.data.txs.push({
            id: uid('t'), customerId: m.customerId, type: 'owe', category: 'fee',
            amount: round2(m.credit), date: s.date, note: '台费 · 记在这场上',
            incomeId: s.id, createdAt: now + (seq++)
          });
        }
        if (round2(m.cig) > 0) {
          self.data.txs.push({
            id: uid('t'), customerId: m.customerId, type: 'owe', category: 'cig',
            amount: round2(m.cig), date: s.date,
            note: '代买烟' + (m.cigName ? ' · ' + m.cigName : '') + ' · 记在这场上',
            incomeId: s.id, createdAt: now + (seq++)
          });
        }
      });
      this.save();
      return s;
    },

    /** 收台 */
    closeSession: function (id) {
      var s = this.getIncome(id);
      if (!s) return null;
      s.status = 'closed';
      s.closeAt = Date.now();
      this.save();
      return s;
    },

    /** 重新开台（记错了，接着改） */
    reopenSession: function (id) {
      var s = this.getIncome(id);
      if (!s) return null;
      s.status = 'open';
      s.closeAt = null;
      this.save();
      return s;
    },

    /** 这场牌当前牌面余额（玩家欠款净额合计） */
    sessionNet: function (sessionId) {
      var n = 0;
      this.sessionPlayers(sessionId).forEach(function (p) { n += p.net; });
      return round2(n);
    },

    /** 清洗传入的赊账明细 → 只保留有效客户、正数金额 */
    normCredits: function (list) {
      var out = [];
      (list || []).forEach(function (r) {
        if (!r || !r.customerId) return;
        var fee = round2(r.fee || 0), cig = round2(r.cig || 0);
        if (fee <= 0 && cig <= 0) return;
        out.push({
          customerId: r.customerId,
          fee: fee > 0 ? fee : 0,
          cig: cig > 0 ? cig : 0,
          cigName: String(r.cigName || '').trim()
        });
      });
      return out;
    },

    /**
     * 某场营收的赊账明细。
     * 真相只有一份——就存在流水里（tx.incomeId 指回这场营收），
     * 不在营收上另存一份，从根上避免两边对不上。
     */
    creditsOf: function (incomeId) {
      var self = this;
      return this.data.txs.filter(function (t) {
        return t.incomeId === incomeId && t.type === 'owe' && normCategory(t.category) !== 'loan';
      }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
        .map(function (t) {
          var c = self.getCustomer(t.customerId);
          return {
            txId: t.id,
            customerId: t.customerId,
            name: c ? c.name : '（已删除）',
            category: normCategory(t.category),
            amount: round2(t.amount || 0),
            cigName: t.cigName || '',
            note: t.note || ''
          };
        });
    },

    /** 某场营收的赊账合计 { fee, cig } */
    creditSumOf: function (incomeId) {
      var fee = 0, cig = 0;
      this.creditsOf(incomeId).forEach(function (c) {
        if (c.category === 'cig') cig += c.amount; else fee += c.amount;
      });
      return { fee: round2(fee), cig: round2(cig) };
    },

    /** 现有赊账明细 → 可回灌给 syncIncomeTxs 的输入格式（按客户合并） */
    creditsInputOf: function (incomeId) {
      var m = {}, order = [];
      this.creditsOf(incomeId).forEach(function (c) {
        if (!m[c.customerId]) {
          m[c.customerId] = { customerId: c.customerId, fee: 0, cig: 0, cigName: '' };
          order.push(c.customerId);
        }
        if (c.category === 'cig') {
          m[c.customerId].cig += c.amount;
          if (!m[c.customerId].cigName && c.cigName) m[c.customerId].cigName = c.cigName;
        } else {
          m[c.customerId].fee += c.amount;
        }
      });
      return order.map(function (k) { return m[k]; });
    },

    /**
     * 按明细重建某场营收的关联欠款流水：先清空旧的，再照当前明细生成。
     * 台费走 category='fee'，烟钱走 category='cig'，都带 incomeId 便于溯源。
     */
    syncIncomeTxs: function (income, credits) {
      var self = this;
      // 只重建"挂在这场的台费/烟钱"；借款与还款流水是牌面的真实记录，原样保留
      this.data.txs = this.data.txs.filter(function (t) {
        return t.incomeId !== income.id || t.type === 'paid' || normCategory(t.category) === 'loan';
      });
      var now = Date.now(), seq = 0;
      this.normCredits(credits).forEach(function (c) {
        if (!self.getCustomer(c.customerId)) return;
        if (c.fee > 0) {
          self.data.txs.push({
            id: uid('t'), customerId: c.customerId, type: 'owe', category: 'fee',
            amount: c.fee, date: income.date,
            note: income.note ? ('台费 · ' + income.note) : '台费 · 记在这场上',
            incomeId: income.id, createdAt: now + (seq++)
          });
        }
        if (c.cig > 0) {
          self.data.txs.push({
            id: uid('t'), customerId: c.customerId, type: 'owe', category: 'cig',
            amount: c.cig, cigName: c.cigName, date: income.date,
            note: '代买烟' + (c.cigName ? ' · ' + c.cigName : '') + ' · 记在这场上',
            incomeId: income.id, createdAt: now + (seq++)
          });
        }
      });
    },

    addIncome: function (info) {
      var amount = round2(info.amount);
      if (!(amount > 0)) return null;
      var now = Date.now();
      var it = {
        id: uid('i'),
        date: info.date || toDateStr(new Date()),
        players: fixHead(Number(info.players) || 4),
        unitPrice: round2(info.unitPrice || 0),
        amount: amount,
        feeMode: info.feeMode === 'netting' ? 'netting' : 'separate',
        status: info.status === 'open' ? 'open' : 'closed',
        openAt: now,
        closeAt: info.status === 'open' ? null : now,
        tableNo: String(info.tableNo || '').trim(),
        note: String(info.note || '').trim(),
        createdAt: now
      };
      this.data.incomes.push(it);
      this.syncIncomeTxs(it, info.credits);
      this.save();
      return it;
    },

    updateIncome: function (id, patch) {
      var it = this.getIncome(id);
      if (!it) return null;
      var needSync = false;
      if (patch.date !== undefined && patch.date !== it.date) { it.date = patch.date; needSync = true; }
      if (patch.players !== undefined) it.players = Math.max(1, Number(patch.players) || 1);
      if (patch.unitPrice !== undefined) it.unitPrice = round2(patch.unitPrice || 0);
      if (patch.amount !== undefined) {
        var a = round2(patch.amount);
        if (a > 0) it.amount = a;
      }
      if (patch.note !== undefined && String(patch.note).trim() !== it.note) {
        it.note = String(patch.note).trim();
        needSync = true;
      }
      if (patch.tableNo !== undefined) it.tableNo = String(patch.tableNo).trim();
      if (patch.feeMode !== undefined) it.feeMode = patch.feeMode === 'netting' ? 'netting' : 'separate';
      // 明细显式传入就用新的；只改了日期/备注，则拿现有明细重建一遍让流水跟上
      if (patch.credits !== undefined) this.syncIncomeTxs(it, patch.credits);
      else if (needSync) this.syncIncomeTxs(it, this.creditsInputOf(it.id));
      this.save();
      return it;
    },

    deleteIncome: function (id) {
      var n = this.data.incomes.length;
      this.data.incomes = this.data.incomes.filter(function (i) { return i.id !== id; });
      if (this.data.incomes.length === n) return false;
      // 这场产生在客户账上的欠款也一并撤掉，避免留下孤儿流水
      this.data.txs = this.data.txs.filter(function (t) { return t.incomeId !== id; });
      this.save();
      return true;
    },

    /** 这场营收在客户账上挂了几笔、共多少钱 */
    linkedTxCount: function (incomeId) {
      var n = 0;
      this.data.txs.forEach(function (t) { if (t.incomeId === incomeId) n++; });
      return n;
    },

    /** 区间营收汇总：营业额 / 实收现金 / 赊账台费 / 赊账烟钱 */
    incomeStats: function (from, to) {
      var self = this;
      var total = 0, games = 0, players = 0, creditFee = 0, creditCig = 0, pendingFee = 0;
      this.data.incomes.forEach(function (i) {
        if (from && i.date < from) return;
        if (to && i.date > to) return;
        total += Number(i.amount || 0);
        games++;
        players += Number(i.players || 0);
        var cs = self.creditSumOf(i.id);
        creditFee += cs.fee;
        creditCig += cs.cig;
        pendingFee += self.feePendingFeeOf(i);      // 还没确认的台费（不算已收）
      });
      return {
        total: round2(total),
        games: games,
        players: players,
        creditFee: round2(creditFee),      // 这场赊掉的台费
        creditCig: round2(creditCig),      // 这场赊掉的烟钱（代买垫付）
        pending: round2(pendingFee),       // 台费还没确认的部分
        cash: round2(total - creditFee - pendingFee),   // 台费里确实收到了的现金
        avg: games ? round2(total / games) : 0,
        perHead: players ? round2(total / players) : 0
      };
    },

    /** 区间借贷统计：这场牌借出去多少、收回多少（往来款，不是营业收入） */
    loanStats: function (from, to) {
      var out = 0, back = 0, n = 0;
      var dateOf = {};
      this.data.incomes.forEach(function (i) { dateOf[i.id] = i.date; });
      this.data.txs.forEach(function (t) {
        if (normCategory(t.category) !== 'loan') return;
        var d = (t.incomeId && dateOf[t.incomeId]) || t.date;
        if (from && d < from) return;
        if (to && d > to) return;
        if (t.type === 'paid') back += Number(t.amount || 0);
        else { out += Number(t.amount || 0); n++; }
      });
      return { out: round2(out), back: round2(back), net: round2(out - back), count: n };
    },

    /** 区间内还在挂账的营收笔数（有人欠着这场的钱） */
    creditIncomeCount: function (from, to) {
      var self = this, n = 0;
      this.data.incomes.forEach(function (i) {
        if (from && i.date < from) return;
        if (to && i.date > to) return;
        var cs = self.creditSumOf(i.id);
        if (cs.fee > 0 || cs.cig > 0) n++;
      });
      return n;
    },

    /** 近 N 个月营收：[{ym,label,total,games}] */
    incomeMonthly: function (months) {
      months = months || 6;
      var now = new Date();
      var buckets = [], index = {};
      for (var i = months - 1; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var ym = d.getFullYear() + '-' + pad(d.getMonth() + 1);
        var b = { ym: ym, label: (d.getMonth() + 1) + '月', total: 0, games: 0 };
        buckets.push(b);
        index[ym] = b;
      }
      this.data.incomes.forEach(function (it) {
        var bk = index[String(it.date).slice(0, 7)];
        if (!bk) return;
        bk.total += Number(it.amount || 0);
        bk.games++;
      });
      buckets.forEach(function (b) { b.total = round2(b.total); });
      return buckets;
    },

    /* ---------- 烟品价目 ---------- */

    listCigs: function () {
      if (!Array.isArray(this.data.settings.cigs)) this.data.settings.cigs = defaultCigs();
      return this.data.settings.cigs.slice().sort(function (a, b) { return Number(a.price) - Number(b.price); });
    },

    addCig: function (info) {
      var name = String(info.name || '').trim();
      var price = round2(info.price);
      if (!name || !(price > 0)) return null;
      var cg = { id: uid('cg'), name: name, price: price };
      this.data.settings.cigs.push(cg);
      this.data.settings.cigs.sort(function (a, b) { return Number(a.price) - Number(b.price); });
      this.save();
      return cg;
    },

    updateCig: function (id, patch) {
      var list = this.data.settings.cigs || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        if (patch.name !== undefined) list[i].name = String(patch.name).trim() || list[i].name;
        if (patch.price !== undefined) {
          var p = round2(patch.price);
          if (p > 0) list[i].price = p;
        }
        this.save();
        return list[i];
      }
      return null;
    },

    deleteCig: function (id) {
      var list = this.data.settings.cigs || [];
      var n = list.length;
      this.data.settings.cigs = list.filter(function (c) { return c.id !== id; });
      if (this.data.settings.cigs.length === n) return false;
      this.save();
      return true;
    },

    /* ---------- 上次台费单价：开台默认价跟着最近一次走，少按一次 ---------- */

    lastUnitPrice: function () {
      var p = Number(this.data.settings.lastUnitPrice);
      return p > 0 ? round2(p) : 20;
    },

    rememberUnitPrice: function (price) {
      var p = round2(price);
      if (!(p > 0) || p === Number(this.data.settings.lastUnitPrice)) return;
      this.data.settings.lastUnitPrice = p;
      this.save();
    },

    /* ---------- 计算 ---------- */

    /** 某客户余额：正=他欠我，负=我欠他 */
    balanceOf: function (customerId) {
      var s = 0;
      for (var i = 0; i < this.data.txs.length; i++) {
        var t = this.data.txs[i];
        if (t.customerId !== customerId) continue;
        s += (t.type === 'paid' ? -1 : 1) * Number(t.amount || 0);
      }
      return round2(s);
    },

    /** 批量余额表：{ customerId: balance } */
    balanceMap: function () {
      var m = {};
      for (var i = 0; i < this.data.txs.length; i++) {
        var t = this.data.txs[i];
        m[t.customerId] = round2((m[t.customerId] || 0) + (t.type === 'paid' ? -1 : 1) * Number(t.amount || 0));
      }
      return m;
    },

    /** 某客户流水汇总（含分类小计） */
    summaryOf: function (customerId) {
      var owe = 0, paid = 0, count = 0, last = null;
      var byCat = { loan: 0, fee: 0, cig: 0, other: 0 };
      for (var i = 0; i < this.data.txs.length; i++) {
        var t = this.data.txs[i];
        if (t.customerId !== customerId) continue;
        count++;
        if (t.type === 'paid') paid += Number(t.amount || 0);
        else {
          owe += Number(t.amount || 0);
          byCat[normCategory(t.category)] += Number(t.amount || 0);
        }
        if (!last || t.date > last) last = t.date;
      }
      return {
        owe: round2(owe), paid: round2(paid), balance: round2(owe - paid),
        count: count, lastDate: last,
        oweLoan: round2(byCat.loan), oweFee: round2(byCat.fee),
        oweCig: round2(byCat.cig), oweOther: round2(byCat.other)
      };
    },

    /** 区间往来统计（可按分类） */
    rangeStats: function (from, to, category) {
      var owe = 0, paid = 0, n = 0, cigOwe = 0;
      for (var i = 0; i < this.data.txs.length; i++) {
        var t = this.data.txs[i];
        if (from && t.date < from) continue;
        if (to && t.date > to) continue;
        if (category && normCategory(t.category) !== category) continue;
        n++;
        if (t.type === 'paid') paid += Number(t.amount || 0);
        else {
          owe += Number(t.amount || 0);
          if (normCategory(t.category) === 'cig') cigOwe += Number(t.amount || 0);
        }
      }
      return { owe: round2(owe), paid: round2(paid), net: round2(owe - paid), count: n, cigOwe: round2(cigOwe) };
    },

    /** 全局总览（往来 + 营收） */
    overview: function () {
      var bm = this.balanceMap();
      var receivable = 0, payable = 0, debtors = 0, creditors = 0;
      Object.keys(bm).forEach(function (k) {
        var v = bm[k];
        if (v > 0.004) { receivable += v; debtors++; }
        else if (v < -0.004) { payable += -v; creditors++; }
      });
      var todayStr = toDateStr(new Date());
      var monthFrom = todayStr.slice(0, 7) + '-01';
      var today = this.incomeStats(todayStr, todayStr);
      var month = this.incomeStats(monthFrom, null);
      var openTables = this.data.incomes.filter(function (i) { return i.status === 'open'; }).length;
      // 待转给客户的（他们赢了别人的钱、还没转出去）也算「我欠别人」——这是他该拿走的
      var transferDue = this.pendingTransferTotal();
      return {
        receivable: round2(receivable),
        payable: round2(payable + transferDue),
        transferDue: transferDue,
        transferCount: this.pendingTransferCount(),
        net: round2(receivable - payable),
        debtors: debtors,
        creditors: creditors,
        customers: this.data.customers.length,
        todayIncome: today.total,
        todayGames: today.games,
        monthIncome: month.total,
        monthGames: month.games,
        monthPlayers: month.players,
        openTables: openTables,
        todayLoan: this.loanStats(todayStr, todayStr),
        monthLoan: this.loanStats(monthFrom, null)
      };
    },

    /** 欠款排行 */
    topDebtors: function (limit) {
      limit = limit || 5;
      var bm = this.balanceMap();
      return this.data.customers
        .map(function (c) { return { customer: c, balance: bm[c.id] || 0 }; })
        .filter(function (r) { return r.balance > 0.004; })
        .sort(function (a, b) { return b.balance - a.balance; })
        .slice(0, limit);
    },

    hasAnyData: function () {
      return this.data.customers.length > 0 || this.data.txs.length > 0 || this.data.incomes.length > 0;
    },

    /* ---------- 备份 / 导出 ---------- */

    exportJSON: function () {
      return JSON.stringify({
        app: '麻将馆往来账',
        version: this.data.version || 2,
        exportedAt: new Date().toISOString(),
        customers: this.data.customers,
        txs: this.data.txs,
        incomes: this.data.incomes,
        settings: this.data.settings
      }, null, 2);
    },

    /** 导入备份；mode='replace' 覆盖 | 'merge' 合并（按 id 去重） */
    importJSON: function (text, mode) {
      var p = JSON.parse(text);
      if (!p || !Array.isArray(p.customers) || !Array.isArray(p.txs)) {
        throw new Error('文件格式不正确');
      }
      mode = mode || 'replace';
      var self = this;
      if (mode === 'replace') {
        this.data.customers = p.customers;
        this.data.txs = p.txs;
        this.data.incomes = Array.isArray(p.incomes) ? p.incomes : [];
        if (p.settings && typeof p.settings === 'object') this.data.settings = p.settings;
      } else {
        var cIds = {};
        this.data.customers.forEach(function (c) { cIds[c.id] = 1; });
        p.customers.forEach(function (c) { if (!cIds[c.id]) { self.data.customers.push(c); cIds[c.id] = 1; } });
        var tIds = {};
        this.data.txs.forEach(function (t) { tIds[t.id] = 1; });
        p.txs.forEach(function (t) { if (!tIds[t.id]) { self.data.txs.push(t); tIds[t.id] = 1; } });
        var iIds = {};
        this.data.incomes.forEach(function (i) { iIds[i.id] = 1; });
        (p.incomes || []).forEach(function (i) { if (!iIds[i.id]) { self.data.incomes.push(i); iIds[i.id] = 1; } });
      }
      this.load();   // 走一遍自愈校验
      this.save();
      return { customers: this.data.customers.length, txs: this.data.txs.length, incomes: this.data.incomes.length };
    },

    /** 导出 CSV（流水明细 + 客户余额 + 营收明细），带 BOM 防中文乱码 */
    exportCSV: function () {
      var self = this;
      var rows = [];

      rows.push(['【客户往来流水】']);
      rows.push(['日期', '客户', '电话', '类型', '分类', '金额(元)', '备注', '录入时间']);
      var list = this.listTxs().slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      list.forEach(function (t) {
        var c = self.getCustomer(t.customerId) || {};
        rows.push([
          t.date,
          c.name || '（已删除）',
          c.phone || '',
          t.type === 'paid' ? '收回欠款' : '记欠款',
          CATEGORY_LABEL[normCategory(t.category)],
          Number(t.amount || 0).toFixed(2),
          t.note || '',
          t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : ''
        ]);
      });

      rows.push([]);
      rows.push(['【客户余额汇总】']);
      rows.push(['客户', '电话', '累计欠款', '其中借款', '其中台费', '其中烟钱', '累计收回', '当前应收']);
      var bm = this.balanceMap();
      this.data.customers.forEach(function (c) {
        var s = self.summaryOf(c.id);
        rows.push([c.name, c.phone || '', s.owe.toFixed(2), s.oweLoan.toFixed(2), s.oweFee.toFixed(2),
          s.oweCig.toFixed(2), s.paid.toFixed(2), (bm[c.id] || 0).toFixed(2)]);
      });

      rows.push([]);
      rows.push(['【牌局明细（每场牌的收入与借贷）】']);
      rows.push(['日期', '台号/备注', '状态', '人数', '每人台费(元)', '台费收入(元)', '台费收现(元)', '台费挂账(元)', '借出(元)', '收回(元)', '净借出(元)', '录入时间']);
      var incomes = this.listIncomes().slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      var tFee = 0, tCash = 0, tCredit = 0, tOut = 0, tBack = 0;
      incomes.forEach(function (i) {
        var ss = self.sessionSummary(i);
        tFee += ss.fee; tCash += ss.cashFee; tCredit += ss.creditFee;
        tOut += ss.loanOut; tBack += ss.loanBack;
        rows.push([
          i.date, [i.tableNo, i.note].filter(Boolean).join(' '),
          i.status === 'open' ? '开台中' : '已收台',
          i.players, Number(i.unitPrice || 0).toFixed(2),
          ss.fee.toFixed(2), ss.cashFee.toFixed(2), ss.creditFee.toFixed(2),
          ss.loanOut.toFixed(2), ss.loanBack.toFixed(2), ss.netLoan.toFixed(2),
          i.createdAt ? new Date(i.createdAt).toLocaleString('zh-CN') : ''
        ]);
      });
      rows.push(['合计', '', '', '', '', round2(tFee).toFixed(2), round2(tCash).toFixed(2),
        round2(tCredit).toFixed(2), round2(tOut).toFixed(2), round2(tBack).toFixed(2),
        round2(tOut - tBack).toFixed(2)]);

      rows.push([]);
      rows.push(['【牌局挂账明细（当场没收钱的部分）】']);
      rows.push(['日期', '客户', '项目', '金额(元)', '说明']);
      var anyCredit = false;
      incomes.forEach(function (i) {
        self.creditsOf(i.id).forEach(function (c) {
          anyCredit = true;
          rows.push([i.date, c.name, c.category === 'cig' ? '代买烟' : '台费', c.amount.toFixed(2), c.note || '']);
        });
      });
      if (!anyCredit) rows.push(['（暂无挂账，场场收清）']);

      rows.push([]);
      rows.push(['【牌局借款明细（开台借款 / 局中借还 / 收台结算）】']);
      rows.push(['日期', '台号/备注', '客户', '动作', '金额(元)', '备注']);
      var anyLoan = false;
      incomes.forEach(function (i) {
        self.sessionTxs(i.id).forEach(function (t) {
          if (t.category !== 'loan') return;
          anyLoan = true;
          rows.push([
            i.date, [i.tableNo, i.note].filter(Boolean).join(' '), t.name,
            t.type === 'paid' ? '还钱' : '借钱', t.amount.toFixed(2), t.note || ''
          ]);
        });
      });
      if (!anyLoan) rows.push(['（暂无借款记录）']);

      var csv = rows.map(function (r) {
        return r.map(function (cell) {
          var s = cell === undefined || cell === null ? '' : String(cell);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',');
      }).join('\r\n');

      return '\ufeff' + csv;
    },

    /** 导入客户名单（每行：姓名,电话,备注） */
    importCustomersText: function (text) {
      var lines = String(text || '').split(/\r?\n/);
      var added = 0, skipped = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var parts = line.split(/[,，\t]+/);
        var name = (parts[0] || '').trim();
        if (!name) continue;
        if (this.findCustomerByName(name)) { skipped++; continue; }
        var c = this.addCustomer({ name: name, phone: (parts[1] || '').trim(), note: (parts[2] || '').trim() });
        if (c) added++; else skipped++;
      }
      return { added: added, skipped: skipped };
    },

    /** 清空全部数据 */
    clearAll: function () {
      this.data = { version: 2, customers: [], txs: [], incomes: [], transfers: [], settings: {} };
      this.data.settings.cigs = defaultCigs();
      this.save();
    },

    /** 示例数据（仅用于首次体验） */
    loadDemo: function () {
      var today = new Date();
      function d(offset) { return toDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)); }
      var a = this.addCustomer({ name: '陈老板', phone: '13800001111', note: '隔壁茶叶店' });
      var b = this.addCustomer({ name: '老李', phone: '13900002222', note: '熟客，每周三来' });
      var c = this.addCustomer({ name: '阿强', phone: '', note: '朋友介绍' });
      if (a) {
        this.addTx({ customerId: a.id, type: 'owe', category: 'fee', amount: 800, date: d(12), note: '夜场台费' });
        this.addTx({ customerId: a.id, type: 'owe', category: 'cig', amount: 45, date: d(9), note: '代买烟·45元烟' });
        this.addTx({ customerId: a.id, type: 'paid', category: 'fee', amount: 300, date: d(5), note: '微信转账' });
      }
      if (b) {
        this.addTx({ customerId: b.id, type: 'owe', category: 'fee', amount: 1200, date: d(20), note: '借现金' });
        this.addTx({ customerId: b.id, type: 'owe', category: 'cig', amount: 23, date: d(4), note: '代买烟·23元烟' });
        this.addTx({ customerId: b.id, type: 'owe', category: 'fee', amount: 260, date: d(3), note: '茶水+台费' });
        this.addTx({ customerId: b.id, type: 'paid', category: 'fee', amount: 500, date: d(2), note: '现金还款' });
      }
      if (c) {
        this.addTx({ customerId: c.id, type: 'owe', category: 'fee', amount: 150, date: d(1), note: '欠台费' });
      }
      // 营业收入：每天几场（其中几场有人挂账，看清「营业额 ≠ 现金」）
      var demoIncome = [
        { date: d(0), players: 4, unitPrice: 20 },
        { date: d(0), players: 4, unitPrice: 10 },
        { date: d(0), players: 2, unitPrice: 20, credits: [{ customerId: c && c.id, fee: 20 }] },
        { date: d(1), players: 4, unitPrice: 20, credits: [{ customerId: b && b.id, fee: 20, cig: 13, cigName: '13元烟' }] },
        { date: d(1), players: 4, unitPrice: 20 },
        { date: d(2), players: 4, unitPrice: 10, credits: [{ customerId: a && a.id, fee: 20 }] },
        { date: d(3), players: 4, unitPrice: 20 }
      ];
      demoIncome.forEach(function (it) {
        Store.addIncome({
          date: it.date, players: it.players, unitPrice: it.unitPrice,
          amount: it.players * it.unitPrice,
          credits: (it.credits || []).filter(function (x) { return x.customerId; })
        });
      });

      // 正在打的台：演示「开台每人先借 500、局中再借、中途还钱」
      var members = [a, b, c].filter(Boolean).map(function (x) {
        return { customerId: x.id, stake: 500 };
      });
      var open = null;
      if (members.length) {
        open = Store.openSession({
          date: d(0), players: members.length, unitPrice: 20, tableNo: '1号台',
          members: members
        });
        if (open && a) Store.addSessionTx(open.id, { customerId: a.id, type: 'owe', amount: 200, note: '输光了再借' });
        if (open && b) Store.addSessionTx(open.id, { customerId: b.id, type: 'paid', amount: 300, note: '赢了先还一部分' });
      }
      return { customers: 3, txs: this.data.txs.length, incomes: demoIncome.length + (open ? 1 : 0) };
    }
  };

  /* 工具方法挂到 Store 上，供 UI 复用 */
  Store.util = {
    uid: uid, toDateStr: toDateStr, parseDate: parseDate, humanDate: humanDate, hmTime: hmTime,
    money: money, round2: round2, normCategory: normCategory, CATEGORY_LABEL: CATEGORY_LABEL,
    fixHead: fixHead
  };

  global.Store = Store;
})(window);
