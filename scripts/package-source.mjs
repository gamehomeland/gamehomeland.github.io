import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';
import { verifyModelLibrary } from './model-library.mjs';
await verifyModelLibrary();
const root = new URL('../', import.meta.url),
  files = {};
const top = [
  '.github',
  '.gitattributes',
  'apps',
  'assets',
  'packages',
  'data',
  'docs',
  'examples',
  'tools',
  'tests',
  'scripts',
  'README.md',
  'DEPLOYMENT.md',
  'site.config.json',
  'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
];
async function collect(url) {
  const info = await stat(url);
  if (info.isDirectory()) {
    for (const item of await readdir(url, { withFileTypes: true })) {
      if (!['node_modules', 'dist', '__pycache__'].includes(item.name))
        await collect(new URL(item.name + (item.isDirectory() ? '/' : ''), url));
    }
    return;
  }
  const name = relative(fileURLToPath(root), fileURLToPath(url)).split(sep).join('/');
  if (name.endsWith('.generated.ts')) return;
  files['jx3-homeland-blueprint/' + name] = new Uint8Array(await readFile(url));
}
for (const name of top) {
  const info = await stat(new URL(name, root));
  await collect(new URL(name + (info.isDirectory() ? '/' : ''), root));
}
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(
  new URL('artifacts/jx3-homeland-blueprint-source.zip', root),
  zipSync(files, { level: 6, mtime: new Date(2000, 0, 1) }),
);
console.log(`源码包：${Object.keys(files).length} 个文件`);
