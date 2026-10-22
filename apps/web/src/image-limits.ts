export const MAX_IMAGE_FILE_BYTES = 50 * 1024 ** 2;
export const MAX_IMAGE_PIXELS = 8_000_000;

export function checkImageSize(width: number, height: number): void {
  if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS)
    throw new Error('图片不能超过 800 万像素');
}
