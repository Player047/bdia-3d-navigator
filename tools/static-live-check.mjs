#!/usr/bin/env node
/**
 * 线上站点核对 —— 把已经部署出去的静态站点和本地构建产物逐个字节比一遍。
 *
 * 用法:
 *   node tools/static-live-check.mjs --url https://player047.site/projects/BDIA-3D-Navigator/
 *   node tools/static-live-check.mjs --url <base> --local ../BDIA-3D-Navigator
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么还需要这一套（static-parity / static-http-selftest 之外）
 * ════════════════════════════════════════════════════════════════════
 *
 * 前两套验的是【本地】：本地构建对不对、本地静态服务器上跑不跑得起来。
 * 它们对「传上去之后变成什么样」一无所知，而线上有它自己的一整套坑：
 *
 *   · 上传工具猜错了 Content-Type（尤其 .mjs）→ ES module 被浏览器拒绝执行
 *   · 漏传了某个文件 → 本地全绿，线上 404，而且只在你点到那个功能时才炸
 *   · 传上去的是【旧的一次构建】→ 页面能打开，但数据和代码都不是你以为的那份
 *   · 缓存头没设 → 改了数据线上还是旧的
 *
 * 所以这一套只做一件事：把线上每个文件的字节拿回来，和本地构建产物比对。
 * 全都一样 + 模块 MIME 正确 + 数据能解析 = 线上就是那一份，而且跑得起来。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const URL_ARG = argOf('--url', '');
const LOCAL = path.resolve(ROOT, argOf('--local', path.join('..', 'BDIA-3D-Navigator')));
const CONCURRENCY = Number(argOf('--concurrency', 6));

if (!URL_ARG) {
  console.error('\n  用法: node tools/static-live-check.mjs --url <站点基地址>\n'
    + '  例如: node tools/static-live-check.mjs --url https://player047.site/projects/BDIA-3D-Navigator/\n');
  process.exit(2);
}
/** 基地址必须以 / 结尾，后面全部相对它拼。 */
const BASE = URL_ARG.endsWith('/') ? URL_ARG : URL_ARG + '/';

let pass = 0; let fail = 0;
const bad = [];
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; bad.push(m + (extra ? `  → ${extra}` : '')); console.log(`  FAIL ${m}${extra ? `  → ${extra}` : ''}`); }
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

console.log('\n线上站点核对\n' + '─'.repeat(66));
console.log(`  线上   ${BASE}`);
console.log(`  本地   ${path.relative(ROOT, LOCAL).replace(/\\/g, '/')}/\n`);

if (!fs.existsSync(LOCAL)) {
  console.error(`  ✗ 本地构建目录不存在：${LOCAL}\n    先跑 npm run build:static\n`);
  process.exit(2);
}

/* ───────────────── 取回线上每个文件，和本地逐个字节比 ───────────────── */

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

const localFiles = walk(LOCAL).sort();
console.log(`① 全量比对 —— 本地 ${localFiles.length} 个文件，逐个取回线上比对\n`);

const results = new Map();
{
  let i = 0;
  async function worker() {
    while (i < localFiles.length) {
      const rel = localFiles[i++];
      const url = BASE + rel.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) { results.set(rel, { status: res.status }); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        results.set(rel, {
          status: res.status,
          buf,
          ct: res.headers.get('content-type') ?? '',
          cc: res.headers.get('cache-control') ?? '',
        });
      } catch (e) {
        results.set(rel, { status: 0, err: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, localFiles.length) }, worker));

  const missing = [];
  const different = [];
  for (const rel of localFiles) {
    const r = results.get(rel);
    if (!r || r.status !== 200) { missing.push(`${rel}（HTTP ${r?.status ?? '?'}${r?.err ? ' ' + r.err : ''}）`); continue; }
    const want = sha256(fs.readFileSync(path.join(LOCAL, rel)));
    if (sha256(r.buf) !== want) {
      different.push(`${rel}（本地 ${fs.statSync(path.join(LOCAL, rel)).size} B / 线上 ${r.buf.length} B）`);
    }
  }
  ok(missing.length === 0, `${localFiles.length} 个文件线上都取得到`, missing.slice(0, 8).join('、'));
  ok(different.length === 0, '★ 每个文件的字节都和本地构建产物完全相同', different.slice(0, 8).join('、'));
}

/* ───────────────── 模块 MIME：ES module 的硬门槛 ───────────────── */

console.log('\n② 模块 MIME —— 错了浏览器直接拒绝执行\n');
{
  const mods = localFiles.filter((f) => /\.(mjs|js)$/.test(f));
  const wrong = [];
  for (const rel of mods) {
    const r = results.get(rel);
    if (!r || r.status !== 200) { wrong.push(`${rel} → HTTP ${r?.status ?? '?'}`); continue; }
    if (!/javascript/.test(r.ct)) wrong.push(`${rel} → ${r.ct}`);
  }
  ok(wrong.length === 0, `${mods.length} 个 .js/.mjs 的 Content-Type 都是 JavaScript`, wrong.join('、'));
}

/* ───────────────── 缓存头：数据必须每次回源 ───────────────── */

console.log('\n③ 缓存头\n');
{
  const dataRel = 'client/api/data.json';
  const r = results.get(dataRel);
  ok(!!r && r.status === 200, `${dataRel} 取得到`);
  if (r) {
    ok(/no-cache|no-store|max-age=0/.test(r.cc), `★ ${dataRel} 是 no-cache 一类（否则改了数据线上还是旧的）`, `实际 "${r.cc}"`);
  }
}

/* ───────────────── 数据本身能不能用 ───────────────── */

console.log('\n④ 数据\n');
{
  const r = results.get('client/api/data.json');
  if (!r || r.status !== 200) {
    ok(false, '取到 client/api/data.json');
  } else {
    let d = null;
    try { d = JSON.parse(r.buf.toString('utf8')); } catch (e) { ok(false, 'data.json 是合法 JSON', e.message); }
    if (d) {
      const mf = JSON.parse(fs.readFileSync(path.join(LOCAL, 'build-manifest.json'), 'utf8'));
      ok(true, `载荷：${Object.keys(d.levels ?? {}).length} 层 · 设施 ${d.facilities?.features?.length ?? 0}`
        + ` · 通行线 ${d.paths?.features?.length ?? 0}`);
      ok((d.facilities?.features?.length ?? 0) === mf.counts.facilities,
        `设施数与 build-manifest.json 一致（${mf.counts.facilities}）`);
      ok((d.paths?.features?.length ?? 0) === mf.counts.paths,
        `通行线与 build-manifest.json 一致（${mf.counts.paths}）`);
    }
  }
}

/* ───────────────── shim 能不能自己找到数据 ───────────────── */

console.log('\n⑤ shim 的数据落点\n');
{
  /*
   * static-api.js 是【相对它自己的 URL】算数据地址的，不依赖 location.pathname。
   * 这里按同样的规则算一遍，确认算出来的地址真的取得到 ——
   * 部署到子路径时最容易在这里出问题。
   */
  const shimUrl = new URL('client/static-api.js', BASE);
  const dataUrl = new URL('api/data.json', shimUrl).href;
  const expect = new URL('client/api/data.json', BASE).href;
  ok(dataUrl === expect, `shim 会去取 ${new URL(dataUrl).pathname}`, `期望 ${new URL(expect).pathname}`);
  try {
    const res = await fetch(dataUrl);
    ok(res.ok, '这个地址线上取得到', `HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ok(sha256(buf) === sha256(fs.readFileSync(path.join(LOCAL, 'client/api/data.json'))),
      '它拿到的确实就是构建出来的那份数据');
  } catch (e) {
    ok(false, 'shim 的数据地址取得到', e.message);
  }
}

/* ───────────────── 结果 ───────────────── */

console.log('\n' + '─'.repeat(66));
if (fail) {
  console.log(`  ✗ 线上核对未通过　${pass} 通过 / ${fail} 失败`);
  for (const b of bad) console.log(`    · ${b}`);
  console.log('');
  process.exit(1);
}
console.log(`  ✓ 通过　${pass}/${pass}　线上就是本地构建的那一份，可以正常使用\n`);
