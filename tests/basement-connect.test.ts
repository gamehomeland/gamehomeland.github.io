import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  emptyScene,
  exportSceneBlueprint,
  editorResources,
  placeSceneItem,
  writeSceneProject,
  readSceneProject,
  type SceneItem,
} from '../packages/core/src/editor.js';
import {
  mergeWholeBlueprintDetailed,
  readWholeBlueprintPreview,
} from '../packages/core/src/blueprint-merge.js';
import { scanWholeBlueprint, type RawNode } from '../packages/core/src/blueprint-structure.js';
import {
  basementModelById,
  basementVariant,
  basementExpansionCandidates,
  type BasementCell,
} from '../packages/core/src/basement.js';
import { encodeBlueprint, decodeBlueprint } from '../packages/core/src/codec.js';

const cell = (id = 'a', x = 0, z = 0, level = 0, brushId = 84): BasementCell => ({
  id,
  x,
  z,
  level,
  brushId,
});
const doc = (cells = [cell()]) => ({
  ...emptyScene(),
  landKey: 'blueprint:40:56',
  basementMergeOnly: true as const,
  basements: cells,
});
const chair = (): SceneItem => ({
  id: 'chair',
  resourceKey: editorResources.find((r) => r.representId === 19315)!.key,
  detail: 0,
  position: [0, 0, 0],
  rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)],
  scale: [1, 1, 1],
});
const emit = (d: ReturnType<typeof doc>) => exportSceneBlueprint(d, { forMerge: true });
function independentWorld(bytes: Uint8Array) {
  const tree = scanWholeBlueprint(bytes),
    values = new Map<number, { node: RawNode; matrix: Matrix4 }>();
  const walk = (node: RawNode, parent: Matrix4) => {
    const local =
      node === tree.root || !node.rotation
        ? new Matrix4()
        : new Matrix4().compose(
            new Vector3(...(node.position as [number, number, number])),
            new Quaternion(...node.rotation).normalize(),
            new Vector3(...node.scale!),
          );
    const matrix = parent.clone().multiply(local);
    if (node.id !== undefined) values.set(node.id, { node, matrix });
    node.children.forEach((c) => walk(c, matrix));
  };
  walk(tree.root, new Matrix4());
  return values;
}
function unchangedObjects(before: Uint8Array, after: Uint8Array) {
  const a = independentWorld(before),
    b = independentWorld(after);
  for (const [id, object] of a) {
    assert.ok(b.has(id));
    const actual = b.get(id)!;
    assert.equal(actual.node.type, object.node.type);
    assert.equal(actual.node.resourceId, object.node.resourceId);
    if (object.node.type === 9) continue;
    object.matrix.elements.forEach((v, i) =>
      assert.ok(
        Math.abs(v - actual.matrix.elements[i]) < (i >= 12 ? 0.01 : 0.00005),
        `instance ${id} matrix ${i}`,
      ),
    );
  }
}

test('六种材质横向连通，原房间和新增房间两侧掩码同步，家具姿态不变', () => {
  for (const brushId of [74, 82, 83, 84, 113, 114])
    for (const [x, z, bit, opposite] of [
      [1, 0, 2, 8],
      [-1, 0, 8, 2],
      [0, 1, 1, 4],
      [0, -1, 4, 1],
    ]) {
      const original = doc([cell('old', 0, 0, 0, brushId)]);
      original.items = [placeSceneItem(chair(), original, 'old')];
      const base = emit(original),
        addition = emit(doc([cell('new', x, z, 0, brushId)]));
      const result = mergeWholeBlueprintDetailed(base, addition),
        p = readWholeBlueprintPreview(result.blueprint);
      assert.equal(result.report.connections, 1);
      assert.deepEqual(
        p.rooms.map((r) => r.mask),
        [64 | bit, 64 | opposite],
      );
      unchangedObjects(base, result.blueprint);
    }
});

test('下方连通移除旧地板，家具及其子挂接迁移到可用地板并保持世界变换', () => {
  const d = doc();
  d.items = [placeSceneItem(chair(), d, 'a')];
  const base = emit(d),
    result = mergeWholeBlueprintDetailed(base, emit(doc([cell('down', 0, 0, 1)])));
  assert.deepEqual(
    readWholeBlueprintPreview(result.blueprint).rooms.map((r) => r.mask),
    [80, 32],
  );
  assert.deepEqual(result.report.transferredAttachments, [1]);
  unchangedObjects(base, result.blueprint);
  const tree = scanWholeBlueprint(result.blueprint),
    furniture = tree.nodes.find((n) => n.id === 1)!;
  const lower = tree.root.children.find((n) => n.position?.[1] === -400)!;
  assert.ok(lower.children.some((p) => p.children.includes(furniture)));
  const old = scanWholeBlueprint(base).nodes.find((n) => n.id === 1)!;
  assert.ok(Math.abs(furniture.position![1] - old.position![1] - 400) < 0.01);
  assert.throws(() => exportSceneBlueprint(doc([cell('down', 0, 0, 1)])), /连通地表/);
  assert.equal(
    readSceneProject(writeSceneProject(doc([cell('down', 0, 0, 1)]))).basementMergeOnly,
    true,
  );
});

test('墙面消失时挂件保留原位；其他墙面按几何位置重新匹配索引', () => {
  const original = decodeBlueprint(emit(doc())),
    room = original.root.children[0];
  const anchors = basementModelById.get(84)!.variants[basementVariant(64).index].anchors;
  let id = 2;
  for (const anchor of anchors.filter((a) => a.tags.includes('Vertical'))) {
    const plane = room.children.find((p) => p.index === anchor.index)!;
    plane.transform = [
      1,
      ...anchor.rotation,
      ...anchor.position.map((v) => v * 100),
    ] as typeof plane.transform;
    plane.children.push({
      type: 0,
      flags: 0x123400,
      instanceId: id++,
      representId: 19315,
      builtin: 0,
      detail: 0,
      transform: [1, 0, Math.sin(0.3), 0, Math.cos(0.3), 30, 20, 10],
      children: [],
    });
  }
  new DataView(original.prefix!.buffer).setUint32(37, id, true);
  const base = encodeBlueprint(original),
    result = mergeWholeBlueprintDetailed(base, emit(doc([cell('east', 1)])));
  assert.equal(result.report.transferredAttachments.length, 1);
  assert.equal(result.report.attachmentRemaps, 4);
  unchangedObjects(base, result.blueprint);
  const old = scanWholeBlueprint(base),
    next = scanWholeBlueprint(result.blueprint);
  for (const n of old.nodes.filter((n) => n.type === 0)) {
    const match = next.nodes.find((m) => m.id === n.id)!;
    assert.equal(
      new DataView(base.buffer).getUint32(n.start + 1, true),
      new DataView(result.blueprint.buffer).getUint32(match.start + 1, true),
    );
  }
});

test('原家具的多层子树与非等比缩放保留，不将家具内部挂接扁平化', () => {
  const d = doc();
  d.items = [placeSceneItem(chair(), d, 'a')];
  const raw = decodeBlueprint(emit(d)),
    floor = raw.root.children[0].children.find((n) => n.children.length)!;
  floor.children[0].children = [
    {
      type: 5,
      index: 0,
      transform: [1, 0, 0, 0, 1, 0, 30, 0],
      children: [
        {
          type: 0,
          flags: 0,
          instanceId: 10,
          representId: 21276,
          builtin: 0,
          detail: 0,
          transform: [1, 0, 0.25, 0, Math.sqrt(1 - 0.25 ** 2), 20, 0, -10],
          axisScale: [0.2, 0.5, 0.3],
          children: [],
        },
      ],
    },
  ];
  new DataView(raw.prefix!.buffer).setUint32(37, 11, true);
  const base = encodeBlueprint(raw),
    result = mergeWholeBlueprintDetailed(base, emit(doc([cell('down', 0, 0, 1)])));
  unchangedObjects(base, result.blueprint);
  const old = scanWholeBlueprint(base).nodes.find((n) => n.id === 10)!,
    next = scanWholeBlueprint(result.blueprint).nodes.find((n) => n.id === 10)!;
  assert.deepEqual(
    result.blueprint.subarray(next.start, next.end),
    base.subarray(old.start, old.end),
  );
});

test('合并时仅接原房间的深层新增单元可用，孤立单元及混规格接缝拒绝', () => {
  const base = emit(doc());
  assert.throws(
    () => mergeWholeBlueprintDetailed(base, emit(doc([cell('orphan', 2, 0, 2)]))),
    /尚未连到/,
  );
  assert.throws(
    () => mergeWholeBlueprintDetailed(base, emit(doc([cell('mixed', 0.75, 0, 0, 114)]))),
    /相同/,
  );
  assert.throws(
    () => mergeWholeBlueprintDetailed(base, emit(doc([cell('partial', 1, 0.25)]))),
    /对齐/,
  );
});

test('可点击扩建格与原房间同规格同网格，排除已有单元、越界和混规格接缝', () => {
  const original = [cell('old', 0.5, -0.5)];
  const surface = basementExpansionCandidates(original, 4, 0, 'blueprint:40:56');
  assert.deepEqual(
    surface.map((c) => [c.x, c.z]).sort(),
    [
      [0.5, 0.5],
      [1.5, -0.5],
      [0.5, -1.5],
      [-0.5, -0.5],
    ].sort(),
  );
  const below = basementExpansionCandidates(original, 4, 1);
  assert.equal(below.length, 1);
  assert.equal(below[0].x, 0.5);
  assert.deepEqual(basementExpansionCandidates(original, 8, 0), []);
  assert.deepEqual(basementExpansionCandidates(original, 4, 8), []);
  const bounded = basementExpansionCandidates([cell()], 4, 0, 'blueprint:4:4');
  assert.equal(bounded.length, 0);
});

test('从原下层向上补房间，同时打通顶面和相邻侧面并保留家具', () => {
  const original = doc([cell('surface'), cell('lower', 0, 0, 1), cell('under-new', 1, 0, 1)]);
  original.items = [placeSceneItem(chair(), original, 'under-new')];
  const base = emit(original),
    result = mergeWholeBlueprintDetailed(base, emit(doc([cell('upper', 1, 0, 0)])));
  assert.equal(result.report.connections, 2);
  const rooms = readWholeBlueprintPreview(result.blueprint).rooms;
  assert.ok(rooms.find((r) => r.position[0] === 4 && r.position[1] === -4)!.mask & 32);
  assert.equal(rooms.at(-1)!.mask, 64 | 16 | 8);
  unchangedObjects(base, result.blueprint);
});
