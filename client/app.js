/**
 * 大兴机场导航客户端。
 *
 * 两个模式：
 *   浏览 —— 自由切楼层、自由 3D 视角、自由 2D 视角，点设施看信息
 *   导航 —— 搜起点终点 → 自动寻路 → 分步走，每步手动确认
 *
 * ★ 分步规则（用户定的）：通行线的每个折点就是一步。
 *   buildGraph 已经在每个折点和交叉点切过刀，所以图上每条边本来就是一条直线段，
 *   直接拿边当步骤就行，不需要再做什么几何切分。
 *
 * ★ 视角（用户定的）：
 *   3D 跟走（默认）—— 站在当前这一步的起点，朝终点看，人眼高度
 *   3D 全览       —— 把当前涉及的所有楼层框进画面
 *   2D 全览 / 2D 跟走
 *   当前步不跨层时只渲染当前层；跨层时渲染跨的那两层。
 */

import { buildNetwork, normalizeFeatures, setLevelOrder } from '../tools/lib/graph.mjs';
import { buildSearchIndex } from '../tools/lib/search.mjs';
import { planRoute, renderLevelsForStep, buildRoutingGraph, levelsOfSteps } from '../tools/lib/route.mjs';
import { buildScene, makeCamera, draw3d, fitCamera, levelZ, project, explodedZ } from './lib/view3d.mjs';
import { createView, fitView, centerOn, toScreen, toLocal, draw2d } from './lib/view2d.mjs';
import { MAP, setMapTheme } from './lib/palette.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
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
  setTimeout(() => t.remove(), 3600);
}

/* ============================================================ 状态 */

const S = {
  mode: 'browse',           // browse | nav
  view: '3d-follow',        // 3d-follow | 3d-overview | 2d-follow | 2d-overview
  level: null,
  manifest: null,
  regions: [], facilities: [], paths: [], connectors: [],
  net: null, routing: null, index: null,
  scene: null,
  cam: null,
  v2: createView(),
  selected: null,           // 点开信息的设施
  from: null, to: null,     // 导航起终点（设施）
  route: null,
  stepIndex: 0,
  /*
   * 导航的三个阶段：
   *   idle       还没算路，随便点
   *   preview    ★ 起终点都选好了、路线算出来了，【先整体预览一遍】——
   *              全路径高亮 + 起终点标色 + 3D 俯视看全局。
   *              这时候还不分步，用户确认「就是要走这条」再开始。
   *   navigating 点过「开始导航」，进入分步跟走，【不能再随便点设施了】。
   */
  phase: 'idle',
  /*
   * ★ 聚焦楼层：设了它，其它楼层就画成半透明。
   *   多层一起看的时候，非聚焦层会压住要看的那层 ——
   *   尤其跨层预览，下面那层的路径全被上面的楼板盖住。
   *   聚焦之后非聚焦层降到 0.22，仍然看得见轮廓（那是空间参照），
   *   但不会抢走注意力。
   */
  focusLevel: null,
  accessibleOnly: false,
  xray: false,              // 通行线是否透视显示（默认关闭 = 被物体完全遮挡）
  cam3d: {
    yaw: -0.6, pitch: 0.75, dist: 300, target: [0, 0, 0], free: false,
    // ★ 跟走视角在基准位姿上叠加的用户偏移。换步不重置，想回默认按「重置视角」。
    follow: { yaw: 0, pitch: 0, zoom: 1 },
  },
};

/* ============================================================ 载入 */

async function boot() {
  let d;
  try {
    d = await (await fetch('/api/data')).json();
  } catch (e) {
    window.__navFail?.('取不到数据', `<p>${e.message}</p><p>服务没在跑？<pre>npm run editor</pre></p>`);
    return;
  }
  S.manifest = d.manifest;
  setLevelOrder(S.manifest.levels);

  S.regions = [];
  for (const [lv, pack] of Object.entries(d.levels ?? {})) {
    for (const f of pack.regions?.features ?? []) {
      S.regions.push({ level: f.properties?.level ?? lv, polygons: f.geometry?.coordinates ?? [], props: f.properties ?? {}, id: f.id });
    }
  }
  const norm = (fc) => normalizeFeatures(fc).map((x) => ({ ...x, props: x.props, level: x.props?.level }));
  S.facilities = norm(d.facilities).map((x) => ({ ...x, level: x.props.level, polygons: x.polygons, point: x.point }));
  S.paths = norm(d.paths).map((x) => ({ ...x, level: x.props.level, coords: x.coords }));
  S.obstacles = norm(d.obstacles).map((x) => ({ ...x, level: x.props.level, polygons: x.polygons }));
  S.connectors = norm(d.connectors).map((x) => ({ ...x, level: x.props?.from?.level }));

  S.index = buildSearchIndex(S.manifest, (d.facilities?.features ?? []));

  S.net = buildNetwork({
    manifest: S.manifest,
    paths: normalizeFeatures(d.paths),
    facilities: normalizeFeatures(d.facilities),
    connectors: normalizeFeatures(d.connectors),
  }, {
    areaAttachTolerance: S.manifest.thresholds?.areaAttachTolerance ?? 1,
    poiPathTolerance: S.manifest.thresholds?.poiPathTolerance ?? 5,
    connectorTolerance: S.manifest.thresholds?.connectorOnPathTolerance ?? 0.5,
    verticalGroupTolerance: S.manifest.thresholds?.verticalGroupTolerance ?? 0.05,
    verticalSpecs: Object.fromEntries(Object.entries(S.manifest.facilityCategories ?? {})
      .filter(([k, v]) => !k.startsWith('_') && v?.vertical).map(([k, v]) => [k, v.vertical])),
  });
  S.routing = buildRoutingGraph(S.net, { walkSpeed: walkSpeedMPerMin() });

  // ★ 默认停在「内容最多」的那层，而不是设施列表里的第一层。
  //   跨层设施会在每一层都留一个点，所以「有设施」不等于「这层画过」
  //   —— 按设施数排会选到只有几个电梯点的空楼层。
  const score = (lv) => (S.paths.filter((p) => p.level === lv).reduce((s, p) => s + p.coords.length, 0))
    + S.facilities.filter((f) => f.level === lv).length * 2;
  const allLevels = [...new Set([...S.facilities.map((f) => f.level), ...S.paths.map((p) => p.level)])].filter(Boolean);
  S.level = allLevels.sort((a, b) => score(b) - score(a))[0]
    ?? Object.keys(d.levels ?? {})[0] ?? null;

  // URL 参数：方便深链和截图验证，例如 ?mode=nav&view=2d&level=L3F
  // ★ globalThis.location 可能不存在（无头测试环境），不能直接写 location.search
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  if (q.get('mode') === 'nav') { S.mode = 'nav'; S.view = '3d-follow'; }
  if (q.get('mode') === 'browse') { S.mode = 'browse'; }
  if (q.get('view')) S.view = q.get('view');
  if (q.get('level') && S.manifest.levels?.[q.get('level')]) S.level = q.get('level');
  if (q.get('xray')) S.xray = q.get('xray') !== '0';
  if (q.get('sel')) S.selected = q.get('sel');     // 深链到某个设施（也方便截图验证高亮）
  if (q.get('from')) S.from = q.get('from');
  if (q.get('to')) S.to = q.get('to');
  /*
   * ★ ?q=星巴克 —— 预填搜索框并展开候选。
   *
   *   两个用处：
   *   ① 深链：可以直接分享"搜某个东西"的状态
   *   ② 截图验证：候选列表是 oninput 之后才出现的，
   *      而截图只能拍到"加载完的状态" —— 没有这个参数，
   *      候选列表的样式永远进不了截图，等于没法验证。
   */
  S._prefillQuery = q.get('q') ?? null;

  rebuildScene();
  renderAll();
  resize();
  if (S.from && S.to) tryPlan();
  // ★ 数据、场景、首次渲染都就绪了 —— 现在才允许动画起定时器
  animArmed = true;
  updateAnim();
  window.__navBooted = true;
}

/** 场景只重建需要的楼层 —— 跨层渲染时可能会要两层。 */
function rebuildScene(levels = null) {
  const ls = levels ?? levelsInPlay();
  S.sceneLevels = ls.join(',');
  S.scene = buildScene({
    manifest: S.manifest,
    regions: S.regions,
    facilities: S.facilities,
    paths: S.paths,
    obstacles: S.obstacles,
  }, {
    ...(levels ? { levels } : {}),
    // ★ 多层自动炸开 —— 由楼层数决定，不是用户选项
    explode: explodeFactor(ls),
  });
}

/**
 * 楼层集合变了就重建场景。
 *
 * ★ 必须每帧检查一次。
 *   炸开系数是【建场景时】烘焙进 z 的，所以「从单层变成两层」
 *   （比如预览了一条跨层路线、或者走到跨层那一步）必须重建，
 *   否则新出现的那一层还带着旧的、没拉开的 z —— 两层糊在一起。
 *   用一个字符串签名比较，比到处挂钩子可靠。
 */
function ensureSceneLevels() {
  if (!S.manifest) return;
  const key = levelsInPlay().join(',');
  if (S.sceneLevels !== key) rebuildScene();
}

/**
 * 当前这一步【附近的设施】。
 *
 * ★ 跟走的时候，旅客最关心的是"我这一步旁边有什么"——
 *   哪个登机口、哪家店、哪个卫生间。现在图上只有房间色块，
 *   要挨个点才知道是什么。把附近的挑出来涂个标记色，
 *   一眼就能扫到"哦旁边有个卫生间"。
 *
 * 判定：设施的代表点（点设施用坐标、面设施用质心）
 *   到当前步这一段线的距离 ≤ NEARBY_M。
 *
 * ★ 只看当前步，不看整条路线 —— 整条路线会把半张图的房间都染上，
 *   那就等于没标。
 */
const NEARBY_M = 18;

function nearbyFacilities() {
  const out = new Set();
  if (S.mode !== 'nav' || !S.route || !S.stepIndex && S.phase !== 'navigating') return out;
  const st = S.route.steps[S.stepIndex];
  if (!st) return out;

  for (const f of S.facilities) {
    if (f.level !== st.level) continue;
    // 跨层的那一步不标 —— 它是"上下楼"，附近的设施没有意义
    if (st.kind === 'vertical') continue;
    const p = facilityPoint(f);
    if (!p) continue;
    const d = pointToSegment(p, st.from, st.to);
    if (d <= NEARBY_M) out.add(f.id);
  }
  return out;
}

/** 点到线段的距离。 */
function pointToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function levelsInPlay() {
  if (S.mode === 'nav' && S.route) {
    /*
     * ★ 预览时返回【整条路线经过的所有楼层】，不是第一步的。
     *
     *   原来两种情况共用一个分支（都取 steps[stepIndex]），
     *   而预览时 stepIndex 是 0 —— 于是「3D 路线全览」只画了第一步那一层。
     *   跨层路线明明连着两层，第二层【根本没进渲染列表】：
     *   楼板不画、房间不画，跨层竖线的另一端落在空处。
     *   用户看到的就是「第二个楼层根本没渲染，竖线长度也不对」。
     */
    if (S.phase === 'preview') {
      const ls = levelsOfSteps(S.route.steps);
      if (ls.length) return ls;
    }
    return renderLevelsForStep(S.route.steps[S.stepIndex]);
  }
  return S.level ? [S.level] : [];
}

/**
 * 多层时必须炸开，而且没有"不炸开"这个选项。
 *
 * ★ 为什么不做成开关：
 *   几层楼板叠在同一个高度上，看上去就是一团糊在一起的东西 ——
 *   既看不出有几层，也看不出哪段在哪层。那不是"另一种视图"，
 *   是渲染错误的样子。所以只要画多层就拉开，不给关掉的机会。
 *
 *   单层时系数是 1：只画一层，拉开只会让相机白白拉远。
 */
const EXPLODE_FACTOR = 16;
function explodeFactor(levels) {
  return (levels?.length ?? 0) > 1 ? EXPLODE_FACTOR : 1;
}

/* ============================================================ 渲染 */

let raf = 0;
function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}

/*
 * ★ 跨层流动动画的驱动。
 *
 *   虚线偏移靠 Date.now() 算，所以它只在【重绘时】才前进 ——
 *   必须有人不停地要求重绘。
 *
 * ★ 用 setInterval，不用自续的 requestAnimationFrame。
 *   自续 rAF（回调里再排一帧）在无头环境里会变成【同步递归】：
 *   rAF 立刻回调 → draw → 再排 → 立刻回调…… 直接卡死，
 *   连 boot() 都回不来（测试静默停住、退出码 0 就是这个）。
 *   setInterval 在浏览器和无头环境里都是异步的，行为一致。
 *
 *   按需启停：没有跨层路线时定时器根本不存在，
 *   不会白白占着 CPU 每 33ms 重绘整张地图。
 */
let animTimer = 0;
const ANIM_MS = 33;                 // ≈30fps，虚线滚动够顺了
/*
 * ★ 数据加载完成前【不允许启动动画】。
 *   模块顶层就会调一次 resize() → draw()，那时候数据和场景都还没有。
 *   如果那次 draw 就起了定时器，定时器又每 33ms 调 draw()，
 *   就会在"还没初始化完"的状态下反复重入 —— 无头环境里直接卡死
 *   （表现为 import 卡住、测试静默停住、退出码 0）。
 *   boot() 走完再把闸打开。
 */
let animArmed = false;

function updateAnim() {
  if (!animArmed) return;
  const need = S.mode === 'nav' && !!S.route && routeLines3d().some((r) => r.vertical);
  if (need && !animTimer) animTimer = setInterval(() => draw(), ANIM_MS);
  else if (!need && animTimer) { clearInterval(animTimer); animTimer = 0; }
}

function resize() {
  const cv = $('cv');
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  draw();
}

function draw() {
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr, h = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // ★ 数据还没加载完就来画了（resize() 在模块顶层就调过一次）。
  //   这里先铺底色走人，别让 draw3d 去读 null 场景。
  if (!S.scene || !S.manifest) {
    ctx.fillStyle = MAP.bg;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  /* ★ 楼层集合变了就重建场景（多层要炸开）。必须在这里、在取 levels 之前。 */
  ensureSceneLevels();

  const levels = levelsInPlay();
  const is3d = S.view.startsWith('3d');
  /*
   * ★ 当前步附近的设施，2D / 3D 都要染上标记色。
   *   算一次给两处用 —— 各算一遍容易两边判定的范围不一致。
   */
  const nearby = nearbyFacilities();

  if (is3d) {
    const sc = S.scene;
    /*
     * ★ 相机选择的规则统一成一条：
     *   「跟走视角」有自己的一套基准位姿 + 用户偏移；
     *   其余所有 3D 视角（浏览、路线全览）都是【轨道相机】——
     *   用户动过就听用户的，没动过才自动框一次。
     *
     *   之前 3d-overview 每帧都调 fitCamera()，把用户的拖动立刻覆盖掉，
     *   所以「路线全览时不能动视角」。现在它和浏览模式共用 orbitCamera。
     *
     * ★ 跟走时用户也能自由转：一拖就把 free 打开，
     *   从那一刻起完全按轨道相机走（和全览一样自由）。
     *   切下一步时再动画回到新的默认跟走位姿。
     */
    const following = S.view === '3d-follow' && S.mode === 'nav' && S.route;
    const cam = animCamera()
      ?? (following && !S.cam3d.free ? followCamera() : orbitCamera(levels.length ? levels : [S.level]));
    ctx.fillStyle = MAP.bg;
    ctx.fillRect(0, 0, w, h);
    /*
     * ★ 传的是 only（只画这几层），不是「其它层淡化」。
     *   浏览模式就只画当前那一层；导航时当前步不跨层也只画一层，
     *   只有跨层的那一步才同时画跨的两层。
     */
    draw3d(ctx, sc, cam, {
      w, h,
      only: new Set(levels.length ? levels : [S.level]),
      routeLines: routeLines3d(),
      xray: S.xray,
      selected: S.selected,
      endpoints: endpointMarkers(),
      manifest: S.manifest,
      // ★ 起终点标记的 z 要用炸开后的值，否则楼板拉开了它们还留在原地
      explode: explodeFactor(levels),
      /*
       * ★ 聚焦楼层。多层时点某一层，其它层降到 0.22 ——
       *   仍然看得见轮廓（那是空间参照），但不再压住要看的那层。
       *   跨层路线的竖线不受影响：它本来就是"穿过所有层"的东西。
       */
      focusLevel: levels.length > 1 ? S.focusLevel : null,
      // ★ 当前步附近的设施
      nearby,
    });
    // 跨层动画：按需启停（见 updateAnim 的说明）
    updateAnim();
    S._lastCam = cam;
  } else {
    ensure2dView(w, h);
    const shown = levels.length ? levels : [S.level];
    draw2d(ctx, {
      level: S.level,
      regions: S.regions.filter((r) => shown.includes(r.level)),
      facilities: S.facilities.filter((f) => shown.includes(f.level)),
      paths: S.paths.filter((p) => shown.includes(p.level)),
      obstacles: S.obstacles.filter((o) => shown.includes(o.level)),
    }, S.v2, {
      w, h, route: S.route, stepIndex: S.stepIndex, from: S.from, to: S.to,
      selected: S.selected,
      // ★ 当前步附近的设施，涂标记色
      nearby: nearby,
    });
  }
}

/** 2D 取景的「场合指纹」。楼层 / 视角 / 步骤 变了就该重新取景。 */
function v2Key() {
  const levels = levelsInPlay();
  return `${S.view}|${S.mode}|${levels.join(',')}|${S.mode === 'nav' ? S.stepIndex : ''}`;
}

/**
 * 2D 视图的取景。
 *
 * ★ 只在「换了楼层 / 换了视角 / 换了步骤」时重算，不能每帧都 fit。
 */
function ensure2dView(w, h) {
  const key = v2Key();
  if (S._v2Key === key) return;
  S._v2Key = key;
  const levels = levelsInPlay();

  if (S.view === '2d-follow' && S.mode === 'nav' && S.route) {
    const st = S.route.steps[S.stepIndex];
    if (st) { centerOn(S.v2, st.from, w, h, 2.2); return; }
  }
  const pts = [];
  for (const p of S.paths) if (levels.includes(p.level)) pts.push(...p.coords);
  for (const f of S.facilities) if (levels.includes(f.level) && f.point) pts.push(f.point);
  /*
   * ★ 这里必须 push 整个环，不能 push(...poly[0])。
   *   polygons 是【环的数组】：ring 本身就是一个环（点的数组），
   *   poly[0] 只是【一个点】。展开它会把 x、y 当成两个「点」推进去，
   *   pts 变成一串数字 —— 后面 p[0] 取到 undefined，
   *   Math.min 出 NaN，缩放变 NaN，整个 2D 视图画到屏幕外，
   *   连比例尺都看不见。而且不报任何错。
   */
  for (const r of S.regions) {
    if (!levels.includes(r.level)) continue;
    for (const ring of r.polygons) pts.push(...ring);
  }
  if (pts.length) fitView(S.v2, pts, w, h);
}

/**
 * 用户手动动过 2D 视图之后，标记「本场合已经取好景了」。
 *
 * ★ 不能写成 S._v2Key = '__manual__'。
 *   那样它永远不等于下一帧算出来的 key，于是【每帧都重新取景】，
 *   用户刚拖动的结果立刻被覆盖 —— 表现就是「2D 拖不动、缩不了」。
 *   正确做法是把当前的 key 记下来，让 ensure2dView 认为这个场合已经处理过了。
 */
function lockV2() { S._v2Key = v2Key(); }

/**
 * 路线转成 3D 折线，标出哪一段是当前步。
 * 当前步会贴地抬高 5cm，避免和通行线自己打架（同高度的共面闪烁）。
 */
function routeLines3d() {
  if (S.mode !== 'nav' || !S.route) return [];
  const out = [];
  const preview = S.phase === 'preview';
  const EZ = (lv) => explodedZ(S.manifest, lv, explodeFactor(levelsInPlay()));

  S.route.steps.forEach((st, i) => {
    /*
     * ★ current = 「你正在走的那一步」——【只在分步导航阶段存在】。
     *   预览时全部标 current 会让整条路走"压在一切之上、不透明"的分支，
     *   楼板房间全都挡不住，看上去就是"没有遮挡"。详见下面水平线那段。
     */
    const current = !preview && i === S.stepIndex;

    /*
     * ★ 跨层的那一步（扶梯/电梯/楼梯）画成【上下层之间的竖线】。
     *
     *   同一个 verticalGroup 的成员在各层坐标完全相同，
     *   所以这条线本来就是纯竖直的 —— from 和 to 的 (x,y) 一样，
     *   只有 z 不同。不需要额外算什么几何。
     *
     *   它在画面上回答的是"我是从哪一层下到哪一层"，
     *   炸开之后这条线会拉得很长，一眼就能看到跨了几层。
     */
    if (st.kind === 'vertical' && st.crossesLevels?.length >= 2) {
      const [lo, hi] = st.levels;
      out.push({
        level: lo,
        levels: st.levels,
        vertical: true,
        down: (S.manifest?.levels?.[hi]?.order ?? 0) < (S.manifest?.levels?.[lo]?.order ?? 0),
        current,
        preview,
        pts: [
          [st.from[0], st.from[1], EZ(lo)],
          [st.from[0], st.from[1], EZ(hi)],
        ],
      });
      return;
    }

    const z = EZ(st.level) + 0.08;
    out.push({
      level: st.level,
      /*
       * ★ current = 「你正在走的那一步」，【只在分步导航阶段存在】。
       *
       *   预览时【不能】把它标成 current —— 那个标记会让这条线
       *   走"画在所有楼层之后、完全不透明、穿墙可见"的分支。
       *   整条路都标上的话，预览就是一条糊在所有东西上面的亮青色带子，
       *   楼板、房间全都挡不住它 —— 看上去就是"没有遮挡"。
       *   （实测截图确认过：预览路线是 8px 青色带折点圆点，正是当前步的样式。）
       *
       *   预览要高亮，靠的是【颜色和粗细】，不是"画在最上面"。
       */
      current: !preview && i === S.stepIndex,
      preview,
      pts: [[st.from[0], st.from[1], z], [st.to[0], st.to[1], z]],
    });
  });
  return out;
}

/** 起点 / 终点的位置（面状设施用质心）。 */
function facilityPoint(f) {
  if (!f) return null;
  if (f.point) return f.point;
  if (f.polygons?.length) return ringCentroid(f.polygons[0]);
  return null;
}

/**
 * 起点和终点的标记。
 * ★ 两种颜色区分：起点绿、终点红 —— 和 2D 的圆圈、信息卡上的按钮同一套语言。
 * ★ 面状设施要带上轮廓环，3D 里好把整个体块描出来（只看一个圆点太弱）。
 */
function endpointMarkers(level) {
  const out = [];
  for (const [id, color, tag] of [[S.from, '#5aa87a', '起'], [S.to, '#d95757', '终']]) {
    if (!id) continue;
    const fac = S.facilities.find((x) => x.id === id);
    const p = facilityPoint(fac);
    if (!fac || !p) continue;
    if (level && fac.level !== level) continue;
    out.push({
      p, color, tag, level: fac.level,
      ring: fac.polygons?.[0] ?? null,      // 面状设施 → 描整个轮廓
    });
  }
  return out;
}

/**
 * 跟走相机：站在当前步起点上方，俯视这一段路。
 *
 * ★ 视线高度调过两轮：
 *   1.6 米平视（真人身高）—— 脚下完全在视野外，只看得见远处的墙。
 *   2.6 米略俯 —— 还是太平，像贴着地面看，没有「俯视当前路段」的感觉。
 *   现在：站到 8 米高、注视点压到地面，俯角约 30~45°。
 *
 * ★ 用户偏移（S.cam3d.follow）是在基准位姿上【叠加】的，
 *   不是每帧覆盖 —— 否则拖完下一帧就被基准值盖回去，等于不能动。
 */
const EYE_HEIGHT = 8.0;
const LOOK_DROP = 8.0;      // 注视点比眼睛低多少米（压到地面附近）

/**
 * 把"跟走基准位姿"换算成轨道参数，交给自由相机接管。
 *
 * ★ 不换算的话，一拖动画面就会【跳】——
 *   轨道参数（yaw/pitch/dist/target）停在某个旧值上，
 *   而屏幕上显示的是跟走位姿，两者根本不是同一个视角。
 *   换算完，拖动的第一帧就接着当前看到的画面继续。
 */
function adoptFollowPose(c) {
  const cam = followCamera();
  if (!cam) return;
  const dx = cam.eye[0] - cam.target[0];
  const dy = cam.eye[1] - cam.target[1];
  const dz = cam.eye[2] - cam.target[2];
  c.target = cam.target.slice();
  c.dist = Math.max(8, Math.hypot(dx, dy, dz));
  c.pitch = Math.asin(Math.max(-1, Math.min(1, dz / c.dist)));
  c.yaw = Math.atan2(dx, -dy);
}

/**
 * 炸开之后的楼层 z。跟走相机、路线、起终点都要用同一个公式 ——
 * 否则楼板拉开了，这些东西还留在原来的高度上。
 */
function EZ_OF(level) {
  return explodedZ(S.manifest, level, explodeFactor(levelsInPlay()));
}

function followCamera() {
  const st = S.route?.steps[S.stepIndex];
  const f = S.cam3d.follow;
  if (!st) return orbitCamera([S.level]);

  const z = EZ_OF(st.level) + EYE_HEIGHT * f.zoom;
  const eye = [st.from[0], st.from[1], z];

  // 基准朝向：从当前步起点指向终点
  const dir = [st.to[0] - st.from[0], st.to[1] - st.from[1]];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  let ux = dir[0] / len, uy = dir[1] / len;

  // 叠加用户的转向偏移
  const cos = Math.cos(f.yaw), sin = Math.sin(f.yaw);
  const rx = ux * cos - uy * sin;
  const ry = ux * sin + uy * cos;
  ux = rx; uy = ry;

  const ahead = Math.min(16, Math.max(8, len * 0.9)) * f.zoom;
  const target = [
    st.from[0] + ux * ahead,
    st.from[1] + uy * ahead,
    z - LOOK_DROP * f.zoom * (1 + f.pitch),
  ];
  return makeCamera(eye, target);
}

/*
 * ══════════════════════════════════════════════════════════════════
 * 相机动画
 *
 * ★ 为什么需要：
 *   换到下一步时相机是【瞬移】的 —— 从上一步的俯视角度"啪"地跳到
 *   下一步的俯视角度，人会瞬间失去空间感，不知道自己是往前走还是往后退。
 *   补一段 420ms 的过渡，位移就能被眼睛跟上。
 *
 * ★ 插值的是 eye 和 target 两个点，不是 yaw/pitch/dist。
 *   两点插值天然走直线、不会绕远；用角度插值会在某些朝向下转一大圈。
 * ══════════════════════════════════════════════════════════════════
 */
let camAnim = null;          // { fromEye, fromTarget, toEye, toTarget, t0, dur }
const CAM_ANIM_MS = 420;

function startCamAnim(fromCam, toCam, dur = CAM_ANIM_MS) {
  if (!fromCam || !toCam) return;
  camAnim = {
    fromEye: fromCam.eye.slice(), fromTarget: fromCam.target.slice(),
    toEye: toCam.eye.slice(), toTarget: toCam.target.slice(),
    t0: performance.now(), dur,
  };
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/** 有动画在跑就返回插值出来的相机，否则 null。 */
function animCamera() {
  if (!camAnim) return null;
  const k = Math.min(1, (performance.now() - camAnim.t0) / camAnim.dur);
  const e = easeInOut(k);
  const mix = (a, b) => [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
  if (k >= 1) { camAnim = null; return null; }   // 结束就交回正常逻辑
  return makeCamera(mix(camAnim.fromEye, camAnim.toEye), mix(camAnim.fromTarget, camAnim.toTarget));
}

/**
 * 切到下一步（或换视角）时，从当前相机【动画过渡】到新的默认位姿。
 *
 * ★ 即使用户已经手动转过视角，也要过渡 ——
 *   用户的要求正是"即使不在默认位置，切下一步时也要动过去"。
 *   瞬移回默认会让人以为视角被重置了；动过去才知道是"跟着走"。
 */
function animateToDefault(fromCam) {
  // 先按新的一步算出目标位姿
  const wasFree = S.cam3d.free;
  S.cam3d.free = false;
  const to = (S.view === '3d-follow' && S.mode === 'nav' && S.route)
    ? followCamera() : orbitCamera(levelsInPlay().length ? levelsInPlay() : [S.level]);
  S.cam3d.free = wasFree;
  startCamAnim(fromCam, to);
}

/**
 * 轨道相机。浏览模式和「3D 路线全览」共用。
 *
 * ★ 只有【用户没动过】的时候才自动取景。
 *   之前的写法是 3d-overview 每帧都调 fitCamera()，
 *   用户一拖，下一帧就被覆盖 —— 表现就是「全览时不能移动视角」。
 */
function orbitCamera(levels) {
  const c = S.cam3d;
  const ls = levels.length ? levels : [S.level];
  if (!c.free) {
    // 自动框住这几层的包围盒
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const lv of ls) {
      const b = S.scene?.boundsByLevel?.get(lv);
      if (!b) continue;
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    if (Number.isFinite(x0)) {
      const zs = ls.map((lv) => levelZ(S.manifest, lv));
      c.target = [(x0 + x1) / 2, (y0 + y1) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
      c.dist = Math.max(x1 - x0, y1 - y0, 60) * 1.15;
    }
    // ★ 默认视角：从南侧斜上方看，偏航 -35°、俯仰 42°。
    //   原来那个固定 eye 偏移角度太陡又偏，看起来别扭。
    c.yaw = -0.6;
    c.pitch = 0.75;
  }
  const { yaw, pitch, dist, target } = c;
  const eye = [
    target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    target[1] - dist * Math.cos(pitch) * Math.cos(yaw),
    target[2] + dist * Math.sin(pitch),
  ];
  return makeCamera(eye, target);
}

/* ============================================================ 面板 */

function renderAll() {
  renderTop();
  renderLevels();
  renderViewModes();
  renderSearch();
  renderCard();
  renderPlanError();
  renderInfo();
  requestDraw();
}

function renderTop() {
  const seg = $('modeSeg');
  seg.replaceChildren(
    el('button', { class: S.mode === 'browse' ? 'on' : '', onclick: () => setMode('browse') }, '浏览'),
    el('button', { class: S.mode === 'nav' ? 'on' : '', onclick: () => setMode('nav') }, '导航'),
  );
}

function setMode(m) {
  S.mode = m;
  S.selected = null;
  if (m === 'browse') { S.route = null; S.stepIndex = 0; S.view = '3d-follow'; }
  else { S.view = '3d-follow'; }
  renderAll();
}

function renderLevels() {
  const box = $('levels');
  if (S.mode === 'nav') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const levels = Object.keys(S.manifest.levels ?? {}).filter((k) => !k.startsWith('_'))
    .sort((a, b) => (S.manifest.levels[b].order ?? 0) - (S.manifest.levels[a].order ?? 0));
  box.replaceChildren(...levels.map((lv) => {
    const meta = S.manifest.levels[lv];
    const has = S.facilities.some((f) => f.level === lv) || S.paths.some((p) => p.level === lv);
    return el('button', {
      class: lv === S.level ? 'on' : '',
      disabled: !has,
      onclick: () => { S.level = lv; S.selected = null; S.cam3d.free = false; renderAll(); },
    }, meta.name ?? lv);
  }));
}

function renderViewModes() {
  const box = $('viewModes');
  const opts = S.mode === 'nav'
    ? [['3d-follow', '3D 跟走'], ['3d-overview', '3D 路线全览'], ['2d-follow', '2D 跟走'], ['2d-overview', '2D 路线全览']]
    : [['3d-follow', '3D 视角'], ['2d-follow', '2D 视角']];
  const kids = opts.map(([id, label]) => el('button', {
    class: S.view === id ? 'on' : '', onclick: () => {
      S.view = id;
      // ★ 换视角时把相机交还给自动取景 ——
      //   否则从「全览」切到「跟走」再切回来，看到的还是上次手动转过的角度，
      //   用户会以为「视角坏了」。
      S.cam3d.free = false;
      S.cam3d.follow = { yaw: 0, pitch: 0, zoom: 1 };
      // ★ 窄屏上选完就收起菜单，不然它一直挡着地图
      $('viewModes').classList.remove('open');
      renderAll();
    },
  }, label));

  // 只在 3D 下有意义 —— 2D 是俯视图，没有遮挡这回事
  if (S.view.startsWith('3d')) {
    const following = S.view === '3d-follow' && S.mode === 'nav' && S.route;
    kids.push(el('button', {
      class: S.xray ? 'on' : '',
      title: '默认：物体【完全遮挡】后面的通行线。开启后通行线完整渲染，但透明 40%，用来排查墙后面有没有画线。',
      style: 'margin-top:6px;border-top:1px solid var(--line);padding-top:8px',
      onclick: () => { S.xray = !S.xray; renderAll(); },
    }, S.xray ? '透视通行线 ✓' : '透视通行线'));
    // ★ 现在视角可以自由转了，得给一个回到默认的出口
    kids.push(el('button', {
      title: following ? '回到「站在当前步起点、俯视这一段」的默认视角'
        : '回到自动框住整层的默认视角',
      onclick: () => {
        S.cam3d.free = false;
        S.cam3d.follow = { yaw: 0, pitch: 0, zoom: 1 };
        renderAll();
      },
    }, '重置视角'));

    /*
     * ★ 楼层炸开【不是开关】—— 多层自动拉开，单层自动不拉。
     *   几层楼板叠在同一高度上就是一团糊：看不出有几层，
     *   也看不出哪段在哪层。那不是"另一种视图"，是渲染错误的样子。
     *   所以这里只报状态，不给关掉的机会。
     */
    if (levelsInPlay().length > 1) {
      kids.push(el('button', {
        class: 'on',
        title: '跨层时楼层自动拉开，避免几层糊在一起。这里只是告诉你当前状态。',
        onclick: () => toast(`正显示 ${levelsInPlay().length} 层 —— 已自动拉开 ${EXPLODE_FACTOR}×`),
      }, `楼层已拉开 ${EXPLODE_FACTOR}×`));

      /*
       * ★ 聚焦楼层。
       *   多层一起看时，非聚焦层会压住要看的那层 ——
       *   尤其跨层预览，下面那层的路径全被上面的楼板盖住。
       *   点一下就只留那层清晰，其它降到 0.22（仍然看得见轮廓，那是空间参照）。
       */
      for (const lv of levelsInPlay()) {
        const on = S.focusLevel === lv;
        kids.push(el('button', {
          class: on ? 'on' : '',
          title: on ? '取消聚焦，恢复所有楼层' : `只把 ${S.manifest?.levels?.[lv]?.name ?? lv} 显示清晰，其它层变半透明`,
          onclick: () => {
            S.focusLevel = on ? null : lv;
            renderAll();
          },
        }, `聚焦 ${S.manifest?.levels?.[lv]?.name ?? lv}`));
      }
    }
  }
  box.replaceChildren(...kids);
}

/* ---------------------------------------------------------- 搜索 */

function renderSearch() {
  const box = $('search');
  if (S.mode !== 'nav') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  /*
   * ★ 开始分步导航之后，起终点卡片缩到左上角。
   *   跟走时画面中间是「路」，卡片挡在那儿最碍事；
   *   但起终点要随时可见，所以是变小挪边，不是隐藏。
   */
  box.classList.toggle('compact', S.phase === 'navigating');

  const field = (which, label, placeholder) => {
    const cur = S[which];
    const inp = el('input', { type: 'text', placeholder, value: cur ? nameOf(cur) : '' });
    const sug = el('div', { id: `sug-${which}`, class: 'sug hidden' });

    /**
     * 把名字里【命中的那几个字】标出来。
     *
     * ★ 这是让候选"说得通"的关键：光看到「星巴克」出现在结果里，
     *   你不知道是因为名字匹配、还是因为类别、还是因为某个字段。
     *   标出来之后，「为什么它在这里」一眼就有答案。
     *
     * 只在名字里找；名字里没有（说明是字段/别名命中的）就不标，
     * 那本身也是一种信息。
     */
    const highlight = (title, q) => {
      if (!q) return title;
      const i = title.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return title;
      const frag = document.createDocumentFragment();
      frag.append(
        title.slice(0, i),
        el('mark', {}, title.slice(i, i + q.length)),
        title.slice(i + q.length),
      );
      return frag;
    };

    inp.oninput = () => {
      const q = inp.value.trim();
      if (!q) { sug.classList.add('hidden'); return; }
      const hits = searchFacilities(q).slice(0, 12);

      if (!hits.length) {
        // ★ 空结果也要有反馈 —— 什么都不显示会让人以为"卡住了"
        sug.replaceChildren(el('div', { class: 'empty' }, `没有找到「${q}」相关的设施`));
        sug.classList.remove('hidden');
        return;
      }

      sug.replaceChildren(...hits.map((h, i) => el('div', {
        // ★ 错开入场：每条按序号延迟 26ms，从上往下依次滑入
        style: `--i:${i}`,
        onclick: () => {
          S[which] = h.id; S.selected = h.id;
          // 输入框里回填的也用同一套标题写法（起终点卡片会一直显示这个值）
          inp.value = facilityTitle(h, h.id);
          sug.classList.add('hidden');
          renderSearch(); renderInfo(); requestDraw(); tryPlan();
        },
      },
      // ★ 主行显示完整标题（和选中后的信息卡一致）—— 不要出现「(无名)」
      el('span', {}, highlight(facilityTitle(h, h.id), q)),
      // 楼层：多层导航时"在哪一层"和"是什么"一样重要，所以单独一个标签
      h.level ? el('span', { class: 'lv' }, S.manifest?.levels?.[h.level]?.name ?? h.level) : null,
      // ★ searchRecord() 返回的字段叫 categoryName，不是 catName。
      //   写错了不报错，只是每个候选项都显示 "undefined"。
      el('span', { class: 'cat' }, h.categoryName || '—'))));
      sug.classList.remove('hidden');
    };
    inp.onblur = () => setTimeout(() => sug.classList.add('hidden'), 180);
    /*
     * ★ ?q= 预填：填进输入框并把候选项展开。
     *   放在这里是因为只有这里拿得到 inp 和 sug。两个字段都会拿到，
     *   但只展开【起点】那个 —— 两个都弹出来会打架。
     */
    if (which === 'from' && S._prefillQuery) {
      inp.value = S._prefillQuery;
      setTimeout(() => inp.oninput(), 0);
    }
    return el('div', { class: 'f' }, el('label', {}, label), inp, sug);
  };

  box.replaceChildren(
    field('from', '起点', '搜店名 / 登机口 / 航司…'),
    field('to', '终点', '搜店名 / 登机口 / 航司…'),
    el('div', { class: 'acts' },
      // ★ 这个按钮是「算路 + 预览」，不是「开始走」——
      //   真正的开始分步在预览卡片上。两个按钮同名会让人点错。
      el('button', { class: 'primary', onclick: tryPlan }, '预览路线'),
      el('button', { onclick: () => { S.from = S.to = null; S.route = null; S.phase = 'idle'; renderAll(); } }, '清空')),
  );
}

const nameOf = (id) => S.index?.byId?.get(id)?.name || id;

function searchFacilities(q) {
  const t = String(q).toLowerCase().trim();
  if (!t) return [];
  const hits = [];
  for (const r of S.index.records) {
    const name = (r.name || '').toLowerCase();
    let score = 0;
    if (name === t) score = 100;
    else if (name.startsWith(t)) score = 80;
    else if (name.includes(t)) score = 60;
    else if (r.terms.some((x) => x.startsWith(t))) score = 40;
    else if (r.text.includes(t)) score = 20;
    if (score) hits.push({ ...r, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------------- 导航 */

/**
 * 算路。失败时把原因【留在界面上】，不要只弹一个 3 秒就消失的 toast ——
 * 「为什么走不过去」是用户最需要看清的信息，一闪而过等于没说。
 */
function tryPlan() {
  if (!S.from || !S.to) return toast('起点和终点都要选', 'err');
  const r = planRoute(S.net, S.from, S.to, {
    walkSpeed: walkSpeedMPerMin(),
    accessibleOnly: S.accessibleOnly,
  });
  if (!r.ok) {
    console.warn('[导航] 算路失败：', r.error, r.debug);
    S.planError = r.error;
    S.planDebug = r.debug ?? null;
    S.route = null;
    renderAll();
    return;
  }
  S.planError = null;
  S.planDebug = null;
  S.route = r;
  S.stepIndex = 0;
  S.level = r.steps[0]?.level ?? S.level;
  /*
   * ★ 算完路【先预览，不直接开始分步】。
   *   默认 3D 俯视 —— 让用户先看清整条路怎么走、从哪到哪，
   *   确认了再点「开始导航」进入跟走。直接跳到第一步会让人措手不及。
   */
  S.phase = 'preview';
  S.view = '3d-overview';
  S._v2Key = null;
  toast(`共 ${r.steps.length} 步 · ${Math.round(r.totalMeters)} 米 · 约 ${Math.round(r.totalMinutes)} 分钟`, 'ok');
  renderAll();
}

/** 从预览进入分步导航。 */
function startNavigation() {
  if (!S.route) return;
  S.phase = 'navigating';
  S.stepIndex = 0;
  S.view = '3d-follow';
  S._v2Key = null;
  S.selected = null;
  renderAll();
}

function stepTo(i) {
  /*
   * ★ 先把【当前】相机抓住，再改 stepIndex。
   *   顺序反了的话，animateToDefault 拿到的"起点"已经是新位姿，
   *   动画就成了零距离 —— 等于没动画。
   */
  const before = currentCamera();

  S.stepIndex = Math.max(0, Math.min(S.route.steps.length - 1, i));
  const st = S.route.steps[S.stepIndex];
  S.level = st.level;

  /*
   * ★ 换步时带动画过渡到新的默认视角。
   *   即使用户已经手动转过视角也要过渡 —— 瞬移回默认会让人
   *   以为视角被重置了；动过去才知道是"跟着走到了下一段"。
   */
  S.cam3d.free = false;
  S.cam3d.follow = { yaw: 0, pitch: 0, zoom: 1 };
  animateToDefault(before);

  renderAll();
  startCamAnimLoop();
}

/** 当前这一帧用的相机（动画中就用动画的）。 */
function currentCamera() {
  if (camAnim) return animCamera();
  if (S.view === '3d-follow' && S.mode === 'nav' && S.route
      && !S.cam3d.free) {
    return followCamera();
  }
  return orbitCamera(levelsInPlay().length ? levelsInPlay() : [S.level]);
}

/*
 * ★ 相机动画要靠连续重绘才能动起来。
 *   和跨层流动动画一样，用 setInterval 按需启停 ——
 *   自续的 requestAnimationFrame 在无头环境里会变成同步递归，直接卡死。
 */
let camTimer = 0;
function startCamAnimLoop() {
  if (camTimer) return;
  camTimer = setInterval(() => {
    draw();
    if (!camAnim) { clearInterval(camTimer); camTimer = 0; }
  }, 16);
}

function renderCard() {
  const box = $('card');
  if (S.mode !== 'nav' || !S.route) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const n = S.route.steps.length;

  /*
   * ★ 预览阶段：先把整条路摊开给用户看，还不分步。
   *   说清「从哪到哪、多远、多久、几步」，确认了再点开始。
   */
  if (S.phase === 'preview') {
    const nm = (id) => S.index?.byId?.get(id)?.name || S.facilities.find((f) => f.id === id)?.props?.name || id;
    const lv = [...new Set(S.route.steps.flatMap((s) => s.levels))];
    box.replaceChildren(
      el('div', { class: 'row1' }, el('span', { class: 'instr' }, '路线预览')),
      el('div', { class: 'meta', style: 'line-height:1.8' },
        `起点　${nm(S.from)}\n终点　${nm(S.to)}\n`
        + `全程　${Math.round(S.route.totalMeters)} 米 · 约 ${Math.round(S.route.totalMinutes)} 分钟 · ${n} 步`
        + (lv.length > 1 ? `\n跨层　${lv.join(' → ')}` : '')),
      el('div', { class: 'acts' },
        el('button', { class: 'primary', onclick: startNavigation }, '开始导航'),
        el('button', { onclick: () => { S.route = null; S.phase = 'idle'; renderAll(); } }, '重新选')),
    );
    return;
  }

  const st = S.route.steps[S.stepIndex];
  const done = S.stepIndex >= n - 1;

  box.replaceChildren(
    el('div', { class: 'prog' }, el('i', { style: `width:${((S.stepIndex + 1) / n) * 100}%` })),
    el('div', { class: 'row1' },
      el('span', { class: 'idx' }, `${S.stepIndex + 1}/${n}`),
      el('span', { class: 'instr' }, st.instruction)),
    el('div', { class: 'meta' },
      st.detail ?? '',
      st.crossesLevels ? `　· 跨层 ${st.crossesLevels.join(' → ')}` : '',
      st.crossesZones ? `　· 跨区 ${st.crossesZones.join(' → ')}` : ''),
    el('div', { class: 'acts' },
      el('button', { disabled: S.stepIndex === 0, onclick: () => stepTo(S.stepIndex - 1) }, '上一步'),
      el('button', { class: 'primary', disabled: done, onclick: () => stepTo(S.stepIndex + 1) },
        done ? '已到达' : '我已走到，下一步')),
  );
}

/** 算不出路时，把原因常驻在界面上。 */
function renderPlanError() {
  // ★ 没有错误就【什么都别做】。这个函数和 renderCard 共用 #card 这个盒子，
  //   顺手隐藏一下就会把 renderCard 刚画好的步骤卡片擦掉。
  if (!S.planError || S.mode !== 'nav' || S.route) return;
  const box = $('card');
  box.classList.remove('hidden');
  box.replaceChildren(
    el('div', { class: 'row1' }, el('span', { class: 'instr', style: 'color:var(--err)' }, '走不过去')),
    el('div', { class: 'meta', style: 'white-space:pre-wrap;line-height:1.6' },
      S.planError,
      S.planDebug ? `\n路网 ${S.planDebug.nodes} 节点 / ${S.planDebug.edges} 边 / ${S.planDebug.links} 条连接件边`
        + `\n起点在分量 ${S.planDebug.fromComp}（${S.planDebug.fromCompSize} 个节点）`
        + `　终点在分量 ${S.planDebug.toComp}（${S.planDebug.toCompSize} 个节点）` : ''),
    el('div', { class: 'acts' },
      el('button', { onclick: () => { S.planError = null; renderAll(); } }, '知道了')),
  );
}

/* ---------------------------------------------------------- 设施信息 */

/**
 * 设施的大标题：类别 + 名称，或者带前缀的类别。
 *
 * 三种情况，全部由 manifest 配置驱动，代码里不写死任何类别：
 *
 *   ① labelKey      —— 某字段【替代】名字。登机口 gateNo=E42 → 「登机口 E42」
 *   ② titlePrefix   —— 某字段【修饰】类别。卫生间 restroomType=male → 「男卫生间」
 *   ③ 都没有        —— 名字为空就显示类别，名字已含类别前缀就不重复
 *
 * ★ 为什么不写死「卫生间」：以后下机口、出入口、行李转盘都可能要类似效果，
 *   每加一个就改一次客户端，迟早会漏。
 */
function facilityTitle(rec, fallbackId) {
  const cat = String(rec?.categoryName ?? '').trim();
  const nm = String(rec?.name ?? '').trim();
  const defs = S.manifest?.facilityCategories?.[rec?.category]?.fields ?? [];

  // ② 前缀字段：有值就用它的选项文字拼在类别前面
  for (const def of defs) {
    if (!def.titlePrefix) continue;
    const v = rec.fields?.[def.key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const opt = (def.options ?? []).find((o) => o.value === String(v));
    const prefix = opt?.label ?? String(v);
    // 名字是类别本身（或为空）时，用「前缀+类别」；有独立名字就「前缀+类别 名字」
    const base = !nm || nm === cat ? cat : `${cat} ${nm}`;
    return `${prefix}${base}`;
  }

  // ③ 名字为空 → 只显示类别
  if (!nm) return cat || fallbackId || '';
  // 名字里已经带了类别（「电梯 1」对类别「电梯」）就不重复
  return (cat && nm.startsWith(cat)) ? nm : `${cat} ${nm}`;
}

function renderInfo() {
  const box = $('info');
  const id = S.selected;
  if (!id) { box.classList.add('hidden'); return; }
  const f = S.facilities.find((x) => x.id === id);
  /*
   * ★ 搜不到索引记录时【不要静默隐藏】。
   *   早先这里 `if (!f || !rec) { hidden; return; }` —— 索引一旦没建好
   *   或者 id 对不上，点设施就「什么都没发生」，完全看不出为什么。
   *   退回到原始 properties 也要把信息显示出来。
   */
  const rec = S.index?.byId?.get(id) ?? (f ? {
    id: f.id,
    name: f.props?.name ?? '',
    category: f.props?.category,
    categoryName: S.manifest?.facilityCategories?.[f.props?.category]?.name ?? f.props?.category ?? '—',
    level: f.level,
    kind: f.point ? 'point' : 'area',
    fields: f.props?.fields ?? {},
    aliases: f.props?.aliases ?? [],
  } : null);
  if (!f || !rec) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const kv = [];
  if (f.level) kv.push(['楼层', S.manifest.levels?.[f.level]?.name ?? f.level]);
  /*
   * ★ 不再单列「类别」—— 大标题已经写了（「女卫生间」「登机口 E42」）。
   *   再列一行「类别 卫生间」既是重复，又会和字段名撞车
   *   （restroomType 的标签原来也叫「类别」，两行长得一模一样）。
   */
  for (const def of (S.manifest.facilityCategories?.[rec.category]?.fields ?? [])) {
    const v = rec.fields[def.key];
    if (v === undefined || v === '') continue;
    /*
     * ★ choice 字段要翻译成选项文字。
     *   直接 String(v) 会显示内部的 "female" —— 那是给程序看的，
     *   旅客看不懂，和界面上按钮写的「女」也对不上。
     */
    if (def.type === 'choice') {
      const opt = (def.options ?? []).find((o) => o.value === String(v));
      kv.push([def.label, opt?.label ?? String(v)]);
    } else {
      kv.push([def.label, def.type === 'boolean' ? (v ? '是' : '否') : String(v)]);
    }
  }
  for (const [k, v] of Object.entries(rec.fields)) {
    if (kv.some(([kk]) => kk === k)) continue;
    if ((S.manifest.facilityCategories?.[rec.category]?.fields ?? []).some((x) => x.key === k)) continue;
    kv.push([k, String(v)]);
  }
  const att = S.net?.attachments?.get(id);
  kv.push(['可达', att?.served ? '✓ 已接入路网' : '✗ 没有通行线接上']);

  /*
   * 标题逻辑全部收进 facilityTitle() —— 搜索候选也用它，两处必须一致。
   * 里面有三种情况的说明（labelKey / titlePrefix / 都没有）。
   */

  box.replaceChildren(
    el('button', { class: 'x', onclick: () => { S.selected = null; renderInfo(); requestDraw(); } }, '×'),
    el('h3', {}, facilityTitle(rec, f.id)),
    el('div', { class: 'cat' }, rec.kind === 'area' ? '面状设施' : '点状设施'),
    el('dl', {}, ...kv.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    el('div', { class: 'acts' },
      el('button', { onclick: () => { S.from = id; setMode('nav'); renderAll(); } }, '设为起点'),
      el('button', { onclick: () => { S.to = id; setMode('nav'); renderAll(); } }, '设为终点'),
    ),
  );
}

/**
 * 步行速度（米/分钟）。
 * ★ manifest.timeModel.walkSpeed 是一张按人群分的表，单位是【米/秒】，
 *   不是数字。取 default 再乘 60。传错了会让权重全变 NaN，
 *   表现是「两点之间不连通」—— 查起来非常费劲。
 */
function walkSpeedMPerMin() {
  const w = S.manifest?.timeModel?.walkSpeed;
  const ms = typeof w === 'number' ? w : (w?.default ?? 1.25);
  return ms * 60;
}

/* ============================================================ 交互 */

const cv = $('cv');
let drag = null;

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  // x0/y0 是按下点，用来算【净位移】；x/y 是上一帧位置，用来算增量
  drag = { x, y, x0: x, y0: y, moved: 0, button: e.button, shift: e.shiftKey };
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const dx = x - drag.x, dy = y - drag.y;
  /*
   * ★ 这里算的是【离按下点的净位移】，不是路径总长度。
   *   原来写的是 drag.moved += |dx| + |dy| —— 累加路径长度。
   *   手稍微抖一下，来回 3px 走几趟就累加到 15px 以上，
   *   净位移其实几乎是 0，却被当成拖拽，点击被吞掉。
   *   表现就是「点设施有概率选不中」。
   */
  drag.moved = Math.hypot(x - drag.x0, y - drag.y0);

  if (S.view.startsWith('3d')) {
    const c = S.cam3d;
    /*
     * ★ 跟走时【也允许完全自由地转】。
     *
     *   原来跟走是"基准位姿 + 偏移"的受限模式：只能左右转、上下俯仰，
     *   不能平移。但用户会想绕到侧面看看、或者拉远一点看整段路 ——
     *   受限反而别扭。
     *
     *   现在的规则：
     *     默认   → 站在当前步起点、俯视这一段（基准位姿）
     *     一拖动 → 立刻切成【轨道相机】，从当前位姿接管，完全自由
     *     切下一步 → 从当前位置【动画】回到新的默认位姿（见 animateToDefault）
     *
     *   关键：切换的那一刻要把"当前看到的位姿"换算成轨道参数，
     *   否则一拖画面就会跳 —— 因为轨道参数还停在某个旧值上。
     */
    const following = S.view === '3d-follow' && S.mode === 'nav' && S.route;
    if (following && !c.free) adoptFollowPose(c);

    c.free = true;
    if (drag.button === 2 || drag.shift) {
      /*
       * 平移：在水平面上按「相机的右 / 前」方向挪 target。
       * 相机方位：eye = target + dist·(cos(pitch)·sin(yaw), −cos(pitch)·cos(yaw), sin(pitch))
       * 所以水平朝向是 (sin yaw, −cos yaw)，右方向是 (cos yaw, sin yaw)。
       */
      const k = c.dist / 700;
      const rx = Math.cos(c.yaw), ry = Math.sin(c.yaw);
      const fx = Math.sin(c.yaw), fy = -Math.cos(c.yaw);
      c.target[0] -= (rx * dx + fx * dy) * k;
      c.target[1] -= (ry * dx + fy * dy) * k;
    } else {
      c.yaw += dx * 0.006;
      /*
       * ★ 跟走时俯仰范围放宽到 [-0.35, 1.45]。
       *   跟走原来卡在 [-0.55, 1.2]，是为了"别让人看到地底下"；
       *   但既然现在允许自由转，就按轨道相机的范围来，
       *   只在下方留一点余量（再往下就是楼板背面了）。
       */
      const lo = following ? -0.35 : 0.12;
      c.pitch = Math.max(lo, Math.min(1.45, c.pitch + dy * 0.005));
    }
  } else {
    S.v2.ox += dx; S.v2.oy += dy;
    lockV2();        // 手动平移之后，本场合不再自动取景
  }
  drag.x = x; drag.y = y;
  requestDraw();
});
cv.addEventListener('pointerup', (e) => {
  const wasDrag = drag && drag.moved > 8;
  drag = null;
  if (wasDrag) { renderViewModes(); return; }
  const r = cv.getBoundingClientRect();
  const sp = [e.clientX - r.left, e.clientY - r.top];
  const hit = pick(sp);
  /*
   * ★ 选完之后必须 requestDraw()。
   *   renderInfo() 只重建左下角那张信息卡，【不碰画布】——
   *   早先这里漏了重绘，高亮要等下一次碰巧发生的重绘
   *   （拖动相机、缩放、改窗口大小）才出现，表现就是「点了之后好久才显示」。
   */
  if (hit) { S.selected = hit; renderInfo(); requestDraw(); }
  else if (S.selected) { S.selected = null; renderInfo(); requestDraw(); }
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.view.startsWith('3d')) {
    const following = S.view === '3d-follow' && S.mode === 'nav' && S.route;
    if (following) {
      // 跟走：缩放改的是「站多高 / 看多远」，不是轨道半径
      const f = S.cam3d.follow;
      f.zoom = Math.max(0.35, Math.min(3.5, f.zoom * (e.deltaY < 0 ? 0.9 : 1.1)));
    } else {
      S.cam3d.free = true;
      S.cam3d.dist = Math.max(8, Math.min(3000, S.cam3d.dist * (e.deltaY < 0 ? 0.9 : 1.1)));
    }
  } else {
    const r = cv.getBoundingClientRect();
    const s = [e.clientX - r.left, e.clientY - r.top];
    const before = toLocal(s, S.v2);
    S.v2.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const after = toLocal(s, S.v2);
    S.v2.ox += (after[0] - before[0]) * S.v2.scale;
    S.v2.oy -= (after[1] - before[1]) * S.v2.scale;
    lockV2();        // 手动缩放之后，本场合不再自动取景
  }
  requestDraw();
}, { passive: false });

/**
 * 点选设施。
 *
 * ★ 面状设施必须按【多边形本身】命中，不能只测它的中心点。
 *   早先所有设施都按「离代表点 22px 以内」判断，面状设施的代表点是质心 ——
 *   于是只有中心那一小块能点中，点边角完全没反应。
 *   实测表现就是「只有点中间才高亮」。
 *
 *   重叠时的取舍：命中多个就取【屏幕上面积最小的那个】。
 *   小店铺往往落在大区域（候机区/门厅）里面，取最小的才符合直觉 ——
 *   你想点的是那个店铺，不是它所在的那一大片。
 */
function pick(sp) {
  /*
   * ★ 导航中（预览 + 分步）不允许随便点选设施。
   *   这时候点地图的意图是「看看路」或者「点下一步」，不是「换一个设施看详情」。
   *   误点会把信息卡弹出来盖住步骤卡，跟着走的人就懵了。
   *   要换起终点，用搜索框或者「清空」。
   */
  if (S.mode === 'nav' && S.route) return null;

  const levels = levelsInPlay();
  let best = null;
  for (const f of S.facilities) {
    if (!levels.includes(f.level)) continue;

    /* ---- 面状设施：多边形命中 ---- */
    if (!f.point && f.polygons?.length) {
      for (const ring of f.polygons) {
        const scr = ringToScreen(ring, f.level);
        if (!scr) continue;                       // 有顶点在相机身后 → 退回质心
        const area = Math.abs(polyArea(scr));
        if (!pointInPoly(sp, scr)) continue;
        // 面积最小的优先（最具体的那个）
        if (!best || best.area == null || area < best.area) best = { d: 0, area, id: f.id };
      }
      // 投影不出来（贴着相机或完全在身后）时，退回质心距离
      if (!best || best.id !== f.id) {
        const c = ringCentroid(f.polygons[0]);
        const s = projectLocal(c, f.level);
        if (s) {
          const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
          if (d <= 22 && (!best || best.area == null)) best = { d, area: null, id: f.id };
        }
      }
      continue;
    }

    /* ---- 点状设施：按屏幕距离 ---- */
    if (!f.point) continue;
    const s = projectLocal(f.point, f.level);
    if (!s) continue;
    const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
    // 点标记永远优先于面 —— 它画在最上层，点它就该选中它
    if (d <= 22 && (!best || best.area != null || d < best.d)) best = { d, area: null, id: f.id };
  }
  return best?.id ?? null;
}

/** 本地坐标 → 屏幕坐标。2D 走视图变换，3D 走投影。 */
function projectLocal(p, level) {
  if (S.view.startsWith('3d')) {
    const cam = S._lastCam;
    if (!cam) return null;
    const pr = projectPoint(p, level, cam);
    return pr ? [pr.x, pr.y] : null;
  }
  return toScreen(p, S.v2);
}

/** 环 → 屏幕多边形。任何一个顶点投不出来就返回 null。 */
function ringToScreen(ring, level) {
  const out = [];
  for (const c of ring) {
    const s = projectLocal(c, level);
    if (!s) return null;
    out.push(s);
  }
  return out.length >= 3 ? out : null;
}

function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const c of ring) { x += c[0]; y += c[1]; }
  return [x / ring.length, y / ring.length];
}

/** 叉积法算有向面积的 2 倍（只用它比大小，不用开方）。 */
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** 射线法判断点是否在多边形内。 */
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** 把设施位置投到屏幕上，供 3D 点选。 */
function projectPoint(p, level, cam) {
  const cvEl = $('cv');
  const dpr = window.devicePixelRatio || 1;
  const w = cvEl.width / dpr, h = cvEl.height / dpr;
  return project([p[0], p[1], levelZ(S.manifest, level) + 1.1], cam, w, h);
}

/* ============================================================ 主题 */

/**
 * 深浅色切换。
 * ★ 默认跟随系统（index.html 里已经同步设过一次，避免闪白），
 *   用户手动切过就写进 localStorage，之后不再跟随系统。
 *   地图配色不跟着变 —— 那是数据，深浅两套下都要能分辨。
 */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  setMapTheme(t);
  /*
   * ★ 必须重建场景。
   *
   *   view3d 的颜色不是每帧从调色板读的，而是【建场景时】写进棱柱对象的
   *   （polys.push({ fill: MAP.slab })）。buildScene 只在启动时跑一次，
   *   所以切换主题后场景里存的还是旧颜色 ——
   *   表现就是「只有画布背景变了，楼板/房间全没变」。
   *
   *   重建很便宜（几十个多边形），比改成"每帧查表"简单得多，也不会漏。
   */
  if (S.manifest && S.scene) rebuildScene();
  requestDraw();
  try { localStorage.setItem('bdia-theme', t); } catch { /* 隐私模式下写不了，忽略 */ }
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = t === 'dark' ? '☀' : '☾';
    btn.title = t === 'dark' ? '切换到浅色' : '切换到深色';
  }
}

/* ============================================================ 启动 */

/*
 * 暴露内部函数给无头测试（tools/client-selftest.mjs）。
 *
 * ★ 这些函数全是「不报错、只是看起来不对」的重灾区，人工点不出来：
 *   点选命中、近平面裁剪、场景棱柱数量。
 *   浏览器里没人读这个对象（零成本），但测试要靠它。
 */
globalThis.__navTestHooks = {
  S, pick, pointInPoly, polyArea, ringCentroid, ringToScreen, projectLocal,
  draw, resize, levelsInPlay, v2Key, ensure2dView, buildScene, levelZ,
  boot, setMode, tryPlan, renderAll, searchFacilities,
};

applyTheme(
  new URLSearchParams(globalThis.location?.search ?? '').get('theme')
  || currentTheme(),
);
$('btnTheme').onclick = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
/*
 * ★ 折叠视角菜单（窄屏）。
 *   按钮只在 ≤640px 显示 —— 桌面端菜单一直开着，没必要多点一下。
 *   展开时点画布 / 点菜单里任一项都会收起来，免得一直挡着地图。
 */
$('btnViewToggle').onclick = (ev) => {
  ev.stopPropagation();
  $('viewModes').classList.toggle('open');
};
// 点别处收起
document.addEventListener('pointerdown', (ev) => {
  const panel = $('viewModes');
  if (!panel.classList.contains('open')) return;
  if (panel.contains(ev.target) || ev.target === $('btnViewToggle')) return;
  panel.classList.remove('open');
}, true);
$('btnHelp').onclick = () => {
  toast(S.view.startsWith('3d')
    ? '拖动=旋转视角　右键/Shift+拖动=平移　滚轮=缩放　点击设施=看信息'
    : '拖动=平移　滚轮=缩放　点击设施=看信息');
};
window.addEventListener('resize', resize);

/*
 * ★ 未捕获的错误【必须显示出来】。
 *
 *   之前任何一处抛异常都是静默的：控制台里有一行，界面上毫无反应。
 *   表现是"点了没反应"——而这类问题查起来最费劲，
 *   因为你会以为是逻辑没写对，实际上是代码在中途就断了。
 *   （这次就是：stepTo 里抛了异常，后面的 renderAll 没执行到，
 *     于是"步骤卡不更新"；拖动处理里抛了，于是"视角不能动"。
 *     两个看起来无关的现象，其实是同一个异常。）
 *
 *   显示在界面上，用户截个图就能定位。
 */
let errShown = 0;
function surfaceError(where, e) {
  const msg = `${where}：${e?.message ?? e}`;
  console.error('[导航]', where, e);
  if (errShown++ > 4) return;          // 别刷屏
  toast(msg, 'err');
}
window.addEventListener('error', (ev) => surfaceError('脚本出错', ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => surfaceError('异步出错', ev.reason));

resize();
boot().catch((e) => {
  console.error(e);
  window.__navFail?.('启动出错', `<pre>${e.message}</pre>`);
});
