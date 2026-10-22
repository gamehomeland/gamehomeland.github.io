import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { opaqueColors, support } from '../packages/core/src/catalog.js';
import {
  makePlan,
  buildNative,
  readNative,
  microTiles,
  buildMicro,
  readMicro,
  verifyVisibility,
} from '../packages/core/src/layout.js';
import { decodeBlueprint, encodeBlueprint, walkNodes } from '../packages/core/src/codec.js';
import { supportCount } from '../packages/core/src/component.js';
import { deltaE2, rgbLab, roundEven } from '../packages/core/src/math.js';
import type { Orientation } from '../packages/core/src/types.js';

const contracts = JSON.parse(
  readFileSync(new URL('./fixtures/layout-contracts.json', import.meta.url), 'utf8'),
);
test('感知色差标准样例与整数边界', () => {
  assert.ok(
    Math.abs(Math.sqrt(deltaE2([50, 2.6772, -79.7751], [50, 0, -82.7485])) - 2.0425) < 0.0001,
  );
  const white = rgbLab([255, 255, 255]);
  assert.ok(Math.abs(white[0] - 100) < 0.001);
  assert.deepEqual(
    [roundEven(0.5), roundEven(1.5), roundEven(2.5), roundEven(-0.5), roundEven(-1.5)],
    [0, 2, 2, 0, -2],
  );
});
for (const [key, wanted] of Object.entries(contracts.ordinary) as [
  string,
  { sha256: string; bytes: number },
][]) {
  test('普通组件完整字节对照 ' + key, () => {
    const [direction, w, h, cell, striped] = key.split(':');
    const width = +w,
      height = +h;
    const keys = Array.from({ length: width * height }, (_, i) =>
      +striped ? opaqueColors[i % opaqueColors.length].key : '灰7',
    );
    const tiles = makePlan(keys, width, height, +cell),
      bytes = buildNative(tiles, width, height, +cell, direction as Orientation);
    assert.equal(bytes.length, wanted.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), wanted.sha256);
    assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
    const restored = readNative(bytes, width, height, +cell, direction as Orientation);
    assert.deepEqual(
      restored.map((t) => [t.x, t.y, t.side, t.layer, t.key]),
      tiles.map((t) => [t.x, t.y, t.side, t.layer, t.key]),
    );
    const nodes = walkNodes(decodeBlueprint(bytes).root);
    assert.equal(nodes.filter((n) => n.type === 3).length, supportCount(tiles.length));
  });
}
for (const direction of ['wall', 'ground'] as const)
  for (const [width, height, meters] of [
    [16, 16, 2],
    [32, 24, 4],
    [51, 51, 8],
  ]) {
    test(`微缩回读和逐格可见性 ${direction} ${width}×${height}`, () => {
      const keys = Array.from(
          { length: width * height },
          (_, i) => opaqueColors[i % opaqueColors.length].key,
        ),
        tiles = microTiles(keys, width, height, 0.5);
      const pitch = meters / Math.max(width, height),
        bytes = buildMicro(tiles, width, height, pitch, direction, 0.5);
      assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
      const restored = readMicro(bytes, width, height, pitch, direction, 0.5);
      assert.deepEqual(
        restored.pieces.map((p) => p.tile.key),
        keys,
      );
      assert.equal(verifyVisibility(restored, width, height, pitch, direction), width * height * 5);
    });
  }
test('校验值、截断、未知节点和超范围字段均拒绝', () => {
  const tiles = makePlan(['灰7', '红5', '蓝8', '黄3'], 2, 2, 0.5),
    bytes = buildNative(tiles, 2, 2, 0.5, 'wall');
  const changed = bytes.slice();
  changed[20] ^= 1;
  assert.throws(() => decodeBlueprint(changed));
  assert.throws(() => decodeBlueprint(bytes.slice(0, -1)));
  assert.throws(() => encodeBlueprint({ global: false, root: { type: 99, children: [] } }));
  assert.throws(() =>
    encodeBlueprint({
      global: false,
      root: {
        type: 0,
        instanceId: 1,
        representId: 1,
        transform: [1, 0, 0, 0, 1, Infinity, 0, 0],
        children: [],
      },
    }),
  );
});
test('根基座显示不改变家具位置和挂接结构', () => {
  const tiles = microTiles(Array(256).fill('灰7'), 16, 16, 0.5);
  const a = decodeBlueprint(buildMicro(tiles, 16, 16, 0.125, 'ground', 0.5, true));
  const b = decodeBlueprint(buildMicro(tiles, 16, 16, 0.125, 'ground', 0.5, false));
  a.root.children[0].detail = 0;
  a.root.children[0].children[0].detail = 0;
  assert.deepEqual(a, b);
  assert.equal(b.root.children[0].representId, support.representId);
});

for (const direction of ['wall', 'ground'] as const)
  test('三层叠色的完整二进制合同 ' + direction, () => {
    const tiles = makePlan(Array(64).fill('蓝3'), 8, 8, 0.5);
    for (const depth of [1, 2]) {
      const layer = makePlan(Array(64).fill('灰1'), 8, 8, 0.5, false);
      layer.forEach((t) => (t.layer = depth));
      tiles.push(...layer);
    }
    const bytes = buildNative(tiles, 8, 8, 0.5, direction),
      wanted = contracts.layered[direction];
    assert.equal(bytes.length, wanted.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), wanted.sha256);
    assert.deepEqual(
      readNative(bytes, 8, 8, 0.5, direction).map((t) => [t.x, t.y, t.side, t.layer, t.key]),
      tiles.map((t) => [t.x, t.y, t.side, t.layer, t.key]),
    );
  });

for (const [key, wanted] of Object.entries(contracts.compact) as [string, any][])
  test('奇偶网格、单格与密集挂接合同 ' + key, () => {
    const [orientation, w, h, cell] = key.split(':'),
      width = +w,
      height = +h,
      pitch = +cell,
      direction = orientation as Orientation;
    const tiles = microTiles(
      Array.from({ length: width * height }, (_, i) => opaqueColors[i % opaqueColors.length].key),
      width,
      height,
      0.5,
    );
    const bytes = buildMicro(tiles, width, height, pitch, direction, 0.5),
      nodes = walkNodes(decodeBlueprint(bytes).root);
    const types: Record<string, number> = {};
    for (const node of nodes) types[node.type] = (types[node.type] ?? 0) + 1;
    assert.deepEqual(types, wanted.types);
    assert.equal(nodes.filter((n) => n.instanceId !== undefined).length, wanted.object_count);
    for (const [ident, sample] of Object.entries(wanted.samples) as [string, any][]) {
      const actual = nodes.find((n) => n.instanceId === +ident)!;
      assert.equal(actual.representId, sample.representId);
      assert.equal(actual.builtin, sample.p1);
      assert.equal(actual.detail, sample.p2);
      assert.ok(actual.transform!.every((v, i) => Math.abs(v - sample.transform[i]) < 1e-5));
    }
    const geometry = readMicro(bytes, width, height, pitch, direction, 0.5);
    for (const side of ['min', 'max'] as const)
      assert.ok(
        geometry[side].every(
          (v, i) => Math.abs(v - wanted.geometry.cloth_bounds_m[side][i]) < 1e-5,
        ),
      );
    assert.equal(verifyVisibility(geometry, width, height, pitch, direction), width * height * 5);
  });

for (const mutation of ['position', 'id', 'scale', 'resource'])
  test('重新签名也不能掩盖错误家具 ' + mutation, () => {
    const bytes = buildMicro(
        microTiles(Array(64).fill('灰7'), 8, 8, 0.5),
        8,
        8,
        0.125,
        'wall',
        0.5,
      ),
      parsed = decodeBlueprint(bytes);
    const nodes = walkNodes(parsed.root).filter((n) => n.type === 0 && n.instanceId! <= 64);
    if (mutation === 'position') nodes[0].transform![5] += 5;
    if (mutation === 'id') nodes[1].instanceId = nodes[0].instanceId;
    if (mutation === 'scale') nodes[0].transform![0] = 0.01;
    if (mutation === 'resource') nodes[0].representId = 123456789;
    assert.throws(() => readMicro(encodeBlueprint(parsed), 8, 8, 0.125, 'wall', 0.5));
  });
