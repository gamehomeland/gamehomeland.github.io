import { readFile, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectLibraryGLB(bytes, label) {
  if (
    bytes.length < 28 ||
    bytes.length > 50 * 1024 ** 2 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new Error('模型不是有效的 GLB 2.0：' + label);
  const jsonLength = bytes.readUInt32LE(12),
    binHeader = 20 + jsonLength;
  if (
    jsonLength % 4 ||
    binHeader + 8 > bytes.length ||
    bytes.readUInt32LE(binHeader + 4) !== 0x004e4942
  )
    throw new Error('模型缺少内嵌二进制数据：' + label);
  const doc = JSON.parse(bytes.toString('utf8', 20, binHeader));
  const binLength = bytes.readUInt32LE(binHeader);
  if (
    binHeader + 8 + binLength !== bytes.length ||
    doc.buffers?.length !== 1 ||
    doc.buffers[0].uri !== undefined ||
    !Number.isSafeInteger(doc.buffers[0].byteLength) ||
    doc.buffers[0].byteLength > binLength ||
    binLength - doc.buffers[0].byteLength > 3
  )
    throw new Error('模型缓冲区不完整或引用外部文件：' + label);
  for (const view of doc.bufferViews ?? []) {
    const offset = view.byteOffset ?? 0;
    if (
      view.buffer !== 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(view.byteLength) ||
      view.byteLength < 0 ||
      offset + view.byteLength > doc.buffers[0].byteLength
    )
      throw new Error('模型缓冲区越界：' + label);
  }
  for (const image of doc.images ?? []) {
    const view = doc.bufferViews?.[image.bufferView];
    if (
      image.uri !== undefined ||
      !view ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
    )
      throw new Error('贴图必须以内嵌 PNG、JPEG 或 WebP 提供：' + label);
  }
  return {
    doc,
    bytes: bytes.length,
    images: doc.images?.length ?? 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function validateLibraryRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw new Error('家具模型目录须为 1～1000 项数组');
  const names = new Set(),
    ids = new Set();
  for (const row of rows) {
    if (
      !row ||
      !/^[\w-]+\.glb$/.test(row.file) ||
      names.has(row.file) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 80 ||
      typeof row.note !== 'string' ||
      typeof row.category !== 'string' ||
      row.category.length > 30 ||
      (row.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(row.sha256))
    )
      throw new Error('家具模型目录的名称、文件名或摘要无效');
    names.add(row.file);
    if (row.resourceId !== undefined) {
      if (
        !Number.isSafeInteger(row.resourceId) ||
        row.resourceId <= 0 ||
        row.resourceId >= 0xffffffff ||
        ids.has(row.resourceId)
      )
        throw new Error('家具资源编号无效或重复：' + row.resourceId);
      ids.add(row.resourceId);
    }
  }
}

export async function verifyModelLibrary(rootURL = new URL('../', import.meta.url)) {
  const root = fileURLToPath(rootURL);
  const loadJSON = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const rows = await loadJSON('assets/models/furniture/manifest.json');
  validateLibraryRows(rows);
  const editor = await loadJSON('data/editor_catalog.json');
  const basement = await loadJSON('data/basement_models.json');
  const bindings = new Map(editor.resources.map((r) => [r.representId, r]));
  const bound = new Set(),
    records = [];
  async function check(relative, expectedHash) {
    const file = await realpath(resolve(root, relative));
    const base = await realpath(resolve(root, 'assets/models'));
    if (!file.startsWith(base + sep)) throw new Error('模型路径超出资源目录');
    const report = inspectLibraryGLB(await readFile(file), relative);
    if (report.sha256 !== expectedHash) throw new Error('模型摘要与目录不一致：' + relative);
    records.push({
      path: relative,
      sha256: report.sha256,
      bytes: report.bytes,
      images: report.images,
    });
    return report;
  }
  for (const row of rows) {
    await check('assets/models/furniture/' + row.file, row.sha256);
    if (row.resourceId !== undefined) {
      const binding = bindings.get(row.resourceId);
      if (!binding || binding.modelSha256 !== row.sha256)
        throw new Error('家具模型与导出绑定不一致，请重新生成 editor_catalog.json：' + row.name);
      bound.add(row.resourceId);
    }
  }
  if (bound.size !== bindings.size) throw new Error('部分可编辑家具缺少随项目提供的模型');
  for (const resource of basement.resources) {
    if (!/^[\w-]+\.glb$/.test(resource.file)) throw new Error('地下室模型文件名无效');
    const { doc } = await check('assets/models/basement/' + resource.file, resource.modelSha256);
    const variants = new Set(
      (doc.scenes?.[doc.scene ?? 0]?.nodes ?? []).map(
        (i) => doc.nodes?.[i]?.extras?.basementVariant,
      ),
    );
    if (
      doc.extras?.basementBrushId !== resource.brushId ||
      variants.size !== 24 ||
      [...variants].some((v) => !Number.isInteger(v) || v < 0 || v >= 24)
    )
      throw new Error('地下室模型形态或资源身份不一致：' + resource.file);
  }
  for (const folder of ['furniture', 'basement']) {
    const expected = new Set(
      records.filter((r) => dirname(r.path).endsWith(folder)).map((r) => r.path.split('/').at(-1)),
    );
    if (folder === 'furniture') expected.add('manifest.json');
    for (const name of await readdir(resolve(root, 'assets/models', folder)))
      if (!expected.has(name))
        throw new Error('模型库存在未登记文件，请先整理：' + folder + '/' + name);
  }
  return {
    furniture: rows.length,
    editableFurniture: bound.size,
    basements: basement.resources.length,
    variants: basement.resources.reduce((n, r) => n + r.variants.length, 0),
    bytes: records.reduce((n, r) => n + r.bytes, 0),
    embeddedImages: records.reduce((n, r) => n + r.images, 0),
    files: records,
  };
}
