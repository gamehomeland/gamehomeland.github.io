import { landPlan, type GroundPoint } from './land.js';
import { basementModelData } from './basement-models.generated.js';
import { rotate, multiply } from './math.js';
import type { Vec3, Quat } from './types.js';

export interface BasementFloorAnchor {
  index: number;
  position: Vec3;
  rotation: Quat;
  sizeM: [number, number];
}
export interface BasementAnchor extends BasementFloorAnchor {
  tags: string[];
}
export interface BasementModelResource {
  brushId: number;
  name: string;
  file: string;
  bytes: number;
  modelSha256: string;
  modelSha256Aliases?: string[];
  variants: {
    index: number;
    letter: string;
    triangles: number;
    planeCount: number;
    anchors: BasementAnchor[];
    floor: BasementFloorAnchor | null;
  }[];
}
export const basementModelResources =
  basementModelData.resources as unknown as BasementModelResource[];
export const basementModelById = new Map(basementModelResources.map((r) => [r.brushId, r]));

/** 从级联笔刷资源表整理；size为完整边长，深度同边长。 */
export const basementResources = [
  { brushId: 74, furnitureId: 2040, name: '木质', size: 4, color: '#b08b61' },
  { brushId: 82, furnitureId: 2149, name: '沧州石', size: 4, color: '#a7b0a8' },
  { brushId: 83, furnitureId: 2150, name: '雪浪石', size: 4, color: '#d6d5ce' },
  { brushId: 84, furnitureId: 2151, name: '石质', size: 4, color: '#a29a91' },
  { brushId: 113, furnitureId: 5466, name: '木质', size: 8, color: '#b08b61' },
  { brushId: 114, furnitureId: 5863, name: '石质', size: 8, color: '#a29a91' },
] as const;
export const basementById = new Map<number, (typeof basementResources)[number]>(
  basementResources.map((r) => [r.brushId, r]),
);
/** 编辑器预算；不代表游戏地下室最大容量或最大深度。 */
export const BASEMENT_LIMITS = Object.freeze({ cells: 512, bottomM: 32, horizontalM: 1000 });
export interface BasementCell {
  id: string;
  brushId: number;
  /** 中心格坐标；分区换算可含四分之一格偏移，顶面Y=-level*size。 */
  x: number;
  z: number;
  level: number;
}
export const basementSize = (cell: BasementCell) => {
  const r = basementById.get(cell.brushId);
  if (!r) throw new Error('未知地下室组件');
  return r.size;
};
export const basementPosition = (cell: BasementCell): [number, number, number] => {
  const size = basementSize(cell);
  return [cell.x * size, -cell.level * size, cell.z * size];
};
/** 重读整屋文件后保持原格点相位；新增单元与同规格已有房间对齐。 */
export function basementGridPhase(cells: BasementCell[], size: number): GroundPoint {
  const c = cells.find((c) => basementSize(c) === size);
  return c ? [c.x - Math.floor(c.x), c.z - Math.floor(c.z)] : [0, 0];
}
/** 当前工作层中，与既有同规格房间接壤且无重叠的扩建格。 */
export function basementExpansionCandidates(
  cells: BasementCell[],
  size: number,
  level: number,
  landKey?: string,
): BasementCell[] {
  const brushId = basementResources.find((r) => r.size === size)?.brushId;
  if (
    !brushId ||
    !Number.isInteger(level) ||
    level < 0 ||
    (level + 1) * size > BASEMENT_LIMITS.bottomM
  )
    return [];
  const candidates = new Map<string, BasementCell>();
  for (const c of cells.filter((c) => basementSize(c) === size))
    for (const [dx, dz, dy] of directions) {
      if (c.level + dy !== level) continue;
      const next = { id: 'candidate', brushId, x: c.x + dx, z: c.z + dz, level };
      if (landKey && !basementInsideLand(next, landKey)) continue;
      if (
        cells.some((other) => {
          const s = basementSize(other),
            half = (size + s) / 2;
          const gaps = [
            Math.abs(next.x * size - other.x * s) - half,
            Math.abs((level + 0.5) * size - (other.level + 0.5) * s) - half,
            Math.abs(next.z * size - other.z * s) - half,
          ];
          return (
            gaps.every((v) => v < -1e-6) ||
            (s !== size &&
              gaps.every((v) => v <= 1e-6) &&
              gaps.filter((v) => v < -1e-6).length >= 2)
          );
        })
      )
        continue;
      candidates.set(`${next.x}:${next.z}`, next);
    }
  return [...candidates.values()].slice(0, 1024);
}
export const basementFootprint = (c: BasementCell): GroundPoint[] => {
  const s = basementSize(c),
    x = c.x * s,
    z = c.z * s,
    h = s / 2;
  return [
    [x - h, z - h],
    [x + h, z - h],
    [x + h, z + h],
    [x - h, z + h],
  ];
};
export function basementInsideLand(c: BasementCell, key: string) {
  const p = landPlan(key);
  if (!p) throw new Error('未知地块范围');
  const a = p.points;
  const sign = Math.sign(
    a.reduce(
      (sum, v, i) => sum + v[0] * a[(i + 1) % a.length][1] - a[(i + 1) % a.length][0] * v[1],
      0,
    ),
  );
  return basementFootprint(c).every((v) =>
    a.every((b, i) => {
      const d = a[(i + 1) % a.length];
      return sign * ((d[0] - b[0]) * (v[1] - b[1]) - (d[1] - b[1]) * (v[0] - b[0])) >= -1e-5;
    }),
  );
}
const keyOf = (c: BasementCell) => `${basementSize(c)}:${c.x}:${c.z}:${c.level}`;
const directions = [
  [0, 1, 0],
  [1, 0, 0],
  [0, -1, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
/** bits 0..5 = +Z,+X,-Z,-X,-Y,+Y；bit6为地表洞口。 */
export function basementMasks(cells: BasementCell[]): Map<string, number> {
  const occupied = new Set(cells.map(keyOf));
  return new Map(
    cells.map((c) => {
      let mask = c.level === 0 ? 64 : 0;
      directions.forEach(([x, z, level], bit) => {
        if (occupied.has(keyOf({ ...c, x: c.x + x, z: c.z + z, level: c.level + level })))
          mask |= 1 << bit;
      });
      return [c.id, mask];
    }),
  );
}
/** 24种六面组合的资源变体；原生创建路径将此旋转设置到级联节点。 */
export function basementVariant(mask: number) {
  const missing = ~(mask | (mask & 64 ? 32 : 0)) & 63;
  const horizontal = missing & 15;
  const groups = [[0], [1, 2, 4, 8], [3, 6, 12, 9], [5, 10], [7, 14, 13, 11], [15]];
  const group = groups.findIndex((values) => values.includes(horizontal));
  const rotation = groups[group].indexOf(horizontal) * 90;
  const index = group + (missing & 16 ? 6 : 0) + (missing & 32 ? 12 : 0);
  return { index, letter: String.fromCharCode(65 + index), rotation };
}
export function basementRotation(mask: number): Quat {
  const angle = (basementVariant(mask).rotation * Math.PI) / 360;
  return [0, Math.sin(angle), 0, Math.cos(angle)];
}
export function basementFloor(
  cell: BasementCell,
  cells: BasementCell[],
  masks = basementMasks(cells),
) {
  const mask = masks.get(cell.id);
  if (mask === undefined) throw new Error('地下室单元不存在');
  const variant = basementVariant(mask),
    anchor = basementModelById.get(cell.brushId)?.variants[variant.index]?.floor;
  if (!anchor) return;
  const q = basementRotation(mask),
    origin = basementPosition(cell),
    offset = rotate(anchor.position, q);
  return {
    cellId: cell.id,
    anchor,
    variant: variant.index,
    position: origin.map((v, i) => v + offset[i]) as Vec3,
    rotation: multiply(q, anchor.rotation),
  };
}
export function validateBasements(
  input: unknown,
  landKey?: string,
  allowDetached = false,
): BasementCell[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > BASEMENT_LIMITS.cells)
    throw new Error('地下室单元数量超出处理范围');
  const ids = new Set<string>(),
    occupied = new Set<string>();
  const cells = input.map((c: BasementCell) => {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,64}$/.test(c.id) || ids.has(c.id))
      throw new Error('地下室实例标识无效或重复');
    ids.add(c.id);
    const size = basementSize(c);
    if (
      ![c.x, c.z].every((v) => Number.isFinite(v) && Number.isInteger(v * 4)) ||
      !Number.isInteger(c.level) ||
      c.level < 0 ||
      (c.level + 1) * size > BASEMENT_LIMITS.bottomM ||
      Math.max(Math.abs(c.x * size), Math.abs(c.z * size)) > BASEMENT_LIMITS.horizontalM
    )
      throw new Error('地下室格点或层深无效');
    const key = keyOf(c);
    if (occupied.has(key)) throw new Error('地下室单元重复');
    occupied.add(key);
    if (landKey && !basementInsideLand(c, landKey)) throw new Error('地下室单元超出所选地块边界');
    return { id: c.id, brushId: c.brushId, x: c.x, z: c.z, level: c.level };
  });
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i],
        b = cells[j],
        sa = basementSize(a),
        sb = basementSize(b);
      const overlaps = [
        Math.abs(a.x * sa - b.x * sb) - (sa + sb) / 2,
        Math.abs((a.level + 0.5) * sa - (b.level + 0.5) * sb) - (sa + sb) / 2,
        Math.abs(a.z * sa - b.z * sb) - (sa + sb) / 2,
      ];
      if (sa === sb) {
        if (overlaps.every((v) => v < -1e-6)) throw new Error('地下室单元相互重叠');
        if (
          overlaps.every((v) => v <= 1e-6) &&
          overlaps.filter((v) => v < -1e-6).length >= 2 &&
          (!Number.isInteger(a.x - b.x) || !Number.isInteger(a.z - b.z))
        )
          throw new Error('相邻地下室必须对齐同一组件格点');
        continue;
      }
      if (overlaps.every((v) => v <= 1e-6) && overlaps.filter((v) => v < -1e-6).length >= 2)
        throw new Error('4米与8米组件不能重叠或直接连通，请分区留出间隔');
    }
  const byKey = new Map(cells.map((c) => [keyOf(c), c]));
  const seen = new Set<string>(),
    queue = cells.filter((c) => c.level === 0);
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    for (const [x, z, level] of directions) {
      const n = byKey.get(keyOf({ ...c, x: c.x + x, z: c.z + z, level: c.level + level }));
      if (n && !seen.has(n.id)) queue.push(n);
    }
  }
  if (!allowDetached && seen.size !== cells.length)
    throw new Error('地下单元必须连通地表洞口，请先挖通上层或相邻通道');
  return cells;
}
export function editBasement(
  cells: BasementCell[],
  cell: BasementCell,
  action: 'dig' | 'fill',
  landKey?: string,
  allowDetached = false,
) {
  const key = keyOf(cell),
    previous = cells.find((c) => keyOf(c) === key);
  if (action === 'fill' && !previous) throw new Error('此规格与工作层的格子尚未挖掘');
  const next =
    action === 'fill'
      ? cells.filter((c) => keyOf(c) !== key)
      : previous
        ? cells.map((c) => (c.id === previous.id ? { ...cell, id: previous.id } : c))
        : [...cells, cell];
  try {
    return validateBasements(next, landKey, allowDetached);
  } catch (error) {
    if (action === 'fill' && error instanceof Error && error.message.includes('连通地表'))
      throw new Error('回填会切断地下通道，请先回填依赖此洞口的下层单元');
    throw error;
  }
}

/** 将凸地块按矩形洞口分割为互不重叠的凸多边形，包含贴边及相邻洞口。 */
export function cutBasementGround(polygon: GroundPoint[], cells: BasementCell[]): GroundPoint[][] {
  let pieces = [polygon];
  const clip = (poly: GroundPoint[], axis: number, value: number, positive: boolean) => {
    const out: GroundPoint[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      const da = (a[axis] - value) * (positive ? 1 : -1),
        db = (b[axis] - value) * (positive ? 1 : -1);
      if (da >= -1e-9) out.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    const area = Math.abs(
      out.reduce(
        (sum, a, i) =>
          sum + a[0] * out[(i + 1) % out.length][1] - out[(i + 1) % out.length][0] * a[1],
        0,
      ),
    );
    return area > 1e-8 ? out : [];
  };
  for (const c of cells.filter((c) => c.level === 0)) {
    const p = basementFootprint(c),
      next: GroundPoint[][] = [];
    for (const poly of pieces) {
      let inside = poly;
      for (const [axis, value, positive] of [
        [0, p[0][0], true],
        [0, p[2][0], false],
        [1, p[0][1], true],
        [1, p[2][1], false],
      ] as const) {
        const outside = clip(inside, axis, value, !positive);
        if (outside.length) next.push(outside);
        inside = clip(inside, axis, value, positive);
        if (!inside.length) break;
      }
    }
    pieces = next;
  }
  return pieces;
}
