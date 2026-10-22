import { editorCatalogData } from './editor-catalog.generated.js';
import { decodeBlueprint, encodeBlueprint } from './codec.js';
import type { BlueprintNode, Quat, Vec3 } from './types.js';
import { zipSync, strToU8 } from 'fflate';
import { rotate, multiply } from './math.js';
import { mergeWholeBlueprint } from './blueprint-merge.js';
import { landPlan, groundBounds, landBlueprintFrame, type GroundPoint } from './land.js';
import {
  validateBasements,
  basementById,
  basementMasks,
  basementPosition,
  basementSize,
  basementFloor,
  basementRotation,
  basementModelById,
  basementVariant,
  cutBasementGround,
  type BasementCell,
} from './basement.js';

export interface EditorResource {
  key: string;
  name: string;
  category: string;
  representId: number;
  furnitureType: number;
  furnitureId: number;
  defaultDetail: number;
  details: number[];
  nonUniform: boolean;
  scaleRanges: number[][];
  freeRotation: boolean;
  heightRangeM: number[] | null;
  modelSha256: string;
  modelSha256Aliases?: string[];
  detailNames?: string[];
  sourceMeshSha256: string;
  boundsMin: number[];
  boundsMax: number[];
  triangles: number;
  resourcePath: string;
}
export const editorResources = editorCatalogData.resources as EditorResource[];
export const editorResourceByKey = new Map(editorResources.map((r) => [r.key, r]));
export const editorResourceByHash = new Map(
  editorResources.flatMap((r) =>
    [r.modelSha256, ...(r.modelSha256Aliases ?? [])].map((hash) => [hash, r] as const),
  ),
);
const byRepresent = new Map(editorResources.map((r) => [r.representId, r]));
const scaleRules = {
  nonUniformResources: new Set(
    editorResources.filter((r) => r.nonUniform).map((r) => r.representId),
  ),
};
export const SCENE_LIMITS = Object.freeze({
  objects: 2000,
  triangles: 3_000_000,
  projectBytes: 2_000_000,
  horizontalM: 1000,
});

export interface SceneItem {
  id: string;
  resourceKey: string;
  detail: number;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  /** 编辑位置/朝向保持世界米制，导出时转换到此地下室的真实地板挂面。 */
  basementId?: string;
}
export interface SceneDocument {
  format: 'homeland-layout';
  version: 1;
  name: string;
  items: SceneItem[];
  landKey?: string;
  basements?: BasementCell[];
  /** 新增深层单元依赖原整屋连接；只允许合并导出。 */
  basementMergeOnly?: true;
}
export const emptyScene = (): SceneDocument => ({
  format: 'homeland-layout',
  version: 1,
  name: '我的布置',
  items: [],
});

export function sceneItemFootprint(item: SceneItem): GroundPoint[] {
  const r = editorResourceByKey.get(item.resourceKey);
  if (!r) throw new Error('未知家具资源');
  const points: GroundPoint[] = [];
  for (const x of [r.boundsMin[0], r.boundsMax[0]])
    for (const y of [r.boundsMin[1], r.boundsMax[1]])
      for (const z of [r.boundsMin[2], r.boundsMax[2]]) {
        const p = rotate([x * item.scale[0], y * item.scale[1], z * item.scale[2]], item.rotation);
        points.push([p[0] + item.position[0], p[2] + item.position[2]]);
      }
  return points;
}
export function sceneItemFloor(item: SceneItem, cells: BasementCell[]) {
  if (item.basementId === undefined) return;
  const cell = cells.find((c) => c.id === item.basementId);
  if (!cell) throw new Error('家具所属的地下室已不存在，请先移走家具');
  const floor = basementFloor(cell, cells);
  if (!floor) throw new Error('此地下室地板承载家具，不能继续向下挖掘；请先移动家具');
  return floor;
}
export function sceneItemHeightRange(item: SceneItem, cells: BasementCell[]): number[] | null {
  const origin = sceneItemFloor(item, cells)?.position[1] ?? 0;
  return editorResourceByKey.get(item.resourceKey)?.heightRangeM?.map((v) => v + origin) ?? null;
}
function footprintHull(item: SceneItem): GroundPoint[] {
  const pts = sceneItemFootprint(item).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: GroundPoint, b: GroundPoint, c: GroundPoint) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const build = (p: GroundPoint[]) => {
    const a: GroundPoint[] = [];
    for (const v of p) {
      while (a.length > 1 && cross(a[a.length - 2], a[a.length - 1], v) <= 1e-9) a.pop();
      a.push(v);
    }
    return a.slice(0, -1);
  };
  return [...build(pts), ...build([...pts].reverse())];
}
export function sceneItemInsideBasement(item: SceneItem, cells: BasementCell[]): boolean {
  if (!item.basementId) return true;
  const floor = sceneItemFloor(item, cells)!,
    cell = cells.find((c) => c.id === item.basementId)!;
  const masks = basementMasks(cells);
  const available = cells.filter(
    (c) =>
      c.level === cell.level &&
      basementSize(c) === basementSize(cell) &&
      basementFloor(c, cells, masks),
  );
  const byGrid = new Map(available.map((c) => [`${c.x}:${c.z}`, c]));
  const connected = [cell],
    seen = new Set([cell.id]);
  for (let i = 0; i < connected.length; i++)
    for (const [dx, dz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const c = byGrid.get(`${connected[i].x + dx}:${connected[i].z + dz}`);
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        connected.push(c);
      }
    }
  // 以整个旋转包围框投影检查，避免家具四角都落在地板上但中部跨过洞口。
  const rest = cutBasementGround(
    footprintHull(item),
    connected.map((c) => ({ ...c, level: 0 })),
  );
  const area = rest.reduce(
    (total, p) =>
      total +
      Math.abs(
        p.reduce(
          (sum, a, i) => sum + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1],
          0,
        ),
      ) /
        2,
    0,
  );
  return area < 1e-5 && Number.isFinite(floor.position[1]);
}
export function placeSceneItem(
  item: SceneItem,
  doc: SceneDocument,
  basementId?: string,
): SceneItem {
  const result = structuredClone(item);
  if (basementId) result.basementId = basementId;
  else delete result.basementId;
  const floor = sceneItemFloor(result, doc.basements ?? []);
  if (floor) {
    result.position[0] = floor.position[0];
    result.position[2] = floor.position[2];
  }
  const r = editorResourceByKey.get(result.resourceKey)!;
  let low = Infinity;
  for (const x of [r.boundsMin[0], r.boundsMax[0]])
    for (const y of [r.boundsMin[1], r.boundsMax[1]])
      for (const z of [r.boundsMin[2], r.boundsMax[2]])
        low = Math.min(
          low,
          rotate([x * item.scale[0], y * item.scale[1], z * item.scale[2]], item.rotation)[1],
        );
  result.position[1] = (floor?.position[1] ?? 0) - low;
  if (floor) {
    const occupied = doc.items
      .filter(
        (other) =>
          other.id !== item.id &&
          other.basementId &&
          Math.abs(
            (sceneItemFloor(other, doc.basements ?? [])?.position[1] ?? Infinity) -
              floor.position[1],
          ) < 1e-4,
      )
      .map((other) => groundBounds(sceneItemFootprint(other)));
    const base = [result.position[0], result.position[2]],
      initial = groundBounds(sceneItemFootprint(result));
    const step = Math.max(
      0.5,
      Math.min(initial.max[0] - initial.min[0], initial.max[1] - initial.min[1]) * 0.5 + 0.15,
    );
    for (let radius = 0; radius < 14; radius++)
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (radius && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          result.position[0] = base[0] + dx * step;
          result.position[2] = base[1] + dz * step;
          const b = groundBounds(sceneItemFootprint(result));
          if (
            occupied.some(
              (a) =>
                b.max[0] + 0.1 > a.min[0] &&
                b.min[0] - 0.1 < a.max[0] &&
                b.max[1] + 0.1 > a.min[1] &&
                b.min[1] - 0.1 < a.max[1],
            )
          )
            continue;
          if (sceneItemInsideBasement(result, doc.basements ?? [])) return result;
        }
    throw new Error('地下室没有可自动放下此家具的空位，请先调整布置或扩建');
  }
  return result;
}
function landPlanes(key: string) {
  const plan = landPlan(key);
  if (!plan) throw new Error('未知地块范围');
  const points = plan.points;
  const sign = Math.sign(
    points.reduce(
      (sum, p, i) =>
        sum + p[0] * points[(i + 1) % points.length][1] - points[(i + 1) % points.length][0] * p[1],
      0,
    ),
  );
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz),
      nx = (-dz / length) * sign,
      nz = (dx / length) * sign;
    return { nx, nz, c: nx * a[0] + nz * a[1] };
  });
}
export function sceneItemInsideLand(item: SceneItem, key: string) {
  const footprint = sceneItemFootprint(item);
  return landPlanes(key).every((p) =>
    footprint.every((v) => p.nx * v[0] + p.nz * v[1] >= p.c - 1e-4),
  );
}
/** 求家具完整投影可容纳的锚点区域，将拖动位置投影到最近的合法点。 */
export function constrainSceneItem(item: SceneItem, key: string): SceneItem {
  const plan = landPlan(key);
  if (!plan) throw new Error('未知地块范围');
  const offsets = sceneItemFootprint({ ...item, position: [0, item.position[1], 0] });
  const planes = landPlanes(key).map((p) => ({
    ...p,
    c: p.c - Math.min(...offsets.map((v) => p.nx * v[0] + p.nz * v[1])),
  }));
  const bounds = groundBounds(plan.points),
    extend = Math.max(...offsets.flat().map(Math.abs)) + 1;
  let feasible: GroundPoint[] = [
    [bounds.min[0] - extend, bounds.min[1] - extend],
    [bounds.max[0] + extend, bounds.min[1] - extend],
    [bounds.max[0] + extend, bounds.max[1] + extend],
    [bounds.min[0] - extend, bounds.max[1] + extend],
  ];
  for (const p of planes) {
    const clipped: GroundPoint[] = [];
    for (let i = 0; i < feasible.length; i++) {
      const a = feasible[i],
        b = feasible[(i + 1) % feasible.length],
        da = p.nx * a[0] + p.nz * a[1] - p.c,
        db = p.nx * b[0] + p.nz * b[1] - p.c;
      if (da >= -1e-9) clipped.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    feasible = clipped;
  }
  if (!feasible.length) throw new Error('家具当前尺寸或朝向超出地块可容纳范围');
  if (sceneItemInsideLand(item, key)) return structuredClone(item);
  const point: GroundPoint = [item.position[0], item.position[2]];
  let best = feasible[0],
    distance = Infinity;
  for (let i = 0; i < feasible.length; i++) {
    const a = feasible[i],
      b = feasible[(i + 1) % feasible.length],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = dx * dx + dz * dz;
    const t = length
      ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length))
      : 0;
    const candidate: GroundPoint = [a[0] + dx * t, a[1] + dz * t],
      d = Math.hypot(candidate[0] - point[0], candidate[1] - point[1]);
    if (d < distance) {
      best = candidate;
      distance = d;
    }
  }
  const result = structuredClone(item);
  result.position[0] = best[0];
  result.position[2] = best[1];
  if (!sceneItemInsideLand(result, key)) throw new Error('无法在地块内放置当前家具');
  return result;
}
export function suggestScenePosition(key: string, doc: SceneDocument, basementId?: string): Vec3 {
  const resource = editorResourceByKey.get(key);
  if (!resource) throw new Error('未知家具资源');
  const rectangles = doc.items
    .filter((item) => item.basementId === basementId)
    .map((item) => {
      const r = editorResourceByKey.get(item.resourceKey)!,
        min = [Infinity, Infinity],
        max = [-Infinity, -Infinity];
      for (const x of [r.boundsMin[0], r.boundsMax[0]])
        for (const y of [r.boundsMin[1], r.boundsMax[1]])
          for (const z of [r.boundsMin[2], r.boundsMax[2]]) {
            const p = rotate(
              [x * item.scale[0], y * item.scale[1], z * item.scale[2]],
              item.rotation,
            );
            min[0] = Math.min(min[0], p[0] + item.position[0]);
            max[0] = Math.max(max[0], p[0] + item.position[0]);
            min[1] = Math.min(min[1], p[2] + item.position[2]);
            max[1] = Math.max(max[1], p[2] + item.position[2]);
          }
      return { min, max };
    });
  const stepX = Math.max(1, resource.boundsMax[0] - resource.boundsMin[0]) + 0.5;
  const stepZ = Math.max(1, resource.boundsMax[2] - resource.boundsMin[2]) + 0.5;
  const support = basementId
    ? sceneItemFloor({ basementId } as SceneItem, doc.basements ?? [])
    : undefined;
  const y =
    (support?.position[1] ?? 0) +
    Math.min(
      resource.heightRangeM?.[1] ?? 1000,
      Math.max(resource.heightRangeM?.[0] ?? -1000, -resource.boundsMin[1]),
    );
  const zigzag = (v: number) => (v === 0 ? 0 : (v % 2 === 1 ? 1 : -1) * Math.ceil(v / 2));
  for (let row = 0; row < 80; row++)
    for (let col = 0; col < 80; col++) {
      const x = (support?.position[0] ?? 0) + zigzag(col) * stepX,
        z = (support?.position[2] ?? 0) + zigzag(row) * stepZ;
      if (
        basementId &&
        !sceneItemInsideBasement(
          {
            id: 'candidate',
            resourceKey: key,
            detail: resource.defaultDetail,
            position: [x, y, z],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            basementId,
          },
          doc.basements ?? [],
        )
      )
        continue;
      if (
        doc.landKey &&
        !sceneItemInsideLand(
          {
            id: 'candidate',
            resourceKey: key,
            detail: resource.defaultDetail,
            position: [x, y, z],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          doc.landKey,
        )
      )
        continue;
      const minX = x + resource.boundsMin[0] - 0.25,
        maxX = x + resource.boundsMax[0] + 0.25,
        minZ = z + resource.boundsMin[2] - 0.25,
        maxZ = z + resource.boundsMax[2] + 0.25;
      if (
        rectangles.every(
          (r) => maxX < r.min[0] || minX > r.max[0] || maxZ < r.min[1] || minZ > r.max[1],
        )
      )
        return [x, y, z];
    }
  throw new Error('自动放置区域已满，请先移动或整理现有家具');
}
const vector = (value: unknown, n: number) =>
  Array.isArray(value) &&
  value.length === n &&
  value.every((v) => typeof v === 'number' && Number.isFinite(v));

/** 编辑目录是资源身份及限制的依据，不能从任意GLB外形猜游戏编号。 */
export function validateScene(input: unknown): SceneDocument {
  const doc = input as SceneDocument;
  if (
    !doc ||
    doc.format !== 'homeland-layout' ||
    doc.version !== 1 ||
    typeof doc.name !== 'string' ||
    doc.name.length > 80 ||
    !Array.isArray(doc.items) ||
    doc.items.length > SCENE_LIMITS.objects
  )
    throw new Error('布置工程格式或数量无效');
  const ids = new Set<string>();
  if (doc.landKey !== undefined && (typeof doc.landKey !== 'string' || !landPlan(doc.landKey)))
    throw new Error('工程中的地块范围无效');
  if (doc.basementMergeOnly !== undefined && doc.basementMergeOnly !== true)
    throw new Error('地下室合并模式无效');
  const basements = validateBasements(doc.basements, doc.landKey, doc.basementMergeOnly);
  if (doc.items.length + basements.length > SCENE_LIMITS.objects)
    throw new Error('场景对象数量超出处理范围');
  for (const c of basements) ids.add(c.id);
  let triangles = 0;
  const items = doc.items.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id) || ids.has(item.id))
      throw new Error('家具实例标识无效或重复');
    ids.add(item.id);
    const resource = editorResourceByKey.get(item.resourceKey);
    if (!resource) throw new Error('工程中存在尚未支持导出的家具资源');
    if (!resource.details.includes(item.detail)) throw new Error(`${resource.name}的样式无效`);
    if (!vector(item.position, 3) || !vector(item.rotation, 4) || !vector(item.scale, 3))
      throw new Error('家具位置、旋转或缩放无效');
    const [x, y, z] = item.position;
    if (
      Math.abs(x) > SCENE_LIMITS.horizontalM ||
      Math.abs(z) > SCENE_LIMITS.horizontalM ||
      Math.abs(y) > 1000
    )
      throw new Error('家具位置超出编辑器处理范围');
    if (item.basementId !== undefined && typeof item.basementId !== 'string')
      throw new Error('家具所属地下室无效');
    const heightRange = sceneItemHeightRange(item, basements);
    if (heightRange && (y < heightRange[0] - 1e-5 || y > heightRange[1] + 1e-5))
      throw new Error(`${resource.name}的位置高度应在 ${heightRange.join('～')} 米`);
    const norm = Math.hypot(...item.rotation);
    if (Math.abs(norm - 1) > 1e-4) throw new Error('家具旋转不是单位四元数');
    if (
      !resource.freeRotation &&
      (Math.abs(item.rotation[0]) > 1e-5 || Math.abs(item.rotation[2]) > 1e-5)
    )
      throw new Error(`${resource.name}仅支持水平旋转`);
    item.scale.forEach((v, i) => {
      if (v < resource.scaleRanges[i][0] - 1e-6 || v > resource.scaleRanges[i][1] + 1e-6)
        throw new Error(`${resource.name}的缩放超出允许范围`);
    });
    if (
      !resource.nonUniform &&
      (Math.abs(item.scale[0] - item.scale[1]) > 1e-6 ||
        Math.abs(item.scale[0] - item.scale[2]) > 1e-6)
    )
      throw new Error(`${resource.name}不支持分轴缩放`);
    if (doc.landKey && !sceneItemInsideLand(item, doc.landKey))
      throw new Error(`${resource.name}超出所选地块边界，请先调整位置、朝向或尺寸`);
    if (!sceneItemInsideBasement(item, basements))
      throw new Error(`${resource.name}超出相连地下室的地板范围，请先扩建或缩小家具`);
    triangles += resource.triangles;
    return {
      ...item,
      position: [...item.position] as Vec3,
      rotation: [...item.rotation] as Quat,
      scale: [...item.scale] as Vec3,
    };
  });
  if (triangles > SCENE_LIMITS.triangles) throw new Error('场景几何过多，请拆分为多个局部组件');
  return {
    format: 'homeland-layout',
    version: 1,
    name: doc.name,
    items,
    ...(doc.landKey ? { landKey: doc.landKey } : {}),
    ...(basements.length ? { basements } : {}),
    ...(doc.basementMergeOnly ? { basementMergeOnly: true as const } : {}),
  };
}
export function readSceneProject(bytes: Uint8Array): SceneDocument {
  if (bytes.length > SCENE_LIMITS.projectBytes) throw new Error('布置工程超过大小限制');
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('布置工程不是有效的JSON文件');
  }
  return validateScene(doc);
}
export function writeSceneProject(doc: SceneDocument): Uint8Array {
  return strToU8(JSON.stringify(validateScene(doc), null, 2) + '\n');
}
export function sceneMaterials(input: SceneDocument) {
  const doc = validateScene(input),
    items = new Map<
      string,
      { name: string; type: number; id: number; detail: number; count: number }
    >();
  for (const item of doc.items) {
    const r = editorResourceByKey.get(item.resourceKey)!,
      key = `${r.furnitureType}:${r.furnitureId}:${item.detail}`;
    const row = items.get(key) ?? {
      name: r.name,
      type: r.furnitureType,
      id: r.furnitureId,
      detail: item.detail,
      count: 0,
    };
    row.count++;
    items.set(key, row);
  }
  for (const c of doc.basements ?? []) {
    const r = basementById.get(c.brushId)!,
      key = `1:${r.furnitureId}:0`;
    const row = items.get(key) ?? {
      name: `地下室·${r.name}·${r.size}米`,
      type: 1,
      id: r.furnitureId,
      detail: 0,
      count: 0,
    };
    row.count++;
    items.set(key, row);
  }
  return [...items.values()];
}

/** 无地表/植被绘制的整屋头。级联笔刷直接属于根平面，不挂入局部Holder。 */
function basementSceneHeader(doc: SceneDocument, nextId: number): Uint8Array {
  const frame = landBlueprintFrame(doc.landKey),
    bytes = new Uint8Array(222),
    v = new DataView(bytes.buffer);
  v.setUint8(0, 1);
  v.setUint32(1, 7, true);
  v.setFloat32(5, frame.widthM * 50, true);
  v.setFloat32(9, frame.depthM * 50, true);
  const positions: Vec3[] = [];
  for (const item of doc.items) {
    const r = editorResourceByKey.get(item.resourceKey)!;
    for (const x of [r.boundsMin[0], r.boundsMax[0]])
      for (const y of [r.boundsMin[1], r.boundsMax[1]])
        for (const z of [r.boundsMin[2], r.boundsMax[2]]) {
          const p = rotate(
            [x * item.scale[0], y * item.scale[1], z * item.scale[2]],
            item.rotation,
          );
          positions.push(p.map((n, i) => n + item.position[i]) as Vec3);
        }
  }
  for (const c of doc.basements ?? []) {
    const [x, y, z] = basementPosition(c),
      s = basementSize(c);
    positions.push([x - s / 2, y - s, z - s / 2], [x + s / 2, y, z + s / 2]);
  }
  for (let i = 0; i < 3; i++) {
    const delta = i === 0 ? frame.offset[0] : i === 2 ? frame.offset[1] : 0;
    v.setFloat32(13 + i * 4, Math.min(...positions.map((p) => p[i] + delta)) * 100, true);
    v.setFloat32(25 + i * 4, Math.max(...positions.map((p) => p[i] + delta)) * 100, true);
  }
  v.setUint32(37, nextId, true);
  v.setUint32(46, 2, true);
  v.setUint32(50, 3, true);
  // 空绘制层仍携带根平面的采样尺寸与变换；不写原有涂绘及植被内容。
  v.setUint32(54, Math.round(frame.widthM * 4), true);
  v.setUint32(58, Math.round(frame.depthM * 4), true);
  v.setFloat32(62, frame.depthM / 2, true);
  v.setFloat32(66, 5, true);
  v.setFloat32(70, frame.widthM / 2, true);
  v.setFloat32(78, Math.SQRT1_2, true);
  v.setFloat32(86, Math.SQRT1_2, true);
  for (const offset of [182, 186, 190, 206]) v.setFloat32(offset, 1, true);
  for (let i = 0; i < 3; i++) v.setUint32(110 + i * 21, i, true);
  v.setUint32(165, 1, true);
  v.setUint32(169, Math.round(frame.widthM * 2), true);
  v.setUint32(173, Math.round(frame.depthM * 2), true);
  return bytes;
}

export function exportSceneBlueprint(
  input: SceneDocument,
  options: { forMerge?: boolean } = {},
): Uint8Array {
  const doc = validateScene(input),
    cells = doc.basements ?? [],
    masks = basementMasks(cells),
    frame = cells.length ? landBlueprintFrame(doc.landKey) : undefined,
    rootOffset: Vec3 = frame ? [frame.offset[0], 0, frame.offset[1]] : [0, 0, 0];
  if (!options.forMerge) validateBasements(cells, doc.landKey);
  if (!doc.items.length && !cells.length) throw new Error('先添加家具或地下室，再导出蓝图');
  const modelNode = (item: SceneItem, i: number): BlueprintNode => {
    const r = editorResourceByKey.get(item.resourceKey)!,
      floor = sceneItemFloor(item, cells);
    const inverse = floor
      ? ([-floor.rotation[0], -floor.rotation[1], -floor.rotation[2], floor.rotation[3]] as Quat)
      : undefined;
    const position = floor
      ? rotate(item.position.map((v, j) => v - floor.position[j]) as Vec3, inverse!)
      : item.position.map((v, j) => v + rootOffset[j]);
    const rotation = floor ? multiply(inverse!, item.rotation) : item.rotation;
    return {
      type: 0,
      flags: 0,
      instanceId: i + 1,
      representId: r.representId,
      builtin: 0,
      detail: item.detail,
      transform: [
        r.nonUniform ? 1 : item.scale[0],
        ...rotation,
        ...position.map((v) => v * 100),
      ] as BlueprintNode['transform'],
      ...(r.nonUniform ? { axisScale: [...item.scale] as Vec3 } : {}),
      children: [],
    };
  };
  const modelNodes = doc.items.map(modelNode);
  const nodes = modelNodes.filter((_, i) => !doc.items[i].basementId);
  for (const [i, c] of cells.entries()) {
    const mask = masks.get(c.id)!,
      floor = basementFloor(c, cells);
    const children = modelNodes.filter((_, j) => doc.items[j].basementId === c.id);
    const variant = basementModelById.get(c.brushId)!.variants[basementVariant(mask).index];
    const planes: BlueprintNode[] = Array.from({ length: variant.planeCount }, (_, index) => {
      if (children.length && index === floor!.anchor.index)
        return {
          type: 5 as const,
          index,
          transform: [
            1,
            ...floor!.anchor.rotation,
            ...floor!.anchor.position.map((v) => v * 100),
          ] as BlueprintNode['transform'],
          children,
        };
      return { type: 5 as const, index, children: [] };
    });
    nodes.push({
      type: 9,
      instanceId: doc.items.length + i + 1,
      brushId: c.brushId,
      mask,
      cascadeState: 1,
      children: planes,
      transform: [
        1,
        ...basementRotation(mask),
        ...basementPosition(c).map((v, j) => (v + rootOffset[j]) * 100),
      ] as BlueprintNode['transform'],
    });
  }
  const bytes = encodeBlueprint(
    cells.length
      ? {
          global: true,
          prefix: basementSceneHeader(doc, doc.items.length + cells.length + 1),
          root: { type: 5, index: 0, transform: [1, 0, 0, 0, 1, 0, 0, 0], children: nodes },
        }
      : {
          global: false,
          root: {
            type: 8,
            flags: 0,
            instanceId: doc.items.length + 1,
            representId: 0xffffffff,
            builtin: 0,
            detail: 0,
            transform: [1, 0, 0, 0, 1, 0, 0, 0],
            children: nodes,
          },
        },
  );
  const restored = importSceneBlueprint(bytes, doc.name, doc.landKey, options.forMerge);
  if (doc.landKey) {
    restored.landKey = doc.landKey;
    validateScene(restored);
  }
  if (
    restored.items.length !== doc.items.length ||
    (restored.basements?.length ?? 0) !== cells.length
  )
    throw new Error('导出对象数量校验失败');
  const parentIds = new Map<string, string>();
  cells.forEach((a, i) => {
    const b = restored.basements![i];
    if (a.brushId !== b.brushId || a.x !== b.x || a.z !== b.z || a.level !== b.level)
      throw new Error('地下室回读校验失败');
    parentIds.set(a.id, b.id);
  });
  doc.items.forEach((a, i) => {
    const b = restored.items[i];
    if (
      a.resourceKey !== b.resourceKey ||
      a.detail !== b.detail ||
      parentIds.get(a.basementId!) !== b.basementId ||
      ['position', 'rotation', 'scale'].some((key) =>
        (a[key as 'position'] as number[]).some(
          (v, j) => Math.abs(v - b[key as 'position'][j]) > Math.max(2e-5, Math.abs(v) * 2e-7),
        ),
      )
    )
      throw new Error('导出变换或地下室挂接回读校验失败');
  });
  return bytes;
}
export function importSceneBlueprint(
  bytes: Uint8Array,
  name = '导入的布置',
  targetLandKey?: string,
  forMerge = false,
): SceneDocument {
  const parsed = decodeBlueprint(bytes, scaleRules),
    root = parsed.root,
    identity = [1, 0, 0, 0, 1, 0, 0, 0];
  if (
    (parsed.global
      ? root.type !== 5 || root.index !== 0
      : root.type !== 8 || root.representId !== 0xffffffff) ||
    root.axisScale ||
    !root.transform?.every((v, i) =>
      parsed.global && i >= 5 ? Number.isFinite(v) : Math.abs(v - identity[i]) < 1e-6,
    ) ||
    root.flags ||
    root.builtin
  )
    throw new Error('暂仅支持本编辑器导出的家具布置与地下室场景');
  let landKey = targetLandKey;
  let rootOffset: Vec3 = [0, 0, 0];
  if (parsed.global) {
    const h = new DataView(parsed.prefix!.buffer, parsed.prefix!.byteOffset),
      width = h.getFloat32(5, true) / 50,
      depth = h.getFloat32(9, true) / 50;
    const target = targetLandKey ? landBlueprintFrame(targetLandKey) : undefined;
    if (
      target &&
      Math.abs(target.widthM - width) < 0.001 &&
      Math.abs(target.depthM - depth) < 0.001
    )
      rootOffset = [target.offset[0], 0, target.offset[1]];
    else {
      const selected = targetLandKey ? landPlan(targetLandKey) : undefined,
        b = selected ? groundBounds(selected.points) : undefined;
      // 旧文件只写选中分区尺寸。仅在用户明确选择匹配范围时恢复分区，不猜测归属。
      if (
        !b ||
        Math.abs(b.max[0] - b.min[0] - width) > 0.001 ||
        Math.abs(b.max[1] - b.min[1] - depth) > 0.001
      )
        landKey = `blueprint:${width}:${depth}`;
    }
  }
  const ids = new Set([root.instanceId]),
    cells: BasementCell[] = [],
    brushNodes = root.children.filter((n) => n.type === 9);
  for (const node of brushNodes) {
    const r = basementById.get(node.brushId!),
      t = node.transform;
    if (
      !parsed.global ||
      !r ||
      !t ||
      t[0] !== 1 ||
      node.cascadeState !== 1 ||
      node.instanceId === undefined ||
      ids.has(node.instanceId) ||
      node.axisScale
    )
      throw new Error('地下室蓝图包含未支持的变换或挂接结构');
    ids.add(node.instanceId);
    const coords = [
      (t[5] / 100 - rootOffset[0]) / r.size,
      (t[7] / 100 - rootOffset[2]) / r.size,
      -t[6] / (r.size * 100),
    ];
    if (
      coords.some((v, i) => Math.abs(v * (i < 2 ? 4 : 1) - Math.round(v * (i < 2 ? 4 : 1))) > 1e-5)
    )
      throw new Error('地下室未对齐组件格点');
    cells.push({
      id: `basement-${node.instanceId}`,
      brushId: r.brushId,
      x: Math.round(coords[0] * 4) / 4 || 0,
      z: Math.round(coords[1] * 4) / 4 || 0,
      level: Math.round(coords[2]) || 0,
    });
  }
  const masks = basementMasks(cells);
  const sameQ = (a: number[], b: number[]) =>
    Math.min(
      Math.max(...a.map((v, i) => Math.abs(v - b[i]))),
      Math.max(...a.map((v, i) => Math.abs(v + b[i]))),
    ) < 1e-5;
  brushNodes.forEach((node, i) => {
    if (node.mask !== masks.get(cells[i].id)) throw new Error('地下室邻接掩码与布局不一致');
    const q = node.transform!.slice(1, 5),
      canonical = basementRotation(node.mask!);
    // 兼容旧结构版的空子树；再导出时修复旧版遗漏的模型旋转。
    if (!sameQ(q, canonical) && !(node.children.length === 0 && sameQ(q, [0, 0, 0, 1])))
      throw new Error('地下室旋转与连通形态不一致');
  });
  const modelEntries: { node: BlueprintNode; cell?: BasementCell }[] = [];
  for (const node of root.children) if (node.type !== 9) modelEntries.push({ node });
  brushNodes.forEach((node, i) => {
    if (!node.children.length) return;
    const c = cells[i],
      floor = basementFloor(c, cells),
      variant = basementModelById.get(c.brushId)!.variants[basementVariant(node.mask!).index],
      nonempty = node.children.filter((p) => p.children.length),
      plane = nonempty[0];
    const indices = new Set<number>();
    for (const p of node.children) {
      if (
        p.type !== 5 ||
        p.index === undefined ||
        p.index >= variant.planeCount ||
        indices.has(p.index)
      )
        throw new Error('地下室挂面编号与资源定义不一致');
      indices.add(p.index);
    }
    if (!nonempty.length) return;
    if (
      !floor ||
      nonempty.length !== 1 ||
      plane.type !== 5 ||
      plane.index !== floor.anchor.index ||
      !plane.children.length ||
      !plane.transform ||
      plane.axisScale
    )
      throw new Error('未支持的地下室挂面或子树');
    const expected = [1, ...floor.anchor.rotation, ...floor.anchor.position.map((v) => v * 100)];
    if (
      plane.transform.some(
        (v, j) => Math.abs(v - expected[j]) > Math.max(0.001, Math.abs(v) * 2e-7),
      )
    )
      throw new Error('地下室挂面变换与资源定义不一致');
    for (const child of plane.children) modelEntries.push({ node: child, cell: c });
  });
  const items = modelEntries
    .sort((a, b) => (a.node.instanceId ?? 0) - (b.node.instanceId ?? 0))
    .map(({ node, cell }): SceneItem => {
      const r = byRepresent.get(node.representId!);
      if (
        node.type !== 0 ||
        !r ||
        node.children.length ||
        node.flags ||
        node.builtin ||
        !node.transform ||
        node.instanceId === undefined ||
        ids.has(node.instanceId)
      )
        throw new Error('蓝图包含未支持的家具或挂接结构，未丢弃或改写原数据');
      ids.add(node.instanceId);
      const t = node.transform,
        floor = cell ? basementFloor(cell, cells) : undefined;
      let position = t.slice(5).map((v, i) => v / 100 - (floor ? 0 : rootOffset[i])) as Vec3,
        rotation = t.slice(1, 5) as Quat;
      if (floor) {
        position = rotate(position, floor.rotation).map((v, i) => v + floor.position[i]) as Vec3;
        rotation = multiply(floor.rotation, rotation);
      }
      return {
        id: `item-${node.instanceId}`,
        resourceKey: r.key,
        detail: node.detail ?? 0,
        position,
        rotation,
        scale: node.axisScale ? ([...node.axisScale] as Vec3) : [t[0], t[0], t[0]],
        ...(cell ? { basementId: cell.id } : {}),
      };
    });
  return validateScene({
    format: 'homeland-layout',
    version: 1,
    name,
    items,
    ...(landKey ? { landKey } : {}),
    ...(cells.length ? { basements: cells } : {}),
    ...(forMerge ? { basementMergeOnly: true as const } : {}),
  });
}
export function scenePackage(doc: SceneDocument, baseBlueprint?: Uint8Array) {
  const addition = exportSceneBlueprint(doc, { forMerge: !!baseBlueprint }),
    blueprint = baseBlueprint ? mergeWholeBlueprint(baseBlueprint, addition) : addition,
    materials = sceneMaterials(doc);
  const text = [
    baseBlueprint ? '新增家具清单' : '家具清单',
    ...materials.map((r) => `${r.name} × ${r.count}（样式${r.detail}）`),
    '',
    `合计 ${doc.items.length} 件家具、${doc.basements?.length ?? 0} 个地下室单元`,
  ].join('\n');
  return zipSync(
    {
      '家园布置.blueprintx': blueprint,
      '布置工程.homeland.json': writeSceneProject(doc),
      ...(baseBlueprint ? { '原始整屋.blueprintx': baseBlueprint } : {}),
      '家具清单.txt': strToU8(text),
      '使用说明.txt': strToU8(
        (baseBlueprint
          ? '此包包含合并后的整屋蓝图。原始整屋中的家具、地下室、地表涂绘和植被均予以保留，再加入当前工程的布置。\n1. 在游戏保存当前布置作为备份。\n2. 从整屋入口导入“家园布置.blueprintx”，核对后保存。\n3. 再次编辑时打开“布置工程.homeland.json”，并选择包内“原始整屋.blueprintx”作为合并底图；不要重复合并到已添加过的文件。\n工程文件和家具清单只记录新增部分。\n'
          : doc.basements?.length
            ? '此文件为全新整屋蓝图。导入会替换整个家园的布置，即使网页只选择了一个分区。\n1. 在游戏保存当前布置作为备份。\n2. 从整屋入口导入“家园布置.blueprintx”，核对后保存。\n如需保留现有布置，请返回网页选择“合并到现有整屋”，载入游戏保存的原蓝图后重新导出。\n'
            : '从游戏的局部组件入口导入“家园布置.blueprintx”，核对位置后保存。\n') +
          '按家具清单准备库存及可用容量。“布置工程.homeland.json”可通过“打开工程”继续编辑。网页采用中性照明，游戏内效果受环境影响。\n',
      ),
    },
    { level: 6, mtime: new Date(2000, 0, 1) },
  );
}
export class SceneHistory {
  private past: SceneDocument[] = [];
  private future: SceneDocument[] = [];
  private current = emptyScene();
  get document() {
    return structuredClone(this.current);
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  commit(doc: SceneDocument) {
    const next = validateScene(doc);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.past.push(this.current);
    if (this.past.length > 50) this.past.shift();
    this.current = next;
    this.future = [];
  }
  undo() {
    if (this.past.length) {
      this.future.push(this.current);
      this.current = this.past.pop()!;
    }
    return this.document;
  }
  redo() {
    if (this.future.length) {
      this.past.push(this.current);
      this.current = this.future.pop()!;
    }
    return this.document;
  }
}
