# BDIA 3D Navigator —— 静态站点

北京大兴国际机场（PKX）室内 3D 导航客户端。**这个目录是构建产物，可以直接部署到 S3 + CloudFront。**

由 `bdia-nav/tools/build-static.mjs` 生成。**不要在这里手改代码** —— 下次构建会把改动覆盖掉，而且 `build-manifest.json` 里的哈希会对不上，`tools/static-parity.mjs` 会直接报错。

---

## 1. 目录结构

```
├── index.html               ← 生成的跳转页：/ → ./client/index.html
├── client/
│   ├── index.html           ← client/index.html　★ 唯一被改写的文件（见下）
│   ├── app.js               ← client/app.js　　　逐字节相同
│   ├── static-api.js        ← 静态数据接管层（新增）
│   ├── lib/                 ← client/lib/　　　　逐字节相同
│   ├── assets/              ← client/assets/　　 逐字节相同
│   └── api/data.json        ← 由 data/source/ 生成
├── tools/lib/               ← tools/lib/　逐字节相同（client/app.js import 的就是它）
├── build-manifest.json      ← 每个文件的 sha256 + 数据指纹
├── deploy.ps1               ← 一键部署到 S3 + CloudFront
└── README.md                ← 本文件
```

**站点保留 `client/` 和 `tools/` 两层，和开发服务器上的目录结构完全一致。** 因为 `client/app.js` 里写的是 `import '../tools/lib/graph.mjs'`，只有在 `/client/` 下才能解析到 `/tools/lib/`。摊平到根目录会让这个相对路径越过站点根 —— 浏览器凑巧能跑，但 node 从磁盘加载时会真的跑到目录外面去。

`client/index.html` 是唯一被改写的文件，且只改两处（构建时记录在 `build-manifest.json`）：

1. 在 `<script type="module" src="./app.js">` 前插入 `<script src="./static-api.js">`
2. 把 `file://` 打开时的错误提示从「去跑 npm run editor」改成静态部署的说法

**`app.js` 和所有 `*.mjs` 一个字符都没动。** 这意味着「开发时在 `bdia-nav` 里测的那个客户端」和「线上跑的这个客户端」是同一份代码，不是两份像的代码。

---

## 2. 为什么 `fetch('/api/data')` 在静态站点上也成立

`client/app.js` 里写死了 `fetch('/api/data')`。开发时由 `tools/editor-server.mjs` 现场读 `data/source/` 回应；静态站点上没有服务器。

`client/static-api.js` 在 `app.js` 之前执行，把 `window.fetch` 换成一个只拦 `GET /api/data` 的版本，让它落到本站的 `client/api/data.json`。其余请求原样转给浏览器原生 `fetch`。

它有两个必须成立的性质：

- **与部署路径无关。** 站点根由 `static-api.js` 自己的 `src` 反推，不是猜 `location.pathname`。所以放在域名根、放在 `/BDIA-3D-Navigator/` 子路径、换 CloudFront 域名，都能跑。
- **只拦那一次请求。** 只认 `GET`。POST、跨域请求、以后新增的任何接口都不受影响。

> **另一种做法（不推荐）**：把数据上传成一个键名恰好叫 `api/data`（没有扩展名）的对象，然后删掉 `index.html` 里的 `static-api.js` 引用。这只在**域名根路径**部署、且客户端在站点根时成立。放进子目录后 `/api/data` 会被解析到域名根，直接 404。所以默认走 shim。

---

## 3. 部署

### 3.1 前置

- 一个 S3 存储桶
- 一个 CloudFront 分发，源指向该桶，**Default root object 设为 `index.html`**
- AWS CLI 配好凭证

推荐用 **CloudFront + OAC**（源用 S3 的 REST 端点）。这样桶可以完全私有，也不用开「静态网站托管」。

### 3.2 一条命令

```powershell
# 预览要传什么，不真传
.\deploy.ps1 -Bucket my-bucket -DistributionId EXXXXXXXXXXXXX -DryRun

# 真传 + 失效缓存
.\deploy.ps1 -Bucket my-bucket -DistributionId EXXXXXXXXXXXXX

# 部署到子路径
.\deploy.ps1 -Bucket my-bucket -Prefix BDIA-3D-Navigator -DistributionId EXXXXXXXXXXXXX
```

没用 AWS CLI 的话，`deploy.ps1` 里的几条 `aws s3 sync` 可以照着手工敲。

### 3.3 ★ 三个必须注意的坑

**(1) 入口是 `/client/index.html`，不是 `/client/`。**

S3 的 **REST 端点**（CloudFront + OAC 用的就是它）**不会**把目录映射到 `index.html` —— 那是「静态网站托管」端点的 index document 行为。所以：

| 配置 | `GET /` | `GET /client/` | `GET /client/index.html` |
|---|---|---|---|
| CloudFront + OAC（推荐） | ✅ Default root object | ❌ 404 | ✅ |
| CloudFront + S3 网站托管端点 | ✅ | ✅ index document | ✅ |

根上的 `index.html` 会把人送到 `./client/index.html`，所以**从 `/` 进来永远是对的**。想支持 `/client/` 这种短地址，加一个 CloudFront Function：

```js
function handler(event) {
  var req = event.request;
  if (req.uri.endsWith('/')) req.uri += 'index.html';
  return req;
}
```

**(2) `.mjs` / `.js` 的 Content-Type 必须显式指定。**

浏览器对 ES module 做**严格 MIME 检查**：`Content-Type` 不是 JavaScript 类型就**直接拒绝执行**，控制台只留一句 "Failed to load module script"。而 AWS CLI 对 `.mjs` 不一定猜得对。

`deploy.ps1` 已经处理了（单独一趟 `--content-type "text/javascript; charset=utf-8"`）。手工部署的话别漏：

```bash
aws s3 sync . s3://BUCKET/ --exclude "*" --include "*.js" --include "*.mjs" \
  --content-type "text/javascript; charset=utf-8" \
  --cache-control "public, max-age=31536000, immutable"
```

**(3) 不能在本地用 `file://` 打开。**

ES module 会被 CORS 拦掉，`client/api/data.json` 也取不到。本地预览用：

```bash
cd bdia-nav
npm run preview:static      # 起一个和 S3+CloudFront 行为一致的静态服务器
```

页面在 `file://` 下会给出明确说明，而不是白屏。

### 3.4 缓存策略（`deploy.ps1` 已按这个来）

| 文件 | Cache-Control | 理由 |
|---|---|---|
| `client/lib/`、`client/assets/`、`tools/`、`*.js`、`*.mjs` | `max-age=31536000, immutable` | 靠 CloudFront 失效来推新 |
| `client/index.html`、根 `index.html` | `no-cache` | 入口，必须每次拿到最新的 |
| `client/api/data.json` | `no-cache` | ★ 数据会变。缓存住的话编辑器改了数据、地图上却还是旧的 |

> 用 `no-cache` 而不是 `no-store`：允许缓存，但每次都要回源校验。配合 CloudFront 失效，改完数据几十秒内就能看到。

---

## 4. 数据怎么更新

数据只有一份，在 `bdia-nav/data/source/`。改完重新构建即可：

```bash
cd bdia-nav
npm run build:static     # 重新生成这个目录
npm run test:static      # 验证「静态客户端 == 开发客户端」
```

**想让编辑器保存后自动重建**，启动服务器时加一个参数：

```bash
node tools/editor-server.mjs --static-out ../BDIA-3D-Navigator
```

之后每次 `Ctrl+S` 保存，这个目录会跟着重建，`build-manifest.json` 也一起更新。

构建是**确定性的**：同一份 `data/source` 会产出字节完全相同的 `client/api/data.json`。可以放心用 `diff` 判断数据到底有没有变。

---

## 5. 怎么确认线上就是构建出来的那份

```bash
cd bdia-nav
npm run test:static
```

它分五层验证，从弱到强：

1. **文件层** —— 拿 `build-manifest.json` 里每个文件的 sha256，和 `bdia-nav` 仓库里的源文件**双向**比对。既抓「站点里的文件被手改过」，也抓「改了源码忘了重新构建」
2. **依赖图层** —— 走一遍模块依赖图，确认站点里每个 `import` 都落得下（少搬一个文件，构建照样成功，线上才 404）
3. **数据层** —— 真起一次 `editor-server`，把 `/api/data` 的响应体和 `client/api/data.json` **逐字节**比对（不是"解析后深比较"那种弱判据）
4. **行为层** —— 把客户端**真正启动两次**（一次连开发服务器、一次走构建出来的静态 shim），比对楼层、设施 id 全集、搜索结果、**算路步骤序列的哈希**、以及 2D/3D 的**绘制调用次数**
5. **反向层** —— 上面任何一层对不上就失败，并指出是「站点被改了」还是「源码改了没重建」

比对的是行为，不只是文件。前三层只能证明「文件是那份文件」；第 4 层才能证明「跑起来是同一个东西」。
