import type {
  ExportOptions,
  RawImage,
  ExportResult,
  ProgressCallback,
  Recipe,
  Tile,
  MaterialItem,
} from './types.js';
import { prepareImage, validateOptions } from './image.js';
import { recipes, visibleColor, support, neutralKeys, maxRecipeLayers } from './catalog.js';
import { rgbLab } from './math.js';
import { matchColors, scoreColors, refineSpatial } from './color.js';
import {
  makePlan,
  buildNative,
  readNative,
  microTiles,
  buildMicro,
  readMicro,
  verifyVisibility,
} from './layout.js';
import { supportCount } from './component.js';
import { decodeBlueprint, encodeBlueprint } from './codec.js';
import { applyExperimentalMaterials } from './experimental.js';

function planRecipes(
  indices: Uint16Array,
  all: Recipe[],
  width: number,
  height: number,
  cell: number,
): Tile[] {
  const tiles: Tile[] = [];
  const depth = indices.reduce((n, index) => Math.max(n, all[index].depth), 1);
  for (let layer = 0; layer < depth; layer++) {
    const keys = Array.from(indices, (index) => all[index].keys[layer] ?? null);
    if (!keys.some((x) => x !== null)) continue;
    const rows = makePlan(keys, width, height, cell, layer === 0);
    rows.forEach((tile) => (tile.layer = layer));
    tiles.push(...rows);
  }
  return tiles;
}
function previewTiles(
  tiles: Tile[],
  width: number,
  height: number,
  direction: 'wall' | 'ground',
): RawImage {
  const stacks: string[][] = Array.from({ length: width * height }, () => []);
  for (const tile of [...tiles].sort((a, b) => a.layer - b.layer))
    for (let y = tile.y; y < tile.y + tile.side; y++)
      for (let x = tile.x; x < tile.x + tile.side; x++) stacks[y * width + x].push(tile.key);
  const rgba = new Uint8Array(width * height * 4),
    cache = new Map<string, number[]>();
  for (let i = 0; i < stacks.length; i++) {
    if (!stacks[i].length) throw new Error('回读图案存在空缺');
    const name = JSON.stringify(stacks[i]);
    let rgb = cache.get(name);
    if (!rgb) {
      rgb = visibleColor(stacks[i], direction);
      cache.set(name, rgb);
    }
    rgba.set([...rgb, 255], i * 4);
  }
  return { width, height, rgba };
}
export function exportImage(
  source: RawImage,
  input: ExportOptions,
  progress?: ProgressCallback,
): ExportResult {
  const options = validateOptions(input),
    direction = options.orientation;
  const finalProgress = progress;
  if (options.experimentalMaterials)
    progress = (event) => {
      if (event.stage === 'sample') finalProgress?.(event);
      else if (event.stage === 'color')
        finalProgress?.({ stage: 'color', fraction: event.fraction * 0.45 });
      else if (event.stage === 'layout') finalProgress?.({ stage: 'color', fraction: 0.5 });
      else if (event.stage === 'verify')
        finalProgress?.({ stage: 'color', fraction: 0.5 + 0.18 * event.fraction });
    };
  progress?.({ stage: 'sample', fraction: 0 });
  const prepared = prepareImage(source, options);
  const { image, layout, cellM, physicalEdgeM, profile } = prepared,
    width = image.width,
    height = image.height;
  const all = recipes(
    direction,
    layout === 'miniature' || profile.kind === 'pixel' ? 1 : maxRecipeLayers,
  );
  type Candidate = {
    indices: Uint16Array;
    tiles?: Tile[];
    count: number;
    score: number;
    grain: number;
  };
  const candidates: Candidate[] = [],
    seen = new Set<string>();
  const lightness = Array.from(
    { length: width * height },
    (_, i) => rgbLab(image.rgba.subarray(i * 4, i * 4 + 3))[0],
  ).sort((a, b) => a - b);
  const rangeFit =
    layout === 'miniature' ||
    (profile.kind !== 'pixel' &&
      lightness[Math.floor((lightness.length - 1) * 0.99)] >
        rgbLab(visibleColor([neutralKeys.white], direction))[0] + 3);
  const fittedOptions = profile.kind === 'pixel' || !rangeFit ? [false] : [false, true];
  for (const [pass, fit] of fittedOptions.entries()) {
    const matched = matchColors(image, all, direction, fit, (fraction) =>
      progress?.({ stage: 'color', fraction: (pass + fraction) / fittedOptions.length }),
    );
    const add = (indices: Uint16Array, spatial = false): void => {
      const signature = indices.join(',');
      if (seen.has(signature)) return;
      seen.add(signature);
      const quality = scoreColors(matched.source, indices, all, width, height, direction, rangeFit);
      if (spatial && quality.grain > 2) return;
      const tiles =
        layout === 'native' ? planRecipes(indices, all, width, height, cellM) : undefined;
      const count = tiles
        ? tiles.length + supportCount(tiles.length)
        : width * height + supportCount(width * height);
      if (count <= options.maxFurniture) candidates.push({ indices, tiles, count, ...quality });
    };
    for (const choice of matched.choices) add(choice);
    add(matched.opaque);
    if (layout === 'native' && (profile.kind === 'photo' || profile.kind === 'soft'))
      for (const choice of matched.choices.slice(0, 2))
        add(refineSpatial(matched.target, choice, matched.alternatives, all, width, height), true);
  }
  if (!candidates.length) throw new Error('当前图片超出家具预算，请增大尺寸或使用更简洁的图片');
  const bestScore = Math.min(...candidates.map((c) => c.score));
  const chosen = candidates
    .filter((c) => c.score <= bestScore + 0.03)
    .sort((a, b) => a.count - b.count || a.score - b.score)[0];
  progress?.({ stage: 'layout', fraction: 0 });
  let blueprint: Uint8Array,
    tiles: Tile[],
    preview: RawImage,
    visibilitySamples = 0;
  if (layout === 'native') {
    const planned = chosen.tiles!;
    blueprint = buildNative(planned, width, height, cellM, direction, options.showRootHandle);
    progress?.({ stage: 'verify', fraction: 0.05 });
    tiles = readNative(blueprint, width, height, cellM, direction);
    if (
      tiles.length !== planned.length ||
      tiles.some((t, i) =>
        ['x', 'y', 'side', 'layer', 'key'].some(
          (k) => t[k as keyof Tile] !== planned[i][k as keyof Tile],
        ),
      )
    )
      throw new Error('蓝图回读与家具计划不一致');
    preview = previewTiles(tiles, width, height, direction);
  } else {
    const keys = Array.from(chosen.indices, (i) => all[i].keys[0]),
      planned = microTiles(keys, width, height, physicalEdgeM);
    blueprint = buildMicro(
      planned,
      width,
      height,
      cellM,
      direction,
      physicalEdgeM,
      options.showRootHandle,
    );
    progress?.({ stage: 'verify', fraction: 0 });
    const geometry = readMicro(blueprint, width, height, cellM, direction, physicalEdgeM);
    tiles = geometry.pieces.map((p) => p.tile);
    if (tiles.some((t, i) => t.key !== keys[i])) throw new Error('微缩颜色回读不一致');
    visibilitySamples = verifyVisibility(geometry, width, height, cellM, direction, (fraction) =>
      progress?.({ stage: 'verify', fraction }),
    );
    const rgba = new Uint8Array(width * height * 4);
    tiles.forEach((t, i) => rgba.set([...visibleColor([t.key], direction), 255], i * 4));
    preview = { width, height, rgba };
  }
  const reencoded = encodeBlueprint(decodeBlueprint(blueprint));
  if (reencoded.length !== blueprint.length || reencoded.some((b, i) => b !== blueprint[i]))
    throw new Error('蓝图字节校验未通过');
  const counts = new Map<number, MaterialItem>();
  for (const tile of tiles) {
    const old = counts.get(tile.variant.furnitureId);
    if (old) old.count++;
    else
      counts.set(tile.variant.furnitureId, {
        id: tile.variant.furnitureId,
        name: tile.variant.name,
        count: 1,
        kind: 'cloth',
      });
  }
  const bases = supportCount(tiles.length),
    materials = [...counts.values()].sort((a, b) => b.count - a.count || a.id - b.id);
  materials.push({
    id: support.furnitureId,
    name: support.name.replace('（挂接）', ''),
    count: bases,
    kind: 'support',
  });
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const result: ExportResult = {
    blueprint,
    preview,
    materials,
    summary: {
      widthM: round(width * cellM),
      heightM: round(height * cellM),
      gridWidth: width,
      gridHeight: height,
      orientation: direction,
      layout,
      clothCount: tiles.length,
      supportCount: bases,
      totalCount: tiles.length + bases,
      visibleLayers: tiles.reduce((n, t) => Math.max(n, t.layer + 1), 1),
      showRootHandle: options.showRootHandle,
      backgroundFilled: prepared.backgroundFilled,
      canvasPadded: prepared.canvasPadded,
    },
    verification: { roundTrip: true, geometry: true, visibilitySamples, gameImportVerified: false },
  };
  if (result.summary.totalCount > options.maxFurniture) throw new Error('文件中家具数量超过预算');
  if (options.experimentalMaterials) {
    const trial = applyExperimentalMaterials(result, prepared, options, (event) => {
      if (event.stage !== 'done') finalProgress?.(event);
    });
    if (!trial.summary.glassCount && options.experimentalSelection === 'improve') {
      // 扩展材质没有获益时恢复完整的基础方案，不为对齐玻璃而降低默认网格。
      const original = exportImage(source, {
        ...input,
        experimentalMaterials: false,
        experimentalSelection: undefined,
      });
      original.summary.paletteMode = 'experimental-glass';
      original.summary.glassCount = 0;
      original.experimental = { ...trial.experimental!, outputUsesOriginalLayout: true };
      original.verification.overlaySamples = 0;
      original.verification.gameColorVerified = false;
      finalProgress?.({ stage: 'done', fraction: 1 });
      return original;
    }
    finalProgress?.({ stage: 'done', fraction: 1 });
    return trial;
  }
  progress?.({ stage: 'done', fraction: 1 });
  return result;
}
