import { gifFirstFrame } from './gif.js';
import { MAX_IMAGE_FILE_BYTES, checkImageSize } from './image-limits.js';

export interface ImageHeader {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp' | 'gif';
}
export function imageHeader(bytes: Uint8Array): ImageHeader {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ascii = (p: number, n: number) => String.fromCharCode(...bytes.subarray(p, p + n));
  let result: ImageHeader | undefined;
  if (ascii(0, 3) === 'GIF') {
    const first = gifFirstFrame(bytes);
    result = { format: 'gif', width: first.width, height: first.height };
  } else if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === 'PNG') {
    if (
      bytes[4] !== 13 ||
      bytes[5] !== 10 ||
      bytes[6] !== 26 ||
      bytes[7] !== 10 ||
      v.getUint32(8) !== 13 ||
      ascii(12, 4) !== 'IHDR'
    )
      throw new Error('PNG 图片头无效');
    result = { format: 'png', width: v.getUint32(16), height: v.getUint32(20) };
    let p = 8,
      ended = false,
      data = false;
    while (p + 12 <= bytes.length) {
      const size = v.getUint32(p),
        type = ascii(p + 4, 4);
      if (p + 12 + size > bytes.length) throw new Error('PNG 图片不完整');
      if (type === 'acTL' && size >= 8 && v.getUint32(p + 8) > 1)
        throw new Error('动画 PNG 和动画 WebP 暂不支持，请先导出为静态图片。');
      if (type === 'IDAT') data = true;
      p += size + 12;
      if (type === 'IEND') {
        ended = size === 0;
        break;
      }
    }
    if (!ended || !data) throw new Error('PNG 图片不完整');
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 255) {
        p++;
        continue;
      }
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > bytes.length) break;
      const length = v.getUint16(p);
      if (length < 2 || p + length > bytes.length) throw new Error('JPG 图片不完整');
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new Error('JPG 图片头无效');
        result = { format: 'jpeg', height: v.getUint16(p + 3), width: v.getUint16(p + 5) };
        break;
      }
      p += length;
    }
  } else if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (v.getUint32(4, true) + 8 !== bytes.length) throw new Error('WebP 图片不完整');
    let p = 12;
    while (p + 8 <= bytes.length) {
      const type = ascii(p, 4),
        size = v.getUint32(p + 4, true),
        s = p + 8;
      if (s + size > bytes.length) throw new Error('WebP 图片不完整');
      if (type === 'ANIM' || type === 'ANMF') throw new Error('动画 PNG 和动画 WebP 暂不支持，请先导出为静态图片。');
      if (type === 'VP8X' && size >= 10) {
        if (bytes[s] & 2) throw new Error('动画 PNG 和动画 WebP 暂不支持，请先导出为静态图片。');
        result = {
          format: 'webp',
          width: 1 + (bytes[s + 4] | (bytes[s + 5] << 8) | (bytes[s + 6] << 16)),
          height: 1 + (bytes[s + 7] | (bytes[s + 8] << 8) | (bytes[s + 9] << 16)),
        };
      }
      if (type === 'VP8L' && size >= 5 && bytes[s] === 47) {
        const bits = v.getUint32(s + 1, true);
        const candidate = {
          format: 'webp' as const,
          width: (bits & 16383) + 1,
          height: ((bits >>> 14) & 16383) + 1,
        };
        if (!result) result = candidate;
        else if (result.width !== candidate.width || result.height !== candidate.height)
          throw new Error('WebP 尺寸信息不一致');
      }
      if (
        type === 'VP8 ' &&
        size >= 10 &&
        bytes[s + 3] === 157 &&
        bytes[s + 4] === 1 &&
        bytes[s + 5] === 42
      ) {
        const candidate = {
          format: 'webp' as const,
          width: v.getUint16(s + 6, true) & 16383,
          height: v.getUint16(s + 8, true) & 16383,
        };
        if (!result) result = candidate;
        else if (result.width !== candidate.width || result.height !== candidate.height)
          throw new Error('WebP 尺寸信息不一致');
      }
      p = s + size + (size % 2);
    }
  }
  if (!result) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
  checkImageSize(result.width, result.height);
  return result;
}
export async function validateFile(file: File): Promise<ImageHeader> {
  if (!file.size || file.size > MAX_IMAGE_FILE_BYTES) throw new Error('图片为空或超过 50 MiB');
  return imageHeader(new Uint8Array(await file.arrayBuffer()));
}

export async function prepareFile(file: File): Promise<{
  header: ImageHeader;
  file: File;
  firstFrameOnly: boolean;
}> {
  if (!file.size || file.size > MAX_IMAGE_FILE_BYTES) throw new Error('图片为空或超过 50 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') {
    const first = gifFirstFrame(bytes);
    return {
      header: { width: first.width, height: first.height, format: 'gif' },
      file: new File([first.bytes.slice().buffer as ArrayBuffer], file.name, { type: 'image/gif' }),
      firstFrameOnly: true,
    };
  }
  return { header: imageHeader(bytes), file, firstFrameOnly: false };
}
export async function decodeFile(
  file: File,
): Promise<{ width: number; height: number; rgba: ArrayBuffer }> {
  const prepared = await prepareFile(file);
  const bitmap = await createImageBitmap(prepared.file, {
    imageOrientation: 'from-image',
    colorSpaceConversion: 'default',
  });
  try {
    checkImageSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!context) throw new Error('当前浏览器无法读取图片');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 1;
    return { width: bitmap.width, height: bitmap.height, rgba: pixels.data.buffer as ArrayBuffer };
  } finally {
    bitmap.close();
  }
}
