import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inspectWholeBlueprint,
  mergeWholeBlueprint,
} from '../packages/core/src/blueprint-merge.js';
import { emptyScene, exportSceneBlueprint, scenePackage } from '../packages/core/src/editor.js';
import { checksum, decodeBlueprint } from '../packages/core/src/codec.js';
import { unzipSync, strFromU8 } from 'fflate';

const base = () =>
  new Uint8Array(
    readFileSync(new URL('./fixtures/native-basement-8m.blueprintx', import.meta.url)),
  );
const addition = () => ({
  ...emptyScene(),
  landKey: 'private-565-2',
  basements: [{ id: 'new', brushId: 84, x: -3, z: -3, level: 0 }],
});

test('追加地下室保留原节点全部字节、根坐标、绘制块和输入文件', () => {
  const original = base(),
    backup = original.slice(),
    out = mergeWholeBlueprint(original, exportSceneBlueprint(addition()));
  assert.deepEqual(original, backup);
  assert.deepEqual(out.subarray(46, 225), original.subarray(46, 225));
  assert.deepEqual(out.subarray(227, 259), original.subarray(227, 259));
  assert.deepEqual(out.subarray(259, original.length - 16), original.subarray(259, -16));
  const view = new DataView(out.buffer),
    parsed = decodeBlueprint(out);
  assert.equal(parsed.root.children.length, 2);
  assert.deepEqual(
    parsed.root.children.map((n) => n.instanceId),
    [319, 320],
  );
  assert.equal(view.getUint32(37, true), 321);
  assert.deepEqual(parsed.root.children[1].transform!.slice(5), [-9000, 0, -4400]);
  assert.deepEqual(inspectWholeBlueprint(out), {
    widthM: 212,
    depthM: 216,
    objectCount: 2,
    basementCount: 2,
  });
});

test('重复追加、原房间重叠/相连、范围不匹配和校验破损明确拒绝', () => {
  const delta = exportSceneBlueprint(addition()),
    merged = mergeWholeBlueprint(base(), delta);
  assert.throws(() => mergeWholeBlueprint(merged, delta), /重叠|相连/);
  const near = addition();
  near.basements[0].x = 0;
  near.basements[0].z = 1;
  assert.throws(() => mergeWholeBlueprint(base(), exportSceneBlueprint(near)), /重叠|相连/);
  near.landKey = 'size-1280';
  assert.throws(() => mergeWholeBlueprint(base(), exportSceneBlueprint(near)), /范围不一致/);
  const broken = base();
  broken[20] ^= 1;
  assert.throws(() => inspectWholeBlueprint(broken), /校验/);
});

test('Node Buffer及非零byteOffset输入不会被原地改写', () => {
  const original = Buffer.from(base()),
    originalCopy = Buffer.from(original);
  const raw = exportSceneBlueprint(addition()),
    padded = Buffer.alloc(raw.length + 31);
  padded.set(raw, 13);
  const delta = padded.subarray(13, 13 + raw.length),
    deltaCopy = Buffer.from(delta);
  const output = mergeWholeBlueprint(original, delta);
  assert.equal(inspectWholeBlueprint(output).basementCount, 2);
  assert.deepEqual(original, originalCopy);
  assert.deepEqual(delta, deltaCopy);
});

test('完整包保存原始整屋，新增工程和清单不冒充原有全部家具', () => {
  const original = base(),
    files = unzipSync(scenePackage(addition(), original));
  assert.deepEqual(files['原始整屋.blueprintx'], original);
  assert.equal(inspectWholeBlueprint(files['家园布置.blueprintx']).basementCount, 2);
  assert.match(strFromU8(files['家具清单.txt']), /新增家具清单/);
  assert.match(strFromU8(files['使用说明.txt']), /只记录新增部分/);
  assert.equal(JSON.parse(strFromU8(files['布置工程.homeland.json'])).basements.length, 1);
});

test('动态长度的绘制数据以原字节保留，不经过当前编辑器的空绘制编码器', () => {
  // 验证结构遍历和字节保留；不把这份人工负载当作游戏可导入样本。
  const original = base(),
    payload = new Uint8Array(original.length + 7),
    blob = Uint8Array.of(21, 32, 43, 54, 65, 76, 87);
  payload.set(original.subarray(0, 123));
  payload.set(blob, 123);
  payload.set(original.subarray(123), 130);
  const v = new DataView(payload.buffer);
  v.setUint32(102, 47, true);
  v.setUint32(106, 200, true);
  v.setUint32(114, blob.length, true);
  payload.set(checksum(payload.subarray(0, -16)), payload.length - 16);
  const merged = mergeWholeBlueprint(payload, exportSceneBlueprint(addition()));
  assert.deepEqual(merged.subarray(46, 222 + 7), payload.subarray(46, 222 + 7));
  assert.deepEqual(merged.subarray(259 + 7, payload.length - 16), payload.subarray(259 + 7, -16));
});

test('灯光未命名参数、分组标签、非等比家具和植被网格均原样保留', () => {
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const f32 = (...values: number[]) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeFloatLE(v, i * 4));
    return b;
  };
  const transform = f32(1, 0, 0, 0, 1, 0, 0, 0);
  const lightBody = Buffer.concat([
    u32(0xabc),
    u32(1),
    Buffer.alloc(184, 0x52),
    Buffer.from('mat\0mask\0'),
    u16(0),
    transform,
  ]);
  const light = Buffer.concat([Buffer.from([4]), u16(lightBody.length + 3), lightBody]);
  const model = Buffer.concat([
    Buffer.from([0]),
    u32(0),
    u32(3),
    u32(21276),
    Buffer.from([0, 0]),
    u16(0),
    f32(0.25, 0.5, 0.25, 0, 0, 0, 1, 10, 20, 30),
  ]);
  const group = Buffer.concat([
    Buffer.from([2]),
    u32(0x100),
    u32(2),
    u32(0xffffffff),
    Buffer.from([0, 0, 1]),
    u32(17),
    u16(1),
    transform,
    model,
  ]);
  const prefix = Buffer.from(base().subarray(0, 222));
  prefix.writeUInt32LE(6, 37);
  prefix.writeUInt32LE(2, 169);
  prefix.writeUInt32LE(2, 173);
  prefix[177] = 1;
  prefix.writeUInt32LE(4, 178);
  const foliage = Buffer.alloc(328);
  foliage.writeUInt32LE(77, 0);
  foliage.set([0, 91, 0, 52, 0, 14, 0, 75], 320);
  const root = Buffer.concat([Buffer.from([5]), u16(0), u16(2), transform]);
  const originalBody = Buffer.concat([prefix, foliage, root, light, group]);
  const original = Buffer.concat([originalBody, checksum(originalBody)]);
  assert.equal(inspectWholeBlueprint(original).objectCount, 3);
  const merged = mergeWholeBlueprint(original, exportSceneBlueprint(addition()));
  const rootStart = prefix.length + foliage.length,
    childrenStart = rootStart + root.length;
  assert.deepEqual(
    merged.subarray(46, rootStart),
    new Uint8Array(original.subarray(46, rootStart)),
  );
  assert.deepEqual(
    merged.subarray(childrenStart, original.length - 16),
    new Uint8Array(original.subarray(childrenStart, -16)),
  );
  assert.equal(inspectWholeBlueprint(merged).objectCount, 4);
});
