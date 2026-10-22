import { mkdir, writeFile } from 'node:fs/promises';
import { exportImage, createPackage } from '../packages/core/src/index.js';

// 应用层可换成自己的图片解码器。核心只需要 RGBA 字节，不依赖 Canvas 或文件格式。
const width = 32,
  height = 24;
const rgba = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const border = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
    rgba.set(border ? [30, 35, 40, 255] : [230, 140 + y * 3, 70 + x * 3, 255], (y * width + x) * 4);
  }

const result = exportImage(
  { width, height, rgba },
  { orientation: 'wall', longEdgeM: 8, maxFurniture: 5000 },
);
const bundle = createPackage(result);
const output = new URL('../artifacts/core-example/', import.meta.url);
await mkdir(output, { recursive: true });
for (const [name, data] of [
  ['家园蓝图.blueprintx', result.blueprint],
  ['效果预览.png', bundle.png],
  ['家具清单.txt', bundle.materials],
  ['使用说明.txt', bundle.guide],
  ['家园蓝图.zip', bundle.zip],
] as const)
  await writeFile(new URL(name, output), data);
console.log(
  JSON.stringify(
    { output: output.href, summary: result.summary, verification: result.verification },
    null,
    2,
  ),
);
