import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBlueprint } from '../packages/core/src/codec.js';
import {
  landCatalog,
  landPlan,
  groundBounds,
  groundGrid,
  type GroundPoint,
} from '../packages/core/src/land.js';
import {
  emptyScene,
  editorResources,
  exportSceneBlueprint,
  importSceneBlueprint,
  readSceneProject,
  writeSceneProject,
  validateScene,
  SceneHistory,
  constrainSceneItem,
  sceneItemInsideLand,
  sceneItemFootprint,
} from '../packages/core/src/editor.js';

const area = (p: GroundPoint[]) =>
  Math.abs(
    p.reduce(
      (sum, a, i) => sum + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1],
      0,
    ),
  ) / 2;
const inside = (point: GroundPoint, p: GroundPoint[]) => {
  const cross = p.map((a, i) => {
    const b = p[(i + 1) % p.length];
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  });
  return cross.every((v) => v >= -1e-6) || cross.every((v) => v <= 1e-6);
};
test('七档地块尺寸对应标称面积，五社区有108块实际坐标', () => {
  assert.deepEqual(
    landCatalog.presets.map((p) => p.areaM2).sort((a, b) => a - b),
    [1280, 2240, 4032, 6272, 7200, 11648, 45792],
  );
  for (const p of landCatalog.presets) assert.equal(p.lengthM * p.widthM, p.areaM2);
  const community = landCatalog.maps.filter((m) => m.kind === 'community');
  assert.equal(community.length, 5);
  assert.equal(
    community.reduce((sum, m) => sum + m.plots.length, 0),
    108,
  );
  for (const map of community)
    for (const plot of map.plots) {
      assert.ok(Math.abs(area(plot.points) - plot.areaM2) < 1);
      assert.equal(new Set(plot.points.map((p) => p.join(','))).size, 4);
    }
});
test('私宅七区完整覆盖212×216米，面积不重复计算', () => {
  const full = landPlan('private-565-all')!,
    bounds = groundBounds(full.points);
  assert.equal(full.areaM2, 45792);
  assert.deepEqual(bounds, { min: [-106, -108], max: [106, 108] });
  assert.deepEqual(
    full.regions.map((p) => p.areaM2),
    [2240, 4032, 6272, 7200, 7200, 7200, 11648],
  );
  assert.equal(
    full.regions.reduce((n, p) => n + area(p.points), 0),
    45792,
  );
  const xs = [...new Set(full.regions.flatMap((r) => r.points.map((p) => p[0])))].sort(
      (a, b) => a - b,
    ),
    zs = [...new Set(full.regions.flatMap((r) => r.points.map((p) => p[1])))].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < zs.length - 1; j++) {
      const point: GroundPoint = [(xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2];
      assert.equal(full.regions.filter((p) => inside(point, p.points)).length, 1);
    }
});
test('旋转地块网格裁剪在四边形内，并限制过密网格', () => {
  const p: GroundPoint[] = [
      [0, 2],
      [2, 0],
      [0, -2],
      [-2, 0],
    ],
    lines = groundGrid(p, 0.25);
  assert.ok(lines.length > 10);
  for (const line of lines) for (const point of line) assert.ok(inside(point, p));
  assert.throws(() => groundGrid(p, 0), /无效/);
  assert.throws(() => groundGrid(p, 0.0001), /过密/);
});
test('地块选择随工程保存和撤销，不增加蓝图家具或改变坐标字节', () => {
  const doc = emptyScene(),
    resource = editorResources.find((r) => r.representId === 19315)!;
  doc.items = [
    {
      id: 'chair',
      resourceKey: resource.key,
      detail: resource.defaultDetail,
      position: [1, 0, 2],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  ];
  const before = exportSceneBlueprint(doc),
    history = new SceneHistory();
  history.commit(doc);
  doc.landKey = 'private-565-all';
  history.commit(doc);
  assert.deepEqual(exportSceneBlueprint(doc), before);
  assert.equal(readSceneProject(writeSceneProject(doc)).landKey, doc.landKey);
  history.undo();
  assert.equal(history.document.landKey, undefined);
  history.redo();
  assert.equal(history.document.landKey, 'private-565-all');
  assert.throws(() => validateScene({ ...doc, landKey: 'unknown' }), /地块/);
});
test('选择参考范围不污染共享地块数据', () => {
  const plan = landPlan('private-565-1')!;
  plan.points[0][0] = 99999;
  assert.notEqual(landPlan('private-565-1')!.points[0][0], 99999);
  assert.equal(landPlan('unknown'), undefined);
});

test('限制整个家具投影而非中心，越界工程与导出均拒绝', () => {
  const r = editorResources.find((r) => r.representId === 19315)!,
    doc = emptyScene();
  doc.landKey = 'size-1280';
  const item = {
    id: 'bound-chair',
    resourceKey: r.key,
    detail: r.defaultDetail,
    position: [15.99, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
  doc.items = [item];
  assert.equal(sceneItemInsideLand(item, doc.landKey), false);
  assert.throws(() => validateScene(doc), /边界/);
  assert.throws(() => exportSceneBlueprint(doc), /边界/);
  const fixed = constrainSceneItem(item, doc.landKey);
  assert.ok(fixed.position[0] < 15.99);
  assert.ok(sceneItemInsideLand(fixed, doc.landKey));
  assert.equal(item.position[0], 15.99);
  assert.deepEqual(fixed.rotation, item.rotation);
});
test('四角方向拖动到任意旋转社区地块时，整件家具都停在边界内', () => {
  const r = editorResources.find((r) => r.representId === 19315)!;
  for (const map of landCatalog.maps.filter((m) => m.kind === 'community'))
    for (const p of map.plots)
      for (const [x, z] of [
        [1000, 1000],
        [-1000, 1000],
        [1000, -1000],
        [-1000, -1000],
      ]) {
        const item = {
          id: 'bound-chair',
          resourceKey: r.key,
          detail: r.defaultDetail,
          position: [x, 0, z] as [number, number, number],
          rotation: [0, Math.sin(0.4), 0, Math.cos(0.4)] as [number, number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        };
        const fixed = constrainSceneItem(item, p.key),
          plan = landPlan(p.key)!;
        for (const point of sceneItemFootprint(fixed)) assert.ok(inside(point, plan.points), p.key);
        assert.ok(sceneItemInsideLand(fixed, p.key));
        const doc = { ...emptyScene(), landKey: p.key, items: [fixed] };
        const read = importSceneBlueprint(exportSceneBlueprint(doc));
        read.landKey = p.key;
        assert.doesNotThrow(() => validateScene(read));
      }
});
test('大于地块的家具不能靠强行平移塞入', () => {
  const r = editorResources.find((r) => r.representId === 19315)!;
  assert.throws(
    () =>
      constrainSceneItem(
        {
          id: 'too-large',
          resourceKey: r.key,
          detail: r.defaultDetail,
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [100, 100, 100],
        },
        'size-1280',
      ),
    /超出地块可容纳/,
  );
});

test('地块水平约束允许配置内负高度，普通家具位移不生成地下室节点', () => {
  const resource = editorResources.find((r) => r.representId === 19315)!,
    doc = emptyScene();
  doc.landKey = 'size-1280';
  doc.items = [
    {
      id: 'below-ground',
      resourceKey: resource.key,
      detail: resource.defaultDetail,
      position: [1, -3, 2],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  ];
  const bytes = exportSceneBlueprint(doc),
    read = importSceneBlueprint(bytes),
    parsed = decodeBlueprint(bytes);
  assert.equal(read.items[0].position[1], -3);
  assert.equal(parsed.global, false);
  assert.deepEqual(
    parsed.root.children.map((node) => node.type),
    [0],
  );
  doc.items[0].position[1] = -4.5;
  assert.throws(() => validateScene(doc), /高度/);
});
