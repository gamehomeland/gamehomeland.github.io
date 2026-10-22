import { catalogData } from './catalog.generated.js';
import type { ClothColor, Recipe, Orientation, Vec3 } from './types.js';
import { rgbLab } from './math.js';
export const CLIENT_VERSION = catalogData.version;
export const colors = catalogData.colors as ClothColor[];
export const opaqueColors = colors.filter((c) => !c.translucent);
export const colorByKey = new Map(colors.map((c) => [c.key, c]));
export const variantById = new Map(
  colors.flatMap((color) =>
    color.variants.map((variant) => [variant.representId, { color, variant }] as const),
  ),
);
export const support = catalogData.support;
export const overlayKey = catalogData.overlayKey;
export const maxRecipeLayers = catalogData.maxRecipeLayers;
export function visibleColor(keys: readonly string[], direction: Orientation): Vec3 {
  const table = catalogData.tables[direction].colors as Record<string, number[]>;
  const value = table[JSON.stringify(keys)];
  if (!value) throw new Error('资料中没有对应的叠层配方');
  return [...value] as Vec3;
}
export function recipes(direction: Orientation, depth: number): Recipe[] {
  if (!Number.isInteger(depth) || depth < 1 || depth > maxRecipeLayers)
    throw new Error('配色层数超出资料范围');
  const output: Recipe[] = [];
  for (let level = 0; level < depth; level++)
    for (const color of opaqueColors) {
      const keys = [color.key, ...Array(level).fill(overlayKey)];
      const rgb = visibleColor(keys, direction);
      output.push({ keys, rgb, lab: rgbLab(rgb), depth: level + 1 });
    }
  return output;
}
export const neutralKeys = catalogData.neutralKeys;
