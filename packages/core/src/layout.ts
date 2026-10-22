import type { Tile, Variant, Orientation, BlueprintNode, Vec3, Quat, Transform } from './types.js';
import { colorByKey, variantById, support, maxRecipeLayers } from './catalog.js';
import { roundEven, multiply, rotate } from './math.js';
import {
  assemble,
  objectNode,
  socketNode,
  GROUP_SIZE,
  supportCount,
  importOrientation,
  undoImport,
  placedNodes,
} from './component.js';
import { encodeBlueprint, decodeBlueprint, walkNodes } from './codec.js';
import { MAX_CLOTH_TILES } from './budget.js';

export function variantFor(
  key: string,
  side: number,
  cellM: number,
): { variant: Variant; scale: number } | undefined {
  const color = colorByKey.get(key);
  if (!color) return;
  const base = color.variants.find(
    (v) => v.minScale - 1e-6 <= cellM / v.sizeM && cellM / v.sizeM <= v.maxScale + 1e-6,
  );
  if (!base) return;
  const scale = cellM / base.sizeM;
  if (side === 1) return { variant: base, scale };
  const twice = color.variants.find(
    (v) => v.sizeM === base.sizeM * 2 && v.minScale - 1e-6 <= scale && scale <= v.maxScale + 1e-6,
  );
  if (side === 2) return twice ? { variant: twice, scale } : undefined;
  if (twice) {
    const large = color.variants.find(
      (v) =>
        v.sizeM === 4 &&
        v.minScale - 1e-6 <= (side * cellM) / v.sizeM &&
        (side * cellM) / v.sizeM <= v.maxScale + 1e-6,
    );
    if (large) return { variant: large, scale: (side * cellM) / large.sizeM };
  }
}
export function makePlan(
  grid: readonly (string | null)[],
  width: number,
  height: number,
  cellM: number,
  requireAnchor = true,
): Tile[] {
  if (grid.length !== width * height) throw new Error('颜色网格大小不匹配');
  const tile = (x: number, y: number, side: number): Tile => {
    const key = grid[y * width + x]!,
      chosen = variantFor(key, side, cellM);
    if (!chosen) throw new Error('当前尺寸超出拼布缩放范围');
    return { x, y, side, layer: 0, key, ...chosen };
  };
  const merge = (sides: number[]): Tile[] => {
    const used = new Uint8Array(grid.length),
      result: Tile[] = [];
    for (const side of sides)
      for (let y = 0; y <= height - side; y++)
        for (let x = 0; x <= width - side; x++) {
          const i = y * width + x,
            key = grid[i];
          if (used[i] || key === null || !variantFor(key, side, cellM)) continue;
          let match = true;
          for (let dy = 0; dy < side && match; dy++)
            for (let dx = 0; dx < side; dx++)
              if (used[(y + dy) * width + x + dx] || grid[(y + dy) * width + x + dx] !== key) {
                match = false;
                break;
              }
          if (!match) continue;
          result.push(tile(x, y, side));
          for (let dy = 0; dy < side; dy++)
            for (let dx = 0; dx < side; dx++) used[(y + dy) * width + x + dx] = 1;
        }
    if (grid.some((key, i) => key !== null && !used[i])) throw new Error('拼布没有覆盖完整图案');
    return result;
  };
  const merged = merge([8, 4, 2, 1]);
  if (merged.length && requireAnchor && !merged.some((t) => t.side <= 2)) {
    let index = 0;
    for (let i = 1; i < merged.length; i++) {
      const a = merged[i],
        b = merged[index];
      if (
        (a.side === 4 ? 3 : 6) < (b.side === 4 ? 3 : 6) ||
        (a.side === b.side && (a.y < b.y || (a.y === b.y && a.x < b.x)))
      )
        index = i;
    }
    const first = merged[index],
      pieces = [
        [0, 0],
        [2, 0],
        [0, 2],
        [2, 2],
      ].map(([x, y]) => tile(first.x + x, first.y + y, 2));
    if (first.side === 8)
      pieces.push(
        ...[
          [4, 0],
          [0, 4],
          [4, 4],
        ].map(([x, y]) => tile(first.x + x, first.y + y, 4)),
      );
    merged.splice(index, 1, ...pieces);
  }
  const smaller = merge([2, 1]);
  return smaller.length + supportCount(smaller.length) < merged.length + supportCount(merged.length)
    ? smaller
    : merged;
}
export function buildNative(
  tiles: Tile[],
  width: number,
  height: number,
  cellM: number,
  direction: Orientation,
  showHandle = true,
): Uint8Array {
  const anchor = tiles.find((t) => t.side <= 2 && t.layer === 0);
  if (!anchor) throw new Error('图案缺少合法锚点');
  const surface = 2.5 * anchor.scale,
    unit = cellM * 100,
    nodes: BlueprintNode[] = [];
  for (const [i, t] of tiles.entries()) {
    if (!Number.isInteger(t.layer) || t.layer < 0 || t.layer >= maxRecipeLayers)
      throw new Error('叠层超出范围');
    const x = (width / 2 - t.x - t.side / 2) * unit,
      depth = surface * (t.layer + 1) - 2.5 * t.scale;
    const q: Quat = direction === 'wall' ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1];
    const position: Vec3 =
      direction === 'wall'
        ? [x, (height - t.y - t.side / 2) * unit, depth]
        : [x, depth, (t.y + t.side / 2 - height / 2) * unit];
    nodes.push(
      objectNode(
        0,
        i + 1,
        t.variant.representId,
        [t.scale, ...q, ...position],
        [socketNode(0), socketNode(1)],
      ),
    );
  }
  const original = nodes.map((n) => [...n.transform!] as Transform),
    groups: BlueprintNode[][] = [];
  for (let start = 0; start < nodes.length; start += GROUP_SIZE) {
    const first = tiles[start],
      root = nodes[start],
      socket = root.children[first.variant.topSocketIndex],
      top = first.variant.topSocketY;
    if (!socket || !Number.isFinite(top) || top <= 0) throw new Error('拼布挂点资料无效');
    for (let i = start + 1; i < Math.min(start + GROUP_SIZE, nodes.length); i++) {
      const current = original[i],
        parent = original[start],
        x = current[5] - parent[5],
        y = current[6] - parent[6],
        z = current[7] - parent[7];
      nodes[i].transform = [
        current[0],
        0,
        0,
        0,
        1,
        x,
        (direction === 'wall' ? z : y) - top * first.scale,
        direction === 'wall' ? -y : z,
      ];
      socket.transform = [first.scale, 0, 0, 0, 1, 0, top * first.scale, 0];
      socket.children.push(nodes[i]);
    }
    groups.push([root]);
  }
  let outer: Vec3 = [0, 0, 60],
    inner: Vec3 = [0, 0, 60];
  if (direction === 'wall') {
    const lowest = tiles.reduce(
      (value, t, i) => Math.min(value, original[i][7] - t.variant.surfaceY * t.scale),
      Infinity,
    );
    outer = [0, 0, 0];
    inner = [0, 0, lowest - 100];
  }
  const raw = encodeBlueprint({
    global: false,
    root: assemble(groups, nodes.length + 1, outer, inner, showHandle),
  });
  const restored = decodeBlueprint(raw);
  importOrientation(restored.root, direction);
  return encodeBlueprint(restored);
}
export function readNative(
  bytes: Uint8Array,
  width: number,
  height: number,
  cellM: number,
  direction: Orientation,
): Tile[] {
  const parsed = decodeBlueprint(bytes);
  if (parsed.global || parsed.root.type !== 8) throw new Error('不是局部拼布组件');
  undoImport(parsed.root, direction, false);
  const unit = cellM * 100,
    actual: (Tile & { surface: number; id: number })[] = [];
  let bases = 0;
  const identifiers = new Set<number>();
  for (const { node, position, rotation } of placedNodes(parsed.root)) {
    if (node.instanceId !== undefined) {
      if (identifiers.has(node.instanceId)) throw new Error('家具实例编号重复');
      identifiers.add(node.instanceId);
    }
    if (node.type === 3) {
      if (node.representId !== support.representId) throw new Error('未知挂接基座');
      bases++;
    }
    const item = variantById.get(node.representId ?? -1);
    if (node.type === 0 && item) {
      const { color, variant } = item,
        scale = node.transform![0],
        sideValue = (variant.sizeM * scale) / cellM,
        side = roundEven(sideValue);
      const wanted: Quat = direction === 'wall' ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1];
      const dot = rotation.reduce((sum, x, i) => sum + x * wanted[i], 0);
      if (
        ![1, 2, 4, 8].includes(side) ||
        Math.abs(side - sideValue) > 0.001 ||
        scale < variant.minScale - 1e-5 ||
        scale > variant.maxScale + 1e-5 ||
        Math.abs(Math.abs(dot) - 1) > 1e-4
      )
        throw new Error('家具规格或朝向回读失败');
      const x = width / 2 - position[0] / unit - side / 2,
        y =
          direction === 'wall'
            ? height - position[1] / unit - side / 2
            : position[2] / unit + height / 2 - side / 2;
      const gx = roundEven(x),
        gy = roundEven(y);
      if (
        Math.abs(x - gx) > 0.001 ||
        Math.abs(y - gy) > 0.001 ||
        gx < 0 ||
        gy < 0 ||
        gx + side > width ||
        gy + side > height
      )
        throw new Error('家具坐标偏离网格');
      actual.push({
        x: gx,
        y: gy,
        side,
        layer: 0,
        key: color.key,
        variant,
        scale,
        surface: position[direction === 'wall' ? 2 : 1] + 2.5 * scale,
        id: node.instanceId!,
      });
    } else if (node.type === 0 && node.representId !== support.meshRepresentId)
      throw new Error('蓝图含未知家具');
  }
  if (!actual.length || bases !== supportCount(actual.length)) throw new Error('家具数量回读失败');
  const first = actual.reduce((n, t) => Math.min(n, t.surface), Infinity);
  if (first <= 0) throw new Error('叠层高度无效');
  for (const t of actual) {
    const depth = t.surface / first - 1;
    t.layer = roundEven(depth);
    if (t.layer < 0 || t.layer >= maxRecipeLayers || Math.abs(depth - t.layer) > 0.01)
      throw new Error('叠层高度回读失败');
  }
  return actual.sort((a, b) => a.id - b.id).map(({ surface, id, ...tile }) => tile);
}
export interface Piece {
  tile: Tile;
  center: Vec3;
  rotation: Quat;
}
export interface MicroGeometry {
  pieces: Piece[];
  floor: number;
  min: Vec3;
  max: Vec3;
}
export function microTiles(
  keys: readonly string[],
  width: number,
  height: number,
  edgeM: number,
): Tile[] {
  if (keys.length !== width * height) throw new Error('微缩颜色网格不完整');
  return keys.map((key, i) => {
    const color = colorByKey.get(key);
    const variant = color?.variants.find(
      (v) => v.minScale <= edgeM / v.sizeM && edgeM / v.sizeM <= v.maxScale,
    );
    if (!color || color.translucent || !variant) throw new Error('微缩拼布规格无效');
    return {
      x: i % width,
      y: Math.floor(i / width),
      side: 1,
      layer: 0,
      key,
      variant,
      scale: edgeM / variant.sizeM,
    };
  });
}
export function microGeometry(
  tiles: Tile[],
  width: number,
  height: number,
  pitch: number,
  direction: Orientation,
  edgeM: number,
): MicroGeometry {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_CLOTH_TILES ||
    tiles.length !== width * height ||
    ![0.5, 1, 2, 4, 8].includes(edgeM) ||
    pitch / (edgeM / 0.5) < 0.001 ||
    pitch / (edgeM / 0.5) > 0.25
  )
    throw new Error('微缩尺寸超出范围');
  const slope = Math.tan(Math.PI / 180),
    norm = Math.hypot(slope, slope, 1),
    inset = edgeM / (2 * pitch);
  const qs: Quat[] = [];
  for (const [horizontal, vertical] of [
    [1, -1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const i = (vertical * slope) / norm,
      a = (-horizontal * slope) / norm,
      o = 1 + 1 / norm,
      k = Math.SQRT1_2 / Math.hypot(i, a, o);
    const q: Quat = [(i - o) * k, a * k, a * k, (i + o) * k],
      length = Math.hypot(...q);
    qs.push(q.map((x) => x / length) as Quat);
  }
  const ground = direction === 'ground',
    c: Quat = ground ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1];
  const pieces: Piece[] = [],
    min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let floor = 0;
  for (const [index, tile] of tiles.entries()) {
    if (
      tile.x !== index % width ||
      tile.y !== Math.floor(index / width) ||
      tile.side !== 1 ||
      tile.layer !== 0 ||
      tile.scale < tile.variant.minScale ||
      tile.scale > tile.variant.maxScale ||
      Math.abs(tile.variant.sizeM * tile.scale - edgeM) > 1e-8
    )
      throw new Error('微缩家具布局无效');
    const right = tile.x >= Math.ceil(width / 2),
      bottom = tile.y >= Math.ceil(height / 2);
    const p: Vec3 = [
      (tile.x + (right ? 1 - inset : inset) - width / 2) * pitch,
      (height - tile.y - (bottom ? 1 - inset : inset)) * pitch,
      0,
    ];
    const center = ground ? rotate([-p[0], (height * pitch) / 2 - p[1], p[2]], c) : p;
    const h = qs[(bottom ? 2 : 0) + (right ? 1 : 0)],
      g = ground ? multiply(multiply([1, 0, 0, 0], h), [0, 1, 0, 0]) : h;
    const q = multiply(c, ground ? [-g[0], g[1], -g[2], g[3]] : g);
    pieces.push({ tile, center, rotation: q });
    const half = (tile.variant.sizeM * tile.scale) / 2,
      thickness = (tile.variant.surfaceY * tile.scale) / 100;
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          const point = rotate([x * half, y * thickness, z * half], q).map(
            (v, i) => v + center[i],
          ) as Vec3;
          floor = Math.min(floor, point[1]);
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
          }
        }
  }
  min[1] -= floor;
  max[1] -= floor;
  if (max.some((v, i) => v - min[i] > [212, 100, 216][i])) throw new Error('微缩实体超出范围');
  return { pieces, floor, min, max };
}
export function buildMicro(
  tiles: Tile[],
  width: number,
  height: number,
  pitch: number,
  direction: Orientation,
  edgeM: number,
  showHandle = true,
): Uint8Array {
  const geometry = microGeometry(tiles, width, height, pitch, direction, edgeM);
  const nodes = geometry.pieces.map((p, i) =>
    objectNode(
      0,
      i + 1,
      p.tile.variant.representId,
      [
        p.tile.scale,
        ...p.rotation,
        p.center[0] * 100,
        (p.center[1] - geometry.floor) * 100,
        p.center[2] * 100,
      ],
      [socketNode(0), socketNode(1)],
    ),
  );
  const outer: Vec3 = direction === 'wall' ? [0, 0, 0] : [0, 0, 60],
    inner: Vec3 = direction === 'wall' ? [0, 0, geometry.max[2] * 100 + 100] : outer;
  const groups: BlueprintNode[][] = [];
  for (let i = 0; i < nodes.length; i += GROUP_SIZE) groups.push(nodes.slice(i, i + GROUP_SIZE));
  const root = assemble(groups, nodes.length + 1, outer, inner, showHandle);
  if (direction === 'ground') importOrientation(root, direction);
  return encodeBlueprint({ global: false, root });
}
export function readMicro(
  bytes: Uint8Array,
  width: number,
  height: number,
  pitch: number,
  direction: Orientation,
  edgeM: number,
): MicroGeometry {
  const parsed = decodeBlueprint(bytes);
  if (parsed.global || parsed.root.type !== 8) throw new Error('不是微缩组件');
  undoImport(parsed.root, direction, true);
  const found = new Map<number, Piece>(),
    ids = new Set<number>();
  let bases = 0;
  for (const { node, position, rotation } of placedNodes(parsed.root)) {
    if (node.instanceId !== undefined) {
      if (ids.has(node.instanceId)) throw new Error('家具实例编号重复');
      ids.add(node.instanceId);
    }
    if (node.type === 3) {
      if (node.representId !== support.representId) throw new Error('未知挂接基座');
      bases++;
    }
    const item = variantById.get(node.representId ?? -1);
    if (node.type === 0 && item) {
      const id = node.instanceId!,
        scale = node.transform![0];
      if (
        item.color.translucent ||
        id < 1 ||
        id > width * height ||
        scale < item.variant.minScale - 1e-6 ||
        scale > item.variant.maxScale + 1e-6
      )
        throw new Error('微缩家具回读失败');
      found.set(id, {
        tile: {
          x: (id - 1) % width,
          y: Math.floor((id - 1) / width),
          side: 1,
          layer: 0,
          key: item.color.key,
          variant: item.variant,
          scale,
        },
        center: position.map((x) => x / 100) as Vec3,
        rotation,
      });
    } else if (node.type === 0 && node.representId !== support.meshRepresentId)
      throw new Error('未知家具');
  }
  if (found.size !== width * height || bases !== supportCount(found.size))
    throw new Error('微缩数量回读失败');
  const pieces = Array.from({ length: width * height }, (_, i) => found.get(i + 1)!);
  const expected = microGeometry(
    pieces.map((x) => x.tile),
    width,
    height,
    pitch,
    direction,
    edgeM,
  );
  pieces.forEach((p, i) => {
    const target = expected.pieces[i];
    const center = [target.center[0], target.center[1] - expected.floor, target.center[2]];
    if (
      p.center.some((x, j) => Math.abs(x - center[j]) > 2e-5) ||
      p.rotation.some((x, j) => Math.abs(x - target.rotation[j]) > 1e-6)
    )
      throw new Error('微缩位置或方向回读失败');
  });
  return { ...expected, pieces };
}
export function verifyVisibility(
  geometry: MicroGeometry,
  width: number,
  height: number,
  pitch: number,
  direction: Orientation,
  onProgress?: (fraction: number) => void,
  sampleOffsets?: number[][],
): number {
  let pieces = geometry.pieces,
    floor = geometry.floor;
  if (direction === 'ground') {
    const q: Quat = [0, Math.SQRT1_2, -Math.SQRT1_2, 0];
    pieces = pieces.map((p) => ({
      tile: p.tile,
      center: [-p.center[0], (height * pitch) / 2 - p.center[2], -p.center[1] - floor],
      rotation: multiply(q, p.rotation),
    }));
    floor = 0;
  }
  const offsets = sampleOffsets ?? [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ];
  for (const [pass, offset] of offsets.entries()) {
    const depth = new Float64Array(width * height).fill(Infinity),
      visible = new Int32Array(width * height).fill(-1);
    for (const [index, piece] of pieces.entries()) {
      const n = rotate([0, 1, 0], piece.rotation),
        u = rotate([1, 0, 0], piece.rotation),
        v = rotate([0, 0, 1], piece.rotation);
      const half = (piece.tile.variant.sizeM * piece.tile.scale) / 2,
        thickness = (piece.tile.variant.surfaceY * piece.tile.scale) / 100;
      const c = piece.center.map((x, i) => x + n[i] * thickness) as Vec3;
      const rx = half * (Math.abs(u[0]) + Math.abs(v[0])),
        ry = half * (Math.abs(u[1]) + Math.abs(v[1]));
      const x0 = Math.max(0, Math.ceil((c[0] - rx) / pitch + width / 2 - offset[0] - 1e-6));
      const x1 = Math.min(
        width,
        Math.floor((c[0] + rx) / pitch + width / 2 - offset[0] + 1e-6) + 1,
      );
      const y0 = Math.max(0, Math.ceil(height - offset[1] - (c[1] + ry + floor) / pitch - 1e-6));
      const y1 = Math.min(
        height,
        Math.floor(height - offset[1] - (c[1] - ry + floor) / pitch + 1e-6) + 1,
      );
      if (Math.abs(n[2]) < 1e-9) throw new Error('拼布观察角度无效');
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const dx = (x + offset[0] - width / 2) * pitch - c[0],
            dy = (height - y - offset[1]) * pitch - floor - c[1],
            dz = -(n[0] * dx + n[1] * dy) / n[2];
          const id = y * width + x,
            z = c[2] + dz;
          if (
            Math.abs(u[0] * dx + u[1] * dy + u[2] * dz) <= half + 1e-8 &&
            Math.abs(v[0] * dx + v[1] * dy + v[2] * dz) <= half + 1e-8 &&
            z < depth[id]
          ) {
            depth[id] = z;
            visible[id] = index;
          }
        }
      if (index % 1024 === 0) onProgress?.((pass + index / pieces.length) / offsets.length);
    }
    if (visible.some((value, index) => value !== index))
      throw new Error('当前尺寸的拼布遮挡校验未通过，请调整尺寸');
  }
  onProgress?.(1);
  return width * height * offsets.length;
}
