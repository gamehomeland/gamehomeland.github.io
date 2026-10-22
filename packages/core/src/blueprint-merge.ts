import { checksum } from './codec.js';
import { connectBasementBlueprint } from './blueprint-connect.js';
import { blueprintWorldMatrices } from './blueprint-transform.js';
import { scanWholeBlueprint as scan, type WholeBlueprintInfo } from './blueprint-structure.js';
export type { WholeBlueprintInfo } from './blueprint-structure.js';

export function inspectWholeBlueprint(bytes: Uint8Array): WholeBlueprintInfo {
  const s = scan(bytes);
  return {
    widthM: s.extent[0] / 50,
    depthM: s.extent[1] / 50,
    objectCount: s.nodes.filter((n) => n.id !== undefined).length,
    basementCount: s.nodes.filter((n) => n.type === 9).length,
  };
}

/** 将新增场景追加到已有整屋；不扁平化或重编码原有节点。 */
export function mergeWholeBlueprintDetailed(base: Uint8Array, addition: Uint8Array) {
  const a = scan(base),
    b = scan(addition);
  if (a.extent.some((v, i) => Math.abs(v - b.extent[i]) > 0.1))
    throw new Error('保留蓝图与当前户型范围不一致，请选择对应户型');
  const count = a.root.children.length + b.root.children.length;
  if (count > 65535) throw new Error('合并后根节点数量超出格式范围');
  const append = Uint8Array.from(addition.subarray(b.root.dataEnd, b.root.end)),
    appendView = new DataView(append.buffer);
  let nextId = a.nextId;
  for (const n of b.nodes)
    if (n.idOffset !== undefined) {
      if (nextId >= 0xffffffff) throw new Error('合并后实例编号超出格式范围');
      appendView.setUint32(n.idOffset - b.root.dataEnd, nextId++, true);
    }
  const insertIdentity = a.root.children.length === 0;
  const prefix = Uint8Array.from(base.subarray(0, a.root.dataEnd)),
    header = new DataView(prefix.buffer);
  header.setUint16(a.root.countOffset, count, true);
  header.setUint32(37, nextId, true);
  for (let i = 0; i < 3; i++) {
    header.setFloat32(13 + i * 4, Math.min(a.bounds[i], b.bounds[i]), true);
    header.setFloat32(25 + i * 4, Math.max(a.bounds[i + 3], b.bounds[i + 3]), true);
  }
  const old = base.subarray(a.root.dataEnd, a.root.end),
    identity = new Uint8Array(insertIdentity ? 32 : 0);
  if (insertIdentity) {
    const v = new DataView(identity.buffer);
    v.setFloat32(0, 1, true);
    v.setFloat32(16, 1, true);
  }
  const result = new Uint8Array(prefix.length + identity.length + old.length + append.length + 16);
  let offset = 0;
  for (const part of [prefix, identity, old, append]) {
    result.set(part, offset);
    offset += part.length;
  }
  result.set(checksum(result.subarray(0, offset)), offset);
  const check = scan(result);
  if (check.root.children.length !== count || check.nextId !== nextId)
    throw new Error('合并后的结构校验失败');
  return connectBasementBlueprint(
    result,
    new Set(a.nodes.filter((n) => n.id !== undefined).map((n) => n.id!)),
  );
}

export function mergeWholeBlueprint(base: Uint8Array, addition: Uint8Array): Uint8Array {
  return mergeWholeBlueprintDetailed(base, addition).blueprint;
}

/** 原整屋只读预览数据；原业务字段仍由合并器按字节保留。 */
export function readWholeBlueprintPreview(bytes: Uint8Array) {
  const tree = scan(bytes),
    world = blueprintWorldMatrices(tree.root);
  return {
    extentM: tree.extent.map((v) => v / 50),
    rooms: tree.nodes
      .filter((n) => n.type === 9)
      .map((n) => ({
        id: n.id!,
        brushId: n.brushId!,
        mask: n.mask!,
        position: n.position!.map((v) => v / 100),
        rotation: n.rotation!,
      })),
    objects: tree.nodes
      .filter((n) => n.id !== undefined && n.type !== 9)
      .map((n) => {
        const matrix = [...world.get(n)!];
        for (const i of [12, 13, 14]) matrix[i] /= 100;
        return { id: n.id!, type: n.type, resourceId: n.resourceId, detail: n.detail ?? 0, matrix };
      }),
  };
}
export type WholeBlueprintPreview = ReturnType<typeof readWholeBlueprintPreview>;
