import { readFile, writeFile, mkdir } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
import { validateSiteConfig } from './site-config.mjs';
const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const project = validateSiteConfig(JSON.parse(await read('site.config.json')));
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
const files = ['00-user-guide.md'];
const developerFiles = [
  '24-model-library.md',
  '23-basement-and-terrain.md',
  '22-land-layouts.md',
  '20-scene-editor.md',
  '18-coverage-and-3d.md',
  '19-model-to-glb.md',
  '21-furniture-materials.md',
  '15-reading-homeland.md',
  '16-client-operations.md',
  '12-homeland-development-map.md',
  '11-lighting-and-scene.md',
  '01-homeland-model.md',
  '02-rendering-and-color.md',
  '03-blueprint-format.md',
  '13-blueprint-field-reference.md',
  '14-material-expansion.md',
  '04-client-resources.md',
  '05-export-pipeline.md',
  '06-verification.md',
  '07-editor-lifecycle.md',
  '08-developer-guide.md',
  '10-game-limits.md',
  '17-desktop-releases.md',
];
const developerTargets = new Map(developerFiles.map((file, i) => [file, `developer-chapter-${i}`]));
developerTargets.set('09-technology-and-architecture.md', 'developer-overview');
developerTargets.set('../CONTRIBUTING.md', 'developer-contributing');
developerTargets.set('../examples/export-blueprint.ts', 'developer-example');
developerTargets.set('../examples/inspect-component.ts', 'developer-structure-example');
const defaultLink =
  md.renderer.rules.link_open ||
  ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index],
    href = token.attrGet('href') || '';
  const file = href.split('#')[0];
  if (files.includes(file)) token.attrSet('href', `#doc-${files.indexOf(file)}`);
  else if (developerTargets.has(file.replace(/^docs\//, '')))
    token.attrSet('href', '#' + developerTargets.get(file.replace(/^docs\//, '')));
  else if (/^https?:\/\//.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink(tokens, index, options, env, self);
};
const documents = await Promise.all(files.map((readFileName) => read('docs/' + readFileName)));
const html = documents
  .map((body, i) => {
    const [title, ...lines] = body.trim().split('\n');
    if (files.length === 1) return md.render(lines.join('\n'));
    return `<details id="doc-${i}"${i === 0 ? ' open' : ''}><summary>${md.utils.escapeHtml(title.replace(/^#\s+/, ''))}</summary>${md.render(lines.join('\n'))}</details>`;
  })
  .join('\n');
let developer =
  '<section id="developer-overview">' +
  md.render(
    (await read('docs/09-technology-and-architecture.md')).split('\n').slice(1).join('\n'),
  ) +
  '</section>';
let chapterLinks = '',
  chapters = '';
for (const [i, file] of developerFiles.entries()) {
  const [title, ...lines] = (await read('docs/' + file)).trim().split('\n');
  const label = md.utils.escapeHtml(title.replace(/^#\s+/, '')),
    id = `developer-chapter-${i}`;
  chapterLinks += `<a href="#${id}">${label}</a>`;
  chapters += `<details id="${id}"><summary>${label}</summary>${md.render(lines.join('\n'))}</details>`;
}
developer =
  `<nav class="doc-nav" aria-label="开发文档目录">${chapterLinks}</nav>` +
  developer +
  '<h2>家园实现与扩展文档</h2>' +
  chapters;
developer +=
  '<details id="developer-contributing"><summary>参与开发</summary>' +
  md.render((await read('CONTRIBUTING.md')).split('\n').slice(1).join('\n')) +
  '</details>';
developer +=
  '<details id="developer-example"><summary>可运行的核心导出示例</summary>' +
  md.render('```ts\n' + (await read('examples/export-blueprint.ts')) + '\n```') +
  '</details>';
developer +=
  '<details id="developer-structure-example"><summary>可运行的四格结构示例</summary>' +
  md.render('```ts\n' + (await read('examples/inspect-component.ts')) + '\n```') +
  '</details>';
const limits = md.render((await read('docs/10-game-limits.md')).split('\n').slice(1).join('\n'));
const paletteData = JSON.parse(await read('data/furniture_palette.json'));
const colorProfiles = JSON.parse(await read('data/client_color_profiles.json'));
const opaque = paletteData.colors.filter((color) => !color.translucent);
const recipeDepth = colorProfiles.max_recipe_layers;
const uniqueColors = new Set(
  Object.values(colorProfiles.tables.wall.colors).map((rgb) => rgb.join(',')),
).size;
let palette = `<p>${opaque.length} 种不透明底色，普通叠层提供 ${opaque.length * recipeDepth} 个配方，对应当前预览模型中的 ${uniqueColors} 个不同颜色。白色透明叠层主要补充浅色，饱和色范围仍受家具材质限制。</p><p>微缩布局和像素画使用不透明底色；彩色透明材料通过独立试验选项参与配色。色卡是固定光照基准，游戏实际颜色会受光照影响。</p><div class="palette-table"><table><thead><tr><th>底色</th>${Array.from({ length: recipeDepth }, (_, i) => `<th>${i ? `叠 ${i} 层` : '单层'}</th>`).join('')}</tr></thead><tbody>`;
for (const color of opaque) {
  palette += `<tr><th>${md.utils.escapeHtml(color.key)}</th>`;
  for (let level = 0; level < recipeDepth; level++) {
    const keys = [color.key, ...Array(level).fill(colorProfiles.overlay_key)];
    const rgb = colorProfiles.tables.wall.colors[JSON.stringify(keys)];
    if (
      !Array.isArray(rgb) ||
      rgb.length !== 3 ||
      rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error('色卡数据无效');
    palette += `<td><svg viewBox="0 0 80 30" role="img" aria-label="${md.utils.escapeHtml(color.key)}，${level + 1} 件拼布，RGB ${rgb.join(', ')}"><rect width="80" height="30" rx="3" fill="rgb(${rgb.join(',')})"/></svg><small>${rgb
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}</small></td>`;
  }
  palette += '</tr>';
}
palette += '</tbody></table></div>';
const materialResearch = JSON.parse(await read('docs/material-candidates.json'));
let candidatePalette =
  '<details open><summary>彩色透明材料试验</summary><p>六类彩色透明材料可参与试验配色，在“更多选项”开启。仅在综合评分改善时采用；下面是中性模型估算，游戏实际颜色仍需核对。</p><div class="palette-table"><table><thead><tr><th>底色</th><th>原底色</th>';
for (const candidate of materialResearch.candidates)
  candidatePalette += `<th>${md.utils.escapeHtml(candidate.name.replace('琉璃七巧·', '').replace('琉璃·', ''))}</th>`;
candidatePalette += '</tr></thead><tbody>';
for (const key of ['灰2', '灰4', '红5', '黄4', '绿3', '蓝2']) {
  const color = opaque.find((c) => c.key === key);
  const row = [
    color.rgb,
    ...materialResearch.candidates.map((c) => c.recipes.find((r) => r.base === key).rgb),
  ];
  candidatePalette += `<tr><th>${md.utils.escapeHtml(key)}</th>`;
  for (const rgb of row)
    candidatePalette += `<td><svg viewBox="0 0 80 30" role="img" aria-label="试色估算 RGB ${rgb.join(', ')}"><rect width="80" height="30" rx="3" fill="rgb(${rgb.join(',')})"/></svg></td>`;
  candidatePalette += '</tr>';
}
candidatePalette +=
  '</tbody></table></div><p>试色蓝图生成方法、材料编号和验证范围见“技术与开发 → 扩展材质配色”。</p></details>';
palette = candidatePalette + '<h3>拼布色卡</h3>' + palette;
const examples = {};
for (const [id, name] of [['sample', '示例图片.jpg']])
  examples[id] = {
    name,
    type: 'image/jpeg',
    base64: (await readFile(new URL(`examples/${id}.jpg`, root))).toString('base64'),
  };
await mkdir(new URL('apps/web/src/', root), { recursive: true });
await writeFile(
  new URL('apps/web/src/content.generated.ts', root),
  '// Generated by scripts/build-content.mjs.\n' +
    `export const PROJECT_LINKS=${JSON.stringify(project)};\nexport const EXAMPLES=${JSON.stringify(examples)};\nexport const GAME_GUIDE_HTML=${JSON.stringify(html)};\nexport const DEVELOPER_GUIDE_HTML=${JSON.stringify(developer)};\nexport const GAME_LIMITS_HTML=${JSON.stringify(limits)};\nexport const PALETTE_GUIDE_HTML=${JSON.stringify(palette)};\n`,
);
console.log('已内嵌使用资料与示例图');
