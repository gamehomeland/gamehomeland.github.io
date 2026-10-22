import { decodeBlueprint } from './codec.js';
import { placedNodes, undoImport } from './component.js';
import { support, variantById } from './catalog.js';
import { glassByResource, glassMaterials } from './glass.js';
import { rotate } from './math.js';
import type { ExportResult, Vec3 } from './types.js';

export interface PreviewBatch {
  resourceId: number;
  name: string;
  kind: 'cloth' | 'support' | 'glass';
  /** 每实例：米制位置 XYZ、旋转 XYZW、实体尺寸/几何缩放 XYZ。 */
  transforms: Float32Array;
  instanceIds: Uint32Array;
  rgb: Vec3;
  opacity: number;
  /** 琉璃上表面的已核对轮廓；不代表完整材质或体积模型。 */
  triangles?: Float32Array;
}
export interface BlueprintScene {
  batches: PreviewBatch[];
  bounds: { min: Vec3; max: Vec3 };
  front: Vec3;
  up: Vec3;
  count: { cloth: number; support: number; glass: number; total: number };
  orientation: 'wall' | 'ground';
}

/** 本导出器的组件查看适配层。只读真实文件，不重新排布、不写回。 */
export function readPreviewScene(
  bytes: Uint8Array,
  summary: ExportResult['summary'],
): BlueprintScene {
  if (
    !['wall', 'ground'].includes(summary.orientation) ||
    !['native', 'miniature'].includes(summary.layout)
  )
    throw new Error('预览缺少有效的摆放方式');
  const parsed = decodeBlueprint(bytes);
  if (parsed.global || parsed.root.type !== 8) throw new Error('3D 预览仅支持本工具生成的局部组件');
  undoImport(parsed.root, summary.orientation, summary.layout === 'miniature');
  const batches = new Map<
    number,
    {
      info: Omit<PreviewBatch, 'transforms' | 'instanceIds'>;
      transforms: number[];
      ids: number[];
    }
  >();
  const ids = new Set<number>();
  const count = { cloth: 0, support: 0, glass: 0, total: 0 };
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { node, position, rotation } of placedNodes(parsed.root)) {
    if (node.instanceId !== undefined) {
      if (ids.has(node.instanceId)) throw new Error('家具实例编号重复');
      ids.add(node.instanceId);
    }
    if ([5, 8].includes(node.type)) continue;
    if (node.type === 3 && node.representId === support.representId) continue;
    if (node.type !== 0 || !node.transform || node.instanceId === undefined)
      throw new Error('预览中存在不支持的家具节点');
    const id = node.representId!,
      scale = node.transform[0];
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(Math.hypot(...rotation) - 1) > 1e-4)
      throw new Error('家具变换无效');
    const cloth = variantById.get(id),
      glass = glassByResource.get(id);
    let info: Omit<PreviewBatch, 'transforms' | 'instanceIds'>;
    let size: Vec3, low: Vec3, high: Vec3;
    if (cloth) {
      const { color, variant } = cloth;
      if (scale < variant.minScale - 1e-5 || scale > variant.maxScale + 1e-5)
        throw new Error('家具缩放超出已核对范围');
      info = {
        resourceId: id,
        name: variant.name,
        kind: 'cloth',
        rgb: color.rgb,
        opacity: color.alpha,
      };
      size = [variant.sizeM * scale, (2 * variant.surfaceY * scale) / 100, variant.sizeM * scale];
      low = size.map((v) => -v / 2) as Vec3;
      high = size.map((v) => v / 2) as Vec3;
    } else if (id === support.meshRepresentId && node.builtin === 1) {
      // 定位标记，不冒充基座的完整模型；位置与朝向来自内建模型节点。
      info = {
        resourceId: id,
        name: '挂接基座（位置示意）',
        kind: 'support',
        rgb: [196, 100, 131],
        opacity: 1,
      };
      size = [0.12, 0.12, 0.12];
      low = [-0.06, -0.06, -0.06];
      high = [0.06, 0.06, 0.06];
    } else if (glass) {
      const { variant, material } = glass;
      if (scale < variant.scaleRange[0] - 1e-5 || scale > variant.scaleRange[1] + 1e-5)
        throw new Error('琉璃缩放超出已核对范围');
      const [lo, hi] = variant.footprint.bounds;
      const points =
        variant.footprint.source === 'mesh-vertices-indices'
          ? variant.footprint.triangles
          : [
              [
                [lo[0], lo[2]],
                [hi[0], lo[2]],
                [hi[0], hi[2]],
              ],
              [
                [lo[0], lo[2]],
                [hi[0], hi[2]],
                [lo[0], hi[2]],
              ],
            ];
      info = {
        resourceId: id,
        name: glassMaterials[material].key,
        kind: 'glass',
        rgb: [139, 175, 198],
        opacity: 0.3,
        triangles: new Float32Array(
          points.flatMap((tri) => tri.flatMap(([x, z]) => [x, hi[1], z])),
        ),
      };
      size = [scale, scale, scale];
      low = lo.map((v) => v * scale) as Vec3;
      high = hi.map((v) => v * scale) as Vec3;
    } else throw new Error(`资源 ${id} 尚无 3D 预览定义`);
    let batch = batches.get(id);
    if (!batch) batches.set(id, (batch = { info, transforms: [], ids: [] }));
    const center = position.map((v) => v / 100) as Vec3;
    batch.transforms.push(...center, ...rotation, ...size);
    batch.ids.push(node.instanceId);
    count[info.kind]++;
    if (info.kind === 'support') continue;
    for (const x of [low[0], high[0]])
      for (const y of [low[1], high[1]])
        for (const z of [low[2], high[2]]) {
          const p = rotate([x, y, z], rotation);
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], p[axis] + center[axis]);
            max[axis] = Math.max(max[axis], p[axis] + center[axis]);
          }
        }
  }
  count.total = count.cloth + count.support + count.glass;
  if (
    !count.cloth ||
    count.cloth !== summary.clothCount ||
    count.support !== summary.supportCount ||
    count.glass !== (summary.glassCount ?? 0) ||
    count.total !== summary.totalCount
  )
    throw new Error('3D 家具数量与导出结果不一致');
  return {
    batches: [...batches.values()].map((b) => ({
      ...b.info,
      transforms: new Float32Array(b.transforms),
      instanceIds: new Uint32Array(b.ids),
    })),
    bounds: { min, max },
    count,
    orientation: summary.orientation,
    front:
      summary.orientation === 'ground'
        ? [0, 1, 0]
        : [0, 0, summary.layout === 'miniature' ? -1 : 1],
    up: summary.orientation === 'ground' ? [0, 0, -1] : [0, 1, 0],
  };
}
