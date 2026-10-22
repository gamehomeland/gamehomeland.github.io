import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectModelFile } from '../apps/web/src/model-file.js';
import { modelFixture } from './fixtures/model-glb.js';

test('GLB接受自包含纹理与几何，不读取任何外部资源', () => {
  const result = inspectModelFile(modelFixture());
  assert.equal(result.geometryOnly, false);
  assert.equal(result.json.meshes.length, 1);
});
test('GLB拒绝外部地址、损坏流、越界和解码器扩展', () => {
  for (const uri of [
    'https://example.com/image.png',
    'file:///C:/private',
    'data:image/png;base64,AA==',
  ])
    assert.throws(() => inspectModelFile(modelFixture((j) => (j.images[0].uri = uri))), /外部资源/);
  assert.throws(() => inspectModelFile(modelFixture().slice(0, -1)), /有效/);
  assert.throws(
    () => inspectModelFile(modelFixture((j) => (j.bufferViews[0].byteLength = 999999))),
    /越界/,
  );
  assert.throws(
    () =>
      inspectModelFile(
        modelFixture((j) => (j.extensionsRequired = ['KHR_draco_mesh_compression'])),
      ),
    /扩展/,
  );
  assert.throws(
    () => inspectModelFile(modelFixture((j) => (j.accessors[0].count = 99999999))),
    /数量/,
  );
});
test('GLB拒绝循环引用、无效子节点、过深场景树', () => {
  assert.throws(() => inspectModelFile(modelFixture((j) => (j.nodes[0].children = [0]))), /循环/);
  assert.throws(() => inspectModelFile(modelFixture((j) => (j.nodes[0].children = [5]))), /引用/);
  assert.throws(
    () =>
      inspectModelFile(
        modelFixture((j) => {
          j.nodes = Array.from({ length: 140 }, (_, i) => (i === 139 ? {} : { children: [i + 1] }));
        }),
      ),
    /层级/,
  );
});
