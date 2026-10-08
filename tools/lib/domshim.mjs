/**
 * 极简 DOM shim —— 只为在 node 里把 editor/app.js 真正启动一遍。
 *
 * 为什么需要它：`node --check` 只查语法，查不出运行时错误。
 * 一个 `ReferenceError: extra is not defined` 就能让 renderPanels() 从第二行起全部不执行，
 * 表现是「所有栏目空白、点选没反应」，但代码看起来完全正常。
 * 有了这个 shim，编辑器可以在 CI 里被真正 boot 一次，断言每个面板都渲染出了内容。
 *
 * 不是 jsdom 的替代品 —— 只实现 app.js 实际用到的那部分 API。
 */

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.el.className = [...s].join(' '); }
  add(...c) { const s = this._set(); c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set(); c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set().has(c); }
  toggle(c) { if (this.contains(c)) this.remove(c); else this.add(c); }
}

export /** HTML 布尔属性：存在即为真。 */
const BOOL_ATTRS = new Set(['checked', 'disabled', 'readonly', 'selected', 'multiple', 'hidden', 'required', 'open']);

class ShimElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.style = {};
    this.className = '';
    this.classList = new ClassList(this);
    this._attrs = {};
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.title = '';
    this.type = '';
    this.step = '';
    this.placeholder = '';
    this.id = '';
    this.width = 800;
    this.height = 600;
    this.clientWidth = 1200;
    this.clientHeight = 800;
    this.parentElement = null;
    this._listeners = new Map();
  }
  get textContent() { return this._text || this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  /** 测试用：把整棵子树的文本拼起来。★ 必须包含 value —— 属性面板的很多字段是只读 input。 */
  get allText() {
    return [
      this._text, this._html, this.value,
      ...this.children.map((c) => (typeof c === 'string' ? c : c.allText)),
    ].join(' ');
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      this.children.push(n);
      if (n instanceof ShimElement) n.parentElement = this;
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  /** SVG 那边习惯用 appendChild，桩里也得有。 */
  appendChild(n) { this.append(n); return n; }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  /*
   * ★ HTML 的布尔属性是「存在即为真」：setAttribute('checked','') 之后
   *   input.checked 应该变成 true，而不是空字符串。
   *   桩不还原这一点的话，`el('input', { checked: true })` 出来的勾选框
   *   在测试里全是未勾选状态 —— 而且 disabled 也一样会静默失效。
   */
  setAttribute(k, v) {
    this._attrs[k] = v;
    if (BOOL_ATTRS.has(String(k).toLowerCase())) { this[k] = true; return; }
    if (k in this) this[k] = v;
  }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() { /* noop */ }
  /** 测试用：模拟一次事件 */
  fire(type, ev = {}) { for (const fn of this._listeners.get(type) ?? []) fn({ target: this, ...ev }); }
  /** 焦点桩。blur 次数用来验证「选完下拉框要把焦点还给画布」。 */
  focus() { this.focused = true; }
  blur() { this.focused = false; this.blurCount = (this.blurCount ?? 0) + 1; }
  /** 测试用：把子树里所有元素收集出来（字符串文本节点跳过）。 */
  allElements(out = []) {
    if (this.nodeType) out.push(this);
    for (const c of this.children) if (c && typeof c === 'object' && c.nodeType) c.allElements(out);
    return out;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  /** ★ 必须缓存：每次返回新对象的话，测到的调用记录永远是空的。 */
  getContext() { if (!this._ctx) this._ctx = makeCtx(); return this._ctx; }
}

/* ------------------------------------------------------------ canvas 2D 桩 */

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** M1 · M2。canvas 的变换都是这种形式的 3×3 仿射矩阵。 */
function matMul(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/**
 * canvas 2D 上下文桩。
 *
 * ★ 它真的维护变换矩阵和 save/restore 栈，并记录每次绘制调用当时的矩阵。
 *   这不是多余的严谨：实际踩过的坑就是「底图绘制结束后把变换复位成单位矩阵，
 *   把 draw() 开头设的 diag(dpr,dpr) 丢了」—— 底图之后画的所有东西都错位，
 *   而且只在 dpr ≠ 1 的高分屏上才暴露。只有真正追踪矩阵才抓得到。
 */
function makeCtx() {
  const calls = [];
  const stack = [];
  const st = {
    m: { ...IDENTITY },
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textBaseline: '', imageSmoothingEnabled: true, lineDash: [],
  };

  const rec = (name) => (...args) => { calls.push({ name, args, m: { ...st.m } }); };
  const put = (name, args) => calls.push({ name, args, m: { ...st.m } });

  const api = {
    _calls: calls,
    get _matrix() { return { ...st.m }; },

    setTransform(...a) {
      st.m = a.length === 6 ? { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] } : { ...IDENTITY };
      put('setTransform', a);
    },
    transform(a, b, c, d, e, f) { st.m = matMul(st.m, { a, b, c, d, e, f }); },
    translate(x, y) { st.m = matMul(st.m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); st.m = matMul(st.m, { a: c, b: s, c: -s, d: c, e: 0, f: 0 }); },
    scale(x, y) { st.m = matMul(st.m, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
    resetTransform() { st.m = { ...IDENTITY }; },

    save() { stack.push({ ...st, m: { ...st.m }, lineDash: [...st.lineDash] }); },
    restore() { const p = stack.pop(); if (p) { Object.assign(st, p); st.m = { ...p.m }; } },

    clearRect: rec('clearRect'), fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'), rect: rec('rect'),
    stroke: rec('stroke'), fill: rec('fill'), clip: rec('clip'),
    drawImage: rec('drawImage'), fillText: rec('fillText'), strokeText: rec('strokeText'),
    setLineDash(d) { st.lineDash = d ?? []; put('setLineDash', [d]); },
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };

  for (const k of ['globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textBaseline', 'imageSmoothingEnabled']) {
    Object.defineProperty(api, k, { get: () => st[k], set: (v) => { st[k] = v; } });
  }
  return api;
}

/** 安装全局桩。返回一个句柄，测试结束后可以查错误、清理。 */
export function installDom({ fetchImpl, dpr = 1 } = {}) {
  const byId = new Map();
  const errors = [];

  const getById = (id) => {
    if (!byId.has(id)) {
      const e = new ShimElement(id === 'cv' ? 'canvas' : 'div');
      e.id = id;
      byId.set(id, e);
    }
    return byId.get(id);
  };

  // canvas 需要一个 parentElement 给 ResizeObserver
  const cv = getById('cv');
  const canvasHost = new ShimElement('main');
  cv.parentElement = canvasHost;

  const document = {
    body: new ShimElement('body'),
    getElementById: getById,
    createElement: (tag) => new ShimElement(tag),
    /*
     * ★ SVG 元素必须走 createElementNS —— 图例的色块是用 SVG 画的。
     *   桩里没有它的话，图例会在「面板渲染失败」里被吞掉，
     *   表现成侧边栏那一节是空的（真实浏览器里反而正常，所以特别难查）。
     */
    createElementNS: (ns, tag) => {
      const n = new ShimElement(tag);
      n.namespaceURI = ns;
      // ★ SVG 元素的 tagName 是【小写】的（HTML 元素才是大写）。
      //   桩不还原这一点的话，测试里 c.tagName === 'svg' 永远为假。
      n.tagName = tag;
      return n;
    },
    addEventListener: () => {},
  };
  // body.append 之后 getElementById 也要能找到面板错误横幅
  const origAppend = document.body.append.bind(document.body);
  document.body.append = (...nodes) => {
    origAppend(...nodes);
    for (const n of nodes) if (n instanceof ShimElement && n.id) byId.set(n.id, n);
  };

  class ResizeObserverStub {
    constructor(cb) { this.cb = cb; }
    observe() {} unobserve() {} disconnect() {}
  }
  class ImageStub {
    constructor() { this.onload = null; this.onerror = null; this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(v) { this._src = v; queueMicrotask(() => this.onerror?.()); }
    get src() { return this._src; }
  }

  const winListeners = new Map();
  const win = {
    devicePixelRatio: dpr,
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };

  const prev = {};
  const set = (k, v) => { prev[k] = globalThis[k]; globalThis[k] = v; };
  set('document', document);
  set('window', win);
  set('ResizeObserver', ResizeObserverStub);
  set('Image', ImageStub);
  set('requestAnimationFrame', (cb) => { cb(0); return 0; });
  set('cancelAnimationFrame', () => {});
  if (fetchImpl) set('fetch', fetchImpl);

  const onUncaught = (e) => errors.push(e);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  return {
    document, window: win, getById, errors, dpr,
    canvasCtxCalls: () => (cv._ctx ? cv._ctx._calls : []),
    /** 当前生效的变换矩阵。一帧画完之后它必须回到基础矩阵。 */
    canvasMatrix: () => (cv._ctx ? cv._ctx._matrix : { ...IDENTITY }),
    /** 测试用：清空绘制调用记录，便于只检查接下来这一次重绘。 */
    resetCtxCalls: () => { if (cv._ctx) cv._ctx._calls.length = 0; },
    /** 触发挂在 window 上的事件（键盘快捷键就是挂在这里的）。 */
    fireWindow(type, ev = {}) {
      const e = { preventDefault: () => {}, stopPropagation: () => {}, target: { tagName: 'BODY' }, ...ev };
      for (const fn of winListeners.get(type) ?? []) fn(e);
    },
    /** 在画布上模拟一次指针事件。 */
    fireCanvas(type, ev = {}) {
      cv.fire(type, { pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault: () => {}, ...ev });
    },
    restore() {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
      for (const [k, v] of Object.entries(prev)) globalThis[k] = v;
    },
  };
}
