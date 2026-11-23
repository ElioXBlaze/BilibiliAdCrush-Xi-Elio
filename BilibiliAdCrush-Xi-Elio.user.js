// ==UserScript==
// @name         BilibiliAdCrush Xi/Elio
// @namespace    https://local.yuanbao/bilibili-stay-adreplace
// @version      2.1.0
// @description  全站精准去广告；首页「小火箭」等推广卡不留空白容器，原位换成一条真实推荐视频。专为 iPad/iPhone Safari + Stay 设计，零外部依赖、零数据上报。
// @author       Xi/Elio X. Blaze
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://live.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://m.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 设计要点（调研结论，2026-11-13）
 * 1) 「小火箭」推广视频在 DOM 上与普通视频卡几乎完全一致（同为
 *    .bili-video-card.is-rcmd.enable-no-interest），唯一可靠标记在推荐流接口里：
 *    business_info.is_ad_loc === true；另有「广告跳转包装」判据
 *    （a[href*="cm.bilibili.com"] + [data-target-url]）。故采用「接口判据 + DOM 角标 + 链接」三层识别。
 * 2) 广告卡不做 display:none（会留下空槽并触发 B 站 :nth-of-type 边距错位），
 *    而是用「同页真实卡模板 + 推荐接口返回的真实 item」做 replaceWith：
 *    原位、DOM 序号不变、grid 不重排、无空白容器。
 * 3) 补位数据来源优先级：页面自身推荐请求的响应（hook 收集）→ 重放页面已签名的
 *    推荐 URL（等价于调推荐 API，无需自己算 wbi）→ 自算 wbi 签名请求 →
 *    同页真实卡复用 → 直接 remove 让栅格自然补位。
 * 4) Stay 公开资料未给出完整 GM_* API 清单，故 @grant none，全部用原生 DOM/fetch；
 *    不改写页面响应体，避免干扰 B 站 Vue 渲染。
 *
 * 调试：localStorage.setItem('__yb_debug','1') 后刷新；控制台 __YBBiliAd.report()
 * 配置：localStorage.setItem('__yb_config', JSON.stringify({hideCarousel:false}))
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  var CONFIG = {
    enable: true,
    // 首页 / feed
    cleanFeed: true,            // 识别并替换首页推荐流广告卡（含小火箭）
    hideCarousel: true,         // 隐藏首页左侧大图轮播推广位
    hideLiveCard: false,        // 隐藏首页直播卡（默认关，避免误杀内容）
    // 全站场景
    cleanHomeExtras: true,      // 首页横幅 / 左侧广告 / 浮层
    cleanVideoPage: true,       // 播放页横幅、右侧广告卡、活动卡、弹窗
    cleanSearch: true,          // 搜索结果广告卡
    cleanDynamic: true,         // 动态页广告
    cleanLive: true,            // 直播页推广位
    cleanBangumi: true,         // 番剧页广告
    // 补位
    useApiFill: true,           // 调推荐接口补一条真实视频（用户选定方案）
    useSelfWbi: true,           // 复用签名 URL 失败时，尝试自算 wbi 签名
    maxRequests: 3,             // 每页最多主动补位请求数
    minInterval: 1500,          // 两次请求最小间隔（ms）
    pendingTimeout: 3000,       // 等补位数据最长多久（超时则移除广告卡）
    extraPoolSize: 12           // 备用真实视频池上限
  };
  try {
    var saved = JSON.parse(localStorage.getItem('__yb_config') || 'null');
    if (saved && typeof saved === 'object') for (var k in saved) if (k in CONFIG) CONFIG[k] = saved[k];
  } catch (e) {}

  var DEBUG = false;
  try { DEBUG = localStorage.getItem('__yb_debug') === '1'; } catch (e) {}

  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[BilibiliAdCrush]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    if (!DEBUG) return;
    try { console.warn.apply(console, ['[BilibiliAdCrush]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  /* ============================ 状态 ============================ */
  var state = {
    signedUrl: '',            // 页面自身发出的、带合法 wbi 签名的推荐 URL
    adKeys: new Set(),        // 接口判定的广告 bvid / avid
    poolKeys: new Set(),      // 已入池的真实视频
    usedKeys: new Set(),      // 已被用来补位的真实视频
    sparePool: [],            // 可用于补位的真实 item
    template: null,           // 干净真实卡模板（DOM 节点）
    feedSeen: 0,
    apiAds: 0,
    adCards: 0,
    replaced: 0,
    removed: 0,
    reqCount: 0,
    lastReqAt: 0,
    failStreak: 0,
    apiDisabled: false,
    fetchHooked: false,
    xhrHooked: false,
    observer: null,
    cssKey: '',
    pending: new Set(),
    feedIdx: 1
  };

  var DONE = 'data-yb-done', REAL = 'data-yb-real', PEND = 'data-yb-pending';

  /* ============================ 小工具 ============================ */
  function resolveUrl(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (input.url) return input.url;
    return '';
  }
  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u || ''); }
  }
  function itemKey(it) {
    if (!it || typeof it !== 'object') return null;
    if (it.bvid) return String(it.bvid);
    if (it.bv_id) return String(it.bv_id);
    if (it.id) return 'av' + it.id;
    if (it.aid) return 'av' + it.aid;
    return null;
  }
  function bvidFromCard(card) {
    try {
      var a = card.querySelector('a[href*="/video/"], a[data-bvid], [data-bvid]');
      var raw = a ? (a.getAttribute('href') || a.getAttribute('data-bvid') || '') : '';
      var m = raw.match(/BV[0-9A-Za-z]{10}/) || raw.match(/\/av(\d+)/i);
      return m ? (m[1] ? 'av' + m[1] : m[0]) : null;
    } catch (e) { return null; }
  }
  function formatCount(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    n = Number(n);
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }
  function formatDuration(d) {
    if (!d && d !== 0) return '';
    if (typeof d === 'string' && d.indexOf(':') >= 0) return d;
    var s = parseInt(d, 10);
    if (isNaN(s) || s < 0) return '';
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function normPic(p) {
    if (!p) return '';
    p = String(p);
    if (p.indexOf('//') === 0) return 'https:' + p;
    if (p.indexOf('http:') === 0) return p.replace(/^http:/, 'https:');
    return p;
  }
  function statVal(it, name, alt) {
    try {
      if (it.stat && it.stat[name] !== undefined) return it.stat[name];
      if (it[name] !== undefined) return it[name];
      if (alt !== undefined && it[alt] !== undefined) return it[alt];
    } catch (e) {}
    return null;
  }

  /* MD5-START  —— 用于 wbi 自签名，独立可单测 —— */
  function md5(str) {
    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
        bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var lo = bitLen >>> 0, hi = Math.floor(bitLen / 0x100000000);
    for (i = 0; i < 4; i++) bytes.push((lo >>> (8 * i)) & 0xff);
    for (i = 0; i < 4; i++) bytes.push((hi >>> (8 * i)) & 0xff);
    var K = [], S = [];
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    for (i = 0; i < 64; i++) {
      if (i < 16) S[i] = [7, 12, 17, 22][i % 4];
      else if (i < 32) S[i] = [5, 9, 14, 20][i % 4];
      else if (i < 48) S[i] = [4, 11, 16, 23][i % 4];
      else S[i] = [6, 10, 15, 21][i % 4];
    }
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (i = 0; i < 16; i++) {
        M[i] = (bytes[off + 4 * i] | (bytes[off + 4 * i + 1] << 8) |
          (bytes[off + 4 * i + 2] << 16) | (bytes[off + 4 * i + 3] << 24)) >>> 0;
      }
      var A = a0, B = b0, C = c0, D = d0, F, g, sum, rot;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        sum = (A + F + K[i] + M[g]) >>> 0;
        rot = ((sum << S[i]) | (sum >>> (32 - S[i]))) >>> 0;
        A = D; D = C; C = B; B = (B + rot) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    function hx(n) {
      var s = '', b;
      for (var j = 0; j < 4; j++) { b = (n >>> (8 * j)) & 0xff; s += ('0' + b.toString(16)).slice(-2); }
      return s;
    }
    return hx(a0) + hx(b0) + hx(c0) + hx(d0);
  }
  /* MD5-END */

  // WBI mixin key 重排表（社区公开常量；若 B 站更新，签名失败会自动降级）
  var MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
  ];
  function keyFromFile(u) {
    try { return String(u).split('/').pop().split('.')[0]; } catch (e) { return ''; }
  }

  /* ======================= 推荐接口：识别与收集 ======================= */
  var FEED_RE = /\/top\/feed\/rcmd|\/index\/rcmd|\/feed\/rcmd|\/wbi\/index\/top\/feed\/rcmd/i;
  function isFeedUrl(u) {
    if (!u) return false;
    if (!/bilibili\.com/i.test(String(u))) return false;
    return FEED_RE.test(String(u));
  }
  function rememberSignedUrl(u) {
    try {
      var full = absUrl(u);
      if (isFeedUrl(full)) {
        state.signedUrl = full;
        log('记录已签名推荐 URL');
        // 提前预备补位数据：等价于「调推荐 API 补一条」，但复用页面合法签名
        setTimeout(function () { ensureSpare(); }, 60);
      }
    } catch (e) {}
  }
  function isAdItem(it) {
    if (!it || typeof it !== 'object') return false;
    try {
      if (it.business_info && it.business_info.is_ad_loc === true) return true; // 小火箭主判据
      if (it.is_ad === true || it.ad_info || it.cm_mark || it.ad_cb || it.ad) return true;
      if (it.card_goto && /^(ad|banner|cm|advert|promote)/i.test(String(it.card_goto))) return true;
      if (it.goto && /^(ad|banner|cm|advert)/i.test(String(it.goto))) return true;
      if (it.uri && /cm\.bilibili\.com|ad\.bilibili\.com/i.test(String(it.uri))) return true;
    } catch (e) {}
    return false;
  }
  function cacheItem(it) {
    if (!it || isAdItem(it)) return;
    var key = itemKey(it);
    if (!key || state.poolKeys.has(key) || state.usedKeys.has(key) || state.adKeys.has(key)) return;
    if (!it.title || !(it.pic || it.cover)) return; // 必须能渲染成一张卡
    state.sparePool.push(it);
    state.poolKeys.add(key);
    while (state.sparePool.length > CONFIG.extraPoolSize) {
      var old = state.sparePool.shift();
      if (old) state.poolKeys.delete(itemKey(old));
    }
  }
  function harvestFeed(json) {
    if (!json || json.code !== 0 || !json.data) return;
    var items = json.data.item || json.data.items || json.data.list;
    if (!Array.isArray(items)) return;
    state.feedSeen++;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (isAdItem(it)) {
        var ak = itemKey(it);
        if (ak) state.adKeys.add(ak);
        // 广告归因链接里也可能带 bvid
        try {
          var mm = String(it.uri || it.url || '').match(/BV[0-9A-Za-z]{10}/);
          if (mm) state.adKeys.add(mm[0]);
        } catch (e) {}
        state.apiAds++;
      } else {
        cacheItem(it);
      }
    }
    log('收集推荐响应：真实池', state.sparePool.length, '广告', state.apiAds);
  }
  function takeSpare() {
    while (state.sparePool.length) {
      var it = state.sparePool.shift();
      var key = itemKey(it);
      state.poolKeys.delete(key);
      if (!key || state.usedKeys.has(key) || state.adKeys.has(key) || isAdItem(it)) continue;
      state.usedKeys.add(key);
      return it;
    }
    return null;
  }

  /* -------------------- hook fetch（只读取，不改响应） -------------------- */
  function hookFetch() {
    if (state.fetchHooked) return;
    var orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function () {
      var url = resolveUrl(arguments[0]);
      var p;
      try { p = orig.apply(this, arguments); } catch (e) { throw e; }
      if (isFeedUrl(url) && p && typeof p.then === 'function') {
        rememberSignedUrl(url);
        p.then(function (res) {
          try {
            if (!res || typeof res.clone !== 'function') return;
            res.clone().json().then(function (j) { harvestFeed(j); }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
    state.fetchHooked = true;
    log('fetch hook 就绪');
  }

  /* -------------------- hook XHR（只读取，不改响应） -------------------- */
  function hookXHR() {
    if (state.xhrHooked || typeof XMLHttpRequest === 'undefined') return;
    var P = XMLHttpRequest.prototype;
    var origOpen = P.open, origSend = P.send;
    var dText = Object.getOwnPropertyDescriptor(P, 'responseText');
    P.open = function () {
      try {
        var u = String(arguments[1] || '');
        this.__ybFeed = isFeedUrl(u);
        if (this.__ybFeed) rememberSignedUrl(u);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    P.send = function () {
      var self = this;
      if (self.__ybFeed) {
        try {
          self.addEventListener('loadend', function () {
            try {
              var json = null;
              try { if (dText && dText.get) json = JSON.parse(dText.get.call(self)); } catch (e) {}
              if (!json) { try { json = self.response; } catch (e2) {} }
              if (json && typeof json === 'object') harvestFeed(json);
            } catch (e) {}
          });
        } catch (e) {}
      }
      return origSend.apply(this, arguments);
    };
    state.xhrHooked = true;
    log('XHR hook 就绪');
  }

  /* ======================= 补位：调推荐 API ======================= */
  var inflight = null;
  function canRequest() {
    if (!CONFIG.useApiFill || state.apiDisabled) return false;
    if (state.reqCount >= CONFIG.maxRequests) return false;
    if (Date.now() - state.lastReqAt < CONFIG.minInterval) return false;
    return true;
  }
  function noteFail(tag, e) {
    state.failStreak++;
    warn('补位请求失败(' + tag + ')', e && e.message ? e.message : e);
    if (state.failStreak >= 2) { state.apiDisabled = true; warn('连续失败，停用主动补位，改为本地降级'); }
  }
  function noteSuccess() { state.failStreak = 0; }

  // 方案 A：重放页面已签名的推荐 URL（无 wbi 计算、无风控风险）
  function fetchBySignedUrl() {
    if (!state.signedUrl) return Promise.reject(new Error('no signed url'));
    return fetch(state.signedUrl, { credentials: 'include', referrer: location.href })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data) throw new Error('code ' + (j && j.code));
        harvestFeed(j);
        return true;
      });
  }
  // 方案 B：自算 wbi 签名主动请求推荐接口
  function fetchByWbi() {
    if (!CONFIG.useSelfWbi) return Promise.reject(new Error('self wbi disabled'));
    return fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include', referrer: location.href })
      .then(function (r) { return r.json(); })
      .then(function (nav) {
        var wi = nav && nav.data && nav.data.wbi_img;
        if (!wi || !wi.img_url || !wi.sub_url) throw new Error('no wbi key');
        var raw = keyFromFile(wi.img_url) + keyFromFile(wi.sub_url);
        if (raw.length < 64) throw new Error('bad wbi key');
        var mixin = '', i;
        for (i = 0; i < MIXIN_TAB.length; i++) mixin += raw.charAt(MIXIN_TAB[i]);
        mixin = mixin.slice(0, 32);
        var p = {
          ps: 12,
          fresh_type: 4,
          feed_version: 'V8',
          fresh_idx: state.feedIdx++,
          fresh_idx_1h: state.feedIdx++,
          wts: Math.floor(Date.now() / 1000)
        };
        var q = Object.keys(p).sort().map(function (key) {
          return key + '=' + encodeURIComponent(String(p[key]).replace(/[!'()*]/g, ''));
        }).join('&');
        var url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + q + '&w_rid=' + md5(q + mixin);
        return fetch(url, { credentials: 'include', referrer: location.href }).then(function (r) { return r.json(); });
      })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data) throw new Error('code ' + (j && j.code));
        harvestFeed(j);
        return true;
      });
  }
  function ensureSpare() {
    if (!CONFIG.enable || !CONFIG.useApiFill) return Promise.resolve(false);
    if (state.sparePool.length >= 2) return Promise.resolve(true);
    if (inflight) return inflight;
    if (!canRequest()) return Promise.resolve(false);
    state.reqCount++;
    state.lastReqAt = Date.now();
    log('发起补位请求 #' + state.reqCount);
    inflight = fetchBySignedUrl()
      .catch(function (e) { warn('签名 URL 不可用，尝试自签名', e.message); return fetchByWbi(); })
      .then(function (ok) { noteSuccess(); log('补位成功，池内', state.sparePool.length); return ok; })
      .catch(function (e) { noteFail('api', e); return false; })
      .then(function (r) { inflight = null; flushPending(); return r; });
    return inflight;
  }
  // 本地兜底：复用同页真实卡（不额外发请求）
  function ensureTemplate() {
    if (state.template) return state.template;
    try {
      var cards = document.querySelectorAll('.feed-card, .bili-feed-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        if (c.getAttribute(REAL) || c.getAttribute(PEND)) continue;
        if (!isAdCard(c) && c.querySelector('a[href*="/video/"]')) {
          state.template = c.cloneNode(true);
          return state.template;
        }
      }
    } catch (e) {}
    return null;
  }

  /* ======================= 广告卡识别 ======================= */
  function isAdCard(card) {
    if (!card || card.nodeType !== 1) return '';
    if (card.getAttribute(REAL) === '1') return '';
    var cls = String(card.className || '');
    if (!/feed-card|bili-feed-card/.test(cls)) return '';
    // 安全闸：结果必须像一张卡片，避免在视频页等布局下误藏整块容器
    try {
      var r = card.getBoundingClientRect();
      if (r.width > 700 || r.height > window.innerHeight * 0.9) return '';
    } catch (e) {}
    try {
      // 1) 接口黑名单（小火箭主判据）
      var bv = bvidFromCard(card);
      if (bv && state.adKeys.has(bv)) return 'promoted';
      // 2) 广告角标（含根节点自带标记）
      if (card.getAttribute('data-is-ad') === 'true' ||
        card.querySelector('.bili-video-card__info--ad, .bili-video-card__info--ad-creative, ' +
        '.bili-video-card__info--creative-ad, svg.ad-tag, svg.bili-video-card__info--creative-ad, ' +
        '[data-is-ad="true"], [class*="__info--ad"], [class*="creative-ad"]')) return 'badge';
      // 3) 广告跳转包装：cm 链接 + data-target-url 必须同时存在（避免误杀）
      if (card.querySelector('a[href*="cm.bilibili.com"]') && card.querySelector('[data-target-url]')) return 'adlink';
      // 4) 天马 / sycp 商业素材
      if (card.querySelector('[data-mod^="tianma.2."], img[src*="/sycp/"], source[srcset*="/sycp/"]')) return 'material';
      // 5) 主链接指向商业域 / 空链接；若主链接压根不存在，需排除番剧、直播等正常内容卡
      var main = card.querySelector('a.bili-video-card__image--link');
      if (main) {
        var href = main.getAttribute('href') || '';
        if (!href || /cm\.bilibili\.com|game\.bilibili\.com|ad\.bilibili\.com/i.test(href)) return 'link';
      } else if (card.querySelector('.bili-video-card') &&
        !card.querySelector('a[href*="/bangumi/"], a[href*="live.bilibili.com"], a[href*="/opus/"], a[href*="/festival/"]') &&
        !card.querySelector('a[href*="/video/"]')) {
        return 'link';
      }
      // 6) 低置信：缺少正常视频卡的「不感兴趣 / 稍后再看」标记，且没有任何正常内容链接
      if (!card.querySelector('a[href*="/video/"]') && card.querySelector('.bili-video-card')) {
        var v = card.querySelector('.bili-video-card');
        var other = card.querySelector('a[href*="/bangumi/"], a[href*="live.bilibili.com"], a[href*="/opus/"]');
        if (!other && !v.classList.contains('enable-no-interest') && !card.querySelector('.bili-watch-later--wrap')) return 'nocontrol';
      }
    } catch (e) { warn('判卡异常', e); }
    return '';
  }

  /* ======================= 卡片填充 / 原位替换 ======================= */
  function setAll(sel, fn, root) {
    try { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); } catch (e) {}
  }
  function cleanAdTraces(node) {
    try {
      Array.prototype.forEach.call(node.querySelectorAll('*'), function (el) {
        ['data-target-url', 'data-mod', 'data-is-ad', 'data-ad', 'data-ad-id', 'data-report-id'].forEach(function (a) {
          try { el.removeAttribute(a); } catch (e) {}
        });
      });
      Array.prototype.forEach.call(node.querySelectorAll(
        '.bili-video-card__info--ad, .bili-video-card__info--ad-creative, ' +
        '.bili-video-card__info--creative-ad, svg.ad-tag, [class*="creative-ad"], [data-is-ad="true"]'
      ), function (el) { try { el.remove(); } catch (e) {} });
    } catch (e) {}
  }
  function fillCard(node, item) {
    var key = itemKey(item);
    var url = item.bvid ? 'https://www.bilibili.com/video/' + item.bvid + '/' :
      (item.id ? 'https://www.bilibili.com/video/av' + item.id + '/' : '');
    var pic = normPic(item.pic || item.cover || '');
    var title = String(item.title || '').replace(/<[^>]*>/g, '');
    var author = (item.owner && item.owner.name) || item.author || item.uname || '';
    var mid = (item.owner && item.owner.mid) || item.mid || '';
    var view = formatCount(statVal(item, 'view', 'play'));
    var danmaku = formatCount(statVal(item, 'danmaku', 'reply'));
    var dur = formatDuration(item.duration);

    // 主封面链接 + 标题链接
    if (url) {
      setAll('a.bili-video-card__image--link, a[class*="image--link"], a[class*="info--tit"], a[title]', function (a) {
        try { a.setAttribute('href', url); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); } catch (e) {}
      }, node);
    }
    if (title) {
      setAll('a[class*="info--tit"], [class*="info--tit"], a[title]', function (el) {
        try { el.textContent = title; el.setAttribute('title', title); } catch (e) {}
      }, node);
    }
    // 封面
    if (pic) {
      setAll('img', function (img, i) {
        if (i > 0) return;
        try {
          img.setAttribute('src', pic);
          img.setAttribute('data-src', pic);
          img.removeAttribute('srcset');
          img.style.opacity = '1';
        } catch (e) {}
      }, node);
      setAll('source', function (s) { try { s.setAttribute('srcset', pic); } catch (e) {} }, node);
      setAll('[class*="image--wrap"], [class*="cover"]', function (el) {
        try { el.style.backgroundImage = 'url("' + pic + '")'; } catch (e) {}
      }, node);
    }
    // UP 主（只改署名文本节点，不动头像等子元素）
    if (author) {
      var authorEl = node.querySelector('[class*="info--author"]') || node.querySelector('[class*="author"]');
      try {
        if (authorEl) {
          authorEl.textContent = author;
          if (mid && authorEl.tagName === 'A') authorEl.setAttribute('href', 'https://space.bilibili.com/' + mid + '/');
        }
      } catch (e) {}
    }
    // 播放 / 弹幕：优先改数字文本节点，避免清掉播放图标
    var statTexts = node.querySelectorAll('[class*="stats--text"], [class*="stat--text"], [class*="stats--item"] span');
    var statEls = statTexts.length ? statTexts : node.querySelectorAll('[class*="stats--item"], [class*="stat--item"]');
    try {
      if (statEls.length >= 1 && view) statEls[0].textContent = view;
      if (statEls.length >= 2 && danmaku) statEls[1].textContent = danmaku;
    } catch (e) {}
    if (dur) {
      setAll('[class*="duration"], [class*="stats__duration"]', function (el) {
        try { el.textContent = dur; } catch (e) {}
      }, node);
    }
    cleanAdTraces(node);
    node.setAttribute(REAL, '1');
    node.setAttribute(DONE, '1');
    node.removeAttribute(PEND);
    node.classList.remove('yb-pending');
    try { node.setAttribute('data-yb-bvid', key || ''); } catch (e) {}
    return node;
  }
  function buildReplacement(item, adCard) {
    var tpl = ensureTemplate();
    var node;
    if (tpl) node = tpl.cloneNode(true);
    else node = adCard.cloneNode(true); // 极端兜底：至少保留骨架
    node.removeAttribute(DONE);
    node.removeAttribute(REAL);
    // 模板本身是真实 .feed-card，自带正确 grid class，不复制广告卡的 class
    return fillCard(node, item);
  }
  function replaceCard(card, item) {
    try {
      var fresh = buildReplacement(item, card);
      card.parentNode.replaceChild(fresh, card);
      state.replaced++;
      log('原位替换广告卡 →', item.title);
      return true;
    } catch (e) { warn('替换失败', e); return false; }
  }
  function dropCard(card) {
    try { card.classList.remove('yb-pending'); card.removeAttribute(PEND); card.remove(); state.removed++; } catch (e) {}
  }

  /* ======================= DOM 扫描与观察器 ======================= */
  function flushPending() {
    if (!state.pending.size) return;
    var cards = Array.prototype.slice.call(state.pending);
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (!card.parentNode) { state.pending.delete(card); continue; }
      var item = takeSpare();
      if (item) { state.pending.delete(card); replaceCard(card, item); }
      else if (!ensureTemplate()) { /* 还在等请求 */ }
      else {
        // 无接口数据但有同页真实卡模板：直接复用一张真实卡内容补位
        state.pending.delete(card);
        var cloned = ensureTemplate().cloneNode(true);
        cloned.removeAttribute(DONE); cloned.removeAttribute(REAL);
        cloned.setAttribute(REAL, '1'); cloned.setAttribute(DONE, '1');
        cleanAdTraces(cloned);
        try { card.parentNode.replaceChild(cloned, card); state.replaced++; } catch (e) { dropCard(card); }
      }
    }
  }
  function processCard(card) {
    if (!CONFIG.enable || !CONFIG.cleanFeed) return;
    if (!card || card.nodeType !== 1) return;
    if (card.getAttribute(DONE) === '1' || card.getAttribute(REAL) === '1') return;
    var reason = isAdCard(card);
    if (!reason) return;
    state.adCards++;
    card.setAttribute(DONE, '1');
    log('命中广告卡', reason, bvidFromCard(card));
    var item = takeSpare();
    if (item) { replaceCard(card, item); return; }
    // 池空：先隐藏广告内容（保留布局槽，不显示广告），等接口数据来原位替换
    card.setAttribute(PEND, '1');
    card.classList.add('yb-pending');
    state.pending.add(card);
    ensureSpare();
    setTimeout(function () {
      if (!state.pending.has(card)) return;
      var it = takeSpare();
      if (it) { state.pending.delete(card); replaceCard(card, it); return; }
      var tpl = ensureTemplate();
      if (tpl) {
        state.pending.delete(card);
        var c = tpl.cloneNode(true);
        c.removeAttribute(DONE); c.removeAttribute(REAL);
        c.setAttribute(REAL, '1'); c.setAttribute(DONE, '1');
        cleanAdTraces(c);
        try { card.parentNode.replaceChild(c, card); state.replaced++; } catch (e) { dropCard(card); }
      } else {
        // 最终降级：整卡移除，grid 自然重排，不留空白容器
        state.pending.delete(card);
        dropCard(card);
        log('补位失败，移除广告卡让栅格自然补位');
      }
    }, CONFIG.pendingTimeout);
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var cards;
    try { cards = root.querySelectorAll('.feed-card, .bili-feed-card'); } catch (e) { return; }
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (n++ > 150) break;
      processCard(cards[i]);
    }
  }
  function scanAll() {
    scan(document.body || document.documentElement);
    applyCss();
  }
  var scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    var run = function () { scheduled = false; scanAll(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 30);
  }
  function startObserver() {
    if (state.observer || !document.body) return;
    try {
      state.observer = new MutationObserver(function (records) {
        var dirty = false;
        for (var i = 0; i < records.length; i++) if (records[i].addedNodes.length) { dirty = true; break; }
        if (dirty) scheduleScan();
      });
      state.observer.observe(document.body, { childList: true, subtree: true });
      log('MutationObserver 就绪');
    } catch (e) { warn('Observer 挂载失败', e); }
  }

  /* ======================= 分场景 CSS 兜底 ======================= */
  var STYLE_ID = 'yb-bili-ad-style';
  function baseCss() {
    return [
      '/* 广告角标 / 横幅 / 活动浮层：只隐藏广告本体，不动 grid 卡片 */',
      '.bili-video-card__info--ad,.bili-video-card__info--ad-creative,',
      '.bili-video-card__info--creative-ad,svg.ad-tag,svg.bili-video-card__info--creative-ad,',
      '.ad-floor-cover,.ad-floor-exp,.strip-ad,.slide-ad-exp,#bannerAd,#activity_vote,',
      '.activity-m-v1,.video-card-ad-small,.video-page-game-card-small,.bili-dyn-ads,',
      '[class*="ad-report"],[class*="ad-floor"],.ad-report.left-banner,.strip-ad.left-banner,',
      '.bili-live-card.is-rcmd.enable-no-interest .bili-live-card__info--ad',
      '{display:none!important}',
      '.yb-pending{visibility:hidden!important}',
      '[data-yb-real="1"]{visibility:visible!important}'
    ].join('\n');
  }
  function sceneCss() {
    var host = location.hostname, path = location.pathname, out = [];
    if (host === 'www.bilibili.com' && (path === '/' || path === '')) {
      if (CONFIG.hideCarousel) out.push('.recommended-swipe,.recommended-container,.bili-feed-card.is-carousel{display:none!important}');
      if (CONFIG.cleanHomeExtras) out.push(
        '.ad-report.ad-floor-exp.left-banner,.fixed-card,.bili-video-card__info--ad,' +
        '[class*="activity-banner"],[class*="ad-banner"]{display:none!important}');
      if (CONFIG.hideLiveCard) out.push('.bili-live-card.is-rcmd.enable-no-interest{display:none!important}');
      // 首屏对齐：隐藏推广位后让推荐流自然平铺，不留空白容器
      out.push('.feed-card{margin-top:0!important}');
    }
    if (/^\/video\//.test(path) && CONFIG.cleanVideoPage) {
      out.push(
        '.ad-report.strip-ad.left-banner,.video-card-ad-small,.video-page-game-card-small,' +
        '.slide-ad-exp,#activity_vote,.activity-m-v1,.ad-floor-exp,.strip-ad,' +
        '[class*="ad-report"],[class*="game-card"],[class*="activity-card"]{display:none!important}');
    }
    if (/^\/bangumi\/play\//.test(path) && CONFIG.cleanBangumi) {
      out.push('.ad-report,.slide-ad-exp,#bannerAd,.activity-m-v1,[class*="ad-floor"]{display:none!important}');
    }
    if (host === 'search.bilibili.com' && CONFIG.cleanSearch) {
      out.push(
        '[class*="col_"]:has(.bili-video-card__info--ad),' +
        '[class*="col_"]:has(.bili-video-card__info--ad-creative),' +
        '[class*="col_"]:has(.bili-video-card__info--creative-ad),' +
        '[class*="col_"]:has(a[href*="cm.bilibili.com"][data-target-url]){display:none!important}');
    }
    if (host === 't.bilibili.com' && CONFIG.cleanDynamic) {
      out.push('.bili-dyn-ads,[class*="dyn-ads"],[class*="ad-card"]{display:none!important}');
    }
    if (host === 'live.bilibili.com' && CONFIG.cleanLive) {
      out.push(
        '.player-area-ctnr.border-box.p-relative.t-center,' +
        '[class*="activity-banner"],[class*="ad-report"],[class*="game-card"]{display:none!important}');
    }
    return out.join('\n');
  }
  function applyCss() {
    if (!CONFIG.enable) return;
    var key = location.hostname + location.pathname;
    var css = baseCss() + '\n' + sceneCss();
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      var host = document.head || document.documentElement;
      if (!host) { setTimeout(applyCss, 50); return; }
      style = document.createElement('style');
      style.id = STYLE_ID;
      try { host.appendChild(style); } catch (e) { setTimeout(applyCss, 50); return; }
    }
    if (state.cssKey === key && style.textContent === css) return;
    style.textContent = css;
    state.cssKey = key;
  }
  function installSpaWatcher() {
    try {
      window.addEventListener('popstate', function () { setTimeout(scanAll, 120); });
      ['pushState', 'replaceState'].forEach(function (name) {
        var orig = history[name];
        history[name] = function () {
          var r = orig.apply(this, arguments);
          setTimeout(scanAll, 120);
          return r;
        };
      });
    } catch (e) {}
  }

  /* ======================= 调试接口 ======================= */
  function exposeDebug() {
    try {
      window.__YBBiliAd = {
        report: function () {
          return {
            enabled: CONFIG.enable,
            feedResponses: state.feedSeen,
            apiAdItems: state.apiAds,
            adCards: state.adCards,
            replaced: state.replaced,
            removed: state.removed,
            sparePool: state.sparePool.length,
            adBvids: state.adKeys.size,
            signedUrl: !!state.signedUrl,
            requests: state.reqCount,
            apiDisabled: state.apiDisabled,
            pending: state.pending.size
          };
        },
        debug: function (on) {
          DEBUG = on !== false;
          try { localStorage.setItem('__yb_debug', DEBUG ? '1' : '0'); } catch (e) {}
          return DEBUG;
        },
        setConfig: function (o) {
          try { localStorage.setItem('__yb_config', JSON.stringify(o)); return '已保存，刷新生效'; }
          catch (e) { return String(e); }
        },
        rescan: scanAll,
        md5: md5,
        resetFirstDonate: function () {
          try { localStorage.removeItem(YBC_SEEN_KEY); } catch (e) {}
          try { document.cookie = YBC_SEEN_CK + '=; domain=.bilibili.com; path=/; max-age=0'; } catch (e) {}
          ui.donateSeen = false;
          return '已重置首次弹窗标记，刷新页面即可再体验一次';
        },
        donateSeen: function () { return ybcSeen(); }
      };
    } catch (e) {}
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('BilibiliAdCrush：查看统计', function () {
          console.log('[BilibiliAdCrush]', window.__YBBiliAd.report());
        });
      }
    } catch (e) {}
  }

  /* ======================= 悬浮菜单 / 打赏窗口 ======================= */
  /* 两张收款码以 data URI 内嵌，脚本自包含，不依赖任何外部图床。 */
  var YBC_IMG = {
    alipay: 'data:image/jpeg;base64,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khvegGucxwFK1V6Zxo3DPjkETHYYrtldt3nlj2epk2egIZT1e45PB/irtAB+JdUVd4qpXRRnqd/x9CX5ZJNuSN3wUg+GSLYn7MpZIc96q7R8l2j5LtHyyX5MF2j5LtnyXaPkr8eFPYItqk2+wO2ZHbFLtySASuAr4pwc8uF3vOSjZHAUWlf55Yt1SbExrn0IC0gWkCDhgUXOzALSBaQJjo3VF3JHsUmxdG9tL33lUZDdxRe9t6veFn9CPYpSPwrSv81pX+aj2KQj8K0r/NaV/mo90KTZ6HVBKuys/t+J9C4xh6P4d6zgj0JckmQsldTPmRHSYp13Cqi2KTZ6TdqC+aDJBUFaIJvRigd7DFtUm317WeJRcHl1cjtil25C50YJKvRsDTkvSMBK0TU8DxyRbqk2ZGydJSq0oTWeAUuz0Y9ik2K+5gJrk67w2qqDXJ1o2+S7JGxNdHWpOSPYpd3LHsUu6mx1pVaUprPAUUmzI6+T1V2K7V1Y2j5ZKvcArtc3iqtcDk60bT8l2KbEGsrQjJJkkytjrSq0pTY61uhSbMjYzmvLSuWlctK5A9K7J0biRsTZBI6rcgvEingnvEjswr7BFtUm318ZOYVWmaq9KE6RuCkvuAzrStRaGl1O9aNy0blo3LRuTneOSIF7eypAHtwyRgyAFaVq0rU6JjrzneiwGQVopAJBWiPSPAzqkLanxKvSOquo87F/djr8Qu1d2rNI1NuuBz5IwZBWikAkFaZYwZBWikAkbWijJzCq0rVpWoxROvE9+STpHhtV272xf24ydqzUaFV7i7bkrG8tXWo5deMjYu3d2phjdeFMj77gFpWqQtNRlYXGgWlatK1Oa115xzZsjHuzAFaULShaULShaULShaULShaVPa2TOR7BFtUm382xbVJt/NsW1SbfzbFtUm382xbVJt/NsW1SbfzbFtUm382xbVJt/NsW1SbfzbFtUm382xbVJt/NsW1SbfzbFtUm32MAYlau9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au9au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RyoW54gca0p4j39WsC2xpOBd34p0JO0ueEqosxvL7Vi06wka/YKvII0KnLI/2YMJZoybwKhHlX+CinZH1uqumo/nUleIsyn+2rCFN4D1FmqnAdhDyl6jkdRdkdrMGGozXaigOCqRV5x4q3zhF/FZiI1uFkIE3ebD1XxrINQFCpnt+s/1q4BZ8BHSRrnMcnEavoUelplLwc5gXGOoHHNY43OR+BzYThGuFRLk4hcTlnyPaNVVISM9bJDeclrN0iLLSlYqSuJQiYHBMX921RKBSzWUi/7B3gVTsm/YTaQVHJFaUriMmfOh3sNRqVbTUWg3YRNuy9SXxXJwUmk8RXXFiqH1Da608yMomFqPCwsMIZ8nmOw4plN8WyHBDgugsrVxMCI3LCzQ5hkhgsSCIqor5CSAIJl53uHK/sZcFxzz5FWPpQiWXkoWmcCjCQqSOI68NVKKUabUNTlzHciwLZh3F+q/7wdWoQt/lCH+qIQxrKtIctqHxDqHNqox5zEr2IiNUuObY8o+RilJtpqQAIW6EDKq4iOf1FYQDIXYdEurGHPpoubNVGmjLWjBrJzkTaCRCGhTUnIqOaEczZFQt3B/Y2KRXshVtOD0ZlfgU0sGhtF0yyRAobaqsVUamr3Egy3kUc0mkoiCKNMRYVPf2IbroOF2CXE58T7VLMZZdVHJPB7ognB4LJocVwa/g5H8A1jNIohHNPkZvTMqSTP5rgPUBqXxthVHDgO9iD35UEi1FwHeBVj6KlREmVk0/U/9wJVAxOPnZFKBamJ7LpYQL1MKiTQhk18V3DCTgahWHZ0wXmavgNslPlIVISJdTu8UT2qc2Cs6vihNAqlxBW9WoSShA5mHSjLS0QqrgTaQqSzgjKYECapZqSeuaCL3LkmFqS58Nqm2xOo4P+j6mcJcFpJzOriKlugqeuEG5GcWIbDCE1S2rOXBv+ixCdUhAaVxRJFJCwgRDuK6qlgtOlOrOOCVYsIJTgh2FAvA1wccDfS9O9CRSW7QVC2hWAivJVFUqeOEKiJqwoA2Y1EdYV3/AId//wD/AP8A/wC/UlAv9a73ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve973ve9qygZ/9oADAMBAAIAAwAAABDnM888888888888888888888888888888888888888888888888888tCtzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyitfzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyitfzzzzzzzzzzzzzzx5HPOPZzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyitfzzzzzzzzzzzzzynXnH3D3vzDCzTzhzyxTDzX3jjzzzzzzzzzzzzyitfzzzzzzzzzzzzzyn4nu5Fj6ywzgwSigwgCAhWFzXzzzzzzzzzzzzyitfzzzzzzzzzzzzzyn6IqVMW7yRxhgxz3wni020UmzzzzzzzzzzzzzyitfzzzzzzzzzzzzzylM4lrxfjxyx0/CG7yCgDHEkXHzzzzzzzzzzzzyitfzzzzzzzzzzzzzym5Hhyt9jzhEeoMD0gKTTBUmD3zzzzzzzzzzzzyitfzzzzzzzzzzzzzzi1CxDD9FcGPBHePOAOPMEEFEDzzzzzzzzzzzzyitfzzzzzzzzzzzzzzz532011/wwwxyzwwzxywwwxyzzzzzzzzzzzzzyitfzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyitfzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyiujf/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AMzlLTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTFfffffffffffffffffffffffffffffffffffffffffffffffffffffaVfffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffQUde9+sd+J2q0N3sffvv8A/rz3qdTzzzTzz7z3P/v3333332tX333333zkZEkxcRyI11mvm/xFM6fAywRlUVTCsyIccR7xjb7333332tX3333338robNqAUCHGVvgWmatCFx3YO5LUBc/Qk5nEuAi0X3333332tX333332sJhQjYvc91MCAM5XP8WPnLcfM0vYL9YnYr2i4uFLz333332tX3333332r4CqktAb4mINLFG/RIe0vtSEJQxixZm6v1pGQC7z333332tX3333320TU3YqgDtic+IR/KZ48F6EuWrQD4chsb8ynnX4zt/333332tX3333321y5/wB9N/8AvPvfvvfXnr/TrzzTTfHfbDnPrrTzjj/3ffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa1ffffffffffffffffffffffffffffffffffffffffffffffecMffffa1fffffffffiQcMsssssssssssssssssssssssssssssspvPeDyC+Pfa1fffffffffhPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPKOHD/szb9Pa1ffffffffflPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPKClNUAV3FvK1ffffffffflPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPIAX/AODdUj2tX33333333xTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxljMzTDT/wBrV999999998U8888www4cMIw40QoUU8o8wo4k0ww0U88887qNQkhG/wDK1fffffffffFPPPPENOAPOHPLCLPOCDFPDHHFFPOOFPPPPBqpsV9oP/a1fffffffffFPPPPFFPAOMFEJNMPCIEBNNPBNFPPAFPPPPF/Pb7tPPfa1fffffffffFPPPPCPPAPOFDNIDBOEPPPFLAPFHLLFPPPPF/fffffffa1fffffffffFPPPPNMOKPPHNCHPNKPKBPEDDEJPMMFPPPPF/fffffffa1fffffffffFPPPPONFENPIABHGMHJKINEIHNJANOPPPPPF/fffffffa1fffffffffFPPPPAMDNKKFNPLPCNIJAMEPGADHAAPPPPPF/fffffffa1fffffffffFPPPPBKKBOLEALGLJNGOEANBEDNEHCPPPPPF/fffffffa1feFr49PffFPPPKJNPEPPFLFOPGOLKPLGNLIPPENNPPPPF/fffffffa1esH2C9F/fFPPPPIPLFFPPNPGMgihnuNPBPPNPJBHPPPPF/fffffffa1a+OpE41/fFPPPPIKJIJDCHOL2RffOCUGNOFMPGPPPPPPF/fffffffa0bcSVyZn/fFPPPPAKPKAPAPPBTkVJlRFDHHCEPKPPPPPPF/fffffffa1b3Uc9fPvfFPPPPIMKMGPNENMoIAmKkkPEDHFLJHNPPPPF/fffffffa1bZRlDfnffFPPPLPEBOCEMAPObkOA6UaPKHNMKMIFPPPPF/fffffffa1fbLZf/fffFPPPPLBHNHPCGOAR8uzwYTMDDPFDFGHPPPPF/fffffffa1fffffffffFPPPPFANEFLBGJHvP/hiOlMMKMOLDJFPPPPF/fffffffa1fffffffffFPPPOGMKOMOEOMM4DCzvluHKBHEIDDFPPPPF/fffffffa1fffffffffFPPPPFHOIFKGMNDPEAPLLANOHJDPFLPPPPPF/fffffffa1fffffffffFPPPOEMNOAKLHNLKBNOKDNKGLENOBAPPPPPF/fffffffa1fffffffffFPPPPJHLAJLFKFLJCLNMLDMHPENANCPPPPPF/fffffffa1fffffffffFPPPPGMMMEIJCOFPPFBCNEOJDOEOIFFPPPPF/fffffffa1fffffffffFPPPPPPPPPKJLJNODPNKDEEKPELPOHHPPPPF/fffffffa1fffffffffFPPPPADCILBLCHHDOCDNKAIDLBDPOHNPPPPF/fffffffa1fffffffffFPPPPFFLAPAEPPLMNPKABEPPPJDGFIFPPPPF/fffffffa1fffffffffFPPPPFEIAPJAMHPGCFOOAEBPPEPBCKFPPPPF/fffffffa1fffffffffFPPPPAAAIPIHJJNIIBMAADPNMMDLAIPPPPPF/fffffffa1fffffffffFPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPF/fetN/ffa1fffffffffFPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPF/wAMl6rX32tX33333333xTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxe9PrKovX2tX33333333xTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxc6qUq0r32tX33333333xTzzzz3v8A288468wz/wD89gvO/PPPP/vPPPPPF8+YF2D/AH2tX33333333xTzzzyGQL1ZgMCsZm5vi4l8x7HRbJb7zzzzxf33NQrz32tX33333333xTzzzwj6z6Eh+X6qf0aImi50U54tiT3zzzzxf336/wB/99rV999999998U8888vxiCRCgU2lbvThn5Fy08sTTPy88888X99999999rV999999998U8888888888888888888888888888888888X99999999rV999999998U8888888888888888888888888888888888X99999999rV99999999rlNPNPPPNNPPNNPPPNPPPNNPPNNPPNNPPNNPDd9999999rV99999999999999999999999999999999999999999999999999999rV99999999999999999999999999999999999999999999999999999rV99999999998+99+694x99999x982990x9+6290195881999999999rV9999999986hFb2gyy/6Ryb6d/aledxvt0144/ZKvt25/wDffffffffa1fffffffffWTf0vfhEJXqr5DGolApyBj/GC/bujKlu9ciHffffffffa1fffffffffehDQXv+kmD3L0Pbd6j8dzi+TuAOpKSxr4QqPffffffffa1fffffffffeMnVrlIuJBXbjfIJvrjNP7/Fsitf7TXP3HHvPfffffffa1ffffffffffffPffPfffffPPPfffffPPPPPfffffPPffffffffffffa1fffffffffffffffffffffffffffffffffffffffffffffffffffffa4Agggggggggggggggggggggggggggggggggggggggggggggggggggggv/xAAqEQACAQMDBAICAwEBAQAAAAAAAREhMaEwYXEQQVBRIJGBwUCx8OHx0f/aAAgBAwEBPxBJNEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIhEIaUCt5Z2FZeWdhWX8CHcs9KmxNqbEXdUQdj9eAdh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',
    wechat: 'data:image/jpeg;base64,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dytbAWMWIUMzHMGXNOn5cI8kd5j6YNzWXLI7OnlQZiq5sFy5uGIochnyxtL+NPXqqJMEfV+4yzwByssBuuOJ5t9TUHnc14S1S0GjioLpDJ8o4cOplvjiSv1RbRHHr+IjohfXiPV4z1MXW+PnA0bTzKfqleAHoRuafQ6oXRuLNizMZvV/jfEerKE3od5r195uke34hNbGbZvrO01AmvfMNR6MltmsfM3Amut7Qm2M1k1SHb8zfr7Tej3/AMIWmbZO7NEoD1doPYM4DP2D9Q539Ijd+Ijl4g394LoQfQ8kG0fJBOHme5KesslkslkslPWe5EOHmIbPkiex5IjsRL+8By8RDV+I8b+k/YP1OAxegIj0dpslNsvdim3oFwRzPdZ76e6nvp7rFOZf+zOJwL8RCNFfWUStiFuVXKMVMW2/7MPhhlF4QTX1H56emKBputV7x0AUt6+3oShSZGK3f2uXDIDJyfMG0nB0enqbzNCVV269sIXchsc4z3YW/JvD2NPaUmcU71+WMu46cqsZvdcQVUW/qVQClX7fL1hBbstTHi5nyorVOPWcgBRRR824hdM3Sdtn4hQGnZkqG2B7At7z3hb/APPP/8QALhABAAICAQIGAgMAAwADAQEAAQARITFBUWEQcYGRwfChsSBg0VDh8TCQoECA/9oACAEBAAE/EP7hcv8As9y/4MOcCz4HGOsTfqbt2PiLFCEXAxfife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/ife/iCFIOVm/EGBr1NWrPxHPEM+BzjrDxY0928R7PKPHEbAHOev8AZzhgNADjPWBPdvMezyh/BYf2dg/xIUQQdMP7SQoA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'
  };
  var YBC_COPY = {
    alipay: {
      label: '绿色能量 · 支付宝',
      lead: '扫它，攒一份蚂蚁森林能量。',
      sub: '燃料不灭火，只让火更旺一点。'
    },
    wechat: {
      label: '赞赏 · 微信',
      lead: '「你的智齿，是我更新的动力」',
      sub: '原话奉还：智齿还在，更新也在。'
    }
  };
  var ui = {
    root: null, panel: null, badge: null, stat: null, overlay: null,
    tab: 'alipay', collapsed: true, timer: null, drag: null,
    expandedH: 0, animTimer: null,
    donateSeen: false, donateMode: ''
  };

  /* 插件反馈 QQ 群：完整分享链接 + 群号兜底（分享链接可能过期，群号长期有效） */
  var YBC_GROUP = {
    id: '1134860332',
    name: '插件反馈',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=%2FDXPFWwtWjj98jGsOT9H2qhcfYu7jWQnh1zdMVXhq6umiD4Uq4CyVtLuKEwBqYVi&busi_data=eyJncm91cENvZGUiOiIxMTM0ODYwMzMyIiwidG9rZW4iOiJIY0JURm1XVHRUSlBieCtwUEtTZ3dPYWNXR25tMTNTaS9CaUZYNFVuVmc2SWpLWHRKR2pOTk5rSyt4eU9TYkoyIiwidWluIjoiMzU2MDcwNzgwOCJ9&data=Lac66SlF9K0iOqtDDj_THt-fbvlaQi8u4MOPQ3tPk7QgY768r30ut_DrWnZO7yLAWCClGuvRSSJdC25_cevCQg&svctype=4&tempid=h5_group_info'
  };

  /* 首次弹窗标记：独立于 @version，脚本更新不会重置。
     localStorage 管本 origin 长期持久，.bilibili.com cookie 管跨子域（www/search/t/live/space）共享，
     内存标记兜底无痕模式等存储不可写场景。三者任一命中即不再弹。 */
  var YBC_SEEN_KEY = '__ybc_donate_seen', YBC_SEEN_CK = 'ybc_donate_seen';
  function ybcSeen() {
    if (ui.donateSeen) return true;
    try { if (localStorage.getItem(YBC_SEEN_KEY)) { ui.donateSeen = true; return true; } } catch (e) {}
    try {
      if (new RegExp('(?:^|;\\s*)' + YBC_SEEN_CK + '=').test(document.cookie)) {
        ui.donateSeen = true; return true;
      }
    } catch (e) {}
    return false;
  }
  function ybcMarkSeen(v) {
    ui.donateSeen = true;
    try { localStorage.setItem(YBC_SEEN_KEY, v || '1'); } catch (e) {}
    try {
      document.cookie = YBC_SEEN_CK + '=1; domain=.bilibili.com; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
  }
  // 观看场景不打扰：播放页 / 番剧 / 直播不自动弹，其余页面首次使用才弹
  function ybcShouldAutoDonate() {
    if (ybcSeen()) return false;
    if (location.hostname === 'live.bilibili.com') return false;
    if (/^\/video\//.test(location.pathname) || /^\/bangumi\/play\//.test(location.pathname)) return false;
    return true;
  }
  function ybcCopyText(t, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, t.length);
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e) { return false; }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { ybcToast(okMsg); }, function () {
          ybcToast(fallback() ? okMsg : '复制失败，请手动记群号 ' + YBC_GROUP.id);
        });
        return;
      }
    } catch (e) {}
    ybcToast(fallback() ? okMsg : '复制失败，请手动记群号 ' + YBC_GROUP.id);
  }
  function ybcOpenContact() {
    try {
      var a = document.createElement('a');
      a.href = YBC_GROUP.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      ybcToast('插件反馈群 ' + YBC_GROUP.id + ' · 链接失效可直接搜群号');
    } catch (e) {
      ybcToast('请搜索 QQ 群 ' + YBC_GROUP.id);
    }
  }

  function ybcStyle() {
    if (document.getElementById('ybc-style')) return;
    var css = [
      '.ybc-panel{position:fixed;z-index:2147483000;width:268px;background:rgba(18,20,26,.94);',
      '  -webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);color:#f2f3f7;',
      '  border:1px solid rgba(255,255,255,.12);border-radius:16px;overflow:hidden;',
      '  box-shadow:0 12px 38px rgba(0,0,0,.38);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      '  touch-action:none;user-select:none;-webkit-user-select:none;transition:none}',
      '.ybc-panel.ybc-collapsed{border-radius:50%;box-shadow:0 8px 26px rgba(0,0,0,.42)}',
      '.ybc-panel.ybc-anim{transition:width .32s cubic-bezier(.22,1,.36,1),height .32s cubic-bezier(.22,1,.36,1),',
      '  border-radius .32s cubic-bezier(.22,1,.36,1),left .34s cubic-bezier(.22,1,.36,1),top .34s cubic-bezier(.22,1,.36,1)}',
      '.ybc-head{display:flex;align-items:center;gap:9px;padding:10px 12px;height:50px;box-sizing:border-box;cursor:grab;',
      '  background:linear-gradient(100deg,rgba(255,107,53,.18),rgba(255,107,53,0));',
      '  border-bottom:1px solid rgba(255,255,255,.08);',
      '  transition:height .32s cubic-bezier(.22,1,.36,1),padding .32s ease,',
      '  background .32s ease,border-color .32s ease,gap .32s ease}',
      '.ybc-collapsed .ybc-head{padding:0;height:58px;gap:0;justify-content:center;',
      '  border-bottom-color:transparent;background:transparent}',
      '.ybc-flame{flex:0 0 30px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;',
      '  transition:transform .32s cubic-bezier(.22,1,.36,1)}',
      '.ybc-flame svg{width:28px;height:28px}',
      '.ybc-collapsed .ybc-flame{transform:scale(1.14)}',
      '.ybc-titles{flex:1;min-width:0;max-width:190px;display:flex;flex-direction:column;line-height:1.25;',
      '  opacity:1;overflow:hidden;',
      '  transition:opacity .2s ease,max-width .32s cubic-bezier(.22,1,.36,1)}',
      '.ybc-titles b{font-size:13px;letter-spacing:.2px;white-space:nowrap}',
      '.ybc-titles i{font-size:10px;font-style:normal;color:#9aa0ad;white-space:nowrap}',
      '.ybc-collapsed .ybc-titles{opacity:0;max-width:0;pointer-events:none}',
      '.ybc-badge{flex:0 0 auto;min-width:20px;height:20px;padding:0 5px;border-radius:10px;opacity:1;',
      '  background:#ff6b35;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:20px;',
      '  transition:opacity .18s ease,min-width .28s ease,width .28s ease,padding .28s ease,transform .28s ease}',
      '.ybc-collapsed .ybc-badge{opacity:0;min-width:0;width:0;padding:0;transform:scale(.3);pointer-events:none}',
      '.ybc-toggle{flex:0 0 auto;width:24px;height:24px;border:0;border-radius:8px;opacity:1;overflow:hidden;',
      '  background:rgba(255,255,255,.1);color:#f2f3f7;font-size:16px;line-height:1;cursor:pointer;',
      '  transition:opacity .18s ease,width .28s ease,transform .28s ease}',
      '.ybc-collapsed .ybc-toggle{opacity:0;width:0;min-width:0;transform:scale(.4);pointer-events:none}',
      '.ybc-body{padding:12px;opacity:1;transform:none;',
      '  transition:opacity .2s ease,transform .32s cubic-bezier(.22,1,.36,1)}',
      '.ybc-collapsed .ybc-body{opacity:0;transform:translateY(-8px) scale(.97);pointer-events:none}',
      '.ybc-stat{display:flex;justify-content:space-between;gap:6px;margin-bottom:10px;',
      '  padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.055);font-size:11px;color:#c9cdd6}',
      '.ybc-stat b{color:#ffb08a;font-size:13px}',
      '.ybc-row{display:flex;align-items:center;justify-content:space-between;padding:6px 2px;font-size:12px}',
      '.ybc-row+.ybc-row{border-top:1px solid rgba(255,255,255,.06)}',
      '.ybc-sw{position:relative;width:38px;height:22px;border-radius:11px;background:rgba(255,255,255,.16);cursor:pointer;transition:background .18s}',
      '.ybc-sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;',
      '  background:#fff;transition:transform .18s}',
      '.ybc-sw.on{background:#ff6b35}.ybc-sw.on::after{transform:translateX(16px)}',
      '.ybc-btns{display:flex;gap:7px;margin-top:11px}',
      '.ybc-btn{flex:1;padding:8px 4px;border:0;border-radius:10px;font-size:11px;cursor:pointer;',
      '  background:rgba(255,255,255,.09);color:#f2f3f7}',
      '.ybc-btn.hot{background:linear-gradient(135deg,#ff6b35,#ff9248);color:#fff;font-weight:700;flex:1.5}',
      '.ybc-foot{margin-top:11px;text-align:center;font-size:10px;color:#7d838f}',
      /* 联系我们：菜单里的一个独立子项 */
      '.ybc-contact{display:flex;align-items:center;gap:8px;margin-top:10px;padding:9px 10px;',
      '  border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.045);cursor:pointer}',
      '.ybc-contact-t{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3}',
      '.ybc-contact-t b{font-size:12px;color:#f2f3f7;font-weight:600}',
      '.ybc-contact-t i{font-size:10px;font-style:normal;color:#9aa0ad;white-space:nowrap}',
      '.ybc-contact-go,.ybc-contact-cp{flex:0 0 auto;width:26px;height:26px;border:0;border-radius:8px;',
      '  background:rgba(255,255,255,.1);color:#ffb08a;font-size:13px;line-height:1;cursor:pointer}',
      '.ybc-contact-cp{color:#c9cdd6}',
      '.ybc-mask{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.62);',
      '  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;',
      '  font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.ybc-card{width:100%;max-width:380px;max-height:88vh;overflow:auto;background:#171a21;color:#f2f3f7;',
      '  border:1px solid rgba(255,255,255,.13);border-radius:20px;padding:18px;',
      '  box-shadow:0 20px 60px rgba(0,0,0,.55);-webkit-overflow-scrolling:touch}',
      '.ybc-card h2{margin:0;font-size:19px;letter-spacing:.5px}',
      '.ybc-card .ybc-en{margin:1px 0 10px;font-size:10px;letter-spacing:2.2px;color:#ff8a5c;text-transform:uppercase}',
      '.ybc-card .ybc-lead{margin:0 0 14px;font-size:12.5px;color:#c3c8d2}',
      '.ybc-tabs{display:flex;gap:7px;margin-bottom:12px}',
      '.ybc-tab{flex:1;padding:8px 4px;border:1px solid rgba(255,255,255,.12);border-radius:10px;',
      '  background:transparent;color:#c3c8d2;font-size:11.5px;cursor:pointer}',
      '.ybc-tab.on{background:rgba(255,107,53,.16);border-color:#ff6b35;color:#ffb08a;font-weight:700}',
      '.ybc-qrbox{max-height:50vh;overflow:auto;background:#fff;border-radius:12px;',
      '  -webkit-overflow-scrolling:touch}',
      '.ybc-qrbox img{display:block;width:100%;height:auto}',
      '.ybc-copy{margin:12px 2px 0;font-size:12px;color:#e6e8ee}',
      '.ybc-copy small{display:block;margin-top:3px;color:#9aa0ad;font-size:11px}',
      '.ybc-hint{margin:11px 0 0;font-size:10.5px;color:#7d838f;text-align:center}',
      '.ybc-sign{margin:12px 0 0;text-align:center;font-size:11px;color:#ff8a5c}',
      '.ybc-close{float:right;width:26px;height:26px;border:0;border-radius:9px;',
      '  background:rgba(255,255,255,.1);color:#f2f3f7;font-size:15px;line-height:1;cursor:pointer}',
      /* 首次弹窗：谢绝按钮放在二维码上方，一打开就看得见，不用滚动 */
      '.ybc-first{margin:12px 0 4px;padding:12px;border-radius:14px;',
      '  background:rgba(255,107,53,.09);border:1px solid rgba(255,107,53,.28)}',
      '.ybc-first-lead{margin:0 0 10px;font-size:12.5px;color:#e6e8ee;line-height:1.65}',
      '.ybc-first-lead b{color:#ffb08a}',
      '.ybc-decline{display:block;width:100%;height:46px;border:0;border-radius:12px;',
      '  background:#f2f3f7;color:#171a21;font:700 14px/46px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      '  letter-spacing:.2px;cursor:pointer;-webkit-appearance:none;appearance:none}',
      '.ybc-decline:active{background:#d9dce3;transform:scale(.99)}',
      '.ybc-decline-note{margin:8px 0 0;text-align:center;font-size:11px;color:#9aa0ad}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'ybc-style';
    s.textContent = css;
    (document.head || document.body || document.documentElement).appendChild(s);
  }

  function ybcCfg(patch) {
    try {
      var cur = JSON.parse(localStorage.getItem('__yb_config') || '{}') || {};
      for (var k in patch) cur[k] = patch[k];
      localStorage.setItem('__yb_config', JSON.stringify(cur));
      for (var k2 in patch) CONFIG[k2] = patch[k2];
    } catch (e) {}
  }
  function ybcNum(v) { return v > 999 ? '999+' : String(v || 0); }
  function ybcRefresh() {
    if (!ui.stat) return;
    var r = (window.__YBBiliAd && window.__YBBiliAd.report) ? window.__YBBiliAd.report() : null;
    if (!r) return;
    ui.stat.innerHTML = '<span>已压碎 <b>' + ybcNum(r.adCards) + '</b></span>' +
      '<span>已换血 <b>' + ybcNum(r.replaced) + '</b></span>' +
      '<span>弹匣 <b>' + ybcNum(r.sparePool) + '</b></span>';
    if (ui.badge) ui.badge.textContent = ybcNum(r.adCards);
  }
  function ybcSw(label, key) {
    var row = document.createElement('div');
    row.className = 'ybc-row';
    var t = document.createElement('span');
    t.textContent = label;
    var sw = document.createElement('div');
    sw.className = 'ybc-sw' + (CONFIG[key] ? ' on' : '');
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      var val = !sw.classList.contains('on');
      sw.classList.toggle('on', val);
      var p = {}; p[key] = val;
      ybcCfg(p);
      if (key === 'hideCarousel') applyCss();
      if (key === 'useApiFill' && val) ensureSpare();
      ybcToast(val ? '已开启 · 部分设置刷新后完全生效' : '已关闭');
    });
    row.appendChild(t); row.appendChild(sw);
    return row;
  }
  var toastTimer = null;
  function ybcToast(msg) {
    var el = document.getElementById('ybc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ybc-toast';
      el.setAttribute('style', 'position:fixed;z-index:2147483200;left:50%;bottom:84px;transform:translateX(-50%);' +
        'background:rgba(18,20,26,.94);color:#fff;padding:9px 16px;border-radius:20px;font:12px/1.4 -apple-system,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;opacity:0;transition:opacity .2s');
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = '0'; }, 1800);
  }

  function ybcBuildPanel() {
    var panel = document.createElement('div');
    panel.className = 'ybc-panel ybc-collapsed';
    panel.id = 'ybc-panel';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    var head = document.createElement('div');
    head.className = 'ybc-head';
    head.innerHTML =
      '<span class="ybc-flame"><svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M17.6 2.2c.9 5.1-1.4 7.6-3.9 10.1-2.3 2.3-4.7 4.6-4.7 9 0 4.9 3.9 8.7 8.9 8.7s8.9-3.8 8.9-8.7c0-3.4-1.6-6-3.3-8.1.1 2.6-1 4-2.2 4.5.6-5.4-1.8-9.2-3.7-15.5z" fill="#ff7a3d"/>' +
      '<path d="M16 17.4c1.9 2.2 3.3 3.6 3.3 5.7a3.3 3.3 0 0 1-6.6 0c0-2.1 1.4-3.5 3.3-5.7z" fill="#ffd166"/>' +
      '</svg></span>' +
      '<span class="ybc-titles"><b>BilibiliAdCrush</b><i>Xi/Elio X. Blaze</i></span>' +
      '<span class="ybc-badge" id="ybc-badge">0</span>' +
      '<button class="ybc-toggle" id="ybc-toggle" title="收起">−</button>';
    panel.appendChild(head);

    var body = document.createElement('div');
    body.className = 'ybc-body';
    var stat = document.createElement('div');
    stat.className = 'ybc-stat';
    stat.innerHTML = '<span>已压碎 <b>0</b></span><span>已换血 <b>0</b></span><span>弹匣 <b>0</b></span>';
    body.appendChild(stat);
    body.appendChild(ybcSw('总开关', 'enable'));
    body.appendChild(ybcSw('首页轮播净化', 'hideCarousel'));
    body.appendChild(ybcSw('接口补位', 'useApiFill'));

    // 联系我们：菜单里的一个独立子项（打开群链接 / 复制群号兜底）
    var contact = document.createElement('div');
    contact.className = 'ybc-contact';
    contact.innerHTML =
      '<span class="ybc-contact-t"><b>联系我们 · ' + YBC_GROUP.name + '</b>' +
      '<i>QQ群 ' + YBC_GROUP.id + '</i></span>' +
      '<button class="ybc-contact-cp" title="复制群号">⧉</button>' +
      '<button class="ybc-contact-go" title="打开QQ群">↗</button>';
    contact.addEventListener('click', function (e) { e.stopPropagation(); ybcOpenContact(); });
    contact.querySelector('.ybc-contact-cp').addEventListener('click', function (e) {
      e.stopPropagation();
      ybcCopyText(YBC_GROUP.id, '群号已复制 · ' + YBC_GROUP.id);
    });
    contact.querySelector('.ybc-contact-go').addEventListener('click', function (e) {
      e.stopPropagation(); ybcOpenContact();
    });
    body.appendChild(contact);

    var btns = document.createElement('div');
    btns.className = 'ybc-btns';
    var b1 = document.createElement('button');
    b1.className = 'ybc-btn hot';
    b1.textContent = '🔥 投喂点火器';
    b1.addEventListener('click', function (e) { e.stopPropagation(); ybcOpenDonate(); });
    var b2 = document.createElement('button');
    b2.className = 'ybc-btn';
    b2.textContent = '重扫';
    b2.addEventListener('click', function (e) { e.stopPropagation(); scanAll(); ybcRefresh(); ybcToast('已重新扫描'); });
    var b3 = document.createElement('button');
    b3.className = 'ybc-btn';
    b3.textContent = '日志';
    b3.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.__YBBiliAd && window.__YBBiliAd.debug) {
        var on = window.__YBBiliAd.debug(DEBUG ? false : true);
        DEBUG = !!on;
        ybcToast(on ? '调试日志已开，刷新后输出' : '调试日志已关');
      }
    });
    btns.appendChild(b1); btns.appendChild(b2); btns.appendChild(b3);
    body.appendChild(btns);

    var foot = document.createElement('div');
    foot.className = 'ybc-foot';
    foot.textContent = 'v2.1.0 · 纯本地运行 · 不上传任何数据';
    body.appendChild(foot);
    panel.appendChild(body);

    // 减号：只负责丝滑收起；小火苗（收起态的整个 head）负责展开
    head.querySelector('#ybc-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      ybcToggle(false);
    });

    ui.badge = head.querySelector('#ybc-badge');
    ui.stat = stat;
    return panel;
  }

  var YBC_PAD = 8, YBC_W = 268, YBC_S = 58;
  function ybcSize() {
    return ui.collapsed ? [YBC_S, YBC_S] : [YBC_W, ui.expandedH || 250];
  }
  function ybcAnim(on) {
    if (!ui.panel) return;
    if (on) {
      ui.panel.classList.add('ybc-anim');
      clearTimeout(ui.animTimer);
      ui.animTimer = setTimeout(function () {
        if (ui.panel) ui.panel.classList.remove('ybc-anim');
      }, 420);
    } else {
      clearTimeout(ui.animTimer);
      ui.panel.classList.remove('ybc-anim');
    }
  }
  // 丝滑收缩 / 展开：width / height / 圆角 / 内容淡出一起过渡
  function ybcApplySize(open, animate) {
    if (!ui.panel) return;
    if (animate) ybcAnim(true);
    else ybcAnim(false);
    ui.panel.style.width = (open ? YBC_W : YBC_S) + 'px';
    ui.panel.style.height = (open ? (ui.expandedH || 250) : YBC_S) + 'px';
    ui.panel.classList.toggle('ybc-collapsed', !open);
  }
  function ybcPlace(x, y) {
    var s = ybcSize();
    var maxX = Math.max(YBC_PAD, window.innerWidth - s[0] - YBC_PAD);
    var maxY = Math.max(YBC_PAD, window.innerHeight - s[1] - YBC_PAD);
    ui.panel.style.left = Math.min(Math.max(YBC_PAD, x), maxX) + 'px';
    ui.panel.style.top = Math.min(Math.max(YBC_PAD, y), maxY) + 'px';
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }
  // 松手吸附到最近的屏幕边缘（上下左右四边取最近），带滑动动画
  function ybcSnap(x, y, animate) {
    if (!ui.panel) return;
    var s = ybcSize();
    var maxX = Math.max(YBC_PAD, window.innerWidth - s[0] - YBC_PAD);
    var maxY = Math.max(YBC_PAD, window.innerHeight - s[1] - YBC_PAD);
    x = Math.min(Math.max(YBC_PAD, x), maxX);
    y = Math.min(Math.max(YBC_PAD, y), maxY);
    var dl = x - YBC_PAD, dr = maxX - x, dt = y - YBC_PAD, db = maxY - y;
    var m = Math.min(dl, dr, dt, db);
    if (m === dl) x = YBC_PAD;
    else if (m === dr) x = maxX;
    else if (m === dt) y = YBC_PAD;
    else y = maxY;
    if (animate) ybcAnim(true);
    ybcPlace(x, y);
    ybcSavePos();
  }
  function ybcSavePos() {
    try {
      localStorage.setItem('__ybc_pos', ui.panel.style.left + ',' + ui.panel.style.top);
    } catch (e) {}
  }
  // open=true 展开，false 收起；切换时保持原来贴住的那条边不跑偏
  function ybcToggle(open) {
    var next = (open === undefined) ? ui.collapsed : !!open;
    var oldS = ybcSize(), newS = next ? [YBC_W, ui.expandedH || 250] : [YBC_S, YBC_S];
    var x0 = parseFloat(ui.panel.style.left);
    var y0 = parseFloat(ui.panel.style.top);
    if (isNaN(x0)) x0 = window.innerWidth - YBC_W - YBC_PAD;
    if (isNaN(y0)) y0 = window.innerHeight - 100;
    var keepRight = (window.innerWidth - (x0 + oldS[0])) <= x0;
    var keepBottom = (window.innerHeight - (y0 + oldS[1])) <= y0;
    var x1 = keepRight ? x0 + oldS[0] - newS[0] : x0;
    var y1 = keepBottom ? y0 + oldS[1] - newS[1] : y0;

    ui.collapsed = !next;
    ybcApplySize(next, true);
    ybcPlace(x1, y1);
    ybcSavePos();
    var t = ui.panel.querySelector('#ybc-toggle');
    if (t) { t.textContent = ui.collapsed ? '+' : '−'; t.title = ui.collapsed ? '展开' : '收起'; }
    if (next) ybcRefresh();
    try { localStorage.setItem('__ybc_collapsed', ui.collapsed ? '1' : '0'); } catch (e) {}
  }
  function ybcBindDrag(head) {
    var moved = false, sx = 0, sy = 0, ox = 0, oy = 0, active = false;
    function down(e) {
      if (e.target && e.target.tagName === 'BUTTON') return;
      var pt = e.touches ? e.touches[0] : e;
      if (!pt) return;
      ybcAnim(false);                    // 拖动期间关掉过渡，跟手不滞后
      active = true; moved = false;
      sx = pt.clientX; sy = pt.clientY;
      ox = parseFloat(ui.panel.style.left) || 0;
      oy = parseFloat(ui.panel.style.top) || 0;
      if (e.pointerId !== undefined && head.setPointerCapture) {
        try { head.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }
    function move(e) {
      if (!active) return;
      var pt = e.touches ? e.touches[0] : e;
      if (!pt) return;
      var dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      if (moved) { ybcPlace(ox + dx, oy + dy); e.preventDefault(); }
    }
    function up() {
      if (!active) return;
      active = false;
      if (moved) {
        // 小火苗或整个窗口，松手都吸附到最近边缘
        ybcSnap(parseFloat(ui.panel.style.left) || 0, parseFloat(ui.panel.style.top) || 0, true);
      } else if (ui.collapsed) {
        ybcToggle(true);                // 点小火苗才展开；拖动不展开
      }
      // 展开态点标题栏不收起，只有减号能收
    }
    if (typeof PointerEvent !== 'undefined') {
      head.addEventListener('pointerdown', down);
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    } else {
      head.addEventListener('touchstart', down, { passive: true });
      head.addEventListener('touchmove', move, { passive: false });
      head.addEventListener('touchend', up);
      head.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  }

  function ybcOpenDonate(mode) {
    ui.donateMode = (mode === 'first') ? 'first' : 'manual';
    if (ui.overlay) {
      ui.overlay.style.display = 'flex';
      ybcApplyDonateMode(ui.donateMode);
      ybcSetTab(ui.tab);
      return;
    }
    var mask = document.createElement('div');
    mask.className = 'ybc-mask';
    mask.addEventListener('click', function (e) { if (e.target === mask) ybcCloseDonate(); });
    mask.addEventListener('click', function (e) { e.stopPropagation(); });

    var card = document.createElement('div');
    card.className = 'ybc-card';
    card.innerHTML =
      '<button class="ybc-close" id="ybc-close">×</button>' +
      '<h2 id="ybc-title">投喂点火器</h2>' +
      '<div class="ybc-en" id="ybc-en">Fuel the Crush</div>' +
      '<p class="ybc-lead" id="ybc-lead">广告被压碎的每一秒，都在烧我的发际线。<br>若这枚小钮替你守住了首页清净，顺手丢个能量球就行。</p>' +
      '<div class="ybc-first" id="ybc-first" style="display:none">' +
      '  <p class="ybc-first-lead">个人维护不易，若它替你挡掉了首页那几张小火箭，欢迎顺手投喂一份能量。<br>' +
      '  <b>不打赏也可以免费使用全部功能</b>，谢绝之后不再弹窗。</p>' +
      '  <button class="ybc-decline" id="ybc-decline">谢绝 · 免费继续使用全部功能</button>' +
      '  <p class="ybc-decline-note">点它就行，之后更新版本也不会再打扰</p>' +
      '</div>' +
      '<div class="ybc-tabs">' +
      '  <button class="ybc-tab on" data-tab="alipay">● 绿色能量 · 支付宝</button>' +
      '  <button class="ybc-tab" data-tab="wechat">● 赞赏 · 微信</button>' +
      '</div>' +
      '<div class="ybc-qrbox" id="ybc-qrbox"><img id="ybc-qr" alt="打赏二维码"></div>' +
      '<p class="ybc-copy" id="ybc-copy"></p>' +
      '<p class="ybc-hint">长按二维码可保存，或用另一台设备扫。<br>不投喂也全速运行，绝不弹窗催更。</p>' +
      '<p class="ybc-sign">— Xi/Elio X. Blaze</p>';
    mask.appendChild(card);
    document.documentElement.appendChild(mask);
    ui.overlay = mask;

    card.querySelector('#ybc-close').addEventListener('click', function (e) {
      e.stopPropagation(); ybcCloseDonate();
    });
    card.querySelector('#ybc-decline').addEventListener('click', function (e) {
      e.stopPropagation();
      ybcMarkSeen('declined');                 // 谢绝：永久不再弹
      ybcCloseDonate();
      ybcToast('已谢绝 · 全部功能照常免费');
    });
    Array.prototype.forEach.call(card.querySelectorAll('.ybc-tab'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        ybcSetTab(btn.getAttribute('data-tab'));
      });
    });
    ybcApplyDonateMode(ui.donateMode);
    ybcSetTab(ui.tab);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' || e.keyCode === 27) ybcCloseDonate();
    });
  }
  function ybcApplyDonateMode(mode) {
    if (!ui.overlay) return;
    var first = (mode === 'first');
    var t = ui.overlay.querySelector('#ybc-title');
    var en = ui.overlay.querySelector('#ybc-en');
    var lead = ui.overlay.querySelector('#ybc-lead');
    var box = ui.overlay.querySelector('#ybc-first');
    if (t) t.textContent = first ? '初次见面' : '投喂点火器';
    if (en) en.textContent = first ? 'First Run · Fuel the Crush' : 'Fuel the Crush';
    if (lead) lead.style.display = first ? 'none' : '';
    if (box) box.style.display = first ? 'block' : 'none';
  }
  function ybcSetTab(name) {
    ui.tab = (name === 'wechat') ? 'wechat' : 'alipay';
    if (!ui.overlay) return;
    Array.prototype.forEach.call(ui.overlay.querySelectorAll('.ybc-tab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === ui.tab);
    });
    var img = ui.overlay.querySelector('#ybc-qr');
    var box = ui.overlay.querySelector('#ybc-qrbox');
    if (img) { img.src = YBC_IMG[ui.tab]; img.alt = YBC_COPY[ui.tab].label; }
    if (box) box.scrollTop = 0;
    var c = ui.overlay.querySelector('#ybc-copy');
    if (c) c.innerHTML = YBC_COPY[ui.tab].lead + '<small>' + YBC_COPY[ui.tab].sub + '</small>';
  }
  function ybcCloseDonate() {
    if (!ui.overlay) return;
    ui.overlay.style.display = 'none';
    if (ui.donateMode === 'first') {
      // 点谢绝之外的任何关闭方式同样视为「不再提示」，避免反复打扰
      if (!ui.donateSeen) ybcMarkSeen('seen');
      ui.donateMode = 'manual';
      ybcApplyDonateMode('manual');
    }
  }

  function ybcMeasure() {
    var p = ui.panel, was = p.className;
    p.classList.remove('ybc-collapsed', 'ybc-anim');
    p.style.width = YBC_W + 'px';
    p.style.height = 'auto';
    var h = Math.ceil(p.getBoundingClientRect().height);
    if (!h || h < 120) h = 250;
    ui.expandedH = h;
    p.className = was;
  }
  function initUI() {
    if (document.getElementById('ybc-panel')) return;
    if (!document.head && !document.body) { setTimeout(initUI, 40); return; }
    ybcStyle();
    ui.panel = ybcBuildPanel();
    (document.body || document.documentElement).appendChild(ui.panel);
    ybcMeasure();                        // 先量出完整展开高度，供 height 过渡使用
    ybcBindDrag(ui.panel.querySelector('.ybc-head'));

    try { ui.collapsed = localStorage.getItem('__ybc_collapsed') !== '0'; } catch (e) {}
    ybcApplySize(!ui.collapsed, false);
    var t = ui.panel.querySelector('#ybc-toggle');
    if (t) { t.textContent = ui.collapsed ? '+' : '−'; t.title = ui.collapsed ? '展开' : '收起'; }

    var pos = null;
    try { pos = localStorage.getItem('__ybc_pos'); } catch (e) {}
    var x = window.innerWidth - 74, y = window.innerHeight - 92;
    if (pos) {
      var xy = pos.split(',');
      if (!isNaN(parseFloat(xy[0]))) x = parseFloat(xy[0]);
      if (!isNaN(parseFloat(xy[1]))) y = parseFloat(xy[1]);
    }
    ybcSnap(x, y, false);               // 初次出现就贴住最近边缘

    window.addEventListener('resize', function () {
      ybcMeasure();
      ybcApplySize(!ui.collapsed, false);
      ybcSnap(parseFloat(ui.panel.style.left) || 0, parseFloat(ui.panel.style.top) || 0, false);
    });
    ybcRefresh();
    ui.timer = setInterval(ybcRefresh, 2500);

    // 第一次使用：页面安稳后再弹，谢绝（或任意方式关闭）后永久不再弹
    if (ybcShouldAutoDonate()) {
      setTimeout(function () {
        if (!ybcShouldAutoDonate()) return;
        ybcOpenDonate('first');
        log('首次使用弹窗已展示');
      }, 900);
    }
    log('悬浮菜单 / 打赏窗口 / 联系我们 就绪');
  }

  /* ======================= 启动 ======================= */
  function boot() {
    exposeDebug();
    initUI();                       // 总开关关闭时仍保留菜单，便于重新开启
    if (!CONFIG.enable) return;
    hookFetch();
    hookXHR();
    applyCss();
    installSpaWatcher();
    var start = function () { startObserver(); scanAll(); };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    // 低频全扫：覆盖「换一换」、滚动加载、SPA 复用节点等场景
    var rounds = 0;
    var timer = setInterval(function () {
      if (++rounds > 10) { clearInterval(timer); return; }
      scanAll();
    }, 1500);
    log('脚本已启动', CONFIG);
  }
  boot();
})();
