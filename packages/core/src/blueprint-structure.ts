import { checksum } from './codec.js';
import { blueprintResourceData } from './blueprint-resources.generated.js';
import type { Vec3, Quat } from './types.js';

const known = new Set<number>([0xffffffff]);
for (const [a, b] of blueprintResourceData.knownRanges)
  for (let id = a; id <= b; id++) known.add(id);
const nonUniform = new Set<number>(blueprintResourceData.nonUniform);
export interface RawNode {
  start: number;
  end: number;
  type: number;
  countOffset: number;
  dataEnd: number;
  children: RawNode[];
  id?: number;
  idOffset?: number;
  brushId?: number;
  position?: number[];
  mask?: number;
  resourceId?: number;
  detail?: number;
  index?: number;
  transformOffset?: number;
  scale?: Vec3;
  rotation?: Quat;
  axisScale?: boolean;
}
export interface WholeBlueprintInfo {
  widthM: number;
  depthM: number;
  objectCount: number;
  basementCount: number;
}

/** 只遍历结构与字段长度；原文件的材质、灯光、涂绘及未知业务参数保持原字节。 */
export function scanWholeBlueprint(bytes: Uint8Array) {
  if (bytes.length < 63 || bytes.length > 32_000_000) throw new Error('整屋蓝图文件大小无效');
  const end = bytes.length - 16,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!checksum(bytes.subarray(0, end)).every((b, i) => b === bytes[end + i]))
    throw new Error('整屋蓝图校验失败');
  let offset = 0;
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || offset + n > end)
      throw new Error('整屋蓝图数据不完整');
    const start = offset;
    offset += n;
    return start;
  };
  const u8 = () => view.getUint8(take(1)),
    u16 = () => view.getUint16(take(2), true),
    u32 = () => view.getUint32(take(4), true);
  const floats = (n: number) =>
    Array.from({ length: n }, () => {
      const v = view.getFloat32(take(4), true);
      if (!Number.isFinite(v)) throw new Error('蓝图含无效变换');
      return v;
    });
  if (u8() !== 1 || u32() !== 7) throw new Error('请选择游戏保存的 V7 整屋蓝图');
  const extent = floats(2),
    bounds = floats(6),
    nextId = u32();
  take(5);
  if (extent.some((v) => v <= 0 || v > 100000)) throw new Error('整屋蓝图范围无效');
  const groundVersion = u32(),
    layers = u32(),
    gw = u32(),
    gh = u32();
  if (![1, 2].includes(groundVersion) || layers > 3 || gw * gh > 16_000_000)
    throw new Error('未支持的地表绘制尺寸或版本');
  floats(10);
  const ids = new Set<number>();
  let highestId = 0;
  const recordId = (id: number) => {
    if (id === 0) return;
    if (ids.has(id)) throw new Error('原蓝图含重复实例编号');
    ids.add(id);
    highestId = Math.max(highestId, id);
  };
  for (let i = 0; i < layers; i++) {
    const resource = u32(),
      id = u32();
    u32();
    if (resource) recordId(id);
    if (groundVersion === 2) {
      const length = u32();
      take(5);
      take(length);
    } else if (resource) take(gw * gh);
  }
  if (u32() !== 1) throw new Error('未支持的植被版本');
  const fw = u32(),
    fh = u32(),
    count = u8(),
    foliageId = u32();
  floats(10);
  if (count > 64 || fw * fh > 16_000_000) throw new Error('未支持的植被尺寸');
  if (count) {
    recordId(foliageId);
    take(320 + fw * fh * 2);
  }
  const rootOffset = offset,
    nodes: RawNode[] = [];
  const readNode = (depth: number): RawNode => {
    if (depth > 128 || nodes.length >= 250000) throw new Error('蓝图节点超出处理范围');
    const start = offset,
      type = u8();
    const n: RawNode = { start, end: 0, type, countOffset: 0, dataEnd: 0, children: [] };
    nodes.push(n);
    let childCount = 0,
      transform = false,
      axisScale = false;
    if ([0, 2, 3, 8].includes(type)) {
      u32();
      n.idOffset = offset;
      n.id = u32();
      const resource = u32();
      n.resourceId = resource;
      u8();
      n.detail = u8();
      if (!known.has(resource)) throw new Error(`资源 ${resource} 的节点布局未收录，无法安全合并`);
      axisScale = nonUniform.has(resource);
      if (type === 2) take(5);
      n.countOffset = offset;
      childCount = u16();
      transform = true;
    } else if (type === 1 || type === 9) {
      n.idOffset = offset;
      n.id = u32();
      n.brushId = u16();
      n.mask = u16();
      if (type === 9) u8();
      n.countOffset = offset;
      childCount = u16();
      transform = true;
    } else if ([5, 6, 7].includes(type)) {
      n.index = u16();
      n.countOffset = offset;
      childCount = u16();
      transform = childCount > 0;
    } else if (type === 4) {
      const length = u16();
      if (length < 231 || length > 749) throw new Error('灯光节点长度无效');
      u32();
      n.idOffset = offset;
      n.id = u32();
      take(184);
      for (let i = 0; i < 2; i++) {
        let length = 0;
        while (u8() !== 0) if (++length >= 260) throw new Error('灯光字符串缺少终止符');
      }
      n.countOffset = offset;
      childCount = u16();
      transform = true;
      if (offset + 32 !== start + length) throw new Error('灯光字段边界不一致');
    } else throw new Error(`未支持的蓝图节点类型 ${type}，原文件未修改`);
    if (n.id !== undefined) recordId(n.id);
    if (transform) {
      n.transformOffset = offset;
      n.axisScale = axisScale;
      const t = floats(axisScale ? 10 : 8);
      n.scale = axisScale ? (t.slice(0, 3) as Vec3) : [t[0], t[0], t[0]];
      n.rotation = t.slice(axisScale ? 3 : 1, axisScale ? 7 : 5) as Quat;
      n.position = t.slice(-3);
    }
    n.dataEnd = offset;
    for (let i = 0; i < childCount; i++) n.children.push(readNode(depth + 1));
    n.end = offset;
    return n;
  };
  const root = readNode(0);
  if (root.type !== 5 || view.getUint16(root.start + 1, true) !== 0 || offset !== end)
    throw new Error('整屋根节点或文件边界不正确');
  if (nextId <= highestId) throw new Error('原蓝图实例编号范围不完整');
  return { view, root, rootOffset, nodes, nextId, highestId, extent, bounds };
}
