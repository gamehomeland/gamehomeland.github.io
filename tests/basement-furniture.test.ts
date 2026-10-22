import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyScene,
  editorResources,
  exportSceneBlueprint,
  importSceneBlueprint,
  placeSceneItem,
  validateScene,
  readSceneProject,
  writeSceneProject,
  sceneItemInsideBasement,
  sceneItemHeightRange,
  type SceneItem,
} from '../packages/core/src/editor.js';
import {
  basementFloor,
  basementVariant,
  basementRotation,
  basementMasks,
  basementModelResources,
  type BasementCell,
} from '../packages/core/src/basement.js';
import { decodeBlueprint, encodeBlueprint } from '../packages/core/src/codec.js';

const cell = (id: string, x = 0, z = 0, level = 0, brushId = 113): BasementCell => ({
  id,
  x,
  z,
  level,
  brushId,
});
const make = (cells = [cell('a')]) => ({
  ...emptyScene(),
  landKey: 'blueprint:40:56',
  basements: cells,
});
const chair = (): SceneItem => ({
  id: 'f',
  resourceKey: editorResources.find((r) => r.representId === 19315)!.key,
  detail: 0,
  position: [0, 0, 0],
  rotation: [0, Math.sin(0.3), 0, Math.cos(0.3)],
  scale: [1, 1, 1],
});
test('144个模型变体都绑定真实地板挂面；72个带底面', () => {
  assert.equal(
    basementModelResources.reduce((n, r) => n + r.variants.length, 0),
    144,
  );
  assert.equal(
    basementModelResources.reduce((n, r) => n + r.variants.filter((v) => v.floor).length, 0),
    72,
  );
  for (const r of basementModelResources)
    for (const v of r.variants) if (v.floor) assert.deepEqual(v.floor.rotation, [0, 0, 0, 1]);
});
test('4米/8米深层家具按地板局部高度验证，保留原家具高度规则', () => {
  for (const brushId of [74, 113]) {
    const doc = make([cell('a', 0, 0, 0, brushId), cell('b', 0, 0, 1, brushId)]);
    const item = placeSceneItem(chair(), doc, 'b');
    doc.items = [item];
    assert.ok(item.position[1] < -7);
    assert.doesNotThrow(() => validateScene(doc));
    const height = sceneItemHeightRange(item, doc.basements)!;
    const invalid = structuredClone(doc);
    invalid.items[0].position[1] = height[0] - 1;
    assert.throws(() => validateScene(invalid), /高度/);
  }
});
test('迁移多件家具自动选择空位，不将它们堆到地板中心', () => {
  const doc = make();
  const first = placeSceneItem(chair(), doc, 'a');
  doc.items = [first];
  const second = placeSceneItem({ ...chair(), id: 'second' }, doc, 'a');
  assert.ok(
    Math.hypot(first.position[0] - second.position[0], first.position[2] - second.position[2]) >
      0.5,
  );
  doc.items.push(second);
  assert.doesNotThrow(() => validateScene(doc));
});
test('地下室挂面内的非等比模型按57字节布局完整往返', () => {
  const doc = make([cell('a'), cell('b', 1)]),
    r = editorResources.find((r) => r.representId === 21276)!;
  const item = placeSceneItem(
    {
      id: 'column',
      resourceKey: r.key,
      detail: 0,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [0.2, 0.4, 0.3],
    },
    doc,
    'a',
  );
  doc.items = [item];
  const b = exportSceneBlueprint(doc),
    restored = importSceneBlueprint(b);
  assert.ok(restored.items[0].basementId);
  assert.ok(Math.abs(restored.items[0].scale[2] - 0.3) < 1e-6);
  assert.deepEqual(exportSceneBlueprint(restored), b);
});
test('级联旋转与真实挂面索引写入；子家具世界位置朝向回读一致', () => {
  const doc = make([cell('a'), cell('b', 1)]);
  const item = placeSceneItem(chair(), doc, 'a');
  item.position[0] = -1;
  item.position[2] = 0.5;
  doc.items = [item];
  const data = exportSceneBlueprint(doc),
    parsed = decodeBlueprint(data),
    a = parsed.root.children[0];
  assert.equal(a.type, 9);
  const plane = a.children.find((p) => p.children.length)!;
  assert.equal(plane.type, 5);
  assert.equal(plane.index, 1);
  assert.ok(Math.abs(a.transform![2] - 1) < 1e-6);
  assert.equal(plane.children[0].type, 0);
  const restored = importSceneBlueprint(data);
  assert.ok(restored.items[0].basementId);
  for (const field of ['position', 'rotation', 'scale'] as const)
    item[field].forEach((v, i) => assert.ok(Math.abs(v - restored.items[0][field][i]) < 1e-5));
  assert.deepEqual(exportSceneBlueprint(restored), data);
});
test('所有水平邻接形态下的地板、朝向及世界坐标往返', () => {
  const directions = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];
  for (const brushId of [74, 82, 83, 84, 113, 114])
    for (let mask = 0; mask < 16; mask++) {
      const cells = [cell('a', 0, 0, 0, brushId)];
      directions.forEach(([x, z], i) => {
        if (mask & (1 << i)) cells.push(cell('n' + i, x, z, 0, brushId));
      });
      const doc = make(cells);
      doc.items = [placeSceneItem(chair(), doc, 'a')];
      const f = basementFloor(cells[0], cells)!;
      const file = decodeBlueprint(exportSceneBlueprint(doc));
      const node = file.root.children[0];
      assert.equal(node.children.find((p) => p.children.length)!.index, f.anchor.index);
      const wanted = basementRotation(basementMasks(cells).get('a')!);
      node.transform!.slice(1, 5).forEach((q, i) => assert.ok(Math.abs(q - wanted[i]) < 1e-6));
    }
});
test('继续连铺改变挂面编号/旋转时，家具世界位置不变', () => {
  const doc = make();
  doc.items = [placeSceneItem(chair(), doc, 'a')];
  doc.items[0].position[0] = 0.4;
  const before = importSceneBlueprint(exportSceneBlueprint(doc)).items[0];
  doc.basements.push(cell('b', 1));
  const after = importSceneBlueprint(exportSceneBlueprint(doc)).items[0];
  before.position.forEach((v, i) => assert.ok(Math.abs(v - after.position[i]) < 1e-5));
  before.rotation.forEach((v, i) => assert.ok(Math.abs(v - after.rotation[i]) < 1e-5));
});
test('有家具的地板不能被挖空或回填；不能绑定不存在/无底面的格子', () => {
  const doc = make();
  doc.items = [placeSceneItem(chair(), doc, 'a')];
  assert.throws(() => validateScene({ ...doc, basements: [] }), /不存在/);
  doc.basements.push(cell('b', 0, 0, 1));
  assert.throws(() => validateScene(doc), /承载家具/);
  assert.throws(() => placeSceneItem(chair(), doc, 'missing'), /不存在/);
});
test('家具可跨同深度连通地板，不能悬在开口或越界', () => {
  const doc = make([cell('a'), cell('b', 1)]);
  const item = placeSceneItem(chair(), doc, 'a');
  item.position[0] = 4;
  assert.equal(sceneItemInsideBasement(item, doc.basements), true);
  item.position[2] = 5;
  assert.equal(sceneItemInsideBasement(item, doc.basements), false);
  doc.items = [item];
  assert.throws(() => validateScene(doc), /地板范围/);
});
test('篡改挂面索引/变换或级联旋转不会静默改写家具', () => {
  const doc = make([cell('a'), cell('b', 1)]);
  doc.items = [placeSceneItem(chair(), doc, 'a')];
  for (const field of ['index', 'position', 'rotation']) {
    const b = decodeBlueprint(exportSceneBlueprint(doc));
    const parent = b.root.children[0];
    const plane = parent.children.find((p) => p.children.length)!;
    if (field === 'index') plane.index = 99;
    if (field === 'position') plane.transform![6] += 10;
    if (field === 'rotation')
      parent.transform = [1, 0, 0, 0, 1, ...parent.transform!.slice(5)] as typeof parent.transform;
    assert.throws(() => importSceneBlueprint(encodeBlueprint(b)), /挂面|旋转/);
  }
});
test('旧结构版空地下室可以读入，再导出纠正旋转；工程保留挂接目标', () => {
  const doc = make([cell('a'), cell('b', 1)]),
    old = decodeBlueprint(exportSceneBlueprint(doc));
  old.root.children[0].transform!.splice(1, 4, 0, 0, 0, 1);
  old.root.children.forEach((n) => {
    n.children = [];
  });
  const imported = importSceneBlueprint(encodeBlueprint(old));
  assert.equal(decodeBlueprint(exportSceneBlueprint(imported)).root.children[0].transform![2], 1);
  doc.items = [placeSceneItem(chair(), doc, 'a')];
  assert.deepEqual(readSceneProject(writeSceneProject(doc)), validateScene(doc));
});
