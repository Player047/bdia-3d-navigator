#!/usr/bin/env node
/**
 * BDIA 3D Navigator — 源数据校验器
 *
 * 用法:
 *   node tools/validate.mjs              人读输出
 *   node tools/validate.mjs --json       机器可读（CI 用）
 *   node tools/validate.mjs --strict     WARN 也算失败
 *   node tools/validate.mjs --quiet      只印问题清单
 *
 * 退出码: 0 = 通过, 1 = 有 ERROR（或 --strict 下有 WARN）, 2 = 数据无法加载
 *
 * ★ 阈值全部从 manifest.thresholds 读取，不要在这里硬编码。
 *
 * ★★ 这一版的核心变化：
 *
 *   通行线 paths   = 唯一的寻路图
 *   区域   regions = 只是隔离区标记，【不参与寻路】
 *   设施           = 能不能走到，取决于通行线有没有接上它
 *
 *   所以删掉了所有基于「可通行面相邻性」的旧检查（E_ZONE_ADJACENT_NO_GATE、
 *   基于多边形邻接的 E_DISCONNECTED、W_ISOLATED_WALKABLE），
 *   隔离区泄漏改为在【图】上检查。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from './lib/geo.mjs';
import {
  buildNetwork, normalizeFeatures, sampleAlong, polylineSelfIntersects,
  segIntersectionPoints, nearestOnPaths, setLevelOrder,
} from './lib/graph.mjs';
import { buildSearchIndex, categoryFields } from './lib/search.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const OPT = {
  json: argv.includes('--json'),
  strict: argv.includes('--strict'),
  quiet: argv.includes('--quiet'),
  src: (() => {
    const i = argv.indexOf('--src');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : process.env.BDIA_SRC ?? null;
  })(),
  out: (() => {
    const i = argv.indexOf('--out');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  })(),
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const SRC = OPT.src ? path.resolve(process.cwd(), OPT.src) : path.join(ROOT, 'data', 'source');

/* ------------------------------------------------------------------ 输出 */

const useColor = process.stdout.isTTY && !OPT.json && !process.env.NO_COLOR;
const C = {
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s) => (useColor ? `\x1b[34m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
};

const issues = [];
function add(severity, group, code, message, ctx = {}) {
  issues.push({ severity, group, code, message, ...ctx });
}

/* ------------------------------------------------------------ 载入数据 */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(C.red(`\n✗ 无法解析 ${path.relative(ROOT, file)}`));
    console.error(`  ${err.message}`);
    console.error(C.dim('  提示：手改 GeoJSON 最常见的错误是多余的逗号、缺引号、以及把注释 // 当成合法语法。\n'));
    process.exit(2);
  }
}

const keys = (obj) => Object.keys(obj || {}).filter((k) => !k.startsWith('_'));

function loadFeatures(file, kind) {
  if (!fs.existsSync(file)) return [];
  const fc = readJson(file);
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    add('ERROR', '结构与引用', 'E_BAD_FC', `${path.relative(ROOT, file)} 不是合法的 FeatureCollection`);
    return [];
  }
  const out = [];
  fc.features.forEach((f, idx) => {
    if (!f || f.type !== 'Feature') {
      add('ERROR', '结构与引用', 'E_BAD_FEATURE', `${path.relative(ROOT, file)} features[${idx}] 不是 Feature`);
      return;
    }
    out.push({ id: f.id ?? f.properties?.id ?? null, file: path.relative(ROOT, file), idx, feature: f, props: f.properties ?? {}, kind });
  });
  return out;
}

const manifest = readJson(path.join(SRC, 'manifest.json'));
const LEVELS = keys(manifest.levels);
const ZONES = keys(manifest.zones);
const CONN_TYPES = keys(manifest.connectorTypes);
const CATEGORIES = keys(manifest.facilityCategories);
const SCENARIOS = keys(manifest.scenarios);
const REGION_KINDS = keys(manifest.regionKinds);
const PATH_KINDS = keys(manifest.pathKinds);
const OBSTACLE_KINDS = keys(manifest.obstacleKinds);
const TH = manifest.thresholds ?? {};
const PROJECTION = manifest.projection ?? {};

/* ---- 扫描各楼层目录 ---- */

const levelDirs = fs.existsSync(SRC)
  ? fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
const DRAWN_LEVELS = levelDirs.filter((lv) => fs.existsSync(path.join(SRC, lv, 'regions.geojson')));
for (const lv of levelDirs) {
  if (!LEVELS.includes(lv)) {
    add('ERROR', '结构与引用', 'E_UNKNOWN_LEVEL_DIR', `目录 ${lv}/ 不是 manifest.levels 里定义的楼层`, { hint: `已定义：${LEVELS.join(', ')}` });
  }
}

/* ---- 载入全部要素 ---- */

const S = {
  regions: [], facilities: [], obstacles: [], connectors: [], paths: [], anchors: null,
};
for (const lv of levelDirs) {
  for (const r of loadFeatures(path.join(SRC, lv, 'regions.geojson'), 'region')) {
    if (!r.props.level) r.props.level = lv;
    S.regions.push(r);
  }
}
S.facilities = loadFeatures(path.join(SRC, 'facilities.geojson'), 'facility');
S.obstacles = loadFeatures(path.join(SRC, 'obstacles.geojson'), 'obstacle');
S.connectors = loadFeatures(path.join(SRC, 'connectors.geojson'), 'connector');
S.paths = loadFeatures(path.join(SRC, 'paths.geojson'), 'path');
if (fs.existsSync(path.join(SRC, 'anchors.json'))) S.anchors = readJson(path.join(SRC, 'anchors.json'));

/* ------------------------------------------------------------ 几何解析 */

/** Feature → Polygon 数组（MultiPolygon 摊平）。 */
function toPolygons(entry) {
  const geom = entry.feature.geometry;
  const name = entry.id ?? `features[${entry.idx}]`;
  if (!geom) {
    add('ERROR', '几何有效性', 'E_NO_GEOMETRY', `${name} 没有 geometry`, { file: entry.file, feature: entry.id });
    return [];
  }
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  add('ERROR', '几何有效性', 'E_BAD_GEOMETRY_TYPE', `${name} 的几何是 ${geom.type}，这里需要 Polygon / MultiPolygon`, { file: entry.file, feature: entry.id });
  return [];
}

function parseGeometry(e) {
  const g = e.feature.geometry;
  e.point = null; e.coords = []; e.polygons = [];
  if (g?.type === 'Point') {
    if (G.isFinitePoint(g.coordinates)) e.point = g.coordinates;
    else add('ERROR', '几何有效性', 'E_BAD_NUMBER', `${e.id} 的 Point 坐标非法 ${JSON.stringify(g.coordinates)}`, { file: e.file, feature: e.id });
  } else if (g?.type === 'LineString') {
    if (Array.isArray(g.coordinates) && g.coordinates.length >= 2 && g.coordinates.every(G.isFinitePoint)) e.coords = g.coordinates;
    else add('ERROR', '几何有效性', 'E_BAD_LINESTRING', `${e.id} 的 LineString 至少需要 2 个合法点`, { file: e.file, feature: e.id });
  } else {
    e.polygons = toPolygons(e);
  }
  return e;
}

for (const e of [...S.regions, ...S.facilities, ...S.obstacles, ...S.connectors]) parseGeometry(e);
for (const e of S.paths) parseGeometry(e);

const byId = {
  region: new Map(S.regions.map((x) => [x.id, x])),
  facility: new Map(S.facilities.map((x) => [x.id, x])),
  obstacle: new Map(S.obstacles.map((x) => [x.id, x])),
  connector: new Map(S.connectors.map((x) => [x.id, x])),
  path: new Map(S.paths.map((x) => [x.id, x])),
};

const areaFacilities = S.facilities.filter((f) => f.polygons.length);
const pointFacilities = S.facilities.filter((f) => f.point);
const featureArea = (e) => e.polygons.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0);

/** 点在哪个区域里（同层，带容差）。 */
function regionAt(pt, level, tol = 0) {
  return S.regions.find((r) => r.props.level === level
    && r.polygons.some((p) => (tol > 0 ? G.pointPolygonGap(pt, p) <= tol : G.pointInPolygon(pt, p)))) ?? null;
}

/* ============================================================ 1. 结构与引用 */

function checkIds() {
  const seen = new Map();
  for (const [kind, list] of Object.entries(byId)) {
    for (const e of list.values()) {
      if (!e.id) continue;
      const k = `${kind}:${e.id}`;
      if (seen.has(k)) {
        add('ERROR', '结构与引用', 'E_DUP_ID', `${e.id} 在 ${kind} 里重复出现（${seen.get(k)} 与 ${e.file}）`, { file: e.file, feature: e.id });
      } else seen.set(k, e.file);
    }
  }
  // 跨层重名也危险（搜索会撞车）
  const all = new Map();
  for (const list of Object.values(byId)) {
    for (const e of list.values()) {
      if (!e.id) continue;
      if (all.has(e.id)) add('ERROR', '结构与引用', 'E_DUP_ID_GLOBAL', `${e.id} 在不同图层里重复：${all.get(e.id)} 与 ${e.file}`, { file: e.file, feature: e.id });
      else all.set(e.id, e.file);
    }
  }
}

function checkEnums() {
  const need = (e, field, allowed, code) => {
    const v = e.props[field];
    if (v === undefined || v === null) return false;
    if (!allowed.includes(v)) {
      add('ERROR', '结构与引用', code, `${e.id} 的 ${field} "${v}" 未定义`, { file: e.file, feature: e.id, hint: `可用：${allowed.join(', ')}` });
      return false;
    }
    return true;
  };

  for (const r of S.regions) {
    need(r, 'level', LEVELS, 'E_UNKNOWN_LEVEL');
    need(r, 'zone', ZONES, 'E_UNKNOWN_ZONE');
    need(r, 'kind', REGION_KINDS, 'E_UNKNOWN_REGION_KIND');
    if (!r.props.name) add('WARN', '覆盖与质量', 'W_NO_NAME', `${r.id} 没有 name`, { file: r.file, feature: r.id });
  }
  for (const p of S.paths) {
    need(p, 'level', LEVELS, 'E_UNKNOWN_LEVEL');
    need(p, 'zone', ZONES, 'E_UNKNOWN_ZONE');
    need(p, 'kind', PATH_KINDS, 'E_UNKNOWN_PATH_KIND');
    /*
     * ★ 不再检查通行线的 name。
     *
     *   通行线【本来就不该有名字】—— 转向指令里显示的是「走廊」「指廊通道」
     *   这种类别名（pathKinds[kind].name），那是旅客看得懂的话。
     *   给它起「三号走廊西段」这种名字，既不会出现在界面上，
     *   也没人维护，纯属字段噪声。
     *
     *   这条旧检查一次就报了 128 条，全是莫须有。
     */
    if (p.props.speedFactor !== undefined && !(p.props.speedFactor > 0)) {
      add('ERROR', '结构与引用', 'E_BAD_SPEED_FACTOR', `${p.id} 的 speedFactor 必须大于 0，实际 ${p.props.speedFactor}`, { file: p.file, feature: p.id });
    }
  }
  for (const f of S.facilities) {
    need(f, 'level', LEVELS, 'E_UNKNOWN_LEVEL');
    if (f.props.zone !== undefined) need(f, 'zone', ZONES, 'E_UNKNOWN_ZONE');
    need(f, 'category', CATEGORIES, 'E_UNKNOWN_CATEGORY');
    /*
     * ★ 设施「没有名字」只有在【真的搜不到】时才算问题。
     *
     *   原来的检查是「name 为空就报」—— 但新模型里很多设施的显示名
     *   来自类别的 labelKey 字段（登机口的 E42、值机柜台的编号），
     *   名字留空是【设计如此】。也有的设施靠 fields 里的值就能被搜到。
     *
     *   所以改成：名字、labelKey 值、任意一个字段值 —— 三者全空才报。
     *   这才是「用户没法搜到它」这句话的真实含义。
     */
    if (!f.props.name) {
      const defs = categoryFields(manifest, f.props.category);
      const lk = manifest?.facilityCategories?.[f.props.category]?.labelKey;
      const vals = f.props.fields ?? {};
      const hasAnyField = Object.values(vals).some((v) => v !== undefined && v !== null && String(v).trim() !== '');
      const hasLabel = lk && String(vals[lk] ?? '').trim() !== '';
      if (!hasLabel && !hasAnyField) {
        add('WARN', '覆盖与质量', 'W_NO_NAME',
          `${f.id}（${manifest?.facilityCategories?.[f.props.category]?.name ?? f.props.category}）`
          + '既没有 name，也没有任何字段值 —— 搜索里完全找不到它',
          { file: f.file, feature: f.id, hint: '给它起个名字，或者填上类别字段（有 labelKey 的类别填那个字段）' });
      }
      void defs;
    }
  }
  for (const o of S.obstacles) {
    need(o, 'level', LEVELS, 'E_UNKNOWN_LEVEL');
    need(o, 'kind', OBSTACLE_KINDS, 'E_UNKNOWN_OBSTACLE_KIND');
  }
  for (const c of S.connectors) {
    const t = c.props.type ?? c.props.connectorType;
    if (!t) add('ERROR', '结构与引用', 'E_MISSING_PROP', `${c.id} 缺少 type`, { file: c.file, feature: c.id });
    else if (!CONN_TYPES.includes(t)) add('ERROR', '结构与引用', 'E_UNKNOWN_CONNECTOR_TYPE', `${c.id} 的 type "${t}" 未定义`, { file: c.file, feature: c.id, hint: `可用：${CONN_TYPES.join(', ')}` });
    for (const side of ['from', 'to']) {
      const e = c.props[side];
      if (!e) { add('ERROR', '结构与引用', 'E_MISSING_PROP', `${c.id} 缺少 ${side}`, { file: c.file, feature: c.id }); continue; }
      if (!LEVELS.includes(e.level)) add('ERROR', '结构与引用', 'E_UNKNOWN_LEVEL', `${c.id} 的 ${side}.level "${e.level}" 未定义`, { file: c.file, feature: c.id });
      if (e.zone !== undefined && !ZONES.includes(e.zone)) add('ERROR', '结构与引用', 'E_UNKNOWN_ZONE', `${c.id} 的 ${side}.zone "${e.zone}" 未定义`, { file: c.file, feature: c.id });
    }
    if (c.props.from?.zone && c.props.to?.zone && c.props.from.zone === c.props.to.zone
      && c.props.from.level === c.props.to.level) {
      add('INFO', '结构与引用', 'I_CONN_SAME_ZONE_LEVEL', `${c.id} 的两端在同一层同一区 —— 那不是连接件，应该直接画通行线`, { file: c.file, feature: c.id });
    }
  }

  // 场景的 zonePath 是否合法
  const rules = manifest.zoneRules?.allowedTransitions ?? [];
  for (const sid of SCENARIOS) {
    const sc = manifest.scenarios[sid];
    for (let i = 0; i + 1 < (sc.zonePath?.length ?? 0); i++) {
      const from = sc.zonePath[i], to = sc.zonePath[i + 1];
      const via = rules.filter((r) => r.from === from && r.to === to).flatMap((r) => r.via);
      if (!via.length) {
        add('ERROR', '覆盖与质量', 'E_ZONE_PATH_ILLEGAL', `场景「${sc.name}」的 zonePath 包含 ${from} → ${to}，但 manifest.zoneRules 里没有定义这种跨越`, { file: 'data/source/manifest.json' });
      }
    }
  }
}

/* ============================================================ 2. 几何有效性 */

function checkGeometry() {
  const minArea = TH.minPolygonArea ?? 0.5;

  for (const e of [...S.regions, ...S.obstacles, ...areaFacilities]) {
    for (const poly of e.polygons) {
      for (let ri = 0; ri < poly.length; ri++) {
        const ring = poly[ri];
        if (!G.ringIsClosed(ring)) {
          add('ERROR', '几何有效性', 'E_RING_OPEN', `${e.id} 的环没有闭合（首尾点必须相同）`, { file: e.file, feature: e.id });
          continue;
        }
        if (G.ringSelfIntersects(ring)) {
          add('ERROR', '几何有效性', 'E_SELF_INTERSECT', `${e.id} 的环自交 —— 面积和包含判断都会出错`, { file: e.file, feature: e.id });
        }
      }
    }
    const a = featureArea(e);
    if (a > 0 && a < minArea) {
      add('ERROR', '几何有效性', 'E_AREA_TOO_SMALL', `${e.id} 面积只有 ${a.toFixed(2)} m²，小于 ${minArea} —— 多半是误点出来的`, { file: e.file, feature: e.id });
    }
  }

  /*
   * 坐标是不是把经纬度当米写了。
   *
   * ★ 判据要盯住【这个机场的经纬度】，不能只看「像不像经纬度的取值范围」。
   *   本地坐标的合法范围可以有 ±250 米甚至更大，-156.32 / 83.4 是完全正常的米坐标；
   *   早先那条 `|x|>100 && |y|>20` 的宽松判据把一堆正常数据全报成了 ERROR。
   *   真正的信号是：值恰好落在原点附近（经度 116 上下、纬度 39 上下）。
   */
  for (const e of [...S.regions, ...S.facilities, ...S.obstacles, ...S.paths, ...S.connectors]) {
    const pts = e.point ? [e.point] : e.coords.length ? e.coords : e.polygons.flat(2);
    for (const p of pts) {
      if (!G.isFinitePoint(p)) continue;
      const nearLon = Math.abs(p[0] - PROJECTION.origin.lon) < 2;
      const nearLat = Math.abs(p[1] - PROJECTION.origin.lat) < 2;
      // 两个都贴近原点经纬度，或者明显是「经度 100~180 / 纬度 0~60」这种中国区间的写法
      const chinaish = Math.abs(p[0]) > 100 && Math.abs(p[0]) < 180 && Math.abs(p[1]) > 0 && Math.abs(p[1]) < 60;
      if ((nearLon && nearLat) || chinaish) {
        add('ERROR', '几何有效性', 'E_COORD_LOOKS_LIKE_LONLAT',
          `${e.id} 的坐标 ${JSON.stringify(p)} 看起来是经纬度 —— 本地坐标系是【米】，原点 ${JSON.stringify(PROJECTION.origin)}。北京经度约 116、纬度约 39，很容易写反`,
          { file: e.file, feature: e.id });
        break;
      }
    }
  }

  // 区域之间不能重叠（同层）；不同 zone 更不行
  for (let i = 0; i < S.regions.length; i++) {
    for (let j = i + 1; j < S.regions.length; j++) {
      const a = S.regions[i], b = S.regions[j];
      if (a.props.level !== b.props.level) continue;
      const hit = a.polygons.some((pa) => b.polygons.some((pb) => G.polygonsOverlap(pa, pb)));
      if (hit) {
        const cross = a.props.zone !== b.props.zone;
        add(cross ? 'ERROR' : 'WARN', '几何有效性', cross ? 'E_REGION_CROSS_ZONE_OVERLAP' : 'W_REGION_OVERLAP',
          `${a.id}（${a.props.zone}）与 ${b.id}（${b.props.zone}）重叠`,
          { feature: a.id, file: a.file, hint: cross ? '★ 不同隔离区的区域绝不能重叠 —— 那等于两个区是同一片地方' : '同层区域应该互不重叠' });
      }
    }
  }

  // 障碍物必须在某个区域里
  for (const o of S.obstacles) {
    if (!o.polygons.length) continue;
    const inside = o.polygons.some((p) => {
      const c = G.polygonCentroid(p);
      return S.regions.some((r) => r.props.level === o.props.level && r.polygons.some((rp) => G.pointInPolygon(c, rp)));
    });
    if (!inside) {
      add('WARN', '几何有效性', 'W_OBSTACLE_OUTSIDE_REGION', `${o.id} 不在任何区域里 —— 障碍是从区域里扣除的，落在区域外面没有意义`, { file: o.file, feature: o.id });
    }
  }
}

/* ============================================================ 3. 通行线 */

function checkPaths(net) {
  const tolRegion = TH.pathOnRegionTolerance ?? 0.5;
  const step = TH.pathSampleStep ?? 2;
  const nearMin = TH.pathNearMissMin ?? 0.05;
  const nearMax = TH.pathNearMissMax ?? 2;
  const anchorDist = TH.pathDanglingAnchorDistance ?? 15;
  const usable = S.paths.filter((p) => p.coords.length >= 2);

  /*
   * 不在任何隔离区面里的通行线。
   * ★ 【汇总成一条 INFO】，不逐条报。
   *   这条检查的旧前提是「每条通行线都带 zone，且区域面铺满所有可通行的地方」——
   *   新模型里通行线不带 zone，区域面只是隔离标记、不参与寻路、也不需要铺满。
   *   现在只画了 3 块区域面，于是 79 条线全部"越界"，逐条报就是 79 条噪音。
   *   但「这条线没被任何区域覆盖」对画区域的人是有用的，所以保留，只是汇总。
   */
  const OUTSIDE_REGION = [];

  for (const p of usable) {
    const q = p.props;

    if (polylineSelfIntersects(p.coords)) {
      add('ERROR', '通行线', 'E_PATH_SELF_INTERSECT',
        `${p.id}（${q.name ?? ''}）自交 —— 交叉点会被当成路口，凭空多出一个节点`,
        { file: p.file, feature: p.id, hint: '拆成两条线，或者把折点挪开' });
    }

    const regionCands = S.regions.filter((r) => r.props.level === q.level);
    if (!regionCands.length) {
      add('WARN', '通行线', 'W_PATH_NO_REGION', `${p.id} 所在楼层 ${q.level} 还没有区域面，无法校验它有没有画到外面去`, { file: p.file, feature: p.id });
    } else {
      const samples = sampleAlong(p.coords, step);
      const bad = [];
      for (const s of samples) {
        const hit = regionCands.find((r) => r.polygons.some((rp) => G.pointPolygonGap(s, rp) <= tolRegion) && r.props.zone === q.zone);
        if (!hit) {
          const near = regionCands
            .map((r) => ({ r, d: Math.min(...r.polygons.map((rp) => G.pointPolygonGap(s, rp))) }))
            .sort((a, b) => a.d - b.d)[0];
          bad.push({ s, near });
        }
      }
      if (bad.length) {
        const b = bad[0];
        /*
         * ★ 从 ERROR 降为「汇总一条 INFO」。
         *
         *   这条检查问的是「通行线有没有落在【它自己声明的 zone】的区域面里」——
         *   前提是「每条通行线都带 zone，而且区域面铺满了所有可通行的地方」。
         *   这两个前提在新模型下都不成立：
         *     · 通行线【不带 zone】了，zone 只标在设施上
         *     · 区域面只是隔离区标记，不参与寻路，也不需要铺满
         *   现在区域面只画了 3 块，于是 79 条线全部"越界"——
         *   全是莫须有。
         *
         *   但「这条线不在任何隔离区里」本身是有用的信息（画区域时可以参考），
         *   所以不删，降级 + 汇总成一条。
         */
        OUTSIDE_REGION.push(p.id);
        void b;
      }
    }

    // 不得穿过障碍物
    for (const o of S.obstacles) {
      if (o.props.level !== q.level || !o.polygons.length) continue;
      let hit = false;
      for (let i = 0; i + 1 < p.coords.length && !hit; i++) {
        for (const ring of o.polygons[0]) {
          for (let k = 0; k + 1 < ring.length; k++) {
            if (G.segmentsIntersect(p.coords[i], p.coords[i + 1], ring[k], ring[k + 1])) { hit = true; break; }
          }
          if (hit) break;
        }
      }
      if (!hit && o.polygons.some((poly) => G.pointInPolygon(p.coords[0], poly))) hit = true;
      if (hit) {
        add('ERROR', '通行线', 'E_PATH_CROSSES_OBSTACLE',
          `${p.id}（${q.name ?? ''}）穿过障碍物 ${o.id}${o.props.name ? `（${o.props.name}）` : ''} —— 路径会穿柱子`,
          { file: p.file, feature: p.id, hint: '把线绕开，或者把障碍物挪走' });
      }
    }
  }

  /* ---- ★ 隔离区：两条【不同 zone】的通行线绝不能相交 ---- */
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i], B = usable[j];
      if (A.props.level !== B.props.level) continue;
      if (A.props.zone === B.props.zone) continue;
      if (A.props.bridge || B.props.bridge) continue;
      let hit = null;
      for (let ai = 0; ai + 1 < A.coords.length && !hit; ai++) {
        for (let bi = 0; bi + 1 < B.coords.length; bi++) {
          const pts = segIntersectionPoints(A.coords[ai], A.coords[ai + 1], B.coords[bi], B.coords[bi + 1]);
          if (pts.length) { hit = pts[0]; break; }
        }
      }
      if (hit) {
        add('ERROR', '通行线', 'E_PATH_TOUCHES_OTHER_ZONE',
          `${A.id}（zone=${A.props.zone}）与 ${B.id}（zone=${B.props.zone}）在 ${JSON.stringify(hit.map((n) => Math.round(n * 10) / 10))} 相接`
          + ` —— 两条线会在图里合并成一个节点，隔离区就被绕过去了`,
          {
            file: A.file, feature: A.id,
            hint: '★ 这是新版最重要的一条隔离检查：不同隔离区的通行线之间【不能有任何接触】，'
              + '跨区只能经连接件。把其中一条缩回到自己区域内，中间放连接件',
          });
      }
    }
  }

  /* ---- 图结构与连通性 ---- */

  const graph = net.graph;
  const deg = graph.degree;

  // 同 (层, zone) 内必须连通
  const groups = new Map();
  for (const n of graph.nodes) {
    const k = `${n.level}|${n.zone}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n.id);
  }
  /*
   * 「不在任何隔离区面里」的通行线 —— 【汇总成一条】。
   * 逐条报的话（79 条）会把真正要看的东西淹掉，而这条信息本身只是提示：
   * 画区域的时候可以参考，不画也不影响寻路。
   */
  if (OUTSIDE_REGION.length) {
    add('INFO', '通行线', 'I_PATH_OUTSIDE_REGION',
      `${OUTSIDE_REGION.length}/${usable.length} 条通行线不在任何区域面内`
      + `（当前只画了 ${S.regions.length} 块区域面）—— 区域只是隔离区标记，不参与寻路，不影响导航`,
      {
        feature: OUTSIDE_REGION[0],
        hint: '需要按隔离区限制寻路时才要补区域面。不需要的话这条可以忽略',
        list: OUTSIDE_REGION,
      });
  }

  const comps = net.components;
  const nodeComp = net.nodeComp;
  for (const [k, ids] of groups) {
    const seen = new Set(ids.map((id) => nodeComp.get(id)).filter((x) => x !== undefined));
    if (seen.size > 1) {
      const [lv, zone] = k.split('|');
      const detail = [...seen].map((ci) => {
        const g = comps[ci].filter((id) => ids.includes(id));
        const n = graph.nodes.find((x) => x.id === g[0]);
        return `(${n.x.toFixed(0)},${n.y.toFixed(0)}) 起 ${g.length} 个节点`;
      }).join(' ｜ ');
      add('ERROR', '通行线', 'E_PATH_DISCONNECTED',
        `${lv} 的「${zone}」区里，通行线网络分成 ${seen.size} 块互不连通 —— 旅客走不过去`,
        { hint: `${detail}。常见原因：两条线看着相交但没真正接触（差几厘米）；或者漏画了一段` });
    }
  }

  // 每个 (层, zone) 组能否连到别的组（只有连接件能跨）
  const groupComp = new Map();
  for (const [k, ids] of groups) groupComp.set(k, nodeComp.get(ids[0]));
  const compGroups = new Map();
  for (const [k, ci] of groupComp) {
    if (!compGroups.has(ci)) compGroups.set(ci, []);
    compGroups.get(ci).push(k);
  }
  if (compGroups.size > 1 && graph.nodes.length) {
    const list = [...compGroups.values()].map((g) => g.join('+')).join('  ｜  ');
    add('WARN', '通行线', 'W_ZONE_UNREACHABLE',
      `路网分成 ${compGroups.size} 个互不连通的部分，中间没有连接件：${list}`,
      { hint: '如果这些区域本来就该互通，就在交界处补一个连接件（安检/扶梯/连廊）；如果本来就隔离，忽略这条' });
  }

  // 悬空端点
  for (const n of graph.nodes) {
    if ((deg.get(n.id) ?? 0) !== 1) continue;
    const nearFac = S.facilities.some((f) => {
      if (f.props.level !== n.level) return false;
      const pt = f.point ?? null;
      if (pt) return G.dist(pt, [n.x, n.y]) <= anchorDist;
      // 面状设施：端点在它边界附近也算接住了
      return f.polygons.some((p) => G.pointPolygonGap([n.x, n.y], p) <= anchorDist);
    });
    // ★ 必须【两端都查】。早先写成「from.level 匹配就用 from」，结果
    //   端点明明在 to 那侧 5m 处，也判成悬空。
    const nearConn = S.connectors.some((c) => ['from', 'to'].some((side) => {
      const e = c.props[side];
      return e && e.level === n.level && Math.hypot(e.x - n.x, e.y - n.y) <= anchorDist;
    }));
    if (!nearFac && !nearConn) {
      add('WARN', '通行线', 'W_PATH_DANGLING',
        `${n.level} 的通行线在 (${n.x.toFixed(0)}, ${n.y.toFixed(0)}) 有个悬空端点 —— 既不是路口，${anchorDist}m 内也没有设施或连接件`,
        { feature: n.paths[0], hint: '多半是漏接了：把端点拖到某个门/登机口/扶梯口上，或者补一段线接上' });
    }
  }

  // 近乎相交但没接触
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i], B = usable[j];
      if (A.props.level !== B.props.level) continue;
      if (A.props.bridge || B.props.bridge) continue;
      let connected = false;
      for (let ai = 0; ai + 1 < A.coords.length && !connected; ai++) {
        for (let bi = 0; bi + 1 < B.coords.length; bi++) {
          if (segIntersectionPoints(A.coords[ai], A.coords[ai + 1], B.coords[bi], B.coords[bi + 1]).length) { connected = true; break; }
        }
      }
      if (connected) continue;
      let best = null;
      for (const pa of A.coords) {
        for (let bi = 0; bi + 1 < B.coords.length; bi++) {
          const d = G.pointToSegmentDistance(pa, B.coords[bi], B.coords[bi + 1]);
          if (!best || d < best.d) best = { d, p: pa };
        }
      }
      if (best && best.d > nearMin && best.d <= nearMax) {
        add('WARN', '通行线', 'W_PATH_NEAR_MISS',
          `${A.id} 与 ${B.id} 差 ${best.d.toFixed(2)}m 没接上（在 ${JSON.stringify(best.p.map((n) => Math.round(n * 10) / 10))} 附近）—— 看起来该连但实际断开`,
          { feature: A.id, hint: '放大到那个位置，把端点拖到线上（编辑器会吸附）；或者它们本来就该分开，那就忽略这条' });
      }
    }
  }

  return graph;
}

/* ====================================================== 4. 设施接入（新核心） */

function checkFacilityAccess(net) {
  const areaTol = TH.areaAttachTolerance ?? 1.0;
  const poiTol = TH.poiPathTolerance ?? 5.0;
  /** 还没画通行线的楼层 → 该层有几个设施。一层报一条，不逐设施报。 */
  const NO_PATH_LEVELS = new Map();

  for (const f of S.facilities) {
    const isArea = f.polygons.length > 0;
    const att = net.attachments.get(f.id);

    if (!att) {
      /*
       * ★ 分两级：这一层【根本没有通行线】= 还没画完，是警告；
       *   有通行线但接不上 = 真错，旅客搜到它却走不过去。
       *
       * ★ 但「那一层还没画通行线」是【一层一个事实】，不是【一个设施一个事实】。
       *   原来每个设施各报一条 —— L5F/B2F 这种没画的楼层一报就是 136 条，
       *   把真正要看的东西全淹了。改成按层汇总，一层一条。
       */
      const hasPaths = S.paths.some((p) => p.props.level === f.props.level);
      if (hasPaths) {
        add('ERROR', '设施接入', 'E_FACILITY_UNSERVED',
          `${f.id}（${f.props.name ?? f.props.category}）走不到 —— ${f.props.level} 上一条通行线都没有`,
          { file: f.file, feature: f.id, hint: '这一层画通行线（编辑器按 L）' });
      } else {
        NO_PATH_LEVELS.set(f.props.level, (NO_PATH_LEVELS.get(f.props.level) ?? 0) + 1);
      }
      continue;
    }
    if (att.served) continue;

    const tol = isArea ? areaTol : poiTol;
    if (isArea) {
      add('ERROR', '设施接入', 'E_AREA_NOT_ON_PATH',
        `${f.id}（${f.props.name}）走不到 —— 最近的通行线 ${att.pathId} 离它的墙还有 ${att.dist.toFixed(2)}m（容差 ${tol}m）`,
        {
          file: f.file, feature: f.id,
          hint: '面状设施的可通行性取决于「有没有通行线吸附到它的边缘上」。把那条支线的端点拖到这个房间的墙上（编辑器会吸附到房间边界）',
        });
    } else {
      add('ERROR', '设施接入', 'E_POI_NOT_ON_PATH',
        `${f.id}（${f.props.name}）走不到 —— 最近的通行线 ${att.pathId} 离它 ${att.dist.toFixed(2)}m（容差 ${tol}m）`,
        {
          file: f.file, feature: f.id,
          hint: '点状设施的可通行性取决于「有没有通行线经过它」。编辑器里选中它 →「一键生成支线」即可',
        });
    }
  }

  // 设施声明的 zone 和它所在区域的 zone 不一致
  for (const f of S.facilities) {
    const pt = f.point ?? (f.polygons.length ? G.polygonCentroid(f.polygons[0]) : null);
    if (!pt || !f.props.zone) continue;
    const r = regionAt(pt, f.props.level, 2.0);
    if (r && r.props.zone !== f.props.zone) {
      add('WARN', '设施接入', 'W_FACILITY_ZONE_MISMATCH',
        `${f.id} 声明 zone=${f.props.zone}，但它落在区域 ${r.id}（zone=${r.props.zone}）上`,
        { file: f.file, feature: f.id });
    }
  }

  /*
   * 「这一层还没画通行线」—— 【一层一条】，不逐设施报。
   * 136 个设施落在没画线的楼层上，报 136 条和报 3 条说的是同一件事。
   */
  for (const [lv, n] of NO_PATH_LEVELS) {
    add('WARN', '设施接入', 'W_FACILITY_NO_PATH',
      `${lv} 还没画通行线 —— 那一层的 ${n} 个设施现在都走不到（铺完线会自动接上）`,
      { hint: `切到 ${lv}，按 L 画通行线` });
  }

  return net.stats;
}

/* ============================================ 4.5 搜索索引字段 */

/**
 * 设施的「搜索索引标签」。
 *
 * 字段定义写在 manifest.facilityCategories[类别].fields 上，对该类别【所有】设施生效。
 * 放在类别上而不是单个设施上，是因为值机柜台的「字母编号 / 航空公司 / 航司代码」
 * 对每一个柜台都必须有 —— 放类别上，新增柜台时自动出现；放单设施上，一定会有人漏填。
 *
 * 这里检查「必填有没有填、格式对不对、有没有类别里没定义的野字段」。
 */
function checkFacilityFields() {
  const index = buildSearchIndex(manifest, S.facilities.map((f) => f.feature));

  for (const f of S.facilities) {
    const defs = categoryFields(manifest, f.props.category);
    const values = f.props.fields ?? {};
    const rec = index.byId.get(f.id);

    // ① 必填
    for (const key of rec?.missingRequired ?? []) {
      const d = defs.find((x) => x.key === key);
      add('ERROR', '搜索索引', 'E_FIELD_REQUIRED',
        `${f.id}（${f.props.name ?? f.props.category}）缺少必填索引字段「${d?.label ?? key}」`
        + `　—— 「${manifest.facilityCategories[f.props.category]?.name ?? f.props.category}」这一类设施都要求填它`,
        { file: f.file, feature: f.id, hint: d?.hint ?? '在属性面板的「搜索索引」里填上' });
    }

    // ② 格式
    for (const d of defs) {
      const v = values[d.key];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      if (d.pattern && !new RegExp(d.pattern).test(String(v))) {
        add('ERROR', '搜索索引', 'E_FIELD_PATTERN',
          `${f.id} 的「${d.label}」= 「${v}」不符合格式要求 ${d.pattern}`,
          { file: f.file, feature: f.id, hint: d.hint });
      }
      if (d.type === 'number' && !Number.isFinite(Number(v))) {
        add('ERROR', '搜索索引', 'E_FIELD_NUMBER', `${f.id} 的「${d.label}」应该是数字，实际「${v}」`, { file: f.file, feature: f.id });
      }
      if (d.type === 'airline') {
        const codes = Object.keys(manifest.airlines ?? {}).filter((k) => !k.startsWith('_'));
        const known = codes.some((c) => String(v).includes(manifest.airlines[c].name) || String(v).toUpperCase().includes(c));
        if (!known) {
          add('WARN', '搜索索引', 'W_AIRLINE_UNKNOWN',
            `${f.id} 的「${d.label}」= 「${v}」不在 manifest.airlines 表里 —— 如果是小航司/包机可以忽略`,
            { file: f.file, feature: f.id });
        }
      }
    }

    // ③ 类别里没定义的临时字段：允许，但提示可以提升成类别级
    const declared = new Set(defs.map((d) => d.key));
    for (const k of Object.keys(values)) {
      if (declared.has(k)) continue;
      if (values[k] === undefined || values[k] === null || String(values[k]).trim() === '') continue;
      add('INFO', '搜索索引', 'I_FIELD_UNDECLARED',
        `${f.id} 有临时索引字段「${k}」= 「${values[k]}」，但类别「${f.props.category}」没有定义它`,
        { file: f.file, feature: f.id, hint: '如果这一类设施都该有，在编辑器里点「所有…都用」把它提升成类别级' });
    }
  }

  // ④ 字段定义本身要自洽
  for (const [cat, v] of Object.entries(manifest.facilityCategories ?? {})) {
    if (cat.startsWith('_') || !v?.fields) continue;
    const seen = new Set();
    for (const d of v.fields) {
      if (!d.key || !d.label) {
        add('ERROR', '搜索索引', 'E_FIELD_DEF', `manifest 里类别「${cat}」有个字段定义缺 key 或 label`, { file: 'data/source/manifest.json' });
        continue;
      }
      if (seen.has(d.key)) {
        add('ERROR', '搜索索引', 'E_FIELD_DEF_DUP', `类别「${cat}」的字段 key「${d.key}」定义了两次`, { file: 'data/source/manifest.json' });
      }
      seen.add(d.key);
      if (d.pattern) {
        try { new RegExp(d.pattern); } catch {
          add('ERROR', '搜索索引', 'E_FIELD_DEF_BAD_PATTERN', `类别「${cat}」字段「${d.key}」的正则非法：${d.pattern}`, { file: 'data/source/manifest.json' });
        }
      }
    }
  }

  return index;
}

/* ==================================== 3.5 路网断口（最有用的一条） */

/**
 * 把「路网分成 N 块」变成「在这里补一条线就连上了」。
 *
 * ★ 为什么需要这条：
 *   「已接入路网」和「能走到别处」是两件不同的事。
 *   一条支线碰到设施 = 接入了；但这条支线如果和主网差 2 米没接上，
 *   设施照样走不到 —— 而界面上两个地方都显示「已接入」。
 *   实测数据里 31 个设施接上了，只有 10 个能走到主网，剩下的困在 21 个小块里。
 *   光说「不连通」没法修，得说清【在哪里、差多少米】。
 */
function checkNetworkGaps(net) {
  const compNodes = new Map();
  for (const n of net.graph.nodes) {
    const c = net.nodeComp.get(n.id);
    if (!compNodes.has(c)) compNodes.set(c, []);
    compNodes.get(c).push(n);
  }
  const comps = [...compNodes].sort((a, b) => b[1].length - a[1].length);
  if (comps.length <= 1) return;

  // 每块只留「边界节点」，块一大就全比会 O(n²)；抽稀到最多 60 个代表点
  const reps = comps.map(([c, nodes]) => {
    const step = Math.max(1, Math.floor(nodes.length / 60));
    return { c, nodes: nodes.filter((_, i) => i % step === 0), size: nodes.length };
  });

  const gaps = [];
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      if (reps[i].c === reps[j].c) continue;
      let best = Infinity, bp = null;
      for (const a of reps[i].nodes) {
        for (const b of reps[j].nodes) {
          if (a.level !== b.level) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < best) { best = d; bp = [a, b]; }
        }
      }
      if (bp) gaps.push({ i: reps[i], j: reps[j], d: best, bp });
    }
  }
  gaps.sort((a, b) => a.d - b.d);

  // ★ 只报「差一点点」的：超过 60 米那是两片本来就该分开画的区域，不是断口
  const NEAR = 60;
  const near = gaps.filter((g) => g.d <= NEAR);
  const far = gaps.length - near.length;

  for (const g of near) {
    const a = g.bp[0], b = g.bp[1];
    add('WARN', '路网连通', 'W_NETWORK_GAP',
      `两块路网相距 ${g.d.toFixed(1)}m 没接上 —— 在这里补一条线，${g.i.size} 个节点和 ${g.j.size} 个节点就通了`
      + `\n      位置约 [${((a.x + b.x) / 2).toFixed(1)}, ${((a.y + b.y) / 2).toFixed(1)}]（${a.level}）`
      + `\n      最近的两点：[${a.x.toFixed(1)}, ${a.y.toFixed(1)}] ↔ [${b.x.toFixed(1)}, ${b.y.toFixed(1)}]`,
      { file: 'data/source/paths.geojson', level: a.level, at: [(a.x + b.x) / 2, (a.y + b.y) / 2] });
  }

  add('WARN', '路网连通', 'W_NETWORK_FRAGMENTED',
    `通行线网络分成 ${comps.length} 块：最大的一块 ${comps[0][1].length} 个节点，`
    + `另有 ${near.length} 处「差一点就能连上」的断口${far ? `，还有 ${far} 处离得较远` : ''}`
    + '\n      ★ 设施「接上了通行线」不等于「能走到别处」—— 支线本身也要连进主网',
    { file: 'data/source/paths.geojson' });
}

/* ============================================== 5. 跨层设施（垂直交通） */

/**
 * 跨层设施 = 电梯/扶梯/楼梯/坡道。它们是【点状设施】，不是边。
 *
 * 模型：同一部电梯在每个连通的楼层上各有一个点状设施，坐标【完全相同】，
 *       共享一个 verticalGroup。它们在寻路上相通，
 *       而且是整个模型里唯一「跨楼层同一个位置」的地方 —— 3D 里路径在这里垂直穿楼板。
 *
 * 所以最要紧的一条检查就是：【各层成员坐标必须一致】。
 * 差一点点，3D 里的垂直路径就是斜的，而且很难看出是数据问题。
 */
function checkVertical(net) {
  const tol = TH.verticalGroupTolerance ?? 0.05;
  /** 还没画通行线的楼层 → 该层有几个跨层成员。一层报一条。 */
  const VG_NO_PATH = new Map();
  const VERT = new Set(Object.entries(manifest.facilityCategories ?? {})
    .filter(([k, v]) => !k.startsWith('_') && v?.vertical).map(([k]) => k));

  // 单成员检查：用错类别的、声明了跨层却没组的
  for (const f of S.facilities) {
    const isVertCat = VERT.has(f.props.category);
    const hasGroup = !!f.props.verticalGroup;
    if (isVertCat && !hasGroup) {
      add('ERROR', '跨层设施', 'E_VERTICAL_NO_GROUP',
        `${f.id}（${f.props.name ?? f.props.category}）是跨层设施类别，却没有 verticalGroup —— 它在图上接不到别的楼层`,
        { file: f.file, feature: f.id, hint: '用编辑器重新放一个（会弹出选楼层的对话框，自动在各层建好成员）' });
    }
    if (!isVertCat && hasGroup) {
      add('ERROR', '跨层设施', 'E_VERTICAL_WRONG_CATEGORY',
        `${f.id} 有 verticalGroup，但它的类别「${f.props.category}」不是跨层设施`,
        { file: f.file, feature: f.id, hint: `跨层类别：${[...VERT].join(', ')}` });
    }
    // ★ 用 f.point（parseGeometry 解析出来的），不是 f.geometry ——
    //   S.facilities 里装的是「条目」，几何在 f.feature.geometry 上。
    if (hasGroup && !f.point) {
      add('ERROR', '跨层设施', 'E_VERTICAL_NOT_POINT',
        `${f.id} 带 verticalGroup 但几何不是 Point —— 跨层设施必须是点（它标记的是一个位置，不是一片区域）`,
        { file: f.file, feature: f.id });
    }
  }

  for (const issue of net.verticalIssues ?? []) {
    const g = net.verticalGroups?.get(issue.id) ?? [];
    const ids = g.map((m) => m.id).join(', ');
    if (issue.reason === 'POSITION_MISMATCH') {
      add('ERROR', '跨层设施', 'E_VGROUP_POSITION',
        `verticalGroup ${issue.id} 的成员坐标不一致：${issue.level} 上的点偏了 ${issue.dist.toFixed(3)}m（容差 ${tol}m）`
        + `\n      参考点 ${JSON.stringify(issue.ref)}，实际 ${JSON.stringify(issue.point)}`,
        {
          feature: g[0]?.id,
          hint: '★ 这是整个模型里唯一「跨楼层同一个位置」的地方。坐标对不上，3D 里的垂直路径就是斜的，'
            + '而且从平面图上看不出来。用编辑器的「复制到其他楼层」或在 3D 预览里检查。',
        });
    } else if (issue.reason === 'CATEGORY_MISMATCH') {
      add('ERROR', '跨层设施', 'E_VGROUP_CATEGORY',
        `verticalGroup ${issue.id} 的成员类别不一致：${issue.cats.join(' / ')} —— 同一部电梯不可能换了楼层就变成扶梯`,
        { feature: g[0]?.id });
    } else if (issue.reason === 'DUPLICATE_LEVEL') {
      add('ERROR', '跨层设施', 'E_VGROUP_DUP_LEVEL',
        `verticalGroup ${issue.id} 在同一层上有多个成员：${issue.levels.join(', ')}`,
        { feature: g[0]?.id, hint: '一层只需要一个点。多的那个删掉' });
    } else if (issue.reason === 'MISSING_MEMBER') {
      add('ERROR', '跨层设施', 'E_VGROUP_MISSING',
        `verticalGroup ${issue.id} 声明连通 ${issue.missing.length} 个楼层，但这些楼层上没有成员：${issue.missing.join(', ')}`
        + `　（成员在：${g.map((m) => m.level).join(', ')}）`,
        { feature: g[0]?.id, hint: '补上这些楼层的成员，或者把它从 verticalLevels 里去掉' });
    } else if (issue.reason === 'UNDECLARED_MEMBER') {
      add('WARN', '跨层设施', 'W_VGROUP_UNDECLARED',
        `verticalGroup ${issue.id} 在 ${issue.extra.join(', ')} 上有成员，但 verticalLevels 里没声明`,
        { feature: g[0]?.id, hint: '把这几层补进 verticalLevels，或者删掉那几个成员' });
    }
  }

  // 只有一个成员的组 = 没真正跨层
  for (const [gid, members] of net.verticalGroups ?? []) {
    if (members.length < 2) {
      add('WARN', '跨层设施', 'W_VGROUP_SINGLE',
        `verticalGroup ${gid}（${members[0]?.props?.name ?? ''}）只有一个成员，在 ${members[0]?.level} —— 它还没连到任何别的楼层`,
        { feature: members[0]?.id, hint: '补上其他楼层的成员，否则它在图上就是个普通点状设施' });
    }
    // 每个成员都得接上本层路网 —— 否则「能坐电梯」在图上根本不存在
    for (const m of members) {
      const att = net.attachments?.get(m.id);
      if (att?.served) continue;
      const hasPaths = S.paths.some((p) => p.props.level === m.level);
      if (hasPaths) {
        add('ERROR', '跨层设施', 'E_VGROUP_MEMBER_UNSERVED',
          `verticalGroup ${gid} 在 ${m.level} 上的成员（${m.id}）接不上本层路网 —— 电梯口没有通行线经过，图上就没法从这一层进电梯`,
          { feature: m.id, hint: '在电梯口拉一条支线（选中该设施 →「一键生成支线」）' });
      } else {
        // ★ 同样按层汇总：没画线的楼层报一条就够，不逐成员报
        VG_NO_PATH.set(m.level, (VG_NO_PATH.get(m.level) ?? 0) + 1);
      }
    }
  }

  // 「那一层还没画通行线」—— 一层一条，不逐成员报
  for (const [lv, n] of VG_NO_PATH) {
    add('WARN', '跨层设施', 'W_VGROUP_MEMBER_NO_PATH',
      `${lv} 还没画通行线 —— 那一层有 ${n} 个跨层设施成员接不上（铺完线会自动接上）`,
      { hint: `切到 ${lv}，按 L 画通行线，或者在电梯口「一键生成支线」` });
  }

  return net.stats;
}

/* ============================================================ 6. 连接件 */

function checkConnectors(net) {
  for (const issue of net.connIssues) {
    const c = byId.connector.get(issue.id);
    const side = issue.side ? ` 的 ${issue.side} 端点` : '';
    if (issue.reason === 'NOT_ON_PATH') {
      add('ERROR', '连接件', 'E_CONN_NOT_ON_PATH',
        `${issue.id}${side} ${JSON.stringify(issue.point)} 距离最近的通行线 ${Number.isFinite(issue.dist) ? `${issue.dist.toFixed(2)}m` : '∞'}，超过容差 ${TH.connectorOnPathTolerance ?? 0.5}m —— 图会在这里断开，路径走不过去`,
        { file: c?.file, feature: issue.id, hint: '把端点拖到通行线上（编辑器会吸附），或者在那个位置画一段通行线' });
    } else if (issue.reason === 'NO_PATH_ON_LEVEL') {
      add('WARN', '连接件', 'W_CONN_DANGLING_LEVEL',
        `${issue.id}${side} 在 ${issue.level}，但那一层还没画通行线 —— 铺完那层后会连上`,
        { file: c?.file, feature: issue.id });
    } else if (issue.reason === 'BAD_ENDPOINT') {
      add('ERROR', '连接件', 'E_BAD_ENDPOINT', `${issue.id}${side} 的坐标不是合法数字`, { file: c?.file, feature: issue.id });
    } else if (issue.reason === 'INCOMPLETE') {
      add('ERROR', '连接件', 'E_CONN_INCOMPLETE', `${issue.id} 两端没能都接到路网上`, { file: c?.file, feature: issue.id });
    }
  }

  for (const c of S.connectors) {
    const t = CONN_TYPES.includes(c.props.type) ? manifest.connectorTypes[c.props.type] : null;
    if (t && t.oneWay && c.props.bidirectional === true) {
      add('WARN', '连接件', 'W_ONEWAY_CONFLICT', `${c.id} 的类型「${t.name}」是单向的，却标了 bidirectional: true`, { file: c.file, feature: c.id });
    }
  }
}

/* ============================================================ 6. 地理配准 */

function checkAnchors() {
  if (!S.anchors) {
    add('WARN', '地理配准', 'W_NO_ANCHORS', '没有 anchors.json —— 无法把本地坐标贴到真实经纬度，将来接室外地图/摆渡车会卡住');
    return null;
  }
  const cp = S.anchors.controlPoints ?? [];
  const minN = TH.anchorCountMin ?? 3;
  if (cp.length < minN) {
    add('ERROR', '地理配准', 'E_ANCHOR_TOO_FEW', `只有 ${cp.length} 个控制点，至少需要 ${minN} 个才能拟合相似变换`, { file: 'data/source/anchors.json' });
    return null;
  }
  const origin = S.anchors.origin ?? PROJECTION.origin;
  const mpd = PROJECTION.metersPerDegree;
  if (!origin || !mpd) {
    add('ERROR', '地理配准', 'E_NO_PROJECTION', 'anchors 或 manifest.projection 缺少 origin / metersPerDegree', { file: 'data/source/manifest.json' });
    return null;
  }

  const pts = [];
  const bad = [];
  cp.forEach((c, i) => {
    const wx = c.wgs84?.[0], wy = c.wgs84?.[1];
    if (!G.isFinitePoint(c.local) || !Number.isFinite(wx) || !Number.isFinite(wy)) {
      add('ERROR', '地理配准', 'E_BAD_ANCHOR', `控制点 ${c.id ?? i} 的 local 或 wgs84 格式不对`, { file: 'data/source/anchors.json', feature: c.id });
      return;
    }
    if (Math.abs(wy) > 90 || Math.abs(wx) > 180) bad.push(c.id ?? i);
    pts.push({ p: c.local, q: G.wgs84ToLocalMeters(wx, wy, origin, mpd), id: c.id ?? String(i) });
  });
  if (bad.length) {
    add('ERROR', '地理配准', 'E_LONLAT_ORDER',
      `控制点 ${bad.join(', ')} 的 wgs84 看起来是 [lat, lon] 而不是 [lon, lat] —— GeoJSON 标准是经度在前。北京经度约 116、纬度约 39，很容易写反`,
      { file: 'data/source/anchors.json' });
  }
  if (pts.length < minN) return null;

  let fit;
  try {
    fit = G.fitSimilarity(pts);
  } catch (err) {
    add('ERROR', '地理配准', 'E_FIT_FAILED', `相似变换拟合失败：${err.message}`, { file: 'data/source/anchors.json' });
    return null;
  }

  const [sMin, sMax] = TH.anchorScaleRange ?? [0.9, 1.1];
  if (fit.scale < sMin || fit.scale > sMax) {
    add('ERROR', '地理配准', 'E_ANCHOR_SCALE',
      `拟合出的缩放因子是 ${fit.scale.toFixed(4)}，超出允许范围 [${sMin}, ${sMax}] —— 说明画图用的米制比例和地理配准不一致`,
      { file: 'data/source/anchors.json' });
  }
  const maxRes = TH.anchorResidualMax ?? 2.0;
  if (fit.maxResidual > maxRes) {
    add('ERROR', '地理配准', 'E_ANCHOR_RESIDUAL',
      `控制点最大残差 ${fit.maxResidual.toFixed(2)}m，超过阈值 ${maxRes}m —— 控制点定错了，或者各层没有用同一个坐标系`,
      { file: 'data/source/anchors.json' });
  }
  const unverified = cp.filter((c) => c.verified !== true).length;
  if (unverified) {
    add('INFO', '地理配准', 'I_ANCHOR_UNVERIFIED', `${unverified}/${cp.length} 个控制点标记为未核实`, { file: 'data/source/anchors.json' });
  }
  return fit;
}

/* ============================================================ 7. 覆盖与质量 */

function checkCoverage() {
  const drawn = new Set(DRAWN_LEVELS);
  const undrawn = LEVELS.filter((l) => !drawn.has(l));

  for (const sid of SCENARIOS) {
    const sc = manifest.scenarios[sid];
    const missing = [];
    for (const step of sc.steps ?? []) {
      const cat = step.category;
      const has = S.facilities.some((f) => f.props.category === cat)
        || S.connectors.some((c) => (c.props.type ?? c.props.connectorType) === cat);
      if (!has) missing.push(`${step.id}(${cat})`);
    }
    if (missing.length) {
      add('WARN', '覆盖与质量', 'W_SCENARIO_GAP',
        `场景「${sc.name}」有 ${missing.length} 个步骤在已绘制楼层中找不到对应数据：${missing.join('、')}`,
        { hint: `已绘制楼层：${DRAWN_LEVELS.join(', ') || '（无）'}${undrawn.length ? `；未绘制：${undrawn.join(', ')}` : ''}` });
    }
  }

  /*
   * ★ 不再检查英文名。
   *
   *   这条的前提是「双语站点，每个命名要素都要有英文名」——
   *   但这是【楼内步行导航】，指示牌、广播、旅客问的都是中文
   *   （国内航站楼尤其如此）。为了一个不存在的英文界面，
   *   让 101 个要素各报一条警告，是拿旧需求量新数据。
   *
   *   真要做中英双语时，应该反过来：先有双语界面，
   *   再按界面实际用到的那批要素去检查。
   */
  void 0;

  const byLevelName = new Map();
  for (const f of S.facilities) {
    const k = `${f.props.level}::${f.props.name}`;
    if (!byLevelName.has(k)) byLevelName.set(k, []);
    byLevelName.get(k).push(f.id);
  }
  for (const [k, ids] of byLevelName) {
    if (ids.length > 1) add('WARN', '覆盖与质量', 'W_DUP_NAME', `同一层有 ${ids.length} 个「${k.split('::')[1]}」：${ids.join(', ')} —— 搜索时用户无法区分`, { feature: ids[0] });
  }

  const dd = TH.duplicateFacilityDistance ?? 1.0;
  for (let i = 0; i < pointFacilities.length; i++) {
    for (let j = i + 1; j < pointFacilities.length; j++) {
      const a = pointFacilities[i], b = pointFacilities[j];
      if (a.props.level !== b.props.level || a.props.category !== b.props.category) continue;
      const d = G.dist(a.point, b.point);
      if (d < dd) add('WARN', '覆盖与质量', 'W_DUP_FACILITY', `${a.id} 与 ${b.id}（同类 ${a.props.category}）相距仅 ${d.toFixed(2)}m —— 可能是重复录入`, { feature: a.id });
    }
  }
}

/* ================================================================ 执行 */

checkIds();
checkEnums();
checkGeometry();

const net = buildNetwork({
  regions: normalizeFeatures({ features: S.regions.map((r) => r.feature) }),
  paths: normalizeFeatures({ features: S.paths.map((p) => p.feature) }),
  facilities: normalizeFeatures({ features: S.facilities.map((f) => f.feature) }),
  connectors: normalizeFeatures({ features: S.connectors.map((c) => c.feature) }),
}, {
  tolerance: TH.polygonTouchTolerance ?? 0.05,
  areaAttachTolerance: TH.areaAttachTolerance ?? 1.0,
  poiPathTolerance: TH.poiPathTolerance ?? 5.0,
  connectorTolerance: TH.connectorOnPathTolerance ?? 0.5,
  verticalGroupTolerance: TH.verticalGroupTolerance ?? 0.05,
  verticalSpecs: Object.fromEntries(Object.entries(manifest.facilityCategories ?? {})
    .filter(([k, v]) => !k.startsWith('_') && v?.vertical)
    .map(([k, v]) => [k, v.vertical])),
});
setLevelOrder(manifest.levels);

checkPaths(net);
checkFacilityAccess(net);
checkNetworkGaps(net);
const searchIdx = checkFacilityFields();
checkVertical(net);
checkConnectors(net);
const fit = checkAnchors();
checkCoverage();

/* ================================================================ 报告 */

const ERROR = issues.filter((i) => i.severity === 'ERROR');
const WARN = issues.filter((i) => i.severity === 'WARN');
const INFO = issues.filter((i) => i.severity === 'INFO');

const stats = {
  regions: S.regions.length,
  paths: S.paths.length,
  graph: net.graph.stats,
  facilities: S.facilities.length,
  facilitiesArea: areaFacilities.length,
  facilitiesPoint: pointFacilities.length,
  served: net.stats.served,
  unserved: net.stats.unserved,
  obstacles: S.obstacles.length,
  connectors: S.connectors.length,
  connectorLinks: net.links.length,
  components: net.components.length,
};

if (OPT.json) {
  const payload = JSON.stringify({
    dataVersion: manifest.dataVersion,
    drawnLevels: DRAWN_LEVELS,
    stats,
    attachments: [...net.attachments].map(([id, a]) => ({
      id, kind: a.kind, served: a.served, dist: a.dist, tolerance: a.tolerance,
      pathId: a.pathId, routingPoint: a.routingPoint,
    })),
    anchorage: fit ? { scale: fit.scale, rotationDeg: fit.rotationDeg, maxResidual: fit.maxResidual, rmsResidual: fit.rmsResidual } : null,
    counts: { ERROR: ERROR.length, WARN: WARN.length, INFO: INFO.length },
    issues,
  }, null, 2);
  if (OPT.out) {
    fs.writeFileSync(OPT.out, payload);
    if (!OPT.quiet) console.log(`校验结果已写入 ${OPT.out}　ERROR ${ERROR.length}　WARN ${WARN.length}`);
  } else {
    console.log(payload);
  }
  process.exit(ERROR.length || (OPT.strict && WARN.length) ? 1 : 0);
}

const line = '─'.repeat(66);
if (!OPT.quiet) {
  console.log('');
  console.log(C.bold('  BDIA 3D Navigator · 源数据校验'));
  console.log(C.dim(`  数据版本 ${manifest.dataVersion ?? '(未设置)'}　·　${new Date().toISOString().slice(0, 10)}`));
  console.log(line);

  console.log(C.bold('\n概要'));
  const all = [...S.regions, ...S.facilities, ...S.obstacles, ...S.connectors, ...S.paths];
  const unverified = all.filter((e) => e.props.verified !== true).length;
  const g = net.graph.stats;
  const rows = [
    ['已绘制楼层', DRAWN_LEVELS.join(', ') || '（无）'],
    ['未绘制楼层', LEVELS.filter((l) => !DRAWN_LEVELS.includes(l)).join(', ') || '（无）'],
    ['区域', `${S.regions.length}（只是隔离区标记，不参与寻路）`],
    ['通行线', `${S.paths.length} 条 · 图 ${g.nodes} 节点 / ${g.edges} 边 / ${g.junctions} 个路口`],
    ['　└ 自动路口', `${g.autoJunctions} 个（两条线交叉生成，不用手工打断）`],
    ['路网总长', `${(g.totalLength / 1000).toFixed(2)} km`],
    ['设施', `${S.facilities.length}（面状 ${areaFacilities.length} · 点状 ${pointFacilities.length}）`],
    /*
     * ★ 「接上了通行线」和「能走到别处」必须分开报。
     *   一条支线碰到设施 = 接入了；但这条支线如果和主网差 2 米没接上，
     *   设施照样走不到 —— 而界面上两个地方都显示「已接入」，
     *   用起来就是「明明说接上了，怎么还是走不过去」。
     */
    (() => {
      // 每块图有多大
      const size = new Map();
      for (const n of net.graph.nodes) {
        const c = net.nodeComp.get(n.id);
        size.set(c, (size.get(c) ?? 0) + 1);
      }
      const mainSize = Math.max(0, ...size.values());

      // 设施 → 图节点（和 route.mjs 的 nodeForFacility 同一套规则）
      const nodeOf = (id) => {
        const att = net.attachments.get(id);
        if (!att?.served) return null;
        let best = null;
        for (const n of net.graph.nodes) {
          if (att.level && n.level !== att.level) continue;
          const d = Math.hypot(n.x - att.routingPoint[0], n.y - att.routingPoint[1]);
          if (d <= 0.6 && (!best || d < best.d)) best = { d, n };
        }
        return best?.n ?? null;
      };

      let reach = 0;
      let servedCount = 0;
      for (const [id, a] of net.attachments) {
        if (!a.served) continue;
        servedCount++;
        const n = nodeOf(id);
        if (n && size.get(net.nodeComp.get(n.id)) === mainSize) reach++;
      }

      return ['　└ 能走到主网', `${reach} / ${servedCount} 个设施和主网连通`
        + (servedCount - reach
          ? `　✗ ${servedCount - reach} 个「接上了线但困在小块里」—— 这是两回事，见下面的 W_NETWORK_GAP`
          : '　✓ 全部连通')];
    })(),
    ['障碍物', String(S.obstacles.length)],
    ['搜索索引', (() => {
      const st = searchIdx?.stats ?? {};
      const withFields = Object.entries(manifest.facilityCategories ?? {}).filter(([k, v]) => !k.startsWith('_') && v?.fields);
      return `${st.terms ?? 0} 个检索词 · ${st.withFields ?? 0}/${st.total ?? 0} 个设施带索引字段`
        + `${st.missingRequired ? `　✗ ${st.missingRequired} 个缺必填` : '　✓ 必填齐全'}`
        + `　（${withFields.length} 个类别定义了字段：${withFields.map(([k, v]) => `${k}·${v.fields.length}`).join(' ')}）`;
    })()],
    ['连接件', `${S.connectors.length}（接通 ${net.links.filter((l) => l.kind !== 'vertical').length} 条图边）`],
    ['跨层设施', (() => {
      const g = net.verticalGroups ?? new Map();
      if (!g.size) return '（无）';
      const served = [...g.values()].flat().filter((m) => net.attachments?.get(m.id)?.served).length;
      return `${g.size} 组 / ${[...g.values()].flat().length} 个点（接通 ${net.links.filter((l) => l.kind === 'vertical').length} 条跨层边，${served} 个点已接上本层路网）`;
    })()],
    ['连通分量', `${net.components.length}`],
    ['未核实要素', `${unverified} / ${all.length}${unverified ? '  ⚠ 需对照官方平面图核实' : ''}`],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(12, '　')} ${v}`);

  // 设施接入明细 —— 这是新版最该一眼看清的东西
  if (net.attachments.size) {
    console.log(C.bold('\n设施接入'));
    for (const [id, a] of net.attachments) {
      const mark = a.served ? C.green('✓') : C.red('✗');
      const f = byId.facility.get(id);
      const nm = f?.props.name ?? id;
      /*
       * ★ routingPoint 可能是坏的（有 null / NaN 分量）。
       *   早先这里直接 a.dist.toFixed(2)，遇到坏数据就抛 TypeError ——
       *   【整个校验器中断】，后面的检查一条都跑不了。
       *   校验器遇到坏数据应该把它报出来，而不是自己倒下。
       */
      const rp = Array.isArray(a.routingPoint) ? a.routingPoint : null;
      const rpBad = !rp || rp.some((n) => !Number.isFinite(n));
      const rpTxt = rpBad ? C.red('（寻路点无效：含 null / NaN）') : `(${rp.map((n) => n.toFixed(1)).join(', ')})`;
      const dTxt = Number.isFinite(a.dist) ? `${a.dist.toFixed(2)}m` : C.red(`${a.dist}`);
      console.log(`  ${mark} ${nm.padEnd(14, '　')} ${a.kind === 'area' ? '面状' : '点状'}　`
        + `${dTxt} / 容差 ${a.tolerance}m　→ 寻路点 ${rpTxt}`
        + C.dim(`  via ${a.pathId}`));
    }
    for (const id of net.unserved) {
      if (net.attachments.has(id)) continue;
      console.log(`  ${C.red('✗')} ${(byId.facility.get(id)?.props.name ?? id).padEnd(14, '　')} 没有任何通行线`);
    }
  }

  if (fit) {
    console.log(C.bold('\n地理配准'));
    console.log(`  缩放因子      ${fit.scale.toFixed(5)}  ${Math.abs(fit.scale - 1) < 0.005 ? C.green('✓ 接近 1') : C.yellow('⚠ 偏离 1')}`);
    console.log(`  旋转角        ${fit.rotationDeg.toFixed(3)}°  ${Math.abs(fit.rotationDeg) < 1 ? C.green('✓ 与正北对齐') : C.yellow('⚠ 平面图未与正北对齐')}`);
    console.log(`  最大残差      ${fit.maxResidual.toFixed(3)} m`);
    console.log(`  RMS 残差      ${fit.rmsResidual.toFixed(3)} m`);
  }
}

function printGroup(sev, list, title) {
  if (!list.length) return;
  const byCode = new Map();
  for (const i of list) {
    if (!byCode.has(i.code)) byCode.set(i.code, []);
    byCode.get(i.code).push(i);
  }
  const color = sev === 'ERROR' ? C.red : sev === 'WARN' ? C.yellow : C.blue;
  console.log('');
  console.log(color(C.bold(`${title}（${list.length}）`)));
  for (const [code, items] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
    console.log(color(`  ${code}  ×${items.length}`));
    const show = OPT.quiet ? items.length : Math.min(items.length, 6);
    for (let k = 0; k < show; k++) {
      const it = items[k];
      console.log(`    · ${it.message}`);
      if (!OPT.quiet && it.hint) console.log(C.dim(`      ↳ ${it.hint}`));
    }
    if (items.length > show) console.log(C.dim(`    … 另有 ${items.length - show} 条同类问题`));
  }
}

printGroup('ERROR', ERROR, '✗ ERROR — 必须修复');
printGroup('WARN', WARN, '⚠  WARN — 建议修复');
if (!OPT.quiet) printGroup('INFO', INFO, 'ℹ  INFO — 提示');

console.log('');
console.log(line);
const ok = ERROR.length === 0 && (!OPT.strict || WARN.length === 0);
console.log(
  ok
    ? C.green(C.bold(`  ✓ 校验通过　ERROR ${ERROR.length}　WARN ${WARN.length}　INFO ${INFO.length}`))
    : C.red(C.bold(`  ✗ 校验未通过　ERROR ${ERROR.length}　WARN ${WARN.length}　INFO ${INFO.length}`)),
);
console.log('');
process.exit(ok ? 0 : 1);
