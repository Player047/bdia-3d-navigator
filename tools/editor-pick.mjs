/**
 * 验证编辑器里「放跨层设施」的完整流程：
 *   选类别（电梯）→ 点地图 → 弹出选楼层 → 勾几层 → 创建
 *   → 每一层【同一个坐标】上各得一个点状设施，共用 verticalGroup
 *
 * 这是用户直接操作的那条路径，必须端到端走一遍。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './lib/domshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'source');
const rj = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const empty = () => ({ type: 'FeatureCollection', features: [] });

const DATA = {
  manifest: rj(path.join(SRC, 'manifest.json')), anchors: null,
  calibration: { version: 2, levels: {} },
  connectors: rj(path.join(SRC, 'connectors.geojson'), empty()),
  facilities: rj(path.join(SRC, 'facilities.geojson'), empty()),
  obstacles: rj(path.join(SRC, 'obstacles.geojson'), empty()),
  paths: rj(path.join(SRC, 'paths.geojson'), empty()),
  levels: { L3F: { regions: rj(path.join(SRC, 'L3F', 'regions.geojson'), empty()) } },
};

const dom = installDom({
  dpr: 1,
  fetchImpl: async (url) => {
    const u = String(url);
    const body = u.includes('/api/data') ? DATA : u.includes('/api/plans') ? { files: [] } : { ok: true, issues: [], counts: {} };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  },
});

await import('../editor/app.js');
const app = globalThis.__bdiaTestHooks;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}　期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

if (!app) { console.log('  ✗ 编辑器没启动'); process.exit(1); }
const ed = app.ed, view = app.view;

console.log('\n放跨层设施（编辑器端到端）');

ed.currentLevel = 'L3F';
view.scale = 4; view.ox = 700; view.oy = 500;

const S = (p) => [view.ox + p[0] * view.scale, view.oy - p[1] * view.scale];
const clickAt = (p) => {
  const s = S(p);
  dom.fireCanvas('pointerdown', { clientX: s[0], clientY: s[1] });
  dom.fireCanvas('pointerup', { clientX: s[0], clientY: s[1] });
};

// ① 普通点状设施不该弹对话框
app.setMode('facPoint');
ed.currentCategory = 'water';
const n0 = ed.facilities.features.length;
clickAt([-20, -20]);
ok(ed.facilities.features.length === n0 + 1, '普通点状设施应直接放下');
ok(!dom.getById('modal')?.classList?.contains?.('on'), '普通点状设施不该弹对话框');

// ② 选电梯类别 → 点地图 → 应弹选楼层对话框
ed.currentCategory = 'elevator';
const n1 = ed.facilities.features.length;
clickAt([15, 40]);
ok(ed.facilities.features.length === n1, '跨层设施在确认之前不该先建东西');
const modal = dom.getById('modal');
ok(modal?.classList?.contains?.('on'), '★ 选电梯后点地图应弹出选楼层对话框');

// ★ 内容是放进 #modalBox 的，不是 #modal
const box = dom.getById('modalBox');
const boxes = box.allElements().filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
ok(boxes.length >= 6, `对话框里应列出全部楼层，实际 ${boxes.length} 个勾选框`);

// ③ 只勾一层 → 拒绝
const okBtn = dom.getById('vgOk');
const checked = boxes.filter((b) => b.checked);
ok(checked.length === 1, `打开时应只勾选当前层（L3F），实际 ${checked.length} 层`);
okBtn.onclick();
ok(ed.facilities.features.length === n1, '只勾一层不该创建任何东西');

// ④ 勾三层 → 创建
const rows = box.allElements().filter((n) => n.tagName === 'LABEL');
const want = ['L3F', 'L4F', 'L2F'];
for (const row of rows) {
  const lv = want.find((w) => row.allText.includes(w));
  const cb = row.allElements().find((n) => n.tagName === 'INPUT');
  if (cb) cb.checked = !!lv;
}
okBtn.onclick();

const added = ed.facilities.features.slice(n1);
eq(added.length, 3, '★ 勾三层应创建 3 个点状设施');
eq(added.map((f) => f.properties.level).sort(), ['L2F', 'L3F', 'L4F'], '应分布在三个楼层上');
eq([...new Set(added.map((f) => f.properties.verticalGroup))].length, 1, '★ 三个点必须共用同一个 verticalGroup');
eq([...new Set(added.map((f) => f.properties.category))], ['elevator'], '类别都应是 elevator');
eq([...new Set(added.map((f) => JSON.stringify(f.geometry.coordinates)))].length, 1,
  '★★ 三个点的坐标必须完全相同 —— 这是整个模型里唯一「跨楼层同一个位置」的地方');
eq(added[0].properties.verticalLevels.slice().sort(), ['L2F', 'L3F', 'L4F'], '应记录声明连通的楼层');
ok(added.every((f) => f.id && ed.facilities.features.filter((x) => x.id === f.id).length === 1),
  '★ 三个成员必须有各自唯一的 id（nextId 靠扫描现有要素去重，逐个入列才不会撞 id）');

// ⑤ 对话框关闭
ok(!dom.getById('modal')?.classList?.contains?.('on'), '创建后对话框应关闭');

// ⑥ 再次创建应拿到新的 group id
const n2 = ed.facilities.features.length;
clickAt([25, 40]);
const rows2 = dom.getById('modalBox').allElements().filter((n) => n.tagName === 'LABEL');
for (const row of rows2) {
  const lv = ['L3F', 'L4F'].find((w) => row.allText.includes(w));
  const cb = row.allElements().find((n) => n.tagName === 'INPUT');
  if (cb) cb.checked = !!lv;
}
dom.getById('vgOk').onclick();
const added2 = ed.facilities.features.slice(n2);
eq(added2.length, 2, '第二次应创建 2 个');
ok(added2[0].properties.verticalGroup !== added[0].properties.verticalGroup,
  `★ 两批应是不同的 group：${added[0].properties.verticalGroup} vs ${added2[0].properties.verticalGroup}`);

console.log(`\n  ${fail ? '✗' : '✓'} 通过 ${pass}/${pass + fail}\n`);
process.exit(fail ? 1 : 0);
