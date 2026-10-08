#!/usr/bin/env node
/**
 * 编辑器端到端冒烟测试。
 *
 * 做三件事：
 *   1. 起一个临时服务器，按浏览器的方式把整张 import 依赖图抓一遍
 *      （能抓到「模块路径写错」「循环依赖」这类只有运行时才暴露的问题）
 *   2. 打一遍 API 端点，确认返回的数据形状符合【当前】模型
 *   3. 静态审计：app.js 用到的 ed.xxx 是否都在 state.mjs 里；
 *      工具栏按钮会不会被裁掉
 *
 * ★ 第 3 项是踩坑加的：
 *   · 重写 state.mjs 时漏了 ed.save / ed.validate / ed.find，没有类型检查兜底，
 *     运行时才炸成「ed.save is not a function」
 *   · 模式按钮加到 11 个之后，工具栏没有 overflow，右边的按钮被直接裁掉 ——
 *     界面上看不见，用户只会觉得「这个功能不存在」
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const bad = [];

/* ------------------------------------------------------------ 起服务器 */

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'editor-server.mjs'), '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

async function waitReady(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function cleanup() { try { server.kill(); } catch { /* ignore */ } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log(`\n编辑器端到端冒烟测试　端口 ${PORT}\n` + '─'.repeat(66));

if (!await waitReady()) {
  console.error('  ✗ 服务器没能启动');
  process.exit(1);
}

/* -------------------------------------------------------- 模块依赖图 */

console.log('\n模块依赖图');

const seen = new Map();
async function grab(urlPath, from = null) {
  if (seen.has(urlPath)) return seen.get(urlPath);
  seen.set(urlPath, null);
  const res = await fetch(BASE + urlPath);
  const text = res.ok ? await res.text() : '';
  seen.set(urlPath, { ok: res.ok, status: res.status, text });
  console.log(`  ${res.ok ? 'ok  ' : 'FAIL'}  ${String(res.status).padEnd(4)} ${urlPath}${from ? `   (来自 ${from})` : ''}`);
  if (!res.ok) bad.push(`${urlPath} 取不到（${res.status}）`);
  return seen.get(urlPath);
}

const index = await grab('/editor/');
if (index?.ok) {
  const queue = [];
  const pushRefs = (src, from) => {
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) queue.push([m[1], from]);
    for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) queue.push([m[1], from]);
  };
  pushRefs(index.text, '/editor/');
  while (queue.length) {
    const [ref, from] = queue.shift();
    const baseDir = from.endsWith('/') ? from : from.slice(0, from.lastIndexOf('/') + 1);
    const urlPath = new URL(ref, `http://x${baseDir}`).pathname;
    if (seen.has(urlPath)) continue;
    const r = await grab(urlPath, from);
    if (r?.ok && /\.(mjs|js)$/.test(urlPath)) pushRefs(r.text, urlPath);
  }
}

/* ------------------------------------------------------------- API */

console.log('\nAPI 端点');

async function apiJson(p) {
  const res = await fetch(BASE + p);
  if (!res.ok) { bad.push(`${p} 返回 ${res.status}`); return null; }
  try { return await res.json(); } catch { bad.push(`${p} 不是合法 JSON`); return null; }
}

await apiJson('/api/health');
await apiJson('/api/plans');

const d = await apiJson('/api/data');
if (d) {
  const n = Object.keys(d.levels ?? {}).length;
  const regions = Object.values(d.levels ?? {}).reduce((s, p) => s + (p.regions?.features.length ?? 0), 0);
  const area = (d.facilities?.features ?? []).filter((f) => f.geometry.type === 'Polygon').length;
  const point = (d.facilities?.features ?? []).filter((f) => f.geometry.type === 'Point').length;
  console.log(`\n  /api/data：${n} 个楼层，${regions} 个区域，通行线 ${d.paths?.features.length ?? 0} 条，连接件 ${d.connectors.features.length}`);
  console.log(`  设施 ${d.facilities.features.length}（面状 ${area} · 点状 ${point}，同一份数据）· 障碍物 ${d.obstacles.features.length}`);

  if (!d.manifest) bad.push('/api/data 没有返回 manifest');
  if (!d.facilities) bad.push('/api/data 没有返回 facilities');
  if (!d.obstacles) bad.push('/api/data 没有返回 obstacles');
  if (!d.paths) bad.push('/api/data 没有返回 paths —— 通行线是唯一的寻路图，必须有');
  if ('pois' in d) bad.push('/api/data 还在返回已废弃的 pois');
  if ('zones' in d) bad.push('/api/data 还在返回已废弃的 zones（区域自己带 zone）');
  if ('walkable' in d) bad.push('/api/data 还在返回已废弃的 walkable（现在叫 regions）');
  for (const [lv, p] of Object.entries(d.levels ?? {})) {
    if (!p.regions) bad.push(`levels.${lv} 没有 regions —— 服务端可能还在按旧的 walkable 名字读文件`);
  }
  for (const f of d.facilities?.features ?? []) {
    if (f.properties && 'door' in f.properties) {
      bad.push(`${f.id} 还带着已废弃的 door 字段 —— 门现在由通行线的吸附点算出来，不该存盘`);
      break;
    }
  }
}

/* ---------------------------------------------------------- 静态审计 */

console.log('\n接口审计（app.js ↔ state.mjs）');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'editor', 'app.js'), 'utf8');
  const stSrc = fs.readFileSync(path.join(ROOT, 'editor', 'lib', 'state.mjs'), 'utf8');
  const used = [...new Set([...appSrc.matchAll(/\bed\.([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]))];
  const defined = new Set([...stSrc.matchAll(/ed\.([a-zA-Z_]\w*)\s*=/g)].map((m) => m[1]));
  const fields = new Set([...stSrc.matchAll(/^\s{4}([a-zA-Z_]\w*):/gm)].map((m) => m[1]));
  const missing = used.filter((k) => !defined.has(k) && !fields.has(k));
  console.log(`  app.js 调用 ${used.length} 个 ed 成员；state.mjs 提供 ${defined.size} 个方法 + ${fields.size} 个字段`);
  if (missing.length) bad.push(`state.mjs 缺少 app.js 要用到的成员：${missing.join(', ')}　→ 运行时会炸成「ed.xxx is not a function」`);
  else console.log('  ok   无缺失');
}

console.log('\n工具栏可发现性');
{
  const html = fs.readFileSync(path.join(ROOT, 'editor', 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'editor', 'app.js'), 'utf8');
  const modes = [...appSrc.matchAll(/\{ id: '([a-z]+)', key: '([A-Z0-9])', label: '([^']+)'/g)];
  console.log(`  ${modes.length} 个模式按钮：${modes.map((m) => m[2]).join(' ')}`);
  const tb = html.match(/#toolbar\s*\{[^}]*\}/);
  const scrolls = tb && /overflow-x\s*:\s*(auto|scroll)/.test(tb[0]);
  if (modes.length >= 8 && !scrolls) {
    bad.push(`工具栏有 ${modes.length} 个模式按钮，但 #toolbar 没有 overflow-x —— 右边的按钮会被裁掉，用户找不到它们`);
  } else if (scrolls) {
    console.log('  ok   #toolbar 可横向滚动，按钮不会被裁掉');
  }
}

/* ------------------------------------------------------------- 结果 */

console.log('\n' + '─'.repeat(66));
if (bad.length) {
  console.error(`  ✗ ${bad.length} 项失败：\n    ` + bad.join('\n    ') + '\n');
  process.exit(1);
}
console.log(`  ✓ 通过　${seen.size} 个资源全部可取，模块依赖图完整，接口与可发现性审计通过\n`);
process.exit(0);
