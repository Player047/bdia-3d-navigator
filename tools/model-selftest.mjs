/**
 * 模型自测：建图、寻路、搜索索引。
 *
 * ★ 每个用例都对应一个【真实踩过的坑】，不是凑覆盖率。
 *   两条最要紧的回归：
 *     ① walkSpeed 传成对象 —— 权重全变 NaN，dijkstra 静默地「找不到任何路」，
 *        界面上只显示一句「两点之间不连通」，查了很久。
 *     ② 节点只按精确坐标去重 —— 差 0.1 米的线头不合并，
 *        整张网碎成 23 块，而每个设施都显示「已接入路网」。
 */

import { buildNetwork, buildGraph, normalizeFeatures, setLevelOrder } from './lib/graph.mjs';
import { planRoute, buildRoutingGraph, dijkstra, nodeForFacility, fmtMinutes, fmtMeters, turnBetween } from './lib/route.mjs';
import { buildSearchIndex, searchRecord, normalizeTerm } from './lib/search.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n         ${extra}` : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const throws = (fn, label) => {
  try { fn(); fail++; console.log(`  FAIL ${label}（应该抛错的没有抛）`); }
  catch { pass++; console.log(`  ok   ${label}`); }
};

const MANIFEST = {
  levels: { L1F: { name: '一层', order: 1 }, L2F: { name: '二层', order: 2 } },
  facilityCategories: {
    gate: { name: '登机口' },
    shop: { name: '商业', fields: [{ key: 'brand', label: '品牌', type: 'string', index: true }] },
    checkin: {
      name: '值机柜台',
      fields: [
        { key: 'counterLetter', label: '字母编号', type: 'string', required: true, pattern: '^[A-Z]$' },
        { key: 'airlineCode', label: '航司代码', type: 'string', required: true, pattern: '^[A-Z0-9]{2}$' },
      ],
    },
  },
  airlines: { CA: { name: '中国国际航空' } },
  pathKinds: { spine: { name: '主通道' }, branch: { name: '支线' } },
  thresholds: { areaAttachTolerance: 1, poiPathTolerance: 5, connectorOnPathTolerance: 0.5, verticalGroupTolerance: 0.05 },
};

const fc = (features) => ({ type: 'FeatureCollection', features });
const line = (id, coords, props = {}) => ({
  type: 'Feature', id,
  geometry: { type: 'LineString', coordinates: coords },
  properties: { level: 'L1F', zone: 'a', kind: 'spine', ...props },
});
const point = (id, c, props = {}) => ({
  type: 'Feature', id, geometry: { type: 'Point', coordinates: c },
  properties: { level: 'L1F', zone: 'a', category: 'gate', ...props },
});

console.log('\n模型自测\n' + '─'.repeat(66));
setLevelOrder(MANIFEST.levels);

/* ══════════════ 1. 节点合并容差（回归：差 0.1 米的线头必须合并） ══════════════ */
console.log('\n1. 节点合并容差');

{
  // 两条线端点差 0.1 米 —— 人眼看着是接上的
  const paths = normalizeFeatures(fc([
    line('p1', [[0, 0], [10, 0]]),
    line('p2', [[10.1, 0], [20, 0]]),
  ]));
  const g = buildGraph(paths, { nodeMergeTolerance: 0.5 });
  // (0,0) (10,0) (20,0) —— (10.1,0) 并进了 (10,0)。不合并的话是 4 个。
  eq(g.stats.nodes, 3, '端点差 0.1m 的两条线合并成 3 个节点（不合并会是 4 个）');
  eq(g.stats.edges, 2, '两条线各贡献一条边');
  eq(g.components?.length ?? 1, 1, '合并后是一个连通块');

  // 差 2 米就不该合并 —— 那是真的没接上
  const paths2 = normalizeFeatures(fc([
    line('q1', [[0, 0], [10, 0]]),
    line('q2', [[12, 0], [20, 0]]),
  ]));
  const g2 = buildGraph(paths2, { nodeMergeTolerance: 0.5 });
  eq(g2.stats.nodes, 4, '端点差 2m 的两条线不合并（4 个节点）');
}

{
  // ★ 不同楼层的相同坐标绝不能合并
  const paths = normalizeFeatures(fc([
    line('r1', [[0, 0], [10, 0]], { level: 'L1F' }),
    line('r2', [[0, 0], [10, 0]], { level: 'L2F' }),
  ]));
  const g = buildGraph(paths, { nodeMergeTolerance: 0.5 });
  eq(g.stats.nodes, 4, '两层坐标完全相同的线不合并（楼层是节点身份的一部分）');
}

/* ══════════════ 2. walkSpeed（回归：传对象不能静默变 NaN） ══════════════ */
console.log('\n2. 步行速度');

{
  const net = buildNetwork({
    manifest: MANIFEST,
    paths: normalizeFeatures(fc([line('p1', [[0, 0], [100, 0]])])),
    facilities: normalizeFeatures(fc([point('f1', [0, 0]), point('f2', [100, 0])])),
    connectors: normalizeFeatures(fc([])),
  }, { areaAttachTolerance: 1, poiPathTolerance: 5, nodeMergeTolerance: 0.5 });

  // manifest.timeModel.walkSpeed 是一张表（m/s），旧代码直接当数字用 → NaN
  const routing = buildRoutingGraph(net, { walkSpeed: { default: 1.25, withLuggage: 1 } });
  const e = routing.adj.get([...routing.adj.keys()][0])[0];
  ok(Number.isFinite(e.minutes), '传对象（manifest 里那张表）也能算出有限的时间', `minutes=${e.minutes}`);
  // 1.25 m/s = 75 m/min，100 米 ≈ 1.333 分钟
  ok(Math.abs(e.minutes - 100 / 75) < 1e-6, '取值正确：用 default × 60 换算成米/分钟', `minutes=${e.minutes}`);

  throws(() => buildRoutingGraph(net, { walkSpeed: 0 }), 'walkSpeed = 0 直接抛错，不留 NaN');
  throws(() => buildRoutingGraph(net, { walkSpeed: 'fast' }), 'walkSpeed 传字符串直接抛错');
}

/* ══════════════ 3. 分步：每个折点一步 ══════════════ */
console.log('\n3. 分步规则');

{
  const net = buildNetwork({
    manifest: MANIFEST,
    // 一条折线，3 个折点 → 2 段 → 2 步
    paths: normalizeFeatures(fc([line('p1', [[0, 0], [10, 0], [10, 10], [20, 10]], { name: '中央通道' })])),
    facilities: normalizeFeatures(fc([point('f1', [0, 0]), point('f2', [20, 10])])),
    connectors: normalizeFeatures(fc([])),
  }, { areaAttachTolerance: 1, poiPathTolerance: 5, nodeMergeTolerance: 0.5 });

  const net2 = { ...net, manifest: MANIFEST };
  const r = planRoute(net2, 'f1', 'f2', { walkSpeed: 75 });
  ok(r.ok, '路线算得出来', r.error);
  eq(r.steps.length, 3, '4 个顶点的折线 = 3 步（每段一步）');
  ok(r.steps.every((s) => s.kind === 'walk'), '全是步行段');
  eq(r.steps[0].instruction.includes('中央通道'), true, '指令里带通行线的名字');
  eq(Math.round(r.totalMeters), 30, '总长 10+10+10 = 30 米');
}

/* ══════════════ 4. 转向判断 ══════════════ */
console.log('\n4. 转向');

eq(turnBetween(null, 90), 'start', '第一步是「出发」');
eq(turnBetween(0, 0), 'straight', '同向 = 直行');
eq(turnBetween(0, 90), 'right', '方位角增大 = 右转（x 东 y 北，顺时针）');
eq(turnBetween(0, -90), 'left', '方位角减小 = 左转');
eq(turnBetween(0, 180), 'back', '反向 = 掉头');
eq(turnBetween(0, 10), 'straight', '偏 10° 仍算直行（阈值 20°）');

/* ══════════════ 5. 说人话的格式化 ══════════════ */
console.log('\n5. 格式化');

eq(fmtMinutes(14 / 75), '约 10 秒', '14 米 ≈ 10 秒，不强行凑成「1 分钟」');
eq(fmtMinutes(3.2), '约 3 分钟', '3.2 分钟 → 约 3 分钟');
eq(fmtMeters(8.4), '8 米', '短距离给米');
eq(fmtMeters(1234), '1.2 公里', '长距离给公里');

/* ══════════════ 6. 不连通时要说清是两坨 ══════════════ */
console.log('\n6. 不连通的诊断');

{
  const net = buildNetwork({
    manifest: MANIFEST,
    paths: normalizeFeatures(fc([
      line('p1', [[0, 0], [10, 0]]),
      line('p2', [[100, 0], [110, 0]]),      // 离得很远
    ])),
    facilities: normalizeFeatures(fc([point('f1', [0, 0]), point('f2', [100, 0])])),
    connectors: normalizeFeatures(fc([])),
  }, { areaAttachTolerance: 1, poiPathTolerance: 5, nodeMergeTolerance: 0.5 });

  const r = planRoute({ ...net, manifest: MANIFEST }, 'f1', 'f2', { walkSpeed: 75 });
  eq(r.ok, false, '走不通');
  ok(r.debug != null, '失败时附带诊断数据（让用户能去修）');
  eq(r.debug.sameComponent, false, '诊断指出两端不在同一个连通分量');
}

/* ══════════════ 7. 搜索索引 ══════════════ */
console.log('\n7. 搜索索引');

eq(normalizeTerm('  ＣＡ  '), 'ca', '归一化：小写 + 去空白 + 全角转半角');

{
  const rec = searchRecord(MANIFEST, {
    id: 'c1',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { level: 'L1F', category: 'checkin', name: '值机柜台 A01', fields: { counterLetter: 'A', airlineCode: 'CA' } },
  });
  eq(rec.missingRequired.length, 0, '必填字段都填了 → 没有缺失');
  ok(rec.text.includes('ca'), '字段值进了检索文本');
  ok(rec.text.includes('值机柜台 a01'), '名字进了检索文本');

  const rec2 = searchRecord(MANIFEST, {
    id: 'c2',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { level: 'L1F', category: 'checkin', name: '值机柜台 B01', fields: { counterLetter: 'B' } },
  });
  eq(rec2.missingRequired.length, 1, '缺航司代码 → 报 1 个必填缺失');
  eq(rec2.missingRequired[0], 'airlineCode', '缺的正是 airlineCode');

  const idx = buildSearchIndex(MANIFEST, [
    { id: 's1', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { level: 'L1F', category: 'shop', name: '星巴克', fields: { brand: '星巴克' } } },
  ]);
  eq(idx.byTerm.has('星巴克'), true, '反向索引里能按词查到设施');
  eq(idx.stats.missingRequired, 0, '统计：没有缺必填的');
}

/* ══════════════ 结果 ══════════════ */
console.log('\n' + '─'.repeat(66));
if (fail) { console.log(`  ✗ 模型自测未通过　${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`  ✓ 模型自测通过　${pass}/${pass}\n`);
