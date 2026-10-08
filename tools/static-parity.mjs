#!/usr/bin/env node
/**
 * 静态站点 ↔ 开发环境 一致性验证。
 *
 * 用法:
 *   node tools/static-parity.mjs
 *   node tools/static-parity.mjs --site ../BDIA-3D-Navigator
 *
 * ════════════════════════════════════════════════════════════════════
 * 「静态页面客户端和开发时的客户端完全一样」这句话，怎么才算证明了
 * ════════════════════════════════════════════════════════════════════
 *
 * 分五层，从弱到强：
 *
 *   ① 文件层 —— 站点里的 app.js / lib / tools/lib 和仓库里的源文件逐字节相同
 *      （sha256 比对，哈希记在构建时的 build-manifest.json 里）
 *
 *   ② 依赖图层 —— 站点里每个 import 都落得下
 *      （少搬一个 .mjs，构建照样成功，线上才 404）
 *
 *   ③ 数据层 —— /api/data 的响应体和 api/data.json 【逐字节】相同
 *      （不是「解析后深比较」那种弱判据；真的是同一个字节序列）
 *
 *   ④ 行为层 —— 客户端真的启动两次，比对算路结果、搜索结果、绘制调用数
 *      （连 UI 画出来多少笔都对齐）
 *
 *   ⑤ 反向层 —— 谁偷偷改了站点里的文件，或者改了源码忘了重新构建，都要报错
 *
 * ④ 是重点。前三层只能证明「文件是那份文件」，证明不了「跑起来是同一个东西」——
 * 比如 shim 拦截错了、数据取到了别的楼层、静默退化成了空数据，
 * 文件层全绿而线上是坏的。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SITE = path.resolve(ROOT, argOf('--site', path.join('..', 'BDIA-3D-Navigator')));
const PORT = Number(argOf('--port', 5198));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0; let fail = 0;
const bad = [];
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; bad.push(m + (extra ? `\n         ${extra}` : '')); console.log(`  FAIL ${m}${extra ? `\n         ${extra}` : ''}`); }
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

console.log('\n静态站点一致性验证\n' + '─'.repeat(66));
console.log(`  站点   ${path.relative(ROOT, SITE).replace(/\\/g, '/')}/`);

if (!fs.existsSync(SITE)) {
  console.error(`\n  ✗ 站点目录不存在：${SITE}\n    先跑 npm run build:static\n`);
  process.exit(1);
}

const manifestPath = path.join(SITE, 'build-manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`\n  ✗ 没有 build-manifest.json —— 这个目录不是本项目的构建产物。\n`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`  构建   ${manifest.builtAt}\n`);

/* ══════════════════ ① 文件层：逐字节相同 ══════════════════ */
console.log('① 文件层 —— 逐字节比对');

{
  const mismatched = [];
  const missing = [];
  for (const f of manifest.files) {
    const built = path.join(SITE, f.path);
    if (!fs.existsSync(built)) { missing.push(f.path); continue; }
    const got = sha256(fs.readFileSync(built));
    if (got !== f.sha256) { mismatched.push(`${f.path}（站点里的文件被改过）`); continue; }

    /*
     * ★ 反向检查：源文件也要对得上。
     *   只验站点那一侧的话，「改了 app.js 但忘了重新构建」会被判为通过 ——
     *   而那正是这个项目最容易发生、也最危险的一种不一致。
     */
    if (f.source) {
      const srcPath = path.join(ROOT, f.source);
      if (!fs.existsSync(srcPath)) { missing.push(`${f.path} ← 源文件 ${f.source} 不见了`); continue; }
      const want = f.rewritten ? f.sourceSha256 : f.sha256;
      const srcGot = sha256(fs.readFileSync(srcPath));
      if (srcGot !== want) {
        mismatched.push(`${f.path} ← ${f.source} 改过了，但站点没重新构建`);
      }
    }
  }
  ok(missing.length === 0, `${manifest.files.length} 个文件都在`, missing.join('、'));
  ok(mismatched.length === 0, '每个文件都和源文件逐字节相同（或被明确记录的改写）', mismatched.join('、'));

  /* 被改写的文件必须【只有】index.html，且改写内容写在 manifest 里可审 */
  const rewritten = manifest.files.filter((f) => f.rewritten).map((f) => f.path);
  ok(rewritten.length === 1 && rewritten[0] === 'client/index.html',
    `唯一被改写的文件是 client/index.html（实际：${rewritten.join(', ') || '无'}）`);
  const idx = manifest.files.find((f) => f.path === 'client/index.html');
  ok((idx?.edits?.length ?? 0) === 2, `改写处数已记录（${idx?.edits?.length ?? 0} 处）`);
}

/* ══════════════════ ② 依赖图层：每个 import 都落得下 ══════════════════ */
console.log('\n② 依赖图层 —— 站点里每个资源都取得到');

{
  const rel = (p) => path.relative(SITE, p).replace(/\\/g, '/');
  const exists = (p) => fs.existsSync(p);
  const resolve = (fromRel, ref) =>
    path.posix.normalize(path.posix.join('/', path.posix.dirname(fromRel), ref)).replace(/^\/+/, '');

  const queue = [];
  const html = fs.readFileSync(path.join(SITE, 'client', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (!/^https?:|^\/\//.test(m[1])) queue.push([m[1], 'client/index.html']);
  }
  /* 客户端真正会请求的数据文件 */
  queue.push(['api/data.json', 'client/static-api.js']);

  const seen = new Set();
  const broken = [];
  while (queue.length) {
    const [ref, from] = queue.shift();
    const target = resolve(from, ref);
    if (seen.has(target)) continue;
    seen.add(target);
    const full = path.join(SITE, target);
    if (!exists(full)) { broken.push(`${from} → ${ref}（站点里没有 ${target}）`); continue; }
    if (!/\.(mjs|js)$/.test(target)) continue;
    const src = fs.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) queue.push([m[1], target]);
  }
  ok(broken.length === 0, `依赖图走通 ${seen.size} 个资源`, broken.join('\n         '));
  ok(exists(path.join(SITE, 'client', 'api', 'data.json')), '数据文件 client/api/data.json 在位');
  ok(exists(path.join(SITE, 'client', 'static-api.js')), 'shim client/static-api.js 在位');
  void rel;
}

/* ══════════════════ ③ 数据层：/api/data 逐字节 ══════════════════ */

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'editor-server.mjs'), '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));
const cleanup = () => { try { server.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitReady(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

console.log('\n③ 数据层 —— /api/data 与 api/data.json 逐字节比对');

if (!await waitReady()) {
  console.error('  ✗ editor-server 没能启动，跳过数据层与行为层\n');
  fail++;
} else {
  const res = await fetch(`${BASE}/api/data`);
  const liveBuf = Buffer.from(await res.text(), 'utf8');
  const siteBuf = fs.readFileSync(path.join(SITE, 'client', 'api', 'data.json'));
  const same = liveBuf.equals(siteBuf);
  ok(same, `响应体与 api/data.json 完全相同（${siteBuf.length} 字节）`,
    same ? '' : firstDiff(liveBuf, siteBuf));

  /* 顺带确认载荷形状没退化 —— 空数据也能「完全一致」 */
  const d = JSON.parse(siteBuf.toString('utf8'));
  ok((d.facilities?.features?.length ?? 0) > 0, `设施非空（${d.facilities?.features?.length ?? 0} 个）`);
  ok((d.paths?.features?.length ?? 0) > 0, `通行线非空（${d.paths?.features?.length ?? 0} 条）`);
  ok((d.manifest?.levels && Object.keys(d.manifest.levels).length) > 0, 'manifest.levels 非空');
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const s = Math.max(0, i - 60);
      return `第 ${i} 字节起不同：\n`
        + `           开发  …${a.slice(s, i + 40).toString('utf8')}\n`
        + `           静态  …${b.slice(s, i + 40).toString('utf8')}`;
    }
  }
  return `长度不同：开发 ${a.length} 字节，静态 ${b.length} 字节`;
}

/* ══════════════════ ④ 行为层：真的启动两次 ══════════════════ */
console.log('\n④ 行为层 —— 客户端真的启动两次，比对行为指纹');

function runBoot(mode) {
  return new Promise((resolve) => {
    const args = [path.join(ROOT, 'tools', 'static-boot.mjs'), '--mode', mode];
    if (mode === 'live') args.push('--base', BASE);
    else args.push('--site', SITE);
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.split(/\r?\n/).filter((l) => l.startsWith('__FINGERPRINT__')).pop();
      if (!line) return resolve({ error: `没有拿到指纹。stdout 尾部：\n${out.slice(-600)}\nstderr：${err.slice(-600)}` });
      try { resolve(JSON.parse(line.slice('__FINGERPRINT__'.length))); }
      catch (e) { resolve({ error: `指纹不是合法 JSON：${e.message}` }); }
    });
    child.on('error', (e) => resolve({ error: e.message }));
  });
}

{
  const [live, stat] = await Promise.all([runBoot('live'), runBoot('static')]);

  if (live.__fail || stat.__fail) {
    ok(false, '客户端启动', `开发：${live.__fail ?? 'ok'}　静态：${stat.__fail ?? 'ok'}`);
  } else if (live.error || stat.error) {
    ok(false, '客户端启动', `开发：${live.error ?? 'ok'}\n         静态：${stat.error ?? 'ok'}`);
  } else {
    ok(true, `两次都启动成功（开发 ${live.counts?.facilities} 个设施 / 静态 ${stat.counts?.facilities} 个）`);

    const diffs = [];
    diff(live, stat, '', diffs);
    ok(diffs.length === 0, '行为指纹逐字段相同', diffs.slice(0, 12).join('\n         '));

    /* 指纹本身不能是空的 —— 两边都算出「什么都没有」也算「一致」 */
    ok((live.routes?.length ?? 0) > 0, `算路结果已进入指纹（${live.routes?.length ?? 0} 对起终点）`);
    ok((live.draw2d ?? 0) > 50, `2D 绘制调用数有意义（${live.draw2d ?? 0} 次）`);
    ok((live.draw3d ?? 0) > 50, `3D 绘制调用数有意义（${live.draw3d ?? 0} 次）`);
    ok(live.errors === 0 && stat.errors === 0, `两边都没有未捕获错误（开发 ${live.errors} / 静态 ${stat.errors}）`);

    /* 算路真的算出了路 —— 全是 ok:false 的话，一致性证明力很弱 */
    const routed = (live.routes ?? []).filter((r) => r.ok).length;
    if (routed === 0) console.log(`  note 这几对起终点当前都算不出路（数据本身如此），一致性仍然成立`);
    else console.log(`  note 其中 ${routed} 对成功算出路径，步骤哈希已比对`);
  }
}

/** 深比较，把差异路径收集起来。 */
function diff(a, b, prefix, out) {
  if (out.length > 40) return;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push(`${prefix}: 类型不同 ${ta} vs ${tb}`); return; }
  if (ta === 'array') {
    if (a.length !== b.length) { out.push(`${prefix}: 长度不同 ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${prefix}[${i}]`, out);
    return;
  }
  if (ta === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a)) { out.push(`${prefix}.${k}: 静态独有`); continue; }
      if (!(k in b)) { out.push(`${prefix}.${k}: 开发独有`); continue; }
      diff(a[k], b[k], `${prefix}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${prefix}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

/* ══════════════════ 结果 ══════════════════ */

cleanup();
console.log('\n' + '─'.repeat(66));
if (fail) {
  console.log(`  ✗ 静态站点一致性验证未通过　${pass} 通过 / ${fail} 失败`);
  for (const b of bad) console.log(`    · ${b}`);
  console.log('');
  process.exit(1);
}
console.log(`  ✓ 通过　${pass}/${pass}　静态客户端与开发客户端一致\n`);
process.exit(0);
