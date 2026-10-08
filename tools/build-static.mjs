#!/usr/bin/env node
/**
 * 构建静态站点 —— 可以直接丢进 S3 + CloudFront 的那种。
 *
 * 用法:
 *   node tools/build-static.mjs                      # 输出到 ../BDIA-3D-Navigator
 *   node tools/build-static.mjs --out <dir>          # 换输出目录
 *   node tools/build-static.mjs --quiet              # 只打印错误
 *
 * ════════════════════════════════════════════════════════════════════
 * 这个脚本存在的唯一理由：让「开发时看到的客户端」和「线上跑的客户端」
 * 是同一份代码，而不是两份像的代码。
 * ════════════════════════════════════════════════════════════════════
 *
 * 所以它不是「打包」，是【照搬 + 生成数据】：
 *
 *   client/app.js          →  app.js           逐字节
 *   client/lib/*.mjs       →  lib/*.mjs        逐字节
 *   client/assets/*        →  assets/*         逐字节
 *   tools/lib/*.mjs        →  tools/lib/*.mjs  逐字节（客户端 import 的就是它）
 *   tools/static/static-api.js → static-api.js 逐字节
 *   client/index.html      →  index.html       ★ 唯一被改写的文件，且改写是固定的两处
 *                                              （加一行 shim、改一句 file:// 提示）
 *   data/source/           →  api/data.json    生成的
 *
 * 没有压缩、没有改名、没有 tree-shaking、没有 bundle。
 * 每个文件的 sha256 记进 build-manifest.json，tools/static-parity.mjs
 * 会拿它和仓库里的源文件逐个比对 —— 只要有人偷偷改了线上的副本，
 * 或者改了源码忘了重新构建，测试就会失败。
 *
 * ★ app.js 一个字符都不改，意味着 fetch('/api/data') 原样保留。
 *   数据落到 api/data.json 这件事由 static-api.js 在运行时接管。
 *   详见该文件顶部的说明。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAll, dataStamp } from './lib/source-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'source');
const STATIC_SRC = path.join(ROOT, 'tools', 'static');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, argOf('--out', path.join('..', 'BDIA-3D-Navigator')));
const QUIET = argv.includes('--quiet');

const problems = [];
const warn = (m) => problems.push(m);

/* ------------------------------------------------------------------ 工具 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readText = (p) => fs.readFileSync(p, 'utf8');

/* --------------------------------------------------- index.html 的两处改写 */

/**
 * ★ 锚点必须精确命中，否则【直接失败】。
 *
 *   静默地少注入一行 shim，产出的是一个「其它资源全 200、只有数据取不到」
 *   的站点 —— 界面上是一句看不懂的报错，而构建日志一片绿。
 *   宁可构建失败，也不要产出这种站点。
 */
function injectShim(html) {
  const ANCHOR = '<script type="module" src="./app.js"></script>';
  const n = html.split(ANCHOR).length - 1;
  if (n !== 1) {
    throw new Error(`index.html 里 "${ANCHOR}" 出现 ${n} 次（应为 1 次）。\n`
      + '    client/index.html 改过之后，tools/build-static.mjs 的注入锚点要跟着改。');
  }
  return html.replace(ANCHOR, '<script src="./static-api.js"></script>\n' + ANCHOR);
}

/**
 * 第二处改写：file:// 的提示文案。
 *
 * 原文案让人「cd projects/bdia-nav && npm run editor」—— 那是开发目录的做法，
 * 静态站点上没有那个服务器，照着做只会更困惑。
 * 只动这一段错误提示，正常运行路径完全不受影响。
 */
function fixFileProtocolHint(html) {
  const OLD = `    fail('不能直接用文件打开', '<p>浏览器会以 CORS 为由拒绝加载 ES 模块。</p>'
      + '<p>请用本地服务打开：<pre>cd projects/bdia-nav\\\\nnpm run editor</pre>'
      + '然后访问 <code>http://127.0.0.1:5173/client/</code></p>');`;
  const NEW = `    fail('不能直接用文件打开', '<p>浏览器会以 CORS 为由拒绝加载 ES 模块，也取不到 api/data.json。</p>'
      + '<p>这个页面必须通过 HTTP 访问：用它的 S3 / CloudFront 地址，'
      + '或者在本目录起一个静态服务，例如 <code>npx serve .</code></p>');`;
  if (!html.includes(OLD)) {
    throw new Error('index.html 里那段 file:// 提示的原文变了，替换锚点失效。\n'
      + '    client/index.html 改过之后，tools/build-static.mjs 的这段锚点要跟着改。');
  }
  return html.replace(OLD, NEW);
}

/* -------------------------------------------------------------- 收集文件 */

/**
 * 要照搬的文件清单：源文件 → 站点内相对路径。
 *
 * ★ 站点布局【原样保留 client/ 和 tools/ 两层】，不摊平到根目录。
 *
 *   因为 client/app.js 里写的是 import '../tools/lib/graph.mjs'。
 *   app.js 在 /client/ 下时，这个相对路径解析到 /tools/lib/ ——
 *   开发服务器的目录结构和这里【一模一样】，浏览器和 Node 的解析结果也一致。
 *
 *   摊平到根目录则会变成「/app.js 引用 ../tools/lib/…」：
 *   浏览器按 RFC 3986 会把根之上的 .. 丢掉，凑巧能跑；
 *   但 Node 从磁盘 import 时会真的跑到站点目录【外面】去找，
 *   于是无头测试根本启动不了客户端 —— 而线上却是好的。
 *   这种「只在测试里坏」的布局不能要。
 */
function collectCopies() {
  const out = [];
  const add = (from, to) => out.push({ from, to });

  add(path.join(ROOT, 'client', 'index.html'), 'client/index.html');
  add(path.join(ROOT, 'client', 'app.js'), 'client/app.js');
  for (const f of fs.readdirSync(path.join(ROOT, 'client', 'lib'))) {
    if (f.endsWith('.mjs') || f.endsWith('.js')) add(path.join(ROOT, 'client', 'lib', f), `client/lib/${f}`);
  }
  const assetsDir = path.join(ROOT, 'client', 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const f of fs.readdirSync(assetsDir)) add(path.join(assetsDir, f), `client/assets/${f}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'tools', 'lib'))) {
    if (f.endsWith('.mjs') || f.endsWith('.js')) add(path.join(ROOT, 'tools', 'lib', f), `tools/lib/${f}`);
  }
  // shim 和 client/index.html 同目录，于是它算出来的「站点根」就是 /client/
  add(path.join(STATIC_SRC, 'static-api.js'), 'client/static-api.js');
  add(path.join(STATIC_SRC, 'SITE-README.md'), 'README.md');
  add(path.join(STATIC_SRC, 'deploy.ps1'), 'deploy.ps1');
  return out;
}

/* -------------------------------------------------- 依赖图完整性（自检） */

/**
 * 像浏览器那样把依赖图走一遍，确认站点里每个 import 都落得下。
 *
 * ★ 这一步是廉价保险：少搬一个 tools/lib/*.mjs，构建照样成功，
 *   线上才 404，而且只有点到那个功能时才炸。
 *
 * ★ 解析时先拼到虚拟根 '/' 再规范化：
 *   'client/app.js' + '../tools/lib/graph.mjs' 要得到 'tools/lib/graph.mjs'。
 *   直接 path.join('client', '..', ...) 也能对，但 'app.js' + '../x' 这种
 *   【越过站点根】的写法，join 会留下前导 '..'，而浏览器按 RFC 3986 是把
 *   根之上的 .. 丢掉。先锚到 '/' 就与浏览器一致了。
 */
function checkModuleGraph(files) {
  const have = new Set(files.map((f) => f.to));
  const resolve = (from, ref) =>
    path.posix.normalize(path.posix.join('/', path.posix.dirname(from), ref)).replace(/^\/+/, '');

  const queue = [];
  const indexHtml = files.find((f) => f.to === 'client/index.html');
  for (const m of (indexHtml?.text ?? '').matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (!/^https?:|^\/\//.test(m[1])) queue.push([m[1], 'client/index.html']);
  }
  const visited = new Set();
  while (queue.length) {
    const [ref, from] = queue.shift();
    const rel = resolve(from, ref);
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (!have.has(rel)) { warn(`依赖图缺文件：${from} 引用了 ${ref} → 站点里没有 ${rel}`); continue; }
    const f = files.find((x) => x.to === rel);
    if (!f || !/\.(mjs|js)$/.test(rel)) continue;
    for (const m of (f.text ?? '').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push([m[1], rel]);
    }
  }
  return visited;
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到源数据目录：${SRC}`);

  /* 1. 载荷 —— 和服务器 /api/data 用同一个 loadAll，键顺序也一样 */
  const payload = loadAll(SRC);
  payload.stamp = dataStamp(SRC);
  /*
   * ★ 用紧凑 JSON，且顺序与 server 的 sendJson 完全一致。
   *   于是 api/data.json 的字节 === /api/data 响应体的字节，
   *   parity 测试可以直接逐字节比对，不需要「解析后深比较」这种弱一些的判据。
   */
  const dataText = JSON.stringify(payload);

  /* 2. 逐个读源文件，构造输出 */
  const files = [];
  for (const { from, to } of collectCopies()) {
    if (!fs.existsSync(from)) throw new Error(`找不到要照搬的源文件：${from}`);
    const buf = fs.readFileSync(from);
    files.push({ from, to, buf, sha256: sha256(buf), source: path.relative(ROOT, from).replace(/\\/g, '/') });
  }

  /* 3. client/index.html 的两处改写 */
  const idx = files.find((f) => f.to === 'client/index.html');
  if (!idx) throw new Error('collectCopies() 没有产出 client/index.html');
  const originalSha = idx.sha256;
  const edited = fixFileProtocolHint(injectShim(idx.buf.toString('utf8')));
  idx.buf = Buffer.from(edited, 'utf8');
  idx.text = edited;
  idx.sha256 = sha256(idx.buf);
  idx.edited = true;

  for (const f of files) if (f.text === undefined && /\.(mjs|js|html)$/.test(f.to)) f.text = f.buf.toString('utf8');

  /* 4. 生成物 */
  const dataBuf = Buffer.from(dataText, 'utf8');
  files.push({ to: 'client/api/data.json', buf: dataBuf, sha256: sha256(dataBuf), generated: true, text: dataText });

  /*
   * ★ 根上的 index.html：把 / 送到 /client/index.html。
   *
   *   为什么需要它：CloudFront 的 Default root object 只会把
   *   client/index.html 的内容【在 URL / 上】返回，
   *   而浏览器是按【文档 URL】解析相对路径的 ——
   *   地址栏是 / 时，'./app.js' 就变成了 /app.js → 404，整页白屏。
   *   （editor-server.mjs 里那段「/ 必须 302 到 /editor/」的注释，
   *     踩的是同一个坑。）
   *
   * ★ 跳转目标写成 client/index.html，【不写 client/】。
   *   S3 的 REST 端点（CloudFront + OAC 用的就是它）不会把目录映射到
   *   index.html —— 那是「静态网站托管」端点的行为。
   *   写 client/ 的话，在开着 OAC 的分发上会拿到 404，而本地用
   *   python -m http.server 预览却正常，于是本地和线上行为不一致。
   *   写全文件名则在两种配置下都对。
   */
  const rootRedirect = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>BDIA 3D Navigator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=./client/index.html">
<link rel="canonical" href="./client/index.html">
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;
    font:14px/1.6 system-ui,-apple-system,"Noto Sans SC",sans-serif;
    display:flex;align-items:center;justify-content:center}
  a{color:#58a6ff}
</style>
</head>
<body>
<p>正在打开 <a href="./client/index.html">BDIA 3D Navigator</a>…</p>
</body>
</html>
`;
  const rootBuf = Buffer.from(rootRedirect, 'utf8');
  files.push({ to: 'index.html', buf: rootBuf, sha256: sha256(rootBuf), generated: true, note: '跳转到 ./client/index.html' });

  /* 5. 依赖图自检 */
  const graph = checkModuleGraph(files);

  /* 6. 落盘 */
  fs.mkdirSync(OUT, { recursive: true });
  const prevManifestPath = path.join(OUT, 'build-manifest.json');
  let prevManaged = [];
  try {
    const prev = JSON.parse(fs.readFileSync(prevManifestPath, 'utf8'));
    prevManaged = [...(prev.files ?? []), ...(prev.generated ?? [])].map((x) => x.path);
  } catch { /* 第一次构建，没有上一份 */ }

  for (const f of files) {
    const dest = path.join(OUT, f.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.buf);
  }

  /* 7. 清理上一份产出、这一份不再有的文件 */
  /*
   * ★ 判据是「上一份 manifest 记过它」，不是「它落在当前的托管目录里」。
   *   两者不等价：改了输出布局之后（比如从摊平改成 client/ 子目录），
   *   旧布局的文件不在新托管集合里 —— 按后者判断就会【永久残留】，
   *   而它们恰好是会被浏览器加载的旧副本。
   *   manifest 里的路径是我们自己写下去的，可以放心删。
   *   从没被记过的文件（用户的 thumbnail.svg 之类）一律不碰。
   */
  const nowSet = new Set(files.map((f) => f.to));
  const removed = [];
  for (const rel of prevManaged) {
    if (nowSet.has(rel)) continue;
    const full = path.resolve(OUT, rel);
    if (full !== OUT && !full.startsWith(OUT + path.sep)) continue;   // 越界，跳过
    try { fs.rmSync(full, { force: true }); removed.push(rel); } catch { /* ignore */ }
  }
  /* 删空目录（只可能由上面的删除产生），自底向上 */
  const pruneEmpty = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
    if (dir === OUT) return;
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
  };
  pruneEmpty(OUT);

  /* 8. manifest —— parity 测试全靠它 */
  const manifest = {
    generator: 'bdia-nav/tools/build-static.mjs',
    builtAt: new Date().toISOString(),
    outputDir: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    dataStamp: payload.stamp,
    counts: {
      levels: Object.keys(payload.levels ?? {}).length,
      facilities: payload.facilities?.features?.length ?? 0,
      paths: payload.paths?.features?.length ?? 0,
      obstacles: payload.obstacles?.features?.length ?? 0,
      connectors: payload.connectors?.features?.length ?? 0,
    },
    /*
     * 逐字节照搬的文件。sha256 是【站点里那份】的哈希。
     * source 指向仓库里的源文件，parity 测试会重新算一遍源文件的哈希来对。
     */
    files: files.filter((f) => !f.generated).map((f) => ({
      path: f.to,
      source: f.source,
      bytes: f.buf.length,
      sha256: f.sha256,
      ...(f.to === 'client/index.html'
        ? {
          rewritten: true,
          sourceSha256: originalSha,
          edits: [
            '在 <script type="module" src="./app.js"> 之前插入 <script src="./static-api.js">',
            'file:// 错误提示改成静态部署的说法',
          ],
        }
        : {}),
    })),
    generated: files.filter((f) => f.generated).map((f) => ({
      path: f.to,
      bytes: f.buf.length,
      sha256: f.sha256,
      from: f.to === 'client/api/data.json' ? 'data/source/' : 'tools/build-static.mjs',
    })),
    moduleGraph: [...graph].sort(),
  };
  fs.writeFileSync(prevManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  /* 9. 报告 */
  if (!QUIET) {
    console.log('');
    console.log('  静态站点构建');
    console.log('  ' + '─'.repeat(62));
    console.log(`  输出       ${path.relative(ROOT, OUT).replace(/\\/g, '/')}/`);
    console.log(`  数据       ${manifest.counts.levels} 层 · 设施 ${manifest.counts.facilities}`
      + ` · 通行线 ${manifest.counts.paths} · 障碍物 ${manifest.counts.obstacles}`);
    console.log(`  依赖图     ${graph.size} 个资源，全部落地`);
    console.log(`  照搬       ${manifest.files.length - 1} 个文件逐字节相同`);
    console.log(`  改写       client/index.html（${manifest.files.find((f) => f.path === 'client/index.html')?.edits.length ?? 0} 处，见 build-manifest.json）`);
    console.log(`  入口       /  →  ./client/`);
    if (removed.length) console.log(`  清理       ${removed.length} 个上一版遗留文件：${removed.join(', ')}`);
    console.log('  ' + '─'.repeat(62));
  }

  return manifest;
}

try {
  const m = main();
  if (problems.length) {
    console.error('\n  ✗ 构建有问题：');
    for (const p of problems) console.error('    · ' + p);
    process.exit(1);
  }
  if (QUIET) console.log(`静态构建完成 → ${path.relative(ROOT, OUT).replace(/\\/g, '/')}/`);
  else {
    console.log('  校验：node tools/static-parity.mjs');
    console.log('');
  }
  void m;
} catch (e) {
  console.error('\n  ✗ 构建失败：' + e.message + '\n');
  process.exit(1);
}
