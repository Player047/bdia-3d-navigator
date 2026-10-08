/**
 * 本地米制平面几何工具。
 *
 * ★ 本文件里所有点都是 [x, y] = [东(米), 北(米)]。不涉及经纬度，
 *   唯一的例外是相似变换拟合时把 WGS84 换算成米（见 wgs84ToLocalMeters）。
 *
 * 约定：面 = Ring[]，Ring = [[x,y], ...]，Rings[0] 是外环、其余是洞。
 *       环可以是闭合的（首尾点相同）也可以不是，两种都能正确处理。
 */

const EPS = 1e-9;

/* ------------------------------------------------------------------ 基础 */

export function isFinitePoint(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 方位角，度。0 = 正北(+y)，顺时针为正（正东 = 90）。 */
export function bearingDeg(a, b) {
  const d = Math.atan2(b[0] - a[0], b[1] - a[1]) * (180 / Math.PI);
  return (d + 360) % 360;
}

/** 归一化到 (-180, 180]，用于算转角。 */
export function normalizeAngle(deg) {
  let x = ((deg + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/* ------------------------------------------------------------------ 面积 */

/** 有符号面积（鞋带公式）。闭合环与非闭合环都适用。 */
export function ringArea(ring) {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return s / 2;
}

/** 外环减洞。返回正的平方米数。 */
export function polygonArea(polygon) {
  if (!polygon?.length) return 0;
  let a = Math.abs(ringArea(polygon[0]));
  for (let i = 1; i < polygon.length; i++) a -= Math.abs(ringArea(polygon[i]));
  return a;
}

export function ringIsClosed(ring) {
  if (!ring?.length) return false;
  const a = ring[0], b = ring[ring.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/* ------------------------------------------------- 点与环 / 面的关系 */

/** 射线法。落在边界上时返回 false —— 需要边界判定请配合 pointToRingDistance。 */
export function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, polygon) {
  if (!polygon?.length) return false;
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(pt, polygon[i])) return false;
  return true;
}

/* ------------------------------------------------------------- 线段 */

export function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** 三态符号。★ 必须区分 0（共线/端点重合）与正负，否则相邻边会被误判成严格相交。 */
function sgn(x) {
  return x > EPS ? 1 : x < -EPS ? -1 : 0;
}

function onSegment(a, b, p) {
  return (
    Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS &&
    Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

/** 含端点接触的相交判定。 */
export function segmentsIntersect(a, b, c, d) {
  const o1 = sgn(cross(a, b, c)), o2 = sgn(cross(a, b, d));
  const o3 = sgn(cross(c, d, a)), o4 = sgn(cross(c, d, b));
  if (o1 !== 0 && o2 !== 0 && o1 !== o2 && o3 !== 0 && o4 !== 0 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * 严格相交：交点必须落在两条线段内部，共端点或共线接触都不算。
 * 相邻边共享一个顶点 → 该顶点处两个 cross 值必为 0 → 返回 false。
 */
export function segmentsProperlyIntersect(a, b, c, d) {
  const o1 = sgn(cross(a, b, c)), o2 = sgn(cross(a, b, d));
  const o3 = sgn(cross(c, d, a)), o4 = sgn(cross(c, d, b));
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

export function pointToSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function segmentSegmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  );
}

/* --------------------------------------------------- 环 / 面之间的距离 */

export function pointToRingDistance(p, ring) {
  let best = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = pointToSegmentDistance(p, ring[j], ring[i]);
    if (d < best) best = d;
  }
  return best;
}

export function pointToPolygonDistance(p, polygon) {
  if (!polygon?.length) return Infinity;
  let best = Infinity;
  for (const ring of polygon) best = Math.min(best, pointToRingDistance(p, ring));
  return best;
}

/** 点到面的"关系距离"：在面内返回 0，否则返回到边界的距离。 */
export function pointPolygonGap(p, polygon) {
  return pointInPolygon(p, polygon) ? 0 : pointToPolygonDistance(p, polygon);
}

/**
 * 点在线段上的最近点。
 * @returns { point, t }  t 是参数（0~1），point 是最近点
 */
export function closestPointOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { point: [a[0], a[1]], t: 0 };
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { point: [a[0] + dx * t, a[1] + dy * t], t };
}

/** 点到折线的最近点。 */
export function closestPointOnPolyline(p, coords) {
  let best = null;
  for (let i = 0; i + 1 < coords.length; i++) {
    const r = closestPointOnSegment(p, coords[i], coords[i + 1]);
    const d = dist(p, r.point);
    if (!best || d < best.dist) best = { dist: d, point: r.point, segIndex: i, t: r.t };
  }
  return best;
}

/**
 * 两条线段之间的最近点对。
 * 通行线是【不能进房间】的，它只能停在房间边上 —— 所以要把「线到房间边界」的最近点算准。
 * @returns { dist, p（在 ab 上）, q（在 cd 上） }
 */
export function closestBetweenSegments(a, b, c, d) {
  // 相交时距离为 0，交点就是最近点
  if (segmentsIntersect(a, b, c, d)) {
    const r = closestPointOnSegment(a, c, d);
    // 交点用 a 到 cd 的投影近似（两者都在对方段上）
    const r2 = closestPointOnSegment(r.point, a, b);
    return { dist: 0, p: r2.point, q: r.point };
  }
  const cands = [
    { p: closestPointOnSegment(a, c, d).point, from: 'a' },
    { p: closestPointOnSegment(b, c, d).point, from: 'b' },
    { p: closestPointOnSegment(c, a, b).point, from: 'c' },
    { p: closestPointOnSegment(d, a, b).point, from: 'd' },
  ];
  let best = null;
  for (const cand of cands) {
    let p, q;
    if (cand.from === 'a' || cand.from === 'b') { q = cand.p; p = cand.from === 'a' ? [a[0], a[1]] : [b[0], b[1]]; }
    else { p = cand.p; q = cand.from === 'c' ? [c[0], c[1]] : [d[0], d[1]]; }
    const dd = dist(p, q);
    if (!best || dd < best.dist) best = { dist: dd, p, q };
  }
  return best;
}

/**
 * 折线到多边形边界的最近点对。
 * 用来判断「通行线有没有吸附到这个房间的边缘上」，以及吸附点在哪。
 * @returns { dist, point（在折线上）, edgePoint（在房间边界上） }
 */
export function closestBetweenPolylineAndPolygon(coords, polygon) {
  let best = null;
  for (let i = 0; i + 1 < coords.length; i++) {
    for (const ring of polygon) {
      for (let k = 0; k + 1 < ring.length; k++) {
        const r = closestBetweenSegments(coords[i], coords[i + 1], ring[k], ring[k + 1]);
        if (!best || r.dist < best.dist) best = { dist: r.dist, point: r.p, edgePoint: r.q };
      }
    }
  }
  return best;
}


export function ringBoundaryDistance(r1, r2) {
  let best = Infinity;
  for (let i = 0, n = r1.length; i < n; i++) {
    const a = r1[i], b = r1[(i + 1) % n];
    for (let k = 0, m = r2.length; k < m; k++) {
      const d = segmentSegmentDistance(a, b, r2[k], r2[(k + 1) % m]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

export function polygonBoundaryDistance(polyA, polyB) {
  let best = Infinity;
  for (const ra of polyA) for (const rb of polyB) best = Math.min(best, ringBoundaryDistance(ra, rb));
  return best;
}

/* --------------------------------------------------- 面与面的拓扑关系 */

/** 边界相交（含共线接触）或一个面包含另一个面。不含"间距很近但未接触"。 */
export function polygonsIntersect(a, b) {
  for (const ra of a) {
    for (let i = 0, n = ra.length; i < n; i++) {
      const p1 = ra[i], p2 = ra[(i + 1) % n];
      for (const rb of b) {
        for (let k = 0, m = rb.length; k < m; k++) {
          if (segmentsIntersect(p1, p2, rb[k], rb[(k + 1) % m])) return true;
        }
      }
    }
  }
  return false;
}

export function polygonContainsPolygon(outer, inner) {
  if (!pointInPolygon(inner[0][0], outer)) return false;
  for (const ring of inner) for (const p of ring) if (!pointInPolygon(p, outer)) return false;
  return true;
}

/** 点是否严格在面内部（不在边界附近）。共边相邻时用它避开射线法的边界歧义。 */
export function strictlyInside(p, polygon, eps = 0.05) {
  return pointInPolygon(p, polygon) && pointToPolygonDistance(p, polygon) > eps;
}

/**
 * 正面积重叠判定。
 *
 * ★ 不要用「顶点是否落在对方内部」来判断 —— 射线法对边界点的结果是模糊的。
 *   两个共边相邻的面（例如店铺贴着走廊，门就在那条公共边上）会让走廊的角点
 *   落在店铺的边界线上，从而被误判成重叠。这里改用两条判据：
 *     1) 边界存在严格穿越 → 必有正面积重叠
 *     2) 一个面的质心严格落在另一个面内部（远离边界）→ 包含关系
 *   共边相邻两种情况都不满足，正确返回 false。
 */
export function polygonsOverlap(a, b) {
  for (const ra of a) {
    for (let i = 0, n = ra.length; i < n; i++) {
      const p1 = ra[i], p2 = ra[(i + 1) % n];
      for (const rb of b) {
        for (let k = 0, m = rb.length; k < m; k++) {
          if (segmentsProperlyIntersect(p1, p2, rb[k], rb[(k + 1) % m])) return true;
        }
      }
    }
  }
  return strictlyInside(polygonCentroid(a), b) || strictlyInside(polygonCentroid(b), a);
}

/**
 * 两个面是否"可通行地接触"：边界相交、包含，或最近边界距离 <= tol。
 * 这是判断走廊之间是否连通的核心。tol 一般取 0.05m（画图误差量级）。
 */
export function polygonsConnected(a, b, tol = 0.05) {
  if (polygonsIntersect(a, b)) return true;
  if (polygonContainsPolygon(a, b) || polygonContainsPolygon(b, a)) return true;
  return polygonBoundaryDistance(a, b) <= tol;
}

/* ------------------------------------------------------------ 自交 */

export function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  // 闭合环去掉重复的末点，避免把退化边算进来
  const pts = ringIsClosed(ring) ? ring.slice(0, -1) : ring.slice();
  const m = pts.length;
  if (m < 4) return false;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    for (let k = i + 1; k < m; k++) {
      const c = pts[k], d = pts[(k + 1) % m];
      const adjacent = k === i + 1 || (i === 0 && k === m - 1);
      if (adjacent) {
        if (segmentsProperlyIntersect(a, b, c, d)) return true;
      } else if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------ 其它 */

export function centroidOfRing(ring) {
  let a = 0, cx = 0, cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const f = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    a += f;
    cx += (ring[i][0] + ring[j][0]) * f;
    cy += (ring[i][1] + ring[j][1]) * f;
  }
  if (Math.abs(a) < EPS) return ring[0].slice();
  return [cx / (3 * a), cy / (3 * a)];
}

export function polygonCentroid(polygon) {
  return centroidOfRing(polygon[0]);
}

export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export function polygonBBox(polygon) {
  let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of polygon) {
    const r = ringBBox(ring);
    b = {
      minX: Math.min(b.minX, r.minX), minY: Math.min(b.minY, r.minY),
      maxX: Math.max(b.maxX, r.maxX), maxY: Math.max(b.maxY, r.maxY),
    };
  }
  return b;
}

export function bboxContains(bbox, p) {
  return p[0] >= bbox.minX && p[0] <= bbox.maxX && p[1] >= bbox.minY && p[1] <= bbox.maxY;
}

/* -------------------------------------------------- 经纬度 ↔ 本地米 */

/** WGS84 → 本地米。注意 wgs84 参数是 [lon, lat]（GeoJSON 顺序）。 */
export function wgs84ToLocalMeters(lon, lat, origin, metersPerDegree) {
  return [
    (lon - origin.lon) * metersPerDegree.lon,
    (lat - origin.lat) * metersPerDegree.lat,
  ];
}

/** 本地米 → WGS84，返回 [lon, lat]。 */
export function localMetersToWgs84(x, y, origin, metersPerDegree) {
  return [
    origin.lon + x / metersPerDegree.lon,
    origin.lat + y / metersPerDegree.lat,
  ];
}

/**
 * 2D 相似变换拟合（Procrustes）：求 s、θ、t 使得 q ≈ s·R(θ)·p + t 残差最小。
 * p 是绘制坐标，q 是地理参考坐标（都已是米）。
 *
 * 理想情况 s = 1、θ = 0、t = 0，残差 = 0。
 * 实测中：s 偏离 1 → 画图比例不对；θ 偏离 0 → 平面图没和正北对齐；残差大 → 控制点定错了。
 */
export function fitSimilarity(points) {
  const n = points.length;
  if (n < 2) throw new Error('fitSimilarity 至少需要 2 个控制点');
  const pm = [0, 0], qm = [0, 0];
  for (const { p, q } of points) { pm[0] += p[0] / n; pm[1] += p[1] / n; qm[0] += q[0] / n; qm[1] += q[1] / n; }

  let a = 0, b = 0, normP = 0;
  for (const { p, q } of points) {
    const px = p[0] - pm[0], py = p[1] - pm[1];
    const qx = q[0] - qm[0], qy = q[1] - qm[1];
    a += px * qx + py * qy;      // 点积
    b += px * qy - py * qx;      // 叉积
    normP += px * px + py * py;
  }
  if (normP < EPS) throw new Error('fitSimilarity: 控制点重合，无法拟合');

  const scale = Math.hypot(a, b) / normP;
  const rotationDeg = Math.atan2(b, a) * (180 / Math.PI);
  const cos = Math.cos(rotationDeg * Math.PI / 180);
  const sin = Math.sin(rotationDeg * Math.PI / 180);
  const tx = qm[0] - scale * (cos * pm[0] - sin * pm[1]);
  const ty = qm[1] - scale * (sin * pm[0] + cos * pm[1]);

  const apply = (p) => [
    scale * (cos * p[0] - sin * p[1]) + tx,
    scale * (sin * p[0] + cos * p[1]) + ty,
  ];

  let maxResidual = 0, sumSq = 0;
  const residuals = points.map(({ p, q }) => {
    const t = apply(p);
    const r = Math.hypot(t[0] - q[0], t[1] - q[1]);
    maxResidual = Math.max(maxResidual, r);
    sumSq += r * r;
    return r;
  });

  return {
    scale, rotationDeg, translation: [tx, ty], apply,
    maxResidual, rmsResidual: Math.sqrt(sumSq / n), residuals,
  };
}

/** 折线简化（Douglas–Peucker），用于把寻路输出的折线变成人类可读的转向点。 */
export function simplifyPolyline(points, tolerance = 1.5) {
  if (points.length < 3) return points.slice();
  let maxD = 0, index = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDistance(points[i], first, last);
    if (d > maxD) { maxD = d; index = i; }
  }
  if (maxD <= tolerance) return [first, last];
  return [
    ...simplifyPolyline(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplifyPolyline(points.slice(index), tolerance),
  ];
}
