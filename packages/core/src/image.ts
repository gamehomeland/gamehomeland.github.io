import type { RawImage, ExportOptions, Vec3 } from './types.js';
import { clamp, roundEven } from './math.js';
import { supportCount } from './component.js';
import { MAX_OUTPUT_FURNITURE, MIN_OUTPUT_FURNITURE, MAX_GRID_EDGE } from './budget.js';

export interface ImageProfile {
  kind: 'pixel' | 'graphic' | 'soft' | 'photo';
  suggestedGridEdge: number;
}
export type ValidatedOptions = Required<ExportOptions> & { automaticBudget: boolean };
export interface PreparedImage {
  image: RawImage;
  profile: ImageProfile;
  cellM: number;
  physicalEdgeM: number;
  layout: 'native' | 'miniature';
  backgroundFilled: boolean;
  canvasPadded: boolean;
}

/** 缩图后补回局部边缘；平涂区域清理轻微 JPEG 噪声。 */
export function restoreSampleDetail(image: RawImage, clean: boolean): RawImage {
  const { width, height } = image,
    source = image.rgba,
    rgba = new Uint8Array(source);
  const kernel = [
    Math.exp((-2 * 2) / (2 * 0.6 * 0.6)),
    Math.exp(-1 / (2 * 0.6 * 0.6)),
    1,
    Math.exp(-1 / (2 * 0.6 * 0.6)),
    Math.exp((-2 * 2) / (2 * 0.6 * 0.6)),
  ];
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const horizontal = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        for (let k = -2; k <= 2; k++)
          horizontal[(y * width + x) * 3 + c] +=
            source[(y * width + clamp(x + k, 0, width - 1)) * 4 + c] * kernel[k + 2];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        let blur = 0;
        for (let k = -2; k <= 2; k++)
          blur += horizontal[(clamp(y + k, 0, height - 1) * width + x) * 3 + c] * kernel[k + 2];
        const i = (y * width + x) * 4 + c,
          difference = source[i] - blur;
        if (Math.abs(difference) > 8)
          rgba[i] = clamp(roundEven(source[i] + 0.3 * difference), 0, 255);
      }
  if (clean) {
    const before = rgba.slice();
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const channels: number[][] = [[], [], []];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            for (let c = 0; c < 3; c++)
              channels[c].push(before[((y + dy) * width + x + dx) * 4 + c]);
        if (channels.every((values) => Math.max(...values) - Math.min(...values) <= 10))
          for (let c = 0; c < 3; c++)
            rgba[(y * width + x) * 4 + c] = channels[c].sort((a, b) => a - b)[4];
      }
  }
  return { width, height, rgba };
}
export function validateImage(image: RawImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > 8_000_000 ||
    image.rgba.length !== image.width * image.height * 4
  )
    throw new Error('图片尺寸无效或超过 800 万像素');
}
export function validateOptions(input: ExportOptions): ValidatedOptions {
  if (
    !input ||
    !['wall', 'ground'].includes(input.orientation) ||
    !Number.isFinite(input.longEdgeM) ||
    input.longEdgeM < 1 ||
    input.longEdgeM > (input.orientation === 'wall' ? 96 : 200)
  )
    throw new Error('请选择有效的摆放方式和长边尺寸');
  const maxFurniture = input.maxFurniture ?? MAX_OUTPUT_FURNITURE,
    maxGridEdge = input.maxGridEdge ?? MAX_GRID_EDGE;
  if (
    !Number.isInteger(maxFurniture) ||
    maxFurniture < MIN_OUTPUT_FURNITURE ||
    maxFurniture > MAX_OUTPUT_FURNITURE ||
    !Number.isInteger(maxGridEdge) ||
    maxGridEdge < 1 ||
    maxGridEdge > MAX_GRID_EDGE
  )
    throw new Error('家具预算或网格上限无效');
  if (input.showRootHandle !== undefined && typeof input.showRootHandle !== 'boolean')
    throw new Error('基座显示选项无效');
  if (input.experimentalMaterials !== undefined && typeof input.experimentalMaterials !== 'boolean')
    throw new Error('试验配色选项无效');
  if (
    input.experimentalSelection !== undefined &&
    !['improve', 'candidate'].includes(input.experimentalSelection)
  )
    throw new Error('试验对照选项无效');
  if (input.experimentalSelection === 'candidate' && !input.experimentalMaterials)
    throw new Error('候选对照需要先开启试验配色');
  if (
    input.experimentalMaterials &&
    (input.orientation !== 'wall' ||
      Math.abs(input.longEdgeM * 2 - Math.round(input.longEdgeM * 2)) > 1e-6)
  )
    throw new Error('试验配色目前用于墙面画，长边请填写0.5米的倍数');
  return {
    ...input,
    maxFurniture,
    maxGridEdge,
    showRootHandle: input.showRootHandle ?? true,
    experimentalMaterials: input.experimentalMaterials ?? false,
    experimentalSelection: input.experimentalSelection ?? 'improve',
    automaticBudget: input.maxFurniture === undefined,
  };
}
/** 虚拟白底画布取样，避免极细长图片留边时分配巨幅中间图。 */
export function resample(
  image: RawImage,
  width: number,
  height: number,
  canvasW = image.width,
  canvasH = image.height,
  pixel = false,
): RawImage {
  const out = new Uint8Array(width * height * 4),
    ox = Math.floor((canvasW - image.width) / 2),
    oy = Math.floor((canvasH - image.height) / 2);
  const source = (x: number, y: number): Vec3 => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [255, 255, 255];
    const p = (y * image.width + x) * 4,
      a = image.rgba[p + 3] / 255;
    return [
      image.rgba[p] * a + 255 * (1 - a),
      image.rgba[p + 1] * a + 255 * (1 - a),
      image.rgba[p + 2] * a + 255 * (1 - a),
    ];
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let rgb: Vec3;
      if (pixel) {
        rgb = source(
          Math.floor(((x + 0.5) * canvasW) / width) - ox,
          Math.floor(((y + 0.5) * canvasH) / height) - oy,
        );
      } else {
        const left = (x * canvasW) / width - ox,
          right = ((x + 1) * canvasW) / width - ox,
          top = (y * canvasH) / height - oy,
          bottom = ((y + 1) * canvasH) / height - oy;
        const area = (right - left) * (bottom - top);
        const sums: Vec3 = [255 * area, 255 * area, 255 * area];
        for (
          let sy = Math.max(0, Math.floor(top));
          sy < Math.min(image.height, Math.ceil(bottom));
          sy++
        ) {
          const wy = Math.max(0, Math.min(bottom, sy + 1) - Math.max(top, sy));
          for (
            let sx = Math.max(0, Math.floor(left));
            sx < Math.min(image.width, Math.ceil(right));
            sx++
          ) {
            const weight = wy * Math.max(0, Math.min(right, sx + 1) - Math.max(left, sx)),
              c = source(sx, sy);
            for (let ch = 0; ch < 3; ch++) sums[ch] += (c[ch] - 255) * weight;
          }
        }
        rgb = sums.map((v) => v / area) as Vec3;
      }
      const i = (y * width + x) * 4;
      out[i] = clamp(roundEven(rgb[0]), 0, 255);
      out[i + 1] = clamp(roundEven(rgb[1]), 0, 255);
      out[i + 2] = clamp(roundEven(rgb[2]), 0, 255);
      out[i + 3] = 255;
    }
  return { width, height, rgba: out };
}
export function profileImage(source: RawImage): ImageProfile {
  const edge = Math.min(128, Math.max(source.width, source.height)),
    probe = resample(
      source,
      Math.max(1, roundEven((source.width * edge) / Math.max(source.width, source.height))),
      Math.max(1, roundEven((source.height * edge) / Math.max(source.width, source.height))),
    );
  const exact = new Set<number>(),
    coarse = new Map<number, number>();
  let soft = 0;
  for (let i = 0; i < probe.rgba.length; i += 4) {
    const [r, g, b] = [probe.rgba[i], probe.rgba[i + 1], probe.rgba[i + 2]];
    exact.add((r << 16) | (g << 8) | b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    coarse.set(key, (coarse.get(key) ?? 0) + 1);
    const high = Math.max(r, g, b) / 255,
      low = Math.min(r, g, b) / 255,
      saturation = high ? (high - low) / high : 0;
    if (saturation < 0.5 && high > 0.55) soft++;
  }
  const count = probe.width * probe.height,
    dominant =
      [...coarse.values()]
        .sort((a, b) => b - a)
        .slice(0, 16)
        .reduce((s, v) => s + v, 0) / count;
  const pixel = Math.max(source.width, source.height) <= 128 && exact.size <= 96 && dominant >= 0.8;
  let transitions = 0;
  for (let y = 0; y < probe.height; y++)
    for (let x = 0; x < probe.width; x++) {
      const offset = (y * probe.width + x) * 4;
      for (const neighbor of [x ? offset - 4 : offset, y ? offset - probe.width * 4 : offset])
        if ([0, 1, 2].some((c) => Math.abs(probe.rgba[offset + c] - probe.rgba[neighbor + c]) > 24))
          transitions++;
    }
  const entropy = [...coarse.values()].reduce(
    (sum, n) => sum - (n / count) * Math.log2(n / count),
    0,
  );
  const aspect = Math.max(probe.width / probe.height, probe.height / probe.width);
  // 自动采样的工程启发式：轮廓丰富时保留线条，连续色调丰富时保留渐变；常色图允许简化。
  const suggestedGridEdge =
    coarse.size === 1
      ? 1
      : Math.ceil(Math.max(64, 4 * Math.sqrt(transitions * aspect), 32 * entropy));
  return {
    kind: pixel ? 'pixel' : dominant >= 0.9 ? 'graphic' : soft / count > 0.6 ? 'soft' : 'photo',
    suggestedGridEdge,
  };
}
export function prepareImage(source: RawImage, options: ValidatedOptions): PreparedImage {
  validateImage(source);
  const profile = profileImage(source);
  let canvasW = source.width,
    canvasH = source.height;
  let visible = false,
    backgroundFilled = false;
  for (let i = 3; i < source.rgba.length; i += 4) {
    visible ||= source.rgba[i] >= 31;
    backgroundFilled ||= source.rgba[i] < 255;
  }
  if (!visible) throw new Error('图片没有可制作的可见内容');
  const allowedRatio = Math.max(1, options.longEdgeM / 1.02);
  if (canvasW / canvasH > allowedRatio) canvasH = Math.ceil(canvasW / allowedRatio);
  else if (canvasH / canvasW > allowedRatio) canvasW = Math.ceil(canvasH / allowedRatio);
  let maximum = Math.min(options.maxGridEdge, Math.max(source.width, source.height));
  if (options.automaticBudget && profile.kind !== 'pixel')
    maximum = Math.min(maximum, profile.suggestedGridEdge);
  if (profile.kind === 'pixel')
    maximum = Math.min(
      maximum,
      Math.max(
        32,
        Math.max(source.width, source.height) <= 32
          ? 32
          : Math.max(source.width, source.height) <= 64
            ? 64
            : 128,
      ),
    );
  const required = Math.ceil(options.longEdgeM / 8);
  if (maximum < required)
    maximum = Math.min(options.maxGridEdge, Math.ceil(required / maximum) * maximum);
  let width = 0,
    height = 0;
  for (let edge = maximum; edge >= 1; edge--) {
    if (options.experimentalMaterials && edge % Math.round(options.longEdgeM / 0.5) !== 0) continue;
    const w = Math.max(1, roundEven((canvasW * edge) / Math.max(canvasW, canvasH))),
      h = Math.max(1, roundEven((canvasH * edge) / Math.max(canvasW, canvasH)));
    if (
      w * h + supportCount(w * h) <= options.maxFurniture &&
      options.longEdgeM / Math.max(w, h) <= 8
    ) {
      width = w;
      height = h;
      break;
    }
  }
  if (!width) throw new Error('当前尺寸与家具预算无法容纳图片');
  let cellM = options.longEdgeM / Math.max(width, height);
  if (cellM > 0.25 && cellM < 0.5 && options.longEdgeM < 2) {
    width *= 2;
    height *= 2;
    cellM = options.longEdgeM / Math.max(width, height);
  }
  if (width * height + supportCount(width * height) > options.maxFurniture)
    throw new Error('当前小尺寸需要更多家具，请调整尺寸');
  const layout = cellM >= 0.5 ? 'native' : 'miniature';
  const physicalEdgeM =
    layout === 'native'
      ? cellM
      : [0.5, 1, 2, 4, 8].find((e) => cellM / (e / 0.5) >= 0.001 && cellM / (e / 0.5) <= 0.25);
  if (physicalEdgeM === undefined) throw new Error('无法为该尺寸选择合法拼布');
  let sampled = resample(source, width, height, canvasW, canvasH, profile.kind === 'pixel');
  if (profile.kind !== 'pixel' && Math.max(source.width, source.height) > Math.max(width, height))
    sampled = restoreSampleDetail(sampled, profile.kind === 'graphic');
  return {
    image: sampled,
    profile,
    cellM,
    physicalEdgeM,
    layout,
    backgroundFilled,
    canvasPadded: canvasW !== source.width || canvasH !== source.height,
  };
}
