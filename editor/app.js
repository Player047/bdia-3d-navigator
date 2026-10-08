/**
 * BDIA 数据编辑器 —— 交互与界面。
 *
 * 设计原则：把领域规则焊进操作里，而不是靠人记住。
 *   · 房间画完自动算门（共享边中点）—— 「门必须在走廊边界上」自动成立
 *   · 连接件端点实时判定是否落在通行线上 —— 落不进去当场标红
 *   · 跨层的扶梯默认写成单向 —— 「扶梯是单向的」不用记
 *   · 保存后立刻可跑校验器 —— 错误在下一步之前就暴露
 */

import * as G from '../tools/lib/geo.mjs';
import { buildGraph, buildNetwork, crossingsWith } from '../tools/lib/graph.mjs';
import { createEditor, scaleBaseMapAbout, rotateBaseMapAbout } from './lib/state.mjs';
import {
  createView, screenFromLocal, localFromScreen, fitTo, zoomAt, draw,
  featureLevel, featureMatchesLevel, baseMapHandles, pointInScreenPoly, legendSpec,
} from './lib/render.mjs';

/* ============================================================ 基础设施 */

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
};

function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  $('toast').append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

let modalCleanup = null;
function modal(title, bodyNode, onMount) {
  const box = $('modalBox');
  box.replaceChildren(el('h2', {}, title), bodyNode);
  $('modal').classList.add('on');
  modalCleanup = onMount?.(box) ?? null;
}
function closeModal() { $('modal').classList.remove('on'); modalCleanup?.(); modalCleanup = null; }
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

const api = {
  loadAll: () => fetch('/api/data').then((r) => r.json()),
  listPlans: () => fetch('/api/plans').then((r) => r.json()),
  save: (files, force = false, stamp = null) => fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, force, stamp }),
  }).then((r) => r.json()),
  validate: () => fetch('/api/validate', { method: 'POST' }).then((r) => r.json()),
};

/* ============================================================ 状态 */

const ed = createEditor(api);
const view = createView();
const canvas = $('cv');
const ctx = canvas.getContext('2d');

const ia = {
  mode: 'select',
  draft: null,
  cursorLocal: null,
  cursorScreen: null,
  snap: null,
  handles: [],
  visibleLayers: { regions: true, paths: true, pathNodes: true, access: true, facilities: true, obstacles: true, connectors: true },
  ghostLevel: null,
  snapEnabled: true,
  gridSnap: false,
  regionKind: 'corridor',
  connType: 'elevator',
  drag: null,
  mapDrag: null,
  crossingPreview: null,
};

const MODES = [
  { id: 'select', key: 'V', label: '选择', hint: '点选要素；拖动白点改顶点；拖面内部整体移动。' },
  /*
   * ★ 「改形状」和「选择」分开，因为点击的含义冲突：
   *   选择模式下点边 = 选中整个要素；这个模式里点边 = 在边上插一个拐点。
   *   挤在一起的话，想加拐点就老是选中整个东西，想选东西就老插出多余的点。
   *
   *   顶点手柄本身两个模式都画（render.mjs 的 drawSelection 负责），
   *   所以拖拐点在哪个模式下都能用，这个模式额外提供「点边加点」和「Alt 拖复制」。
   */
  { id: 'reshape', key: 'M', label: '改形状', hint: '★ 点【边】＝在这条边上插一个拐点；拖【白点】＝挪拐点；拖【要素内部】＝整体平移；Alt+拖＝复制一份再拖。Delete 删除选中要素。' },
  { id: 'regions', key: 'R', label: '区域', hint: '区域【只是隔离区标记】，不参与寻路。寻路图是通行线。画得粗一点没关系，它只用来标记「这片属于哪个隔离区」。' },
  { id: 'paths', key: 'L', label: '通行线', hint: '★ 这是寻路图本身。画一条长线穿过另一条，交叉处会自动生成路口，不用手工打断。每条线必须落在同层同 zone 的区域面内，且不能跨隔离区。' },
  { id: 'facArea', key: 'F', label: '面状设施', hint: '店铺/休息室/卫生间：画在区域外侧、贴边。画完把通行线拖到它墙上，它才可达。' },
  { id: 'facPoint', key: 'P', label: '点状设施', hint: '登机口/饮水/充电：点击放置。类别在下方选。' },
  { id: 'connect', key: 'E', label: '连接件', hint: '★ 电梯/扶梯/楼梯/坡道是【跨层设施】：选好类型后点地图，会弹出选楼层的对话框，自动在每一层同一坐标建点。安检/边检这类跨隔离区的连接件则是点入口、再点出口。' },
  { id: 'obstacles', key: 'O', label: '障碍物', hint: '柱子/柜台/设备：画在区域内部，会被扣除。它们不是设施，不会被搜到。' },
  { id: 'basemap', key: 'G', label: '底图', hint: '拖框内 = 移动，拖角/边 = 缩放，拖圆点 = 旋转。框上方有实时数值。' },
];

/** 画面用的模式 → 要素存哪个图层。 */
function modeToLayer(mode) {
  if (mode === 'regions') return `${ed.currentLevel}/regions`;
  if (mode === 'facArea') return 'facilities';
  if (mode === 'obstacles') return 'obstacles';
  if (mode === 'paths') return 'paths';
  return null;
}

/**
 * 找光标附近的那条【边】。只在当前选中的要素上找。
 *
 * ★ 只在选中要素上找是刻意的：如果对所有要素都判边，
 *   画布上任何一条线附近点击都会插出一个拐点 —— 那是灾难。
 *   想改哪个形状，先选中它。
 *
 * @returns { fi, vi } —— 在第 fi 个环的第 vi 个顶点【之后】插入。
 *   LineString 的 fi 是 -1（它没有环的概念）。
 */
function hitEdge(sp, tol = 9) {
  const sel = ed.selected();
  if (!sel) return null;
  const g = sel.f.geometry;
  if (!g || g.type === 'Point') return null;

  const rings = g.type === 'Polygon' ? g.coordinates : [g.coordinates];
  let best = null;
  rings.forEach((ring, fi) => {
    for (let vi = 0; vi + 1 < ring.length; vi++) {
      const a = screenFromLocal(ring[vi], view);
      const b = screenFromLocal(ring[vi + 1], view);
      const d = G.pointToSegmentDistance(sp, a, b);
      if (d <= tol && (!best || d < best.d)) {
        best = { fi: g.type === 'Polygon' ? fi : -1, vi, d };
      }
    }
  });
  return best;
}

/** 在边上插入一个拐点。点在哪就插在哪，不死板地插在中点。 */
function insertVertexAt(edge, local) {
  const sel = ed.selected();
  if (!sel) return;
  const g = sel.f.geometry;
  const ring = g.type === 'Polygon' ? g.coordinates[edge.fi] : g.coordinates;
  ring.splice(edge.vi + 1, 0, [r2(local[0]), r2(local[1])]);

  /*
   * ★ 闭合环首尾必须同步。
   *   多边形在数据里首尾点重复，只改一头环就断了 ——
   *   渲染时看着没事，但"多边形必须闭合"的校验会炸。
   */
  if (g.type === 'Polygon') {
    const r = g.coordinates[edge.fi];
    if (r.length > 1 && G.dist(r[0], r[r.length - 1]) < 1e-6) r[r.length - 1] = r[0].slice();
  }

  ed.dirty = true;
  toast(`已插入拐点（这条线现在 ${ring.length} 个点）`, 'ok');
  renderPanels(); requestDraw();
}

/**
 * 复制一份要素，选中副本，并挪开一点点。
 * 正好压在原件上的话，用户看不出复制成功，也没法拖。
 */
function duplicateFeature(hit) {
  const src = ed.find(hit.key, hit.id).f;
  const copy = JSON.parse(JSON.stringify(src));
  const made = ed.newFeature(hit.key, copy.geometry);
  Object.assign(made.properties, JSON.parse(JSON.stringify(src.properties)));

  const off = 24 / Math.max(0.05, view.scale);   // 屏幕上约 24px
  moveGeometry(made.geometry, copy.geometry, off, -off);

  ed.dirty = true;
  ed.selection = { key: hit.key, id: made.id };
  toast(`已复制一份（${made.id}）—— 拖的是副本，原件没动`, 'ok');
  renderPanels(); requestDraw();
}

/* ============================================================ 剪贴板 */

/**
 * 形状剪贴板。
 *
 * ★ 存的是【深拷贝】，不是引用。存引用的话，你复制完随手把原件改了，
 *   剪贴板里的东西也跟着变 —— 粘贴出来的就不是你复制的那一份。
 *
 * ★ 粘贴会落到【当前楼层】，不是原件的楼层。这正是「复制到别的层」的用法：
 *   在 L3F 复制，切到 L4F，粘贴。
 *   跨层坐标可以直接复用 —— 同一栋楼各层是同一个本地坐标系，
 *   电梯/扶梯就是靠这个对齐的（同坐标不同层）。
 */
let clipboard = null;

function geomBBox(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const eat = (c) => {
    if (typeof c[0] !== 'number') { c.forEach(eat); return; }
    x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]);
    x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
  };
  eat(geom.coordinates);
  return Number.isFinite(x0) ? { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
}

/** 对几何里的每个坐标做一次变换。 */
function mapGeometry(geom, fn) {
  const walk = (node) => {
    if (typeof node[0] === 'number') { const p = fn(node); node[0] = p[0]; node[1] = p[1]; return; }
    node.forEach(walk);
  };
  walk(geom.coordinates);
  return geom;
}

function copyFeature() {
  const sel = ed.selected();
  if (!sel) return toast('先选中一个要素', 'err');
  if (!sel.f.geometry) return toast('这个要素没有几何', 'err');
  clipboard = {
    key: sel.key,
    props: JSON.parse(JSON.stringify(sel.f.properties)),
    geometry: JSON.parse(JSON.stringify(sel.f.geometry)),
  };
  toast(`已复制 ${sel.f.id}（${sel.f.geometry.type}）—— 切到目标楼层按 Ctrl+V 粘贴`, 'ok');
  renderPanels();
}

function pasteFeature() {
  if (!clipboard) return toast('剪贴板是空的 —— 先选中一个要素按 Ctrl+C', 'err');
  // ★ 粘贴到【当前】楼层：这是「复制到别的层」的关键
  const lv = ed.currentLevel;
  const geom = JSON.parse(JSON.stringify(clipboard.geometry));

  // 稍微挪开，免得和原件（或刚粘贴的那份）完全重合
  const off = 20 / Math.max(0.05, view.scale);
  moveGeometry(geom, geom, off, -off);

  const made = ed.newFeature(clipboard.key, geom);
  Object.assign(made.properties, JSON.parse(JSON.stringify(clipboard.props)));
  made.properties.level = lv;                 // 落到当前层
  made.properties.verified = false;           // 复制来的没核实过

  ed.pushUndo();
  ed.dirty = true;
  ed.selection = { key: clipboard.key, id: made.id };
  toast(`已粘贴到 ${lv}（${made.id}）`, 'ok');
  renderPanels(); requestDraw();
}

/** 绕几何中心旋转。deg 为正 = 逆时针（本地坐标系 x 东 y 北）。 */
function rotateFeature(deg) {
  const sel = ed.selected();
  if (!sel?.f.geometry) return toast('先选中一个要素', 'err');
  const bb = geomBBox(sel.f.geometry);
  if (!bb) return;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  ed.pushUndo();
  mapGeometry(sel.f.geometry, ([x, y]) => {
    const dx = x - bb.cx, dy = y - bb.cy;
    return [r2(bb.cx + dx * cos - dy * sin), r2(bb.cy + dx * sin + dy * cos)];
  });
  ed.dirty = true;
  toast(`已旋转 ${deg}°（绕形状中心）`, 'ok');
  renderPanels(); requestDraw();
}

/** 翻转。axis='x' 沿水平轴翻（上下颠倒），axis='y' 沿竖直轴翻（左右镜像）。 */
function flipFeature(axis) {
  const sel = ed.selected();
  if (!sel?.f.geometry) return toast('先选中一个要素', 'err');
  const bb = geomBBox(sel.f.geometry);
  if (!bb) return;

  ed.pushUndo();
  mapGeometry(sel.f.geometry, ([x, y]) => (axis === 'x'
    ? [x, r2(bb.cy - (y - bb.cy))]
    : [r2(bb.cx - (x - bb.cx)), y]));
  ed.dirty = true;
  toast(axis === 'x' ? '已上下翻转' : '已左右翻转', 'ok');
  renderPanels(); requestDraw();
}

/** 点着画的：闭合面。 */
const POLYGON_MODES = new Set(['regions', 'facArea', 'obstacles']);
/** 点着画的：开放折线（通行线）。 */
const POLYLINE_MODES = new Set(['paths']);

/* ============================================================ 工具函数 */

// featureLevel / featureMatchesLevel 从 render.mjs 引入 —— 判断楼层归属的逻辑只有一份，
// 「适应视图」、吸附、命中测试用的是同一个规则，不会各自漂移。
const visibleOnCurrent = (key, f) => featureMatchesLevel(key, f, ed.currentLevel);

const layerVisible = (key) => ia.visibleLayers[key.includes('/') ? key.split('/')[1] : key] !== false;

function ringPoints(f) {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'LineString') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.flat(2);
  return [];
}

/* ------------------------------------------------------------ 吸附 */

/**
 * 吸附档位。**按顺序找，第一个有命中的档位胜出**，档内取最近的。
 *
 * 用「档位优先」而不是「全局比距离」，是因为后者行为不可预测：
 * 你想吸到路口顶点，结果 1px 外有根线边，就吸到边上去了。
 * 分档之后「顶点永远赢边」是确定的。
 *
 * ★ 通行线【边】的吸附是这次补上的 —— 之前只处理多边形边，
 *   LineString 的边根本不参与，画 T 型接头时永远对不准。
 */
const SNAP_TIERS = [
  { kind: 'poi', label: '设施点', r: 14 },
  // ★ 正在画的这条折线自己（已落点、已画段）。
  //   放在很靠前的位置：闭环回到起点、把新点对齐到刚才那个点，都是画线时最常用的操作。
  { kind: 'draftVertex', label: '本条折线顶点', r: 12 },
  { kind: 'conn', label: '连接件端点', r: 13 },
  /*
   * ★ 三种「拐点」都是最高优先级的一档。
   *   画线时最常见的意图就是「接到已有要素的那个角上」——
   *   通行线的折点、区域面的角、面状设施的墙角。
   *   把它们排在边档位之前，靠近墙角时光标才会钉在角上，
   *   而不是被「边上任意一点」抢走。
   */
  { kind: 'pathVertex', label: '通行线顶点', r: 13 },
  { kind: 'regionVertex', label: '区域顶点', r: 13 },
  { kind: 'facilityVertex', label: '设施拐点', r: 13 },
  { kind: 'pathEdge', label: '通行线上', r: 11 },
  { kind: 'draftEdge', label: '本条折线上', r: 10 },
  { kind: 'facilityEdge', label: '设施边界', r: 10 },
  { kind: 'regionEdge', label: '区域边界', r: 10 },
  { kind: 'grid', label: '网格', r: 14 },
];

/**
 * 把线段投影到屏幕，返回离 screenPt 最近的点（本地坐标）+ 参数 t。
 *
 * ★ 返回 t 是为了让调用方能排除【端点】。
 *   端点用顶点档位去吸，如果段档位也把端点算进来，段的大半径就会偷偷
 *   把顶点的小半径顶掉 —— 比如「本条折线」段半径 10px、
 *   而最后一个点的半径只有 6px（故意留小，好让密集折线画得下去），
 *   结果段档位把有效半径撑到 10px，密集折线又画不动了。
 */
function segSnap(a, b, screenPt) {
  const sa = screenFromLocal(a, view), sb = screenFromLocal(b, view);
  const d = G.pointToSegmentDistance(screenPt, sa, sb);
  const dx = sb[0] - sa[0], dy = sb[1] - sa[1];
  const len2 = Math.max(1e-6, dx * dx + dy * dy);
  const t = Math.max(0, Math.min(1, ((screenPt[0] - sa[0]) * dx + (screenPt[1] - sa[1]) * dy) / len2));
  return { d, t, local: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

/** t 落在两端的这一段，交给顶点档位处理，段档位不碰。 */
const isEndpointHit = (t) => t < 0.02 || t > 0.98;

/**
 * @param screenPt 屏幕坐标
 * @param opts.exclude  { key, id } —— 拖动中的要素不要吸到自己身上
 */
function computeSnap(screenPt, opts = {}) {
  if (!ia.snapEnabled) return null;
  const ex = opts.exclude;
  const isSelf = (key, f) => ex && ex.id === f.id && ex.key === key;

  // 每档收集候选
  const buckets = new Map(SNAP_TIERS.map((t) => [t.kind, []]));
  const put = (kind, local, d, label) => {
    const b = buckets.get(kind);
    if (b) b.push({ local, d, label });
  };

  // ① 设施点 / 设施边界
  for (const f of ed.facilities.features) {
    if (f.properties?.level !== ed.currentLevel || isSelf('facilities', f)) continue;
    const g = f.geometry;
    if (g?.type === 'Point') {
      const s = screenFromLocal(g.coordinates, view);
      const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
      if (d <= 14) put('poi', g.coordinates, d, f.properties.name ?? f.id);
    } else if (g?.type === 'Polygon') {
      const ring = g.coordinates[0];
      const nm = f.properties.name ?? f.id;
      // 拐点（高优先级）和边（低优先级）都收。谁赢由 SNAP_TIERS 的先后决定：
      // 靠近墙角时拐点档位先命中，光标钉在角上；沿墙中间靠近时才落到边上。
      for (const c of ring) {
        const s = screenFromLocal(c, view);
        const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
        if (d <= 13) put('facilityVertex', c, d, `${nm} 拐点`);
      }
      for (let i = 0; i + 1 < ring.length; i++) {
        const r = segSnap(ring[i], ring[i + 1], screenPt);
        if (r.d <= 10) put('facilityEdge', r.local, r.d, nm);
      }
    }
  }

  // ② 连接件端点
  for (const c of ed.connectors.features) {
    const p = c.properties ?? {};
    for (const side of ['from', 'to']) {
      const e = p[side];
      if (!e || e.level !== ed.currentLevel) continue;
      const s = screenFromLocal([e.x, e.y], view);
      const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
      if (d <= 13) put('conn', [e.x, e.y], d, `${c.id} ${side}`);
    }
  }

  // ③ 通行线：顶点 + 边
  for (const f of ed.paths.features) {
    if (f.properties?.level !== ed.currentLevel || f.geometry?.type !== 'LineString') continue;
    if (isSelf('paths', f)) continue;
    const c = f.geometry.coordinates;
    const nm = f.properties.name ?? f.id;
    for (const p of c) {
      const s = screenFromLocal(p, view);
      const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
      if (d <= 13) put('pathVertex', p, d, nm);
    }
    for (let i = 0; i + 1 < c.length; i++) {
      const r = segSnap(c[i], c[i + 1], screenPt);
      // 端点由 pathVertex 档位负责（优先级更高），这里只吸段的中间部分
      if (r.d <= 11 && !isEndpointHit(r.t)) put('pathEdge', r.local, r.d, nm);
    }
  }

  // ④ 区域：顶点 + 边
  const regionPack = ed.levels[ed.currentLevel]?.regions;
  for (const f of regionPack?.features ?? []) {
    if (isSelf(`${ed.currentLevel}/regions`, f)) continue;
    const nm = f.properties?.name ?? f.id;
    for (const ring of f.geometry?.coordinates ?? []) {
      for (const p of ring) {
        const s = screenFromLocal(p, view);
        const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
        if (d <= 12) put('regionVertex', p, d, nm);
      }
      for (let i = 0; i + 1 < ring.length; i++) {
        const r = segSnap(ring[i], ring[i + 1], screenPt);
        if (r.d <= 10) put('regionEdge', r.local, r.d, nm);
      }
    }
  }

  // ⑤ 正在画的这条折线自己：已落下的顶点 + 已画出的段
  //
  // ★ 「已经确定位置、但还没按 Enter」的那些点 —— 画线时最想吸的就是它们：
  //   闭环回到起点、把新点对齐到刚放的那个点、把点落在自己刚画的那一段上。
  const draft = ia.draft;
  if (draft?.kind === 'polyline' && draft.points?.length) {
    const dp = draft.points;
    for (let i = 0; i < dp.length; i++) {
      const s = screenFromLocal(dp[i], view);
      const d = Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]);
      // 最后一个点的半径很小（6px）：它只是「结束折线」的手势目标，
      // 半径太大会把最小可画的段长顶上去，画密折线时会突然放不下点。
      const r = i === dp.length - 1 ? 6 : 12;
      if (d <= r) put('draftVertex', dp[i], d, i === 0 ? '起点（闭环）' : `第 ${i + 1} 点`);
    }
    for (let i = 0; i + 1 < dp.length; i++) {
      const r = segSnap(dp[i], dp[i + 1], screenPt);
      if (r.d <= 10 && !isEndpointHit(r.t)) put('draftEdge', r.local, r.d, '本条折线');
    }
  }

  // ⑥ 网格（兜底）
  if (ia.gridSnap) {
    const l = localFromScreen(screenPt, view);
    const g = [Math.round(l[0] * 2) / 2, Math.round(l[1] * 2) / 2];
    const d = Math.hypot(...screenFromLocal(g, view).map((v, i) => v - screenPt[i]));
    if (d <= 14) put('grid', g, d, '网格 0.5m');
  }

  // 按档位顺序取第一个有命中的
  for (const tier of SNAP_TIERS) {
    const b = buckets.get(tier.kind);
    if (!b.length) continue;
    const win = b.reduce((a, c) => (c.d < a.d ? c : a));
    // ★ 必须返回【副本】。直接返回 win.local 的话，调用方把这个点 push 进草稿后，
    //   草稿点和设施/通行线的坐标就是同一个数组了 —— 之后移动顶点会把源数据一起改掉。
    //   这类别名 bug 不会当场报错，只会在某次编辑后莫名其妙地"两个东西一起动"。
    return { local: [win.local[0], win.local[1]], kind: tier.kind, label: tier.label, target: win.label, d: win.d };
  }
  return null;
}

/** 当前点在哪个区域里 —— 连接件端点合法性的实时判据。 */
function regionAt(local, level) {
  for (const w of (ed.levels[level]?.regions?.features ?? [])) {
    const polys = w.geometry.type === 'Polygon' ? [w.geometry.coordinates] : w.geometry.coordinates;
    if (polys.some((p) => G.pointInPolygon(local, p))) return w;
  }
  return null;
}

/* ---------------------------------------------------------- 命中测试 */

function hitTest(screenPt) {
  // 顺序 = 谁在上面谁先被选中。通行线很细，所以给得比较靠前。
  const order = ['facilities', 'paths', 'obstacles', 'connectors', `${ed.currentLevel}/regions`];
  const local = localFromScreen(screenPt, view);
  for (const key of order) {
    if (!layerVisible(key)) continue;
    let fc; try { fc = ed.collection(key); } catch { continue; }
    if (!fc) continue;
    const feats = fc.features.filter((f) => visibleOnCurrent(key, f));
    for (const f of [...feats].reverse()) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Point') {
        const s = screenFromLocal(g.coordinates, view);
        if (Math.hypot(s[0] - screenPt[0], s[1] - screenPt[1]) <= 9) return { key, id: f.id };
      } else if (g.type === 'LineString') {
        // 线很细，按屏幕距离判定（和画出来的宽度对齐）
        for (let i = 0; i + 1 < g.coordinates.length; i++) {
          const sa = screenFromLocal(g.coordinates[i], view);
          const sb = screenFromLocal(g.coordinates[i + 1], view);
          if (G.pointToSegmentDistance(screenPt, sa, sb) <= 8) return { key, id: f.id };
        }
      } else {
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        if (polys.some((p) => G.pointInPolygon(local, p))) return { key, id: f.id };
      }
    }
  }
  return null;
}

/* ============================================================ 绘制循环 */

let rafPending = false;
function requestDraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(ctx, ed, view, ia, canvas); updateStatus(); });
}

function updateStatus() {
  const l = ia.cursorLocal;
  $('stCoord').textContent = l ? `${l[0].toFixed(2)}, ${l[1].toFixed(2)}` : '—';
  const maps = ed.calMaps();
  const active = ed.activeMap();
  $('stScale').textContent = active
    ? `1px = ${active.mPerPx.toFixed(4)} m${maps.length > 1 ? `（${maps.length} 张底图）` : ''}`
    : (maps.length ? `${maps.length} 张底图` : '无底图');
  $('stZoom').textContent = `${view.scale.toFixed(2)} px/m`;
  $('stSnap').textContent = ia.snap
    ? `吸附：${ia.snap.label}${ia.snap.target ? `（${ia.snap.target}）` : ''}`
    : '';
  const m = MODES.find((x) => x.id === ia.mode);
  $('stMode').textContent = m ? `${m.label}（${m.key}）` : ia.mode;
  $('stDirty').innerHTML = ed.dirty ? '<b style="color:var(--warn)">未保存</b>' : '<b style="color:var(--ok)">已保存</b>';
  $('btnUndo').disabled = !ed.undo.length;
  $('btnRedo').disabled = !ed.redo.length;
}

/* ============================================================ 指针交互 */

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const rect = canvas.getBoundingClientRect();
  const sp = [ev.clientX - rect.left, ev.clientY - rect.top];
  const raw = localFromScreen(sp, view);
  const snap = computeSnap(sp);
  const local = snap ? snap.local : raw;

  // 中键 / 右键 / 空格 = 平移
  if (ev.button === 1 || ev.button === 2 || ia.mode === 'select' && ev.shiftKey) {
    ia.drag = { kind: 'pan', sp, ox: view.ox, oy: view.oy };
    return;
  }
  if (ev.button !== 0) return;

  switch (ia.mode) {
    /*
     * ★ 改形状。
     *   优先级：拐点手柄 → 边（插点）→ 要素内部（整体拖 / Alt 复制）。
     *   手柄必须排第一，否则靠近拐点时会被"边上插点"抢走 ——
     *   而用户伸手去够的显然就是那个拐点。
     */
    case 'reshape': {
      // 1) 拐点手柄 → 拖动
      for (const h of ia.handles) {
        if (G.dist(h.p, local) * view.scale <= 11) {
          ed.pushUndo();
          ia.drag = { kind: 'vertex', handle: h };
          requestDraw();
          return;
        }
      }

      // 2) 边 → 在这条边上插一个拐点
      const edge = hitEdge(sp);
      if (edge) {
        ed.pushUndo();
        insertVertexAt(edge, local);
        return;
      }

      // 3) 要素内部 → 整体拖动；按住 Alt 先复制一份再拖
      const hit = hitTest(sp);
      if (hit) {
        if (ev.altKey) duplicateFeature(hit);
        ed.selection = hit;
        ed.pushUndo();
        ia.drag = {
          kind: 'feature', key: hit.key, id: hit.id, start: local,
          orig: JSON.parse(JSON.stringify(ed.find(hit.key, hit.id).f.geometry)),
        };
      } else {
        ed.selection = null;
        ia.drag = { kind: 'pan', sp, ox: view.ox, oy: view.oy };
      }
      renderPanels();
      requestDraw();
      return;
    }

    case 'select': {
      // 1) 顶点手柄优先
      for (const h of ia.handles) {
        if (G.dist(h.p, local) * view.scale <= 10) {
          ed.pushUndo();
          ia.drag = { kind: 'vertex', handle: h };
          return;
        }
      }
      // 2) 命中要素 → 整体拖动
      const hit = hitTest(sp);
      if (hit) {
        ed.selection = hit;
        ed.pushUndo();
        ia.drag = { kind: 'feature', key: hit.key, id: hit.id, start: local, orig: JSON.parse(JSON.stringify(ed.find(hit.key, hit.id).f.geometry)) };
        renderPanels();
        requestDraw();
        return;
      }
      ed.selection = null;
      ia.drag = { kind: 'pan', sp, ox: view.ox, oy: view.oy };
      renderPanels();
      requestDraw();
      return;
    }

    case 'regions': case 'facArea': case 'obstacles': {
      if (!ia.draft) ia.draft = { kind: 'polygon', mode: ia.mode, points: [] };
      const first = ia.draft.points[0];
      if (first && ia.draft.points.length >= 3 && G.dist(first, local) * view.scale <= 12) return closePolygon();
      ia.draft.points.push(local);
      requestDraw();
      return;
    }

    case 'basemap': {
      // ★ 底图调整：拖框内移动，拖角/边缩放，拖黄点旋转。不用手填坐标。
      const g = baseMapHandles(ed, view);
      if (!g) { toast('这一层还没有底图 —— 先在左侧「平面图与校准」里加一张', 'err'); return; }
      let hit = null;
      for (const h of g.handles) {
        if (Math.hypot(h.screen[0] - sp[0], h.screen[1] - sp[1]) <= 11) { hit = h; break; }
      }
      if (!hit && pointInScreenPoly(sp, g.corners)) hit = { kind: 'center', imgPx: [g.W / 2, g.H / 2] };
      if (!hit) return;

      const map = g.map;
      const centerLocal = ed.toLocal([g.W / 2, g.H / 2], map);

      // ★ 缩放的锚点是【对侧】手柄，不是被拖的那个。
      //   用成自己会得到 dist=0，缩放永远不生效（而且很难看出来）。
      let anchorPx = null;
      if (hit.kind === 'corner') anchorPx = g.handles.find((h) => h.kind === 'corner' && h.i === (hit.i + 2) % 4).imgPx;
      else if (hit.kind === 'edge') anchorPx = g.handles.find((h) => h.kind === 'edge' && h.i === (hit.i + 2) % 4).imgPx;

      // ★ 拖拽全程以【按下那一刻的状态】为基准算增量，不要在中间态上累加 ——
      //   否则来回拖几次就会漂。
      ia.mapDrag = {
        kind: hit.kind,
        level: ed.currentLevel,
        mapId: map.id,
        startLocal: local,
        startScreen: sp,
        start: { mPerPx: map.mPerPx, rotationDeg: map.rotationDeg, originPx: [...(map.originPx ?? [0, 0])], nudge: [...(map.nudge ?? [0, 0])] },
        anchorPx,
        anchorLocal: anchorPx ? ed.toLocal(anchorPx, map) : centerLocal,
        pivotLocal: centerLocal,
        startDeg: map.rotationDeg ?? 0,
        startAngle: Math.atan2(local[1] - centerLocal[1], local[0] - centerLocal[0]),
        startDist: anchorPx ? G.dist(local, ed.toLocal(anchorPx, map)) : 1,
      };
      ed.pushUndo();
      return;
    }

    case 'paths': {
      // 折线：点着加顶点；Enter / 双击 / 点回上一个点 / 点回起点 都能结束
      if (!ia.draft) ia.draft = { kind: 'polyline', mode: ia.mode, points: [] };
      const pts = ia.draft.points;
      const last = pts[pts.length - 1];

      // ★ 用「有没有真的吸到那个点上」判断结束，不用像素阈值。
      //   阈值法有个隐蔽后果：最小可画的段长会随缩放变化 ——
      //   8px 在 scale=4 时是 2m，在 scale=1 时就是 8m，画密折线时会突然画不动。
      const onDraftPoint = (p) => !!(snap && p && snap.kind === 'draftVertex'
        && Math.abs(snap.local[0] - p[0]) < 1e-9 && Math.abs(snap.local[1] - p[1]) < 1e-9);

      // 点回【起点】= 闭环并结束。闭环在图里会合并成同一个节点，是合法的环线。
      if (pts.length >= 3 && onDraftPoint(pts[0])) {
        pts.push([pts[0][0], pts[0][1]]);
        return finishPolyline();
      }
      // 点回【上一个点】= 结束
      if (pts.length >= 2 && onDraftPoint(last)) return finishPolyline();
      // ★ 吸附可能把光标吸到刚放下的那个点上。放一个重合点会产生零长度的段，
      //   图里会出现两个同坐标的节点。直接忽略这一下。
      if (last && G.dist(last, local) < 0.05) return;

      pts.push(local);
      requestDraw();
      return;
    }

    case 'facPoint': {
      // ★ 跨层设施（电梯/扶梯/楼梯/坡道）走另一条路：
      //   先选它连通哪几层，再在各层同一坐标上自动建点。
      if (isVerticalCategory(ed.currentCategory)) {
        pickLevelsAndPlace(local, ed.currentCategory);
        return;
      }
      const feat = ed.newFeature('facilities', { type: 'Point', coordinates: [r2(local[0]), r2(local[1])] });
      // 继承所在区域的隔离区，避免手填 zone 填错
      const w = regionAt(local, ed.currentLevel);
      if (w) { feat.properties.zone = w.properties.zone; ed.currentZone = w.properties.zone; syncZoneSel(); }
      ed.add('facilities', feat);
      toast(`已放置 ${feat.id}`, 'ok');
      renderPanels(); requestDraw();
      return;
    }

    case 'connect': {
      // ★ 一个按钮管两种连接件：
      //   跨层类型（电梯/扶梯/楼梯/坡道）→ 走「跨层设施」流程：选楼层、各层同坐标建点
      //   跨区类型（安检/边检/海关/检疫/中转/出口）→ 点入口、再点出口，存成图上的边
      const t = ed.manifest?.connectorTypes?.[ia.connType] ?? {};
      if (t.horizontal === false) {
        ed.currentCategory = isVerticalCategory(ia.connType) ? ia.connType : 'elevator';
        pickLevelsAndPlace(local, ed.currentCategory);
        return;
      }
      if (!ia.draft) ia.draft = { kind: 'connector', points: [] };
      ia.draft.points.push(local);
      if (ia.draft.points.length === 2) {
        const [a, b] = ia.draft.points;
        ia.draft = null;
        finishConnector(a, b);
      }
      requestDraw();
      return;
    }
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const sp = [ev.clientX - rect.left, ev.clientY - rect.top];
  ia.cursorScreen = sp;

  if (ia.mapDrag) {
    applyBaseMapDrag(sp);
    requestDraw();
    return;
  }

  if (ia.drag) {
    if (ia.drag.kind === 'pan') {
      view.ox = ia.drag.ox + (sp[0] - ia.drag.sp[0]);
      view.oy = ia.drag.oy + (sp[1] - ia.drag.sp[1]);
    } else if (ia.drag.kind === 'vertex') {
      // ★ 拖顶点时别吸到它自己身上，否则一动就被自己钉住
      const snap = computeSnap(sp, { exclude: ed.selection });
      const p = snap ? snap.local : localFromScreen(sp, view);
      moveVertex(ia.drag.handle, p);
    } else if (ia.drag.kind === 'feature') {
      const raw = localFromScreen(sp, view);
      const dx = raw[0] - ia.drag.start[0], dy = raw[1] - ia.drag.start[1];
      const hit = ed.find(ia.drag.key, ia.drag.id);
      moveGeometry(hit.f.geometry, ia.drag.orig, dx, dy);
    }
    requestDraw();
    return;
  }

  ia.snap = computeSnap(sp, ed.mode === 'select' && ed.selection ? { exclude: ed.selection } : {});
  ia.cursorLocal = ia.snap ? ia.snap.local : localFromScreen(sp, view);

  // 画通行线时预览「这一段会生成哪些路口」
  if (ia.draft?.kind === 'polyline') {
    const coords = ia.cursorLocal ? [...ia.draft.points, ia.cursorLocal] : ia.draft.points;
    const others = ed.paths.features
      .filter((f) => f.properties?.level === ed.currentLevel && f.geometry?.type === 'LineString')
      .map((f) => ({ id: f.id, coords: f.geometry.coordinates, level: f.properties.level }));
    ia.crossingPreview = coords.length >= 2 ? crossingsWith(coords, others, { level: ed.currentLevel }) : [];
  } else {
    ia.crossingPreview = null;
  }

  requestDraw();
});

/**
 * 应用一次底图拖拽。
 *
 * ★ 全程以【按下那一刻的 map 快照】为基准算，不在中间态上累加 ——
 *   否则拖拽过程中反复应用变换会累积浮点误差，松手后位置会漂。
 */
function applyBaseMapDrag(sp) {
  const d = ia.mapDrag;
  const map = ed.mapById(d.level, d.mapId);
  if (!map) return;
  const cur = localFromScreen(sp, view);
  const level = d.level;

  if (d.kind === 'center') {
    // 平移：直接改 nudge（本地米），和视图缩放无关
    const dx = cur[0] - d.startLocal[0];
    const dy = cur[1] - d.startLocal[1];
    ed.updateCalMap(level, d.mapId, {
      nudge: [d.start.nudge[0] + dx, d.start.nudge[1] + dy],
    });
    return;
  }

  if (d.kind === 'rotate') {
    const ang = Math.atan2(cur[1] - d.pivotLocal[1], cur[0] - d.pivotLocal[0]);
    let deltaDeg = ((ang - d.startAngle) * 180) / Math.PI;
    let deg = d.startDeg + deltaDeg;
    if (ia.snapEnabled) deg = Math.round(deg * 2) / 2;        // 吸附到 0.5°
    // 用【起始状态】当作旋转基准，避免在中间态上累加
    const base = { ...map, ...d.start };
    const out = rotateBaseMapAbout(base, d.pivotLocal, deg);
    ed.updateCalMap(level, d.mapId, out);
    return;
  }

  // corner / edge：以对侧手柄为锚点做等比缩放
  const anchorPx = d.anchorPx;
  if (!anchorPx) return;
  const anchorLocal = d.anchorLocal;
  const dStart = G.dist(d.startLocal, anchorLocal);
  const dNow = G.dist(cur, anchorLocal);
  if (dStart < 0.5) return;
  let m = d.start.mPerPx * (dNow / dStart);
  if (!(m > 1e-6)) return;
  if (ia.snapEnabled) m = Math.round(m * 1e4) / 1e4;
  const out = scaleBaseMapAbout({ ...map, ...d.start }, anchorPx, m);
  ed.updateCalMap(level, d.mapId, out);
}

canvas.addEventListener('pointerup', (ev) => {
  if (ia.mapDrag) { ia.mapDrag = null; renderPanels(); requestDraw(); return; }
  if (ia.drag && ia.drag.kind !== 'pan') ed.dirty = true;
  ia.drag = null;
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  renderPanels();
  requestDraw();
});
canvas.addEventListener('pointerleave', () => { ia.cursorLocal = null; ia.snap = null; requestDraw(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(view, [ev.clientX - rect.left, ev.clientY - rect.top], ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  requestDraw();
}, { passive: false });

const r2 = (n) => Math.round(n * 100) / 100;

function moveVertex(h, p) {
  const sel = ed.selected();
  if (!sel) return;
  const g = sel.f.geometry;
  if (g.type === 'Point') { g.coordinates = [r2(p[0]), r2(p[1])]; return; }
  if (g.type === 'LineString') { g.coordinates[h.vi] = [r2(p[0]), r2(p[1])]; return; }
  const ring = g.coordinates[h.fi];
  const isClosed = ring.length > 1 && G.dist(ring[0], ring[ring.length - 1]) < 1e-6;
  ring[h.vi] = [r2(p[0]), r2(p[1])];
  if (isClosed && h.vi === 0) ring[ring.length - 1] = ring[0].slice();
}

function moveGeometry(geom, orig, dx, dy) {
  const walk = (node, path) => {
    if (typeof node[0] === 'number') {
      const o = getAt(orig, path);
      node[0] = r2(o[0] + dx); node[1] = r2(o[1] + dy);
      return;
    }
    node.forEach((child, i) => walk(child, [...path, i]));
  };
  walk(geom.coordinates, []);
}
function getAt(obj, path) { return path.reduce((a, k) => a[k], obj); }

/* ============================================================ 绘制完成 */

/**
 * 结束一条通行线。
 *
 * 画完立刻做两项即时校验（正式校验仍以 validate.mjs 为准）：
 *   · 每个顶点和每段中点是否落在同层同 zone 的区域面内
 *   · 是否穿过障碍物
 * 让错误在画的那一刻就暴露，而不是攒到跑校验器时。
 */
function finishPolyline() {
  const d = ia.draft;
  ia.draft = null;
  if (!d || d.points.length < 2) { toast('通行线至少需要 2 个点', 'err'); return; }

  const coords = d.points.map((p) => [r2(p[0]), r2(p[1])]);
  const feat = ed.newFeature('paths', { type: 'LineString', coordinates: coords });

  /*
   * ★ 通行线不取名字。它的称呼就是它的【种类】（走廊 / 主通道 / 支线…），
   *   导航指令直接念种类名就够了。生成「走廊 12」这种编号是多余的 ——
   *   旅客在航站楼里看不到「走廊 12」这块牌子，编号没有任何信息量。
   */

  // 继承所在区域的 zone —— 手填 zone 是常见错误来源
  const mid = coords[Math.floor(coords.length / 2)];
  const w = regionAt(mid, ed.currentLevel) ?? regionAt(coords[0], ed.currentLevel);
  if (w) {
    feat.properties.zone = w.properties.zone;
    if (ed.currentZone !== w.properties.zone) { ed.currentZone = w.properties.zone; syncZoneSel(); }
  }

  const problems = [];
  if (G.polylineSelfIntersects?.(coords)) problems.push('这条线自交了 —— 交叉点会被当成路口');
  const outside = coords.filter((p) => !regionAt(p, ed.currentLevel));
  if (outside.length) problems.push(`${outside.length} 个顶点不在区域面内（路径会穿墙）`);
  const zoneDiff = new Set(coords.map((p) => regionAt(p, ed.currentLevel)?.properties.zone).filter(Boolean));
  if (zoneDiff.size > 1) problems.push('这条线跨了隔离区 —— 跨 zone 只能经连接件，不能直接拉线');

  ed.add('paths', feat);

  if (problems.length) toast(`⚠ ${problems[0]}`, 'err');
  else {
    const g = graphPreview();
    toast(`已加通行线 ${feat.id}${g ? `　路网：${g.stats.nodes} 节点 / ${g.stats.junctions} 个路口` : ''}`, 'ok');
  }
  renderPanels(); requestDraw();
}

/** 用当前层的通行线编译一次图，给界面做即时反馈。 */
function graphPreview() {
  try {
    const paths = ed.paths.features
      .filter((f) => f.properties?.level === ed.currentLevel && f.geometry?.type === 'LineString')
      .map((f) => ({ id: f.id, level: f.properties.level, zone: f.properties.zone, props: f.properties, coords: f.geometry.coordinates }));
    if (!paths.length) return null;
    return buildGraph(paths);
  } catch { return null; }
}

/**
 * 设施接入状态 + 一键生成支线。
 *
 * ★ 这是新模型里设施可达性的全部：
 *     面状设施 → 通行线有没有吸附到它的边缘上
 *     点状设施 → 通行线有没有经过它
 *   没接上就一键拉一条支线过去，比手工画快得多。
 */
function accessNote(f, key) {
  const isArea = ed.isArea(f);
  const net = computeNetwork();
  const att = net?.attachments?.get(f.id);
  const tol = isArea ? (TH().areaAttachTolerance ?? 1) : (TH().poiPathTolerance ?? 5);

  if (!att) {
    return el('div', { class: 'field wide' }, el('div', { class: 'note', style: 'color:var(--err)' },
      `✗ 走不到 —— ${f.properties.level} 上还没有通行线`));
  }

  const ok = att.served;
  const box = el('div', { class: 'field wide' },
    el('div', { class: 'note', style: `color:${ok ? 'var(--ok)' : 'var(--err)'}` },
      ok
        ? `✓ 已接入路网　${att.dist.toFixed(2)}m（容差 ${tol}m）`
        : `✗ 走不到　最近的通行线 ${att.pathId} 离它 ${att.dist.toFixed(2)}m，超过容差 ${tol}m`,
      el('br'),
      el('span', { style: 'color:var(--fg3)' },
        `寻路点 (${att.routingPoint.map((n) => n.toFixed(1)).join(', ')})　via ${att.pathId}` +
        (isArea ? '　· 面状设施的寻路点 = 通行线吸附到它墙上的那个点' : '　· 点状设施的寻路点就是它自己'))),
    ok ? null : el('div', { class: 'actions', style: 'margin-top:6px' },
      el('button', {
        onclick: () => {
          const made = makeSpurTo(f);
          if (!made) return;
          toast(`已生成支线 ${made.id} —— 从 ${made.properties.zone} 的路网接过来`, 'ok');
          renderPanels(); requestDraw();
        },
      }, '一键生成支线')),
  );
  return box;
}

/** 从最近的路网拉一条支线到某个设施。返回新建的通行线。 */
function makeSpurTo(f) {
  const level = f.properties.level;
  const paths = ed.paths.features.filter((x) => x.properties?.level === level && x.geometry?.type === 'LineString');
  if (!paths.length) { toast('这一层还没有通行线 —— 先画一条主干', 'err'); return null; }

  const lite = paths.map((p) => ({ id: p.id, level, zone: p.properties.zone, coords: p.geometry.coordinates }));
  const isArea = ed.isArea(f);

  let attach, target;
  if (isArea) {
    // 支线终点落在房间【墙】上（不是房间中心）
    const a = G.closestBetweenPolylineAndPolygon;   // 只是为了让 lint 认得这个引用
    let best = null;
    for (const p of lite) {
      const r = a(p.coords, f.geometry.coordinates);
      if (r && (!best || r.dist < best.dist)) best = { ...r, pathId: p.id };
    }
    if (!best) { toast('算不出最近的接入点', 'err'); return null; }
    attach = best.point; target = best.edgePoint;
  } else {
    const n = G.closestPointOnPolyline(f.geometry.coordinates, []);
    void n;
    let best = null;
    for (const p of lite) {
      const r = G.closestPointOnPolyline(f.geometry.coordinates, p.coords);
      if (r && (!best || r.dist < best.dist)) best = { ...r, pathId: p.id };
    }
    if (!best) { toast('算不出最近的接入点', 'err'); return null; }
    attach = best.point; target = f.geometry.coordinates;
  }

  if (G.dist(attach, target) < 0.05) { toast('已经贴在路网上了', 'err'); return null; }

  const src = ed.paths.features.find((x) => x.id === attach.pathId);
  const coords = [[r2(attach[0]), r2(attach[1])], [r2(target[0]), r2(target[1])]];
  const feat = ed.newFeature('paths', { type: 'LineString', coordinates: coords });
  feat.properties.kind = 'branch';
  feat.properties.name = `${f.properties.name ?? f.id} 支线`;
  feat.properties.zone = src?.properties.zone ?? f.properties.zone;   // ★ 必须继承路网的 zone
  feat.properties.minWidth = 2;
  return ed.add('paths', feat);
}

/** 从 manifest 读阈值。 */
const TH = () => ed.manifest?.thresholds ?? {};

/** 实时编译一次路网，供叠加层和面板使用。 */
function computeNetwork() {
  try {
    const paths = ed.paths.features
      .filter((f) => f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2)
      .map((f) => ({ id: f.id, level: f.properties.level, zone: f.properties.zone, props: f.properties, coords: f.geometry.coordinates }));
    if (!paths.length) return null;
    const facs = ed.facilities.features.map((f) => ({
      id: f.id, level: f.properties?.level,
      point: f.geometry?.type === 'Point' ? f.geometry.coordinates : null,
      polygons: f.geometry?.type === 'Polygon' ? f.geometry.coordinates : null,
      props: f.properties ?? {},
    }));
    const conns = ed.connectors.features.map((c) => ({ id: c.id, props: c.properties ?? {} }));
    return buildNetwork({ paths, facilities: facs, connectors: conns }, {
      tolerance: ed.manifest?.thresholds?.polygonTouchTolerance ?? 0.05,
      areaAttachTolerance: TH().areaAttachTolerance ?? 1.0,
      poiPathTolerance: TH().poiPathTolerance ?? 5.0,
      connectorTolerance: TH().connectorOnPathTolerance ?? 0.5,
    });
  } catch { return null; }
}

/**
 * 图例。
 *
 * ★ 内容全部来自 render.mjs 导出的 legendSpec —— 那份规格又是从【绘制用的同一批常量】
 *   生成的。所以改了颜色/线宽，图例自动跟着变，不可能对不上。
 *
 * 色块用 SVG 画，不是 CSS：线要能表达「虚线 / 粗细」，点要能表达「半径」，
 * 圆角 div 做不到这些。
 */
function renderLegend() {
  const wrap = $('legend');
  if (!wrap || !ed.manifest) return;
  let groups;
  try { groups = legendSpec(ed); } catch { return; }

  const SW = 34, SH = 14;
  const svg = (children) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', SW); s.setAttribute('height', SH);
    s.setAttribute('viewBox', `0 0 ${SW} ${SH}`);
    for (const c of children) {
      const n = document.createElementNS('http://www.w3.org/2000/svg', c.tag);
      for (const [k, v] of Object.entries(c.attrs)) n.setAttribute(k, String(v));
      s.appendChild(n);
    }
    return s;
  };
  const cy = SH / 2;
  const mid = SW / 2;

  /** 把一条 item 画成色块。size 直接用真实数值，粗细差别看得出来。 */
  function swatch(it) {
    // 画布上的线宽是「屏幕像素」，图例里按 1:0.5 缩一点，否则 7px 外描边太占地方
    const w = Math.max(1, Math.min(6, (it.size ?? 2) * 0.7));
    const r = Math.max(2, Math.min(7, (it.size ?? 3.4) * 0.9));
    switch (it.swatch) {
      case 'line':
        return svg([{ tag: 'line', attrs: { x1: 2, y1: cy, x2: SW - 2, y2: cy, stroke: it.color, 'stroke-width': w, 'stroke-linecap': 'round' } }]);
      case 'dash':
        return svg([
          ...(it.fill ? [{ tag: 'rect', attrs: { x: 2, y: cy - 5, width: SW - 4, height: 10, fill: it.color, 'fill-opacity': it.fill } }] : []),
          { tag: 'line', attrs: { x1: 2, y1: cy, x2: SW - 2, y2: cy, stroke: it.color, 'stroke-width': w, 'stroke-dasharray': '5 3' } },
        ]);
      case 'rect':
        return svg([{ tag: 'rect', attrs: { x: 2, y: cy - 6, width: SW - 4, height: 12, fill: it.color, 'fill-opacity': it.fill ?? 0.3, stroke: it.color, 'stroke-width': 1.4, rx: 2 } }]);
      case 'ring':
        return svg([{ tag: 'circle', attrs: { cx: mid, cy, r, fill: 'none', stroke: it.color, 'stroke-width': 2 } }]);
      case 'dot':
      default:
        return svg([{ tag: 'circle', attrs: { cx: mid, cy, r, fill: it.color, stroke: '#0b1013', 'stroke-width': 1.2 } }]);
    }
  }

  const nodes = [];
  for (const g of groups) {
    if (!g.items?.length) continue;
    const box = el('div', { class: 'grp' }, el('div', { class: 'gt' }, g.title));
    if (g.note) box.append(el('div', { class: 'gn' }, g.note));
    for (const it of g.items) {
      box.append(el('div', { class: 'it' }, swatch(it),
        el('div', { class: 'nm' },
          el('b', {}, it.name),
          it.detail ? el('div', { class: 'sub' }, it.detail) : null)));
    }
    nodes.push(box);
  }
  wrap.replaceChildren(...nodes);

  const total = groups.reduce((s, g) => s + (g.items?.length ?? 0), 0);
  $('legendHint').textContent = `${total} 项`;
}

/**
 * 跨层设施（电梯/扶梯/楼梯/坡道）。
 *
 * ★ 模型：它们是【点状设施】，不是连接件的边。
 *   同一部电梯在每个连通的楼层上各有一个点，坐标【完全相同】，共享一个 verticalGroup。
 *   它们是整个模型里唯一「跨楼层同一个位置」的地方 —— 3D 里路径就在这里垂直穿过楼板。
 *
 * 所以创建流程是：先在当前层点一个位置 → 选这部电梯连通哪几层 →
 * 自动在每一层【同一个坐标】上各建一个点状设施，共用一个 group。
 */

const VERTICAL_CATEGORIES = () => Object.entries(ed.manifest?.facilityCategories ?? {})
  .filter(([k, v]) => !k.startsWith('_') && v?.vertical).map(([k]) => k);

const isVerticalCategory = (cat) => VERTICAL_CATEGORIES().includes(cat);
const catLabel = (cat) => ed.manifest?.facilityCategories?.[cat]?.name ?? cat;

function nextVerticalGroupId(cat) {
  const used = new Set(ed.facilities.features.map((f) => f.properties?.verticalGroup).filter(Boolean));
  let n = 1;
  while (used.has(`vg-${cat}-${String(n).padStart(2, '0')}`)) n++;
  return `vg-${cat}-${String(n).padStart(2, '0')}`;
}

/** 在选定的每一层、同一个坐标上各建一个点状设施，共用一个 verticalGroup。 */
function addVerticalFacility(coord, category, levels) {
  const group = nextVerticalGroupId(category);
  const list = ed.levelIds().filter((lv) => levels.includes(lv));   // 按楼层顺序排
  const pt = [r2(coord[0]), r2(coord[1])];
  const zone = regionAt(pt, ed.currentLevel)?.properties.zone ?? ed.currentZone;
  const name = `${catLabel(category)} ${group.split('-').pop()}`;

  ed.pushUndo();
  const made = [];
  for (const lv of list) {
    // 逐个建 + 逐个入列：nextId 靠扫描现有要素去重，
    // 一次全建完再入列的话 N 个成员会拿到同一个 id。
    const feat = ed.newFeature('facilities', { type: 'Point', coordinates: pt });
    Object.assign(feat.properties, {
      category, level: lv, zone, name, nameEn: name,
      verticalGroup: group, verticalLevels: list,
    });
    ed.facilities.features.push(feat);
    made.push(feat);
  }
  ed.dirty = true;
  ed.selection = { key: 'facilities', id: (made.find((m) => m.properties.level === ed.currentLevel) ?? made[0]).id };
  return { group, made };
}

/** 选楼层对话框。 */
function pickLevelsAndPlace(coord, category) {
  const all = ed.levelIds();
  const boxes = new Map();
  const body = el('div', {},
    el('div', { class: 'note', style: 'margin-bottom:10px' },
      `正在放一个【${catLabel(category)}】在 (${r2(coord[0])}, ${r2(coord[1])})。`,
      el('br'),
      '勾选它连通哪几层 —— 会在这些楼层的【同一个坐标】上各建一个点状设施，它们在寻路上相通。'),
    el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:4px 14px;margin-bottom:12px' },
      ...all.map((lv) => {
        const cb = el('input', { type: 'checkbox', checked: lv === ed.currentLevel });
        boxes.set(lv, cb);
        const meta = ed.manifest.levels[lv] ?? {};
        const drawn = !!ed.levels[lv] || ed.paths.features.some((p) => p.properties.level === lv);
        return el('label', { class: 'row', style: 'cursor:pointer' }, cb,
          el('span', { class: 't' },
            lv,
            el('div', { class: 'sub' }, `${meta.name ?? ''}${drawn ? '' : ' · 未绘制'}`)));
      })),
    el('div', { class: 'note', id: 'vgHint' }, ''),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', id: 'vgOk' }, '创建'),
      el('button', { onclick: closeModal }, '取消')),
  );

  const refresh = () => {
    const sel = [...boxes].filter(([, cb]) => cb.checked).map(([lv]) => lv);
    const undrawn = sel.filter((lv) => !ed.paths.features.some((p) => p.properties.level === lv));
    const hint = $('vgHint');
    if (!hint) return;
    hint.innerHTML = sel.length < 2
      ? '<span style="color:var(--warn)">至少选两层 —— 只选一层的话它就不是跨层设施了</span>'
      : `将创建 ${sel.length} 个点：${sel.join(', ')}`
        + (undrawn.length
          ? `<br><span style="color:var(--warn)">其中 ${undrawn.join(', ')} 还没画通行线，建好后那几个点会显示为「走不到」，等那层画完就通了</span>`
          : '');
  };
  for (const cb of boxes.values()) cb.onchange = refresh;

  modal(`放跨层设施 · ${catLabel(category)}`, body, () => {
    refresh();
    $('vgOk').onclick = () => {
      const sel = [...boxes].filter(([, cb]) => cb.checked).map(([lv]) => lv);
      if (sel.length < 2) return toast('至少选两层', 'err');
      const { group, made } = addVerticalFacility(coord, category, sel);
      closeModal(); renderPanels(); requestDraw();
      toast(`已创建 ${group}：${made.map((m) => m.properties.level).join(' / ')} 各一个点，坐标相同`, 'ok');
    };
  });
}

/**
 * 「搜索索引」面板：类别级字段定义 + 设施级取值。
 *
 * ★ 字段定义写在 manifest.facilityCategories[类别].fields 上，对该类别的【所有】设施生效。
 *   值机柜台的「字母编号 / 航空公司 / 航司代码」是必填 —— 放类别上，新增柜台自动出现；
 *   放单个设施上，就一定会有人漏填。
 *
 * 设施上也可以加临时字段（比如这家店多个「是否有座位」），
 * 点「所有 X 都用」就把它提升成类别级 —— 这就是「可选地让字段对所有该类型设施生效」。
 */
function searchFieldRows(f, key) {
  const cat = f.properties.category;
  const defs = ed.manifest?.facilityCategories?.[cat]?.fields ?? [];
  const values = f.properties.fields ?? {};
  const catName = ed.manifest?.facilityCategories?.[cat]?.name ?? cat;
  const rows = [];

  /** 写值。空值 = 删掉这个字段（清空输入框就是移除字段，这是对的）。 */
  const set = (k, v) => {
    const next = { ...(f.properties.fields ?? {}) };
    if (v === '' || v === undefined || v === null) delete next[k]; else next[k] = v;
    ed.setProps(key, f.id, { fields: next });
  };

  /**
   * ★ 新增字段必须和「清空字段」分开。
   *
   *   原来加字段也调 set(k, '')，而 set 把空字符串当成"删除" ——
   *   于是字段刚加进去就被删掉，侧边栏里什么也不出现。
   *   用户看到的是「点了 + 加临时字段，没反应」。
   *
   *   新增就是写入一个空字符串占位，让它先出现在面板里。
   *   （searchRecord 会把空值过滤掉，所以不会污染搜索索引。）
   */
  const addField = (k) => {
    const next = { ...(f.properties.fields ?? {}) };
    next[k] = '';
    ed.setProps(key, f.id, { fields: next });
  };

  const item = (d, val, declared) => {
    const missing = declared && d.required && (val === undefined || val === null || String(val).trim() === '');
    const box = el('div', { class: 'field wide', style: 'grid-template-columns:1fr;margin-bottom:6px' });

    const top = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:2px' },
      el('span', { style: `font-size:11.5px;color:${missing ? 'var(--err)' : 'var(--fg3)'}` },
        d.label, d.required ? ' *' : ''),
      el('span', { style: 'flex:1' }),
      declared ? null : el('button', {
        class: 'mini', title: `把「${d.label}」加到所有「${catName}」`,
        onclick: () => {
          const n = ed.addCategoryField(cat, { ...d, required: false });
          if (!n) return toast('这个类别已经有同名字段了', 'err');
          toast(`已把「${d.label}」加到所有「${catName}」`, 'ok');
          renderPanels(); requestDraw();
        },
      }, `所有${catName}都用`),
      declared ? null : el('button', {
        class: 'mini danger', title: '删掉这个临时字段',
        onclick: () => { set(d.key, undefined); renderPanels(); requestDraw(); },
      }, '×'),
    );
    box.append(top);

    let input;
    if (d.type === 'choice') {
      /*
       * ★ 枚举字段用【一排按钮】，不用下拉框。
       *   选项少（三个以内）、互斥、要频繁切换 —— 按钮一次点击就到位，
       *   下拉框要点开、找到、再点，还得看清选中了没有。
       *   再点一下当前项 = 取消（清空这个字段），不用额外给"无"的选项。
       */
      const box2 = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      for (const opt of (d.options ?? [])) {
        const on = String(val ?? '') === opt.value;
        box2.append(el('button', {
          class: on ? 'on' : '',
          title: on ? '再点一下取消' : '',
          onclick: () => { set(d.key, on ? undefined : opt.value); renderPanels(); requestDraw(); },
        }, opt.label));
      }
      box.append(box2);
      input = null;
    } else if (d.type === 'airline') {
      // 航司字段：给一个 datalist 建议，但允许填表外的值（小航司/包机不在表里）
      const listId = `airlines-${f.id}`;
      input = el('input', { type: 'text', value: val ?? '', list: listId, placeholder: '中国国际航空' });
      const dl = el('datalist', { id: listId });
      for (const [code, info] of Object.entries(ed.manifest?.airlines ?? {})) {
        if (code.startsWith('_')) continue;
        dl.append(el('option', { value: info.name }, `${info.name}（${code}）`));
      }
      box.append(input, dl);
    } else {
      input = el('input', {
        type: d.type === 'number' ? 'number' : 'text',
        value: val ?? '', placeholder: d.placeholder ?? '',
      });
      box.append(input);
    }
    if (input) input.onchange = () => { set(d.key, input.value.trim()); renderPanels(); };

    if (d.hint) box.append(el('div', { class: 'hint' }, d.hint));
    if (missing) box.append(el('div', { class: 'hint', style: 'color:var(--err)' }, '必填 —— 校验器会报 E_FIELD_REQUIRED'));
    return box;
  };

  rows.push(el('div', { class: 'field wide', style: 'margin-top:10px;margin-bottom:4px' },
    el('div', { style: 'font-size:12px;color:var(--fg2)' }, '搜索索引')));

  if (!defs.length) {
    rows.push(el('div', { class: 'note', style: 'margin-bottom:6px' },
      `类别「${catName}」还没定义字段。下面加的字段只对这个设施生效，点「所有${catName}都用」可以提升成类别级。`));
  }
  for (const d of defs) rows.push(item(d, values[d.key], true));

  // 类别里没定义的临时字段
  const declared = new Set(defs.map((d) => d.key));
  for (const [k, v] of Object.entries(values)) {
    if (declared.has(k)) continue;
    rows.push(item({ key: k, label: k, type: 'string' }, v, false));
  }

  rows.push(el('div', { class: 'actions', style: 'margin-top:2px' },
    el('button', {
      onclick: () => {
        const k = ($('newFieldKey')?.value ?? '').trim();
        if (!k) return toast('先填字段名', 'err');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return toast('字段名只能用字母数字下划线，且不能以数字开头', 'err');
        if (declared.has(k) || k in values) return toast('已经有这个字段了', 'err');
        // ★ addField，不是 set —— set(k,'') 会把它当成"清空"删掉
        addField(k);
        toast(`已添加字段「${k}」—— 填上值就会进搜索索引`, 'ok');
        renderPanels(); requestDraw();
      },
    }, '+ 加临时字段'),
    (() => {
      const k = el('input', { type: 'text', id: 'newFieldKey', placeholder: '字段名', style: 'width:88px' });
      return k;
    })(),
    (() => {
      const l = el('input', { type: 'text', id: 'newFieldLabel', placeholder: '显示名（可省）', style: 'width:110px' });
      return l;
    })(),
  ));

  return rows;
}

/**
 * 「可穿行」= 门 的提示。
 *
 * ★ 门的作用是：把接到它边缘上的所有通行线互相连通。
 *   所以至少要接上【两条】线才有意义 —— 只接一条的话，
 *   它连不出任何新路径，等于白标。
 *   而且跨区能否成立，取决于两侧的通行线是不是【真的断开】的：
 *   如果线直接从公共区画进了隔离区，寻路会顺着线走过去，门就用不上了。
 */
function portalNote(f) {
  const g = graphPreview();
  const touches = g?.portalTouches?.filter((t) => t.facilityId === f.id) ?? [];
  const paths = [...new Set(touches.map((t) => t.pathId))];
  const box = el('div', { class: 'field wide' });
  if (paths.length >= 2) {
    box.append(el('div', { class: 'note', style: 'color:var(--ok)' },
      `✓ 门已生效：${paths.length} 条通行线接到它边缘上，彼此全部连通`));
    box.append(el('div', { class: 'hint' }, paths.join('、')));
  } else if (paths.length === 1) {
    box.append(el('div', { class: 'note', style: 'color:var(--warn)' },
      '⚠ 只接上了 1 条通行线 —— 门至少要接两条才有意义（两侧各一条），否则连不出新路径'));
    box.append(el('div', { class: 'hint' }, paths[0]));
  } else {
    box.append(el('div', { class: 'note', style: 'color:var(--warn)' },
      '⚠ 还没有通行线接到它边缘上 —— 把两侧的线各收一段，停在它的边上'));
  }
  return box;
}

/**
 * 跨层设施的「单向」设置。
 *
 * ★ 扶梯在机场常常是单向的：这一部只上不下，要下去得走旁边那部。
 *   只有【正好两个楼层】的组才有方向可言 —— 三个层以上说「单向」是含糊的
 *   （从 A 能到 B，那 B 到 C 呢？），所以只在两层时才显示这个控件。
 */
/**
 * 跨层设施：【连通哪些楼层】。
 *
 * ★ 这个控件改的是"成员"，不是某个字段。
 *   跨层设施在每个连通的楼层上各有一个点（同坐标、共用一个 verticalGroup），
 *   所以「让这部扶梯也通到五层」= 在五层补一个同坐标的点；
 *   「不通二层了」= 把二层的那个成员删掉。
 *   只改 verticalLevels 字段而不增删成员的话，字段和实际成员会对不上，
 *   建图时按哪个走都是错的。
 */
function verticalLevelRows(f) {
  const gid = f.properties.verticalGroup;
  const members = ed.facilities.features.filter((x) => x.properties.verticalGroup === gid);
  const has = new Set(members.map((m) => m.properties.level));
  const all = ed.levelIds();

  /** 改完之后，所有成员身上的 verticalLevels 都要重新对齐 */
  const sync = (list) => {
    for (const m of ed.facilities.features) {
      if (m.properties.verticalGroup !== gid) continue;
      if (list.length >= 2) m.properties.verticalLevels = list;
      else delete m.properties.verticalLevels;
      /*
       * ★ 单向只在【正好两层】时才有意义。
       *   层数变了还留着 verticalOneWay，那就是个悬空引用 ——
       *   建图时会按一个不存在的方向去连，路由结果莫名其妙。
       */
      if (list.length !== 2) delete m.properties.verticalOneWay;
    }
  };

  const toggle = (lv) => {
    if (has.has(lv)) {
      if (members.length <= 2) return toast('跨层设施至少得连通两层 —— 想拆掉整组，直接删这些点', 'err');
      const victim = members.find((m) => m.properties.level === lv);
      ed.pushUndo();
      ed.facilities.features = ed.facilities.features.filter((x) => x !== victim);
      const rest = ed.levelIds().filter((x) => has.has(x) && x !== lv);
      sync(rest);
      ed.dirty = true;
      toast(`已断开 ${levelName(lv)}（删掉了那一层的点）`, 'ok');
    } else {
      const src = members[0];
      ed.pushUndo();
      const feat = ed.newFeature('facilities', {
        type: 'Point', coordinates: JSON.parse(JSON.stringify(src.geometry.coordinates)),
      });
      Object.assign(feat.properties, JSON.parse(JSON.stringify(src.properties)));
      feat.properties.level = lv;
      feat.properties.verified = false;      // 新加的这层没人核实过
      ed.facilities.features.push(feat);
      const list = ed.levelIds().filter((x) => has.has(x) || x === lv);
      sync(list);
      ed.dirty = true;
      toast(`已连通 ${levelName(lv)}（在那一层的同一坐标补了一个点）`, 'ok');
    }
    renderPanels(); requestDraw();
  };

  const row = el('div', { class: 'field wide' });
  row.append(el('div', { style: 'font-size:11.5px;color:var(--fg3);margin-bottom:3px' },
    `连通楼层（组 ${gid}）—— 点亮/熄灭来增删`));
  const box = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
  for (const lv of all) {
    const on = has.has(lv);
    box.append(el('button', {
      class: on ? 'on' : '',
      title: on ? `断开 ${levelName(lv)}（删掉那一层的点）` : `连通 ${levelName(lv)}（在那一层补一个同坐标的点）`,
      onclick: () => toggle(lv),
    }, levelName(lv)));
  }
  row.append(box);

  const extra = all.filter((lv) => has.has(lv) && !members.some((m) => m.properties.level === lv));
  row.append(el('div', { class: 'hint' },
    `当前连通 ${has.size} 层：${ed.levelIds().filter((x) => has.has(x)).map(levelName).join('、')}`
    + (extra.length ? `　⚠ ${extra.map(levelName).join('、')} 声明了但没有对应成员` : '')
    + (has.size < 2 ? '　⚠ 少于两层，这个组不会参与建图' : '')));
  return [row];
}

function verticalOneWayRows(f, key) {
  const gid = f.properties.verticalGroup;
  const members = ed.facilities.features.filter((x) => x.properties.verticalGroup === gid);
  const levels = [...new Set(members.map((m) => m.properties.level))];
  if (levels.length !== 2) {
    return [el('div', { class: 'field wide' },
      el('div', { class: 'note' },
        `跨层组 ${gid} 连通 ${levels.length} 个楼层（${levels.join('、')}）—— 三层以上不设单向`))];
  }
  const ow = members.find((m) => m.properties.verticalOneWay)?.properties.verticalOneWay ?? null;
  const [a, b] = levels;

  const apply = (from, to) => {
    /*
     * ★ 走 ed.setProps，不要直接改 m.properties。
     *   直接改绕过了编辑器的改动追踪（脏标记、缓存失效），
     *   会出现「点了看着变了、存下去却没有」或者下次渲染被旧值盖回来。
     *
     * ★ 点完一定要有反馈。之前完全静默 —— 用户根本判断不出生效没有，
     *   只能靠反复点、反复看，最后觉得「点了没反应」。
     */
    ed.pushUndo();
    for (const m of members) {
      ed.setProps('facilities', m.id, {
        verticalOneWay: (from && to) ? { from, to } : undefined,
      });
    }
    ed.dirty = true;
    toast(from && to
      ? `已设为单向：只能 ${levelName(from)} → ${levelName(to)}`
      : '已设为双向（两个方向都能走）', 'ok');
    renderPanels(); requestDraw();
  };

  const row = el('div', { class: 'field wide' });
  row.append(el('div', { style: 'font-size:11.5px;color:var(--fg3);margin-bottom:3px' }, '方向'));
  const box = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
  const mk = (label, from, to) => {
    /*
     * ★ 激活判断必须分开写。
     *   原来「双向」用的是 `ow && ow.from === from && ow.to === to`，
     *   而双向时 ow 是 null —— `ow &&` 直接短路成假，
     *   所以【双向那个按钮永远不可能点亮】。
     */
    const active = (from && to)
      ? !!ow && ow.from === from && ow.to === to
      : !ow;
    return el('button', {
      class: active ? 'on' : '',
      title: active ? '当前生效' : '点这里切换',
      onclick: () => apply(from, to),
    }, label);
  };
  box.append(
    mk('双向', null, null),
    mk(`${levelName(a)} → ${levelName(b)}`, a, b),
    mk(`${levelName(b)} → ${levelName(a)}`, b, a),
  );
  row.append(box);
  row.append(el('div', { class: 'hint' },
    ow ? `当前：单向，只能 ${levelName(ow.from)} → ${levelName(ow.to)}，反向走不了`
      : '当前：双向，两个方向都能走'));
  return [row];
}

const levelName = (lv) => ed.manifest?.levels?.[lv]?.name ?? lv;

function closePolygon() {
  const d = ia.draft;
  ia.draft = null;
  if (!d || d.points.length < 3) { toast('至少 3 个点', 'err'); return; }
  const key = modeToLayer(d.mode);
  const ring = d.points.map((p) => [r2(p[0]), r2(p[1])]);
  ring.push(ring[0].slice());
  const feat = ed.newFeature(key, { type: 'Polygon', coordinates: [ring] });

  if (d.mode === 'regions') feat.properties.kind = ia.regionKind;
  // ★ 不再自动算门。房间的门 = 通行线吸附到它边缘上的那个点，由编辑器实时算出来。
  //   存一个 door 字段的话，挪动通行线之后它就过期了。

  // 几何有效性即时反馈 —— 别等到跑校验器才发现
  if (G.ringSelfIntersects(ring)) toast('这个面自交了（边交叉），路径会算错', 'err');
  const area = G.polygonArea([ring]);
  if (area < 1) toast(`面积只有 ${area.toFixed(2)} m²，太小了`, 'err');

  ed.add(key, feat);

  if (d.mode === 'facArea') {
    // ★ 房间的可达性不在这里判断 —— 它的门 = 通行线吸附到它边缘上的那个点。
    //   画完先提示「还没接上」，用户把通行线拖到墙上就通了。
    toast(`已加房间 ${feat.id} —— 把通行线拖到它墙上，它才可达`, 'ok');
  }
  if (d.mode === 'obstacles') {
    const c = G.polygonCentroid(feat.geometry.coordinates);
    if (!regionAt(c, ed.currentLevel)) {
      toast('⚠ 障碍物画在区域外 —— 画在外面它什么也挡不住（和面状设施正好相反）', 'err');
    }
  }
  renderPanels(); requestDraw();
}

/**
 * 跨隔离区的连接件（安检/边检/海关/检疫/中转/出口）：点入口、再点出口。
 *
 * ★ 它和跨层设施是两种东西：
 *   跨层设施是【点】—— 各层同坐标，靠 verticalGroup 相连；
 *   跨区连接件是【边】—— 入口到出口有一段实际要走的路（排队区），
 *   本身就是图上的一条边。硬塞成一个点会丢掉这段距离。
 */
function finishConnector(a, b) {
  const fromZone = regionAt(a, ed.currentLevel)?.properties.zone ?? ed.currentZone;
  const toZone = regionAt(b, ed.currentLevel)?.properties.zone ?? ed.currentZone;
  const type = ia.connType && ed.manifest?.connectorTypes?.[ia.connType]
    ? ia.connType
    : inferConnectorType(fromZone, toZone, ed.currentLevel, ed.currentLevel);
  const t = Math.round((new Date().getTime() % 100000));
  const feat = {
    type: 'Feature',
    id: `cn-${type.slice(0, 4)}-${ed.currentLevel.toLowerCase()}-${t}`,
    geometry: { type: 'Point', coordinates: [r2((a[0] + b[0]) / 2), r2((a[1] + b[1]) / 2)] },
    properties: {
      connectorType: type, name: '', nameEn: '',
      from: { level: ed.currentLevel, x: r2(a[0]), y: r2(a[1]), zone: fromZone },
      to: { level: ed.currentLevel, x: r2(b[0]), y: r2(b[1]), zone: toZone },
      ...connectorDefaults(type, ed.currentLevel, ed.currentLevel),
      verified: false,
    },
  };
  ed.add('connectors', feat);
  const wa = regionAt(a, ed.currentLevel), wb = regionAt(b, ed.currentLevel);
  if (!wa || !wb) toast('⚠ 端点没落在通行线上 —— 图会断在这里，请把端点拖到线上', 'err');
  else if (fromZone !== toZone) toast(`跨越 ${fromZone} → ${toZone}`, 'ok');
  else toast(`已创建 ${feat.id}`, 'ok');
  renderPanels(); requestDraw();
}

function inferConnectorType(fromZone, toZone, fromLevel, toLevel) {
  if (fromLevel !== toLevel) return 'escalator';
  if (fromZone !== toZone) {
    const r = (ed.manifest.zoneRules?.allowedTransitions ?? [])
      .find((x) => x.from === fromZone && x.to === toZone);
    if (r?.via?.length) {
      const proc = r.via.find((v) => ed.manifest.connectorTypes[v]?.category === 'process');
      return proc ?? r.via[0];
    }
  }
  return 'travelator';
}

function connectorDefaults(type, fromLevel, toLevel) {
  const ct = ed.manifest.connectorTypes[type] ?? {};
  const tm = { ...(ed.manifest.timeModel?.connectorTime?.[type] ?? {}) };
  delete tm.note;
  const span = Math.abs((ed.manifest.levels[toLevel]?.order ?? 0) - (ed.manifest.levels[fromLevel]?.order ?? 0)) || 1;
  const travel = (tm.base ?? 3) + (tm.perLevel ?? 0) * Math.max(0, span - 1);

  // ★ 单向判定的优先级：
  //   1. connectorTypes[type].oneWay 显式声明（安检/边检/海关/检验检疫/到达出口都是单向）
  //   2. 垂直连接件（扶梯/楼梯/坡道）默认单向 —— 大兴大量扶梯只上不下
  //   3. 其余（电梯/自动步道/中转柜台）双向
  //   早期版本只看 horizontal，结果自动创建的安检是双向的 ——
  //   旅客会被规划出「倒着穿过安检回到外面」的路线。
  const oneWay = ct.oneWay ?? (ct.horizontal === false);

  return {
    bidirectional: !oneWay,
    direction: oneWay ? (ct.horizontal === false ? 'up' : 'forward') : 'both',
    accessible: ct.accessible ?? true,
    travel_time: Math.round(travel),
    wait_time: tm.wait ?? 0,
  };
}

/* ============================================================ 校准 */

/*
 * 两点定比例 / 量距核对这两个模式已经删掉了。
 * 底图的比例、旋转、位置现在全部由「底图」(G) 模式的拖拽手柄直接调 ——
 * 拖角缩放、拖圆点旋转、拖框内移动，框上有实时数值。
 * 精确值仍然可以在左侧「平面图与校准」面板里手填 m/px。
 */

/* ============================================================ 键盘 */

window.addEventListener('keydown', (ev) => {
  // ★ 只在「正在输入文字」时让开快捷键。
  //   早先一棍子把所有 INPUT/SELECT 都排除掉，结果是：选完类别焦点还留在 <select> 上，
  //   再按 W / F / V 这些模式键全部没反应 —— 用户得先点一下别处才能继续。
  const t = ev.target;
  const tag = t?.tagName;
  const isTextEntry = tag === 'TEXTAREA'
    || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(t.type));
  if (isTextEntry) return;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); doSave(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    (ev.shiftKey ? ed.redoStep() : ed.undoStep());
    renderPanels(); requestDraw(); return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); ed.redoStep(); renderPanels(); requestDraw(); return; }

  /*
   * 复制 / 粘贴。
   * ★ 必须挡在模式键前面 —— 否则 Ctrl+C 会被当成按了 C。
   *   而且要用 ev.key.toLowerCase() 判，别用 ev.code：
   *   中文输入法下 code 仍然是对的，但大写锁定/组合键时 key 更可靠。
   */
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') { ev.preventDefault(); return copyFeature(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') { ev.preventDefault(); return pasteFeature(); }

  if (ev.key === 'Escape') {
    if ($('modal').classList.contains('on')) return closeModal();
    ia.draft = null; ia.drag = null; ed.selection = null; renderPanels(); requestDraw(); return;
  }
  if (ev.key === 'Enter' && ia.draft?.kind === 'polygon') return closePolygon();
  if (ev.key === 'Enter' && ia.draft?.kind === 'polyline') return finishPolyline();
  if (ev.key === 'Backspace' && ia.draft?.points?.length) { ia.draft.points.pop(); requestDraw(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') return doDelete();
  if (ev.key === '?') return showHelp();
  // ★ 适应视图用 0（CAD/GIS 惯例），不能用 F —— F 已经是「画面状设施」模式键。
  //   两者冲突时，先检查的那个会永远赢，另一个快捷键就静默失效了。
  if (ev.key === '0' || ev.key === 'Home') { fitTo(ed, view, canvas); requestDraw(); return; }

  const m = MODES.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
  if (m) { setMode(m.id); return; }
});

function setMode(id) {
  ia.mode = id;
  ia.draft = null;
  if (id === 'rooms') ed.currentZone = ed.currentZone;
  renderToolbar(); renderHint(); requestDraw();
}

function doDelete() {
  if (!ed.selection) return;
  const { key, id } = ed.selection;
  if (ed.remove(key, id)) { toast(`已删除 ${id}`); renderPanels(); requestDraw(); }
}

/**
 * 保存前的客户端体检。
 *
 * ★ 服务端也有一道同样的闸，两边都要有：
 *   服务端拦得住「坏状态写盘」，但拦不住「用户以为存上了」——
 *   客户端先拦，才能立刻给出人话解释，而不是弹一个 409。
 *
 * 这里检查的都是「绝不可能是合法意图」的退化状态，不做任何启发式猜测。
 */
function saveSanityProblems() {
  const p = [];
  if (ed.currentLevel == null) p.push('当前楼层是空的 —— 数据没加载完');
  if (Object.keys(ed.levels).some((k) => k === 'null' || k === 'undefined')) {
    p.push('楼层表里有 "null" 条目 —— 说明有代码在空楼层上建过数据');
  }
  if (Object.keys(ed.calibration.levels ?? {}).some((k) => k === 'null')) {
    p.push('底图校准里有 "null" 楼层');
  }
  const total = ed.paths.features.length + ed.facilities.features.length
    + ed.obstacles.features.length + ed.connectors.features.length;
  if (total === 0) p.push('所有图层都是空的 —— 多半是页面没加载成功就开始保存了');
  return p;
}

/* ============================================================ 自动保存 */

/**
 * 自动保存 + 离开拦截。
 *
 * ★ 为什么必须做：用户摆了十几个底图，点了一下浏览器的「后退」——
 *   全没了。这不是"下次注意"，是工具缺了一层最基本的保护。
 *
 * 三层保护，一层比一层靠前：
 *
 *   ① beforeunload —— 有未保存改动时，浏览器弹「确定要离开吗」。
 *      这一层【最关键】：它拦住的正是「误点后退/关闭标签页」这种事故。
 *      注意浏览器不允许自定义提示文字，只能给标准对话框 ——
 *      但「有东西没保存」这个事实本身就能让人停手。
 *
 *   ② 定时自动保存 —— 默认 60 秒，只在【有改动】时触发。
 *      走的是同一个 doSave()，所以之前所有护栏都还在：
 *      退化状态拦截、陈旧时间戳拦截、保存前快照。
 *
 *   ③ 状态灯 —— 顶栏显示「已保存 / 有未保存改动 / 自动保存于 12:03」。
 *      用户随时知道自己的东西在不在盘上。
 */
const AUTOSAVE_MS = 60_000;
let autosaveTimer = 0;
let autosaveEnabled = true;
let lastSavedAt = null;

function fmtTime(d) {
  return d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}

/** 顶栏状态灯。 */
function renderSaveStatus(state) {
  const el = $('saveStatus');
  if (!el) return;
  /*
   * 不传 state 就【按 ed.dirty 现算】——
   * ed.dirty 有 20 处设置点，逐个挂钩迟早会漏一个，
   * 轮询当前值反而不会漏。
   */
  const st = state ?? (ed?.dirty ? 'dirty' : 'saved');
  const map = {
    saved: ['已保存', lastSavedAt ? `自动保存于 ${fmtTime(lastSavedAt)}` : '所有改动都已写入磁盘'],
    dirty: ['有未保存改动', '点「保存」立即写盘；不点的话 60 秒后自动保存'],
    saving: ['保存中…', '正在写入'],
    error: ['保存失败', '看提示 —— 改动还在内存里，别关页面'],
  };
  const [txt, title] = map[st] ?? map.saved;
  el.textContent = txt;
  el.title = title;
  el.className = `save-status ${st}`;
}

/** 自动保存一轮。只在有改动时真的写盘。 */
async function autosaveTick() {
  if (!autosaveEnabled) return;
  if (!ed?.dirty) return;
  /*
   * ★ 自动保存【不强行绕过】退化状态拦截。
   *   强行保存是给人在看到警告后做的决定，自动化流程不该替人做这个决定 ——
   *   真出问题就是静默写坏数据，比丢改动严重得多。
   */
  if (saveSanityProblems().length) {
    renderSaveStatus('error');
    toast('自动保存已跳过：数据状态看起来是坏的，请手动检查后保存', 'err');
    autosaveEnabled = false;              // 别每 60 秒骚扰一次
    return;
  }
  renderSaveStatus('saving');
  saveBusy = true;
  const r = await doSave(false, { silent: true });
  saveBusy = false;
  if (r) lastSavedAt = new Date();
  renderSaveStatus(r ? 'saved' : 'error');
}

function startAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(autosaveTick, AUTOSAVE_MS);
  // 状态灯每 800ms 刷一次 —— 比挂钩 20 处 ed.dirty 可靠
  setInterval(() => { if (!saveBusy) renderSaveStatus(); }, 800);
  renderSaveStatus();
  /*
   * ★ beforeunload —— 这一层是这次事故的直接解药。
   *   有未保存改动就交给浏览器弹确认框。
   *   浏览器不允许自定义提示文字，只能给标准对话框 ——
   *   但「有东西没保存」这个事实本身就足以让人停手。
   */
  window.addEventListener('beforeunload', (ev) => {
    if (!ed?.dirty) return undefined;
    ev.preventDefault();
    ev.returnValue = '有未保存的改动，确定离开吗？';
    return ev.returnValue;
  });
}

let saveBusy = false;

async function doSave(force = false, opt = {}) {
  const btn = $('btnSave');
  const problems = saveSanityProblems();
  if (problems.length && !force) {
    return modal('这次保存看起来是坏的', el('div', {},
      el('div', { class: 'note', style: 'margin-bottom:8px' },
        '下面这些状态不可能是正常的编辑结果。已拦住，磁盘没有被改动：'),
      el('ul', { style: 'margin:0 0 12px 18px;color:var(--err);line-height:1.7' },
        ...problems.map((x) => el('li', {}, x))),
      el('div', { class: 'note', style: 'margin-bottom:12px' },
        '最可能的原因：页面是在数据加载成功之前打开的。',
        el('br'), '★ 先刷新页面（F5）让它重新加载，再保存。'),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => { closeModal(); location.reload(); } }, '刷新页面'),
        el('button', { onclick: () => { closeModal(); doSave(true); } }, '仍要强行保存'),
        el('button', { onclick: closeModal }, '取消'))));
  }

  btn.disabled = true; btn.textContent = '保存中…';
  saveBusy = true;
  try {
    const r = await ed.save();
    if (r.ok) {
      // 自动保存是静默的 —— 每 60 秒弹一条 toast 会把屏幕刷满
      if (!opt.silent) {
        toast(`已写入 ${r.written.length} 个文件`
          + `${r.rejected?.length ? `，${r.rejected.length} 个被拒绝` : ''}`
          + `${r.backup ? '（已备份到 ' + r.backup + '）' : ''}`, 'ok');
      }
      if (r.rejected?.length) toast('被拒绝：' + r.rejected.join(', '), 'err');
      return r;
    } else {
      /*
       * ★ 服务端拦下来时【必须弹常驻对话框】，不能只弹 toast。
       *   曾经这里只在有 problems 数组时才弹窗，「磁盘比你新」这种拒绝
       *   只走 toast —— 3.6 秒就消失。用户按了保存、以为存上了、刷新，
       *   改动全没了，而且完全不知道为什么。
       */
      toast(r.error ?? '保存失败', 'err');
      if (r.stale) {
        modal('没有保存 —— 磁盘上的数据比你打开页面时新', el('div', {},
          el('div', { class: 'note', style: 'margin-bottom:10px' },
            '你的改动【一个字节都没写进去】。磁盘没有被改动。'),
          el('div', { class: 'note', style: 'margin-bottom:10px' },
            '原因：这个页面打开之后，data/source 里的文件被别的东西改过了'
            + '（改了代码、跑过脚本、另一个标签页保存过）。'
            + '这时候直接保存会把中间那些改动整个盖掉，所以拦住了。'),
          el('div', { class: 'note', style: 'margin-bottom:12px;color:var(--warn)' },
            '★ 刷新页面重新加载，然后重新做刚才的改动。'),
          el('div', { class: 'actions' },
            el('button', { class: 'primary', onclick: () => location.reload() }, '刷新页面'),
            el('button', { onclick: () => { closeModal(); doSave(true); } }, '仍要强行覆盖'),
            el('button', { onclick: closeModal }, '取消'))));
      } else if (r.problems?.length) {
        modal('服务端拒绝了这次保存', el('div', {},
          el('div', { class: 'note', style: 'margin-bottom:8px' }, r.error ?? ''),
          el('ul', { style: 'margin:0 0 12px 18px;color:var(--err);line-height:1.7' },
            ...r.problems.map((x) => el('li', {}, x))),
          el('div', { class: 'actions' },
            el('button', { onclick: () => { closeModal(); location.reload(); } }, '刷新页面'),
            el('button', { onclick: () => { closeModal(); doSave(true); } }, '仍要强行保存'),
            el('button', { onclick: closeModal }, '取消'))));
      } else {
        modal('保存失败', el('div', {},
          el('div', { class: 'note', style: 'margin-bottom:12px' }, r.error ?? '未知原因'),
          el('div', { class: 'actions' }, el('button', { onclick: closeModal }, '知道了'))));
      }
    }
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
  saveBusy = false;
  btn.disabled = false; btn.textContent = '保存';
  updateStatus();
  renderSaveStatus('error');
  return null;
}

async function doValidate() {
  const btn = $('btnValidate');
  btn.disabled = true; btn.textContent = '校验中…';
  try {
    const r = await ed.validate();
    renderIssues();
    const c = r.counts ?? {};
    toast(`校验完成：ERROR ${c.ERROR ?? 0} · WARN ${c.WARN ?? 0}`, c.ERROR ? 'err' : 'ok');
  } catch (e) { toast('校验失败：' + e.message, 'err'); }
  btn.disabled = false; btn.textContent = '校验';
}

/* ============================================================ 面板 */

function renderToolbar() {
  const wrap = $('modes');
  wrap.replaceChildren(...MODES.map((m) => el('button', {
    class: ia.mode === m.id ? 'on' : '',
    title: `${m.hint}  快捷键 ${m.key}`,
    onclick: () => setMode(m.id),
  }, `${m.label} ${m.key}`)));

  const zs = $('zoneSel');
  const zones = Object.keys(ed.manifest?.zones ?? {}).filter((k) => !k.startsWith('_'));
  zs.replaceChildren(...zones.map((z) => el('option', { value: z, selected: z === ed.currentZone },
    ed.manifest.zones[z].name ?? z)));
  zs.onchange = () => { ed.currentZone = zs.value; zs.blur(); };
}
function syncZoneSel() { $('zoneSel').value = ed.currentZone; }

function renderHint() {
  const m = MODES.find((x) => x.id === ia.mode);
  const h = $('hint');
  if (!m) { h.classList.remove('on'); return; }
  h.classList.add('on');
  const extra = [];
  const picker = (label, table, current, onPick) => el('div', { style: 'margin-top:6px;display:flex;gap:6px;align-items:center' },
    el('span', { class: 'k' }, label),
    (() => {
      const s = el('select', { style: 'width:auto;max-width:380px' });
      for (const k of Object.keys(table ?? {}).filter((x) => !x.startsWith('_')))
        s.append(el('option', { value: k, selected: k === current }, `${table[k].name}  (${k})`));
      // 选完就还焦点给画布，否则接着按 W / F 这些模式键会被 <select> 吃掉
      s.onchange = () => { onPick(s.value); s.blur(); };
      return s;
    })());

  if (ia.mode === 'regions') extra.push(picker('种类', ed.manifest?.regionKinds, ia.regionKind, (v) => { ia.regionKind = v; }));
  if (ia.mode === 'regions') {
    extra.push(el('div', { class: 'note', style: 'margin-top:6px' },
      '区域只标记隔离区。旅客走哪条路，完全由通行线（L）决定。'));
  }
  // ★ 面状和点状设施共用同一张类别表 —— 它们本来就是同一种东西
  if (ia.mode === 'facArea' || ia.mode === 'facPoint') {
    const cats = Object.entries(ed.manifest?.facilityCategories ?? {}).filter(([k]) => !k.startsWith('_'));
    // ★ 类别现在分了组（process / facility / rest / commerce…），下拉里用 optgroup 归拢，
    //   36 个选项平铺会很难找。
    const byGroup = new Map();
    for (const [k, v] of cats) {
      const g = v.group ?? '其他';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push([k, v]);
    }
    const GROUP_LABEL = {
      process: '流程点', facility: '设施', service: '服务', rest: '休息',
      commerce: '商业', transport: '交通', medical: '医疗', vertical: '跨层设施',
    };
    const sel = el('select', { style: 'width:auto;max-width:240px' });
    for (const [g, list] of byGroup) {
      const og = el('optgroup', { label: GROUP_LABEL[g] ?? g });
      for (const [k, v] of list) og.append(el('option', { value: k, selected: k === ed.currentCategory }, v.name));
      sel.append(og);
    }
    sel.onchange = () => { ed.currentCategory = sel.value; sel.blur(); renderPanels(); requestDraw(); };
    extra.push(el('div', { style: 'margin-top:6px;display:flex;gap:6px;align-items:center' },
      el('span', { class: 'k' }, '类别'), sel));
    if (ia.mode === 'facPoint' && isVerticalCategory(ed.currentCategory)) {
      extra.push(el('div', { class: 'note', style: 'margin-top:6px;color:var(--cyan)' },
        '★ 这是【跨层设施】。点击地图后会弹出选楼层的对话框 ——',
        el('br'), '会在你勾选的每一层【同一个坐标】上各建一个点，它们在寻路上相通。'));
    }
  }
  if (ia.mode === 'obstacles') extra.push(picker('种类', ed.manifest?.obstacleKinds, ed.currentObstacleKind, (v) => { ed.currentObstacleKind = v; }));
  if (ia.mode === 'connect') {
    const types = Object.entries(ed.manifest?.connectorTypes ?? {}).filter(([k]) => !k.startsWith('_'));
    const vert = types.filter(([, v]) => v.horizontal === false);
    const horiz = types.filter(([, v]) => v.horizontal !== false);
    const sel = el('select', { style: 'width:auto;max-width:240px' });
    const add = (label, list) => {
      const g = el('optgroup', { label });
      for (const [k, v] of list) g.append(el('option', { value: k, selected: k === ia.connType }, v.name));
      sel.append(g);
    };
    add('跨层', vert);
    add('跨隔离区', horiz);
    sel.onchange = () => { ia.connType = sel.value; sel.blur(); renderPanels(); requestDraw(); };
    extra.push(el('div', { style: 'margin-top:6px;display:flex;gap:6px;align-items:center' },
      el('span', { class: 'k' }, '类型'), sel));
    const t = ed.manifest?.connectorTypes?.[ia.connType] ?? {};
    extra.push(el('div', { class: 'note', style: 'margin-top:6px' },
      t.horizontal === false
        ? el('span', { style: 'color:var(--cyan)' }, '★ 跨层设施：点击地图后会弹出选楼层，自动在各层同一坐标建点。')
        : '跨隔离区连接件：点入口 → 点出口。中间那段路就是排队区，会算进路径长度。'));
  }
  if (ia.mode === 'paths') {
    extra.push(picker('种类', ed.manifest?.pathKinds, ed.currentPathKind, (v) => { ed.currentPathKind = v; }));
    const g = graphPreview();
    if (g) {
      extra.push(el('div', { class: 'note', style: 'margin-top:6px' },
        `本层路网：${g.stats.nodes} 节点 · ${g.stats.junctions} 个路口 · ${(g.stats.totalLength / 1000).toFixed(2)} km　`,
        el('span', { style: 'color:var(--fg3)' }, '（交叉处会自动生成路口）')));
    }
    if (ia.draft?.points?.length) {
      extra.push(el('div', { class: 'note', style: 'margin-top:4px' },
        `已放 ${ia.draft.points.length} 个顶点　Enter 结束　Backspace 退一个　Esc 取消`));
    }
    /*
     * ★ 这里【没有】「给无名通行线命名」的按钮，是刻意的。
     *   通行线的称呼来自它的种类（走廊 / 主通道 / 支线…），不需要逐条取名。
     *   导航里念的是种类名，旅客听得懂；生成「走廊 12」这种编号反而没意义。
     */
  }

  if (ia.draft?.points?.length) {
    extra.push(el('div', { class: 'note', style: 'margin-top:6px' },
      `已放 ${ia.draft.points.length} 个点　Enter 闭合　Backspace 退一个　Esc 取消`));
  }
  h.replaceChildren(el('div', {}, m.hint), ...extra);
}

function renderLevels() {
  const wrap = $('levelList');
  const ids = ed.levelIds();
  const drawnCount = ed.drawnLevelIds().length;
  $('levelHint').textContent = `${drawnCount} / ${ids.length} 已画`;
  wrap.replaceChildren(...ids.map((lv) => {
    const meta = ed.manifest.levels[lv] ?? {};
    const pack = ed.levels[lv];
    // ★ 楼层包里现在只有 regions（隔离区标记）—— 设施是全局一份、靠 properties.level 归属楼层。
    //   早期版本这里读 pack.rooms，重构后 rooms 没了就直接抛异常。
    const walkN = pack ? (pack.regions?.features.length ?? 0) : 0;
    const facN = ed.facilities.features.filter((f) => f.properties?.level === lv).length;
    const calN = ed.calMaps(lv).filter((m) => m.image).length;
    return el('div', {
      class: `row ${lv === ed.currentLevel ? 'on' : ''}`,
      onclick: () => { ed.currentLevel = lv; ed.selection = null; loadMapImagesFor(lv); renderPanels(); requestDraw(); },
    },
      el('span', { class: 'swatch', style: `background:${pack ? 'var(--cyan)' : 'var(--line2)'}` }),
      el('span', { class: 't' }, meta.name ?? lv,
        el('div', { class: 'sub' },
          `${lv} · 区域 ${walkN} · 设施 ${facN}${pack ? '' : ' · 未画'}${calN ? ` · 底图 ${calN}` : ''}`)),
      el('span', { class: 'sub' }, String(meta.order ?? '')),
    );
  }));
}

/**
 * 平面图与校准面板。
 *
 * 一层可以放多张底图，每张独立控制缩放 / 旋转 / 位置 / 透明度。
 * 「当前底图」（蓝框那张）是 K/M 工具作用的对象，画布上会用青色虚线框标出来。
 */
function renderCalib() {
  const wrap = $('calibPanel');
  const lv = ed.currentLevel;
  const maps = ed.calMaps(lv);
  const active = ed.activeMap(lv);

  /* ---- 添加底图 ---- */
  const addSel = el('select', {},
    el('option', { value: '' }, ed.plans.length ? '＋ 添加底图…' : '＋ plans/ 目录里没有图片'));
  for (const p of ed.plans) {
    // 已经加过的标出来，但仍然可以再加一次（同一张图放两个位置是合法的）
    const used = maps.filter((m) => m.image === p.name).length;
    addSel.append(el('option', { value: p.name }, used ? `${p.name}（已用 ${used} 次）` : p.name));
  }
  addSel.onchange = async () => {
    if (!addSel.value) return;
    const map = ed.addCalMap(lv, { image: addSel.value });
    await loadMapImage(map);
    renderPanels(); requestDraw();
    toast(`已添加底图「${map.label}」—— 按 K 给它定比例`, 'ok');
  };

  /* ---- 每张底图的卡片 ---- */
  const card = (map, i) => {
    const isActive = active && map.id === active.id;
    const num = (key, step, dflt = 0) => {
      const inp = el('input', { type: 'number', step, value: map[key] ?? dflt });
      inp.onchange = () => { ed.updateCalMap(lv, map.id, { [key]: Number(inp.value) }); requestDraw(); };
      return inp;
    };
    const pair = (key, step) => el('div', { class: 'duo' },
      (() => {
        const a = el('input', { type: 'number', step, value: map[key]?.[0] ?? 0 });
        a.onchange = () => { ed.updateCalMap(lv, map.id, { [key]: [Number(a.value), map[key]?.[1] ?? 0] }); requestDraw(); };
        return a;
      })(),
      (() => {
        const b = el('input', { type: 'number', step, value: map[key]?.[1] ?? 0 });
        b.onchange = () => { ed.updateCalMap(lv, map.id, { [key]: [map[key]?.[0] ?? 0, Number(b.value)] }); requestDraw(); };
        return b;
      })());

    return el('div', {
      class: `mapcard ${isActive ? 'on' : ''}`,
      onclick: (e) => {
        // 点卡片本身 = 设为当前底图；点里面的控件不抢
        if (e.target.closest('input,select,button')) return;
        ed.setActiveMap(lv, map.id);
        renderPanels(); requestDraw();
      },
    },
      el('div', { class: 'head' },
        el('span', { class: 'dot', style: `background:${map.visible === false ? 'var(--line2)' : 'var(--cyan)'}` }),
        (() => {
          const t = el('input', { type: 'text', class: 'label', value: map.label ?? '', placeholder: `底图 ${i + 1}` });
          t.onchange = () => ed.updateCalMap(lv, map.id, { label: t.value });
          return t;
        })(),
        el('span', { class: 'sub' }, `#${i + 1}`),
        el('button', { class: 'mini', title: '往上叠一层', disabled: i === maps.length - 1,
          onclick: () => { ed.moveCalMap(lv, map.id, 1); renderPanels(); requestDraw(); } }, '↑'),
        el('button', { class: 'mini', title: '往下叠一层', disabled: i === 0,
          onclick: () => { ed.moveCalMap(lv, map.id, -1); renderPanels(); requestDraw(); } }, '↓'),
        el('button', { class: 'mini', title: map.visible === false ? '显示' : '隐藏',
          onclick: () => { ed.updateCalMap(lv, map.id, { visible: map.visible === false }); renderPanels(); requestDraw(); } },
          map.visible === false ? '◌' : '◉'),
        el('button', { class: 'mini danger', title: '移除这张底图',
          onclick: () => {
            ed.removeCalMap(lv, map.id);
            ed.mapImages.delete(map.id);
            renderPanels(); requestDraw();
            toast(`已移除「${map.label}」`);
          } }, '×'),
      ),
      el('div', { class: 'sub file' }, map.image ?? '（未选择图片）'),
      el('div', { class: 'field' }, el('label', {}, '比例 m/px'), num('mPerPx', '0.0001', 0.5)),
      el('div', { class: 'field' }, el('label', {}, '旋转 °'), num('rotationDeg', '0.01', 0)),
      el('div', { class: 'field' }, el('label', {}, '原点 px'), pair('originPx', '1')),
      el('div', { class: 'field' }, el('label', {}, '微调 m'), pair('nudge', '0.1')),
      el('div', { class: 'field' }, el('label', {}, '不透明度'),
        (() => {
          const r = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: map.opacity ?? 0.65 });
          r.oninput = () => { ed.updateCalMap(lv, map.id, { opacity: Number(r.value), visible: true }); requestDraw(); };
          return r;
        })()),
      el('div', { class: 'actions' },
        el('button', { onclick: () => { ed.setActiveMap(lv, map.id); setMode('basemap'); } }, '拖动调整'),
        el('button', {
          onclick: () => {
            ed.setActiveMap(lv, map.id);
            const p = map.originPx ?? [0, 0];
            ed.updateCalMap(lv, map.id, { nudge: [0, 0] });
            renderPanels(); requestDraw();
            toast(`「${map.label}」微调已归零（原点 ${p[0]}, ${p[1]}）`);
          },
        }, '微调归零'),
      ),
    );
  };

  const activeInfo = active
    ? el('div', { class: 'note', style: 'margin-bottom:8px' },
        el('div', {}, `当前底图：`, el('b', {}, active.label || active.id)),
        el('div', {}, `1 m = ${(1 / (active.mPerPx || 1)).toFixed(2)} px　旋转 ${(active.rotationDeg ?? 0).toFixed(2)}°`))
    : el('div', { class: 'note', style: 'margin-bottom:8px' }, '这层还没有底图。先从上面加一张。');

  wrap.replaceChildren(
    el('div', { class: 'field wide' }, addSel),
    el('div', { class: 'note', style: 'margin:-2px 0 10px' },
      '图片放进 ', el('code', {}, 'plans/'), ' 目录即可出现在下拉里。可以放多张，分别校准后叠在一起用。'),
    activeInfo,
    ...(maps.length ? maps.map(card) : [el('div', { class: 'empty' }, '还没有底图。')]),
    el('div', { class: 'actions', style: 'margin-top:10px' },
      el('button', {
        disabled: !active,
        onclick: () => {
          const body = el('div', {},
            el('div', { class: 'note', style: 'margin-bottom:10px' },
              `把「${active.label}」的校准参数（比例 ${active.mPerPx}、旋转 ${active.rotationDeg}°）复制到其他楼层。`,
              el('br'), '适用于各层平面图来自同一个 PDF、像素尺度一致的情况。'),
            el('div', { class: 'actions' },
              ...ed.levelIds().filter((x) => x !== lv).map((x) => el('button', {
                onclick: () => {
                  const m = ed.activeMap(x);
                  if (m) ed.updateCalMap(x, m.id, { mPerPx: active.mPerPx, rotationDeg: active.rotationDeg });
                  else ed.addCalMap(x, { image: active.image, mPerPx: active.mPerPx, rotationDeg: active.rotationDeg });
                  toast(`已复制到 ${x}`, 'ok');
                },
              }, x)),
              el('button', { onclick: closeModal }, '关闭')));
          modal('复制校准参数', body);
        },
      }, '复制到其他层…'),
    ),
  );
}

function renderLayers() {
  const defs = [
    ['regions', '区域（隔离区标记）', 'var(--cyan)'],
    ['paths', '通行线（寻路图）', '#5b8def'],
    ['pathNodes', '　└ 路网节点 / 路口', '#FFD166'],
    ['facilities', '设施（面 + 点）', 'var(--gold)'],
    ['obstacles', '障碍物', 'var(--err)'],
    ['connectors', '连接件', '#FF9F5A'],
  ];
  const wrap = $('layerList');
  const ghostSel = el('select', {},
    el('option', { value: '' }, '— 不显示 —'),
    ...ed.drawnLevelIds().filter((x) => x !== ed.currentLevel)
      .map((x) => el('option', { value: x, selected: x === ia.ghostLevel }, `幽灵层：${ed.manifest.levels[x]?.name ?? x}`)));
  ghostSel.onchange = () => { ia.ghostLevel = ghostSel.value || null; requestDraw(); };

  wrap.replaceChildren(
    ...defs.map(([k, label, color]) => el('label', { class: 'row', style: 'cursor:pointer' },
      el('input', {
        type: 'checkbox', checked: ia.visibleLayers[k] !== false,
        onchange: (e) => { ia.visibleLayers[k] = e.target.checked; requestDraw(); },
      }),
      el('span', { class: 'swatch', style: `background:${color}` }),
      el('span', { class: 't' }, label))),
    el('div', { style: 'margin-top:8px' }, ghostSel),
    el('div', { class: 'note', style: 'margin-top:6px' }, '幽灵层用来跨层对齐扶梯：把下一层以低透明度叠上来，调「微调 m」让扶梯井对上。'),
  );
}

function renderStats() {
  const lv = ed.currentLevel;
  const pack = ed.levels[lv];
  const n = (fc) => fc?.features?.length ?? 0;
  const all = [...ed.allFeatures()];
  const unverified = all.filter(({ f }) => f.properties?.verified !== true).length;
  const area = ed.areaFacilities().filter((f) => f.properties.level === lv).length;
  const point = ed.pointFacilities().filter((f) => f.properties.level === lv).length;
  const g = graphPreview();
  $('stats').innerHTML = [
    `<div>当前层　${lv ?? '—'}</div>`,
    `<div>区域　${n(pack?.regions)}　障碍物　${n(ed.obstacles)}</div>`,
    `<div>通行线　${ed.paths.features.filter((f) => f.properties?.level === lv).length} 条` +
      (g ? `　图 ${g.stats.nodes} 节点 / ${g.stats.junctions} 路口` : '') + `</div>`,
    ...(g ? [`<div>路网总长　${(g.stats.totalLength / 1000).toFixed(2)} km</div>`] : []),
    `<div>设施　面状 ${area} · 点状 ${point}　（全楼层 ${n(ed.facilities)}）</div>`,
    `<div>连接件　${n(ed.connectors)}</div>`,
    `<div>要素合计　${all.length}　未核实　${unverified}</div>`,
    ed.issues ? `<div>上次校验　<span style="color:${(ed.lastValidate?.counts?.ERROR ? 'var(--err)' : 'var(--ok)')}">ERROR ${ed.lastValidate?.counts?.ERROR ?? 0}</span>　WARN ${ed.lastValidate?.counts?.WARN ?? 0}</div>` : '',
  ].join('');
}

/* -------------------------------------------------------- 属性面板 */

function renderProps() {
  const wrap = $('props');
  const sel = ed.selected();
  const hint = $('selHint');
  if (!sel) { hint.textContent = '未选中'; hint.className = 'pill'; wrap.replaceChildren(el('div', { class: 'empty' }, '选中一个要素后在这里改属性。')); return; }
  const { key, f } = sel;
  hint.textContent = f.id;
  hint.className = 'pill';

  const fields = [];

  /*
   * 形状操作：复制 / 粘贴 / 旋转 / 翻转。
   *
   * ★ 放在属性面板最上面，对所有带几何的要素都可用。
   *   复制粘贴是「在 L3F 复制、切到 L4F 粘贴」这个用法 ——
   *   跨层坐标可以直接复用，因为同一栋楼各层是同一个本地坐标系
   *   （电梯/扶梯就是靠同坐标对齐的）。
   */
  if (f.geometry && f.geometry.type !== 'Point') {
    fields.push(el('div', { class: 'actions', style: 'margin:0 0 10px' },
      el('button', { onclick: copyFeature, title: 'Ctrl+C' }, '复制'),
      el('button', {
        onclick: pasteFeature,
        title: '粘贴到【当前楼层】—— 在 L3F 复制、切到 L4F 粘贴，就是复制到别的层',
        disabled: !clipboard,
      }, '粘贴到本层'),
      el('button', { onclick: () => rotateFeature(-90), title: '绕形状中心顺时针转 90°' }, '↻ 90°'),
      el('button', { onclick: () => flipFeature('y'), title: '左右镜像' }, '⇋ 水平翻'),
      el('button', { onclick: () => flipFeature('x'), title: '上下镜像' }, '⇅ 垂直翻'),
    ));
  }
  const ro = (label, val) => fields.push(el('div', { class: 'field' }, el('label', {}, label), el('input', { type: 'text', value: val ?? '', readonly: true })));
  const txt = (label, prop, ph = '') => {
    const i = el('input', { type: 'text', value: f.properties[prop] ?? '', placeholder: ph });
    i.onchange = () => { ed.setProps(key, f.id, { [prop]: i.value }); renderPanelsLite(); };
    fields.push(el('div', { class: 'field' }, el('label', {}, label), i));
  };
  const numF = (label, prop, step = '1') => {
    const i = el('input', { type: 'number', step, value: f.properties[prop] ?? 0 });
    i.onchange = () => { ed.setProps(key, f.id, { [prop]: Number(i.value) }); renderPanelsLite(); };
    fields.push(el('div', { class: 'field' }, el('label', {}, label), i));
  };
  const selF = (label, prop, opts, labels = {}) => {
    const s = el('select', {}, ...opts.map((o) => el('option', { value: o, selected: String(f.properties[prop]) === String(o) }, labels[o] ?? o)));
    s.onchange = () => { ed.setProps(key, f.id, { [prop]: s.value }); renderPanelsLite(); };
    fields.push(el('div', { class: 'field' }, el('label', {}, label), s));
  };
  const chk = (label, prop, dflt = false) => {
    const i = el('input', { type: 'checkbox', checked: f.properties[prop] ?? dflt });
    i.onchange = () => { ed.setProps(key, f.id, { [prop]: i.checked }); renderPanelsLite(); };
    fields.push(el('div', { class: 'field' }, el('label', {}, label), el('div', {}, i)));
  };

  ro('id', f.id);
  ro('类型', key);

  const zoneOpts = Object.keys(ed.manifest.zones).filter((k) => !k.startsWith('_'));
  const zoneLabels = Object.fromEntries(zoneOpts.map((z) => [z, ed.manifest.zones[z].name]));

  const catLabels = Object.fromEntries(
    Object.entries(ed.manifest.facilityCategories)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => [k, v.group && v.group !== '其他' ? `${v.name} · ${k}` : `${v.name} (${k})`]));

  // 面状和点状设施共用一套属性 —— 这正是统一模型的意义。唯一的差别是面状多一个门。
  const isArea = f.geometry?.type === 'Polygon';

  if (key.endsWith('/regions')) {
    selF('zone', 'zone', zoneOpts, zoneLabels);
    selF('kind', 'kind', Object.keys(ed.manifest.regionKinds ?? {}).filter((k) => !k.startsWith('_')),
      Object.fromEntries(Object.entries(ed.manifest.regionKinds ?? {}).map(([k, v]) => [k, v.name])));
    txt('中文名', 'name'); txt('英文名', 'nameEn');
    numF('最小宽 m', 'minWidth', '0.5'); numF('名义宽 m', 'width', '0.5');
    chk('无障碍', 'accessible', true); chk('双向', 'bidirectional', true); chk('已核实', 'verified');

  } else if (key === 'facilities') {
    selF('zone', 'zone', zoneOpts, zoneLabels);
    selF('category', 'category', Object.keys(ed.manifest.facilityCategories).filter((k) => !k.startsWith('_')), catLabels);
    txt('中文名', 'name'); txt('英文名', 'nameEn');
    txt('位置描述', 'location', '如 3F 北指廊西侧');
    txt('营业时间', 'hours', '06:00-22:00');
    chk('无障碍', 'accessible', true); chk('已核实', 'verified');

    const a = el('input', { type: 'text', value: (f.properties.aliases ?? []).join(', ') });
    a.onchange = () => ed.setProps(key, f.id, { aliases: a.value.split(',').map((s) => s.trim()).filter(Boolean) });
    fields.push(el('div', { class: 'field' }, el('label', {}, '别名'), a,
      el('div', { class: 'hint' }, '「星巴克」要能被「Starbucks」「咖啡」搜到 —— 搜索体验的关键')));

    fields.push(...searchFieldRows(f, key));

    /*
     * ★ 跨层设施的「方向」要放在【搜索索引之前】。
     *   它原本排在整段的最后，被搜索索引那一大坨压在面板最底部 ——
     *   用户选中扶梯，滚不到底就以为「没有这个功能」。
     *   单向/双向是跨层设施的主要属性，不是脚注。
     */
    if (!isArea && f.properties.verticalGroup) {
      // 先「连通哪些层」，再「方向」—— 层数决定了方向控件出不出来
      fields.push(...verticalLevelRows(f));
      fields.push(...verticalOneWayRows(f, key));
    }

    if (isArea) {
      /*
       * ★ 「可穿行」不再是一个可勾的框 —— 它由【类别】决定。
       *
       *   安检 / 边检 / 海关 / 国内出口 / 国际出口 这类设施存在的意义
       *   就是让人穿过去，同类之间不该有差别。做成可勾的框，
       *   结果就是【忘了勾】—— 那个出口在图上不是门，两侧的线永远不连通，
       *   而界面上完全看不出任何异常。实测已经因此白查了一轮。
       *
       *   所以：类别声明了 through 就显示成一条只读说明；
       *   只有类别【没声明】的设施才给勾选框（那是"个别确实可穿"的情况）。
       */
      const catThrough = ed.manifest?.facilityCategories?.[f.properties.category]?.through === true;
      if (catThrough) {
        fields.push(el('div', { class: 'field wide' },
          el('label', {}, '可穿行'),
          el('div', { class: 'note', style: 'color:#6FCF97' },
            `✓ 由类别「${ed.manifest.facilityCategories[f.properties.category].name}」决定 —— 自动开启，不用勾`),
          el('div', { class: 'hint' }, '接到这个面边缘的所有通行线会自动互相连通。')));
      } else {
        chk('可穿行', 'through', false);
      }
      fields.push(accessNote(f, key));
      if (catThrough || f.properties.through === true) fields.push(portalNote(f));
    } else {
      const wa = regionAt(f.geometry.coordinates, f.properties.level);
      fields.push(el('div', { class: 'field wide' },
        el('div', { class: 'note', style: `color:${wa ? 'var(--ok)' : 'var(--fg3)'}` },
          wa ? `✓ 落在区域 ${wa.id}（${wa.properties.zone}）内` : '· 不在任何区域内 —— 区域只是隔离区标记，不拦这个')));
      fields.push(accessNote(f, key));
      // 同层同类别的近邻提示
      const near = ed.areaFacilities().filter((x) => x.properties.level === f.properties.level
        && G.pointInPolygon(f.geometry.coordinates, x.geometry.coordinates));
      if (near.length) {
        fields.push(el('div', { class: 'field wide' },
          el('div', { class: 'note', style: 'color:var(--warn)' },
            `落在面状设施「${near[0].properties.name}」内部 —— 如果它本来就是这家店的一部分，应该合并成一条记录，而不是两条`)));
      }
    }

  } else if (key === 'obstacles') {
    selF('zone', 'zone', zoneOpts, zoneLabels);
    selF('kind', 'kind', Object.keys(ed.manifest.obstacleKinds ?? {}).filter((k) => !k.startsWith('_')),
      Object.fromEntries(Object.entries(ed.manifest.obstacleKinds ?? {}).map(([k, v]) => [k, v.name])));
    txt('名称', 'name', '可留空 —— 障碍物不需要名字');
    chk('已核实', 'verified');
    const c = G.polygonCentroid(f.geometry.coordinates);
    const wa = regionAt(c, f.properties.level);
    fields.push(el('div', { class: 'field wide' },
      el('div', { class: 'note', style: `color:${wa ? 'var(--ok)' : 'var(--err)'}` },
        wa ? `✓ 落在区域 ${wa.id} 内（区域只是隔离区标记，不参与寻路）` : '✗ 不在任何区域内 —— 画在外面它什么也挡不住')));

  } else if (key === 'connectors') {
    const types = Object.keys(ed.manifest.connectorTypes).filter((k) => !k.startsWith('_'));
    selF('类型', 'connectorType', types,
      Object.fromEntries(Object.entries(ed.manifest.connectorTypes).map(([k, v]) => [k, `${v.name} (${k})`])));
    txt('中文名', 'name'); txt('英文名', 'nameEn');

    for (const side of ['from', 'to']) {
      const e = f.properties[side];
      const wa = e ? regionAt([e.x, e.y], e.level) : null;
      fields.push(el('div', { class: 'field wide' },
        el('div', { class: 'note', style: `color:${wa ? 'var(--ok)' : 'var(--err)'}` },
          `${side === 'from' ? '起点' : '终点'}　${e?.level}　(${e?.x?.toFixed(1)}, ${e?.y?.toFixed(1)})　${e?.zone}`,
          el('br'),
          wa ? `✓ 落在区域 ${wa.id} 内` : '· 不在任何区域内 —— 这条只是提示，不拦'),
      ));
    }
    chk('双向', 'bidirectional', true);
    selF('方向', 'direction', ['up', 'down', 'both', 'forward']);
    chk('无障碍', 'accessible', true);
    numF('通过秒', 'travel_time', '1'); numF('等待秒', 'wait_time', '15');
    chk('已核实', 'verified');

    fields.push(el('div', { class: 'field wide' },
      el('div', { class: 'actions' },
        el('button', { onclick: () => { const p = f.properties; ed.setProps(key, f.id, { from: p.to, to: p.from, direction: p.direction === 'up' ? 'down' : p.direction === 'down' ? 'up' : p.direction }); renderPanels(); requestDraw(); } }, '对调起点终点'),
      )));
  } else if (key === 'paths') {
    const kindLabels = Object.fromEntries(
      Object.entries(ed.manifest.pathKinds ?? {}).map(([k, v]) => [k, `${v.name} (${k})`]));
    selF('zone', 'zone', zoneOpts, zoneLabels);
    selF('kind', 'kind', Object.keys(ed.manifest.pathKinds ?? {}).filter((k) => !k.startsWith('_')), kindLabels);
    txt('中文名', 'name', '会出现在转向指令里，起得像人话');
    txt('英文名', 'nameEn');
    numF('最小宽 m', 'minWidth', '0.5');
    numF('速度系数', 'speedFactor', '0.1');
    chk('无障碍', 'accessible', true);
    chk('双向', 'bidirectional', true);
    chk('已核实', 'verified');

    // 即时体检：顶点是否都在区域面内、有没有跨 zone、有没有穿障碍物
    const coords = f.geometry.coordinates;
    const outside = coords.filter((p) => !regionAt(p, ed.currentLevel));
    const zones = new Set(coords.map((p) => regionAt(p, ed.currentLevel)?.properties.zone).filter(Boolean));
    const obsHit = ed.obstacles.features.filter((o) => o.properties.level === f.properties.level).some((o) => {
      const ring = o.geometry.coordinates[0];
      for (let i = 0; i + 1 < coords.length; i++) {
        for (let k = 0; k + 1 < ring.length; k++) {
          if (G.segmentsIntersect(coords[i], coords[i + 1], ring[k], ring[k + 1])) return true;
        }
      }
      return false;
    });
    const notes = [];
    notes.push(outside.length
      ? [`✗ ${outside.length} 个顶点不在区域面内`, 'var(--err)']
      : ['✓ 所有顶点都在区域面内', 'var(--ok)']);
    if (zones.size > 1) notes.push(['✗ 跨了隔离区 —— 跨 zone 只能经连接件', 'var(--err)']);
    if (obsHit) notes.push(['✗ 穿过障碍物', 'var(--err)']);
    notes.push([`${coords.length} 个顶点 · ${(coords.reduce((s, p, i) => i ? s + G.dist(coords[i - 1], p) : 0, 0)).toFixed(1)} m`, 'var(--fg3)']);
    fields.push(el('div', { class: 'field wide' },
      el('div', { class: 'note' },
        ...notes.flatMap(([t, c], i) => (i ? [el('br'), el('span', { style: `color:${c}` }, t)] : [el('span', { style: `color:${c}` }, t)])))));
  } else if (key === 'zones') {
    selF('zone', 'zone', zoneOpts, zoneLabels);
    txt('中文名', 'name'); txt('英文名', 'nameEn');
  }

  fields.push(el('div', { class: 'actions' },
    el('button', { onclick: () => { fitToSelection(); } }, '缩放到此'),
    el('button', { class: 'danger', onclick: doDelete }, '删除')));

  wrap.replaceChildren(...fields);
}

function fitToSelection() {
  const sel = ed.selected();
  if (!sel) return;
  const pts = ringPoints(sel.f);
  if (!pts.length) return;
  const bb = pts.reduce((a, p) => ({
    minX: Math.min(a.minX, p[0]), maxX: Math.max(a.maxX, p[0]),
    minY: Math.min(a.minY, p[1]), maxY: Math.max(a.maxY, p[1]),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const w = Math.max(bb.maxX - bb.minX, 4), h = Math.max(bb.maxY - bb.minY, 4);
  view.scale = Math.max(0.1, Math.min((canvas.clientWidth - 160) / w, (canvas.clientHeight - 160) / h, 40));
  view.ox = canvas.clientWidth / 2 - ((bb.minX + bb.maxX) / 2) * view.scale;
  view.oy = canvas.clientHeight / 2 + ((bb.minY + bb.maxY) / 2) * view.scale;
  requestDraw();
}

function renderIssues() {
  const wrap = $('issues');
  const list = ed.issues ?? [];
  const c = ed.lastValidate?.counts ?? {};
  $('issueCount').textContent = `E ${c.ERROR ?? 0} · W ${c.WARN ?? 0} · I ${c.INFO ?? 0}`;
  $('issueCount').className = 'pill ' + (c.ERROR ? 'bad' : 'ok');
  if (!list.length) { wrap.replaceChildren(el('div', { class: 'empty' }, '没有发现问题。')); return; }

  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  const sorted = [...list].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  wrap.replaceChildren(...sorted.map((it) => el('div', {
    class: 'issue',
    title: it.hint ?? '',
    onclick: () => focusIssue(it),
  },
    el('span', { class: `sev ${it.severity[0]}` }),
    el('span', { class: 'm' }, it.message, el('div', { class: 'c' }, it.code, it.feature ? ` · ${it.feature}` : '')),
  )));
}

function focusIssue(it) {
  if (!it.feature) return;
  for (const { key, f } of ed.allFeatures()) {
    if (f.id !== it.feature) continue;
    const lv = featureLevel(key, f);
    if (lv && ed.levels[lv]) ed.currentLevel = lv;
    ed.selection = { key, id: f.id };
    renderPanels(); fitToSelection();
    return;
  }
  toast('这个要素不在地图上（可能属于未绘制的楼层）');
}

/**
 * 渲染所有面板。
 *
 * ★ 每个面板单独 try/catch。一个面板出 bug 不应该让整块界面变空白 ——
 *   早期版本 renderHint() 里一个 ReferenceError（漏删的 `const extra = []`）就让
 *   楼层/校准/图层/属性/统计全都不渲染，连画布都是空的，表现是「编辑器坏了」，
 *   但根本看不出是哪里坏的。现在坏掉的面板会把名字和消息显示在顶部横幅上。
 */
function renderPanels() {
  const jobs = [
    ['工具栏', renderToolbar], ['提示条', renderHint], ['楼层', renderLevels],
    ['校准', renderCalib], ['图层', renderLayers], ['图例', renderLegend],
    ['属性', renderProps], ['统计', renderStats],
  ];
  const errors = [];
  for (const [name, fn] of jobs) {
    try { fn(); } catch (e) { errors.push({ name, e }); }
  }
  reportPanelErrors(errors);
}

function renderPanelsLite() {
  const errors = [];
  for (const [name, fn] of [['属性', renderProps], ['统计', renderStats]]) {
    try { fn(); } catch (e) { errors.push({ name, e }); }
  }
  reportPanelErrors(errors);
}

/** 面板渲染失败时，把错误摊在明面上，而不是静默白屏。 */
function reportPanelErrors(errors) {
  let box = document.getElementById('panelError');
  if (!errors.length) { box?.remove(); return; }
  for (const { name, e } of errors) console.error(`[面板渲染失败] ${name}:`, e);
  if (!box) {
    box = el('div', {
      id: 'panelError',
      style: 'position:fixed;left:50%;top:52px;transform:translateX(-50%);z-index:80;'
        + 'background:#241416;border:1px solid var(--err);border-radius:5px;'
        + 'padding:10px 14px;font-size:12px;max-width:70vw;box-shadow:0 10px 30px rgba(0,0,0,.6)',
    });
    document.body.append(box);
  }
  box.replaceChildren(
    el('div', { style: 'font-weight:600;color:var(--err);margin-bottom:4px' },
      `有 ${errors.length} 个面板渲染失败（其余面板仍可用）`),
    ...errors.map(({ name, e }) => el('div', { class: 'mono', style: 'color:#ffd9d9;line-height:1.5' },
      `${name}：${e.message}`)),
    el('div', { style: 'color:var(--fg3);margin-top:6px' }, '按 F12 打开控制台看完整堆栈'),
  );
}

/* ============================================================ 图片加载 */

const imgCache = new Map();   // URL → HTMLImageElement，避免同一张图重复解码

/** 加载单张底图的图片。id 是底图 id（不是楼层），因为一层可以有多张。 */
function loadMapImage(map) {
  if (!map?.image) return Promise.resolve(null);
  const url = ed.planBase + encodeURIComponent(map.image);
  if (imgCache.has(url)) { ed.mapImages.set(map.id, imgCache.get(url)); return Promise.resolve(imgCache.get(url)); }
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { imgCache.set(url, im); ed.mapImages.set(map.id, im); requestDraw(); resolve(im); };
    im.onerror = () => { toast(`图片加载失败：${map.image}`, 'err'); resolve(null); };
    im.src = url;
  });
}

/** 加载某层所有底图的图片。 */
function loadMapImagesFor(level) {
  return Promise.all(ed.calMaps(level).map((m) => loadMapImage(m)));
}

/* ============================================================ 帮助 */

function showHelp() {
  const body = el('div', { class: 'kb' },
    el('div', {}, 'V'), el('div', {}, '选择 / 编辑顶点 / 整体拖动'),
    el('div', {}, 'R'), el('div', {}, '画区域（隔离区标记）'),
    el('div', {}, 'F'), el('div', {}, '画面状设施（店铺、休息室 —— 自动放门）'),
    el('div', {}, 'P'), el('div', {}, '放点状设施（登机口、饮水、充电）'),
    el('div', {}, 'O'), el('div', {}, '画障碍物（柱子、柜台 —— 从区域里扣除）'),
    el('div', {}, 'Z'), el('div', {}, '画区域面（隔离区着色）'),
    el('div', {}, 'C'), el('div', {}, '连连接件（点起点 → 点终点）'),
    el('div', {}, 'K'), el('div', {}, '两点定比例'),
    el('div', {}, 'M'), el('div', {}, '量距核对'),
    el('div', {}, 'Enter'), el('div', {}, '闭合当前多边形'),
    el('div', {}, 'Backspace'), el('div', {}, '退掉最后一个点'),
    el('div', {}, 'Delete'), el('div', {}, '删除选中要素'),
    el('div', {}, 'Esc'), el('div', {}, '取消当前操作'),
    el('div', {}, '0'), el('div', {}, '适应视图'),
    el('div', {}, 'Ctrl+S'), el('div', {}, '保存到 data/source/'),
    el('div', {}, 'Ctrl+Z'), el('div', {}, '撤销'),
    el('div', {}, 'Ctrl+Shift+Z'), el('div', {}, '重做'),
    el('div', {}, '滚轮'), el('div', {}, '缩放'),
    el('div', {}, '中键 / 右键 / Shift+拖'), el('div', {}, '平移'),
    el('hr', { style: 'border:none;border-top:1px solid var(--line2);margin:10px 0' }),
    el('div', { style: 'grid-column:1/-1' }, el('b', {}, '推荐流程')),
    el('div', { style: 'grid-column:1/-1' }, '① 把平面图放进 plans/ → ② 选图 → ③ K 两点定比例 → ④ M 量另一条已知距离核对 → ⑤ W 画走廊 → ⑥ F 画店铺（门自动生成）→ ⑦ P 放点状设施 → ⑧ O 画柱子 → ⑨ C 连扶梯/电梯/安检 → ⑩ 保存 → ⑪ 校验，清掉所有 ERROR → ⑫ 已核实的要素勾选 verified'),
    el('div', { class: 'actions', style: 'grid-column:1/-1;margin-top:14px' },
      el('button', { class: 'primary', onclick: closeModal }, '知道了')),
  );
  modal('快捷键与推荐流程', body);
}

/* ============================================================ 测试钩子 */

/**
 * 暴露内部函数给 tools/ 下的无头测试（editor-pick.mjs / editor-e2e.mjs）。
 *
 * 浏览器里没人读这个对象（零成本）。之所以要暴露，是因为「编辑器启动后界面全空」
 * 这类 bug 只有真正 boot 一遍才能发现 —— node --check 查不出 ReferenceError。
 * 有了它，CI 里就能驱动「选中要素 → 属性面板出数据」这条真实路径。
 */
globalThis.__bdiaTestHooks = {
  ed, ia, view,
  select(sel) { ed.selection = sel; renderPanels(); requestDraw(); },
  setMode,
  validate: doValidate,
  save: doSave,
  focusIssue,
  renderPanels,
  /** 同步重绘一次，不走 requestAnimationFrame —— 测试要能确定性地检查这一帧。 */
  redraw() { draw(ctx, ed, view, ia, canvas); },
  /** 同步适应视图，便于测试断言取景范围。 */
  fit() { fitTo(ed, view, canvas); },
  /** 加载某层全部底图的图片（无头测试里 Image 是桩）。 */
  loadMaps: (level) => loadMapImagesFor(level ?? ed.currentLevel),
  /** 底图手柄位置（测试用，和画布上画的是同一份）。 */
  handles: () => baseMapHandles(ed, view),
  /** 吸附结果（测试用）。传屏幕坐标。 */
  snap: (sp, opts) => computeSnap(sp, opts),
  /** 实时编译的路网（测试用）。 */
  net: () => computeNetwork(),
};

/* ============================================================ 启动 */

$('btnUndo').onclick = () => { ed.undoStep(); renderPanels(); requestDraw(); };
$('btnRedo').onclick = () => { ed.redoStep(); renderPanels(); requestDraw(); };
$('btnFit').onclick = () => { fitTo(ed, view, canvas); requestDraw(); };
$('btnDel').onclick = doDelete;
$('btnSave').onclick = doSave;
$('btnValidate').onclick = doValidate;
$('btnHelp').onclick = showHelp;

new ResizeObserver(() => { fitTo(ed, view, canvas); requestDraw(); }).observe(canvas.parentElement);

(async function boot() {
  try {
    await ed.load();
  } catch (e) {
    // 复用 index.html 里的诊断层，别把整个 body 换掉 —— 那样连控制台提示都没了，
    // 而且和 file:// 场景显示的是两套完全不同的东西。
    bootFail(
      '连不上编辑器服务',
      '界面加载了，但取 <code>/api/data</code> 失败 —— 本地服务没在跑，或者已经退出了。',
      '<b>重新启动：</b><pre>cd projects/bdia-nav\nnpm run editor</pre>'
      + `<p>错误详情：<code>${String(e.message).replace(/[<>&]/g, '')}</code></p>`,
    );
    console.error('[boot] 载入源数据失败', e);
    return;
  }
  // 支持 ?level=L3F 直接打开某一层（深链，也方便截图和测试）
  try {
    const want = new URLSearchParams(globalThis.location?.search ?? '').get('level');
    if (want && ed.manifest?.levels?.[want]) ed.currentLevel = want;
  } catch { /* 没有 location 就按默认层 */ }

  const lv = ed.currentLevel;
  await loadMapImagesFor(lv);
  renderPanels();
  fitTo(ed, view, canvas);
  if (!$('issues').children.length) renderIssues();
  /*
   * ★ 数据加载完成之后才启动自动保存。
   *   早于加载完成启动的话，第一次 tick 面对的是一份空数据 ——
   *   那正是之前「一次保存把数据清空」事故的成因。
   */
  startAutosave();
  requestDraw();
  // ★ 告诉 index.html 的看门狗「起来了」。没有这一步，看门狗会在 4 秒后
  //   误报「编辑器没能启动」—— 一个假警报比没有警报更糟。
  globalThis.__bdiaBooted = true;
  toast('编辑器就绪。按 ? 看快捷键和推荐流程。', 'ok');
})();

/** 显示启动失败诊断。守卫脚本还没跑（或不存在）时退回到一个最简提示。 */
function bootFail(title, detailHtml, extraHtml) {
  if (typeof globalThis.__bdiaFail === 'function') return globalThis.__bdiaFail(title, detailHtml, extraHtml);
  document.body.innerHTML = `<div style="padding:40px;font:14px/1.8 system-ui;color:#ececec;background:#0e0e0e;min-height:100vh">
    <h1 style="font-size:17px;font-weight:500;margin-bottom:12px;color:#d95757">${title}</h1>
    <div>${detailHtml}</div><div style="color:#9c9c9c;font-size:13px;margin-top:14px">${extraHtml ?? ''}</div></div>`;
}
