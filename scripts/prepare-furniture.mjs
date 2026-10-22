import { readFile, mkdir, copyFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLibraryGLB, validateLibraryRows } from './model-library.mjs';
const source = process.argv[2];
if (!source || process.argv.length !== 3)
  throw new Error('用法：node scripts/prepare-furniture.mjs 模型清单.json');
const manifestPath = await realpath(source),
  input = dirname(manifestPath);
const rows = JSON.parse(await readFile(manifestPath, 'utf8'));
validateLibraryRows(rows);
const output = fileURLToPath(new URL('../assets/models/furniture/', import.meta.url));
let current = [];
try {
  current = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (current.length) validateLibraryRows(current);
const merged = new Map(current.map((row) => [row.file, row]));
const prepared = [],
  names = new Set();
for (const row of rows) {
  if (
    !/^[\w-]+\.glb$/.test(row.file) ||
    typeof row.name !== 'string' ||
    row.name.length > 80 ||
    typeof row.note !== 'string' ||
    names.has(row.file)
  )
    throw new Error('模型清单名称或文件名无效');
  const path = await realpath(resolve(input, row.file));
  if (!path.startsWith(input + sep)) throw new Error('模型路径越界');
  const bytes = await readFile(path);
  const report = inspectLibraryGLB(bytes, row.file);
  names.add(row.file);
  prepared.push({
    path,
    row: {
      file: row.file,
      name: row.name,
      category: typeof row.category === 'string' ? row.category.slice(0, 30) : '其他',
      note: row.note,
      ...(row.resourceId === undefined ? {} : { resourceId: row.resourceId }),
      sha256: report.sha256,
    },
  });
}
for (const item of prepared) merged.set(item.row.file, item.row);
validateLibraryRows([...merged.values()]);
await mkdir(output, { recursive: true });
for (const item of prepared)
  if (item.path !== resolve(output, item.row.file))
    await copyFile(item.path, resolve(output, item.row.file));
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify([...merged.values()], null, 2) + '\n',
);
console.log(
  `已加入或更新 ${prepared.length} 份模型，模型库共 ${merged.size} 份，存放于 assets/models/furniture。含 resourceId 的模型请同步 editor_catalog.json，再运行 pnpm check:models。`,
);
