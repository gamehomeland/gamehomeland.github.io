import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { ModelAsset, modelViewDistance } from '../apps/web/src/model-assets.js';
import { editorResources, editorResourceByHash } from '../packages/core/src/editor.js';

test('同源灰模与材质模型哈希映射到相同游戏资源', () => {
  assert.ok(editorResources.filter((r) => r.modelSha256Aliases?.length).length >= 35);
  for (const resource of editorResources) {
    assert.equal(editorResourceByHash.get(resource.modelSha256), resource);
    // 新加入的资源可以没有历史灰模；既有别名仍须指向原资源。
    for (const hash of resource.modelSha256Aliases ?? [])
      assert.equal(editorResourceByHash.get(hash), resource);
    for (const detail of resource.details)
      assert.ok(resource.detailNames?.[detail] || resource.details.length === 1);
  }
});

test('各实例独立切换材质，快速切换只采用最后一次结果', async () => {
  const base = new MeshStandardMaterial(),
    red = new MeshStandardMaterial({ color: 'red' }),
    blue = new MeshStandardMaterial({ color: 'blue' });
  const mesh = new Mesh(new BoxGeometry(), base),
    root = new Group();
  root.add(mesh);
  let resolveRed!: (material: MeshStandardMaterial) => void;
  const redPromise = new Promise<MeshStandardMaterial>((resolve) => {
    resolveRed = resolve;
  });
  const parser = {
    json: {
      materials: [{}, {}, {}],
      meshes: [
        {
          primitives: [
            {
              material: 0,
              extensions: {
                KHR_materials_variants: {
                  mappings: [
                    { material: 1, variants: [1] },
                    { material: 2, variants: [2] },
                  ],
                },
              },
            },
          ],
        },
      ],
      extensions: {
        KHR_materials_variants: { variants: [{ name: '原色' }, { name: '红' }, { name: '蓝' }] },
      },
    },
    associations: new Map([[mesh, { meshes: 0, primitives: 0 }]]),
    getDependency: (_type: string, id: number) =>
      id === 1 ? redPromise : Promise.resolve(id === 2 ? blue : base),
    assignFinalMaterial: () => {},
  };
  const asset = new ModelAsset({ scene: root, parser } as any),
    first = asset.clone(),
    second = asset.clone();
  const earlier = asset.apply(first, 1);
  await asset.apply(first, 2);
  resolveRed(red);
  await earlier;
  await asset.apply(second, 1);
  assert.equal((first.children[0] as Mesh).material, blue);
  assert.equal((second.children[0] as Mesh).material, red);
  assert.equal(mesh.material, base);
  asset.dispose();
});

test('横长家具按屏幕投影取景，所有角点均留在画面内', () => {
  const box = new Box3(new Vector3(-4, 0, -1), new Vector3(4, 1, 1)),
    direction = new Vector3(1, 0.65, 1.25).normalize(),
    up = new Vector3(0, 1, 0),
    aspect = 3;
  const d = modelViewDistance(box, direction, up, 35, aspect),
    center = box.getCenter(new Vector3()),
    right = new Vector3().crossVectors(up, direction).normalize(),
    vertical = new Vector3().crossVectors(direction, right);
  assert.ok(d > 0 && d < 15);
  for (const x of [-4, 4])
    for (const y of [0, 1])
      for (const z of [-1, 1]) {
        const v = new Vector3(x, y, z).sub(center),
          depth = d - v.dot(direction),
          t = Math.tan((35 * Math.PI) / 360);
        assert.ok(depth > 0);
        assert.ok(Math.abs(v.dot(right)) < depth * t * aspect);
        assert.ok(Math.abs(v.dot(vertical)) < depth * t);
      }
});
