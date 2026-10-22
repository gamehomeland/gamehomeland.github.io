import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyScene,
  exportSceneBlueprint,
  importSceneBlueprint,
  placeSceneItem,
  editorResources,
  type SceneItem,
} from '../packages/core/src/editor.js';
import { decodeBlueprint, encodeBlueprint, checksum } from '../packages/core/src/codec.js';
import { landBlueprintFrame } from '../packages/core/src/land.js';
import { basementGridPhase, validateBasements } from '../packages/core/src/basement.js';

const single = (key = 'private-565-2', brushId = 84) => ({
  ...emptyScene(),
  landKey: key,
  basements: [{ id: 'room', brushId, x: -3, z: -3, level: 0 }],
});
const native = () =>
  new Uint8Array(
    readFileSync(new URL('./fixtures/native-basement-8m.blueprintx', import.meta.url)),
  );

test('原生整屋样本：完整宅园半尺寸、绘制参数、根平面及六个空挂面', () => {
  const bytes = native(),
    h = new DataView(bytes.buffer, bytes.byteOffset),
    p = decodeBlueprint(bytes);
  assert.deepEqual([h.getFloat32(5, true), h.getFloat32(9, true)], [10600, 10800]);
  assert.deepEqual([h.getUint32(54, true), h.getUint32(58, true)], [848, 864]);
  assert.deepEqual(
    [h.getFloat32(62, true), h.getFloat32(66, true), h.getFloat32(70, true)],
    [108, 5, 106],
  );
  assert.deepEqual([h.getUint32(169, true), h.getUint32(173, true)], [424, 432]);
  assert.equal(p.root.type, 5);
  assert.equal(p.root.children[0].brushId, 114);
  assert.deepEqual(
    p.root.children[0].children.map((n) => [n.type, n.index, n.children.length]),
    Array.from({ length: 6 }, (_, i) => [5, i, 0]),
  );
  const scene = importSceneBlueprint(bytes);
  assert.equal(scene.landKey, 'blueprint:212:216');
  assert.deepEqual(
    scene.basements?.map(({ id, ...c }) => c),
    [{ brushId: 114, x: -9.5, z: -3.5, level: 0 }],
  );
  const roundtrip = decodeBlueprint(exportSceneBlueprint(scene));
  assert.deepEqual(roundtrip.root.children[0].transform, p.root.children[0].transform);
});

test('私宅七区共享完整根平面，分区中心按实际地块坐标换算', () => {
  const offsets = [
    [-78, -88],
    [-78, -32],
    [-22, -52],
    [56, -72],
    [56, 0],
    [56, 72],
    [-50, 56],
  ];
  offsets.forEach((offset, i) => {
    const key = `private-565-${i + 1}`,
      frame = landBlueprintFrame(key);
    assert.deepEqual(frame, { widthM: 212, depthM: 216, offset, privateRoot: true });
    for (const brushId of [74, 82, 83, 84, 113, 114]) {
      const d = single(key, brushId);
      d.basements[0].x = d.basements[0].z = 0;
      const bytes = exportSceneBlueprint(d),
        p = decodeBlueprint(bytes),
        v = new DataView(bytes.buffer);
      assert.deepEqual([v.getFloat32(5, true), v.getFloat32(9, true)], [10600, 10800]);
      assert.deepEqual(p.root.children[0].transform!.slice(5), [
        offset[0] * 100,
        0,
        offset[1] * 100,
      ]);
      const recovered = importSceneBlueprint(bytes, d.name, key);
      assert.equal(recovered.landKey, key);
      assert.equal(recovered.basements![0].x, 0);
      assert.equal(recovered.basements![0].z, 0);
      assert.deepEqual(exportSceneBlueprint(recovered), bytes);
      assert.deepEqual(exportSceneBlueprint(importSceneBlueprint(bytes)), bytes);
    }
  });
});

test('私宅二区：分区内(-12,-12)米换算为宅园(-90,-44)米', () => {
  const d = single(),
    bytes = exportSceneBlueprint(d),
    p = decodeBlueprint(bytes),
    h = new DataView(bytes.buffer);
  assert.deepEqual(p.root.children[0].transform!.slice(5), [-9000, 0, -4400]);
  assert.deepEqual([h.getFloat32(13, true), h.getFloat32(21, true)], [-9200, -4600]);
  assert.equal(p.root.children[0].children.length, 6);
  // 原生空绘制块除浮点负零外与生成结果一致。
  const sample = native();
  for (let i = 46; i < 222; i++) if (i !== 197) assert.equal(bytes[i], sample[i], `offset ${i}`);
});

test('地下家具的局部挂接不重复施加分区偏移；地面家具同步平移', () => {
  const d = single(),
    chair: SceneItem = {
      id: 'chair',
      resourceKey: editorResources.find((r) => r.representId === 19315)!.key,
      detail: 0,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  d.items = [placeSceneItem(chair, d, 'room'), { ...chair, id: 'surface', position: [3, 0, 4] }];
  const bytes = exportSceneBlueprint(d),
    p = decodeBlueprint(bytes),
    r = importSceneBlueprint(bytes, d.name, d.landKey);
  assert.deepEqual(
    p.root.children.find((n) => n.type === 0)!.transform!.slice(5),
    [-7500, 0, -2800],
  );
  for (let i = 0; i < d.items.length; i++)
    d.items[i].position.forEach((v, j) => assert.ok(Math.abs(v - r.items[i].position[j]) < 1e-5));
  const full = importSceneBlueprint(bytes);
  full.items[0].position.forEach((v, j) =>
    assert.ok(Math.abs(v - d.items[0].position[j] - [-78, 0, -32][j]) < 1e-5),
  );
});

test('不静默丢弃原生涂绘数据', () => {
  const bytes = exportSceneBlueprint(single()),
    h = new DataView(bytes.buffer);
  h.setUint32(102, 1, true);
  bytes.set(checksum(bytes.subarray(0, -16)), bytes.length - 16);
  assert.throws(() => importSceneBlueprint(bytes), /涂绘|绘制|植被/);
});

test('旧分区蓝图在明确选择原分区时可修复，不按文件尺寸自动猜分区', () => {
  const d = single('blueprint:56:72'),
    bytes = exportSceneBlueprint(d);
  assert.equal(importSceneBlueprint(bytes).landKey, 'blueprint:56:72');
  const recovered = importSceneBlueprint(bytes, d.name, 'private-565-2');
  assert.equal(recovered.landKey, 'private-565-2');
  assert.equal(recovered.basements![0].x, -3);
  const fixed = exportSceneBlueprint(recovered);
  assert.equal(new DataView(fixed.buffer).getFloat32(5, true), 10600);
});

test('换算后的格点偏移支持连铺，重叠与错位接缝仍拒绝', () => {
  const a = { id: 'a', brushId: 74, x: -19.5, z: -8, level: 0 };
  assert.deepEqual(basementGridPhase([a], 4), [0.5, 0]);
  assert.doesNotThrow(() => validateBasements([a, { ...a, id: 'b', x: -18.5 }]));
  assert.throws(() => validateBasements([a, { ...a, id: 'b', x: -19 }]), /重叠/);
  assert.throws(() => validateBasements([a, { ...a, id: 'b', x: -18.5, z: -7.5 }]), /对齐/);
});
