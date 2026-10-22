import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreviewScene } from '../packages/core/src/scene.js';
import {
  buildNative,
  makePlan,
  buildMicro,
  microTiles,
  readMicro,
  microGeometry,
} from '../packages/core/src/layout.js';
import { buildGlassBlueprint, glassMaterials, placeGlass } from '../packages/core/src/glass.js';
import { decodeBlueprint, encodeBlueprint, walkNodes } from '../packages/core/src/codec.js';
import { supportCount } from '../packages/core/src/component.js';
import { variantById } from '../packages/core/src/catalog.js';
import type { ExportResult, Orientation, Vec3 } from '../packages/core/src/types.js';

function summary(
  count: number,
  orientation: Orientation,
  layout: 'native' | 'miniature',
  glass = 0,
): ExportResult['summary'] {
  return {
    widthM: 8,
    heightM: 8,
    gridWidth: 16,
    gridHeight: 16,
    orientation,
    layout,
    clothCount: count,
    supportCount: supportCount(count + glass),
    glassCount: glass,
    totalCount: count + glass + supportCount(count + glass),
    visibleLayers: 1,
    showRootHandle: true,
    backgroundFilled: false,
    canvasPadded: false,
  };
}

for (const orientation of ['wall', 'ground'] as const)
  for (const layout of ['native', 'miniature'] as const)
    test(`3D 实体从文件回读、观察方向不镜像、数量对应 ${orientation}/${layout}`, () => {
      const keys = Array.from(
        { length: 16 },
        (_, i) => ['红5', '蓝8', '黄3', '灰7'][(i % 4 >= 2 ? 1 : 0) + (i >= 8 ? 2 : 0)],
      );
      const plan = makePlan(keys, 4, 4, 0.5);
      const bytes =
        layout === 'native'
          ? buildNative(plan, 4, 4, 0.5, orientation)
          : buildMicro(microTiles(keys, 4, 4, 0.5), 4, 4, 0.2, orientation, 0.5);
      const n = layout === 'native' ? plan.length : keys.length;
      const before = bytes.slice(),
        scene = readPreviewScene(bytes, summary(n, orientation, layout));
      assert.deepEqual(bytes, before);
      assert.equal(scene.count.total, n + supportCount(n));
      const points = new Map(
        scene.batches
          .filter((b) => b.kind === 'cloth')
          .map((b) => [variantById.get(b.resourceId)!.color.key, b.transforms.slice(0, 3)]),
      );
      // 网页整个组件反射 X；相机右向量为 up × front。
      const [u, f] = [scene.up, scene.front];
      const right: Vec3 = [
        u[1] * f[2] - u[2] * f[1],
        u[2] * f[0] - u[0] * f[2],
        u[0] * f[1] - u[1] * f[0],
      ];
      const project = (key: string, axis: Vec3) => {
        const [x, y, z] = points.get(key)!;
        return -x * axis[0] + y * axis[1] + z * axis[2];
      };
      assert(project('红5', right) < project('蓝8', right));
      assert(project('红5', scene.up) > project('黄3', scene.up));
      if (layout === 'miniature') {
        const expected = readMicro(bytes, 4, 4, 0.2, orientation, 0.5);
        for (let axis = 0; axis < 3; axis++) {
          assert(Math.abs(scene.bounds.min[axis] - expected.min[axis]) < 2e-5);
          assert(Math.abs(scene.bounds.max[axis] - expected.max[axis]) < 2e-5);
        }
      }
    });

test('3D 保留透明叠层和每一层的实际厚度位置', () => {
  const tiles = makePlan(Array(4).fill('蓝3'), 2, 2, 0.5);
  const white = makePlan(Array(4).fill('灰1'), 2, 2, 0.5, false);
  white.forEach((t) => (t.layer = 1));
  tiles.push(...white);
  const scene = readPreviewScene(
    buildNative(tiles, 2, 2, 0.5, 'wall'),
    summary(tiles.length, 'wall', 'native'),
  );
  const opaque = scene.batches.find((b) => b.kind === 'cloth' && b.opacity === 1)!;
  const overlay = scene.batches.find((b) => b.kind === 'cloth' && b.opacity < 1)!;
  assert(overlay.transforms[2] > opaque.transforms[2]);
  assert(opaque.transforms[8] > 0 && overlay.transforms[8] > 0);
});

test('3D 使用六类琉璃的实际轮廓，不把异形缺口补为矩形', () => {
  const keys = Array(1024).fill('灰4');
  const g = microGeometry(microTiles(keys, 32, 32, 0.5), 32, 32, 0.25, 'wall', 0.5);
  const frame = {
    width: 32,
    height: 32,
    pitch: 0.25,
    edgeM: 0.5,
    floor: g.floor,
    front: g.min[2] - 0.03,
  };
  const overlays = glassMaterials.map((_, i) => placeGlass(i, 1 + i, 0.25, frame));
  const bytes = buildGlassBlueprint(keys, frame, overlays, true);
  const scene = readPreviewScene(bytes, summary(keys.length, 'wall', 'miniature', 6));
  assert.equal(scene.count.glass, 6);
  const batches = scene.batches.filter((b) => b.kind === 'glass');
  assert.equal(batches.length, 6);
  for (const b of batches) assert(b.triangles!.length >= 18 && b.triangles!.every(Number.isFinite));
  assert(batches.some((b) => b.triangles!.length > 18));
});

test('3D 拒绝截断、数量不符、未知资源，不能漏掉家具却声称完整', () => {
  const bytes = buildNative(makePlan(['红5'], 1, 1, 0.5), 1, 1, 0.5, 'wall');
  const s = summary(1, 'wall', 'native');
  assert.throws(() => readPreviewScene(bytes.slice(0, -1), s));
  assert.throws(() => readPreviewScene(bytes, { ...s, totalCount: 100 }), /数量/);
  const doc = decodeBlueprint(bytes);
  walkNodes(doc.root).find((n) => n.type === 0 && !n.builtin)!.representId = 99999999;
  assert.throws(() => readPreviewScene(encodeBlueprint(doc), s), /尚无/);
});
