/**
 * 编辑器状态层。
 *
 * 负责：项目数据、底图校准（像素 ↔ 本地米）、增删改、撤销栈、落盘序列化。
 * 不碰 DOM，不碰 canvas。
 *
 * 数据形状：
 *   区域       L<层>/regions       按层存 ★ 只是隔离区标记，【不参与寻路】
 *   设施       facilities          全局一份，几何是 Point 或 Polygon
 *   通行线     paths               全局一份 ★ 唯一的寻路图
 *   障碍物     obstacles           全局一份
 *   连接件     connectors          全局一份，跨层 / 跨隔离区的边
 *   底图校准   _calibration.json   编辑器专用，一层可有多张底图
 *
 * ★ 没有 door 字段。房间能不能走到，取决于通行线有没有吸附到它的边缘上 ——
 *   「门」是算出来的，不是填出来的。挪动通行线，入口跟着动，不会有过期的 door。
 *
 * 坐标链路（三层）：
 *   图像像素 px  ──校准──▶  本地米 (x=东, y=北)  ──视图──▶  屏幕像素
 *   校准是「每层各自一张底图 + 共享同一个本地米坐标系」，这样跨层才能对齐。
 */

import * as G from '../../tools/lib/geo.mjs';

/** 图像 y 向下、本地 y 向上，所以要翻 y。 */
function applyCal(px, cal) {
  const m = cal.mPerPx ?? 1;
  let v = [(px[0] - cal.originPx[0]) * m, -(px[1] - cal.originPx[1]) * m];
  const t = ((cal.rotationDeg ?? 0) * Math.PI) / 180;
  if (t) {
    const c = Math.cos(t), s = Math.sin(t);
    v = [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  }
  return [v[0] + (cal.nudge?.[0] ?? 0), v[1] + (cal.nudge?.[1] ?? 0)];
}

function applyCalInverse(local, cal) {
  let v = [local[0] - (cal.nudge?.[0] ?? 0), local[1] - (cal.nudge?.[1] ?? 0)];
  const t = ((cal.rotationDeg ?? 0) * Math.PI) / 180;
  if (t) {
    const c = Math.cos(-t), s = Math.sin(-t);
    v = [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  }
  const m = cal.mPerPx || 1;
  return [v[0] / m + cal.originPx[0], -(v[1] / m) + cal.originPx[1]];
}

/**
 * 缩放底图：让图像上的某一点在【本地坐标系里保持不动】。
 *
 * 推导：local = R(θ)·u + nudge，其中 u(P) = [(P−origin)·m, −(P−origin)·m]
 *       要让 u(A) 不变，就取 origin' = A − (A−origin)·(m/m')
 * 这样 nudge 和 rotationDeg 都不用动 —— 拖角缩放时手感才稳。
 */
export function scaleBaseMapAbout(map, anchorPx, newMPerPx) {
  const m = map.mPerPx || 1;
  const k = m / newMPerPx;
  const [ox, oy] = map.originPx ?? [0, 0];
  return {
    mPerPx: newMPerPx,
    originPx: [
      anchorPx[0] - (anchorPx[0] - ox) * k,
      anchorPx[1] - (anchorPx[1] - oy) * k,
    ],
  };
}

/**
 * 旋转底图：让本地空间里的 pivot 保持不动。
 * local = R(θ)·u + nudge，绕本地点 P 转 Δθ 时：nudge' = P − R(Δθ)·(P − nudge)
 */
export function rotateBaseMapAbout(map, pivotLocal, newDeg) {
  const d = ((newDeg - (map.rotationDeg ?? 0)) * Math.PI) / 180;
  const c = Math.cos(d), s = Math.sin(d);
  const n = map.nudge ?? [0, 0];
  const vx = pivotLocal[0] - n[0], vy = pivotLocal[1] - n[1];
  return {
    rotationDeg: newDeg,
    nudge: [
      pivotLocal[0] - (vx * c - vy * s),
      pivotLocal[1] - (vx * s + vy * c),
    ],
  };
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

export function createEditor(api) {
  const ed = {
    manifest: null,
    anchors: null,
    calibration: { version: 2, levels: {} },

    levels: {},            // { L3F: { regions: FC } }
    mapImages: new Map(),  // Map<底图 id, HTMLImageElement> —— 运行时缓存，不落盘

    facilities: empty(),
    obstacles: empty(),
    paths: empty(),
    connectors: empty(),

    plans: [],
    planBase: '/plans/',

    currentLevel: null,
    currentZone: 'airside_domestic',
    currentCategory: 'commerce',   // ★ 默认必须是真实存在的类别；写 'shop' 这种会一路传到校验器才报错
    currentObstacleKind: 'column',
    currentPathKind: 'corridor',
    currentRegionKind: 'concourse',

    selection: null,
    dirty: false,
    issues: null,
    lastValidate: null,
    undo: [],
    redo: [],
  };

  /* ------------------------------------------------------------ 载入 */

  ed.load = async function load() {
    const d = await api.loadAll();
    ed.manifest = d.manifest;
    // ★ 记住加载时的数据指纹。保存时带回服务端比对，磁盘更新就拒收 ——
    //   否则会把加载时那份旧的整个写回去，而且写回去的是一份完全合法的 JSON，
    //   事后从文件本身看不出任何异常。
    ed.stamp = d.stamp ?? null;
    ed.anchors = d.anchors ?? null;
    ed.levels = d.levels ?? {};
    ed.facilities = d.facilities ?? empty();
    ed.obstacles = d.obstacles ?? empty();
    ed.paths = d.paths ?? empty();
    ed.connectors = d.connectors ?? empty();
    ed.calibration = migrateCalibration(d.calibration);
    try { ed.plans = (await api.listPlans()).files ?? []; } catch { ed.plans = []; }

    const drawn = ed.levelIds().filter((l) => ed.levels[l]);
    const all = ed.levelIds();
    ed.currentLevel = drawn[0] ?? all[0] ?? null;
    return ed;
  };

  /** 楼层 id 列表，按 order 从高到低。 */
  ed.levelIds = () => Object.keys(ed.manifest?.levels ?? {}).filter((k) => !k.startsWith('_'))
    .sort((a, b) => (ed.manifest.levels[b]?.order ?? 0) - (ed.manifest.levels[a]?.order ?? 0));

  ed.drawnLevelIds = () => ed.levelIds().filter((l) => ed.levels[l]);

  ed.ensureLevel = function ensureLevel(level) {
    // ★ JS 的默认参数只对 undefined 生效，对 null 不生效 ——
    //   `ensureLevel(null)` 会建出一个键叫 "null" 的楼层，serialize 时就写出
    //   `null/regions.geojson` 这种目录。拿数据换来的教训。
    if (level == null) {
      throw new Error('ensureLevel 收到了空楼层 —— 数据还没加载完，或者 currentLevel 被清掉了');
    }
    if (!ed.levels[level]) ed.levels[level] = { regions: empty() };
    if (!ed.levels[level].regions) ed.levels[level].regions = empty();
    return ed.levels[level];
  };

  /** 区域 = 隔离区标记。不参与寻路。 */
  ed.regions = () => ed.ensureLevel(ed.currentLevel).regions;

  /** 面状设施 / 点状设施 —— 同一份数据、同一张类别表，只是几何不同。 */
  ed.areaFacilities = () => ed.facilities.features.filter((f) => f.geometry?.type === 'Polygon');
  ed.pointFacilities = () => ed.facilities.features.filter((f) => f.geometry?.type === 'Point');
  ed.isArea = (f) => f?.geometry?.type === 'Polygon';

  /* ---------------------------------------------------- 底图与校准 */

  /**
   * 一层可以放多张底图，每张独立控制缩放 / 旋转 / 位置 / 透明度。
   *   levels: { L3F: { activeId, maps: [ {id, image, label, mPerPx, ...} ] } }
   * 数组顺序 = 叠放顺序（后面的盖在前面上）。
   */

  const MAP_DEFAULTS = {
    image: null, label: '', mPerPx: 0.5, rotationDeg: 0,
    originPx: [0, 0], nudge: [0, 0], opacity: 0.65, visible: true, locked: false,
  };

  const labelOf = (image, id) => (image ? String(image).replace(/\.[^.]+$/, '').slice(0, 24) : `底图 ${id}`);

  /** 把旧格式的 _calibration.json 升级成新格式。 */
  function migrateCalibration(raw) {
    const levels = {};
    for (const [lv, v] of Object.entries(raw?.levels ?? {})) {
      if (!v) continue;
      if (Array.isArray(v.maps)) {
        levels[lv] = {
          activeId: v.activeId ?? v.maps[0]?.id ?? null,
          maps: v.maps.map((m) => {
            const full = { ...MAP_DEFAULTS, ...m };
            if (!full.label) full.label = labelOf(full.image, full.id);
            return full;
          }),
        };
      } else if (v.image) {
        const full = { ...MAP_DEFAULTS, ...v, id: 'm1' };
        if (!full.label) full.label = labelOf(v.image, 'm1');
        levels[lv] = { activeId: 'm1', maps: [full] };
      } else {
        levels[lv] = { activeId: null, maps: [] };
      }
    }
    return { version: 2, levels };
  }

  ed.calLevel = function calLevel(level = ed.currentLevel) {
    // ★ 同上：默认参数不拦 null。currentLevel 为空时调校准会建出 "null" 楼层，
    //   写进 _calibration.json 之后每次保存都带着它。这里给个不落盘的空壳。
    if (level == null) return { activeId: null, maps: [] };
    if (!ed.calibration.levels[level]) ed.calibration.levels[level] = { activeId: null, maps: [] };
    const L = ed.calibration.levels[level];
    if (!Array.isArray(L.maps)) L.maps = [];
    return L;
  };

  ed.calMaps = (level = ed.currentLevel) => ed.calLevel(level).maps;

  ed.activeMap = function activeMap(level = ed.currentLevel) {
    const L = ed.calLevel(level);
    return L.maps.find((m) => m.id === L.activeId) ?? L.maps[0] ?? null;
  };

  ed.setActiveMap = (level, id) => { ed.calLevel(level).activeId = id; };
  ed.mapById = (level, id) => ed.calMaps(level).find((m) => m.id === id) ?? null;

  ed.addCalMap = function (level, patch = {}) {
    const L = ed.calLevel(level);
    let n = 1;
    while (L.maps.some((m) => m.id === `m${n}`)) n++;
    const map = { ...MAP_DEFAULTS, ...patch, id: `m${n}` };
    if (!map.label) map.label = labelOf(map.image, map.id);
    L.maps.push(map);
    L.activeId = map.id;
    ed.dirty = true;
    return map;
  };

  ed.updateCalMap = function (level, id, patch) {
    const m = ed.mapById(level, id);
    if (!m) return null;
    Object.assign(m, patch);
    ed.dirty = true;
    return m;
  };

  ed.removeCalMap = function (level, id) {
    const L = ed.calLevel(level);
    const i = L.maps.findIndex((m) => m.id === id);
    if (i < 0) return false;
    L.maps.splice(i, 1);
    if (L.activeId === id) L.activeId = L.maps[Math.min(i, L.maps.length - 1)]?.id ?? null;
    ed.dirty = true;
    return true;
  };

  ed.moveCalMap = function (level, id, dir) {
    const L = ed.calLevel(level);
    const i = L.maps.findIndex((m) => m.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= L.maps.length) return false;
    [L.maps[i], L.maps[j]] = [L.maps[j], L.maps[i]];
    ed.dirty = true;
    return true;
  };

  function resolveMap(x) {
    if (x && typeof x === 'object') return x;
    return ed.activeMap(typeof x === 'string' ? x : ed.currentLevel);
  }
  const orDefault = (m) => m ?? MAP_DEFAULTS;

  ed.cal = function cal(level = ed.currentLevel) { return ed.activeMap(level) ?? MAP_DEFAULTS; };

  ed.setCal = function setCal(patch, level = ed.currentLevel) {
    let m = ed.activeMap(level);
    if (!m) m = ed.addCalMap(level, { image: null });
    Object.assign(m, patch);
    ed.dirty = true;
    return m;
  };

  ed.toLocal = (px, mapOrLevel) => applyCal(px, orDefault(resolveMap(mapOrLevel)));
  ed.toPx = (local, mapOrLevel) => applyCalInverse(local, orDefault(resolveMap(mapOrLevel)));

  /** 用两点 + 真实距离定比例；bearingDeg 是这两点在真实世界里的方位角。 */
  ed.calibrateByTwoPoints = function (aPx, bPx, realMeters, bearingDeg = null, map = null) {
    const pxDist = Math.hypot(bPx[0] - aPx[0], bPx[1] - aPx[1]);
    if (pxDist < 1) throw new Error('两点太近，至少隔 50 像素');
    const mPerPx = realMeters / pxDist;
    const target = orDefault(resolveMap(map));
    let rotationDeg = target.rotationDeg ?? 0;
    if (bearingDeg != null) {
      const dx = bPx[0] - aPx[0], dy = -(bPx[1] - aPx[1]);
      const currentBearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      // ★ 符号不能反：「本地坐标系里逆时针旋转 t」会让方位角减少 t。
      //   取反了的话，一张正北朝上的图会被额外转 180°，整层数据南北颠倒。
      rotationDeg = ((currentBearing - bearingDeg) % 360 + 360) % 360;
      if (rotationDeg > 180) rotationDeg -= 360;
    }
    if (map && typeof map === 'object' && map.id) {
      ed.updateCalMap(ed.currentLevel, map.id, { mPerPx, rotationDeg, originPx: aPx });
    } else {
      ed.setCal({ mPerPx, rotationDeg, originPx: aPx });
    }
    return { mPerPx, rotationDeg };
  };

  /* -------------------------------------------------- 要素增删改查 */

  /** 遍历所有要素，带 layerKey。 */
  ed.allFeatures = function* () {
    for (const [lv, pack] of Object.entries(ed.levels)) {
      for (const f of (pack.regions ?? empty()).features) yield { key: `${lv}/regions`, f };
    }
    for (const f of ed.facilities.features) yield { key: 'facilities', f };
    for (const f of ed.obstacles.features) yield { key: 'obstacles', f };
    for (const f of ed.paths.features) yield { key: 'paths', f };
    for (const f of ed.connectors.features) yield { key: 'connectors', f };
  };

  ed.collection = function (key) {
    const [lv, kind] = key.split('/');
    if (kind === 'regions') return ed.ensureLevel(lv).regions;
    if (key === 'facilities') return ed.facilities;
    if (key === 'obstacles') return ed.obstacles;
    if (key === 'paths') return ed.paths;
    if (key === 'connectors') return ed.connectors;
    throw new Error('未知图层 ' + key);
  };

  ed.find = function (key, id) {
    let c;
    try { c = ed.collection(key); } catch { return null; }
    const f = c.features.find((x) => x.id === id);
    return f ? { key, f } : null;
  };

  ed.selected = function () {
    return ed.selection ? ed.find(ed.selection.key, ed.selection.id) : null;
  };

  const ID_PREFIX = { regions: 'region', facilities: 'fac', obstacles: 'obs', paths: 'path', connectors: 'cn' };

  ed.nextId = function (key) {
    const parts = key.split('/');
    const lv = (parts.length > 1 ? parts[0] : ed.currentLevel) ?? 'xx';
    const kind = parts.length > 1 ? parts[1] : key;
    const prefix = ID_PREFIX[kind] ?? 'f';
    const tag = lv.toLowerCase();
    let n = 1;
    const taken = new Set((ed.collection(key).features ?? []).map((f) => f.id));
    while (taken.has(`${prefix}-${tag}-${String(n).padStart(4, '0')}`)) n++;
    return `${prefix}-${tag}-${String(n).padStart(4, '0')}`;
  };

  /**
   * 造一个新要素。
   * ★ 必须区分「按层存的图层」和「全局存的图层」。regions 按层存（key 形如 L3F/regions），
   *   其余全局存（key 就是图层名），楼层从 currentLevel 取。
   */
  ed.newFeature = function (key, geometry) {
    const parts = key.split('/');
    const isLevelLayer = parts.length > 1;
    const kind = isLevelLayer ? parts[1] : key;
    const level = isLevelLayer ? parts[0] : ed.currentLevel;
    const base = { level, zone: ed.currentZone, verified: false };
    let props;

    if (kind === 'regions') {
      props = { ...base, kind: ed.currentRegionKind, name: '', nameEn: '' };
    } else if (kind === 'facilities') {
      props = {
        ...base,
        category: ed.currentCategory, name: '', nameEn: '',
        aliases: [], pinyin: [], location: '', hours: null, phone: null,
        accessible: true, tags: [],
      };
      // 只有面状设施有通行语义
      if (geometry.type === 'Polygon') Object.assign(props, { public: true, through: false });
    } else if (kind === 'obstacles') {
      props = { ...base, kind: ed.currentObstacleKind, name: '' };
    } else if (kind === 'paths') {
      props = {
        ...base, kind: ed.currentPathKind, name: '', nameEn: '',
        minWidth: 6, accessible: true, bidirectional: true, speedFactor: 1,
      };
    } else {
      props = { ...base };
    }
    return { type: 'Feature', id: ed.nextId(key), geometry, properties: props };
  };

  /* ---------------------------------------------------------- 撤销栈 */

  function snapshot() {
    return JSON.stringify({
      levels: ed.levels, connectors: ed.connectors,
      facilities: ed.facilities, obstacles: ed.obstacles, paths: ed.paths,
      calibration: ed.calibration,
    });
  }
  function restore(s) {
    const d = JSON.parse(s);
    ed.levels = d.levels; ed.connectors = d.connectors;
    ed.facilities = d.facilities; ed.obstacles = d.obstacles; ed.paths = d.paths;
    ed.calibration = d.calibration;
  }

  ed.pushUndo = function () {
    ed.undo.push(snapshot());
    if (ed.undo.length > 60) ed.undo.shift();
    ed.redo.length = 0;
  };
  ed.undoStep = function () {
    if (!ed.undo.length) return false;
    ed.redo.push(snapshot());
    restore(ed.undo.pop());
    ed.dirty = true;
    ed.selection = null;
    return true;
  };
  ed.redoStep = function () {
    if (!ed.redo.length) return false;
    ed.undo.push(snapshot());
    restore(ed.redo.pop());
    ed.dirty = true;
    ed.selection = null;
    return true;
  };
  ed.canUndo = () => ed.undo.length > 0;
  ed.canRedo = () => ed.redo.length > 0;

  /* ------------------------------------------------------ 增删改 */

  ed.add = function (key, feature) {
    ed.pushUndo();
    ed.collection(key).features.push(feature);
    ed.dirty = true;
    ed.selection = { key, id: feature.id };
    return feature;
  };

  ed.remove = function (key, id) {
    const c = ed.collection(key);
    const i = c.features.findIndex((f) => f.id === id);
    if (i < 0) return false;
    ed.pushUndo();
    c.features.splice(i, 1);
    ed.dirty = true;
    if (ed.selection?.id === id) ed.selection = null;
    return true;
  };

  ed.setProps = function (key, id, patch) {
    const c = ed.collection(key);
    const f = c.features.find((x) => x.id === id);
    if (!f) return false;
    Object.assign(f.properties, patch);
    ed.dirty = true;
    return true;
  };

  /* -------------------------------------------------------- 序列化 */

  ed.serialize = function () {
    const files = {
      'manifest.json': ed.manifest,
      '_calibration.json': {
        ...ed.calibration,
        _comment: '编辑器专用：每层的底图与像素→米校准参数。不参与导航计算。',
      },
      'connectors.geojson': ed.connectors,
      'facilities.geojson': ed.facilities,
      'obstacles.geojson': ed.obstacles,
      'paths.geojson': ed.paths,
    };
    if (ed.anchors) files['anchors.json'] = ed.anchors;
    for (const [lv, pack] of Object.entries(ed.levels)) {
      if (lv === 'null' || lv === 'undefined') continue;    // 防御：绝不把这种键写出去
      files[`${lv}/regions.geojson`] = pack.regions ?? empty();
    }
    return files;
  };

  ed.markSaved = function () { ed.dirty = false; };

  /**
   * 把一个字段提升为「该类别所有设施都有」。
   * 编辑器里点「所有 X 都用」时调用 —— 直接改内存里的 manifest，保存时一起落盘。
   */
  ed.addCategoryField = function (category, def) {
    const cat = ed.manifest?.facilityCategories?.[category];
    if (!cat || !def?.key) return false;
    if (!Array.isArray(cat.fields)) cat.fields = [];
    if (cat.fields.some((d) => d.key === def.key)) return false;
    cat.fields.push(def);
    ed.dirty = true;
    return true;
  };

  /** 从类别上移除一个字段定义（不影响已有取值）。 */
  ed.removeCategoryField = function (category, keyName) {
    const cat = ed.manifest?.facilityCategories?.[category];
    if (!Array.isArray(cat?.fields)) return false;
    const i = cat.fields.findIndex((d) => d.key === keyName);
    if (i < 0) return false;
    cat.fields.splice(i, 1);
    ed.dirty = true;
    return true;
  };

  /* ------------------------------------------------------ 保存 / 校验 */

  /**
   * 落盘。api.save 收 { 相对路径: 内容 }。
   * ★ 这两个方法在重写 state.mjs 时被漏掉过，导致「保存失败：ed.save is not a function」。
   *   凡是 app.js 调用的 ed.xxx，state.mjs 里都必须有 —— 类型检查抓不到这种遗漏。
   */
  ed.save = async function save(force = false) {
    // ★ 带上加载时的数据指纹。服务端拿它和磁盘现状比对，
    //   磁盘更新就拒收 —— 否则会把加载时那份旧的整个写回去。
    const r = await api.save(ed.serialize(), force, ed.stamp);
    if (r?.ok !== false) {
      ed.markSaved();
      // ★ 保存成功之后服务端会回传新的指纹。不接住的话，
      //   下一次保存就会拿「加载时」的旧指纹去比，必然被判过期 ——
      //   表现成「第一次存上了，之后再也存不进去」。
      if (r.stamp) ed.stamp = r.stamp;
    }
    return r;
  };

  /** 跑一次校验，结果挂在 ed.lastValidate / ed.issues 上给界面用。 */
  ed.validate = async function validate() {
    const r = await api.validate();
    ed.lastValidate = r ?? null;
    ed.issues = r?.issues ?? [];
    return r;
  };

  ed.G = G;
  return ed;
}
