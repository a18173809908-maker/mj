/* ==========================================================================
   ui.js — 图标与渲染小工具
   ========================================================================== */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name, size) {
    var paths = Icons[name] || '';
    size = size || 22;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + paths + '</svg>';
  }

  var Icons = {
    users: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="8" r="3.2"/><path d="M20 19v-1.4a3.4 3.4 0 0 0-2.6-3.3M15.5 5.2a3.2 3.2 0 0 1 0 5.9"/>',
    receipt: '<path d="M6 3.5h12a1 1 0 0 1 1 1V20l-2.4-1.5L14.2 20l-2.2-1.5L9.8 20l-2.4-1.5L5 20V4.5a1 1 0 0 1 1-1Z"/><path d="M9 8.5h6M9 12h6"/>',
    chart: '<path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M9 16v-5M13.5 16V8M18 16v-3"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>',
    back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
    search: '<circle cx="11" cy="11" r="6.2"/><path d="m19.5 19.5-3.6-3.6"/>',
    chev: '<path d="m9.5 6 6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    trash: '<path d="M4.5 6.5h15M9.5 6V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6.5M7 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/><path d="M10.3 10.5v6M13.7 10.5v6"/>',
    pencil: '<path d="M14.5 5.5 18.5 9.5 8.6 19.4l-4.3.7.7-4.3L14.5 5.5Z"/><path d="m12.7 7.3 4 4"/>',
    down: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4.5 17.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-1.5"/>',
    up: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4.5 17.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-1.5"/>',
    phone: '<path d="M6.8 3.8 8.9 3.4a1 1 0 0 1 1.1.6l1.2 2.8a1 1 0 0 1-.3 1.2l-1.5 1.2a12.4 12.4 0 0 0 5.4 5.4l1.2-1.5a1 1 0 0 1 1.2-.3l2.8 1.2a1 1 0 0 1 .6 1.1l-.4 2.1a1.6 1.6 0 0 1-1.6 1.3A15.7 15.7 0 0 1 5.5 5.4a1.6 1.6 0 0 1 1.3-1.6Z"/>',
    doc: '<path d="M13.5 3.5H7a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4.5-4.5Z"/><path d="M13.5 3.5V8H18"/><path d="M9.5 12.5h5M9.5 16h5"/>',
    usersAdd: '<path d="M15 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="9.5" cy="8.5" r="3"/><path d="M18.5 8v5M16 10.5h5"/>',
    swap: '<path d="M7 4.5 3.5 8 7 11.5M3.5 8H17"/><path d="m17 12.5 3.5 3.5L17 19.5M20.5 16H7"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.4" fill="currentColor"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17" r="0.4" fill="currentColor"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    broom: '<path d="M19 4 12.5 10.5"/><path d="M10 8.5 15.5 14 9 20.5H4v-5.5L10 8.5Z"/>',
    smile: '<circle cx="12" cy="12" r="8.5"/><path d="M9 14.2s1.1 1.3 3 1.3 3-1.3 3-1.3"/><circle cx="9.3" cy="9.8" r="0.4" fill="currentColor"/><circle cx="14.7" cy="9.8" r="0.4" fill="currentColor"/>',
    wallet: '<path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h11.6a2.2 2.2 0 0 1 2.2 2.2v8.1a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V8.2Z"/><path d="M3.5 10.2h17M16.2 14.4h1.6"/><path d="M18 6V4.9a1.4 1.4 0 0 0-1.7-1.4L6.6 5.2"/>',
    cig: '<path d="M3 16.5h13.5v3H3z"/><path d="M16.5 18h3.4a2.1 2.1 0 0 0 2.1-2.1v-1.6"/><path d="M17.6 8.6c1.2-.9 1.2-2.3 0-3.2M20.4 10.4c1.5-1.5 1.5-3.7 0-5.2"/>',
    coins: '<ellipse cx="9" cy="6.6" rx="5.5" ry="2.6"/><path d="M3.5 6.6v4.2c0 1.4 2.5 2.6 5.5 2.6s5.5-1.2 5.5-2.6V6.6"/><path d="M14.5 10.6v3.6c0 1.4 2.2 2.5 5 2.5s2-1.1 2-2.5"/><path d="M3.5 10.8v4.2c0 1.4 2.5 2.6 5.5 2.6 1 0 2-.2 2.8-.4"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    lock: '<rect x="4.8" y="10.5" width="14.4" height="9.7" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/><circle cx="12" cy="15.3" r="1.1" fill="currentColor" stroke="none"/>',
    unlock: '<rect x="4.8" y="10.5" width="14.4" height="9.7" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.3-1.2"/>',
    moon: '<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.5 8.5 0 1 0 10.4 10.4Z"/>',
    cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>'
  };

  /** 头像首字 + 配色 class */
  function avatarHtml(name) {
    var ch = (name || '?').trim().charAt(0).toUpperCase() || '?';
    var idx = 0;
    for (var i = 0; i < (name || '').length; i++) idx = (idx + name.charCodeAt(i)) % 5;
    return '<span class="avatar c' + idx + '">' + esc(ch) + '</span>';
  }

  /** 余额展示片段：红=他欠我 / 绿=我欠他 / 灰=已清 */
  function balanceHtml(balance, opts) {
    opts = opts || {};
    var cls, text;
    if (balance > 0.004) { cls = 'owe'; text = esc(global.Store.util.money(balance)); }
    else if (balance < -0.004) { cls = 'paid'; text = esc(global.Store.util.money(-balance)); }
    else { cls = 'zero'; text = '0'; }
    return '<span class="' + cls + '">' +
      '<span class="v num">' + text + '</span>' +
      (cls === 'zero' ? '' : '<span class="u">' + (cls === 'owe' ? '应收' : '待转') + '</span>') +
      '</span>';
  }

  global.UI = { esc: esc, icon: icon, avatarHtml: avatarHtml, balanceHtml: balanceHtml, Icons: Icons };
})(window);
