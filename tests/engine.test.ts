import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8, unzlibSync } from 'fflate';
import {
  exportImage,
  createPackage,
  decodeBlueprint,
  walkNodes,
  PACKAGE_NAMES,
} from '../packages/core/src/index.js';
import type { RawImage } from '../packages/core/src/types.js';
import { MAX_OUTPUT_FURNITURE } from '../packages/core/src/budget.js';

function source(width = 32, height = 24): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = x < width / 2 ? [205, 40, 45, 255] : [40, 120, 180, 255];
      rgba.set(color, (y * width + x) * 4);
    }
  return { width, height, rgba };
}
for (const orientation of ['wall', 'ground'] as const)
  for (const longEdgeM of [1, 8, 80]) {
    test(`独立导出及四件套 ${orientation} ${longEdgeM}米`, () => {
      const result = exportImage(source(), { orientation, longEdgeM }),
        bundle = createPackage(result),
        files = unzipSync(bundle.zip);
      assert.equal(Math.max(result.summary.widthM, result.summary.heightM), longEdgeM);
      assert.ok(result.summary.totalCount <= MAX_OUTPUT_FURNITURE);
      assert.ok(result.verification.geometry);
      assert.deepEqual(Object.keys(files).sort(), [...PACKAGE_NAMES].sort());
      assert.deepEqual(files['家园蓝图.blueprintx'], result.blueprint);
      assert.deepEqual(files['效果预览.png'], bundle.png);
      assert.equal(
        result.materials.reduce((n, row) => n + row.count, 0),
        result.summary.totalCount,
      );
      const guide = strFromU8(files['使用说明.txt']);
      assert.ok(guide.includes(`${longEdgeM}`));
      assert.ok(!/token|API|队列|manifest|RVA|私有/.test(guide));
      const materialCount = [
        ...strFromU8(files['家具清单.txt']).matchAll(/ × ([\d,]+) 件/g),
      ].reduce((n, m) => n + Number(m[1].replaceAll(',', '')), 0);
      assert.equal(materialCount, result.summary.totalCount);
      const nodes = walkNodes(decodeBlueprint(result.blueprint).root);
      assert.ok(nodes.length > 0);
    });
  }
test('透明输入铺白、极细长图保留比例并留边', () => {
  const image = source(120, 8);
  for (let i = 3; i < image.rgba.length; i += 4) if (i % 16 < 8) image.rgba[i] = 0;
  const result = exportImage(image, { orientation: 'wall', longEdgeM: 4 });
  assert.equal(result.summary.backgroundFilled, true);
  assert.equal(result.summary.canvasPadded, true);
  assert.equal(result.preview.rgba.length, result.preview.width * result.preview.height * 4);
});
test('全透明、无效尺寸和容量配置给出可理解错误', () => {
  assert.throws(
    () =>
      exportImage(
        { width: 1, height: 1, rgba: new Uint8Array(4) },
        { orientation: 'wall', longEdgeM: 8 },
      ),
    /可见/,
  );
  for (const longEdgeM of [0, NaN, 201])
    assert.throws(() => exportImage(source(), { orientation: 'ground', longEdgeM }));
  assert.throws(() =>
    exportImage(source(), { orientation: 'wall', longEdgeM: 8, maxFurniture: 1 }),
  );
});
test('相同输入的文件与打包结果确定一致', () => {
  const options = { orientation: 'ground' as const, longEdgeM: 20 };
  const a = exportImage(source(), options),
    b = exportImage(source(), options);
  assert.deepEqual(a.blueprint, b.blueprint);
  assert.deepEqual(createPackage(a).zip, createPackage(b).zip);
});
test('PNG 封装可解压且像素与文件回读预览相同', () => {
  const result = exportImage(source(8, 8), { orientation: 'wall', longEdgeM: 8 }),
    png = createPackage(result).png;
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength),
    width = view.getUint32(16),
    height = view.getUint32(20);
  let p = 8;
  const parts: Uint8Array[] = [];
  while (p < png.length) {
    const n = view.getUint32(p),
      name = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (name === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + n));
    p += n + 12;
  }
  const compressed = new Uint8Array(parts.reduce((n, piece) => n + piece.length, 0));
  let off = 0;
  for (const piece of parts) {
    compressed.set(piece, off);
    off += piece.length;
  }
  const raw = unzlibSync(compressed);
  assert.equal(raw.length, (width * 4 + 1) * height);
  assert.equal(raw[0], 0);
  assert.deepEqual([...raw.subarray(1, 5)], [...result.preview.rgba.subarray(0, 4)]);
});
test('浅灰图案与白背景保持可见区别，中性灰不出现偏色', () => {
  const width = 256,
    height = 128,
    rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gray = x < width / 2 ? 210 : 255;
      rgba.set([gray, gray, gray, 255], (y * width + x) * 4);
    }
  const result = exportImage(
    { width, height, rgba },
    { orientation: 'wall', longEdgeM: 8, maxGridEdge: 32 },
  );
  const body = Array.from(result.preview.rgba.subarray(0, 3));
  const background = Array.from(
    result.preview.rgba.subarray(
      (result.preview.width - 1) * 4,
      (result.preview.width - 1) * 4 + 3,
    ),
  );
  assert.ok(background[0] - body[0] >= 10, `gray=${body}, white=${background}`);
  assert.equal(Math.max(...body) - Math.min(...body), 0);
});
