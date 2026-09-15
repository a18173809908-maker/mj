/* ==========================================================================
   store.js — 数据层
   所有数据保存在手机本机（localStorage），不上传任何服务器。
   数据模型：
     customer = { id, name, phone, note, createdAt, updatedAt }
     tx       = { id, customerId, type:'owe'|'paid', category:'fee'|'cig'|'other',
                  amount, date:'YYYY-MM-DD', note, createdAt }
       type = 'owe'  记欠款（他欠我的钱增加）
       type = 'paid' 收回（他欠我的钱减少）
       category: fee=台费茶水类  cig=代买烟  other=其他
     余额 = Σ owe − Σ paid    正数=他欠我；负数=我欠他
     income   = { id, date, players, unitPrice, amount, note, credits, createdAt }
       营业收入：一场的收费（人数 × 每人单价，金额可手改）
       本场赊账明细不另存：有客人当场没掏钱（台费/烟钱先记着）时，直接生成该客户的
       欠款流水并打上 incomeId。查明细用 creditsOf(incomeId)，改/删营收时按明细重建或撤销。
       真相只有一份（流水里），不会两边对不上。
       口径：amount = 本场营业额（台费，含赊账）；cash = amount − Σfee（实收现金）；
             Σcig = 代买烟赊账（垫付，不计入营业额，单独进客户欠款）
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

  var CATEGORY_LABEL = { fee: '台费', cig: '烟钱', other: '其他' };
  function normCategory(c) { return (c === 'cig' || c === 'other') ? c : 'fee'; }

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
    data: { version: 2, customers: [], txs: [], incomes: [], settings: {} },

    /* ---------- 持久化 ---------- */

    load: function () {
      var raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* 隐私模式 */ }
      if (raw) {
        try {
          var p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            this.data.customers = Array.isArray(p.customers) ? p.customers : [];
            this.data.txs = Array.isArray(p.txs) ? p.txs : [];
            this.data.incomes = Array.isArray(p.incomes) ? p.incomes : [];
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
      this.data.txs.forEach(function (t) {
        if (!t.category) { t.category = 'fee'; changed = true; }
      });
      this.data.incomes.forEach(function (i) {
        if (i.players === undefined) { i.players = 1; changed = true; }
        if (i.unitPrice === undefined) { i.unitPrice = round2(i.amount); changed = true; }
      });
      // 老流水没有 incomeId 字段，补上以免被误判为营收生成
      this.data.txs.forEach(function (t) {
        if (t.incomeId === undefined) { t.incomeId = null; changed = true; }
      });
      if (!Array.isArray(this.data.settings.cigs) || !this.data.settings.cigs.length) {
        this.data.settings.cigs = defaultCigs();
        changed = true;
      }
      if (changed) this.save();
    },

    save: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        return true;
      } catch (e) {
        console.error('[store] 保存失败', e);
        return false;
      }
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

    /* ---------- 营业收入 ---------- */

    listIncomes: function (filter) {
      filter = filter || {};
      var out = this.data.incomes.slice();
      if (filter.from) out = out.filter(function (i) { return i.date >= filter.from; });
      if (filter.to) out = out.filter(function (i) { return i.date <= filter.to; });
      out.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return out;
    },

    getIncome: function (id) {
      for (var i = 0; i < this.data.incomes.length; i++) {
        if (this.data.incomes[i].id === id) return this.data.incomes[i];
      }
      return null;
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
        return t.incomeId === incomeId && t.type === 'owe';
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
      this.data.txs = this.data.txs.filter(function (t) { return t.incomeId !== income.id; });
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
      var it = {
        id: uid('i'),
        date: info.date || toDateStr(new Date()),
        players: Math.max(1, Number(info.players) || 1),
        unitPrice: round2(info.unitPrice || 0),
        amount: amount,
        note: String(info.note || '').trim(),
        createdAt: Date.now()
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
      var total = 0, games = 0, players = 0, creditFee = 0, creditCig = 0;
      this.data.incomes.forEach(function (i) {
        if (from && i.date < from) return;
        if (to && i.date > to) return;
        total += Number(i.amount || 0);
        games++;
        players += Number(i.players || 0);
        var cs = self.creditSumOf(i.id);
        creditFee += cs.fee;
        creditCig += cs.cig;
      });
      return {
        total: round2(total),
        games: games,
        players: players,
        creditFee: round2(creditFee),      // 这场赊掉的台费
        creditCig: round2(creditCig),      // 这场赊掉的烟钱（代买垫付）
        cash: round2(total - creditFee),   // 台费里实收现金的部分
        avg: games ? round2(total / games) : 0,
        perHead: players ? round2(total / players) : 0
      };
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
      var byCat = { fee: 0, cig: 0, other: 0 };
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
        oweFee: round2(byCat.fee), oweCig: round2(byCat.cig), oweOther: round2(byCat.other)
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
      return {
        receivable: round2(receivable),
        payable: round2(payable),
        net: round2(receivable - payable),
        debtors: debtors,
        creditors: creditors,
        customers: this.data.customers.length,
        todayIncome: today.total,
        todayGames: today.games,
        monthIncome: month.total,
        monthGames: month.games,
        monthPlayers: month.players
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
      rows.push(['客户', '电话', '累计欠款', '其中台费', '其中烟钱', '累计收回', '当前应收']);
      var bm = this.balanceMap();
      this.data.customers.forEach(function (c) {
        var s = self.summaryOf(c.id);
        rows.push([c.name, c.phone || '', s.owe.toFixed(2), s.oweFee.toFixed(2), s.oweCig.toFixed(2), s.paid.toFixed(2), (bm[c.id] || 0).toFixed(2)]);
      });

      rows.push([]);
      rows.push(['【营业收入明细】']);
      rows.push(['日期', '人数', '每人(元)', '本场营业额(元)', '实收现金(元)', '其中挂账(元)', '备注', '录入时间']);
      var incomes = this.listIncomes().slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      var sumAmount = 0, sumCash = 0, sumCredit = 0;
      incomes.forEach(function (i) {
        var cs = self.creditSumOf(i.id);
        var amt = Number(i.amount || 0);
        sumAmount += amt; sumCredit += cs.fee; sumCash += amt - cs.fee;
        rows.push([
          i.date, i.players, Number(i.unitPrice || 0).toFixed(2), amt.toFixed(2),
          round2(amt - cs.fee).toFixed(2), cs.fee.toFixed(2),
          i.note || '', i.createdAt ? new Date(i.createdAt).toLocaleString('zh-CN') : ''
        ]);
      });
      rows.push(['合计', '', '', round2(sumAmount).toFixed(2), round2(sumCash).toFixed(2), round2(sumCredit).toFixed(2)]);

      rows.push([]);
      rows.push(['【营收挂账明细（当场没收钱的部分）】']);
      rows.push(['日期', '客户', '项目', '金额(元)', '说明']);
      var anyCredit = false;
      incomes.forEach(function (i) {
        self.creditsOf(i.id).forEach(function (c) {
          anyCredit = true;
          rows.push([i.date, c.name, c.category === 'cig' ? '代买烟' : '台费', c.amount.toFixed(2), c.note || '']);
        });
      });
      if (!anyCredit) rows.push(['（暂无挂账，场场收清）']);

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
      this.data = { version: 2, customers: [], txs: [], incomes: [], settings: {} };
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
      return { customers: 3, txs: this.data.txs.length, incomes: demoIncome.length };
    }
  };

  /* 工具方法挂到 Store 上，供 UI 复用 */
  Store.util = {
    uid: uid, toDateStr: toDateStr, parseDate: parseDate, humanDate: humanDate, hmTime: hmTime,
    money: money, round2: round2, normCategory: normCategory, CATEGORY_LABEL: CATEGORY_LABEL
  };

  global.Store = Store;
})(window);
