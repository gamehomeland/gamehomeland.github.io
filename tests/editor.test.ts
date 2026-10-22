import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import {
  editorResources,
  emptyScene,
  validateScene,
  exportSceneBlueprint,
  importSceneBlueprint,
  readSceneProject,
  writeSceneProject,
  sceneMaterials,
  scenePackage,
  SceneHistory,
  suggestScenePosition,
  type SceneItem,
} from '../packages/core/src/editor.js';
import { decodeBlueprint, encodeBlueprint } from '../packages/core/src/codec.js';

const makeItem = (representId: number, id = 'item-1'): SceneItem => {
  const r = editorResources.find((r) => r.representId === representId)!;
  return {
    id,
    resourceKey: r.key,
    detail: r.defaultDetail,
    position: [1.25, 0.5, -2],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
};
test('家具布置导出真实Holder+Model节点，资源/样式/米制变换往返一致', () => {
  const doc = emptyScene();
  doc.items = [makeItem(19315), makeItem(20831, 'item-2')];
  doc.items[1].rotation = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  doc.items[1].scale = [0.5, 0.5, 0.5];
  const bytes = exportSceneBlueprint(doc),
    restored = importSceneBlueprint(bytes);
  assert.equal(bytes.length, 5 + 49 + 49 * 2 + 16);
  assert.deepEqual(
    restored.items.map((i) => [i.resourceKey, i.position, i.scale]),
    doc.items.map((i) => [i.resourceKey, i.position, i.scale]),
  );
  const root = decodeBlueprint(bytes).root;
  assert.equal(root.type, 8);
  assert.equal(root.representId, 0xffffffff);
  assert.deepEqual(root.children[0].transform!.slice(5), [125, 50, -200]);
  assert.deepEqual(
    root.children.map((n) => n.representId),
    [19315, 20831],
  );
  assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
});
test('非等比资源使用57字节模型布局，回读依赖明确资源规则', () => {
  const doc = emptyScene();
  doc.items = [makeItem(21276)];
  doc.items[0].scale = [0.25, 2, 1.5];
  const bytes = exportSceneBlueprint(doc);
  assert.equal(bytes.length, 5 + 49 + 57 + 16);
  assert.deepEqual(importSceneBlueprint(bytes).items[0].scale, [0.25, 2, 1.5]);
  assert.throws(() => decodeBlueprint(bytes));
});
test('固定比例/受限旋转/高度/样式/未知资源和重复标识不能偷偷写出', () => {
  const changes = [
    (i: SceneItem) => (i.scale = [2, 2, 2]),
    (i: SceneItem) => (i.rotation = [Math.sin(0.1), 0, 0, Math.cos(0.1)]),
    (i: SceneItem) => (i.position = [0, 999, 0]),
    (i: SceneItem) => (i.detail = 255),
    (i: SceneItem) => (i.resourceKey = 'unknown'),
  ];
  for (const change of changes) {
    const doc = emptyScene();
    const item = makeItem(19315);
    change(item);
    doc.items = [item];
    assert.throws(() => exportSceneBlueprint(doc));
  }
  const doc = emptyScene();
  doc.items = [makeItem(19315), makeItem(19315)];
  assert.throws(() => validateScene(doc));
  assert.throws(() => exportSceneBlueprint(emptyScene()));
});
test('完整包包含可继续编辑工程及正确家具清单，重复家具不遗漏', () => {
  const doc = emptyScene();
  doc.name = '茶室';
  doc.items = [makeItem(19315), makeItem(19315, 'item-2'), makeItem(20831, 'item-3')];
  assert.deepEqual(readSceneProject(writeSceneProject(doc)), doc);
  const rows = sceneMaterials(doc);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 2);
  const files = unzipSync(scenePackage(doc));
  assert.equal(Object.keys(files).length, 4);
  assert.deepEqual(
    importSceneBlueprint(files['家园布置.blueprintx']).items.map((i) => i.resourceKey),
    doc.items.map((i) => i.resourceKey),
  );
  assert.deepEqual(readSceneProject(files['布置工程.homeland.json']), doc);
});
test('撤销重做恢复整个布置，撤销后新修改切断旧重做分支', () => {
  const h = new SceneHistory(),
    a = emptyScene();
  a.items = [makeItem(19315)];
  h.commit(a);
  const b = h.document;
  b.items[0].position[0] = 4;
  h.commit(b);
  assert.equal(h.undo().items[0].position[0], 1.25);
  assert.equal(h.redo().items[0].position[0], 4);
  h.undo();
  const c = h.document;
  c.items = [];
  h.commit(c);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo().items.length, 1);
  a.items[0].position[0] = 999;
  assert.equal(h.document.items[0].position[0], 1.25);
});
test('不支持的挂接结构及资源导入明确拒绝，不静默扁平化', () => {
  const doc = emptyScene();
  doc.items = [makeItem(19315)];
  const bp = decodeBlueprint(exportSceneBlueprint(doc));
  bp.root.children[0].children = [{ type: 5, index: 0, children: [] }];
  assert.throws(() => importSceneBlueprint(encodeBlueprint(bp)), /挂接/);
});
test('自动初放为后加入的家具留出空间，不覆盖既有对象', () => {
  const doc = emptyScene(),
    chair = makeItem(19315);
  chair.position = [0, 0, 0];
  doc.items.push(chair);
  const before = structuredClone(doc),
    r = editorResources.find((r) => r.representId === 19315)!;
  const next = suggestScenePosition(r.key, doc);
  assert(next[0] + r.boundsMin[0] > r.boundsMax[0] || next[2] + r.boundsMin[2] > r.boundsMax[2]);
  assert.deepEqual(doc, before);
});
