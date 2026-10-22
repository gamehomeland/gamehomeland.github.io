import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exportImage, createPackage, encodePng } from '../packages/core/src/index.js';
import type { RawImage, ExportOptions } from '../packages/core/src/types.js';
const root = resolve('artifacts/samples');
mkdirSync(root, { recursive: true });
function image(width: number, height: number, pixel: (x: number, y: number) => number[]): RawImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, rgba };
}
const images = {
  mosaic: image(32, 24, (x, y) => {
    const colors = [
      [42, 67, 40],
      [205, 96, 51],
      [239, 199, 91],
      [254, 238, 206],
      [71, 110, 135],
    ];
    return [...colors[(Math.floor(x / 4) + Math.floor(y / 4)) % 5], 255];
  }),
  gradient: image(144, 96, (x, y) => [
    Math.round((x / 143) * 255),
    Math.round((y / 95) * 255),
    Math.round(210 - (x / 143) * 120),
    255,
  ]),
  transparent: image(96, 96, (x, y) => [50, 156, 102, Math.hypot(x - 48, y - 48) < 37 ? 255 : 0]),
  lines: image(160, 64, (x, y) => [
    ...(x % 20 < 3 || y % 16 < 2 ? [30, 32, 33] : [244, 233, 207]),
    255,
  ]),
};
const cases: [string, keyof typeof images, ExportOptions][] = [
  ['wall-8m', 'mosaic', { orientation: 'wall', longEdgeM: 8 }],
  ['ground-20m', 'mosaic', { orientation: 'ground', longEdgeM: 20 }],
  ['ground-100m', 'gradient', { orientation: 'ground', longEdgeM: 100, maxFurniture: 10000 }],
  ['ground-200m', 'mosaic', { orientation: 'ground', longEdgeM: 200 }],
  ['wall-1m', 'gradient', { orientation: 'wall', longEdgeM: 1, maxFurniture: 5000 }],
  ['transparent-8m', 'transparent', { orientation: 'wall', longEdgeM: 8, maxFurniture: 10000 }],
  ['lines-ground', 'lines', { orientation: 'ground', longEdgeM: 12, maxFurniture: 10000 }],
  ['hidden-handle', 'mosaic', { orientation: 'ground', longEdgeM: 8, showRootHandle: false }],
];
const rows = [];
for (const [name, id, options] of cases) {
  const start = performance.now(),
    result = exportImage(images[id], options),
    bundle = createPackage(result),
    folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  for (const [filename, body] of Object.entries({
    '家园蓝图.blueprintx': result.blueprint,
    '效果预览.png': bundle.png,
    '原图.png': encodePng(images[id]),
    '完整包.zip': bundle.zip,
    '家具清单.txt': bundle.materials,
    '使用说明.txt': bundle.guide,
  }))
    writeFileSync(join(folder, filename), body);
  const row = {
    name,
    options,
    summary: result.summary,
    verification: result.verification,
    milliseconds: Math.round(performance.now() - start),
    sha256: createHash('sha256').update(result.blueprint).digest('hex'),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(root, 'results.json'), JSON.stringify(rows, null, 2));
