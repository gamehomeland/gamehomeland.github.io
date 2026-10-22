import type { Recipe, RawImage, Orientation, Vec3 } from './types.js';
import { rgbLab, labRgb, colorCost, deltaE2, clamp } from './math.js';
import { neutralKeys, visibleColor } from './catalog.js';

export const LAYER_PENALTIES = [0, 4, 16, 60];
export interface ColorCandidates {
  choices: Uint16Array[];
  opaque: Uint16Array;
  alternatives: Uint16Array;
  source: Uint8Array;
  target: Uint8Array;
}
export function fitMaterial(rgb: Vec3, direction: Orientation): Vec3 {
  const [black, white] = [neutralKeys.black, neutralKeys.white].map(
    (key) => rgbLab(visibleColor([key], direction))[0],
  );
  const lab = rgbLab(rgb),
    chroma = Math.hypot(lab[1], lab[2]),
    weight = clamp((24 - chroma) / 18, 0.35, 1);
  lab[0] += weight * (black + (lab[0] * (white - black)) / 100 - lab[0]);
  return labRgb(lab);
}
export function matchColors(
  image: RawImage,
  recipes: Recipe[],
  direction: Orientation,
  fit: boolean,
  onProgress?: (fraction: number) => void,
): ColorCandidates {
  const count = image.width * image.height,
    choices = LAYER_PENALTIES.map(() => new Uint16Array(count)),
    opaque = new Uint16Array(count),
    alternatives = new Uint16Array(count * 8),
    source = new Uint8Array(count * 3),
    target = new Uint8Array(count * 3);
  const memo = new Map<number, { choices: number[]; top: number[]; opaque: number }>(),
    neutral = recipes.map((r) => Math.hypot(r.lab[1], r.lab[2]) < 6),
    hasNeutral = neutral.some(Boolean);
  for (let i = 0; i < count; i++) {
    const original: Vec3 = [image.rgba[i * 4], image.rgba[i * 4 + 1], image.rgba[i * 4 + 2]];
    source.set(original, i * 3);
    const rgb = fit ? fitMaterial(original, direction) : original,
      key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    target.set(rgb, i * 3);
    let saved = memo.get(key);
    if (!saved) {
      const lab = rgbLab(rgb),
        trulyNeutral = Math.hypot(lab[1], lab[2]) < 3;
      const costs = recipes.map((r, index) =>
        hasNeutral && trulyNeutral && !neutral[index] ? Infinity : colorCost(lab, r.lab),
      );
      let single = Infinity,
        singleIndex = 0;
      for (let j = 0; j < recipes.length; j++)
        if (recipes[j].depth === 1 && costs[j] < single) {
          single = costs[j];
          singleIndex = j;
        }
      const first = Math.sqrt(single);
      for (let j = 0; j < recipes.length; j++)
        if (recipes[j].depth > 1) {
          const gain = first - Math.sqrt(costs[j]);
          if (gain < 0.8 + 0.2 * (recipes[j].depth - 1) || gain < 0.05 * first) costs[j] = Infinity;
        }
      const picks = LAYER_PENALTIES.map((penalty) => {
        let best = 0,
          minimum = Infinity;
        for (let j = 0; j < costs.length; j++) {
          const score = costs[j] + penalty * (recipes[j].depth - 1);
          if (score < minimum) {
            minimum = score;
            best = j;
          }
        }
        return best;
      });
      const top = costs
        .map((cost, index) => ({ cost, index }))
        .filter((v) => Number.isFinite(v.cost))
        .sort((a, b) => a.cost - b.cost || a.index - b.index)
        .slice(0, 8)
        .map((x) => x.index);
      while (top.length < 8) top.push(picks[0]);
      saved = { choices: picks, top, opaque: singleIndex };
      memo.set(key, saved);
    }
    for (let p = 0; p < choices.length; p++) choices[p][i] = saved.choices[p];
    opaque[i] = saved.opaque;
    alternatives.set(saved.top, i * 8);
    if (i % 256 === 0) onProgress?.(i / count);
  }
  onProgress?.(1);
  return { choices, opaque, alternatives, source, target };
}

function blur(source: Float64Array, width: number, height: number): Float64Array {
  const weights = Array.from({ length: 7 }, (_, i) => Math.exp(-((i - 3) ** 2) / (2 * 1.1 ** 2))),
    sum = weights.reduce((a, b) => a + b, 0);
  const kernel = weights.map((x) => x / sum),
    temp = new Float64Array(source.length),
    out = new Float64Array(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        for (let k = -3; k <= 3; k++)
          temp[(y * width + x) * 3 + c] +=
            source[(y * width + clamp(x + k, 0, width - 1)) * 3 + c] * kernel[k + 3];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        for (let k = -3; k <= 3; k++)
          out[(y * width + x) * 3 + c] +=
            temp[(clamp(y + k, 0, height - 1) * width + x) * 3 + c] * kernel[k + 3];
  return out;
}
/** 同时比较色差、彩度、轮廓与新增颗粒；不修改最终家具颜色。 */
export function scoreColors(
  source: Uint8Array,
  indices: Uint16Array,
  recipes: Recipe[],
  width: number,
  height: number,
  direction: Orientation,
  rangeFit = true,
): { score: number; grain: number } {
  const target = Float64Array.from(source),
    rendered = new Float64Array(source.length);
  indices.forEach((recipe, i) => rendered.set(recipes[recipe].rgb, i * 3));
  const a = blur(target, width, height),
    b = blur(rendered, width, height);
  const [black, white] = [neutralKeys.black, neutralKeys.white].map(
    (k) => rgbLab(visibleColor([k], direction))[0],
  );
  let total = 0,
    grain = 0,
    contrast = 0,
    edges = 0;
  for (let i = 0; i < indices.length; i++) {
    const offset = i * 3,
      la = rgbLab(a.subarray(offset, offset + 3)),
      lb = rgbLab(b.subarray(offset, offset + 3));
    const chroma = Math.hypot(la[1], la[2]),
      relative: Vec3 = [clamp(((lb[0] - black) * 100) / (white - black), 0, 100), lb[1], lb[2]],
      weight = rangeFit ? 0.7 * clamp((24 - chroma) / 18, 0.35, 1) : 0;
    let detail = 0,
      added = 0,
      edge = 0;
    for (let c = 0; c < 3; c++) {
      detail +=
        Math.abs(target[offset + c] - a[offset + c] - (rendered[offset + c] - b[offset + c])) / 3;
      added +=
        Math.max(
          0,
          Math.abs(rendered[offset + c] - b[offset + c]) -
            Math.abs(target[offset + c] - a[offset + c]),
        ) / 3;
    }
    for (const neighbor of [i % width ? i - 1 : i, i >= width ? i - width : i]) {
      let ag = 0,
        bg = 0;
      for (let c = 0; c < 3; c++) {
        edge +=
          Math.abs(a[offset + c] - a[neighbor * 3 + c] - (b[offset + c] - b[neighbor * 3 + c])) / 3;
        ag += Math.abs(a[offset + c] - a[neighbor * 3 + c]) / 3;
        bg += Math.abs(b[offset + c] - b[neighbor * 3 + c]) / 3;
      }
      if (ag > 4) {
        contrast += Math.max(0, ag - bg - 1);
        edges++;
      }
    }
    total +=
      weight * Math.sqrt(deltaE2(la, relative)) +
      (1 - weight) * Math.sqrt(deltaE2(la, lb)) +
      0.2 * Math.max(0, chroma - Math.hypot(lb[1], lb[2]) - 1) +
      0.035 * edge +
      0.018 * detail +
      0.25 * added;
    grain += added;
  }
  return {
    score: total / indices.length + (edges ? (0.6 * contrast) / edges : 0),
    grain: grain / indices.length,
  };
}
export function refineSpatial(
  source: Uint8Array,
  initial: Uint16Array,
  alternatives: Uint16Array,
  recipes: Recipe[],
  width: number,
  height: number,
): Uint16Array {
  const grid = initial.slice(),
    protectedPixels = new Uint8Array(grid.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!x || !y || x === width - 1 || y === height - 1) {
        protectedPixels[i] = 1;
        continue;
      }
      for (const n of [i - 1, i + 1, i - width, i + width])
        for (let c = 0; c < 3; c++)
          if (Math.abs(source[i * 3 + c] - source[n * 3 + c]) > 32) protectedPixels[i] = 1;
    }
  for (let pass = 0; pass < 3; pass++)
    for (let parity = 0; parity < 2; parity++) {
      const before = grid.slice();
      for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (protectedPixels[i] || (x + y) % 2 !== parity) continue;
          const neighbors = [i - 1, i + 1, i - width, i + width],
            targetMean: Vec3 = [0, 0, 0],
            mean: Vec3 = [0, 0, 0],
            current = recipes[before[i]].rgb;
          for (let c = 0; c < 3; c++) {
            targetMean[c] = 2 * source[i * 3 + c];
            for (const n of neighbors) {
              mean[c] += recipes[before[n]].rgb[c] / 4;
              targetMean[c] += source[n * 3 + c];
            }
            targetMean[c] /= 6;
          }
          let best = before[i],
            cost = Infinity;
          const limit = (source[i * 3] + source[i * 3 + 1] + source[i * 3 + 2]) / 3 < 60 ? 18 : 42;
          for (const choice of [before[i], ...alternatives.subarray(i * 8, i * 8 + 8)]) {
            const rgb = recipes[choice].rgb;
            if (rgb.some((v, c) => Math.abs(v - current[c]) > limit)) continue;
            let error = 0;
            for (let c = 0; c < 3; c++)
              error +=
                (((2 * rgb[c] + 4 * mean[c]) / 6 - targetMean[c]) ** 2 +
                  0.13 * (rgb[c] - source[i * 3 + c]) ** 2) /
                3;
            if (error < cost - 1e-6) {
              cost = error;
              best = choice;
            }
          }
          grid[i] = best;
        }
    }
  return grid;
}
