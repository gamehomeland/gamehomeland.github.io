import {
  Group,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  DoubleSide,
  LineSegments,
  LineBasicMaterial,
  EdgesGeometry,
} from 'three';
import {
  basementById,
  basementMasks,
  basementPosition,
  basementSize,
  basementVariant,
  type BasementCell,
} from '../../../packages/core/src/basement.js';

/** 地下室模型与结构占位；尺寸、开口与导出掩码同源，不包含地形碰撞。 */
export function basementDisplay(
  cells: BasementCell[],
  sliceY?: number,
  model?: (brushId: number, index: number) => import('three').Object3D | undefined,
  savedMasks?: ReadonlyMap<string, number>,
): Group {
  const root = new Group(),
    masks = savedMasks ?? basementMasks(cells);
  for (const c of cells) {
    const s = basementSize(c),
      [x, y, z] = basementPosition(c),
      h = s / 2,
      mask = masks.get(c.id)!;
    if (sliceY !== undefined && (y > sliceY + 0.001 || y - s < sliceY - s - 0.001)) continue;
    const group = new Group();
    group.position.set(x, y, z);
    group.userData.basementId = c.id;
    const variant = basementVariant(mask),
      native = model?.(c.brushId, variant.index);
    if (native) {
      group.userData.nativeBasement = true;
      if (variant.index !== 0) {
        native.rotation.y = (variant.rotation * Math.PI) / 180;
        group.add(native);
      }
      root.add(group);
      continue;
    }
    const quads = [
      [
        [-h, 0, h],
        [h, 0, h],
        [h, -s, h],
        [-h, -s, h],
      ],
      [
        [h, 0, h],
        [h, 0, -h],
        [h, -s, -h],
        [h, -s, h],
      ],
      [
        [h, 0, -h],
        [-h, 0, -h],
        [-h, -s, -h],
        [h, -s, -h],
      ],
      [
        [-h, 0, -h],
        [-h, 0, h],
        [-h, -s, h],
        [-h, -s, -h],
      ],
      [
        [-h, -s, -h],
        [-h, -s, h],
        [h, -s, h],
        [h, -s, -h],
      ],
      [
        [-h, 0, h],
        [-h, 0, -h],
        [h, 0, -h],
        [h, 0, h],
      ],
    ];
    const positions: number[] = [];
    for (let face = 0; face < 6; face++) {
      if (mask & (1 << face) || (face === 5 && (mask & 64 || sliceY !== undefined))) continue;
      for (const i of [0, 1, 2, 0, 2, 3]) positions.push(...quads[face][i]);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    group.add(
      new Mesh(
        geo,
        new MeshStandardMaterial({
          color: basementById.get(c.brushId)!.color,
          roughness: 0.9,
          side: DoubleSide,
        }),
      ),
    );
    group.add(
      new LineSegments(
        new EdgesGeometry(geo),
        new LineBasicMaterial({ color: 0x685c62, transparent: true, opacity: 0.5 }),
      ),
    );
    root.add(group);
  }
  return root;
}
