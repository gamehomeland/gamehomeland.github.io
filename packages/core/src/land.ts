import { landCatalogData } from './land-catalog.generated.js';

export type GroundPoint = [number, number];
export interface LandPlot {
  key: string;
  name: string;
  areaM2: number;
  points: GroundPoint[];
  index?: number;
}
export interface LandPreset extends LandPlot {
  lengthM: number;
  widthM: number;
  privateOnly: boolean;
}
export interface LandMap {
  key: string;
  mapId: number;
  name: string;
  kind: 'private' | 'community';
  plots: LandPlot[];
  whole?: LandPlot;
  skins?: { id: number; name: string }[];
}
export interface LandPlan extends LandPlot {
  regions: LandPlot[];
}
export const landCatalog = landCatalogData as unknown as { presets: LandPreset[]; maps: LandMap[] };
const plans = new Map<string, LandPlan>();
for (const p of landCatalog.presets) plans.set(p.key, { ...p, name: '通用户型', regions: [] });
for (const map of landCatalog.maps) {
  if (map.whole) plans.set(map.whole.key, { ...map.whole, regions: map.plots });
  for (const p of map.plots)
    plans.set(p.key, { ...p, name: `${map.name} · ${p.name}`, regions: [] });
}
export function groundBounds(points: GroundPoint[]) {
  return {
    min: [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
    ] as GroundPoint,
    max: [
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
    ] as GroundPoint,
  };
}
/** 以选中地块的包围盒中心为编辑参考原点，不修改家具位置。 */
export function landPlan(key?: string): LandPlan | undefined {
  if (!key) return;
  // 整屋蓝图只保存根平面的两轴范围，不能据此猜测社区、户型或私宅外观。
  const match = /^blueprint:([\d.]+):([\d.]+)$/.exec(key);
  if (match) {
    const w = Number(match[1]),
      h = Number(match[2]);
    if (![w, h].every((v) => Number.isFinite(v) && v > 0 && v <= 2000)) return;
    return {
      key,
      name: '蓝图范围',
      areaM2: w * h,
      regions: [],
      points: [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ],
    };
  }
  const p = plans.get(key);
  if (!p) return;
  const b = groundBounds(p.points),
    center = b.min.map((v, i) => (v + b.max[i]) / 2);
  const shift = (v: LandPlot) => ({
    ...v,
    points: v.points.map((p) => [p[0] - center[0], p[1] - center[1]] as GroundPoint),
  });
  return { ...shift(p), regions: p.regions.map(shift) };
}

/** 编辑分区与游戏整屋根平面是不同坐标系；私宅所有分区共享完整宅园范围。 */
export function landBlueprintFrame(key?: string) {
  const selected = landPlan(key);
  if (!selected) throw new Error('含地下室的蓝图需要先选择户型和地块范围');
  const map = landCatalog.maps.find(
    (m) => m.kind === 'private' && (m.whole?.key === key || m.plots.some((p) => p.key === key)),
  );
  const source = map?.plots.find((p) => p.key === key),
    whole = map?.whole,
    b = groundBounds(whole?.points ?? selected.points),
    offset: GroundPoint = [0, 0];
  if (source && whole) {
    const s = groundBounds(source.points);
    for (const axis of [0, 1])
      offset[axis] = (s.min[axis] + s.max[axis] - b.min[axis] - b.max[axis]) / 2;
  }
  return {
    widthM: b.max[0] - b.min[0],
    depthM: b.max[1] - b.min[1],
    offset,
    privateRoot: !!whole,
  };
}
/** 将平面网格线裁剪到凸四边形内，旋转地块也不显示越界网格。 */
export function groundGrid(points: GroundPoint[], step: number): [GroundPoint, GroundPoint][] {
  if (
    !Number.isFinite(step) ||
    step <= 0 ||
    points.length !== 4 ||
    points.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)))
  )
    throw new Error('地块网格参数无效');
  const b = groundBounds(points),
    segments: [GroundPoint, GroundPoint][] = [];
  if ((b.max[0] - b.min[0] + b.max[1] - b.min[1]) / step > 3000) throw new Error('地块网格过密');
  for (const axis of [0, 1])
    for (let v = Math.ceil(b.min[axis] / step) * step; v <= b.max[axis] + 1e-8; v += step) {
      const crossings: number[] = [];
      for (let i = 0; i < 4; i++) {
        const a = points[i],
          c = points[(i + 1) % 4],
          delta = c[axis] - a[axis];
        if (Math.abs(delta) < 1e-9) continue;
        const t = (v - a[axis]) / delta;
        if (t >= -1e-9 && t <= 1 + 1e-9)
          crossings.push(a[1 - axis] + t * (c[1 - axis] - a[1 - axis]));
      }
      if (crossings.length < 2) continue;
      const low = Math.min(...crossings),
        high = Math.max(...crossings);
      if (high - low < 1e-8) continue;
      segments.push(
        axis === 0
          ? [
              [v, low],
              [v, high],
            ]
          : [
              [low, v],
              [high, v],
            ],
      );
    }
  return segments;
}
