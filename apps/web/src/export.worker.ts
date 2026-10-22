import { exportImage, createPackage } from '../../../packages/core/src/index.js';
import type { ExportOptions } from '../../../packages/core/src/types.js';
interface Input {
  width: number;
  height: number;
  rgba: ArrayBuffer;
  options: ExportOptions;
}
const context = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Input>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
context.onmessage = (event) => {
  try {
    const { width, height, rgba, options } = event.data;
    const result = exportImage({ width, height, rgba: new Uint8Array(rgba) }, options, (progress) =>
      context.postMessage({ type: 'progress', ...progress }),
    );
    const bundle = createPackage(result);
    context.postMessage(
      {
        type: 'result',
        summary: result.summary,
        verification: result.verification,
        materials: result.materials,
        blueprint: result.blueprint,
        png: bundle.png,
        zip: bundle.zip,
      },
      [
        result.blueprint.buffer as ArrayBuffer,
        bundle.png.buffer as ArrayBuffer,
        bundle.zip.buffer as ArrayBuffer,
      ],
    );
  } catch (error) {
    context.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '生成失败，请重新选择图片',
    });
  }
};
