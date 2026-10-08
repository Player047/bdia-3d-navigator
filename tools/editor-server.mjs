#!/usr/bin/env node
/**
 * BDIA 数据编辑器 —— 本地开发服务器
 *
 * 零依赖。只监听 127.0.0.1。作用是让浏览器里的编辑器能：
 *   · 直接读写 data/source/（不用导出下载再手动搬文件）
 *   · 复用 tools/lib/geo.mjs（同一份几何库，不会和校验器算出不一样的结果）
 *   · 直接调 tools/validate.mjs 拿校验结果
 *
 * 用法: node tools/editor-server.mjs [--port 5173] [--open=both|editor|client] [--no-open]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ★ 读取逻辑与静态构建共用一份，两边不可能算出不同的载荷。
import { loadAll, dataStamp, readJsonIfExists } from './lib/source-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'source');
const PLANS = path.join(ROOT, 'plans');
const EDITOR = path.join(ROOT, 'editor');
const TMP = path.join(ROOT, '.editor-tmp');

const argv = process.argv.slice(2);
/**
 * 取命令行参数。
 * ★ 两种写法都要认：`--open both` 和 `--open=both`。
 *   只认空格形式的话，用 `=` 写的人会拿到默认值 —— 而且不报错，
 *   只会觉得「这个参数没用」。
 */
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', process.env.PORT ?? 5173));
const HOST = '127.0.0.1';
const VALIDATOR = path.join(ROOT, 'tools', 'validate.mjs');
const BUILD_STATIC = path.join(ROOT, 'tools', 'build-static.mjs');

/*
 * ★ --static-out <dir>：每次保存成功后【顺手重建静态站点】。
 *
 *   没有它的话，「改了数据」和「静态站点跟着更新」之间隔着一个
 *   需要人记住的手工步骤 —— 而漏掉它的表现是「线上还是旧数据」，
 *   不报错，也很难第一时间想到。
 *
 *   传了才开。不开的时候保存路径完全不变（多一次 spawn 都不做）。
 */
const STATIC_OUT = argOf('--static-out', process.env.BDIA_STATIC_OUT ?? '');

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(PLANS, { recursive: true });

/* ------------------------------------------------------------- 工具 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/** 把 URL 路径解析成磁盘路径，并确保没有逃出允许的根目录。 */
function safeResolve(urlPath, allowRoots) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (clean.includes('\0')) return null;
  for (const [prefix, dir] of allowRoots) {
    if (clean === prefix || clean.startsWith(prefix + '/')) {
      const rel = clean.slice(prefix.length).replace(/^\/+/, '');
      const full = path.resolve(dir, rel);
      if (full !== dir && !full.startsWith(dir + path.sep)) return null; // 目录穿越
      return full;
    }
  }
  return null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('请求体超过 64MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------- /api/data */

/*
 * 数据指纹、楼层目录扫描、整包读取都在 tools/lib/source-data.mjs。
 *
 * ★ 静态构建（tools/build-static.mjs）调的是同一份。
 *   如果这里再写一遍读取逻辑，那么「加一个数据文件」「改楼层扫描规则」
 *   就只会在一侧生效 —— 表现是【静态站点上少了一整层，且不报任何错】。
 */

/* -------------------------------------------------------- /api/save */

/**
 * POST /api/save
 * body: { files: { "manifest.json": {...}, "L3F/regions.geojson": {...}, ... } }
 *
 * 只允许写 data/source 下的白名单文件名 —— 编辑器改不到别的地方去。
 * 每份内容写盘前先 JSON.parse 一遍：绝不把坏 JSON 落盘。
 */
/**
 * 保存前的体检。
 *
 * ★ 这一条是拿数据换来的：编辑器曾经在 currentLevel 为 null 的状态下保存过一次，
 *   把 paths / obstacles / regions 全部写成了空集合，manifest 也被内存里的旧副本覆盖，
 *   连「null/regions.geojson」这种目录都建了出来。没有备份，只能手工重建。
 *
 * 所以现在两道闸：
 *   ① 退化状态直接拒收 —— 空集合 + null 楼层，任何时候都不是合法的保存意图
 *   ② 真写之前先整目录快照，留最近若干份
 */
function inspectSave(files) {
  const problems = [];

  for (const rel of Object.keys(files)) {
    const key = rel.replace(/^data\/source\//, '').replace(/\\/g, '/');
    if (/(^|\/)null(\/|$)/.test(key)) {
      problems.push(`${rel} —— 路径里有 "null" 楼层目录，说明编辑器拿到过空楼层`);
    }
  }

  const cal = files['_calibration.json'];
  if (cal && cal.levels && Object.prototype.hasOwnProperty.call(cal.levels, 'null')) {
    problems.push('_calibration.json 里有 "null" 楼层 —— currentLevel 是空的时候调用了校准接口');
  }

  // 磁盘上明明有数据，却要写一堆空集合 —— 多半是前端没加载成功就开始保存
  const emptyish = ['paths.geojson', 'facilities.geojson'];
  for (const name of emptyish) {
    const fc = files[name];
    if (!fc) continue;
    if (!Array.isArray(fc.features) || fc.features.length) continue;
    const disk = readJsonIfExists(path.join(SRC, name));
    if (disk && Array.isArray(disk.features) && disk.features.length > 0) {
      problems.push(`${name}：磁盘上有 ${disk.features.length} 个要素，这次要写成 0 个`
        + ' —— 如果确实是想清空，先手工删文件再保存');
    }
  }

  return problems;
}

/** 写盘前把整个 data/source 快照一份，保留最近 N 份。 */
function snapshotBeforeSave() {
  try {
    if (!fs.existsSync(SRC)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(ROOT, 'data', '.backup', stamp);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(SRC, dest, { recursive: true });
    // 只留最近 20 份
    const root = path.join(ROOT, 'data', '.backup');
    const all = fs.readdirSync(root).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 20))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
    return path.relative(ROOT, dest).replace(/\\/g, '/');
  } catch (e) {
    return `（快照失败：${e.message}）`;
  }
}

function handleSave(req, res) {
  readBody(req).then((raw) => {
    let payload;
    try { payload = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const files = payload?.files ?? {};

    /*
     * ⓪ 过期检查 —— 磁盘上的数据比客户端加载时新，就拒收。
     *    这是最隐蔽的一类数据丢失：写回去的是一份完全合法的 JSON，
     *    事后从文件本身看不出任何异常，只是「我之前改的东西不见了」。
     *    客户端没带 stamp 就跳过（兼容旧页面），带了就必须对得上。
     */
    if (payload.stamp && !payload.force) {
      const now = dataStamp(SRC);
      if (payload.stamp.mtime && now.mtime > payload.stamp.mtime) {
        return sendJson(res, 409, {
          ok: false,
          error: '磁盘上的数据比你打开页面时新，已拒绝保存（磁盘没有被改动）',
          stale: true,
          loadedAt: payload.stamp.mtime,
          diskNow: now.mtime,
          hint: '多半是你改了代码 / 跑过迁移脚本 / 另一个标签页保存过。'
            + '刷新页面（F5）重新加载再改，否则会把中间那些改动整个盖掉。',
        });
      }
    }

    // ① 体检
    const problems = inspectSave(files);
    if (problems.length && !payload.force) {
      return sendJson(res, 409, {
        ok: false,
        error: '这次保存看起来是坏的，已拒绝（磁盘没有被改动）',
        problems,
        hint: '先刷新编辑器页面重新加载数据。确实要强制写入的话，再点一次「保存」并在确认框里选「仍要保存」。',
      });
    }

    // ② 快照
    const backup = snapshotBeforeSave();

    const written = [], rejected = [];
    for (const [rel, content] of Object.entries(files)) {
      const key = rel.replace(/^data\/source\//, '').replace(/\\/g, '/');
      const full = path.resolve(SRC, key);
      if (!full.startsWith(SRC + path.sep)) { rejected.push(rel); continue; }
      const base = path.basename(key);
      const allowedBase = [
        'manifest.json', 'anchors.json', '_calibration.json',
        'connectors.geojson',
        'facilities.geojson', 'obstacles.geojson', 'paths.geojson',
        'regions.geojson',
      ];
      if (!allowedBase.includes(base)) { rejected.push(rel); continue; }
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
      try { JSON.parse(text); } catch (e) {
        return sendJson(res, 400, { ok: false, error: `${key} 不是合法 JSON：${e.message}`, written });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
      written.push(key);
    }
    /*
     * ★ 保存成功后必须把【新的指纹】带回去。
     *   写盘本身就会改 mtime —— 不回传的话客户端手里还是加载时那个旧指纹，
     *   于是【第二次保存必然被判为过期】。用户看到的现象就是
     *   「第一次存上了，之后就怎么都存不进去」。
     */
    const stamp = dataStamp(SRC);

    /*
     * ③ 顺手重建静态站点（只有在启用了 --static-out 时才做）。
     *    放在写盘之后：构建读的就是刚写下去的那份数据。
     *    构建失败【不影响保存结果】—— 数据已经落盘了，
     *    回一个失败码会让用户以为保存没成功，然后去重复保存。
     */
    let staticBuild = null;
    if (STATIC_OUT) {
      const r = spawnSync(process.execPath, [BUILD_STATIC, '--out', STATIC_OUT, '--quiet'], {
        cwd: ROOT, stdio: 'inherit', timeout: 120000,
      });
      staticBuild = { ok: r.status === 0, exitCode: r.status, out: STATIC_OUT };
      if (r.status !== 0) {
        console.error(`\n  ✗ 静态站点重建失败（退出码 ${r.status}）—— 数据已保存，静态站点还是旧的\n`);
      } else {
        console.log(`  ↻ 静态站点已重建 → ${STATIC_OUT}\n`);
      }
    }

    return sendJson(res, 200, { ok: true, written, rejected, backup, stamp, staticBuild });
  }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
}

/* ---------------------------------------------------- /api/validate */

let validateBusy = false;
function handleValidate(req, res) {
  if (validateBusy) return sendJson(res, 429, { ok: false, error: '上一次校验还没跑完' });
  validateBusy = true;
  const out = path.join(TMP, 'validate.json');
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }

  // ★ 用 --out 写文件而不是捕获 stdout：受限环境下管道会被拦，且写文件更稳。
  const r = spawnSync(process.execPath, [VALIDATOR, '--json', '--out', out, '--quiet'], {
    cwd: ROOT, stdio: 'inherit', timeout: 30000,
  });

  const result = readJsonIfExists(out);
  validateBusy = false;
  if (!result) {
    return sendJson(res, 500, { ok: false, error: `校验器没有产出结果（退出码 ${r.status}）` });
  }
  return sendJson(res, 200, { ok: true, exitCode: r.status, ...result });
}

/* --------------------------------------------------- /api/plans */

function handlePlans(req, res) {
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.bmp']);
  let files = [];
  try {
    files = fs.readdirSync(PLANS, { withFileTypes: true })
      .filter((d) => d.isFile() && exts.has(path.extname(d.name).toLowerCase()))
      .map((d) => {
        const st = fs.statSync(path.join(PLANS, d.name));
        return { name: d.name, url: '/plans/' + encodeURIComponent(d.name), bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* plans 目录不存在就是空的 */ }
  sendJson(res, 200, { ok: true, dir: 'plans/', files });
}

/* ------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  try {
    if (url === '/api/data' && req.method === 'GET') {
      const payload = loadAll(SRC);
      payload.stamp = dataStamp(SRC);   // ★ 客户端保存时要带回来，用来发现「磁盘比你新」
      return sendJson(res, 200, payload);
    }
    if (url === '/api/save' && req.method === 'POST') return handleSave(req, res);
    if (url === '/api/validate' && req.method === 'POST') return handleValidate(req, res);
    if (url === '/api/plans' && req.method === 'GET') return handlePlans(req, res);
    if (url === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, root: ROOT, src: path.relative(ROOT, SRC), node: process.version });
    }

    // ★ / 必须重定向到 /editor/，不能直接把 index.html 吐在 / 上。
    //   浏览器按「文档 URL」解析相对路径，页面在 / 时 <script src="./app.js"> 会变成 /app.js → 404，
    //   整个编辑器白屏。重定向后文档 URL 是 /editor/，相对路径自然落到 /editor/app.js。
    if (url === '/' || url === '') {
      res.writeHead(302, { Location: '/editor/' });
      return res.end();
    }

    // 静态资源。tools/ 也要开放：编辑器和客户端都用相对路径 import 同一批模块
    // （几何、建图、寻路、搜索索引），同一份实现不会算出两种结果。
    const roots = [
      ['plans', PLANS],
      ['tools', path.join(ROOT, 'tools')],
      ['editor', EDITOR],
      ['client', path.join(ROOT, 'client')],
      ['data', path.join(ROOT, 'data')],
    ];
    let file = safeResolve(url, roots);
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

    if (!file || !fs.existsSync(file)) {
      return send(res, 404, `404  ${url}\n\n可用：\n  /                     编辑器\n  /api/data             读取全部源数据\n  /api/plans            平面图列表\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const body = fs.readFileSync(file);
    return send(res, 200, body, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message, stack: err.stack });
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  const editorUrl = `${base}/editor/`;
  const clientUrl = `${base}/client/`;
  console.log('');
  console.log('  BDIA 数据编辑器 + 客户端');
  console.log('  ' + '─'.repeat(60));
  console.log(`  编辑器     ${editorUrl}`);
  console.log(`  客户端     ${clientUrl}`);
  console.log(`  源数据     ${path.relative(ROOT, SRC).replace(/\\/g, '/')}/`);
  console.log(`  平面图     ${path.relative(ROOT, PLANS).replace(/\\/g, '/')}/   ← 把平面图图片放这里`);
  console.log('  ' + '─'.repeat(60));

  /*
   * ★ 一个服务器同时服务编辑器和客户端 —— 它们读的是同一份 data/source，
   *   同一批 tools/lib 模块。所以「开客户端服务器」不需要另起进程，
   *   只是多开一个页面而已。
   *
   *   默认两个都开：改完数据就能立刻在客户端看到效果，这是最常见的循环。
   *   不想全开就用 --open=editor / --open=client，或者 --no-open 一个都不开。
   */
  const which = String(argOf('--open', 'both'));
  const targets = ({
    both: [editorUrl, clientUrl],
    editor: [editorUrl],
    client: [clientUrl],
    none: [],
  })[which] ?? [editorUrl, clientUrl];

  if (!argv.includes('--no-open') && which !== 'none') {
    for (const u of targets) openBrowser(u);
  }
  if (STATIC_OUT) {
    console.log(`  静态站点   ${STATIC_OUT}`);
    console.log('             ↑ 每次保存后自动重建');
  }
  console.log('  Ctrl+C 停止　　　想只开一个：--open=editor / --open=client');
  console.log('');
});

/**
 * 尽力打开浏览器。
 *
 * ★ 这里绝对不能让它把服务器搞崩。早期版本用的 exec() 内部走管道 stdio，
 *   在没有权限 spawn 子进程的环境里会抛 EPERM —— 而未捕获的 'error' 事件
 *   会直接终止进程。表现是「打印出了访问地址，然后服务器立刻死掉」。
 *   现在：stdio: 'ignore'（不开管道）+ 必须挂 error 监听 + 整段包在 try 里。
 */
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* 没有浏览器 / 没有权限 —— 手动打开那个地址就行 */ });
    child.unref();
  } catch { /* 同上，静默忽略 */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ 端口 ${PORT} 已被占用。换一个：node tools/editor-server.mjs --port 5174\n`);
  } else {
    console.error('\n  ✗ ' + e.message + '\n');
  }
  process.exit(1);
});
