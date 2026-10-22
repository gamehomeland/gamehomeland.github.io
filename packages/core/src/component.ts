import type { BlueprintNode, Orientation, Transform, Vec3, Quat } from './types.js';
import { support } from './catalog.js';
import { multiply, rotate } from './math.js';

/** 导出分组策略，不代表客户端挂接数量上限。 */
export const GROUP_SIZE = 50;
export function supportCount(count: number): number {
  let total = 0;
  while (count > 0) {
    count = Math.ceil(count / GROUP_SIZE);
    total += count;
    if (count === 1) break;
  }
  return total;
}
export const objectNode = (
  type: number,
  id: number,
  resource: number,
  transform: Transform,
  children: BlueprintNode[],
  builtin = 0,
  detail = 0,
): BlueprintNode => ({
  type,
  instanceId: id,
  representId: resource,
  flags: 0,
  builtin,
  detail,
  transform,
  children,
});
export const socketNode = (index: number): BlueprintNode => ({ type: 5, index, children: [] });
export function assemble(
  groups: BlueprintNode[][],
  firstId: number,
  outer: Vec3,
  inner: Vec3,
  showHandle: boolean,
): BlueprintNode {
  if (!groups.length) throw new Error('图案没有可生成的家具');
  let next = firstId;
  const wrap = (children: BlueprintNode[], position: Vec3): BlueprintNode => {
    if (!children.length || children.length > GROUP_SIZE) throw new Error('家具分组无效');
    for (const child of children)
      for (let axis = 0; axis < 3; axis++)
        child.transform![5 + axis] -=
          position[axis] + (axis === 1 ? support.meshY + support.socketY : 0);
    const anchor = socketNode(support.socketIndex);
    anchor.transform = [support.meshScale, 0, 0, 0, 1, 0, support.socketY, 0];
    anchor.children = children;
    const mesh = objectNode(
      0,
      next + 1,
      support.meshRepresentId,
      [support.meshScale, 0, 0, 0, 1, 0, support.meshY, 0],
      [socketNode(0), anchor],
      1,
    );
    const base = objectNode(3, next, support.representId, [1, 0, 0, 0, 1, ...position], [mesh]);
    next += 2;
    return base;
  };
  let level = groups.map((group) => wrap(group, groups.length === 1 ? outer : inner));
  while (level.length > 1) {
    const position = level.length <= GROUP_SIZE ? outer : inner,
      nextLevel: BlueprintNode[] = [];
    for (let start = 0; start < level.length; start += GROUP_SIZE)
      nextLevel.push(wrap(level.slice(start, start + GROUP_SIZE), position));
    level = nextLevel;
  }
  level[0].detail = level[0].children[0].detail = showHandle ? 1 : 0;
  return objectNode(8, next, 0xffffffff, [1, 0, 0, 0, 1, 0, 0, 0], level);
}
export function importOrientation(root: BlueprintNode, direction: Orientation): void {
  for (const base of root.children) {
    const t = base.transform!,
      mesh = base.children[0],
      anchor = mesh.children[support.socketIndex];
    if (direction === 'wall') {
      const ox = t[5] + mesh.transform![5] + anchor.transform![5],
        oz = t[7] + mesh.transform![7] + anchor.transform![7];
      for (const node of anchor.children) {
        const [s, x, y, z, w, px, py, pz] = node.transform!;
        node.transform = [s, z, w, -x, -y, -px - 2 * ox, py, -pz - 2 * oz];
      }
    } else {
      const [s, x, y, z, w, px, py, pz] = t;
      const flip: Transform = [s, z, w, -x, -y, -px, py, -pz];
      const quarter: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        q = multiply(quarter, flip.slice(1, 5) as Quat);
      const offset = rotate([-px, 0, -pz], quarter);
      for (const node of anchor.children) {
        const ct = node.transform!,
          point = rotate([ct[5], ct[6] + support.socketY, ct[7]], q);
        node.transform = [
          ct[0],
          ...multiply(q, ct.slice(1, 5) as Quat),
          point[0] + offset[0],
          point[1] + offset[1] - support.socketY,
          point[2] + offset[2],
        ];
      }
      mesh.transform!.splice(1, 4, -Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      base.transform = [s, 0, 0, 0, 1, 0, py, 0];
    }
  }
}
export function undoImport(root: BlueprintNode, direction: Orientation, miniature: boolean): void {
  for (const base of root.children) {
    if (base.type !== 3 || base.representId !== support.representId) throw new Error('未知根基座');
    const mesh = base.children[0],
      anchor = mesh?.children[support.socketIndex];
    if (!anchor || mesh.representId !== support.meshRepresentId) throw new Error('基座结构不完整');
    if (direction === 'wall') {
      if (miniature) continue;
      const ox = base.transform![5] + mesh.transform![5] + anchor.transform![5],
        oz = base.transform![7] + mesh.transform![7] + anchor.transform![7];
      for (const node of anchor.children) {
        const [s, x, y, z, w, px, py, pz] = node.transform!;
        node.transform = [s, -z, -w, x, y, -px - 2 * ox, py, -pz - 2 * oz];
      }
    } else {
      const q = multiply([Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 1, 0, 0]),
        inverse: Quat = [-q[0], -q[1], -q[2], q[3]];
      const offset = rotate([0, 0, -60], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
      for (const node of anchor.children) {
        const t = node.transform!,
          point = rotate(
            [t[5] - offset[0], t[6] + support.socketY - offset[1], t[7] - offset[2]],
            inverse,
          );
        node.transform = [
          t[0],
          ...multiply(inverse, t.slice(1, 5) as Quat),
          point[0],
          point[1] - support.socketY,
          point[2],
        ];
      }
      base.transform = [1, 0, 0, 0, 1, 0, 0, 60];
      mesh.transform!.splice(1, 4, 0, 0, 0, 1);
    }
  }
}
export interface PlacedNode {
  node: BlueprintNode;
  position: Vec3;
  rotation: Quat;
}
export function placedNodes(root: BlueprintNode): PlacedNode[] {
  const result: PlacedNode[] = [];
  const pending: { node: BlueprintNode; position: Vec3; rotation: Quat }[] = [
    { node: root, position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  ];
  while (pending.length) {
    const { node, position: parent, rotation: parentQ } = pending.pop()!;
    const t = node.transform ?? [1, 0, 0, 0, 1, 0, 0, 0],
      delta = rotate(t.slice(5) as Vec3, parentQ),
      position = parent.map((x, i) => x + delta[i]) as Vec3;
    const rotation = multiply(parentQ, t.slice(1, 5) as Quat);
    result.push({ node, position, rotation });
    for (let i = node.children.length - 1; i >= 0; i--)
      pending.push({ node: node.children[i], position, rotation });
  }
  return result;
}
