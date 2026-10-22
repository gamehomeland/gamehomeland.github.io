import { zlibSync } from 'fflate';
import type { RawImage } from './types.js';
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, -4)));
  return out;
}
/** PNG 编码与界面/Canvas无关，网页、桌面和Node使用同一份输出。 */
export function encodePng(image: RawImage, scale = 1): Uint8Array {
  if (
    !Number.isInteger(scale) ||
    scale < 1 ||
    image.width * image.height * scale * scale > 8_000_000
  )
    throw new Error('预览图尺寸无效');
  const width = image.width * scale,
    height = image.height * scale,
    row = width * 4 + 1,
    raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      const from = (sourceY * image.width + Math.floor(x / scale)) * 4,
        to = y * row + 1 + x * 4;
      raw.set(image.rgba.subarray(from, from + 4), to);
    }
  }
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const pieces = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(pieces.reduce((n, x) => n + x.length, 0));
  let offset = 0;
  for (const p of pieces) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
