/**
 * 验证跨层设施：三层各一个点，坐标相同，共享 verticalGroup。
 *
 * 关键断言：拿掉跨层边之后，各层路网必须是互不相通的孤岛；
 * 加上之后才连通。这才证明「跨层设施」真的在图上起作用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNetwork, setLevelOrder, normalizeFeatures } from './lib/graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return d; } };
const empty = () => ({ type: 'FeatureCollection', features: [] });

const manifest = rj('data/source/manifest.json');
setLevelOrder(manifest.levels);

const verticalSpecs = Object.fromEntries(Object.entries(manifest.facilityCategories)
  .filter(([k, v]) => !k.startsWith('_') && v?.vertical).map(([k, v]) => [k, v.vertical]));

const ELEV = [20, 55];
const mkElev = (lv, id) => ({
  type: 'Feature', id,
  geometry: { type: 'Point', coordinates: [ELEV[0], ELEV[1]] },
  properties: { level: lv, zone: 'airside_domestic', category: 'elevator', name: '电梯 1', verticalGroup: 'vg-elev-01', verticalLevels: ['L3F', 'L4F', 'L2F'] },
});
const mkPath = (lv, id, coords) => ({
  type: 'Feature', id,
  geometry: { type: 'LineString', coordinates: coords },
  properties: { level: lv, zone: 'airside_domestic', kind: 'branch', name: id },
});

// 三层各有一条通行线，每条都正好经过本层的电梯口
const FACILITIES = [mkElev('L3F', 'fac-elev-3f-01'), mkElev('L4F', 'fac-elev-4f-01'), mkElev('L2F', 'fac-elev-2f-01')];
const PATHS = [
  mkPath('L3F', 'path-3f-a', [[0, 55], [20, 55]]),
  mkPath('L4F', 'path-4f-a', [[0, 55], [20, 55]]),
  mkPath('L2F', 'path-2f-a', [[0, 55], [20, 55]]),
];

// ★ buildNetwork 要的是【规范化后】的输入（.point / .coords / .props），
//   不是原始 GeoJSON Feature。直接传 Feature 的话什么都读不到，
//   表现成「所有统计都是 0」—— 很难一眼看出是输入形状错了。
const N = (feats) => normalizeFeatures({ type: 'FeatureCollection', features: feats });

const opts = {
  areaAttachTolerance: 1, poiPathTolerance: 5, connectorTolerance: 0.5,
  verticalGroupTolerance: 0.05, verticalSpecs,
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('\n跨层设施');

const net = buildNetwork({ regions: [], paths: N(PATHS), facilities: N(FACILITIES), connectors: [] }, opts);

const vlinks = net.links.filter((l) => l.kind === 'vertical');
ok(net.verticalGroups.size === 1, `应识别出 1 个 verticalGroup，实际 ${net.verticalGroups.size}`);
ok(vlinks.length === 3, `3 个成员两两相连 = 3 条跨层边，实际 ${vlinks.length}`);
ok(net.verticalIssues.length === 0, `不该有问题，实际 ${JSON.stringify(net.verticalIssues)}`);

// 三条边跨的层数：L3F↔L4F(1) L3F↔L2F(1) L4F↔L2F(2)
const spans = vlinks.map((l) => l.minutes).sort((a, b) => a - b);
ok(spans[0] > 0, `跨层边要有耗时，实际 ${JSON.stringify(spans)}`);

// ★ 决定性检验：拿掉跨层边，三层必须互不相通
const noVert = buildNetwork({
  regions: [], paths: N(PATHS),
  facilities: N(FACILITIES.map((f) => ({ ...f, properties: { ...f.properties, verticalGroup: null } }))),
  connectors: [],
}, opts);
ok(noVert.components.length === 3,
  `★ 拿掉 verticalGroup 后，三层路网必须是 3 座孤岛，实际 ${noVert.components.length} 个分量`);
ok(net.components.length === 1,
  `★ 有跨层设施时应合并成 1 个分量，实际 ${net.components.length}`);

// 坐标不一致必须被抓到
const bad = buildNetwork({
  regions: [], paths: N(PATHS),
  facilities: N(FACILITIES.map((f, i) => (i === 1 ? { ...f, geometry: { type: 'Point', coordinates: [20.5, 55] } } : f))),
  connectors: [],
}, opts);
const posIssue = bad.verticalIssues.find((i) => i.reason === 'POSITION_MISMATCH');
ok(!!posIssue, '★ 某层成员偏了 0.5m 必须报 POSITION_MISMATCH');
ok(posIssue && posIssue.level === 'L4F', `应指出是哪一层偏了，实际 ${posIssue?.level}`);
ok(posIssue && Math.abs(posIssue.dist - 0.5) < 1e-6, `应算出偏移量，实际 ${posIssue?.dist}`);

// 声明了楼层却没有成员
const missing = buildNetwork({ regions: [], paths: N(PATHS), facilities: N(FACILITIES.slice(0, 2)), connectors: [] }, opts);
ok(missing.verticalIssues.some((i) => i.reason === 'MISSING_MEMBER'), '★ 声明连通 L2F 却没有成员，必须报 MISSING_MEMBER');

// 同一层两个成员
const dup = buildNetwork({
  regions: [], paths: N(PATHS),
  facilities: N([...FACILITIES, mkElev('L3F', 'fac-elev-3f-02')]), connectors: [],
}, opts);
ok(dup.verticalIssues.some((i) => i.reason === 'DUPLICATE_LEVEL'), '★ 同一层两个成员必须报 DUPLICATE_LEVEL');

// 电梯口没有通行线经过 → 该层成员接不上
const noSpur = buildNetwork({
  regions: [],
  paths: N(PATHS.map((p) => (p.properties.level === 'L4F' ? mkPath('L4F', 'path-4f-a', [[0, 100], [40, 100]]) : p))),
  facilities: N(FACILITIES), connectors: [],
}, opts);
ok(noSpur.components.length === 2,
  `★ L4F 的通行线不经过电梯口 → 那一层应该接不上（2 个分量），实际 ${noSpur.components.length}`);

console.log(`\n  ${fail ? '✗' : '✓'} 通过 ${pass}/${pass + fail}\n`);
process.exit(fail ? 1 : 0);
