import { readPreviewScene } from '../../../packages/core/src/scene.js';
import type { ExportResult } from '../../../packages/core/src/types.js';
const context = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ blueprint: Uint8Array; summary: ExportResult['summary'] }>) => void)
    | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
context.onmessage = ({ data }) => {
  try {
    const scene = readPreviewScene(data.blueprint, data.summary);
    const buffers = scene.batches.flatMap((b) => [
      b.transforms.buffer,
      b.instanceIds.buffer,
      ...(b.triangles ? [b.triangles.buffer] : []),
    ]) as ArrayBuffer[];
    context.postMessage({ type: 'result', scene }, buffers);
  } catch (error) {
    context.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '蓝图预览读取失败',
    });
  }
};
