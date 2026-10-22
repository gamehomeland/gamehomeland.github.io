import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basementResources,
  basementMasks,
  basementVariant,
  validateBasements,
  editBasement,
  cutBasementGround,
  type BasementCell,
} from '../packages/core/src/basement.js';
import {
  emptyScene,
  exportSceneBlueprint,
  importSceneBlueprint,
  validateScene,
  writeSceneProject,
  readSceneProject,
  SceneHistory,
  sceneMaterials,
  scenePackage,
  editorResources,
} from '../packages/core/src/editor.js';
import { encodeBlueprint, decodeBlueprint, checksum } from '../packages/core/src/codec.js';
import { landCatalog, landPlan, type GroundPoint } from '../packages/core/src/land.js';
import { unzipSync, strFromU8 } from 'fflate';
import { basementDisplay } from '../apps/web/src/basement-view.js';
import { Box3, Mesh } from 'three';

const landKey = landCatalog.presets[0].key;
const cell = (id: string, x = 0, z = 0, level = 0, brushId = 74): BasementCell => ({
  id,
  x,
  z,
  level,
  brushId,
});
const doc = (cells: BasementCell[]) => ({ ...emptyScene(), landKey, basements: cells });
test('六种真实组件、家具目录和规格关联', () => {
  assert.deepEqual(
    basementResources.map((r) => [r.brushId, r.furnitureId, r.size]),
    [
      [74, 2040, 4],
      [82, 2149, 4],
      [83, 2150, 4],
      [84, 2151, 4],
      [113, 5466, 8],
      [114, 5863, 8],
    ],
  );
  assert.throws(() => validateBasements([cell('anti', 0, 0, 0, 79)]), /未知/);
});
test('水平邻接、混材质连通及上下连通掩码', () => {
  const cells = [cell('a'), cell('b', 1, 0, 0, 84), cell('c', 0, 0, 1)];
  assert.deepEqual([...basementMasks(cells).values()], [82, 72, 32]);
  assert.equal(basementMasks([cell('a')]).get('a'), 64);
  const center = cell('center', 0, 0, 1),
    all = [
      center,
      cell('z+', 0, 1, 1),
      cell('x+', 1, 0, 1),
      cell('z-', 0, -1, 1),
      cell('x-', -1, 0, 1),
      cell('down', 0, 0, 2),
      cell('up'),
    ];
  assert.equal(basementMasks(all).get('center'), 63);
});
test('原生24变体旋转归一与地表开口', () => {
  assert.deepEqual(basementVariant(64), { index: 11, letter: 'L', rotation: 0 });
  assert.deepEqual(basementVariant(0), { index: 23, letter: 'X', rotation: 0 });
  assert.equal(basementVariant(63).letter, 'A');
  assert.equal(basementVariant(62).letter, 'B');
  assert.equal(basementVariant(61).rotation, 90);
  for (let m = 0; m < 128; m++)
    assert.ok(basementVariant(m).index >= 0 && basementVariant(m).index < 24);
});
test('级联节点44字节，独立按偏移核对字段、默认兼容字节与浮点', () => {
  const bytes = encodeBlueprint({
    global: false,
    root: {
      type: 9,
      instanceId: 0x1234,
      brushId: 113,
      mask: 80,
      transform: [1, 0, 0, 0, 1, 800, -800, 0],
      children: [],
    },
  });
  assert.equal(bytes.length, 5 + 44 + 16);
  const b = Buffer.from(bytes);
  assert.equal(b[5], 9);
  assert.equal(b.readUInt32LE(6), 0x1234);
  assert.equal(b.readUInt16LE(10), 113);
  assert.equal(b.readUInt16LE(12), 80);
  assert.equal(b[14], 1);
  assert.equal(b.readUInt16LE(15), 0);
  assert.equal(b.readFloatLE(17), 1);
  assert.equal(b.readFloatLE(37), 800);
  assert.equal(b.readFloatLE(41), -800);
  assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
});
test('地下室整屋蓝图根平面及资源回读，工程保存和清单一致', () => {
  const d = doc([cell('a'), cell('b', 1, 0, 0, 84), cell('c', 0, 0, 1)]);
  const bytes = exportSceneBlueprint(d),
    parsed = decodeBlueprint(bytes),
    restored = importSceneBlueprint(bytes);
  assert.equal(parsed.global, true);
  assert.equal(parsed.root.type, 5);
  assert.equal(parsed.root.children.length, 3);
  assert.deepEqual(
    parsed.root.children.map((n) => n.mask),
    [82, 72, 32],
  );
  assert.ok(
    parsed.root.children.every(
      (n) =>
        n.type === 9 &&
        n.cascadeState === 1 &&
        n.children.every((p) => p.type === 5 && !p.children.length),
    ),
  );
  assert.deepEqual(
    restored.basements?.map(({ id, ...c }) => c),
    d.basements.map(({ id, ...c }) => c),
  );
  assert.deepEqual(exportSceneBlueprint(restored), bytes);
  assert.deepEqual(readSceneProject(writeSceneProject(d)), validateScene(d));
  assert.deepEqual(
    sceneMaterials(d).map((r) => [r.type, r.id, r.count]),
    [
      [1, 2040, 2],
      [1, 2151, 1],
    ],
  );
  const pack = unzipSync(scenePackage(d));
  assert.ok(strFromU8(pack['使用说明.txt']).includes('整屋蓝图'));
  assert.deepEqual(pack['家园布置.blueprintx'], bytes);
});
test('全六材质规格可导出，下层64洞口位不应设置', () => {
  for (const r of basementResources) {
    const b = exportSceneBlueprint(
      doc([cell('a', 0, 0, 0, r.brushId), cell('b', 0, 0, 1, r.brushId)]),
    );
    assert.deepEqual(
      decodeBlueprint(b).root.children.map((n) => n.mask),
      [80, 32],
    );
  }
});
test('仅地下室也能导出；无地块时保存工程可用、整屋导出给出明确提示', () => {
  const d = { ...emptyScene(), basements: [cell('a')] };
  assert.equal(readSceneProject(writeSceneProject(d)).basements?.length, 1);
  assert.throws(() => exportSceneBlueprint(d), /选择户型/);
  assert.throws(() => exportSceneBlueprint(emptyScene()), /添加/);
});
test('旧普通家具仍写局部Holder，地下室不会污染普通节点', () => {
  const r = editorResources.find((r) => !r.nonUniform)!;
  const d = {
    ...doc([cell('basement')]),
    items: [
      {
        id: 'f',
        resourceKey: r.key,
        detail: r.defaultDetail,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    ],
  };
  assert.deepEqual(
    decodeBlueprint(exportSceneBlueprint(d)).root.children.map((n) => n.type),
    [0, 9],
  );
  delete (d as any).basements;
  const p = decodeBlueprint(exportSceneBlueprint(d));
  assert.equal(p.global, false);
  assert.equal(p.root.type, 8);
  assert.equal(importSceneBlueprint(exportSceneBlueprint(d)).basements, undefined);
});
test('回填保持连接、可更换材质、撤销恢复地下室及地块', () => {
  const cells = [cell('a'), cell('b', 0, 0, 1)];
  assert.throws(() => editBasement(cells, cell('x'), 'fill'), /下层/);
  const filled = editBasement(cells, cell('x', 0, 0, 1), 'fill');
  assert.equal(filled.length, 1);
  assert.throws(() => editBasement(filled, cell('x', 2), 'fill'), /尚未/);
  const recolor = editBasement(filled, cell('new', 0, 0, 0, 82), 'dig');
  assert.equal(recolor[0].id, 'a');
  assert.equal(recolor[0].brushId, 82);
  assert.deepEqual(
    editBasement(cells, cell('new', 0, 0, 0, 82), 'dig').map((c) => c.id),
    ['a', 'b'],
  );
  const h = new SceneHistory();
  h.commit(doc(cells));
  h.commit(doc(filled));
  assert.equal(h.undo().basements?.length, 2);
  assert.equal(h.redo().basements?.length, 1);
});
test('下层可横向扩展，经其他通道仍可到达地表', () => {
  const cells = [cell('a'), cell('b', 0, 0, 1), cell('c', 1, 0, 1), cell('d', 1, 0, 0)];
  assert.equal(editBasement(cells, cell('a'), 'fill').length, 3);
  assert.throws(() => validateBasements([cell('x', 0, 0, 1)]), /连通/);
});
test('重复、越界、过深、混规格重叠和篡改掩码被拒绝', () => {
  assert.throws(() => validateBasements([cell('a'), cell('b')]), /重复/);
  assert.throws(() => validateBasements([cell('a', 0, 0, 8)]), /层深/);
  assert.throws(() => validateBasements([cell('a', 20)], landKey), /边界/);
  assert.throws(() => validateBasements([cell('a'), cell('b', 0, 0, 0, 113)]), /重叠/);
  assert.throws(() => validateScene({ ...doc([cell('a')]), items: [{ id: 'a' }] }), /重复/);
  const bytes = exportSceneBlueprint(doc([cell('a')]));
  const corrupted = bytes.slice();
  corrupted[222 + 37 + 7] = 0;
  corrupted.set(checksum(corrupted.subarray(0, -16)), corrupted.length - 16);
  assert.throws(() => importSceneBlueprint(corrupted), /掩码/);
});
const area = (poly: GroundPoint[]) =>
  Math.abs(
    poly.reduce(
      (s, a, i) =>
        s + a[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * a[1],
      0,
    ),
  ) / 2;
test('真实地块裁切相邻洞口：面积守恒，深层不重复挖地表', () => {
  const plan = landPlan(landKey)!,
    cells = [cell('a'), cell('b', 1), cell('c', 0, 0, 1)];
  const pieces = cutBasementGround(plan.points, cells);
  assert.ok(
    Math.abs(pieces.reduce((sum, p) => sum + area(p), 0) - (area(plan.points) - 32)) < 1e-6,
  );
  assert.ok(pieces.every((p) => p.every((v) => v.every(Number.isFinite))));
});
test('贴边洞口和任意旋转地块的地面裁切', () => {
  const p: GroundPoint[] = [
    [-2, -2],
    [6, -2],
    [6, 2],
    [-2, 2],
  ];
  assert.equal(cutBasementGround(p, [cell('a'), cell('b', 1)]).length, 0);
  const diamond: GroundPoint[] = [
    [0, -10],
    [10, 0],
    [0, 10],
    [-10, 0],
  ];
  assert.ok(
    Math.abs(cutBasementGround(diamond, [cell('a')]).reduce((s, p) => s + area(p), 0) - 184) < 1e-6,
  );
});
test('3D结构的米制包围盒和连通面数量，与导出掩码同源', () => {
  const root = basementDisplay([cell('a'), cell('b', 1), cell('c', 0, 0, 1)]);
  const box = new Box3().setFromObject(root);
  assert.deepEqual(box.min.toArray(), [-2, -8, -2]);
  assert.deepEqual(box.max.toArray(), [6, 0, 2]);
  let triangles = 0;
  root.traverse((o) => {
    if (o instanceof Mesh) triangles += o.geometry.getAttribute('position').count / 3;
  });
  // 18个面，2个地表顶面、2对邻接面共6个面不绘制。
  assert.equal(triangles, 24);
});
