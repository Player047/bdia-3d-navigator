#!/usr/bin/env node
/**
 * 在 node 里把【真正的客户端】启动一次，打印一份行为指纹（JSON）。
 *
 * 被 tools/static-parity.mjs 调用两次：
 *   --mode live    连 tools/editor-server.mjs 的 /api/data（= 开发时的那条路）
 *   --mode static  走构建出来的静态站点 + 真正的 client/static-api.js shim
 *
 * 两次的指纹必须逐字段相同。这是「静态客户端和开发客户端是同一个东西」
 * 这句话唯一有说服力的证据 —— 比对的是【算路结果、搜索结果、绘制调用数】，
 * 不是「文件长得像」。
 *
 * ★ 为什么单独起进程：
 *   两边的 client/app.js 是两个不同的模块实例，而 app.js 会把状态挂在
 *   globalThis（__navTestHooks）和 document 上。同一个进程里跑两次必然互相污染。
 *
 * ★ static 模式刻意【真的去 eval 构建产物里的 static-api.js】，
 *   而不是在测试里模仿它的行为。模仿等于测自己写的替身，
 *   真 shim 里「路径结尾匹配」「只拦 GET」这些细节就永远测不到。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom } from './lib/domshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MODE = argOf('--mode', 'live');
const BASE = argOf('--base', 'http://127.0.0.1:5173');
const SITE = path.resolve(argOf('--site', path.join(ROOT, '..', 'BDIA-3D-Navigator')));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const round = (n, d = 6) => (typeof n === 'number' ? Number(n.toFixed(d)) : n);

/* ───────────────────────── fetch 桩 ───────────────────────── */

/*
 * ★ 必须先把原生的 fetch 抓在手里。
 *   installDom 会把 globalThis.fetch 换成我们的桩，之后桩里再写 `fetch(...)`
 *   拿到的就是桩自己 —— 无限递归，表现成「客户端一直启动不完」，
 *   而且不报任何错（栈溢出被 installDom 的 unhandledRejection 处理器吃掉了）。
 */
const realFetch = globalThis.fetch.bind(globalThis);

/** live：真的走 HTTP，和浏览器访问 http://host/client/ 一样。 */
function httpFetch(url, init) {
  return realFetch(new URL(url, BASE).href, init);
}

/**
 * static：像静态文件服务器那样按路径读磁盘。
 * ★ 故意不认「没有扩展名的文件」之外的花样 —— 就是一个静态服务器。
 */
function makeFileFetch(siteDir) {
  const MIME = {
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  return async function fileFetch(input, init) {
    const raw = typeof input === 'string' ? input : input?.url;
    let rel;
    try { rel = decodeURIComponent(new URL(raw, 'http://localhost/').pathname).replace(/^\/+/, ''); } catch { return new Response('bad url', { status: 400 }); }
    const full = path.resolve(siteDir, rel);
    if (full !== siteDir && !full.startsWith(siteDir + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const buf = fs.readFileSync(full);
      return new Response(buf, { status: 200, headers: { 'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

/* ──────────────────────── 启动 ──────────────────────── */

const clientEntry = MODE === 'static'
  ? path.join(SITE, 'client', 'app.js')
  : path.join(ROOT, 'client', 'app.js');

if (!fs.existsSync(clientEntry)) fail(`找不到客户端入口：${clientEntry}`);

const native = MODE === 'static' ? makeFileFetch(SITE) : httpFetch;
const dom = installDom({ dpr: 1, fetchImpl: (u, i) => native(u, i) });

/* 页面地址：让 app.js 里 `globalThis.location?.search` 有个真实的值 */
const pageUrl = MODE === 'static' ? 'http://localhost/client/' : new URL('/client/', BASE).href;
try {
  Object.defineProperty(globalThis, 'location', {
    value: new URL(pageUrl), configurable: true, writable: true,
  });
} catch { /* 没有也无所谓 */ }

if (MODE === 'static') {
  /*
   * ★ 真的加载构建产物里的 shim。
   *   document.currentScript 是普通 script 拿自身 URL 的唯一途径，
   *   所以这里要把它摆成浏览器里的样子。
   */
  const shimPath = path.join(SITE, 'client', 'static-api.js');
  if (!fs.existsSync(shimPath)) fail(`静态站点里没有 client/static-api.js：${shimPath}`);
  const shimSrc = fs.readFileSync(shimPath, 'utf8');
  dom.document.currentScript = { src: new URL('/client/static-api.js', 'http://localhost/').href };
  // eslint-disable-next-line no-new-func
  new Function(shimSrc)();
  if (typeof globalThis.fetch !== 'function' || !globalThis.fetch.__bdiaStaticApi) {
    fail('static-api.js 执行了，但没有接管 fetch');
  }
}

/* ──────────────────────── 启动客户端 ──────────────────────── */

process.on('unhandledRejection', (e) => {
  console.error('!! unhandledRejection:', e?.stack ?? e);
});
process.on('uncaughtException', (e) => {
  console.error('!! uncaughtException:', e?.stack ?? e);
});

await import(pathToFileURL(clientEntry).href);

const app = globalThis.__navTestHooks;
if (!app) fail('客户端没有暴露 __navTestHooks');
const { S } = app;

/* 等模块自己那次 boot() 跑完 —— 不再手动 boot 一次，避免两次并发启动互相改状态 */
const t0 = Date.now();
while (!dom.window.__navBooted && Date.now() - t0 < 20000) {
  await new Promise((r) => setTimeout(r, 20));
}
if (!dom.window.__navBooted) fail('客户端 20 秒内没有启动完成（__navBooted 一直是 false）');

/* ──────────────────────── 指纹 ──────────────────────── */

const fp = {};

fp.counts = {
  facilities: S.facilities.length,
  paths: S.paths.length,
  obstacles: S.obstacles.length,
  connectors: S.connectors.length,
  regions: S.regions.length,
  levels: Object.keys(S.manifest?.levels ?? {}).length,
};
fp.manifestLevels = Object.keys(S.manifest?.levels ?? {});
fp.defaultLevel = S.level;
fp.facilityKinds = {
  area: S.facilities.filter((f) => f.polygons?.length).length,
  point: S.facilities.filter((f) => f.point).length,
};
/* 设施 id 全集 —— 数据层有任何增删改，这里立刻暴露 */
fp.facilityIdHash = sha(S.facilities.map((f) => f.id).join('|'));
fp.pathIdHash = sha(S.paths.map((p) => p.id).join('|'));
fp.regionIdHash = sha(S.regions.map((r) => r.id).join('|'));

/* 搜索：确定性查询，记录命中 id 与得分 */
const QUERIES = ['星巴克', '免税', '电梯', '安检', '咖啡', 'a', '门'];
fp.search = {};
for (const q of QUERIES) {
  fp.search[q] = app.searchFacilities(q).slice(0, 8).map((r) => [r.id, r.score]);
}

/* 算路：在同层点状设施里取一批确定的起终点对，把结果整体记下来 */
{
  const pts = S.facilities.filter((f) => f.point && f.level === S.level).map((f) => f.id).sort();
  const pairs = [];
  /*
   * ★ 取样要兼顾「算得通」和「算不通」两种。
   *   只取相距最远的那几对，在当前这份数据上全是「两段路没接上」——
   *   两边都失败当然也算一致，但这种一致几乎没有证明力：
   *   真正的 A*、折点序列、步行时间全都没被走到。
   *   相邻成对更可能落在同一个连通分量里，于是能把完整路径拉出来比对。
   */
  for (let i = 0; i + 1 < pts.length && pairs.length < 18; i += 2) pairs.push([pts[i], pts[i + 1]]);
  if (pts.length >= 2) {
    pairs.push([pts[0], pts[pts.length - 1]]);
    pairs.push([pts[1], pts[pts.length - 2]]);
  }
  fp.routes = pairs.map(([from, to]) => {
    S.from = from; S.to = to;
    app.tryPlan();
    const r = S.route;
    const err = r ? null : (S.planError ?? null);
    return {
      from, to,
      ok: !!r,
      steps: r?.steps?.length ?? 0,
      meters: round(r?.totalMeters),
      minutes: round(r?.totalMinutes),
      /* 整条步骤序列的哈希：折点坐标/楼层/指令有任何差异都会变 */
      stepsHash: r ? sha(JSON.stringify(r.steps)) : null,
      /* 失败原因本身也是行为的一部分，但要哈希，别把指纹撑爆 */
      errorHash: err ? sha(String(err)) : null,
      errorHead: err ? String(err).slice(0, 40) : null,
    };
  });
  S.from = null; S.to = null; S.route = null; S.phase = 'idle';
}

/* 场景构建 */
{
  const by = {};
  for (const p of S.scene?.polys ?? []) by[p.kind] = (by[p.kind] ?? 0) + 1;
  fp.scene = { polys: by, voidRings: S.scene?.voidRings?.length ?? 0, levels: S.sceneLevels ?? null };
}

/* 绘制调用数：同样的数据 + 同样的视角，必须画出同样多的东西 */
{
  S.view = '2d-follow';
  app.renderAll();
  app.resize();
  dom.resetCtxCalls();
  app.draw();
  fp.draw2d = dom.canvasCtxCalls().length;

  S.view = '3d-follow';
  S.cam3d.free = false;
  dom.resetCtxCalls();
  app.draw();
  fp.draw3d = dom.canvasCtxCalls().length;
}

fp.errors = dom.errors.length;

/* ──────────────────────── 输出 ──────────────────────── */

console.log('__FINGERPRINT__' + JSON.stringify(fp));
process.exit(0);

function fail(msg) {
  console.log('__FINGERPRINT__' + JSON.stringify({ __fail: msg }));
  process.exit(0);
}
