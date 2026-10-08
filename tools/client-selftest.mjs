/**
 * 客户端自测：3D 投影 / 场景构建 / 点选。
 *
 * ★ 这里测的全是「不报错、只是看起来不对」的东西 ——
 *   语法检查、校验器、编辑器测试全绿也照样漏。它们已经真实发生过：
 *
 *   ① 相机贴近时楼板整个不渲染（一个顶点投不出来就整块放弃，没有近平面裁剪）
 *   ② 面状设施只有中心 22px 能点中（把多边形压成了质心点）
 *   ③ 面状设施选中没有高亮（高亮只写在点标记那条分支里）
 *   ④ 点完要等下一次碰巧的重绘才高亮（改状态没 requestDraw）
 *
 *   ①②④ 在这里都有对应断言。③ 靠 draw() 的调用记录间接覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './lib/domshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'source');
const rj = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const empty = () => ({ type: 'FeatureCollection', features: [] });

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; console.log(`  FAIL ${m}${extra ? `\n         ${extra}` : ''}`); }
};
const eq = (a, b, m) => ok(a === b, m, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

console.log('\n客户端自测\n' + '─'.repeat(66));

/* ══════════════ 1. 近平面裁剪（纯几何，不需要 DOM） ══════════════ */
console.log('\n1. 近平面裁剪 —— 相机贴近时不能整块放弃');

const { projectRing, makeCamera, buildScene, levelZ } = await import('../client/lib/view3d.mjs');
const { normalizeFeatures } = await import('./lib/graph.mjs');

const MANIFEST = { levels: { L1F: { name: '一层', order: 1 } } };

{
  // 一块 200m×200m 的楼板，相机站在它正中间上方 3 米
  const ring = [[-100, -100], [100, -100], [100, 100], [-100, 100], [-100, -100]];
  const pts3 = ring.map((c) => [c[0], c[1], 0]);

  // 远看：整块在视野里
  const far = makeCamera([0, -400, 200], [0, 0, 0]);
  const rFar = projectRing(pts3, far, 1200, 800);
  ok(rFar && rFar.length >= 3, '远距离：正常返回多边形');

  // 贴近且朝前看：大部分顶点在相机身后
  const near = makeCamera([-90, 0, 3], [100, 0, 0]);
  const rNear = projectRing(pts3, near, 1200, 800);
  ok(rNear !== null && rNear.length >= 3,
    '★ 相机贴近、部分顶点在身后：仍然返回多边形（不是 null）',
    `实际 ${rNear ? rNear.length + ' 个点' : 'null'}`);

  // 完全在身后：相机在 +y 侧朝 +y 看，楼板整个在它背后
  const behind = makeCamera([0, 500, 3], [0, 1000, 3]);
  eq(projectRing(pts3, behind, 1200, 800), null, '完全在身后：返回 null');

  // 相机在楼板内部（四个顶点全在四周）
  const inside = makeCamera([0, 0, 5], [0, 100, 2]);
  const rIn = projectRing(pts3, inside, 1200, 800);
  ok(rIn !== null && rIn.length >= 3, '相机在楼板内部：仍然返回多边形');
}

/* ══════════════ 2. 场景棱柱数量对得上数据 ══════════════ */
console.log('\n2. 场景构建');

const facs = normalizeFeatures(rj(path.join(SRC, 'facilities.geojson'), empty()));
const ps = normalizeFeatures(rj(path.join(SRC, 'paths.geojson'), empty()));
const obs = normalizeFeatures(rj(path.join(SRC, 'obstacles.geojson'), empty()));
const realManifest = rj(path.join(SRC, 'manifest.json'));

{
  const sc = buildScene({ manifest: realManifest, regions: [], facilities: facs, paths: ps, obstacles: obs }, {});
  const areaCount = facs.filter((f) => f.polygons?.length).length;
  const roomCount = sc.polys.filter((o) => o.kind === 'room').length;
  eq(roomCount, areaCount, `每个面状设施都产出一个房间棱柱（${areaCount} 个）`);

  const badRing = sc.polys.filter((o) => !Array.isArray(o.ring) || o.ring.length < 3);
  eq(badRing.length, 0, '没有环点数 < 3 的畸形棱柱');

  const voidCount = obs.filter((o) => o.props?.kind === 'void').length;
  eq(sc.voidRings.length, voidCount, `挑空障碍物都进了 voidRings（${voidCount} 个）`);

  const blockedCount = obs.filter((o) => o.props?.kind !== 'void').length;
  eq(sc.polys.filter((o) => o.kind === 'obstacle').length, blockedCount,
    `非挑空障碍物都拉伸成体（${blockedCount} 个）`);

  // 挑空不应该同时被拉伸成体
  ok(!sc.polys.some((o) => o.kind === 'obstacle' && obs.find((x) => x.id === o.id)?.props?.kind === 'void'),
    '挑空没有被误当成实体拉伸');

  const lvScoped = buildScene({ manifest: realManifest, regions: [], facilities: facs, paths: ps, obstacles: obs },
    { levels: ['L3F'] });
  ok(lvScoped.polys.every((o) => o.level === 'L3F'), 'levels 过滤生效：只产出该层的棱柱');
}

/* ══════════════ 3. 启动客户端，测点选 ══════════════ */
console.log('\n3. 点选（需要 DOM）');

const DATA = {
  manifest: realManifest, anchors: null, calibration: { version: 2, levels: {} },
  connectors: rj(path.join(SRC, 'connectors.geojson'), empty()),
  facilities: rj(path.join(SRC, 'facilities.geojson'), empty()),
  obstacles: rj(path.join(SRC, 'obstacles.geojson'), empty()),
  paths: rj(path.join(SRC, 'paths.geojson'), empty()),
  levels: { L3F: { regions: rj(path.join(SRC, 'L3F', 'regions.geojson'), empty()) } },
  stamp: { mtime: 1, files: 1 },
};

const dom = installDom({
  dpr: 1,
  fetchImpl: async (url) => {
    const body = String(url).includes('/api/data') ? DATA : { files: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  },
});

await import('../client/app.js');
const app = globalThis.__navTestHooks;
if (!app) { console.log('  FAIL 客户端没启动'); process.exit(1); }
await app.boot();
const { S, pick, pointInPoly, polyArea } = app;

/* --- 3.1 纯函数 --- */
eq(pointInPoly([0, 0], [[-1, -1], [1, -1], [1, 1], [-1, 1]]), true, 'pointInPoly：内部点');
eq(pointInPoly([5, 0], [[-1, -1], [1, -1], [1, 1], [-1, 1]]), false, 'pointInPoly：外部点');
eq(Math.abs(polyArea([[0, 0], [10, 0], [10, 10], [0, 10]])) > 0, true, 'polyArea：非零');

/* --- 3.2 面状设施：整个多边形都能点中 --- */
{
  // 切到 2D，屏幕变换是确定的
  S.view = '2d-follow';
  app.renderAll();
  app.resize();
  const v = S.v2;
  const toS = (p) => [v.ox + p[0] * v.scale, v.oy - p[1] * v.scale];
  const lv = S.level;

  // ★ 断言不能写死某个 id：面状设施会互相嵌套，点标记又会优先于面，
  //   命中多个时取的是「面积最小的面」或者「最近的 22px 内的点」。
  //   这里要钉死的是【那个回归本身】：
  //   修之前，只有质心 22px 内能点中，点边角返回 null。
  const contains = (fac, pt) => (fac.polygons ?? []).some((ring) => pointInPoly(pt, ring));
  const inLevelAreas = S.facilities.filter((f) => f.level === lv && f.polygons?.length);
  ok(inLevelAreas.length > 0, `本层有面状设施（${inLevelAreas.length} 个）`);

  // 取【面积最大】的那个面（不是顶点最多的 —— 小而密的店会赢错）
  const screenArea = (f) => Math.abs(polyArea(f.polygons[0].map((c) => toS(c))));
  const area = inLevelAreas.reduce((a, b) => (screenArea(a) >= screenArea(b) ? a : b));
  const ring = area.polygons[0];
  const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
  const corner = ring[Math.floor(ring.length / 3)];

  const probes = [
    ['质心', c, true],
    ['质心→顶点 中点', [(c[0] + corner[0]) / 2, (c[1] + corner[1]) / 2], false],
    ['靠顶点 80%', [c[0] + (corner[0] - c[0]) * 0.8, c[1] + (corner[1] - c[1]) * 0.8], false],
  ];
  for (const [label, pt] of probes) {
    const hit = pick(toS(pt));
    // 关键：边角也必须能点中东西（修之前这里是 null）
    ok(hit !== null, `★ 点面状设施的「${label}」能选中东西（${hit ?? 'null'}）`);
  }

  // 质心那一击必须命中包含该点的设施 —— 这条是硬要求
  {
    const hit = pick(toS(c));
    const hitFac = S.facilities.find((f) => f.id === hit);
    ok(hitFac && (contains(hitFac, c) || hitFac.point),
      `质心一击命中了包含质心的面或附近点（${hit}）`);
  }

  // 远在多边形外面
  const far = toS([c[0] + 500, c[1] + 500]);
  const hitFar = pick(far);
  ok(hitFar !== area.id, '点远处空白处选不中它');
}

/* --- 3.3 点状设施：22px 内命中，外不命中 --- */
{
  // ★ 必须限定在当前楼层 —— 直接 find(f => f.point) 会拿到别层的设施，
  //   被 levelsInPlay() 过滤掉，测试就假失败了。
  const lv = S.level;
  const pt = S.facilities.find((f) => f.point && f.level === lv);
  ok(!!pt, `找到本层的一个点状设施（${pt?.id ?? '无'}）`);
  if (pt) {
    const v = S.v2;
    const s = [v.ox + pt.point[0] * v.scale, v.oy - pt.point[1] * v.scale];
    // 附近可能有别的设施 —— 只要求「选中了离这一点 22px 内的某个设施」
    const within = (id, sp) => {
      const f = S.facilities.find((x) => x.id === id);
      if (!f) return false;
      const c = f.point ?? f.polygons?.[0]?.reduce((a, p) => [a[0] + p[0] / f.polygons[0].length, a[1] + p[1] / f.polygons[0].length], [0, 0]);
      if (!c || f.level !== S.level) return false;
      const q = [v.ox + c[0] * v.scale, v.oy - c[1] * v.scale];
      return Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= 22;
    };
    ok(within(pick(s), s), `正中点标记能选中附近的设施（${pick(s)}）`);
    ok(within(pick([s[0] + 15, s[1]]), [s[0] + 15, s[1]]), '点标记 15px 内能选中');
    ok(pick([s[0] + 60, s[1] + 60]) !== pt.id, '点标记 60px 外选不中');
  }
}

/* --- 3.4 draw() 不抛错，而且真的画了东西 --- */
{
  const before = dom.canvasCtxCalls().length;
  let threw = null;
  try { app.draw(); } catch (e) { threw = e; }
  ok(!threw, 'draw() 不抛错', threw?.message);
  const calls = dom.canvasCtxCalls().length - before;
  ok(calls > 20, `draw() 产生了绘制调用（${calls} 次）—— 不是空跑`);

  // 3D 也要能画
  S.view = '3d-follow';
  S.cam3d.free = false;
  const b2 = dom.canvasCtxCalls().length;
  let threw3d = null;
  try { app.draw(); } catch (e) { threw3d = e; }
  ok(!threw3d, '3D draw() 不抛错', threw3d?.message);
  ok(dom.canvasCtxCalls().length - b2 > 20, '3D draw() 产生了绘制调用');
}

/* --- 3.5 选中态会改变绘制输出（高亮的间接验证） --- */
{
  S.view = '2d-follow';
  const countWith = (sel) => {
    S.selected = sel;
    const b = dom.canvasCtxCalls().length;
    app.draw();
    return dom.canvasCtxCalls().length - b;
  };
  const area = S.facilities.find((f) => f.level === S.level && f.polygons?.length);
  const n1 = countWith(null);
  const n2 = countWith(area?.id);
  ok(n2 > n1, `选中面状设施后多画了东西（${n1} → ${n2} 次调用）—— 说明高亮确实画了`);
  const pt = S.facilities.find((f) => f.level === S.level && f.point);
  const n3 = countWith(pt?.id);
  ok(n3 > n1, `选中点状设施后多画了东西（${n1} → ${n3} 次调用）`);
  S.selected = null;
}

/* ══════════════ 结果 ══════════════ */
console.log('\n' + '─'.repeat(66));
if (fail) { console.log(`  ✗ 客户端自测未通过　${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`  ✓ 客户端自测通过　${pass}/${pass}\n`);
