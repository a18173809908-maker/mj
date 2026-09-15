/* ==========================================================================
   sw.js — 离线缓存（可选增强：https/localhost 下自动生效）
   ========================================================================== */
(function () {
  'use strict';

  var CACHE = 'ledger-mahjong-v4';
  var ASSETS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/app.css',
    './js/store.js',
    './js/ui.js',
    './js/app.js',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/icon-maskable-512.png',
    './assets/apple-touch-icon.png'
  ];

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
    if (e.request.method !== 'GET') return;
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        if (hit) {
          // 后台静默更新
          fetch(e.request).then(function (resp) {
            if (resp && resp.ok) {
              caches.open(CACHE).then(function (c) { c.put(e.request, resp.clone()); });
            }
          }).catch(function () { });
          return hit;
        }
        return fetch(e.request).then(function (resp) {
          if (resp && resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
          }
          return resp;
        });
      })
    );
  });
})();
