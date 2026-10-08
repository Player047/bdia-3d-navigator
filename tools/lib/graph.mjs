/**
 * 路由网络编译：区域 + 通行线 + 设施 + 连接件 → 一张可寻路的图。
 *
 * ★ 这个项目的核心约定（和早期版本最大的区别）：
 *
 *   通行线 paths   = 【唯一的寻路图】。端点、顶点、交叉点都是节点；两条线交叉即连通。
 *   区域   regions = 【只是隔离区标记】。它不参与寻路，只负责：
 *                    ① 承载 zone 语义（「这片是安检后的」本质上是面，线表达不了）
 *                    ② 判断通行线有没有画到区域外面去
 *                    ③ 判断设施落在哪个区域上
 *   设施 facilities = 【接入网络的方式由通行线决定】：
 *                    · 面状设施：有没有通行线吸附到它边缘上 → 吸附点就是寻路点
 *                    · 点状设施：有没有通行线经过它 → 它自己就是寻路点
 *
 * ★ 这个模块被两处共用：
 *     · 校验器 —— 建网后做连通性 / 接入 / 悬空检查
 *     · 寻路   —— 同一张网直接跑 Dijkstra
 *   一份实现，不会出现「校验器说通、寻路说断」。
 */

import * as G from './geo.mjs';

/* ------------------------------------------------------------ 线段求交 */

const EPS = 1e-9;

function pointOnSegment(p, a, b, eps = 1e-9) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -eps && dot <= len2 + eps;
}

/**
 * 两条线段的交点。返回数组：
 *   []        不相交
 *   [P]       交于一点（含端点接触、T 型接头）
 *   [P, Q]    共线重叠，返回重叠段的两个端点
 */
/**
 * 带【米制容差】的相接判定。
 *
 * ★ 为什么需要它 —— 这是"吸附画出来的线不生成路口"的根因。
 *
 *   segIntersectionPoints 是精确几何判定，epsilon 是 1e-9。
 *   但编辑器的坐标只存到 2 位小数（1 厘米），
 *   而且吸附到线上的点是【垂足】—— 一条斜线上的垂足几乎不可能
 *   恰好落在厘米网格上：
 *
 *     垂足 (36.69993, -196.73) → 存成 (36.70, -196.73)
 *     偏离线 0.07 厘米 → 精确判定说"不相交" → 不生成路口
 *
 *   于是用户看到的是：「我明明吸附到那条线上了，怎么没成路口？」
 *   而且【时好时坏】：四舍五入后恰好共线就成功，偏一点就失败。
 *
 *   判定本身没错，错在用浮点 epsilon 去量一份只有厘米精度的数据。
 *   相接必须用【米制容差】。
 *
 * @param tol 端点离对方线段多近算相接。默认 2 厘米 ——
 *   比坐标精度（1 厘米）大一档，又远小于任何真实的路径间距。
 */
/* ★ 阈值写在 manifest.thresholds 里，这里只是兜底默认值 —— 见 pathTouchTolerance 的说明 */
export const TOUCH_TOL = 0.02;

export function segTouchPoints(a, b, c, d, tol = TOUCH_TOL) {  const exact = segIntersectionPoints(a, b, c, d);
  if (exact.length) return exact;

  const out = [];
  const distTo = (p, q, r) => {
    const vx = r[0] - q[0], vy = r[1] - q[1];
    const L = vx * vx + vy * vy;
    if (L < 1e-18) return Math.hypot(p[0] - q[0], p[1] - q[1]);
    let t = ((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / L;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (q[0] + t * vx), p[1] - (q[1] + t * vy));
  };

  // 端点落在对方线段附近 → 在【端点处】接头（端点就是实际画的那个点）
  for (const p of [a, b]) if (distTo(p, c, d) <= tol) out.push([p[0], p[1]]);
  for (const p of [c, d]) if (distTo(p, a, b) <= tol) out.push([p[0], p[1]]);

  // 两端都贴但端点不重合（两条平行线贴在一起）→ 取中点，避免生成两个节点
  if (out.length > 2) return [out[0]];
  return out;
}

export function segIntersectionPoints(a, b, c, d, eps = EPS) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  const qpx = c[0] - a[0], qpy = c[1] - a[1];

  if (Math.abs(denom) > eps) {
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
      const tc = Math.min(1, Math.max(0, t));
      return [[a[0] + tc * rx, a[1] + tc * ry]];
    }
    return [];
  }

  if (Math.abs(qpx * ry - qpy * rx) > eps) return [];   // 平行不共线

  const len2 = rx * rx + ry * ry;
  if (len2 < eps) return pointOnSegment(a, c, d) ? [[a[0], a[1]]] : [];
  const tc = (qpx * rx + qpy * ry) / len2;
  const td = ((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / len2;
  const lo = Math.max(0, Math.min(tc, td));
  const hi = Math.min(1, Math.max(tc, td));
  if (hi < lo - eps) return [];
  const at = (t) => [a[0] + t * rx, a[1] + t * ry];
  if (Math.abs(hi - lo) < eps) return [at(lo)];
  return [at(lo), at(hi)];
}

/** 折线自交（相邻段共用端点是正常的，不算）。 */
export function polylineSelfIntersects(coords) {
  const n = coords.length;
  if (n < 4) return false;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = i + 1; j + 1 < n; j++) {
      if (j === i + 1) continue;
      if (segIntersectionPoints(coords[i], coords[i + 1], coords[j], coords[j + 1]).length) return true;
    }
  }
  return false;
}

/**
 * 一条折线相对【其它】折线的全部交点 —— 画线时用来预览「这里会生成路口」。
 * @param others [{ id, level, coords }]
 * @returns [{ point, otherId, level }]
 */
export function crossingsWith(coords, others, opts = {}) {
  const out = [];
  /*
   * ★ 建图用的相接容差是【米制】的，不是浮点 epsilon。
   *   数据只有厘米精度，用精确几何判定会出现「明明吸在线上却没成路口」，
   *   而且时好时坏（看四舍五入落在哪边）。
   *   2 厘米比坐标精度大一档，又远小于任何真实的路径间距。
   */
  const touchTol = opts.touchTolerance ?? opts.thresholds?.pathTouchTolerance ?? TOUCH_TOL;
  for (const other of others) {
    if (other.id === opts.excludeId) continue;
    if (opts.level && other.level && other.level !== opts.level) continue;
    for (let i = 0; i + 1 < coords.length; i++) {
      for (let k = 0; k + 1 < other.coords.length; k++) {
        for (const P of segTouchPoints(coords[i], coords[i + 1], other.coords[k], other.coords[k + 1], touchTol)) {
          out.push({ point: P, otherId: other.id, level: other.level, zone: other.zone });
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((c) => {
    const k = `${c.point[0].toFixed(2)},${c.point[1].toFixed(2)},${c.otherId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------ 折线的距离参数化 */

function makeArc(path) {
  const n = path.coords.length;
  const starts = new Array(n).fill(0);
  let total = 0;
  for (let i = 0; i + 1 < n; i++) {
    starts[i] = total;
    total += G.dist(path.coords[i], path.coords[i + 1]);
  }
  starts[n - 1] = total;
  return { starts, total };
}

function pointAtDistance(path, arc, d) {
  const c = path.coords;
  if (d <= 0) return [c[0][0], c[0][1]];
  if (d >= arc.total) return [c[c.length - 1][0], c[c.length - 1][1]];
  for (let i = 0; i + 1 < c.length; i++) {
    const seg = G.dist(c[i], c[i + 1]);
    if (seg < EPS) continue;
    if (d <= arc.starts[i] + seg) {
      const u = (d - arc.starts[i]) / seg;
      return [c[i][0] + (c[i + 1][0] - c[i][0]) * u, c[i][1] + (c[i + 1][1] - c[i][1]) * u];
    }
  }
  return [c[c.length - 1][0], c[c.length - 1][1]];
}

/* -------------------------------------------------------------- 建图 */

/**
 * 节点身份 = 【楼层 + 坐标】。
 *
 * ★ 楼层必须进 key。不然不同楼层上相同 (x,y) 的两个点会被合并成同一个节点，
 *   各层路网凭空连通，隔离区和跨层设施全都失去意义。
 *   「跨楼层同一个位置」只能由 verticalGroup 显式建立，不能靠坐标撞出来。
 */
const nodeKey = (p, level) => `${level ?? '?'}|${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/**
 * 由通行线建寻路图。
 *
 * @param paths [{ id, level, zone, props, coords: [[x,y],…] }]
 * @param opts  { tolerance, extraNodes }
 *   extraNodes: [{ point, level }] —— 外部锚点（设施寻路点、连接件端点）。
 *   ★ 这些点也必须成为图节点，否则「连接件接在一条线的中间」会找不到节点，
 *     图就在这里断开了。这是很容易漏的一环。
 */
/**
 * 这个设施是不是「可穿过的门」。
 *
 * ★ 类别说了算。
 *   安检 / 边检 / 海关 / 国内出口 / 国际出口这类设施存在的意义
 *   就是【让人穿过去】—— 同类之间不该有差别，没有哪个安检口是
 *   "只让看不让过"的。
 *
 *   所以 manifest 里 facilityCategories[x].through === true 就是门，
 *   个体上的 through 只是个跟上没跟上的记录，关不掉它。
 *
 *   个体标志仍然有用：给【没有声明 through 的类别】里个别确实可穿的设施用。
 */
export function facilityIsThrough(f, manifest) {
  if (manifest?.facilityCategories?.[f?.props?.category]?.through === true) return true;
  return f?.props?.through === true;
}

export function buildGraph(paths, opts = {}) {
  const tol = opts.tolerance ?? 0.05;
  /*
   * ★ 相接容差也从 manifest 读，代码里只留兜底。
   *   原来是写死的常量 —— 和其它十几个阈值分居两处，
   *   改坐标精度时很容易只改一边。见 pathTouchTolerance 的说明。
   */
  const touchTol2 = opts.touchTolerance ?? opts.thresholds?.pathTouchTolerance ?? TOUCH_TOL;
  const list = paths.filter((p) => Array.isArray(p.coords) && p.coords.length >= 2);
  const arcs = new Map(list.map((p) => [p.id, makeArc(p)]));
  const cuts = new Map(list.map((p) => [p.id, []]));
  const autoPoints = [];      // 交叉自动生成的节点，界面要标出来

  // ① 自身顶点都是切点
  for (const p of list) for (const s of arcs.get(p.id).starts) cuts.get(p.id).push(s);

  // ①' 外部锚点：投影到线上，在投影处切一刀
  for (const ex of opts.extraNodes ?? []) {
    if (!Array.isArray(ex?.point)) continue;
    for (const p of list) {
      if (ex.level && p.level !== ex.level) continue;
      const r = G.closestPointOnPolyline(ex.point, p.coords);
      if (!r || r.dist > (ex.tolerance ?? 0.5)) continue;
      const seg = G.dist(p.coords[r.segIndex], p.coords[r.segIndex + 1]);
      cuts.get(p.id).push(arcs.get(p.id).starts[r.segIndex] + seg * r.t);
    }
  }

  // ② 同层两两求交 —— ★ 交叉即连通
  const byLevel = new Map();
  for (const p of list) {
    if (!byLevel.has(p.level)) byLevel.set(p.level, []);
    byLevel.get(p.level).push(p);
  }
  for (const group of byLevel.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const A = group[i], B = group[j];
        if (A.props?.bridge || B.props?.bridge) continue;
        for (let ai = 0; ai + 1 < A.coords.length; ai++) {
          for (let bi = 0; bi + 1 < B.coords.length; bi++) {
            // ★ 同样用米制容差 —— 这里是【真正生成路口】的地方
            const hits = segTouchPoints(A.coords[ai], A.coords[ai + 1], B.coords[bi], B.coords[bi + 1], touchTol2);
            for (const P of hits) {
              cuts.get(A.id).push(arcs.get(A.id).starts[ai] + G.dist(A.coords[ai], P));
              cuts.get(B.id).push(arcs.get(B.id).starts[bi] + G.dist(B.coords[bi], P));
              autoPoints.push({ point: P, level: A.level });
            }
          }
        }
      }
    }
  }

  /*
   * ③ 切分成边，切点按坐标去重成节点
   *
   * ★ 必须带【合并容差】，不能要求坐标精确相等。
   *   用 toFixed(3) 那种精确去重的话，两个线头差 0.1 米就是两个节点 ——
   *   人眼在编辑器里看着是接上的，图里却是断的。
   *   实测数据里出现过「两个节点相距 0.0m 却分属两个连通块」这种情况，
   *   整张网因此碎成 23 块，而界面上每个设施都显示「已接入路网」。
   *
   *   做法：按容差大小的网格分桶，查找时看 3×3 邻域。
   *   只按格子查会漏掉跨格边界的点对，所以邻域必须查满。
   *   ★ 楼层仍然是 key 的一部分：不同楼层的相同 (x,y) 绝不合并，
   *     「跨楼层同一个位置」只能由 verticalGroup 显式建立。
   */
  const mergeTol = opts.nodeMergeTolerance ?? 0.5;
  const cell = Math.max(mergeTol, 1e-6);
  const grid = new Map();
  const edges = [];
  let nodeSeq = 0;
  const bucketKey = (level, cx, cy) => `${level ?? '?'}|${cx},${cy}`;

  const nodeAt = (pt, path) => {
    const cx = Math.floor(pt[0] / cell), cy = Math.floor(pt[1] / cell);
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(bucketKey(path.level, cx + dx, cy + dy));
        if (!bucket) continue;
        for (const n of bucket) {
          const dd = Math.hypot(n.x - pt[0], n.y - pt[1]);
          if (dd <= mergeTol && dd < bestD) { bestD = dd; best = n; }
        }
      }
    }
    if (best) {
      if (!best.paths.includes(path.id)) best.paths.push(path.id);
      best.merged = (best.merged ?? 0) + (bestD > 1e-6 ? 1 : 0);
      return best;
    }
    const n = {
      id: `n${++nodeSeq}`, x: pt[0], y: pt[1], level: path.level, zone: path.zone, paths: [path.id],
    };
    const bk = bucketKey(path.level, cx, cy);
    if (!grid.has(bk)) grid.set(bk, []);
    grid.get(bk).push(n);
    return n;
  };

  for (const p of list) {
    const arc = arcs.get(p.id);
    const ds = [...cuts.get(p.id)].sort((a, b) => a - b);
    const merged = [];
    for (const d of ds) {
      if (d < -tol || d > arc.total + tol) continue;
      const dc = Math.min(arc.total, Math.max(0, d));
      if (!merged.length || dc - merged[merged.length - 1] > tol) merged.push(dc);
    }
    for (let k = 0; k + 1 < merged.length; k++) {
      const p0 = pointAtDistance(p, arc, merged[k]);
      const p1 = pointAtDistance(p, arc, merged[k + 1]);
      const w = G.dist(p0, p1);
      if (w <= tol) continue;
      const a = nodeAt(p0, p), b = nodeAt(p1, p);
      if (a.id === b.id) continue;
      edges.push({
        a: a.id, b: b.id, weight: w,
        pathId: p.id, level: p.level, zone: p.zone,
        accessible: p.props?.accessible !== false,
        speedFactor: p.props?.speedFactor ?? 1,
        bidirectional: p.props?.bidirectional !== false && p.props?.oneWay !== true,
      });
    }
  }

  for (const P of autoPoints) {
    // 用同一套容差查找：交叉点也可能落在已合并节点的容差范围内
    const cx = Math.floor(P.point[0] / cell), cy = Math.floor(P.point[1] / cell);
    let hit = null, bd = Infinity;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (const n of grid.get(bucketKey(P.level, cx + dx, cy + dy)) ?? []) {
          const dd = Math.hypot(n.x - P.point[0], n.y - P.point[1]);
          if (dd <= mergeTol && dd < bd) { bd = dd; hit = n; }
        }
      }
    }
    if (hit) hit.auto = true;
  }

  const nodeList = [...grid.values()].flat();
  const degree = new Map(nodeList.map((n) => [n.id, 0]));
  for (const e of edges) { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1); }
  const junctions = nodeList.filter((n) => (degree.get(n.id) ?? 0) >= 3);

  return {
    nodes: nodeList,
    edges,
    degree,
    stats: {
      paths: list.length,
      nodes: nodeList.length,
      edges: edges.length,
      junctions: junctions.length,
      autoJunctions: nodeList.filter((n) => n.auto).length,
      totalLength: list.reduce((s, p) => s + arcs.get(p.id).total, 0),
    },
  };
}

/* ------------------------------------------------------ 连通分量（并查集） */

export function graphComponents(graph, extraLinks = []) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const n of graph.nodes) find(n.id);
  for (const e of graph.edges) union(e.a, e.b);
  for (const [a, b] of extraLinks) if (a && b) union(a, b);

  const groups = new Map();
  for (const n of graph.nodes) {
    const r = find(n.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n.id);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------ 就近吸附 */

/** 点离最近通行线的距离、最近点、所属线。 */
export function nearestOnPaths(pt, paths, opts = {}) {
  const { level, excludeId } = opts;
  let best = null;
  for (const p of paths) {
    if (level && p.level !== level) continue;
    if (excludeId && p.id === excludeId) continue;
    const r = G.closestPointOnPolyline(pt, p.coords);
    if (r && (!best || r.dist < best.dist)) {
      best = { dist: r.dist, point: r.point, pathId: p.id, level: p.level, zone: p.zone };
    }
  }
  return best;
}

/** 把 [[x,y],…] 按固定间隔采样（含端点）。 */
export function sampleAlong(coords, step = 2, maxSamples = 200) {
  const out = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i], b = coords[i + 1];
    const len = G.dist(a, b);
    const n = Math.max(2, Math.min(Math.ceil(len / step) + 1, maxSamples));
    for (let k = 0; k < n; k++) {
      const u = k / (n - 1);
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
  return out;
}

/* -------------------------------------------------- 设施接入（新模型核心） */

/**
 * 面状设施的寻路点：通行线吸附到它边缘上的那个点。
 *
 * 房间画在区域【外面】，通行线画在区域【里面】，两者在房间的墙上相遇。
 * 所以「路径到房间边界的最近点对」就是入口 —— 线不能进房间。
 */
export function attachAreaFacility(paths, polygon) {
  let best = null;
  for (const p of paths) {
    const r = G.closestBetweenPolylineAndPolygon(p.coords, polygon);
    if (r && (!best || r.dist < best.dist)) {
      best = { dist: r.dist, routingPoint: r.point, edgePoint: r.edgePoint, pathId: p.id, level: p.level, zone: p.zone };
    }
  }
  return best;
}

/** 点状设施的寻路点：它自己。接入距离 = 最近的通行线离它多远。 */
export function attachPointFacility(paths, pt) {
  const r = nearestOnPaths(pt, paths);
  return r
    ? { dist: r.dist, routingPoint: [pt[0], pt[1]], onPath: r.point, pathId: r.pathId, level: r.level, zone: r.zone }
    : null;
}

/** 找离某点最近、且在容差内的图节点。 */
export function nearestNode(graph, pt, level, tol = 0.5) {
  let best = null;
  for (const n of graph.nodes) {
    if (level && n.level !== level) continue;
    const d = Math.hypot(n.x - pt[0], n.y - pt[1]);
    if (d <= tol && (!best || d < best.d)) best = { d, node: n };
  }
  return best ? best.node.id : null;
}

/* ---------------------------------------------------------- 完整网络 */

/**
 * 把四层数据编译成一张可寻路的网络。
 *
 * @param input { regions, paths, facilities, connectors }
 *               每个元素都已被规范化为 { id, level, coords|point|polygons, props }
 * @param opts  { tolerance, areaAttachTolerance, poiPathTolerance, connectorTolerance }
 */
export function buildNetwork(input, opts = {}) {
  const tol = opts.tolerance ?? 0.05;
  /*
   * ★ manifest 要在这里取出来。
   *   它挂在 input 上（不是 opts），下面判断「类别是不是门」要用到它。
   */
  const manifest = input.manifest ?? opts.manifest ?? {};
  const areaTol = opts.areaAttachTolerance ?? 1.0;
  const poiTol = opts.poiPathTolerance ?? 5.0;
  const connTol = opts.connectorTolerance ?? 0.5;

  const paths = (input.paths ?? []).filter((p) => Array.isArray(p.coords) && p.coords.length >= 2);

  /* ---- ① 先算出所有外部锚点（设施寻路点 + 连接件端点）----
     顺序很重要：锚点必须在建图【之前】算出来，作为额外切点传进去。
     否则「连接件接在一条线的中间」在图里找不到节点，整张图会断开。 */

  const facilities = input.facilities ?? [];
  const connectors = input.connectors ?? [];

  const attachments = new Map();
  const unserved = [];
  for (const f of facilities) {
    const isArea = Array.isArray(f.polygons) && f.polygons.length > 0;
    const cands = paths.filter((p) => p.level === f.level);
    let att = null;
    if (isArea) {
      att = attachAreaFacility(cands, f.polygons);
      if (att) { att.kind = 'area'; att.served = att.dist <= areaTol; att.tolerance = areaTol; }
    } else if (f.point) {
      att = attachPointFacility(cands, f.point);
      if (att) { att.kind = 'point'; att.served = att.dist <= poiTol; att.tolerance = poiTol; }
    }
    if (att) {
      att.facilityId = f.id;
      attachments.set(f.id, att);
      if (!att.served) unserved.push(f.id);
    } else {
      unserved.push(f.id);
    }
  }

  const connCands = connectors.filter((c) => {
    const t = c.props?.type ?? c.props?.connectorType;
    return t;
  });

  const connEnds = [];    // { id, side, point, level, zone, dist }
  const connIssues = [];
  for (const c of connCands) {
    for (const side of ['from', 'to']) {
      const e = c.props?.[side];
      if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) {
        connIssues.push({ id: c.id, side, reason: 'BAD_ENDPOINT' });
        continue;
      }
      const cands = paths.filter((p) => p.level === e.level);
      if (!cands.length) { connIssues.push({ id: c.id, side, reason: 'NO_PATH_ON_LEVEL', level: e.level }); continue; }
      const near = nearestOnPaths([e.x, e.y], cands);
      if (!near || near.dist > connTol) {
        connIssues.push({ id: c.id, side, reason: 'NOT_ON_PATH', dist: near?.dist ?? Infinity, point: [e.x, e.y] });
        continue;
      }
      connEnds.push({ id: c.id, side, point: near.point, level: e.level, zone: e.zone, dist: near.dist });
    }
  }

  /* ---- ② 带着锚点建图 ---- */

  /*
   * ★ 门（through: true 的面状设施）：接到它边缘上的【每一条】通行线，
   *   都要在接触点切一个节点。
   *
   *   漏了这一步，「线停在门边上」在图里就找不到节点，门等于没接上 ——
   *   和连接件当初踩的坑一模一样。而且必须在这里算，因为节点是建图时产生的。
   */
  const portalTouches = [];
  for (const f of facilities) {
    /*
     * ★ 「能不能穿」由【类别】决定，个体标志只是没跟上。
     *
     *   原来只看 f.props.through —— 于是出现：类别的 through 声明是 true，
     *   但个体上那个字段是 false（建类别之前画的、或者忘了勾），
     *   结果这个出口在图上【根本不是门】，两侧的线永远不连通。
     *   实测就踩过：国内出口两侧的线都接好了，路却走不通。
     *
     *   而且这件事同类设施应该一致 —— 没有哪个安检口是"只让看不让过"的。
     *   所以类别声明 true 就是 true，个体关不掉。
     */
    if (!facilityIsThrough(f, manifest)) continue;
    if (!Array.isArray(f.polygons) || !f.polygons.length) continue;
    for (const p of paths) {
      if (p.level !== f.level) continue;
      const cp = G.closestBetweenPolylineAndPolygon(p.coords, f.polygons);
      if (cp && cp.dist <= areaTol) {
        portalTouches.push({ facilityId: f.id, pathId: p.id, point: cp.point, level: f.level });
      }
    }
  }

  // ★ 只有【已接入】的设施才产生节点。未接入的设施没有寻路点，
  //   如果连它也切一刀，图上会凭空多出一个用不到的节点（而且容差会被放大到几十米）。
  const extraNodes = [
    ...[...attachments.values()]
      .filter((a) => a.served)
      .map((a) => ({ point: a.routingPoint, level: a.level, tolerance: Math.max(tol, a.dist + tol) })),
    ...connEnds.map((e) => ({ point: e.point, level: e.level, tolerance: connTol })),
    ...portalTouches.map((t) => ({ point: t.point, level: t.level, tolerance: Math.max(tol, 0.6) })),
  ];
  const graph = buildGraph(paths, {
    tolerance: tol,
    extraNodes,
    // ★ 这个必须透传。漏了的话 buildGraph 会一直用它内部的默认值，
    //   阈值改多少都不生效 —— 表现为「调参数没反应」，很难查。
    nodeMergeTolerance: opts.nodeMergeTolerance,
    /*
     * ★ 同样必须透传，理由和上面那条一样：
     *   漏传的话 buildGraph 会一直用代码里的兜底常量，
     *   manifest 里那个 pathTouchTolerance 改多少都不生效。
     *   注意 manifest 在 input 上，不在 opts 上。
     */
    touchTolerance: opts.touchTolerance ?? input.manifest?.thresholds?.pathTouchTolerance,
  });

  /* ---- ③ 门：可穿过的面状设施把接到它边缘上的通行线互相连通 ----
   *
   * ★ 这就是隔离区的分隔机制。
   *   安检 / 边检 / 海关 是「可穿过的面状设施」（properties.through === true）：
   *   所有接到它边缘上的通行线，彼此全部连通。
   *   只看通行线图，这里【本来就是断的】—— 是这个面把它们接上的。
   *
   *   于是「从公共区到隔离区必经安检」不再靠给每条通行线标 zone 来保证，
   *   而是靠拓扑本身：不经过这个面，图里根本走不过去。
   *   不需要谁记得标对什么，也就没有「两条线一不小心挨上，隔离区被绕过」这回事。
   *
   *   ★ 「同区寻路不得借道」这个约束【不在建图阶段做】—— 图是无向的，
   *     门在图上就是一个普通的连通边。约束在寻路阶段做：
   *     起点和终点同 zone 时，直接把所有门边禁掉。见 route.mjs 的 planRoute。
   */
  const portalLinks = [];
  const portalIssues = [];
  const links = [];
  const touchesByFacility = new Map();
  for (const t of portalTouches) {
    if (!touchesByFacility.has(t.facilityId)) touchesByFacility.set(t.facilityId, []);
    touchesByFacility.get(t.facilityId).push(t);
  }

  for (const f of facilities) {
    if (!facilityIsThrough(f, manifest)) continue;
    if (!Array.isArray(f.polygons) || !f.polygons.length) {
      portalIssues.push({ id: f.id, reason: 'NO_POLYGON' });
      continue;
    }
    const touches = touchesByFacility.get(f.id) ?? [];
    if (touches.length < 2) {
      portalIssues.push({ id: f.id, reason: 'TOO_FEW_PATHS', count: touches.length });
      continue;
    }
    const nodes = [...new Set(touches
      .map((t) => nearestNode(graph, t.point, t.level, Math.max(tol, 0.6)))
      .filter(Boolean))];
    if (nodes.length < 2) {
      portalIssues.push({ id: f.id, reason: 'NO_NODE', count: nodes.length });
      continue;
    }
    // 两两相连 —— 接到门上的线彼此全部相通
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        portalLinks.push({
          a: nodes[i], b: nodes[j], id: `portal:${f.id}`,
          kind: 'portal', facilityId: f.id, category: f.props.category,
          minutes: 0,        // 先不计耗时，只标记「通过安检」
        });
      }
    }
  }
  links.push(...portalLinks);

  /* ---- ④ 跨层设施：同一个 verticalGroup 的各层成员在图上连通 ---- */

  /*
   * ★ 这是整个模型里唯一「跨楼层同一个位置」的地方。
   *   一部电梯在 L3F 和 L4F 上各有一个点状设施，坐标【完全相同】，
   *   共享一个 verticalGroup。它们在寻路上相通，3D 里路径就在这里垂直穿过楼板。
   *
   *   注意：组成员先各自接上【本层】的路网（走 E_POI_NOT_ON_PATH 那套），
   *   再由这里把各层的接入点连起来。所以电梯口必须有通行线经过 ——
   *   否则「能坐电梯」这件事在图上根本不存在。
   */
  const vgroups = new Map();
  for (const f of facilities) {
    const gid = f.props?.verticalGroup;
    if (!gid) continue;
    if (!vgroups.has(gid)) vgroups.set(gid, []);
    vgroups.get(gid).push(f);
  }

  const verticalIssues = [];
  for (const [gid, members] of vgroups) {
    const levels = members.map((m) => m.level);
    if (new Set(levels).size !== levels.length) {
      verticalIssues.push({ id: gid, reason: 'DUPLICATE_LEVEL', levels });
    }
    const cats = new Set(members.map((m) => m.kind));
    if (cats.size > 1) verticalIssues.push({ id: gid, reason: 'CATEGORY_MISMATCH', cats: [...cats] });

    // 坐标必须一致 —— 对不上 3D 里的垂直路径就是斜的
    const tol = opts.verticalGroupTolerance ?? 0.05;
    const first = members[0]?.point;
    if (first) {
      for (const m of members) {
        if (!m.point) continue;
        const d = Math.hypot(m.point[0] - first[0], m.point[1] - first[1]);
        if (d > tol) {
          verticalIssues.push({ id: gid, reason: 'POSITION_MISMATCH', level: m.level, dist: d, point: m.point, ref: first });
        }
      }
    }

    // 声明了要连通哪些楼层，就必须每层都有成员
    const declared = members.find((m) => Array.isArray(m.props?.verticalLevels) && m.props.verticalLevels.length)?.props.verticalLevels;
    if (declared) {
      const missing = declared.filter((lv) => !levels.includes(lv));
      if (missing.length) verticalIssues.push({ id: gid, reason: 'MISSING_MEMBER', missing });
      const extra = levels.filter((lv) => !declared.includes(lv));
      if (extra.length) verticalIssues.push({ id: gid, reason: 'UNDECLARED_MEMBER', extra });
    }

    // 各层成员接到本层路网后，把它们两两连起来
    const nodeIds = [];
    for (const m of members) {
      const att = attachments.get(m.id);
      if (!att?.served) continue;
      const n = nearestNode(graph, att.routingPoint, m.level, Math.max(tol, 0.5));
      if (n) nodeIds.push({ node: n, level: m.level, id: m.id });
    }
    const cat = members[0]?.kind;
    // 垂直交通的耗时模型（等梯 + 每层运行）。配置写在 manifest.facilityCategories[cat].vertical。
    // 两处都收，避免调用方放错位置后静默用了兜底值 —— 那样算出来的耗时会不对，而且看不出来。
    const vSpecs = opts.verticalSpecs ?? input.verticalSpecs ?? {};
    const spec = vSpecs[cat] ?? { wait: 1, perLevel: 0.3 };

    /*
     * ★ 单向扶梯。
     *
     *   扶梯在机场常常是单向的：这一部只上不下，要下去得走旁边那部。
     *   允许在跨层设施上声明方向：
     *     "verticalOneWay": { "from": "L3F", "to": "L4F" }
     *   意思是只能从 L3F 到 L4F，反过来走不了。
     *
     *   限制：只对【正好两个楼层】的组有意义。三个层以上说「单向」是含糊的
     *   （从 A 能到 B，那 B 到 C 呢？），所以那种情况直接忽略并报问题。
     */
    const owRaw = members.find((m) => m.props?.verticalOneWay)?.props?.verticalOneWay;
    let ow = null;
    if (owRaw && typeof owRaw === 'object' && owRaw.from && owRaw.to) {
      if (levels.length === 2) {
        if (!levels.includes(owRaw.from) || !levels.includes(owRaw.to)) {
          verticalIssues.push({ id: gid, reason: 'ONEWAY_LEVEL_UNKNOWN', oneWay: owRaw, levels });
        } else {
          ow = { from: owRaw.from, to: owRaw.to };
        }
      } else {
        verticalIssues.push({ id: gid, reason: 'ONEWAY_NEEDS_TWO_LEVELS', levels: [...levels], oneWay: owRaw });
      }
    }

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const span = Math.abs(levelOrder(nodeIds[i].level) - levelOrder(nodeIds[j].level)) || 1;
        const lvA = nodeIds[i].level, lvB = nodeIds[j].level;
        let a = nodeIds[i].node, b = nodeIds[j].node;
        let oneWay = false;
        if (ow) {
          // 两端正好是声明的 from/to 才单向；别的层对（理论上不存在）不受影响
          if (lvA === ow.from && lvB === ow.to) oneWay = true;
          else if (lvA === ow.to && lvB === ow.from) { a = nodeIds[j].node; b = nodeIds[i].node; oneWay = true; }
        }
        links.push({
          a, b, id: gid,
          kind: 'vertical', category: cat,
          minutes: (spec.wait ?? 0) + (spec.perLevel ?? 0.3) * span,
          from: nodeIds[i].id, to: nodeIds[j].id,
          oneWay,                       // ★ true 表示只有 a → b，反向走不了
        });
      }
    }
  }

  /* ---- ⑤ 连通分量（含连接件与跨层设施）---- */

  const comps = graphComponents(graph, links.map((l) => [l.a, l.b]));
  const nodeComp = new Map();
  comps.forEach((g, i) => g.forEach((id) => nodeComp.set(id, i)));

  return {
    graph,
    attachments,
    unserved,
    links,
    connIssues,
    portalIssues,
    portalTouches,
    verticalIssues,
    verticalGroups: vgroups,
    components: comps,
    nodeComp,
    /* ---- 下面这些是给寻路和界面用的查表 ---- */
    pathsById: new Map(paths.map((p) => [p.id, p])),
    connectorsById: new Map(connectors.map((c) => [c.id, c])),
    facilitiesById: new Map(facilities.map((f) => [f.id, f])),
    manifest: input.manifest ?? null,
    stats: {
      ...graph.stats,
      facilities: (input.facilities ?? []).length,
      // ★ 不能写成 attachments.size - unserved.length：
      //   unserved 里既有「接上了但太远」也有「根本没接上（attachments 里没有）」，
      //   一减就出负数。直接数 served 的个数。
      served: [...attachments.values()].filter((a) => a.served).length,
      unserved: unserved.length,
      links: links.length,
      verticalGroups: vgroups.size,
      verticalLevels: [...vgroups.values()].reduce((s, m) => s + m.length, 0),
      components: comps.length,
    },
  };
}

/** 楼层顺序（manifest.levels[x].order），用来算跨几层。 */
let LEVEL_ORDER = {};
export function setLevelOrder(levels) {
  LEVEL_ORDER = {};
  for (const [k, v] of Object.entries(levels ?? {})) LEVEL_ORDER[k] = v?.order ?? 0;
}
function levelOrder(lv) { return LEVEL_ORDER[lv] ?? 0; }

/* ---------------------------------------------------------- 规范化输入 */

/** 把 GeoJSON FeatureCollection 规范化成 buildNetwork 的输入。 */
export function normalizeFeatures(fc) {
  const out = [];
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    out.push({
      id: f.id,
      level: f.properties?.level,
      zone: f.properties?.zone,
      kind: f.properties?.kind ?? f.properties?.category,
      point: g.type === 'Point' ? g.coordinates : null,
      coords: g.type === 'LineString' ? g.coordinates : null,
      polygons: g.type === 'Polygon' ? g.coordinates : null,
      props: f.properties ?? {},
      feature: f,
    });
  }
  return out;
}
