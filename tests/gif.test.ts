import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gifFirstFrame } from '../apps/web/src/gif.js';
import { prepareFile, validateFile, imageHeader } from '../apps/web/src/upload.js';
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const animated = fixture('first-frame.gif');
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
test('GIF 截取后成为确定的单帧，重复截取不会改变画面数据', async () => {
  const first = gifFirstFrame(animated);
  assert.deepEqual([first.width, first.height], [32, 24]);
  assert.ok(first.bytes.length < animated.length);
  assert.deepEqual(gifFirstFrame(first.bytes).bytes, first.bytes);
  assert.equal(first.bytes.at(-1), 0x3b);
  const file = new File([animated], 'example.gif', { type: 'application/octet-stream' });
  const prepared = await prepareFile(file);
  assert.equal(prepared.firstFrameOnly, true);
  assert.equal(prepared.file.type, 'image/gif');
  assert.equal(prepared.file.name, file.name);
  assert.deepEqual(new Uint8Array(await prepared.file.arrayBuffer()), first.bytes);
  assert.equal(imageHeader(animated).format, 'gif');
});
test('首帧保留局部调色板和偏移，不以第一块像素区域替代完整画布', () => {
  const local = fixture('first-frame-local.gif'),
    first = gifFirstFrame(local);
  assert.deepEqual([first.width, first.height], [40, 32]);
  assert.equal(first.bytes[10] & 0x80, 0);
  const p = 13 + 8;
  assert.equal(first.bytes[p], 0x2c);
  assert.equal(first.bytes[p + 1], 4);
  assert.equal(first.bytes[p + 3], 3);
  assert.equal(first.bytes[p + 9] & 0x80, 0x80);
});
test('首帧完整时忽略其后的损坏帧，首帧损坏则给出错误', () => {
  const first = gifFirstFrame(animated).bytes;
  assert.deepEqual(
    gifFirstFrame(join(first.subarray(0, -1), Uint8Array.of(0x2c, 0xff))).bytes,
    first,
  );
  for (const cut of [1, 12, 20, first.length - 3])
    assert.throws(() => gifFirstFrame(first.subarray(0, cut)));
  const bad = first.slice();
  new DataView(bad.buffer).setUint16(6, 0, true);
  assert.throws(() => gifFirstFrame(bad));
});
test('GCE 损坏、首帧越界和缺少调色板不能进入解码', () => {
  const first = gifFirstFrame(animated).bytes,
    head = 13 + 3 * 2 ** ((first[10] & 7) + 1);
  const broken = first.slice();
  broken[head + 2] = 5;
  assert.throws(() => gifFirstFrame(broken));
  const offset = first.slice();
  new DataView(offset.buffer).setUint16(head + 8 + 1, 32, true);
  assert.throws(() => gifFirstFrame(offset), /画布/);
  const local = fixture('first-frame-local.gif');
  local[13 + 8 + 9] &= 0x7f;
  assert.throws(() => gifFirstFrame(local), /调色板/);
});
test('超过旧 10 MiB 限制的有效 GIF 现在可以读取', async () => {
  const size = 11 * 1024 ** 2,
    comment = new Uint8Array(2 + Math.ceil(size / 255) + size + 1);
  comment[0] = 0x21;
  comment[1] = 0xfe;
  let at = 2,
    remaining = size;
  while (remaining) {
    const n = Math.min(255, remaining);
    comment[at++] = n;
    comment.fill(65, at, at + n);
    at += n;
    remaining -= n;
  }
  const head = 13 + 3 * 2 ** ((animated[10] & 7) + 1),
    large = join(animated.subarray(0, head), comment, animated.subarray(head));
  const file = new File([large], 'large.gif', { type: 'image/gif' });
  assert.ok(file.size > 10 * 1024 ** 2);
  assert.equal((await validateFile(file)).format, 'gif');
  assert.deepEqual(
    new Uint8Array(await (await prepareFile(file)).file.arrayBuffer()),
    gifFirstFrame(animated).bytes,
  );
});
