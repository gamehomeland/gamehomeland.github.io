import { multiply, rotate } from './math.js';
import type { Vec3, Quat } from './types.js';
import type { RawNode } from './blueprint-structure.js';

export interface RigidFrame {
  position: Vec3;
  rotation: Quat;
  scale: number;
}
export const identityFrame = (): RigidFrame => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: 1,
});
export function unitQuaternion(q: Quat): Quat {
  const length = Math.hypot(...q);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 0.002)
    throw new Error('挂接旋转数据无效，原文件未修改');
  return q.map((v) => v / length) as Quat;
}
export function nodeFrame(n: RawNode): RigidFrame {
  if (
    !n.position ||
    !n.rotation ||
    !n.scale ||
    Math.max(...n.scale) - Math.min(...n.scale) > 1e-6 ||
    n.scale[0] <= 0
  )
    throw new Error('地下室挂面不是受支持的等比变换');
  return { position: n.position as Vec3, rotation: unitQuaternion(n.rotation), scale: n.scale[0] };
}
export function composeFrame(a: RigidFrame, b: RigidFrame): RigidFrame {
  const p = rotate(b.position, a.rotation);
  return {
    position: p.map((v, i) => v * a.scale + a.position[i]) as Vec3,
    rotation: unitQuaternion(multiply(a.rotation, b.rotation)),
    scale: a.scale * b.scale,
  };
}
export const inverseRotation = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function relativePosition(world: Vec3, parent: RigidFrame): Vec3 {
  return rotate(
    world.map((v, i) => (v - parent.position[i]) / parent.scale) as Vec3,
    inverseRotation(parent.rotation),
  );
}
export function frameClose(a: RigidFrame, b: RigidFrame) {
  return (
    Math.abs(a.scale - b.scale) < 1e-9 &&
    a.position.every((v, i) => Math.abs(v - b.position[i]) < 1e-7) &&
    Math.min(
      ...[1, -1].map((sign) =>
        Math.max(...a.rotation.map((v, i) => Math.abs(v - sign * b.rotation[i]))),
      ),
    ) < 1e-8
  );
}
/** 只改子树根节点SRT；资源、样式、业务字段与后续挂接子树原字节保留。 */
export function rebaseSubtree(
  bytes: Uint8Array,
  node: RawNode,
  oldParent: RigidFrame,
  newParent: RigidFrame,
): Uint8Array {
  const output = Uint8Array.from(bytes.subarray(node.start, node.end));
  if (frameClose(oldParent, newParent)) return output;
  if (node.transformOffset === undefined) {
    if (node.children.length) throw new Error('带子节点的挂件缺少变换，无法保留原位置');
    return output;
  }
  const offset = node.transformOffset - node.start,
    view = new DataView(output.buffer);
  const scaled = rotate(node.position as Vec3, oldParent.rotation),
    world = scaled.map((v, i) => v * oldParent.scale + oldParent.position[i]) as Vec3,
    position = relativePosition(world, newParent),
    rotation = unitQuaternion(
      multiply(
        inverseRotation(newParent.rotation),
        multiply(oldParent.rotation, unitQuaternion(node.rotation!)),
      ),
    ),
    scale = node.scale!.map((v) => (v * oldParent.scale) / newParent.scale),
    values = [...(node.axisScale ? scale : [scale[0]]), ...rotation, ...position];
  values.forEach((v, i) => view.setFloat32(offset + i * 4, v, true));
  return output;
}

export const identityMatrix = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiplyMatrix(a: number[], b: number[]) {
  const result = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) result[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return result;
}
export function nodeMatrix(node: RawNode) {
  if (!node.position || !node.rotation || !node.scale) return identityMatrix();
  const q = unitQuaternion(node.rotation),
    matrix: number[] = [];
  for (let i = 0; i < 3; i++) {
    const axis: Vec3 = [0, 0, 0];
    axis[i] = node.scale[i];
    matrix.push(...rotate(axis, q), 0);
  }
  matrix.push(...node.position, 1);
  return matrix;
}
/** 返回整屋根坐标中的矩阵，排除地图世界原点。 */
export function blueprintWorldMatrices(root: RawNode) {
  const out = new Map<RawNode, number[]>();
  const walk = (node: RawNode, parent: number[]) => {
    const matrix = node === root ? identityMatrix() : multiplyMatrix(parent, nodeMatrix(node));
    out.set(node, matrix);
    for (const child of node.children) walk(child, matrix);
  };
  walk(root, identityMatrix());
  return out;
}
