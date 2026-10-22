import { experimentalData } from './experimental.generated.js';
import { opaqueColors, variantById, support } from './catalog.js';
import { microTiles, microGeometry, verifyVisibility, type MicroGeometry } from './layout.js';
import {
  assemble,
  objectNode,
  socketNode,
  placedNodes,
  supportCount,
  GROUP_SIZE,
} from './component.js';
import { encodeBlueprint, decodeBlueprint } from './codec.js';
import { rotate } from './math.js';
import type { BlueprintNode, Quat, RawImage, Vec3 } from './types.js';

export interface GlassVariant {
  name: string;
  furnitureId: number;
  representId: number;
  scaleRange: number[];
  planeCount: number;
  footprint: {
    source: 'anchor-bounds' | 'mesh-vertices-indices';
    bounds: number[][];
    triangles: number[][][];
  };
}
export interface GlassMaterial {
  key: string;
  recipes: { base: string; rgb: number[]; rgbMin: number[]; rgbMax: number[] }[];
  variants: GlassVariant[];
}
export interface GlassPlacement {
  material: number;
  variant: GlassVariant;
  scale: number;
  center: Vec3;
  rotation: Quat;
}
export interface GlassFrame {
  width: number;
  height: number;
  pitch: number;
  edgeM: number;
  floor: number;
  front: number;
}
export const glassMaterials = experimentalData.materials as unknown as GlassMaterial[];
export const glassByResource = new Map(
  glassMaterials.flatMap((m, material) =>
    m.variants.map((variant) => [variant.representId, { material, variant }] as const),
  ),
);
export const COVERAGE_GRID = 3;
export const COVERAGE_SAMPLES = COVERAGE_GRID * COVERAGE_GRID;
export const GLASS_SAMPLE_OFFSETS = Array.from({ length: COVERAGE_SAMPLES }, (_, i) => [
  ((i % COVERAGE_GRID) + 0.5) / COVERAGE_GRID,
  (Math.floor(i / COVERAGE_GRID) + 0.5) / COVERAGE_GRID,
]);
const wallRotation: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

export function placeGlass(
  material: number,
  xM: number,
  yM: number,
  frame: GlassFrame,
): GlassPlacement {
  const variant = glassMaterials[material].variants.find((v) => v.name.endsWith('2米'))!;
  const [low, high] = variant.footprint.bounds;
  const scale = 0.25;
  if (variant.scaleRange[0] > scale || variant.scaleRange[1] < scale || variant.planeCount !== 2)
    throw new Error('试验材料规格发生变化');
  return {
    material,
    variant,
    scale,
    rotation: [...wallRotation],
    center: [
      xM - (frame.width * frame.pitch) / 2 - ((low[0] + high[0]) * scale) / 2,
      frame.height * frame.pitch - yM - frame.floor - ((low[2] + high[2]) * scale) / 2,
      frame.front,
    ],
  };
}

export function glassContains(variant: GlassVariant, x: number, z: number): boolean {
  const [low, high] = variant.footprint.bounds;
  const eps = 1e-7;
  if (x < low[0] - eps || x > high[0] + eps || z < low[2] - eps || z > high[2] + eps) return false;
  if (variant.footprint.source === 'anchor-bounds') return true;
  return variant.footprint.triangles.some(([a, b, c]) => {
    const ab = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const bc = (c[0] - b[0]) * (z - b[1]) - (c[1] - b[1]) * (x - b[0]);
    const ca = (a[0] - c[0]) * (z - c[1]) - (a[1] - c[1]) * (x - c[0]);
    return (ab >= -eps && bc >= -eps && ca >= -eps) || (ab <= eps && bc <= eps && ca <= eps);
  });
}

/** 每个像素内的九个实际射线样点；异形空缺不会按包围盒填满。 */
export function glassCoverage(placement: GlassPlacement, frame: GlassFrame): Map<number, number> {
  const { variant, scale, rotation, center } = placement;
  const n = rotate([0, 1, 0], rotation),
    u = rotate([1, 0, 0], rotation),
    v = rotate([0, 0, 1], rotation);
  if (n[2] > -0.999) throw new Error('试验透明面没有朝向墙画正面');
  const [low, high] = variant.footprint.bounds;
  const surface = center.map((p, i) => p + n[i] * high[1] * scale) as Vec3;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const x of [low[0], high[0]])
    for (const z of [low[2], high[2]]) {
      const p = rotate([x * scale, high[1] * scale, z * scale], rotation);
      const ix = (p[0] + center[0]) / frame.pitch + frame.width / 2;
      const iy = frame.height - (p[1] + center[1] + frame.floor) / frame.pitch;
      minX = Math.min(minX, ix);
      maxX = Math.max(maxX, ix);
      minY = Math.min(minY, iy);
      maxY = Math.max(maxY, iy);
    }
  if (minX < -1e-3 || minY < -1e-3 || maxX > frame.width + 1e-3 || maxY > frame.height + 1e-3)
    throw new Error('试验材料超出图案边界');
  const coverage = new Map<number, number>();
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(frame.height, Math.ceil(maxY)); y++)
    for (let x = Math.max(0, Math.floor(minX)); x < Math.min(frame.width, Math.ceil(maxX)); x++) {
      let mask = 0;
      for (let sample = 0; sample < COVERAGE_SAMPLES; sample++) {
        const [ox, oy] = GLASS_SAMPLE_OFFSETS[sample];
        const dx = (x + ox - frame.width / 2) * frame.pitch - surface[0];
        const dy = (frame.height - y - oy) * frame.pitch - frame.floor - surface[1];
        const dz = -(n[0] * dx + n[1] * dy) / n[2];
        const lx = (u[0] * dx + u[1] * dy + u[2] * dz) / scale;
        const lz = (v[0] * dx + v[1] * dy + v[2] * dz) / scale;
        if (glassContains(variant, lx, lz)) mask |= 1 << sample;
      }
      if (mask) coverage.set(y * frame.width + x, mask);
    }
  return coverage;
}

export function sampleCount(mask: number): number {
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

export function buildGlassBlueprint(
  keys: string[],
  frame: GlassFrame,
  overlays: GlassPlacement[],
  showHandle: boolean,
): Uint8Array {
  const geometry = microGeometry(
    microTiles(keys, frame.width, frame.height, frame.edgeM),
    frame.width,
    frame.height,
    frame.pitch,
    'wall',
    frame.edgeM,
  );
  const nodes = geometry.pieces.map((piece, i) =>
    objectNode(
      0,
      i + 1,
      piece.tile.variant.representId,
      [
        piece.tile.scale,
        ...piece.rotation,
        piece.center[0] * 100,
        (piece.center[1] - geometry.floor) * 100,
        piece.center[2] * 100,
      ],
      [socketNode(0), socketNode(1)],
    ),
  );
  for (const overlay of overlays)
    nodes.push(
      objectNode(
        0,
        nodes.length + 1,
        overlay.variant.representId,
        [overlay.scale, ...overlay.rotation, ...overlay.center.map((p) => p * 100)] as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ],
        [socketNode(0), socketNode(1)],
      ),
    );
  const groups: BlueprintNode[][] = [];
  for (let start = 0; start < nodes.length; start += GROUP_SIZE)
    groups.push(nodes.slice(start, start + GROUP_SIZE));
  const root = assemble(
    groups,
    nodes.length + 1,
    [0, 0, 0],
    [0, 0, geometry.max[2] * 100 + 100],
    showHandle,
  );
  return encodeBlueprint({ global: false, root });
}

export interface GlassReadback {
  keys: string[];
  geometry: MicroGeometry;
  overlays: GlassPlacement[];
  bases: number;
}
export function readGlassBlueprint(bytes: Uint8Array, frame: GlassFrame): GlassReadback {
  const decoded = decodeBlueprint(bytes);
  if (decoded.global || decoded.root.type !== 8) throw new Error('不是试验墙画组件');
  const count = frame.width * frame.height,
    ids = new Set<number>();
  const baseNodes = new Map<number, ReturnType<typeof placedNodes>[number]>();
  const overlays: { id: number; placement: GlassPlacement }[] = [];
  let bases = 0;
  for (const placed of placedNodes(decoded.root)) {
    const { node, position, rotation } = placed;
    if (node.instanceId !== undefined) {
      if (ids.has(node.instanceId)) throw new Error('试验组件编号重复');
      ids.add(node.instanceId);
    }
    if (node.type === 3) {
      if (node.representId !== support.representId) throw new Error('未知试验基座');
      bases++;
    }
    if (node.type !== 0 || node.representId === support.meshRepresentId) continue;
    const id = node.instanceId!,
      scale = node.transform![0];
    if (node.detail || node.builtin || node.flags) throw new Error('试验家具状态发生变化');
    if (
      node.children.length !== 2 ||
      node.children.some((c, i) => c.type !== 5 || c.index !== i || c.children.length)
    )
      throw new Error('试验家具挂点异常');
    const glass = glassByResource.get(node.representId!);
    if (glass) {
      if (
        id <= count ||
        scale < glass.variant.scaleRange[0] - 1e-6 ||
        scale > glass.variant.scaleRange[1] + 1e-6
      )
        throw new Error('透明材料编号或缩放无效');
      const placement = { ...glass, scale, center: position.map((p) => p / 100) as Vec3, rotation };
      if (
        Math.abs(scale - 0.25) > 1e-6 ||
        rotation.some((p, i) => Math.abs(p - wallRotation[i]) > 1e-6)
      )
        throw new Error('透明材料方向或规格偏离试验方案');
      if (Math.abs(placement.center[2] - frame.front) > 2e-5) throw new Error('透明层前后位置异常');
      glassCoverage(placement, frame);
      overlays.push({ id, placement });
    } else {
      const cloth = variantById.get(node.representId!);
      if (!cloth || cloth.color.translucent || id < 1 || id > count)
        throw new Error('试验底层家具无效');
      baseNodes.set(id, placed);
    }
  }
  if (baseNodes.size !== count || bases !== supportCount(count + overlays.length))
    throw new Error('试验组件数量不符');
  overlays.sort((a, b) => a.id - b.id);
  if (overlays.some((row, i) => row.id !== count + i + 1)) throw new Error('试验材料编号不连续');
  const keys = Array.from(
    { length: count },
    (_, i) => variantById.get(baseNodes.get(i + 1)!.node.representId!)!.color.key,
  );
  const expected = microGeometry(
    microTiles(keys, frame.width, frame.height, frame.edgeM),
    frame.width,
    frame.height,
    frame.pitch,
    'wall',
    frame.edgeM,
  );
  const pieces = expected.pieces.map((piece, i) => {
    const actual = baseNodes.get(i + 1)!;
    const center = actual.position.map((p) => p / 100) as Vec3;
    const wanted = [piece.center[0], piece.center[1] - expected.floor, piece.center[2]];
    if (
      center.some((p, j) => Math.abs(p - wanted[j]) > 2e-5) ||
      actual.rotation.some((p, j) => Math.abs(p - piece.rotation[j]) > 1e-6) ||
      Math.abs(actual.node.transform![0] - piece.tile.scale) > 1e-6
    )
      throw new Error('试验底层坐标或缩放回读失败');
    return { ...piece, center, rotation: actual.rotation };
  });
  if (
    overlays.some(
      ({ placement }) =>
        placement.center[2] - placement.variant.footprint.bounds[0][1] * placement.scale >=
        expected.min[2] - 0.009,
    )
  )
    throw new Error('透明材料与底层发生相交');
  return {
    keys,
    geometry: { ...expected, pieces },
    overlays: overlays.map((p) => p.placement),
    bases,
  };
}

/** 图像只根据实际蓝图回读的资源与位置重建，不使用选色时的目标图。 */
export function renderGlassBlueprint(
  readback: GlassReadback,
  frame: GlassFrame,
  progress?: (n: number) => void,
): { image: RawImage; samples: number; coveredSamples: number } {
  const samples = verifyVisibility(
    readback.geometry,
    frame.width,
    frame.height,
    frame.pitch,
    'wall',
    progress,
    GLASS_SAMPLE_OFFSETS,
  );
  const width = frame.width * COVERAGE_GRID,
    height = frame.height * COVERAGE_GRID;
  const rgba = new Uint8Array(width * height * 4),
    occupied = new Uint16Array(frame.width * frame.height);
  const colorMap = new Map(opaqueColors.map((c) => [c.key, c.rgb]));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const key =
        readback.keys[Math.floor(y / COVERAGE_GRID) * frame.width + Math.floor(x / COVERAGE_GRID)];
      rgba.set([...colorMap.get(key)!, 255], (y * width + x) * 4);
    }
  let coveredSamples = 0;
  for (const overlay of readback.overlays) {
    const recipes = new Map(glassMaterials[overlay.material].recipes.map((r) => [r.base, r.rgb]));
    for (const [i, mask] of glassCoverage(overlay, frame)) {
      if (occupied[i] & mask) throw new Error('透明层互相覆盖，不能按单层配方预览');
      occupied[i] |= mask;
      const rgb = recipes.get(readback.keys[i]);
      if (!rgb) throw new Error('回读缺少透明材料配方');
      for (let sample = 0; sample < COVERAGE_SAMPLES; sample++)
        if (mask & (1 << sample)) {
          const x = (i % frame.width) * COVERAGE_GRID + (sample % COVERAGE_GRID);
          const y =
            Math.floor(i / frame.width) * COVERAGE_GRID + Math.floor(sample / COVERAGE_GRID);
          rgba.set([...rgb, 255], (y * width + x) * 4);
          coveredSamples++;
        }
    }
  }
  return { image: { width, height, rgba }, samples, coveredSamples };
}
