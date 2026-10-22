import SparkMD5 from 'spark-md5';
import type { Blueprint, BlueprintNode, Transform, Vec3 } from './types.js';

const OBJECTS = new Set([0, 3, 8]),
  CONTAINERS = new Set([5, 6, 7]);
export const BLUEPRINT_LIMITS = Object.freeze({ bytes: 32_000_000, nodes: 250_000, depth: 128 });
const { bytes: MAX_BYTES, nodes: MAX_NODES, depth: MAX_DEPTH } = BLUEPRINT_LIMITS;
export function checksum(payload: Uint8Array): Uint8Array {
  const copy = new Uint8Array(payload);
  const digest = SparkMD5.ArrayBuffer.hash(copy.buffer, true);
  return Uint8Array.from({ length: 16 }, (_, i) => digest.charCodeAt((i + 1) % 16) ^ 0x33);
}
function validateTransform(t: Transform | undefined): asserts t is Transform {
  if (!t || t.length !== 8 || t.some((x) => !Number.isFinite(x)) || t[0] <= 0)
    throw new Error('蓝图变换数据无效');
}
function validatePrefix(prefix: Uint8Array): void {
  if (prefix.length !== 222) throw new Error('不支持此场景头');
  const v = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (v.getUint8(0) !== 1 || v.getUint32(1, true) !== 7) throw new Error('仅支持第 7 版蓝图');
  const fields = [
    ...Array.from({ length: 8 }, (_, i) => 5 + i * 4),
    ...Array.from({ length: 10 }, (_, i) => 62 + i * 4),
    ...Array.from({ length: 10 }, (_, i) => 182 + i * 4),
  ];
  if (fields.some((p) => !Number.isFinite(v.getFloat32(p, true))))
    throw new Error('场景头含无效坐标');
  if (
    v.getUint8(41) ||
    v.getUint32(42, true) ||
    v.getUint32(46, true) !== 2 ||
    v.getUint32(50, true) !== 3
  )
    throw new Error('暂不支持此场景格式');
  for (let i = 0; i < 3; i++) {
    const p = 102 + i * 21;
    if (
      [0, 4, 12, 16].some((o) => v.getUint32(p + o, true) !== 0) ||
      v.getUint32(p + 8, true) !== i ||
      v.getUint8(p + 20) !== 0
    )
      throw new Error('暂不支持地表绘制数据');
  }
  if (v.getUint32(165, true) !== 1 || v.getUint8(177) !== 0)
    throw new Error('暂不支持植被绘制数据');
}
class Writer {
  bytes = new Uint8Array(4096);
  view = new DataView(this.bytes.buffer);
  position = 0;
  reserve(n: number): void {
    if (this.position + n > MAX_BYTES - 16) throw new Error('蓝图文件过大');
    if (this.position + n <= this.bytes.length) return;
    const next = new Uint8Array(
      Math.min(MAX_BYTES, Math.max(this.bytes.length * 2, this.position + n)),
    );
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  integer(n: number, bits: 8 | 16 | 32): void {
    if (!Number.isInteger(n) || n < 0 || n > 2 ** bits - 1) throw new Error('蓝图整数超出范围');
    this.reserve(bits / 8);
    if (bits === 8) this.view.setUint8(this.position, n);
    else if (bits === 16) this.view.setUint16(this.position, n, true);
    else this.view.setUint32(this.position, n, true);
    this.position += bits / 8;
  }
  float(n: number): void {
    this.reserve(4);
    this.view.setFloat32(this.position, n, true);
    if (!Number.isFinite(this.view.getFloat32(this.position, true)))
      throw new Error('蓝图坐标超出范围');
    this.position += 4;
  }
  raw(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.position);
    this.position += bytes.length;
  }
}
export function encodeBlueprint(blueprint: Blueprint): Uint8Array {
  const writer = new Writer();
  if (blueprint.global) {
    validatePrefix(blueprint.prefix ?? new Uint8Array());
    writer.raw(blueprint.prefix!);
  } else {
    if (blueprint.prefix?.length) throw new Error('局部蓝图不能带场景头');
    writer.integer(0, 8);
    writer.integer(7, 32);
  }
  const pending: [BlueprintNode, number][] = [[blueprint.root, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error('蓝图节点或层级过多');
    if (!Array.isArray(node.children) || node.children.length > 65535)
      throw new Error('子节点数量超出格式范围');
    writer.integer(node.type, 8);
    if (OBJECTS.has(node.type)) {
      writer.integer(node.flags ?? 0, 32);
      writer.integer(node.instanceId!, 32);
      writer.integer(node.representId!, 32);
      writer.integer(node.builtin ?? 0, 8);
      writer.integer(node.detail ?? 0, 8);
      writer.integer(node.children.length, 16);
    } else if (node.type === 9) {
      writer.integer(node.instanceId!, 32);
      writer.integer(node.brushId!, 16);
      writer.integer(node.mask!, 16);
      writer.integer(node.cascadeState ?? 1, 8);
      writer.integer(node.children.length, 16);
    } else if (CONTAINERS.has(node.type)) {
      writer.integer(node.index!, 16);
      writer.integer(node.children.length, 16);
    } else throw new Error('暂不支持这种蓝图节点');
    if (OBJECTS.has(node.type) || node.type === 9 || node.children.length) {
      validateTransform(node.transform);
      if (node.axisScale) {
        if (
          ![0, 3].includes(node.type) ||
          node.transform[0] !== 1 ||
          node.axisScale.length !== 3 ||
          node.axisScale.some((x) => !Number.isFinite(x) || x <= 0)
        )
          throw new Error('非等比缩放数据无效');
        node.axisScale.forEach((x) => writer.float(x));
        node.transform.slice(1).forEach((x) => writer.float(x));
      } else node.transform.forEach((x) => writer.float(x));
    } else if (node.transform || node.axisScale) throw new Error('空挂点不能携带变换');
    for (let i = node.children.length - 1; i >= 0; i--) pending.push([node.children[i], depth + 1]);
  }
  const payload = writer.bytes.slice(0, writer.position),
    output = new Uint8Array(payload.length + 16);
  output.set(payload);
  output.set(checksum(payload), payload.length);
  return output;
}
export function decodeBlueprint(
  bytes: Uint8Array,
  rules?: { nonUniformResources: ReadonlySet<number> },
): Blueprint {
  if (bytes.length < 26 || bytes.length > MAX_BYTES) throw new Error('蓝图文件长度无效');
  const payload = bytes.subarray(0, -16),
    actual = bytes.subarray(-16),
    expected = checksum(payload);
  if (actual.some((x, i) => x !== expected[i])) throw new Error('蓝图校验失败');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let p = 0,
    count = 0;
  const uint = (bits: 8 | 16 | 32): number => {
    if (p + bits / 8 > payload.length) throw new Error('蓝图数据不完整');
    const value =
      bits === 8
        ? view.getUint8(p)
        : bits === 16
          ? view.getUint16(p, true)
          : view.getUint32(p, true);
    p += bits / 8;
    return value;
  };
  const flag = uint(8),
    version = uint(32);
  if (flag > 1 || version !== 7) throw new Error('仅支持第 7 版蓝图');
  let prefix: Uint8Array | undefined;
  if (flag) {
    prefix = payload.slice(0, 222);
    validatePrefix(prefix);
    p = 222;
  }
  const readNode = (depth: number): BlueprintNode => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error('蓝图节点或层级过多');
    const node: BlueprintNode = { type: uint(8), children: [] };
    let children: number;
    if (OBJECTS.has(node.type)) {
      node.flags = uint(32);
      node.instanceId = uint(32);
      node.representId = uint(32);
      node.builtin = uint(8);
      node.detail = uint(8);
      children = uint(16);
    } else if (node.type === 9) {
      node.instanceId = uint(32);
      node.brushId = uint(16);
      node.mask = uint(16);
      node.cascadeState = uint(8);
      children = uint(16);
    } else if (CONTAINERS.has(node.type)) {
      node.index = uint(16);
      children = uint(16);
    } else throw new Error('暂不支持这种蓝图节点');
    if (OBJECTS.has(node.type) || node.type === 9 || children) {
      const axisScaling =
        [0, 3].includes(node.type) && rules?.nonUniformResources.has(node.representId!);
      if (p + (axisScaling ? 40 : 32) > payload.length) throw new Error('蓝图坐标不完整');
      if (axisScaling) {
        node.axisScale = Array.from({ length: 3 }, () => {
          const v = view.getFloat32(p, true);
          p += 4;
          return v;
        }) as Vec3;
        if (node.axisScale.some((x) => !Number.isFinite(x) || x <= 0))
          throw new Error('非等比缩放数据无效');
      }
      node.transform = Array.from({ length: 8 }, (_, index) => {
        if (axisScaling && index === 0) return 1;
        const x = view.getFloat32(p, true);
        p += 4;
        return x;
      }) as Transform;
      validateTransform(node.transform);
    }
    for (let i = 0; i < children; i++) node.children.push(readNode(depth + 1));
    return node;
  };
  const root = readNode(0);
  if (p !== payload.length) throw new Error('蓝图含未识别数据');
  if (
    flag &&
    (root.type !== 5 ||
      root.index !== 0 ||
      !root.children.length ||
      root.transform?.slice(0, 5).some((x, i) => x !== [1, 0, 0, 0, 1][i]))
  )
    throw new Error('不支持此场景根节点');
  return { global: !!flag, root, prefix };
}
export function walkNodes(root: BlueprintNode): BlueprintNode[] {
  const pending = [root],
    output: BlueprintNode[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    output.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  return output;
}
