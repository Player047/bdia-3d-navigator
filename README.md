# BDIA 3D Navigator

北京大兴国际机场（PKX / BDIA）室内 3D 导航 Web App —— **数据层与校验工具**。

覆盖场景：国内/国际 **出发**、国内/国际 **到达**、四种 **中转**，以及值机、安检、边检、海关、登机、休息、餐饮、购物等全部环节。

---

## 当前进度

| 阶段 | 状态 |
|---|---|
| **0. 数据地基**：schema + 校验器 + 示例楼层 | ✅ 完成 |
| 1. 画一层真实数据，跑通 点→点→路径→指令 | ✅ |
| 2. 3D 可视化 + 相机状态机 + 分步交互 | ✅ |
| 3. 加第二层，验证跨层寻路 | 🟡 数据有 L1F–L4F，跨层还有接不上的电梯口 |
| 4. 铺全楼层数据 | 🟡 L1F / L4F / B1 / L5F 还没画通行线 |
| 5. 部署上线 | 🟡 静态客户端可部署（S3 + CloudFront，见 [docs/STATIC-DEPLOY.md](docs/STATIC-DEPLOY.md)）；服务端接口未接 |
| 6. 接航班动态 / 实时排队 | ⬜ |

**⚠️ 数据仍在绘制中，`npm run validate` 目前不是全绿。** 当前 ERROR 主要集中在三类：
坐标疑似写成了经纬度（`E_COORD_LOOKS_LIKE_LONLAT`）、不同隔离区的通行线相互接触
（`E_PATH_TOUCHES_OTHER_ZONE`，等于绕过了安检）、以及设施接不上路网
（`E_POI_NOT_ON_PATH` / `E_AREA_NOT_ON_PATH`）。跑一次 `npm run validate` 看完整清单 ——
每条都带定位和修法。

因此 **`npm test` 目前会在第一套（数据校验）就停下**。只想跑其余几套：

```bash
npm run test:model && npm run test:client && npm run test:vertical && npm run test:editor
```

---

## 快速开始

```bash
cd projects/bdia-nav

# ── 画图 ──
npm run editor          # 启动本地编辑器 → http://127.0.0.1:5173/editor/
```

> **Windows 上更省事：双击 [`启动编辑器.cmd`](启动编辑器.cmd)。**
>
> ⚠️ **不要直接双击 `editor/index.html`。** 用 `file://` 打开一定是空白页 ——
> 浏览器会以 CORS 为由拒绝加载 ES 模块，`fetch('/api/data')` 也无从谈起（没有服务可问），
> 而且 `file://` 下连 `data/source/` 都读不到。
> 现在这种情况下页面会给出明确说明而不是空白，但正确做法还是走服务。

```bash
# ── 校验 ──
npm run validate        # 校验源数据（人读输出）
npm run validate:json   # 机器可读，给 CI 用
npm run check           # strict 模式：WARN 也算失败

# ── 测试 ──
npm test                # 全部：数据校验 + 模型 + 客户端 + 跨层 + 编辑器

# ── 静态站点（S3 + CloudFront）──
npm run build:static    # 生成 ../BDIA-3D-Navigator/，可直接部署
npm run test:static     # 验证「静态客户端 == 开发客户端」
npm run preview:static  # 本地起一个和 CloudFront 行为一致的静态服务器
npm run check:live      # 核对【已经部署出去的】站点是否就是本地构建的那一份
                        #   --url https://player047.site/projects/BDIA-3D-Navigator/
```

**静态部署** → [docs/STATIC-DEPLOY.md](docs/STATIC-DEPLOY.md)

**怎么画？看 → [docs/DRAWING-GUIDE.md](docs/DRAWING-GUIDE.md)**

数据模型细节 → [docs/DATA-SCHEMA.md](docs/DATA-SCHEMA.md)

数据当前状态以 `npm run validate` 的输出为准（见上方「当前进度」）。

---

## 画图：为什么是自建编辑器

| 现成方案 | 卡在哪 |
|---|---|
| geojson.io | 只能画经纬度。导出被强制重投影成 WGS84，**距离直接错 30%** |
| QGIS | 能用（自定义投影），但 GeoJSON 规范强制 WGS84，导出要绕道 GeoPackage 再转回来 |
| Figma / Inkscape 描图 → 脚本转 | 描图快，但**属性和几何分离**，几十个店铺的名称/类别要另维护一份表 |
| JOSM + PicLayer | 专为描图设计，但输出 WGS84 的 OSM XML |

共同问题：**它们都不知道这个领域的规则** —— 门必须在走廊边界上、扶梯端点必须在可通行面里、两个隔离区不能贴在一起。这些恰恰是眼睛看不出来、但会让路径彻底失效的错误。

所以编辑器把这些规则**焊进操作里**：

| 领域规则 | 编辑器怎么让它自动成立 |
|---|---|
| 门必须在可通行面边界上 | 面状设施画完**自动算门**：取与走廊的最长共享边中点 |
| 连接件端点必须在可通行面内 | 放端点时**实时判定**，不在里面立刻提示「路径会断在这里」 |
| 障碍物必须在可通行面**内** | 画完立刻判定，画在外面提示「什么也挡不住」 |
| 扶梯大多是单向的 | 新建扶梯**默认 `bidirectional: false`** |
| 跨隔离区只能用合规类型 | 两端 zone 不同时**自动从 `zoneRules` 挑合法类型** |
| 距离必须准确 | 两点定比例 + **量距核对**（探测平面图有没有透视变形） |
| 各层必须对齐到同一坐标系 | 每层独立校准但映射到同一本地米坐标系 + 幽灵层叠加 |
| 数据必须合规 | 保存后可**在浏览器里直接跑完整校验器** |

编辑器、校验器、未来的寻路算法**共用同一份 `tools/lib/geo.mjs`**，不会算出两种结果。

---

## 数据模型：一个设施就是一条记录

`facilities.geojson` 里，**几何是 `Point` 或 `Polygon`，属性完全一致**。

店铺和饮水机在领域上是**同一种东西** —— 有名字、有类别、有楼层、有隔离区、有营业时间、有无障碍属性。唯一不同的是形状。所以：**一个文件、一张类别表、一条记录一个设施**。

```
统一设施（facilities.geojson）          障碍物（obstacles.geojson）
┌─────────┐                                  ┌───┐
│  店铺   │← 面状，画在走廊外侧              │ ▨ │← 面，画在走廊内部
└────┬────┘   靠门连接，是「目的地」          └───┘   被扣除，路径要绕开
     │ door
┌────┴────────────────┐              ┌───────────┴────────┐
│   走廊 / 大厅        │              │   走廊 / 大厅       │
└─────────────────────┘              └────────────────────┘
```

**为什么不分两个文件。** 早期版本拆成了 `rooms.geojson`（面）和 `pois.geojson`（点），代价是：

- `name` / `nameEn` / `category` / `zone` / `level` **在两处重复**，各自会过期
- 需要 `room.poi ↔ poi.room` **双向引用**，还多出一条只为看管这个冗余而存在的校验规则 `E_ROOM_POI_MISMATCH`
- 两套类别表里 `dining` / `cafe` / `retail` / `restroom` 重名
- 说不清谁是权威（搜索用 POI，渲染店铺标签用 room，不一致时谁赢？）

> **一条只为看管冗余而存在的校验规则，就是设计错误的铁证。**

现在那条规则连同整个 `checkRefs` 一起删掉了。`obstacles` 单列是因为它**根本不是设施** —— 没名字、没类别、不该被搜到、不该成为导航目的地，只是一个要被扣掉的形状。

详见 [docs/DATA-SCHEMA.md](docs/DATA-SCHEMA.md) §3 和 §5。

---

## 目录结构

```
projects/bdia-nav/
├── data/source/                 ← 源数据（进 Git）
│   ├── manifest.json            ★ 全局配置：楼层 / 隔离区 / zone跨越规则 /
│   │                              POI类别 / 连接件类型 / 时间模型 / 场景任务图 / 校验阈值
│   ├── anchors.json             ★ 地理配准控制点
│   ├── _calibration.json          编辑器专用：每层的平面图与像素→米校准参数
│   ├── facilities.geojson       ★ 设施：唯一的实体，几何是 Point 或 Polygon
│   │                              店铺、休息室、卫生间是面；登机口、饮水、充电是点
│   ├── obstacles.geojson        ★ 障碍物：柱子/柜台/设备。不是设施，没名字没类别
│   ├── paths.geojson            ★ 通行线：唯一的寻路图
│   ├── connectors.geojson       ★ 扶梯 / 电梯 / 楼梯 / 安检 / 边检 / 中转柜台
│   └── L3F/                       每层一个目录
│       └── regions.geojson      ★ 隔离区标记（不参与寻路）
│
├── data/.backup/                ← 保存前的自动快照（已 gitignore）
│
├── plans/                       ← 平面图底图放这里（已 gitignore，有版权）
│
├── client/                      导航客户端（零依赖，无构建步骤）
│   ├── index.html
│   ├── app.js                   浏览 + 导航、分步交互、面板
│   └── lib/
│       ├── view3d.mjs           3D 渲染与相机
│       ├── view2d.mjs           2D 视图
│       └── palette.mjs          配色（深浅两套）
│
├── editor/                      画图工具（零依赖，无构建步骤）
│   ├── index.html
│   ├── app.js                   交互、吸附、面板
│   └── lib/
│       ├── state.mjs            校准数学、自动算门、撤销、序列化
│       └── render.mjs           画布渲染
│
├── schema/                      JSON Schema —— 编辑器之外的补全与实时报错
│
├── tools/
│   ├── lib/geo.mjs              米制平面几何库（编辑器 / 校验器 / 客户端共用）
│   ├── lib/graph.mjs            建图：通行线 → 寻路网络
│   ├── lib/route.mjs            两层规划器（任务图 + 几何图 A*）
│   ├── lib/search.mjs           搜索索引
│   ├── lib/source-data.mjs      ★ 读 data/source —— 服务器与静态构建【共用这一份】
│   ├── lib/domshim.mjs          无头测试用的最小 DOM 桩
│   ├── editor-server.mjs        本地服务器：读写 data/source + 调用校验器
│   ├── validate.mjs             ★ 校验器
│   ├── model-selftest.mjs       数据模型自测
│   ├── client-selftest.mjs      客户端自测（投影 / 场景 / 点选）
│   ├── vertical-selftest.mjs    跨层设施自测
│   ├── editor-pick.mjs          编辑器跨层拾取自测
│   ├── editor-e2e.mjs           端到端：模拟浏览器解析模块依赖图并打 API
│   ├── build-static.mjs         ★ 生成静态站点（照搬客户端 + 生成数据）
│   ├── static-parity.mjs        ★ 验证「静态客户端 == 开发客户端」
│   ├── static-boot.mjs          无头启动真客户端，产出行为指纹
│   ├── static-http-selftest.mjs 走真实 HTTP 查部署可用性（MIME / 缓存头 / 入口）
│   ├── static-live-check.mjs    ★ 核对线上站点与本地构建产物逐字节相同
│   ├── serve-static.mjs         本地静态预览（模拟 S3 + CloudFront）
│   └── static/                  静态站点模板（shim / 部署脚本 / 站点 README）
│
└── docs/
    ├── DRAWING-GUIDE.md         ★ 画图操作手册
    ├── DATA-SCHEMA.md           ★ 数据模型手册
    ├── ZONE-MODEL.md            隔离区模型
    └── STATIC-DEPLOY.md         ★ 静态部署手册
```

---

## 核心设计

### 1. 用本地米制坐标画图，不要用经纬度

定一个 origin，所有坐标是 **x = 正东(米)、y = 正北(米)**。

```
GeoJSON 里所有 coordinates 一律 [x, y] = [东, 北] 米
只有 anchors.json 的 wgs84 字段是 [lon, lat]
```

为什么：北京纬度 39.5°，Web Mercator 尺度因子 `1/cos(39.5°) ≈ 1.296`，直接在经纬度上算距离会**错 30%**。用米制画，距离直接就是米，各层只要同 origin / 同比例 / 同旋转，扶梯上下端天然对齐。

### 2. 隔离区是硬约束，不是提示

机场导航和商场导航的根本区别：`landside → airside` **只能经安检通道**。zone 跨越规则是有向的：

```
landside         → airside_domestic   必须过 security
airside_domestic → landside           是到达出口（exit），单向自由通行
```

反过来放行就等于没有安检。校验器会检查：两个不同 zone 的可通行面**直接相邻**即为 ERROR（隔离区泄漏）。

### 3. 两层规划器

```
上层：任务图（业务规则，会变）
  进楼 → [值机?] → 安检 → [边检?] → 登机口
  航班类型 / 是否已值机 / 有无托运 / 是否中转 → 决定走哪几步

下层：几何图（navmesh，不会变）
  每一步之间跑 A*
```

业务规则随政策和航班变，几何不变。混在一张图里，改一条规则要重编译整个图。场景定义在 `manifest.json → scenarios`。

### 4. 寻路放客户端，服务端存数据

单栋建筑的可通行图只有几千到几万个节点，A\* 在浏览器里 **< 5ms**。放服务端等于多 100~300ms 网络往返 + 断网就废。服务端保留同签名的 `/route` 备用接口，将来接实时排队时无感切换。

---

## 画图工作流（逐层）

完整操作手册见 **[docs/DRAWING-GUIDE.md](docs/DRAWING-GUIDE.md)**。速览：

1. **放平面图**：图片丢进 `plans/`，文件名带楼层号
2. **校准**（按 `K`）：在图上点两个已知距离的点，输入真实米数 + 方位角
3. **核对**（按 `M`）：再量一条方向不同的已知距离，误差 > 3% 说明图有透视变形，不能用
4. **画可通行面**（`W`）：先画走廊和大厅 —— 这是寻路的地基，不是店铺
5. **画面状设施**（`F`）：店铺/休息室贴在走廊外侧共边，**门自动生成**
6. **放点状设施**（`P`）：登机口/饮水/充电。先选类别，再点
7. **画障碍物**（`O`）：柱子/柜台画在走廊**内部**，会被扣除
8. **连连接件**（`C`）：点起点 → 点终点。跨隔离区会自动选合法类型
9. **保存**（`Ctrl+S`）→ **校验**：ERROR 全部清掉
10. **勾 `verified`**：核实过的要素标记上

> 建议第一轮不要铺全楼层：先画「中央大厅 + 一家店 + 两个登机口 + 一个安检点」，把整条工具链验证完。之后就是重复劳动。

---

## 测试

```bash
npm test    # 五套一起跑
```

| 套件 | 作用 |
|---|---|
| `validate` | 源数据校验 |
| `test:model` | **数据模型**：检索文本归一化、必填索引字段、按词反查 |
| `test:client` | **客户端**：近平面裁剪、场景棱柱数量、点选命中、选中高亮 |
| `test:vertical` | **跨层设施**：楼层成员一致性、坐标必须跨层重合、接不上本层路网 |
| `test:editor` | **编辑器**：跨层拾取对话框（`editor-pick`）+ 模块依赖图与 API 冒烟（`editor-e2e`） |
| `test:static` | **静态站点**：语义一致性（文件逐字节 + 依赖图 + 数据逐字节 + 客户端行为指纹）+ 部署可用性（走真实 HTTP 查入口、MIME、缓存头、泄漏） |
| `check:live` | **线上核对**：把已部署站点的每个文件取回来，和本地构建产物逐字节比对。抓「上传工具猜错 MIME」「漏传文件」「传的是旧的一次构建」 |

`test:static` 只有在构建过静态站点之后才有意义（先 `npm run build:static`），
所以不在 `npm test` 里。

为什么值得写这些：它们都抓到过**光看代码发现不了**的问题 ——

- 几何库把共端点的相邻边判成「严格相交」，导致**所有矩形都被判自交**，数据集加载为空但校验器照样"跑完了"
- 并查集漏掉没有边的节点，导致**孤岛被静默放过**，`E_DISCONNECTED` 形同虚设
- 校准的旋转符号反了，一张正北朝上的图会被额外转 180°，**整层数据南北颠倒**
- 编辑器页面在 `/` 提供而 `<script src="./app.js">` 被解析成 `/app.js` → **编辑器白屏**
- 「点状设施落在面状设施内部」这条检查**写在 `continue` 之后，永远不触发**
- 校验器遇到几何型非法的障碍物**直接崩溃** —— 本该报告问题，结果什么也不报
- 重构时漏删的 `const extra = []` 和残留的 `pack.rooms`，让**整个界面所有面板都是空的**，但 `node --check` 完全查不出来
- DOM 桩缺 `document.documentElement`，客户端在模块顶层抛 `TypeError`，而桩里的
  `unhandledRejection` 处理器把顶层 await 的拒绝吃掉、进程以**退出码 0** 结束 ——
  于是 `test:client` 的第 3 节（点选命中 / 高亮 / 近平面裁剪）**一直没跑，而且算通过**

共同特征：**不崩溃、不报错，只是安静地给出错误结果**。

### 界面坏了怎么办

**三种启动失败都会在页面上说清楚原因，而不是留一片空白**：

| 现象 | 页面会显示 |
|---|---|
| 用 `file://` 双击打开 | 「这个编辑器不能直接用 file:// 打开」+ 正确做法 |
| 脚本加载失败 | 「加载 app.js 失败」+ 检查服务/端口 |
| 4 秒内没启动完成 | 「编辑器没能启动」+ 排查方向（`npm run validate` / `editor:boot`） |

面板渲染还有独立容错：**一个面板出错不会让其他面板变空白**，出错的面板名和错误消息显示在顶部红色横幅里。按 F12 看完整堆栈。

如果你改了 `editor/` 下的代码，先跑 `npm run editor:boot` —— 它能在 300ms 内告诉你界面还能不能起来。

---

## 版权

官方平面图有版权。做法：**以官方图为参考，自己重绘矢量数据**，最终产品里不出现原图（这是业内通行做法）。
