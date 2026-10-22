import { checkImageSize } from './image-limits.js';

/** 将首个图像块封装为单帧 GIF，保留画布、调色板、交错标记及透明色。 */
export function gifFirstFrame(input: Uint8Array): {
  width: number;
  height: number;
  bytes: Uint8Array;
} {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const requireBytes = (start: number, length: number): void => {
    if (start + length > input.length) throw new Error('GIF 首帧数据不完整');
  };
  requireBytes(0, 13);
  const signature = String.fromCharCode(...input.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('GIF 文件头无效');
  const width = view.getUint16(6, true),
    height = view.getUint16(8, true);
  checkImageSize(width, height);
  const hasGlobalTable = !!(input[10] & 0x80);
  const headerEnd = 13 + (hasGlobalTable ? 3 * 2 ** ((input[10] & 7) + 1) : 0);
  requireBytes(0, headerEnd);
  let cursor = headerEnd;
  let control: Uint8Array | undefined;

  function skipSubBlocks(): number {
    let total = 0;
    while (true) {
      requireBytes(cursor, 1);
      const size = input[cursor++];
      if (size === 0) return total;
      requireBytes(cursor, size);
      cursor += size;
      total += size;
    }
  }
  while (cursor < input.length) {
    const start = cursor,
      kind = input[cursor++];
    if (kind === 0x21) {
      requireBytes(cursor, 1);
      const label = input[cursor++];
      if (label === 0xf9) {
        requireBytes(cursor, 6);
        if (input[cursor] !== 4 || input[cursor + 5] !== 0) throw new Error('GIF 首帧控制块无效');
        // 单帧不等待用户输入，不保留播放延迟和帧后处置；透明索引继续生效。
        control = Uint8Array.of(0x21, 0xf9, 4, input[cursor + 1] & 1, 0, 0, input[cursor + 4], 0);
        cursor += 6;
      } else if (label === 0x01) {
        throw new Error('GIF 首帧包含文本绘制块，请转为 PNG 后再试');
      } else {
        // 注释、应用扩展（包括循环次数）不属于首帧画面。
        skipSubBlocks();
      }
      continue;
    }
    if (kind === 0x3b) break;
    if (kind !== 0x2c) throw new Error('GIF 图像块无效');
    requireBytes(start, 10);
    const left = view.getUint16(start + 1, true),
      top = view.getUint16(start + 3, true);
    const frameWidth = view.getUint16(start + 5, true),
      frameHeight = view.getUint16(start + 7, true);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
      throw new Error('GIF 首帧超出画布范围');
    const flags = input[start + 9],
      hasLocalTable = !!(flags & 0x80);
    if (!hasLocalTable && !hasGlobalTable) throw new Error('GIF 首帧缺少调色板');
    cursor = start + 10 + (hasLocalTable ? 3 * 2 ** ((flags & 7) + 1) : 0);
    requireBytes(cursor, 1);
    const codeSize = input[cursor++];
    if (codeSize < 2 || codeSize > 8) throw new Error('GIF 首帧编码无效');
    if (!skipSubBlocks()) throw new Error('GIF 首帧没有图像数据');
    const output = new Uint8Array(headerEnd + (control?.length ?? 0) + cursor - start + 1);
    output.set(input.subarray(0, headerEnd));
    if (control) output.set(control, headerEnd);
    output.set(input.subarray(start, cursor), headerEnd + (control?.length ?? 0));
    output[output.length - 1] = 0x3b;
    return { width, height, bytes: output };
  }
  throw new Error('GIF 没有可读取的首帧');
}
