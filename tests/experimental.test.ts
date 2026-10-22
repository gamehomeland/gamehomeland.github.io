import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportImage,
  createPackage,
  decodeBlueprint,
  encodeBlueprint,
  walkNodes,
} from '../packages/core/src/index.js';
import { microGeometry, microTiles } from '../packages/core/src/layout.js';
import {
  glassMaterials,
  glassContains,
  glassCoverage,
  placeGlass,
  buildGlassBlueprint,
  readGlassBlueprint,
  renderGlassBlueprint,
  type GlassFrame,
} from '../packages/core/src/glass.js';

const width = 32,
  height = 32;
function image() {
  const colors = [
    [18, 46, 25],
    [87, 0, 0],
    [74, 72, 9],
    [140, 101, 97],
  ];
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgba.set([...colors[(x >= 16 ? 1 : 0) + (y >= 16 ? 2 : 0)], 255], (y * width + x) * 4);
  return { width, height, rgba };
}
function geometry() {
  const keys = Array(width * height).fill('灰4');
  const g = microGeometry(microTiles(keys, width, height, 0.5), width, height, 0.25, 'wall', 0.5);
  const frame: GlassFrame = {
    width,
    height,
    pitch: 0.25,
    edgeM: 0.5,
    floor: g.floor,
    front: g.min[2] - 0.03,
  };
  return { keys, frame };
}
test('试验配色能选入真实琉璃家具，回读预览和清单对应且改善深色样例', () => {
  const result = exportImage(image(), {
    orientation: 'wall',
    longEdgeM: 8,
    maxFurniture: 5000,
    experimentalMaterials: true,
  });
  assert(result.summary.glassCount! > 0);
  assert(result.experimental!.recommended);
  assert(result.experimental!.averageDeltaEAfter < result.experimental!.averageDeltaEBefore * 0.7);
  assert.equal(
    result.summary.totalCount,
    result.materials.reduce((n, m) => n + m.count, 0),
  );
  assert.equal(
    result.materials.filter((m) => m.kind === 'glass').reduce((n, m) => n + m.count, 0),
    result.summary.glassCount,
  );
  assert.equal(result.preview.width, result.summary.gridWidth * 3);
  const bundle = createPackage(result);
  assert.match(bundle.materials, /彩色透明材料/);
  assert.match(bundle.guide, /试验配色/);
});
test('玻璃及基座都计入紧张预算，关闭试验保持原导出字节', () => {
  const source = image();
  const a = exportImage(source, { orientation: 'wall', longEdgeM: 8, maxFurniture: 1100 });
  const b = exportImage(source, {
    orientation: 'wall',
    longEdgeM: 8,
    maxFurniture: 1100,
    experimentalMaterials: false,
  });
  assert.deepEqual(a.blueprint, b.blueprint);
  const trial = exportImage(source, {
    orientation: 'wall',
    longEdgeM: 8,
    maxFurniture: 1100,
    experimentalMaterials: true,
  });
  assert(trial.summary.totalCount <= 1100);
  assert.equal(
    trial.summary.totalCount,
    trial.materials.reduce((n, m) => n + m.count, 0),
  );
});
test('玄雾按实际三角形取样，弧线缺口不会被包围盒涂满', () => {
  const { frame } = geometry();
  const index = glassMaterials.findIndex((m) => m.key.includes('玄雾'));
  const v = glassMaterials[index].variants.find((v) => v.name.endsWith('2米'))!;
  assert.equal(glassContains(v, -2.1, 0), false);
  assert.equal(glassContains(v, 1, 0), true);
  const coverage = glassCoverage(placeGlass(index, 1, 0.25, frame), frame);
  const samples = [...coverage.values()].reduce(
    (n, m) => n + m.toString(2).replaceAll('0', '').length,
    0,
  );
  assert(samples > 0 && samples < 8 * 2 * 9);
});
test('六类材料写入真实资源并从最终文件验证透明覆盖，重叠与篡改位置会拒绝', () => {
  const { keys, frame } = geometry();
  const black = glassMaterials.findIndex((m) => m.key.includes('玄雾'));
  let x = 2.25;
  const overlays = glassMaterials.map((_, i) =>
    placeGlass(i, i === black ? 1 : (x += 0.5) - 0.5, 0.25, frame),
  );
  const bytes = buildGlassBlueprint(keys, frame, overlays, true);
  const read = readGlassBlueprint(bytes, frame);
  assert.equal(read.overlays.length, 6);
  const rendered = renderGlassBlueprint(read, frame);
  assert(rendered.coveredSamples > 0);
  assert.equal(rendered.samples, width * height * 9);
  assert.deepEqual(encodeBlueprint(decodeBlueprint(bytes)), bytes);
  const edited = decodeBlueprint(bytes);
  const glass = walkNodes(edited.root).find(
    (n) => n.type === 0 && n.instanceId === width * height + 1,
  )!;
  glass.transform![7] += 1;
  assert.throws(() => readGlassBlueprint(encodeBlueprint(edited), frame), /位置异常/);
  const overlap = readGlassBlueprint(
    buildGlassBlueprint(keys, frame, [overlays[0], overlays[0]], true),
    frame,
  );
  assert.throws(() => renderGlassBlueprint(overlap, frame), /互相覆盖/);
});
test('不支持的试验模式、方向与未对齐长边给出明确错误', () => {
  assert.throws(
    () =>
      exportImage(image(), { orientation: 'ground', longEdgeM: 8, experimentalMaterials: true }),
    /墙面/,
  );
  assert.throws(
    () =>
      exportImage(image(), { orientation: 'wall', longEdgeM: 8.1, experimentalMaterials: true }),
    /0.5米/,
  );
  assert.throws(
    () =>
      exportImage(image(), {
        orientation: 'wall',
        longEdgeM: 8,
        experimentalSelection: 'candidate',
      }),
    /先开启/,
  );
});

test('扩色无收益时恢复完整基础网格，不能为了透明分区降低原方案精度', () => {
  const w = 72,
    h = 72,
    rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const color = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 224 : 168;
      rgba.set([color, color, color, 255], (y * w + x) * 4);
    }
  const source = { width: w, height: h, rgba };
  const basic = exportImage(source, { orientation: 'wall', longEdgeM: 8, maxFurniture: 8000 });
  const automatic = exportImage(source, {
    orientation: 'wall',
    longEdgeM: 8,
    maxFurniture: 8000,
    experimentalMaterials: true,
  });
  assert.equal(automatic.summary.glassCount, 0);
  assert.equal(automatic.summary.gridWidth, basic.summary.gridWidth);
  assert.equal(automatic.summary.gridHeight, basic.summary.gridHeight);
  assert.deepEqual(automatic.blueprint, basic.blueprint);
  assert(automatic.experimental?.outputUsesOriginalLayout);
});
