/* ==========================================================================
   sw.js — 离线缓存（可选增强：https/localhost 下自动生效）
   策略：页面走「网络优先」（保证更新及时到手机），静态资源走「缓存优先 + 后台更新」
   ========================================================================== */
(function () {
  'use strict';

  var CACHE = 'ledger-mahjong-v5';
  var ASSETS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/app.css',
    './js/store.js',
    './js/ui.js',
    './js/lock.js',
    './js/app.js',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/icon-maskable-512.png',
    './assets/apple-touch-icon.png'
  ];

  function isDocument(req) {
    return req.mode === 'navigate' ||
      (req.headers.get('accept') || '').indexOf('text/html') >= 0;
  }

  function put(req, resp) {
    if (!resp || !resp.ok) return;
    var clone = resp.clone();
    caches.open(CACHE).then(function (c) { c.put(req, clone); });
  }

  self.addEventListener('install', function (e) {
    e.waitUntil(
      caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
        .then(function () { return self.skipWaiting(); })
    );
  });

  self.addEventListener('activate', function (e) {
    e.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      }).then(function () { return self.clients.claim(); })
    );
  });

  self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    // 页面：先要网络（拿到最新版），断网再回退缓存
    if (isDocument(req)) {
      e.respondWith(
        fetch(req).then(function (resp) {
          put(req, resp);
          return resp;
        }).catch(function () {
          return caches.match(req, { ignoreSearch: true }).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
      );
      return;
    }

    // 静态资源：先给缓存（快），同时后台拉最新
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) {
          fetch(req).then(function (resp) { put(req, resp); }).catch(function () { });
          return hit;
        }
        return fetch(req).then(function (resp) {
          put(req, resp);
          return resp;
        });
      })
    );
  });
})();
