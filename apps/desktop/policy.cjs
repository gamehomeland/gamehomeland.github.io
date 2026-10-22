'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};
const CSP =
  "default-src 'none'; script-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; worker-src blob:; connect-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
function localURL(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'homeland:' && u.hostname === 'app' && !u.port && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
async function resource(url, root) {
  if (!localURL(url)) return { status: 403 };
  let name;
  try {
    name = decodeURIComponent(new URL(url).pathname);
  } catch {
    return { status: 400 };
  }
  if (name.includes('\\') || name.includes('\0') || name.split('/').includes('..'))
    return { status: 403 };
  if (name === '/') name = '/index.html';
  // Resolve Windows short paths and symlinked roots before checking containment.
  const base = await fs.realpath(root),
    file = path.resolve(base, '.' + name);
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 403 };
  try {
    const actual = await fs.realpath(file);
    if (!actual.startsWith(base + path.sep)) return { status: 403 };
    const contentType = TYPES[path.extname(actual).toLowerCase()];
    if (!contentType) return { status: 403 };
    if (!(await fs.stat(actual)).isFile()) return { status: 404 };
    return {
      status: 200,
      body: await fs.readFile(actual),
      headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    };
  } catch {
    return { status: 404 };
  }
}
function allowedDownload(url, filename) {
  return (
    url.startsWith('blob:homeland://app/') &&
    /(?:\.(zip|blueprintx)|\.homeland\.json)$/i.test(filename) &&
    !/[\/\\]/.test(filename)
  );
}
function isSourceLink(url, repositoryUrl = '') {
  // 只允许打开发布者明确配置的 GitHub 仓库首页。
  return (
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repositoryUrl) &&
    url === repositoryUrl
  );
}
module.exports = { localURL, resource, allowedDownload, isSourceLink, CSP };
