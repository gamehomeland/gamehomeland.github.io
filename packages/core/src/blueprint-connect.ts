import { checksum } from './codec.js';
import { scanWholeBlueprint, type RawNode } from './blueprint-structure.js';
import {
  basementById,
  basementModelById,
  basementVariant,
  basementRotation,
  type BasementAnchor,
} from './basement.js';
import { rotate } from './math.js';
import type { Vec3 } from './types.js';
import {
  nodeFrame,
  composeFrame,
  rebaseSubtree,
  blueprintWorldMatrices,
  unitQuaternion,
  relativePosition,
  type RigidFrame,
} from './blueprint-transform.js';

export interface BasementConnectionReport {
  connections: number;
  changedOriginalRooms: number[];
  attachmentRemaps: number;
  transferredAttachments: number[];
}
interface Room {
  node: RawNode;
  old: boolean;
  size: number;
  frame: RigidFrame;
  nextFrame: RigidFrame;
  mask: number;
  nextMask: number;
  anchors: BasementAnchor[];
  nextAnchors: BasementAnchor[];
  adjacent: Set<Room>;
  changed: boolean;
  dirty: boolean;
  buckets: Map<number, Uint8Array[]>;
  frames: Map<number, RigidFrame>;
  planes: Map<number, RawNode>;
}
function anchorFrame(room: RigidFrame, anchor: BasementAnchor): RigidFrame {
  return composeFrame(room, {
    position: anchor.position.map((v) => v * 100) as Vec3,
    rotation: unitQuaternion(anchor.rotation),
    scale: 1,
  });
}
function sameTags(a: BasementAnchor, b: BasementAnchor) {
  return [...a.tags].sort().join('|') === [...b.tags].sort().join('|');
}
function matchingPlane(room: Room, old: BasementAnchor, frame: RigidFrame) {
  const normal = rotate([0, 1, 0], frame.rotation);
  return room.nextAnchors.find((anchor) => {
    const next = room.frames.get(anchor.index)!,
      direction = rotate([0, 1, 0], next.rotation);
    return (
      sameTags(old, anchor) &&
      Math.hypot(...next.position.map((v, i) => v - frame.position[i])) < 5 &&
      normal.reduce((sum, v, i) => sum + v * direction[i], 0) > 0.99
    );
  });
}
function fallbackFloor(source: Room, at: Vec3) {
  const queue = [source],
    seen = new Set<Room>(),
    choices: { room: Room; anchor: BasementAnchor; score: number }[] = [];
  for (let i = 0; i < queue.length; i++) {
    const room = queue[i];
    if (seen.has(room)) continue;
    seen.add(room);
    for (const anchor of room.nextAnchors.filter((a) => a.tags.includes('H_Floor'))) {
      const frame = room.frames.get(anchor.index)!;
      const horizontal = Math.hypot(frame.position[0] - at[0], frame.position[2] - at[2]);
      const local = relativePosition(at, frame),
        covers =
          Math.abs(local[0]) <= anchor.sizeM[0] * 50 + 1 &&
          Math.abs(local[2]) <= anchor.sizeM[1] * 50 + 1;
      choices.push({
        room,
        anchor,
        score:
          horizontal * 4 +
          Math.abs(frame.position[1] - at[1]) +
          (frame.position[1] > at[1] + 1 ? 1e6 : 0) +
          (covers ? 0 : 1e7),
      });
    }
    queue.push(...room.adjacent);
  }
  choices.sort((a, b) => a.score - b.score);
  if (!choices.length) throw new Error('连通后没有可承接原挂件的地板，原布置未修改');
  return choices[0];
}
function concatenate(parts: Uint8Array[]) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  if (length > 32_000_000) throw new Error('连通后的整屋蓝图超过 32 MB');
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 在原始合并树上更新同规格连通形态，保留全部家具实例和世界变换。 */
export function connectBasementBlueprint(bytes: Uint8Array, originalIds: ReadonlySet<number>) {
  const tree = scanWholeBlueprint(bytes),
    report: BasementConnectionReport = {
      connections: 0,
      changedOriginalRooms: [],
      attachmentRemaps: 0,
      transferredAttachments: [],
    };
  const rooms: Room[] = tree.nodes
    .filter((n) => n.type === 9)
    .map((node) => {
      const resource = basementById.get(node.brushId!),
        frame = nodeFrame(node),
        mask = node.mask!;
      if (!resource || !tree.root.children.includes(node))
        throw new Error('未支持的地下室资源或父节点');
      if (Math.abs(frame.scale - 1) > 1e-6) throw new Error('缩放后的地下室不能参与连通');
      const anchors = basementModelById.get(node.brushId!)!.variants[basementVariant(mask).index]
        .anchors;
      return {
        node,
        old: originalIds.has(node.id!),
        size: resource.size * 100,
        frame,
        nextFrame: frame,
        mask,
        nextMask: originalIds.has(node.id!)
          ? mask
          : Math.abs(frame.position[1]) < resource.size * 50
            ? 64
            : 0,
        anchors,
        nextAnchors: anchors,
        adjacent: new Set(),
        changed: false,
        dirty: false,
        buckets: new Map(),
        frames: new Map(),
        planes: new Map(),
      };
    });
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i],
        b = rooms[j],
        p = a.frame.position,
        q = b.frame.position;
      const delta = q.map((v, k) => v - p[k]),
        half = (a.size + b.size) / 2;
      const gaps = [
        Math.abs(delta[0]) - half,
        Math.abs(p[1] - a.size / 2 - (q[1] - b.size / 2)) - half,
        Math.abs(delta[2]) - half,
      ];
      const interacts = gaps.every((v) => v <= 0.01) && gaps.filter((v) => v < -0.01).length >= 2;
      if (!interacts) continue;
      if (gaps.every((v) => v < -0.01)) {
        if (!a.old || !b.old) throw new Error('新增地下室与已有房间重叠，请调整位置');
        continue;
      }
      const axis = delta.findIndex((v) => Math.abs(Math.abs(v) - a.size) < 0.01),
        aligned =
          a.size === b.size && axis >= 0 && delta.every((v, k) => k === axis || Math.abs(v) < 0.01);
      if (!aligned) {
        if (!a.old || !b.old)
          throw new Error(
            a.size !== b.size
              ? '连通需要使用与原房间相同的 4 米或 8 米规格'
              : '相邻房间未对齐完整侧面，请对齐原房间网格',
          );
        continue;
      }
      a.adjacent.add(b);
      b.adjacent.add(a);
      if (a.old && b.old) continue;
      const bit =
          axis === 0
            ? delta[0] > 0
              ? 2
              : 8
            : axis === 2
              ? delta[2] > 0
                ? 1
                : 4
              : delta[1] > 0
                ? 32
                : 16,
        opposite = ({ 1: 4, 4: 1, 2: 8, 8: 2, 16: 32, 32: 16 } as Record<number, number>)[bit];
      a.nextMask |= bit;
      b.nextMask |= opposite;
      if (a.old !== b.old) report.connections++;
    }
  const reached = new Set<Room>(),
    queue = rooms.filter((r) => r.old || r.nextMask & 64);
  for (let i = 0; i < queue.length; i++) {
    const room = queue[i];
    if (reached.has(room)) continue;
    reached.add(room);
    queue.push(...room.adjacent);
  }
  if (rooms.some((r) => !r.old && !reached.has(r)))
    throw new Error('新增地下室尚未连到原房间或地表洞口');
  for (const room of rooms) {
    room.changed = room.nextMask !== room.mask;
    room.dirty = room.changed;
    if (room.changed) {
      const expected = basementRotation(room.mask),
        q = room.frame.rotation;
      if (
        Math.min(
          ...[1, -1].map((sign) => Math.max(...q.map((v, i) => Math.abs(v - sign * expected[i])))),
        ) > 1e-5
      )
        throw new Error('原地下室旋转与连接形态不符，无法保持原挂接');
      room.nextFrame = { ...room.frame, rotation: basementRotation(room.nextMask) };
      room.nextAnchors = basementModelById.get(room.node.brushId!)!.variants[
        basementVariant(room.nextMask).index
      ].anchors;
      if (room.old) report.changedOriginalRooms.push(room.node.id!);
    }
    for (const plane of room.node.children) {
      if (
        plane.type !== 5 ||
        plane.index === undefined ||
        plane.index >= room.anchors.length ||
        room.planes.has(plane.index)
      )
        throw new Error('地下室包含未适配的挂接容器，原文件未修改');
      room.planes.set(plane.index, plane);
    }
    for (const anchor of room.nextAnchors) {
      const old = room.planes.get(anchor.index);
      const frame =
        !room.changed && old?.children.length
          ? composeFrame(room.frame, nodeFrame(old))
          : anchorFrame(room.nextFrame, anchor);
      room.frames.set(anchor.index, frame);
      room.buckets.set(anchor.index, []);
      if (!room.changed && old)
        room.buckets.set(
          anchor.index,
          old.children.map((n) => Uint8Array.from(bytes.subarray(n.start, n.end))),
        );
    }
  }
  for (const room of rooms.filter((r) => r.changed))
    for (const plane of room.node.children) {
      if (!plane.children.length) continue;
      const old = room.anchors[plane.index!],
        oldFrame = composeFrame(room.frame, nodeFrame(plane)),
        same = matchingPlane(room, old, oldFrame);
      for (const child of plane.children) {
        const at = child.position
          ? composeFrame(oldFrame, { ...nodeFrame({ ...child, scale: [1, 1, 1] }), scale: 1 })
              .position
          : oldFrame.position;
        const target = same ? { room, anchor: same } : fallbackFloor(room, at),
          newFrame = target.room.frames.get(target.anchor.index)!;
        target.room.buckets
          .get(target.anchor.index)!
          .push(rebaseSubtree(bytes, child, oldFrame, newFrame));
        target.room.dirty = true;
        report.attachmentRemaps++;
        if (!same && child.id !== undefined) report.transferredAttachments.push(child.id);
      }
    }
  const replacements = new Map<RawNode, Uint8Array>();
  for (const room of rooms.filter((r) => r.dirty)) {
    const head = Uint8Array.from(bytes.subarray(room.node.start, room.node.dataEnd)),
      h = new DataView(head.buffer);
    h.setUint16(7, room.nextMask, true);
    h.setUint16(10, room.nextAnchors.length, true);
    if (room.changed) room.nextFrame.rotation.forEach((v, i) => h.setFloat32(16 + i * 4, v, true));
    const children = room.nextAnchors.map((anchor) => {
      const contents = room.buckets.get(anchor.index)!;
      if (contents.length > 65535) throw new Error('迁移后的挂面对象数量超出格式范围');
      const old = room.planes.get(anchor.index);
      const plane = new Uint8Array(contents.length ? 37 : 5),
        p = new DataView(plane.buffer);
      p.setUint8(0, 5);
      p.setUint16(1, anchor.index, true);
      p.setUint16(3, contents.length, true);
      if (contents.length) {
        if (!room.changed && old?.transformOffset !== undefined)
          plane.set(bytes.subarray(old.transformOffset, old.transformOffset + 32), 5);
        else
          [1, ...unitQuaternion(anchor.rotation), ...anchor.position.map((v) => v * 100)].forEach(
            (v, i) => p.setFloat32(5 + i * 4, v, true),
          );
      }
      return concatenate([plane, ...contents]);
    });
    replacements.set(room.node, concatenate([head, ...children]));
  }
  if (!replacements.size) return { blueprint: bytes, report };
  const body = concatenate([
    bytes.subarray(0, tree.root.dataEnd),
    ...tree.root.children.map((n) => replacements.get(n) ?? bytes.subarray(n.start, n.end)),
  ]);
  const output = concatenate([body, checksum(body)]),
    after = scanWholeBlueprint(output),
    beforeWorld = blueprintWorldMatrices(tree.root),
    afterWorld = blueprintWorldMatrices(after.root),
    afterIds = new Map(after.nodes.filter((n) => n.id !== undefined).map((n) => [n.id!, n]));
  for (const node of tree.nodes.filter((n) => n.id !== undefined)) {
    const next = afterIds.get(node.id!);
    if (!next || next.type !== node.type || next.resourceId !== node.resourceId)
      throw new Error('连通后对象身份校验失败');
    if (node.type === 9) {
      if (
        next.brushId !== node.brushId ||
        node.position!.some((v, i) => Math.abs(v - next.position![i]) > 0.001) ||
        node.scale!.some((v, i) => Math.abs(v - next.scale![i]) > 1e-6)
      )
        throw new Error(`原房间 ${node.id} 的资源、位置或尺寸发生变化`);
      continue;
    }
    const first = beforeWorld.get(node)!,
      last = afterWorld.get(next)!;
    if (
      first.some(
        (v, i) =>
          Math.abs(v - last[i]) >
          (i >= 12 && i <= 14
            ? Math.max(0.005, Math.abs(v) * 3e-7)
            : Math.max(3e-5, Math.abs(v) * 3e-6)),
      )
    )
      throw new Error(`连通后家具 ${node.id} 的位置或朝向校验失败`);
    const oldPayload = bytes.subarray(node.start, node.dataEnd),
      newPayload = output.subarray(next.start, next.dataEnd),
      start = node.transformOffset === undefined ? -1 : node.transformOffset - node.start;
    if (
      oldPayload.length !== newPayload.length ||
      oldPayload.some(
        (v, i) =>
          (i < start || start < 0 || i >= start + (node.axisScale ? 40 : 32)) &&
          v !== newPayload[i],
      )
    )
      throw new Error(`家具 ${node.id} 的业务字段发生变化，合并已取消`);
  }
  return { blueprint: output, report };
}
