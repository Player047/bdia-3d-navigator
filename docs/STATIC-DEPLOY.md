# 静态部署 —— S3 + CloudFront

静态站点生成在 **`projects/BDIA-3D-Navigator/`**，可以直接上传到 S3 + CloudFront。

```bash
npm run build:static     # 生成
npm run test:static      # 验证「静态客户端 == 开发客户端」
npm run preview:static   # 本地预览（模拟 CloudFront 行为）
```

---

## 1. 这个构建到底在做什么

**它不是打包，是照搬 + 生成数据。**

| 源 | 目标 | 处理 |
|---|---|---|
| `client/app.js` | `client/app.js` | **逐字节** |
| `client/lib/*.mjs` | `client/lib/*.mjs` | **逐字节** |
| `client/assets/*` | `client/assets/*` | **逐字节** |
| `tools/lib/*.mjs` | `tools/lib/*.mjs` | **逐字节** |
| `tools/static/static-api.js` | `client/static-api.js` | **逐字节** |
| `client/index.html` | `client/index.html` | ★ 唯一改写，固定两处 |
| `data/source/` | `client/api/data.json` | 生成（紧凑 JSON） |

没有压缩、没有改名、没有 tree-shaking、没有 bundle。

### 为什么 `app.js` 一个字符都不改

`client/app.js` 里写死了 `fetch('/api/data')`。开发时由 `editor-server.mjs` 现场读盘回应；静态站点上没有服务器。

有三种解法，只有一种不破坏「开发时测的就是线上跑的」：

| 做法 | 问题 |
|---|---|
| 把 app.js 改成 `fetch('api/data.json')` | 客户端代码就和开发时测的那份不一样了。以后每改一次客户端，「两边是不是同一个东西」都要重新论证 |
| 上传一个键名恰好叫 `api/data`（无扩展名）的对象 | 只在**域名根路径**部署时成立；放进 `/BDIA-3D-Navigator/` 子路径，`/api/data` 被解析到域名根 → 404 |
| **用 `static-api.js` 在运行时接管 `fetch`** ✅ | 客户端零改动，且与部署路径无关 |

`client/static-api.js` 在 `app.js` 之前执行（普通 `<script>`，而 module 是 defer 的），把 `window.fetch` 换成一个只拦 `GET /api/data` 的版本。

它的两条关键性质：

- **与部署路径无关** —— 站点根由脚本自身的 `src` 反推，不是猜 `location.pathname`。
- **只拦那一次请求** —— 只认 `GET`；POST、跨域、以后新增的接口原样转给浏览器原生 `fetch`。

### 为什么保留 `client/` 和 `tools/` 两层

因为 `client/app.js` 里写的是 `import '../tools/lib/graph.mjs'`。

在 `/client/` 下，这个相对路径解析到 `/tools/lib/` —— 和开发服务器的目录结构一模一样，浏览器和 node 的解析结果也一致。

摊平到站点根目录则变成「`/app.js` 引用 `../tools/lib/…`」：浏览器按 RFC 3986 会把根之上的 `..` 丢掉，凑巧能跑；但 node 从磁盘 `import` 时会真的跑到站点目录**外面**去找，于是无头测试根本启动不了客户端，而线上却是好的。**只在测试里坏的布局不能要。**

---

## 2. 数据怎么同步

数据只有一份，在 `data/source/`。两条路：

```bash
# 手动
npm run build:static

# 或者让编辑器保存后自动重建
node tools/editor-server.mjs --static-out ../BDIA-3D-Navigator
```

加了 `--static-out` 之后，编辑器里每次 `Ctrl+S`：

```
编辑器保存 → 写 data/source/ → 自动重建静态站点 → client/api/data.json 更新
```

构建失败**不影响保存结果**（数据已经落盘了），但会在终端里明确报出来，并在 `/api/save` 的响应里带 `staticBuild.ok === false`。

构建是**确定性的**：同一份 `data/source` 产出字节完全相同的 `client/api/data.json`。可以直接 `diff` 判断数据有没有变。

---

## 3. 怎么证明「静态客户端和开发客户端完全一样」

`npm run test:static` 跑两套：`static-parity`（语义一致）+ `static-http-selftest`（部署可用）。

### 3.1 `tools/static-parity.mjs` —— 语义一致，分五层

| 层 | 比什么 | 能抓到什么 |
|---|---|---|
| ① 文件 | `build-manifest.json` 里每个文件的 sha256，与仓库源文件**双向**比对 | 站点被手改过；或改了源码忘了重新构建 |
| ② 依赖图 | 像浏览器那样走一遍 `import` | 少搬一个 `.mjs` —— 构建照样成功，线上才 404 |
| ③ 数据 | 起真的 `editor-server`，`/api/data` 响应体与 `client/api/data.json` **逐字节**比对 | 静态数据与开发数据分叉（不是「解析后深比较」那种弱判据） |
| ④ 行为 | 客户端**真的启动两次**（一次连开发服务器、一次走构建出的 shim），比对行为指纹 | shim 拦错了、取到别的楼层、静默退化成空数据 |
| ⑤ 反向 | 上面任一层对不上就失败，并区分「站点被改」与「源码改了没重建」 | —— |

第 ④ 层的指纹包含：楼层与设施/通行线/障碍物计数、设施 id 全集的哈希、7 组搜索结果（id + 得分）、**20 对起终点的算路结果与步骤序列哈希**、场景棱柱构成、以及 2D/3D 的**绘制调用次数**。

前三层只能证明「文件是那份文件」；第 ④ 层才能证明「跑起来是同一个东西」。

### 3.2 `tools/static-http-selftest.mjs` —— 部署可用，走真实 HTTP

`static-parity` 是**从磁盘直接 import** 客户端来比行为的，它证明两份代码语义等价，
但整条链路上还有一段它碰不到 —— 浏览器真正会请求什么、那些请求在静态服务器上
能不能取到、取回来的头对不对。所以这一套必须走真的 HTTP：

| 组 | 查什么 |
|---|---|
| ① 入口 | `/` 是跳转页且目标可取；`/client/index.html` 是 `text/html` + `no-cache`；**shim 排在 app.js 之前**；`/client/` 是 404（S3 REST + OAC 不做目录索引） |
| ② 依赖图 | 从 `index.html` 走一遍依赖图，**逐个取回来查 Content-Type 是不是 JavaScript** —— ES module 有严格 MIME 检查，类型不对浏览器直接拒绝执行 |
| ③ 数据 | `/api/data` 是 404（正因如此才需要 shim）；`client/api/data.json` 可取、是 JSON、`no-cache`、非空、与 `build-manifest.json` 数量一致 |
| ④ 缓存 | 静态资源 `immutable` 长缓存，入口与数据 `no-cache` |
| ⑤ 泄漏 | `editor/`、`data/source/` 原始 GeoJSON、有版权的 `plans/` 都没有被打包进去 |

模块清单**不写死**：从 `index.html` 出发走依赖图再逐个取，所以加了新模块忘了搬、
或者改了 import 路径，都会被自动覆盖。

> 验证器本身做过变异测试：往站点里改一个字节、或改源码不重建，都会失败并指出是哪一种。一个不会失败的测试等于没有测试。

---

## 4. 部署

站点目录里有 `README.md`（部署细节）和 `deploy.ps1`（一键脚本）。要点：

```powershell
cd ../BDIA-3D-Navigator
.\deploy.ps1 -Bucket my-bucket -DistributionId EXXXXXXXXXXXXX -DryRun   # 先看要传什么
.\deploy.ps1 -Bucket my-bucket -DistributionId EXXXXXXXXXXXXX
```

### 三个必须注意的坑

**① 入口是 `/client/index.html`，不是 `/client/`。**
S3 的 REST 端点（CloudFront + OAC 用的就是它）**不做目录索引**。根上的 `index.html` 会把人送到 `./client/index.html`，所以从 `/` 进来永远是对的。想支持 `/client/` 短地址就加一个 CloudFront Function（片段见站点 README）。

**② `.mjs` / `.js` 必须显式指定 Content-Type。**
浏览器对 ES module 做**严格 MIME 检查**，类型不对就直接拒绝执行，控制台只有一句 "Failed to load module script"。`deploy.ps1` 已经单独用一趟 `--content-type "text/javascript; charset=utf-8"` 处理。

**③ `client/api/data.json` 必须 `no-cache`。**
缓存住的话，编辑器改了数据、线上地图上还是旧的 —— 而且看起来像前端 bug。

### 缓存策略

| 文件 | Cache-Control |
|---|---|
| `client/lib/`、`client/assets/`、`tools/`、`*.js`、`*.mjs` | `max-age=31536000, immutable` |
| 两个 `index.html` | `no-cache` |
| `client/api/data.json` | `no-cache` |

---

## 5. 本地预览

```bash
npm run preview:static      # 默认 http://127.0.0.1:8080/client/index.html
```

它刻意模拟 S3 + CloudFront 的行为，而不是「怎么方便怎么来」：

- `.mjs` 回 `text/javascript`（`python -m http.server` 会回 `application/octet-stream`，于是本地白屏而线上正常 —— 这种「本地和线上不一致」最费时间）
- 不做目录索引（`/client/` 就是 404，和 CloudFront + OAC 一致）
- 缓存策略与部署一致（能提前撞上「数据被缓存住」）

也可以在开发服务器里直接看客户端（数据和编辑器同一份）：`npm run editor` → `http://127.0.0.1:5173/client/`
