import test from 'node:test';
import assert from 'node:assert/strict';
import {
  structureCost,
  MAX_CLOTH_TILES,
  MAX_OUTPUT_FURNITURE,
} from '../packages/core/src/budget.js';
import { BLUEPRINT_LIMITS, decodeBlueprint, walkNodes } from '../packages/core/src/codec.js';
import { buildMicro, microTiles } from '../packages/core/src/layout.js';
import { prepareImage, validateOptions } from '../packages/core/src/image.js';
import { exportImage } from '../packages/core/src/index.js';

test('结构预算与实际二进制节点一致，字节估计不低于实际输出', () => {
  for (const [width, height] of [
    [1, 1],
    [10, 5],
    [17, 3],
    [51, 51],
  ]) {
    const tiles = microTiles(Array(width * height).fill('灰4'), width, height, 0.5);
    const bytes = buildMicro(tiles, width, height, 0.125, 'wall', 0.5);
    const cost = structureCost(tiles.length),
      nodes = walkNodes(decodeBlueprint(bytes).root);
    assert.equal(nodes.length, cost.nodes);
    assert.ok(bytes.length <= cost.maxBytes);
  }
  assert.ok(structureCost(MAX_CLOTH_TILES).nodes <= BLUEPRINT_LIMITS.nodes);
  assert.ok(structureCost(MAX_CLOTH_TILES + 1).nodes > BLUEPRINT_LIMITS.nodes);
  assert.equal(MAX_OUTPUT_FURNITURE, structureCost(MAX_CLOTH_TILES).furniture);
});

test('自动规划按图像细节变化，自定义预算仍严格遵守', () => {
  const size = 160,
    flat = new Uint8Array(size * size * 4),
    detailed = flat.slice();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      flat.set([168, 168, 168, 255], (y * size + x) * 4);
      detailed.set(
        (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? [220, 45, 55, 255] : [25, 120, 190, 255],
        (y * size + x) * 4,
      );
    }
  const image = (rgba: Uint8Array) => ({ width: size, height: size, rgba });
  const options = validateOptions({ orientation: 'wall', longEdgeM: 8 });
  const a = prepareImage(image(flat), options),
    b = prepareImage(image(detailed), options);
  assert.ok(b.image.width > a.image.width);
  const result = exportImage(image(detailed), {
    orientation: 'wall',
    longEdgeM: 8,
    maxFurniture: 200,
  });
  assert.ok(result.summary.totalCount <= 200);
  assert.ok(result.verification.roundTrip);
  assert.throws(() =>
    validateOptions({ orientation: 'wall', longEdgeM: 8, maxFurniture: MAX_OUTPUT_FURNITURE + 1 }),
  );
});

test('极简图可按最小完整组件生成，大尺寸仍受家具实体尺寸约束', () => {
  const rgba = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([168, 168, 168, 255], i);
  const source = { width: 256, height: 256, rgba };
  const small = exportImage(source, { orientation: 'wall', longEdgeM: 8 });
  assert.equal(small.summary.totalCount, 2);
  const large = exportImage(source, { orientation: 'ground', longEdgeM: 200 });
  assert.equal(large.summary.widthM, 200);
  assert.ok(large.summary.gridWidth >= 25);
  assert.ok(large.summary.totalCount < MAX_OUTPUT_FURNITURE);
});
