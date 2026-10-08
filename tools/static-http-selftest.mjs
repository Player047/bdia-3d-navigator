#!/usr/bin/env node
/**
 * 静态站点 HTTP 自测 —— 用【真实的静态服务器】把站点按浏览器的方式取一遍。
 *
 * 用法:
 *   node tools/static-http-selftest.mjs
 *   node tools/static-http-selftest.mjs --site <dir> --port 8127
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么光有 static-parity.mjs 还不够
 * ════════════════════════════════════════════════════════════════════
 *
 * static-parity.mjs 是【从磁盘直接 import】客户端来比行为的 ——
 * 它证明了两份代码在语义上等价，但整条链路上还有一段它碰不到：
 *
 *   · 浏览器真正会请求哪些 URL，那些 URL 在静态服务器上取不取得到
 *   · 取回来的 Content-Type 对不对 —— ES module 有【严格 MIME 检查】，
 *     类型不对浏览器直接拒绝执行，只留一句 "Failed to load module script"
 *   · Cache-Control 对不对 —— client/api/data.json 被缓存住的话，
 *     编辑器改了数据而线上地图还是旧的，看起来像前端 bug
 *   · /client/ 与 /client/index.html 的区别 ——
 *     S3 的 REST 端点（CloudFront + OAC 用的就是它）不做目录索引
 *
 * 这几条全是「构建成功、测试通过、线上白屏」的经典来源。
 * 所以这一套必须走真的 HTTP。
 *
 * 模块清单不写死：从 client/index.html 出发把依赖图走一遍再逐个取，
 * 这样加了新模块忘了搬、或者改了 import 路径，都会被自动覆盖到。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const SITE = path.resolve(ROOT, argOf('--site', path.join('..', 'BDIA-3D-Navigator')));
const PORT = Number(argOf('--port', 8127));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0; let fail = 0;
const bad = [];
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; bad.push(m + (extra ? `  → ${extra}` : '')); console.log(`  FAIL ${m}${extra ? `  → ${extra}` : ''}`); }
};

console.log('\n静态站点 HTTP 自测\n' + '─'.repeat(66));
console.log(`  站点   ${path.relative(ROOT, SITE).replace(/\\/g, '/')}/`);
console.log(`  地址   ${BASE}\n`);

if (!fs.existsSync(path.join(SITE, 'client', 'index.html'))) {
  console.error('  ✗ 站点不存在或没构建完整。先跑 npm run build:static\n');
  process.exit(1);
}

/* ────────────────────────── 起服务器 ────────────────────────── */

const srv = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve-static.mjs'),
  '--site', SITE, '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
const cleanup = () => { try { srv.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function ready(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/client/index.html`); if (r.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

if (!await ready()) {
  console.error(`  ✗ 静态服务器没能启动（端口 ${PORT} 被占用？）\n`);
  cleanup();
  process.exit(1);
}

/* ────────────────────────── 1. 入口 ────────────────────────── */

console.log('① 入口');

let entryTarget = null;
{
  const r = await fetch(`${BASE}/`);
  const text = await r.text();
  ok(r.status === 200, '/ 返回 200', `实际 ${r.status}`);
  ok(/http-equiv=["']refresh["']/i.test(text), '/ 是跳转页而不是空白或目录列表');
  const m = text.match(/url=(\.\/client\/index\.html)/);
  ok(!!m, '/ 跳到 ./client/index.html', m ? '' : '没找到跳转目标');
  entryTarget = m ? m[1] : null;
  if (entryTarget) {
    const rr = await fetch(new URL(entryTarget, `${BASE}/`).href);
    ok(rr.ok, `跳转目标 ${entryTarget} 取得到`, `实际 ${rr.status}`);
  }
}

{
  const r = await fetch(`${BASE}/client/index.html`);
  const html = await r.text();
  const ct = r.headers.get('content-type') ?? '';
  ok(r.status === 200, '/client/index.html 返回 200', `实际 ${r.status}`);
  ok(/text\/html/.test(ct), 'Content-Type 是 text/html', ct);
  ok((r.headers.get('cache-control') ?? '') === 'no-cache', 'Cache-Control 是 no-cache（入口不能缓存）', r.headers.get('cache-control'));

  const iShim = html.indexOf('static-api.js');
  const iApp = html.indexOf('src="./app.js"');
  ok(iShim > -1, 'index.html 引用了 static-api.js');
  ok(iApp > -1, 'index.html 引用了 ./app.js');
  ok(iShim > -1 && iApp > -1 && iShim < iApp, '★ static-api.js 在 app.js 之前（否则 fetch 没被接管）');
}

/*
 * ★ /client/ 必须是 404。
 *   这不是缺陷，是 S3 的 REST 端点（CloudFront + OAC 用的就是它）的真实行为：
 *   它不做目录索引。把这个断言写下来，是为了让「入口要写全文件名」这件事
 *   在被误改成 /client/ 时立刻失败，而不是等上线后发现白屏。
 */
{
  const r = await fetch(`${BASE}/client/`);
  ok(r.status === 404, '/client/ 是 404 —— 入口必须是 /client/index.html（S3 REST + OAC 不做目录索引）', `实际 ${r.status}`);
}

/* ─────────────────── 2. 依赖图：逐个取，查 MIME ─────────────────── */

console.log('\n② 依赖图 —— 浏览器会请求的每个模块');

{
  const seen = new Map();          // urlPath -> {status, type}
  const badMime = [];
  const missing = [];

  async function grab(urlPath) {
    if (seen.has(urlPath)) return seen.get(urlPath);
    const res = await fetch(BASE + urlPath);
    const ct = res.headers.get('content-type') ?? '';
    const rec = { status: res.status, type: ct, text: '' };
    /*
     * ★ html 也要读正文 —— 依赖图的种子就在 index.html 的 <script src> 里。
     *   只读 .js/.mjs 的话，从起点就收集不到任何引用，
     *   整个第 ② 节会「1 个资源全部取得到」地空跑通过。
     */
    if (res.ok && /\.(mjs|js|html)$/.test(urlPath)) rec.text = await res.text();
    seen.set(urlPath, rec);
    return rec;
  }

  const queue = [];
  const indexHtml = await grab('/client/index.html');
  for (const m of indexHtml.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (!/^https?:|^\/\//.test(m[1])) queue.push([m[1], '/client/index.html']);
  }
  while (queue.length) {
    const [ref, from] = queue.shift();
    const urlPath = new URL(ref, `http://x${from}`).pathname;
    if (seen.has(urlPath)) continue;
    const r = await grab(urlPath);
    if (r.status !== 200) { missing.push(`${urlPath}（来自 ${from}）→ HTTP ${r.status}`); continue; }
    /* ★ ES module 的严格 MIME 检查 */
    if (!/javascript/.test(r.type)) badMime.push(`${urlPath} → ${r.type}`);
    for (const m of (r.text ?? '').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push([m[1], urlPath]);
    }
  }

  ok(missing.length === 0, `依赖图里 ${seen.size} 个资源全部取得到`, missing.join('、'));
  ok(badMime.length === 0, '★ 每个 .js/.mjs 的 Content-Type 都是 JavaScript', badMime.join('、'));
  ok(seen.size >= 8, `覆盖到的资源数量合理（${seen.size} 个）`);

  /* 客户端真正 import 的那几个必须在里面 */
  for (const must of ['/client/app.js', '/client/static-api.js', '/tools/lib/graph.mjs',
    '/tools/lib/route.mjs', '/tools/lib/search.mjs', '/client/lib/view3d.mjs']) {
    ok(seen.has(must), `依赖图覆盖到 ${must}`);
  }
}

/* ────────────────────────── 3. 数据 ────────────────────────── */

console.log('\n③ 数据');

{
  /*
   * ★ /api/data 在纯静态站点上必然是 404 —— 这正是需要 shim 的原因。
   *   把它断言下来：哪天有人「顺手」在构建里造了一个 api/data 文件，
   *   这条会失败，提醒他那只在域名根部署时成立。
   */
  const r0 = await fetch(`${BASE}/api/data`);
  ok(r0.status === 404, '/api/data 在静态服务器上是 404（所以必须靠 shim 接管）', `实际 ${r0.status}`);

  const r = await fetch(`${BASE}/client/api/data.json`);
  const ct = r.headers.get('content-type') ?? '';
  ok(r.status === 200, '/client/api/data.json 返回 200', `实际 ${r.status}`);
  ok(/json/.test(ct), 'Content-Type 是 JSON', ct);
  ok((r.headers.get('cache-control') ?? '') === 'no-cache', '★ Cache-Control 是 no-cache（否则改了数据线上还是旧的）', r.headers.get('cache-control'));

  const d = await r.json();
  const fac = d.facilities?.features?.length ?? 0;
  const paths = d.paths?.features?.length ?? 0;
  const levels = Object.keys(d.levels ?? {}).length;
  ok(true, `载荷：${levels} 层 · 设施 ${fac} · 通行线 ${paths} · 障碍物 ${d.obstacles?.features?.length ?? 0}`);
  ok(fac > 0, '设施非空');
  ok(paths > 0, '通行线非空（寻路图就是它）');
  ok(levels > 0, '楼层非空');
  ok(!!d.manifest, 'manifest 在');
  ok(!('pois' in d) && !('zones' in d) && !('walkable' in d), '没有已废弃的 pois / zones / walkable 字段');

  /* 与构建清单对得上 —— 确认服务器上这份就是构建出来的那份 */
  const mf = JSON.parse(fs.readFileSync(path.join(SITE, 'build-manifest.json'), 'utf8'));
  ok(mf.counts.facilities === fac && mf.counts.paths === paths,
    '数据与 build-manifest.json 记的数量一致',
    `manifest 设施 ${mf.counts.facilities} / 通行线 ${mf.counts.paths}`);
}

/* ────────────────────────── 4. 资源与缓存 ────────────────────────── */

console.log('\n④ 资源与缓存策略');

{
  const r = await fetch(`${BASE}/client/assets/preznt-production.svg`);
  ok(r.ok && /svg/.test(r.headers.get('content-type') ?? ''), 'SVG 取得到且 MIME 正确', r.headers.get('content-type') ?? '');
  ok(/immutable/.test(r.headers.get('cache-control') ?? ''), '静态资源是长缓存 immutable', r.headers.get('cache-control'));

  const rj = await fetch(`${BASE}/client/app.js`);
  ok(/immutable/.test(rj.headers.get('cache-control') ?? ''), 'app.js 是长缓存 immutable', rj.headers.get('cache-control'));
}

/* ────────────────── 5. 不该发出去的东西 ────────────────── */

console.log('\n⑤ 不该发出去的东西');

{
  for (const [p, what] of [
    ['/editor/app.js', '编辑器'],
    ['/data/source/facilities.geojson', '源数据（原始 GeoJSON）'],
    ['/data/source/manifest.json', '源数据 manifest'],
    ['/plans/1-1.jpg', '有版权的平面图'],
  ]) {
    const r = await fetch(`${BASE}${p}`);
    ok(r.status === 404, `${what}没有被打包进静态站点（${p}）`, `实际 ${r.status}`);
  }
}

/* ────────────────────────── 结果 ────────────────────────── */

cleanup();
console.log('\n' + '─'.repeat(66));
if (fail) {
  console.log(`  ✗ 静态站点 HTTP 自测未通过　${pass} 通过 / ${fail} 失败`);
  for (const b of bad) console.log(`    · ${b}`);
  console.log('');
  process.exit(1);
}
console.log(`  ✓ 通过　${pass}/${pass}　静态站点可直接部署\n`);
process.exit(0);
