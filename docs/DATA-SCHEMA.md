# 数据模型手册

画图时对照这份。字段的机器可校验版本在 `schema/*.schema.json`（编辑器会自动补全和报错）。

---

## 0. 坐标系 —— 先读这一节

**所有源数据用本地米制坐标绘制：`[x, y] = [东(米), 北(米)]`。**

| | |
|---|---|
| 原点 | `manifest.projection.origin` = WGS84 `(39.5098, 116.4109)`，即本地坐标 `(0, 0)` |
| x 轴 | 正东，单位米 |
| y 轴 | 正北，单位米 |
| 经纬度换算 | `lon = origin.lon + x / 85882`　`lat = origin.lat + y / 111320` |

> **为什么不直接用经纬度画？**
> 北京纬度 39.5°，Web Mercator 的尺度因子是 `1/cos(39.5°) ≈ 1.296`。直接在经纬度上做距离运算会**错 30%**，而导航 App 的核心就是距离和转向。

### 三条铁律

1. **GeoJSON 里所有 `coordinates` 都是 `[x, y]` 米，绝不是 `[lon, lat]`**
2. **只有 `anchors.json` 的 `wgs84` 字段是 `[lon, lat]`**（经度在前 —— GeoJSON 标准）。北京经度 ≈116、纬度 ≈39，写反了校验器报 `E_LONLAT_ORDER`
3. **各层必须用同一个 origin、同一个 px→m 比例、同一个旋转角**。否则扶梯上下端对不上，校验器报 `E_CONN_MISALIGNED`

### 地理配准怎么做

在平面图和卫星图上都能精确定位的点（建筑角点、指廊端点）取 4~6 个，填进 `anchors.json`：

```json
{
  "id": "cp-sw",
  "local": [-250, -120],                  // 你在图上量的坐标
  "wgs84": [116.407989, 39.508722],       // [经度, 纬度]
  "note": "航站楼西南角，取自卫星图",
  "verified": true
}
```

校验器会拟合相似变换并报告三个数字：

| 指标 | 合格 | 不合格说明什么 |
|---|---|---|
| 缩放因子 | 0.99 ~ 1.01 | 偏离 → 画图比例和地理配准不一致（比如按 1px=0.8m 导入却当成 1px=1m） |
| 旋转角 | ±1° | 偏离 → 平面图没和正北对齐 |
| 最大残差 | < 2m | 超了 → 控制点定错了，或各层没用同一坐标系 |

---

## 1. 文件结构
```
data/source/
├── manifest.json          全局配置（见 §7）
├── anchors.json           地理配准控制点（见 §0）
├── _calibration.json      编辑器专用：每层的平面图与像素→米校准参数
├── facilities.geojson     ★ 设施：唯一的实体，几何是 Point 或 Polygon（见 §3）
├── obstacles.geojson      ★ 障碍物：柱子/柜台/设备，不是设施（见 §5）
├── paths.geojson          ★★ 通行线：唯一的寻路图（见 §5.5）
├── zones.geojson          隔离区面（可选，用于着色）
├── connectors.geojson     连接件（见 §4）
└── <LEVEL>/               每层一个目录，目录名 = 楼层 id
    └── walkable.geojson   可通行面（见 §2）
```

**加一层**：在 `data/source/` 下新建目录，名字就是楼层 id（必须在 `manifest.levels` 里定义过），放一个 `walkable.geojson`。校验器会自动扫描，不需要注册。

> **为什么只有可通行面按层分文件？** 它天然是「一层一大片」，而且逐层绘制时按层取用最方便。
> 设施、障碍物、通行线、连接件都跨层且需要统一搜索/编译，放全局一份。

> **`walkable` 和 `paths` 的分工**（容易搞混，见 §5.5）：
> `walkable` = **可走区域约束**（隔离区语义、宽度、几何校验、POI 定位）
> `paths` = **寻路图本身**（路径怎么走、转弯点在哪、指令说什么）

---

## 2. `walkable.geojson` — 可通行面

**真正能走的地面。** 它不是店铺、不是墙、不是柱子，**也不是寻路图**（寻路图是 `paths.geojson`，见 §5.5）。

```json
{
  "type": "Feature",
  "id": "walk-3f-hall",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-60,-50], [60,-50], [60,60], [-60,60], [-60,-50]]]
  },
  "properties": {
    "level": "L3F",
    "zone": "airside_domestic",
    "kind": "hall",
    "name": "中心候机大厅",
    "nameEn": "Central Departure Hall",
    "width": 120,
    "minWidth": 8,
    "accessible": true,
    "bidirectional": true,
    "verified": false
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `level` | ✅ | 楼层 id，必须在 `manifest.levels` 中 |
| `zone` | ✅ | 隔离区，枚举见 §6 |
| `kind` | ✅ | `hall` / `corridor` / `pier` / `queue` / `lobby` / `bridge` / `platform` |
| `name` `nameEn` | ✅ | 双语名 |
| `minWidth` | ✅ | **最小通行宽度（米）**。用于判定无障碍/大件行李路线，也用于校验画得太窄 |
| `width` | | 名义宽度，仅信息展示 |
| `accessible` | | 轮椅/婴儿车能否通行 |
| `verified` | | 是否已对照官方图核实 |

### 关键规则

- **环必须闭合**（首尾点相同），至少 4 个点，**不得自交**
- **同层可通行面之间不得正面积重叠** —— 可以共边（表示连通），不能压盖
- **相邻即连通**：两个面共边或间距 < 0.05m，视为可以走过去。这是连通性检查的依据
- **不同 zone 的面不得直接相邻** —— 必须拉开距离，用连接件跨过去。否则报隔离区泄漏

---

## 3. `facilities.geojson` — 设施

**唯一的设施实体。几何是 `Point` 或 `Polygon`，属性完全一致。**

```json
{
  "type": "Feature",
  "id": "fac-3f-w1",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-80,25], [-60,25], [-60,55], [-80,55], [-80,25]]]
  },
  "properties": {
    "level": "L3F",
    "zone": "airside_domestic",
    "category": "cafe",
    "name": "星巴克",
    "nameEn": "Starbucks",
    "aliases": ["咖啡", "coffee", "starbucks"],
    "pinyin": ["xing ba ke", "xbk"],
    "location": "3F 大厅西侧",
    "hours": "06:00-22:00",
    "accessible": true,
    "tags": [],
    "door": [-60, 40],
    "public": true,
    "through": false,
    "verified": false
  }
}
```

### 为什么点状和面状不分家

店铺和饮水机在领域上是**同一种东西**：有名字、有类别、有楼层、有隔离区、有营业时间、有无障碍属性。唯一不同的是**形状**。

早期版本把它们拆成 `rooms.geojson`（面）和 `pois.geojson`（点），结果：
- `name` / `nameEn` / `category` / `zone` / `level` **在两处重复**，各自会过期
- 需要 `room.poi ↔ poi.room` **双向引用**，以及一条只为看管这个冗余而存在的校验规则 `E_ROOM_POI_MISMATCH`
- 两套类别表里 `dining` / `cafe` / `retail` / `restroom` 重名
- 说不清谁是权威

**一条只为看管冗余而存在的校验规则，就是设计错误的铁证。** 现在只有一个文件、一张类别表、一条记录一个设施。

### 字段

| 字段 | 必填 | 适用 | 说明 |
|---|---|---|---|
| `level` `zone` `category` `name` `nameEn` | ✅ | 全部 | `category` 必须在 `manifest.facilityCategories` 中 |
| `aliases` | | 全部 | **搜索体验的关键**。「星巴克」要能被「Starbucks」「咖啡」搜到 |
| `pinyin` | | 全部 | 拼音全拼 + 首字母缩写，构建期生成搜索索引 |
| `location` | | 全部 | 人工位置描述，搜索结果副标题用 |
| `hours` `phone` `accessible` `tags` | | 全部 | |
| `door` | ✅ | **仅面状** | 必须落在同层可通行面边界上（容差 0.5m）。编辑器画完自动算 |
| `public` | | **仅面状** | 旅客能否进入，默认 true |
| `through` | | **仅面状** | **是否允许穿行，默认 false** —— 店铺不能当通道，否则路径会穿店而过 |

### 两种几何的定位规则正好相反

```
   面状设施                          障碍物（见 §5）
   ┌─────────┐                              ┌───┐
   │  店铺   │  ← 画在走廊「外侧」           │ ▨ │  ← 画在走廊「内部」
   └────┬────┘     只与走廊共边              └───┘     被扣除
        │ door                                    
   ┌────┴────────────────┐              ┌───────────┴────────┐
   │   走廊 / 大厅        │              │   走廊 / 大厅       │
   └─────────────────────┘              └────────────────────┘
   靠门连接，是「目的地」                 是「障碍」，路径要绕开
```

- **面状设施**：与可通行面**只共边、不重叠**（重叠报 `E_FACILITY_OVERLAP_WALKABLE`），门开在共边上
- **点状设施**：必须**落在**同层同 zone 的可通行面内（不在里面报 `E_FACILITY_OUTSIDE_WALKABLE`）

### 点状设施落在面状设施内部 = 可能是重复录入

报 `W_POINT_INSIDE_AREA_FACILITY`。如果它本来就是那家店的一部分，应该**合并成一条记录**，而不是两条。除非它确实需要作为独立导航目的地。

### 已预置的类别分组（`facilityCategories`，一张表）

| group | 类别 |
|---|---|
| `transport` | entrance / exit / taxi / bus / rail / parking / car_rental |
| `process` | checkin / baggage_drop / oversize_baggage / security / immigration / customs / quarantine / gate / transfer_desk / baggage_claim / ticketing |
| `service` | service_desk / baggage_storage / postal / sim_card / police / lost_found / office / counter / staff |
| `rest` | airline_lounge / paid_lounge / sleep_pod / hotel / shower / rest_area / seating / kids_area / prayer_room / smoking |
| `facility` | restroom / accessible_restroom / nursing / water / charging / wifi / elevator_lobby / left_luggage / facility |
| `finance` | atm / bank / tax_refund |
| `medical` | pharmacy / medical |
| `dining` | dining / fast_food / cafe / bar |
| `shopping` | retail / duty_free / convenience / souvenir / bookstore / florist |

---

## 4. `connectors.geojson` — 连接件

**「哪个扶梯连着另一层的哪个扶梯」的落点。** 每个连接件是一条图边 `from → to`。

```json
{
  "type": "Feature",
  "id": "cn-esc-3f4f-n01",
  "geometry": { "type": "Point", "coordinates": [0, 55] },
  "properties": {
    "connectorType": "escalator",
    "name": "北侧扶梯 1",
    "nameEn": "North Escalator 1",
    "from": { "level": "L3F", "x": 0, "y": 55, "zone": "airside_domestic" },
    "to":   { "level": "L4F", "x": 0, "y": 55, "zone": "airside_domestic" },
    "bidirectional": false,
    "direction": "up",
    "schedule": [{ "hours": "04:30-23:30", "direction": "up" }],
    "accessible": false,
    "travel_time": 13,
    "wait_time": 0,
    "verified": false
  }
}
```

`geometry` 只是中点，用于在地图上放图标；真正的数据在 `from` / `to`。

### 类型

| 类型 | 中文 | 跨层 | 无障碍 | 对齐容差 |
|---|---|---|---|---|
| `escalator` | 扶梯 | ✅ | ❌ | 3.0 m |
| `elevator` | 电梯 | ✅ | ✅ | 1.5 m |
| `stairs` | 楼梯 | ✅ | ❌ | 2.0 m |
| `ramp` | 坡道 | ✅ | ✅ | 3.0 m |
| `travelator` | 自动步道 | 同层 | ✅ | 5.0 m |
| `apm` / `shuttle` / `train` | 捷运/摆渡车/轨道 | 同层 | ✅ | 50~200 m |
| `security` | 安检 | 同层 | ✅ | — |
| `immigration` | 边检 | 同层 | ✅ | — |
| `customs` | 海关 | 同层 | ✅ | — |
| `quarantine` | 检验检疫 | 同层 | ✅ | — |
| `transfer_desk` | 中转柜台 | 同层 | ✅ | — |
| `exit` | 到达出口 | 同层 | ✅ | — |

### 四个坑

**① 端点必须落在可通行面里**
`from` / `to` 的 `(x, y)` 必须在 `(level, zone)` 对应的某个 walkable 面内部（容差 1m）。不满足报 `E_CONN_ENDPOINT_OUTSIDE` —— 路径会断在这里。这是最容易犯、也最难靠眼睛发现的错误。

**② 扶梯大量是单向的**
`bidirectional: false` 表示只能 `from → to` 走。全写成双向会规划出物理上过不去的路线。分时反向用 `schedule`。

**③ 电梯连 N 层，不是两层**
不要两两建边 —— 那样等待时间会被重复计算 N 次。**正确做法：为电梯建一个「井节点」**：

```
        ┌──────────────┐
   L4F ─┤ elevator_hub ├─ L3F
        └──────┬───────┘
              L2F
```

在 `connectors.geojson` 里这样表达：每层站点 ↔ 井节点一条边（`travel_time: 8`），井节点之间不建边。等待时间（`wait_time`）只算一次。
> 具体落地方式见下方「待补充」—— 井节点模型需要在编译期展开，源数据阶段先用成对的 `escalator`/`elevator` 表达，编译脚本负责合并。

**④ 跨越 zone 的类型必须在白名单里**
`manifest.zoneRules` 定义了哪种跨越允许用哪些类型。用扶梯从中转区直通国内隔离区 → 报 `E_ZONE_TRANSITION_FORBIDDEN`。

---

## 5. `obstacles.geojson` — 障碍物

**纯障碍：柱子、柜台、设备、不可通行的员工区。**

它们**没有名字、没有类别** —— 不是设施，只是要从可通行面里**扣掉**的区域。不该被搜到，也不该成为导航目的地。

```json
{
  "type": "Feature",
  "id": "obs-3f-0001",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-5,-5], [5,-5], [5,5], [-5,5], [-5,-5]]]
  },
  "properties": {
    "level": "L3F",
    "zone": "airside_domestic",
    "kind": "column",
    "name": "结构柱",
    "verified": false
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `level` | ✅ | 楼层 id |
| `kind` | ✅ | 必须在 `manifest.obstacleKinds` 中：`column` / `counter` / `equipment` / `planter` / `furniture` / `stairwell` / `shaft` / `void` / `blocked` |
| `zone` | | 可选。填了就要求落在同 zone 的可通行面内 |
| `name` | | 可选。不填就不显示标签，不影响导航 |

### ★ 定位规则和面状设施正好相反

| | 面状设施 | 障碍物 |
|---|---|---|
| 画在哪 | 可通行面**外侧**，只共边 | 可通行面**内部** |
| 作用 | 目的地，从门进去 | 被扣除，路径绕开 |
| 报错 | `E_FACILITY_OVERLAP_WALKABLE`（重叠了） | `E_OBSTACLE_OUTSIDE_WALKABLE`（画到外面了） |

**画在外面的障碍物什么也挡不住** —— 这是最容易犯的错，画完编辑器会立刻提示。

### 为什么柱子不塞进可通行面的洞里

技术上可行（Polygon 支持洞），但**画起来极其痛苦**：大厅里几十根柱子，每加一根都要回头改大厅的环。

分成一个独立的扣除层之后：**大厅画一次，柱子一个个盖上去**。改柱子不动大厅。

### 什么时候不需要它

如果走廊本来就画得绕开了柱子（可通行面是**净值**），那就不需要障碍物。两种做法都行，别重复：柱子既在可通行面里挖了洞、又画了一遍障碍物，会导致扣两次（结果一样，但数据冗余）。

---

## 5.5 `paths.geojson` — 通行线（★ 唯一的寻路图）

```json
{
  "type": "Feature",
  "id": "path-3f-spine",
  "geometry": { "type": "LineString", "coordinates": [[0, -45], [0, 60]] },
  "properties": {
    "level": "L3F", "zone": "airside_domestic", "kind": "spine",
    "name": "中央通道", "nameEn": "Central Concourse",
    "minWidth": 8, "accessible": true, "bidirectional": true, "speedFactor": 1.0
  }
}
```

### 为什么不直接用可通行面算路

**面从「寻路图」降级为「可走区域约束」。** 面只负责三件事：

1. 承载**隔离区**语义（「这片是安检后的」本质上是面，线表达不了）
2. 提供**宽度 / 几何校验**的依据（轮椅路线要判通道够不够宽）
3. 判断「某个 POI 在不在可走区域里」

**路径怎么走由通行线决定。** 这是一次刻意的取舍：

| | 面模型（navmesh） | 线模型（通行线） |
|---|---|---|
| 寻路图 | 需要编译（Recast 体素化→三角网格） | **就是数据本身**，零编译 |
| 转弯点 | 漏斗算法算出的障碍角点 | **你放节点的位置** |
| 指令 | 「向东南方走 87 米」 | 「沿中央通道向前 60 米，问询台后右手边是星巴克」 |
| 一层数据量 | 几百个顶点 | 几十个顶点 |
| 客户端算路 | navmesh WASM + off-mesh link | 纯 Dijkstra，~20KB，<1ms |

对**导览**（而不是人群仿真）来说，「可执行」压倒「最短」；对一个人画完整个航站楼来说，绘制成本是项目能否完成的头号风险。

### 编译规则：交叉即连通

> **端点、顶点、交叉点 = 图节点。两条线交叉即连通。**

这是平面上的物理事实 —— 同一个可通行区域里，交叉点你确实走得过去。所以**画长线穿过去就行，不要在路口手工打断**。

例外用 `bridge: true`（跨层天桥在平面图上重叠）。

编译实现见 `tools/lib/graph.mjs`。**校验器和未来的寻路共用同一份实现**，所以不会出现「校验器说通、寻路说断」。

### 怎么保证图是可信的（9 条规则）

| 码 | 级别 | 检查 |
|---|---|---|
| `E_PATH_OUTSIDE_WALKABLE` | ERROR | 每个采样点（顶点 + 沿线每 2m）必须落在同层同 zone 的可通行面内 |
| `E_PATH_CROSS_ZONE` | ERROR | **一条线不能跨隔离区** —— 跨 zone 只能经连接件 |
| `E_PATH_CROSSES_OBSTACLE` | ERROR | 不得穿过障碍物 |
| `E_PATH_SELF_INTERSECT` | ERROR | 单条线不得自交（会被当成路口，凭空多出节点） |
| `E_PATH_DISCONNECTED` | ERROR | 同层同 zone 的线网必须连通 |
| `E_CONN_NOT_ON_PATH` | ERROR | **连接件的 from/to 必须落在通行线上**（容差 0.5m） |
| `W_PATH_DANGLING` | WARN | 端点悬空 —— 15m 内没有设施或连接件接住它 |
| `W_PATH_NEAR_MISS` | WARN | 两条线差 0.05~2m 没接触（看着该连其实断着） |
| `W_POI_FAR_FROM_PATH` | WARN | 设施离最近通行线 > 30m（旅客没有可跟的通道） |

### 隔离区在图论上的表达

这是线模型最漂亮的一点：

```
中转厅通道  path-3f-transit   ← zone: transit
      │
      ✗  不连通
      │
中央通道    path-3f-spine     ← zone: airside_domestic
```

两条线**在图里就是不连通的**，只能通过 `cn-sec-3f-transit-a`（安检连接件）跨过去。于是「必须过安检」不再是一条需要额外校验的规则 —— **它是图的拓扑本身**。

### 一个坑：悬空端点的判定半径

`thresholds.pathDanglingAnchorDistance` 默认 **15m**。这个数**必须 ≥ 指廊半宽**：指廊通常 28m 宽，中线到两侧登机口约 12~14m。设成 12m 时，指廊末端的正常端点会被误报成悬空（实测差 0.08m 就中招）。

### 端点的正确落法

| 端点应该落在 | 例子 |
|---|---|
| 路口 | 中央通道 × 东西通道 |
| 某个店铺的门 | `path-3f-branch-w` 终点 = 咖啡店的门 `(-60, 40)` |
| 某个登机口旁边 | 指廊通道末端距登机口 11m |
| 某个扶梯/电梯口 | 连接件的 from/to |

---

## 6. 隔离区（zone）

| zone | 含义 | public |
|---|---|---|
| `landside` | 非隔离区（安检前） | ✅ |
| `transit` | 中转区 | ✅ |
| `security` | 安检区 | ✅ |
| `airside_domestic` | 国内隔离区 | ✅ |
| `airside_intl` | 国际隔离区 | ✅ |
| `airside_transit` | 国际中转隔离区 | ✅ |
| `staff` | 工作人员区 | ❌ |
| `restricted` | 禁止进入 | ❌ |

### `zoneRules` 是有向的

```
landside         → airside_domestic   经 security              国内出发安检
landside         → airside_intl       经 security/immigration  国际出发
airside_domestic → landside           经 exit                  ★ 国内到达单向出口
airside_intl     → landside           经 immigration/customs   国际到达
transit          → airside_domestic   经 security/transfer_desk
airside_domestic → transit            经 transfer_desk
...
```

> **如果没有 `airside_domestic → landside` 这条单向规则，国内到达就没法规划。**
> **如果反过来也放行（`landside → airside_domestic` 允许走 `exit`），就等于没有安检。**

### 校验器怎么抓隔离区泄漏

1. **几何层**：两个不同 zone 的 walkable 面直接相邻或重叠 → `E_ZONE_ADJACENT_NO_GATE`
2. **连接件层**：跨 zone 的连接件类型不在 `zoneRules` 白名单 → `E_ZONE_TRANSITION_FORBIDDEN`
3. **场景层**：场景的 `zonePath` 里有 `zoneRules` 未定义的跨越 → `E_ZONE_PATH_ILLEGAL`

---

## 7. `manifest.json` — 全局配置

| 段 | 作用 |
|---|---|
| `projection` | 坐标系统定义（origin / 轴向 / 经纬度换算系数） |
| `bbox` | 坐标合法范围，防止误画飞出 |
| `levels` | **楼层定义**。`order` 越大越靠上，`elevation` 用于 3D 各层垂直间距 |
| `zones` | 隔离区枚举 + 显示名 + 颜色 |
| `zoneRules` | **允许的 zone 跨越方式（有向）** |
| `connectorTypes` | 连接件类型 + 对齐容差 |
| `facilityCategories` | ★ **设施类别体系**（点状和面状共用一张表）+ 分组 + 图标 + 可否作为目的地 |
| `obstacleKinds` | 障碍物种类（柱子/柜台/设备…）。障碍物不是设施，没有类别 |
| `walkableKinds` | 可通行面种类 |
| `timeModel` | **时间估算表**（步行速度 / 连接件耗时 / 流程耗时） |
| `scenarios` | **场景任务图**（见 §8） |
| `thresholds` | 校验阈值 —— 校验器从这里读，不要在脚本里硬编码 |

### `levels` 怎么填

```json
"L3F": {
  "order": 5,               // 排序权重，越大越靠上
  "elevation": 12.0,        // 标高（米），3D 渲染的垂直间距
  "name": "三层",
  "nameEn": "Level 3",
  "roles": ["departure", "airside", "gates", "transit"],
  "verified": false,        // ★ 对照官方平面图核实后改 true
  "drawn": true             // 进度标记
}
```

> **⚠️ 现有 `roles` 是按公开资料推测的，必须核实。** 校验器会统计 `verified: false` 的要素数量提醒你。

### `timeModel` 怎么填

全部是**估算值，必须用实测校准**：

```json
"walkSpeed":    { "default": 1.25, "withLuggage": 1.0, "wheelchair": 0.9, "rushing": 1.6 },
"connectorTime":{ "escalator": { "base": 3, "perLevel": 10 },
                  "elevator":  { "base": 8, "wait": 45, "perLevel": 8 } },
"processTime":  { "security":  { "wait": 480, "waitPeak": 1080, "service": 60 },
                  "immigration": { "wait": 300, "service": 45 } }
```

---

## 8. 场景任务图

两层规划器的**上层**。业务规则会变，几何不会变 —— 分开维护。

已定义 8 个场景：

| id | 名称 | zonePath |
|---|---|---|
| `dep-domestic` | 国内出发 | landside → airside_domestic |
| `dep-international` | 国际出发 | landside → airside_intl |
| `arr-domestic` | 国内到达 | airside_domestic → landside |
| `arr-international` | 国际到达 | airside_intl → landside |
| `transit-domestic-domestic` | 国内转国内 | airside_domestic → transit → airside_domestic |
| `transit-international-domestic` | 国际转国内（入境） | airside_intl → landside → airside_domestic |
| `transit-domestic-international` | 国内转国际（出境） | airside_domestic → transit → airside_intl |
| `transit-international-international` | 国际转国际 | airside_intl → transit → airside_intl |

```json
"dep-domestic": {
  "name": "国内出发",
  "zonePath": ["landside", "airside_domestic"],
  "steps": [
    { "id": "enter",    "category": "entrance",     "required": true },
    { "id": "checkin",  "category": "checkin",      "required": false, "when": "!checkedIn || needBaggageDrop" },
    { "id": "bagdrop",  "category": "baggage_drop", "required": false, "when": "needBaggageDrop" },
    { "id": "security", "category": "security",     "required": true },
    { "id": "gate",     "category": "gate",         "required": true, "dynamic": "boardingGate" }
  ]
}
```

`required: false` 的步骤由 `when` 条件决定是否插入；`dynamic` 表示运行期取值（登机口会临时变更，目的地是「当前有效登机口」，不是用户手输的）。

---

## 9. 校验器输出的错误码

跑 `npm run selftest` 会注入 23 类真实错误确认每一种都能被抓到。

### ERROR — 必须修复

| 码 | 含义 |
|---|---|
| `E_ZONE_ADJACENT_NO_GATE` | 不同隔离区的可通行面直接相邻（可被规划出不经过安检的路线） |
| `E_ZONE_TRANSITION_FORBIDDEN` | 跨 zone 的连接件类型不在 zoneRules 白名单 |
| `E_ZONE_PATH_ILLEGAL` | 场景 zonePath 里有未定义的跨越 |
| `E_CONN_ENDPOINT_OUTSIDE` | 连接件端点不在任何可通行面内（路径断点） |
| `E_CONN_ENDPOINT_ZONE_MISMATCH` | 端点声明的 zone 与所在可通行面不符 |
| `E_CONN_MISALIGNED` | 跨层两端水平偏差超容差（两层平面图没对齐） |
| `E_CONN_SAME_POINT` / `E_CONN_SAME_LEVEL` | 无意义的边 / 垂直连接件两端同层 |
| `E_DOOR_NOT_ON_WALKABLE` | 面状设施的门没画在走廊边界上（旅客进不去） |
| `E_DOOR_ZONE_MISMATCH` | 门开在隔离区外 |
| `E_MISSING_DOOR` | 面状设施缺 door |
| `E_FACILITY_OUTSIDE_WALKABLE` | 点状设施不在任何可通行面内 |
| `E_FACILITY_ZONE_MISMATCH` | 设施声明的 zone 与所在地不符 |
| `E_FACILITY_OVERLAP_WALKABLE` / `E_FACILITY_OVERLAP_FACILITY` / `E_WALKABLE_OVERLAP` | 面互相压盖 |
| `E_OBSTACLE_OUTSIDE_WALKABLE` | 障碍物画在可通行面外（什么也挡不住） |
| `E_SELF_INTERSECT` / `E_RING_NOT_CLOSED` / `E_RING_TOO_FEW_POINTS` | 几何非法 |
| `E_COORD_LOOKS_LIKE_LONLAT` | **把经纬度当成米写了**（bbox 检查抓不到，靠尺度识破） |
| `E_OUT_OF_BBOX` / `E_AREA_TOO_SMALL` | 坐标越界 / 面积过小 |
| `E_DISCONNECTED` | 出现走不到的孤岛 |
| `E_DUP_ID` | id 重复 |
| `E_BAD_GEOMETRY_TYPE` | 几何类型不对（障碍物写成了 Point 之类） |
| `E_UNKNOWN_LEVEL` / `E_UNKNOWN_ZONE` / `E_UNKNOWN_CATEGORY` / `E_UNKNOWN_CONNECTOR_TYPE` / `E_UNKNOWN_KIND` | 枚举写错 |
| `E_ANCHOR_SCALE` / `E_ANCHOR_RESIDUAL` / `E_LONLAT_ORDER` / `E_ANCHOR_TOO_FEW` | 地理配准 |

> **已删除**：`E_ROOM_OVERLAP_*`、`E_POI_*`、`E_DANGLING_REF`、`E_ROOM_POI_MISMATCH`、`E_UNKNOWN_ROOM_CATEGORY`
> —— 这些是为旧的 rooms/pois 双文件模型服务的。统一设施模型下它们不该存在。

### WARN — 建议修复（多数是「楼层还没画完」的预期提示）

`W_CONN_DANGLING_LEVEL` · `W_CONN_HALF_LINKED` · `W_FACILITY_NO_WALKABLE` · `W_DOOR_NO_WALKABLE` · `W_ZONE_UNCOVERED` · `W_SCENARIO_GAP` · `W_ZONE_PATH_UNSUPPORTED` · `W_NO_NAME_EN` · `W_DUP_NAME` · `W_DUP_FACILITY` · `W_POINT_INSIDE_AREA_FACILITY` · `W_ISOLATED_WALKABLE` · `W_WIDTH_MISMATCH` · `W_OBSTACLE_NO_WALKABLE` · `W_OBSTACLE_ZONE_MISMATCH` · `W_OBSTACLE_OVERLAP` · `W_UNKNOWN_OBSTACLE_KIND`

---

## 10. 常见错误速查

| 症状 | 原因 | 修法 |
|---|---|---|
| 路径穿过店铺 | 面状设施和走廊重叠了（没挖空） | 设施向外凸出，只与走廊共边 |
| 路径断在扶梯口 | 端点没落在走廊里 | 把 `from`/`to` 挪进 walkable 面内 |
| 能不进安检就到登机口 | 隔离区面贴在一起了 | 拉开距离，用 `security` 连接件跨过去 |
| 扶梯上下端对不上 | 各层 origin / 比例 / 旋转不一致 | 统一导入参数 |
| 距离全部偏小 30% | 用了经纬度当坐标 | 改成米制；检查 `E_COORD_LOOKS_LIKE_LONLAT` |
| 反向规划绕远路 | 单向连接件写成双向 | `bidirectional: false` 或配 `schedule` |
| 无障碍路线算不出来 | 没有 `accessible: true` 的垂直连接件 | 每层至少配一部电梯 |
| 路径撞上柱子 | 柱子没画成障碍物（或障碍物画在走廊外） | 用「画障碍物」在走廊**内部**盖上 |
| 搜到两个「星巴克」 | 同一家店录了一条面状设施 + 一条点状设施 | 合并成一条。校验器报 `W_POINT_INSIDE_AREA_FACILITY` |
| 地图上啥都没有 | `zones.geojson` 没覆盖 | 补区域面，或检查质心是否落在区域内 |

---

## 待补充

以下内容会在后续阶段补进本手册：

- **编译层格式**：`data/source` → navmesh + 图 + POI 索引 的产物规范
- **电梯井节点的编译期展开规则**
- **转向指令的数据结构**（`{action, dist, dir, landmark, level}`）
- **转向角阈值与地标绑定半径**的可调参数
- **运行时数据版本与缓存策略**
