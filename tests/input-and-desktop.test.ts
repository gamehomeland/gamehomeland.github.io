import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { imageHeader, validateFile } from '../apps/web/src/upload.js';
const require = createRequire(import.meta.url);
const { resource, allowedDownload, localURL, isSourceLink } = require('../apps/desktop/policy.cjs');
const sample = readFileSync(new URL('./fixtures/first-frame.png', import.meta.url));
for (const [name, format] of [
  ['rgb.jpg', 'jpeg'],
  ['alpha.webp', 'webp'],
  ['rotated.jpg', 'jpeg'],
])
  test('真实格式文件头 ' + name, () => {
    const bytes = readFileSync(new URL('./fixtures/' + name, import.meta.url));
    const header = imageHeader(bytes);
    assert.equal(header.format, format);
    assert.equal(header.width, 32);
  });
test('输入依据实际文件头，不能只改扩展名', async () => {
  assert.equal(imageHeader(sample).format, 'png');
  assert.throws(() => imageHeader(new TextEncoder().encode('<svg><script/></svg>')));
  assert.throws(() => imageHeader(sample.subarray(0, 40)));
  await assert.rejects(validateFile(new File([], 'empty.png')));
  await assert.rejects(
    validateFile(new File([new Uint8Array(50 * 1024 ** 2 + 1)], 'large.png')),
    /50 MiB/,
  );
});
test('伪造超大尺寸和动画均被拒绝', () => {
  const huge = sample.slice();
  huge.writeUInt32BE(9000000, 16);
  assert.throws(() => imageHeader(huge), /800/);
  const prefix = sample.subarray(0, 33),
    chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4);
  chunk.writeUInt32BE(2, 8);
  assert.throws(() => imageHeader(Buffer.concat([prefix, chunk, sample.subarray(33)])), /静态/);
  const webp = Buffer.alloc(30);
  webp.write('RIFF');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBP', 8);
  webp.write('VP8X', 12);
  webp.writeUInt32LE(10, 16);
  webp[20] = 2;
  assert.throws(() => imageHeader(webp), /静态/);
});
test('桌面本地协议只读构建目录，拒绝外部和路径逃逸', async () => {
  const root = mkdtempSync(join(tmpdir(), 'homeland-protocol-'));
  try {
    writeFileSync(join(root, 'index.html'), 'test');
    writeFileSync(join(root, 'secret.txt'), 'no');
    writeFileSync(join(root, 'model.glb'), 'glTF-test');
    assert.equal((await resource('homeland://app/', root)).status, 200);
    assert.equal(
      (await resource('homeland://app/model.glb?v=hash', root)).headers['Content-Type'],
      'model/gltf-binary',
    );
    for (const url of [
      'https://example.com/',
      'homeland://other/index.html',
      'homeland://name:pass@app/',
      'homeland://app/%2e%2e%2fsecret.txt',
      'homeland://app/%5c..%5csecret.txt',
      'homeland://app/secret.txt',
    ]) {
      assert.notEqual((await resource(url, root)).status, 200, url);
    }
    assert.equal((await resource('homeland://app/absent.js', root)).status, 404);
  } finally {
    unlinkSync(join(root, 'index.html'));
    unlinkSync(join(root, 'secret.txt'));
    unlinkSync(join(root, 'model.glb'));
    rmdirSync(root);
  }
});
test('桌面下载只接收本页生成的蓝图与完整包', () => {
  assert.ok(allowedDownload('blob:homeland://app/123', '花园.blueprintx'));
  assert.ok(allowedDownload('blob:homeland://app/123', '花园.zip'));
  assert.ok(allowedDownload('blob:homeland://app/123', '花园.homeland.json'));
  assert.equal(allowedDownload('blob:homeland://app/123', 'other.json'), false);
  assert.equal(allowedDownload('https://example.com/file.zip', 'file.zip'), false);
  assert.equal(allowedDownload('blob:homeland://other/123', 'file.zip'), false);
  assert.equal(allowedDownload('blob:homeland://app/123', '../file.zip'), false);
  assert.equal(allowedDownload('blob:homeland://app/123', 'file.exe'), false);
  assert.equal(localURL('homeland://app:123/'), false);
});

test('未配置发布仓库时不开放外部仓库链接', () => {
  assert.equal(isSourceLink('https://github.com/sample-owner/sample-owner.github.io'), false);
  for (const url of [
    'file:///C:/Windows/',
    'javascript:alert(1)',
    'http://github.com/sample-owner/sample-owner.github.io',
    'https://github.com.evil.test/sample-owner/sample-owner.github.io',
    'https://github.com/other/repo',
  ])
    assert.equal(isSourceLink(url), false);
});

test('配置仓库后仅允许指定 HTTPS 仓库首页', () => {
  const expected = 'https://github.com/deploy-owner/deploy-owner.github.io';
  assert.equal(isSourceLink(expected, expected), true);
  for (const candidate of [
    expected + '/issues',
    expected + '?redirect=other',
    expected.replace('github.com', 'github.com.evil.test'),
    expected.replace('https:', 'http:'),
    'https://github.com/other/repo',
    'file:///C:/Windows/',
  ])
    assert.equal(isSourceLink(candidate, expected), false);
  assert.equal(isSourceLink('javascript:alert(1)', 'javascript:alert(1)'), false);
});
