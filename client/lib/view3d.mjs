/**
 * 3D 视图：投影 + 场景构建 + 绘制。
 *
 * ★ 为什么不用 three.js：整个项目是零依赖的，而且 plans/ 是本机目录、
 *   客户端必须能离线跑。这个场景又很规整 —— 平面上的拉伸棱柱，
 *   用「画家算法 + 手写透视投影」完全够用，而且行为完全可控。
 *
 * 场景构成（用户定的模型）：
 *   楼板    = 区域面（可通行区域标记）拉伸成一块薄板
 *   房间    = 面状设施拉伸成体
 *   路线    = 通行线贴着楼板顶面画
 *   标记    = 点状设施立在楼板上面
 */


import { MAP } from './palette.mjs';

/* ------------------------------------------------------------ 向量/矩阵 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * 建一个观察矩阵。
 * 本地坐标是 (x=东, y=北, z=上)，屏幕是 y 向下，投影时会翻。
 */
export function makeCamera(eye, target, up = [0, 0, 1]) {
  const fwd = norm(sub(target, eye));
  let right = cross(fwd, up);
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0];      // 正俯视时的退化情况
  right = norm(right);
  const realUp = cross(right, fwd);
  /*
   * ★ 必须把 target 一起返回。
   *   调用方（相机动画、跟走转轨道）需要它来插值和换算，
   *   而 target 就在参数里、本来就有 —— 不返回纯属遗漏。
   *
   *   漏了它的代价：cam.target 是 undefined，
   *   于是 cam.target.slice() 抛 "Cannot read properties of undefined"，
   *   而且是【在交互过程中】抛的 —— 界面表现是
   *   「步骤卡不更新」+「视角不能动」两个看起来无关的毛病，
   *   实际上是同一行缺失。查了很久。
   */
  return { eye, target, fwd, right, up: realUp };
}

/**
 * 透视投影。
 * @returns { x, y, depth } 屏幕坐标（CSS 像素）+ 相机空间深度；depth <= near 表示在身后
 */
export function project(p, cam, w, h, fovDeg = 55) {
  const d = sub(p, cam.eye);
  const z = dot(d, cam.fwd);
  if (z <= 0.05) return null;                               // 在相机后面或太近
  const f = (h / 2) / Math.tan((fovDeg * Math.PI) / 360);
  return {
    x: w / 2 + (dot(d, cam.right) / z) * f,
    y: h / 2 - (dot(d, cam.up) / z) * f,
    depth: z,
  };
}

/* ---------------------------------------------------------- 场景构建 */

/** 房间拉伸高度（米）。 */
export const ROOM_HEIGHT = 3.2;
/** 楼板厚度（米）。 */
export const SLAB_THICK = 0.35;
/** 楼层间距（米）。 */
export const LEVEL_GAP = 5;

/** 楼层 → 世界 z。用 manifest.levels[].order 排高低。 */
export function levelZ(manifest, level) {
  const o = manifest?.levels?.[level]?.order ?? 0;
  return o * LEVEL_GAP;
}

/** 凸包（Andrew monotone chain）。区域没画时拿它当楼板轮廓的兜底。 */
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (arr) => {
    const out = [];
    for (const q of arr) {
      while (out.length >= 2 && (out[out.length - 1][0] - out[out.length - 2][0]) * (q[1] - out[out.length - 2][1])
        - (out[out.length - 1][1] - out[out.length - 2][1]) * (q[0] - out[out.length - 2][0]) <= 0) out.pop();
      out.push(q);
    }
    return out;
  };
  const lo = half(p), hi = half(p.slice().reverse());
  const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
  return hull.length >= 3 ? hull : pts.slice();
}

/**
 * 从数据建 3D 场景。
 *
 * @param data { manifest, regions: [{level, polygons, props}], facilities, paths }
 * @param opt  { levels } 只渲染这几层；不给就全部
 */
/**
 * 炸开之后的楼层 z。
 *
 * ★ 必须和 buildScene 里的 Z() 用同一个公式。
 *   路线、起终点、高亮这些东西的 z 是在 app.js 里算的（不走 buildScene），
 *   如果它们继续用未炸开的 levelZ，开启炸开之后就会【飘在错误的高度上】——
 *   楼板拉开了，路线还留在原地。
 */
export function explodedZ(manifest, level, explode = 1) {
  const keys = manifest?.levels ? Object.keys(manifest.levels).filter((k) => !k.startsWith('_')) : [];
  const all = keys.length ? keys.map((k) => levelZ(manifest, k)) : [0];
  const lowest = Math.min(...all);
  return lowest + (levelZ(manifest, level) - lowest) * explode;
}

/**
 * 设施的显示名。
 *
 * ★ 和 app.js 的 facilityTitle() 用【同一套规则】，不能各写一套。
 *   很多设施的名字不在 name 字段里 —— 登机口的名字是 labelKey 指向的
 *   gateNo（E42），卫生间的名字由 titlePrefix 字段拼出来（男 + 卫生间）。
 *   这里只用 name 的话，那些设施的标签会显示成 fac-l3f-0314 这种 id。
 */
function displayName(f, manifest) {
  const p = f?.props ?? {};
  const cat = p.category;
  const def = manifest?.facilityCategories?.[cat];
  const values = p.fields ?? {};
  const catName = def?.name ?? cat ?? '';

  for (const d of (def?.fields ?? [])) {
    if (!d.titlePrefix) continue;
    const v = values[d.key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const opt = (d.options ?? []).find((o) => o.value === String(v));
    const prefix = opt?.label ?? String(v);
    return p.name ? `${prefix}${catName} ${p.name}` : `${prefix}${catName}`;
  }
  if (p.name) return p.name;
  const lk = def?.labelKey;
  if (lk && values[lk] !== undefined && String(values[lk]).trim() !== '') return String(values[lk]);
  return catName || f.id;
}

export function buildScene(data, opt = {}) {
  const polys = [];
  const voidRings = [];      // 挑空：楼板上要挖的洞
  const want = opt.levels ? new Set(opt.levels) : null;
  const inLevel = (lv) => !want || want.has(lv);

  /*
   * ★ 楼层【炸开】：把层与层之间的竖直距离乘一个系数。
   *
   *   为什么在这里做、不在绘制时做：
   *   场景里的 z 是【建场景时烘焙进去的】—— 楼板的 base/top、
   *   通行线每个点的 z、标记的 z，一共 5 个地方。
   *   改成绘制时加偏移的话，要动 draw3d 里所有用到 z 的地方（十几处），
   *   而且【每漏一处都会静默出错】：某个东西飘在错误的楼层上、
   *   或者被别的层挡住 —— 都是"看着不对但说不上哪不对"。
   *
   *   包在这里只要一处。建场景本来就不贵，切换炸开时重建一次即可。
   */
  const explode = opt.explode ?? 1;
  const Z = (lv) => explodedZ(data.manifest, lv, explode);

  /* ---- 楼板：区域面拉伸 ---- */
  const regionsByLevel = new Map();
  for (const r of data.regions ?? []) {
    if (!inLevel(r.level)) continue;
    if (!regionsByLevel.has(r.level)) regionsByLevel.set(r.level, []);
    regionsByLevel.get(r.level).push(r);
  }

  // 每层的内容包围盒 —— 区域没画时用它生成一块兜底楼板
  const boundsByLevel = new Map();
  const eat = (lv, x, y) => {
    if (!boundsByLevel.has(lv)) boundsByLevel.set(lv, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const b = boundsByLevel.get(lv);
    b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
    b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
  };
  for (const p of data.paths ?? []) { if (inLevel(p.level)) for (const c of p.coords) eat(p.level, c[0], c[1]); }
  for (const f of data.facilities ?? []) {
    if (!inLevel(f.level)) continue;
    if (f.point) eat(f.level, f.point[0], f.point[1]);
    for (const ring of f.polygons ?? []) for (const c of ring) eat(f.level, c[0], c[1]);
  }

  for (const lv of new Set([...(data.paths ?? []).map((p) => p.level), ...(data.facilities ?? []).map((f) => f.level)])) {
    if (!inLevel(lv)) continue;
    const zo = Z(lv);
    const regions = regionsByLevel.get(lv) ?? [];
    /*
     * ★ 楼板【只依据 kind = walkable 的「可通行面」区域】。
     *   别的种类（候机区 / 走廊 / 指廊…）只是语义标签，参与着色和判断，
     *   但不参与画楼板 —— 一个楼层画一块可通行面就够了，
     *   形状可以很复杂（航站楼本来就不是矩形）。
     *
     *   挑空在下面统一用 evenodd 扣掉，见 drawPrism。
     *
     *   兜底顺序：可通行面 → 任意区域 → 内容的凸包。
     *   最后那层只是「什么区域都没画」时的权宜之计，
     *   总比让房间悬在空中强，但它不是真实轮廓。
     */
    const walkable = regions.filter((r) => r.props?.kind === 'walkable');
    const slabSrc = walkable.length ? walkable : regions;
    /*
     * ★ polygons 是【环的数组】：[[ [x,y], [x,y], … ], …]，不是「多边形」的数组。
     *   写成 poly[0] 会把「一个坐标点」当成环，投影出 NaN ——
     *   而且不报错，只是屏幕上什么都没有，很难查。
     */
    const outlines = slabSrc.length
      ? slabSrc.flatMap((r) => r.polygons.map((ring) => ({
        ring, name: r.props?.name, fill: MAP.slab, fallback: false,
      })))
      : (() => {
        const b = boundsByLevel.get(lv);
        if (!b) return [];
        const pts = [];
        for (const p of data.paths ?? []) if (p.level === lv) pts.push(...p.coords);
        for (const f of data.facilities ?? []) if (f.level === lv && f.point) pts.push(f.point);
        const hull = convexHull(pts);
        return hull.length >= 3 ? [{ ring: hull, name: '（未画可通行面，用路径轮廓兜底）', fill: MAP.slab, fallback: true }] : [];
      })();

    for (const o of outlines) {
      polys.push({
        kind: 'slab', level: lv, name: o.name, id: `slab:${lv}`,
        base: zo - SLAB_THICK, top: zo,
        ring: o.ring, fill: o.fill, fallback: o.fallback,
      });
    }
  }

  /* ---- 房间：面状设施拉伸 ---- */
  for (const f of data.facilities ?? []) {
    if (!inLevel(f.level)) continue;
    if (!f.polygons?.length) continue;
    const zo = Z(f.level);
    const h = f.props?.height ?? ROOM_HEIGHT;
    // ★ 同上：f.polygons 里的每一项本身就是【一个环】，不要再取 [0]
    for (const ring of f.polygons) {
      polys.push({
        kind: 'room', level: f.level, id: f.id, name: displayName(f, data.manifest),
        category: f.props?.category,
        base: zo, top: zo + h, ring,
        fill: f.props?.fill ?? MAP.room,
      });
    }
  }

  /* ---- 路线：通行线（贴楼板顶面）---- */
  const lines = [];
  for (const p of data.paths ?? []) {
    if (!inLevel(p.level)) continue;
    const zo = Z(p.level);
    lines.push({
      kind: 'path', level: p.level, id: p.id, name: p.props?.name ?? p.id,
      pts: p.coords.map((c) => [c[0], c[1], zo + 0.05]),
      kindOf: p.props?.kind,
    });
  }

  /* ---- 标记：点状设施 ---- */
  const markers = [];
  for (const f of data.facilities ?? []) {
    if (!inLevel(f.level) || !f.point) continue;
    const zo = Z(f.level);
    /*
     * ★ 显示名优先用类别的 labelKey 字段（登机口 = 编号）。
     *   名字留空、编号单独成字段之后，直接用 props.name 会画出一串 id。
     */
    const lk = data.manifest?.facilityCategories?.[f.props?.category]?.labelKey;
    const label = f.props?.name || (lk ? f.props?.fields?.[lk] : null) || '';
    markers.push({
      kind: 'marker', level: f.level, id: f.id, name: label || f.id,
      category: f.props?.category,
      x: f.point[0], y: f.point[1], z: zo + 1.1,
      vertical: !!f.props?.verticalGroup,
    });
  }

  /* ---- 障碍物 ----
   *
   * ★ 分两类，处理方式完全不同：
   *   柱子/柜台/设备/封闭区域…  = 实体，纵向拉伸成体（半透明，别把视线挡死）
   *   void（挑空）              = 空的，要在楼板上【挖洞】
   *
   *   挑空不是「一个立起来的东西」，它是一块【没有地板】的区域。
   *   当成实体拉伸的话，看起来就像地上多了个柱子，语义正好相反。
   */
  for (const o of data.obstacles ?? []) {
    if (!inLevel(o.level)) continue;
    if (!o.polygons?.length) continue;
    const zo = Z(o.level);
    const kind = o.props?.kind;
    for (const ring of o.polygons) {
      if (kind === 'void') {
        voidRings.push({ level: o.level, ring });      // 交给楼板去挖
      } else {
        const h = o.props?.height ?? (kind === 'column' ? 4.0 : 3.0);
        polys.push({
          kind: 'obstacle', level: o.level, id: o.id, name: o.props?.name ?? kind,
          base: zo, top: zo + h, ring,
          fill: kind === 'column' ? MAP.column : MAP.obstacle,
          alpha: 0.55,                                   // 半透明：障碍物只是提示，不该挡路
        });
      }
    }
  }

  return { polys, lines, markers, boundsByLevel, voidRings };
}

/** 近平面。比这个还近就不投影了。 */
const NEAR = 0.12;

/** 世界坐标 → 相机坐标。 */
function toCam(p, cam) {
  const d = sub(p, cam.eye);
  return [dot(d, cam.right), dot(d, cam.up), dot(d, cam.fwd)];
}

/**
 * 把多边形按近平面裁掉。
 *
 * ★ 这是必须的，不能「有一个点投不出来就整块放弃」。
 *   视角一近，楼板这种大物体的部分顶点就会跑到相机身后，
 *   整块丢掉的话 —— 表现就是「凑近了楼板就不渲染了」。
 *   折线那边踩过同一个坑（一条线有一个点在身后，整条线消失）。
 *
 *   Sutherland–Hodgman，只对一个平面（z = NEAR）裁。
 */
function clipNear(poly) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ain = a[2] >= NEAR, bin = b[2] >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}

/** 世界坐标的多边形 → 屏幕多边形。裁完不足 3 个点才算真的看不见。 */
export function projectRing(pts3, cam, w, h, fovDeg = 55) {
  const clipped = clipNear(pts3.map((p) => toCam(p, cam)));
  if (clipped.length < 3) return null;
  const f = (h / 2) / Math.tan((fovDeg * Math.PI) / 360);
  return clipped.map((c) => ({
    x: w / 2 + (c[0] / c[2]) * f,
    y: h / 2 - (c[1] / c[2]) * f,
    depth: c[2],
  }));
}

/* ------------------------------------------------------------ 绘制 */

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

/**
 * 画一帧。
 *
 * ★ 不用「全局按深度排序」那一套。
 *   楼板是一整块大平面，它的【质心深度】代表不了它自己：
 *   靠近楼板远端的房间，深度比楼板质心还大，于是楼板被排在房间后面画，
 *   直接把房间盖掉了 —— 表现出来就是「部分设施可见」，而且摄像机一动
 *   排序来回翻，画面随机闪烁。
 *
 *   这个场景其实是「一层一层的东西摞在楼板上、互不穿插」，
 *   所以正确的做法是【分层绘制】而不是全局排序：
 *     楼层（按 z 从低到高）
 *       ├─ 楼板      永远先画（它就是地面）
 *       ├─ 房间      彼此之间按深度排（远→近）
 *       ├─ 通行线    贴在地面上，画在房间之后
 *       └─ 点标记    立在上面，最后画
 *   层内稳定、层间确定，不会有任何闪动。
 *
 * @param ctx  canvas 2d
 * @param sc   buildScene() 结果
 * @param cam  makeCamera() 结果
 * @param opt  { w, h, fov, only: Set<level>, routeLines }
 *   only: 只画这几层。★ 浏览模式就是靠它做到「只渲染当前层」——
 *         早先用的是「其它层淡化到 18%」，但那要调用方自己判断，
 *         单层时条件为假，结果所有楼层都全不透明地画了上来。
 *   routeLines: [{ pts: [[x,y,z],…], current: bool }]
 *         ★ 分两趟画：非当前步的贴在地面上（于是会被房间正常遮挡，不穿墙），
 *           当前步的放到最后画 —— 脚下那一段必须永远看得见。
 *   xray: 是否把通行线透视显示（默认 false = 完全遮挡）
 */
export function draw3d(ctx, sc, cam, opt) {
  const { w, h, fov = 55, only, routeLines = [], xray = false, selected = null, explode = 1 } = opt;
  const P = (p) => project(p, cam, w, h, fov);
  const depthOf = (p) => dot(sub(p, cam.eye), cam.fwd);
  /*
   * ★ 起终点、高亮这些东西的 z 必须用【炸开之后】的值。
   *   用 levelZ 的话，楼板已经拉开了、标记还留在原地 ——
   *   看上去就是"起终点飘在半空中"。
   */
  const EZ = (lv) => explodedZ(opt.manifest, lv, explode);
  /*
   * ★ 是否同时画了多层。
   *   挑空的处理方式取决于这个 —— 见下面挑空那一段的说明：
   *   只有下面那层真的画出来了，"透明的洞"才透得出东西。
   */
  const multiLevel = explode > 1 || (only ? only.size > 1 : false);
  /*
   * ★ 跟走时"当前步附近的设施" —— 用暖橙涂出来。
   *   2D / 3D 共用同一份 id 集合（由 app.js 算好传进来）。
   */
  const nearby = opt.nearby ?? null;   // 标记色见 palette.nearby（暗蓝紫）
  /*
   * ★ 聚焦楼层：非聚焦层整体降透明度。
   *   返回当前该用的 alpha 倍率 —— 直接乘进每层的绘制里。
   */
  const focus = opt.focusLevel ?? null;
  const focusAlpha = (lv) => (!focus || lv === focus ? 1 : 0.22);

  const inView = (lv) => !only || only.has(lv);
  const sel = selected;

  /**
   * 标签卡片 —— 按 Material 3 的做法。
   *
   * M3 里这类东西是 **label + status dot**，规则很明确：
   *
   *   容器   surface-container-highest（比背景【亮一档】的实底）
   *   文字   on-surface，label-large（13~14px medium）
   *   形状   shape-small = 8px 圆角（不是随手取的圆角）
   *   状态点 7px 圆点，用强调色 —— M3 用【圆点】表示状态，不用竖条
   *   间距   左右 11px，圆点与文字之间 7px
   *
   * ★ 为什么把半透明黑底换成实底：
   *   半透明底压在楼板上会跟着背景变浅 —— 同一张卡片在不同底色上
   *   明度不一样，看着"脏"。M3 的做法是【实底 + 比背景亮一档】，
   *   这样它永远是从背景里"浮起来"，而不是"混进去"。
   */
  const labelCard = (x, y, text, accent) => {
    ctx.font = '500 13px "Roboto", "Noto Sans SC", system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 11, dot = 7, gap = 7;
    const tw = ctx.measureText(text).width;
    const wBox = tw + padX * 2 + dot + gap;
    const hBox = 26;                 // M3 触摸目标下限是 24，取 26
    const r = 8;                     // shape-small
    const x0 = x, y0 = y - hBox / 2, x1 = x + wBox, y1 = y + hBox / 2;

    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r);
    ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
    ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
    ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
    ctx.closePath();
    ctx.fillStyle = '#36343B';                    // M3 dark: surface-container-highest
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 状态圆点（M3 用圆点，不用竖条）
    ctx.beginPath();
    ctx.arc(x0 + padX + dot / 2, y, dot / 2, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();

    ctx.fillStyle = '#E6E0E9';                    // M3 on-surface
    ctx.fillText(text, x0 + padX + dot + gap, y + 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  };

  /**
   * 把一条线段按【近平面】裁开，返回可见的那一半（或 null）。
   *
   * ★ 这是「跟走时附近的通行线会消失、转一下又出现」的根因。
   *
   *   原来的做法是：投影两个端点，只要有一个是 null（在相机身后）
   *   就【整段跳过】。可是相机贴近地面跟走时，
   *   脚下那一段路的两端几乎总有一个在身后 ——
   *   于是最近、最该看见的那一段反而最先消失。
   *   稍微转一下视角，端点跑到身前了，它又回来了。
   *
   *   正确做法和楼板那边一样（projectRing 的 Sutherland–Hodgman）：
   *   线段和近平面求交，把身后的部分切掉，剩下的照画。
   *   一根线段最多切一刀，所以只需要线性插值一次。
   */
  const clipSegNear = (a3, b3) => {
    const da = dot(sub(a3, cam.eye), cam.fwd);
    const db = dot(sub(b3, cam.eye), cam.fwd);
    const okA = da >= NEAR;
    const okB = db >= NEAR;
    if (okA && okB) return [a3, b3];
    if (!okA && !okB) return null;
    // 一刀切：交点参数 t 由 (NEAR - da) / (db - da) 得到
    const t = (NEAR - da) / (db - da);
    const mid = [
      a3[0] + (b3[0] - a3[0]) * t,
      a3[1] + (b3[1] - a3[1]) * t,
      a3[2] + (b3[2] - a3[2]) * t,
    ];
    return okA ? [a3, mid] : [mid, b3];
  };

  /**
   * 画一条折线（路线 / 通行线）。
   *
   * ★ 逐【段】处理，而且每段都要【按近平面裁剪】。
   *   早先是整条一起判断（有一个点投不出来就整条丢掉）——
   *   后来改成逐段，但仍然是"投不出来就跳过这一段"，
   *   对贴近地面的跟走视角来说，这等于把最近的那段路藏起来。
   */
  const strokePath = (pts3, color, width, halo = true) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i + 1 < pts3.length; i++) {
      const seg = clipSegNear(pts3[i], pts3[i + 1]);
      if (!seg) continue;
      const a = P(seg[0]);
      const b = P(seg[1]);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (halo) {
        ctx.strokeStyle = MAP.bg;
        ctx.lineWidth = width + 4;
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  };

  /* ---- 收集要画的楼层，按高度从低到高 ---- */
  const zOf = new Map();
  for (const o of sc.polys) if (inView(o.level) && !zOf.has(o.level)) zOf.set(o.level, o.base);
  for (const l of sc.lines) if (inView(l.level) && !zOf.has(l.level)) zOf.set(l.level, l.pts[0]?.[2] ?? 0);
  for (const m of sc.markers) if (inView(m.level) && !zOf.has(m.level)) zOf.set(m.level, m.z);
  const levels = [...zOf.keys()].sort((a, b) => zOf.get(a) - zOf.get(b));

  const drawPrism = (o, layerAlpha = 1) => {
    const topZ = o.top, botZ = o.base;
    // ★ 用 projectRing（带近平面裁剪），不是「有一个点投不出来就整块放弃」。
    const top = projectRing(o.ring.map((c) => [c[0], c[1], topZ]), cam, w, h, fov);
    if (!top) return;
    const alpha = o.alpha ?? 1;

    /*
     * ★ 侧面【不做背面剔除】。
     *   多边形在编辑器里是手画的，绕向不保证，靠法向判断正反面会有一半画反。
     *   改成：所有侧面按深度远→近全画，顶面最后画。
     *   凸棱柱从外面看，近的侧面自然盖住远的，顶面盖住全部侧面。
     *
     * ★ 但【侧面必须画成不透明的】，哪怕整个物体要半透明。
     *   侧面也带 alpha 的话，背面的侧面会透过正面显出来 ——
     *   看上去像个玻璃盒子，能看到"背后的面"。实测就是这样。
     *   所以：侧面不透明（用更暗的固有色），只有顶面带 alpha。
     *   体块看起来是实的，顶面是透的，既保留拉伸感又没有穿帮。
     */
    const sides = [];
    for (let i = 0; i < o.ring.length - 1; i++) {
      const a = o.ring[i], b = o.ring[i + 1];
      const quad = [[a[0], a[1], topZ], [b[0], b[1], topZ], [b[0], b[1], botZ], [a[0], a[1], botZ]];
      const q = projectRing(quad, cam, w, h, fov);
      if (!q) continue;
      sides.push({ d: depthOf([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (topZ + botZ) / 2]), q });
    }
    sides.sort((x, y) => y.d - x.d);

    /*
     * ★ 当前步附近的设施涂暖橙。
     *   只改【基色】—— 侧面和顶面都是从 base 推导的（shade(base, x)），
     *   所以整个体块会整体变色，侧看俯看都认得出。
     */
    const near = !!(nearby && o.kind === 'room' && nearby.has(o.id));
    /*
     * ★ 建筑本身【保持不透明】，变淡的是叠上去的那层提示色。
     *
     *   我上一版把整个棱柱降到 alpha 0.5 —— 那是错的：
     *   建筑变半透明之后，背面的墙会透出来，看着像个玻璃盒子，
     *   而且和周边不透明的建筑不在一个"实体感"上。
     *   用户要的是「提示色别那么显眼」，不是「建筑变虚」。
     *
     *   所以：基色照旧（不透明），画完顶面之后再【叠一层】半透明蓝紫。
     */
    const base = o.fill ?? MAP.room;
    const alphaFinal = alpha;
    /*
     * ★ 整块都带 alpha —— 侧面也不透明处理是错的。
     *   半透明时背面的侧面会透过正面显出来，看着像个玻璃盒子。
     *   这是【故意的】：障碍物是「这里走不过去」的提示层，不是实体。
     *   看得出是半透明覆盖物，反而不会被误当成能走的地方；
     *   而且正因为透，它和房间谁先画谁后画就不那么要紧了 ——
     *   排序的偶发错误在视觉上被抹平了。
     */
    ctx.globalAlpha = alphaFinal * layerAlpha;
    for (const s of sides) {
      ctx.beginPath();
      s.q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = shade(base, 0.62);
      ctx.fill();
      /*
       * ★ 附近设施的提示色也要叠到【侧面】上。
       *
       *   只叠顶面是不够的：跟走时看到的主要是侧面，
       *   而侧面还是普通房间色 —— 整个体块读起来仍然像"普通建筑"，
       *   只是顶上多了一块淡色。用户的原话是「建筑有点不显眼了」。
       *
       *   路径还是刚才那条，直接再 fill 一次，不用重新 beginPath。
       */
      if (near) {
        ctx.fillStyle = MAP.nearbyFill;
        ctx.fill();
      }
    }

    /*
     * ★ 顺序不能反：先把「顶面 + 所有洞」拼成一条路径并填充，
     *   再回头画洞壁。
     *
     *   踩过的坑：洞壁画在中间，每圈洞壁都调了一次 ctx.beginPath()，
     *   把已经累积好的顶面路径清空了 —— 最后那句 fill 填的是个空路径，
     *   于是【整块楼板直接不渲染】。
     *   Canvas 的路径是全局状态，beginPath 是清空而不是「开一个新的」。
     */
    ctx.beginPath();
    top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();

    const voidShapes = [];
    if (o.kind === 'slab') {
      for (const v of (sc.voidRings ?? [])) {
        if (v.level !== o.level) continue;
        // 洞同样要裁 —— 视角近的时候洞的一大半会在相机身后
        const pts = projectRing(v.ring.map((c) => [c[0], c[1], topZ]), cam, w, h, fov);
        if (!pts || pts.length < 3) continue;
        voidShapes.push({ ring: v.ring, pts });
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
      }
    }

    ctx.fillStyle = shade(base, 1.3);
    ctx.fill(o.kind === 'slab' ? 'evenodd' : 'nonzero');

    /*
     * ★ 挑空 = 在楼板上挖个洞。就这样 —— 不描边、不加洞壁、不给特殊颜色。
     *
     *   两道一起上：先按 evenodd 把顶面挖空，【再把洞逐个显式填掉】。
     *   为什么不信 evenodd 一个：单独用过一次，顶面填的还是原色 ——
     *   看上去就是「挑空和楼板一个颜色」，也就是洞根本没挖开。
     *   显式填一遍不依赖填充规则，一定挖得掉。
     *   填的颜色比背景还暗一点，读起来像"深处"。
     */
    ctx.globalAlpha = alphaFinal * layerAlpha;                   // 只有顶面带 alpha
    ctx.fillStyle = shade(base, 1.3);
    ctx.fill(o.kind === 'slab' ? 'evenodd' : 'nonzero');

    /*
     * ★ 挑空分两种情况处理 —— 因为"透明"的意义取决于下面有没有东西。
     *
     *   多层（跨层路线 / 炸开）：【什么都不填】。evenodd 挖掉的洞
     *     透出来的正是【下一层已经画好的楼板和房间】—— 这才是用户要的
     *     "能看到底下的楼层"。
     *
     *   单层：洞里透出来的是画布背景，跟楼板外面一样是"空"——
     *     看上去就是"挑空消失了、楼板变成一整块实心的"。
     *     所以单层时给洞填一层比楼板暗的颜色，让它读起来像个洞。
     *
     *   ⚠ evenodd 单独用【挖不开】（实测过两轮）：洞会变成实心。
     *     两层保险 —— 先 evenodd，再对单层的情况显式补一笔。
     */
    if (!multiLevel) {
      for (const vs of voidShapes) {
        ctx.beginPath();
        vs.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = MAP.voidShade;   // 半透明黑 —— 见 palette 里的说明
        ctx.fill();
      }
    }

    if (o.kind === 'room') {
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /*
     * ★ 附近设施：在【已画好的顶面】上叠一层半透明蓝紫。
     *
     *   路径还是刚才那个（顶面 + 洞），所以直接再 fill 一次就行 ——
     *   不需要重新 beginPath，洞的位置也自动对齐。
     *   建筑本体完全不透明，只有这层提示色是淡的。
     */
    if (near) {
      ctx.fillStyle = MAP.nearbyFill;
      ctx.fill('evenodd');
    }
    /*
     * ★ 附近的【面状】设施也要标名字 —— 和点状设施一样。
     *
     *   只给点状标是不够的：跟走时旁边最常见的就是店铺、卫生间、
     *   休息区这些面状设施，而它们恰恰是旅客最想认出"这是什么"的。
     *   之前只涂了橙色，等于说"这里有个东西"却不说是什么。
     *
     *   卡片放在顶面投影的重心上 —— 不用额外算位置，顶面本来就有。
     */
    if (near && o.name && top.length) {
      const cx = top.reduce((s, p) => s + p.x, 0) / top.length;
      const cy = top.reduce((s, p) => s + p.y, 0) / top.length;
      labelCard(cx - 20, cy, o.name, MAP.nearby);
    }
    ctx.globalAlpha = 1;
  };

  for (const lv of levels) {
    /*
     * ★ 非聚焦层整体降透明度。
     *   只在这里设一次、整层复用 —— 逐个物体去乘太容易漏，
     *   漏掉的那个就会突兀地保持不透明，反而更乱。
     */
    ctx.save();
    ctx.globalAlpha = focusAlpha(lv);

    /* ① 楼板 —— 永远最先画 */
    for (const o of sc.polys) if (o.level === lv && o.kind === 'slab') drawPrism(o, focusAlpha(lv));

    /*
     * ★ 最上层楼板加一道亮边。
     *
     *   多层叠着看的时候，光靠深浅分不出"哪块是最上面那层" ——
     *   尤其俯视，几层楼板几乎完全重合。一道亮边把它的轮廓勾出来，
     *   空间关系立刻就清楚了。
     *
     *   只在【多层且没聚焦】时画：单层没有"最上面"可言，
     *   聚焦时用户已经知道自己在看哪层，再加边是多余的。
     */
    if (multiLevel && !focus && lv === levels[levels.length - 1]) {
      for (const o of sc.polys) {
        if (o.level !== lv || o.kind !== 'slab') continue;
        const top = projectRing(o.ring.map((c) => [c[0], c[1], o.top]), cam, w, h, fov);
        if (!top) continue;
        ctx.beginPath();
        top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.strokeStyle = MAP.slabEdgeBright ?? '#8FD9E8';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    /*
     * ② 通行线和路线 —— 必须画在【房间之前】。
     *
     * ★ 这里踩过一次：原来把通行线放在房间之后画，注释却写着
     *   「贴在地面上，会被房间正常遮挡」—— 顺序是反的，于是**永远不可能被遮挡**，
     *   开着透视和关着透视看起来一样。
     *   想被挡住的东西，就得先画。
     */
    for (const l of sc.lines) {
      if (l.level !== lv) continue;
      /*
       * ★ 显式设一次本层的透明度。
       *   原来只靠楼层循环开头那句 globalAlpha —— 但 drawPrism 内部
       *   自己也会设 globalAlpha，只要有一处 save/restore 不配对，
       *   这层的透明度就被冲掉了。表现是"聚焦时通行线不跟着淡"。
       *   在每条线前面明确设一次，不依赖任何嵌套状态。
       */
      ctx.globalAlpha = focusAlpha(lv);
      strokePath(l.pts, MAP.pathMain, 2.5);
      ctx.globalAlpha = focusAlpha(lv);
    }
    for (const r of routeLines) {
      if (r.current) continue;
      if (r.level && r.level !== lv && !(r.levels ?? []).includes(lv)) continue;
      /*
       * ★ 这里画【完全不透明】。
       *
       *   Canvas 没有"只在被遮挡的地方变透明"这回事 ——
       *   globalAlpha 是整条线的。设成 0.72 的话，
       *   【没被挡住的地方也一起变暗】，看上去就是"路线整体发灰"。
       *   （实测反馈就是这个。）
       *
       *   "透过楼层看得见"交给顶上那趟 ghost pass：
       *     没被挡住 → 这条不透明的线就是全部，清晰 ✓
       *     被挡住   → 只剩下 ghost 那层淡影 ✓
       *   两种情况都对，而且不需要知道哪里被挡住了。
       *
       * ★ 图层透明度（聚焦）靠【相乘】。
       *   直接赋值会把楼层循环外面设的 focusAlpha 冲掉 ——
       *   表现就是"聚焦时其他楼层的路线不跟着变淡"。
       */
      const a = focusAlpha(lv);
      if (a < 1) ctx.globalAlpha = a;
      strokePath(r.pts, r.preview ? MAP.select : MAP.route, r.preview ? 6 : 4);
      /*
       * ★ 恢复成本层的透明度，不是 1。
       *   写成 1 的话，这一层后面画的房间、障碍物、标记
       *   就全都不透明了 —— 聚焦时只有路线变淡，其它照旧清晰。
       */
      ctx.globalAlpha = a;
    }

    /*
     * ③ 房间 —— 按深度排（远→近），它们会挡住后面的通行线。
     */
    const rooms = sc.polys
      .filter((o) => o.level === lv && o.kind === 'room')
      .map((o) => {
        let far = -Infinity;
        for (const c of o.ring) far = Math.max(far, depthOf([c[0], c[1], (o.base + o.top) / 2]));
        return { o, d: far };
      })
      .sort((a, b) => b.d - a.d);
    for (const r of rooms) drawPrism(r.o, focusAlpha(lv));

    /*
     * ④ 障碍物 —— 【单独一趟，固定排在房间之后】。
     *
     * ★ 之前把它和房间合并成一趟按深度排，想修「障碍物盖住它背后的房间」。
     *   但那治不好：障碍物一百多米宽、房间几米宽，深度范围大幅重叠，
     *   任何单一深度值都会在某个角度判错 —— 表现就是「时隐时现」。
     *
     *   改成固定的覆盖层：它半透明，压在房间之上，但不参与深度竞争。
     *   好处是【永远不会翻转】—— 对错是稳定的，不会随相机抖动。
     *   而且半透明本来就该读作提示层，不是实体。
     */
    for (const o of sc.polys) if (o.level === lv && o.kind === 'obstacle') drawPrism(o, focusAlpha(lv));

    /* ⑤ 点标记 —— 立在上面，最后画 */
    for (const m of sc.markers) {
      if (m.level !== lv) continue;
      const p = P([m.x, m.y, m.z]);
      if (!p) continue;
      const r = Math.max(2.5, Math.min(9, 900 / Math.max(1, p.depth)));
      const isSel = sel && m.id === sel;
      /*
       * ★ 选中的设施必须一眼看得出来。
       *   画三层：外圈光环 → 本体 → 深色描边。
       *   光环用固定屏幕尺寸（不随距离缩放），这样远处选中也一样醒目。
       */
      if (isSel) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = MAP.select;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 15, 0, Math.PI * 2);
        ctx.strokeStyle = MAP.select;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, isSel ? r + 3 : r, 0, Math.PI * 2);
      /*
       * ★ 当前步附近的点设施也涂暖橙 —— 和房间用同一个颜色，
       *   这样"这一步旁边有什么"在 2D/3D、点状/面状上是同一套语言。
       *   选中的青色优先：选中是用户的主动操作，比"附近"更需要被看见。
       */
      const isNear = !!(nearby && nearby.has(m.id));
      ctx.fillStyle = isSel ? MAP.select
        : isNear ? MAP.nearby
          : (m.vertical ? MAP.vertical : MAP.gate);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      /*
       * ★ 附近的点设施【标名字】，而且和面状设施用【同一种卡片】。
       *
       *   之前这里是裸文字 + 深色描边。描边只能保证"勉强看得见"：
       *   压在浅色楼板上仍然发灰，压在通行线上又和线糊在一起。
       *   换成实底卡片之后，文字对比度是固定的，和面状设施也统一了 ——
       *   同一张图上两种标签长得不一样才是问题。
       */
      if (isNear && m.name) {
        // 让开本体，别把点盖住
        labelCard(p.x + r + 6, p.y - r - 6, m.name, MAP.nearby);
      }
    }

    ctx.restore();   // ★ 收掉这一层的聚焦透明度，别漏到下一层
  }

  /*
   * ★ 路线 ghost pass —— 在所有楼层画完之后【再补一遍】。
   *
   *   为什么必须补第二遍：
   *   路线是在每个楼层内部、房间【之前】画的（那样才会被房间正常遮挡）。
   *   但跨层预览时，下面几层的路径会被上面的楼板整个盖掉 ——
   *   看上去就是"路走到一半没了"。
   *
   *   光把线本身设成半透明是【没用的】：它是先画的，
   *   后面盖上来的是完全不透明的楼板 —— 半透明的东西被不透明的东西盖住，
   *   照样看不见。
   *
   *   所以在这里用低透明度重画一遍，压在一切之上。
   *   0.28 是"看得见走向，但不至于喧宾夺主"。
   */
  if (routeLines.length > 1) {
    ctx.save();
    /*
     * 0.22 —— 比主体淡得多，但仍然看得出走向。
     * 它的作用只是"提示这条路从楼板下面穿过去了"，
     * 不该盖过楼板本身：盖过了就等于没有遮挡。
     */
    for (const r of routeLines) {
      if (r.vertical) continue;
      // ★ 聚焦时其他楼层的路线也要跟着淡下去
      const a = focusAlpha(r.level) * 0.22;
      ctx.globalAlpha = a;
      strokePath(r.pts, r.preview ? MAP.select : MAP.route, 5, false);
    }
    ctx.restore();
  }

  /*
   * 透视通行线。
   *
   * ★ 是【再画一遍】，不是【改透明度重画】。
   *   通行线在前面已经正常画过一次（会被房间挡住），这里在所有物体之后
   *   用 40% 补一遍 —— 被挡住的那些就"透"出来了。
   *   如果只画这一遍，前面的线也会一起变淡，看起来像整套路网都褪色了。
   *   两遍叠起来的效果才对：看得见的依旧实心，被挡的是幽灵。
   */
  if (xray) {
    ctx.globalAlpha = 0.4;
    for (const l of sc.lines) {
      if (!inView(l.level)) continue;
      strokePath(l.pts, MAP.pathMain, 3);
    }
    ctx.globalAlpha = 1;
  }

  /*
   * ★ 起点 / 终点的标记，画在最后 —— 和选中高亮一样，不能被任何东西压暗。
   *   绿 = 起点，红 = 终点。
   *
   * ★ 描【轮廓】，不是实心圆点。
   *   和选中高亮同一套语言：面状设施描整个体块的线框，
   *   点状设施描一个空心环。实心圆点在地图上会盖住底下的东西，
   *   而且和点设施的黄色圆点混在一起分不清。
   */
  for (const e of (opt.endpoints ?? [])) {
    if (!inView(e.level)) continue;
    const zo = EZ(e.level);

    ctx.strokeStyle = e.color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';

    // 面状设施：整个棱柱的线框（和选中高亮同样的画法）
    if (e.ring && e.ring.length >= 3) {
      const rTop = e.ring.map((c) => [c[0], c[1], zo + ROOM_HEIGHT]);
      const rBot = e.ring.map((c) => [c[0], c[1], zo]);
      const pTop = projectRing(rTop, cam, w, h, fov);
      const pBot = projectRing(rBot, cam, w, h, fov);
      for (const poly of [pTop, pBot]) {
        if (!poly) continue;
        ctx.beginPath();
        poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
      if (pTop && pBot && pTop.length === pBot.length) {
        for (let i = 0; i < pTop.length; i++) {
          const seg = projectRing([rTop[i], rTop[i], rBot[i], rBot[i]], cam, w, h, fov);
          if (!seg || seg.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(seg[0].x, seg[0].y);
          ctx.lineTo(seg[seg.length - 1].x, seg[seg.length - 1].y);
          ctx.stroke();
        }
      }
    }

    // 位置环 + 底色标签：点状设施描空心环，面状设施在重心上再点一个
    const p = P([e.p[0], e.p[1], zo + (e.ring ? ROOM_HEIGHT : 1.6)]);
    if (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = e.color;
      ctx.fill();
      // 「起」「终」两个小字，靠色环外侧
      ctx.fillStyle = e.color;
      ctx.font = 'bold 12px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.tag, p.x, p.y - 20);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /*
   * ★ 跨层的竖线 + 【流动高亮动画】。
   *
   *   方向感靠动画传达：向下走 → 高亮段向下滚；向上走 → 向上滚。
   *   实现就是虚线的 lineDashOffset 随时间变 —— 便宜、流畅、不用加任何状态。
   *   相位用 Date.now() 算，所以画布每帧重绘时它是连续的，不需要自己维护计时器。
   *
   *   这条线画在【所有楼层之后】：跨层的线如果被中间楼层挡住，
   *   就完全看不到"从哪下到哪"了 —— 而那正是它唯一的作用。
   */
  for (const r of routeLines) {
    if (!r.vertical) continue;
    const a = P(r.pts[0]);
    /*
     * ★ a 必须先判空，再用它。
     *   原来是「先算 b，b 为空时用 a.x 兜底，最后才 if (!a || !b)」——
     *   顺序反了：a 为 null 时那句 a.x 直接抛
     *   "Cannot read properties of null (reading 'x')"。
     *
     *   表现很有迷惑性：跟着走【前几步没事】，走到某一步时
     *   竖线的端点转到相机身后（P 返回 null），才开始报错。
     *   而且一报就是一串 —— 每帧都抛一次。
     */
    if (!a) continue;
    let b = P(r.pts[1]);
    if (!b) {
      // 下端在相机身后时，退化成从上端朝下画一小段，至少还看得出方向
      b = { x: a.x, y: a.y + 60, depth: 1 };
    }

    /*
     * ★ 跨层竖线用【独立颜色】，不跟水平路线共用。
     *   同色的话，它看起来就是"路线的尾巴"，读不出"这里换了一层"。
     *   黄色是登机口那一系，旅客已经习惯用它表示"关键节点"。
     */
    const col = r.current ? MAP.gate : MAP.vertical;
    ctx.lineCap = 'butt';

    // 底线：细、暗，先把"这里有一条线"交代清楚
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 流动高亮：短亮段 + 长间隔，offset 随时间推进
    const phase = (Date.now() / 22) % 28;      // 22ms/px，28px 一个周期
    const dir = r.down ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = col;
    ctx.lineWidth = 5;
    ctx.setLineDash([10, 18]);
    ctx.lineDashOffset = dir * phase;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 两端各点一个圆点，标明上下楼层的接入位置
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = MAP.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /*
   * ★ 当前这一步最后画，压在所有东西上面。
   *   脚下那一段如果跟着地面一起被房间遮住，跟着走的人就失去参照了 ——
   *   宁可让它穿墙可见。
   */
  for (const r of routeLines) {
    if (!r.current) continue;
    // ★ 用青色而不是同一个蓝：脚下这段必须一眼就和路网里其它线区分开
    strokePath(r.pts, MAP.select, 8);
  }

  /*
   * ★ 选中的【面状设施】高亮单独一趟，画在所有东西之后。
   *
   *   原来它跟着房间棱柱一起画，而障碍物排在房间之后 ——
   *   半透明障碍物盖在选中房间上，把青色高亮压暗了。
   *   高亮是交互反馈，不该被任何东西影响，所以放到最后。
   */
  if (sel) {
    const o = sc.polys.find((x) => x.kind === 'room' && x.id === sel && inView(x.level));
    if (o) {
      /*
       * ★ 描【整个棱柱的边框】，不是只描顶面。
       *   只描顶面的话，从低角度看顶面几乎侧对视线，描边退化成一条细线，
       *   等于没高亮。选中反馈必须在任何角度都成立。
       *
       *   上线框 + 下线框 + 每根竖直棱 = 一个线框盒子。
       *   不做背面剔除（绕向不保证），所以四根竖棱全画 ——
       *   看起来就是个完整的方盒轮廓，反而更清楚。
       */
      const ringTop = o.ring.map((c) => [c[0], c[1], o.top]);
      const ringBot = o.ring.map((c) => [c[0], c[1], o.base]);
      const pTop = projectRing(ringTop, cam, w, h, fov);
      const pBot = projectRing(ringBot, cam, w, h, fov);

      ctx.strokeStyle = MAP.select;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      for (const poly of [pTop, pBot]) {
        if (!poly) continue;
        ctx.beginPath();
        poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
      // 竖直棱：要单独裁，因为上下端点可能一个在相机后一个在前
      if (pTop && pBot && pTop.length === pBot.length) {
        for (let i = 0; i < pTop.length; i++) {
          const seg = projectRing([ringTop[i], ringTop[i], ringBot[i], ringBot[i]], cam, w, h, fov);
          if (!seg || seg.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(seg[0].x, seg[0].y);
          ctx.lineTo(seg[seg.length - 1].x, seg[seg.length - 1].y);
          ctx.stroke();
        }
      }

      /* 重心上再点一个环 —— 远处 / 被挡住时也能一眼看到它在哪 */
      const src = pTop ?? pBot;
      if (src) {
        const cx = src.reduce((s, p) => s + p.x, 0) / src.length;
        const cy = src.reduce((s, p) => s + p.y, 0) / src.length;
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.strokeStyle = MAP.select;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = MAP.select;
        ctx.fill();
      }
    }
  }
}

/** 把相机自动摆到能看全这些楼层的位置（3D 全览）。 */
export function fitCamera(sc, levels, opt = {}) {
  const boxes = levels.map((lv) => sc.boundsByLevel.get(lv)).filter(Boolean);
  if (!boxes.length) return makeCamera([0, -80, 60], [0, 0, 0]);
  const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
  const y0 = Math.min(...boxes.map((b) => b.y0)), y1 = Math.max(...boxes.map((b) => b.y1));
  const zs = levels.map((lv) => levelZ(opt.manifest, lv));
  const z0 = Math.min(...zs), z1 = Math.max(...zs) + ROOM_HEIGHT;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const span = Math.max(x1 - x0, y1 - y0, (z1 - z0) * 2, 40);
  const dist = span * 1.15;
  return makeCamera([cx + dist * 0.35, cy - dist * 0.85, cz + dist * 0.75], [cx, cy, cz]);
}
