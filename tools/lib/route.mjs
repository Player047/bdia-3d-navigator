/**
 * 寻路。
 *
 * 输入是 graph.mjs 编译出来的网络（通行线图 + 设施接入点 + 连接件边 + 跨层边），
 * 输出是一串【步骤】—— 每一步对应通行线上的一段直线。
 *
 * ★ 为什么「每个折点 = 一步」：
 *   buildGraph 已经在每个折点和交叉点切过刀了，所以图上的每条边本来就是一条直线段。
 *   直接拿边当步骤，天然就是「走到折点算一步」，不需要再做什么几何切分。
 *
 * 权重用【时间】而不是距离 —— 旅客关心的是「还要多久」，而且自动步道、
 * 扶梯、安检排队这些差别只有时间能体现。
 */

import * as G from './geo.mjs';

/* ------------------------------------------------------------ 建路由图 */

/**
 * 把编译好的网络转成邻接表。
 *
 * @param net   buildNetwork() 的结果
 * @param opts  { walkSpeed } 步行速度 m/min，默认 80（约 1.33 m/s）
 */
export function buildRoutingGraph(net, opts = {}) {
  let walkSpeed = opts.walkSpeed ?? 80;

  /*
   * ★ manifest.timeModel.walkSpeed 是一张表（m/s）：{default, withLuggage, wheelchair…}，
   *   不是一个数字。直接把它当数字用，speed 会变成 NaN，于是每条边的 minutes 都是 NaN，
   *   dijkstra 里所有 `nd < dist` 比较全为 false —— 表现是「两点之间不连通」，
   *   而路网其实是通的。这种错最难查：没有任何报错，只有一句误导人的提示。
   *   所以这里既做兼容，也做硬校验。
   */
  if (walkSpeed && typeof walkSpeed === 'object') walkSpeed = (walkSpeed.default ?? 1.25) * 60;
  if (!Number.isFinite(walkSpeed) || walkSpeed <= 0) {
    throw new Error(`walkSpeed 必须是正的有限数（米/分钟），收到 ${JSON.stringify(opts.walkSpeed)}`);
  }

  const adj = new Map();
  const add = (from, to, e) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, ...e });
  };

  for (const e of net.graph.edges) {
    const speed = walkSpeed * (e.speedFactor || 1);
    const minutes = e.weight / speed;
    if (!Number.isFinite(minutes)) {
      throw new Error(`通行线 ${e.pathId ?? '?'} 上有一段算不出时间（weight=${e.weight}, speedFactor=${e.speedFactor}）`);
    }
    const base = { minutes, meters: e.weight, kind: 'walk', level: e.level, zone: e.zone, pathId: e.pathId, accessible: e.accessible, id: `e:${e.a}>${e.b}` };
    add(e.a, e.b, base);
    if (e.bidirectional) add(e.b, e.a, { ...base, id: `e:${e.b}>${e.a}` });
  }

  for (const l of net.links ?? []) {
    // portal = 可穿过的面状设施（安检/边检/海关）；vertical = 跨层；boundary = 老的连接件边（正在淘汰）
    const kind = l.kind === 'vertical' ? 'vertical' : (l.kind === 'portal' ? 'portal' : 'boundary');
    const minutes = l.minutes ?? 1;
    const a = net.graph.nodes.find((n) => n.id === l.a);
    const b = net.graph.nodes.find((n) => n.id === l.b);
    const meters = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    const base = { minutes, meters, kind, linkId: l.id, facilityId: l.facilityId, category: l.category, id: `l:${l.id}` };
    add(l.a, l.b, base);
    // ★ 单向扶梯：只加 a → b，不加反向。反过来走不了。
    if (l.oneWay !== true) add(l.b, l.a, base);
  }

  return { adj, nodes: new Map(net.graph.nodes.map((n) => [n.id, n])), walkSpeed };
}

/** 设施 → 图上节点。设施必须先接入路网（net.attachments 里有 served）。 */
export function nodeForFacility(net, facilityId, tol = 0.6) {
  const att = net.attachments.get(facilityId);
  if (!att?.served) return null;
  let best = null;
  for (const n of net.graph.nodes) {
    if (att.level && n.level !== att.level) continue;
    const d = Math.hypot(n.x - att.routingPoint[0], n.y - att.routingPoint[1]);
    if (d <= tol && (!best || d < best.d)) best = { d, id: n.id };
  }
  return best ? best.id : null;
}

/* -------------------------------------------------------------- Dijkstra */

/**
 * 两个连通分量之间【最近的两个节点】。
 *
 * ★ 这是「不连通」这句话唯一有用的补充：差多远、在哪。
 *   实测遇到过一条 4.3 米的支线画到了主管线 1.07 米旁边 ——
 *   在这个缩放下看着就是连着的，不给坐标根本找不到。
 *
 * 只在算路失败时走一次，O(n·m) 可以接受。
 */
function nearestGapBetween(routing, nodeComp, ca, cb) {
  if (ca == null || cb == null || ca === cb) return null;
  const A = []; const B = [];
  for (const [id, c] of nodeComp) {
    const v = routing.nodes.get(id);
    if (!v) continue;
    if (c === ca) A.push(v);
    else if (c === cb) B.push(v);
  }
  let sameLevelBest = null;
  let anyBest = null;
  for (const va of A) {
    for (const vb of B) {
      const d = Math.hypot(va.x - vb.x, va.y - vb.y);
      if (!anyBest || d < anyBest.d) anyBest = { d, a: va, b: vb };
      if (va.level === vb.level && (!sameLevelBest || d < sameLevelBest.d)) {
        sameLevelBest = { d, a: va, b: vb };
      }
    }
  }
  /*
   * 优先报【同层】的最近点 —— 那才是"没接上"。
   * 跨层的最近点往往只是"两片隔着楼层"，报出来会把人引向错误的方向。
   */
  const best = sameLevelBest ?? anyBest;
  // 差太远就不是"没接上"，而是两片本来就没画到一起，报距离没意义
  return best && best.d <= 60 ? best : null;
}

/**
 * 最短时间路径。返回节点 id 序列 + 每条边。
 */
export function dijkstra(routing, startId, endId, opts = {}) {
  if (!startId || !endId) return null;
  if (startId === endId) return { nodeIds: [startId], edges: [], minutes: 0, meters: 0 };

  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const done = new Set();
  // 节点不多（几十到几千），用简单的线性取最小就够，不必上堆
  const queue = new Set([startId]);

  while (queue.size) {
    let cur = null, best = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < best) { best = d; cur = id; }
    }
    if (cur == null) break;
    queue.delete(cur);
    done.add(cur);
    if (cur === endId) break;

    for (const e of routing.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      if (opts.accessibleOnly && e.accessible === false) continue;
      /*
       * ★ 同区寻路不得借道安检 —— 公共区到公共区，不该穿过安检再出来。
       *   图是无向的，门在图上就是一条普通的连通边，所以这个约束做不到建图里，
       *   只能在寻路时禁掉。见 planRoute：起点终点同 zone 时 allowPortals = false。
       */
      /*
     * ★ 门禁设施：不只是"能不能穿"，而是"必须穿哪一个"。
     *
     *   allowPortals === false            → 一个门都不许穿（同区出行）
     *   allowedPortalCats 是 Set          → 【只】允许穿这些类别的门
     *   两者都没给                        → 全放行（老行为，兼容用）
     *
     *   为什么按类别限制：从公共区去国际隔离区，必须先安检再海关 ——
     *   只允许穿 {security, customs}，别的门（比如国内出口）在这条路上
     *   就不该open。光用"允许穿门"是拦不住绕路的。
     */
    if (e.kind === 'portal') {
      if (opts.allowPortals === false) continue;
      if (opts.allowedPortalCats && !opts.allowedPortalCats.has(e.category)) continue;
    }
      if (opts.maxMinutes != null && best + e.minutes > opts.maxMinutes) continue;
      const nd = best + e.minutes;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: cur, edge: e });
        queue.add(e.to);
      }
    }
  }

  if (!dist.has(endId)) return null;

  const nodeIds = [endId];
  const edges = [];
  let cur = endId;
  while (cur !== startId) {
    const p = prev.get(cur);
    if (!p) return null;
    edges.unshift(p.edge);
    nodeIds.unshift(p.from);
    cur = p.from;
  }
  return {
    nodeIds,
    edges,
    minutes: dist.get(endId),
    meters: edges.reduce((s, e) => s + (e.meters ?? 0), 0),
  };
}

/* ------------------------------------------------------------ 转向判断 */

/**
 * 相对于上一步的转向。本地坐标系里 x=东、y=北，方位角 atan2(东, 北)，
 * 所以方位角【增大】= 顺时针 = 右转。
 */
export function turnBetween(prevDir, dir) {
  if (prevDir == null) return 'start';
  const d = G.normalizeAngle(dir - prevDir);
  if (Math.abs(d) < 20) return 'straight';
  if (Math.abs(d) > 150) return 'back';
  return d > 0 ? 'right' : 'left';
}

const TURN_WORD = { left: '左转', right: '右转', straight: '继续直行', back: '掉头', start: '出发' };

/** 时间说人话：不到 1 分钟就报秒，别强行凑成「1 分钟」。 */
export function fmtMinutes(min) {
  if (!(min > 0)) return '不到 1 秒';
  if (min < 1) return `约 ${Math.max(5, Math.round((min * 60) / 5) * 5)} 秒`;
  return `约 ${Math.round(min)} 分钟`;
}

/** 距离说人话：短距离精确到米，长距离给公里。 */
export function fmtMeters(m) {
  if (m < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

/**
 * 通行线在指令里怎么念。
 *
 * ★ 通行线【不需要自己的名字】—— 它的称呼就是它的【种类】：
 *   走廊、主通道、指廊通道、支线…… 旅客听到「沿走廊向前 14 米」就够了。
 *   早先这里给没名字的线加了「无名」前缀，编辑器还会自动生成「走廊 12」
 *   这种编号名字，两者都是多余的：编号对旅客没有任何信息量，
 *   而种类名本来就已经说明了这条线是什么。
 *
 *   如果确实有人给某条线填了 name（比如「中央大道」），那就用它。
 */
export function pathLabel(net, pathId) {
  const p = net.pathsById?.get(pathId);
  if (!p) return '通道';
  const nm = p.props?.name;
  if (nm) return nm;
  return net.manifest?.pathKinds?.[p.props?.kind]?.name || '通道';
}

/* ---------------------------------------------------------- 切成步骤 */

/**
 * 把路径展开成「一步一段」的步骤序列。
 *
 * @param net      buildNetwork() 结果（用来查设施名、通行线名）
 * @param routing  buildRoutingGraph() 结果
 * @param route    dijkstra() 结果
 * @param ctx      { nameOf(facilityId) } 取名字
 */
export function routeToSteps(net, routing, route, ctx = {}) {
  const nodeOf = (id) => routing.nodes.get(id);
  const pathName = (pathId) => pathLabel(net, pathId);
  const catName = (c) => net.manifest?.facilityCategories?.[c]?.name ?? c;
  const connName = (id) => net.connectorsById?.get(id)?.props?.name || '连接件';

  const steps = [];
  let prevDir = null;

  for (let i = 0; i < route.edges.length; i++) {
    const e = route.edges[i];
    const a = nodeOf(route.nodeIds[i]);
    const b = nodeOf(route.nodeIds[i + 1]);
    if (!a || !b) continue;

    if (e.kind === 'vertical') {
      const lvA = a.level, lvB = b.level;
      // 一条跨层边上可能挂着多个层级关系（L3F 那侧只记了 L3F），用两端的 level 就够了
      const levels = lvA === lvB ? [lvA] : [lvA, lvB];
      steps.push({
        index: steps.length,
        kind: 'vertical',
        from: [a.x, a.y], to: [b.x, b.y],
        level: lvA, levels,
        crossesLevels: lvA !== lvB ? levels : null,
        distance: 0, minutes: e.minutes,
        icon: 'vertical',
        instruction: `乘${catName(e.category) || '垂直交通'}到 ${lvB}`,
        detail: fmtMinutes(e.minutes),
      });
      prevDir = null;   // 换了楼层，方向重新开始
      continue;
    }

    /*
     * ★ 门：可穿过的面状设施（安检 / 边检 / 海关）。
     *   这一步【不是沿某条通行线走】，而是从这个面里穿过去 ——
     *   只看通行线图，这里本来就是断的，是那个面把两段接上的。
     *   指令就是「通过三层安检区」这种，时间是 0（先跑通拓扑，耗时以后再说）。
     */
    if (e.kind === 'portal') {
      const f = net.facilitiesById?.get(e.facilityId);
      const nm = f?.props?.name || net.manifest?.facilityCategories?.[e.category]?.name || '门禁';
      steps.push({
        index: steps.length,
        kind: 'portal',
        from: [a.x, a.y], to: [b.x, b.y],
        level: a.level,
        levels: a.level === b.level ? [a.level] : [a.level, b.level],
        crossesLevels: a.level === b.level ? null : [a.level, b.level],
        distance: e.meters, minutes: e.minutes,
        facilityId: e.facilityId, category: e.category,
        icon: 'gate',
        instruction: `通过${nm}`,
        detail: `${catName(e.category)}　请准备好证件`,
      });
      prevDir = null;
      continue;
    }

    if (e.kind === 'boundary') {
      const c = net.connectorsById?.get(e.linkId);
      const from = c?.props?.from, to = c?.props?.to;
      const crossZone = from && to && from.zone !== to.zone;
      steps.push({
        index: steps.length,
        kind: 'boundary',
        from: [a.x, a.y], to: [b.x, b.y],
        level: a.level,
        levels: [a.level],
        crossesLevels: from && to && from.level !== to.level ? [from.level, to.level] : null,
        crossesZones: crossZone ? [from.zone, to.zone] : null,
        distance: e.meters, minutes: e.minutes,
        icon: 'gate',
        instruction: `通过${c?.props?.name || connName(e.linkId)}`,
        detail: `${crossZone ? `${from.zone} → ${to.zone}　` : ''}${fmtMinutes(e.minutes)}`,
      });
      prevDir = null;
      continue;
    }

    // 步行段：一段直线 = 一步
    const dir = G.bearingDeg([a.x, a.y], [b.x, b.y]);
    const turn = turnBetween(prevDir, dir);
    const nm = pathName(e.pathId);
    const m = e.meters;
    let text;
    if (turn === 'start') text = `沿「${nm}」出发，向前 ${fmtMeters(m)}`;
    else if (turn === 'straight') text = `沿「${nm}」继续向前 ${fmtMeters(m)}`;
    else text = `${TURN_WORD[turn]}，沿「${nm}」走 ${fmtMeters(m)}`;

    steps.push({
      index: steps.length,
      kind: 'walk',
      from: [a.x, a.y], to: [b.x, b.y],
      level: a.level, levels: [a.level],
      crossesLevels: null,
      distance: e.meters, minutes: e.minutes,
      pathId: e.pathId, pathName: nm,
      bearing: dir, turn,
      icon: 'walk',
      instruction: text,
      detail: `${fmtMeters(m)}　${fmtMinutes(e.minutes)}`,
    });
    prevDir = dir;
  }

  // 末端：从最后一个节点走到设施
  const last = steps[steps.length - 1];
  if (last && ctx.destName) {
    last.instruction += `，到达${ctx.destName}`;
  }

  return {
    steps,
    totalMinutes: route.minutes,
    totalMeters: route.meters,
    nodeIds: route.nodeIds,
  };
}

/* -------------------------------------------------------------- 对外入口 */

/**
 * 一次算完：设施 → 设施。
 *
 * @param net       buildNetwork() 结果
 * @param fromId    起点设施 id
 * @param toId      终点设施 id
 * @param opts      { walkSpeed, accessibleOnly, manifest, nameOf }
 */
export function planRoute(net, fromId, toId, opts = {}) {
  if (!net) return { ok: false, error: '路网还没编译' };
  const routing = net.routing ?? buildRoutingGraph(net, opts);
  const a = nodeForFacility(net, fromId);
  const b = nodeForFacility(net, toId);
  if (!a) return { ok: false, error: `起点走不到路网上（${fromId}）—— 给它拉一条支线` };
  if (!b) return { ok: false, error: `终点走不到路网上（${toId}）—— 给它拉一条支线` };

  /*
   * ★ 同区寻路不得借道安检。
   *
   *   公共区 → 公共区，不该穿过安检再出来。图是无向的，门在图上就是一条
   *   普通的连通边，所以只能在寻路时把它禁掉。
   *
   *   判据只看【起点和终点的 zone】—— 设施带 zone，这个信息够用，
   *   不需要给每条通行线标 zone（那正是旧模型最烦人的地方）。
   *   zone 一致 → 禁用所有门；不一致 → 门才是必经之路。
   */
  const zoneOf = (id) => net.facilitiesById.get(id)?.props?.zone ?? null;
  const zFrom = zoneOf(fromId);
  const zTo = zoneOf(toId);
  const sameZone = zFrom != null && zTo != null && zFrom === zTo;

  /*
   * ★ 跨区规则查表。
   *
   *   规则写在 manifest.zoneTransitions.rules 里，代码不写死任何类别 ——
   *   以后加一个区、改一条规则，改数据就行。
   *
   *   三种情况：
   *     同区           → 一个门都不许穿（没理由在同一个区里过一次安检）
   *     跨区且有规则    → 【只】允许穿规则里列的类别
   *     跨区但没规则    → 门全禁。没写规则说明这两个区之间不该直接通行，
   *                      放行等于默默开了一条没人定义过的路。
   */
  const rules = net.manifest?.zoneTransitions?.rules ?? [];
  const rule = (!sameZone && zFrom && zTo)
    ? rules.find((r) => r.from === zFrom && r.to === zTo) ?? null
    : null;
  const allowedCats = sameZone ? null : (rule ? new Set(rule.via) : null);

  const searchOpts = {
    ...opts,
    allowPortals: sameZone ? false : (rule ? true : false),
    allowedPortalCats: allowedCats ?? undefined,
  };

  let route = dijkstra(routing, a, b, searchOpts);
  const blockedByZone = !route && (sameZone || !rule);
  if (!route) {
    const compA = net.nodeComp?.get(a);
    const compB = net.nodeComp?.get(b);
    const sizeOf = (c) => (c == null ? null : [...(net.nodeComp?.values() ?? [])].filter((x) => x === c).length);

    /*
     * ★ 说清【到底是哪两坨没接上、差多远、在哪个坐标】。
     *
     *   原来只说「中间缺通行线」，用户拿着这句话没法动手 ——
     *   实测遇到的是：一条 4.3 米的支线画到了主管线 1.07 米旁边，
     *   在这个缩放下看着就是连着的。不报出距离和坐标，
     *   谁也不可能在一千多个节点里找到那 1 米。
     */
    const gap = nearestGapBetween(routing, net.nodeComp, compA, compB);

    return {
      ok: false,
      error: gap
        ? `两段路没接上：相差 ${gap.d.toFixed(2)} 米。\n`
          + `　${gap.a.level} (${gap.a.x.toFixed(1)}, ${gap.a.y.toFixed(1)})　↔　`
          + `${gap.b.level} (${gap.b.x.toFixed(1)}, ${gap.b.y.toFixed(1)})\n`
          + `　起点那一侧有 ${sizeOf(compA)} 个节点，另一侧有 ${sizeOf(compB)} 个。`
          + (gap.a.level === gap.b.level
            ? '\n　把这两点之间的线接上就好（编辑器里拖端点，或补一小段）。'
            : '\n　⚠ 这两点不在同一层 —— 要么分错了层，要么中间缺一个跨层设施。')
        : (sameZone
          ? `同在「${zFrom}」区内走不过去 —— 中间缺通行线。`
            + `\n（不允许借道安检等门禁设施：同区出行没有理由过安检）`
          : '两点之间不连通 —— 中间缺少通行线，或者该区之间没有门禁设施（安检/边检/海关）'),
      debug: {
        gap,
        fromNode: a, toNode: b,
        fromZone: zFrom, toZone: zTo, sameZone, blockedByZone,
        fromComp: compA, toComp: compB,
        fromCompSize: sizeOf(compA), toCompSize: sizeOf(compB),
        nodes: net.graph.stats.nodes, edges: net.graph.stats.edges, links: net.links?.length ?? 0,
        sameComponent: compA != null && compA === compB,
      },
    };
  }
  if (!route) {
    /*
     * ★ 算不出路时，把「起点和终点各自在哪个连通分量」一并返回。
     *   「不连通」这句话本身没法让人去修数据 —— 得说清是哪两坨没接上。
     */
    const compA = net.nodeComp?.get(a);
    const compB = net.nodeComp?.get(b);
    const sizeOf = (c) => (c == null ? null : [...(net.nodeComp?.values() ?? [])].filter((x) => x === c).length);
    return {
      ok: false,
      error: (() => {
        if (opts.accessibleOnly) return '找不到无障碍路线 —— 中间可能只有楼梯或扶梯';
        /*
         * ★ 最容易误导的一种失败：两侧【本来就在同一个连通分量里】，
         *   图是通的，是规则把路拦住了。
         *
         *   这时候说「两点之间不连通」是错的 —— 用户去补通行线，
         *   补多少都没用，因为缺的是门禁设施（或者它的 through 标志没开）。
         *   实测就是这么被绕进去的：真正的毛病是那个国内出口的
         *   through 是 false，根本不成为门。
         */
        if (compA != null && compA === compB && rule) {
          const names = rule.via
            .map((c) => net.manifest?.facilityCategories?.[c]?.name ?? c).join(' + ');
          const cnt = {};
          for (const f of (net.manifest ? [] : [])) void f;
          return `${rule.label}必须经过${names}，但走不过去 —— 两侧的路网是【连着的】，`
            + `缺的是能穿过的那道门。\n`
            + `　检查：${rule.via.map((c) => `${net.manifest?.facilityCategories?.[c]?.name ?? c}`).join('、')}`
            + `设施的 through 勾上了没有、有没有通行线接到它边缘上。`;
        }
        if (compA != null && compA === compB) {
          return '两点之间不连通 —— 中间缺少通行线或连接件';
        }
        return '两点之间不连通 —— 中间缺少通行线或连接件';
      })(),
      debug: {
        fromNode: a, toNode: b,
        fromComp: compA, toComp: compB,
        fromCompSize: sizeOf(compA), toCompSize: sizeOf(compB),
        nodes: net.graph.stats.nodes, edges: net.graph.stats.edges, links: net.links?.length ?? 0,
        sameComponent: compA != null && compA === compB,
      },
    };
  }
  /*
   * ★ 找到了路，还要【逐条对账】。
   *   限制边只能保证"只穿这几类"，保证不了"这几类都穿了"。
   *   少一道就明说少哪道 —— 悄悄放行一条没过海关的路，
   *   比直接说"走不通"危险得多。
   */
  const steps = routeToSteps(net, routing, route, opts);
  const transit = verifyZoneTransit(net, steps.steps ?? steps, rule, net.manifest);
  if (!transit.ok) {
    return {
      ok: false,
      error: `${rule.label}必须经过${rule.via.map((c) => net.manifest?.facilityCategories?.[c]?.name ?? c).join(' + ')}，`
        + `但算出来的路少了：${transit.missing.map((m) => m.name).join('、')}。\n`
        + `　说明这一段之间还缺对应的门禁设施，或者绕开了它。`,
      debug: { zoneRule: rule, missing: transit.missing, fromNode: a, toNode: b, sameZone },
    };
  }
  return { ok: true, ...steps, routing };
}

/**
 * 核对一条路线【是不是真的穿过了规则要求的每一道门】。
 *
 * ★ 为什么光靠限制边的类别不够：
 *   「安检 + 海关」这种多项要求，限制边只能保证"只穿这两类"，
 *   保证不了"两类都穿了"。物理布局通常强制了顺序，但那是我对数据的
 *   假设，不是保证 —— 万一某处画了一条绕过海关的通道，
 *   限制边是拦不住的（它也是 customs 类别的边，只是没走到）。
 *
 *   所以穿完必须逐条对账，少一道就明说少哪道。
 *
 * @returns { ok, missing: [{category, name}] }
 */
export function verifyZoneTransit(net, steps, rule, manifest) {
  if (!rule?.via?.length) return { ok: true, missing: [] };
  const cats = net.manifest?.facilityCategories ?? manifest?.facilityCategories ?? {};

  const passed = new Set();
  for (const s of steps) {
    if (!s.facilityId) continue;
    const f = net.facilitiesById?.get(s.facilityId);
    if (f?.props?.category) passed.add(f.props.category);
    if (s.category) passed.add(s.category);
  }

  const missing = rule.via
    .filter((c) => !passed.has(c))
    .map((c) => ({ category: c, name: cats[c]?.name ?? c }));
  return { ok: missing.length === 0, missing };
}

/** 路线经过的楼层（按经过顺序，去重）。 */
export function levelsOfSteps(steps) {
  const out = [];
  for (const s of steps) for (const lv of s.levels) if (!out.includes(lv)) out.push(lv);
  return out;
}

/** 第 i 步需要渲染哪几层：不跨层就只渲染当前层，跨层就渲染跨的那两层。 */
export function renderLevelsForStep(step) {
  if (!step) return [];
  return step.crossesLevels ? [...step.crossesLevels] : [step.level];
}
