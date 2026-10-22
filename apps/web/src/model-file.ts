/** 自包含 GLB。导入模型不允许借助外部 URL 读取纹理或缓冲区。 */
export const MAX_MODEL_BYTES = 50 * 1024 * 1024;
export function inspectModelFile(bytes: ArrayBuffer): {
  json: Record<string, any>;
  geometryOnly: boolean;
} {
  if (bytes.byteLength < 28 || bytes.byteLength > MAX_MODEL_BYTES)
    throw new Error('请选择不超过 50 MiB 的完整 GLB 文件。');
  const view = new DataView(bytes);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength
  )
    throw new Error('文件不是有效的 GLB 2.0 模型。');
  let offset = 12,
    json: Record<string, any> | undefined,
    binaryBytes = 0,
    chunks = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('GLB 数据块被截断。');
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.byteLength)
      throw new Error('GLB 数据块长度无效。');
    if (chunks === 0 && type !== 0x4e4f534a) throw new Error('GLB 缺少首个 JSON 数据块。');
    if (type === 0x4e4f534a) {
      if (json || length > 8 * 1024 * 1024) throw new Error('GLB 描述块无效或过大。');
      json = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, offset + 8, length)),
      );
    } else if (type === 0x004e4942 && chunks === 1) binaryBytes = length;
    else throw new Error('暂不支持这种 GLB 数据块。');
    offset += 8 + length;
    chunks++;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('GLB 版本不受支持。');
  const arrays = [
    'nodes',
    'meshes',
    'accessors',
    'buffers',
    'bufferViews',
    'images',
    'textures',
    'materials',
    'scenes',
  ];
  for (const key of arrays)
    if (json[key] !== undefined && (!Array.isArray(json[key]) || json[key].length > 10000))
      throw new Error('模型结构数量过大。');
  for (const key of arrays)
    if (
      (json[key] ?? []).some(
        (item: unknown) => !item || typeof item !== 'object' || Array.isArray(item),
      )
    )
      throw new Error('模型描述字段格式无效。');
  if (json.extensionsRequired?.some((name: string) => name !== 'EXT_texture_webp'))
    throw new Error('此模型需要额外扩展解码器，请先导出为普通 GLB。');
  // 不允许数据 URI：图片也应嵌入 BIN，通过 bufferView 引用。
  const pending: unknown[] = [json];
  let examined = 0;
  while (pending.length) {
    if (++examined > 200000) throw new Error('模型描述过于复杂。');
    const item = pending.pop();
    if (item && typeof item === 'object')
      for (const [key, value] of Object.entries(item)) {
        if (key === 'uri') throw new Error('模型引用了外部资源，请将纹理和几何全部嵌入 GLB。');
        if (value && typeof value === 'object') pending.push(value);
      }
  }
  if (
    json.buffers?.length !== 1 ||
    !Number.isSafeInteger(json.buffers[0].byteLength) ||
    json.buffers[0].byteLength <= 0 ||
    json.buffers[0].byteLength > binaryBytes
  )
    throw new Error('模型二进制缓冲区无效。');
  for (const b of json.bufferViews ?? []) {
    const start = b.byteOffset ?? 0;
    if (
      b.buffer !== 0 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(b.byteLength) ||
      b.byteLength < 0 ||
      start + b.byteLength > json.buffers[0].byteLength
    )
      throw new Error('模型数据范围越界。');
  }
  let elements = 0;
  for (const a of json.accessors ?? []) {
    if (!Number.isSafeInteger(a.count) || a.count < 0 || a.count > 3000000 || a.sparse)
      throw new Error('模型顶点数量或稀疏数据格式不受支持。');
    elements += a.count;
  }
  if (elements > 8000000 || (json.nodes?.length ?? 0) > 3000)
    throw new Error('模型过大，请精简后预览。');
  const nodes = json.nodes ?? [],
    colors = new Uint8Array(nodes.length);
  const visit = (id: number, depth: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= nodes.length || depth > 128 || colors[id] === 1)
      throw new Error('模型节点存在无效引用、循环或过深层级。');
    if (colors[id] === 2) return;
    colors[id] = 1;
    const children = nodes[id].children ?? [];
    if (!Array.isArray(children) || children.length > nodes.length)
      throw new Error('模型子节点无效。');
    for (const child of children) visit(child, depth + 1);
    colors[id] = 2;
  };
  for (let i = 0; i < nodes.length; i++) visit(i, 0);
  return {
    json,
    geometryOnly: json.asset?.extras?.scope === 'geometry-only' || !json.images?.length,
  };
}
