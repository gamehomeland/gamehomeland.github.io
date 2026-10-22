import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)),
  web = resolve(root, 'apps/web/dist'),
  artifacts = resolve(root, 'artifacts');
const downloadNames = new Set([
  '家园蓝图-离线版.html',
  '家园蓝图-Windows-x64.zip',
  'jx3-homeland-blueprint-source.zip',
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.blueprintx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1'),
      name = decodeURIComponent(url.pathname);
    if (name.includes('\\') || name.includes('\0') || name.split('/').includes('..')) {
      res.writeHead(403).end();
      return;
    }
    let base = web,
      relative = name === '/' ? 'index.html' : name.slice(1),
      download = false;
    if (['/review.html', '/guide.html'].includes(name)) {
      base = artifacts;
      relative = name.slice(1);
    } else if (name.startsWith('/samples/')) {
      base = resolve(artifacts, 'samples');
      relative = name.slice(9);
    } else if (name.startsWith('/downloads/') && downloadNames.has(name.slice(11))) {
      base = artifacts;
      relative = name.slice(11);
      download = true;
    }
    const file = await realpath(resolve(base, relative)),
      resolvedBase = await realpath(base);
    if (!file.startsWith(resolvedBase + sep) || !(await stat(file)).isFile()) {
      res.writeHead(403).end();
      return;
    }
    const headers = {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    if (download)
      headers['Content-Disposition'] =
        "attachment; filename*=UTF-8''" + encodeURIComponent(relative);
    const data = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.listen(5173, '127.0.0.1', () =>
  console.log('制作页面 http://127.0.0.1:5173/\n验证预览 http://127.0.0.1:5173/review.html'),
);
