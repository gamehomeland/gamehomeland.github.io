import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recipes,
  visibleColor,
  overlayKey,
  maxRecipeLayers,
  colorByKey,
} from '../packages/core/src/catalog.js';
import { buildNative, readNative, makePlan } from '../packages/core/src/layout.js';
import type { Tile } from '../packages/core/src/types.js';
import {
  exportImage,
  decodeBlueprint,
  encodeBlueprint,
  walkNodes,
} from '../packages/core/src/index.js';

for (const direction of ['wall', 'ground'] as const)
  test(`普通布局六层配色写入真实家具并可回读 ${direction}`, () => {
    const tiles: Tile[] = [];
    for (let layer = 0; layer < maxRecipeLayers; layer++) {
      const planned = makePlan(Array(12).fill(layer ? overlayKey : '蓝8'), 4, 3, 0.5, layer === 0);
      planned.forEach((tile) => (tile.layer = layer));
      tiles.push(...planned);
    }
    const bytes = buildNative(tiles, 4, 3, 0.5, direction);
    const restored = readNative(bytes, 4, 3, 0.5, direction);
    assert.deepEqual(restored, tiles);
    assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
    const recipe = ['蓝8', ...Array(5).fill(overlayKey)];
    const rgb = visibleColor(recipe, direction);
    assert.ok(rgb.every(Number.isFinite));
    assert.ok(rgb[0] > visibleColor(['蓝8', overlayKey, overlayKey], direction)[0]);
    assert.ok(restored.filter((tile) => tile.layer === 5).length > 0);
    assert.throws(
      () => buildNative([{ ...tiles[0], layer: 6 }, ...tiles], 4, 3, 0.5, direction),
      /叠层/,
    );
  });

test('扩展色卡的每种配方都能对应实际家具与合法底色', () => {
  const all = recipes('wall', maxRecipeLayers);
  assert.equal(all.length, 426);
  for (const r of all) {
    assert.equal(r.keys.length, r.depth);
    assert.equal(colorByKey.get(r.keys[0])?.translucent, false);
    assert.ok(r.keys.every((key) => colorByKey.get(key)?.variants.length === 2));
    assert.ok(r.keys.slice(1).every((key) => key === overlayKey));
  }
  for (const depth of [0, 7, NaN, 1.5]) assert.throws(() => recipes('wall', depth));
});

test('普通自动配色能选择新增层数，预算与实际文件数量一致', () => {
  const all = recipes('wall', 6),
    width = 192,
    height = 144,
    rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const r = all[(Math.floor(y / 8) * 24 + Math.floor(x / 8)) % all.length];
      rgba.set([...r.rgb, 255], (y * width + x) * 4);
    }
  const result = exportImage(
    { width, height, rgba },
    { orientation: 'wall', longEdgeM: 24, maxGridEdge: 24, maxFurniture: 5000 },
  );
  assert.equal(result.summary.layout, 'native');
  assert.ok(result.summary.visibleLayers > 3);
  assert.ok(result.summary.visibleLayers <= 6);
  assert.equal(
    result.materials.reduce((n, row) => n + row.count, 0),
    result.summary.totalCount,
  );
  const nodes = walkNodes(decodeBlueprint(result.blueprint).root);
  const clothes = nodes.filter((node) => node.type === 0 && node.representId !== 18238);
  assert.equal(clothes.length, result.summary.clothCount);
});
