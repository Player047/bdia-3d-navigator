/**
 * 2D 视图：俯视平面图 + 路线。
 *
 * 和编辑器的渲染器分开写：这里只负责「给人看」，不需要编辑手柄、吸附、
 * 命中测试那些东西，所以代码短得多，也更容易为浏览和导航两种场景调优。
 */

import { MAP as C } from './palette.mjs';

/*
 * ★ 2D 的颜色不再是写死的常量，而是【每帧读调色板】。
 *   下面所有 `C.xxx` 都指向 palette.mjs 里那张会随主题切换的表。
 *   所以 draw2d 里不能把 C.xxx 缓存到局部变量再跨帧用 —— 会拿到旧主题的值。
 */

/** 创建视图（本地米 ↔ 屏幕像素）。 */
export function createView() {
  return { scale: 1, ox: 0, oy: 0 };
}
export const toScreen = (p, v) => [v.ox + p[0] * v.scale, v.oy - p[1] * v.scale];
export const toLocal = (s, v) => [(s[0] - v.ox) / v.scale, (v.oy - s[1]) / v.scale];

/** 把视图对准一组点。 */
export function fitView(v, pts, w, h, pad = 48) {
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0));
  v.scale = Math.max(0.02, Math.min(40, s));
  v.ox = w / 2 - ((x0 + x1) / 2) * v.scale;
  v.oy = h / 2 + ((y0 + y1) / 2) * v.scale;
}

/** 平滑把视图移到某个点（导航跟随时用）。 */
export function centerOn(v, p, w, h, scale) {
  if (scale) v.scale = scale;
  v.ox = w / 2 - p[0] * v.scale;
  v.oy = h / 2 + p[1] * v.scale;
}

function poly(ctx, rings, v) {
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((c, i) => {
      const s = toScreen(c, v);
      i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]);
    });
    ctx.closePath();
  }
}

/**
 * 画一帧。
 *
 * @param d { level, regions, facilities, paths, markers }
 * @param opt { w, h, route, stepIndex, here, showAllLevels }
 */
export function draw2d(ctx, d, v, opt) {
  const { w, h } = opt;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  /* ---- 区域（楼板）---- */
  for (const r of d.regions ?? []) {
    poly(ctx, r.polygons, v);
    // 可通行面用楼板色；别的种类（候机区/走廊/指廊…）只是语义标签，虚线圈一下即可
    const isWalk = r.props?.kind === 'walkable';
    ctx.fillStyle = isWalk ? C.slab : 'rgba(90,120,140,.08)';
    ctx.fill('evenodd');
    ctx.strokeStyle = isWalk ? C.slabEdge : 'rgba(120,150,170,.30)';
    ctx.lineWidth = 1;
    if (!isWalk) ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ---- 障碍物：挑空挖洞 + 封闭区域实体 ---- */
  for (const o of d.obstacles ?? []) {
    if (!o.polygons?.length) continue;
    const isVoid = o.props?.kind === 'void';
    poly(ctx, o.polygons, v);
    if (isVoid) {
      /*
       * ★ 挑空用「背景色重涂」而不是 evenodd —— 因为楼板可能是多个区域拼的，
       *   逐个 evenodd 挖不准。重涂背景色简单，而且结果和 3D 一致。
       */
      ctx.fillStyle = C.bg;
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(120,150,170,.38)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = o.props?.kind === 'column' ? 'rgba(120,100,80,.45)' : 'rgba(90,95,105,.42)';
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(150,155,165,.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /* ---- 通行线 ---- */
  ctx.lineCap = 'round';
  for (const p of d.paths ?? []) {
    const pts = p.coords.map((c) => toScreen(c, v));
    ctx.beginPath();
    pts.forEach((s, i) => (i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1])));
    ctx.strokeStyle = p.props?.kind === 'spine' ? C.pathMain : C.path;
    ctx.globalAlpha = p.props?.kind === 'spine' ? 0.5 : 0.32;
    ctx.lineWidth = p.props?.kind === 'spine' ? 4 : 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ---- 面状设施 ---- */
  /* ★ 当前步附近的设施（app.js 算好传进来），2D 里也涂暖橙 */
  const nearby = opt.nearby ?? null;
  for (const f of d.facilities ?? []) {
    if (!f.polygons?.length) continue;
    const isSel = opt.selected && f.id === opt.selected;
    const isNear = !!(nearby && nearby.has(f.id));
    poly(ctx, f.polygons, v);
    // 选中的青色优先 —— 那是用户的主动操作，比"附近"更需要被看见
    /*
     * ★ 附近的面状设施用【半透明】填充，不是实心。
     *   实心涂色看着像"这个房间被选中了"，而且把底下的通行线全盖住。
     *   附近标记应该像一层提示色。
     *   描边仍然用实色 —— 轮廓清楚才有"这是个范围"的感觉。
     */
    ctx.fillStyle = isSel ? 'rgba(111,227,245,.28)'
      : isNear ? C.nearbyFill
        : (f.props?.category === 'security' ? 'rgba(217,87,87,.22)' : C.room);
    ctx.fill('evenodd');
    /*
     * ★ 选中的面状设施要高亮 —— 它不走 marker 那条路，
     *   只在 marker 上加光环保留的话，点中一个店铺/登机口区域是看不出变化的。
     */
    ctx.strokeStyle = isSel ? '#6FE3F5'
      : isNear ? C.nearby
        : (f.props?.category === 'security' ? C.security : C.roomEdge);
    ctx.lineWidth = isSel ? 3 : 1.4;
    ctx.stroke();
    if (isSel) {
      // 外圈再描一层淡光，远处也能一眼看到
      ctx.strokeStyle = 'rgba(111,227,245,.35)';
      ctx.lineWidth = 7;
      ctx.stroke();
    }
  }

  /* ---- 路线 ---- */
  const { route, stepIndex = 0 } = opt;
  if (route?.steps?.length) {
    ctx.lineCap = 'round';
    // 已走过的部分画淡
    for (let i = 0; i < route.steps.length; i++) {
      const s = route.steps[i];
      if (s.level !== d.level && !(s.crossesLevels ?? []).includes(d.level)) continue;
      const a = toScreen(s.from, v), b = toScreen(s.to, v);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = '#15191c'; ctx.lineWidth = 9; ctx.stroke();
      ctx.strokeStyle = i < stepIndex ? C.routeDone : C.route;
      ctx.lineWidth = i === stepIndex ? 6 : 4;
      ctx.stroke();
    }
    // 当前步的起点画个圈
    const cur = route.steps[stepIndex];
    if (cur && (cur.level === d.level || (cur.crossesLevels ?? []).includes(d.level))) {
      const a = toScreen(cur.from, v);
      ctx.beginPath(); ctx.arc(a[0], a[1], 7, 0, Math.PI * 2);
      ctx.fillStyle = C.here; ctx.fill();
      ctx.strokeStyle = '#0e0e0e'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  /* ---- 点状设施 ---- */
  const showLabel = v.scale > 0.35;
  ctx.font = '11px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (const m of d.facilities ?? []) {
    if (!m.point) continue;
    const s = toScreen(m.point, v);
    const cat = m.props?.category;
    const col = cat === 'security' ? C.security
      : cat === 'gate' ? C.gate
        : cat === 'commerce' ? C.commerce : '#9aa4ab';
    const isSel = opt.selected && m.id === opt.selected;
    const isNear = !!(nearby && nearby.has(m.id));
    /*
     * ★ 染色要加在【真正 fill 的那一句】上。
     *   我先在上面加了一句 `if (isNear) ctx.fillStyle = C.nearby;` ——
     *   但下面这行又用 isSel/col 重新赋值，把它整个覆盖掉了。
     *   同一个 fillStyle 被赋值两次，后面那次赢。
     */
    /*
     * ★ 选中的设施必须一眼看得出来 —— 和 3D 用同一套语言：
     *   外圈青色光环 + 本体放大 + 名字一定显示（不管缩放到多少）。
     */
    if (isSel) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], m.props?.verticalGroup ? 15 : 13, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(111,227,245,.95)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s[0], s[1], 20, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(111,227,245,.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(s[0], s[1], isSel ? (m.props?.verticalGroup ? 9 : 7) : (m.props?.verticalGroup ? 6 : 4), 0, Math.PI * 2);
    // 选中的青色优先：那是用户的主动操作，比"附近"更需要被看见
    ctx.fillStyle = isSel ? '#6FE3F5' : (isNear ? C.nearby : col);
    ctx.fill();
    ctx.strokeStyle = '#0e0e0e'; ctx.lineWidth = 1.5; ctx.stroke();
    if (m.props?.verticalGroup) {
      // 跨层设施画个上下箭头
      ctx.strokeStyle = '#C08BFF'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s[0], s[1] - 9); ctx.lineTo(s[0], s[1] + 9);
      ctx.stroke();
    }
    /*
     * ★ 跨层设施（电梯/扶梯/楼梯）不画名字。
     *   一层里可能几十个，名字一画上去整张图就被标签糊满了 ——
     *   实测效果是「什么也看不清」。它们的位置和符号已经足够说明问题。
     */
    /*
     * ★ 附近的设施【一定标名字】。
     *   只涂个橙色的话，旅客看到"旁边有个橙点"还是不知道那是什么 ——
     *   而"这一步旁边有什么"正是这个功能存在的全部理由。
     *   跨层设施仍然不标（几十个电梯名字会把图糊满）。
     */
    const alwaysLabel = isNear && !m.props?.verticalGroup;
    if (isSel || alwaysLabel || (showLabel && m.props?.name && !m.props?.verticalGroup)) {
      if (alwaysLabel) {
        // 橙色标签 + 深色描边，和 3D 一致
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(10,12,14,.85)';
        ctx.strokeText(m.props.name, s[0] + 8, s[1] - 8);
        ctx.fillStyle = C.nearby;
      } else {
        ctx.fillStyle = 'rgba(236,236,236,.82)';
      }
      ctx.fillText(m.props.name, s[0] + 8, s[1] - 8);
    }
  }

  /* ---- 起终点 ---- */
  for (const [f, col, tag] of [[opt.from, '#5aa87a', '起'], [opt.to, '#d95757', '终']]) {
    // ★ f.polygons 是环的数组：f.polygons[0] 才是一个环
    const p = f?.point ?? (f?.polygons?.length ? centroid(f.polygons[0]) : null);
    if (!p) continue;
    const s = toScreen(p, v);
    ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = '#0e0e0e'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#0e0e0e';
    ctx.font = 'bold 11px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(tag, s[0], s[1] + 0.5);
    ctx.textAlign = 'left';
    ctx.font = '11px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
  }

  /* ---- 比例尺 ---- */
  const targetPx = 120;
  const rawM = targetPx / v.scale;
  const nice = [5, 10, 20, 50, 100, 200, 500, 1000].find((n) => n >= rawM) ?? 1000;
  const barPx = nice * v.scale;
  const bx = w - barPx - 24, by = h - 22;
  ctx.strokeStyle = 'rgba(236,236,236,.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.lineTo(bx + barPx, by - 5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(236,236,236,.7)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + barPx / 2, by - 12);
  ctx.textAlign = 'left';
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const c of ring) { x += c[0]; y += c[1]; }
  return [x / ring.length, y / ring.length];
}
