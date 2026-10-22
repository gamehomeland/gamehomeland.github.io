import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url),
  web = new URL('apps/web/', root);
// 单独构建单入口，防止多入口构建产生共享 chunk，破坏 file:// 离线运行。
const result = await build({
  configFile: false,
  publicDir: false,
  root: fileURLToPath(web),
  base: './',
  plugins: [
    {
      name: 'offline-viewer',
      transform(code, id) {
        if (id.replaceAll('\\', '/').endsWith('/src/viewer-loader.ts'))
          return "import { BlueprintViewer } from './preview3d.js'; import { FurnitureViewer } from './furniture3d.js'; import { SceneViewer } from './scene-viewer.js'; export async function loadViewer() { return BlueprintViewer; } export async function loadFurnitureViewer() { return FurnitureViewer; } export async function loadSceneViewer() { return SceneViewer; }";
      },
    },
  ],
  worker: { format: 'iife' },
  build: {
    write: false,
    target: 'es2022',
    assetsInlineLimit: 1000000,
    rollupOptions: {
      input: fileURLToPath(new URL('index.html', web)),
      output: { codeSplitting: false },
    },
  },
});
const items = (Array.isArray(result) ? result : [result]).flatMap((x) => x.output),
  chunks = items.filter((x) => x.type === 'chunk');
if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length)
  throw new Error('离线页面仍含外部脚本依赖');
const code = chunks[0].code.replace(/<\/script/gi, '<\\/script');
const css = items
  .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
  .map((x) => String(x.source))
  .join('\n')
  .replace(/<\/style/gi, '<\\/style');
let html = await readFile(new URL('index.html', web), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('base64');
const policy = `default-src 'none'; script-src 'sha256-${sha(code)}' blob:; style-src 'sha256-${sha(css)}'; img-src data: blob:; worker-src blob:; connect-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'`;
html = html.replace(
  '<head>',
  '<head><meta http-equiv="Content-Security-Policy" content="' + policy + '">',
);
const entry = /<script type="module" src="\/src\/main.ts"><\/script>/;
if (!entry.test(html)) throw new Error('未找到离线构建入口');
html = html
  .replace('</head>', () => `<style>${css}</style></head>`)
  .replace(entry, () => `<script type="module">${code}</script>`);
if (/<script[^>]*\ssrc\s*=/.test(html)) throw new Error('离线页面仍含外部入口');
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(new URL('artifacts/家园蓝图-离线版.html', root), html);
console.log(
  `离线页面 ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB，脚本、样图和资料全部内嵌`,
);
