/**
 * 批量缝合断口：把端点精确吸到它本该接上的那条线上。
 *
 * 保守原则：
 *   · 只动【端点】，不碰中间折点
 *   · 只处理 0.55m ~ 3m 的缺口（≤0.5m 的建图时已自动合并；>3m 是本来就没画到一起）
 *   · 只缝合【不在同一连通分量】的两条线（已经连上的不动）
 *   · 一个端点只缝一次（取最近的）
 *   · 默认先出报告，加 --apply 才写盘
 *
 * 用法： node tools/stitch-gaps.mjs            （只看报告）
 *        node tools/stitch-gaps.mjs --apply    （真的改）
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, normalizeFeatures } from './lib/graph.mjs';

const APPLY = process.argv.includes('--apply');
const SRC = 'data/source';
const rj = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));

const pathsFC = rj('paths.geojson');
const feats = pathsFC.features.filter((f) => f.geometry?.type === 'LineString' && f.geometry.coordinates?.length >= 2);

/* 按层分组算 —— 不同层之间不该缝合 */
const byLevel = new Map();
for (const f of feats) {
  const lv = f.properties?.level ?? '?';
  if (!byLevel.has(lv)) byLevel.set(lv, []);
  byLevel.get(lv).push(f);
}

const segDist = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)), foot: [a[0] + t * vx, a[1] + t * vy] };
};

/*
 * ★ 必须迭代。
 *
 *   有些断口是【互相】的：A 的端点缝到 B 上，B 的端点缝到 A 上 ——
 *   一次算完再统一应用，两者只是互换位置，距离一点没变，还是断的。
 *   实测就有这种（0080 ↔ 0081 互相缝到对方的原位）。
 *
 *   每轮都基于【当前】坐标重算，所以第二轮它们就真的碰上了。
 *   上限 5 轮：正常的缺口一两轮就收敛，跑满说明数据有别的毛病，
 *   不该无限循环下去。
 */
let totalGaps = 0, totalFixed = 0;
const report = [];
const MAX_PASS = 5;

for (const [lv, list] of byLevel) {
  for (let pass = 0; pass < MAX_PASS; pass++) {
    const g = buildGraph(list.map((f) => ({
      id: f.id, level: f.properties.level, props: f.properties, coords: f.geometry.coordinates,
    })));
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const n of g.nodes) parent.set(n.id, n.id);
    for (const e of g.edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
    const compOf = new Map();
    for (const n of g.nodes) for (const p of (n.paths ?? [])) compOf.set(p, find(n.id));

    const segs = [];
    for (const f of list) {
      const c = f.geometry.coordinates;
      for (let i = 0; i + 1 < c.length; i++) segs.push({ id: f.id, a: c[i], b: c[i + 1] });
    }

    const moves = [];
    for (const f of list) {
      const c = f.geometry.coordinates;
      for (const ei of [0, c.length - 1]) {
        const p = c[ei];
        let best = null;
        for (const s of segs) {
          if (s.id === f.id) continue;
          const r = segDist(p, s.a, s.b);
          if (!best || r.d < best.d) best = { d: r.d, foot: r.foot, other: s.id };
        }
        if (!best || best.d <= 0.55 || best.d > 3) continue;
        if (compOf.get(f.id) === compOf.get(best.other)) continue;   // 已经连上了
        moves.push({ f, ei, ...best });
      }
    }

    if (!moves.length) break;
    if (pass === 0) totalGaps = moves.length;
    for (const m of moves) {
      if (pass === 0) {
        report.push({
          lv, path: m.f.id, end: m.ei === 0 ? '起点' : '终点',
          from: m.f.geometry.coordinates[m.ei].map((n) => +n.toFixed(2)),
          to: m.foot.map((n) => +n.toFixed(2)), d: +m.d.toFixed(2), onto: m.other, pass: pass + 1,
        });
      }
      if (APPLY) {
        m.f.geometry.coordinates[m.ei] = [+m.foot[0].toFixed(2), +m.foot[1].toFixed(2)];
        totalFixed++;
      }
    }
    if (!APPLY) break;      // 预演只跑一轮（迭代结果只有真改才看得到）
  }
}

report.sort((a, b) => b.d - a.d);
console.log(`\n  发现断口 ${totalGaps} 处${APPLY ? `，已缝合 ${totalFixed} 处` : '（未改动）'}\n`);
console.log('  层    通行线              端     从                    到                    差');
console.log('  ' + '─'.repeat(86));
for (const r of report.slice(0, 40)) {
  console.log(`  ${r.lv.padEnd(5)} ${r.path.padEnd(20)} ${r.end}  `
    + `(${String(r.from[0]).padStart(7)},${String(r.from[1]).padStart(7)})  `
    + `(${String(r.to[0]).padStart(7)},${String(r.to[1]).padStart(7)})  ${r.d.toFixed(2)}m`);
}
if (report.length > 40) console.log(`  …… 还有 ${report.length - 40} 处`);

if (APPLY) {
  fs.writeFileSync(path.join(SRC, 'paths.geojson'), JSON.stringify(pathsFC, null, 2) + '\n', 'utf8');
  console.log('\n  ✓ 已写入 data/source/paths.geojson');
  console.log('  ⚠ 编辑器如果开着，刷新页面再继续编辑（否则内存里还是旧的）');
} else {
  console.log('\n  这是预演。确认无误后加 --apply 真改：');
  console.log('    node tools/stitch-gaps.mjs --apply');
}
console.log('');
