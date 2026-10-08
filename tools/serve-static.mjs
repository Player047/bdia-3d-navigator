#!/usr/bin/env node
/**
 * 静态站点本地预览 —— 尽量模拟 S3 + CloudFront 的行为。
 *
 * 用法:
 *   node tools/serve-static.mjs                       # 预览 ../BDIA-3D-Navigator
 *   node tools/serve-static.mjs --site <dir> --port 8080
 *
 * ★ 为什么不直接 `npx serve` / `python -m http.server`：
 *
 *   ① MIME。浏览器对 ES module 做【严格 MIME 检查】，.mjs 必须回
 *      JavaScript 类型。python -m http.server 会把 .mjs 当成
 *      application/octet-stream，于是本地一看是白屏，而线上（S3 设对了
 *      Content-Type）明明是好的 —— 本地和线上行为不一致，最费时间。
 *   ② 缓存。这里照搬部署时的策略（html/json 不缓存，其余长缓存），
 *      本地就能提前撞上「数据缓存住了」这类问题。
 *   ③ 目录。CloudFront 不会自动把 /client/ 映射到 /client/index.html，
 *      这里也不做，免得出「本地能跑、线上 403」的假象。
 *      （真实部署靠 CloudFront 的 Default root object，那是分发级配置。）
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
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
const PORT = Number(argOf('--port', process.env.PORT ?? 8080));
const HOST = argOf('--host', '127.0.0.1');

/** 与 tools/static/deploy.ps1 里的三档缓存策略保持一致。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function cacheFor(rel) {
  if (rel === 'index.html' || rel.endsWith('/index.html')) return 'no-cache';
  if (rel === 'client/api/data.json' || rel === 'build-manifest.json') return 'no-cache';
  return 'public, max-age=31536000, immutable';
}

if (!fs.existsSync(SITE)) {
  console.error(`\n  ✗ 站点目录不存在：${SITE}\n    先跑 npm run build:static\n`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  let rel = decodeURIComponent(url).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  const full = path.resolve(SITE, rel);
  if (full !== SITE && !full.startsWith(SITE + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403\n');
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404  ${url}\n\n静态站点里没有这个文件。\n`
      + `· 这里不做目录自动索引 —— S3 的 REST 端点（CloudFront + OAC 用的就是它）也不做。\n`
      + `· 客户端入口是 /client/index.html，不是 /client/。\n`);
  }

  const body = fs.readFileSync(full);
  const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cacheFor(rel.replace(/\\/g, '/')),
    'Content-Length': body.length,
  });
  res.end(body);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  ✗ 端口 ${PORT} 已被占用，换一个：--port 8081\n`);
  else console.error('\n  ✗ ' + e.message + '\n');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  BDIA 3D Navigator —— 静态站点预览');
  console.log('  ' + '─'.repeat(60));
  console.log(`  站点    ${path.relative(ROOT, SITE).replace(/\\/g, '/')}/`);
  console.log(`  地址    ${base}/client/index.html`);
  console.log(`  数据    ${base}/client/api/data.json`);
  console.log('  ' + '─'.repeat(60));
  console.log('  Ctrl+C 停止');
  console.log('');
});
