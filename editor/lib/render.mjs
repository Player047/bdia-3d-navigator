/**
 * 画布渲染层。
 *
 * 坐标链路与 state.mjs 一致：
 *   图像像素 ──校准──▶ 本地米 ──视图──▶ 屏幕像素
 * 所有矢量都存本地米；渲染时统一走 screenFromLocal。
 * 平面图底图走 canvas 的 setTransform（一次仿射搞定缩放+旋转+翻转）。
 */

import * as G from '../../tools/lib/geo.mjs';
import { buildGraph } from '../../tools/lib/graph.mjs';

export function createView() {
  return { scale: 1.2, ox: 0, oy: 0 };   // scale = 每米多少屏幕像素
}

export const screenFromLocal = (p, v) => [v.ox + p[0] * v.scale, v.oy - p[1] * v.scale];
export const localFromScreen = (s, v) => [(s[0] - v.ox) / v.scale, (v.oy - s[1]) / v.scale];

/** 要素属于哪个楼层。设施 / 障碍物 / 区域面存在全局文件里，靠属性判断。 */
export function featureLevel(key, f) {
  if (key.includes('/')) return key.split('/')[0];                       // <层>/regions
  if (key === 'connectors') return f.properties?.from?.level ?? null;
  return f.properties?.level ?? null;
}

/** 要素是否属于指定楼层。连接件只要有一端在这层就算。 */
export function featureMatchesLevel(key, f, level) {
  if (key === 'connectors') {
    return f.properties?.from?.level === level || f.properties?.to?.level === level;
  }
  return featureLevel(key, f) === level;
}

export function fitTo(state, view, canvas) {
  const lv = state.currentLevel;
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const eat = (p) => {
    if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) return;
    bb.minX = Math.min(bb.minX, p[0]); bb.maxX = Math.max(bb.maxX, p[0]);
    bb.minY = Math.min(bb.minY, p[1]); bb.maxY = Math.max(bb.maxY, p[1]);
  };

  // ★ 只算【当前楼层】的要素。早先遍历所有楼层，于是「适应视图」按别层的范围缩放，
  //   当前层的底图会被整块切到屏幕外面去。
  for (const { key, f } of state.allFeatures()) {
    if (!featureMatchesLevel(key, f, lv)) continue;
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') eat(g.coordinates);
    else if (g.type === 'LineString') g.coordinates.forEach(eat);
    else for (const ring of (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat())) ring.forEach(eat);
  }

  // ★ 底图始终参与，不管这层有没有矢量 —— 导入底图之后第一件事就是「适应视图」把它框进来。
  //   一层可能有多张，全部按各自的校准算角点。
  for (const map of state.calMaps(lv)) {
    if (!map.image || map.visible === false) continue;
    const img = state.mapImages.get(map.id);
    if (!img || !img.naturalWidth) continue;
    [[0, 0], [img.naturalWidth, 0], [0, img.naturalHeight], [img.naturalWidth, img.naturalHeight]]
      .map((p) => state.toLocal(p, map)).forEach(eat);
  }

  if (!Number.isFinite(bb.minX)) { bb.minX = -100; bb.maxX = 100; bb.minY = -100; bb.maxY = 100; }

  const w = Math.max(bb.maxX - bb.minX, 1), h = Math.max(bb.maxY - bb.minY, 1);
  const pad = 60;
  const s = Math.min((canvas.clientWidth - pad * 2) / w, (canvas.clientHeight - pad * 2) / h);
  view.scale = Math.max(0.02, Math.min(s, 40));
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  view.ox = canvas.clientWidth / 2 - cx * view.scale;
  view.oy = canvas.clientHeight / 2 + cy * view.scale;
}

export function zoomAt(view, screenPt, factor) {
  const before = localFromScreen(screenPt, view);
  view.scale = Math.max(0.02, Math.min(view.scale * factor, 80));
  const after = localFromScreen(screenPt, view);
  view.ox += (after[0] - before[0]) * view.scale;
  view.oy -= (after[1] - before[1]) * view.scale;
}

/* ------------------------------------------------------------- 配色 */

const css = (hex, a) => {
  const h = (hex ?? '#7ADCE4').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const zoneColor = (state, zone) => state.manifest?.zones?.[zone]?.color ?? '#7ADCE4';

/* ---------------------------------------------------------- 样式常量 */

/*
 * ★ 这些常量同时被【绘制】和【图例】使用。
 *   分两处各写一份的话，改了绘制颜色、图例还是旧的 —— 图例就成了谎话。
 *   所以这里有且只有一份，图例从它生成。
 */

/** 通行线按种类着色。 */
export const PATH_STYLE = {
  spine: '#7ADCE4', corridor: '#8FE3B0', pier: '#8FE3B0',
  branch: '#CBC885', queue: '#C9A227', walkway: '#7ADCE4', staff: '#8FA3B0',
};

/** 点状设施按类别着色。 */
/**
 * 点状设施按类别着色。
 *
 * ★ 类别合并到 36 个之后，这张表也短了很多 —— 而且**故意只给少数几类上色**。
 *   商业全是一个色：旅客不需要从颜色上区分「免税店」和「便利店」，
 *   那是 fields.kind 的事。颜色只留给真正需要一眼分辨的东西。
 */
export const POI_DOT = {
  // 流程点：旅客最常找，给最强的颜色
  gate: '#FFD166', arrival_gate: '#FFD166', checkin: '#7ADCE4', self_checkin: '#7ADCE4',
  baggage_drop: '#7ADCE4', baggage_claim: '#7ADCE4',
  security: '#FF7B7B', immigration: '#FF7B7B', customs: '#FF7B7B', quarantine: '#FF7B7B',
  transfer_desk: '#C9A227',
  // 设施
  restroom: '#8FA3B0', nursing: '#F2A6C4',
  water: '#7ADCE4', charging: '#7ADCE4', left_luggage: '#8FA3B0',
  // 服务 / 休息
  service_desk: '#8FE3B0', lounge: '#C08BFF', seating: '#8FA3B0', sleep: '#C08BFF',
  // 商业：一个颜色
  commerce: '#FFB86B', finance: '#C9A227',
  // 交通 / 医疗
  entrance: '#8FE3B0', exit: '#8FE3B0', entrance_exit: '#8FE3B0', ground_transport: '#8FE3B0',
  medical: '#FF7B7B', pharmacy: '#FF7B7B',
};

export const CONNECTOR_STYLE = {
  sameLevel: '#7ADCE4', crossLevel: '#FF9F5A',
  from: '#FF9F5A', to: '#FFD166',
  width: 2, dash: [7, 5],
  endpointRadius: 4,
};

export const OBSTACLE_STYLE = { color: '#FF7B7B', fill: 0.5, stroke: 0.75, dash: [4, 3] };
export const REGION_STYLE = { fill: 0.13, stroke: 0.7 };
export const AREA_FACILITY_STYLE = { fill: 0.3, stroke: 0.9 };

/** 路网节点：普通拐点 / 路口 / 交叉自动生成。 */
export const NODE_STYLE = {
  plain: 'rgba(255,255,255,0.55)', plainRadius: 3.5,
  junction: '#FFD166', junctionRadius: 6,
  preview: '#FFD166', previewRadius: 9,
};

/** 设施接入状态。 */
export const ACCESS_STYLE = { ok: '#8FE3B0', bad: '#FF7B7B' };

export const PATH_WIDTH = { outer: 7, inner: 3 };
export const SELECT_STYLE = { color: '#FFFFFF', width: 2.5 };

/* -------------------------------------------------------------- 图例 */

/**
 * 图例规格。
 *
 * ★ 从上面那份【唯一的】样式常量生成，不手抄。
 *   手抄的图例改了颜色就变谎话，而且没人会发现。
 *
 * 每条 item：
 *   swatch  'line' | 'dash' | 'dot' | 'ring' | 'rect' | 'box'
 *   color   主色
 *   size    线宽 / 半径，画出来让人一眼看到粗细差别
 *   name    中文名
 *   detail  补充说明（可省）
 */
export function legendSpec(state) {
  const zone = (z) => state.manifest?.zones?.[z]?.color ?? '#7ADCE4';
  const pkn = (k) => state.manifest?.pathKinds?.[k]?.name ?? k;
  const rkn = (k) => state.manifest?.regionKinds?.[k]?.name ?? k;
  const cat = (c) => state.manifest?.facilityCategories?.[c]?.name ?? c;

  const zones = Object.keys(state.manifest?.zones ?? {}).filter((k) => !k.startsWith('_'));

  return [
    {
      title: '通行线',
      note: '★ 唯一的寻路图。端点/顶点/交叉点都是节点，两条线交叉即连通。',
      items: [
        ...Object.entries(PATH_STYLE).map(([k, c]) => ({
          swatch: 'line', color: c, size: PATH_WIDTH.inner, name: pkn(k), detail: k,
        })),
        { swatch: 'line', color: PATH_STYLE.spine, size: PATH_WIDTH.outer, name: '通行线外描边', detail: '深色底衬，任何底色上都看得清' },
      ],
    },
    {
      title: '路网节点',
      note: '通行线编译出来的图。打开「路网节点」图层可见。',
      items: [
        { swatch: 'dot', color: NODE_STYLE.junction, size: NODE_STYLE.junctionRadius, name: '路口', detail: '连接 ≥3 条边，旁边标注度数' },
        { swatch: 'dot', color: NODE_STYLE.plain, size: NODE_STYLE.plainRadius, name: '拐点', detail: '折线的顶点，连接 2 条边' },
        { swatch: 'ring', color: NODE_STYLE.preview, size: NODE_STYLE.previewRadius, name: '将生成路口', detail: '画线时的实时预览' },
      ],
    },
    {
      title: '连接件',
      note: '跨层 / 跨隔离区的边。它是图上的边，不是地理上的通道。',
      items: [
        { swatch: 'line', color: CONNECTOR_STYLE.sameLevel, size: CONNECTOR_STYLE.width, name: '同层连接件', detail: '实线' },
        { swatch: 'dash', color: CONNECTOR_STYLE.crossLevel, size: CONNECTOR_STYLE.width, name: '跨层连接件', detail: '虚线' },
        { swatch: 'dot', color: CONNECTOR_STYLE.from, size: CONNECTOR_STYLE.endpointRadius, name: 'from 端点', detail: '起点' },
        { swatch: 'dot', color: CONNECTOR_STYLE.to, size: CONNECTOR_STYLE.endpointRadius, name: 'to 端点', detail: '终点' },
      ],
    },
    {
      title: '区域',
      note: '只是隔离区标记，不参与寻路。按 zone 着色。',
      items: zones.map((z) => ({
        swatch: 'rect', color: zone(z), fill: REGION_STYLE.fill,
        name: state.manifest.zones[z]?.name ?? z, detail: z,
      })),
    },
    {
      title: '面状设施',
      note: '店铺、休息室、卫生间。画在区域【外面】，和区域共边。',
      items: zones.map((z) => ({
        swatch: 'rect', color: zone(z), fill: AREA_FACILITY_STYLE.fill,
        name: `设施（${state.manifest.zones[z]?.name ?? z}）`, detail: '按所在隔离区着色',
      })),
    },
    {
      title: '跨层设施',
      note: '★ 电梯/扶梯/楼梯/坡道是【点状设施】，不是边。同一个 verticalGroup 在各层坐标完全相同 —— 这是整个模型里唯一「跨楼层同一个位置」的地方，3D 里路径就在这里垂直穿楼板。',
      items: [
        { swatch: 'dot', color: VERTICAL_STYLE.color, size: VERTICAL_STYLE.radius, name: '跨层设施', detail: '紫色六边形 + 上下箭头，旁边标注它连通的其他楼层' },
        { swatch: 'ring', color: VERTICAL_STYLE.unreachable, size: VERTICAL_STYLE.radius, name: '跨层设施走不到', detail: '这一层还没有通行线经过它' },
      ],
    },
    {
      title: '点状设施',
      note: '登机口、饮水、充电…按类别着色。',
      items: Object.entries(POI_DOT).map(([c, col]) => ({
        swatch: 'dot', color: col, size: 3.4, name: cat(c), detail: c,
      })),
    },
    {
      title: '可达性',
      note: '★ 设施能不能走到，完全由通行线决定。',
      items: [
        { swatch: 'dot', color: ACCESS_STYLE.ok, size: 4.5, name: '已接入路网', detail: '点状设施；面状设施另画墙面到线的短段' },
        { swatch: 'ring', color: ACCESS_STYLE.bad, size: 3.4, name: '走不到', detail: '红圈空心，并拉一条虚线指向最近的路网，标注还差几米' },
      ],
    },
    {
      title: '障碍物',
      note: '柱子、柜台、设备。从区域里扣除，通行线不得穿过。',
      items: [
        { swatch: 'dash', color: OBSTACLE_STYLE.color, size: 1.6, name: '障碍物', fill: OBSTACLE_STYLE.fill, detail: '红色虚线框' },
      ],
    },
    {
      title: '选中与吸附',
      items: [
        { swatch: 'line', color: SELECT_STYLE.color, size: SELECT_STYLE.width, name: '选中的要素', detail: '白色描边 + 顶点手柄' },
        { swatch: 'ring', color: '#7ADCE4', size: 7, name: '吸附提示', detail: '光标吸到的位置' },
      ],
    },
  ];
}

/* ------------------------------------------------------------- 主绘制 */

export function draw(ctx, state, view, ia, canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  drawBackground(ctx, W, H);
  drawGrid(ctx, state, view, W, H);
  drawPlans(ctx, state, view, state.currentLevel, dpr, state.calLevel(state.currentLevel).activeId);
  if (ia.ghostLevel && ia.ghostLevel !== state.currentLevel) drawGhost(ctx, state, view, ia.ghostLevel);

  const L = ia.visibleLayers ?? {};
  // ★ 区域只是隔离区标记 —— 画得淡，因为它不参与寻路，寻路图是下面那层通行线
  if (L.regions !== false) drawPolygons(ctx, state, view, `${state.currentLevel}/regions`, REGION_STYLE);
  if (L.obstacles !== false) drawPolygons(ctx, state, view, 'obstacles', OBSTACLE_STYLE);
  if (L.paths !== false) drawPaths(ctx, state, view, { nodes: L.pathNodes !== false, net: ia.network });
  if (L.facilities !== false) {
    // 设施是一个图层，但点状和面状要分开画 —— 同一份数据，两种几何
    // 传 network 是为了把「已接入 / 走不到」直接画在图上
    drawPolygons(ctx, state, view, 'facilities', AREA_FACILITY_STYLE);
    drawPointFacilities(ctx, state, view, ia.network);
  }
  if (L.connectors !== false) drawConnectors(ctx, state, view);
  if (L.access !== false) drawAccess(ctx, state, view, ia.network);

  drawSelection(ctx, state, view, ia);
  drawDraft(ctx, state, view, ia);
  drawAutoJunctions(ctx, state, view, ia);
  if (ia.mode === 'basemap') drawBaseMapGizmo(ctx, state, view, ia);
  drawSnap(ctx, view, ia.snap);
  drawScaleBar(ctx, view, W, H);
}

function drawBackground(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b1013');
  g.addColorStop(1, '#0e1417');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawGrid(ctx, state, view, W, H) {
  const step = view.scale > 6 ? 5 : view.scale > 1.5 ? 10 : view.scale > 0.5 ? 50 : 200;
  const tl = localFromScreen([0, 0], view);
  const br = localFromScreen([W, H], view);
  const x0 = Math.floor(tl[0] / step) * step, x1 = Math.ceil(br[0] / step) * step;
  const y0 = Math.floor(br[1] / step) * step, y1 = Math.ceil(tl[1] / step) * step;

  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x += step) {
    const s = screenFromLocal([x, 0], view)[0];
    const major = Math.abs(x % (step * 5)) < 1e-6;
    ctx.strokeStyle = x === 0 ? 'rgba(122,220,228,0.45)' : major ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(s, H); ctx.stroke();
  }
  for (let y = y0; y <= y1; y += step) {
    const s = screenFromLocal([0, y], view)[1];
    const major = Math.abs(y % (step * 5)) < 1e-6;
    ctx.strokeStyle = y === 0 ? 'rgba(203,200,133,0.45)' : major ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(0, s); ctx.lineTo(W, s); ctx.stroke();
  }
}

/**
 * 平面图底图：把「图像像素 → 屏幕像素」的仿射矩阵交给 canvas。
 *
 * ★ 这里有两个很容易踩的坑，都跟 canvas 变换的语义有关：
 *
 *   1) setTransform 是【绝对设置】，不是叠加。直接用 setTransform(底图矩阵) 会把
 *      draw() 开头设的 diag(dpr, dpr) 整个替换掉 —— 高分屏上底图就少了 dpr 这一层，
 *      变成按 1/dpr 画。表现是：拖动时底图和矢量数据移动速度不一致，点子相对底图会漂。
 *      正确做法是先把基础 dpr 变换立起来，再用 transform()（叠加/右乘）压上底图仿射。
 *
 *   2) 每张图画完必须 save/restore。早先用 setTransform(1,0,0,1,0,0) 复位，等于把 dpr 丢了，
 *      底图之后画的所有东西（矢量地图、比例尺）都会错位。
 *
 * 一层可以有多张底图，各画各的（数组顺序 = 叠放顺序，后面的盖在前面上）。
 */
function drawPlans(ctx, state, view, level, dpr, activeId) {
  for (const map of state.calMaps(level)) {
    if (!map.image || map.visible === false) continue;
    const img = state.mapImages.get(map.id);
    if (!img) continue;

    const m = map.mPerPx ?? 1;
    const t = ((map.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(t), sin = Math.sin(t);
    const a1 = cos * m, c1 = sin * m, b1 = sin * m, d1 = -cos * m;
    const [ox, oy] = map.originPx ?? [0, 0];
    const t1x = -(a1 * ox + c1 * oy) + (map.nudge?.[0] ?? 0);
    const t1y = -(b1 * ox + d1 * oy) + (map.nudge?.[1] ?? 0);
    const s = view.scale;

    ctx.save();
    ctx.globalAlpha = map.opacity ?? 0.65;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);                       // 基础层：高分屏
    ctx.transform(                                                 // 叠加层：图像像素 → 屏幕
      s * a1, -s * b1, s * c1, -s * d1,
      s * t1x + view.ox, -s * t1y + view.oy,
    );
    ctx.imageSmoothingEnabled = true;
    try { ctx.drawImage(img, 0, 0); } catch { /* 图像还没解码完 */ }
    ctx.restore();

    // 给当前底图描一圈虚线边框 —— 多张图叠在一起时能一眼看出在调哪一张
    if (map.id === activeId && img.naturalWidth) {
      ctx.save();
      ctx.strokeStyle = 'rgba(122,220,228,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      [[0, 0], [img.naturalWidth, 0], [img.naturalWidth, img.naturalHeight], [0, img.naturalHeight]]
        .forEach((q, i) => {
          const p = screenFromLocal(state.toLocal(q, map), view);
          i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
        });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * 通行线：唯一的寻路图。
 *
 * 线本身画成一条带外描边的粗线（像地图上的路），端点加圆点。
 * 打开 nodes 时，顺带把编译出来的图叠加出来 —— 这是验证「交叉即连通」最直观的方式：
 * 你画两条线穿过去，交叉点上会立刻冒出一个节点。
 */
/**
 * 当前楼层的【路网拓扑】：每个连通分量一个颜色 + 所有断口。
 *
 * ★ 为什么必须有这个：
 *   编辑器原来只画几何，不画连通性。线又粗又带圆头，
 *   端点相距 7px（≈6 米）看着就完全接上了 ——
 *   而图里是断的。用户看着"完美"，路网碎成 118 块，
 *   而且【没有任何办法从界面上看出来】。
 *
 *   一个看着完美、实际碎成上百块的路网，是这个工具能犯的最严重的错误：
 *   用户会基于"看起来对"去做后面所有的事。
 *
 * 结果按内容签名缓存 —— 468 条线的分量计算 + 断口扫描不便宜，
 * 不能每帧重算。签名用「路径数 + 总坐标数」，改线必然变。
 */
let _topoCache = { key: '', value: null };

/* 分量配色：色相拉开，相邻分量不撞色。深浅两套主题下都能分辨。 */
const COMP_COLORS = [
  '#7ADCE4', '#FFD166', '#A0E86A', '#FF9F7B', '#B79CFF', '#6ADCE0',
  '#F57BA8', '#8FD96B', '#FFC46B', '#7FB0FF', '#E0A0FF', '#5FD9A8',
  '#FFB3B3', '#C7E86A', '#9BB8FF', '#FFA8DC', '#6FE3F5', '#D6C86A',
];

function pathTopology(state, paths) {
  const lv = state.currentLevel;
  const key = `${lv}|${paths.length}|${paths.reduce((s, f) => s + f.geometry.coordinates.length, 0)}`;
  if (_topoCache.key === key && _topoCache.value) return _topoCache.value;

  const compOf = new Map();
  const gaps = [];

  try {
    const g = buildGraph(paths.map((f) => ({
      id: f.id, level: f.properties.level,
      props: f.properties, coords: f.geometry.coordinates,
    })));

    /* ① 连通分量：并查集，比从每个节点各跑一次 BFS 简单也快 */
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const n of g.nodes) parent.set(n.id, n.id);
    for (const e of g.edges) union(e.a, e.b);

    const rootOf = new Map();
    for (const n of g.nodes) {
      for (const pid of (n.paths ?? [])) {
        if (!rootOf.has(pid)) rootOf.set(pid, find(n.id));
      }
    }
    const roots = [...new Set(rootOf.values())];
    const idx = new Map(roots.map((r, i) => [r, i]));
    for (const [pid, r] of rootOf) compOf.set(pid, idx.get(r));

    const colorOf = (i) => COMP_COLORS[i % COMP_COLORS.length];

    /* ② 断口：某条线的【端点】离另一条线 3m 内，但两者不在同一分量 */
    const segs = [];
    for (const f of paths) {
      const c = f.geometry.coordinates;
      for (let i = 0; i + 1 < c.length; i++) segs.push({ id: f.id, a: c[i], b: c[i + 1] });
    }
    for (const f of paths) {
      const c = f.geometry.coordinates;
      for (const [pi, p] of [[0, c[0]], [c.length - 1, c[c.length - 1]]]) {
        void pi;
        let best = null;
        for (const s of segs) {
          if (s.id === f.id) continue;
          if (Math.abs(s.a[0] - p[0]) > 4 && Math.abs(s.a[1] - p[1]) > 4
            && Math.abs(s.b[0] - p[0]) > 4 && Math.abs(s.b[1] - p[1]) > 4) continue;   // 粗筛
          const d = segDist(p, s.a, s.b);
          if (!best || d < best.d) best = { d, other: s.id };
        }
        // 0.5m 以内的会被自动合并，不算断口；超过 3m 属于"本来就没画到一起"
        if (best && best.d > 0.55 && best.d <= 3
          && compOf.get(f.id) !== compOf.get(best.other)) {
          gaps.push({ p, d: best.d, a: f.id, b: best.other });
        }
      }
    }
  } catch {
    /* 建图失败不能让整个编辑器画不出来 —— 退回单色，不画断口 */
  }

  const value = { compOf, gaps, colorOf: (i) => COMP_COLORS[i % COMP_COLORS.length] };
  _topoCache = { key, value };
  return value;
}

function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function drawPaths(ctx, state, view, opt = {}) {
  const paths = state.paths.features.filter((f) => f.properties?.level === state.currentLevel
    && f.geometry?.type === 'LineString' && f.geometry.coordinates?.length >= 2);

  const topo = pathTopology(state, paths);

  for (const f of paths) {
    const pts = f.geometry.coordinates.map((p) => screenFromLocal(p, view));
    /*
     * ★ 颜色改由【连通分量】决定，不再是"线型一个颜色"。
     *
     *   这是本编辑器最严重的一次教训：线画得又粗又带圆头，
     *   端点相距 7 像素（≈6 米）看着就完全接上了 ——
     *   而图里其实是断的。用户看着"完美"，路网却碎成了 118 块。
     *
     *   同一块内的线同色，碎成几块一眼就看出来。
     */
    const comp = topo.compOf.get(f.id);
    const col = comp == null ? (PATH_STYLE[f.properties.kind] ?? '#7ADCE4') : topo.colorOf(comp);

    ctx.beginPath();
    pts.forEach((s, i) => (i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1])));
    ctx.strokeStyle = 'rgba(11,16,19,0.85)';
    /*
     * ★ 底衬从 7px 收到 5px，并且【去掉圆头】。
     *   lineCap:'round' 让每个端点向外鼓出 3.5px（≈3 米）——
     *   两条线的端点相距 7px 就重叠了，缺口被彻底盖住。
     *   改成 butt 之后，端点就在它真正的位置上。
     */
    ctx.lineWidth = 5;
    ctx.lineCap = 'butt';
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.setLineDash(f.properties.bridge ? [8, 5] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath(); ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = '#0b1013'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  /*
   * ★ 断口标记 —— 画在所有线【之后】，压在它们上面。
   *
   *   「端点离另一条线 3 米内、但不在同一个连通分量」= 看着接上了、实际是断的。
   *   这些地方必须比线本身更显眼：红色警示环 + 中心点 + 距离数字。
   *   不画出来的话，用户永远只会看到"完美的路网" —— 这正是之前发生的事。
   */
  for (const g of topo.gaps) {
    const s = screenFromLocal(g.p, view);
    const r = 7 + Math.min(6, g.d * 2);      // 缺口越大圈越大
    ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
    ctx.strokeStyle = '#FF5A5A'; ctx.lineWidth = 2.5;
    ctx.setLineDash([]); ctx.stroke();
    ctx.beginPath(); ctx.arc(s[0], s[1], 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#FF5A5A'; ctx.fill();
    if (view.scale > 0.55) {                 // 太密的时候不写字，免得糊成一团
      ctx.font = '600 10px ui-monospace, Consolas, monospace';
      ctx.fillStyle = '#FF8A8A';
      ctx.fillText(`${g.d.toFixed(1)}m`, s[0] + r + 3, s[1] - r - 2);
    }
  }

  if (!opt.nodes || !paths.length) return;

  // 编译出来的图：节点 + 度数
  let graph;
  try {
    graph = buildGraph(paths.map((f) => ({
      id: f.id, level: f.properties.level, zone: f.properties.zone,
      props: f.properties, coords: f.geometry.coordinates,
    })));
  } catch { return; }

  for (const n of graph.nodes) {
    const s = screenFromLocal([n.x, n.y], view);
    const deg = graph.degree.get(n.id) ?? 0;
    const isJunction = deg >= 3;
    ctx.beginPath();
    ctx.arc(s[0], s[1], isJunction ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isJunction ? NODE_STYLE.junction : NODE_STYLE.plain;
    ctx.fill();
    ctx.strokeStyle = '#0b1013';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (isJunction && view.scale > 0.4) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,209,102,0.9)';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${deg}`, s[0] + 9, s[1]);
    }
  }
}

/** 幽灵层：把别的楼层以低透明度画出来，用于跨层对齐扶梯。 */function drawGhost(ctx, state, view, level) {
  const pack = state.levels[level];
  if (!pack) return;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#8FA3B0';
  ctx.lineWidth = 1.5;
  const stroke = (g) => {
    if (g?.type !== 'Polygon') return;
    ctx.beginPath();
    g.coordinates[0].forEach((p, i) => {
      const s = screenFromLocal(p, view);
      i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]);
    });
    ctx.stroke();
  };
  for (const f of (pack.regions ?? { features: [] }).features) stroke(f.geometry);
  for (const f of state.facilities.features) {
    if (f.properties?.level === level) stroke(f.geometry);
  }
  ctx.restore();
}

function drawPolygons(ctx, state, view, key, opt) {
  let fc;
  try { fc = state.collection(key); } catch { return; }
  if (!fc) return;

  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    // Point 几何在这里自动跳过 —— 设施图层是点和面混在一个文件里的
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) continue;
    // ★ 只画当前楼层。facilities / obstacles 存在全局文件里，但它们各自带 level。
    if (f.properties?.level && f.properties.level !== state.currentLevel) continue;

    const col = opt.color ?? zoneColor(state, f.properties?.zone);
    for (const poly of polys) {
      ctx.beginPath();
      for (const ring of poly) {
        ring.forEach((p, i) => {
          const s = screenFromLocal(p, view);
          i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]);
        });
        ctx.closePath();
      }
      ctx.fillStyle = css(col, opt.fill);
      ctx.fill('evenodd');
      ctx.strokeStyle = css(col, opt.stroke);
      ctx.lineWidth = 1.6;
      if (opt.dash) ctx.setLineDash(opt.dash); else ctx.setLineDash([]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/**
 * 设施可达性叠加层。
 *
 * 这是新模型最该一眼看清的东西：
 *   · 面状设施 —— 通行线吸附到它边缘上的那个点 = 寻路点。画一条从墙到线的短线 + 黄点。
 *   · 点状设施 —— 有通行线经过才算可达。可达画绿圈，走不到画红圈加虚线（表示缺失的那段）。
 */
function drawAccess(ctx, state, view, net) {
  if (!net?.attachments) return;
  ctx.save();
  for (const [id, a] of net.attachments) {
    const f = state.facilities.features.find((x) => x.id === id);
    if (!f || f.properties?.level !== state.currentLevel) continue;
    const rp = screenFromLocal(a.routingPoint, view);
    const ok = a.served;
    const col = ok ? '#8FE3B0' : '#FF7B7B';

    if (a.kind === 'area') {
      // 从房间边界到通行线的那一小段「入口」
      const ep = a.edgePoint ? screenFromLocal(a.edgePoint, view) : rp;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(ok ? [] : [4, 3]);
      ctx.beginPath(); ctx.moveTo(ep[0], ep[1]); ctx.lineTo(rp[0], rp[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ep[0], ep[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = '#0b1013'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    if (!ok) {
      // 走不到：在设施和最近的路网之间画一条虚线，直观显示「差这一段」
      const from = f.geometry.type === 'Point' ? screenFromLocal(f.geometry.coordinates, view)
        : screenFromLocal(G.polygonCentroid(f.geometry.coordinates), view);
      const to = a.onPath ? screenFromLocal(a.onPath, view) : rp;
      ctx.strokeStyle = 'rgba(255,123,123,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke();
      ctx.setLineDash([]);
      if (view.scale > 0.25) {
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillStyle = '#FF7B7B';
        ctx.textBaseline = 'middle';
        ctx.fillText(`差 ${a.dist.toFixed(1)}m`, (from[0] + to[0]) / 2 + 6, (from[1] + to[1]) / 2 - 8);
      }
    } else {
      ctx.beginPath(); ctx.arc(rp[0], rp[1], 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = '#0b1013'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
  ctx.restore();
}

function drawConnectors(ctx, state, view) {
  const showAll = true;
  for (const f of state.connectors.features) {
    const p = f.properties ?? {};
    if (!p.from || !p.to) continue;
    if (!showAll && p.from.level !== state.currentLevel && p.to.level !== state.currentLevel) continue;

    const here = p.from.level === state.currentLevel || p.to.level === state.currentLevel;
    const a = screenFromLocal([p.from.x, p.from.y], view);
    const b = screenFromLocal([p.to.x, p.to.y], view);

    ctx.save();
    ctx.globalAlpha = here ? 1 : 0.28;
    const cross = p.from.level !== p.to.level;
    ctx.strokeStyle = cross ? CONNECTOR_STYLE.crossLevel : CONNECTOR_STYLE.sameLevel;
    ctx.lineWidth = CONNECTOR_STYLE.width;
    ctx.setLineDash(cross ? CONNECTOR_STYLE.dash : []);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);

    for (const [pt, isFrom] of [[a, true], [b, false]]) {
      ctx.fillStyle = isFrom ? CONNECTOR_STYLE.from : CONNECTOR_STYLE.to;
      ctx.beginPath(); ctx.arc(pt[0], pt[1], CONNECTOR_STYLE.endpointRadius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0b1013'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (p.bidirectional === false) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.save();
      ctx.translate(mx, my); ctx.rotate(ang);
      ctx.strokeStyle = CONNECTOR_STYLE.crossLevel; ctx.lineWidth = CONNECTOR_STYLE.width;
      ctx.beginPath(); ctx.moveTo(-6, -5); ctx.lineTo(2, 0); ctx.lineTo(-6, 5); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

/** 跨层设施（电梯/扶梯/楼梯/坡道）的颜色。 */
export const VERTICAL_STYLE = { color: '#C08BFF', radius: 6, unreachable: '#FF7B7B' };

/** 点状设施。和面状设施是同一份数据、同一张类别表，只是几何是点。 */
function drawPointFacilities(ctx, state, view, net) {
  const showLabel = view.scale > 0.25;
  ctx.font = '11px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (const f of state.facilities.features) {
    if (f.geometry?.type !== 'Point') continue;
    if (f.properties?.level !== state.currentLevel) continue;
    const c = f.geometry.coordinates;
    if (!G.isFinitePoint(c)) continue;
    const s = screenFromLocal(c, view);
    const att = net?.attachments?.get(f.id);
    const unreachable = net && (!att || !att.served);

    // ★ 跨层设施画成紫色六边形 + 上下箭头 —— 它是整个模型里唯一
    //   「跨楼层同一个位置」的地方，必须和普通点状设施一眼区分开。
    if (f.properties.verticalGroup) {
      const col = unreachable ? VERTICAL_STYLE.unreachable : VERTICAL_STYLE.color;
      const r = VERTICAL_STYLE.radius;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k - Math.PI / 2;
        const px = s[0] + Math.cos(a) * r, py = s[1] + Math.sin(a) * r;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = unreachable ? 'rgba(255,123,123,0.22)' : 'rgba(192,139,255,0.22)';
      ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      // 上下双箭头 = 垂直交通
      ctx.beginPath();
      ctx.moveTo(s[0], s[1] - 3.2); ctx.lineTo(s[0], s[1] + 3.2);
      ctx.moveTo(s[0] - 2.4, s[1] - 1.2); ctx.lineTo(s[0], s[1] - 3.4); ctx.lineTo(s[0] + 2.4, s[1] - 1.2);
      ctx.moveTo(s[0] - 2.4, s[1] + 1.2); ctx.lineTo(s[0], s[1] + 3.4); ctx.lineTo(s[0] + 2.4, s[1] + 1.2);
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();

      if (showLabel) {
        const lv = f.properties.verticalLevels ?? [];
        const others = lv.filter((x) => x !== f.properties.level);
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = col;
        ctx.textBaseline = 'middle';
        ctx.fillText(`⇕ ${others.length ? others.join(' ') : '未连其他层'}`, s[0] + r + 5, s[1] + 9);
      }
      continue;
    }

    const col = unreachable ? ACCESS_STYLE.bad : (POI_DOT[f.properties.category] ?? '#E8F7F9');
    ctx.beginPath(); ctx.arc(s[0], s[1], 3.4, 0, Math.PI * 2);
    if (unreachable) {
      ctx.fillStyle = 'rgba(255,123,123,0.22)'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = 'rgba(11,16,19,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();
    }

    if (showLabel && f.properties.name) {
      ctx.fillStyle = 'rgba(232,247,249,0.82)';
      ctx.fillText(f.properties.name, s[0] + 7, s[1]);
    }
  }
}

function drawSelection(ctx, state, view, ia) {
  const sel = state.selected();
  // 绘制中的顶点
  const handles = [];
  if (sel) {
    const g = sel.f.geometry;
    if (g?.type === 'Point') handles.push({ p: g.coordinates, kind: 'vertex', fi: -1, vi: -1 });
    else if (g?.type === 'LineString') {
      g.coordinates.forEach((p, vi) => handles.push({ p, kind: 'vertex', fi: -1, vi }));
    } else if (g?.type === 'Polygon') {
      g.coordinates.forEach((ring, ri) => ring.forEach((p, vi) => {
        if (ri === 0 && vi === ring.length - 1) return;    // 闭合点不重复画
        handles.push({ p, kind: 'vertex', fi: ri, vi });
      }));
    }
    if (g?.type === 'Polygon' || g?.type === 'LineString') {
      const rings = g.type === 'Polygon' ? g.coordinates : [g.coordinates];
      ctx.save();
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      for (const ring of rings) {
        ctx.beginPath();
        ring.forEach((p, i) => { const s = screenFromLocal(p, view); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ia.handles = handles;
  for (const h of handles) {
    const s = screenFromLocal(h.p, view);
    ctx.beginPath(); ctx.rect(s[0] - 4, s[1] - 4, 8, 8);
    ctx.fillStyle = '#0b1013'; ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2; ctx.stroke();
  }
}

/**
 * 自动交点预览。
 *
 * 画通行线时，从最后一个顶点到光标这一段如果会和已有线交叉，就在交叉处画一个
 * 醒目的黄圈标出「这里会自动生成一个路口」。
 * 「交叉即连通」是这套模型的核心便利，但看不见就会让人不放心 —— 这条把它画出来。
 */
function drawAutoJunctions(ctx, state, view, ia) {
  const d = ia.draft;
  if (!d || d.kind !== 'polyline' || !d.points.length || !ia.cursorLocal) return;
  const coords = [...d.points, ia.cursorLocal];
  if (coords.length < 2) return;

  const others = state.paths.features
    .filter((f) => f.properties?.level === state.currentLevel && f.geometry?.type === 'LineString')
    .map((f) => ({ id: f.id, coords: f.geometry.coordinates, level: f.properties.level }));

  const hits = ia.crossingPreview ?? [];
  ctx.save();
  for (const h of hits) {
    const s = screenFromLocal(h.point, view);
    ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFD166'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD166'; ctx.fill();
    if (view.scale > 0.3) {
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,209,102,0.95)';
      ctx.textBaseline = 'middle';
      ctx.fillText('将生成路口', s[0] + 13, s[1] - 11);
    }
  }
  ctx.restore();
}

/**
 * 底图的手柄位置。
 *
 * ★ 绘制和命中测试必须用【同一份】坐标 —— 分成两处算的话，手柄画在这里、
 *   点在那里，就会出现「明明点中了却没反应」。
 *
 * 返回 null 表示没有可调的底图。
 */
export function baseMapHandles(state, view) {
  const map = state.activeMap?.(state.currentLevel);
  if (!map) return null;
  const img = state.mapImages?.get(map.id);
  if (!img?.naturalWidth) return null;
  const W = img.naturalWidth, H = img.naturalHeight;
  const toS = (px) => screenFromLocal(state.toLocal(px, map), view);
  const corners = [[0, 0], [W, 0], [W, H], [0, H]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const edgeMids = [
    mid(corners[0], corners[1]),   // 上
    mid(corners[1], corners[2]),   // 右
    mid(corners[2], corners[3]),   // 下
    mid(corners[3], corners[0]),   // 左
  ];

  const handles = [];
  corners.forEach((c, i) => handles.push({ kind: 'corner', i, imgPx: c, screen: toS(c) }));
  edgeMids.forEach((c, i) => handles.push({ kind: 'edge', i, imgPx: c, screen: toS(c) }));

  // 旋转柄：从上边中点朝远离中心的方向推出去
  const centerS = toS([W / 2, H / 2]);
  const topS = toS(edgeMids[0]);
  let dx = topS[0] - centerS[0], dy = topS[1] - centerS[1];
  const L = Math.hypot(dx, dy) || 1;
  handles.push({ kind: 'rotate', imgPx: null, screen: [topS[0] + (dx / L) * 44, topS[1] + (dy / L) * 44] });

  return { map, W, H, corners: corners.map(toS), center: centerS, handles };
}

/** 点是否在屏幕多边形内（底图整体拖动的判定）。 */
export function pointInScreenPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 底图调整手柄：拖动移动、拖角缩放、拖旋转柄旋转 —— 不用手填 xy。
 */
export function drawBaseMapGizmo(ctx, state, view, ia) {
  const g = baseMapHandles(state, view);
  if (!g) return;
  ctx.save();

  // 外框
  ctx.strokeStyle = 'rgba(122,220,228,0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  g.corners.forEach((s, i) => (i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1])));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // 旋转柄连杆
  const rot = g.handles.find((h) => h.kind === 'rotate');
  const topMid = g.handles.find((h) => h.kind === 'edge' && h.i === 0);
  if (rot && topMid) {
    ctx.strokeStyle = 'rgba(122,220,228,0.55)';
    ctx.beginPath(); ctx.moveTo(topMid.screen[0], topMid.screen[1]); ctx.lineTo(rot.screen[0], rot.screen[1]); ctx.stroke();
  }

  for (const h of g.handles) {
    const [x, y] = h.screen;
    ctx.beginPath();
    if (h.kind === 'rotate') {
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD166';
    } else if (h.kind === 'corner') {
      ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fillStyle = '#7ADCE4';
    } else {
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fillStyle = 'rgba(122,220,228,0.75)';
    }
    ctx.fill();
    ctx.strokeStyle = '#0b1013';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 实时数值，边拖边看
  const m = g.map;
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(232,247,249,0.92)';
  ctx.textBaseline = 'middle';
  const info = [
    `比例 ${(m.mPerPx ?? 0).toFixed(4)} m/px`,
    `旋转 ${(m.rotationDeg ?? 0).toFixed(2)}°`,
    `微调 ${(m.nudge?.[0] ?? 0).toFixed(2)}, ${(m.nudge?.[1] ?? 0).toFixed(2)} m`,
    '拖框内=移动　拖角=缩放　拖黄点=旋转',
  ];
  const bx = g.corners[0][0], by = g.corners[0][1] - 14;
  info.forEach((s, i) => ctx.fillText(s, bx + 6, by - (info.length - 1 - i) * 15));
  ctx.restore();
}

function drawDraft(ctx, state, view, ia) {
  const d = ia.draft;
  if (!d) return;
  const pts = d.points.map((p) => screenFromLocal(p, view));
  const isPolyline = d.kind === 'polyline';

  ctx.save();
  ctx.strokeStyle = isPolyline ? '#8FE3B0' : '#7ADCE4';
  ctx.lineWidth = isPolyline ? 3 : 2;
  ctx.setLineDash([6, 4]);
  if (pts.length) {
    ctx.beginPath();
    pts.forEach((s, i) => (i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1])));
    if (ia.cursorLocal) { ctx.lineTo(...screenFromLocal(ia.cursorLocal, view)); }
    ctx.stroke();
  }
  if (d.kind === 'connector' && pts.length === 1 && ia.cursorLocal) {
    const s = screenFromLocal(ia.cursorLocal, view);
    ctx.strokeStyle = '#FF9F5A';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
  }
  if (d.kind === 'measure' && pts.length === 1 && ia.cursorLocal) {
    const s = screenFromLocal(ia.cursorLocal, view);
    ctx.strokeStyle = '#FFD166';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
    const m = G.dist(d.points[0], ia.cursorLocal);
    ctx.setLineDash([]);
    ctx.fillStyle = '#FFD166'; ctx.font = '600 13px ui-monospace, monospace';
    ctx.fillText(`${m.toFixed(2)} m`, (pts[0][0] + s[0]) / 2 + 8, (pts[0][1] + s[1]) / 2 - 8);
  }
  ctx.setLineDash([]);
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i];
    const isLast = i === pts.length - 1;
    const isFirst = i === 0;
    ctx.beginPath(); ctx.arc(s[0], s[1], isLast ? 4.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = isPolyline ? '#8FE3B0' : '#7ADCE4'; ctx.fill();
    ctx.strokeStyle = '#0b1013'; ctx.lineWidth = 1.5; ctx.stroke();
    // ★ 已落下的点要标出「可以吸回来」：起点画个圈（点它 = 闭环），
    //   其他点画个小十字。不标的话用户不知道它们也是吸附目标。
    if (isPolyline && pts.length >= 2) {
      ctx.strokeStyle = isFirst ? '#FFD166' : 'rgba(143,227,176,0.85)';
      ctx.lineWidth = isFirst ? 1.8 : 1.2;
      ctx.beginPath();
      if (isFirst) ctx.arc(s[0], s[1], 8, 0, Math.PI * 2);
      else { ctx.moveTo(s[0] - 7, s[1]); ctx.lineTo(s[0] + 7, s[1]); ctx.moveTo(s[0], s[1] - 7); ctx.lineTo(s[0], s[1] + 7); }
      ctx.stroke();
    }
  }
  // 折线画法：提示「怎么结束」
  if (isPolyline && pts.length >= 2 && ia.cursorLocal) {
    const s = screenFromLocal(ia.cursorLocal, view);
    const hover = ia.snap?.kind === 'draftVertex' || ia.snap?.kind === 'draftEdge';
    ctx.fillStyle = hover ? '#FFD166' : 'rgba(143,227,176,0.85)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(hover ? `吸附：${ia.snap.label}（${ia.snap.target}）` : 'Enter 结束', s[0] + 14, s[1] - 14);
  }
  ctx.restore();
}

function drawSnap(ctx, view, snap) {
  if (!snap) return;
  const s = screenFromLocal(snap.local, view);
  ctx.save();
  ctx.strokeStyle = snap.kind === 'vertex' ? '#FFD166' : snap.kind === 'edge' ? '#7ADCE4' : '#8FA3B0';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(s[0], s[1], 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s[0] - 11, s[1]); ctx.lineTo(s[0] - 8, s[1]);
  ctx.moveTo(s[0] + 8, s[1]); ctx.lineTo(s[0] + 11, s[1]);
  ctx.moveTo(s[0], s[1] - 11); ctx.lineTo(s[0], s[1] - 8);
  ctx.moveTo(s[0], s[1] + 8); ctx.lineTo(s[0], s[1] + 11);
  ctx.stroke();
  if (snap.label) {
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(11,16,19,0.9)';
    const w = ctx.measureText(snap.label).width + 10;
    ctx.fillRect(s[0] + 12, s[1] - 9, w, 18);
    ctx.fillStyle = '#E8F7F9';
    ctx.fillText(snap.label, s[0] + 17, s[1] + 1);
  }
  ctx.restore();
}

function drawScaleBar(ctx, view, W, H) {
  const targets = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const want = 110;                                   // 目标屏幕宽度
  const m = targets.find((t) => t * view.scale >= want) ?? 1000;
  const px = m * view.scale;
  const x = W - 24 - px, y = H - 26;

  ctx.save();
  ctx.fillStyle = 'rgba(11,16,19,0.75)';
  ctx.fillRect(x - 8, y - 16, px + 16, 26);
  ctx.strokeStyle = '#E8F7F9'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 6);
  ctx.stroke();
  ctx.fillStyle = '#E8F7F9';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x + px / 2 - 14, y - 10);
  ctx.restore();
}
