import { opaqueColors, support } from './catalog.js';
import { readMicro } from './layout.js';
import { colorCost, deltaE2, rgbLab } from './math.js';
import { fitMaterial, scoreColors } from './color.js';
import { structureCost } from './budget.js';
import { encodeBlueprint, decodeBlueprint } from './codec.js';
import {
  glassMaterials,
  placeGlass,
  glassCoverage,
  sampleCount,
  buildGlassBlueprint,
  readGlassBlueprint,
  renderGlassBlueprint,
  COVERAGE_SAMPLES,
  type GlassPlacement,
  type GlassFrame,
} from './glass.js';
import type {
  ExportResult,
  MaterialItem,
  ProgressCallback,
  RawImage,
  Recipe,
  Vec3,
} from './types.js';
import type { PreparedImage, ValidatedOptions } from './image.js';

interface Plan {
  placement: GlassPlacement;
  coverage: Map<number, number>;
  picks: Map<number, number>;
  gain: number;
  area: number;
}

export function averageColorError(source: RawImage, preview: RawImage): number {
  const scale = preview.width / source.width;
  if (!Number.isInteger(scale) || preview.height !== source.height * scale)
    throw new Error('试验对照尺寸不同');
  let error = 0;
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const rgb: Vec3 = [0, 0, 0];
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++)
          for (let c = 0; c < 3; c++)
            rgb[c] +=
              preview.rgba[((y * scale + dy) * preview.width + x * scale + dx) * 4 + c] /
              (scale * scale);
      error += Math.sqrt(
        deltaE2(
          rgbLab(source.rgba.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 3)),
          rgbLab(rgb),
        ),
      );
    }
  return error / (source.width * source.height);
}

export function applyExperimentalMaterials(
  baseline: ExportResult,
  prepared: PreparedImage,
  options: ValidatedOptions,
  progress?: ProgressCallback,
): ExportResult {
  if (options.orientation !== 'wall' || prepared.layout !== 'miniature')
    throw new Error('试验扩色目前用于高精度墙面画，请选择墙面并保留足够家具数量');
  const { width, height } = prepared.image,
    pitch = prepared.cellM,
    count = width * height;
  const perBlock = 0.5 / pitch;
  if (Math.abs(perBlock - Math.round(perBlock)) > 1e-6)
    throw new Error('试验网格没有与琉璃尺寸对齐');
  const before = readMicro(
    baseline.blueprint,
    width,
    height,
    pitch,
    'wall',
    prepared.physicalEdgeM,
  );
  const frame: GlassFrame = {
    width,
    height,
    pitch,
    edgeM: prepared.physicalEdgeM,
    floor: before.floor,
    front: before.min[2] - 0.03,
  };
  const originalKeys = before.pieces.map((p) => p.tile.key);
  const baseIndex = new Map(opaqueColors.map((c, i) => [c.key, i]));
  const baseIndices = Uint16Array.from(originalKeys, (key) => baseIndex.get(key)!);
  const recipes: Recipe[] = opaqueColors.map((c) => ({
    keys: [c.key],
    rgb: c.rgb,
    lab: rgbLab(c.rgb),
    depth: 1,
  }));
  const n = opaqueColors.length;
  for (const material of glassMaterials) {
    const byBase = new Map(material.recipes.map((r) => [r.base, r.rgb]));
    for (let covered = 1; covered <= COVERAGE_SAMPLES; covered++)
      for (const base of opaqueColors) {
        const rgb = base.rgb.map(
          (value, c) =>
            value * (1 - covered / COVERAGE_SAMPLES) +
            (byBase.get(base.key)![c] * covered) / COVERAGE_SAMPLES,
        ) as Vec3;
        recipes.push({ keys: [base.key, material.key], rgb, lab: rgbLab(rgb), depth: 2 });
      }
  }
  const recipeIndex = (material: number, covered: number, base: number) =>
    n + (material * COVERAGE_SAMPLES + covered - 1) * n + base;
  const source = Uint8Array.from(
    { length: count * 3 },
    (_, i) => prepared.image.rgba[Math.floor(i / 3) * 4 + (i % 3)],
  );
  const originalScore = scoreColors(source, baseIndices, recipes, width, height, 'wall', true);
  type Trial = {
    plans: Plan[];
    indices: Uint16Array;
    keys: string[];
    score: number;
    grain: number;
  };
  let best: Trial = { plans: [], indices: baseIndices, keys: originalKeys, ...originalScore };
  let bestNew: Trial | undefined;
  const diagnostics: NonNullable<ExportResult['experimental']>['candidates'] = [];
  const rectMaterials = glassMaterials
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.variants[0].footprint.source === 'anchor-bounds');
  const shapedMaterials = glassMaterials
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.variants[0].footprint.source === 'mesh-vertices-indices');
  const columns = Math.floor((width * pitch) / 0.5 + 1e-7),
    rows = Math.floor((height * pitch) / 0.5 + 1e-7);
  const coverageCache = new Map<string, Map<number, number>>();
  let evaluated = 0;
  for (const [pass, fit] of [false, true].entries()) {
    const targets = Array.from({ length: count }, (_, i) => {
      const rgb = [...source.subarray(i * 3, i * 3 + 3)] as Vec3;
      return rgbLab(fit ? fitMaterial(rgb, 'wall') : rgb);
    });
    const oldCosts = targets.map((lab, i) =>
      Math.sqrt(colorCost(lab, recipes[baseIndices[i]].lab)),
    );
    const memo = new Map<string, { base: number; cost: number }>();
    const choose = (material: number, covered: number, pixel: number) => {
      const code = `${material}:${covered}:${source[pixel * 3]},${source[pixel * 3 + 1]},${source[pixel * 3 + 2]}`;
      let value = memo.get(code);
      if (value) return value;
      const target = targets[pixel],
        neutral = Math.hypot(target[1], target[2]) < 3;
      let minimum = Infinity,
        base = 0;
      for (let b = 0; b < n; b++) {
        const lab = recipes[recipeIndex(material, covered, b)].lab;
        if (neutral && Math.hypot(lab[1], lab[2]) > 6) continue;
        const cost = Math.sqrt(colorCost(target, lab));
        if (cost < minimum) {
          minimum = cost;
          base = b;
        }
      }
      value = { base, cost: minimum };
      memo.set(code, value);
      return value;
    };
    const evaluate = (material: number, x: number, y: number): Plan => {
      const placement = placeGlass(material, x, y, frame);
      const cacheKey = `${placement.variant.footprint.source}:${x}:${y}`;
      let coverage = coverageCache.get(cacheKey);
      if (!coverage) {
        coverage = glassCoverage(placement, frame);
        coverageCache.set(cacheKey, coverage);
      }
      const picks = new Map<number, number>();
      let gain = 0,
        area = 0;
      for (const [pixel, mask] of coverage) {
        const covered = sampleCount(mask),
          value = choose(material, covered, pixel);
        picks.set(pixel, value.base);
        gain += oldCosts[pixel] - value.cost;
        area += covered / COVERAGE_SAMPLES;
      }
      evaluated++;
      return { placement, coverage, picks, gain, area };
    };
    const rectangles = new Map<number, Plan>();
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        let selected: Plan | undefined;
        for (const { i } of rectMaterials) {
          const plan = evaluate(i, (column + 0.5) * 0.5, (row + 0.5) * 0.5);
          if (plan.gain > plan.area * 0.12 && (!selected || plan.gain > selected.gain))
            selected = plan;
        }
        if (selected) rectangles.set(row * columns + column, selected);
        if (column === columns - 1)
          progress?.({ stage: 'color', fraction: 0.7 + (pass + (row + 1) / rows) * 0.12 });
      }
    const shaped: Plan[] = [];
    for (let row = 0; row < rows; row++)
      for (let column = 0; column + 4 <= columns; column += 4) {
        const alternative = Array.from({ length: 4 }, (_, i) =>
          rectangles.get(row * columns + column + i),
        );
        const oldGain = alternative.reduce((sum, p) => sum + (p?.gain ?? 0), 0);
        let selected: Plan | undefined;
        for (const { i } of shapedMaterials) {
          const plan = evaluate(i, (column + 2) * 0.5, (row + 0.5) * 0.5);
          if (plan.gain > oldGain + plan.area * 0.12 && (!selected || plan.gain > selected.gain))
            selected = plan;
        }
        if (selected) {
          for (let i = 0; i < 4; i++) rectangles.delete(row * columns + column + i);
          shaped.push(selected);
        }
      }
    const proposed = [...rectangles.values(), ...shaped].sort((a, b) => b.gain - a.gain);
    const budgeted: Plan[] = [];
    for (const plan of proposed) {
      if (structureCost(count + budgeted.length + 1).furniture > options.maxFurniture) break;
      budgeted.push(plan);
    }
    // 同时看色差与块状/边缘误差。新材料没有改善时保留原图方案。
    for (const fraction of [1, 0.75, 0.5]) {
      const plans = budgeted.slice(0, Math.ceil(budgeted.length * fraction));
      if (!plans.length) continue;
      const keys = [...originalKeys],
        indices = baseIndices.slice(),
        occupied = new Uint8Array(count);
      for (const plan of plans)
        for (const [pixel, mask] of plan.coverage) {
          if (occupied[pixel]) throw new Error('分区边界未对齐，底色会被多个透明片共同影响');
          occupied[pixel] = 1;
          const base = plan.picks.get(pixel)!;
          keys[pixel] = opaqueColors[base].key;
          indices[pixel] = recipeIndex(plan.placement.material, sampleCount(mask), base);
        }
      const quality = scoreColors(source, indices, recipes, width, height, 'wall', true);
      diagnostics.push({ fit, overlays: plans.length, ...quality });
      if (!bestNew || quality.score < bestNew.score) bestNew = { plans, indices, keys, ...quality };
      if (quality.grain > originalScore.grain + 0.25) continue;
      if (
        quality.score < best.score - 0.005 ||
        (Math.abs(quality.score - best.score) < 1e-8 && plans.length < best.plans.length)
      )
        best = { plans, indices, keys, ...quality };
    }
  }
  if (options.experimentalSelection === 'candidate' && bestNew) best = bestNew;
  progress?.({ stage: 'layout', fraction: 0 });
  const placements = best.plans.map((p) => p.placement);
  const blueprint = buildGlassBlueprint(best.keys, frame, placements, options.showRootHandle);
  const readback = readGlassBlueprint(blueprint, frame);
  if (
    readback.keys.some((k, i) => k !== best.keys[i]) ||
    readback.overlays.length !== placements.length
  )
    throw new Error('试验配色与实际蓝图不一致');
  readback.overlays.forEach((p, i) => {
    const planned = placements[i];
    if (
      p.variant.representId !== planned.variant.representId ||
      p.center.some((v, j) => Math.abs(v - planned.center[j]) > 2e-5)
    )
      throw new Error('试验透明材料回读不一致');
  });
  const rendered = renderGlassBlueprint(readback, frame, (fraction) =>
    progress?.({ stage: 'verify', fraction }),
  );
  const check = encodeBlueprint(decodeBlueprint(blueprint));
  if (check.length !== blueprint.length || check.some((v, i) => v !== blueprint[i]))
    throw new Error('试验蓝图字节往返不一致');
  const counts = new Map<number, MaterialItem>();
  const add = (id: number, name: string, kind: MaterialItem['kind']) => {
    const old = counts.get(id);
    if (old) old.count++;
    else counts.set(id, { id, name, kind, count: 1 });
  };
  for (const piece of readback.geometry.pieces)
    add(piece.tile.variant.furnitureId, piece.tile.variant.name, 'cloth');
  for (const overlay of readback.overlays)
    add(overlay.variant.furnitureId, overlay.variant.name, 'glass');
  const materials = [...counts.values()].sort((a, b) => b.count - a.count || a.id - b.id);
  materials.push({
    id: support.furnitureId,
    name: support.name.replace('（挂接）', ''),
    kind: 'support',
    count: readback.bases,
  });
  const result: ExportResult = {
    blueprint,
    preview: rendered.image,
    materials,
    summary: {
      ...baseline.summary,
      paletteMode: 'experimental-glass',
      glassCount: placements.length,
      supportCount: readback.bases,
      totalCount: count + placements.length + readback.bases,
      visibleLayers: placements.length ? 2 : 1,
    },
    verification: {
      roundTrip: true,
      geometry: true,
      visibilitySamples: rendered.samples,
      overlaySamples: rendered.coveredSamples,
      gameImportVerified: false,
      gameColorVerified: false,
    },
    experimental: {
      materialsConsidered: glassMaterials.length,
      candidatesEvaluated: evaluated,
      selectedMaterials: [...new Set(placements.map((p) => glassMaterials[p.material].key))],
      averageDeltaEBefore: averageColorError(prepared.image, baseline.preview),
      averageDeltaEAfter: averageColorError(prepared.image, rendered.image),
      qualityBefore: originalScore.score,
      qualityAfter: best.score,
      recommended:
        best.score < originalScore.score - 0.005 && best.grain <= originalScore.grain + 0.25,
      candidates: diagnostics,
      previewModel: 'neutral-material-mean-front-view',
      gameColorVerified: false,
      comparisonGrid: [width, height],
      outputUsesOriginalLayout: false,
    },
  };
  if (result.summary.totalCount > options.maxFurniture) throw new Error('试验材料超过家具预算');
  progress?.({ stage: 'done', fraction: 1 });
  return result;
}
