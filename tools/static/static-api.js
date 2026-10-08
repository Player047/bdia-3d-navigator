/**
 * static-api.js —— 静态部署（S3 + CloudFront）时的数据来源。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ════════════════════════════════════════════════════════════════════
 *
 * client/app.js 里写死了 `fetch('/api/data')`。开发时由
 * tools/editor-server.mjs 现场读 data/source/ 回应；静态站点上没有服务器。
 *
 * 三种做法：
 *   ✗ 改 app.js 让它 fetch 'api/data.json'
 *     → 客户端代码就和开发时测的那份不一样了。以后每改一次客户端，
 *       「开发和线上是不是同一个东西」都要重新论证一遍。
 *   ✗ 上传一个没有扩展名、键名恰好叫 `api/data` 的对象
 *     → 只有在域名【根路径】部署时才成立。放到 /BDIA-3D-Navigator/ 这种
 *       子路径下，`/api/data` 会被解析到域名根，直接 404。
 *   ✓ 在原样不动 app.js 的前提下，把 fetch 换掉（本文件）
 *
 * 所以：app.js / lib/** / tools/lib/** 全部逐字节照搬，一个字符都不改。
 * 这个文件只做一件事 —— 让 `GET /api/data` 落到站点自己带的 api/data.json 上。
 *
 * ════════════════════════════════════════════════════════════════════
 * 它必须满足的三条
 * ════════════════════════════════════════════════════════════════════
 *
 * 1. 【与部署路径无关】
 *    站点根由【本脚本自己的 src】反推，不用 location.pathname 猜。
 *    所以域名根、/BDIA-3D-Navigator/、CloudFront 的任意 origin 都能跑。
 *
 * 2. 【只拦这一次请求】
 *    只认 GET + 路径以 /api/data 结尾。其余请求原样转给浏览器原生 fetch，
 *    包括 POST、跨域请求、以及以后可能加的任何接口。
 *    用途和开发时完全一致，不会把别的功能吞掉。
 *
 * 3. 【加载顺序】
 *    是普通 <script>（不是 module），在 <script type="module" src="./app.js">
 *    之前执行。module 是 defer 的，所以这里一定先跑完。
 *
 * 由 tools/build-static.mjs 逐字节复制进站点，不经过任何改写。
 */
(function () {
  'use strict';

  /* 被加载两次就直接退出，避免把已经换好的 fetch 又包一层 */
  if (typeof globalThis !== 'undefined' && globalThis.fetch && globalThis.fetch.__bdiaStaticApi) return;

  var DATA_FILE = 'api/data.json';

  /* ───────────────────────── 1. 站点根 ───────────────────────── */

  /**
   * 从【本脚本自身的 URL】反推站点根目录。
   *
   * ★ 不能用 location：页面地址是 /BDIA-3D-Navigator/ 还是 / 取决于怎么部署，
   *   而脚本地址总是「站点根 + static-api.js」，反推出来的根永远是对的。
   *   document.currentScript 在普通 script 里一定有值；万一没有（内联、被
   *   打包工具搬走），退回 document.baseURI / location。
   */
  function scriptBase() {
    try {
      var s = document.currentScript;
      if (s && s.src) return new URL('.', s.src);
    } catch (e) { /* 继续往下退 */ }
    try {
      if (document.baseURI) return new URL('.', document.baseURI);
    } catch (e) { /* 继续往下退 */ }
    try { return new URL('./', location.href); } catch (e) { /* 认了 */ }
    return null;
  }

  var BASE = scriptBase() || new URL('http://localhost/');
  var DATA_URL = new URL(DATA_FILE, BASE).href;

  /** 浏览器里 globalThis === window；老环境退回 window。 */
  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof window !== 'undefined') ? window : null;

  var nativeFetch = (G && typeof G.fetch === 'function') ? G.fetch.bind(G) : null;

  /* ─────────────────── 2. 这是不是要数据那次请求 ─────────────────── */

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return null;
  }

  /**
   * ★ 用【结尾匹配】而不是全等。
   *   app.js 请求的是绝对路径 '/api/data'。站点部署在子目录时，
   *   期望的路径是 '/BDIA-3D-Navigator/api/data'，而请求路径仍然是 '/api/data'
   *   —— 全等比对会漏掉，表现是「根路径下能跑，一放进子目录就白屏」。
   */
  function isDataRequest(input) {
    var raw = urlOf(input);
    if (raw == null) return false;
    var p;
    try { p = new URL(raw, BASE).pathname; } catch (e) { return false; }
    var clean = p.replace(/\/+$/, '');
    return clean === '/api/data' || clean.slice(-9) === '/api/data';
  }

  /* ──────────────────────── 3. 读一次，缓存住 ──────────────────────── */

  var pending = null;

  function loadData() {
    if (!nativeFetch) return Promise.reject(new Error('这个环境没有 fetch'));
    if (!pending) {
      pending = nativeFetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) {
          /*
           * ★ 错误消息要能直接指向原因。
           *   最常见的一种部署事故就是「同步时漏掉了 api/ 目录」——
           *   页面其它资源全是 200，只有数据 404，看起来像前端坏了。
           */
          throw new Error('静态数据加载失败：' + DATA_URL + ' 返回 HTTP ' + res.status
            + (res.status === 404 ? '（部署时漏传 api/ 目录？）' : ''));
        }
        return res.json();
      });
      /* 失败不缓存 —— 否则一次网络抖动会让页面永远起不来，刷新也没用 */
      pending.catch(function () { pending = null; });
    }
    return pending;
  }

  /* ────────────────────── 4. 造一个 Response ────────────────────── */

  function jsonResponse(body) {
    var text = JSON.stringify(body);
    if (typeof Response === 'function') {
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    /* 极端降级：给出 fetch 返回值的等价形状（app.js 只用到 .json()） */
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: function () { return 'application/json; charset=utf-8'; } },
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(text); },
    };
  }

  /* ──────────────────────── 5. 换掉 fetch ──────────────────────── */

  function staticFetch(input, init) {
    if (isDataRequest(input)) {
      var m = (init && init.method) || (input && input.method) || 'GET';
      /* 只拦 GET。POST 之类原样放行，免得把将来的写接口吞掉 */
      if (String(m).toUpperCase() === 'GET') return loadData().then(jsonResponse);
    }
    if (!nativeFetch) return Promise.reject(new Error('这个环境没有 fetch'));
    return nativeFetch(input, init);
  }

  staticFetch.__bdiaStaticApi = true;
  staticFetch.dataUrl = DATA_URL;

  if (!G) return;
  G.fetch = staticFetch;
  /* G 已经是 window 时这一句是多余的；不是时它保证 window.fetch 也换了 */
  try { if (typeof window !== 'undefined' && window !== G) window.fetch = staticFetch; } catch (e) { /* ignore */ }

  /* 排查用：控制台里能一眼看出当前是静态版、数据在哪 */
  try {
    if (typeof window !== 'undefined') {
      window.__bdiaStatic = { base: BASE.href, dataUrl: DATA_URL, mode: 'static' };
    }
  } catch (e) { /* ignore */ }
})();
