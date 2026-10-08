/**
 * 地图调色板。
 *
 * ★ 界面令牌（--primary / --surface…）走 CSS，地图不行 ——
 *   它画在 canvas 上，读不到 CSS 变量。所以这里单独维护一套，
 *   深浅两套成对定义，和界面主题一起切换。
 *
 * 两套的原则：
 *   深色 —— 楼板比背景亮，房间比楼板亮，靠"变亮"表示凸起。
 *   浅色 —— 反过来：楼板比背景暗一点，房间再暗一点，靠"变暗"表示凸起。
 *          挑空在两套里都比周围更极端（深色下更黑、浅色下更白），
 *          因为它是"什么都没有"。
 *
 * 数据色（通行线蓝、跨层紫、登机口黄、安检红）两套都保留色相，
 * 只调明度 —— 同一条线在深浅下必须是"同一个颜色"，
 * 否则对着截图讨论时对不上。
 */

export const MAP_DARK = {
  bg: '#0e0e0e',
  slab: '#2b3a44',
  slabEdge: '#31393e',
  slabEdgeBright: '#8FD9E8',   // 最上层楼板的亮边（多层且未聚焦时才画）
  room: '#3d4a52',
  roomEdge: '#4a555d',
  obstacle: '#464b52',
  column: '#5a4c40',
  voidFill: '#08090a',
  voidShade: 'rgba(0,0,0,.62)',   // 单层挑空：半透明黑，不是压暗基色
  path: '#4a5860',
  pathMain: '#5b8def',
  route: '#5b8def',
  routeDone: '#3b4a5e',
  text: '#ececec',
  dim: '#7c7c7c',
  gate: '#FFD166',
  security: '#d95757',
  commerce: '#c08b5e',
  marker: '#9aa4ab',
  vertical: '#C08BFF',
  start: '#5aa87a',
  end: '#d95757',
  select: '#6FE3F5',
  /*
   * 当前步附近的设施。用【偏暗的蓝紫】而不是暖黄：
   *   暖黄和登机口、设施点的颜色撞车，而且太跳，
   *   涂在建筑物上像"选中"而不是"提示"。
   *   暗蓝紫更沉，压在楼板上不抢戏，但仍然明确。
   */
  nearby: '#7B6BC9',
  /*
   * 叠在建筑上的提示色。
   * ★ 0.42 太淡了 —— 建筑整体看着"不显眼"，和旁边的普通房间没区别。
   *   0.6 让整个体块清楚地读作"附近的设施"，但因为是【叠加】而不是替换基色，
   *   建筑本身的明暗层次（侧面暗、顶面亮）仍然保留，不会变成一块死色。
   */
  nearbyFill: 'rgba(123,107,201,.60)',
  here: '#FFD166',         // 当前位置 / 登机口，和 gate 同色系
  ink: '#0e0e0e',          // 描边/文字压在标记上时用的"背景色"
  zone: 'rgba(90,120,140,.08)',
  zoneEdge: 'rgba(120,150,170,.30)',
};

export const MAP_LIGHT = {
  bg: '#F5F3F9',
  slab: '#DCD5E6',
  slabEdge: '#B8B0C6',
  slabEdgeBright: '#3E8FA8',   // 浅色下要够深才看得见
  room: '#C3BBD2',
  roomEdge: '#9E96AE',
  obstacle: '#ADA5BC',
  column: '#C9AE90',
  /*
   * ★ 挑空在浅色下也要【比楼板暗】，不能设成白色。
   *   设成 #FFFFFF 的话，它和近白的背景几乎一样，
   *   而楼板本来就不宽 —— 看上去挑空"没渲染"。
   *   两套统一：挑空永远是周围最暗的一块，读作"这里是个洞"。
   */
  voidFill: '#9E96AE',
  /*
   * 单层挑空的着色。浅色下只要"灰一点"就够 ——
   * 深色那套的 0.62 在浅色楼板上会直接压成黑洞。
   */
  voidShade: 'rgba(0,0,0,.16)',
  path: '#A79FB8',
  pathMain: '#6750A4',
  route: '#6750A4',
  routeDone: '#CFC9DA',
  text: '#1D1B20',
  dim: '#79747E',
  gate: '#8A6100',
  security: '#B3261E',
  commerce: '#8B5A2B',
  marker: '#6B6472',
  vertical: '#6750A4',
  start: '#2E6B45',
  end: '#B3261E',
  select: '#00687A',
  nearby: '#4A3E8F',
  nearbyFill: 'rgba(74,62,143,.34)',     // 浅色下再淡一点，别把楼板压死
  here: '#8A6100',
  ink: '#FFFFFF',
  zone: 'rgba(103,80,164,.06)',
  zoneEdge: 'rgba(103,80,164,.28)',
};

/** 当前生效的一套。view2d / view3d 直接读这个对象。 */
export const MAP = { ...MAP_DARK };

let current = 'dark';

/** 切换地图主题。app.js 在主题变化和每帧绘制前调一次。 */
export function setMapTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  if (t === current) return;
  current = t;
  Object.assign(MAP, t === 'light' ? MAP_LIGHT : MAP_DARK);
}

export const mapTheme = () => current;
