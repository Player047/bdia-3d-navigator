# 隔离区模型：门（可穿过的面状设施）

> 状态：**设计已定，尚未实现**。本文是实现依据。
> 取代旧的「连接件（connectors.geojson）+ 通行线标 zone」两套机制。

## 一句话

**安检 / 边检 / 海关 是「可穿过的面状设施」。所有接到它边缘上的通行线，彼此全部连通。**

只看通行线图，这里**本来就是断的** —— 是这个面把它们接上的。

## 为什么这样更好

旧模型要求**每条通行线都手填 `zone`**，再靠「不同 zone 的线不许相接」来保证隔离区不被绕过。后果：

- 每条线都要标对，标错一条就出问题
- 两条线一不小心挨上（差 0.1 米），隔离区就被绕过去了 —— 实测数据里报了 3 条 `E_PATH_TOUCHES_OTHER_ZONE`
- 用户视角根本不需要「这段走廊在不在隔离区」这个概念

新模型把保证从**标签**挪到了**拓扑**：

> 想从公共区走到隔离区？不经过安检那个面，**图里根本走不过去**。
> 不需要谁记得标对什么。

## 最终模型

| 概念 | 有没有 zone | 说明 |
|---|---|---|
| **通行线** | **没有**。彻底不带 zone | 用户视角只有「从哪个区到哪个区」，没有「这段走廊在不在隔离区」 |
| **点状设施** | 有 | 登机口、饮水处、电梯…… |
| **面状设施** | 有 | 店铺、休息室，以及**安检/边检/海关** |
| **门** | —— | `through: true` 的面状设施 |
| **区域面（隔离区标记）** | 有 | 只用来：给旅客看「你在哪个区」、渲染着色。**不参与寻路** |
| **连接件** | **删除** | 整个概念、`connectors.geojson`、`manifest.connectorTypes` 全部删掉 |
| **跨层点状设施** | 不动 | `verticalGroup` 那套继续用 |

## 建图规则

在 `tools/lib/graph.mjs` 的 `buildNetwork` 里，**③ 连接件** 那一段（现在解析 `connEnds`，约 501–517 行）**整段删掉**，换成：

```
③' 门：可穿过的面状设施
for (const f of facilities) {
  if (f.props?.through !== true) continue;
  if (!f.polygons?.length) continue;

  // 找出所有「接到这个面边缘上」的通行线（同层、距离 ≤ areaTol）
  const hits = paths
    .filter(p => p.level === f.props.level)
    .map(p => ({ p, cp: G.closestBetweenPolylineAndPolygon(p.coords, f.polygons) }))
    .filter(x => x.cp && x.cp.dist <= areaTol);

  if (hits.length < 2) → 记一条「这个门只接上了一条线，起不到门的作用」

  // 每个接入点在图上的节点
  const nodes = hits.map(x => nearestNode(graph, x.cp.pointOnLine, f.props.level, 0.6));

  // 两两相连 —— 接到门上的线彼此全部相通
  for (i < j) links.push({ a: nodes[i], b: nodes[j], kind: 'portal', facilityId: f.id });
}
```

要点：

- **`links` 的元素格式要和 ④ 跨层设施那一段保持一致**（约 585 行 push 的对象形状）。
  动手前先读 `buildNetwork` 结尾怎么归一化 `links` —— ③ 现在 push 的是
  `[a, b, id]` 三元组，④ push 的是对象，两者必然在某处被统一。**先确认这一点再改。**
- 接入点必须在建图**之前**作为 `extraNodes` 传进去，否则「线停在门边上」
  在图里找不到节点 —— 这和连接件当初踩过的坑是同一个。

## 寻路规则

`tools/lib/route.mjs` 的 `routeToSteps`：

- `e.kind === 'portal'` → 一步，指令 `通过{设施名}`
- **时间记 0**（本轮决定：先跑通拓扑，耗时以后再说）
- `crossesZones` 那一套删掉 —— 不再有这个概念

## 校验规则

**删除：**
- `E_PATH_TOUCHES_OTHER_ZONE`（3 条报错直接消失）
- `E_CONN_NOT_ON_PATH`、连接件相关全部
- `zone` 缺失 / 不一致相关

**新增：**
- `E_PATH_NO_ZONE` 之类别再加了 —— 通行线不再有 zone
- `W_PORTAL_SINGLE_PATH`：`through` 面状设施只接上一条线，起不到门的作用
- `W_PORTAL_NO_POLYGON`：标了 `through` 但不是面状
- `E_ZONE_CROSSING_NO_PORTAL`：**这条要重新想** ——
  两个区域面相邻、中间没有门，怎么发现？
  没有 zone 标签之后，只能靠几何：检查「有没有一条通行线跨越了两个不同 zone 的区域面边界」。
  需要区域面已画出来（现在 0 个）。

## 数据迁移

- `paths.geojson`：**删掉所有 `properties.zone`**（62 条）
- `facilities.geojson`：**保留 `zone`**，安全类设施加 `through: true`（已有 3 个）
- `connectors.geojson`：**删除文件**
- `manifest.json`：删 `connectorTypes`；`paths.schema.json` 去掉 `zone`
- `editor`：通行线属性面板去掉「隔离区」下拉；工具栏的「连接件 E」模式合并进「面状设施 F」
- `client`：`view2d` 不再按 zone 给通行线着色

## 受影响的地方（动手时逐个过一遍）

```
tools/lib/graph.mjs     ③ 连接件整段 → ③' 门
tools/lib/route.mjs     portal 步骤；删 crossesZones
tools/validate.mjs      删 zone 相关；加 portal 相关
tools/editor-server.mjs 保存白名单去掉 connectors.geojson
schema/paths.schema.json      去 zone
schema/connectors.schema.json 删文件
editor/lib/state.mjs    collection('connectors') 删掉
editor/app.js           删 connect 模式、connType
editor/lib/render.mjs   删 CONNECTOR_STYLE、drawConnectors
client/app.js           S.connectors 删掉
```

## 未决

**「隔离区被绕过」怎么自动发现？** 没有 zone 标签之后，唯一的办法是几何推导：
一条通行线如果跨越了两个不同 zone 的区域面边界，中间又没经过门，就是错误。
这要求**每个楼层都先把区域面画出来**（现在 L3F/L4F 都是 0 个）。

在那之前，这个检查只能缺席 —— 也就是说，**漏画安检的风险要靠画区域面来兜底**。
