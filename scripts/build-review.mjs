import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
const root = new URL('../', import.meta.url),
  out = new URL('artifacts/', root),
  md = new MarkdownIt({ html: false });
await mkdir(out, { recursive: true });
const documents = (await readdir(new URL('docs/',root))).filter(name=>name.endsWith('.md')).sort();
const linkRule =
  md.renderer.rules.link_open ||
  ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const link = tokens[index],
    file = (link.attrGet('href') || '').split('#')[0];
  if (documents.includes(file)) link.attrSet('href', '#chapter-' + documents.indexOf(file));
  return linkRule(tokens, index, options, env, self);
};
const css = `*{box-sizing:border-box}body{margin:0;background:#f4eedc;color:#393528;font:15px/1.8 'Microsoft YaHei',sans-serif}main{max-width:1160px;padding:32px 24px;margin:auto}h1{font-size:32px;margin:10px 0}h2{font-size:23px;margin-top:30px}p{color:#77694e}a{color:#79552d;font-weight:bold}nav{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 28px}nav a{border:1px solid #cfba8f;background:#fffcf3;border-radius:7px;padding:9px 17px;text-decoration:none}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.card,article{background:#fffcf4;border:1px solid #dfd3b7;border-radius:12px;padding:20px}.images{display:grid;grid-template-columns:1fr 1fr;gap:12px}.images img{width:100%;height:240px;object-fit:contain;background:#f2eddf;image-rendering:pixelated}.images small{display:block;color:#8f8064}.card h3{margin:3px 0 9px}.card p{margin:10px 0;font-size:13px}.pills{display:flex;gap:8px;flex-wrap:wrap}.pills span{background:#e9dfc8;border-radius:5px;padding:3px 10px;font-size:12px}table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow:auto}td,th{padding:8px;border:1px solid #dfd3b7;text-align:left}pre{overflow:auto;padding:18px;background:#eee5d1;border-radius:8px}code{font-family:Consolas,monospace}article{margin-bottom:22px}article p,article li{color:#4e4738}footer{margin-top:30px;color:#99896a;font-size:12px}@media(max-width:700px){.grid{grid-template-columns:1fr}.images img{height:170px}}`;
const frame = (title, body) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style><main>${body}<footer>家园蓝图 · 本地验证资料</footer></main></html>`;
const rows = JSON.parse(await readFile(new URL('samples/results.json', out), 'utf8'));
const titles = {
  'wall-8m': '8 米墙面拼布',
  'ground-20m': '20 米地面图案',
  'ground-100m': '100 米地面渐变',
  'ground-200m': '200 米大幅平铺',
  'wall-1m': '1 米小尺寸',
  'transparent-8m': '透明边缘与白底',
  'lines-ground': '线条与长幅地面',
  'hidden-handle': '隐藏整体操作基座',
};
const cards = rows
  .map(
    (r) =>
      `<section class="card"><h3>${titles[r.name]}</h3><div class="pills"><span>${r.summary.widthM} × ${r.summary.heightM} 米</span><span>${r.summary.totalCount.toLocaleString('zh-CN')} 件</span><span>${r.summary.gridWidth} × ${r.summary.gridHeight} 格</span></div><div class="images"><div><small>原图</small><img src="samples/${r.name}/原图.png" alt="${titles[r.name]}原图"></div><div><small>蓝图回读效果</small><img src="samples/${r.name}/效果预览.png" alt="${titles[r.name]}拼布预览"></div></div><p>${r.summary.layout === 'native' ? '普通布局' : '微缩布局'} · ${r.summary.visibleLayers} 层 · 文件与几何校验通过</p><a href="samples/${r.name}/完整包.zip" download>下载样例完整包</a></section>`,
  )
  .join('');
const body = `<p>JX3 HOMELAND</p><h1>家园蓝图 · 成品与原理</h1><p>选择图片、摆放方向与成品尺寸，配色和格数自动适配。</p><nav><a href="/">打开制作页面</a><a href="guide.html">查看制作原理</a><a href="downloads/家园蓝图-离线版.html" download>下载离线网页</a><a href="downloads/家园蓝图-Windows-x64.zip" download>下载 Windows 版</a><a href="downloads/jx3-homeland-blueprint-source.zip" download>下载源码</a></nav><section class="card"><h2>样例文件</h2><p>八组样例均包含蓝图、预览、家具清单和使用说明。下载后按清单准备家具，在家园中导入并整体调整位置。</p><p>可以先用小尺寸查看配色和摆放效果，再按实际空地选择更大的尺寸。游戏光照和观看角度会影响最终效果。</p></section><h2>不同尺寸与摆放方式</h2><div class="grid">${cards}</div>`;
await writeFile(new URL('review.html', out), frame('家园蓝图 · 验证预览', body));
const rendered = await Promise.all(
  documents.map(
    async (name, i) =>
      `<article id="chapter-${i}">${md.render(await readFile(new URL('docs/' + name, root), 'utf8'))}</article>`,
  ),
);
await writeFile(
  new URL('guide.html', out),
  frame(
    '家园蓝图 · 原理解读',
    `<nav><a href="review.html">返回成品预览</a><a href="/">制作蓝图</a></nav>${rendered.join('\n')}`,
  ),
);
console.log('已生成 artifacts/review.html 和完整原理文档');
