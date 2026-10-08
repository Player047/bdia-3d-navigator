/**
 * data/source 的读取 —— 编辑器服务器和静态构建【共用同一份】。
 *
 * ★ 为什么必须共用：
 *   静态页面的数据来自构建时生成的 api/data.json，开发时的数据来自服务器的 /api/data。
 *   如果这两条路各写一遍读取逻辑，那么「加了一个新数据文件」「改了楼层目录的扫描规则」
 *   这类改动只会在其中一边生效 —— 而表现是【静态站点上少了一整层，且不报任何错】。
 *
 *   所以读取逻辑只此一份，两边都调 loadAll()。
 *   tools/static-parity.mjs 会真的起一次服务器、把 /api/data 和 api/data.json 逐字段比对，
 *   不一致就直接失败。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON，读不到或坏掉就返回 fallback —— 不抛。 */
export function readJsonIfExists(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 扫描 data/source 下的楼层目录。跳过 `.` 和 `_` 开头（那些是配置，不是楼层）。 */
export function listLevelDirs(srcDir) {
  if (!fs.existsSync(srcDir)) return [];
  return fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name).sort();
}

/** 空 GeoJSON 集合。数据文件缺失时用它顶上，客户端不必判 null。 */
export const emptyFeatureCollection = () => ({ type: 'FeatureCollection', features: [] });

/**
 * 读出全部源数据。
 *
 * ★ 返回对象的【键顺序】是有意义的：静态构建会把它 JSON.stringify 落盘，
 *   顺序变了，同一份数据就会产出不同的文件字节。保持一致便于 diff 和校验。
 *
 * @param {string} srcDir  data/source 的绝对路径
 * @param {string} srcLabel 载荷里 srcDir 字段要写的标签（相对项目根，正斜杠）
 */
export function loadAll(srcDir, srcLabel = 'data/source') {
  const levels = {};
  for (const dir of listLevelDirs(srcDir)) {
    // ★ 区域 = 隔离区标记，不参与寻路。寻路完全由 paths.geojson 决定。
    const regions = readJsonIfExists(path.join(srcDir, dir, 'regions.geojson'));
    if (!regions) continue;
    levels[dir] = { regions };
  }
  return {
    ok: true,
    srcDir: srcLabel,
    manifest: readJsonIfExists(path.join(srcDir, 'manifest.json')),
    anchors: readJsonIfExists(path.join(srcDir, 'anchors.json')),
    calibration: readJsonIfExists(path.join(srcDir, '_calibration.json'), { version: 2, levels: {} }),
    connectors: readJsonIfExists(path.join(srcDir, 'connectors.geojson'), emptyFeatureCollection()),
    // ★ 设施是唯一实体，几何是 Point 或 Polygon，点面混在一个文件里
    facilities: readJsonIfExists(path.join(srcDir, 'facilities.geojson'), emptyFeatureCollection()),
    obstacles: readJsonIfExists(path.join(srcDir, 'obstacles.geojson'), emptyFeatureCollection()),
    // ★ 通行线：唯一的寻路图
    paths: readJsonIfExists(path.join(srcDir, 'paths.geojson'), emptyFeatureCollection()),
    levels,
  };
}

/**
 * 数据指纹 = data/source 下所有文件里最新的修改时间 + 文件数。
 *
 * ★ 这是拿数据换来的第二道闸。
 *   编辑器把数据加载到内存之后，如果磁盘上的文件被别的东西改了
 *   （改了代码、跑了一次迁移脚本、另一个标签页保存过），
 *   用户再按保存，就会把【加载时那份旧的】整个写回去 —— 静默回退，
 *   而且回退出来的还是一份完全合法的 JSON，事后看不出任何异常。
 *
 *   实测发生过两次：一次把 paths/obstacles/regions 写成空集合，
 *   一次把 65 个类别的旧 manifest 盖回合并后的 36 个。
 *
 *   所以：加载时把指纹给客户端，保存时带回来比对。对不上就拒收。
 */
export function dataStamp(srcDir) {
  let newest = 0;
  let count = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;      // .backup/ 之类不算数据
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try { newest = Math.max(newest, fs.statSync(full).mtimeMs); count++; } catch { /* ignore */ }
    }
  };
  walk(srcDir);
  return { mtime: Math.round(newest), files: count };
}
